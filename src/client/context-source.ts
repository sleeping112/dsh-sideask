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

import type { ChatMessage, ContextBundle, ContextSelection, SideAskSettings } from '../shared/contract.js'
import { ProjectionCache, buildContext, buildQuestionOnlyBundle } from '../shared/context.js'
import type { SessionsService, SessionBinding } from './types.js'
import { entriesToMessages, lastRouteHint, projectIncrementally } from './transcript.js'

export interface ContextSourceOptions {
  sessions: SessionsService | undefined
  /** Hard ceiling for one extraction pass (default 1500 ms). */
  timeoutMs?: number
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

  constructor(private readonly options: ContextSourceOptions) {}

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
      this.binding = binding
      this.sessionId = sessionId
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
          redactOptions: { customPatterns },
          cache: this.projections,
        })
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
    this.binding = null
    this.sessionId = null
    this.entries = null
    this.lastRevision = -1
  }
}
