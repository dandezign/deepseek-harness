import { describe, expect, it } from 'vitest'
import { ObscuraFetchProvider } from '../src/provider.ts'
import { ObscuraRuntime } from '../src/runtime.ts'
import { DEFAULT_MAX_BODY_CHARS, DEFAULT_TIMEOUT_MS, defaultCommandPath } from '../src/index.ts'

/**
 * Real-environment smoke against the managed Obscura install. Opt-in per the
 * keyless-provider e2e policy in docs/testing.md: self-skips unless the
 * binary is installed at the managed location (or `$DSH_OBSCURA_COMMAND_PATH`
 * names it) and `$DSH_OBSCURA_E2E` is set, because the run reaches the public
 * network.
 */
const commandPath = process.env.DSH_OBSCURA_COMMAND_PATH ?? defaultCommandPath()
const enabled = process.env.DSH_OBSCURA_E2E !== undefined && process.env.DSH_OBSCURA_E2E !== '0'
const maybe = enabled ? describe : describe.skip

const provider = new ObscuraFetchProvider(
  new ObscuraRuntime({ commandPath }),
  { dumpFormat: 'markdown', statusProbe: true, maxBodyChars: DEFAULT_MAX_BODY_CHARS, timeoutMs: DEFAULT_TIMEOUT_MS },
)

maybe('web-fetch-obscura real environment', () => {
  it('fetches a stable public page with a truthful status', { timeout: 180_000 }, async () => {
    const result = await provider.fetch({ url: 'https://example.com/' })
    expect(result.statusCode).toBe(200)
    expect(result.body.kind).toBe('text')
    expect(result.body.content).toContain('Example Domain')
    expect(result.truncated).toBe(false)
  })

  it('reports the final URL after a redirect', { timeout: 180_000 }, async () => {
    const result = await provider.fetch({ url: 'http://github.com/' })
    expect(result.statusCode).toBe(200)
    expect(result.url).toBe('https://github.com/')
  })

  it('reports a real 404 through the status probe', { timeout: 180_000 }, async () => {
    const result = await provider.fetch({ url: 'https://example.com/dsh-e2e-this-page-does-not-exist' })
    expect(result.statusCode).toBe(404)
  })
})
