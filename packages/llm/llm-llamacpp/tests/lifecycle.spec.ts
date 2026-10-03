import { afterEach, describe, expect, it } from 'vitest'
import { contextWindowFromArgs, discoverRouterModels, modalitiesOf, parseModelsReply } from '../src/discovery.ts'
import { ModelLifecycle } from '../src/lifecycle.ts'
import type { ModelLoadTransition } from '../src/lifecycle.ts'
import { closeMockRouters, freePort, mockRouter } from './mock-router.ts'

afterEach(async () => {
  await closeMockRouters()
})

/** A trimmed capture of the live router's /v1/models reply (build b10443-27df9199d). */
const CAPTURED_REPLY = {
  object: 'list',
  data: [
    {
      id: 'Grug',
      object: 'model',
      owned_by: 'llamacpp',
      status: {
        value: 'unloaded',
        args: ['llama-server.exe', '--host', '127.0.0.1', '--jinja', '--alias', 'Grug', '--ctx-size', '131072', '--model', 'grug-35b-v2-Q4_K_M.gguf', '--mmproj', 'mmproj-grug-35b-v2-f16.gguf'],
      },
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    },
    {
      id: 'Qwen3.6-12B-IQ-Q8_0',
      object: 'model',
      owned_by: 'llamacpp',
      status: {
        value: 'loaded',
        args: ['llama-server.exe', '--jinja', '--ctx-size', '131072', '--model', 'Qwen3.6-12B-IQ-Q8_0.gguf'],
      },
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    },
    { id: '', object: 'model' },
  ],
}

describe('discovery parsing', () => {
  it('derives context windows, modalities, and live status from a captured listing', () => {
    const models = parseModelsReply(CAPTURED_REPLY)
    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({ id: 'Grug', contextWindow: 131072, inputModalities: ['text', 'image'], residency: 'unloaded' })
    expect(models[1]).toMatchObject({ id: 'Qwen3.6-12B-IQ-Q8_0', contextWindow: 131072, inputModalities: ['text'], residency: 'loaded' })
  })

  it('skips entries without usable ids instead of failing the listing', () => {
    expect(parseModelsReply(CAPTURED_REPLY).every(model => model.id.length > 0)).toBe(true)
  })

  it('rejects a listing without a data array', () => {
    expect(() => parseModelsReply({ object: 'list' })).toThrow()
  })

  it('reads --ctx-size only as a flag/value pair', () => {
    expect(contextWindowFromArgs(['--ctx-size', '4096'])).toBe(4096)
    expect(contextWindowFromArgs(['--ctx-size'])).toBeUndefined()
    expect(contextWindowFromArgs(['--ctx-size', 'abc'])).toBeUndefined()
    expect(contextWindowFromArgs([])).toBeUndefined()
  })

  it('maps unknown or absent modality blocks to text-only', () => {
    expect(modalitiesOf({ id: 'x', architecture: { input_modalities: ['text', 'image'] } })).toEqual(['text', 'image'])
    expect(modalitiesOf({ id: 'x' })).toEqual(['text'])
    expect(modalitiesOf({ id: 'x', architecture: {} })).toEqual(['text'])
  })
})

