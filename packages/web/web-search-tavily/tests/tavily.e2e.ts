import { describe, expect, it } from 'vitest'
import { TavilySearchProvider } from '../src/provider.ts'

/**
 * Real-API smoke against the public Tavily endpoint. Opt-in per the with-key
 * e2e policy in docs/testing.md: self-skips without `$TAVILY_API_KEY`, and
 * spends one credit of the key's free quota per run.
 */
const apiKey = process.env.TAVILY_API_KEY
const enabled = apiKey !== undefined && apiKey.length > 0
const maybe = enabled ? describe : describe.skip

const provider = new TavilySearchProvider({
  apiKey: apiKey ?? '',
  baseURL: 'https://api.tavily.com',
  searchDepth: 'basic',
  includeAnswer: true,
})

maybe('web-search-tavily real API', () => {
  it('returns sources for a live query', { timeout: 60_000 }, async () => {
    const result = await provider.search({ query: 'DeepSeek Harness', maxResults: 5 })
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
  })

  it('rejects an invalid key with a provider error', { timeout: 60_000 }, async () => {
    if (process.env.TAVILY_E2E_INVALID_KEY !== '1') return
    const bad = new TavilySearchProvider({
      apiKey: 'tvly-invalid',
      baseURL: 'https://api.tavily.com',
      searchDepth: 'basic',
      includeAnswer: false,
    })
    await expect(bad.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })
})
