/**
 * Host runtime: the orchestration layer behind `/plugins/dsh-sideask/api`.
 *
 * Responsibilities, in order of importance:
 * 1. **Never touch the main conversation.** This file has no import of any
 *    session or agent service: it reads a client-supplied snapshot, calls the
 *    model once, and appends only to the plugin's own thread store.
 * 2. Enforce the privacy gate (`readContext`) and independently re-sanitise
 *    whatever the browser sent, because the browser is not a trust boundary.
 * 3. Stream the answer to the browser as contract events, with cancellation
 *    and a wall-clock timeout on every call.
 */

import type {
  AskEvent,
  AskRequest,
  BootstrapResponse,
  ContextBundle,
  ContextItem,
  Citation,
  ModelsResponse,
  SideAskError,
  SummarizeMessage,
  SummarizeRequest,
  SummarizeResponse,
  Thread,
  ThreadMessage,
  ThreadListEntry,
} from '../shared/contract.js'
import { API_VERSION } from '../shared/contract.js'
import { finaliseAnswer } from '../shared/citations.js'
import { makeError } from '../shared/errors.js'
import { buildPrompt } from '../shared/prompt.js'
import { redact } from '../shared/redact.js'
import {
  SUMMARY_MAX_INPUT_CHARS,
  SUMMARY_MAX_MESSAGES,
  buildSummaryInstruction,
  clampSummaryMessages,
  DEFAULT_SUMMARY_MAX_CHARS,
} from '../shared/summarize.js'
import { MESSAGE_OVERHEAD_TOKENS, estimateTokens } from '../shared/tokens.js'
import { readConfig, toSettings, type HostConfig } from './config.js'
import {
  callModel,
  candidateRoutes,
  describeModels,
  listProviderIds,
  type CallResult,
  type DefaultModelService,
  type LlmService,
  type RouteHint,
} from './llm.js'
import { ThreadStore, resolveDshHome, threadsFilePath } from './store.js'

/** The slice of the cordis context this plugin actually uses. */
export interface HostContext {
  get(name: string): unknown
  effect?(callback: () => (() => void) | void, label?: string): unknown
  inject?(names: string[], callback: (ctx: HostContext) => void): unknown
  provide?(name: string, value: unknown): unknown
}

const MAX_QUESTION_CHARS = 8000
const MAX_ITEM_TEXT_CHARS = 12000
const MAX_SUMMARY_CHARS = 8000
const MAX_SELECTION_CHARS = 8000
const MAX_ITEMS = 64
const ROLES = new Set(['user', 'assistant', 'system', 'tool', 'developer'])

/**
 * Summariser call parameters.
 *
 * A summary is a mechanical compression, not creative writing: a low temperature
 * keeps it deterministic, a 500-token cap cannot produce an essay, and the
 * 12 s wall clock bounds the client's "summarising…" indicator even when a
 * provider stalls (the /ask ceiling is config-driven and much longer).
 */
const SUMMARY_TEMPERATURE = 0.1
const SUMMARY_MAX_TOKENS = 500
const SUMMARY_TIMEOUT_MS = 12_000
/** At most one fallback, so a broken route cannot multiply the 12 s timeout. */
const SUMMARY_MAX_ATTEMPTS = 2
/** Output-length clamp for the contract's soft `maxChars` target. */
const SUMMARY_MIN_OUTPUT_CHARS = 120
const SUMMARY_MAX_OUTPUT_CHARS = 2000
/** Only these roles carry a main-conversation exchange worth compressing. */
const SUMMARY_ROLES = new Set(['user', 'assistant'])

/**
 * Terminal failure of {@link SideAskRuntime.summarize}.
 *
 * `/ask` reports failures as SSE events; `/summarize` is a plain JSON route and
 * has no event channel, so the contract error travels as an exception and the
 * HTTP layer maps it to 502. Anything else escaping `summarize` is a bug and is
 * surfaced as 500.
 */
export class SummaryLlmError extends Error {
  constructor(readonly error: SideAskError) {
    super(error.message)
    this.name = 'SummaryLlmError'
  }
}

