/**
 * `@deepseek-ai/dsh-web-fetch-obscura`: registers an Obscura-backed fetch
 * provider with `ctx.web`. A function/namespace plugin (NOT a default-export
 * service): the provider does not own the `ctx.web` key — it registers INTO
 * the seam's provider registry. Obscura is a single self-contained binary
 * (no managed environment); its path defaults to
 * `$DSH_HOME/tools/obscura/obscura.exe` on Windows and
 * `$DSH_HOME/tools/obscura/obscura` elsewhere.
 *
 * @module @deepseek-ai/dsh-web-fetch-obscura
 */

import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { ObscuraFetchProvider } from './provider.ts'
import { ObscuraRuntime } from './runtime.ts'

export { OBSCURA_FETCH_TIMEOUT, ObscuraRuntime, parseProbeLine } from './runtime.ts'
export type { InterpreterLauncher, ObscuraRuntimeOptions } from './runtime.ts'
export { OBSCURA_PROVIDER_ID, ObscuraFetchProvider, validateUrl } from './provider.ts'
export type { ObscuraFetchOptions } from './provider.ts'
export type { ObscuraDumpFormat, ObscuraProbeFailure, ObscuraProbeLine, ObscuraProbeSuccess } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-fetch-obscura'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Default deadline for each probe and render exchange, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Default maximum returned characters for one fetch. */
export const DEFAULT_MAX_BODY_CHARS = 50_000

/** The executable name of the managed Obscura install for this platform.
 * @returns the platform's Obscura executable file name.
 */
export function defaultExecutable(): string {
  return process.platform === 'win32' ? 'obscura.exe' : 'obscura'
}

/** Default absolute path of the managed Obscura CLI executable.
 * @returns the absolute path of the managed Obscura CLI executable.
 */
export function defaultCommandPath(): string {
  return dshHomePath('tools', 'obscura', defaultExecutable())
}

/** Plugin config (all optional — `apply` fills defaults). */
export interface Config {
  /**
   * Absolute path of the Obscura CLI executable. Defaults to the managed
   * install at `$DSH_HOME/tools/obscura/` (obscura.exe on Windows).
   */
  commandPath?: string
  /** Extraction format requested from the rendered page. Defaults to `markdown`. */
  dumpFormat?: 'markdown' | 'text' | 'html'
  /** Probe the raw HTTP status before rendering. Defaults to true. */
  statusProbe?: boolean
  /** Maximum returned characters for one fetch. */
  maxBodyChars?: number
  /** Deadline for each probe and render exchange in milliseconds. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  commandPath: z.string(),
  dumpFormat: z.union(['markdown', 'text', 'html'] as const).default('markdown'),
  statusProbe: z.boolean().default(true),
  maxBodyChars: z.number().step(1).min(1).default(DEFAULT_MAX_BODY_CHARS),
  timeoutMs: z.number().min(1_000).default(DEFAULT_TIMEOUT_MS),
})

/** Register the Obscura fetch provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  const runtime = new ObscuraRuntime({
    commandPath: config.commandPath ?? defaultCommandPath(),
  })
  ctx.web.registerFetchProvider(new ObscuraFetchProvider(runtime, {
    dumpFormat: config.dumpFormat ?? 'markdown',
    statusProbe: config.statusProbe ?? true,
    maxBodyChars: config.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }))
}
