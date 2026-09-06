import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { OBSCURA_PROVIDER_ID, ObscuraFetchProvider, validateUrl } from '../src/provider.ts'
import { ObscuraRuntime, parseProbeLine, OBSCURA_FETCH_TIMEOUT } from '../src/runtime.ts'
import type { InterpreterLauncher, ObscuraRuntimeOptions } from '../src/runtime.ts'
import * as obscuraPlugin from '../src/index.ts'

const fixturePath = fileURLToPath(new URL('./fixtures/obscura-fixture.mjs', import.meta.url))

/** One simulated subprocess exchange. */
type FakeExchange = { code: number | null; stdout: string; stderr: string; stderrHead: string }

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-obscura-'))

const defaultOptions = {
  dumpFormat: 'markdown' as const,
  statusProbe: true,
  maxBodyChars: 50_000,
  timeoutMs: 60_000,
}

/** Runtime whose exchanges are scripted in memory; records every call's args. */
class ScriptedRuntime extends ObscuraRuntime {
  readonly calls: Array<{ readonly args: readonly string[]; readonly stdin: string | undefined }> = []
  probeExchanges: FakeExchange[] = []
  renderExchanges: FakeExchange[] = []

  constructor(options: ObscuraRuntimeOptions = { commandPath: 'unused' }) {
    super(options)
  }

  protected override collect(
    _command: string,
    args: readonly string[],
    _signal: AbortSignal,
    stdinInput?: string,
  ): Promise<FakeExchange> {
    const isProbe = args.includes('--file')
    this.calls.push({ args, stdin: stdinInput })
    const scripted = isProbe ? this.probeExchanges.shift() : this.renderExchanges.shift()
    if (scripted === undefined) throw new Error(`no scripted exchange for ${isProbe ? 'probe' : 'render'}`)
    return Promise.resolve(scripted)
  }
}

/** Runtime that spawns the node fixture, exercising the real spawn machinery. */
class FixtureRuntime extends ObscuraRuntime {
  constructor() {
    super({ commandPath: 'unused' })
  }

