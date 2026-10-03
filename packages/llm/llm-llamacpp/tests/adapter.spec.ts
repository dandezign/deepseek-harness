import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage, resolveRetryPolicy, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import * as LlamaCpp from '../src/index.ts'
import { LlamaCppAdapter, normalizeOrigin, resolveAdapterOptions, resolveRoutes } from '../src/index.ts'
import type { LlamaCppConnectionOptions } from '../src/index.ts'
import { closeMockRouters, mockRouter } from './mock-router.ts'

afterEach(async () => {
  await closeMockRouters()
})

function userMessage(text: string): GenerateOptions['messages'] {
  return [createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })]
}

/** Connection facts pointing at a mock router, with lifecycle knobs for tests. */
function connectionOf(origin: string, overrides: Partial<LlamaCppConnectionOptions> = {}): LlamaCppConnectionOptions {
  return {
    origin,
    apiKeyEnv: credentialRef('LLAMACPP_API_KEY'),
    displayName: 'llama.cpp',
    autoLoad: true,
    autoUnload: 'never',
    loadTimeoutMs: 2_000,
    pollIntervalMs: 10,
    watchEvents: true,
    maxTokens: 8_192,
    defaultContextWindow: 32_768,
    models: [],
    streamIdleTimeoutMs: 5_000,
    retryPolicy: resolveRetryPolicy(undefined, 'test'),
    ...overrides,
  }
}

