/**
 * Structural types for the browser-side runtime.
 *
 * WHY this file exists: the plugin bundle may only `require()` the platform's
 * frozen seed modules, and the host packages ship no client-side type
 * declarations. So instead of importing React's or the DSH client packages'
 * types (which would also pull dependencies into the bundle), this file
 * declares the narrow structural slices of React and of the DSH client
 * services we actually touch. The same source compiles with `types: []` and
 * stays bundle-local.
 */

import type { AskEvent, ContextBundle, SideAskSettings } from '../shared/contract.js'

/** The synchronous CJS resolver handed to a `__ModuleLoader__` factory. */
export type RequireFn = (id: string) => unknown

/** Anything React can render. Intentionally opaque: we never inspect it. */
export type ReactNode = unknown

export interface ReactHookRef<T> {
  current: T
}

/**
 * The subset of the React 18 API this plugin uses. Every member is exercised
 * by the UI; nothing here depends on JSX because the build has no JSX
 * transform configured and the bundle must remain a plain `.ts` build.
 */
export interface ReactApi {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): ReactNode
  Fragment: unknown
  useState<T>(initialState: T | (() => T)): [T, (update: T | ((previous: T) => T)) => void]
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  useMemo<T>(factory: () => T, deps?: readonly unknown[]): T
  useRef<T>(initialValue: T): ReactHookRef<T>
  useCallback<T>(callback: T, deps?: readonly unknown[]): T
  useSyncExternalStore<T>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => T,
  ): T
  memo(component: unknown): unknown
}

export interface ReactRoot {
  render(node: ReactNode): void
  unmount(): void
}

export interface ReactDomClientApi {
  createRoot(container: Element | DocumentFragment): ReactRoot
}

export interface ReactDomApi {
  createPortal(node: ReactNode, container: Element): ReactNode
}

/** What the DSH `shell.overlay` (root list) slot hands a contribution. */
export interface SlotOptions {
  name: string
  id?: string
  key?: string
  order?: number
  priority?: number
  label?: string | (() => string)
  locale?: string
  /** Optional resolver the Slot framework calls with the scope key. */
  inject?: unknown
  children?: unknown
}

export type SlotComponent = (props: Record<string, unknown>) => ReactNode

export interface SlotsService {
  inject(name: string, factory: () => unknown): () => void
  register(options: SlotOptions, component: SlotComponent): () => void
}

export interface LocaleSnapshot {
  active: string
}

export interface LocaleService {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  bind(namespace: string): (key: string, params?: Record<string, string | number>) => string
  getSnapshot(): LocaleSnapshot
}

/** One hotkey sequence as the shortcuts service models it. */
export interface ShortcutBinding {
  code: string
  modifiers: string[]
}

export interface ShortcutResolution {
  status: 'pass' | 'handled' | 'blocked'
  run?: () => void
}

export interface ShortcutCommand {
  id: string
  label: () => string
  aliases?: string[]
  defaults?: Record<string, ShortcutBinding>
  regions?: string[]
  resolve: (state: { modal: string | null }) => ShortcutResolution
}

export interface ShortcutsService {
  register(command: ShortcutCommand): () => void
}

/** The request object the conversation UI passes to a text interaction. */
export interface TextInteractionRequest {
  trigger: string
  sessionId: string
  hasSelection?: boolean
  /** Current selected text, already projected to visible characters. */
  readText: () => string | null
  open: () => void
  preventDefault: () => void
}

export interface InteractionDefinition {
  id: string
  onInteraction(request: TextInteractionRequest): void
}

export interface InteractionsService {
  register(definition: InteractionDefinition): () => void
}

export interface UiConversationService {
  interactions: InteractionsService
}

/** Composer actions exposed by `conversation.input.for(sessionCtx).actions`. */
export interface ComposerActions {
  insertQuote(text: string): boolean
  captureInsertion(): unknown
  insertText(text: string, span: unknown): boolean
  setDraft(text: string): void
  persistDraft?: () => void
}

export interface ComposerShell {
  actions: ComposerActions
}

export interface ConversationInput {
  for(sessionCtx: unknown): ComposerShell
}

export interface ConversationService {
  input: ConversationInput
}

// ---------------------------------------------------------- session feed

export interface SessionEntry {
  event: {
    type: string
    data?: unknown
    seq?: number
    time?: number
  }
}

export interface SessionFeedSnapshot {
  entries: readonly SessionEntry[]
  hasMore?: boolean
  revision?: number
  change?: unknown
}

export interface SessionEventSource {
  getSnapshot(): SessionFeedSnapshot
  subscribe(listener: () => void): () => void
}

export interface SessionBinding {
  sessionId: string
  eventSource: SessionEventSource
  /** Session-scoped context required by `conversation.input.for`. */
  ctx: unknown
  session?: unknown
}

export interface SessionReference {
  sessionId: string
  ready: Promise<SessionBinding>
  release(): void
}

export interface SessionListRow {
  id: string
  displayTitle?: string
  title?: string
  running?: boolean
  blank?: boolean
  updatedAt?: number
  origin?: string
  parentId?: string
  retainedBy?: { mainView?: number }
}

export interface SessionListSnapshot {
  ids: string[]
  byId: Record<string, SessionListRow>
  phase?: string
}

export interface SessionsService {
  binding(id: string): SessionBinding | undefined
  retain(id: string, options: { source: string; signal?: AbortSignal }): SessionReference
  list: {
    getSnapshot(): SessionListSnapshot
    subscribe(listener: () => void): () => void
  }
}

// ------------------------------------------------------------- plugin ctx

/** Cordis-flavoured slice of the plugin context the browser half receives. */
export interface PluginContext {
  effect(setup: () => void | (() => void), label?: string): unknown
  get(name: string, strict?: boolean): unknown
  on(event: string, listener: (payload: unknown) => void): () => void
}

export interface ClientServices {
  slots: SlotsService | undefined
  locale: LocaleService | undefined
  shortcuts: ShortcutsService | undefined
  sessions: SessionsService | undefined
  uiConversation: UiConversationService | undefined
  conversation: ConversationService | undefined
}

/** Host API surface implemented by the plugin's server half. */
export interface AskHandlers {
  onEvent(event: AskEvent): void
}

/** Side-ask settings resolved for one ask, kept together for readability. */
export interface EffectiveSettings {
  settings: SideAskSettings
  contextBundle: ContextBundle | null
}
