/**
 * Serialize harness messages into the shared chat-completions wire: the
 * text-only shape sibling adapters (llama.cpp and other OpenAI-compatible
 * servers) start from. Image-capable adapters wrap this module and supply
 * their own multimodal user parts; here image content is refused loudly
 * rather than flattened away.
 *
 * @module
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { WireMessage } from './types.ts'

function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The shared chat-completions wire does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message: Extract<RequestMessage, { role: 'assistant' }>): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    // Text-less turns send "" — NEVER null. Pure tool-call turns: the
    // official samples replay message.content verbatim (which is "") and
    // some gateways reject null outright. Reasoning-ONLY turns: the live
    // API rejects null-content/no-tool_calls assistant messages with a 400,
    // and since the message sits durably in the session log, a null here
    // bricks every later turn of that session.
    content: text,
    // CoT passback on every reasoning-carrying turn, so a gateway
    // re-encoding the conversation for another vendor can recover that
    // turn's upstream thinking signature.
    ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize the conversation. Tool results are their own harness messages
 * (`role: 'tool'`) and map one-to-one onto the wire's tool messages.
 * Developer messages (tool-set change logs) carry nothing this wire needs —
 * a chat-completions request declares its tools once in `tools` — so they
 * are skipped.
 * @param messages - the harness request history, in order.
 * @returns the wire messages; order preserved.
 */
export function serializeMessages(messages: readonly RequestMessage[]): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    if (message.role === 'tool') {
      wire.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: flattenText(message.content) || '(no output)',
      })
      continue
    }
    // user (and one-shot user input); developer messages carry only the
    // tool-set log this wire expresses through its `tools` field instead.
    if (message.role === 'user') {
      wire.push({ role: 'user', content: flattenText(message.content) })
    }
  }
  return wire
}
