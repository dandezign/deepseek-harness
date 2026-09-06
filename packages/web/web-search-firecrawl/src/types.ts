/**
 * Firecrawl `POST /{version}/search` wire types. Only fields the provider reads
 * are typed; Firecrawl may return more.
 * @module @deepseek-ai/dsh-web-search-firecrawl/types
 */

/** One entry of Firecrawl's web result list. */
export interface FirecrawlSearchItem {
  readonly title?: string
  readonly description?: string
  readonly snippet?: string
  readonly url?: string
  readonly metadata?: {
    readonly title?: string
    readonly description?: string
    readonly sourceURL?: string
    readonly url?: string
  }
}

/**
 * The parsed `POST /{version}/search` response body. `data` is a flat array on
 * v1 and a `{ web: [...] }` envelope on v2, so the provider accepts both.
 */
export interface FirecrawlSearchResponse {
  readonly success?: boolean
  readonly error?: string
  readonly data?: readonly FirecrawlSearchItem[] | { readonly web?: readonly FirecrawlSearchItem[] }
}
