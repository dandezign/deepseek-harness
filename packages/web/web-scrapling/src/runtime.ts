/**
 * Managed Python environment and subprocess runner for the Scrapling-backed
 * web providers. Owns venv creation, `scrapling[fetchers]` installation, the
 * optional browser-engine install for stealth/dynamic fetching, and one
 * request/response exchange with `scripts/scrapling_tools.py` per operation.
 *
 * @module @deepseek-ai/dsh-web-scrapling/runtime
 */

import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WebError } from '@deepseek-ai/dsh-web'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ScraplingOutcome, ScraplingRequest } from './types.ts'

/** The Python tool this runtime executes, resolved beside the package lib. */
export const SCRAPLING_SCRIPT_PATH = fileURLToPath(new URL('../scripts/scrapling_tools.py', import.meta.url))

/** Stamp file proving a venv completed setup; absent or stale forces a repair pass. */
const SETUP_STAMP = 'dsh-setup-complete.json'

/** Interpreter identity used to execute the Python tool. */
export interface InterpreterLauncher {
  /** Executable that runs one tool exchange. */
  readonly command: string
  /** Arguments placed before the tool script path. */
  readonly argsPrefix: readonly string[]
}

/** Fully resolved runtime options (the plugin's `apply` supplies defaults). */
export interface ScraplingRuntimeOptions {
  /** Explicit base interpreter; absent = platform default candidates. */
  readonly pythonCommand: string | undefined
  /** Directory receiving the managed venv. */
  readonly venvRoot: string
  /** Create and install the venv on first use instead of failing loud. */
  readonly autoSetup: boolean
  /** Stealth/dynamic fetch modes need a browser engine installed. */
  readonly needsBrowsers: boolean
  /** Upper bound for the whole one-time setup pipeline. */
  readonly setupTimeoutMs: number
}

/** One collected subprocess exchange. */
interface Exchange {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Largest stdout accepted from the Python tool (its own max_chars bound keeps runs far below). */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024

/** Largest stderr tail retained for diagnostics. */
const MAX_STDERR_CHARS = 4096

/**
 * The managed-venv runtime shared by the search and fetch providers. One
 * instance per plugin fiber; the in-flight setup promise makes concurrent
 * first calls share one installation instead of racing two `pip` runs.
 */
export class ScraplingRuntime {
  private setupPromise: Promise<InterpreterLauncher> | undefined

  constructor(private readonly options: ScraplingRuntimeOptions) {}

  /**
   * Cheap local usability check for seam provider selection: with auto-setup
   * the runtime is always usable (setup runs at the first operation, the
   * earliest resolvable point); without it the venv must already be complete.
   * @returns true when the next operation can proceed.
   */
  available(): boolean {
    return this.options.autoSetup || this.setupComplete()
  }

  /**
   * Run one operation exchange against the Python tool.
   *
   * @param request - the JSON request object for the operation.
   * @param timeoutMs - operation deadline; the child is killed past it.
   * @param timeoutCode - provider-owned timeout code surfaced in the `WebError`.
   * @param signal - caller cancellation; the child is killed on abort.
   * @returns the parsed outcome object from the tool.
   * @throws {@link WebError} `WEB_ABORTED` on caller cancellation, the
   *   provider timeout code on deadline, or `WEB_PROVIDER_ERROR` on a broken
   *   exchange. An environment-marked failure repairs the venv once and
   *   retries the operation.
   */
  async run(
    request: ScraplingRequest,
    timeoutMs: number,
    timeoutCode: string,
    signal?: AbortSignal,
  ): Promise<ScraplingOutcome> {
    const first = await this.exchange(request, timeoutMs, timeoutCode, signal)
    if (first.code !== 3 && !isEnvironmentOutcome(first.outcome)) return requireOutcome(first.outcome)
    // Exit 3 or an environment-marked outcome means the venv itself is broken:
    // repair it once, then retry the operation through the fresh environment.
    await this.repair(signal)
    const second = await this.exchange(request, timeoutMs, timeoutCode, signal)
    if (second.code !== 3 && !isEnvironmentOutcome(second.outcome)) return requireOutcome(second.outcome)
    const detail = second.stderr.trim().length > 0 ? second.stderr.trim() : 'no further detail'
    throw new WebError(
      `the managed Scrapling environment stayed broken after one repair: ${detail}`,
      'WEB_PROVIDER_ERROR',
    )
  }

