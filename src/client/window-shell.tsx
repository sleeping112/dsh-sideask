/**
 * Floating window shell + Shadow DOM mount.
 *
 * Two responsibilities, deliberately separated:
 * 1. `ShadowHost` lives in the DSH `shell.overlay` slot. It renders a single
 *    zero-size host element, attaches an OPEN shadow root, injects the plugin CSS
 *    INSIDE that root, and mounts a second React root into it. Result: the
 *    host page never sees our class names, and our styles never leak out.
 *    If that throws (no Shadow DOM support / createRoot rejects), it falls back
 *    to light DOM with the same `sa-` prefixed classes.
 * 2. `WindowShell` is the actual window chrome: drag, snap, resize, minimize,
 *    collapse, position memory. All geometry maths is delegated to the pure
 *    `window-state` module so it stays unit-testable.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ContextSource } from './context-source.js'
import { ContextPanel } from './context-panel.js'
import type { SideAskStore, UiState } from './store.js'
import { PANEL_CSS } from './styles.js'
import { ThreadView } from './thread-view.js'
import type { ConversationService } from './types.js'
import {
  WINDOW_STORAGE_KEY,
  applyDrag,
  applyResize,
  clampOffset,
  computePosition,
  defaultState,
  focusOnly,
  fromPosition,
  release,
  restore,
  serialize,
  toggleCollapsed,
  toggleMinimized,
  type Point,
  type WindowState,
  type Viewport,
} from './window-state.js'

export interface ShellProps {
  store: SideAskStore
  conversation: ConversationService | undefined
  contextSource: ContextSource
}

function viewportOf(): Viewport {
  if (typeof window === 'undefined') return { width: 1280, height: 800 }
  return { width: window.innerWidth, height: window.innerHeight }
}

function loadWindow(fallbackCorner: UiState['settings']['defaultCorner']): WindowState {
  try {
    return restore(window.localStorage.getItem(WINDOW_STORAGE_KEY), viewportOf(), fallbackCorner)
  } catch {
    return clampOffset(defaultState(fallbackCorner), viewportOf())
  }
}

function saveWindow(state: WindowState): void {
  try {
    window.localStorage.setItem(WINDOW_STORAGE_KEY, serialize(state))
  } catch {
    // Private mode / quota: the window simply forgets its position.
  }
}

/** Drag/resize/minimize chrome. Subscribes to the store itself so the nested
 * React root created inside the shadow root stays live. */