/** Minimal async producer/consumer bridge used to stream model deltas. */
class AsyncQueue<T> {
  private readonly items: T[] = []
  private readonly waiting: ((value: IteratorResult<T>) => void)[] = []
  private closed = false
  private failure: unknown = null

  push(item: T): void {
    if (this.closed) return
    const waiter = this.waiting.shift()
    if (waiter !== undefined) waiter({ value: item, done: false })
    else this.items.push(item)
  }

  fail(error: unknown): void {
    this.failure = error
    this.close()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift()
      if (waiter !== undefined) waiter({ value: undefined as never, done: true })
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const item = this.items.shift()
      if (item !== undefined) {
        yield item
        continue
      }
      if (this.failure !== null) throw this.failure
      if (this.closed) return
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiting.push(resolve)
      })
      if (next.done) {
        if (this.failure !== null) throw this.failure
        return
      }
      yield next.value
    }
  }
}

function newMessageId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// --------------------------------------------------------------- sanitising

function asString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  if (value.length === 0) return ''
  return value.length > max ? value.slice(0, max) : value
}

function asError(value: unknown): SideAskError | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const code = record['code']
  const message = record['message']
  if (typeof code !== 'string' || typeof message !== 'string') return null
  return makeError(
    code as SideAskError['code'],
    message.slice(0, 500),
    {
      retryable: record['retryable'] === true,
      degradableToQuestionOnly: record['degradableToQuestionOnly'] === true,
    },
  )
}

/**
 * Re-validate a browser-supplied context bundle.
 *
 * The browser is a convenience, not an authority: caps, roles, refs, and the
 * token accounting are all recomputed here, and sensitive spans are masked a
 * second time (idempotent by construction). Anything that fails validation is
 * dropped rather than trusted.
 */
export function sanitizeBundle(raw: unknown, config: HostConfig): ContextBundle | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const rawItems = Array.isArray(record['items']) ? record['items'] : []
  const redactOptions = {
    customPatterns: config.redactSensitive ? config.customRedactionPatterns : [],
    homeDir: resolveDshHome(),
    username: process.env['USERNAME'] ?? process.env['USER'] ?? '',
  }

  const items: ContextItem[] = []
  const seenRefs = new Set<string>()
  for (const candidate of rawItems.slice(0, MAX_ITEMS)) {
    if (candidate === null || typeof candidate !== 'object') continue
    const entry = candidate as Record<string, unknown>
    const messageId = asString(entry['messageId'], 200)
    const role = entry['role']
    const text = asString(entry['text'], MAX_ITEM_TEXT_CHARS)
    const source = entry['source']
    if (messageId === null || typeof role !== 'string' || !ROLES.has(role) || text === null) continue
    if (source !== 'selection' && source !== 'recent' && source !== 'summary') continue
    const ref = typeof entry['ref'] === 'string' && /^c\d{1,3}$/.test(entry['ref']) ? entry['ref'] : `c${items.length + 1}`
    if (seenRefs.has(ref)) continue
    seenRefs.add(ref)
    const masked = config.redactSensitive ? redact(text, redactOptions) : { text, total: 0 }
    items.push({
      ref,
      messageId,
      role: role as ContextItem['role'],
      text: masked.text,
      tokens: estimateTokens(masked.text) + MESSAGE_OVERHEAD_TOKENS,
      truncated: entry['truncated'] === true,
      source,
    })
  }

  const summaryRaw = asString(record['summary'], MAX_SUMMARY_CHARS)
  const summary = summaryRaw === null || summaryRaw.trim().length === 0
    ? null
    : config.redactSensitive
      ? redact(summaryRaw, redactOptions).text
      : summaryRaw

  let selection: ContextBundle['selection'] = null
  const selectionRaw = record['selection']
  if (selectionRaw !== null && typeof selectionRaw === 'object') {
    const entry = selectionRaw as Record<string, unknown>
    const text = asString(entry['text'], MAX_SELECTION_CHARS)
    if (text !== null && text.trim().length > 0) {
      const masked = config.redactSensitive ? redact(text, redactOptions).text : text
      const messageId = asString(entry['messageId'], 200)
      selection = messageId !== null && messageId.length > 0 ? { text: masked, messageId } : { text: masked }
    }
  }

  // Enforce the token ceiling by dropping the oldest non-selection items first.
  const budget = config.contextBudgetTokens
  let used = items.reduce((total, item) => total + item.tokens, 0) + (summary === null ? 0 : estimateTokens(summary))
  while (used > budget && items.length > 1) {
    const dropIndex = items.findIndex((item) => item.source !== 'selection')
    if (dropIndex === -1) break
    const [dropped] = items.splice(dropIndex, 1)
    used -= dropped?.tokens ?? 0
  }

  if (items.length === 0 && summary === null) return null

  const degradationsRaw = record['stats']
  const degradations: string[] = []
  if (degradationsRaw !== null && typeof degradationsRaw === 'object') {
    const list = (degradationsRaw as Record<string, unknown>)['degradations']
    if (Array.isArray(list)) {
      for (const entry of list.slice(0, 8)) {
        if (typeof entry === 'string' && entry.length <= 64) degradations.push(entry)
      }
    }
  }
  if (used > budget && !degradations.includes('over-budget-trimmed')) degradations.push('over-budget-trimmed')

  return {
    items,
    summary,
    selection,
    stats: {
      budgetTokens: budget,
      questionTokens: 0,
      selectionTokens: items.filter((item) => item.source === 'selection').reduce((sum, item) => sum + item.tokens, 0),
      recentTokens: items.filter((item) => item.source === 'recent').reduce((sum, item) => sum + item.tokens, 0),
      summaryTokens: summary === null ? 0 : estimateTokens(summary),
      usedTokens: used,
      consideredCount: rawItems.length,
      dedupedCount: 0,
      redactedCount: 0,
      truncations: { selection: 0, recent: 0, summary: 0 },
      degradations,
    },
  }
}

