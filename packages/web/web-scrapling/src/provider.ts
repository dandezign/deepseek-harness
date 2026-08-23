/**
 * Keyless web providers over the managed Scrapling runtime:
 * a DuckDuckGo HTML search provider and a Scrapling fetch provider whose
 * standard/stealth/dynamic acquisition mode is a deployment configuration.
 *
 * @module @deepseek-ai/dsh-web-scrapling/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebFetchBody,
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { ScraplingFetchOutcome, ScraplingOutcome, ScraplingSearchOutcome } from './types.ts'
import type { ScraplingRuntime } from './runtime.ts'

/** Stable id the search provider registers under. */
export const DUCKDUCKGO_PROVIDER_ID = 'duckduckgo'

/** Stable id the fetch provider registers under. */
export const SCRAPLING_PROVIDER_ID = 'scrapling'

/** Default acquired results when a request carries no `maxResults`. */
const DEFAULT_NUM_RESULTS = 10

/** DuckDuckGo's HTML endpoint lists at most this many results per page. */
const MAX_PAGE_RESULTS = 20

/** Provider-owned timeout code for one search exchange. */
export const SCRAPLING_SEARCH_TIMEOUT = 'SCRAPLING_SEARCH_TIMEOUT'

/** Provider-owned timeout code for one fetch exchange. */
export const SCRAPLING_FETCH_TIMEOUT = 'SCRAPLING_FETCH_TIMEOUT'

/**
 * Map one parsed search outcome to the seam's normalized result. Entries with
 * no URL are dropped (a citation without an address is not a source); empty
 * titles and snippets are omitted rather than sent as blank strings.
 *
 * @param outcome - the Python tool's parsed search outcome.
 * @returns the normalized search result with seam-side `truncated: false`
 *   (the seam owns the `maxResults` truncation).
 */
export function mapSearchOutcome(outcome: ScraplingSearchOutcome): WebSearchResult {
  const sources: WebSearchSource[] = []
  for (const item of outcome.results) {
    if (item.url.length === 0) continue
    sources.push({
      url: item.url,
      ...item.title.length > 0 ? { title: item.title } : {},
      ...item.snippet.length > 0 ? { snippet: item.snippet } : {},
    })
  }
  return { sources, truncated: false }
}

/**
 * Throw a search outcome's carried domain error, or narrow it to the success shape.
 *
 * @param outcome - the Python tool's parsed outcome.
 * @returns the same outcome typed as a successful search outcome.
 * @throws {@link WebError} `WEB_PROVIDER_ERROR` carrying the tool's message.
 */
export function requireSearchOutcome(outcome: ScraplingOutcome): ScraplingSearchOutcome {
  if ('error' in outcome) throw new WebError(`DuckDuckGo search failed: ${outcome.error}`, 'WEB_PROVIDER_ERROR')
  if (!('results' in outcome)) throw new WebError('the Scrapling tool returned a non-search outcome', 'WEB_PROVIDER_ERROR')
  return outcome
}

/**
 * Throw a fetch outcome's carried domain error, or narrow it to the success shape.
 *
 * @param outcome - the Python tool's parsed outcome.
 * @returns the same outcome typed as a successful fetch outcome.
 * @throws {@link WebError} `WEB_PROVIDER_ERROR` carrying the tool's message.
 */
export function requireFetchOutcome(outcome: ScraplingOutcome): ScraplingFetchOutcome {
  if ('error' in outcome) throw new WebError(`Scrapling fetch failed: ${outcome.error}`, 'WEB_PROVIDER_ERROR')
  if (!('content' in outcome)) throw new WebError('the Scrapling tool returned a non-fetch outcome', 'WEB_PROVIDER_ERROR')
  return outcome
}

/** Deployment-resolved fetch acquisition options. */
export interface ScraplingFetchOptions {
  /** Scrapling acquisition mode; stealth/dynamic drive a browser engine. */
  readonly mode: 'standard' | 'stealth' | 'dynamic'
  /** Stealth mode: attempt Cloudflare challenge solving. */
  readonly solveCloudflare: boolean
  /** Dynamic mode: wait for network idle before extraction. */
  readonly networkIdle: boolean
  /** Maximum extracted characters returned (the acquisition bound). */
  readonly maxBodyChars: number
  /** Operation deadline in milliseconds. */
  readonly timeoutMs: number
}

/** The keyless DuckDuckGo search provider. */
export class DuckDuckGoSearchProvider implements WebSearchProvider {
  readonly id = DUCKDUCKGO_PROVIDER_ID

  constructor(
    private readonly runtime: ScraplingRuntime,
    private readonly timeoutMs: number,
  ) {}

  available(): boolean {
    return this.runtime.available()
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const numResults = Math.min(request.maxResults ?? DEFAULT_NUM_RESULTS, MAX_PAGE_RESULTS)
    const outcome = requireSearchOutcome(await this.runtime.run(
      { op: 'search', query: request.query, numResults },
      this.timeoutMs,
      SCRAPLING_SEARCH_TIMEOUT,
      signal,
    ))
    return mapSearchOutcome(outcome)
  }
}

/** The Scrapling-backed fetch provider; extraction always yields `kind: "text"`. */
export class ScraplingFetchProvider implements WebFetchProvider {
  readonly id = SCRAPLING_PROVIDER_ID

  constructor(
    private readonly runtime: ScraplingRuntime,
    private readonly options: ScraplingFetchOptions,
  ) {}

  available(): boolean {
    return this.runtime.available()
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const url = validateUrl(request.url)
    const outcome = requireFetchOutcome(await this.runtime.run(
      {
        op: 'fetch',
        url: url.toString(),
        mode: this.options.mode,
        maxChars: this.options.maxBodyChars,
        solveCloudflare: this.options.solveCloudflare,
        networkIdle: this.options.networkIdle,
      },
      this.options.timeoutMs,
      SCRAPLING_FETCH_TIMEOUT,
      signal,
    ))
    const body: WebFetchBody = { kind: 'text', content: outcome.content }
    return {
      url: outcome.url,
      statusCode: outcome.status,
      body,
      truncated: outcome.truncated,
    }
  }
}

/**
 * Validate one fetch target as an absolute http(s) URL.
 * @param raw - the request's URL string.
 * @returns the parsed URL.
 * @throws {@link WebError} `WEB_INVALID_URL` for a non-absolute or non-http(s) target.
 */
function validateUrl(raw: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch (error: unknown) {
    throw new WebError(`"${raw}" is not an absolute URL`, 'WEB_INVALID_URL', { cause: error })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebError(`"${parsed.protocol}" is not an http(s) URL`, 'WEB_INVALID_URL')
  }
  return parsed
}
