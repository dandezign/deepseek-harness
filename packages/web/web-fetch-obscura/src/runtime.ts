/**
 * Subprocess runner for the Obscura-backed fetch provider. Obscura is a single
 * self-contained binary (no managed environment), so this runtime only owns
 * one exchange per operation: a raw status probe through the CLI's batch path,
 * and one rendered dump per fetch. `collect()` is the substitution seam for
 * tests, mirroring `ScraplingRuntime`.
 * @module @deepseek-ai/dsh-web-fetch-obscura/runtime
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { WebError } from '@deepseek-ai/dsh-web'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ObscuraDumpFormat, ObscuraProbeLine } from './types.ts'

/** Provider-owned timeout code for one fetch exchange (probe or render). */
export const OBSCURA_FETCH_TIMEOUT = 'OBSCURA_FETCH_TIMEOUT'

/** The process identity that executes one CLI exchange. */
export interface InterpreterLauncher {
  /** Executable that runs one exchange. */
  readonly command: string
  /** Arguments placed before the CLI arguments. */
  readonly argsPrefix: readonly string[]
}

/** Fully resolved runtime options (the plugin's `apply` supplies defaults). */
export interface ObscuraRuntimeOptions {
  /** Absolute path of the Obscura CLI executable. */
  readonly commandPath: string
}

/** One collected subprocess exchange. */
interface Exchange {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  /** First bytes of stderr, where the CLI reports the loaded URL before any later noise. */
  readonly stderrHead: string
}

/** Largest stdout accepted from one exchange (the provider caps the body below this). */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024

/** Largest stderr tail retained for failure diagnostics. */
const MAX_STDERR_CHARS = 4096

/** Largest stderr head retained for success diagnostics (the loaded-URL report). */
const MAX_STDERR_HEAD_CHARS = 2048

/**
 * The Obscura CLI runtime shared by every fetch operation. One instance per
 * plugin fiber; each operation spawns a fresh short-lived CLI process, so no
 * setup pipeline or shared child state exists.
 */
export class ObscuraRuntime {
  constructor(private readonly options: ObscuraRuntimeOptions) {}

  /**
   * Cheap local usability check for seam provider selection.
   * @returns true when the configured executable exists on disk.
   */
  available(): boolean {
    return existsSync(this.options.commandPath)
  }

  /**
   * Probe one URL's HTTP status through the CLI's raw batch path (no render).
   * The probe is advisory: every failure except caller cancellation — a broken
   * exchange, an unparseable line, a timeout, or an anti-bot block on the raw
   * path — yields `undefined` so the caller can still attempt the render.
   *
   * @param url - the absolute http(s) URL to probe.
   * @param timeoutMs - probe deadline; the child is killed past it.
   * @param signal - caller cancellation; surfaces as `WEB_ABORTED`.
   * @returns the raw response's HTTP status, or `undefined` when unknown.
   * @throws {@link WebError} `WEB_ABORTED` on caller cancellation.
   */
  async probeStatus(url: string, timeoutMs: number, signal?: AbortSignal): Promise<number | undefined> {
    let exchange: Exchange
    try {
      exchange = (await this.exchange(
        ['fetch', '--quiet', '--file', '-', '--concurrency', '1', '--timeout', String(Math.max(1, Math.ceil(timeoutMs / 1000)))],
        `${url}\n`,
        timeoutMs,
        signal,
      )).exchange
    } catch (_error: unknown) {
      // Only caller cancellation propagates; every other probe failure — a
      // broken exchange, an overflow, a deadline — is advisory (the class doc).
      if (signal?.aborted) throw aborted(signal.reason)
      return undefined
    }
    if (signal?.aborted) throw aborted(signal.reason)
    if (exchange.code !== 0) return undefined
    const line = parseProbeLine(exchange.stdout)
    if (line === undefined) return undefined
    // A non-2xx response marks the line not `ok` but still carries the real
    // status — exactly what the seam wants reported for error pages.
    return 'status' in line ? line.status : undefined
  }

  /**
   * Render one URL and dump the page in the requested format. The CLI writes
   * only the dump to stdout; its stderr reports the loaded URL after redirects
   * (`Page loaded: <url> - "<title>"`) plus later page noise, so the head of
   * stderr is parsed for the final URL and the tail kept for failures.
   * Navigation failures exit non-zero with the reason on stderr.
   *
   * @param url - the absolute http(s) URL to render.
   * @param format - extraction format requested from the rendered page.
   * @param maxBodyChars - maximum returned characters (the acquisition cap).
   * @param timeoutMs - render deadline; the child is killed past it.
   * @param signal - caller cancellation; surfaces as `WEB_ABORTED`.
   * @returns the dump content capped to `maxBodyChars`, the truncation flag,
   *   and the loaded URL when the CLI reported one.
   * @throws {@link WebError} `WEB_ABORTED` on caller cancellation, the provider
   *   timeout code on deadline, or `WEB_PROVIDER_ERROR` on a failed exchange.
   */
  async render(
    url: string,
    format: ObscuraDumpFormat,
    maxBodyChars: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ content: string; truncated: boolean; url?: string }> {
    const exchange = await this.exchange(
      [
        'fetch',
        '--dump',
        format,
        '--timeout',
        String(Math.max(1, Math.ceil(timeoutMs / 1000))),
        url,
      ],
      undefined,
      timeoutMs,
      signal,
    )
    const timeout = timeoutOf(exchange.timeoutSignal, OBSCURA_FETCH_TIMEOUT)
    if (timeout !== undefined) {
      throw new WebError(`Obscura fetch timed out after ${timeoutMs}ms`, OBSCURA_FETCH_TIMEOUT, { cause: timeout })
    }
    if (exchange.timeoutSignal.aborted) throw aborted(exchange.timeoutSignal.reason)
    if (exchange.exchange.code !== 0) {
      throw new WebError(
        `Obscura fetch failed with exit code ${exchange.exchange.code ?? 'signal'}: ${describeExchange(exchange.exchange)}`,
        'WEB_PROVIDER_ERROR',
      )
    }
    return { ...capContent(exchange.exchange.stdout, maxBodyChars), ...loadedUrlOf(exchange.exchange.stderrHead) }
  }

