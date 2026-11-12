/**
 * Token estimation.
 *
 * We deliberately do not ship a tokenizer vocabulary: the plugin must stay a
 * few hundred kilobytes and must not depend on a provider package just to
 * budget text. Instead we use a CJK-aware heuristic calibrated on DeepSeek
 * tokenizers, and we keep the *only* invariant that matters for safety:
 * the estimate must be conservative, i.e. it should over-count rather than
 * under-count. A 10-15% over-estimate costs a few unused tokens; an
 * under-estimate costs a truncated provider call.
 *
 * Calibration notes (rough, from public tokenizer behaviour):
 * - Latin scripts: ~4 characters per token.
 * - CJK (Han/Hiragana/Katakana/Hangul): ~1 token per character (slightly less
 *   for common pairs, so we use 0.9 to stay near reality but not optimistic
 *   for the safety direction we want).
 * - Emoji / other symbols: 2 per token.
 * - Whitespace runs collapse to roughly 1 token per 2 characters.
 */

const CJK =
  /[\u2e80-\u2e99\u2e9b-\u2ef3\u2f00-\u2fd5\u3005\u3007\u3021-\u3029\u3038-\u303b\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}]/u
const KANA_HANGUL = /[\u3040-\u30ff\u31f0-\u31ff\u3130-\u318f\uac00-\ud7af]/u
const EMOJI = /[\u{1f300}-\u{1faff}\u{1f000}-\u{1f2ff}\u2600-\u27bf]/u

/** Per-message overhead for role markers and separators. */
export const MESSAGE_OVERHEAD_TOKENS = 4

/** Cheap, allocation-light estimate for a single text run. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  let cjk = 0
  let latin = 0
  let spaces = 0
  let emoji = 0
  for (const ch of text) {
    if (CJK.test(ch) || KANA_HANGUL.test(ch)) cjk += 1
    else if (EMOJI.test(ch)) emoji += 1
    else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') spaces += 1
    else latin += 1
  }
  const tokens =
    cjk * 0.9 +
    latin / 4 +
    spaces / 2 +
    emoji * 2
  return Math.max(1, Math.ceil(tokens))
}

/** Estimate for one message including its framing overhead. */
export function estimateMessageTokens(text: string): number {
  return estimateTokens(text) + MESSAGE_OVERHEAD_TOKENS
}

/**
 * Truncate `text` to at most `maxTokens`, keeping head and tail.
 *
 * Middle-elision is used for conversation messages because both the setup
 * (head) and the conclusion (tail) carry intent; for tool output that is a
 * long list, the tail is usually the interesting part.
 */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: '', truncated: text.length > 0 }
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false }

  const marker = '\n…（已按上下文预算截断）…\n'
  const markerTokens = estimateTokens(marker)
  const available = Math.max(0, maxTokens - markerTokens)
  if (available <= 0) return { text: '', truncated: true }

  // Binary-search the largest head+tail split that fits the estimate. The
  // estimate is monotone in character count for a fixed split ratio, so this
  // converges in a handful of probes.
  const chars = [...text]
  let low = 0
  let high = chars.length
  let best = ''
  while (low <= high) {
    const keep = Math.floor((low + high) / 2)
    const head = Math.floor(keep * 0.6)
    const tail = keep - head
    const candidate =
      chars.slice(0, head).join('') + marker + (tail > 0 ? chars.slice(chars.length - tail).join('') : '')
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate
      low = keep + 1
    } else {
      high = keep - 1
    }
  }
  return { text: best, truncated: true }
}