/** Validate a client-supplied route hint (routing metadata only). */
function readRouteHint(value: unknown): RouteHint | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const provider = asString(record['provider'], 200)
  const model = asString(record['model'], 200)
  if (provider === null || provider.length === 0) return null
  if (model === null || model.length === 0) return null
  return { provider, model }
}

/**
 * Re-validate the browser-supplied messages of a summarise request.
 *
 * Same rule as the context bundle: the browser is a convenience, not an
 * authority. Anything malformed (non-object entry, non-string id/text, a role
 * that cannot appear in a visible transcript) is dropped rather than guessed at,
 * so the model only ever sees well-formed numbered lines.
 */
function sanitizeSummaryMessages(raw: unknown): SummarizeMessage[] {
  if (!Array.isArray(raw)) return []
  const messages: SummarizeMessage[] = []
  for (const candidate of raw) {
    if (candidate === null || typeof candidate !== 'object') continue
    const record = candidate as Record<string, unknown>
    const id = asString(record['id'], 200)
    const text = asString(record['text'], SUMMARY_MAX_INPUT_CHARS)
    const role = record['role']
    if (id === null || id.length === 0 || text === null || text.trim().length === 0) continue
    if (typeof role !== 'string' || !SUMMARY_ROLES.has(role)) continue
    messages.push({ id, role: role as SummarizeMessage['role'], text })
  }
  // No count cap here: `clampSummaryMessages` caps to the NEWEST 40, and
  // truncating early would keep the oldest 40 of a long list instead. The body
  // size cap bounds how many entries can arrive at all.
  return messages
}

/**
 * Clamp the contract's soft `maxChars` target.
 *
 * `buildSummaryInstruction` already floors its own prompt at 120, but the host
 * also enforces the ceiling when slicing the answer, so the accepted range lives
 * here: [120, 2000], defaulting to `DEFAULT_SUMMARY_MAX_CHARS`. Non-numbers fall
 * back to the default instead of becoming `NaN` in arithmetic.
 */
function readSummaryMaxChars(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(numeric)) return DEFAULT_SUMMARY_MAX_CHARS
  return Math.min(SUMMARY_MAX_OUTPUT_CHARS, Math.max(SUMMARY_MIN_OUTPUT_CHARS, Math.trunc(numeric)))
}

/** The model input: one numbered line per message, compact and unambiguous. */
function summaryInput(messages: SummarizeMessage[]): string {
  return messages.map((message, index) => `${index + 1}. [${message.id}] ${message.role}: ${message.text}`).join('\n')
}

