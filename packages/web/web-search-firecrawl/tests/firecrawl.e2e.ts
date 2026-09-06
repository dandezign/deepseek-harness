import { describe, expect, it } from 'vitest'
import { FirecrawlSearchProvider } from '../src/provider.ts'

/**
 * Real-API smoke against the public Firecrawl endpoint. Keyless by default per
 * the keyless-provider e2e policy (docs/testing.md): self-skips when the keyless
 * budget cannot be reached, and never requires a key. Set `$FIRECRAWL_E2E=0` to
 * disable explicitly; the run spends Firecrawl's free keyless quota.
 */
const apiKey = process.env.FIRECRAWL_API_KEY ?? ''
const enabled = process.env.FIRECRAWL_E2E !== '0'
const maybe = enabled ? describe : describe.skip

const provider = new FirecrawlSearchProvider({
  apiKey,
  baseURL: 'https://api.firecrawl.dev',
  apiVersion: 'v2',
})

maybe('web-search-firecrawl real API', () => {
  it('returns sources for a live query', { timeout: 60_000 }, async () => {
    const result = await provider.search({ query: 'DeepSeek Harness', maxResults: 5 })
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
  })
})
