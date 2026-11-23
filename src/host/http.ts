/**
 * HTTP surface: `/plugins/dsh-sideask/api/*`.
 *
 * VERIFIED host API used here (docs/research/host-api.md):
 * `ctx.webServer.register({ kind: 'exact' | 'prefix', path, handler })` where
 * `handler` is a Node `(req, res)` function and the returned value is a
 * disposer. `resource: (request) => Response` accepts a Fetch-style handler
 * instead; this file uses the Node form because streaming needs `res.write`.
 *
 * Transport rules:
 * - same-origin only (a plugin route must not be reachable cross-site);
 * - JSON bodies with a hard size cap;
 * - `ask` streams `text/event-stream`, one contracted event per `data:` line;
 * - every handler answers within a bounded time and never throws to the server.
 */

import type {
  AskEvent,
  BootstrapResponse,
  ForkResponse,
  SideAskError,
  SummarizeRequest,
  SummarizeResponse,
  Thread,
  ThreadListEntry,
} from '../shared/contract.js'
import { API_VERSION, ROUTE_PREFIX } from '../shared/contract.js'
import { makeError } from '../shared/errors.js'
import { SummaryLlmError, type HostContext, type SideAskRuntime } from './runtime.js'

/** Minimal Node request/response surface (no @types/node dependency). */
interface NodeRequest {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  on(event: string, listener: (...args: unknown[]) => void): unknown
  destroy?(): void
}

interface NodeResponse {
  writeHead(status: number, headers?: Record<string, string | number>): unknown
  write(chunk: string): boolean
  end(chunk?: string): unknown
  writableEnded?: boolean
  on?(event: string, listener: (...args: unknown[]) => void): unknown
  once?(event: string, listener: (...args: unknown[]) => void): unknown
  flushHeaders?(): void
}

interface WebServerService {
  register(spec: {
    kind: 'exact' | 'prefix'
    path: string
    handler?: (req: NodeRequest, res: NodeResponse) => void
    resource?: (request: Request) => Response | Promise<Response>
  }): () => void
}

/**
 * The slice of DSH's `connection` service this plugin uses (0.2.x).
 *
 * `requestRejection` applies Connection's Host/Origin fence and browser
 * authentication before dispatch, returning 401/403 or `undefined` when the
 * request may proceed. It is the same fence the shared `/api` channel uses, so
 * a plugin route cannot be driven by an unauthenticated or cross-site page.
 */
interface ConnectionService {
  requestRejection(request: { headers: NodeRequest['headers'] }): 401 | 403 | undefined
}

const MAX_BODY_BYTES = 1024 * 1024

function headerValue(request: NodeRequest, name: string): string | null {
  const value = request.headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return null
}

/**
 * Same-origin guard. Browsers send `Sec-Fetch-Site: cross-site` for cross-site
 * requests; an `Origin` that does not match `Host` is also rejected. A missing
 * Origin (curl, tests) is allowed: this is a local plugin API, not a public one.
 */
function requestAllowed(request: NodeRequest): boolean {
  const site = headerValue(request, 'sec-fetch-site')
  if (site === 'cross-site') return false
  const origin = headerValue(request, 'origin')
  if (origin === null || origin.length === 0) return true
  const host = headerValue(request, 'host')
  if (host === null) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function sendJson(res: NodeResponse, status: number, payload: unknown): void {
  if (res.writableEnded === true) return
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function sendError(res: NodeResponse, status: number, error: SideAskError): void {
  sendJson(res, status, { error })
}

function readBody(request: NodeRequest, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = []
    let size = 0
    request.on('data', (chunk: unknown) => {
      const text = String(chunk)
      size += text.length
      if (size > limit) {
        reject(new Error('body too large'))
        request.destroy?.()
        return
      }
      chunks.push(text)
    })
    request.on('end', () => resolve(chunks.join('')))
    request.on('error', (error: unknown) => reject(error))
  })
}

async function readJson(request: NodeRequest): Promise<unknown> {
  const text = await readBody(request)
  if (text.trim().length === 0) return {}
  return JSON.parse(text)
}

function methodOf(request: NodeRequest): string {
  return (request.method ?? 'GET').toUpperCase()
}

function sseWrite(res: NodeResponse, event: AskEvent): boolean {
  if (res.writableEnded === true) return false
  return res.write(`data: ${JSON.stringify(event)}\n\n`)
}

