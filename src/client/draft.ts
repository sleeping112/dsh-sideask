/**
 * Per-thread draft persistence.
 *
 * Each side thread keeps its own composer draft (the reference product behaves
 * this way too). Drafts live in localStorage only: they are UI state, not
 * conversation content, so they never reach the host and never touch the main
 * chat.
 *
 * Pure helpers so the parsing/limits are unit-testable without a DOM.
 */

export const DRAFT_STORAGE_KEY = 'dsh-sideask.draft.v2'
/** Key used while no thread exists yet (first question, or after delete). */
export const NEW_THREAD_DRAFT_KEY = '__new__'
export const MAX_DRAFTS = 40
export const MAX_DRAFT_CHARS = 8000

export type DraftMap = Record<string, string>

/** Stable storage key for a thread (null => the "new thread" slot). */
export function draftKey(threadId: string | null | undefined): string {
  return threadId !== null && threadId !== undefined && threadId.length > 0 ? threadId : NEW_THREAD_DRAFT_KEY
}

/** Parse a persisted draft map; corrupt input degrades to empty. */
export function loadDrafts(raw: string | null | undefined): DraftMap {
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const drafts: DraftMap = {}
    let count = 0
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (count >= MAX_DRAFTS) break
      if (typeof key !== 'string' || key.length === 0 || key.length > 200) continue
      if (typeof value !== 'string' || value.length === 0) continue
      drafts[key] = value.slice(0, MAX_DRAFT_CHARS)
      count += 1
    }
    return drafts
  } catch {
    return {}
  }
}

/** Serialize a draft map, dropping empty drafts so storage cannot grow. */
export function saveDrafts(drafts: DraftMap): string {
  const entries = Object.entries(drafts)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .slice(0, MAX_DRAFTS)
    .map(([key, value]) => [key, value.slice(0, MAX_DRAFT_CHARS)] as const)
  return JSON.stringify(Object.fromEntries(entries))
}

/** Read one draft, trimmed to the cap (empty string when absent). */
export function getDraft(drafts: DraftMap, threadId: string | null | undefined): string {
  return drafts[draftKey(threadId)] ?? ''
}

/** Return a new map with one draft set (empty text deletes the entry). */
export function setDraft(drafts: DraftMap, threadId: string | null | undefined, text: string): DraftMap {
  const key = draftKey(threadId)
  const next: DraftMap = { ...drafts }
  if (text.length === 0) delete next[key]
  else next[key] = text.slice(0, MAX_DRAFT_CHARS)
  return next
}
