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
  ChatMessage,
  ContextBundle,
  ContextItem,
  ProviderModels,
  SideAskConfig,
  SideAskError,
  SideAskSettings,
  Thread,
  ThreadListEntry,
  ThreadMessage,
} from '../shared/contract.js'
import type { PinnedInput } from '../shared/context.js'
import { makeError } from '../shared/errors.js'
import type { ContextSource, ExtractionResult, SelectionNote } from './context-source.js'
import {
  DRAFT_STORAGE_KEY,
  getDraft,
  loadDrafts,
  saveDrafts,
  setDraft as mapSetDraft,
  type DraftMap,
} from './draft.js'
import type { HostApi } from './host-api.js'
import { initialAnswer, reduceAnswer, type AnswerState } from './stream.js'
import type { ConversationService } from './types.js'
import { buildHandoffText, writeBack } from './writeback.js'

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
  /** Per-thread composer drafts (UI only, never sent to the host until ask). */
  drafts: DraftMap
  /** Explicitly pinned main-conversation messages (`#` references). */
  pins: PinnedInput[]
  /** Context items the user unchecked for the next ask (by message id). */
  excludedMessageIds: string[]
  /** Model chosen in the window; null = follow the main conversation. */
  modelOverride: { provider: string; model: string } | null
  /** Lazily loaded provider/model catalog for the picker. */
  modelCatalog: ProviderModels[] | null
  modelCatalogError: string | null
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
  pillOffset: 40,
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
    drafts: {},
    pins: [],
    excludedMessageIds: [],
    modelOverride: null,
    modelCatalog: null,
    modelCatalogError: null,
    toast: null,
  }
}

/** Persisted model override (UI preference; never written to the host config). */
const MODEL_STORAGE_KEY = 'dsh-sideask.model.v1'

export class SideAskStore {
  private state: UiState = initialState()
  private readonly listeners = new Set<() => void>()
  private inflight: AbortController | null = null
  private initialised = false
  private initialising = false

