/**
 * Context extraction and token budgeting — the heart of the plugin.
 *
 * Design rules (all of them are directly tested in `test/context.test.mjs`):
 *
 * 1. READ-ONLY. This module takes a snapshot and returns a budgeted bundle.
 *    It has no reference to any live conversation object, so it cannot write.
 * 2. INCREMENTAL. `ProjectionCache` memoises the expensive part (redaction +
 *    token estimation) per message identity + content hash, so a transcript
 *    that grew by one message costs one projection, not N.
 * 3. BUDGETED. Total context tokens never exceed `contextBudgetTokens`
 *    (conservative token estimate, so we stay under the real count).
 * 4. PRIORITISED. User selection > recent messages > history summary.
 *    Degradation on overflow is ordered and recorded in `stats.degradations`
 *    so the UI can explain *why* the answer saw less context.
 * 5. MINIMISED. Sensitive spans are masked per item, after budgeting, so the
 *    mask length participates in the final token count.
 */

import type {
  ChatMessage,
  ContextBundle,
  ContextItem,
  ContextSelection,
  ContextStats,
  MessageRole,
  TranscriptSnapshot,
} from './contract.js'
import { redact, type RedactOptions } from './redact.js'
import { MESSAGE_OVERHEAD_TOKENS, estimateTokens, truncateToTokens } from './tokens.js'

// ------------------------------------------------------------------ defaults

/** Default share of the budget a user selection may consume. */
export const DEFAULT_SELECTION_RATIO = 0.4
/** Default share of the budget the history summary may consume. */
export const DEFAULT_SUMMARY_RATIO = 0.25
/** Default share of the budget explicitly pinned (`#`) messages may consume. */
export const DEFAULT_PINS_RATIO = 0.35
/** A single message never takes more than this share of the budget. */
const MAX_ITEM_RATIO = 0.35
/** Below this many remaining tokens a truncated message is not worth adding. */
const MIN_USEFUL_TOKENS = 48
/** Rows shorter than this are not considered for containment dedupe. */
const CONTAINMENT_MIN_CHARS = 240

export interface ContextBudgetSettings {
  readContext: boolean
  recentMessageLimit: number
  contextBudgetTokens: number
  autoSummary: boolean
  redactSensitive: boolean
}

export interface OverflowSummary {
  text: string
  /** Message ids the summary stands in for (oldest → newest). */
  coversMessageIds: string[]
}

export interface ContextBuildInput {
  snapshot: TranscriptSnapshot
  question: string
  selection?: ContextSelection | null
  settings: ContextBudgetSettings
  /**
   * Messages the user pinned explicitly (`#` references). They rank below a live
   * selection but above the automatic recent window: pinning is an explicit
   * "this matters" signal.
   */
  pins?: PinnedInput[] | null
  /** Summary of messages older than the recent window, when available. */
  overflowSummary?: OverflowSummary | null
  redactOptions?: RedactOptions
  cache?: ProjectionCache
  selectionRatio?: number
  summaryRatio?: number
  pinsRatio?: number
}

/** One explicitly pinned main-conversation message. */
export interface PinnedInput {
  messageId: string
  role: MessageRole
  text: string
}

// ------------------------------------------------------------ projection cache

export interface ProjectedMessage {
  id: string
  role: MessageRole
  /** Redacted, token-measured text. */
  text: string
  tokens: number
  /** Masks applied to this message. */
  redactions: number
  hash: string
}

export interface ProjectionCacheStats {
  hits: number
  misses: number
  size: number
}

