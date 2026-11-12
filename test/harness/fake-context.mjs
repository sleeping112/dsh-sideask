/**
 * Fake cordis host context for exercising the built host plugin without a real
 * DSH process.
 *
 * The fakes deliberately mirror the *shipped* host behaviours the plugin
 * depends on, because a permissive fake hides exactly the integration bugs the
 * harness exists to catch:
 *
 * - `webServer.register({ kind, path, handler|resource })` returns a disposer,
 *   duplicate `(kind, path)` throws, and dispatch order is the real one:
 *   exact path, then longest prefix where `pathname === prefix` or
 *   `pathname.startsWith(prefix + '/')` — see
 *   `@deepseek-ai/dsh-host-webserver/lib/index.js` `match()`.
 * - a `node:http` server request emits `'close'` as soon as its body has been
 *   delivered, NOT when the client disconnects; the fake reproduces that timing
 *   so a handler that aborts on `req.on('close')` fails here too.
 * - `ctx.effect(fn)` calls `fn` immediately and keeps the returned disposer;
 *   `ctx.inject(names, cb)` runs `cb` with a context whose `get()` sees the
 *   registered services.
 * - `ctx.llm.stream()` is an async iterable of the real chunk protocol:
 *   `block-start`, `text-delta`, `block-end`, `usage`, `finish`.
 *
 * Everything here is plain ESM with no test-runner imports, so the file can
 * also be imported by a one-off diagnostic script.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { API_VERSION, PLUGIN_ID, ROUTE_PREFIX } from '../../lib/shared/contract.js'

export { API_VERSION, PLUGIN_ID, ROUTE_PREFIX }

/** Absolute file URL of the built host entry. */
export const HOST_ENTRY_URL = new URL('../../lib/host/index.js', import.meta.url).href

let cachedPlugin = null

/** Import the built host entry exactly once (ESM module cache). */
export async function loadHostPlugin() {
  if (cachedPlugin === null) cachedPlugin = await import(HOST_ENTRY_URL)
  return cachedPlugin
}

export const ROUTE = Object.freeze({
  bootstrap: `${ROUTE_PREFIX}/bootstrap`,
  ask: `${ROUTE_PREFIX}/ask`,
  cancel: `${ROUTE_PREFIX}/cancel`,
  health: `${ROUTE_PREFIX}/health`,
  threads: `${ROUTE_PREFIX}/threads`,
  thread: (id) => `${ROUTE_PREFIX}/threads/${encodeURIComponent(id)}`,
})

// ------------------------------------------------------------------ config

/**
 * Plain-object config matching `src/host/config.ts` defaults.
 *
 * `apply(ctx, config)` passes the raw object through `readConfig()`, which
 * unwraps volatile getter refs and clamps values; plain values are the
 * documented shape for a non-loader caller.
 */
export function baseConfig(overrides = {}) {
  return {
    enabled: true,
    provider: '',
    model: '',
    answerMaxTokens: 1200,
    temperature: 0.4,
    recentMessageLimit: 12,
    contextBudgetTokens: 3000,
    autoSummary: true,
    requireCitations: true,
    readContext: true,
    redactSensitive: true,
    persistHistory: true,
    defaultCorner: 'bottom-right',
    hotkey: 'Alt+Shift+A',
    customRedactionPatterns: [],
    historyTurns: 8,
    maxThreads: 30,
    maxMessagesPerThread: 200,
    requestTimeoutMs: 60000,
    ...overrides,
  }
}

// ------------------------------------------------------------------ timing

export function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** Resolve after the current macrotask; cheap way to let pending promises run. */
export function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

class Deferred {
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

// ------------------------------------------------------------- fake context

/**
 * The slice of cordis an injected plugin can use, with the same call shapes.
 *
 * `services` is the backend map behind `ctx.get(name)`; tests put `llm`,
 * `agentDefaultModel`, and `webServer` in it. `ctx.provide(name, value)` also
 * makes the value reachable through `get`, like the real registry.
 */
export class FakeContext {
  constructor({ services = new Map() } = {}) {
    this.services = new Map(services)
    this.provided = new Map()
    this.injections = []
    this.effects = []
    this.disposed = false
  }

  get(name) {
    return this.services.get(name)
  }

  provide(name, value) {
    this.provided.set(name, value)
    this.services.set(name, value)
    return () => {
      this.provided.delete(name)
      this.services.delete(name)
    }
  }

