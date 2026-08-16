/**
 * Register a {@link LlamaCppAdapter} for the `llamacpp` provider route on
 * `ctx.llm`, with connection facts resolved per request instead of frozen at
 * load. The plugin mounts **dormant** without a `baseURL` — zero routes, the
 * configurable-provider card still offered — and serves the route the moment
 * settings supply an endpoint. The optional credential is resolved per
 * request; a llama.cpp server launched without `--api-key` needs none.
 *
 * Adopting this adapter for a route a `dsh-llm-pi-ai` profile already owns
 * (a hand-declared `llamacpp` provider) fails load with `DUPLICATE_ADAPTER`
 * by design: remove the pi-ai profile section when moving the route here,
 * because this adapter adds what the generic one cannot — model lifecycle.
 *
 * @module @deepseek-ai/dsh-llm-llamacpp
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { normalizeApiKey } from '@deepseek-ai/dsh-llm'
import { LlamaCppAdapter, normalizeOrigin } from './adapter.ts'
import type { LlamaCppCatalogModel, LlamaCppConnectionOptions } from './adapter.ts'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_LOAD_TIMEOUT_MS, DEFAULT_MAX_TOKENS, DEFAULT_POLL_INTERVAL_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from './adapter.ts'
import { discoverRouterModels } from './discovery.ts'

export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_LOAD_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  LlamaCppAdapter,
  normalizeOrigin,
} from './adapter.ts'
export type { LlamaCppAdapterOptions, LlamaCppCatalogModel, LlamaCppConnectionOptions } from './adapter.ts'
export { contextWindowFromArgs, discoverRouterModels, modalitiesOf, parseModelsReply } from './discovery.ts'
export { ModelLifecycle } from './lifecycle.ts'
export type { LifecycleOptions, ModelState } from './lifecycle.ts'

export const name = 'llm-llamacpp'
export const inject = ['llm']

const NS = settingsNamespace('llm-llamacpp')
const DEFAULT_API_KEY_ENV = 'LLAMACPP_API_KEY'
const BASE_URL_ENV = 'LLAMACPP_BASE_URL'
/** The single provider route this plugin owns. */
const PROVIDER = 'llamacpp'

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-llamacpp` settings-section shape. Everything is optional:
 * without `baseURL` the plugin mounts dormant.
 */
export interface Config {
  /** Server origin (`http://host:port`); a trailing `/v1` is tolerated and stripped. Falls back to $LLAMACPP_BASE_URL. */
  baseURL?: string
  /** Credential reference resolved per request (default `LLAMACPP_API_KEY`); a server without `--api-key` needs none. */
  apiKeyEnv?: string
  /** Selector label for the provider (default `llama.cpp`). */
  displayName?: string
  /** Ensure the requested model is loaded before each chat request (default true). */
  autoLoad?: boolean
  /** `on-switch` unloads the previously resident model after a successful switch, once no request holds it (default `never`). */
  autoUnload?: 'never' | 'on-switch'
  /** Ceiling for one model load wait in ms (default 600,000 — cold GGUF loads take minutes). */
  loadTimeoutMs?: number
  /** Poll interval for model status transitions in ms (default 1,000, minimum 100). */
  pollIntervalMs?: number
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Positive context capacity used when the selected model has no exact value (default 32,768). */
  defaultContextWindow?: number
  /** Default per-request output cap; a model's own cap and explicit request values win (default 8,192). */
  maxTokens?: number
  /** Advisory models; `Fetch available models` on the configuration card proposes entries with capacities derived from the live listing. */
  models?: LlamaCppCatalogModel[]
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

const catalogModel: z<LlamaCppCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  displayName: z.string().default('llama.cpp'),
  autoLoad: z.boolean().default(true),
  autoUnload: z.union(['never', 'on-switch']).default('never'),
  loadTimeoutMs: z.number().step(1).min(1_000).max(MAX_TIMER_DELAY_MS).default(DEFAULT_LOAD_TIMEOUT_MS),
  pollIntervalMs: z.number().step(1).min(100).max(60_000).default(DEFAULT_POLL_INTERVAL_MS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  defaultContextWindow: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_CONTEXT_WINDOW),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  models: z.array(catalogModel),
  retryPolicy: RetryPolicySchema,
})

/** The environment seam this resolver reads $LLAMACPP_BASE_URL through. */
export interface EnvironmentLookup {
  get(name: string): { value: string } | undefined
}

/**
 * Resolve, validate, and detach one configuration generation.
 * @param config - plugin/entry config to resolve.
 * @param environment - optional launch-environment seam for $LLAMACPP_BASE_URL.
 * @returns validated connection facts, or `undefined` when no endpoint is configured (dormant).
 * @throws Error when a configured endpoint is malformed (non-http scheme).
 */
export function resolveAdapterOptions(config: Config, environment?: EnvironmentLookup): LlamaCppConnectionOptions | undefined {
  const rawBase = config.baseURL
    ?? environment?.get(BASE_URL_ENV)?.value
  if (rawBase === undefined || rawBase.length === 0) return undefined
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-llamacpp: streamIdleTimeoutMs must be positive and no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return {
    origin: normalizeOrigin(rawBase),
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    displayName: config.displayName ?? 'llama.cpp',
    autoLoad: config.autoLoad ?? true,
    autoUnload: config.autoUnload ?? 'never',
    loadTimeoutMs: config.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-llamacpp: retryPolicy'),
  }
}