  /**
   * Resolve the launcher for the NEXT operation, creating and installing the
   * managed venv when auto-setup allows it. Overridden by tests that substitute
   * a fixture interpreter for the real venv pipeline.
   * @param signal - caller cancellation for the setup pipeline.
   * @returns the interpreter identity to execute the tool with.
   */
  protected async resolveLauncher(signal: AbortSignal | undefined): Promise<InterpreterLauncher> {
    if (this.setupComplete()) return this.venvLauncher()
    if (!this.options.autoSetup) {
      throw new WebError(
        `the managed Scrapling venv at "${this.options.venvRoot}" is not set up and autoSetup is false;`
        + ` create it with: python -m venv "${this.options.venvRoot}" &&`
        + ` "${this.venvPython()}" -m pip install "scrapling[fetchers]"`,
        'WEB_PROVIDER_UNAVAILABLE',
      )
    }
    this.setupPromise ??= this.setup(signal)
    try {
      return await this.setupPromise
    } catch (error: unknown) {
      // A failed setup must not pin the rejection: the next operation retries.
      this.setupPromise = undefined
      throw error
    }
  }

  /** Force a full setup pass on the next `resolveLauncher` (repair path). */
  private async repair(signal: AbortSignal | undefined): Promise<void> {
    this.setupPromise = this.setup(signal)
    try {
      await this.setupPromise
    } catch (error: unknown) {
      this.setupPromise = undefined
      throw error
    }
  }

  /** True when the venv interpreter and setup stamp both exist. */
  private setupComplete(): boolean {
    return existsSync(this.venvPython()) && existsSync(this.venvStamp())
  }

  private venvStamp(): string {
    return `${this.options.venvRoot}/${SETUP_STAMP}`
  }

  /**
   * Path of the venv's Python interpreter for the current platform.
   * @returns the interpreter path inside the managed venv.
   */
  venvPython(): string {
    return process.platform === 'win32'
      ? `${this.options.venvRoot}\\Scripts\\python.exe`
      : `${this.options.venvRoot}/bin/python`
  }

  private venvLauncher(): InterpreterLauncher {
    return { command: this.venvPython(), argsPrefix: [] }
  }

  /**
   * Create the venv, install `scrapling[fetchers]`, optionally install the
   * browser engine, and stamp completion. Every step is idempotent, so an
   * interrupted setup re-runs cleanly. Protected so tests can substitute a
   * fixture interpreter for the real installation pipeline.
   */
  protected async setup(signal: AbortSignal | undefined): Promise<InterpreterLauncher> {
    using d = deadline(signal, this.options.setupTimeoutMs, 'SCRAPLING_SETUP_TIMEOUT')
    const base = await this.locateBasePython(d.signal)
    await this.runToCompletion(base.command, [...base.argsPrefix, '-m', 'venv', this.options.venvRoot], d.signal, 'venv creation failed')
    const venv = this.venvLauncher()
    await this.runToCompletion(venv.command, ['-m', 'pip', 'install', '--upgrade', 'pip'], d.signal, 'pip self-upgrade failed')
    await this.runToCompletion(venv.command, ['-m', 'pip', 'install', 'scrapling[fetchers]'], d.signal, 'scrapling installation failed')
    if (this.options.needsBrowsers) {
      await this.runToCompletion(venv.command, ['-m', 'playwright', 'install', 'chromium'], d.signal, 'browser engine installation failed')
    }
    writeFileSync(this.venvStamp(), JSON.stringify({ tool: 'scrapling[fetchers]', browsers: this.options.needsBrowsers }))
    return venv
  }

  /**
   * Find a base Python 3.10+ interpreter among the platform candidates.
   * @returns the located interpreter identity.
   * @throws {@link WebError} `WEB_PROVIDER_UNAVAILABLE` when no candidate runs.
   */
  private async locateBasePython(signal: AbortSignal): Promise<InterpreterLauncher> {
    const candidates: readonly InterpreterLauncher[] = this.options.pythonCommand !== undefined
      ? [{ command: this.options.pythonCommand, argsPrefix: [] }]
      : process.platform === 'win32'
        ? [{ command: 'python', argsPrefix: [] }, { command: 'py', argsPrefix: ['-3'] }]
        : [{ command: 'python3', argsPrefix: [] }, { command: 'python', argsPrefix: [] }]
    for (const candidate of candidates) {
      const exchange = await this.collect(candidate.command, [...candidate.argsPrefix, '--version'], signal)
      if (exchange.code !== 0) continue
      const match = /Python (\d+)\.(\d+)/u.exec(exchange.stdout + exchange.stderr)
      if (match === null) continue
      const major = Number(match[1])
      const minor = Number(match[2])
      if (major > 3 || (major === 3 && minor >= 10)) return candidate
    }
    throw new WebError(
      'no Python 3.10+ interpreter was found; install one from python.org or set "pythonCommand" in the web-scrapling config',
      'WEB_PROVIDER_UNAVAILABLE',
    )
  }

