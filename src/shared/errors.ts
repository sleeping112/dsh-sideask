/**
 * Provider failure → user-facing error mapping.
 *
 * The LLM service reports stable codes on its terminal `finish` chunk
 * (`NO_ADAPTER`, `MISSING_CREDENTIAL`, `AUTH`, `RATE_LIMIT`,
 * `CONTEXT_WINDOW_EXCEEDED`, `QUOTA`, `ACCOUNT_QUOTA`, …). The plugin must
 * route on those codes, never on message text, because provider wording is
 * not part of the contract.
 */

import type { SideAskError, SideAskErrorCode } from './contract.js'

const KNOWN: SideAskErrorCode[] = [
  'NO_ADAPTER',
  'MISSING_CREDENTIAL',
  'AUTH',
  'RATE_LIMIT',
  'QUOTA',
  'CONTEXT_WINDOW_EXCEEDED',
  'ABORTED',
  'TIMEOUT',
  'PROVIDER_ERROR',
  'INTERNAL',
  'BAD_REQUEST',
  'API_MISMATCH',
  'CONTEXT_DISABLED',
]

/** Failure codes that a retry can plausibly fix on its own. */
const RETRYABLE = new Set<string>([
  'RATE_LIMIT',
  'TIMEOUT',
  'PROVIDER_ERROR',
  'INTERNAL',
])

/** Failure codes where re-asking without context may still succeed. */
const DEGRADABLE = new Set<string>(['CONTEXT_WINDOW_EXCEEDED', 'BAD_REQUEST'])

export function makeError(
  code: SideAskErrorCode,
  message: string,
  overrides: Partial<SideAskError> = {},
): SideAskError {
  return {
    code,
    message,
    retryable: RETRYABLE.has(code),
    degradableToQuestionOnly: DEGRADABLE.has(code),
    ...overrides,
  }
}

/** Normalise whatever the provider layer threw into a contract error. */
export function fromFailure(failure: unknown, fallback: SideAskErrorCode = 'INTERNAL'): SideAskError {
  if (failure !== null && typeof failure === 'object') {
    const record = failure as Record<string, unknown>
    const raw = typeof record.code === 'string' ? record.code.toUpperCase() : ''
    const message =
      typeof record.message === 'string' && record.message.length > 0
        ? record.message
        : raw.length > 0
          ? raw
          : '模型调用失败'
    if (raw === 'ACCOUNT_QUOTA') return makeError('QUOTA', message)
    if (raw === 'INVALID_CREDENTIAL') return makeError('MISSING_CREDENTIAL', message)
    if (raw === 'ABORTED') return { code: 'ABORTED', message, retryable: false, degradableToQuestionOnly: false }
    if ((KNOWN as string[]).includes(raw)) return makeError(raw as SideAskErrorCode, message)
    return makeError(fallback, message)
  }
  if (typeof failure === 'string' && failure.length > 0) return makeError(fallback, failure)
  return makeError(fallback, '模型调用失败')
}
