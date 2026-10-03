/**
 * Map an HTTP status to a stable LlmError code. The chat-completions wire
 * vocabulary the sibling adapters share: the package root's Messages
 * transport classifies through transport.ts instead.
 *
 * @module
 */

import { CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, isModelNotLoadedError, isQuotaExceededError, MODEL_NOT_LOADED_CODE, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { WireError } from './types.ts'

/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @param error - parsed provider error body, when available.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status: number, error?: WireError['error']): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 413) return 'INVALID_REQUEST'
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    if (isModelNotLoadedError(detail)) return MODEL_NOT_LOADED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}