  /** One full request/response exchange with abort, timeout, and size guards. */
  private async exchange(
    request: ScraplingRequest,
    timeoutMs: number,
    timeoutCode: string,
    signal?: AbortSignal,
  ): Promise<{ code: number | null; outcome: ScraplingOutcome | undefined; stderr: string }> {
    if (signal?.aborted) throw aborted(signal.reason)
    const launcher = await this.resolveLauncher(signal)
    using d = deadline(signal, timeoutMs, timeoutCode)
    const exchange = await this.collect(
      launcher.command,
      [...launcher.argsPrefix, SCRAPLING_SCRIPT_PATH, JSON.stringify(request)],
      d.signal,
    )
    const timeout = timeoutOf(d.signal, timeoutCode)
    if (timeout !== undefined) {
      throw new WebError(`Scrapling operation timed out after ${timeoutMs}ms`, timeoutCode, { cause: timeout })
    }
    if (d.signal.aborted) throw aborted(d.signal.reason)
    let outcome: ScraplingOutcome | undefined
    if (exchange.code === 0 || exchange.code === 3) {
      outcome = parseOutcome(exchange.stdout)
    }
    // Exit 3 legitimately carries no JSON (an import-time failure exits before
    // the contract applies); `run` treats it as the environment-broken signal.
    if (outcome === undefined && exchange.code !== 3) {
      throw new WebError(
        `the Scrapling tool exited with code ${exchange.code ?? 'signal'} without JSON: ${describeExchange(exchange)}`,
        'WEB_PROVIDER_ERROR',
      )
    }
    return { code: exchange.code, outcome, stderr: exchange.stderr }
  }

  /**
   * Spawn one command, stream its output into bounded buffers, and kill the
   * child when `signal` aborts. Resolution is on process close, so a killed
   * child settles deterministically. Protected so tests can simulate the
   * setup pipeline's exchanges without spawning real processes.
   */
  protected collect(command: string, args: readonly string[], signal: AbortSignal): Promise<Exchange> {
    return new Promise<Exchange>((resolve, reject) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(command, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        })
      } catch (error: unknown) {
        reject(new WebError(`failed to start "${command}": ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error }))
        return
      }
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
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
      })
      const onAbort = (): void => { child.kill() }
      signal.addEventListener('abort', onAbort, { once: true })
      child.on('error', (error: Error) => {
        signal.removeEventListener('abort', onAbort)
        reject(new WebError(`"${command}" could not run: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error }))
      })
      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort)
        if (overflowed) {
          reject(new WebError(`the Scrapling tool emitted more than ${MAX_STDOUT_BYTES} bytes`, 'WEB_PROVIDER_ERROR'))
          return
        }
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8').slice(-MAX_STDERR_CHARS),
        })
      })
    })
  }

  /** Run one setup step to completion, failing with its stderr on a non-zero exit. */
  private async runToCompletion(
    command: string,
    args: readonly string[],
    signal: AbortSignal,
    what: string,
  ): Promise<void> {
    const exchange = await this.collect(command, args, signal)
    if (exchange.code !== 0) {
      throw new WebError(`${what}: ${describeExchange(exchange)}`, 'WEB_PROVIDER_UNAVAILABLE')
    }
  }
}

/** Parse the tool's single-JSON-line stdout contract. */
function parseOutcome(stdout: string): ScraplingOutcome | undefined {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return undefined
  try {
    // JSON.parse returns primitives for `null`/`42`/`"x"` literals; only an
    // object can be an outcome.
    const parsed: unknown = JSON.parse(trimmed)
    return typeof parsed === 'object' && parsed !== null ? parsed as ScraplingOutcome : undefined
  } catch {
    return undefined
  }
}

/** The exchange's parsed outcome, or a thrown provider error for unusable stdout. */
function requireOutcome(outcome: ScraplingOutcome | undefined): ScraplingOutcome {
  if (outcome === undefined) throw new WebError('the Scrapling tool produced no JSON outcome', 'WEB_PROVIDER_ERROR')
  return outcome
}

/** True when the outcome marks the environment (not the operation) as broken. */
function isEnvironmentOutcome(outcome: ScraplingOutcome | undefined): outcome is ScraplingOutcome & { environment: true } {
  return outcome !== undefined && 'error' in outcome && (outcome as { environment?: boolean }).environment === true
}

/** Human-readable tail of one exchange for diagnostics. */
function describeExchange(exchange: Exchange): string {
  const detail = exchange.stderr.trim()
  return detail.length > 0 ? detail : exchange.stdout.trim().slice(-512)
}

/** The stable cancellation error while retaining the caller's reason. */
function aborted(reason: unknown): WebError {
  return new WebError('Scrapling operation aborted', 'WEB_ABORTED', { cause: reason })
}