function WindowShell({ store, conversation, contextSource }: ShellProps): React.ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const settings = state.settings
  const [geometry, setGeometry] = useState<WindowState>(() => loadWindow(settings.defaultCorner))
  const [dragging, setDragging] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const dragRef = useRef<{ start: Point; origin: WindowState } | null>(null)
  const resizeRef = useRef<{ start: Point; left: number; top: number } | null>(null)

  // Persist geometry whenever it settles (cheap: one small localStorage write).
  useEffect(() => {
    saveWindow(geometry)
  }, [geometry])

  // Keep the window inside the viewport on resize/orientation change.
  useEffect(() => {
    const onResize = (): void => {
      setGeometry((current) => clampOffset(current, viewportOf()))
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
    }
  }, [])

  const onHeadPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      const target = event.target as HTMLElement
      if (target.closest('button') !== null || target.closest('input') !== null) return
      const viewport = viewportOf()
      const origin = geometry
      const position = computePosition(origin, viewport)
      dragRef.current = { start: { x: event.clientX, y: event.clientY }, origin }
      setDragging(true)
      event.currentTarget.setPointerCapture(event.pointerId)
      // Cache the origin position for the drag maths.
      resizeRef.current = null
      setGeometry((current) => fromPosition(current, position.left, position.top, viewport, current.corner))
    },
    [geometry],
  )

  const onHeadPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (drag === null) return
      const viewport = viewportOf()
      const position = computePosition(drag.origin, viewport)
      const next = applyDrag(
        drag.origin,
        { x: position.left, y: position.top },
        { x: event.clientX - drag.start.x, y: event.clientY - drag.start.y },
        viewport,
      )
      setGeometry(next)
    },
    [],
  )

  const onHeadPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      dragRef.current = null
      setDragging(false)
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // Pointer capture may already be released.
      }
      if (drag === null) return
      const viewport = viewportOf()
      const position = computePosition(geometry, viewport)
      setGeometry(release(drag.origin, position.left, position.top, viewport))
    },
    [geometry],
  )

  const onResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.stopPropagation()
      const viewport = viewportOf()
      const position = computePosition(geometry, viewport)
      resizeRef.current = { start: { x: event.clientX, y: event.clientY }, left: position.left, top: position.top }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [geometry],
  )

  const onResizePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current
    if (resize === null) return
    const viewport = viewportOf()
    setGeometry((current) =>
      applyResize(
        current,
        resize.left,
        resize.top,
        { x: event.clientX - resize.start.x, y: event.clientY - resize.start.y },
        viewport,
      ),
    )
  }, [])

  const onResizePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    resizeRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Ignore.
    }
  }, [])

  const viewport = viewportOf()
  const position = computePosition(geometry, viewport)
  const streaming = state.answer.status === 'streaming'
  const sessionLabel =
    state.sessionId === null ? '未绑定对话' : state.sessionTitle ?? `对话 ${state.sessionId.slice(0, 8)}`

  // Closed (or minimized): the floating entrance pill. Everything else about the
  // thread is preserved, so reopening never loses the conversation.
  if (!state.open || geometry.minimized) {
    return (
      <div className="sa-root">
        <div
          className="sa-pill"
          style={{ right: 18, bottom: 18 }}
          data-testid="sideask-pill"
          onClick={() => {
            store.setOpen(true)
            setGeometry((current) => focusOnly(current))
          }}
          title={`${sessionLabel} · 点击展开（${settings.hotkey}）`}
        >
          <span className="sa-dot" data-busy={streaming} />
          旁问
          {state.threads.length > 0 ? <span style={{ opacity: 0.6 }}>·{state.threads.length}</span> : null}
        </div>
      </div>
    )
  }

  return (
    <div className="sa-root">
      <div
        className="sa-window"
        style={{ left: position.left, top: position.top, width: geometry.width, height: geometry.height }}
        data-testid="sideask-window"
        data-collapsed={geometry.collapsed}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div
          className="sa-head"
          data-dragging={dragging}
          onPointerDown={onHeadPointerDown}
          onPointerMove={onHeadPointerMove}
          onPointerUp={onHeadPointerUp}
          onDoubleClick={() => setGeometry((current) => toggleCollapsed(current))}
          title="拖动移动；双击折叠"
        >
          <span className="sa-dot" data-busy={streaming || state.extracting} />
          <span className="sa-title">旁问</span>
          <span className="sa-session" title={state.sessionId ?? ''}>
            {sessionLabel}
          </span>
          <button
            type="button"
            className="sa-iconbtn"
            title="上下文详情"
            onClick={() => setDetailsOpen((open) => !open)}
            aria-pressed={detailsOpen}
          >
            详
          </button>
          <button
            type="button"
            className="sa-iconbtn"
            title={geometry.collapsed ? '展开' : '折叠'}
            onClick={() => setGeometry((current) => toggleCollapsed(current))}
          >
            {geometry.collapsed ? '▾' : '▴'}
          </button>
          <button
            type="button"
            className="sa-iconbtn"
            title="最小化"
            onClick={() => setGeometry((current) => toggleMinimized(current))}
          >
            –
          </button>
          <button type="button" className="sa-iconbtn" title="关闭" onClick={() => store.setOpen(false)}>
            ×
          </button>
        </div>

        <div className="sa-body">
          <ThreadView store={store} state={state} conversation={conversation} contextSource={contextSource} />
        </div>

        {detailsOpen ? (
          <ContextPanel
            store={store}
            state={state}
            contextSource={contextSource}
            onClose={() => setDetailsOpen(false)}
          />
        ) : null}

        {state.toast !== null ? (
          <div className="sa-toast" data-kind={state.toast.kind} data-testid="sideask-toast">
            {state.toast.text}
          </div>
        ) : null}

        <div
          className="sa-resize"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          title="拖动调整大小"
        />
      </div>
    </div>
  )
}

/**
 * Outer mount: creates the shadow root, injects CSS inside it, and renders the
 * shell into a nested React root. Renders only a zero-size host element in the
 * overlay layer, so nothing of ours participates in the host page's layout.
 */
export function ShadowHost(props: ShellProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<Root | null>(null)
  const [fallback, setFallback] = useState(false)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (host === null) return
    let root: Root | null = null
    let cleanUp: (() => void) | null = null
    try {
      const shadow = host.attachShadow({ mode: 'open' })
      const style = document.createElement('style')
      style.setAttribute('data-sideask', 'shadow')
      style.textContent = PANEL_CSS
      shadow.appendChild(style)
      const container = document.createElement('div')
      container.className = 'sa-mount'
      shadow.appendChild(container)
      root = createRoot(container)
      root.render(<WindowShell {...props} />)
      rootRef.current = root
      cleanUp = () => {
        root?.unmount()
        rootRef.current = null
      }
    } catch {
      // Shadow DOM unavailable: render the shell into the light DOM instead.
      setFallback(true)
      cleanUp = null
    }
    return () => {
      cleanUp?.()
    }
    // Mount once: the nested root re-renders on its own state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (fallback) {
    return (
      <div className="sa-lightmount">
        <style>{PANEL_CSS}</style>
        <WindowShell {...props} />
      </div>
    )
  }

  // Zero-size host: the window itself is position:fixed inside the root.
  return <div ref={hostRef} data-sideask-host="" style={{ width: 0, height: 0 }} />
}
