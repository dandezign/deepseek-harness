import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

const servers: Server[] = []

/** Close every router opened since the last call; run from each spec's afterEach. */
export async function closeMockRouters(): Promise<void> {
  // Held-open SSE responses are closed first: `server.close` waits out live
  // connections, so a lingering stream would hang every spec's teardown.
  for (const release of openStreams.splice(0)) release()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
}

/** Teardown hooks that end each router's open event streams. */
const openStreams: (() => void)[] = []

/**
 * Reserve a port by binding it and letting go, so a spec can address an
 * origin BEFORE anything listens there and start the router on it later.
 * @returns a port number free at the moment it was released.
 */
export async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => { probe.listen(0, '127.0.0.1', resolve) })
  const address = probe.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const { port } = address
  await new Promise((resolve) => { probe.close(resolve) })
  return port
}

/** One configured mock model. */
interface MockModel {
  id: string
  /** Launch argv reported under `status.args` (a `--ctx-size` entry yields a context window). */
  argv?: string[]
  /** `architecture.input_modalities` (`["text","image"]` marks vision). */
  inputModalities?: string[]
  /** Initial live status (default `unloaded`). */
  start?: 'unloaded' | 'loaded'
}

export interface MockRouterOptions {
  models: MockModel[]
  /** Latency of each load transition (default 25ms). */
  loadDelayMs?: number
  /** `/props` role: `router` (default), `server` (lifecycle inapplicable), or `strata` (Strata server shape). */
  role?: 'router' | 'server' | 'strata'
  /** Concurrent resident models before eviction (default 1, llama.cpp's own default). */
  maxInstances?: number
  /** When set, chat requests must carry `authorization: Bearer <this>`. */
  apiKey?: string
  /** Chat SSE events per request; defaults to a minimal text generation. */
  chatEvents?: string[]
  /**
   * Model ids whose NEXT chat request answers the router's not-loaded 400
   * even though the status listing reports `loaded` — the eviction race the
   * adapter's load-and-retry exists for.
   */
  failChatNotLoadedOnce?: string[]
  /** Listen on this exact port instead of an arbitrary free one (see {@link freePort}). */
  port?: number
  /** `/models/sse` behaviour: `stream` (default) or `absent` (an older build 404s it). */
  sse?: 'stream' | 'absent'
  /** `meta.n_ctx` reported on each model's `loaded` event. */
  loadedContextWindow?: number
}

/** A live mock of a llama.cpp multi-model router. */
export interface MockRouter {
  url: string
  /** Parsed chat request bodies, in order. */
  chatRequests: Record<string, unknown>[]
  /** Load POSTs per model id. */
  loadCount: Map<string, number>
  /** Unload POSTs per model id. */
  unloadCount: Map<string, number>
  /**
   * Resolves once at least one load POST for `model` has been received and
   * counted; resolves immediately when one already has. The barrier that lets
   * a spec observe the count only after an in-flight dispatch has settled.
   */
  loadReceived(model: string): Promise<void>
  close(): Promise<void>
}

const DEFAULT_CHAT_EVENTS = [
  '{"choices":[{"delta":{"role":"assistant","content":null}}]}',
  '{"choices":[{"delta":{"content":"hello"}}]}',
  '{"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  '[DONE]',
]

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => { resolve(body) })
  })
}

