import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DuckDuckGoSearchProvider, ScraplingFetchProvider } from '../src/provider.ts'
import { ScraplingRuntime } from '../src/runtime.ts'

/**
 * Real-environment smoke for the managed Scrapling pipeline: creates a real
 * venv (pip install `scrapling[fetchers]`), runs a live DuckDuckGo search,
 * and fetches a stable public page. Opt-in per the with-key e2e policy in
 * docs/testing.md: self-skips without `$DSH_SCRAPLING_E2E`, because the first
 * run downloads packages and reaches the public network.
 */
const enabled = process.env.DSH_SCRAPLING_E2E !== undefined && process.env.DSH_SCRAPLING_E2E !== '0'
const maybe = enabled ? describe : describe.skip

const venvRoot = mkdtempSync(join(tmpdir(), 'dsh-scrapling-e2e-'))
const runtime = new ScraplingRuntime({
  pythonCommand: process.env.DSH_SCRAPLING_PYTHON,
  venvRoot,
  autoSetup: true,
  needsBrowsers: false,
  setupTimeoutMs: 600_000,
})

afterAll(() => {
  if (enabled) rmSync(venvRoot, { recursive: true, force: true })
})

maybe('web-scrapling real environment', () => {
  it('creates the managed venv on first use', () => {
    expect(runtime.available()).toBe(true)
  })

  it('returns DuckDuckGo sources for a live query', { timeout: 300_000 }, async () => {
    const provider = new DuckDuckGoSearchProvider(runtime, 120_000)
    const result = await provider.search({ query: 'DeepSeek Harness', maxResults: 5 })
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
  })

  it('fetches a public page as extracted text', { timeout: 300_000 }, async () => {
    const provider = new ScraplingFetchProvider(runtime, {
      mode: 'standard',
      solveCloudflare: false,
      networkIdle: false,
      maxBodyChars: 50_000,
      timeoutMs: 180_000,
    })
    const result = await provider.fetch({ url: 'https://example.com' })
    expect(result.statusCode).toBe(200)
    expect(result.body.kind).toBe('text')
    expect(result.body.kind === 'text' && result.body.content.length).toBeGreaterThan(0)
  })
})
