/**
 * `@deepseek-ai/dsh-web-scrapling`: registers a keyless DuckDuckGo search
 * provider and a Scrapling-backed fetch provider with `ctx.web`. A
 * function/namespace plugin (NOT a default-export service): providers do not
 * own the `ctx.web` key — they register INTO the seam's provider registries.
 * Both providers share one managed Python venv, created and installed on
 * first use under `$DSH_HOME/web-scrapling` unless a `venvRoot` is configured.
 *
 * @module @deepseek-ai/dsh-web-scrapling
 */

import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { DuckDuckGoSearchProvider, ScraplingFetchProvider } from './provider.ts'
import { ScraplingRuntime } from './runtime.ts'

export {
  DUCKDUCKGO_PROVIDER_ID,
  SCRAPLING_PROVIDER_ID,
  SCRAPLING_FETCH_TIMEOUT,
  SCRAPLING_SEARCH_TIMEOUT,
  DuckDuckGoSearchProvider,
  ScraplingFetchProvider,
} from './provider.ts'
export type { ScraplingFetchOptions } from './provider.ts'
export { SCRAPLING_SCRIPT_PATH, ScraplingRuntime } from './runtime.ts'
export type { InterpreterLauncher, ScraplingRuntimeOptions } from './runtime.ts'
export type {
  ScraplingErrorOutcome,
  ScraplingFetchOutcome,
  ScraplingOutcome,
  ScraplingRequest,
  ScraplingSearchOutcome,
  ScraplingSearchResultItem,
} from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-scrapling'

/** The web seam these providers register into. */
export const inject = ['web']

/** Default directory of the managed Python venv. */
export const DEFAULT_VENV_ROOT = dshHomePath('web-scrapling')

/** Default result count acquired when a request carries no `maxResults`. */
const DEFAULT_SEARCH_TIMEOUT_MS = 120_000

/** Default deadline for one fetch exchange (browser modes are slower than plain HTTP). */
const DEFAULT_FETCH_TIMEOUT_MS = 180_000

/** Default bound on the whole one-time setup pipeline (pip and browser downloads). */
const DEFAULT_SETUP_TIMEOUT_MS = 600_000

/** Default maximum extracted characters returned by one fetch. */
const DEFAULT_MAX_BODY_CHARS = 50_000

/** Plugin config (all optional — `apply` fills defaults). */
export interface Config {
  /** Base Python 3.10+ interpreter for venv creation; absent = platform candidates. */
  pythonCommand?: string
  /** Directory receiving the managed venv. Defaults to `$DSH_HOME/web-scrapling`. */
  venvRoot?: string
  /** Create and install the venv on first use; `false` fails loud with instructions. */
  autoSetup?: boolean
  /** Scrapling acquisition mode for fetch; stealth/dynamic drive a browser engine. */
  fetchMode?: 'standard' | 'stealth' | 'dynamic'
  /** Stealth mode: attempt Cloudflare challenge solving. */
  solveCloudflare?: boolean
  /** Dynamic mode: wait for network idle before extraction. */
  networkIdle?: boolean
  /** Maximum extracted characters returned by one fetch. */
  maxBodyChars?: number
  /** Deadline for one search exchange in milliseconds. */
  searchTimeoutMs?: number
  /** Deadline for one fetch exchange in milliseconds. */
  fetchTimeoutMs?: number
  /** Bound for the whole one-time setup pipeline in milliseconds. */
  setupTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  pythonCommand: z.string(),
  venvRoot: z.string(),
  autoSetup: z.boolean().default(true),
  fetchMode: z.union(['standard', 'stealth', 'dynamic'] as const).default('standard'),
  solveCloudflare: z.boolean().default(false),
  networkIdle: z.boolean().default(false),
  maxBodyChars: z.number().step(1).min(1).default(DEFAULT_MAX_BODY_CHARS),
  searchTimeoutMs: z.number().min(1_000).default(DEFAULT_SEARCH_TIMEOUT_MS),
  fetchTimeoutMs: z.number().min(1_000).default(DEFAULT_FETCH_TIMEOUT_MS),
  setupTimeoutMs: z.number().min(1_000).default(DEFAULT_SETUP_TIMEOUT_MS),
})

/** Register the DuckDuckGo search provider and the Scrapling fetch provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  const fetchMode = config.fetchMode ?? 'standard'
  const runtime = new ScraplingRuntime({
    pythonCommand: config.pythonCommand,
    venvRoot: config.venvRoot ?? DEFAULT_VENV_ROOT,
    autoSetup: config.autoSetup ?? true,
    needsBrowsers: fetchMode !== 'standard',
    setupTimeoutMs: config.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS,
  })
  ctx.web.registerSearchProvider(new DuckDuckGoSearchProvider(
    runtime,
    config.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
  ))
  ctx.web.registerFetchProvider(new ScraplingFetchProvider(runtime, {
    mode: fetchMode,
    solveCloudflare: config.solveCloudflare ?? false,
    networkIdle: config.networkIdle ?? false,
    maxBodyChars: config.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS,
    timeoutMs: config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  }))
}
