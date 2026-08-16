/**
 * Model lifecycle against a llama.cpp multi-model router: ensure-loaded
 * before a chat request, optional unload-after-switch, and in-flight request
 * refcounts so a switch never unloads a model a running request still holds.
 *
 * Control surface (observed live against build `b10443-27df9199d`):
 * - `GET /props` answers `{"role":"router","models_autoload":false,...}`;
 *   a plain single-model server answers a different shape (`model_path` set,
 *   no `role`), and older builds 404 — both mean "lifecycle does not apply".
 * - `GET /v1/models` entries carry `status.value` (`unloaded` | `loading` |
 *   `loaded`) plus the launch argv when they came from a models directory.
 * - `POST /models/load` `{"model":id}` returns `{"success":true}` immediately
 *   and transitions the model asynchronously. Loading model B while A is
 *   resident at `max_instances: 1` evicts A (exit_code 0) — no explicit
 *   unload is required to switch.
 * - `POST /models/unload` `{"model":id}` mirrors load.
 * - `GET /models/sse` streams model-scoped `status_change` events; this
 *   module deliberately polls `/v1/models` instead (see deferred work).
 *
 * @module dsh-llm-llamacpp/lifecycle
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ModelActionBody, ModelActionReply, ModelsReply, PropsReply, RouterModelEntry } from './types.ts'

/** Live status values a router reports for one model entry. */
export type ModelState = 'unloaded' | 'loading' | 'loaded' | 'unloading' | 'unknown'

/** Construction facts for one route's lifecycle manager. */
export interface LifecycleOptions {
  /** Server origin, normalized (scheme + host[:port], no `/v1` suffix). */
  origin: string
  /**
   * Bearer token for control calls, resolved per operation by the owning
   * adapter so it always comes from the same configuration generation as the
   * endpoint. `undefined` sends no header — a server launched without
   * `--api-key` ignores authorization entirely.
   */
  authorize: () => Promise<string | undefined>
  /** Ceiling for one ensure-loaded wait, covering the whole load (default ten minutes). */
  loadTimeoutMs: number
  /** Poll interval while awaiting a status transition (default one second). */
  pollIntervalMs: number
  /** Whether a successful switch unloads the previously resident model. */
  autoUnload: 'never' | 'on-switch'
  /** Diagnostic sink for load/unload transitions. */
  log?: ((message: string) => void) | undefined
  /**
   * Live transition sink for load progress, invoked at each commit point:
   * once when a load is issued or joined, and once when it settles. Failures
   * of the sink are contained and never fail the load.
   */
  onProgress?: ((progress: ModelLoadTransition) => void) | undefined
}

/** One load-lifecycle transition reported through {@link LifecycleOptions.onProgress}. */
export interface ModelLoadTransition {
  /** Wire model id the transition concerns. */
  model: string
  /** `loading` when the load was issued or joined; `ready`/`failed` when it settles. */
  phase: 'loading' | 'ready' | 'failed'
  /** Human-readable detail; the failure message on `failed`. */
  message?: string
}

/** Read one model's status from a `/v1/models` reply. */
function statusOfEntry(entry: RouterModelEntry | undefined): ModelState {
  const value = entry?.status?.value
  if (value === 'unloaded' || value === 'loading' || value === 'loaded' || value === 'unloading') return value
  return 'unknown'
}

/** Minimal diagnostic sink (no logger dependency for programmatic use). */
function noop(): void {}

/**
 * Load/unload lifecycle for one llama.cpp route. All public methods settle
 * promptly after `signal` aborts. A non-router server turns every method
 * into a no-op, so the adapter can hand every request through unconditionally.
 */
export class ModelLifecycle {
  private readonly options: LifecycleOptions
  /** `undefined` until probed; stays cached for the manager's lifetime. */
  private router: boolean | undefined
  /** Deduplicates concurrent ensure-loaded waits per model (the joined value is the wait's transition report). */
  private readonly inflight = new Map<string, Promise<boolean>>()
  /** In-flight chat requests per model; guards on-switch unloads. */
  private readonly refs = new Map<string, number>()
  /** Models this manager has seen reach `loaded`. */
  private readonly knownLoaded = new Set<string>()
  private disposed = false

  constructor(options: LifecycleOptions) {
    this.options = options
  }

  private get log(): (message: string) => void {
    return this.options.log ?? noop
  }

  /** Report one load transition; a throwing sink never fails the load. */
  private report(progress: ModelLoadTransition): void {
    try {
      this.options.onProgress?.(progress)
    } catch {
      // Progress is diagnostic: the sink's own failure concerns nobody else.
    }
  }

