/**
 * Shared summary-layer helpers.
 *
 * Long side threads cannot stay inside the context window, so messages that fall
 * out of the recent window are compressed into a short summary once, then reused
 * on every later question. These helpers are pure and used by both halves:
 * - the client decides WHICH messages overflow and caches the result by a stable
 *   key derived from the overflow's message ids;
 * - the host builds the instruction and clamps what it is willing to send.
 */

import type { MessageRole, SummarizeMessage } from './contract.js'

/** Default target length of a history summary, in characters. */
export const DEFAULT_SUMMARY_MAX_CHARS = 1200
/** Never summarise more than this many messages in one call. */
export const SUMMARY_MAX_MESSAGES = 40
/** Never send more than this many characters to the summariser. */
export const SUMMARY_MAX_INPUT_CHARS = 8000
/** A summary shorter than this is not worth injecting into the prompt. */
export const MIN_SUMMARY_CHARS = 24

export interface SummaryPlan {
  /** Messages before the recent window, oldest first. */
  overflow: SummarizeMessage[]
  /** Ids of the overflow messages (used to detect changes). */
  ids: string[]
  /** Stable cache key; changes exactly when the overflowing set changes. */
  key: string
}

interface MessageLike {
  id: string
  role: MessageRole
  text: string
}

/**
 * Split a transcript into "already answered by a summary" (overflow) and the
 * recent window. `recentLimit` mirrors the context settings.
 */
export function planSummaryMessages(messages: MessageLike[], recentLimit: number): SummaryPlan {
  const limit = Math.max(1, Math.trunc(recentLimit))
  const overflow = messages.slice(0, Math.max(0, messages.length - limit))
  const ids = overflow.map((message) => message.id)
  return {
    overflow: overflow.map((message) => ({ id: message.id, role: message.role, text: message.text })),
    ids,
    key: summarizeKey(ids),
  }
}

/** FNV-1a over the joined ids; cheap and stable across reloads. */
export function summarizeKey(ids: string[]): string {
  let hash = 0x811c9dc5
  for (const id of ids) {
    for (let index = 0; index < id.length; index += 1) {
      hash ^= id.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
    hash ^= 0x1f
    hash = Math.imul(hash, 0x01000193)
  }
  return `s${(hash >>> 0).toString(36)}`
}

/** Keep only the newest messages and clamp the total input size. */
export function clampSummaryMessages(
  messages: SummarizeMessage[],
  options: { maxMessages?: number; maxChars?: number } = {},
): SummarizeMessage[] {
  const maxMessages = Math.max(1, Math.trunc(options.maxMessages ?? SUMMARY_MAX_MESSAGES))
  const maxChars = Math.max(0, Math.trunc(options.maxChars ?? SUMMARY_MAX_INPUT_CHARS))
  const kept: SummarizeMessage[] = []
  let used = 0
  // Walk newest → oldest so the most relevant tail is kept, then restore order.
  for (let index = messages.length - 1; index >= 0 && kept.length < maxMessages; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    const room = maxChars - used
    if (room <= 0) break
    const text = message.text.length <= room ? message.text : message.text.slice(0, room)
    if (text.trim().length === 0) continue
    kept.push({ id: message.id, role: message.role, text })
    used += text.length
  }
  return kept.reverse()
}

/** The instruction the host sends to the model for one summary. */
export function buildSummaryInstruction(maxChars: number = DEFAULT_SUMMARY_MAX_CHARS): string {
  const target = Math.max(120, Math.trunc(maxChars))
  return [
    '你是对话历史压缩器。',
    `把给出的主对话历史压缩成不超过 ${target} 字的中文要点摘要。`,
    '必须保留：结论与决策、待办与承诺、关键事实与数字、未解决的问题。',
    '不要编造、不要评论、不要提出新建议；不要使用 Markdown 标题。',
    '如果历史里没有实质内容，输出“（无实质内容）”。',
    '直接输出摘要正文。',
  ].join('\n')
}
