/**
 * Tavily `POST /search` wire types. Only fields the provider reads are typed;
 * Tavily may return more.
 * @module @deepseek-ai/dsh-web-search-tavily/types
 */

/** One entry of Tavily's `results[]`. */
export interface TavilyResult {
  readonly title?: string
  readonly url?: string
  /** Tavily's extracted snippet for the result. */
  readonly content?: string
}

/** The parsed `POST /search` response body. */
export interface TavilySearchResponse {
  /** Tavily's generated answer, present when the request asked for one. */
  readonly answer?: string
  readonly results?: readonly TavilyResult[]
}

/** One error shape Tavily is known to return; message extraction is best-effort. */
export interface TavilyError {
  readonly detail?: string | { readonly error?: string }
  readonly error?: string
  readonly message?: string
}