  private async controlHeaders(): Promise<Record<string, string>> {
    const key = await this.options.authorize()
    return key === undefined ? {} : { authorization: `Bearer ${key}` }
  }

  /**
   * Whether the endpoint is a multi-model router. Probed once through
   * `GET /props`; a missing/unknown `role` or a 404 means a plain
   * single-model server, where lifecycle management does not apply.
   * @param signal - cancellation for the probe request.
   * @returns whether this endpoint is a multi-model router.
   */
  async isRouter(signal?: AbortSignal): Promise<boolean> {
    if (this.router !== undefined) return this.router
    let response: Response
    try {
      // The probe carries the bearer token: a server launched with
      // `--api-key` answers an anonymous `/props` with 401, which would
      // otherwise disable lifecycle management on exactly the servers that
      // need it most.
      response = await fetch(`${this.options.origin}/props`, {
        headers: await this.controlHeaders(),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted) throw error
      // An unreachable /props on an otherwise answering server is an older
      // build without the control surface — not a router.
      this.router = false
      return this.router
    }
    if (!response.ok) {
      this.router = false
      return this.router
    }
    try {
      const props = await response.json() as PropsReply
      this.router = props.role === 'router'
    } catch {
      this.router = false
    }
    return this.router
  }

  /**
   * All model entries the endpoint currently reports.
   * @param signal - cancellation for the listing request.
   * @returns the live listing entries in endpoint order.
   * @throws LlmError `AUTH`/`SERVER` naming the endpoint on a failed listing.
   */
  async entries(signal?: AbortSignal): Promise<RouterModelEntry[]> {
    const response = await fetch(`${this.options.origin}/v1/models`, {
      headers: await this.controlHeaders(),
      ...signal === undefined ? {} : { signal },
    })
    if (!response.ok) {
      throw new LlmError(
        `llama.cpp model listing from ${this.options.origin}/v1/models failed (HTTP ${response.status})`,
        response.status === 401 || response.status === 403 ? 'AUTH' : 'SERVER',
        { status: response.status },
      )
    }
    const reply = await response.json() as ModelsReply
    return Array.isArray(reply.data) ? reply.data : []
  }

  /**
   * One model's live status; `unknown` when the listing does not name it.
   * @param model - model id to look up.
   * @param signal - cancellation for the listing request.
   * @returns the live status of that model.
   */
  async status(model: string, signal?: AbortSignal): Promise<ModelState> {
    const entries = await this.entries(signal)
    return statusOfEntry(entries.find(entry => entry.id === model))
  }

  /**
   * Ensure a model is resident before a chat request. Already-loaded returns
   * immediately; `loading` joins the wait without re-issuing the load; any
   * other state posts `/models/load` and polls until `loaded`. On a
   * non-router server this is a no-op. With `autoUnload: 'on-switch'`, a
   * successful load also unloads other resident models with no in-flight
   * requests (the router's own eviction covers `max_instances: 1` either way).
   * @param model - model id the next chat request targets.
   * @param signal - cancellation; the wait settles promptly after it aborts.
   * @returns resolves once the model is resident (or immediately on a non-router).
   * @throws LlmError `TIMEOUT` when the load exceeds `loadTimeoutMs`; `ABORTED`, `AUTH`, or `TRANSPORT` from the control calls.
   */
  async ensureLoaded(model: string, signal?: AbortSignal): Promise<void> {
    if (!(await this.isRouter(signal))) return
    const existing = this.inflight.get(model)
    if (existing !== undefined) {
      // Joining an in-flight load: the waiter that issued it already
      // reported `loading`; the shared wait settles both callers together.
      await existing
      return
    }
    const wait = this.waitForLoaded(model, signal)
    this.inflight.set(model, wait)
    try {
      // A `false` return means the model was already resident: no transition
      // happened, so no terminal report belongs after it either.
      if (!await wait) return
      this.report({ model, phase: 'ready' })
      this.knownLoaded.add(model)
      if (this.options.autoUnload === 'on-switch') this.unloadIdleOthers(model)
    } catch (error: unknown) {
      this.report({
        model,
        phase: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      this.inflight.delete(model)
    }
  }

  /**
   * Drive one model to `loaded`.
   * @returns whether a load transition was reported (an already-resident
   * model transitions nothing and reports nothing).
   */
  private async waitForLoaded(model: string, signal?: AbortSignal): Promise<boolean> {
    const state = await this.status(model, signal)
    if (state === 'loaded') return false
    this.report({ model, phase: 'loading' })
    if (state !== 'loading') await this.postModelAction('/models/load', model, signal)
    const deadline = Date.now() + this.options.loadTimeoutMs
    // Poll until loaded; a transition back to `unloaded` (crash, eviction)
    // re-issues the load once rather than waiting out the clock on a state
    // that will not fix itself.
    let reloaded = false
    while (true) {
      if (signal?.aborted) throw new LlmError(`llama.cpp load of "${model}" aborted`, 'ABORTED')
      if (Date.now() >= deadline) {
        throw new LlmError(
          `llama.cpp model "${model}" did not become loaded within ${this.options.loadTimeoutMs}ms`,
          'TIMEOUT',
        )
      }
      await sleep(this.options.pollIntervalMs, signal)
      const next = await this.status(model, signal)
      if (next === 'loaded') return true
      if (next === 'unloaded' && !reloaded) {
        reloaded = true
        this.log(`model "${model}" returned to unloaded while waiting; re-issuing load`)
        await this.postModelAction('/models/load', model, signal)
      }
    }
  }

  /** POST one `/models/load` or `/models/unload` action. */
  private async postModelAction(path: '/models/load' | '/models/unload', model: string, signal?: AbortSignal): Promise<void> {
    const body: ModelActionBody = { model }
    let response: Response
    try {
      response = await fetch(`${this.options.origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...await this.controlHeaders() },
        body: JSON.stringify(body),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted) throw error
      throw new LlmError(`llama.cpp ${path} for "${model}" failed`, 'TRANSPORT', { cause: error })
    }
    if (!response.ok) {
      // A 404 names an older build without the control surface; the chat
      // request itself will surface the actionable error.
      let detail = ''
      try {
        detail = `: ${await response.text()}`
      } catch { /* the status alone identifies the failure */ }
      throw new LlmError(
        `llama.cpp ${path} for "${model}" failed (HTTP ${response.status})${detail.slice(0, 200)}`,
        response.status === 401 || response.status === 403 ? 'AUTH' : 'SERVER',
        { status: response.status },
      )
    }
    try {
      const reply = await response.json() as ModelActionReply
      if (reply.success !== true) {
        throw new LlmError(`llama.cpp ${path} for "${model}" returned success !== true`, 'SERVER')
      }
    } catch (error) {
      if (error instanceof LlmError) throw error
      // A non-JSON action reply is tolerated: the status poll is authoritative.
    }
    this.log(`${path === '/models/load' ? 'loading' : 'unloading'} "${model}"`)
  }

  /**
   * Explicitly unload one model. Failures are logged, not thrown: an unload
   * is hygiene (the router evicts on its own at `max_instances: 1`), so it
   * must never fail a chat request that already succeeded.
   * @param model - model id to unload.
   * @param signal - cancellation for the unload POST.
   */
  async unload(model: string, signal?: AbortSignal): Promise<void> {
    if (!(await this.isRouter(signal))) return
    try {
      await this.postModelAction('/models/unload', model, signal)
      this.knownLoaded.delete(model)
    } catch (error: unknown) {
      if (signal?.aborted) return
      this.log(`unload of "${model}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private unloadIdleOthers(loaded: string): void {
    for (const model of this.knownLoaded) {
      if (model === loaded) continue
      if ((this.refs.get(model) ?? 0) > 0) continue
      this.knownLoaded.delete(model)
      void this.unload(model)
    }
  }

  /**
   * Count one in-flight chat request against a model.
   * @param model - model id the request targets.
   */
  acquire(model: string): void {
    this.refs.set(model, (this.refs.get(model) ?? 0) + 1)
  }

  /**
   * Release one in-flight chat request; the last release allows unloads.
   * @param model - model id the request targeted.
   */
  release(model: string): void {
    const count = (this.refs.get(model) ?? 0) - 1
    if (count <= 0) this.refs.delete(model)
    else this.refs.set(model, count)
  }

  /** Stop tracking state; in-flight waits observe their own aborts. */
  dispose(): void {
    this.disposed = true
    this.inflight.clear()
    this.refs.clear()
    this.knownLoaded.clear()
  }

  /** Whether dispose() has run. */
  get isDisposed(): boolean {
    return this.disposed
  }
}

/** Cancellable sleep; rejection after abort is swallowed into a return. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    if (signal?.aborted) {
      clearTimeout(timer)
      resolve()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
