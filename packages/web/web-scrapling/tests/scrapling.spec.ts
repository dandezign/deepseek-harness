import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  DUCKDUCKGO_PROVIDER_ID,
  DuckDuckGoSearchProvider,
  SCRAPLING_PROVIDER_ID,
  ScraplingFetchProvider,
  mapSearchOutcome,
  requireFetchOutcome,
  requireSearchOutcome,
} from '../src/provider.ts'
import { ScraplingRuntime } from '../src/runtime.ts'
import type { InterpreterLauncher } from '../src/runtime.ts'
import * as scraplingPlugin from '../src/index.ts'

const fixturePath = fileURLToPath(new URL('./fixtures/tool-fixture.mjs', import.meta.url))

/** One simulated subprocess exchange. */
type FakeExchange = { code: number | null; stdout: string; stderr: string }

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-scrapling-'))

/** Runtime whose setup hands back the node fixture as the interpreter. */
class FixtureRuntime extends ScraplingRuntime {
  setups = 0

  constructor(venvRoot: string) {
    super({ pythonCommand: undefined, venvRoot, autoSetup: true, needsBrowsers: false, setupTimeoutMs: 60_000 })
  }

  protected override async setup(): Promise<InterpreterLauncher> {
    this.setups += 1
    return { command: process.execPath, argsPrefix: [fixturePath] }
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('search outcome mapping', () => {
  it('maps results, dropping URL-less entries and omitting empty optional fields', () => {
    expect(mapSearchOutcome({
      results: [
        { title: 'A', url: 'https://a.test', snippet: 'about a' },
        { title: '', url: 'https://b.test', snippet: '' },
        { title: 'C', url: '', snippet: 'orphan' },
      ],
      count: 3,
    })).toEqual({
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'about a' },
        { url: 'https://b.test' },
      ],
      truncated: false,
    })
  })

  it('carries a domain error as WEB_PROVIDER_ERROR', () => {
    expect(() => requireSearchOutcome({ error: 'blocked' })).toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(() => requireFetchOutcome({ error: 'blocked' })).toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('rejects an outcome of the wrong operation shape', () => {
    expect(() => requireSearchOutcome({ results: [], count: 0 }).results).not.toThrow()
    expect(() => requireSearchOutcome({ url: 'https://a.test', status: 200, content: 'x', truncated: false }))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(() => requireFetchOutcome({ results: [], count: 0 }))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('DuckDuckGoSearchProvider', () => {
  it('sends the query with a bounded result count and maps the outcome', async () => {
    const venv = tmp()
    const capture = join(venv, 'capture.log')
    vi.stubEnv('DSH_FIXTURE_CAPTURE', capture)
    const provider = new DuckDuckGoSearchProvider(new FixtureRuntime(venv), 5_000)
    await expect(provider.search({ query: 'harness', maxResults: 5 })).resolves.toEqual({
      sources: [{ url: 'https://a.test', title: 'A', snippet: 'about a' }],
      truncated: false,
    })
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual({ op: 'search', query: 'harness', numResults: 5 })
  })

  it('defaults to ten results and caps the page size at twenty', async () => {
    const venv = tmp()
    const capture = join(venv, 'capture.log')
    vi.stubEnv('DSH_FIXTURE_CAPTURE', capture)
    const runtime = new FixtureRuntime(venv)
    const provider = new DuckDuckGoSearchProvider(runtime, 5_000)
    await provider.search({ query: 'a' })
    await provider.search({ query: 'b', maxResults: 50 })
    const [first, second] = readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { numResults: number })
    expect(first?.numResults).toBe(10)
    expect(second?.numResults).toBe(20)
  })

  it('surfaces a domain error outcome as WEB_PROVIDER_ERROR', async () => {
    vi.stubEnv('DSH_FIXTURE_BEHAVIOR', 'domain-error')
    const provider = new DuckDuckGoSearchProvider(new FixtureRuntime(tmp()), 5_000)
    await expect(provider.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('ScraplingFetchProvider', () => {
  const fetchOptions = {
    mode: 'stealth' as const,
    solveCloudflare: true,
    networkIdle: false,
    maxBodyChars: 1234,
    timeoutMs: 5_000,
  }

  it('sends the configured mode and bounds, and maps the text outcome', async () => {
    const venv = tmp()
    const capture = join(venv, 'capture.log')
    vi.stubEnv('DSH_FIXTURE_CAPTURE', capture)
    const provider = new ScraplingFetchProvider(new FixtureRuntime(venv), fetchOptions)
    await expect(provider.fetch({ url: 'https://a.test/page' })).resolves.toEqual({
      url: 'https://a.test/page',
      statusCode: 200,
      body: { kind: 'text', content: 'extracted text' },
      truncated: false,
    })
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual({
      op: 'fetch',
      url: 'https://a.test/page',
      mode: 'stealth',
      maxChars: 1234,
      solveCloudflare: true,
      networkIdle: false,
    })
  })

  it('rejects a non-absolute or non-http(s) URL as WEB_INVALID_URL', async () => {
    const provider = new ScraplingFetchProvider(new FixtureRuntime(tmp()), fetchOptions)
    await expect(provider.fetch({ url: 'not a url' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
    await expect(provider.fetch({ url: 'ftp://a.test/x' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
  })
})

describe('ScraplingRuntime exchanges', () => {
  it('repairs the environment once when the outcome is environment-marked', async () => {
    const venv = tmp()
    vi.stubEnv('DSH_FIXTURE_BEHAVIOR', 'env-once')
    vi.stubEnv('DSH_FIXTURE_STATE', join(venv, 'state'))
    const runtime = new FixtureRuntime(venv)
    await expect(runtime.run({ op: 'search', query: 'q', numResults: 5 }, 5_000, 'SCRAPLING_SEARCH_TIMEOUT'))
      .resolves.toMatchObject({ count: 2 })
    expect(runtime.setups).toBe(2)
  })

  it('repairs the environment once when the tool exits with code 3', async () => {
    const venv = tmp()
    vi.stubEnv('DSH_FIXTURE_BEHAVIOR', 'exit3-once')
    vi.stubEnv('DSH_FIXTURE_STATE', join(venv, 'state'))
    const runtime = new FixtureRuntime(venv)
    await expect(runtime.run({ op: 'search', query: 'q', numResults: 5 }, 5_000, 'SCRAPLING_SEARCH_TIMEOUT'))
      .resolves.toMatchObject({ count: 2 })
    expect(runtime.setups).toBe(2)
  })

  it('fails loud when the environment stays broken after one repair', async () => {
    vi.stubEnv('DSH_FIXTURE_BEHAVIOR', 'env-flag')
    const runtime = new FixtureRuntime(tmp())
    await expect(runtime.run({ op: 'search', query: 'q', numResults: 5 }, 5_000, 'SCRAPLING_SEARCH_TIMEOUT'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a pre-aborted signal to WEB_ABORTED', async () => {
    const runtime = new FixtureRuntime(tmp())
    const controller = new AbortController()
    controller.abort()
    await expect(runtime.run({ op: 'search', query: 'q', numResults: 5 }, 5_000, 'SCRAPLING_SEARCH_TIMEOUT', controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('kills a running child on mid-flight abort', async () => {
    vi.stubEnv('DSH_FIXTURE_BEHAVIOR', 'sleep')
    const runtime = new FixtureRuntime(tmp())
    const controller = new AbortController()
    const pending = runtime.run({ op: 'search', query: 'q', numResults: 5 }, 60_000, 'SCRAPLING_SEARCH_TIMEOUT', controller.signal)
    setTimeout(() => { controller.abort() }, 100)
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  }, 10_000)

  it('times a stuck child out with the provider-owned code', async () => {
    vi.stubEnv('DSH_FIXTURE_BEHAVIOR', 'sleep')
    const runtime = new FixtureRuntime(tmp())
    await expect(runtime.run({ op: 'search', query: 'q', numResults: 5 }, 150, 'SCRAPLING_SEARCH_TIMEOUT'))
      .rejects.toThrow(expect.objectContaining({ code: 'SCRAPLING_SEARCH_TIMEOUT' }))
  }, 10_000)

  it('maps a non-zero exit without JSON to WEB_PROVIDER_ERROR', async () => {
    vi.stubEnv('DSH_FIXTURE_BEHAVIOR', 'exit1')
    const runtime = new FixtureRuntime(tmp())
    await expect(runtime.run({ op: 'search', query: 'q', numResults: 5 }, 5_000, 'SCRAPLING_SEARCH_TIMEOUT'))
      .rejects.toThrow(/catastrophic interpreter failure/)
  })

  it('maps unparseable stdout to WEB_PROVIDER_ERROR', async () => {
    vi.stubEnv('DSH_FIXTURE_BEHAVIOR', 'badjson')
    const runtime = new FixtureRuntime(tmp())
    await expect(runtime.run({ op: 'search', query: 'q', numResults: 5 }, 5_000, 'SCRAPLING_SEARCH_TIMEOUT'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('rejects output beyond the stdout bound', async () => {
    vi.stubEnv('DSH_FIXTURE_BEHAVIOR', 'huge')
    const runtime = new FixtureRuntime(tmp())
    await expect(runtime.run({ op: 'search', query: 'q', numResults: 5 }, 30_000, 'SCRAPLING_SEARCH_TIMEOUT'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  }, 30_000)

  it('maps a missing interpreter to WEB_PROVIDER_ERROR', async () => {
    const venv = tmp()
    class MissingCommandRuntime extends FixtureRuntime {
      protected override async setup(): Promise<InterpreterLauncher> {
        return { command: 'dsh-definitely-missing-command', argsPrefix: [] }
      }
    }
    await expect(new MissingCommandRuntime(venv).run({ op: 'search', query: 'q', numResults: 5 }, 5_000, 'SCRAPLING_SEARCH_TIMEOUT'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('shares one setup across concurrent first calls and resets it after failure', async () => {
    const venv = tmp()
    const runtime = new FixtureRuntime(venv)
    await Promise.all([
      runtime.run({ op: 'search', query: 'a', numResults: 5 }, 5_000, 'SCRAPLING_SEARCH_TIMEOUT'),
      runtime.run({ op: 'search', query: 'b', numResults: 5 }, 5_000, 'SCRAPLING_SEARCH_TIMEOUT'),
    ])
    expect(runtime.setups).toBe(1)

    class FailingRuntime extends ScraplingRuntime {
      setups = 0

      constructor() {
        super({ pythonCommand: undefined, venvRoot: venv, autoSetup: true, needsBrowsers: false, setupTimeoutMs: 60_000 })
      }

      protected override async setup(): Promise<InterpreterLauncher> {
        this.setups += 1
        throw new Error('pip exploded')
      }
    }
    const failing = new FailingRuntime()
    await expect(failing.run({ op: 'search', query: 'c', numResults: 5 }, 5_000, 'SCRAPLING_SEARCH_TIMEOUT')).rejects.toThrow(/pip exploded/)
    await expect(failing.run({ op: 'search', query: 'd', numResults: 5 }, 5_000, 'SCRAPLING_SEARCH_TIMEOUT')).rejects.toThrow(/pip exploded/)
    expect(failing.setups).toBe(2)
  })

  it('fails loud with setup instructions when autoSetup is false and the venv is absent', async () => {
    const runtime = new ScraplingRuntime({
      pythonCommand: undefined,
      venvRoot: join(tmp(), 'venv'),
      autoSetup: false,
      needsBrowsers: false,
      setupTimeoutMs: 60_000,
    })
    expect(runtime.available()).toBe(false)
    await expect(runtime.run({ op: 'search', query: 'q', numResults: 5 }, 5_000, 'SCRAPLING_SEARCH_TIMEOUT'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))
  })

  it('is available without autoSetup when the venv interpreter and stamp exist', () => {
    const venv = tmp()
    const options = { pythonCommand: undefined, venvRoot: venv, autoSetup: false, needsBrowsers: false, setupTimeoutMs: 60_000 }
    const runtime = new ScraplingRuntime(options)
    mkdirSync(dirname(runtime.venvPython()), { recursive: true })
    writeFileSync(runtime.venvPython(), '')
    writeFileSync(join(venv, 'dsh-setup-complete.json'), '{}')
    expect(runtime.available()).toBe(true)
  })
})

describe('simulated setup pipeline', () => {
  /** Runtime whose subprocess exchanges are simulated instead of spawned. */
  class SimulatedRuntime extends ScraplingRuntime {
    setups = 0
    /** Fail the exchange whose args contain this marker. */
    failMarker: string | undefined

    constructor(venvRoot: string, pythonCommand?: string) {
      super({ pythonCommand, venvRoot, autoSetup: true, needsBrowsers: false, setupTimeoutMs: 60_000 })
    }

    protected override async collect(_command: string, args: readonly string[]): Promise<FakeExchange> {
      const joined = args.join(' ')
      if (this.failMarker !== undefined && joined.includes(this.failMarker)) {
        return { code: 1, stdout: '', stderr: `simulated failure at ${this.failMarker}` }
      }
      if (joined.includes('--version')) return { code: 0, stdout: 'Python 3.13.1', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }

    protected override async setup(signal: AbortSignal | undefined): Promise<InterpreterLauncher> {
      this.setups += 1
      return await super.setup(signal)
    }
  }

  it('locates a base interpreter, installs, stamps, and reuses the stamp afterwards', async () => {
    const venv = tmp()
    const runtime = new SimulatedRuntime(venv)
    // The simulated tool exchange resolves to empty stdout, so the operation
    // itself fails; what matters is that setup completed and stamped.
    await expect(runtime.run({ op: 'search', query: 'q', numResults: 5 }, 5_000, 'SCRAPLING_SEARCH_TIMEOUT'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(runtime.setups).toBe(1)
    const stamp = JSON.parse(readFileSync(join(venv, 'dsh-setup-complete.json'), 'utf8')) as { tool: string; browsers: boolean }
    expect(stamp).toEqual({ tool: 'scrapling[fetchers]', browsers: false })
    // A second run skips setup: the stamp and interpreter marker are enough.
    mkdirSync(dirname(runtime.venvPython()), { recursive: true })
    writeFileSync(runtime.venvPython(), '')
    await expect(runtime.run({ op: 'search', query: 'q', numResults: 5 }, 5_000, 'SCRAPLING_SEARCH_TIMEOUT'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(runtime.setups).toBe(1)
  })

  it('installs the browser engine when the fetch mode needs one', async () => {
    const commands: string[] = []
    class StealthSimulated extends ScraplingRuntime {
      constructor() {
        super({ pythonCommand: undefined, venvRoot: tmp(), autoSetup: true, needsBrowsers: true, setupTimeoutMs: 60_000 })
      }

      protected override async collect(_command: string, args: readonly string[]): Promise<FakeExchange> {
        commands.push(args.join(' '))
        if (args.join(' ').includes('--version')) return { code: 0, stdout: 'Python 3.13.1', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      }
    }
    await new StealthSimulated().run({ op: 'search', query: 'q', numResults: 5 }, 5_000, 'SCRAPLING_SEARCH_TIMEOUT').catch(() => {})
    expect(commands.some(joined => joined.includes('playwright install chromium'))).toBe(true)
  })

  it('fails loud when no Python 3.10+ candidate runs', async () => {
    class NoPythonRuntime extends SimulatedRuntime {
      protected override async collect(): Promise<FakeExchange> {
        return { code: 1, stdout: '', stderr: 'not found' }
      }
    }
    await expect(new NoPythonRuntime(tmp()).run({ op: 'search', query: 'q', numResults: 5 }, 5_000, 'SCRAPLING_SEARCH_TIMEOUT'))
      .rejects.toThrow(/no Python 3\.10\+ interpreter/)
  })

  it('fails loud when a version prints without a Python signature', async () => {
    class NotPythonRuntime extends SimulatedRuntime {
      protected override async collect(command: string, args: readonly string[]): Promise<FakeExchange> {
        if (args.join(' ').includes('--version')) return { code: 0, stdout: 'v24.6.0', stderr: '' }
        return await super.collect(command, args)
      }
    }
    await expect(new NotPythonRuntime(tmp()).run({ op: 'search', query: 'q', numResults: 5 }, 5_000, 'SCRAPLING_SEARCH_TIMEOUT'))
      .rejects.toThrow(/no Python 3\.10\+ interpreter/)
  })

  it('surfaces a failed setup step as WEB_PROVIDER_UNAVAILABLE', async () => {
    const runtime = new SimulatedRuntime(tmp())
    runtime.failMarker = 'scrapling[fetchers]'
    await expect(runtime.run({ op: 'search', query: 'q', numResults: 5 }, 5_000, 'SCRAPLING_SEARCH_TIMEOUT'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))
  })

  it('honors an explicit pythonCommand candidate', async () => {
    const commands: string[] = []
    class ExplicitRuntime extends SimulatedRuntime {
      constructor() {
        super(tmp(), process.execPath)
      }

      protected override async collect(command: string, args: readonly string[]): Promise<FakeExchange> {
        commands.push(command)
        return await super.collect(command, args)
      }
    }
    await new ExplicitRuntime().run({ op: 'search', query: 'q', numResults: 5 }, 5_000, 'SCRAPLING_SEARCH_TIMEOUT').catch(() => {})
    expect(commands[0]).toBe(process.execPath)
  })
})

describe('web-scrapling plugin registration', () => {
  it('registers both providers into ctx.web (HMR-safe)', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DUCKDUCKGO_PROVIDER_ID, fetchProvider: SCRAPLING_PROVIDER_ID })
    const fiber = await ctx.plugin(scraplingPlugin, { venvRoot: join(tmp(), 'venv'), autoSetup: false })
    // Registered but unavailable: the empty venv is honest, and the seam
    // reports the configured id as unavailable rather than missing.
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
    await expect(ctx.web.fetch({ url: 'https://a.test' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
    await expect(ctx.web.fetch({ url: 'https://a.test' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('auto-selects as the only usable provider without an explicit id', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, {})
    const fiber = await ctx.plugin(scraplingPlugin, { venvRoot: join(tmp(), 'venv'), autoSetup: true })
    // A pre-aborted signal fails inside the resolved provider BEFORE any
    // setup side effect; reaching WEB_ABORTED (rather than a selection error)
    // proves auto-selection resolved this package's provider.
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.web.search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    await expect(ctx.web.fetch({ url: 'https://a.test' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in scraplingPlugin).toBe(false)
  })
})
