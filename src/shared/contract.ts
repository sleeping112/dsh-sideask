/**
 * Wire contract shared by the host half (`src/host`) and the browser half
 * (`src/client`). Everything here is plain JSON-serialisable data with no
 * platform imports, so the same modules compile into the Node plugin entry
 * and into the browser bundle.
 *
 * Version note: `API_VERSION` is bumped whenever a field changes shape. The
 * client sends it on /ask; the host answers with `error code = 'API_MISMATCH'`
 * instead of failing softly, because a stale browser bundle must be visible in
 * the UI, not silently mis-parsed.
 */

export const API_VERSION = 1
export const PLUGIN_ID = 'dsh-sideask'
export const ROUTE_PREFIX = `/plugins/${PLUGIN_ID}/api`

// ---------------------------------------------------------------- transcript

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'developer'

/**
 * One visible chat message as the extractor sees it. This is a *projection*:
 * tool calls, reasoning traces, and attachments are flattened to the visible
 * text (or dropped), matching the "only read what the user can see" rule.
 */
export interface ChatMessage {
  /** Host-stable message identity; used for incrementality and citations. */
  id: string
  role: MessageRole
  /** Visible plain text projection. Never contains hidden reasoning. */
  text: string
  /** Epoch millis when the host recorded the message, when known. */
  createdAt?: number
  /** Set for `role: 'tool'` so the prompt can label the producer. */
  toolName?: string
  /** True when the projection itself elided content (e.g. a huge tool output). */
  truncated?: boolean
}

/**
 * A read-only view of the main conversation. The client produces it from the
 * live conversation store; `revision` grows monotonically so a re-read can be
 * proven identical (and skipped) without diffing every message.
 */
export interface TranscriptSnapshot {
  sessionId: string
  revision: number
  /** Oldest-first, visible messages only. */
  messages: ChatMessage[]
}

// ------------------------------------------------------------------- context

export type ContextSource = 'selection' | 'recent' | 'summary'

/** One budgeted unit handed to the model under a stable short reference. */
export interface ContextItem {
  /** Short reference used in the prompt and in citations: `c1`, `c2`, ... */
  ref: string
  messageId: string
  role: MessageRole
  text: string
  tokens: number
  /** True when the item text was elided to fit the budget. */
  truncated: boolean
  source: ContextSource
}

export interface ContextStats {
  budgetTokens: number
  questionTokens: number
  selectionTokens: number
  recentTokens: number
  summaryTokens: number
  usedTokens: number
  /** Messages considered and rejected before budgeting (recent-limit, dedupe). */
  consideredCount: number
  dedupedCount: number
  redactedCount: number
  /** Truncations applied, by layer. */
  truncations: { selection: number; recent: number; summary: number }
  /**
   * Ordered record of degradations actually applied, e.g.
   * `['summary-dropped', 'recent-trimmed', 'question-only']`.
   */
  degradations: string[]
}

export interface ContextSelection {
  text: string
  /** Message the selection came from, when the client can attribute it. */
  messageId?: string
}

export interface ContextBundle {
  items: ContextItem[]
  summary: string | null
  selection: ContextSelection | null
  stats: ContextStats
}

// ------------------------------------------------------------------ settings

/**
 * Client-relevant configuration. Mirrors a subset of the host Config schema:
 * the host is the source of truth and the client caches this projection.
 */
export interface SideAskSettings {
  /** How many recent messages may enter the budget window. */
  recentMessageLimit: number
  /** Enable the optional rolling summary layer. */
  autoSummary: boolean
  /** Hard ceiling for the whole context block, in tokens. */
  contextBudgetTokens: number
  /** Read the main conversation at all. `false` ⇒ question-only answers. */
  readContext: boolean
  /** Mask secrets/emails/keys before they leave the browser. */
  redactSensitive: boolean
  /** Persist threads locally so they survive a reload. */
  persistHistory: boolean
  /** Default docking corner for the floating window. */
  defaultCorner: DockCorner
  /**
   * Vertical offset (px) of the entrance pill from the top edge. Keeps the pill
   * clear of the window/title row; horizontal offset is fixed at 18px.
   */
  pillOffset: number
  /** Global shortcut that toggles the window, e.g. `Alt+Shift+A`. */
  hotkey: string
  /** Provider/model override; empty strings mean "host default". */
  provider: string
  model: string
}

export type DockCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export interface SideAskConfig extends SideAskSettings {
  /** Max tokens the answer may use. */
  answerMaxTokens: number
  /** Include a citation appendix in the prompt. */
  requireCitations: boolean
  /** Extra regexes whose matches are masked. */
  customRedactionPatterns: string[]
}

