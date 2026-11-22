/**
 * Selection affordance: a small "旁问" button next to the current text selection.
 *
 * Why not use the host's `conversation.chat.text-interaction` slot? That slot is
 * KEYED and the chat shell renders only the key of the interaction that called
 * `request.open()` (`ui-chat/lib/client.js:3683-3688`); the official quote plugin
 * opens first, so a second plugin cannot contribute a button there. Instead this
 * component listens to DOM selection itself and shows its own floating button.
 *
 * It is deliberately cooperative: it never steals the selection, never calls into
 * the host's interaction dispatch, and hides itself while our own window has
 * focus. Clicking it captures the text as the highest-priority context and opens
 * the side thread.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { SideAskStore } from './store.js'

export interface SelectionActionProps {
  store: SideAskStore
}

/** The body-level container that owns our shadow root. */
function currentHost(): Element | null {
  try {
    return document.querySelector('[data-sideask-host]')
  } catch {
    return null
  }
}

interface Anchor {
  text: string
  x: number
  y: number
}

const MIN_SELECTION_CHARS = 1
const SETTLE_MS = 140
const BUTTON_WIDTH = 62
const BUTTON_HEIGHT = 28
const EDGE_GAP = 8

function selectionAnchor(host: Element | null): Anchor | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  const selection = document.getSelection()
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null
  const text = selection.toString().replace(/\s+/g, ' ').trim()
  if (text.length < MIN_SELECTION_CHARS) return null

  // Never react to a selection inside our own window.
  if (host !== null) {
    const anchorNode = selection.anchorNode
    const focusNode = selection.focusNode
    const insideHost = (node: Node | null): boolean => {
      if (node === null) return false
      if (host.contains(node)) return true
      const root = host.shadowRoot
      return root !== null && root.contains(node)
    }
    if (insideHost(anchorNode) || insideHost(focusNode)) return null
  }

  let rect: DOMRect | null = null
  try {
    rect = selection.getRangeAt(0).getBoundingClientRect()
  } catch {
    rect = null
  }
  if (rect === null || (rect.width === 0 && rect.height === 0)) return null

  const x = Math.min(
    Math.max(EDGE_GAP, rect.right - BUTTON_WIDTH / 2),
    window.innerWidth - BUTTON_WIDTH - EDGE_GAP,
  )
  const y = Math.min(
    Math.max(EDGE_GAP, rect.bottom + 6),
    window.innerHeight - BUTTON_HEIGHT - EDGE_GAP,
  )
  return { text, x: Math.round(x), y: Math.round(y) }
}

export function SelectionAction({ store }: SelectionActionProps): React.ReactElement | null {
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const timer = useRef<number | null>(null)

  const evaluate = useCallback((): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    timer.current = window.setTimeout(() => {
      timer.current = null
      try {
        setAnchor(selectionAnchor(currentHost()))
      } catch {
        setAnchor(null)
      }
    }, SETTLE_MS)
  }, [])

  useEffect(() => {
    const onSelectionChange = (): void => evaluate()
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      const host = currentHost()
      if (host !== null && target !== null && (host.contains(target) || host.shadowRoot?.contains(target) === true)) {
        return
      }
      setAnchor(null)
    }
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('pointerup', onSelectionChange, true)
    document.addEventListener('keyup', onSelectionChange, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('scroll', evaluate, true)
    window.addEventListener('resize', evaluate)
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('pointerup', onSelectionChange, true)
      document.removeEventListener('keyup', onSelectionChange, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', evaluate, true)
      window.removeEventListener('resize', evaluate)
    }
  }, [evaluate])

  // Hide when the anchor goes off-screen after a resize.
  useLayoutEffect(() => {
    if (anchor === null) return
    if (anchor.x > window.innerWidth - 20 || anchor.y > window.innerHeight - 20) setAnchor(null)
  }, [anchor])

  if (anchor === null) return null

  return (
    <button
      type="button"
      className="sa-selbtn"
      data-testid="sideask-selection-action"
      style={{ left: anchor.x, top: anchor.y }}
      title="把选中的内容作为上下文，在旁问中讨论"
      // mousedown would clear the selection; keep the selection alive until click.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        store.setSelection({ text: anchor.text, ...(store.getSnapshot().sessionId === null ? {} : { sessionId: store.getSnapshot().sessionId ?? undefined }) })
        store.setOpen(true)
        setAnchor(null)
        try {
          document.getSelection()?.removeAllRanges()
        } catch {
          // Selection already gone.
        }
      }}
    >
      旁问
    </button>
  )
}