/**
 * Choose the failure to report when every candidate route failed.
 *
 * Reporting the LAST failure hides the actionable one: the first attempt usually
 * fails with `MISSING_CREDENTIAL` ("no API key for route X"), while a later
 * fallback may fail with a generic `PROVIDER_ERROR`. Prefer the most actionable
 * code, and say how many routes were tried.
 */
function pickFailure(failures: SideAskError[]): SideAskError | null {
  if (failures.length === 0) return null
  const actionable = failures.find(
    (failure) =>
      failure.code === 'MISSING_CREDENTIAL' ||
      failure.code === 'AUTH' ||
      failure.code === 'NO_ADAPTER' ||
      failure.code === 'QUOTA',
  )
  const chosen = actionable ?? failures[failures.length - 1] ?? null
  if (chosen === null) return null
  if (failures.length <= 1) return chosen
  return { ...chosen, message: `${chosen.message}（已尝试 ${failures.length} 条模型路由）` }
}

/**
 * Make credential failures actionable.
 *
 * The plain provider message ("no API key for provider route …") does not tell
 * the user what to do next. In this plugin the usual cause is that the host's
 * *global default model* points at an API-key route while the conversation runs
 * on an account route, so the hint points at both ways out.
 */
function decorateCredentialFailure(error: SideAskError): SideAskError {
  if (error.code !== 'MISSING_CREDENTIAL') return error
  return {
    ...error,
    message: `${error.message}（旁问会优先沿用主对话当前使用的模型；也可在 dsh 设置里换默认模型，或在插件配置中指定 provider/model）`,
  }
}

// ------------------------------------------------------------------ runtime

export class SideAskRuntime {
  private readonly store: ThreadStore
  private readonly inflight = new Map<string, AbortController>()
  private lastConfig: HostConfig

  constructor(
    private readonly ctx: HostContext,
    private readonly rawConfig: unknown,
  ) {
    this.lastConfig = readConfig(rawConfig)
    this.store = new ThreadStore(threadsFilePath(), {
      maxThreads: this.lastConfig.maxThreads,
      maxMessagesPerThread: this.lastConfig.maxMessagesPerThread,
    })
    // The privacy switch is applied BEFORE load, so `persistHistory: false`
    // neither reads nor writes the history file.
    this.store.setPersist(this.lastConfig.persistHistory)
    this.store.load()
  }

  /** Current config, always re-read so settings changes apply without a reload. */
  config(): HostConfig {
    const config = readConfig(this.rawConfig)
    if (
      config.maxThreads !== this.lastConfig.maxThreads ||
      config.maxMessagesPerThread !== this.lastConfig.maxMessagesPerThread
    ) {
      this.store.setLimits({
        maxThreads: config.maxThreads,
        maxMessagesPerThread: config.maxMessagesPerThread,
      })
    }
    if (config.persistHistory !== this.lastConfig.persistHistory) {
      this.store.setPersist(config.persistHistory)
    }
    this.lastConfig = config
    return config
  }

  private llm(): LlmService | undefined {
    const service = this.ctx.get('llm')
    if (service === null || service === undefined) return undefined
    return service as LlmService
  }

  private defaultModel(): DefaultModelService | undefined {
    const service = this.ctx.get('agentDefaultModel')
    if (service === null || service === undefined) return undefined
    return service as DefaultModelService
  }

  bootstrap(): BootstrapResponse {
    const config = this.config()
    const llm = this.llm()
    const candidates = candidateRoutes(config, llm, this.defaultModel(), null)
    const first = candidates[0]
    return {
      apiVersion: API_VERSION,
      settings: config,
      model: first === undefined ? null : { provider: first.provider, model: first.model },
      providers: listProviderIds(llm),
      unavailable:
        first === undefined
          ? makeError('NO_ADAPTER', '没有可用的模型路由：请在插件设置里指定 provider/model，或在宿主里选一个默认模型')
          : null,
    }
  }

  listThreads(): ThreadListEntry[] {
    return this.store.list()
  }

  getThread(id: string): Thread | null {
    return this.store.get(id)
  }