  effect(callback, label = 'effect') {
    if (this.disposed) throw new Error('fake ctx: effect registered after dispose')
    const cleanup = callback()
    const entry = { label, cleanup: typeof cleanup === 'function' ? cleanup : () => {} }
    this.effects.push(entry)
    return () => {
      const index = this.effects.indexOf(entry)
      if (index >= 0) this.effects.splice(index, 1)
      entry.cleanup()
    }
  }

  inject(names, callback) {
    this.injections.push([...names])
    callback(this)
  }

  /** Run every recorded cleanup (LIFO), like disposing the plugin fiber. */
  disposeAll() {
    if (this.disposed) return
    this.disposed = true
    for (let index = this.effects.length - 1; index >= 0; index -= 1) {
      try {
        this.effects[index].cleanup()
      } catch {
        // Disposal errors must not mask test assertions.
      }
    }
    this.effects.length = 0
  }
}

// ------------------------------------------------------------ fake webServer

/**
 * In-memory stand-in for `@deepseek-ai/dsh-host-webserver`.
 *
 * `register` matches the real contract (returns a disposer, duplicate
 * `(kind, path)` throws) and `match` is a transcription of the shipped
 * `match()`: an exact hit wins, otherwise the longest prefix that equals the
 * pathname or is followed by `/`. A prefix registered WITH a trailing slash
 * therefore matches nothing below it — a real integration trap this fake keeps.
 */
export class FakeWebServer {
  constructor() {
    this.exact = new Map()
    this.prefixes = new Map()
    this.registrations = []
    this.requests = []
  }

  register(spec) {
    if (typeof spec !== 'object' || spec === null) throw new Error('fake webServer: route must be an object')
    if (spec.kind !== 'exact' && spec.kind !== 'prefix') {
      throw new Error(`fake webServer: unknown route kind ${JSON.stringify(spec.kind)}`)
    }
    if (typeof spec.path !== 'string' || !spec.path.startsWith('/')) {
      throw new Error(`fake webServer: route path must be absolute, got ${JSON.stringify(spec.path)}`)
    }
    const hasHandler = typeof spec.handler === 'function'
    const hasResource = typeof spec.resource === 'function'
    if (!hasHandler && !hasResource) throw new Error('fake webServer: route needs a handler or a resource')
    const table = spec.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(spec.path)) throw new Error(`webserver: duplicate ${spec.kind} route "${spec.path}"`)
    table.set(spec.path, spec)
    this.registrations.push(spec)
    return () => {
      if (table.get(spec.path) === spec) table.delete(spec.path)
      const index = this.registrations.indexOf(spec)
      if (index >= 0) this.registrations.splice(index, 1)
    }
  }

  /** Exact first, then longest prefix with a `/` boundary (shipped semantics). */
  match(pathname) {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    let best
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }

  routePaths() {
    return this.registrations.map((route) => `${route.kind}:${route.path}`)
  }

  /**
   * Dispatch one fake request and resolve once the handler has ended the
   * response. `request` may be a plain `{ method, url, headers, body }` object.
   */
  async dispatch(input = {}) {
    const request = input instanceof FakeRequest ? input : new FakeRequest(input)
    const response = new FakeResponse()
    this.requests.push({ method: request.method, url: request.url, headers: request.headers })

    let pathname = '/'
    try {
      pathname = new URL(request.url, 'http://127.0.0.1').pathname
    } catch {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      response.end('{"error":"bad url"}')
      return response
    }
    request.pathname = pathname

    const route = this.match(pathname)
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      response.end('{"error":{"code":"BAD_REQUEST","message":"no route"}}')
      return response
    }

    const outcome = new Deferred()
    response._whenEnded = outcome
    const settle = (error) => {
      if (outcome.settled === true) return
      outcome.settled = true
      if (error !== undefined) outcome.reject(error)
      else outcome.resolve(response)
    }
    response._settle = settle
    const timer = setTimeout(() => settle(new Error(`fake webServer: ${request.method} ${pathname} did not end its response`)), 8000)
    timer.unref?.()

    try {
      if (typeof route.resource === 'function') {
        const fetchRequest = new Request(new URL(request.url, 'http://127.0.0.1'), {
          method: request.method,
          headers: request.headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        })
        const fetchResponse = await route.resource(fetchRequest)
        response.writeHead(fetchResponse.status, Object.fromEntries(fetchResponse.headers))
        response.end(await fetchResponse.text())
        return response
      }
      // The real server hands the handler raw req/res and does not await it.
      route.handler(request, response)
      request.deliverBody()
      await outcome.promise
      return response
    } finally {
      clearTimeout(timer)
    }
  }
}

