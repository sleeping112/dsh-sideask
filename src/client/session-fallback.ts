/**
 * Session fallback selection — pick which conversation the side chat binds to
 * when the session probe never fired.
 *
 * The old fallback blindly took `sessions.list().ids[0]`, which binds whatever
 * happens to sort first (often a blank scratch session) instead of the
 * conversation the user is actually looking at. This module is the pure,
 * DOM-free decision: given a session-catalog snapshot, choose the most recently
 * updated VISIBLE session, preferring the one retained by the main view.
 *
 * It never guesses: an empty catalog, or one made only of blank sessions,
 * yields `null`, and the caller leaves the side chat unbound.
 */

/** The row fields this decision needs; shape kept permissive on purpose. */
export interface SessionRowLike {
  blank?: boolean
  running?: boolean
  updatedAt?: number
  retainedBy?: { mainView?: number }
}

/** Shape of the client session-catalog snapshot. */
export interface SessionListSnapshotLike {
  ids: string[]
  byId?: Record<string, SessionRowLike>
}

interface Candidate {
  id: string
  updatedAt: number
  retainedByMainView: boolean
}

function isRow(value: unknown): value is SessionRowLike {
  return value !== null && typeof value === 'object'
}

function recordOf(value: unknown): Record<string, SessionRowLike> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, SessionRowLike>) : undefined
}

/** Numeric timestamp, or 0 when absent/invalid (missing sorts last). */
function updatedAtOf(row: SessionRowLike | undefined): number {
  if (row === undefined) return 0
  const value = row.updatedAt
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Choose the session the side chat should adopt.
 *
 * Rules, in order:
 * 1. null/empty snapshot → `null`;
 * 2. drop ids whose row is `blank === true`;
 * 3. prefer rows retained by the main view (`retainedBy.mainView > 0`), taking
 *    the largest `updatedAt` among them;
 * 4. otherwise take the largest `updatedAt` among the remaining rows;
 * 5. nothing usable → `null` (never guess).
 *
 * Rows missing from `byId` count as non-blank with `updatedAt: 0`. Ties keep
 * the earliest id in snapshot order, so the result is deterministic.
 */
export function pickFallbackSession(
  snapshot: SessionListSnapshotLike | null | undefined,
): { id: string } | null {
  if (snapshot === null || snapshot === undefined || typeof snapshot !== 'object') return null
  const ids = snapshot.ids
  if (!Array.isArray(ids)) return null
  const byId = recordOf(snapshot.byId)

  const candidates: Candidate[] = []
  for (const rawId of ids) {
    if (typeof rawId !== 'string' || rawId.length === 0) continue
    const rawRow: unknown = byId === undefined ? undefined : byId[rawId]
    const row = isRow(rawRow) ? rawRow : undefined
    if (row !== undefined && row.blank === true) continue
    const mainView = row?.retainedBy?.mainView
    candidates.push({
      id: rawId,
      updatedAt: updatedAtOf(row),
      retainedByMainView: typeof mainView === 'number' && mainView > 0,
    })
  }
  if (candidates.length === 0) return null

  const retained = candidates.filter((candidate) => candidate.retainedByMainView)
  const pool = retained.length > 0 ? retained : candidates
  let best: Candidate | null = null
  for (const candidate of pool) {
    if (best === null || candidate.updatedAt > best.updatedAt) best = candidate
  }
  return best === null ? null : { id: best.id }
}
