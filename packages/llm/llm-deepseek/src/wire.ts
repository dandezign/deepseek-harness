/**
 * The chat-completions wire helpers sibling adapters share with this package:
 * SSE parsing, chunk translation, message serialization, and the wire error
 * code. Published as a built subpath (`@deepseek-ai/dsh-llm-deepseek/wire`)
 * so consumers never import this package's sources; the package root stays
 * free of wire helpers.
 *
 * @module @deepseek-ai/dsh-llm-deepseek/wire
 */

export { httpErrorCode } from './adapter.ts'
export { DONE, parseSse } from './sse.ts'
export { translate } from './translate.ts'
export { serializeMessages } from './serialize.ts'
