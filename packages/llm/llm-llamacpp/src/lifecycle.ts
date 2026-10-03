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
import { ModelStatusWatcher } from './watcher.ts'
import type { ModelActionBody, ModelActionReply, ModelsReply, PropsReply, RouterModelEntry } from './types.ts'

/** Live status values a router reports for one model entry. */
export type ModelState = 'unloaded' | 'loading' | 'loaded' | 'unloading' | 'unknown'

/** Which control surface the endpoint speaks, decided by the `/props` probe. */
export type ServerKind =
  /** llama.cpp multi-model router: `role: "router"`, `/models/load`, `/models/sse`. */
  | 'router'
  /** Strata (`build_info: "Strata …"` or the `models_autoload`/`role`-less props shape):
   *  one whole-server model, `/load` and `/unload`, no event stream. */
  | 'strata'
  /** A plain single-model server: lifecycle management does not apply. */
  | 'plain'

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
  /**
   * Whether to watch `GET /models/sse` for transitions instead of polling
   * `/v1/models` at full rate. The watcher is an accelerator, never a
   * dependency: polling continues underneath at a relaxed interval, so an
   * older build without the stream behaves exactly as before (default true).
   */
  watchEvents?: boolean | undefined
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
  private kind: ServerKind | undefined
  /** Deduplicates concurrent ensure-loaded waits per model (the joined value is the wait's transition report). */
  private readonly inflight = new Map<string, Promise<boolean>>()
  /** In-flight chat requests per model; guards on-switch unloads. */
  private readonly refs = new Map<string, number>()
  /** Models this manager has seen reach `loaded`. */
  private readonly knownLoaded = new Set<string>()
  /**
   * Aborted by {@link dispose}. Every control call is scoped to it, so a
   * manager retired by a configuration change stops driving the endpoint it
   * was built for instead of polling and re-issuing loads against a server
   * the user has already reconfigured away from.
   */
  private readonly closed = new AbortController()
  /** Event-stream accelerator; absent when the deployment opted out. */
  private readonly watcher: ModelStatusWatcher | undefined
  private disposed = false

  constructor(options: LifecycleOptions) {
    this.options = options
    this.watcher = options.watchEvents === false
      ? undefined
      : new ModelStatusWatcher({
        origin: options.origin,
        authorize: options.authorize,
        // A dropped stream costs only the relaxed poll until it returns, so
        // reconnect at the poll cadence rather than racing it.
        reconnectDelayMs: Math.max(options.pollIntervalMs, 500),
        log: options.log,
      })
  }

  /**
   * Poll cadence for the current wait. A live stream reports every transition
   * the moment it happens, so the listing drops back to a slow safety net
   * that only has to cover a silent drop; without one it carries the wait.
   */
  private get pollDelayMs(): number {
    return this.watcher?.connected === true
      ? Math.max(this.options.pollIntervalMs * 10, 5_000)
      : this.options.pollIntervalMs
  }

  /**
   * Bind a caller's cancellation to this manager's lifetime, so disposal
   * settles the call even when the caller's own request is still live.
   */
  private scope(signal?: AbortSignal): AbortSignal {
    return signal === undefined ? this.closed.signal : AbortSignal.any([signal, this.closed.signal])
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
   * Which control surface this endpoint speaks, probed once through `GET /props`:
   * `role: "router"` names a llama.cpp multi-model router; Strata answers the
   * `role`-less single-model props shape with `models_autoload` and a
   * `build_info` that names it; anything else (a 404 included) is a plain
   * single-model server, where lifecycle management does not apply.
   * @param signal - cancellation for the probe request.
   * @returns the detected server kind.
   */
  private async detectKind(signal?: AbortSignal): Promise<ServerKind> {
    if (this.kind !== undefined) return this.kind
    const scoped = this.scope(signal)
    let response: Response
    try {
      // The probe carries the bearer token: a server launched with
      // `--api-key` answers an anonymous `/props` with 401, which would
      // otherwise disable lifecycle management on exactly the servers that
      // need it most.
      response = await fetch(`${this.options.origin}/props`, {
        headers: await this.controlHeaders(),
        signal: scoped,
      })
    } catch (error: unknown) {
      if (scoped.aborted) throw error
      // A transport failure cannot tell an older build without the control
      // surface apart from a server that is not up yet, so this call answers
      // "plain" WITHOUT caching it: caching would disable lifecycle
      // management for the rest of this configuration generation the moment
      // one probe met a server that had not finished starting.
      return 'plain'
    }
    if (!response.ok) {
      this.kind = 'plain'
      return this.kind
    }
    try {
      const props = await response.json() as PropsReply
      if (props.role === 'router') this.kind = 'router'
      // Strata answers the role-less single-model shape but always carries
      // `models_autoload` (a plain llama.cpp server sets neither) — and its
      // `build_info` names it when the engine reported a version.
      else if (!('role' in props) && props.models_autoload !== undefined) this.kind = 'strata'
      else this.kind = 'plain'
    } catch {
      this.kind = 'plain'
    }
    // Only a confirmed router serves the stream; Strata has no `/models/sse`, and
    // this manager will never wait on a load there anyway (polling covers it).
    if (this.kind === 'router') this.watcher?.start()
    return this.kind
  }

  /**
   * Whether the endpoint runs a lifecycle this manager can drive — a
   * multi-model router or a Strata server (whose single model still loads on
   * demand). A plain server answers "no": every lifecycle method no-ops.
   * @param signal - cancellation for the probe request.
   * @returns whether lifecycle management applies.
   */
  async isRouter(signal?: AbortSignal): Promise<boolean> {
    return (await this.detectKind(signal)) !== 'plain'
  }

  /**
   * All model entries the endpoint currently reports.
   * @param signal - cancellation for the listing request.
   * @returns the live listing entries in endpoint order.
   * @throws LlmError `ABORTED`/`TRANSPORT`/`AUTH`/`SERVER` naming the endpoint on a failed listing.
   */
  async entries(signal?: AbortSignal): Promise<RouterModelEntry[]> {
    const scoped = this.scope(signal)
    let response: Response
    try {
      response = await fetch(`${this.options.origin}/v1/models`, {
        headers: await this.controlHeaders(),
        signal: scoped,
      })
    } catch (error: unknown) {
      // The adapter's pre-flight ensure-loaded runs outside its own error
      // mapping, so an unwrapped rejection would reach callers as a bare
      // TypeError/AbortError that no code-keyed layer can classify.
      if (scoped.aborted) {
        throw new LlmError(`llama.cpp model listing from ${this.options.origin}/v1/models aborted`, 'ABORTED', { cause: error })
      }
      throw new LlmError(`llama.cpp model listing from ${this.options.origin}/v1/models failed`, 'TRANSPORT', { cause: error })
    }
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
    // A connected stream has already been told what the listing would say.
    const live = this.watcher?.statusOf(model)
    if (live !== undefined) return live
    const entries = await this.entries(signal)
    const found = entries.find(entry => entry.id === model)
    if (found !== undefined) return statusOfEntry(found)
    // Strata lists a non-resident model only when an idle unload is armed;
    // otherwise its listing comes back empty while the server sits there
    // ready to load on use. A model the (successful) listing does not name is
    // therefore `unloaded`, not `unknown` — which is exactly what a pre-flight
    // ensure-loaded needs to issue the load.
    if (await this.detectKind(signal) === 'strata') return 'unloaded'
    return 'unknown'
  }

  /**
   * Authoritative context capacity for one model, when the router disclosed
   * it. Only the `loaded` event carries `meta.n_ctx`, which is the real
   * capacity for a model whose launch argv omits `--ctx-size`.
   * @param model - model id to read.
   * @returns the observed capacity, or `undefined` when never disclosed.
   */
  observedContextWindow(model: string): number | undefined {
    return this.watcher?.contextWindowOf(model)
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
   * @param onPoll - liveness tick invoked on every status poll, so a caller
   * holding its own idle deadline over this wait can keep it armed.
   * @returns resolves once the model is resident (or immediately on a non-router).
   * @throws LlmError `TIMEOUT` when the load exceeds `loadTimeoutMs`; `ABORTED`, `AUTH`, or `TRANSPORT` from the control calls.
   */
  async ensureLoaded(model: string, signal?: AbortSignal, onPoll?: () => void): Promise<void> {
    // A retired manager owns no endpoint: hand the request through untouched
    // rather than driving loads the adapter has already replaced.
    if (this.disposed) return
    if (!(await this.isRouter(signal))) return
    const existing = this.inflight.get(model)
    if (existing !== undefined) {
      // Joining an in-flight load: the waiter that issued it already
      // reported `loading`; the shared wait settles both callers together.
      try {
        await existing
        return
      } catch (error: unknown) {
        // The shared wait carries the ISSUING caller's cancellation, which is
        // not this caller's: a still-live joiner falls through to its own wait
        // instead of inheriting someone else's abort. The router keeps loading
        // either way, so that wait rejoins the transition rather than re-issuing.
        if (signal?.aborted || !(error instanceof LlmError && error.code === 'ABORTED')) throw error
      }
    }
    const wait = this.waitForLoaded(model, signal, onPoll)
    this.inflight.set(model, wait)
    try {
      // A `false` return means the model was already resident: no transition
      // happened, so no terminal report belongs after it either — but the
      // model is resident under this manager's watch either way, which is
      // what on-switch hygiene later needs to know to reclaim it.
      const transitioned = await wait
      this.knownLoaded.add(model)
      if (!transitioned) return
      this.report({ model, phase: 'ready' })
      if (this.options.autoUnload === 'on-switch') this.unloadIdleOthers(model)
    } catch (error: unknown) {
      this.report({
        model,
        phase: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      // Only retract our OWN entry. A joiner that fell through after the
      // issuer's abort has already published its wait under this key, and
      // deleting that would send the next caller to re-issue `/models/load`
      // against a load this manager is still watching.
      if (this.inflight.get(model) === wait) this.inflight.delete(model)
    }
  }

  /**
   * Drive one model to `loaded`.
   * @returns whether a load transition was reported (an already-resident
   * model transitions nothing and reports nothing).
   */
  private async waitForLoaded(model: string, signal?: AbortSignal, onPoll?: () => void): Promise<boolean> {
    const scoped = this.scope(signal)
    const state = await this.status(model, scoped)
    if (state === 'loaded') return false
    this.report({ model, phase: 'loading' })
    if (state !== 'loading') await this.postModelAction('load', model, scoped)
    const deadline = Date.now() + this.options.loadTimeoutMs
    // Poll until loaded; a transition back to `unloaded` (crash, eviction)
    // re-issues the load once rather than waiting out the clock on a state
    // that will not fix itself.
    let reloaded = false
    while (true) {
      if (scoped.aborted) throw new LlmError(`llama.cpp load of "${model}" aborted`, 'ABORTED')
      if (Date.now() >= deadline) {
        throw new LlmError(
          `llama.cpp model "${model}" did not become loaded within ${this.options.loadTimeoutMs}ms`,
          'TIMEOUT',
        )
      }
      // Whichever comes first: the stream reporting a transition, or the
      // safety-net listing coming due. With no stream the race degenerates to
      // the timer alone, which is the original polling behaviour. The delay is
      // capped by the time left, because the deadline is only tested between
      // waits — a relaxed safety net must not overshoot the load timeout.
      const remaining = deadline - Date.now()
      await Promise.race([
        sleep(Math.max(Math.min(this.pollDelayMs, remaining), 1), scoped),
        this.watcher?.changed(scoped) ?? new Promise<void>(() => { /* never */ }),
      ])
      onPoll?.()
      const next = await this.status(model, scoped)
      if (next === 'loaded') return true
      if (next === 'unloaded' && !reloaded) {
        reloaded = true
        this.log(`model "${model}" returned to unloaded while waiting; re-issuing load`)
        await this.postModelAction('load', model, scoped)
      }
    }
  }

  /**
   * POST one load or unload action on the endpoint's own control surface: a
   * router names the model (`/models/load {model}`), Strata drives its single
   * resident sequence whole-server (`/load`, `/unload`, no body).
   * @param action - which transition to drive.
   * @param model - model id (router calls only; ignored by Strata).
   */
  private async postModelAction(action: 'load' | 'unload', model: string, signal?: AbortSignal): Promise<void> {
    const kind = await this.detectKind(signal)
    const path = kind === 'strata' ? `/${action}` : `/models/${action}`
    const body: ModelActionBody = kind === 'strata' ? {} : { model }
    const named = kind === 'strata' ? `"${model}" (server)` : `"${model}"`
    const scoped = this.scope(signal)
    let response: Response
    try {
      response = await fetch(`${this.options.origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...await this.controlHeaders() },
        body: JSON.stringify(body),
        signal: scoped,
      })
    } catch (error: unknown) {
      if (scoped.aborted) throw error
      throw new LlmError(`llama.cpp ${path} for "${model}" failed`, 'TRANSPORT', { cause: error })
    }
    if (!response.ok) {
      // Strata refuses an unload with 409 while a request is running — for a
      // load that same 409 says a request is in flight, so the model is de
      // facto resident and the wait that follows finds it loaded.
      if (kind === 'strata' && action === 'load' && response.status === 409) return
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
      if (kind !== 'strata' && reply.success !== true) {
        throw new LlmError(`llama.cpp ${path} for "${model}" returned success !== true`, 'SERVER')
      }
    } catch (error) {
      if (error instanceof LlmError) throw error
      // A non-JSON action reply is tolerated: the status poll is authoritative.
    }
    this.log(`${action === 'load' ? 'loading' : 'unloading'} ${named}`)
  }

  /**
   * Explicitly unload one model. Failures are logged, not thrown: an unload
   * is hygiene (the router evicts on its own at `max_instances: 1`), so it
   * must never fail a chat request that already succeeded.
   * @param model - model id to unload.
   * @param signal - cancellation for the unload POST.
   */
  async unload(model: string, signal?: AbortSignal): Promise<void> {
    if (this.disposed) return
    if (!(await this.isRouter(signal))) return
    try {
      await this.postModelAction('unload', model, signal)
      this.knownLoaded.delete(model)
    } catch (error: unknown) {
      if (this.scope(signal).aborted) return
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

  /**
   * Retire this manager: in-flight probes, polls, and load/unload POSTs are
   * aborted rather than left to run out their own clocks against an endpoint
   * this manager no longer represents.
   */
  dispose(): void {
    this.disposed = true
    this.watcher?.close()
    this.closed.abort(new LlmError('llama.cpp lifecycle manager disposed', 'ABORTED'))
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