/** Stateful llama.cpp router stand-in: props, status-bearing listing, load/unload, chat SSE. */
export async function mockRouter(options: MockRouterOptions): Promise<MockRouter> {
  const status = new Map<string, 'unloaded' | 'loading' | 'loaded'>(
    options.models.map(model => [model.id, model.start ?? 'unloaded']),
  )
  const loadCount = new Map<string, number>()
  const unloadCount = new Map<string, number>()
  /** Tests blocked until the next load receipt, notified with the model id. */
  const loadWaiters = new Set<(model: string) => void>()
  const chatRequests: Record<string, unknown>[] = []
  const loadTimers = new Set<NodeJS.Timeout>()
  const failOnce = new Set(options.failChatNotLoadedOnce ?? [])

  /** Open `/models/sse` responses, each fed every status change. */
  const listeners = new Set<ServerResponse>()

  const publish = (model: string, next: 'unloaded' | 'loading' | 'loaded'): void => {
    const info = next === 'loaded' && options.loadedContextWindow !== undefined
      ? { info: { id: model, meta: { n_ctx: options.loadedContextWindow } } }
      : {}
    const payload = JSON.stringify({ model, event: 'status_change', data: { status: next, ...info } })
    for (const listener of listeners) listener.write(`data: ${payload}\n\n`)
  }

  const setStatus = (model: string, next: 'unloaded' | 'loading' | 'loaded'): void => {
    status.set(model, next)
    publish(model, next)
  }

  const transition = (model: string, next: 'loaded'): void => {
    setStatus(model, 'loading')
    const timer = setTimeout(() => {
      loadTimers.delete(timer)
      if ((options.maxInstances ?? 1) === 1) {
        // The router's own eviction: loading B at max_instances 1 unloads A.
        for (const other of status.keys()) {
          if (other !== model && status.get(other) !== 'unloaded') setStatus(other, 'unloaded')
        }
      }
      setStatus(model, next)
    }, options.loadDelayMs ?? 25)
    loadTimers.add(timer)
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response)
  })

  const strata = options.role === 'strata'

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? '/'
    const authorized = options.apiKey === undefined || request.headers.authorization === `Bearer ${options.apiKey}`

    if (url === '/props' && request.method === 'GET') {
      // A server launched with --api-key guards every endpoint, the probe
      // included: an anonymous /props answers 401, not the role document.
      if (!authorized) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'invalid api key', type: 'invalid_request_error', code: 401 } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      if (strata) {
        const anyLoaded = [...status.values()].some(value => value === 'loaded')
        response.end(JSON.stringify({
          default_generation_settings: { n_ctx: options.loadedContextWindow ?? 32768, params: {} },
          total_slots: 1,
          model_alias: options.models[0]?.id ?? 'model',
          modalities: { vision: false },
          models_autoload: true,
          is_sleeping: !anyLoaded,
          build_info: 'Strata 0.1.33-test',
        }))
        return
      }
      const role = options.role ?? 'router'
      response.end(JSON.stringify(role === 'router'
        ? { role: 'router', models_autoload: false, max_instances: options.maxInstances ?? 1 }
        : { role: 'server', model_path: 'model.gguf' }))
      return
    }

    if (url === '/v1/models' && request.method === 'GET') {
      if (!authorized) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'invalid api key', type: 'invalid_request_error', code: 401 } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      if (strata) {
        // Strata lists the model only while it is resident: a non-resident
        // server answers an empty listing (its /props says is_sleeping).
        const anyLoaded = [...status.values()].some(value => value === 'loaded')
        response.end(JSON.stringify({
          object: 'list',
          data: anyLoaded
            ? options.models.map(model => ({
              id: model.id,
              object: 'model',
              status: { value: status.get(model.id) ?? 'unloaded' },
              meta: { n_ctx: options.loadedContextWindow ?? 32768 },
              architecture: { input_modalities: model.inputModalities ?? ['text'], output_modalities: ['text'] },
            }))
            : [],
        }))
        return
      }
      response.end(JSON.stringify({
        object: 'list',
        data: options.models.map(model => ({
          id: model.id,
          object: 'model',
          owned_by: 'llamacpp',
          status: { value: status.get(model.id) ?? 'unloaded', args: model.argv ?? [] },
          architecture: { input_modalities: model.inputModalities ?? ['text'], output_modalities: ['text'] },
        })),
      }))
      return
    }

    if (url === '/models/sse' && request.method === 'GET') {
      if (!authorized) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'invalid api key', type: 'invalid_request_error', code: 401 } }))
        return
      }
      if ((options.sse ?? 'stream') === 'absent' || strata) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'File Not Found', type: 'not_found_error', code: 404 } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      // The live router opens with each model's current status.
      for (const [model, value] of status) {
        response.write(`data: ${JSON.stringify({ model, event: 'model_status', data: { status: value } })}\n\n`)
      }
      listeners.add(response)
      request.on('close', () => { listeners.delete(response) })
      return
    }

    if (strata && (url === '/load' || url === '/unload') && request.method === 'POST') {
      if (!authorized) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'invalid api key', type: 'invalid_request_error', code: 401 } }))
        return
      }
      await readBody(request)
      if (url === '/load') {
        for (const model of options.models) {
          loadCount.set(model.id, (loadCount.get(model.id) ?? 0) + 1)
          for (const notify of [...loadWaiters]) notify(model.id)
          transition(model.id, 'loaded')
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"status":"loaded"}')
      } else {
        for (const model of options.models) {
          unloadCount.set(model.id, (unloadCount.get(model.id) ?? 0) + 1)
          setStatus(model.id, 'unloaded')
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"status":"unloaded"}')
      }
      return
    }

    if ((url === '/models/load' || url === '/models/unload') && request.method === 'POST') {
      if (!authorized) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'invalid api key', type: 'invalid_request_error', code: 401 } }))
        return
      }
      const body = JSON.parse(await readBody(request)) as { model?: string }
      const model = body.model ?? ''
      if (url === '/models/load') {
        loadCount.set(model, (loadCount.get(model) ?? 0) + 1)
        for (const notify of [...loadWaiters]) notify(model)
        if (status.get(model) !== 'loaded' && status.get(model) !== 'loading') transition(model, 'loaded')
      } else {
        unloadCount.set(model, (unloadCount.get(model) ?? 0) + 1)
        setStatus(model, 'unloaded')
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"success":true}')
      return
    }

    if (url === '/v1/chat/completions' && request.method === 'POST') {
      if (!authorized) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'invalid api key', type: 'invalid_request_error', code: 401 } }))
        return
      }
      const body = JSON.parse(await readBody(request)) as { model?: string }
      chatRequests.push(body)
      const model = body.model ?? ''
      const notLoaded = status.get(model) !== 'loaded' || failOnce.delete(model)
      if (notLoaded) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          error: { message: 'model is not loaded', type: 'invalid_request_error', code: 400 },
        }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const events = options.chatEvents ?? DEFAULT_CHAT_EVENTS
      let index = 0
      const write = (): void => {
        if (index >= events.length) {
          response.end()
          return
        }
        response.write(`data: ${events[index]}\n\n`)
        index += 1
        setTimeout(write, 2)
      }
      write()
      return
    }

    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'File Not Found', type: 'not_found_error', code: 404 } }))
  }

  await new Promise<void>((resolve) => { server.listen(options.port ?? 0, '127.0.0.1', resolve) })
  servers.push(server)
  openStreams.push(() => {
    for (const listener of listeners) listener.end()
    listeners.clear()
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    chatRequests,
    loadCount,
    unloadCount,
    loadReceived: (model: string) => {
      if ((loadCount.get(model) ?? 0) > 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        loadWaiters.add((received) => {
          if (received === model) resolve()
        })
      })
    },
    close: () => {
      for (const timer of loadTimers) clearTimeout(timer)
      // An open SSE response keeps the server from closing.
      for (const listener of listeners) listener.end()
      listeners.clear()
      loadWaiters.clear()
      return new Promise((resolve) => { server.close(() => { resolve() }) })
    },
  }
}