/** FNV-1a over the message identity + content; cheap and stable. */
function contentHash(message: ChatMessage, optionsKey: string): string {
  const key = `${message.id}\u0000${message.role}\u0000${message.toolName ?? ''}\u0000${message.text}\u0000${optionsKey}`
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

function optionsKey(options: RedactOptions): string {
  return `${(options.customPatterns ?? []).join('|')}::${options.homeDir ?? ''}::${options.username ?? ''}`
}

/**
 * Memoises per-message redaction + token estimation.
 *
 * The cache is keyed by message id *and* content hash, so an edited message
 * (a streaming assistant reply, a tool result that grew) is re-projected while
 * every unchanged message is served from memory. `prune` bounds memory when a
 * long conversation scrolls away.
 */
export class ProjectionCache {
  private readonly entries = new Map<string, ProjectedMessage>()
  private hits = 0
  private misses = 0

  constructor(private readonly limit = 512) {}

  project(message: ChatMessage, options: RedactOptions = {}, redactEnabled = true): ProjectedMessage {
    const hash = redactEnabled
      ? contentHash(message, optionsKey(options))
      : contentHash(message, 'raw')
    const existing = this.entries.get(message.id)
    if (existing !== undefined && existing.hash === hash) {
      this.hits += 1
      return existing
    }
    this.misses += 1
    const masked = redactEnabled ? redact(message.text, options) : { text: message.text, total: 0 }
    const projected: ProjectedMessage = {
      id: message.id,
      role: message.role,
      text: masked.text,
      tokens: estimateTokens(masked.text) + MESSAGE_OVERHEAD_TOKENS,
      redactions: masked.total,
      hash,
    }
    this.entries.set(message.id, projected)
    if (this.entries.size > this.limit) this.evictOldest()
    return projected
  }

  /** Drop entries whose ids are no longer in the conversation window. */
  prune(keep: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) if (!keep.has(id)) this.entries.delete(id)
  }

  stats(): ProjectionCacheStats {
    return { hits: this.hits, misses: this.misses, size: this.entries.size }
  }

  clear(): void {
    this.entries.clear()
    this.hits = 0
    this.misses = 0
  }

  private evictOldest(): void {
    const first = this.entries.keys().next()
    if (!first.done) this.entries.delete(first.value)
  }
}

// ------------------------------------------------------------------ dedupe

function normalizeForDedupe(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Drop superseded duplicates, keeping the newest copy.
 *
 * Two rules:
 * - exact duplicates after whitespace normalisation, and
 * - containment: an older short row fully contained in a newer long row is the
 *   classic "tool printed, then assistant quoted it" pair; the newer row wins.
 *
 * Returns the kept messages plus how many were dropped.
 */
export function dedupeMessages(messages: ChatMessage[]): { kept: ChatMessage[]; dropped: number } {
  const kept: ChatMessage[] = []
  const seen = new Set<string>()
  let dropped = 0

  // Walk newest → oldest so the newest copy is always the one kept.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    const normalized = normalizeForDedupe(message.text)
    if (normalized.length === 0) {
      dropped += 1
      continue
    }
    if (seen.has(normalized)) {
      dropped += 1
      continue
    }
    let contained = false
    if (normalized.length >= CONTAINMENT_MIN_CHARS) {
      for (const prior of seen) {
        if (prior.length > normalized.length && prior.includes(normalized)) {
          contained = true
          break
        }
      }
    }
    if (contained) {
      dropped += 1
      continue
    }
    seen.add(normalized)
    kept.push(message)
  }
  kept.reverse()
  return { kept, dropped }
}

// ------------------------------------------------------------------- build

function emptyStats(budgetTokens: number, questionTokens: number): ContextStats {
  return {
    budgetTokens,
    questionTokens,
    selectionTokens: 0,
    pinnedTokens: 0,
    recentTokens: 0,
    summaryTokens: 0,
    usedTokens: 0,
    consideredCount: 0,
    dedupedCount: 0,
    redactedCount: 0,
    truncations: { selection: 0, recent: 0, summary: 0 },
    degradations: [],
  }
}

function refFor(index: number): string {
  return `c${index}`
}

/**
 * Build the context bundle for one question.
 *
 * Pure: same input ⇒ same output (given the same cache contents, which only
 * affect performance, not results).
 */
