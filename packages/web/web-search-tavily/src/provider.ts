/**
 * `TavilySearchProvider`: a `WebSearchProvider` backed by the Tavily search API (`POST /search`).
 * It maps Tavily's `content` to `snippet`, optionally carries Tavily's generated answer as
 * `content`, drops entries without a URL, and clamps the request-layer result count to
 * Tavily's documented API maximum.
 * @module @deepseek-ai/dsh-web-search-tavily/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { TavilyError, TavilyResult, TavilySearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const TAVILY_PROVIDER_ID = 'tavily'

/** Default Tavily search endpoint; `/search` is appended. */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'

/** Default retrieval depth: Tavily's `basic` search spends one credit per call. */
export const TAVILY_DEFAULT_SEARCH_DEPTH = 'basic'

/** Default for whether Tavily generates an answer alongside the results. */
export const TAVILY_DEFAULT_INCLUDE_ANSWER = true

/** Default acquired results when a request carries no `maxResults`. */
export const TAVILY_DEFAULT_NUM_RESULTS = 10

/** Tavily rejects `max_results` above its documented API maximum, so the request clamps to it. */
export const TAVILY_MAX_RESULTS = 20

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface TavilySearchProviderOptions {
  /** Tavily API key. Empty/absent makes the provider unavailable. */
  apiKey: string
  /** Endpoint base; `/search` is appended. */
  baseURL: string
  /** Retrieval depth sent as Tavily's `search_depth`; `advanced` spends two credits. */
  searchDepth: 'basic' | 'advanced'
  /** Whether Tavily generates an answer alongside the results. */
  includeAnswer: boolean
  /** Default result count when a request carries no `maxResults`. */
  numResults?: number
}

/**
 * Map one Tavily result to a normalized source, or `undefined` when it carries
 * no URL (a citation without an address is not a source). Blank optional
 * fields are omitted rather than sent as empty strings.
 *
 * @param result - one entry of Tavily's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no URL.
 */
export function mapTavilyResult(result: TavilyResult): WebSearchSource | undefined {
  if (result.url === undefined || result.url.length === 0) return undefined
  return {
    url: result.url,
    ...result.title !== undefined && result.title.length > 0 ? { title: result.title } : {},
    ...result.content !== undefined && result.content.length > 0 ? { snippet: result.content } : {},
  }
}

/**
 * Map a Tavily response envelope to a normalized search result.
 *
 * @param response - the parsed `POST /search` response body.
 * @returns the normalized result; the generated answer, when present and
 *   non-blank, becomes `content` (the Perplexity precedent for provider
 *   answers). The web service owns the final `maxResults` truncation, so this
 *   provider reports `truncated: false`.
 */
export function mapTavilyResponse(response: TavilySearchResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapTavilyResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  const answer = response.answer
  return {
    ...answer !== undefined && answer.length > 0 ? { content: answer } : {},
    sources,
    truncated: false,
  }
}

/** The Tavily-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class TavilySearchProvider implements WebSearchProvider {
  readonly id = TAVILY_PROVIDER_ID

  constructor(private readonly options: TavilySearchProviderOptions) {}

  available(): boolean {
    return this.options.apiKey.length > 0
      && isValidBaseUrl(this.options.baseURL)
      && (this.options.numResults === undefined || isPositiveInteger(this.options.numResults))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // A per-request bound wins over the configured default; both clamp to the
    // API maximum (the seam still enforces the unclamped original bound).
    const requested = request.maxResults ?? this.options.numResults ?? TAVILY_DEFAULT_NUM_RESULTS
    const maxResults = Math.min(requested, TAVILY_MAX_RESULTS)
    let response: Response
    try {
      response = await fetch(`${this.options.baseURL}/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          query: request.query,
          search_depth: this.options.searchDepth,
          max_results: maxResults,
          include_answer: this.options.includeAnswer ? 'basic' : false,
        }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Tavily search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Tavily API error (HTTP ${status})`
      try {
        const parsed = await response.json() as TavilyError
        const detail = extractErrorMessage(parsed)
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as TavilySearchResponse
      return mapTavilyResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Tavily returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/** Extract a human-readable message from the error shapes Tavily returns. */
function extractErrorMessage(parsed: TavilyError): string | undefined {
  if (typeof parsed.detail === 'string') return parsed.detail
  const nested = parsed.detail?.error
  return parsed.error ?? parsed.message ?? nested
}

/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL: string): boolean {
  return URL.canParse(baseURL)
}

/** True for a request limit that can be sent to Tavily (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
