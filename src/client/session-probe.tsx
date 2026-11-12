/**
 * Session probe — the answer to "which conversation am I beside?".
 *
 * The client has no single documented "current session" service (this is the
 * known integration gap), so the plugin contributes a zero-height component to
 * a SESSION-SCOPED slot and reads the bound session from the standard props the
 * slot framework passes down. When the user switches conversations this
 * component unmounts/remounts, which is exactly the signal we need.
 *
 * Every lookup is defensive (props shape is not part of a stable contract here):
 * `sessionId` → `binding.sessionId` → `session.id` → `useSession()` hook. If none
 * exist the probe does nothing and the store falls back to `sessions.list()`.
 */

import { useEffect } from 'react'

import type { SideAskStore } from './store.js'

export interface ProbeProps {
  store: SideAskStore
  [key: string]: unknown
}

function pickSessionId(props: ProbeProps): string | null {
  const direct = props['sessionId']
  if (typeof direct === 'string' && direct.length > 0) return direct

  const binding = props['binding'] as { sessionId?: unknown } | undefined
  if (binding !== undefined && typeof binding.sessionId === 'string' && binding.sessionId.length > 0) {
    return binding.sessionId
  }

  const session = props['session'] as { id?: unknown } | undefined
  if (session !== undefined && typeof session.id === 'string' && session.id.length > 0) return session.id

  const useSession = props['useSession']
  if (typeof useSession === 'function') {
    try {
      const value = (useSession as () => unknown)()
      const record = value as { sessionId?: unknown; id?: unknown; session?: { id?: unknown } } | null
      if (record !== null && typeof record === 'object') {
        if (typeof record.sessionId === 'string' && record.sessionId.length > 0) return record.sessionId
        if (typeof record.id === 'string' && record.id.length > 0) return record.id
        if (typeof record.session?.id === 'string' && record.session.id.length > 0) return record.session.id
      }
    } catch {
      // Hook called outside its scope: ignore.
    }
  }
  return null
}

function pickTitle(props: ProbeProps): string | undefined {
  const session = props['session'] as { displayTitle?: unknown; title?: unknown } | undefined
  if (session !== undefined) {
    if (typeof session.displayTitle === 'string' && session.displayTitle.length > 0) return session.displayTitle
    if (typeof session.title === 'string' && session.title.length > 0) return session.title
  }
  const binding = props['binding'] as { session?: { displayTitle?: unknown; title?: unknown } } | undefined
  const inner = binding?.session
  if (inner !== undefined) {
    if (typeof inner.displayTitle === 'string' && inner.displayTitle.length > 0) return inner.displayTitle
    if (typeof inner.title === 'string' && inner.title.length > 0) return inner.title
  }
  return undefined
}

/**
 * Renders nothing. Its only job is to report the bound session on mount and to
 * hand the already-retained binding to the context source (avoiding a second
 * retain round-trip).
 */
export function SessionProbe(props: ProbeProps): null {
  const store = props.store
  const sessionId = pickSessionId(props)
  const title = pickTitle(props)

  useEffect(() => {
    if (sessionId === null) return
    void store.setSession(sessionId, title)
    // `store` is stable for the plugin lifetime; sessionId/title drive the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, title])

  return null
}