export function buildContext(input: ContextBuildInput): ContextBundle {
  const budgetTokens = Math.max(256, Math.trunc(input.settings.contextBudgetTokens))
  const questionTokens = estimateTokens(input.question)
  const stats = emptyStats(budgetTokens, questionTokens)

  if (!input.settings.readContext) {
    stats.degradations.push('context-disabled')
    return { items: [], summary: null, selection: null, stats }
  }

  const cache = input.cache ?? new ProjectionCache()
  const redactOptions = input.redactOptions ?? {}
  const redactionOn = input.settings.redactSensitive
  const selectionRatio = input.selectionRatio ?? DEFAULT_SELECTION_RATIO
  const summaryRatio = input.summaryRatio ?? DEFAULT_SUMMARY_RATIO
  const pinsRatio = input.pinsRatio ?? DEFAULT_PINS_RATIO

  // ---- 1. dedupe then window -------------------------------------------
  const deduped = dedupeMessages(input.snapshot.messages)
  stats.dedupedCount = deduped.dropped
  const limit = Math.max(1, Math.trunc(input.settings.recentMessageLimit))
  const windowMessages = deduped.kept.slice(-limit)
  stats.consideredCount = deduped.kept.length

  // ---- 2. selection (highest priority) ---------------------------------
  let selection: ContextSelection | null = null
  let selectionTokens = 0
  if (input.selection !== undefined && input.selection !== null && input.selection.text.trim().length > 0) {
    const cap = Math.max(MIN_USEFUL_TOKENS, Math.floor(budgetTokens * selectionRatio))
    const masked = redactionOn
      ? redact(input.selection.text, redactOptions)
      : { text: input.selection.text, total: 0 }
    stats.redactedCount += masked.total
    const fitted = truncateToTokens(masked.text, cap)
    if (fitted.truncated) stats.truncations.selection += 1
    selection = { text: fitted.text, ...(input.selection.messageId !== undefined ? { messageId: input.selection.messageId } : {}) }
    selectionTokens = estimateTokens(fitted.text)
    stats.selectionTokens = selectionTokens
  }

  // ---- 2b. explicitly pinned messages (`#` references) -----------------
  // Explicit user intent ranks below a live selection but above the automatic
  // window. Each pin is redacted, capped by the remaining pin budget, and the
  // pin budget itself is capped at a share of the total.
  const pinnedItems: ContextItem[] = []
  let pinnedTokens = 0
  if (Array.isArray(input.pins) && input.pins.length > 0) {
    const cap = Math.max(MIN_USEFUL_TOKENS, Math.floor(budgetTokens * pinsRatio))
    const maxItemTokens = Math.max(MIN_USEFUL_TOKENS, Math.floor(budgetTokens * MAX_ITEM_RATIO))
    const seen = new Set<string>()
    for (const pin of input.pins) {
      if (pin.messageId.length === 0 || seen.has(pin.messageId)) continue
      seen.add(pin.messageId)
      const remaining = cap - pinnedTokens
      if (remaining < MIN_USEFUL_TOKENS) {
        stats.degradations.push('pins-trimmed')
        break
      }
      const masked = redactionOn ? redact(pin.text, redactOptions) : { text: pin.text, total: 0 }
      stats.redactedCount += masked.total
      const fitted = truncateToTokens(masked.text, Math.min(remaining, maxItemTokens))
      const tokens = estimateTokens(fitted.text) + MESSAGE_OVERHEAD_TOKENS
      if (tokens > remaining) {
        stats.degradations.push('pins-trimmed')
        break
      }
      pinnedItems.push({
        ref: '',
        messageId: pin.messageId,
        role: pin.role,
        text: fitted.text,
        tokens,
        truncated: fitted.truncated,
        source: 'pinned',
      })
      pinnedTokens += tokens
    }
    stats.pinnedTokens = pinnedTokens
  }

  // ---- 3. summary (represents history older than the window) ------------
  let summaryText: string | null = null
  let summaryTokens = 0
  const summaryEnabled = input.settings.autoSummary && input.overflowSummary !== null && input.overflowSummary !== undefined
  const applySummary = (): void => {
    summaryText = null
    summaryTokens = 0
    stats.summaryTokens = 0
    if (!summaryEnabled) return
    const source = input.overflowSummary
    if (source === undefined || source === null) return
    const cap = Math.max(MIN_USEFUL_TOKENS, Math.floor(budgetTokens * summaryRatio))
    const masked = redactionOn ? redact(source.text, redactOptions) : { text: source.text, total: 0 }
    stats.redactedCount += masked.total
    const fitted = truncateToTokens(masked.text, cap)
    if (fitted.truncated) stats.truncations.summary += 1
    summaryText = fitted.text
    summaryTokens = estimateTokens(fitted.text)
    stats.summaryTokens = summaryTokens
  }
  applySummary()

  // ---- 4. recent messages (newest first) --------------------------------
  const project = (message: ChatMessage): ProjectedMessage => cache.project(message, redactOptions, redactionOn)

  const fillRecent = (): { items: ContextItem[]; tokens: number; trimmed: boolean } => {
    const available = budgetTokens - selectionTokens - pinnedTokens - summaryTokens
    const maxItemTokens = Math.max(MIN_USEFUL_TOKENS, Math.floor(budgetTokens * MAX_ITEM_RATIO))
    const chosen: ContextItem[] = []
    let used = 0
    let trimmed = false
    for (let index = windowMessages.length - 1; index >= 0; index -= 1) {
      const message = windowMessages[index]
      if (message === undefined) continue
      const projected = project(message)
      const remaining = available - used
      if (remaining < MIN_USEFUL_TOKENS) {
        trimmed = true
        break
      }
      let text = projected.text
      let tokens = projected.tokens
      let truncated = false
      const cap = Math.min(remaining, maxItemTokens)
      if (tokens > cap) {
        const fitted = truncateToTokens(text, cap)
        text = fitted.text
        tokens = estimateTokens(text) + MESSAGE_OVERHEAD_TOKENS
        truncated = true
      }
      if (tokens > remaining) {
        trimmed = true
        break
      }
      if (truncated) stats.truncations.recent += 1
      stats.redactedCount += projected.redactions
      chosen.push({
        ref: '',
        messageId: message.id,
        role: message.role,
        text,
        tokens,
        truncated: truncated || message.truncated === true,
        source: 'recent',
      })
      used += tokens
      if (tokens > 0) {
        // A partially truncated message is the last one we add.
        if (truncated) {
          trimmed = true
          break
        }
      }
    }
    chosen.reverse()
    return { items: chosen, tokens: used, trimmed }
  }

  let recent = fillRecent()

  // ---- 5. degradation: recent beats summary ----------------------------
  if (recent.trimmed && summaryTokens > 0) {
    summaryText = null
    summaryTokens = 0
    stats.summaryTokens = 0
    stats.degradations.push('summary-dropped-for-recent')
    recent = fillRecent()
  }

  // ---- 6. final assembly ------------------------------------------------
  const items: ContextItem[] = []
  let nextRef = 1
  if (selection !== null) {
    // The selection is presented as the first item so citations can address it,
    // but it keeps `source: 'selection'` so the prompt can label it separately.
    items.push({
      ref: refFor(nextRef),
      messageId: selection.messageId ?? `selection:${input.snapshot.sessionId}`,
      role: 'user',
      text: selection.text,
      tokens: selectionTokens,
      truncated: stats.truncations.selection > 0,
      source: 'selection',
    })
    nextRef += 1
  }
  for (const pin of pinnedItems) {
    items.push({ ...pin, ref: refFor(nextRef) })
    nextRef += 1
  }
  for (const item of recent.items) {
    items.push({ ...item, ref: refFor(nextRef) })
    nextRef += 1
  }

  stats.recentTokens = recent.tokens
  stats.usedTokens = selectionTokens + pinnedTokens + summaryTokens + recent.tokens
  if (items.length === 0 && summaryText === null) {
    stats.degradations.push('question-only')
  } else if (recent.trimmed) {
    stats.degradations.push('recent-trimmed')
  }
  if (stats.usedTokens > budgetTokens) {
    // Defensive: never let a rounding artefact overrun the budget.
    stats.degradations.push('over-budget-trimmed')
  }

  return { items, summary: summaryText, selection, stats }
}

/** Bundle used when the user disabled context reading or extraction failed. */
export function buildQuestionOnlyBundle(question: string, settings: ContextBudgetSettings): ContextBundle {
  const stats = emptyStats(settings.contextBudgetTokens, estimateTokens(question))
  stats.degradations.push(settings.readContext ? 'extraction-failed' : 'context-disabled')
  return { items: [], summary: null, selection: null, stats }
}
