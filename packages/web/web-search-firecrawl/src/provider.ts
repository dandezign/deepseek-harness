/**
 * `FirecrawlSearchProvider`: a `WebSearchProvider` backed by the Firecrawl search API
 * (`POST /{version}/search`). It works keyless — an empty key omits the `Authorization`
 * header and runs at Firecrawl's keyless rate limits — and maps the first non-blank of
 * `description`/`snippet`/`metadata.description` to `snippet`, dropping entries without a URL.
 * @module @deepseek-ai/dsh-web-search-firecrawl/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { FirecrawlSearchItem, FirecrawlSearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const FIRECRAWL_PROVIDER_ID = 'firecrawl'

/** Default Firecrawl endpoint base; `/{version}/search` is appended. */
export const FIRECRAWL_DEFAULT_BASE_URL = 'https://api.firecrawl.dev'

/** Default API version appended to the endpoint base. */
export const FIRECRAWL_DEFAULT_API_VERSION = 'v2'

/** Default acquired results when a request carries no `maxResults`. */
export const FIRECRAWL_DEFAULT_NUM_RESULTS = 10

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface FirecrawlSearchProviderOptions {
  /**
   * Firecrawl API key. Empty/absent runs keyless: the `Authorization` header is
   * omitted and Firecrawl enforces its keyless rate limits.
   */
  apiKey: string
  /** Endpoint base; `/{version}/search` is appended. */
  baseURL: string
  /** API version appended to the endpoint base. */
  apiVersion: 'v1' | 'v2'
  /** Default result count when a request carries no `maxResults`. */
  numResults?: number
}

/**
 * Map one Firecrawl result to a normalized source, or `undefined` when it carries
 * no URL in the item itself or its metadata (a citation without an address is
 * not a source). Blank optional fields are omitted rather than sent as empty
 * strings.
 *
 * @param item - one entry of Firecrawl's web result list.
 * @returns the normalized source, or `undefined` when the entry has no URL.
 */
export function mapFirecrawlItem(item: FirecrawlSearchItem): WebSearchSource | undefined {
  const url = item.url ?? item.metadata?.sourceURL ?? item.metadata?.url
  if (url === undefined || url.length === 0) return undefined
  const title = item.title ?? item.metadata?.title
  const snippet = firstNonBlank(item.description, item.snippet, item.metadata?.description)
  return {
    url,
    ...title !== undefined && title.length > 0 ? { title } : {},
    ...snippet !== undefined ? { snippet } : {},
  }
}

/**
 * Map a Firecrawl response envelope to a normalized search result.
 *
 * @param response - the parsed `POST /{version}/search` response body.
 * @returns the normalized result. Firecrawl returns no generated answer, so
 *   `content` is omitted. The web service owns the final `maxResults`
 *   truncation, so this provider reports `truncated: false`.
 */
export function mapFirecrawlResponse(response: FirecrawlSearchResponse): WebSearchResult {
  const data = response.data
  // Array.isArray cannot narrow a readonly array union, so the guard is local.
  const items = isItemList(data) ? data : data?.web ?? []
  const sources = items
    .map(mapFirecrawlItem)
    .filter((source): source is WebSearchSource => source !== undefined)
  return { sources, truncated: false }
}

/** True when the response's `data` field is the flat v1 result list. */
function isItemList(data: FirecrawlSearchResponse['data']): data is readonly FirecrawlSearchItem[] {
  return Array.isArray(data)
}

/** The Firecrawl-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class FirecrawlSearchProvider implements WebSearchProvider {
  readonly id = FIRECRAWL_PROVIDER_ID

  constructor(private readonly options: FirecrawlSearchProviderOptions) {}

  available(): boolean {
    // Keyless is a supported mode: an empty key runs at Firecrawl's keyless
    // limits, so availability rests on the endpoint alone.
    return isValidBaseUrl(this.options.baseURL)
      && (this.options.numResults === undefined || isPositiveInteger(this.options.numResults))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // A per-request bound wins over the configured default; the seam enforces
    // the final bound, so this value is a request-layer optimization.
    const limit = request.maxResults ?? this.options.numResults ?? FIRECRAWL_DEFAULT_NUM_RESULTS
    let response: Response
    try {
      response = await fetch(`${this.options.baseURL}/${this.options.apiVersion}/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
          // Keyless requests carry no credential header at all, never an empty one.
          ...this.options.apiKey.length > 0 ? { 'authorization': `Bearer ${this.options.apiKey}` } : {},
        },
        body: JSON.stringify({ query: request.query, limit, sources: ['web'] }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Firecrawl search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Firecrawl search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Firecrawl API error (HTTP ${status})`
      try {
        const parsed = await response.json() as FirecrawlSearchResponse
        const detail = parsed.error
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('Firecrawl search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as FirecrawlSearchResponse
      if (payload.success === false) {
        const reason = payload.error !== undefined && payload.error.length > 0 ? payload.error : 'unknown error'
        throw new WebError(`Firecrawl search was unsuccessful: ${reason}`, 'WEB_PROVIDER_ERROR')
      }
      return mapFirecrawlResponse(payload)
    } catch (error: unknown) {
      if (error instanceof WebError) throw error
      if (isAbortError(error)) throw new WebError('Firecrawl search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Firecrawl returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/** The first non-blank string, or `undefined` when every candidate is blank. */
function firstNonBlank(...candidates: readonly (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim().length > 0) return candidate
  }
  return undefined
}

/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL: string): boolean {
  return URL.canParse(baseURL)
}

/** True for a request limit that can be sent to Firecrawl (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
