import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

const servers: Server[] = []

/** Close every router opened since the last call; run from each spec's afterEach. */
export async function closeMockRouters(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
}

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
export interface MockModel {
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
  /** `/props` role: `router` (default) or `server` (lifecycle inapplicable). */
  role?: 'router' | 'server'
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
  const chatRequests: Record<string, unknown>[] = []
  const loadTimers = new Set<NodeJS.Timeout>()
  const failOnce = new Set(options.failChatNotLoadedOnce ?? [])

  const transition = (model: string, next: 'loaded'): void => {
    status.set(model, 'loading')
    const timer = setTimeout(() => {
      loadTimers.delete(timer)
      if ((options.maxInstances ?? 1) === 1) {
        // The router's own eviction: loading B at max_instances 1 unloads A.
        for (const other of status.keys()) {
          if (other !== model && status.get(other) !== 'unloaded') status.set(other, 'unloaded')
        }
      }
      status.set(model, next)
    }, options.loadDelayMs ?? 25)
    loadTimers.add(timer)
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response)
  })

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
      const role = options.role ?? 'router'
      response.writeHead(200, { 'content-type': 'application/json' })
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
        if (status.get(model) !== 'loaded' && status.get(model) !== 'loading') transition(model, 'loaded')
      } else {
        unloadCount.set(model, (unloadCount.get(model) ?? 0) + 1)
        status.set(model, 'unloaded')
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
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    chatRequests,
    loadCount,
    unloadCount,
    close: () => {
      for (const timer of loadTimers) clearTimeout(timer)
      return new Promise((resolve) => { server.close(() => { resolve() }) })
    },
  }
}
