/**
 * The chat-completions wire helpers sibling adapters share with this package:
 * SSE parsing, chunk translation, message serialization, and the wire error
 * code. Published as a built subpath (`@deepseek-ai/dsh-llm-deepseek/wire`)
 * so consumers never import this package's sources; the package root stays
 * free of wire helpers.
 *
 * @module @deepseek-ai/dsh-llm-deepseek/wire
 */

export { httpErrorCode } from './wire/http-error-code.ts'
export { DONE, parseSse } from './wire/sse.ts'
export { translate } from './wire/translate.ts'
export { serializeMessages } from './wire/serialize.ts'
export type { WireError, WireMessage, WireRequest, WireTool } from './wire/types.ts'
