/**
 * `LlamaCppAdapter`: fetch + SSE against a llama.cpp server's
 * OpenAI-compatible chat-completions endpoint, with the router's model
 * lifecycle attached. The chat wire (SSE framing, chunk translation, usage
 * mapping) is shared with `dsh-llm-deepseek`; what this adapter owns is the
 * router dance — ensure-loaded before the request, one load-and-retry on the
 * router's `400 "model is not loaded"` race, and optional unload-after-switch.
 *
 * @module dsh-llm-llamacpp/adapter
 */

import { attributionHeaders, contentHasImage, isModelNotLoadedError, LlmAdapter, LlmError, MODEL_NOT_LOADED_CODE, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { DONE, httpErrorCode, parseSse, translate } from '@deepseek-ai/dsh-llm-deepseek/wire'
import type { WireError } from '@deepseek-ai/dsh-llm-deepseek/wire'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { ModelLifecycle } from './lifecycle.ts'
import type { ModelLoadTransition } from './lifecycle.ts'
import { serializeRequest } from './serialize.ts'

/** One optional model entry advertised by the adapter. */
export interface LlamaCppCatalogModel {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail; the endpoint discloses none, so this is the deployment's own note. */
  description?: string
  /** Known combined context capacity; omitted falls back to the route default. */
  contextWindow?: number
  /** Per-request output cap for this model; omission falls back to the route default. */
  maxTokens?: number
  /**
   * Request modalities this model accepts. Only a server started with an
   * `--mmproj` projector can read images, and only for the model it projects,
   * so this is the deployment's declaration rather than something the adapter
   * can infer; `Fetch available models` proposes it from the live listing.
   * Omitted means text-only.
   */
  inputModalities?: ('text' | 'image')[]
  /**
   * Thinking levels this model's chat template actually reads. Templates
   * disagree — the Qwen3.8 family grades `reasoning_effort`, while Qwen3.6-
   * and Qwen2.5-era templates ignore it and honor only `enable_thinking` —
   * and nothing on the wire announces which. Declaring the subset keeps the
   * picker from offering a level that would silently do nothing here.
   * Omitted offers the full vocabulary.
   */
  reasoningEfforts?: ('low' | 'medium' | 'xhigh' | 'off')[]
}

/** Validated connection facts for one operation (one configuration generation). */
export interface LlamaCppConnectionOptions {
  /** Server origin, normalized: scheme + host[:port], no trailing `/v1`. */
  origin: string
  /** Credential reference resolved per request; a llama.cpp key is optional (local servers run without `--api-key`). */
  apiKeyEnv: CredentialRef
  /** Human-readable provider name for selectors. */
  displayName: string
  /** Ensure the requested model is loaded before each chat request. */
  autoLoad: boolean
  /** Unload the previously resident model after a successful switch. */
  autoUnload: 'never' | 'on-switch'
  /** Ceiling for one ensure-loaded wait. */
  loadTimeoutMs: number
  /** Poll interval while awaiting a model status transition. */
  pollIntervalMs: number
  /** Whether to watch `/models/sse` for transitions instead of polling at full rate. */
  watchEvents: boolean
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly LlamaCppCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor hooks the registering plugin owns. */
export interface LlamaCppAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => LlamaCppConnectionOptions
  /**
   * Resolve the optional bearer token for the connection facts of one
   * request. `undefined` sends no authorization header — a llama.cpp server
   * launched without `--api-key` accepts anonymous requests, unlike the
   * hosted providers the DeepSeek adapter serves.
   */
  resolveApiKey: (connection: LlamaCppConnectionOptions) => Promise<string | undefined>
  /**
   * The attachment store image bytes are read through, resolved per request.
   * `undefined` leaves the route text-only: image content then meets the
   * shared wire's refusal rather than being flattened away.
   */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Diagnostic sink for lifecycle transitions. */
  log?: (message: string) => void
  /** Live load-transition sink (host progress notifications), shared by every request. */
  onProgress?: (transition: ModelLoadTransition) => void
}

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default ceiling for one model load wait — a large cold GGUF takes minutes. */
export const DEFAULT_LOAD_TIMEOUT_MS = 600_000
/** Default poll interval while awaiting a status transition. */
export const DEFAULT_POLL_INTERVAL_MS = 1_000
/** Default context claim for an undescribed model — llama.cpp's own default context. */
export const DEFAULT_CONTEXT_WINDOW = 32_768
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 8_192
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/**
 * llama.cpp reports mid-stream failures as a terminal `data: {"error": …}` payload
 * instead of an HTTP status, then closes the stream without `[DONE]` — a Vulkan
 * device loss during decode is the common case. Surface the payload's own message:
 * the framing error EOF would otherwise produce names the transport, never the failure.
 * @param payloads - parsed SSE data payloads from the shared wire.
 * @returns the payloads unchanged, except a terminal error payload throws in its place.
 * @throws {LlmError} carrying the server's message, mapped through the shared status vocabulary.
 */
async function* failOnStreamErrorPayload(payloads: AsyncGenerator<string>): AsyncGenerator<string> {
  for await (const payload of payloads) {
    if (payload !== DONE) {
      let parsed: WireError | undefined
      try {
        parsed = JSON.parse(payload) as WireError
      } catch {
        // Chunk payloads belong to the shared wire's translation; only the
        // terminal error shape is intercepted here.
      }
      const error = parsed?.error
      if (error !== undefined) {
        const detail = [error.code, error.type, error.message].filter(Boolean).join(' ')
        const message = typeof error.message === 'string' && error.message.length > 0
          ? error.message
          : `llama.cpp stream error: ${payload}`
        throw new LlmError(
          message,
          isModelNotLoadedError(detail) ? MODEL_NOT_LOADED_CODE : httpErrorCode(500, error),
          { cause: payload },
        )
      }
    }
    yield payload
  }
}

const LOW_REASONING_EFFORT = ReasoningEffortId('low')
const MEDIUM_REASONING_EFFORT = ReasoningEffortId('medium')
const XHIGH_REASONING_EFFORT = ReasoningEffortId('xhigh')
const OFF_REASONING_EFFORT = ReasoningEffortId('off')
/**
 * llama.cpp thinking control is template-read, verified against build
 * `b10443-27df9199d` by rendering each model's own chat template: the
 * Qwen3.8 family maps a graded `reasoning_effort` — low / medium / xhigh,
 * xhigh the template default — and RAISES a server error on any other value
 * (high and max included); Qwen3.6- and Qwen2.5-era templates ignore
 * `reasoning_effort` entirely, and every family tested honors
 * `enable_thinking` for off. No default effort — the request sends kwargs
 * only when the user picked a level, so each template's own default governs
 * an unselected session.
 */
const REASONING_EFFORTS = [
  { id: LOW_REASONING_EFFORT, name: 'Low' },
  { id: MEDIUM_REASONING_EFFORT, name: 'Medium' },
  { id: XHIGH_REASONING_EFFORT, name: 'XHigh' },
  { id: OFF_REASONING_EFFORT, name: 'Off' },
] as const

/**
 * The efforts one model offers: its own declared subset in the canonical
 * order, or the full vocabulary when it declares none. An empty declaration
 * is honoured as "this template reads no level", which is the truthful answer
 * for a Qwen2.5-era template.
 * @param model - the catalog entry, when the model is configured.
 * @returns the efforts to advertise for it.
 */
function effortsOf(model: LlamaCppCatalogModel | undefined): readonly { id: ReasoningEffortId; name: string }[] {
  const declared = model?.reasoningEfforts
  if (declared === undefined) return REASONING_EFFORTS
  const allowed = new Set<string>(declared)
  return REASONING_EFFORTS.filter(effort => allowed.has(effort.id))
}

function modelInfo(provider: string, model: LlamaCppCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    // A model reads images only where the deployment declared it, because
    // only a server started with the matching `--mmproj` projector can.
    inputModalities: model.inputModalities ?? ['text'],
  }
}