  createThread(sessionId: string | null): Thread {
    return this.store.create(sessionId)
  }

  deleteThread(id: string): boolean {
    return this.store.remove(id)
  }

  /** Remove a message and every message after it ("regenerate"). Null ⇒ 404. */
  truncateThread(threadId: string, fromMessageId: string): { removed: number } | null {
    return this.store.truncate(threadId, fromMessageId)
  }

  /** Copy a thread prefix into a new thread. Null ⇒ unknown thread OR message. */
  forkThread(threadId: string, fromMessageId: string): Thread | null {
    return this.store.fork(threadId, fromMessageId)
  }

  /**
   * Lazy model catalogue for the in-window picker.
   *
   * Kept out of {@link bootstrap} on purpose: the host catalogue is async and
   * adapter-dependent, while bootstrap must answer synchronously so opening the
   * window is instant. Always resolves (missing/broken services ⇒ empty list).
   */
  async listModels(): Promise<ModelsResponse> {
    return { apiVersion: API_VERSION, providers: await describeModels(this.llm()) }
  }

  clearThreads(): number {
    return this.store.clear()
  }

  /** True when the request id was actually in flight. */
  cancel(requestId: string): boolean {
    const controller = this.inflight.get(requestId)
    if (controller === undefined) return false
    controller.abort()
    return true
  }

  /** Abort every in-flight call (plugin dispose). */
  dispose(): void {
    for (const controller of this.inflight.values()) controller.abort()
    this.inflight.clear()
    this.store.dispose()
  }

  flush(): void {
    this.store.flush()
  }

  /**
   * Compress a batch of main-conversation messages into one short summary.
   *
   * A plain JSON call, not a stream: the client only injects the finished text
   * into a later prompt, so partial output has no use. The failure channel is
   * therefore an exception ({@link SummaryLlmError}) rather than an event.
   *
   * Bounds, in the order they are applied:
   * 1. malformed entries/roles are dropped (the browser is not a trust boundary);
   * 2. at most 40 messages and 8000 input characters survive;
   * 3. an empty result answers `''` **without** a model call — an all-invalid
   *    payload is not worth a provider round-trip;
   * 4. the route list is walked with at most one fallback (only before any
   *    token), under a 12 s wall clock;
   * 5. the answer is trimmed and sliced to the clamped `maxChars`, and
   *    `truncated` records that slicing.
   */
  async summarize(request: SummarizeRequest, signal?: AbortSignal): Promise<SummarizeResponse> {
    // The HTTP layer parses JSON but cannot type-check it; `?? {}` keeps a
    // nullish body from throwing before the sanitising below.
    const body = (request ?? {}) as Partial<SummarizeRequest>
    const maxChars = readSummaryMaxChars(body.maxChars)
    const messages = clampSummaryMessages(sanitizeSummaryMessages(body.messages), {
      maxMessages: SUMMARY_MAX_MESSAGES,
      maxChars: SUMMARY_MAX_INPUT_CHARS,
    })
    const empty: SummarizeResponse = { apiVersion: API_VERSION, summary: '', truncated: false }
    if (messages.length === 0) return empty

    const config = this.config()
    const llm = this.llm()
    if (llm === undefined) throw new SummaryLlmError(makeError('NO_ADAPTER', '宿主未提供模型服务（ctx.llm 不可用）'))
    const candidates = candidateRoutes(config, llm, this.defaultModel(), readRouteHint(body.routeHint))
    if (candidates.length === 0) {
      throw new SummaryLlmError(
        makeError('NO_ADAPTER', '没有可用的模型路由：请在插件设置里指定 provider/model，或在宿主里选一个默认模型'),
      )
    }

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, SUMMARY_TIMEOUT_MS)
    timer.unref?.()
    const onAbort = (): void => controller.abort()
    if (signal !== undefined) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      const instruction = buildSummaryInstruction(maxChars)
      const input = summaryInput(messages)
      let collected = ''
      let result: CallResult | null = null
      const failures: SideAskError[] = []

