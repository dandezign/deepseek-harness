import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { serializeRequest, thinkingKwargs } from '../src/serialize.ts'

/** The minimal request every case builds on; each case adds one field. */
function base(): Pick<GenerateOptions, 'provider' | 'model' | 'messages'> {
  return { provider: 'llamacpp', model: 'tiny', messages: [] }
}

describe('serializeRequest', () => {
  it('sends no template kwargs when no reasoning effort is selected', () => {
    const body = serializeRequest(base())
    expect(body.model).toBe('tiny')
    expect(body.stream).toBe(true)
    expect('chat_template_kwargs' in body).toBe(false)
  })

  it('maps the graded efforts onto chat_template_kwargs.reasoning_effort', () => {
    expect(serializeRequest({ ...base(), reasoningEffort: ReasoningEffortId('low') }).chat_template_kwargs)
      .toEqual({ reasoning_effort: 'low' })
    expect(serializeRequest({ ...base(), reasoningEffort: ReasoningEffortId('medium') }).chat_template_kwargs)
      .toEqual({ reasoning_effort: 'medium' })
    expect(serializeRequest({ ...base(), reasoningEffort: ReasoningEffortId('xhigh') }).chat_template_kwargs)
      .toEqual({ reasoning_effort: 'xhigh' })
  })

  it('maps off onto enable_thinking, which every family tested honors', () => {
    expect(serializeRequest({ ...base(), reasoningEffort: ReasoningEffortId('off') }).chat_template_kwargs)
      .toEqual({ enable_thinking: false })
  })

  it('refuses efforts the Qwen3.8 template would reject server-side', () => {
    // The template raises "Unexpected reasoning effort max" (and the same for
    // high) — fail the request client-side instead of a provider 500.
    expect(() => thinkingKwargs(ReasoningEffortId('high')))
      .toThrow(/does not support reasoning effort "high"/)
    expect(() => thinkingKwargs(ReasoningEffortId('max')))
      .toThrow(/does not support reasoning effort "max"/)
  })
})