  constructor(private readonly deps: StoreDeps) {
    // Drafts are UI-only state: restore them so switching threads (or reloading
    // the page) never loses what the user was typing.
    try {
      this.state = { ...this.state, drafts: loadDrafts(window.localStorage.getItem(DRAFT_STORAGE_KEY)) }
    } catch {
      // Private mode / storage disabled: drafts stay in memory for this session.
    }
    try {
      const raw = window.localStorage.getItem(MODEL_STORAGE_KEY)
      if (raw !== null && raw.length > 0) {
        const parsed = JSON.parse(raw) as { provider?: unknown; model?: unknown }
        if (typeof parsed.provider === 'string' && typeof parsed.model === 'string' && parsed.provider.length > 0 && parsed.model.length > 0) {
          this.state = { ...this.state, modelOverride: { provider: parsed.provider, model: parsed.model } }
        }
      }
    } catch {
      // Corrupt or unavailable storage: follow the main conversation model.
    }
  }

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
    // Retry allowed while no successful bootstrap is cached: the overlay mounts
    // before the host is necessarily ready, and the first attempt can fail.
    if (this.initialising) return
    if (this.initialised && this.state.bootstrap !== null) return
    this.initialising = true
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
    } finally {
      this.initialising = false
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

  // ---------------------------------------------------------------- drafts

  /** Current thread's composer draft ('' when none). */
  draftForCurrentThread(): string {
    return getDraft(this.state.drafts, this.state.thread?.id ?? null)
  }

  /** Update the current thread's draft and persist the draft map. */
  setComposerDraft(text: string): void {
    const drafts = mapSetDraft(this.state.drafts, this.state.thread?.id ?? null, text)
    this.set({ drafts })
    try {
      window.localStorage.setItem(DRAFT_STORAGE_KEY, saveDrafts(drafts))
    } catch {
      // Storage unavailable: keep the in-memory draft.
    }
  }

  /** Drop a thread's draft (after sending, or when the thread is deleted). */
  private dropDraft(threadId: string | null | undefined): void {
    const drafts = mapSetDraft(this.state.drafts, threadId ?? null, '')
    this.set({ drafts })
    try {
      window.localStorage.setItem(DRAFT_STORAGE_KEY, saveDrafts(drafts))
    } catch {
      // Ignore.
    }
  }

  // ------------------------------------------------- pins, exclusions, models

  /** Newest main-conversation messages, for the `#` pin picker. */
  mainMessages(limit = 20): ChatMessage[] {
    return this.deps.contextSource.recentMessages(limit)
  }

  /** Other sessions available for read-only `#Past Chats` references. */
  pastSessions(): Array<{ id: string; title: string }> {
    return this.deps.contextSource.otherSessions()
  }

  /** Read one past session's visible messages (null when unavailable). */
  async loadPastSession(sessionId: string): Promise<ChatMessage[] | null> {
    return this.deps.contextSource.readSessionMessages(sessionId, 20)
  }

  isPinned(messageId: string): boolean {
    return this.state.pins.some((pin) => pin.messageId === messageId)
  }

  /** Pin/unpin one main-conversation message (`#` reference). */
  togglePin(message: Pick<ChatMessage, 'id' | 'role' | 'text'>): void {
    const exists = this.state.pins.some((pin) => pin.messageId === message.id)
    const pins = exists
      ? this.state.pins.filter((pin) => pin.messageId !== message.id)
      : [...this.state.pins, { messageId: message.id, role: message.role, text: message.text }]
    this.set({ pins })
  }

  clearPins(): void {
    this.set({ pins: [] })
  }

  /** Exclude/include one already-extracted context item on the next ask. */
  toggleExclusion(messageId: string): void {
    const excluded = this.state.excludedMessageIds.includes(messageId)
      ? this.state.excludedMessageIds.filter((id) => id !== messageId)
      : [...this.state.excludedMessageIds, messageId]
    this.set({ excludedMessageIds: excluded })
  }

  clearExclusions(): void {
    this.set({ excludedMessageIds: [] })
  }

  /**
   * Extract context on demand (before sending) so the user can inspect and
   * remove items in the details panel.
   */
  async previewContext(): Promise<void> {
    if (this.state.extracting) return
    const state = this.state
    const question = this.draftForCurrentThread() || '（上下文预览）'
    const controller = new AbortController()
    this.set({ extracting: true })
    try {
      const result = await this.deps.contextSource.build(
        question,
        state.settings,
        controller.signal,
        state.customPatterns,
        state.pins,
      )
      this.set({ extractionReason: result.reason, contextDetails: result.bundle })
    } finally {
      this.set({ extracting: false })
    }
  }

  /** Lazily load the provider/model catalog for the model picker. */
  async loadModels(): Promise<void> {
    if (this.state.modelCatalog !== null) return
    try {
      const providers = await this.deps.api.listModels()
      this.set({ modelCatalog: providers, modelCatalogError: null })
    } catch (error) {
      this.set({
        modelCatalog: [],
        modelCatalogError: error instanceof Error ? error.message : '模型列表读取失败',
      })
    }
  }

  /** null = follow the main conversation's model (the default). */
  setModelOverride(provider: string | null, model?: string): void {
    if (provider === null || model === undefined || provider.length === 0 || model.length === 0) {
      this.set({ modelOverride: null })
      try {
        window.localStorage.removeItem(MODEL_STORAGE_KEY)
      } catch {
        // Ignore.
      }
      return
    }
    const modelOverride = { provider, model }
    this.set({ modelOverride })
    try {
      window.localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(modelOverride))
    } catch {
      // Ignore.
    }
  }

  /**
   * Regenerate an answer: truncate it (and anything after it) on the host, then
   * ask the same question again. Only the last answer can be regenerated —
   * removing later turns without asking would be surprising.
   */
  async regenerate(message: ThreadMessage): Promise<void> {
    const state = this.state
    const thread = state.thread
    if (thread === null) return
    if (state.answer.status === 'streaming' || state.threadBusy) return
    const messages = thread.messages
    let lastAssistant: ThreadMessage | null = null
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === 'assistant') {
        lastAssistant = messages[index] ?? null
        break
      }
    }
    if (lastAssistant === null || lastAssistant.id !== message.id) {
      this.toast('info', '只能重新生成最后一条回答（删除中间轮次会丢失后续对话）')
      return
    }
    const replyTo = message.replyTo
    const userMessage =
      replyTo === undefined
        ? null
        : messages.find((candidate) => candidate.id === replyTo) ?? null
    const question = userMessage?.text ?? ''
    if (question.length === 0) {
      this.toast('error', '找不到对应的用户问题，无法重新生成')
      return
    }
    const cutoff = replyTo ?? message.id
    this.set({ threadBusy: true })
    try {
      await this.deps.api.truncateThread(thread.id, cutoff)
      const fresh = await this.deps.api.getThread(thread.id)
      this.set({ thread: fresh, pending: null, answer: initialAnswer() })
      await this.refreshThreads()
    } catch (error) {
      this.toast('error', error instanceof Error ? error.message : '重新生成失败')
      return
    } finally {
      this.set({ threadBusy: false })
    }
    await this.send(question)
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
    // The question left the composer: its draft is no longer needed.
    this.dropDraft(state.thread?.id ?? null)

    // 1) Context (async, cancellable, never blocks the send for long).
    let bundle: ContextBundle | null = null
    if (state.contextOn) {
      this.set({ extracting: true, lastQuestion: text })
      const result = await this.deps.contextSource.build(
        text,
        state.settings,
        controller.signal,
        state.customPatterns,
        state.pins,
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
      // Reuse the main conversation's current model route unless the user picked
      // one in the window. This is metadata, not content, so it is sent even when
      // context reading is off — otherwise a global default on an uncredentialed
      // route would break every question.
      const routeHint = this.state.modelOverride ?? this.deps.contextSource.routeHint()
      await this.deps.api.ask({
        request: {
          requestId,
          threadId: thread.id,
          question: text,
          context: this.applyExclusions(bundle),
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

  /**
   * Drop the context items the user unchecked before sending. Kept separate from
   * extraction so the details panel can still show everything that was read.
   */
  private applyExclusions(bundle: ContextBundle | null): ContextBundle | null {
    if (bundle === null) return null
    const excluded = new Set(this.state.excludedMessageIds)
    if (excluded.size === 0) return bundle
    const items: ContextItem[] = bundle.items.filter((item) => !excluded.has(item.messageId))
    if (items.length === bundle.items.length) return bundle
    const usedTokens = items.reduce((sum, item) => sum + item.tokens, 0) + bundle.stats.summaryTokens
    const selection = bundle.selection !== null && excluded.has(items.find((item) => item.source === 'selection')?.messageId ?? '') ? null : bundle.selection
    return {
      ...bundle,
      items,
      selection,
      stats: { ...bundle.stats, usedTokens },
    }
  }

  private handleEvent(event: AskEvent): void {
    if (event.type === 'settings') {
      // The host is the source of truth for live settings.
      this.set({ settings: { ...this.state.settings, ...event.settings } })
      return
    }
    if (event.type === 'accepted') {
      // The explicit pins/exclusions applied to this turn are consumed.
      this.set({ pins: [], excludedMessageIds: [], answer: reduceAnswer(this.state.answer, event) })
      // Opportunistically compress messages that just fell out of the recent
      // window, so the NEXT question already has the summary.
      void this.deps.contextSource.refreshSummary()
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

  /**
   * Copy this thread's prefix (up to and including `messageId`) into a new
   * thread and switch to it. Used by the "分叉" action on an answer.
   */
  async forkThread(messageId: string): Promise<void> {
    const thread = this.state.thread
    if (thread === null || this.state.threadBusy || this.state.answer.status === 'streaming') return
    this.set({ threadBusy: true })
    try {
      const forked = await this.deps.api.forkThread(thread.id, messageId)
      this.set({ thread: forked, pending: null, answer: initialAnswer(), contextDetails: null })
      await this.refreshThreads()
      this.toast('ok', '已从这条回答分叉出新线程')
    } catch (error) {
      this.toast('error', error instanceof Error ? error.message : '分叉失败')
    } finally {
      this.set({ threadBusy: false })
    }
  }

  /**
   * Hand an answer to the main conversation as an explicit task. Writes the main
   * composer draft (never sends): the user stays in control of the main chat.
   */
  async handoff(text: string): Promise<void> {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    const confirmed =
      typeof window === 'undefined' || typeof window.confirm !== 'function'
        ? true
        : window.confirm('把这条结论交给主对话？会写入主对话输入框（不会自动发送）。')
    if (!confirmed) return
    const result = await writeBack('draft', buildHandoffText(trimmed), {
      conversation: this.deps.conversation,
      getSessionCtx: () => this.deps.contextSource.sessionCtx,
      confirmDraft: false,
    })
    if (result.ok) this.toast('ok', '已写入主对话输入框，确认后发送即可')
    else this.toast('error', result.note ?? '交给主对话失败')
  }

  /** Delete the current thread. */
  async deleteCurrentThread(): Promise<void> {
    const thread = this.state.thread
    if (thread === null) return
    try {
      await this.deps.api.deleteThread(thread.id)
      this.set({ thread: null, pending: null, answer: initialAnswer() })
      this.dropDraft(thread.id)
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
