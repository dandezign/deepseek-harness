/**
 * Live model-status watcher over `GET /models/sse`.
 *
 * The router streams model-scoped `model_status` / `status_change` events, and
 * the `loaded` event carries the authoritative `meta.n_ctx` — the only place
 * the real context capacity is disclosed for a model whose launch argv omits
 * `--ctx-size`. Watching it turns a load wait from "one full `/v1/models`
 * listing per second for as long as the load takes" into one connection plus
 * one event per transition.
 *
 * The watcher is strictly an accelerator: it reports what it currently knows
 * and nothing else, so every caller stays correct when the stream is
 * unavailable (an older build 404s it) or drops mid-load. The lifecycle keeps
 * its own polling safety net for exactly that reason.
 *
 * @module dsh-llm-llamacpp/watcher
 */

import { parseModelEvent } from './discovery.ts'
import type { ModelState } from './lifecycle.ts'

/** Construction facts for one route's status watcher. */
export interface WatcherOptions {
  /** Server origin, normalized (scheme + host[:port], no `/v1` suffix). */
  origin: string
  /** Bearer token for the stream, resolved per connection attempt. */
  authorize: () => Promise<string | undefined>
  /** Delay before re-attempting a dropped stream, in ms. */
  reconnectDelayMs: number
  /** Diagnostic sink. */
  log?: ((message: string) => void) | undefined
}

/** Narrow a status word off the wire onto the lifecycle vocabulary. */
function stateOf(value: string | undefined): ModelState | undefined {
  return value === 'unloaded' || value === 'loading' || value === 'loaded' || value === 'unloading'
    ? value
    : undefined
}

/**
 * Live model status from the router's event stream. All reads are synchronous
 * and non-authoritative: `undefined` means "this watcher does not know", never
 * "the model is absent".
 */
export class ModelStatusWatcher {
  private readonly options: WatcherOptions
  private readonly statuses = new Map<string, ModelState>()
  private readonly contextWindows = new Map<string, number>()
  /** Resolvers waiting for the next event of any kind. */
  private readonly waiters = new Set<() => void>()
  private readonly closed = new AbortController()
  private streaming = false
  /** Set once the endpoint answers that it has no such stream (older build). */
  private unsupported = false
  private running = false

  constructor(options: WatcherOptions) {
    this.options = options
  }

  private get log(): (message: string) => void {
    return this.options.log ?? ((): void => {})
  }

  /** Whether the stream is currently connected and its readings are live. */
  get connected(): boolean {
    return this.streaming
  }

  /** Whether the endpoint answered that it serves no such stream. */
  get isUnsupported(): boolean {
    return this.unsupported
  }

  /**
   * Last status this watcher observed for one model.
   * @param model - model id to read.
   * @returns the observed state, or `undefined` when unobserved.
   */
  statusOf(model: string): ModelState | undefined {
    return this.streaming ? this.statuses.get(model) : undefined
  }

  /**
   * Authoritative context capacity from the model's `loaded` event.
   * @param model - model id to read.
   * @returns `meta.n_ctx` when a load of this model was observed.
   */
  contextWindowOf(model: string): number | undefined {
    return this.contextWindows.get(model)
  }

  /** Begin watching; idempotent, and a no-op once closed or found unsupported. */
  start(): void {
    if (this.running || this.unsupported || this.closed.signal.aborted) return
    this.running = true
    void this.run()
  }

  /**
   * Resolve at the next observed event, or when `signal` aborts. Never
   * rejects: a caller races this against its own timer, and a watcher that
   * goes quiet must degrade to that timer rather than fail the wait.
   * @param signal - cancellation for this wait.
   * @returns a promise settling at the next event or abort.
   */
  changed(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true || this.closed.signal.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        this.waiters.delete(done)
        signal?.removeEventListener('abort', done)
        this.closed.signal.removeEventListener('abort', done)
        resolve()
      }
      this.waiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
      this.closed.signal.addEventListener('abort', done, { once: true })
    })
  }

  /** Wake everyone waiting on the next event. */
  private notify(): void {
    for (const waiter of [...this.waiters]) waiter()
  }

  /**
   * Whether close() has run. A method rather than a property read so the
   * reconnect loop's checks are not narrowed away across its awaits.
   */
  private closedNow(): boolean {
    return this.closed.signal.aborted
  }

  /** Whether the endpoint has answered that it serves no such stream. */
  private unsupportedNow(): boolean {
    return this.unsupported
  }

  /** Connect, read, and reconnect until closed. */
  private async run(): Promise<void> {
    // `while (true)` with explicit exits: both stop conditions are set inside
    // the body (and inside the call it awaits), which a loop-header test would
    // read as invariant.
    while (true) {
      try {
        await this.readStream()
      } catch (error: unknown) {
        if (this.closedNow()) break
        this.log(`model status stream dropped: ${error instanceof Error ? error.message : String(error)}`)
      }
      this.streaming = false
      // A drop invalidates every cached reading: the lifecycle must fall back
      // to its own polling rather than trust a snapshot frozen at disconnect.
      this.statuses.clear()
      this.notify()
      if (this.closedNow() || this.unsupportedNow()) break
      await this.pause()
      if (this.closedNow()) break
    }
    this.streaming = false
    this.running = false
  }

  /** Wait out the reconnect delay, settling early when closed. */
  private pause(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.closed.signal.removeEventListener('abort', onClose)
        resolve()
      }, this.options.reconnectDelayMs)
      const onClose = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.closed.signal.addEventListener('abort', onClose, { once: true })
    })
  }

  /** One connection: read frames until the stream ends or fails. */
  private async readStream(): Promise<void> {
    const key = await this.options.authorize()
    const response = await fetch(`${this.options.origin}/models/sse`, {
      headers: {
        accept: 'text/event-stream',
        ...key === undefined ? {} : { authorization: `Bearer ${key}` },
      },
      signal: this.closed.signal,
    })
    if (response.status === 404) {
      // An older build without the stream: stop trying, permanently. The
      // lifecycle's polling covers this deployment for good.
      this.unsupported = true
      this.log('router has no /models/sse; falling back to polling')
      return
    }
    if (!response.ok || response.body === null) {
      throw new Error(`/models/sse answered HTTP ${String(response.status)}`)
    }
    this.streaming = true
    this.notify()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // SSE frames are blank-line separated; a partial tail stays buffered.
        let split = buffer.indexOf('\n\n')
        while (split !== -1) {
          this.consume(buffer.slice(0, split))
          buffer = buffer.slice(split + 2)
          split = buffer.indexOf('\n\n')
        }
      }
    } finally {
      reader.cancel().catch(() => { /* the connection is already going away */ })
    }
  }

  /** Apply one SSE frame's `data:` payload. */
  private consume(frame: string): void {
    let changed = false
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue
      const parsed = parseModelEvent(line.slice(5).trim())
      if (parsed?.model === undefined) continue
      const state = stateOf(parsed.status)
      if (state !== undefined) {
        this.statuses.set(parsed.model, state)
        changed = true
      }
      // `meta.n_ctx` is disclosed only here, and only on load. It outlives a
      // disconnect because a capacity does not change while the model does.
      if (parsed.nCtx !== undefined) this.contextWindows.set(parsed.model, parsed.nCtx)
    }
    if (changed) this.notify()
  }

  /** Stop watching and release every waiter. */
  close(): void {
    if (this.closed.signal.aborted) return
    this.closed.abort()
    this.streaming = false
    this.statuses.clear()
    this.notify()
  }
}
