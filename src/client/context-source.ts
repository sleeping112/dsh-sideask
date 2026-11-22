/**
 * Session context source: the only place that reads the main conversation.
 *
 * Contract of this module:
 * - READ-ONLY. It retains a session binding and reads
 *   `binding.eventSource.getSnapshot()`, nothing else. No write APIs is imported.
 * - INCREMENTAL. Messages are re-projected only when their content hash changes;
 *   the redaction/token cache is an LRU-bounded `ProjectionCache`.
 * - CANCELLABLE and BOUNDED. `build()` accepts an AbortSignal, never awaits
 *   unbounded work, and yields a question-only bundle instead of failing the
 *   answer path.
 *
 * Everything here is best-effort by design: if the session cannot be retained
 * (the documented main integration risk), the side-ask window still answers,
 * just without context.
 */

import type { ChatMessage, ContextBundle, ContextSelection, SideAskSettings, SummarizeMessage } from '../shared/contract.js'
import { ProjectionCache, buildContext, buildQuestionOnlyBundle } from '../shared/context.js'
import { MIN_SUMMARY_CHARS, clampSummaryMessages } from '../shared/summarize.js'
import type { SessionsService, SessionBinding } from './types.js'
import { entriesToMessages, lastRouteHint, projectIncrementally } from './transcript.js'
import { SummaryCache, planOverflow, summaryStatus, type SummaryPlanView } from './summary.js'
import {
  SUMMARY_STORAGE_KEY,
  getSessionSummaries,
  loadSummaryStore,
  putSessionSummary,
  saveSummaryStore,
  type SummaryStore,
} from './summary-store.js'

export interface ContextSourceOptions {
  sessions: SessionsService | undefined
  /** Hard ceiling for one extraction pass (default 1500 ms). */
  timeoutMs?: number
  /**
   * Compress overflow messages into a short summary. Wired to the host
   * `/summarize` route; absent in tests / hostless contexts.
   */
  summarize?: (messages: SummarizeMessage[], signal: AbortSignal) => Promise<string | null>
}

export interface SummaryState {
  overflowCount: number
  cached: boolean
  pending: boolean
  key: string
}

export interface SelectionNote {
  text: string
  messageId?: string
  sessionId?: string
}

export interface ExtractionResult {
  bundle: ContextBundle | null
  /** Why the bundle is null / partial, for the UI. */
  reason: 'ok' | 'disabled' | 'no-session' | 'no-feed' | 'timeout' | 'aborted' | 'error'
  error?: string
}

export class ContextSource {
  private binding: SessionBinding | null = null
  private sessionId: string | null = null
  private entries: unknown = null
  private readonly cache = new Map<string, { hash: string; message: ChatMessage }>()
  private readonly projections = new ProjectionCache()
  private unsubscribe: (() => void) | null = null
  private selection: SelectionNote | null = null
  private lastRevision = -1
  /**
   * The retain() reference we own. It must be released when we switch sessions,
   * otherwise every session switch leaves a retained session behind (a real
   * retention leak, not just memory).
   */
  private reference: { release(): void } | null = null
  /** Summaries of overflow messages, keyed by the overflowing id set. */
  private readonly summaries = new SummaryCache()
  private summaryInFlightKey: string | null = null
  private lastRecentLimit = 12
  /** Persisted summaries across page reloads, keyed by session id. */
  private summaryStore: SummaryStore = {}
  private summarySessionId: string | null = null

  constructor(private readonly options: ContextSourceOptions) {
    try {
      this.summaryStore = loadSummaryStore(window.localStorage.getItem(SUMMARY_STORAGE_KEY))
    } catch {
      // Storage unavailable: summaries stay in memory for this page.
    }
  }

  /** Restore this session's persisted summaries into the in-memory cache. */
  private attachSummarySession(sessionId: string): void {
    this.summarySessionId = sessionId
    this.summaries.clear()
    for (const [key, text] of Object.entries(getSessionSummaries(this.summaryStore, sessionId))) {
      this.summaries.put(key, text)
    }
  }

  private persistSummary(sessionId: string, key: string, text: string): void {
    this.summaryStore = putSessionSummary(this.summaryStore, sessionId, key, text)
    try {
      window.localStorage.setItem(SUMMARY_STORAGE_KEY, saveSummaryStore(this.summaryStore))
    } catch {
      // Quota/private mode: keep the in-memory copy.
    }
  }

