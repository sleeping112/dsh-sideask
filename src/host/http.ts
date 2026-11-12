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

import type { AskEvent, BootstrapResponse, SideAskError, Thread, ThreadListEntry } from '../shared/contract.js'
import { ROUTE_PREFIX } from '../shared/contract.js'
import { makeError } from '../shared/errors.js'
import type { HostContext, SideAskRuntime } from './runtime.js'

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
 * Extract a thread id from `/plugins/dsh-sideask/api/threads/<id>`.
 *
 * The id-scoped routes are registered under a SLASH-LESS prefix because the
 * host web server matches a prefix route as
 * `pathname === prefix || pathname.startsWith(prefix + '/')`; a prefix that
 * already ends in `/` could never match `.../threads/<id>` (it would require a
 * double slash). Shipped host prefixes are slash-less for exactly this reason.
 */
function threadIdFromPath(pathname: string): string | null {
  const prefix = `${ROUTE_PREFIX}/threads/`
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  if (rest.length === 0 || rest.includes('/')) return null
  try {
    return decodeURIComponent(rest)
  } catch {
    return null
  }
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
    const id = threadIdFromPath(pathname)

    if (id === null) {
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

  const disposers: (() => void)[] = []
  const guard = (handler: (req: NodeRequest, res: NodeResponse) => void) => (req: NodeRequest, res: NodeResponse): void => {
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
      path: `${ROUTE_PREFIX}/ask`,
      handler: guard((req, res) => {
        void handleAsk(runtime, req, res)
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
