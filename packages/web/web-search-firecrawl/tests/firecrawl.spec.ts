import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { FirecrawlSearchProvider, FIRECRAWL_PROVIDER_ID } from '@deepseek-ai/dsh-web-search-firecrawl'
import * as firecrawlPlugin from '@deepseek-ai/dsh-web-search-firecrawl'
import { mapFirecrawlItem, mapFirecrawlResponse } from '../src/provider.ts'

const options = { apiKey: 'fc-key', baseURL: 'https://api.firecrawl.test', apiVersion: 'v2' as const }

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Firecrawl item mapping', () => {
  it('maps a v2 envelope item with title and description', () => {
    expect(mapFirecrawlItem({
      url: 'https://a.test',
      title: 'A',
      description: 'about a',
    })).toEqual({ url: 'https://a.test', title: 'A', snippet: 'about a' })
  })

  it('falls back to snippet and metadata fields for snippet and URL', () => {
    expect(mapFirecrawlItem({
      metadata: { sourceURL: 'https://b.test', title: 'B', description: 'meta description' },
    })).toEqual({ url: 'https://b.test', title: 'B', snippet: 'meta description' })
    expect(mapFirecrawlItem({ metadata: { url: 'https://c.test' }, snippet: 'raw snippet' }))
      .toEqual({ url: 'https://c.test', snippet: 'raw snippet' })
  })

  it('prefers the top-level description over the metadata description', () => {
    expect(mapFirecrawlItem({
      url: 'https://a.test',
      description: 'top',
      metadata: { description: 'meta' },
    })).toEqual({ url: 'https://a.test', snippet: 'top' })
  })

  it('drops an item with no URL anywhere', () => {
    expect(mapFirecrawlItem({ title: 'orphan', description: 'no address' })).toBeUndefined()
  })

  it('omits blank optional fields rather than emitting them', () => {
    expect(mapFirecrawlItem({ url: 'https://a.test', title: '', description: '  ' }))
      .toEqual({ url: 'https://a.test' })
  })

  it('maps a v2 web envelope to a result with filtered entries and no content', () => {
    const result = mapFirecrawlResponse({
      success: true,
      data: {
        web: [
          { url: 'https://a.test', description: 'one' },
          { title: 'orphan' },
          { url: 'https://c.test', title: 'C' },
        ],
      },
    })
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', snippet: 'one' },
        { url: 'https://c.test', title: 'C' },
      ],
      truncated: false,
    })
    expect(result.content).toBeUndefined()
  })

  it('maps a v1 flat data array to a result', () => {
    expect(mapFirecrawlResponse({ data: [{ url: 'https://v1.test' }] }))
      .toEqual({ sources: [{ url: 'https://v1.test' }], truncated: false })
  })

  it('tolerates a missing data field', () => {
    expect(mapFirecrawlResponse({}).sources).toEqual([])
    expect(mapFirecrawlResponse({ data: {} }).sources).toEqual([])
  })
})

describe('FirecrawlSearchProvider availability', () => {
  it('is available keyless — an empty key is a supported mode', () => {
    expect(new FirecrawlSearchProvider({ ...options, apiKey: '' }).available()).toBe(true)
  })

  it('is available with a key', () => {
    expect(new FirecrawlSearchProvider(options).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(new FirecrawlSearchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when numResults is set but not a positive integer', () => {
    expect(new FirecrawlSearchProvider({ ...options, numResults: 0 }).available()).toBe(false)
    expect(new FirecrawlSearchProvider({ ...options, numResults: 1.5 }).available()).toBe(false)
  })
})

describe('FirecrawlSearchProvider request mapping', () => {
  it('sends query, limit, web source, and bearer auth to the versioned endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true, data: { web: [] } }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new FirecrawlSearchProvider({ ...options, apiVersion: 'v1', numResults: 4 })
    await provider.search({ query: 'hello', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.firecrawl.test/v1/search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer fc-key')
    expect(JSON.parse(init.body as string)).toEqual({ query: 'hello', limit: 5, sources: ['web'] })
  })

  it('omits the Authorization header entirely when keyless', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true, data: { web: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await new FirecrawlSearchProvider({ ...options, apiKey: '' }).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['authorization']).toBeUndefined()
  })

  it('falls back to the configured numResults when a request omits maxResults', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true, data: { web: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await new FirecrawlSearchProvider({ ...options, numResults: 7 }).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ limit: 7 })
  })

  it('defaults to ten results when neither the request nor config carries a bound', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true, data: { web: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await new FirecrawlSearchProvider(options).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ limit: 10 })
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true, data: { web: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await new FirecrawlSearchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('FirecrawlSearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'rate limit exceeded' }, { status: 429 })))
    await expect(new FirecrawlSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'rate limit exceeded' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(new FirecrawlSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Firecrawl API error (HTTP 502)' }))
  })

  it('maps a success:false envelope to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: false, error: 'scrape failed' }, { status: 200 })))
    await expect(new FirecrawlSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Firecrawl search was unsuccessful: scrape failed' }))
  })

  it('uses a generic reason for a success:false envelope without an error string', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: false }, { status: 200 })))
    await expect(new FirecrawlSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Firecrawl search was unsuccessful: unknown error' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(new FirecrawlSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new FirecrawlSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(new FirecrawlSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: { web: {} } }, { status: 200 })))
    await expect(new FirecrawlSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new FirecrawlSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-firecrawl plugin registration', () => {
  it('registers the keyless provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: true, data: { web: [] } })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: FIRECRAWL_PROVIDER_ID })
    const fiber = await ctx.plugin(firecrawlPlugin)
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in firecrawlPlugin).toBe(false)
  })

  it('threads baseURL and apiVersion config into the request URL', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true, data: { web: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: FIRECRAWL_PROVIDER_ID })
    const fiber = await ctx.plugin(firecrawlPlugin, { baseURL: 'https://fc.test', apiVersion: 'v1' })
    await ctx.web.search({ query: 'q' })
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe('https://fc.test/v1/search')
    await fiber.dispose()
  })
})
