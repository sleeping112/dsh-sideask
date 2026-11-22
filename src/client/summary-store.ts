/**
 * Persisted summary cache.
 *
 * Summaries are keyed by the exact overflowing message-id set, so a stale entry
 * can never be injected into the wrong context. Persisting them means a page
 * reload (very common in the web shell) does not force a re-summarisation of the
 * same history.
 *
 * Bounded on purpose: at most `MAX_SUMMARY_SESSIONS` sessions, each with
 * `MAX_SUMMARIES_PER_SESSION` entries of `MAX_SUMMARY_CHARS` characters.
 */

export const SUMMARY_STORAGE_KEY = 'dsh-sideask.summary.v1'
export const MAX_SUMMARY_SESSIONS = 3
export const MAX_SUMMARIES_PER_SESSION = 8
export const MAX_SUMMARY_CHARS = 4000

export type SessionSummaries = Record<string, string>
export type SummaryStore = Record<string, SessionSummaries>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse persisted summaries; any malformed shape degrades to an empty store. */
export function loadSummaryStore(raw: string | null | undefined): SummaryStore {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) return {}
    const store: SummaryStore = {}
    for (const [sessionId, entries] of Object.entries(parsed)) {
      if (sessionId.length === 0 || sessionId.length > 200 || !isRecord(entries)) continue
      const clean: SessionSummaries = {}
      for (const [key, text] of Object.entries(entries)) {
        if (key.length === 0 || key.length > 200) continue
        if (typeof text !== 'string' || text.trim().length === 0) continue
        clean[key] = text.slice(0, MAX_SUMMARY_CHARS)
      }
      if (Object.keys(clean).length > 0) store[sessionId] = clean
    }
    // Keep only the newest N sessions (insertion order = recency).
    const sessions = Object.keys(store)
    for (const stale of sessions.slice(0, Math.max(0, sessions.length - MAX_SUMMARY_SESSIONS))) delete store[stale]
    return store
  } catch {
    return {}
  }
}

/** Serialise the store, dropping anything that would exceed the caps. */
export function saveSummaryStore(store: SummaryStore): string {
  const sessions = Object.keys(store).slice(-MAX_SUMMARY_SESSIONS)
  const out: SummaryStore = {}
  for (const sessionId of sessions) {
    const entries = store[sessionId] ?? {}
    const keys = Object.keys(entries).slice(-MAX_SUMMARIES_PER_SESSION)
    const clean: SessionSummaries = {}
    for (const key of keys) {
      const text = entries[key]
      if (key.length === 0 || typeof text !== 'string' || text.trim().length === 0) continue
      clean[key] = text.slice(0, MAX_SUMMARY_CHARS)
    }
    if (Object.keys(clean).length > 0) out[sessionId] = clean
  }
  return JSON.stringify(out)
}

/** Fetch the cache for one session (empty object when absent). */
export function getSessionSummaries(store: SummaryStore, sessionId: string): SessionSummaries {
  return { ...(store[sessionId] ?? {}) }
}

/** Return a NEW store with one summary added (oldest entry evicted first). */
export function putSessionSummary(store: SummaryStore, sessionId: string, key: string, text: string): SummaryStore {
  if (sessionId.length === 0 || key.length === 0) return store
  const trimmed = text.trim()
  if (trimmed.length === 0) return store
  const next: SummaryStore = { ...store }
  // Refresh recency: delete then re-insert so this session becomes the newest.
  delete next[sessionId]
  const entries: SessionSummaries = { ...(store[sessionId] ?? {}) }
  delete entries[key]
  entries[key] = trimmed.slice(0, MAX_SUMMARY_CHARS)
  const keys = Object.keys(entries)
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_SUMMARIES_PER_SESSION))) delete entries[stale]
  next[sessionId] = entries
  const sessions = Object.keys(next)
  for (const stale of sessions.slice(0, Math.max(0, sessions.length - MAX_SUMMARY_SESSIONS))) delete next[stale]
  return next
}
