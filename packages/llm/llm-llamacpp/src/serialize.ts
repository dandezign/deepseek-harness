/**
 * Serialize harness requests into llama.cpp chat completions. Text-only
 * message serialization (tool-call/tool-result mapping) is the shared
 * chat-completions wire owned by `dsh-llm-deepseek`; this module adds the
 * llama.cpp request envelope — the same fields minus the DeepSeek-specific
 * thinking controls, plus the template-kwargs thinking controls llama.cpp
 * accepts beside them — and the multimodal user content a server started with
 * `--mmproj` accepts.
 *
 * Images take the OpenAI-compatible `content` parts shape (`image_url` with a
 * `data:` URL), which is what llama.cpp's own multimodal support reads. A
 * request only reaches that path when the resolved model declared the `image`
 * modality, so a text-only model still refuses images before they are attached.
 *
 * @module dsh-llm-llamacpp/serialize
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { serializeMessages } from '@deepseek-ai/dsh-llm-deepseek/wire'
import type { WireMessage, WireRequest, WireTool } from '@deepseek-ai/dsh-llm-deepseek/wire'

/** One OpenAI-compatible multimodal content part. */
export type WireContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/**
 * A wire message: either exactly what the shared text wire produces (whose
 * assistant content is deliberately nullable), or a user message carrying
 * multimodal parts. A union rather than a widened `content` so the shared
 * shapes keep their own rules.
 */
export type MultimodalWireMessage = WireMessage | { role: 'user'; content: WireContentPart[] }

/** One template-kwargs thinking control, exactly as the chat template reads it. */
export type ThinkingKwargs =
  | { enable_thinking: false }
  | { reasoning_effort: 'low' | 'medium' | 'xhigh' }

/** The llama.cpp envelope: the shared chat-completions wire plus template kwargs. */
export type LlamaCppWireRequest = Omit<WireRequest, 'messages'> & {
  messages: MultimodalWireMessage[]
  /**
   * Variables passed into the chat template render. Templates that read
   * neither variable ignore them (verified against build `b10443-27df9199d`:
   * Qwen3.8-27B maps `reasoning_effort` low/medium/xhigh and rejects every
   * other value with a server error, defaulting to xhigh; Qwen3.6 and
   * Qwen2.5 templates ignore `reasoning_effort` and honor only
   * `enable_thinking`).
   */
  chat_template_kwargs?: ThinkingKwargs
}

/**
 * Map the harness reasoning effort onto the template kwargs. The vocabulary is
 * what effort-aware chat templates accept — the Qwen3.8 family's graded
 * `reasoning_effort` (low / medium / xhigh) plus the cross-family
 * `enable_thinking` switch for off; `off` on an effort-only template still
 * disables thinking because both templates read `enable_thinking`. Anything
 * else is a caller the loop already refused; sending it would make the
 * template raise a server error, so it fails loud here instead.
 * @param effort - the effort the request carries.
 * @returns the chat-template kwargs for that effort.
 * @throws LlmError `INVALID_REQUEST` naming the unsupported effort.
 */
export function thinkingKwargs(effort: NonNullable<GenerateOptions['reasoningEffort']>): ThinkingKwargs {
  if (effort === 'off') return { enable_thinking: false }
  if (effort === 'low') return { reasoning_effort: 'low' }
  if (effort === 'medium') return { reasoning_effort: 'medium' }
  if (effort === 'xhigh') return { reasoning_effort: 'xhigh' }
  throw new LlmError(`llama.cpp does not support reasoning effort "${effort}"`, 'INVALID_REQUEST')
}

/** Read one image block into a `data:` URL the multimodal wire accepts. */
async function imagePart(
  block: Extract<ContentBlock, { type: 'image' }>,
  attachments: AttachmentStore,
): Promise<WireContentPart> {
  const stored = await attachments.readImage(block.attachment)
  const base64 = Buffer.from(stored.data).toString('base64')
  return { type: 'image_url', image_url: { url: `data:${stored.ref.mediaType};base64,${base64}` } }
}

/**
 * Serialize the content of one image-bearing user message into wire parts.
 * Text keeps its position relative to the images around it, which is what
 * lets a caption before or after a picture read the way it was written.
 */
async function multimodalContent(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore,
): Promise<WireContentPart[]> {
  const parts: WireContentPart[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image') {
      parts.push(await imagePart(block, attachments))
      continue
    }
  }
  return parts
}

/**
 * Serialize the conversation, expanding image-bearing user messages into
 * multimodal parts and leaving every other message to the shared text wire.
 * @param messages - the harness conversation, in order.
 * @param attachments - store the image bytes are read through.
 * @returns the wire messages, order preserved.
 */
export async function serializeMultimodalMessages(
  messages: readonly RequestMessage[],
  attachments: AttachmentStore,
): Promise<MultimodalWireMessage[]> {
  const wire: MultimodalWireMessage[] = []
  for (const message of messages) {
    // Only a user message carrying an image needs the parts shape; anything
    // else is exactly what the shared serializer already produces, so the two
    // wires cannot drift for the messages they both describe.
    if (message.role !== 'user' || !contentHasImage(message.content)) {
      wire.push(...serializeMessages([message]))
      continue
    }
    const parts = await multimodalContent(message.content, attachments)
    wire.push({ role: 'user', content: parts })
  }
  return wire
}

/**
 * Build the wire request. Always streaming with usage reporting; optional
 * fields are omitted rather than sent as null. An absent `reasoningEffort`
 * sends no template kwargs, so the chat template's own default governs
 * (xhigh on the Qwen3.8 family, plain thinking on Qwen3.6-era templates).
 *
 * `attachments` is required only to serialize images: without it, image
 * content falls to the shared text wire's `UNSUPPORTED_CONTENT` refusal
 * rather than being silently flattened away.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param attachments - store for reading image bytes, when the request carries any.
 * @returns the chat-completions request body.
 */
export async function serializeRequest(
  options: GenerateOptions,
  attachments?: AttachmentStore,
): Promise<LlamaCppWireRequest> {
  const messages: MultimodalWireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...attachments === undefined
    ? serializeMessages(options.messages)
    : await serializeMultimodalMessages(options.messages, attachments))

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))

  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
    ...options.reasoningEffort === undefined
      ? {}
      : { chat_template_kwargs: thinkingKwargs(options.reasoningEffort) },
  }
}