  /** The session currently bound, if any. */
  get boundSessionId(): string | null {
    return this.sessionId
  }

  /**
   * Session-scoped ctx required by `conversation.input.for(...)`.
   * Null when nothing is bound — write-back then falls back to the clipboard.
   */
  get sessionCtx(): unknown {
    return this.binding?.ctx ?? null
  }

  /** Bind to a session; returns false when the session cannot be retained. */
  async bind(sessionId: string): Promise<boolean> {
    if (this.sessionId === sessionId && this.binding !== null) return true
    this.release()
    const sessions = this.options.sessions
    if (sessions === undefined) return false
    try {
      const reference = sessions.retain(sessionId, { source: 'dsh-sideask' })
      const binding = await reference.ready
      this.reference = reference
      this.binding = binding
      this.sessionId = sessionId
      this.attachSummarySession(sessionId)
      this.entries = binding.eventSource.getSnapshot().entries
      this.unsubscribe = binding.eventSource.subscribe(() => {
        this.entries = binding.eventSource.getSnapshot().entries
      })
      return true
    } catch {
      this.binding = null
      this.sessionId = null
      return false
    }
  }

  /** Bind using an already-retained binding (cheap path used by the probe). */
  adopt(sessionId: string, binding: SessionBinding | null | undefined): boolean {
    if (binding === null || binding === undefined) return false
    if (this.sessionId === sessionId && this.binding !== null) return true
    this.release()
    this.binding = binding
    this.sessionId = sessionId
    this.attachSummarySession(sessionId)
    this.entries = binding.eventSource.getSnapshot().entries
    this.unsubscribe = binding.eventSource.subscribe(() => {
      this.entries = binding.eventSource.getSnapshot().entries
    })
    return true
  }

  /** Messages currently readable from the bound session (no budget applied). */
  messages(): ChatMessage[] {
    return entriesToMessages(this.entries)
  }

  /**
   * Provider/model the main conversation is using.
   *
   * Routing metadata only — no message text — so it is safe to send even when
   * the user turned context reading off; without it the host falls back to the
   * global default model, which may be a route without credentials.
   */
  routeHint(): { provider: string; model: string } | null {
    return lastRouteHint(this.entries)
  }

  /** Whether overflow messages exist and whether their summary is cached. */
  summaryState(): SummaryState {
    const plan: SummaryPlanView = planOverflow(
      this.messages().map((message) => ({ id: message.id, role: message.role, text: message.text })),
      this.lastRecentLimit,
    )
    const cached = this.summaries.get(plan.key)
    const status = summaryStatus(plan, cached, this.summaryInFlightKey)
    return { overflowCount: plan.ids.length, cached: status.cached, pending: status.pending, key: plan.key }
  }

  /**
   * Compress the overflow once, in the background. Idempotent per message set:
   * concurrent calls for the same key are ignored, and cached results are reused.
   * Never throws.
   */
  async refreshSummary(): Promise<string | null> {
    if (this.options.summarize === undefined) return null
    const messages = this.messages()
    const plan = planOverflow(
      messages.map((message) => ({ id: message.id, role: message.role, text: message.text })),
      this.lastRecentLimit,
    )
    const status = summaryStatus(plan, this.summaries.get(plan.key), this.summaryInFlightKey)
    if (!status.needed) return null

    this.summaryInFlightKey = plan.key
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    try {
      const clamped = clampSummaryMessages(plan.overflow, { maxChars: 6000 })
      const text = await this.options.summarize(clamped, controller.signal)
      if (text !== null && text.trim().length >= MIN_SUMMARY_CHARS) {
        this.summaries.put(plan.key, text)
        if (this.summarySessionId !== null) this.persistSummary(this.summarySessionId, plan.key, text)
        return text.trim()
      }
      return null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
      this.summaryInFlightKey = null
    }
  }

  setSelection(note: SelectionNote | null): void {
    this.selection = note === null || note.text.trim().length === 0 ? null : note
  }

  currentSelection(): SelectionNote | null {
    return this.selection
  }

  clearSelection(): void {
    this.selection = null
  }

