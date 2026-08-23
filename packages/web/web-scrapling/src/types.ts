/**
 * JSON contract between this package's TypeScript providers and
 * `scripts/scrapling_tools.py`. Every exchange is one JSON request object as
 * the script's sole argv and one JSON outcome object on stdout.
 * @module @deepseek-ai/dsh-web-scrapling/types
 */

/** One operation request dispatched to the Python tool. */
export type ScraplingRequest =
  | { readonly op: 'search'; readonly query: string; readonly numResults: number }
  | {
    readonly op: 'fetch'
    readonly url: string
    readonly mode: 'standard' | 'stealth' | 'dynamic'
    readonly maxChars: number
    readonly cssSelector?: string
    readonly solveCloudflare?: boolean
    readonly networkIdle?: boolean
    readonly waitSelector?: string
  }

/** One DuckDuckGo search result as normalized by the Python tool. */
export interface ScraplingSearchResultItem {
  readonly title: string
  readonly url: string
  readonly snippet: string
}

/** Successful `op: "search"` outcome. */
export interface ScraplingSearchOutcome {
  readonly results: readonly ScraplingSearchResultItem[]
  readonly count: number
}

/** Successful `op: "fetch"` outcome. */
export interface ScraplingFetchOutcome {
  readonly url: string
  readonly status: number
  readonly content: string
  readonly truncated: boolean
}

/**
 * Any outcome that carries `error` at the top level is a domain failure whose
 * message surfaces verbatim in the thrown `WebError`; `environment: true`
 * additionally marks the managed venv as broken so the caller re-runs setup.
 */
export interface ScraplingErrorOutcome {
  readonly error: string
  readonly environment?: boolean
}

/** The parsed stdout of one Python tool run: exactly one outcome object. */
export type ScraplingOutcome = ScraplingSearchOutcome | ScraplingFetchOutcome | ScraplingErrorOutcome