      // The retry predicate is ask's: advance to the next route only when the
      // failure is adapter-shaped AND no token was produced, so a fallback can
      // never duplicate or replay text.
      for (const candidate of candidates.slice(0, SUMMARY_MAX_ATTEMPTS)) {
        let producedDelta = false
        collected = ''
        result = await callModel(
          llm,
          { provider: candidate.provider, model: candidate.model },
          {
            instruction,
            body: input,
            signal: controller.signal,
            maxTokens: SUMMARY_MAX_TOKENS,
            temperature: SUMMARY_TEMPERATURE,
          },
          (delta) => {
            producedDelta = true
            collected += delta
          },
        )
        if (result.failure === null) break
        failures.push(result.failure)
        const retryableRoute =
          !producedDelta &&
          (result.failure.code === 'MISSING_CREDENTIAL' ||
            result.failure.code === 'NO_ADAPTER' ||
            result.failure.code === 'AUTH')
        if (!retryableRoute) break
      }

      if (result === null) throw new SummaryLlmError(makeError('NO_ADAPTER', '没有可用的模型路由'))
      if (result.failure !== null) {
        const failure =
          result.failure.code === 'ABORTED' && timedOut
            ? makeError('TIMEOUT', '摘要请求超时')
            : decorateCredentialFailure(pickFailure(failures) ?? result.failure)
        throw new SummaryLlmError(failure)
      }

      // `trim()` first so the client never injects padding-only summary text, then
      // slice to the contract ceiling. `truncated` also covers the model's own
      // max-tokens stop, so a cut answer is never passed off as complete.
      const summary = collected.trim().slice(0, maxChars)
      return {
        apiVersion: API_VERSION,
        summary,
        truncated: result.truncated || collected.trim().length >= maxChars,
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * One question → one streamed answer.
   *
   * The generator yields contract events and always terminates with exactly one
   * `done` or `error`, so the HTTP layer never has to reason about partial
   * states.
   */
  async *ask(request: unknown, transportSignal: AbortSignal): AsyncGenerator<AskEvent> {
    const requestId =
      request !== null && typeof request === 'object' && typeof (request as Record<string, unknown>)['requestId'] === 'string'
        ? ((request as Record<string, unknown>)['requestId'] as string).slice(0, 128)
        : newMessageId('req')

    const fail = (error: SideAskError): AskEvent => ({ type: 'error', requestId, error })

    if (request === null || typeof request !== 'object') {
      yield fail(makeError('BAD_REQUEST', '请求体不是对象'))
      return
    }
    const body = request as Partial<AskRequest>
    if (body.apiVersion !== API_VERSION) {
      yield fail(makeError('API_MISMATCH', `插件前端与宿主版本不匹配（期望 ${API_VERSION}）`))
      return
    }
    const config = this.config()
    if (!config.enabled) {
      yield fail(makeError('INTERNAL', '插件已在设置中禁用'))
      return
    }
    const question = typeof body.question === 'string' ? body.question.trim() : ''
    if (question.length === 0) {
      yield fail(makeError('BAD_REQUEST', '问题为空'))
      return
    }
    if (question.length > MAX_QUESTION_CHARS) {
      yield fail(makeError('BAD_REQUEST', `问题过长（>${MAX_QUESTION_CHARS} 字符）`))
      return
    }
    const threadId = typeof body.threadId === 'string' && body.threadId.length > 0 ? body.threadId.slice(0, 128) : newMessageId('th')
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 200) : null

    // ---- route + privacy gate -------------------------------------------
    const llm = this.llm()
    if (llm === undefined) {
      yield fail(makeError('NO_ADAPTER', '宿主未提供模型服务'))
      return
    }
    const hint = readRouteHint(body.routeHint)
    const candidates = candidateRoutes(config, llm, this.defaultModel(), hint)
    if (candidates.length === 0) {
      yield fail(
        makeError(
          'NO_ADAPTER',
          '没有可用的模型路由：请在插件设置里指定 provider/model，或在宿主里选一个默认模型',
        ),
      )
      return
    }

    const contextAllowed = config.readContext && body.context !== null && body.context !== undefined
    const bundle = contextAllowed ? sanitizeBundle(body.context, config) : null
    const mode: 'context' | 'question-only' = bundle === null ? 'question-only' : 'context'

    // ---- thread bookkeeping ---------------------------------------------
    this.store.ensure(threadId, sessionId)
    const userMessage: ThreadMessage = {
      id: newMessageId('m'),
      role: 'user',
      text: question,
      createdAt: Date.now(),
      context: bundle === null ? null : bundle.stats,
    }
    this.store.append(threadId, userMessage)

    const history = (this.store.get(threadId)?.messages ?? []).filter(
      (message) => message.id !== userMessage.id && message.error === undefined,
    )

    const prompt = buildPrompt({
      question,
      bundle,
      history,
      requireCitations: config.requireCitations && mode === 'context',
      historyTurns: config.historyTurns,
    })

    yield { type: 'accepted', requestId, mode }
    yield { type: 'settings', requestId, settings: toSettings(config) }

    // ---- call the model --------------------------------------------------
    const controller = new AbortController()
    const onTransportAbort = (): void => controller.abort()
    transportSignal.addEventListener('abort', onTransportAbort, { once: true })
    this.inflight.set(requestId, controller)

    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, config.requestTimeoutMs)
    timeout.unref?.()