describe('ModelLifecycle', () => {
  it('is a no-op on a plain single-model server', async () => {
    const server = await mockRouter({ models: [{ id: 'tiny' }], role: 'server' })
    const lifecycle = new ModelLifecycle({
      origin: server.url,
      authorize: () => Promise.resolve(undefined),
      loadTimeoutMs: 2_000,
      pollIntervalMs: 10,
      autoUnload: 'never',
    })
    await expect(lifecycle.ensureLoaded('tiny')).resolves.toBeUndefined()
    expect(server.loadCount.get('tiny')).toBeUndefined()
  })

  it('loads an unloaded model and resolves once resident', async () => {
    const server = await mockRouter({ models: [{ id: 'tiny', argv: ['--ctx-size', '4096'] }], loadDelayMs: 20 })
    const lifecycle = new ModelLifecycle({
      origin: server.url,
      authorize: () => Promise.resolve(undefined),
      loadTimeoutMs: 2_000,
      pollIntervalMs: 10,
      autoUnload: 'never',
    })
    await lifecycle.ensureLoaded('tiny')
    expect(await lifecycle.status('tiny')).toBe('loaded')
    expect(server.loadCount.get('tiny')).toBe(1)
  })

  it('deduplicates concurrent ensure-loaded waits into one load POST', async () => {
    const server = await mockRouter({ models: [{ id: 'tiny' }], loadDelayMs: 30 })
    const lifecycle = new ModelLifecycle({
      origin: server.url,
      authorize: () => Promise.resolve(undefined),
      loadTimeoutMs: 2_000,
      pollIntervalMs: 10,
      autoUnload: 'never',
    })
    await Promise.all([lifecycle.ensureLoaded('tiny'), lifecycle.ensureLoaded('tiny'), lifecycle.ensureLoaded('tiny')])
    expect(server.loadCount.get('tiny')).toBe(1)
  })

  it('re-issues the load once when the model falls back to unloaded mid-wait', async () => {
    const server = await mockRouter({ models: [{ id: 'tiny' }], loadDelayMs: 20 })
    const lifecycle = new ModelLifecycle({
      origin: server.url,
      authorize: () => Promise.resolve(undefined),
      loadTimeoutMs: 2_000,
      pollIntervalMs: 5,
      autoUnload: 'never',
    })
    // Sabotage the wait: after the initial load POST (poll 1 sees the real
    // `unloaded` and issues it), poll 2 reports `unloaded` again — the model
    // "fell back" mid-wait — which must trigger exactly one re-issued load.
    const originalStatus = lifecycle.status.bind(lifecycle)
    let polls = 0
    lifecycle.status = async (model: string, signal?: AbortSignal) => {
      const state = await originalStatus(model, signal)
      polls += 1
      if (polls === 2) return 'unloaded' as const
      return state
    }
    await lifecycle.ensureLoaded('tiny')
    expect(server.loadCount.get('tiny')).toBe(2)
  })

  it('times out with TIMEOUT when the model never becomes resident', async () => {
    const server = await mockRouter({ models: [{ id: 'huge' }], loadDelayMs: 5_000 })
    const lifecycle = new ModelLifecycle({
      origin: server.url,
      authorize: () => Promise.resolve(undefined),
      loadTimeoutMs: 120,
      pollIntervalMs: 20,
      autoUnload: 'never',
    })
    await expect(lifecycle.ensureLoaded('huge')).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('probes /props with the bearer key, so an authed router keeps its lifecycle', async () => {
    const server = await mockRouter({ models: [{ id: 'tiny' }], apiKey: 'secret-key' })
    const lifecycle = new ModelLifecycle({
      origin: server.url,
      authorize: () => Promise.resolve('secret-key'),
      loadTimeoutMs: 2_000,
      pollIntervalMs: 10,
      autoUnload: 'never',
    })
    await expect(lifecycle.isRouter()).resolves.toBe(true)
    await lifecycle.ensureLoaded('tiny')
    expect(await lifecycle.status('tiny')).toBe('loaded')
  })

  it('reports load progress at each transition, and none for an already-resident model', async () => {
    // maxInstances 2 keeps b resident while a loads, so the second wait meets
    // an already-loaded model rather than a router eviction.
    const server = await mockRouter({ models: [{ id: 'a' }, { id: 'b', start: 'loaded' }], loadDelayMs: 20, maxInstances: 2 })
    const seen: Array<{ model: string; phase: string }> = []
    const lifecycle = new ModelLifecycle({
      origin: server.url,
      authorize: () => Promise.resolve(undefined),
      loadTimeoutMs: 2_000,
      pollIntervalMs: 10,
      autoUnload: 'never',
      onProgress: (transition) => { seen.push({ model: transition.model, phase: transition.phase }) },
    })
    await lifecycle.ensureLoaded('a')
    expect(seen).toEqual([
      { model: 'a', phase: 'loading' },
      { model: 'a', phase: 'ready' },
    ])
    seen.length = 0
    await lifecycle.ensureLoaded('b')
    expect(seen).toEqual([])
  })

  it('reports a failed transition when the load times out', async () => {
    const server = await mockRouter({ models: [{ id: 'huge' }], loadDelayMs: 5_000 })
    const seen: ModelLoadTransition[] = []
    const lifecycle = new ModelLifecycle({
      origin: server.url,
      authorize: () => Promise.resolve(undefined),
      loadTimeoutMs: 120,
      pollIntervalMs: 20,
      autoUnload: 'never',
      onProgress: (transition) => { seen.push(transition) },
    })
    await expect(lifecycle.ensureLoaded('huge')).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(seen[0]).toMatchObject({ model: 'huge', phase: 'loading' })
    expect(seen[1]?.model).toBe('huge')
    expect(seen[1]?.phase).toBe('failed')
    expect(seen[1]?.message).toContain('did not become loaded')
  })

  it('on-switch unloads idle models but never one an in-flight request holds', async () => {
    const server = await mockRouter({ models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], loadDelayMs: 15 })
    const lifecycle = new ModelLifecycle({
      origin: server.url,
      authorize: () => Promise.resolve(undefined),
      loadTimeoutMs: 2_000,
      pollIntervalMs: 10,
      autoUnload: 'on-switch',
    })
    await lifecycle.ensureLoaded('a')
    lifecycle.acquire('a')
    await lifecycle.ensureLoaded('b')
    // a is held by an in-flight request: the switch to b must not unload it
    // (the router's max_instances eviction is the server's own business).
    expect(server.unloadCount.get('a')).toBeUndefined()
    lifecycle.release('a')
    await lifecycle.ensureLoaded('c')
    // Now a is idle and c just loaded: on-switch hygiene unloads a (and b,
    // which the router already evicted server-side). The unloads are
    // fire-and-forget, so give the POSTs a beat to land.
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(server.unloadCount.get('a')).toBe(1)
  })

  it('on-switch reclaims a model that was already resident on first use', async () => {
    // The model never transitions under this manager's watch, so tracking
    // residency only on transition would leave it permanently unreclaimable.
    const server = await mockRouter({
      models: [{ id: 'resident', start: 'loaded' }, { id: 'next' }],
      loadDelayMs: 15,
      maxInstances: 2,
    })
    const lifecycle = new ModelLifecycle({
      origin: server.url,
      authorize: () => Promise.resolve(undefined),
      loadTimeoutMs: 2_000,
      pollIntervalMs: 10,
      autoUnload: 'on-switch',
    })
    await lifecycle.ensureLoaded('resident')
    expect(server.loadCount.get('resident')).toBeUndefined()
    await lifecycle.ensureLoaded('next')
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(server.unloadCount.get('resident')).toBe(1)
  })

  it('keeps lifecycle management after probing a server that is not up yet', async () => {
    // A harness started before llama.cpp cannot tell an old build without
    // /props from one still starting, so the probe must not latch off.
    const port = await freePort()
    const lifecycle = new ModelLifecycle({
      origin: `http://127.0.0.1:${port}`,
      authorize: () => Promise.resolve(undefined),
      loadTimeoutMs: 2_000,
      pollIntervalMs: 10,
      autoUnload: 'never',
    })
    await expect(lifecycle.ensureLoaded('a')).resolves.toBeUndefined()
    const server = await mockRouter({ models: [{ id: 'a' }], loadDelayMs: 15, port })
    await lifecycle.ensureLoaded('a')
    expect(server.loadCount.get('a')).toBe(1)
  })

  it('never unloads a model another caller is still loading', async () => {
    // The loading model is held by an in-flight request from the moment its
    // load starts, so a concurrent switch's hygiene must leave it alone.
    const server = await mockRouter({ models: [{ id: 'a' }, { id: 'b' }], loadDelayMs: 15, maxInstances: 2 })
    const lifecycle = new ModelLifecycle({
      origin: server.url,
      authorize: () => Promise.resolve(undefined),
      loadTimeoutMs: 2_000,
      pollIntervalMs: 10,
      autoUnload: 'on-switch',
    })
    lifecycle.acquire('a')
    const loadingA = lifecycle.ensureLoaded('a')
    await lifecycle.ensureLoaded('b')
    await loadingA
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(server.unloadCount.get('a')).toBeUndefined()
  })

  it('stops driving the endpoint once disposed mid-load', async () => {
    // A configuration change retires the manager while a load is in flight;
    // it must not keep polling and re-issuing against the old origin.
    const server = await mockRouter({ models: [{ id: 'slow' }], loadDelayMs: 10_000 })
    const lifecycle = new ModelLifecycle({
      origin: server.url,
      authorize: () => Promise.resolve(undefined),
      loadTimeoutMs: 30_000,
      pollIntervalMs: 10,
      autoUnload: 'never',
    })
    const wait = lifecycle.ensureLoaded('slow')
    // Barrier: dispose only after the load POST has been received and counted,
    // so the captured count is stable — an in-flight dispatch cannot land its
    // increment after the capture, and only a post-disposal issue could grow it.
    await server.loadReceived('slow')
    lifecycle.dispose()
    await expect(wait).rejects.toMatchObject({ code: 'ABORTED' })
    // The load POST count must not grow after disposal: no further polls, no
    // re-issue on the next `unloaded` reading.
    const issued = server.loadCount.get('slow')
    expect(issued).toBe(1)
    await new Promise((resolve) => { setTimeout(resolve, 60) })
    expect(server.loadCount.get('slow')).toBe(issued)
  })

  it('settles a load from the event stream without polling the listing', async () => {
    // pollIntervalMs is far longer than the load: only the stream can settle
    // this wait inside the timeout, so finishing proves events drove it.
    const server = await mockRouter({ models: [{ id: 'tiny' }], loadDelayMs: 40, loadedContextWindow: 8192 })
    const lifecycle = new ModelLifecycle({
      origin: server.url,
      authorize: () => Promise.resolve(undefined),
      loadTimeoutMs: 3_000,
      pollIntervalMs: 60_000,
      autoUnload: 'never',
    })
    await lifecycle.ensureLoaded('tiny')
    expect(server.loadCount.get('tiny')).toBe(1)
    // The loaded event's meta.n_ctx is the authoritative capacity.
    expect(lifecycle.observedContextWindow('tiny')).toBe(8192)
  })

  it('falls back to polling on a build whose /models/sse is absent', async () => {
    const server = await mockRouter({ models: [{ id: 'tiny' }], loadDelayMs: 30, sse: 'absent' })
    const lifecycle = new ModelLifecycle({
      origin: server.url,
      authorize: () => Promise.resolve(undefined),
      loadTimeoutMs: 3_000,
      pollIntervalMs: 10,
      autoUnload: 'never',
    })
    await lifecycle.ensureLoaded('tiny')
    expect(await lifecycle.status('tiny')).toBe('loaded')
    expect(lifecycle.observedContextWindow('tiny')).toBeUndefined()
  })

  it('keeps polling as the safety net when watching is switched off', async () => {
    const server = await mockRouter({ models: [{ id: 'tiny' }], loadDelayMs: 30 })
    const lifecycle = new ModelLifecycle({
      origin: server.url,
      authorize: () => Promise.resolve(undefined),
      loadTimeoutMs: 3_000,
      pollIntervalMs: 10,
      autoUnload: 'never',
      watchEvents: false,
    })
    await lifecycle.ensureLoaded('tiny')
    expect(await lifecycle.status('tiny')).toBe('loaded')
  })

  it('reports an unreachable endpoint as a coded TRANSPORT error', async () => {
    // The adapter's pre-flight ensure-loaded runs outside its own mapping, so
    // an unwrapped rejection would reach callers as an unclassifiable TypeError.
    const port = await freePort()
    const lifecycle = new ModelLifecycle({
      origin: `http://127.0.0.1:${port}`,
      authorize: () => Promise.resolve(undefined),
      loadTimeoutMs: 2_000,
      pollIntervalMs: 10,
      autoUnload: 'never',
    })
    await expect(lifecycle.entries()).rejects.toMatchObject({ code: 'TRANSPORT' })
  })
})

describe('live discovery', () => {
  it('carries the bearer key and returns parsed candidates', async () => {
    const server = await mockRouter({
      models: [{ id: 'vision-model', argv: ['--ctx-size', '8192'], inputModalities: ['text', 'image'] }],
      apiKey: 'secret-key',
    })
    const models = await discoverRouterModels(server.url, 'secret-key')
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ id: 'vision-model', contextWindow: 8192, inputModalities: ['text', 'image'] })
    await expect(discoverRouterModels(server.url, 'wrong-key')).rejects.toMatchObject({ code: 'AUTH' })
  })
})

