/**
 * SSE decoding and answer-stream reduction — pure, DOM-free.
 *
 * The host answers `POST /ask` with `text/event-stream`, one JSON event per
 * `data:` line, and always ends with exactly one `done` or `error`. This module
 * owns everything that is finicky about that:
 * - frames can be split across network chunks, so the decoder buffers;
 * - a malformed frame is skipped instead of killing the stream;
 * - the reducer is monotone: text only grows, terminal states are sticky.
 */

import type { AskEvent, Citation, SideAskError } from '../shared/contract.js'

export type StreamStatus = 'idle' | 'streaming' | 'done' | 'error'

export interface AnswerState {
  status: StreamStatus
  requestId: string | null
  text: string
  citations: Citation[]
  error: SideAskError | null
  mode: 'context' | 'question-only' | null
  promptTokens: number
  completionTokens: number
}

export function initialAnswer(): AnswerState {
  return {
    status: 'idle',
    requestId: null,
    text: '',
    citations: [],
    error: null,
    mode: null,
    promptTokens: 0,
    completionTokens: 0,
  }
}

/** Incremental `data:` frame decoder. Keeps the unfinished tail in `rest`. */
export class SseDecoder {
  private buffer = ''

  push(chunk: string): AskEvent[] {
    this.buffer += chunk
    const events: AskEvent[] = []
    let boundary = this.buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const event = decodeFrame(frame)
      if (event !== null) events.push(event)
      boundary = this.buffer.indexOf('\n\n')
    }
    return events
  }

  /** Drain the tail (a server that closes without a trailing blank line). */
  flush(): AskEvent[] {
    const tail = this.buffer.trim()
    this.buffer = ''
    if (tail.length === 0) return []
    const event = decodeFrame(tail)
    return event === null ? [] : [event]
  }

  get pending(): string {
    return this.buffer
  }
}

/** Decode one SSE frame; returns null for comments, heartbeats, bad JSON. */
export function decodeFrame(frame: string): AskEvent | null {
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload.length === 0) continue
    try {
      const parsed = JSON.parse(payload) as unknown
      if (parsed === null || typeof parsed !== 'object') return null
      const type = (parsed as Record<string, unknown>)['type']
      if (typeof type !== 'string') return null
      return parsed as AskEvent
    } catch {
      return null
    }
  }
  return null
}

/**
 * Apply one event to the answer state.
 *
 * `delta` events are appended as-is. A `done` event replaces the text with the
 * authoritative final text (the model output minus the citation block), which
 * keeps the rendered answer identical to what was stored on the host.
 */
export function reduceAnswer(state: AnswerState, event: AskEvent): AnswerState {
  switch (event.type) {
    case 'accepted':
      return { ...initialAnswer(), status: 'streaming', requestId: event.requestId, mode: event.mode }
    case 'settings':
      return state
    case 'delta':
      return state.status === 'streaming' || state.status === 'idle'
        ? { ...state, status: 'streaming', text: state.text + event.text }
        : state
    case 'usage':
      return { ...state, promptTokens: event.promptTokens, completionTokens: event.completionTokens }
    case 'done':
      return {
        ...state,
        status: 'done',
        text: event.text.length > 0 ? event.text : state.text,
        citations: event.citations,
        error: null,
      }
    case 'error':
      return { ...state, status: 'error', error: event.error, mode: state.mode }
    default:
      return state
  }
}

/** True when the stream has reached a terminal event. */
export function isTerminal(event: AskEvent): boolean {
  return event.type === 'done' || event.type === 'error'
}

/** Merge incoming citations with already-rendered ones (stable by ref). */
export function mergeCitations(existing: Citation[], incoming: Citation[]): Citation[] {
  const byRef = new Map(existing.map((citation) => [citation.ref, citation]))
  for (const citation of incoming) byRef.set(citation.ref, citation)
  return [...byRef.values()]
}
