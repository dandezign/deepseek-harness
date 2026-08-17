import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { serializeRequest, thinkingKwargs } from '../src/serialize.ts'

/** The minimal request every case builds on; each case adds one field. */
function base(): Pick<GenerateOptions, 'provider' | 'model' | 'messages'> {
  return { provider: 'llamacpp', model: 'tiny', messages: [] }
}

/** One stored PNG the fake store hands back for any reference. */
const PIXEL = new Uint8Array([137, 80, 78, 71])

/** A store that answers every read with {@link PIXEL}. */
function fakeAttachments(): AttachmentStore {
  return {
    readImage: (ref: ImageAttachmentRef) => Promise.resolve({ ref, data: PIXEL }),
  } as unknown as AttachmentStore
}

/** A user message carrying one image beside its caption. */
function imageMessage(): Message[] {
  return [{
    role: 'user',
    content: [
      { type: 'text', text: 'what is this?' },
      {
        type: 'image',
        attachment: {
          attachmentId: 'att-1', mediaType: 'image/png', bytes: 4, width: 1, height: 1,
        },
      },
    ],
  } as unknown as Message]
}

describe('serializeRequest', () => {
  it('sends no template kwargs when no reasoning effort is selected', async () => {
    const body = await serializeRequest(base())
    expect(body.model).toBe('tiny')
    expect(body.stream).toBe(true)
    expect('chat_template_kwargs' in body).toBe(false)
  })

  it('maps the graded efforts onto chat_template_kwargs.reasoning_effort', async () => {
    expect((await serializeRequest({ ...base(), reasoningEffort: ReasoningEffortId('low') })).chat_template_kwargs)
      .toEqual({ reasoning_effort: 'low' })
    expect((await serializeRequest({ ...base(), reasoningEffort: ReasoningEffortId('medium') })).chat_template_kwargs)
      .toEqual({ reasoning_effort: 'medium' })
    expect((await serializeRequest({ ...base(), reasoningEffort: ReasoningEffortId('xhigh') })).chat_template_kwargs)
      .toEqual({ reasoning_effort: 'xhigh' })
  })

  it('maps off onto enable_thinking, which every family tested honors', async () => {
    expect((await serializeRequest({ ...base(), reasoningEffort: ReasoningEffortId('off') })).chat_template_kwargs)
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

  it('serializes an image into OpenAI-style content parts, caption first', async () => {
    const body = await serializeRequest({ ...base(), messages: imageMessage() }, fakeAttachments())
    expect(body.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw==' } },
      ],
    }])
  })

  it('refuses image content when no attachment store is available', async () => {
    // Without the store the request falls to the shared text wire, whose
    // refusal is the point: flattening would erase the image silently.
    await expect(serializeRequest({ ...base(), messages: imageMessage() }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('leaves a text-only conversation on the shared wire shape', async () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as unknown as Message[]
    const body = await serializeRequest({ ...base(), messages }, fakeAttachments())
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })
})