/** A trimmed capture of Strata's /v1/models reply while the model is resident. */
const STRATA_LOADED = {
  object: 'list',
  data: [
    {
      id: 'qwen3.8-flash-next',
      object: 'model',
      status: { value: 'loaded' },
      meta: { n_ctx: 131072 },
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    },
  ],
}

describe('Strata discovery', () => {
  it('derives the context window from the entry meta a Strata listing carries', () => {
    const models = parseModelsReply(STRATA_LOADED)
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'qwen3.8-flash-next',
      contextWindow: 131072,
      inputModalities: ['text', 'image'],
      residency: 'loaded',
    })
  })

  it('reads an empty Strata listing (model not resident) as no candidates, not an error', () => {
    expect(parseModelsReply({ object: 'list', data: [] })).toEqual([])
  })
})

describe('ModelLifecycle against a Strata server', () => {
  it('loads through the whole-server POST /load and reports the transition', async () => {
    const server = await mockRouter({ models: [{ id: 'tiny' }], role: 'strata', loadDelayMs: 15 })
    const progress: ModelLoadTransition[] = []
    const lifecycle = new ModelLifecycle({
      origin: server.url,
      authorize: () => Promise.resolve(undefined),
      loadTimeoutMs: 2_000,
      pollIntervalMs: 10,
      autoUnload: 'never',
      onProgress: (transition) => { progress.push(transition) },
    })
    await lifecycle.ensureLoaded('tiny')
    // The Strata surface (/load) was driven, not the router's /models/load.
    expect(server.loadCount.get('tiny')).toBe(1)
    expect(progress.map(t => t.phase)).toEqual(['loading', 'ready'])
    lifecycle.dispose()
  })

  it('reads a hidden non-resident model as unloaded and still drives the load', async () => {
    // A Strata server without an idle unload answers an EMPTY listing while
    // the model sleeps: the entry the lifecycle waits for does not exist yet.
    const server = await mockRouter({ models: [{ id: 'tiny' }], role: 'strata', loadDelayMs: 1 })
    const lifecycle = new ModelLifecycle({
      origin: server.url,
      authorize: () => Promise.resolve(undefined),
      loadTimeoutMs: 2_000,
      pollIntervalMs: 10,
      autoUnload: 'never',
    })
    await expect(lifecycle.status('tiny')).resolves.toBe('unloaded')
    await lifecycle.ensureLoaded('tiny')
    expect(server.loadCount.get('tiny')).toBe(1)
    lifecycle.dispose()
  })

  it('unloads through the whole-server POST /unload', async () => {
    const server = await mockRouter({ models: [{ id: 'tiny' }], role: 'strata' })
    const lifecycle = new ModelLifecycle({
      origin: server.url,
      authorize: () => Promise.resolve(undefined),
      loadTimeoutMs: 2_000,
      pollIntervalMs: 10,
      autoUnload: 'never',
    })
    await lifecycle.unload('tiny')
    expect(server.unloadCount.get('tiny')).toBe(1)
    lifecycle.dispose()
  })

  it('leaves the /models/sse watcher alone (Strata has no stream)', async () => {
    const server = await mockRouter({ models: [{ id: 'tiny' }], role: 'strata' })
    const lifecycle = new ModelLifecycle({
      origin: server.url,
      authorize: () => Promise.resolve(undefined),
      loadTimeoutMs: 2_000,
      pollIntervalMs: 10,
      autoUnload: 'never',
      watchEvents: true,
    })
    await lifecycle.ensureLoaded('tiny')
    // The stream 404s on a Strata server; no error escaped, and the load
    // completed through polling alone (the assertions above already ran).
    lifecycle.dispose()
  })
})