  /**
   * One subprocess exchange with abort, timeout, and size guards. The optional
   * stdin input carries the probe's URL list. Protected so tests can simulate
   * CLI exchanges without spawning real processes.
   */
  protected collect(command: string, args: readonly string[], signal: AbortSignal, stdinInput?: string): Promise<Exchange> {
    return new Promise<Exchange>((resolve, reject) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(command, args, {
          stdio: [stdinInput !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error: unknown) {
        reject(new WebError(`failed to start "${command}": ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error }))
        return
      }
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      const stderrHead: Buffer[] = []
      let stdoutBytes = 0
      let stderrHeadBytes = 0
      let overflowed = false
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          overflowed = true
          child.kill()
          return
        }
        stdout.push(chunk)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr.push(chunk.length > MAX_STDERR_CHARS ? chunk.subarray(0, MAX_STDERR_CHARS) : chunk)
        if (stderrHeadBytes < MAX_STDERR_HEAD_CHARS) {
          stderrHeadBytes += chunk.byteLength
          stderrHead.push(chunk.length > MAX_STDERR_HEAD_CHARS ? chunk.subarray(0, MAX_STDERR_HEAD_CHARS) : chunk)
        }
      })
      if (stdinInput !== undefined) {
        // A child that exits before consuming stdin makes this write fail with
        // EPIPE; the stream's error must not reach the process unhandled, and
        // the child's exit code already carries the real failure.
        child.stdin?.on('error', () => {})
        child.stdin?.end(stdinInput)
      }
      const onAbort = (): void => { child.kill() }
      signal.addEventListener('abort', onAbort, { once: true })
      child.on('error', (error: Error) => {
        signal.removeEventListener('abort', onAbort)
        reject(new WebError(`"${command}" could not run: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error }))
      })
      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort)
        if (overflowed) {
          reject(new WebError(`the Obscura CLI emitted more than ${MAX_STDOUT_BYTES} bytes`, 'WEB_PROVIDER_ERROR'))
          return
        }
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8').slice(-MAX_STDERR_CHARS),
          stderrHead: Buffer.concat(stderrHead).toString('utf8').slice(0, MAX_STDERR_HEAD_CHARS),
        })
      })
    })
  }

  /** Run one exchange under a deadline and hand back the exchange with its signal. */
  private async exchange(
    args: readonly string[],
    stdinInput: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ exchange: Exchange; timeoutSignal: AbortSignal }> {
    if (signal?.aborted) throw aborted(signal.reason)
    using d = deadline(signal, timeoutMs, OBSCURA_FETCH_TIMEOUT)
    const launcher = this.launcher()
    const exchange = await this.collect(launcher.command, [...launcher.argsPrefix, ...args], d.signal, stdinInput)
    return { exchange, timeoutSignal: d.signal }
  }

  /**
   * The process identity that executes one CLI exchange. Overridden by tests
   * that substitute a fixture interpreter for the real binary.
   */
  protected launcher(): InterpreterLauncher {
    return { command: this.options.commandPath, argsPrefix: [] }
  }
}

/** Parse the batch path's last non-blank stdout line into a probe record.
 * @param stdout - the exchange's raw stdout.
 * @returns the parsed probe line, or `undefined` when no line parses.
 */
export function parseProbeLine(stdout: string): ObscuraProbeLine | undefined {
  const lines = stdout.trim().split('\n').filter(line => line.trim().length > 0)
  const last = lines.at(-1)
  if (last === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(last)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const candidate = parsed as { ok?: unknown }
    return typeof candidate.ok === 'boolean' ? parsed as ObscuraProbeLine : undefined
  } catch {
    return undefined
  }
}

/** The CLI's post-navigation report line, kept verbatim for the parser. */
const LOADED_URL_PATTERN = /^Page loaded: (\S+) - /m

/**
 * Extract the loaded URL from the exchange's stderr head.
 * @param stderrHead - the first bytes of the render exchange's stderr.
 * @returns the final URL wrapped for spreading, or an empty object when the
 *   CLI reported none.
 */
function loadedUrlOf(stderrHead: string): { url?: string } {
  const match = LOADED_URL_PATTERN.exec(stderrHead)
  const url = match?.[1]
  return url === undefined ? {} : { url }
}

/** Cap the dump content to `maxBodyChars`, flagging the truncation. */
function capContent(content: string, maxBodyChars: number): { content: string; truncated: boolean } {
  return content.length > maxBodyChars
    ? { content: content.slice(0, maxBodyChars), truncated: true }
    : { content, truncated: false }
}

/** Human-readable tail of one exchange for diagnostics. */
function describeExchange(exchange: Exchange): string {
  const detail = exchange.stderr.trim()
  return detail.length > 0 ? detail : exchange.stdout.trim().slice(-512)
}

/** The stable cancellation error while retaining the caller's reason. */
function aborted(reason: unknown): WebError {
  return new WebError('Obscura fetch aborted', 'WEB_ABORTED', { cause: reason })
}