  protected override launcher(): InterpreterLauncher {
    return { command: process.execPath, argsPrefix: [fixturePath] }
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('probe line parsing', () => {
  it('parses a success line and returns its status', () => {
    expect(parseProbeLine('{"url":"https://a.test","ok":true,"status":404,"content_type":"text/html","bytes":10,"elapsed_ms":5}'))
      .toEqual({ url: 'https://a.test', ok: true, status: 404, content_type: 'text/html', bytes: 10, elapsed_ms: 5 })
  })

  it('parses a failure line', () => {
    expect(parseProbeLine('{"url":"https://a.test","ok":false,"error":"blocked","elapsed_ms":5}'))
      .toEqual({ url: 'https://a.test', ok: false, error: 'blocked', elapsed_ms: 5 })
  })

  it('takes the last non-blank line and tolerates leading noise', () => {
    const stdout = '\nwarning line\n{"url":"https://a.test","ok":true,"status":200,"content_type":"","bytes":1,"elapsed_ms":1}\n\n'
    expect(parseProbeLine(stdout)).toMatchObject({ ok: true, status: 200 })
  })

  it('rejects garbage, primitives, and objects without a boolean ok', () => {
    expect(parseProbeLine('')).toBeUndefined()
    expect(parseProbeLine('not json')).toBeUndefined()
    expect(parseProbeLine('42')).toBeUndefined()
    expect(parseProbeLine('{"url":"https://a.test"}')).toBeUndefined()
  })
})

describe('URL validation', () => {
  it('accepts an absolute http(s) URL', () => {
    expect(validateUrl('https://a.test/x').toString()).toBe('https://a.test/x')
  })

  it('rejects a non-absolute or non-http(s) target as WEB_INVALID_URL', () => {
    expect(() => validateUrl('not a url')).toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
    expect(() => validateUrl('ftp://a.test/x')).toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
  })
})

describe('ObscuraFetchProvider orchestration', () => {
  it('renders after the probe and reports the probed status', async () => {
    const runtime = new ScriptedRuntime()
    runtime.probeExchanges.push({
      code: 0,
      stdout: '{"url":"https://a.test","ok":true,"status":404,"content_type":"","bytes":0,"elapsed_ms":1}',
      stderr: '',
      stderrHead: '',
    })
    runtime.renderExchanges.push({ code: 0, stdout: '# rendered', stderr: '', stderrHead: '' })

    const result = await new ObscuraFetchProvider(runtime, defaultOptions).fetch({ url: 'https://a.test' })

    expect(result).toEqual({
      url: 'https://a.test/',
      statusCode: 404,
      body: { kind: 'text', content: '# rendered' },
      truncated: false,
    })
  })

  it('reports the final URL when the render exchange reports one', async () => {
    const runtime = new ScriptedRuntime()
    const report = 'Fetching https://a.test/...\nPage loaded: https://final.test/full - "T"\n'
    runtime.renderExchanges.push({
      code: 0,
      stdout: 'rendered',
      stderr: report,
      stderrHead: report,
    })
    const result = await new ObscuraFetchProvider(runtime, defaultOptions).fetch({ url: 'https://a.test' })
    expect(result.url).toBe('https://final.test/full')
  })

  it('falls back to HTTP 200 when the probe cannot answer, still rendering', async () => {
    const runtime = new ScriptedRuntime()
    runtime.probeExchanges.push({ code: 1, stdout: '', stderr: 'probe broken', stderrHead: '' })
    runtime.renderExchanges.push({ code: 0, stdout: 'rendered', stderr: '', stderrHead: '' })
    const result = await new ObscuraFetchProvider(runtime, defaultOptions).fetch({ url: 'https://a.test' })
    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual({ kind: 'text', content: 'rendered' })
  })

  it('falls back to HTTP 200 when the probe line is unparseable', async () => {
    const runtime = new ScriptedRuntime()
    runtime.probeExchanges.push({ code: 0, stdout: 'garbage', stderr: '', stderrHead: '' })
    runtime.renderExchanges.push({ code: 0, stdout: 'rendered', stderr: '', stderrHead: '' })
    const result = await new ObscuraFetchProvider(runtime, defaultOptions).fetch({ url: 'https://a.test' })
    expect(result.statusCode).toBe(200)
  })

  it('skips the probe entirely when statusProbe is false', async () => {
    const runtime = new ScriptedRuntime()
    runtime.renderExchanges.push({ code: 0, stdout: 'rendered', stderr: '', stderrHead: '' })
    const result = await new ObscuraFetchProvider(runtime, { ...defaultOptions, statusProbe: false })
      .fetch({ url: 'https://a.test' })
    expect(result.statusCode).toBe(200)
    expect(runtime.calls).toHaveLength(1)
    expect(runtime.calls[0]?.args.includes('--file')).toBe(false)
  })

  it('maps an html dump to an html body', async () => {
    const runtime = new ScriptedRuntime()
    runtime.renderExchanges.push({ code: 0, stdout: '<p>hi</p>', stderr: '', stderrHead: '' })
    const result = await new ObscuraFetchProvider(runtime, { ...defaultOptions, statusProbe: false, dumpFormat: 'html' })
      .fetch({ url: 'https://a.test' })
    expect(result.body).toEqual({ kind: 'html', content: '<p>hi</p>' })
  })

  it('caps the body and flags the truncation', async () => {
    const runtime = new ScriptedRuntime()
    runtime.renderExchanges.push({ code: 0, stdout: 'abcdefgh', stderr: '', stderrHead: '' })
    const result = await new ObscuraFetchProvider(runtime, { ...defaultOptions, statusProbe: false, maxBodyChars: 4 })
      .fetch({ url: 'https://a.test' })
    expect(result.body).toEqual({ kind: 'text', content: 'abcd' })
    expect(result.truncated).toBe(true)
  })

  it('fails as WEB_PROVIDER_ERROR when the render exchange exits non-zero', async () => {
    const runtime = new ScriptedRuntime()
    runtime.renderExchanges.push({ code: 1, stdout: '', stderr: 'render broke: navigation failed', stderrHead: '' })
    const failure = new ObscuraFetchProvider(runtime, defaultOptions).fetch({ url: 'https://a.test' })
    await expect(failure).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    await expect(failure).rejects.toThrow(/navigation failed/)
  })

  it('fails as WEB_INVALID_URL without spawning when the target is not http(s)', async () => {
    const runtime = new ScriptedRuntime()
    await expect(new ObscuraFetchProvider(runtime, defaultOptions).fetch({ url: 'ftp://a.test/x' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
    expect(runtime.calls).toHaveLength(0)
  })

  it('sends the probe through the batch path and the render without --quiet, with the URL on stdin', async () => {
    const runtime = new ScriptedRuntime()
    runtime.probeExchanges.push({ code: 0, stdout: '{"url":"https://a.test","ok":true,"status":200,"content_type":"","bytes":0,"elapsed_ms":1}', stderr: '', stderrHead: '' })
    runtime.renderExchanges.push({ code: 0, stdout: 'x', stderr: '', stderrHead: '' })
    await new ObscuraFetchProvider(runtime, { ...defaultOptions, timeoutMs: 90_000 }).fetch({ url: 'https://a.test' })

    const probe = runtime.calls[0]
    expect(probe?.args).toEqual([
      'fetch', '--quiet', '--file', '-', '--concurrency', '1', '--timeout', '90',
    ])
    expect(probe?.stdin).toBe('https://a.test/\n')

    const render = runtime.calls[1]
    expect(render?.args).toEqual(['fetch', '--dump', 'markdown', '--timeout', '90', 'https://a.test/'])
    expect(render?.stdin).toBeUndefined()
  })

  it('propagates a pre-aborted signal as WEB_ABORTED from the probe', async () => {
    const runtime = new ScriptedRuntime()
    const controller = new AbortController()
    controller.abort()
    await expect(new ObscuraFetchProvider(runtime, defaultOptions).fetch({ url: 'https://a.test' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(runtime.calls).toHaveLength(0)
  })
})

describe('ObscuraRuntime exchanges (fixture interpreter)', () => {
  it('probes a status through the real spawn machinery', async () => {
    vi.stubEnv('DSH_OBSCURA_FIXTURE_PROBE', '{"url":"https://a.test","ok":true,"status":403,"content_type":"","bytes":0,"elapsed_ms":1}')
    const runtime = new FixtureRuntime()
    await expect(runtime.probeStatus('https://a.test', 60_000)).resolves.toBe(403)
  })

  it('treats a failed probe exchange as an unknown status', async () => {
    vi.stubEnv('DSH_OBSCURA_FIXTURE_PROBE', 'exit1')
    const runtime = new FixtureRuntime()
    await expect(runtime.probeStatus('https://a.test', 60_000)).resolves.toBeUndefined()
  })

  it('treats a failed probe line as an unknown status', async () => {
    vi.stubEnv('DSH_OBSCURA_FIXTURE_PROBE', 'garbage')
    const runtime = new FixtureRuntime()
    await expect(runtime.probeStatus('https://a.test', 60_000)).resolves.toBeUndefined()
  })

  it('rejects a probe with a pre-aborted signal as WEB_ABORTED', async () => {
    const runtime = new FixtureRuntime()
    const controller = new AbortController()
    controller.abort()
    await expect(runtime.probeStatus('https://a.test', 60_000, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('renders the dump content and reports the loaded URL from stderr', async () => {
    vi.stubEnv('DSH_OBSCURA_FIXTURE_RENDER', '# page')
    const runtime = new FixtureRuntime()
    await expect(runtime.render('https://a.test', 'markdown', 100, 60_000)).resolves.toEqual({
      content: '# page',
      truncated: false,
      url: 'https://final.test/full',
    })
  })

  it('treats an immediately exiting probe child as an unknown status without crashing', async () => {
    vi.stubEnv('DSH_OBSCURA_FIXTURE_PROBE', 'no-drain')
    const runtime = new FixtureRuntime()
    await expect(runtime.probeStatus('https://a.test', 60_000)).resolves.toBeUndefined()
  })

  it('fails loud when the render exchange exits non-zero', async () => {
    vi.stubEnv('DSH_OBSCURA_FIXTURE_RENDER', 'exit1')
    const runtime = new FixtureRuntime()
    const failure = runtime.render('https://a.test', 'markdown', 100, 60_000)
    await expect(failure).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    await expect(failure).rejects.toThrow(/navigation error/)
  })

  it('times a stuck render out with the provider-owned code', async () => {
    vi.stubEnv('DSH_OBSCURA_FIXTURE_RENDER', 'sleep')
    const runtime = new FixtureRuntime()
    await expect(runtime.render('https://a.test', 'markdown', 100, 300))
      .rejects.toThrow(expect.objectContaining({ code: OBSCURA_FETCH_TIMEOUT }))
  }, 10_000)

  it('kills a stuck render on mid-flight abort', async () => {
    vi.stubEnv('DSH_OBSCURA_FIXTURE_RENDER', 'sleep')
    const runtime = new FixtureRuntime()
    const controller = new AbortController()
    const pending = runtime.render('https://a.test', 'markdown', 100, 60_000, controller.signal)
    setTimeout(() => { controller.abort() }, 100)
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  }, 10_000)
})

describe('ObscuraRuntime availability', () => {
  it('is available when the configured executable exists', () => {
    const existing = join(tmp(), 'obscura.exe')
    writeFileSync(existing, '')
    expect(new ObscuraRuntime({ commandPath: existing }).available()).toBe(true)
  })

  it('is unavailable when the configured executable is missing', () => {
    expect(new ObscuraRuntime({ commandPath: join(tmp(), 'missing-obscura.exe') }).available()).toBe(false)
  })
})

describe('web-fetch-obscura plugin registration', () => {
  it('registers the provider into ctx.web and reports an unconfigured binary as unavailable', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: OBSCURA_PROVIDER_ID })
    const missing = join(tmp(), 'missing-obscura.exe')
    const fiber = await ctx.plugin(obscuraPlugin, { commandPath: missing })
    await expect(ctx.web.fetch({ url: 'https://a.test' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
    await fiber.dispose()
    await expect(ctx.web.fetch({ url: 'https://a.test' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('auto-selects as the only usable provider when the binary exists', async () => {
    const existing = join(tmp(), 'obscura.exe')
    writeFileSync(existing, '')
    const ctx = new Context()
    await ctx.plugin(WebRuntime, {})
    await ctx.plugin(obscuraPlugin, { commandPath: existing })
    // A pre-aborted signal fails inside the resolved provider BEFORE any
    // exchange; reaching WEB_ABORTED (rather than a selection error) proves
    // auto-selection resolved this package's provider.
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.web.fetch({ url: 'https://a.test' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in obscuraPlugin).toBe(false)
  })
})