async function handleAsk(runtime: SideAskRuntime, request: NodeRequest, res: NodeResponse): Promise<void> {
  if (methodOf(request) !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  let body: unknown
  try {
    body = await readJson(request)
  } catch (error) {
    sendError(res, 400, makeError('BAD_REQUEST', error instanceof Error ? error.message : '无法解析请求体'))
    return
  }

  const controller = new AbortController()
  // Client disconnect detection listens on the RESPONSE only.
  //
  // In Node's http server the *request* 'close' event fires as soon as the
  // request message is complete — i.e. immediately after the POST body is
  // consumed, while the SSE response is still open. Aborting there kills every
  // stream (verified against a real node:http server). The response's 'close'
  // fires when the socket actually goes away, which is the signal we want.
  // Real client aborts also surface as request 'aborted'/'error'; those are
  // safe to hook, unlike 'close'.
  const onResponseClose = (): void => {
    if (res.writableEnded !== true) controller.abort()
  }
  res.on?.('close', onResponseClose)
  request.on('aborted', () => {
    if (res.writableEnded !== true) controller.abort()
  })
  request.on('error', () => {
    if (res.writableEnded !== true) controller.abort()
  })

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.flushHeaders?.()

  try {
    for await (const event of runtime.ask(body, controller.signal)) {
      // `res.write` returns false only when the socket buffer is full — that is
      // the backpressure signal. Waiting on 'drain' after every frame would add
      // a fake delay to each streamed token, so the wait is conditional.
      const writable = sseWrite(res, event)
      if (res.writableEnded === true) break
      if (!writable && typeof res.once === 'function') {
        await new Promise<void>((resolve) => {
          let settled = false
          const finish = (): void => {
            if (settled) return
            settled = true
            resolve()
          }
          res.once?.('drain', finish)
          // A closed socket may never drain; give up shortly so abort runs.
          setTimeout(finish, 250).unref?.()
        })
      }
      if (event.type === 'done' || event.type === 'error') break
    }
  } catch (error) {
    sseWrite(res, {
      type: 'error',
      requestId: 'stream',
      error: makeError('INTERNAL', error instanceof Error ? error.message : String(error)),
    })
  } finally {
    if (res.writableEnded !== true) res.end()
  }
}

/**
 * POST `/summarize` with `{ apiVersion, requestId, messages, maxChars?, routeHint? }`.
 *
 * JSON rather than SSE: the client only needs the finished summary, and the
 * response is a single contracted `SummarizeResponse`. A malformed body is 400;
 * a provider failure (no route could run) is 502 with the contract error object,
 * mirroring how `/ask` exposes the same `SideAskError` — just not streamed.
 */
async function handleSummarize(runtime: SideAskRuntime, request: NodeRequest, res: NodeResponse): Promise<void> {
  if (methodOf(request) !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  let body: unknown
  try {
    body = await readJson(request)
  } catch (error) {
    sendError(res, 400, makeError('BAD_REQUEST', error instanceof Error ? error.message : '无法解析请求体'))
    return
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendError(res, 400, makeError('BAD_REQUEST', '请求体不是对象'))
    return
  }

  // The model call is not streamed, but a browser that closes the window while
  // we wait should still stop the provider stream. The response's 'close' is the
  // real disconnect signal (the request's 'close' fires once the body is read).
  const controller = new AbortController()
  res.on?.('close', () => {
    if (res.writableEnded !== true) controller.abort()
  })
  request.on('aborted', () => {
    if (res.writableEnded !== true) controller.abort()
  })
  request.on('error', () => {
    if (res.writableEnded !== true) controller.abort()
  })

  try {
    const payload: SummarizeResponse = await runtime.summarize(body as SummarizeRequest, controller.signal)
    sendJson(res, 200, payload)
  } catch (error) {
    if (error instanceof SummaryLlmError) {
      sendError(res, 502, error.error)
      return
    }
    sendError(res, 500, makeError('INTERNAL', error instanceof Error ? error.message : String(error)))
  }
}

/**
 * Parse `/plugins/dsh-sideask/api/threads/<id>[/truncate|/fork]`.
 *
 * The id-scoped routes are registered under a SLASH-LESS prefix because the
 * host web server matches a prefix route as
 * `pathname === prefix || pathname.startsWith(prefix + '/')`; a prefix that
 * already ends in `/` could never match `.../threads/<id>` (it would require a
 * double slash). Shipped host prefixes are slash-less for exactly this reason.
 *
 * The optional trailing segment is a sub-resource action. An unknown action
 * (or an empty id, or an undecodable id) is rejected as "not a thread path" so
 * the caller answers 404 instead of silently operating on the collection.
 */
interface ThreadPath {
  id: string
  /** `null` for the item itself; a sub-resource action otherwise. */
  action: 'truncate' | 'fork' | null
}

/** Every sub-resource action the item route understands. */
const THREAD_ACTIONS = new Set(['truncate', 'fork'])

function threadIdFromPath(pathname: string): ThreadPath | null {
  const prefix = `${ROUTE_PREFIX}/threads/`
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  if (rest.length === 0) return null
  const slash = rest.indexOf('/')
  const rawId = slash === -1 ? rest : rest.slice(0, slash)
  const rawAction = slash === -1 ? null : rest.slice(slash + 1)
  if (rawId.length === 0) return null
  if (rawAction !== null && !THREAD_ACTIONS.has(rawAction)) return null
  try {
    return { id: decodeURIComponent(rawId), action: rawAction as ThreadPath['action'] }
  } catch {
    return null
  }
}

/**
 * POST `/threads/<id>/truncate` with `{ fromMessageId }`.
 *
 * Answers 404 for an unknown thread, 400 for a malformed body, and
 * `{ removed }` otherwise. `removed` may be 0 when the message id is already
 * gone (another tab truncated first), which is not an error.
 */
async function handleTruncate(
  runtime: SideAskRuntime,
  threadId: string,
  request: NodeRequest,
  res: NodeResponse,
): Promise<void> {
  if (methodOf(request) !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  let body: unknown
  try {
    body = await readJson(request)
  } catch (error) {
    sendError(res, 400, makeError('BAD_REQUEST', error instanceof Error ? error.message : '无法解析请求体'))
    return
  }
  const fromMessageId =
    body !== null && typeof body === 'object' && typeof (body as Record<string, unknown>)['fromMessageId'] === 'string'
      ? ((body as Record<string, unknown>)['fromMessageId'] as string)
      : ''
  if (fromMessageId.length === 0) {
    sendError(res, 400, makeError('BAD_REQUEST', '缺少 fromMessageId'))
    return
  }
  const result = runtime.truncateThread(threadId, fromMessageId)
  if (result === null) {
    sendError(res, 404, makeError('BAD_REQUEST', '会话不存在'))
    return
  }
  sendJson(res, 200, { removed: result.removed })
}

/**
 * POST `/threads/<id>/fork` with `{ fromMessageId }`.
 *
 * Copies the message at `fromMessageId` and everything before it into a new
 * thread, leaving the source untouched. Answers 404 both for an unknown thread
 * and for an unknown message: a fork cannot guess a prefix, so — unlike
 * truncate's race-tolerant no-op — there is nothing sensible to return.
 */
async function handleFork(
  runtime: SideAskRuntime,
  threadId: string,
  request: NodeRequest,
  res: NodeResponse,
): Promise<void> {
  if (methodOf(request) !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  let body: unknown
  try {
    body = await readJson(request)
  } catch (error) {
    sendError(res, 400, makeError('BAD_REQUEST', error instanceof Error ? error.message : '无法解析请求体'))
    return
  }
  const fromMessageId =
    body !== null && typeof body === 'object' && typeof (body as Record<string, unknown>)['fromMessageId'] === 'string'
      ? ((body as Record<string, unknown>)['fromMessageId'] as string)
      : ''
  if (fromMessageId.length === 0) {
    sendError(res, 400, makeError('BAD_REQUEST', '缺少 fromMessageId'))
    return
  }
  const thread = runtime.forkThread(threadId, fromMessageId)
  if (thread === null) {
    sendError(res, 404, makeError('BAD_REQUEST', '会话或消息不存在'))
    return
  }
  const payload: ForkResponse = { apiVersion: API_VERSION, thread }
  sendJson(res, 200, payload)
}

function createThreadsHandler(runtime: SideAskRuntime) {
  return async (request: NodeRequest, res: NodeResponse): Promise<void> => {
    let pathname = ''
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    } catch {
      sendError(res, 400, makeError('BAD_REQUEST', '非法路径'))
      return
    }
    const method = methodOf(request)
    const parsed = threadIdFromPath(pathname)

    if (parsed === null) {
      if (pathname !== `${ROUTE_PREFIX}/threads`) {
        sendError(res, 404, makeError('BAD_REQUEST', '未知路径'))
        return
      }
      if (method === 'GET') {
        const threads: ThreadListEntry[] = runtime.listThreads()
        sendJson(res, 200, threads)
        return
      }
      if (method === 'POST') {
        let sessionId: string | null = null
        try {
          const body = (await readJson(request)) as { sessionId?: unknown }
          if (typeof body.sessionId === 'string') sessionId = body.sessionId.slice(0, 200)
        } catch {
          // An empty body is fine: create an unbound thread.
        }
        const thread: Thread = runtime.createThread(sessionId)
        sendJson(res, 201, thread)
        return
      }
      if (method === 'DELETE') {
        sendJson(res, 200, { cleared: runtime.clearThreads() })
        return
      }
      res.writeHead(405, { allow: 'GET, POST, DELETE' })
      res.end()
      return
    }

    if (parsed.action === 'truncate') {
      await handleTruncate(runtime, parsed.id, request, res)
      return
    }

    if (parsed.action === 'fork') {
      await handleFork(runtime, parsed.id, request, res)
      return
    }

    const id = parsed.id
    if (method === 'GET') {
      const thread = runtime.getThread(id)
      if (thread === null) sendError(res, 404, makeError('BAD_REQUEST', '会话不存在'))
      else sendJson(res, 200, thread)
      return
    }
    if (method === 'DELETE') {
      sendJson(res, 200, { deleted: runtime.deleteThread(id) })
      return
    }
    res.writeHead(405, { allow: 'GET, DELETE' })
    res.end()
  }
}

/**
 * Register every route and return one disposer.
 *
 * `webServer` is optional in the composition (a headless profile may not mount
 * it); when absent the plugin simply has no HTTP surface and the browser half
 * reports "host unavailable" instead of breaking the page.
 */
export function registerRoutes(ctx: HostContext, runtime: SideAskRuntime): () => void {
  const server = ctx.get('webServer') as WebServerService | undefined
  if (server === undefined || server === null) return () => {}

  // Fail closed: the routes only exist when DSH's connection service can fence
  // them. The plugin injects both services together, so this is the
  // hypothetical case of a host that mounts a web server without Connection.
  const connection = ctx.get('connection') as ConnectionService | undefined
  if (connection === undefined || connection === null) return () => {}

  const disposers: (() => void)[] = []
  const guard = (handler: (req: NodeRequest, res: NodeResponse) => void) => (req: NodeRequest, res: NodeResponse): void => {
    // DSH's own access check first: Host/Origin fence plus browser
    // authentication. A throw is treated as a rejection, never as "allowed".
    let rejection: 401 | 403 | undefined
    try {
      rejection = connection.requestRejection(req)
    } catch {
      rejection = 403
    }
    if (rejection !== undefined) {
      sendJson(res, rejection, {
        error: makeError('BAD_REQUEST', rejection === 401 ? '未认证请求被拒绝' : '跨站请求被拒绝'),
      })
      return
    }
    // Defense in depth for the request shapes Connection does not classify
    // (e.g. `Sec-Fetch-Site: cross-site` without an Origin).
    if (!requestAllowed(req)) {
      sendJson(res, 403, { error: makeError('BAD_REQUEST', '跨站请求被拒绝') })
      return
    }
    try {
      handler(req, res)
    } catch (error) {
      sendJson(res, 500, { error: makeError('INTERNAL', error instanceof Error ? error.message : String(error)) })
    }
  }

  disposers.push(
    server.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/bootstrap`,
      handler: guard((req, res) => {
        if (methodOf(req) !== 'GET' && methodOf(req) !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        const payload: BootstrapResponse = runtime.bootstrap()
        sendJson(res, 200, payload)
      }),
    }),
  )

  disposers.push(
    server.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/models`,
      handler: guard((req, res) => {
        const method = methodOf(req)
        if (method !== 'GET' && method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        // The catalogue is async and adapter-dependent: a slow or broken
        // provider must degrade to "no model list", never to an error page.
        void runtime
          .listModels()
          .then((payload) => sendJson(res, 200, payload))
          .catch(() => sendJson(res, 200, { apiVersion: API_VERSION, providers: [] }))
      }),
    }),
  )

  disposers.push(
    server.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/ask`,
      handler: guard((req, res) => {
        void handleAsk(runtime, req, res)
      }),
    }),
  )

  disposers.push(
    server.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/summarize`,
      handler: guard((req, res) => {
        void handleSummarize(runtime, req, res)
      }),
    }),
  )

  disposers.push(
    server.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/cancel`,
      handler: guard((req, res) => {
        if (methodOf(req) !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          res.end()
          return
        }
        void readJson(req)
          .then((body) => {
            const requestId =
              body !== null && typeof body === 'object' && typeof (body as Record<string, unknown>)['requestId'] === 'string'
                ? ((body as Record<string, unknown>)['requestId'] as string)
                : ''
            sendJson(res, 200, { cancelled: requestId.length > 0 ? runtime.cancel(requestId) : false })
          })
          .catch((error: unknown) => {
            sendError(res, 400, makeError('BAD_REQUEST', error instanceof Error ? error.message : '无法解析请求体'))
          })
      }),
    }),
  )

  disposers.push(
    server.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/threads`,
      handler: guard((req, res) => {
        void createThreadsHandler(runtime)(req, res)
      }),
    }),
  )

  disposers.push(
    server.register({
      kind: 'prefix',
      path: `${ROUTE_PREFIX}/threads`,
      handler: guard((req, res) => {
        void createThreadsHandler(runtime)(req, res)
      }),
    }),
  )

  disposers.push(
    server.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/health`,
      handler: guard((req, res) => {
        const bootstrap = runtime.bootstrap()
        sendJson(res, bootstrap.unavailable === null ? 200 : 503, {
          ok: bootstrap.unavailable === null,
          model: bootstrap.model,
          providers: bootstrap.providers,
          unavailable: bootstrap.unavailable,
        })
      }),
    }),
  )

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Disposal must never mask the original error.
      }
    }
  }
}
