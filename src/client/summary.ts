/**
 * Client-side summary layer: cache and planning.
 *
 * The context window keeps the newest N messages; everything older would be lost.
 * Instead the client asks the host to compress that overflow ONCE (in the
 * background, after a turn settles) and reuses the text on later questions. The
 * cache key is derived from the exact overflowing message ids, so any change in
 * the transcript invalidates it automatically.
 *
 * Pure helpers here so the cache/planning rules are unit-testable without a DOM.
 */

import type { SummarizeMessage } from '../shared/contract.js'
import { planSummaryMessages } from '../shared/summarize.js'

export const SUMMARY_CACHE_LIMIT = 8

export interface SummaryPlanView {
  overflow: SummarizeMessage[]
  ids: string[]
  key: string
}

export class SummaryCache {
  private readonly entries = new Map<string, string>()
  private readonly limit: number

  constructor(limit: number = SUMMARY_CACHE_LIMIT) {
    this.limit = Math.max(1, Math.trunc(limit))
  }

  get(key: string): string | null {
    return this.entries.get(key) ?? null
  }

  put(key: string, text: string): void {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    this.entries.delete(key)
    this.entries.set(key, trimmed)
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

interface MessageLike {
  id: string
  role: SummarizeMessage['role']
  text: string
}

/** Which messages of a transcript are covered by the summary (vs the window). */
export function planOverflow(messages: MessageLike[], recentLimit: number): SummaryPlanView {
  const plan = planSummaryMessages(messages, recentLimit)
  return { overflow: plan.overflow, ids: plan.ids, key: plan.key }
}

/**
 * Decide whether the current plan needs a background summary run.
 * `inFlightKey` prevents duplicate concurrent calls for the same message set.
 */
export function summaryStatus(
  plan: SummaryPlanView,
  cached: string | null,
  inFlightKey: string | null,
): { needed: boolean; cached: boolean; pending: boolean } {
  const cachedNow = cached !== null && cached.trim().length > 0
  return {
    needed: plan.ids.length > 0 && !cachedNow && inFlightKey !== plan.key,
    cached: cachedNow,
    pending: plan.ids.length > 0 && !cachedNow,
  }
}
