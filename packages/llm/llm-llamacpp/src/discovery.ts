/**
 * Rich model discovery for a llama.cpp endpoint: the router's `/v1/models`
 * discloses far more than the OpenAI-compatible minimum — launch argv (from
 * which `--ctx-size` yields the configured context), architecture input
 * modalities (vision vs text-only), and live loaded/unloaded state — and this
 * reader surfaces all of it as `LlmDiscoveredModel` candidates plus
 * modality metadata the generic pi-ai reader leaves behind.
 *
 * @module dsh-llm-llamacpp/discovery
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import type { ModelEvent, ModelsReply, RouterModelEntry } from './types.ts'

/** Discovery output: candidates plus the extra facts llama.cpp discloses. */
export interface DiscoveredRouterModel extends LlmDiscoveredModel {
  /** Input modalities derived from `architecture.input_modalities`. */
  inputModalities: readonly ('text' | 'image')[]
  /** Live status when the endpoint reports one (`unloaded`/`loading`/`loaded`). */
  status?: string | undefined
}

/**
 * Parse `--ctx-size` out of a models-directory launch argv. The flag and its
 * value are separate argv entries; a missing value falls back to the default.
 * @param args - launch argv of one models-directory entry.
 * @returns the configured context window, or `undefined` when absent or unusable.
 */
export function contextWindowFromArgs(args: readonly unknown[]): number | undefined {
  if (!Array.isArray(args)) return undefined
  const index = args.indexOf('--ctx-size')
  if (index === -1 || index + 1 >= args.length) return undefined
  const value = Number(args[index + 1])
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Map `architecture.input_modalities` onto the harness modality vocabulary.
 * @param entry - one listing entry.
 * @returns the declared input modalities; unknown or absent blocks read text-only.
 */
export function modalitiesOf(entry: RouterModelEntry): readonly ('text' | 'image')[] {
  const raw = entry.architecture?.input_modalities
  if (!Array.isArray(raw)) return ['text']
  const modalities: ('text' | 'image')[] = []
  for (const name of raw) {
    if (name === 'text' && !modalities.includes('text')) modalities.push('text')
    if (name === 'image' && !modalities.includes('image')) modalities.push('image')
  }
  return modalities.length > 0 ? modalities : ['text']
}

/** Derive the context window claim: argv first (configured), info.meta second (authoritative once loaded). */
function contextWindowOf(entry: RouterModelEntry, meta?: { n_ctx?: unknown }): number | undefined {
  const args = entry.status?.args
  const fromArgs = Array.isArray(args) ? contextWindowFromArgs(args) : undefined
  if (fromArgs !== undefined) return fromArgs
  const nCtx = Number(meta?.n_ctx)
  return Number.isInteger(nCtx) && nCtx > 0 ? nCtx : undefined
}

/**
 * Parse a `/v1/models` reply into rich candidates. Entries without a usable
 * id are skipped rather than failing the listing; nothing here touches the
 * network, so callers (and tests) can feed captured replies directly.
 * @param reply - the parsed JSON listing body.
 * @returns the rich candidates in endpoint order.
 * @throws LlmError `MALFORMED_RESPONSE` when the listing carries no `data` array.
 */
export function parseModelsReply(reply: unknown): DiscoveredRouterModel[] {
  const parsed = reply as ModelsReply | null | undefined
  const data = parsed?.data
  if (!Array.isArray(data)) {
    throw new LlmError('llama.cpp model listing has no "data" array', 'MALFORMED_RESPONSE')
  }
  const models: DiscoveredRouterModel[] = []
  // The element type is a claim about the wire, not a guarantee: narrow each
  // row back from `unknown` so a non-object (a proxy's null padding) is
  // skipped like any other unusable entry instead of failing the listing.
  for (const row of data as unknown[]) {
    if (row === null || typeof row !== 'object') continue
    const entry = row as RouterModelEntry
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue
    const status = entry.status?.value
    const modalities = modalitiesOf(entry)
    const contextWindow = contextWindowOf(entry)
    models.push({
      id: entry.id,
      inputModalities: modalities,
      ...typeof status === 'string' ? { status } : {},
      ...contextWindow !== undefined ? { contextWindow } : {},
    })
  }
  return models
}

/**
 * Interrogate one endpoint for its model list. The URL is the server origin
 * (`/v1/models` is appended); a bearer key is sent when supplied, matching a
 * server launched with `--api-key`.
 * @param origin - server origin (scheme + host[:port]).
 * @param apiKey - bearer token, or `undefined` for an anonymous listing.
 * @param signal - caller cancellation; settles promptly after it aborts.
 * @returns the rich candidates in endpoint order.
 * @throws LlmError `TRANSPORT`/`AUTH`/`SERVER`/`MALFORMED_RESPONSE` naming the endpoint.
 */
export async function discoverRouterModels(
  origin: string,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<DiscoveredRouterModel[]> {
  let response: Response
  try {
    response = await fetch(`${origin}/v1/models`, {
      headers: apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
      ...signal === undefined ? {} : { signal },
    })
  } catch (error: unknown) {
    if (signal?.aborted) throw error
    throw new LlmError(`llama.cpp model discovery from ${origin} failed`, 'TRANSPORT', { cause: error })
  }
  if (!response.ok) {
    throw new LlmError(
      `llama.cpp model discovery from ${origin} failed (HTTP ${response.status})`,
      response.status === 401 || response.status === 403 ? 'AUTH' : 'SERVER',
      { status: response.status },
    )
  }
  try {
    return parseModelsReply(await response.json())
  } catch (error) {
    if (error instanceof LlmError) throw error
    throw new LlmError(`llama.cpp model discovery from ${origin} returned a non-JSON listing`, 'MALFORMED_RESPONSE', { cause: error })
  }
}

/**
 * Parse one `data:` payload of `GET /models/sse`. Exported for completeness
 * (and tests) even though the lifecycle currently polls: the loaded event's
 * `info.meta.n_ctx` is the authoritative context claim once a model runs.
 * @param payload - one SSE `data:` line's text.
 * @returns the model, status, and authoritative context when the payload carries them.
 */
export function parseModelEvent(payload: string): { model?: string; status?: string; nCtx?: number } | undefined {
  let event: ModelEvent
  try {
    event = JSON.parse(payload) as ModelEvent
  } catch {
    return undefined
  }
  const model = typeof event.model === 'string' ? event.model : undefined
  const status = typeof event.data?.status === 'string' ? event.data.status : undefined
  const nCtx = Number(event.data?.info?.meta?.n_ctx)
  return {
    ...model !== undefined ? { model } : {},
    ...status !== undefined ? { status } : {},
    ...Number.isInteger(nCtx) && nCtx > 0 ? { nCtx } : {},
  }
}