function adapterOf(connection: LlamaCppConnectionOptions, apiKey?: string): LlamaCppAdapter {
  return new LlamaCppAdapter({
    options: () => connection,
    resolveApiKey: () => Promise.resolve(apiKey),
  })
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function assembled(chunks: StreamChunk[]): { text: string; finish: unknown } {
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return {
    text: assembler.message({ provider: 'llamacpp', model: 'm' }).content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join(''),
    finish: assembler.finish,
  }
}

describe('normalizeOrigin', () => {
  it('strips trailing slashes and a pasted /v1 prefix', () => {
    expect(normalizeOrigin('http://192.168.0.92:8080/v1')).toBe('http://192.168.0.92:8080')
    expect(normalizeOrigin('http://192.168.0.92:8080/v1/')).toBe('http://192.168.0.92:8080')
    expect(normalizeOrigin('http://host:8080//')).toBe('http://host:8080')
    expect(normalizeOrigin('https://gateway.example/v1')).toBe('https://gateway.example')
  })

  it('rejects non-http schemes', () => {
    expect(() => normalizeOrigin('ftp://host:8080')).toThrow(/http/)
  })
})

describe('LlamaCppAdapter against a mock router', () => {
  it('auto-loads the model before the chat request and streams the reply', async () => {
    const server = await mockRouter({ models: [{ id: 'tiny', argv: ['--ctx-size', '4096'] }], loadDelayMs: 15 })
    const chunks = await collect(adapterOf(connectionOf(server.url)).stream({
      provider: 'llamacpp',
      model: 'tiny',
      messages: userMessage('hi'),
    }))
    const { text, finish } = assembled(chunks)
    expect(text).toBe('hello')
    expect(finish).toEqual({ kind: 'stop' })
    // The load happened, and before the chat POST.
    expect(server.loadCount.get('tiny')).toBe(1)
    expect(server.chatRequests).toHaveLength(1)
    expect(server.chatRequests[0]).toMatchObject({ model: 'tiny', stream: true })
  })

  it('recovers once from the not-loaded race with a load-and-retry', async () => {
    const server = await mockRouter({
      models: [{ id: 'tiny' }],
      loadDelayMs: 10,
      failChatNotLoadedOnce: ['tiny'],
    })
    const chunks = await collect(adapterOf(connectionOf(server.url)).stream({
      provider: 'llamacpp',
      model: 'tiny',
      messages: userMessage('hi'),
    }))
    expect(assembled(chunks).text).toBe('hello')
    // First chat 400'd, the adapter re-ensured and retried: two chat POSTs, both failed-then-served.
    expect(server.chatRequests).toHaveLength(2)
  })

  it('surfaces a mid-stream error payload as the server\'s own message, not a framing error', async () => {
    const server = await mockRouter({
      models: [{ id: 'tiny' }],
      chatEvents: [
        '{"error":{"code":500,"message":"decode() failed: vk::Device::waitSemaphores: ErrorDeviceLost","type":"server_error"}}',
      ],
    })
    // The mock writes the events then ends the response without [DONE], matching
    // the live shape: the failure payload is the whole stream.
    await expect(collect(adapterOf(connectionOf(server.url)).stream({
      provider: 'llamacpp',
      model: 'tiny',
      messages: userMessage('hi'),
    }))).rejects.toThrow(expect.objectContaining({
      message: 'decode() failed: vk::Device::waitSemaphores: ErrorDeviceLost',
      code: 'SERVER',
    }))
  })

  it('surfaces the not-loaded 400 as MODEL_NOT_LOADED when autoLoad is off', async () => {
    const server = await mockRouter({ models: [{ id: 'tiny' }] })
    await expect(collect(adapterOf(connectionOf(server.url, { autoLoad: false })).stream({
      provider: 'llamacpp',
      model: 'tiny',
      messages: userMessage('hi'),
    }))).rejects.toMatchObject({ code: 'MODEL_NOT_LOADED' })
  })

  it('sends the bearer key on chat requests when one resolves', async () => {
    const server = await mockRouter({ models: [{ id: 'tiny' }], apiKey: 'secret' })
    const chunks = await collect(adapterOf(connectionOf(server.url), 'secret').stream({
      provider: 'llamacpp',
      model: 'tiny',
      messages: userMessage('hi'),
    }))
    expect(assembled(chunks).text).toBe('hello')
  })

  it('carries the thinking control onto the wire as chat_template_kwargs', async () => {
    const server = await mockRouter({ models: [{ id: 'tiny', start: 'loaded' }] })
    const chunks = await collect(adapterOf(connectionOf(server.url)).stream({
      provider: 'llamacpp',
      model: 'tiny',
      messages: userMessage('hi'),
      reasoningEffort: ReasoningEffortId('medium'),
    }))
    expect(assembled(chunks).text).toBe('hello')
    expect(server.chatRequests[0]).toMatchObject({ chat_template_kwargs: { reasoning_effort: 'medium' } })

    // Off rides the cross-family enable_thinking switch instead.
    server.chatRequests.length = 0
    const offChunks = await collect(adapterOf(connectionOf(server.url)).stream({
      provider: 'llamacpp',
      model: 'tiny',
      messages: userMessage('hi'),
      reasoningEffort: ReasoningEffortId('off'),
    }))
    expect(assembled(offChunks).text).toBe('hello')
    expect(server.chatRequests[0]).toMatchObject({ chat_template_kwargs: { enable_thinking: false } })
  })

  it('fails with AUTH when the router rejects the key', async () => {
    const server = await mockRouter({ models: [{ id: 'tiny' }], apiKey: 'secret' })
    await expect(collect(adapterOf(connectionOf(server.url), 'wrong').stream({
      provider: 'llamacpp',
      model: 'tiny',
      messages: userMessage('hi'),
    }))).rejects.toMatchObject({ code: 'AUTH' })
  })

  it('maps model metadata with catalog capacities winning over the route default', () => {
    const adapter = adapterOf(connectionOf('http://router.test', {
      models: [{ id: 'sized', contextWindow: 8192, maxTokens: 1024 }],
    }))
    return Promise.all([
      adapter.resolveModel('llamacpp', 'sized').then((info) => {
        expect(info.context?.contextWindow).toBe(8192)
        expect(info.defaultMaxTokens).toBe(1024)
        expect(info.inputModalities).toEqual(['text'])
        // The graded thinking vocabulary the effort-aware templates accept
        // (Qwen3.8: low/medium/xhigh, xhigh default) plus the cross-family
        // off switch; no adapter-configured default, so an unselected
        // session runs the template's own default.
        expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'xhigh', 'off'])
        expect(info.reasoning?.defaultEffort).toBeUndefined()
      }),
      adapter.resolveModel('llamacpp', 'unknown-id').then((info) => {
        expect(info.context?.contextWindow).toBe(32_768)
        expect(info.inputModalities).toEqual(['text'])
        expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'xhigh', 'off'])
      }),
    ])
  })

  it('names the duplicate settings entry when another adapter already owns the route', async () => {
    const server = await mockRouter({ models: [{ id: 'tiny' }] })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    // A squatter registers the route first, exactly as a hand-declared
    // llm-pi-ai provider of the same id does; the plugin's own registration
    // must fail naming the removal, not a bare runtime duplicate error.
    const squatter = adapterOf(connectionOf(server.url))
    const release = ctx.llm.registerAdapter(['llamacpp'], squatter)
    await expect(ctx.plugin(LlamaCpp, { baseURL: server.url }))
      .rejects.toThrow(/remove the duplicate "llamacpp" entry from the llm-pi-ai settings section/)
    release()
    squatter.dispose()
    await ctx.fiber.dispose()
  })
})