  /**
   * Build the budgeted context bundle for one question.
   *
   * Never throws and never blocks the caller past `timeoutMs`: on any problem it
   * returns a question-only bundle with the reason attached, so the UI can be
   * honest about why less context was available.
   */
  async build(
    question: string,
    settings: SideAskSettings,
    signal: AbortSignal,
    customPatterns: string[] = [],
  ): Promise<ExtractionResult> {
    if (!settings.readContext) return { bundle: buildQuestionOnlyBundle(question, settings), reason: 'disabled' }
    if (this.binding === null || this.sessionId === null) {
      return { bundle: buildQuestionOnlyBundle(question, settings), reason: 'no-session' }
    }
    if (signal.aborted) return { bundle: null, reason: 'aborted' }

    const timeoutMs = this.options.timeoutMs ?? 1500
    const work = async (): Promise<ExtractionResult> => {
      // Yield once so a large transcript cannot starve the main thread.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      if (signal.aborted) return { bundle: null, reason: 'aborted' }

      try {
        const projected = projectIncrementally(this.entries, this.cache)
        const revision = projected.messages.length
        if (revision !== this.lastRevision) this.lastRevision = revision
        this.lastRecentLimit = settings.recentMessageLimit

        // Overflow messages may already be covered by a cached summary (generated
        // in the background after a previous turn). If not, the bundle is still
        // valid — it simply carries a `summary-pending` degradation.
        const plan = planOverflow(
          projected.messages.map((message) => ({ id: message.id, role: message.role, text: message.text })),
          settings.recentMessageLimit,
        )
        const cachedSummary = settings.autoSummary ? this.summaries.get(plan.key) : null
        const overflowSummary =
          cachedSummary === null ? null : { text: cachedSummary, coversMessageIds: plan.ids }

        const selection: ContextSelection | null =
          this.selection === null
            ? null
            : {
                text: this.selection.text,
                ...(this.selection.messageId === undefined ? {} : { messageId: this.selection.messageId }),
              }
        const bundle = buildContext({
          snapshot: {
            sessionId: this.sessionId ?? 'unknown',
            revision,
            messages: projected.messages,
          },
          question,
          selection,
          settings: {
            readContext: settings.readContext,
            recentMessageLimit: settings.recentMessageLimit,
            contextBudgetTokens: settings.contextBudgetTokens,
            autoSummary: settings.autoSummary,
            redactSensitive: settings.redactSensitive,
          },
          overflowSummary,
          redactOptions: { customPatterns },
          cache: this.projections,
        })
        if (settings.autoSummary && plan.ids.length > 0 && cachedSummary === null) {
          bundle.stats.degradations.push('summary-pending')
        }
        // Drop cache entries for messages that fell out of the window.
        const keep = new Set(projected.messages.map((message) => message.id))
        this.projections.prune(keep)
        return { bundle, reason: 'ok' }
      } catch (error) {
        return {
          bundle: buildQuestionOnlyBundle(question, settings),
          reason: 'error',
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    const timeout = new Promise<ExtractionResult>((resolve) => {
      const handle = setTimeout(
        () => resolve({ bundle: buildQuestionOnlyBundle(question, settings), reason: 'timeout' }),
        timeoutMs,
      )
      signal.addEventListener('abort', () => {
        clearTimeout(handle)
        resolve({ bundle: null, reason: 'aborted' })
      }, { once: true })
    })

    return Promise.race([work(), timeout])
  }

  /** Cache statistics, surfaced in the context-details panel. */
  stats(): { size: number; hits: number; misses: number } {
    const stats = this.projections.stats()
    return { size: stats.size, hits: stats.hits, misses: stats.misses }
  }

  release(): void {
    if (this.unsubscribe !== null) {
      try {
        this.unsubscribe()
      } catch {
        // The feed may already be gone.
      }
      this.unsubscribe = null
    }
    // Only release what WE retained: an adopted binding belongs to the probe's
    // session scope and must not be released from here.
    if (this.reference !== null) {
      try {
        this.reference.release()
      } catch {
        // Already released by the session scope.
      }
      this.reference = null
    }
    this.binding = null
    this.sessionId = null
    this.summarySessionId = null
    this.summaries.clear()
    this.entries = null
    this.lastRevision = -1
  }
}
