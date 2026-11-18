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
import { ThreadMenu } from './thread-menu.js'
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
  pillStyle,
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
  const [threadMenuOpen, setThreadMenuOpen] = useState(false)
  const dragRef = useRef<{ start: Point; origin: WindowState } | null>(null)
  const resizeRef = useRef<{ start: Point; left: number; top: number } | null>(null)
  /**
   * Only remember geometry after the user actually moved/resized/collapsed the
   * window. Writing the initial default on mount would pin it forever and hide
   * later changes to `defaultCorner`.
   */
  const touched = useRef(false)
  const markTouched = useCallback(() => {
    touched.current = true
  }, [])

  /**
   * Load host settings on mount, not on first open: the entrance pill must
   * already use the configured `pillOffset`/`defaultCorner` while the window is
   * still closed. `init()` is idempotent.
   */
  useEffect(() => {
    void store.init()
  }, [store])

  useEffect(() => {
    if (touched.current) saveWindow(geometry)
  }, [geometry])

  // The window mounts before `bootstrap` returns, so its first corner comes from
  // the local fallback. Once the host's real `defaultCorner` arrives (and the
  // user has not moved the window yet), follow it.
  useEffect(() => {
    if (touched.current) return
    setGeometry((current) =>
      current.corner === settings.defaultCorner ? current : clampOffset({ ...current, corner: settings.defaultCorner }, viewportOf()),
    )
  }, [settings.defaultCorner])

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
      markTouched()
      setGeometry(release(drag.origin, position.left, position.top, viewport))
    },
    [geometry, markTouched],
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
    markTouched()
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
  // thread is preserved, so reopening never loses the conversation. The pill
  // follows the docked corner (default: the configured `defaultCorner`).
  if (!state.open || geometry.minimized) {
    return (
      <div className="sa-root">
        <div
          className="sa-pill"
          style={pillStyle(geometry.corner, { top: settings.pillOffset })}
          data-testid="sideask-pill"
          onClick={() => {
            store.setOpen(true)
            markTouched()
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
          onDoubleClick={() => { markTouched(); setGeometry((current) => toggleCollapsed(current)) }}
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
            title="旁问线程：新建/切换/删除"
            onClick={() => setThreadMenuOpen((open) => !open)}
            aria-pressed={threadMenuOpen}
            data-testid="sideask-thread-button"
          >
            线
          </button>
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
            onClick={() => { markTouched(); setGeometry((current) => toggleCollapsed(current)) }}
          >
            {geometry.collapsed ? '▾' : '▴'}
          </button>
          <button
            type="button"
            className="sa-iconbtn"
            title="最小化"
            onClick={() => { markTouched(); setGeometry((current) => toggleMinimized(current)) }}
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

        {threadMenuOpen ? (
          <ThreadMenu store={store} state={state} onClose={() => setThreadMenuOpen(false)} />
        ) : null}

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
 * Outer mount.
 *
 * The window is mounted from `document.body`, NOT from the DOM the slot gives
 * us. Reason (a real bug found by a real-browser audit): the `shell.overlay`
 * layer is z-index 20 inside the app frame, while the main chat's sticky
 * composer/pane stack above it — so a window living in the overlay layer had its
 * lower half (including the input box) painted underneath the chat composer and
 * was therefore unclickable.
 *
 * The slot contribution is now a no-op mounter: it renders nothing and creates a
 * body-level container with a maximal z-index, an open Shadow Root (style
 * isolation preserved) and a nested React root.
 */
export function ShadowHost(props: ShellProps): React.ReactElement | null {
  useLayoutEffect(() => {
    const container = document.createElement('div')
    container.setAttribute('data-sideask-host', '')
    // The container must own the high stacking rank: a fixed-position element
    // with `z-index: auto` forms its own stacking context, so a `z-index: 60`
    // child would still be painted at rank 0 relative to the app frame.
    container.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;'
    document.body.appendChild(container)

    let root: Root | null = null
    const mountInto = (target: Element, shadow: boolean): void => {
      if (shadow) {
        const shadowRoot = (target as HTMLElement).attachShadow({ mode: 'open' })
        const style = document.createElement('style')
        style.setAttribute('data-sideask', 'shadow')
        style.textContent = PANEL_CSS
        shadowRoot.appendChild(style)
        const mount = document.createElement('div')
        mount.className = 'sa-mount'
        shadowRoot.appendChild(mount)
        root = createRoot(mount)
        root.render(<WindowShell {...props} />)
        return
      }
      // Light-DOM fallback: same markup, page-level CSS, high z-index still wins.
      const style = document.createElement('style')
      style.setAttribute('data-sideask', 'light')
      style.textContent = PANEL_CSS
      const mount = document.createElement('div')
      mount.className = 'sa-mount'
      target.append(style, mount)
      root = createRoot(mount)
      root.render(<WindowShell {...props} />)
    }

    try {
      mountInto(container, true)
    } catch {
      try {
        mountInto(container, false)
      } catch (error) {
        console.error('[dsh-sideask] 无法挂载悬浮窗', error)
      }
    }

    return () => {
      try {
        root?.unmount()
      } catch {
        // Already unmounted.
      }
      container.remove()
    }
    // Mount once: the nested root re-renders on its own store subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The slot contribution renders nothing on purpose (the window lives on body).
  return null
}
