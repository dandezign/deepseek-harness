/**
 * Firecrawl-backed `WebSearchProvider` plugin. It contributes to the `ctx.web`
 * registry without owning the service.
 *
 * @module @deepseek-ai/dsh-web-search-firecrawl
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  FirecrawlSearchProvider,
  FIRECRAWL_DEFAULT_API_VERSION,
  FIRECRAWL_DEFAULT_BASE_URL,
} from './provider.ts'

export {
  FIRECRAWL_DEFAULT_API_VERSION,
  FIRECRAWL_DEFAULT_BASE_URL,
  FIRECRAWL_DEFAULT_NUM_RESULTS,
  FIRECRAWL_PROVIDER_ID,
  FirecrawlSearchProvider,
} from './provider.ts'
export type { FirecrawlSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-firecrawl'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /**
   * Firecrawl API key. Falls back to `$FIRECRAWL_API_KEY`. Empty runs keyless:
   * no `Authorization` header is sent and Firecrawl enforces its keyless rate
   * limits.
   */
  apiKey?: string
  /** Endpoint base; `/{version}/search` is appended. Defaults to the public API. */
  baseURL?: string
  /** API version appended to the endpoint base. Defaults to `v2`. */
  apiVersion?: 'v1' | 'v2'
  /** Default result count when a request carries no `maxResults`. Omitted = 10. */
  numResults?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  baseURL: z.string(),
  apiVersion: z.union(['v1', 'v2'] as const),
  numResults: z.number().step(1).min(1),
})

/** Register the Firecrawl search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new FirecrawlSearchProvider({
    // Every environment layer may name this key: the product trusts the
    // project it is launched in, and the managed store is not involved here.
    apiKey: config.apiKey ?? launchEnvironmentOf(ctx).get('FIRECRAWL_API_KEY')?.value ?? '',
    baseURL: config.baseURL ?? FIRECRAWL_DEFAULT_BASE_URL,
    apiVersion: config.apiVersion ?? FIRECRAWL_DEFAULT_API_VERSION,
    ...config.numResults !== undefined ? { numResults: config.numResults } : {},
  }))
}