    const queue = new AsyncQueue<AskEvent>()
    const producer = (async (): Promise<void> => {
      try {
        // Walk the candidate routes. Retrying is only allowed when the failure
        // happened before any token (NO_ADAPTER / MISSING_CREDENTIAL / AUTH), so
        // streamed text can never be duplicated or replayed.
        let result: CallResult | null = null
        const failures: SideAskError[] = []
        for (const candidate of candidates) {
          let producedDelta = false
          result = await callModel(
            llm,
            { provider: candidate.provider, model: candidate.model },
            {
              instruction: prompt.system,
              body: prompt.user,
              signal: controller.signal,
              maxTokens: config.answerMaxTokens,
              temperature: config.temperature,
            },
            (delta) => {
              producedDelta = true
              queue.push({ type: 'delta', requestId, text: delta })
            },
          )
          if (result.failure === null) {
            break
          }
          failures.push(result.failure)
          const retryableRoute =
            !producedDelta &&
            (result.failure.code === 'MISSING_CREDENTIAL' ||
              result.failure.code === 'NO_ADAPTER' ||
              result.failure.code === 'AUTH')
          if (!retryableRoute) break
        }

        if (result === null) {
          queue.push({
            type: 'error',
            requestId,
            error: pickFailure(failures) ?? makeError('NO_ADAPTER', '没有可用的模型路由'),
          })
          return
        }

        if (result.failure !== null) {
          const error =
            result.failure.code === 'ABORTED' && timedOut
              ? makeError('TIMEOUT', '模型调用超时')
              : decorateCredentialFailure(pickFailure(failures) ?? result.failure)
          this.store.append(threadId, {
            id: newMessageId('m'),
            role: 'assistant',
            text: result.text,
            createdAt: Date.now(),
            error,
            replyTo: userMessage.id,
          })
          queue.push({ type: 'error', requestId, error })
          return
        }

        const finalised = finaliseAnswer(result.text, bundle?.items ?? [])
        const citations: Citation[] = finalised.citations
        if (result.truncated) {
          // Surface the cap instead of pretending the answer is complete.
          finalised.text = `${finalised.text}\n\n…（回答达到长度上限，已截断）`
        }
        const assistantMessage: ThreadMessage = {
          id: newMessageId('m'),
          role: 'assistant',
          text: finalised.text,
          createdAt: Date.now(),
          citations,
          replyTo: userMessage.id,
        }
        this.store.append(threadId, assistantMessage)
        queue.push({
          type: 'usage',
          requestId,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
        })
        queue.push({
          type: 'done',
          requestId,
          messageId: assistantMessage.id,
          text: finalised.text,
          citations,
        })
      } catch (error) {
        queue.push({
          type: 'error',
          requestId,
          error: makeError('INTERNAL', error instanceof Error ? error.message : String(error)),
        })
      } finally {
        clearTimeout(timeout)
        transportSignal.removeEventListener('abort', onTransportAbort)
        this.inflight.delete(requestId)
        queue.close()
      }
    })()

    try {
      for await (const event of queue) yield event
    } finally {
      await producer.catch(() => {})
    }
  }
}
