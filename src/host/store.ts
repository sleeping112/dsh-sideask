/**
 * Thread persistence.
 *
 * Deliberately boring: one JSON file per DSH home under
 * `$DSH_HOME/storages/sideask/threads.json`, written with a temp-file rename
 * so a crash cannot leave a half-written file. No database, no network, no
 * cache to invalidate.
 *
 * Bounds are enforced here (not in the HTTP layer) so every caller — HTTP,
 * tests, a future CLI — gets the same guarantees:
 * - at most `maxThreads` threads (oldest dropped),
 * - at most `maxMessagesPerThread` messages per thread (oldest dropped).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Thread, ThreadListEntry, ThreadMessage } from '../shared/contract.js'

const SCHEMA = 1

export function resolveDshHome(): string {
  const fromEnv = process.env['DSH_HOME']
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

export function threadsFilePath(): string {
  return path.join(resolveDshHome(), 'storages', 'sideask', 'threads.json')
}

interface StoreFile {
  schema: number
  threads: Thread[]
}

export interface ThreadStoreLimits {
  maxThreads: number
  maxMessagesPerThread: number
}

function emptyThread(id: string, sessionId: string | null): Thread {
  const now = Date.now()
  return { id, title: '新旁问', createdAt: now, updatedAt: now, sessionId, messages: [] }
}

function sanitizeMessage(raw: unknown): ThreadMessage | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const role = record['role']
  const text = record['text']
  const id = record['id']
  if (role !== 'user' && role !== 'assistant') return null
  if (typeof text !== 'string' || typeof id !== 'string') return null
  const message: ThreadMessage = {
    id,
    role,
    text,
    createdAt: typeof record['createdAt'] === 'number' ? record['createdAt'] : Date.now(),
  }
  if (record['context'] !== undefined && record['context'] !== null) message.context = record['context'] as ThreadMessage['context']
  if (Array.isArray(record['citations'])) message.citations = record['citations'] as ThreadMessage['citations']
  if (record['error'] !== undefined && record['error'] !== null) message.error = record['error'] as ThreadMessage['error']
  if (typeof record['replyTo'] === 'string') message.replyTo = record['replyTo']
  return message
}

function sanitizeThread(raw: unknown): Thread | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const id = record['id']
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null
  const messages = Array.isArray(record['messages'])
    ? record['messages'].map(sanitizeMessage).filter((message): message is ThreadMessage => message !== null)
    : []
  const now = Date.now()
  return {
    id,
    title: typeof record['title'] === 'string' ? record['title'].slice(0, 200) : '新旁问',
    createdAt: typeof record['createdAt'] === 'number' ? record['createdAt'] : now,
    updatedAt: typeof record['updatedAt'] === 'number' ? record['updatedAt'] : now,
    sessionId: typeof record['sessionId'] === 'string' ? record['sessionId'] : null,
    messages,
  }
}

export class ThreadStore {
  private threads = new Map<string, Thread>()
  private dirty = false
  private timer: NodeJS.Timeout | null = null
  /** When false, history is memory-only: no load, no write (privacy switch). */
  private persistEnabled = true

  constructor(
    private readonly file: string,
    private limits: ThreadStoreLimits,
  ) {}

  /**
   * Turn disk persistence on/off. `persistHistory: false` must not write a
   * file at all — not even an empty one — so the switch is enforced here
   * rather than at the call sites.
   */
  setPersist(enabled: boolean): void {
    if (this.persistEnabled === enabled) return
    this.persistEnabled = enabled
    this.dirty = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Load from disk; a corrupt or absent file simply starts empty. */
  load(): void {
    this.threads.clear()
    if (!this.persistEnabled) return
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as StoreFile
      if (parsed === null || typeof parsed !== 'object' || parsed.schema !== SCHEMA) return
      if (!Array.isArray(parsed.threads)) return
      for (const candidate of parsed.threads) {
        const thread = sanitizeThread(candidate)
        if (thread !== null) this.threads.set(thread.id, thread)
      }
      this.enforceLimits()
    } catch {
      // Missing or corrupt: start empty, the next write repairs the file.
    }
  }

  setLimits(limits: ThreadStoreLimits): void {
    this.limits = limits
    if (this.enforceLimits()) this.scheduleFlush()
  }

  list(): ThreadListEntry[] {
    return [...this.threads.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((thread) => ({
        id: thread.id,
        title: thread.title,
        updatedAt: thread.updatedAt,
        messageCount: thread.messages.length,
      }))
  }

  get(id: string): Thread | null {
    const thread = this.threads.get(id)
    return thread === undefined ? null : structuredClone(thread)
  }

  has(id: string): boolean {
    return this.threads.has(id)
  }

  ensure(id: string, sessionId: string | null): Thread {
    const existing = this.threads.get(id)
    if (existing !== undefined) return structuredClone(existing)
    const thread = emptyThread(id, sessionId)
    this.threads.set(id, thread)
    this.enforceLimits()
    this.scheduleFlush()
    return structuredClone(thread)
  }

  create(sessionId: string | null): Thread {
    const id = newThreadId()
    return this.ensure(id, sessionId)
  }

  append(threadId: string, message: ThreadMessage): Thread | null {
    const thread = this.threads.get(threadId)
    if (thread === undefined) return null
    thread.messages.push(message)
    thread.updatedAt = Date.now()
    if (thread.title === '新旁问' && message.role === 'user') {
      thread.title = titleFrom(message.text)
    }
    while (thread.messages.length > this.limits.maxMessagesPerThread) thread.messages.shift()
    this.scheduleFlush()
    return structuredClone(thread)
  }

  rename(threadId: string, title: string): Thread | null {
    const thread = this.threads.get(threadId)
    if (thread === undefined) return null
    thread.title = titleFrom(title)
    thread.updatedAt = Date.now()
    this.scheduleFlush()
    return structuredClone(thread)
  }

  /**
   * Remove `fromMessageId` and every message after it.
   *
   * This is the "regenerate answer" primitive: the browser truncates back to the
   * question it wants re-asked and then posts a new /ask. Returns `null` for an
   * unknown thread so the HTTP layer can answer 404; an unknown *message* id is
   * not an error (`{removed: 0}`) because the client may race another tab.
   */
  truncate(threadId: string, fromMessageId: string): { removed: number } | null {
    const thread = this.threads.get(threadId)
    if (thread === undefined) return null
    const index = thread.messages.findIndex((message) => message.id === fromMessageId)
    if (index === -1) return { removed: 0 }
    const removed = thread.messages.length - index
    thread.messages.splice(index)
    thread.updatedAt = Date.now()
    this.scheduleFlush()
    return { removed }
  }

  /**
   * Copy the prefix of a thread (up to AND INCLUDING `fromMessageId`) into a
   * brand-new thread, leaving the source untouched.
   *
   * This is the "branch from here" primitive: the client keeps exploring in the
   * fork while the original exchange stays intact, so the user can compare two
   * lines of questioning side by side.
   *
   * Why message ids are regenerated: a message id is scoped to its thread, and
   * the client resolves `replyTo` into a question bubble. Reusing an id would
   * make an id in the fork address a message in the source, so every copied
   * message gets a fresh id and every `replyTo` that pointed *inside* the copied
   * prefix is remapped to the new id. A `replyTo` pointing outside the prefix
   * (only possible from corrupt history) is dropped rather than left dangling.
   *
   * Returns `null` for an unknown thread OR an unknown `fromMessageId`; unlike
   * truncate (a race-tolerant no-op) a fork cannot guess what to copy, so both
   * cases are surfaced as 404 by the HTTP layer.
   */
  fork(threadId: string, fromMessageId: string): Thread | null {
    const source = this.threads.get(threadId)
    if (source === undefined) return null
    const index = source.messages.findIndex((message) => message.id === fromMessageId)
    if (index === -1) return null

    const copied = source.messages.slice(0, index + 1)
    const idMap = new Map<string, string>()
    for (const message of copied) idMap.set(message.id, newMessageId())

    const now = Date.now()
    const messages = copied.map((message): ThreadMessage => {
      const next: ThreadMessage = {
        id: idMap.get(message.id) ?? newMessageId(),
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
      }
      // Deep-copy the optional payloads: a fork must never share mutable
      // structure with its source, or editing one would silently edit both.
      if (message.context !== undefined) next.context = structuredClone(message.context)
      if (message.citations !== undefined) next.citations = structuredClone(message.citations)
      if (message.error !== undefined) next.error = structuredClone(message.error)
      if (typeof message.replyTo === 'string') {
        const remapped = idMap.get(message.replyTo)
        if (remapped !== undefined) next.replyTo = remapped
      }
      return next
    })

    const forked: Thread = {
      id: newThreadId(),
      title: forkTitle(source.title),
      createdAt: now,
      updatedAt: now,
      sessionId: source.sessionId,
      messages,
    }
    this.threads.set(forked.id, forked)
    // Adding a thread can push the store over `maxThreads`: the oldest threads
    // (by updatedAt, i.e. not the brand-new fork) are trimmed exactly as on any
    // other write, so the limit cannot be bypassed through fork.
    this.enforceLimits()
    this.scheduleFlush()
    return structuredClone(forked)
  }

  remove(threadId: string): boolean {
    const removed = this.threads.delete(threadId)
    if (removed) this.scheduleFlush()
    return removed
  }

  clear(): number {
    const count = this.threads.size
    this.threads.clear()
    this.scheduleFlush()
    return count
  }

  /** Force an immediate write (tests, shutdown). */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty) return
    this.dirty = false
    if (!this.persistEnabled) return
    // `persistHistory: false` callers keep state in memory only; nothing below
    // touches the filesystem in that mode.
    const payload: StoreFile = { schema: SCHEMA, threads: [...this.threads.values()] }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8')
      fs.renameSync(temporary, this.file)
    } catch {
      // Disk full / read-only home: history is a convenience, not a correctness
      // requirement. The in-memory state keeps working for this session.
    }
  }

  dispose(): void {
    this.flush()
  }

  private scheduleFlush(): void {
    this.dirty = true
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, 400)
    this.timer.unref?.()
  }

  private enforceLimits(): boolean {
    let changed = false
    const ordered = [...this.threads.values()].sort((left, right) => right.updatedAt - left.updatedAt)
    for (let index = this.limits.maxThreads; index < ordered.length; index += 1) {
      const thread = ordered[index]
      if (thread !== undefined) {
        this.threads.delete(thread.id)
        changed = true
      }
    }
    for (const thread of this.threads.values()) {
      while (thread.messages.length > this.limits.maxMessagesPerThread) {
        thread.messages.shift()
        changed = true
      }
    }
    return changed
  }
}

function newThreadId(): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `sa_${Date.now().toString(36)}_${random}`
}

/** Fresh message id. Kept random+suffixed because the store tolerates time travel. */
function newMessageId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Fork title: original + a visible marker, capped at 80 characters.
 *
 * The suffix matters more than the original title (it is what distinguishes the
 * branch in the thread list), so the base is cut to leave room for it instead of
 * slicing the composed string and losing the marker on long titles.
 */
function forkTitle(title: string): string {
  const suffix = ' · 分叉'
  const base = title.trim().length === 0 ? '新旁问' : title
  return `${base.slice(0, Math.max(0, 80 - suffix.length))}${suffix}`
}

function titleFrom(text: string): string {
  const flattened = text.replace(/\s+/g, ' ').trim()
  if (flattened.length === 0) return '新旁问'
  return flattened.length <= 40 ? flattened : `${flattened.slice(0, 39)}…`
}
