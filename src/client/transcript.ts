/**
 * Transcript projection — pure, DOM-free.
 *
 * Turns the session's raw event window into the small `ChatMessage[]` the
 * context engine consumes. Rules that matter for privacy and cost:
 *
 * - only events a user can SEE become context (`user/message`,
 *   `assistant/message`);
 * - only `type: 'text'` content blocks are read: hidden reasoning, tool
 *   arguments, attachments and images never leave the page as "context";
 * - structural events (turn/step markers, compaction checkpoints, approvals)
 *   are skipped;
 * - the projection is iterative and idempotent, so an incremental refresh can
 *   re-map only entries whose content hash changed.
 */

import type { ChatMessage } from '../shared/contract.js'

/** One entry from `eventSource.getSnapshot().entries` (shape kept permissive). */
export interface SessionEntry {
  event?: {
    type?: string
    data?: unknown
    seq?: number
    time?: number
  }
}

interface ContentBlock {
  type?: string
  text?: string
}

/** Join the visible text blocks of one content array. */
export function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : ''
  }
  const parts: string[] = []
  for (const block of content as ContentBlock[]) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/** Map ONE session entry to a chat message, or null when it is not visible text. */
export function entryToMessage(entry: SessionEntry): ChatMessage | null {
  if (entry === null || typeof entry !== 'object') return null
  const event = entry.event
  if (event === undefined || event === null || typeof event !== 'object' || typeof event.type !== 'string') return null
  const data = (event.data ?? {}) as Record<string, unknown>
  const createdAt = typeof event.time === 'number' ? event.time : undefined

  if (event.type === 'user/message') {
    const text = textOfContent(data['content'])
    const id = data['id']
    if (text.length === 0 || typeof id !== 'string') return null
    return { id, role: 'user', text, ...(createdAt === undefined ? {} : { createdAt }) }
  }

  if (event.type === 'assistant/message') {
    const message = (data['message'] ?? {}) as Record<string, unknown>
    const text = textOfContent(message['content'])
    const id = message['id'] ?? data['id']
    if (text.length === 0 || typeof id !== 'string') return null
    return { id, role: 'assistant', text, ...(createdAt === undefined ? {} : { createdAt }) }
  }

  if (event.type === 'developer/message') {
    const text = textOfContent(data['content'])
    if (text.length === 0) return null
    return { id: typeof data['id'] === 'string' ? data['id'] : `developer-${String(event.seq ?? '')}`, role: 'developer', text }
  }

  return null
}

/** Map a whole window, preserving chronological order and dropping empties. */
export function entriesToMessages(entries: unknown): ChatMessage[] {
  if (!Array.isArray(entries)) return []
  const messages: ChatMessage[] = []
  const seen = new Set<string>()
  for (const entry of entries as SessionEntry[]) {
    if (entry === null || typeof entry !== 'object') continue
    const message = entryToMessage(entry)
    if (message === null || seen.has(message.id)) continue
    seen.add(message.id)
    messages.push(message)
  }
  return messages
}

export interface IncrementalProjection {
  messages: ChatMessage[]
  /** Ids whose projection was recomputed on this pass. */
  changedIds: string[]
  /** Ids dropped because they are no longer in the window. */
  removedIds: string[]
}

/**
 * Incremental re-projection.
 *
 * `cache` maps message id → the small record we keep for the extraction layer:
 * `{hash, message}`. Only entries whose content hash differs are re-mapped; the
 * caller keeps the `ProjectionCache` (redaction + tokens) keyed by the same id,
 * so one new message costs one mapping + one projection, not a full re-read.
 */
export function projectIncrementally(
  entries: unknown,
  cache: Map<string, { hash: string; message: ChatMessage }>,
): IncrementalProjection {
  const messages = entriesToMessages(entries)
  const changes: string[] = []
  const nextCache = new Map<string, { hash: string; message: ChatMessage }>()

  for (const message of messages) {
    const hash = hashMessage(message)
    const cached = cache.get(message.id)
    nextCache.set(message.id, { hash, message })
    if (cached === undefined || cached.hash !== hash) changes.push(message.id)
  }

  const removedIds: string[] = []
  for (const id of cache.keys()) if (!nextCache.has(id)) removedIds.push(id)

  cache.clear()
  for (const [id, value] of nextCache) cache.set(id, value)
  return { messages, changedIds: changes, removedIds }
}

/** Cheap stable hash of the fields that affect the projection. */
export function hashMessage(message: ChatMessage): string {
  const key = `${message.id}\u0000${message.role}\u0000${message.text}`
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}