// ------------------------------------------------------------- fake request

const BODY_CHUNK = 64 * 1024

/**
 * Minimal `node:http` IncomingMessage stand-in.
 *
 * Real timing this reproduces: `'close'` is emitted shortly after the body's
 * `'end'`, while the response is still open. `closeAfterBody: false` disables
 * that for scenarios where the request must stay "open" (client-disconnect
 * tests drive `response.destroy()` instead).
 */
export class FakeRequest {
  constructor(options = {}) {
    this.method = (options.method ?? 'GET').toUpperCase()
    this.url = options.url ?? '/'
    this.headers = lowerHeaders(options.headers ?? {})
    this.body = typeof options.body === 'string' ? options.body : ''
    this.closeAfterBody = options.closeAfterBody ?? true
    this.destroyed = false
    this.pathname = '/'
    this.listeners = new Map()
    this.emitted = []
  }

  on(event, listener) {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  once(event, listener) {
    const wrapped = (...args) => {
      this.off(event, wrapped)
      listener(...args)
    }
    return this.on(event, wrapped)
  }

  off(event, listener) {
    const list = this.listeners.get(event)
    if (list === undefined) return this
    const index = list.indexOf(listener)
    if (index >= 0) list.splice(index, 1)
    return this
  }

  emit(event, ...args) {
    this.emitted.push(event)
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
    return this
  }

  /** Deliver the body the way node:http does: zero or more data, then end, then close. */
  deliverBody() {
    if (this.closed === true) return
    const text = this.body
    if (typeof text === 'string' && text.length > 0) {
      for (let offset = 0; offset < text.length; offset += BODY_CHUNK) {
        this.emit('data', Buffer.from(text.slice(offset, offset + BODY_CHUNK)))
      }
    }
    this.emit('end')
    if (this.closeAfterBody) {
      // Node emits the request's 'close' from its own async bookkeeping, after
      // the body microtasks have run (~2 ms in a real server). A microtask here
      // would let consumers attach their 'close' listeners *after* the event,
      // which the real server never allows; use a macrotask to be faithful.
      setImmediate(() => {
        if (this.closed === true) return
        this.closed = true
        this.emit('close')
      })
    }
  }

  /** Server-side abort of the request stream (mirrors the too-large-body path). */
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('close')
  }
}

// ------------------------------------------------------------ fake response

/**
 * Minimal `node:http` ServerResponse stand-in that records writes.
 *
 * `once('drain')` fires on the next macrotask instead of waiting for a real
 * socket, so the plugin's backpressure loop does not add 250 ms per event.
 */
export class FakeResponse {
  constructor() {
    this.statusCode = 200
    this.headers = {}
    this.headersSent = false
    this.chunks = []
    this.writableEnded = false
    this.destroyed = false
    this.listeners = new Map()
    this._settle = () => {}
    this._whenEnded = null
  }

  writeHead(status, headers = {}) {
    this.statusCode = status
    this.headers = lowerHeaders(headers)
    this.headersSent = true
    return this
  }

  flushHeaders() {
    this.headersSent = true
  }

  write(chunk) {
    if (this.writableEnded) return false
    this.chunks.push(String(chunk))
    return true
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== null) this.write(chunk)
    if (this.writableEnded) return this
    this.writableEnded = true
    this.emit('finish')
    this._settle()
    return this
  }

  on(event, listener) {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  once(event, listener) {
    if (event === 'drain') {
      // Backpressure is always satisfiable in a fake: drain next macrotask.
      setImmediate(() => listener())
      return this
    }
    const wrapped = (...args) => {
      this.off(event, wrapped)
      listener(...args)
    }
    return this.on(event, wrapped)
  }

  off(event, listener) {
    const list = this.listeners.get(event)
    if (list === undefined) return this
    const index = list.indexOf(listener)
    if (index >= 0) list.splice(index, 1)
    return this
  }

  emit(event, ...args) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
    return this
  }

  /** Simulate the client going away: the real server sees res 'close'. */
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('close')
    if (!this.writableEnded) {
      this.writableEnded = true
      this._settle()
    }
  }

  get text() {
    return this.chunks.join('')
  }

  get json() {
    try {
      return JSON.parse(this.text)
    } catch {
      return null
    }
  }

  get events() {
    return parseSse(this.text)
  }
}

