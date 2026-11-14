/**
 * Client-side orchestration store.
 *
 * One small observable object owns every piece of UI state (window, thread,
 * streaming answer, context) and every action the UI can trigger. React reads it
 * through `useSyncExternalStore`; there is no other state container, so what you
 * see is exactly one snapshot.
 *
 * Multi-tab note: the store is per-page. Threads are re-read from the host after
 * each turn, so a second tab converges on the next interaction instead of
 * holding a stale local copy.
 */

import type {
  AskEvent,
  BootstrapResponse,
  ContextBundle,
  SideAskConfig,
  SideAskError,
  SideAskSettings,
  Thread,
  ThreadListEntry,
  ThreadMessage,
} from '../shared/contract.js'
import { makeError } from '../shared/errors.js'
import type { ContextSource, ExtractionResult, SelectionNote } from './context-source.js'
import type { HostApi } from './host-api.js'
import { initialAnswer, reduceAnswer, type AnswerState } from './stream.js'
import type { ConversationService } from './types.js'

export interface Toast {
  kind: 'info' | 'ok' | 'error'
  text: string
  at: number
}

export interface UiState {
  open: boolean
  bootstrap: BootstrapResponse | null
  bootstrapError: SideAskError | null
  settings: SideAskSettings
  customPatterns: string[]
  /** Include main-chat context on the next turn. */
  contextOn: boolean
  threads: ThreadListEntry[]
  thread: Thread | null
  /** Optimistic user message + request id for the in-flight turn. */
  pending: { requestId: string; userText: string } | null
  answer: AnswerState
  extracting: boolean
  extractionReason: ExtractionResult['reason'] | null
  contextDetails: ContextBundle | null
  selection: SelectionNote | null
  sessionId: string | null
  sessionTitle: string | null
  lastQuestion: string
  threadBusy: boolean
  toast: Toast | null
}

export interface StoreDeps {
  api: HostApi
  contextSource: ContextSource
  conversation: ConversationService | undefined
}

const FALLBACK_SETTINGS: SideAskSettings = {
  recentMessageLimit: 12,
  autoSummary: true,
  contextBudgetTokens: 3000,
  readContext: true,
  redactSensitive: true,
  persistHistory: true,
  defaultCorner: 'top-right',
  hotkey: 'Alt+Shift+A',
  provider: '',
  model: '',
}

function initialState(): UiState {
  return {
    open: false,
    bootstrap: null,
    bootstrapError: null,
    settings: FALLBACK_SETTINGS,
    customPatterns: [],
    contextOn: true,
    threads: [],
    thread: null,
    pending: null,
    answer: initialAnswer(),
    extracting: false,
    extractionReason: null,
    contextDetails: null,
    selection: null,
    sessionId: null,
    sessionTitle: null,
    lastQuestion: '',
    threadBusy: false,
    toast: null,
  }
}

export class SideAskStore {
  private state: UiState = initialState()
  private readonly listeners = new Set<() => void>()
  private inflight: AbortController | null = null
  private initialised = false

  constructor(private readonly deps: StoreDeps) {}

