/**
 * Host API client.
 *
 * Every call is same-origin and unauthenticated by design: the host fenced the
 * routes behind an Origin/Host check, and the browser already carries whatever
 * session the shell established.
 *
 * Streaming uses `fetch` + `ReadableStream` rather than `EventSource`, because
 * `/ask` is a POST and EventSource cannot POST. Cancellation is two-sided: the
 * local `AbortController` frees the socket, and `POST /cancel` tells the host to
 * stop the model call (the two are idempotent together).
 */

import type {
  AskEvent,
  AskRequest,
  BootstrapResponse,
  ModelsResponse,
  ProviderModels,
  SideAskError,
  Thread,
  ThreadListEntry,
} from '../shared/contract.js'
import { ROUTE_PREFIX } from '../shared/contract.js'
import { makeError } from '../shared/errors.js'
import { SseDecoder, isTerminal } from './stream.js'

export interface AskOptions {
  request: Omit<AskRequest, 'apiVersion'>
  signal: AbortSignal
  onEvent: (event: AskEvent) => void
}

export interface HostApi {
  bootstrap(signal?: AbortSignal): Promise<BootstrapResponse>
  ask(options: AskOptions): Promise<void>
  cancel(requestId: string): Promise<boolean>
  listThreads(signal?: AbortSignal): Promise<ThreadListEntry[]>
  getThread(id: string, signal?: AbortSignal): Promise<Thread>
  createThread(sessionId: string | null, signal?: AbortSignal): Promise<Thread>
  deleteThread(id: string, signal?: AbortSignal): Promise<boolean>
  clearThreads(signal?: AbortSignal): Promise<number>
  /** Remove `fromMessageId` and everything after it (used by "regenerate"). */
  truncateThread(threadId: string, fromMessageId: string, signal?: AbortSignal): Promise<number>
  /** Provider/model catalog for the in-window model picker. */
  listModels(signal?: AbortSignal): Promise<ProviderModels[]>
}

async function readError(response: Response): Promise<SideAskError> {
  try {
    const text = await response.text()
    if (text.length > 0) {
      const parsed = JSON.parse(text) as { error?: SideAskError }
      if (parsed.error !== undefined) return parsed.error
    }
  } catch {
    // Fall through to a generic transport error.
  }
  return makeError('INTERNAL', `宿主返回 ${response.status}`)
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${ROUTE_PREFIX}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!response.ok) throw await readError(response)
  return (await response.json()) as T
}

export function createHostApi(): HostApi {
  return {
    async bootstrap(signal) {
      return requestJson<BootstrapResponse>('/bootstrap', signal === undefined ? {} : { signal })
    },

    async ask({ request, signal, onEvent }) {
      const body: AskRequest = { ...request, apiVersion: 1 }
      const response = await fetch(`${ROUTE_PREFIX}/ask`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      if (!response.ok) throw await readError(response)
      if (response.body === null) throw makeError('INTERNAL', '宿主没有返回流式响应')

      const reader = response.body.getReader()
      const textDecoder = new TextDecoder()
      const decoder = new SseDecoder()
      let finished = false

      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          const chunk = textDecoder.decode(value, { stream: true })
          for (const event of decoder.push(chunk)) {
            onEvent(event)
            if (isTerminal(event)) {
              finished = true
              return
            }
          }
        }
        for (const event of decoder.flush()) {
          onEvent(event)
          if (isTerminal(event)) finished = true
        }
        if (!finished) {
          onEvent({
            type: 'error',
            requestId: request.requestId,
            error: makeError('INTERNAL', '连接意外结束（未收到 done 事件）'),
          })
        }
      } catch (error) {
        // An abort is the user's own action: report it as cancellation, not a failure.
        if (signal.aborted) {
          onEvent({ type: 'error', requestId: request.requestId, error: makeError('ABORTED', '已停止') })
          return
        }
        onEvent({
          type: 'error',
          requestId: request.requestId,
          error: makeError('INTERNAL', error instanceof Error ? error.message : String(error)),
        })
      } finally {
        try {
          await reader.cancel()
        } catch {
          // Reader already closed.
        }
      }
    },

    async cancel(requestId) {
      try {
        const result = await requestJson<{ cancelled: boolean }>('/cancel', {
          method: 'POST',
          body: JSON.stringify({ requestId }),
        })
        return result.cancelled === true
      } catch {
        return false
      }
    },

    async listThreads(signal) {
      return requestJson<ThreadListEntry[]>('/threads', signal === undefined ? {} : { signal })
    },

    async getThread(id, signal) {
      return requestJson<Thread>(`/threads/${encodeURIComponent(id)}`, signal === undefined ? {} : { signal })
    },

    async createThread(sessionId, signal) {
      return requestJson<Thread>('/threads', {
        method: 'POST',
        body: JSON.stringify({ sessionId }),
        ...(signal === undefined ? {} : { signal }),
      })
    },

    async deleteThread(id, signal) {
      const result = await requestJson<{ deleted: boolean }>(`/threads/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        ...(signal === undefined ? {} : { signal }),
      })
      return result.deleted === true
    },

    async clearThreads(signal) {
      const result = await requestJson<{ cleared: number }>('/threads', {
        method: 'DELETE',
        ...(signal === undefined ? {} : { signal }),
      })
      return result.cleared ?? 0
    },

    async truncateThread(threadId, fromMessageId, signal) {
      const result = await requestJson<{ removed: number }>(`/threads/${encodeURIComponent(threadId)}/truncate`, {
        method: 'POST',
        body: JSON.stringify({ fromMessageId }),
        ...(signal === undefined ? {} : { signal }),
      })
      return result.removed ?? 0
    },

    async listModels(signal) {
      const result = await requestJson<ModelsResponse>('/models', {
        ...(signal === undefined ? {} : { signal }),
      })
      return Array.isArray(result.providers) ? result.providers : []
    },
  }
}