/** Resolve and detach the advisory model catalog. */
function resolveModels(models: readonly LlamaCppCatalogModel[] | undefined): LlamaCppCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? []).map((model) => {
    if (model.id.length === 0) throw new Error('llm-llamacpp: catalog model ids must be non-empty')
    if (seen.has(model.id)) throw new Error(`llm-llamacpp: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    }
  })
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: LlamaCppConnectionOptions | undefined
  const options = (): LlamaCppConnectionOptions | undefined => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx))
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-llamacpp: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  // The credential is optional: a llama.cpp server launched without
  // `--api-key` serves anonymous requests, so an unresolvable reference
  // degrades to no header rather than failing every request.
  const resolveKeyByRef = async (ref: CredentialRef): Promise<string | undefined> => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit === undefined) return undefined
      const checked = normalizeApiKey(hit.value)
      return checked.ok ? checked.value : undefined
    }
    const ambient = launchEnvironmentOf(ctx).get(ref)
    if (ambient === undefined || ambient.value.length === 0) return undefined
    const checked = normalizeApiKey(ambient.value)
    return checked.ok ? checked.value : undefined
  }
  const resolveApiKey = async (connection: LlamaCppConnectionOptions): Promise<string | undefined> =>
    resolveKeyByRef(connection.apiKeyEnv)

  const adapter = new LlamaCppAdapter({
    options: () => options() ?? { origin: 'http://127.0.0.1:8080', apiKeyEnv: credentialRef(DEFAULT_API_KEY_ENV), displayName: 'llama.cpp', autoLoad: false, autoUnload: 'never', loadTimeoutMs: DEFAULT_LOAD_TIMEOUT_MS, pollIntervalMs: DEFAULT_POLL_INTERVAL_MS, maxTokens: DEFAULT_MAX_TOKENS, defaultContextWindow: DEFAULT_CONTEXT_WINDOW, models: [], streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS, retryPolicy: resolveRetryPolicy(undefined, 'llm-llamacpp: retryPolicy') },
    resolveApiKey,
    log: (message) => { ctx.logger.info(`llm-llamacpp: ${message}`) },
    // Live load progress for consumers (a settings surface, a session UI):
    // emitted at each transition's commit point, never logged, and never
    // model-visible.
    onProgress: (transition) => {
      ctx.emit('llm/model-load-progress', { provider: PROVIDER, ...transition })
    },
  })
  ctx.effect(() => () => { adapter.dispose() }, 'llm-llamacpp: adapter lifecycle teardown')

  // The directory entry exists even while dormant, so configuration surfaces
  // offer the llama.cpp card before any endpoint is stored. The credential is
  // optional: a server launched without `--api-key` serves anonymous requests.
  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: options()?.displayName ?? 'llama.cpp',
      settingsNs: NS,
      settingsPath: [],
      credentialOptional: true,
    },
  ])

  // Route registration follows the endpoint: absent baseURL mounts zero
  // routes (dormant), a retry-policy change replaces in place, and a
  // disappearing baseURL releases the route without a gap the other way.
  let registration: ReturnType<typeof ctx.llm.registerAdapter> | undefined
  let registeredPolicy: unknown
  const syncRegistration = (): void => {
    const resolved = options()
    if (resolved === undefined) {
      if (registration !== undefined) {
        registration()
        registration = undefined
        registeredPolicy = undefined
      }
      return
    }
    if (registration === undefined) {
      try {
        registration = ctx.llm.registerAdapter([PROVIDER], adapter)
        registeredPolicy = resolved.retryPolicy
      } catch (error) {
        if (error instanceof LlmError && error.code === 'DUPLICATE_ADAPTER') {
          // The usual squatter is a hand-declared provider of the same id in
          // the llm-pi-ai settings section (this package's documented
          // adoption path); name the removal so the log line is actionable.
          throw new LlmError(
            `llm-llamacpp: ${error.message}; remove the duplicate "${PROVIDER}" entry from the llm-pi-ai settings section so this adapter can own the route`,
            'DUPLICATE_ADAPTER',
            { cause: error },
          )
        }
        throw error
      }
      return
    }
    if (!deepEqualJson(resolved.retryPolicy, registeredPolicy)) {
      registration.replace([PROVIDER])
      registeredPolicy = resolved.retryPolicy
    }
  }
  syncRegistration()

  // Endpoint interrogation for the configuration card: live listing with the
  // capacities and modalities the generic OpenAI-compatible reader leaves behind.
  ctx.llm.registerModelDiscovery(NS, async (request: LlmModelDiscoveryRequest): Promise<readonly LlmDiscoveredModel[]> => {
    const resolved = options()
    const raw = request.baseURL ?? resolved?.origin
    if (raw === undefined || raw.length === 0) {
      throw new LlmError(
        'llm-llamacpp: set a base URL before fetching models',
        'INVALID_DISCOVERY',
      )
    }
    const key = request.apiKey ?? await resolveKeyByRef(resolved?.apiKeyEnv ?? credentialRef(DEFAULT_API_KEY_ENV))
    return discoverRouterModels(normalizeOrigin(raw), key, request.signal)
  })

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: syncRegistration,
  })
}