function lowerHeaders(headers) {
  const output = {}
  for (const [name, value] of Object.entries(headers)) output[name.toLowerCase()] = value
  return output
}

/** Parse an SSE body into the JSON payloads of its `data:` lines. */
export function parseSse(text) {
  const events = []
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((entry) => entry.startsWith('data:'))
    if (line === undefined) continue
    const payload = line.slice('data:'.length).trim()
    if (payload.length === 0) continue
    try {
      events.push(JSON.parse(payload))
    } catch {
      events.push({ type: 'unparseable', raw: payload })
    }
  }
  return events
}

// --------------------------------------------------------------- fake model

/**
 * Scriptable stand-in for the host's `llm` service.
 *
 * `script` may be an object or a function `(callIndex) => script`. Supported
 * shapes:
 *
 * - `{ mode: 'success', answer, deltas?, usage? }` — full successful stream.
 * - `{ mode: 'error', failure: { code, message } }` — terminal `finish` with
 *   `reason.kind = 'error'`, exactly how the host reports provider failures.
 * - `{ mode: 'throw', error: { code, message } }` — the iterable throws instead.
 * - `{ mode: 'abort' }` — terminal `finish` with `reason.kind = 'aborted'`.
 * - `{ mode: 'max-tokens', answer }` — `reason.kind = 'max-tokens'` (partial).
 * - `{ mode: 'success', deltas, delayMs }` — a slow stream; honours
 *   `options.signal` between chunks.
 *
 * Every captured `stream(options)` argument is pushed to `requests`, so tests
 * can assert on the exact `messages` the plugin sent.
 */
export class FakeLlm {
  constructor({ providers, script = { mode: 'success', answer: '默认回答' } } = {}) {
    this.providers = providers ?? [{ id: 'deepseek', provider: 'deepseek', label: 'DeepSeek' }]
    this.script = script
    this.requests = []
  }

  listProviders() {
    return this.providers
  }

  setScript(script) {
    this.script = script
  }

  get lastRequest() {
    return this.requests[this.requests.length - 1]
  }

  /** Every text block the plugin actually sent, flattened for convenience. */
  sentText() {
    return this.requests
      .flatMap((request) => request.messages ?? [])
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part) => part !== null && typeof part === 'object' && part.type === 'text')
      .map((part) => part.text)
      .join('\n')
  }

  async *stream(options = {}) {
    this.requests.push(options)
    const script = typeof this.script === 'function' ? this.script(this.requests.length) : this.script
    const signal = options.signal
    const aborted = () => signal !== undefined && signal !== null && signal.aborted === true
    const finish = (reason) => ({ type: 'finish', reason })

    if (aborted()) {
      yield finish({ kind: 'aborted' })
      return
    }

    yield { type: 'block-start', index: 0, blockType: 'text' }

    switch (script.mode) {
      case 'throw':
        throw makeProviderError(script.error)
      case 'abort': {
        yield finish({ kind: 'aborted' })
        return
      }
      case 'error': {
        yield finish({ kind: 'error', failure: script.failure ?? { code: 'PROVIDER_ERROR', message: 'provider failed' } })
        return
      }
      case 'max-tokens':
      case 'success':
      default: {
        const deltas = splitAnswer(script)
        for (const delta of deltas) {
          if (aborted()) {
            yield finish({ kind: 'aborted' })
            return
          }
          if (typeof script.delayMs === 'number' && script.delayMs > 0) {
            await delayWithSignal(script.delayMs, signal)
            if (aborted()) {
              yield finish({ kind: 'aborted' })
              return
            }
          }
          if (delta.length > 0) yield { type: 'text-delta', index: 0, text: delta }
        }
        yield { type: 'block-end', index: 0 }
        if (script.usage !== false) {
          yield {
            type: 'usage',
            usage: script.usage ?? { inputTokens: 24, outputTokens: 8, totalTokens: 32 },
          }
        }
        yield finish({ kind: script.mode === 'max-tokens' ? 'max-tokens' : 'stop' })
      }
    }
  }
}

function makeProviderError(error) {
  const issue = new Error(error?.message ?? 'provider failed')
  if (error !== undefined && error !== null && typeof error === 'object') {
    for (const [key, value] of Object.entries(error)) {
      if (key !== 'message') issue[key] = value
    }
  }
  return issue
}

