/**
 * Serialize harness requests into llama.cpp chat completions. Message
 * serialization (text/tool-call/tool-result mapping, image rejection) is the
 * shared chat-completions wire owned by `dsh-llm-deepseek`; this module adds
 * only the llama.cpp request envelope — the same fields minus the
 * DeepSeek-specific thinking controls, plus the template-kwargs thinking
 * controls llama.cpp accepts beside them.
 *
 * @module dsh-llm-llamacpp/serialize
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { serializeMessages } from '@deepseek-ai/dsh-llm-deepseek/src/serialize.ts'
import type { WireMessage, WireRequest, WireTool } from '@deepseek-ai/dsh-llm-deepseek/src/types.ts'

/** One template-kwargs thinking control, exactly as the chat template reads it. */
export type ThinkingKwargs =
  | { enable_thinking: false }
  | { reasoning_effort: 'low' | 'medium' | 'xhigh' }

/** The llama.cpp envelope: the shared chat-completions wire plus template kwargs. */
export type LlamaCppWireRequest = WireRequest & {
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

/**
 * Build the wire request. Always streaming with usage reporting; optional
 * fields are omitted rather than sent as null. An absent `reasoningEffort`
 * sends no template kwargs, so the chat template's own default governs
 * (xhigh on the Qwen3.8 family, plain thinking on Qwen3.6-era templates).
 * @param options - the harness request (model, history, system, tools, sampling).
 * @returns the chat-completions request body.
 */
export function serializeRequest(options: GenerateOptions): LlamaCppWireRequest {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages))

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