/**
 * Normalize a configured endpoint into a server origin: trailing slashes and
 * a trailing `/v1` (the OpenAI-compatible prefix users paste from other
 * tools) are stripped, because this adapter addresses the control surface
 * (`/props`, `/models/load`) beside `/v1`, not under it.
 * @param baseURL - configured endpoint, prefix-tolerant.
 * @returns the server origin (scheme + host[:port]).
 */
export function normalizeOrigin(baseURL: string): string {
  let origin = baseURL.trim().replace(/\/+$/, '')
  if (origin.endsWith('/v1')) origin = origin.slice(0, -3).replace(/\/+$/, '')
  const parsed = new URL(origin)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`llm-llamacpp: endpoint must be http(s), got "${baseURL}"`)
  }
  return origin
}

/**
 * The llama.cpp route adapter. One instance serves the single `llamacpp`
 * provider route; the plugin re-reads connection facts per operation, so a
 * settings change reaches the next request without re-registration.
 */
export class LlamaCppAdapter extends LlmAdapter {
  private readonly config: LlamaCppAdapterOptions
  /** Lifecycle manager for the current configuration generation. */
  private lifecycle: ModelLifecycle | undefined
  private lifecycleKey: string | undefined

  constructor(config: LlamaCppAdapterOptions) {
    super()
    this.config = config
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.config.options().displayName }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const configured = connection.models.find(entry => entry.id === model)
    // Precedence is deliberate-to-guessed: what the deployment configured, then
    // the capacity the router disclosed when it loaded the model (`meta.n_ctx`,
    // exact and the only source for a model launched without `--ctx-size`),
    // then the route-wide default.
    const contextWindow = configured?.contextWindow
      ?? this.lifecycleOf(connection).observedContextWindow(model)
      ?? connection.defaultContextWindow
    return Promise.resolve({
      ...configured === undefined
        // An unconfigured model declares text-only rather than "unknown":
        // nothing here knows whether the server has a projector for it, and
        // "unknown" would let the host admit images the request must then
        // fail on.
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      reasoning: { efforts: effortsOf(configured) },
    })
  }

  /**
   * Refuse a reasoning effort the selected model does not offer. A model that
   * declared a subset means its template reads only that; sending anything
   * else would either raise a template error server-side or, worse, be
   * ignored while the user believes the level took effect.
   * @throws LlmError `INVALID_REQUEST` naming the model and what it offers.
   */
  private assertEffortDeclared(connection: LlamaCppConnectionOptions, options: GenerateOptions): void {
    const requested = options.reasoningEffort
    if (requested === undefined) return
    const configured = connection.models.find(entry => entry.id === options.model)
    if (configured?.reasoningEfforts === undefined) return
    const offered = effortsOf(configured)
    if (offered.some(effort => effort.id === requested)) return
    const names = offered.map(effort => effort.id).join(', ')
    throw new LlmError(
      `llama.cpp model "${options.model}" does not offer reasoning effort "${requested}"`
      + (names.length > 0 ? `; it offers ${names}` : '; its chat template reads no thinking level'),
      'INVALID_REQUEST',
    )
  }

  /** The lifecycle manager for the current generation, rebuilt on config change. */
  private lifecycleOf(connection: LlamaCppConnectionOptions): ModelLifecycle {
    // The credential reference belongs in the key: `authorize` closes over the
    // generation the manager was built from, so a manager kept across a
    // reference change would keep authorizing control calls with the old one.
    const key = JSON.stringify([
      connection.origin,
      connection.apiKeyEnv,
      connection.autoUnload,
      connection.loadTimeoutMs,
      connection.pollIntervalMs,
      connection.watchEvents,
    ])
    if (this.lifecycle === undefined || this.lifecycleKey !== key) {
      this.lifecycle?.dispose()
      this.lifecycle = new ModelLifecycle({
        origin: connection.origin,
        authorize: () => this.config.resolveApiKey(connection),
        loadTimeoutMs: connection.loadTimeoutMs,
        pollIntervalMs: connection.pollIntervalMs,
        watchEvents: connection.watchEvents,
        autoUnload: connection.autoUnload,
        log: this.config.log,
        onProgress: this.config.onProgress,
      })
      this.lifecycleKey = key
    }
    return this.lifecycle
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.config.options()
    // Refused before the pre-flight load, not after: a level this model's
    // template cannot read is a caller error, and paying a multi-minute GGUF
    // load first would only delay saying so.
    this.assertEffortDeclared(connection, options)
    const apiKey = await this.config.resolveApiKey(connection)
    const lifecycle = this.lifecycleOf(connection)
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    // The refcount is taken BEFORE the pre-flight load, not after it: an
    // unheld model is fair game for a concurrent switch's on-switch hygiene,
    // which would unload the model this request just spent minutes loading
    // and leave it to rediscover that through the not-loaded retry.
    lifecycle.acquire(options.model)
    if (connection.autoLoad) {
      try {
        await lifecycle.ensureLoaded(options.model, upstream)
        if (upstream.aborted) throw new LlmError('llama.cpp request aborted by caller', 'ABORTED')
      } catch (error: unknown) {
        // The stream's own release lives in a `finally` this throw precedes.
        lifecycle.release(options.model)
        throw error
      }
    }
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    // Every sign of provider life re-arms the idle deadline: SSE keep-alive
    // comments during a long prefill, and each status poll of a load the
    // retry path drives (that load runs inside the armed `next()` window, so
    // without the tick a cold model would trip the idle deadline mid-load).
    const pulse = (): void => { watchdog.pulse() }
    const iterator = this.attempt(options, watchdog.signal, connection, apiKey, lifecycle, pulse)[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `llama.cpp stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('llama.cpp request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`llama.cpp stream from ${connection.origin} failed`, 'TRANSPORT', { cause: error })
    } finally {
      lifecycle.release(options.model)
      consumer.abort('llama.cpp stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination.
        }
      }
    }
  }

  /**
   * One chat request, with a single load-and-retry around the router's
   * not-loaded race: another client may unload the model between this
   * adapter's pre-flight check and the chat POST, and the router answers
   * that with `400 "model is not loaded"`.
   */
  private async * attempt(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: LlamaCppConnectionOptions,
    apiKey: string | undefined,
    lifecycle: ModelLifecycle,
    pulse: () => void,
  ): AsyncIterable<StreamChunk> {
    try {
      yield* this.request(options, signal, connection, apiKey, pulse)
    } catch (error: unknown) {
      if (error instanceof LlmError
        && error.code === MODEL_NOT_LOADED_CODE
        && connection.autoLoad
        && !signal.aborted) {
        // The router's own listing is authoritative; load and retry once.
        await lifecycle.ensureLoaded(options.model, signal, pulse)
        yield* this.request(options, signal, connection, apiKey, pulse)
        return
      }
      throw error
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: LlamaCppConnectionOptions,
    apiKey: string | undefined,
    onComment: () => void,
  ): AsyncIterable<StreamChunk> {
    // The store is consulted only for a request that actually carries an
    // image, so a text-only turn never touches the attachment plane.
    const attachments = contentHasImage(options.messages.flatMap(message => message.content))
      ? this.config.resolveAttachments?.()
      : undefined
    const body = await serializeRequest(options, attachments)
    const payload = JSON.stringify(body)
    const headers = {
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
      ...apiKey === undefined ? {} : { 'authorization': `Bearer ${apiKey}` },
    }

    let response: Response
    try {
      response = await fetch(`${connection.origin}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      })
    } catch (error: unknown) {
      if (signal.aborted) throw error
      throw new LlmError(
        `llama.cpp request to ${connection.origin} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      let message = `llama.cpp error (HTTP ${response.status})`
      let providerError: WireError['error']
      try {
        const parsed = await response.json() as WireError
        providerError = parsed.error
        if (providerError?.message) message = providerError.message
      } catch {
        // Only swallow error-body parsing: the HTTP status still identifies the failure.
      }
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
      })
    }
    if (!response.body) {
      throw new LlmError('llama.cpp returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(failOnStreamErrorPayload(parseSse(response.body, onComment)))
  }

  /** Release the lifecycle manager (registration teardown). */
  dispose(): void {
    this.lifecycle?.dispose()
    this.lifecycle = undefined
    this.lifecycleKey = undefined
  }
}