describe('llm-llamacpp plugin through the runtime', () => {
  it('mounts dormant without a baseURL and serves once settings-shaped config supplies one', async () => {
    // Dormant: the directory entry exists, but no adapter route registers —
    // the runtime's sanctioned error delivery is an error finish chunk.
    const dormant = new Context()
    await dormant.plugin(LlmRuntime)
    await dormant.plugin(LlamaCpp, {})
    expect(dormant.llm.listConfigurableProviders().some(entry => entry.provider === 'llamacpp')).toBe(true)
    let dormantFirst: StreamChunk | undefined
    for await (const chunk of dormant.llm.stream({ provider: 'llamacpp', model: 'tiny', messages: [] })) {
      dormantFirst = chunk
      break
    }
    expect(dormantFirst).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'NO_ADAPTER' } },
    })
    await dormant.fiber.dispose()

    // Live: the route registers and a request auto-loads and streams.
    const server = await mockRouter({ models: [{ id: 'tiny' }], loadDelayMs: 10 })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlamaCpp, { baseURL: server.url })
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({ provider: 'llamacpp', model: 'tiny', messages: userMessage('hi') })) {
      assembler.push(chunk)
    }
    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(server.loadCount.get('tiny')).toBe(1)
    await ctx.fiber.dispose()
  })

  it('resolves a /v1-suffixed baseURL to the server origin', () => {
    const resolved = resolveAdapterOptions({ baseURL: 'http://192.168.0.92:8080/v1/' })
    expect(resolved?.origin).toBe('http://192.168.0.92:8080')
    expect(resolveAdapterOptions({})).toBeUndefined()
  })

  it('offers only the thinking levels a model declares, and refuses the rest', async () => {
    // A Qwen3.6-era template ignores reasoning_effort and honors only
    // enable_thinking, so offering graded levels there would be a lie.
    const server = await mockRouter({ models: [{ id: 'qwen36' }], loadDelayMs: 5 })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlamaCpp, {
      baseURL: server.url,
      models: [{ id: 'qwen36', reasoningEfforts: ['off'] }],
    })

    const resolved = await ctx.llm.resolveModelInfo('llamacpp', 'qwen36')
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual(['off'])

    let refusal: StreamChunk | undefined
    for await (const chunk of ctx.llm.stream({
      provider: 'llamacpp',
      model: 'qwen36',
      messages: userMessage('hi'),
      reasoningEffort: ReasoningEffortId('xhigh'),
    })) {
      refusal = chunk
    }
    // The runtime gates the declared vocabulary before the adapter is even
    // called; the adapter keeps its own refusal for direct (non-service) use.
    expect(refusal).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } },
    })
    // Refused before the load: the model was never fetched for a bad level.
    expect(server.loadCount.get('qwen36')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('reads an undeclared list as unset, not as an empty declaration', async () => {
    // schemastery normalizes an absent array to [], so a model that names
    // neither list must still get the full vocabulary and the text modality —
    // reading [] literally would announce a model that accepts nothing.
    const server = await mockRouter({ models: [{ id: 'tiny' }] })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlamaCpp, { baseURL: server.url, models: [{ id: 'tiny' }] })
    const resolved = await ctx.llm.resolveModelInfo('llamacpp', 'tiny')
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'xhigh', 'off'])
    expect(resolved.inputModalities).toEqual(['text'])
    await ctx.fiber.dispose()
  })

  it('honours a declared vision modality through the settings section', async () => {
    const server = await mockRouter({ models: [{ id: 'seer' }] })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlamaCpp, {
      baseURL: server.url,
      models: [{ id: 'seer', inputModalities: ['text', 'image'] }],
    })
    const resolved = await ctx.llm.resolveModelInfo('llamacpp', 'seer')
    expect(resolved.inputModalities).toEqual(['text', 'image'])
    await ctx.fiber.dispose()
  })

  it('serves a second server as its own route with its own lifecycle', async () => {
    const first = await mockRouter({ models: [{ id: 'tiny' }], loadDelayMs: 10 })
    const second = await mockRouter({ models: [{ id: 'other' }], loadDelayMs: 10 })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlamaCpp, {
      baseURL: first.url,
      providers: { workstation: { baseURL: second.url, displayName: 'Workstation' } },
    })

    const directory = ctx.llm.listConfigurableProviders()
    expect(directory.find(entry => entry.provider === 'llamacpp')?.settingsPath).toEqual([])
    expect(directory.find(entry => entry.provider === 'workstation')).toMatchObject({
      displayName: 'Workstation',
      settingsPath: ['providers', 'workstation'],
      credentialOptional: true,
    })

    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({ provider: 'workstation', model: 'other', messages: userMessage('hi') })) {
      assembler.push(chunk)
    }
    expect(assembler.finish).toEqual({ kind: 'stop' })
    // Each route drove only its own server.
    expect(second.loadCount.get('other')).toBe(1)
    expect(first.loadCount.get('tiny')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('refuses an endpoint declared both at the top level and as providers.llamacpp', () => {
    expect(() => resolveRoutes({ baseURL: 'http://a.example:8080', providers: { llamacpp: { baseURL: 'http://b.example:8080' } } }))
      .toThrow(/declared twice/)
    // Either one alone is fine.
    expect([...resolveRoutes({ baseURL: 'http://a.example:8080' }).keys()]).toEqual(['llamacpp'])
    expect([...resolveRoutes({ providers: { llamacpp: { baseURL: 'http://b.example:8080' } } }).keys()]).toEqual(['llamacpp'])
  })

  it('leaves a named route without its own endpoint dormant', () => {
    // $LLAMACPP_BASE_URL names one server, so it must not fill in here.
    const environment = { get: (name: string) => name === 'LLAMACPP_BASE_URL' ? { value: 'http://env.example:8080' } : undefined }
    const resolved = resolveRoutes({ providers: { workstation: { displayName: 'Workstation' } } }, environment)
    expect(resolved.has('workstation')).toBe(false)
    // The default route still takes it.
    expect(resolveRoutes({}, environment).get('llamacpp')?.origin).toBe('http://env.example:8080')
  })
})