// ------------------------------------------------------------------ requests

export interface AskRequest {
  apiVersion: number
  /** Client-generated id used to correlate stream frames and cancel calls. */
  requestId: string
  threadId: string
  question: string
  context: ContextBundle | null
  /** Main session this question was asked beside; advisory thread metadata. */
  sessionId?: string
  /**
   * Provider/model the main conversation is currently using, extracted from the
   * last assistant message. Routing metadata only (no conversation content).
   * The host prefers it over the global default so a side question is answered
   * by the same model the user is already talking to.
   */
  routeHint?: { provider: string; model: string }
  settings?: Partial<SideAskSettings>
}

export type AskEvent =
  | { type: 'accepted'; requestId: string; mode: 'context' | 'question-only' }
  | { type: 'delta'; requestId: string; text: string }
  | { type: 'settings'; requestId: string; settings: SideAskSettings }
  | { type: 'usage'; requestId: string; promptTokens: number; completionTokens: number }
  | { type: 'done'; requestId: string; messageId: string; text: string; citations: Citation[] }
  | { type: 'error'; requestId: string; error: SideAskError }

export interface Citation {
  ref: string
  messageId: string
  role: MessageRole
  /** Short excerpt of the cited text, for the citation chip tooltip. */
  excerpt: string
}

export type SideAskErrorCode =
  | 'API_MISMATCH'
  | 'BAD_REQUEST'
  | 'CONTEXT_DISABLED'
  | 'NO_ADAPTER'
  | 'MISSING_CREDENTIAL'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'QUOTA'
  | 'CONTEXT_WINDOW_EXCEEDED'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'INTERNAL'

export interface SideAskError {
  code: SideAskErrorCode
  message: string
  /** Whether offering a retry button makes sense. */
  retryable: boolean
  /** True when the same question can still be answered without context. */
  degradableToQuestionOnly: boolean
}

// ------------------------------------------------------------------- threads

export interface ThreadMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  /** Context statistics captured when the question was asked. */
  context?: ContextStats | null
  /** Citations returned for an assistant answer. */
  citations?: Citation[]
  /** Set when this message is a failed attempt that can be retried. */
  error?: SideAskError | null
  /** The question this answer belongs to, for retry. */
  replyTo?: string
}

export interface Thread {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** Session the thread was opened beside; survives navigation but is advisory. */
  sessionId: string | null
  messages: ThreadMessage[]
}

export interface ThreadListEntry {
  id: string
  title: string
  updatedAt: number
  messageCount: number
}

// ------------------------------------------------------- summary & fork (v0.4)

/**
 * One main-conversation message handed to the summariser. Already redacted by
 * the client; the host re-sanitises and caps it.
 */
export interface SummarizeMessage {
  id: string
  role: MessageRole
  text: string
}

/** Ask the host to compress messages that fell outside the recent window. */
export interface SummarizeRequest {
  apiVersion: number
  requestId: string
  messages: SummarizeMessage[]
  /** Soft target for the summary length (characters). */
  maxChars?: number
  /** Same routing metadata semantics as AskRequest.routeHint. */
  routeHint?: { provider: string; model: string }
}

export interface SummarizeResponse {
  apiVersion: number
  summary: string
  /** True when the model output was cut at the length cap. */
  truncated: boolean
}

/** Fork the side thread from one message (inclusive). */
export interface ForkResponse {
  apiVersion: number
  thread: Thread
}

export interface BootstrapResponse {
  apiVersion: number
  settings: SideAskConfig
  /** Resolved provider/model actually used for calls. */
  model: { provider: string; model: string } | null
  /** Provider routes the host can see, for diagnostics/settings. */
  providers: string[]
  /** Present when the host cannot call a model at all. */
  unavailable: SideAskError | null
}

// -------------------------------------------------------------------- models

/**
 * One provider's selectable models for the in-window picker.
 *
 * This lives on its own lazy route (`GET /api/models`) instead of in
 * `BootstrapResponse` because the host's `ctx.llm.listModels(provider)` is
 * asynchronous and can be slow or unavailable; bootstrap must stay synchronous
 * and cheap so opening the window never waits on provider catalogues.
 */
export interface ProviderModels {
  provider: string
  /** Model ids the picker may offer, in adapter-preferred order. */
  models: Array<{ id: string; name: string }>
}

export interface ModelsResponse {
  apiVersion: number
  providers: ProviderModels[]
}
