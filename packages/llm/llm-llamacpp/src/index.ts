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

import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
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

const DEFAULT_API_KEY_ENV = 'LLAMACPP_API_KEY'
const BASE_URL_ENV = 'LLAMACPP_BASE_URL'
/** The single provider route this plugin owns. */
const PROVIDER = 'llamacpp'

/**
 * One llama.cpp server's settings. The plugin's own top level is a profile
 * too — the single-server shape most deployments write — and `providers` adds
 * further named routes beside it, each its own server with its own lifecycle.
 */
export interface LlamaCppProviderProfile {
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
  /** Watch `GET /models/sse` for transitions, relaxing the listing poll to a safety net (default true). */
  watchEvents?: boolean
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

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-llamacpp` settings-section shape. Everything is optional: with
 * neither a top-level `baseURL` nor any `providers` entry the plugin mounts
 * dormant.
 */
export interface Config extends LlamaCppProviderProfile {
  /**
   * Additional servers, keyed by the provider route id each one owns. A
   * second llama.cpp box is a second entry here rather than a second
   * composition row; the top-level profile remains the `llamacpp` route.
   */
  providers?: Record<string, LlamaCppProviderProfile>
}

const catalogModel: z<LlamaCppCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(['text', 'image'])),
  reasoningEfforts: z.array(z.union(['low', 'medium', 'xhigh', 'off'])),
})

// Written out rather than spread from a shared shape: the config-catalog
// generator reads this source statically and requires plain keys, and the
// duplication is what makes the generated per-server documentation complete.
const profile: z<LlamaCppProviderProfile> = z.object({
  baseURL: z.string(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  displayName: z.string(),
  autoLoad: z.boolean().default(true),
  autoUnload: z.union(['never', 'on-switch']).default('never'),
  loadTimeoutMs: z.number().step(1).min(1_000).max(MAX_TIMER_DELAY_MS).default(DEFAULT_LOAD_TIMEOUT_MS),
  pollIntervalMs: z.number().step(1).min(100).max(60_000).default(DEFAULT_POLL_INTERVAL_MS),
  watchEvents: z.boolean().default(true),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  defaultContextWindow: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_CONTEXT_WINDOW),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  models: z.array(catalogModel),
  retryPolicy: RetryPolicySchema,
})

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  displayName: z.string().default('llama.cpp'),
  autoLoad: z.boolean().default(true),
  autoUnload: z.union(['never', 'on-switch']).default('never'),
  loadTimeoutMs: z.number().step(1).min(1_000).max(MAX_TIMER_DELAY_MS).default(DEFAULT_LOAD_TIMEOUT_MS),
  pollIntervalMs: z.number().step(1).min(100).max(60_000).default(DEFAULT_POLL_INTERVAL_MS),
  watchEvents: z.boolean().default(true),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  defaultContextWindow: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_CONTEXT_WINDOW),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  models: z.array(catalogModel),
  retryPolicy: RetryPolicySchema,
  providers: z.dict(profile).default({}),
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
export function resolveAdapterOptions(
  config: LlamaCppProviderProfile,
  environment?: EnvironmentLookup,
): LlamaCppConnectionOptions | undefined {
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
    watchEvents: config.watchEvents ?? true,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-llamacpp: retryPolicy'),
  }
}

/**
 * Resolve every configured server into its provider route.
 *
 * The top-level profile is the `llamacpp` route, exactly as before this
 * package understood more than one server; `providers` entries are further
 * routes. Configuring both a top-level endpoint and a `providers.llamacpp`
 * entry is refused rather than silently resolved one way, because the two
 * would otherwise disagree about which server the default route addresses.
 * @param config - the whole settings section.
 * @param environment - optional launch-environment seam for $LLAMACPP_BASE_URL.
 * @returns connection facts per route id, empty when nothing is configured (dormant).
 * @throws Error on a malformed endpoint, an empty route id, or the ambiguous double declaration.
 */
export function resolveRoutes(
  config: Config,
  environment?: EnvironmentLookup,
): Map<string, LlamaCppConnectionOptions> {
  const routes = new Map<string, LlamaCppConnectionOptions>()
  const named = config.providers ?? {}
  const top = resolveAdapterOptions(config, environment)
  if (top !== undefined) {
    if (Object.hasOwn(named, PROVIDER)) {
      throw new Error(
        `llm-llamacpp: the endpoint is declared twice — at the top level and as providers."${PROVIDER}".`
        + ` Keep one: move the top-level settings under providers."${PROVIDER}", or delete that entry`,
      )
    }
    routes.set(PROVIDER, top)
  }
  for (const [route, entry] of Object.entries(named)) {
    if (route.length === 0) throw new Error('llm-llamacpp: provider route ids must be non-empty')
    // A named route states its own endpoint: $LLAMACPP_BASE_URL names one
    // server, so letting it fill in here would silently point every
    // endpointless route at the same box. Such an entry stays dormant.
    const resolved = resolveAdapterOptions(entry)
    if (resolved === undefined) continue
    routes.set(route, { ...resolved, displayName: entry.displayName ?? route })
  }
  return routes
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
      // An absent array arrives here as `[]` (schemastery normalizes it), so
      // empty is read as "undeclared" rather than as "declares nothing" —
      // otherwise every model that named neither would announce no modality
      // and no thinking level at all.
      ...(model.inputModalities ?? []).length === 0 ? {} : { inputModalities: [...model.inputModalities ?? []] },
      ...(model.reasoningEfforts ?? []).length === 0 ? {} : { reasoningEfforts: [...model.reasoningEfforts ?? []] },
    }
  })
}

export function apply(ctx: Context, config: Config): void {
  // The settings namespace the directory entries and model discovery share:
  // the plugin entry's instance id, so multiple mounts keep separate sections.
  const settingsNs = ctx.fiber.entry?.options.id ?? name
  let lastRaw: Config | undefined
  let lastGood: Map<string, LlamaCppConnectionOptions> | undefined
  const routes = (): Map<string, LlamaCppConnectionOptions> => {
    const raw = config
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveRoutes(raw, launchEnvironmentOf(ctx))
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
  routes()

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

  /** Facts a route falls back to while its endpoint is absent (dormant). */
  const dormantOptions = (route: string): LlamaCppConnectionOptions => ({
    origin: 'http://127.0.0.1:8080',
    apiKeyEnv: credentialRef(DEFAULT_API_KEY_ENV),
    displayName: route === PROVIDER ? 'llama.cpp' : route,
    autoLoad: false,
    autoUnload: 'never',
    loadTimeoutMs: DEFAULT_LOAD_TIMEOUT_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    watchEvents: true,
    maxTokens: DEFAULT_MAX_TOKENS,
    defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
    models: [],
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'llm-llamacpp: retryPolicy'),
  })

  /** One mounted route: its adapter, its registration, and the policy it was registered with. */
  interface MountedRoute {
    adapter: LlamaCppAdapter
    registration: ReturnType<typeof ctx.llm.registerAdapter>
    policy: unknown
  }
  const mounted = new Map<string, MountedRoute>()

  /** Build the adapter for one route; its options are re-read per operation. */
  const adapterFor = (route: string): LlamaCppAdapter => new LlamaCppAdapter({
    // Read through by route id rather than closing over a snapshot, so a
    // settings change reaches the next request without re-registration.
    options: () => routes().get(route) ?? dormantOptions(route),
    resolveApiKey,
    resolveAttachments: () => ctx.get('attachments'),
    log: (message) => { ctx.logger.info(`llm-llamacpp: [${route}] ${message}`) },
    // Live load progress for consumers (a settings surface, a session UI):
    // emitted at each transition's commit point, never logged, and never
    // model-visible.
    onProgress: (transition) => {
      ctx.emit('llm/model-load-progress', { provider: route, ...transition })
    },
  })

  ctx.effect(() => () => {
    for (const entry of mounted.values()) entry.adapter.dispose()
  }, 'llm-llamacpp: adapter lifecycle teardown')

  /**
    * The directory entries surfaces offer. The default route is listed even
    * while dormant, so the llama.cpp card exists before any endpoint is
    * stored; a named route only appears once configured, because nothing else
    * would tell a surface it should exist. The credential is optional on all
    * of them: a server launched without `--api-key` serves anonymous requests.
    */
  let directory: ReturnType<typeof ctx.llm.registerConfigurableProviders> | undefined
  let directoryFacts: unknown
  const syncDirectory = (resolved: Map<string, LlamaCppConnectionOptions>): void => {
    const entries = [{
      provider: PROVIDER,
      displayName: resolved.get(PROVIDER)?.displayName ?? 'llama.cpp',
      settingsNs,
      settingsPath: [] as string[],
      credentialOptional: true,
    }]
    for (const [route, connection] of resolved) {
      if (route === PROVIDER) continue
      entries.push({
        provider: route,
        displayName: connection.displayName,
        settingsNs,
        settingsPath: ['providers', route],
        credentialOptional: true,
      })
    }
    if (deepEqualJson(entries, directoryFacts)) return
    if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
    directoryFacts = entries
  }

  // Route registration follows each endpoint: a route whose endpoint
  // disappears is released and its lifecycle disposed, a new one is mounted,
  // and a retry-policy change replaces in place.
  const syncRegistration = (): void => {
    const resolved = routes()
    for (const [route, entry] of [...mounted]) {
      if (resolved.has(route)) continue
      entry.registration()
      entry.adapter.dispose()
      mounted.delete(route)
    }
    for (const [route, connection] of resolved) {
      const existing = mounted.get(route)
      if (existing === undefined) {
        const adapter = adapterFor(route)
        try {
          mounted.set(route, {
            adapter,
            registration: ctx.llm.registerAdapter([route], adapter),
            policy: connection.retryPolicy,
          })
        } catch (error) {
          adapter.dispose()
          if (error instanceof LlmError && error.code === 'DUPLICATE_ADAPTER') {
            // The usual squatter is a hand-declared provider of the same id in
            // the llm-pi-ai settings section (this package's documented
            // adoption path); name the removal so the log line is actionable.
            throw new LlmError(
              `llm-llamacpp: ${error.message}; remove the duplicate "${route}" entry from the llm-pi-ai settings section so this adapter can own the route`,
              'DUPLICATE_ADAPTER',
              { cause: error },
            )
          }
          throw error
        }
        continue
      }
      if (!deepEqualJson(connection.retryPolicy, existing.policy)) {
        existing.registration.replace([route])
        existing.policy = connection.retryPolicy
      }
    }
    syncDirectory(resolved)
  }
  syncRegistration()

  // Endpoint interrogation for the configuration card: live listing with the
  // capacities and modalities the generic OpenAI-compatible reader leaves behind.
  ctx.llm.registerModelDiscovery(
    settingsNs,
    async (request: LlmModelDiscoveryRequest, signal?: AbortSignal): Promise<readonly LlmDiscoveredModel[]> => {
      // The draft the card shows wins; otherwise describe the route named, or
      // the default one when the request names none.
      const resolved = routes().get(request.provider ?? PROVIDER)
      const raw = request.baseURL ?? resolved?.origin
      if (raw === undefined || raw.length === 0) {
        throw new LlmError(
          'llm-llamacpp: set a base URL before fetching models',
          'INVALID_DISCOVERY',
        )
      }
      const key = request.apiKey ?? await resolveKeyByRef(resolved?.apiKeyEnv ?? credentialRef(DEFAULT_API_KEY_ENV))
      return discoverRouterModels(normalizeOrigin(raw), key, signal)
    },
  )
}