function splitAnswer(script) {
  if (Array.isArray(script.deltas)) return script.deltas.map((entry) => String(entry))
  const answer = typeof script.answer === 'string' ? script.answer : ''
  if (answer.length === 0) return []
  // Three chunks is enough to prove incremental streaming without pinning the
  // exact split; the caller asserts the concatenation.
  const cuts = [Math.ceil(answer.length / 3), Math.ceil((answer.length * 2) / 3)]
  return [answer.slice(0, cuts[0]), answer.slice(cuts[0], cuts[1]), answer.slice(cuts[1])]
}

function delayWithSignal(ms, signal) {
  return new Promise((resolve) => {
    if (signal === undefined || signal === null) {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
      return
    }
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener?.('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    timer.unref?.()
    signal.addEventListener?.('abort', done, { once: true })
  })
}

/** Stand-in for the `agentDefaultModel` service. */
export class FakeDefaultModel {
  constructor(selection = { provider: 'deepseek', model: 'deepseek-chat' }) {
    this.selection = selection
  }

  currentSelection() {
    return { ...this.selection }
  }
}

// ------------------------------------------------------------------ mounting

/**
 * Build a fake host, call `apply(ctx, config)`, and return the pieces a test
 * drives.
 *
 * `dshHome` (when provided) is written to `process.env.DSH_HOME` *before*
 * `apply`, because the thread store resolves its file path from the
 * environment at construction time.
 */
export function mountHost(plugin, config = baseConfig(), options = {}) {
  const { llm = new FakeLlm(), defaultModel = new FakeDefaultModel(), services = new Map(), dshHome } = options
  if (dshHome !== undefined) process.env.DSH_HOME = dshHome

  const webServer = new FakeWebServer()
  const serviceMap = new Map(services)
  if (llm !== null) serviceMap.set('llm', llm)
  if (defaultModel !== null) serviceMap.set('agentDefaultModel', defaultModel)
  serviceMap.set('webServer', webServer)

  const ctx = new FakeContext({ services: serviceMap })
  plugin.apply(ctx, config)

  return {
    ctx,
    webServer,
    llm,
    defaultModel,
    config,
    /** Dispatch a request through the registered routes. */
    request: (input) => webServer.dispatch(input),
    get: (name) => ctx.get(name),
    dispose: () => ctx.disposeAll(),
  }
}

/** Fresh throwaway `$DSH_HOME`; the caller sets it and cleans it up. */
export function tempHome(prefix = 'dsh-sideask-verify-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  return {
    dir,
    /** `$DSH_HOME/storages/sideask/threads.json`, the store's real location. */
    threadsFile: () => path.join(dir, 'storages', 'sideask', 'threads.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// -------------------------------------------------------------- test fixtures

export function askBody(overrides = {}) {
  return {
    apiVersion: API_VERSION,
    requestId: 'req-test-1',
    threadId: 'th-test-1',
    question: '这个函数为什么返回 undefined？',
    context: null,
    ...overrides,
  }
}

export function contextItem(overrides = {}) {
  const text = overrides.text ?? '被引用的主对话内容'
  return {
    ref: 'c1',
    messageId: 'm-1',
    role: 'user',
    text,
    tokens: Math.ceil(text.length / 4),
    truncated: false,
    source: 'recent',
    ...overrides,
  }
}

export function contextBundle(overrides = {}) {
  return {
    items: [],
    summary: null,
    selection: null,
    stats: {
      budgetTokens: 3000,
      questionTokens: 10,
      selectionTokens: 0,
      recentTokens: 0,
      summaryTokens: 0,
      usedTokens: 0,
      consideredCount: 0,
      dedupedCount: 0,
      redactedCount: 0,
      truncations: { selection: 0, recent: 0, summary: 0 },
      degradations: [],
    },
    ...overrides,
  }
}

/** JSON POST request body used by `webServer.dispatch`. */
export function jsonRequest(pathname, body, overrides = {}) {
  return {
    method: 'POST',
    url: pathname,
    headers: { 'content-type': 'application/json', ...(overrides.headers ?? {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...overrides,
  }
}

/** GET request with sane same-origin headers absent (allowed, like curl). */
export function getRequest(pathname, overrides = {}) {
  return { method: 'GET', url: pathname, headers: { ...(overrides.headers ?? {}) }, body: '', ...overrides }
}