  // ------------------------------------------------------------ substrate

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): UiState => this.state

  private set(patch: Partial<UiState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A rendering error must not break the store for other listeners.
      }
    }
  }

  toast(kind: Toast['kind'], text: string): void {
    this.set({ toast: { kind, text, at: Date.now() } })
    const at = Date.now()
    setTimeout(() => {
      if (this.state.toast !== null && this.state.toast.at === at) this.set({ toast: null })
    }, 3200)
  }

  // ------------------------------------------------------------- lifecycle

  async init(): Promise<void> {
    if (this.initialised) return
    this.initialised = true
    try {
      const bootstrap = await this.deps.api.bootstrap()
      const settings = { ...FALLBACK_SETTINGS, ...(bootstrap.settings as Partial<SideAskConfig>) }
      this.set({
        bootstrap,
        bootstrapError: null,
        settings,
        customPatterns: Array.isArray((bootstrap.settings as SideAskConfig).customRedactionPatterns)
          ? (bootstrap.settings as SideAskConfig).customRedactionPatterns
          : [],
      })
      if (bootstrap.unavailable !== null) this.set({ bootstrapError: bootstrap.unavailable })
      await this.refreshThreads()
    } catch (error) {
      this.set({
        bootstrapError: makeError('INTERNAL', error instanceof Error ? error.message : String(error)),
      })
    }
  }

  async refreshThreads(): Promise<void> {
    try {
      const threads = await this.deps.api.listThreads()
      this.set({ threads })
    } catch {
      // Listing is cosmetic; keep the previous list.
    }
  }

  // ---------------------------------------------------------------- window

  setOpen(open: boolean): void {
    this.set({ open })
    if (open) void this.init()
  }

  toggleOpen(): void {
    this.setOpen(!this.state.open)
  }

  // --------------------------------------------------------------- session

  /** Called by the session probe (or the selection interaction). */
  async setSession(sessionId: string, title?: string): Promise<void> {
    if (this.state.sessionId === sessionId) {
      if (title !== undefined) this.set({ sessionTitle: title })
      return
    }
    this.set({ sessionId, sessionTitle: title ?? this.state.sessionTitle, thread: null, pending: null, answer: initialAnswer() })
    if (sessionId.length > 0) await this.deps.contextSource.bind(sessionId)
  }

  setSelection(note: SelectionNote | null): void {
    this.deps.contextSource.setSelection(note)
    this.set({ selection: note })
    if (note !== null) this.setOpen(true)
  }

  // ---------------------------------------------------------------- context

  setContextOn(contextOn: boolean): void {
    this.set({ contextOn })
  }

  // ---------------------------------------------------------------- threads

  async newThread(): Promise<void> {
    if (this.state.threadBusy) return
    this.set({ threadBusy: true })
    try {
      const thread = await this.deps.api.createThread(this.state.sessionId)
      this.set({ thread, pending: null, answer: initialAnswer(), contextDetails: null })
      await this.refreshThreads()
    } catch (error) {
      this.toast('error', error instanceof Error ? error.message : '新建会话失败')
    } finally {
      this.set({ threadBusy: false })
    }
  }

  async selectThread(id: string): Promise<void> {
    if (this.state.threadBusy) return
    this.set({ threadBusy: true })
    try {
      const thread = await this.deps.api.getThread(id)
      this.set({ thread, pending: null, answer: initialAnswer() })
    } catch (error) {
      this.toast('error', error instanceof Error ? error.message : '加载会话失败')
    } finally {
      this.set({ threadBusy: false })
    }
  }

  async clearAllHistory(): Promise<void> {
    try {
      const cleared = await this.deps.api.clearThreads()
      this.set({ thread: null, threads: [], pending: null, answer: initialAnswer() })
      this.toast('ok', `已清空 ${cleared} 个旁问线程`)
    } catch (error) {
      this.toast('error', error instanceof Error ? error.message : '清空失败')
    }
  }

  // ------------------------------------------------------------------- ask

  stop(): void {
    const controller = this.inflight
    const requestId = this.state.answer.requestId
    if (controller !== null) controller.abort()
    if (requestId !== null) void this.deps.api.cancel(requestId)
  }

  async send(question: string): Promise<void> {
    const text = question.trim()
    if (text.length === 0) return
    if (this.state.answer.status === 'streaming') return

    const state = this.state
    const requestId = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    const controller = new AbortController()
    this.inflight = controller

    // 1) Context (async, cancellable, never blocks the send for long).
    let bundle: ContextBundle | null = null
    if (state.contextOn) {
      this.set({ extracting: true, lastQuestion: text })
      const result = await this.deps.contextSource.build(
        text,
        state.settings,
        controller.signal,
        state.customPatterns,
      )
      this.set({ extracting: false, extractionReason: result.reason, contextDetails: result.bundle })
      if (result.reason === 'aborted') {
        this.inflight = null
        return
      }
      bundle = result.bundle
    } else {
      this.set({ lastQuestion: text, extractionReason: 'disabled', contextDetails: null })
    }

    // 2) The host thread must exist before the answer can be appended to it.
    let thread = state.thread
    if (thread === null) {
      try {
        thread = await this.deps.api.createThread(state.sessionId)
        this.set({ thread })
      } catch (error) {
        this.toast('error', error instanceof Error ? error.message : '创建会话失败')
        this.inflight = null
        return
      }
    }

    // 3) Ask: optimistic user bubble + streaming answer.
    this.set({
      pending: { requestId, userText: text },
      answer: { ...initialAnswer(), status: 'streaming', requestId, mode: bundle === null ? 'question-only' : 'context' },
    })

    try {
      // Reuse the main conversation's current model route. This is metadata, not
      // content, so it is sent even when context reading is off — otherwise a
      // global default on an uncredentialed route would break every question.
      const routeHint = this.deps.contextSource.routeHint()
      await this.deps.api.ask({
        request: {
          requestId,
          threadId: thread.id,
          question: text,
          context: bundle,
          ...(state.sessionId === null ? {} : { sessionId: state.sessionId }),
          ...(routeHint === null ? {} : { routeHint }),
        },
        signal: controller.signal,
        onEvent: (event: AskEvent) => this.handleEvent(event),
      })
    } catch (error) {
      this.set({
        answer: {
          ...this.state.answer,
          status: 'error',
          error: makeError('INTERNAL', error instanceof Error ? error.message : String(error)),
        },
      })
    } finally {
      this.inflight = null
      await this.finaliseTurn()
    }
  }

  private handleEvent(event: AskEvent): void {
    if (event.type === 'settings') {
      // The host is the source of truth for live settings.
      this.set({ settings: { ...this.state.settings, ...event.settings } })
      return
    }
    if (event.type === 'accepted') {
      this.set({ answer: reduceAnswer(this.state.answer, event) })
      return
    }
    this.set({ answer: reduceAnswer(this.state.answer, event) })
  }

  /** After a terminal event: reload the authoritative thread and clear the optimistic state. */
  private async finaliseTurn(): Promise<void> {
    const thread = this.state.thread
    try {
      if (thread !== null) {
        const fresh = await this.deps.api.getThread(thread.id)
        this.set({ thread: fresh })
      }
    } catch {
      // Keep the optimistic view; the next interaction will refresh it.
    }
    this.set({ pending: null, answer: { ...this.state.answer } })
    await this.refreshThreads()
  }

  /** Resend the last question (used by the Retry button). */
  async retry(): Promise<void> {
    const question = this.state.lastQuestion
    if (question.length === 0) return
    this.set({ answer: initialAnswer(), pending: null })
    await this.send(question)
  }

  /** Ask again but explicitly without context (the `degradableToQuestionOnly` path). */
  async retryWithoutContext(): Promise<void> {
    const question = this.state.lastQuestion
    if (question.length === 0) return
    this.set({ contextOn: false, answer: initialAnswer(), pending: null })
    await this.send(question)
  }

  /** Delete the current thread. */
  async deleteCurrentThread(): Promise<void> {
    const thread = this.state.thread
    if (thread === null) return
    try {
      await this.deps.api.deleteThread(thread.id)
      this.set({ thread: null, pending: null, answer: initialAnswer() })
      await this.refreshThreads()
    } catch (error) {
      this.toast('error', error instanceof Error ? error.message : '删除失败')
    }
  }

  dispose(): void {
    this.inflight?.abort()
    this.inflight = null
    this.listeners.clear()
  }
}

/** Messages the current thread shows, merging the authoritative list with the in-flight turn. */
export function visibleMessages(state: UiState): ThreadMessage[] {
  const base = state.thread?.messages ?? []
  const messages: ThreadMessage[] = [...base]
  const pending = state.pending
  if (pending !== null) {
    const alreadyStored = base.some((message) => message.role === 'user' && message.text === pending.userText)
    if (!alreadyStored) {
      messages.push({
        id: `local-${pending.requestId}`,
        role: 'user',
        text: pending.userText,
        createdAt: Date.now(),
      })
    }
    const answer = state.answer
    if (answer.status === 'streaming' || (answer.status === 'done' && answer.text.length > 0)) {
      messages.push({
        id: `stream-${pending.requestId}`,
        role: 'assistant',
        text: answer.text,
        createdAt: Date.now(),
        citations: answer.citations,
        error: answer.error,
        replyTo: `local-${pending.requestId}`,
      })
    }
  }
  return messages
}
