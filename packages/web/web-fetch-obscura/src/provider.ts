/**
 * `ObscuraFetchProvider`: a `WebFetchProvider` backed by the self-hosted Obscura
 * headless browser. Each fetch runs a raw status probe (the CLI's batch path)
 * followed by a rendered dump, so the seam's `statusCode` stays truthful while
 * the body carries Obscura's rendered markdown/text/html. When the probe cannot
 * answer — the raw path is exactly what anti-bot targets block first — a
 * successful render reports HTTP 200 and the README documents the caveat.
 * @module @deepseek-ai/dsh-web-fetch-obscura/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebFetchBody,
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
} from '@deepseek-ai/dsh-web'
import type { ObscuraDumpFormat } from './types.ts'
import type { ObscuraRuntime } from './runtime.ts'
import { OBSCURA_FETCH_TIMEOUT } from './runtime.ts'

/** Stable id this provider registers under. */
export const OBSCURA_PROVIDER_ID = 'obscura'

/** Deployment-resolved fetch acquisition options. */
export interface ObscuraFetchOptions {
  /** Extraction format requested from the rendered page. */
  readonly dumpFormat: ObscuraDumpFormat
  /** Probe the raw HTTP status before rendering (see the class doc for the fallback). */
  readonly statusProbe: boolean
  /** Maximum returned characters (the acquisition cap). */
  readonly maxBodyChars: number
  /** Deadline for each of the probe and the render, in milliseconds. */
  readonly timeoutMs: number
}

/** The Obscura-backed fetch provider; extraction yields `kind: "text"` for markdown/text dumps. */
export class ObscuraFetchProvider implements WebFetchProvider {
  readonly id = OBSCURA_PROVIDER_ID

  constructor(
    private readonly runtime: ObscuraRuntime,
    private readonly options: ObscuraFetchOptions,
  ) {}

  available(): boolean {
    return this.runtime.available()
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const url = validateUrl(request.url)
    const target = url.toString()
    const status = this.options.statusProbe
      ? await this.runtime.probeStatus(target, this.options.timeoutMs, signal)
      : undefined
    const rendered = await this.runtime.render(
      target,
      this.options.dumpFormat,
      this.options.maxBodyChars,
      this.options.timeoutMs,
      signal,
    )
    // The probe is advisory (see the class doc): a successful render of an
    // unprobed target reports 200 because the engine rendered a document whose
    // exact status is unprovable, never a fabricated error status.
    const statusCode = status ?? 200
    const body: WebFetchBody = this.options.dumpFormat === 'html'
      ? { kind: 'html', content: rendered.content }
      : { kind: 'text', content: rendered.content }
    return { url: rendered.url ?? target, statusCode, body, truncated: rendered.truncated }
  }
}

/**
 * Validate one fetch target as an absolute http(s) URL.
 * @param raw - the request's URL string.
 * @returns the parsed URL.
 * @throws {@link WebError} `WEB_INVALID_URL` for a non-absolute or non-http(s) target.
 */
export function validateUrl(raw: string): URL {
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

export { OBSCURA_FETCH_TIMEOUT }
