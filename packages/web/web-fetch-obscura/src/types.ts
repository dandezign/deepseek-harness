/**
 * Obscura CLI wire types: the batch path's JSON status line (one per URL on
 * stdout) used as the fetch provider's status probe.
 * @module @deepseek-ai/dsh-web-fetch-obscura/types
 */

/** One successful batch status line (`ok: true`): the raw response's facts. */
export interface ObscuraProbeSuccess {
  readonly url: string
  readonly ok: true
  readonly status: number
  readonly content_type: string
  readonly bytes: number
  readonly elapsed_ms: number
}

/** One failed batch status line (`ok: false`): the error text and timing. */
export interface ObscuraProbeFailure {
  readonly url: string
  readonly ok: false
  readonly error: string
  readonly elapsed_ms: number
}

/** The batch path prints exactly one JSON status line per input URL. */
export type ObscuraProbeLine = ObscuraProbeSuccess | ObscuraProbeFailure

/** Extraction format requested from the rendered page, mapped to `--dump`. */
export type ObscuraDumpFormat = 'markdown' | 'text' | 'html'
