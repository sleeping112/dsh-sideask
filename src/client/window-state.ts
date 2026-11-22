/**
 * Window geometry state machine — pure, DOM-free, unit-tested.
 *
 * The floating window is positioned in viewport coordinates. Two coordinate
 * systems are persisted:
 * - `corner` (which corner it is snapped to), and
 * - `x`/`y` (the top-left offset from that corner), so the window keeps its
 *   distance to the snapped edge when the viewport is resized.
 *
 * Everything here is a pure function of (state, pointer delta/geometry), which
 * is what makes the drag maths testable without a browser.
 */

import type { DockCorner } from '../shared/contract.js'

/**
 * Storage key for the remembered geometry.
 *
 * Bumped to v2 together with the `schema` field: v1 wrote the *initial* geometry
 * on first mount, so a default corner could be pinned forever. v2 only writes
 * after the user actually moves/resizes/collapses the window, and a stored value
 * without `schema: 2` is ignored (one-time migration to the configured default).
 */
export const WINDOW_STORAGE_KEY = 'dsh-sideask.window.v2'
/**
 * v3 adds `pillFree` (the entrance pill can be dragged to an arbitrary spot).
 * A v2 record is still restored (one-time migration: the pill starts docked).
 */
export const WINDOW_STORAGE_SCHEMA = 3

export const MIN_WIDTH = 300
export const MIN_HEIGHT = 320
export const MAX_WIDTH_RATIO = 0.7
export const MAX_HEIGHT_RATIO = 0.8
export const SNAP_DISTANCE = 24
export const DEFAULT_WIDTH = 380
export const DEFAULT_HEIGHT = 520
/** Margin (px) between the entrance pill and the viewport edges. */
export const PILL_MARGIN = 18
/** Default vertical offset (px) from the top edge, so the pill clears the top bar. */
export const PILL_TOP_OFFSET = 40

/**
 * CSS offsets for the floating entrance pill at a given corner.
 *
 * The pill is not a window: it has no remembered geometry of its own, it just
 * sits at the corner the window is docked to (or at `defaultCorner` before the
 * window has ever moved). `top` is configurable (`pillOffset`) because the top
 * edge usually has a window/title bar the pill should not overlap.
 */
export function pillStyle(
  corner: DockCorner,
  options: { edge?: number; top?: number } = {},
): {
  left?: number
  right?: number
  top?: number
  bottom?: number
} {
  const edge = options.edge ?? PILL_MARGIN
  const top = options.top ?? PILL_TOP_OFFSET
  const vertical = corner === 'top-left' || corner === 'top-right' ? { top } : { bottom: edge }
  const horizontal = corner === 'top-left' || corner === 'bottom-left' ? { left: edge } : { right: edge }
  return { ...vertical, ...horizontal }
}

export interface WindowGeometry {
  width: number
  height: number
}

export interface WindowState {
  corner: DockCorner
  /** Distance from the snapped corner, in CSS pixels. */
  x: number
  y: number
  width: number
  height: number
  minimized: boolean
  collapsed: boolean
  /**
   * Absolute top-left of the entrance pill once the user dragged it; `null`
   * means "docked to `corner`" (the default, and what resets it).
   */
  pillFree: Point | null
}

/** Measured size of the entrance pill (needed to clamp a free position). */
export interface PillSize {
  width: number
  height: number
}

export const PILL_FALLBACK_SIZE: PillSize = { width: 96, height: 34 }

export interface Viewport {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export const CORNERS: DockCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

/** Keep the pill fully inside the viewport (a 0-size viewport keeps it at 0,0). */
export function clampPill(point: Point, viewport: Viewport, size: PillSize): Point {
  const maxX = Math.max(0, viewport.width - size.width)
  const maxY = Math.max(0, viewport.height - size.height)
  return {
    x: Math.min(maxX, Math.max(0, Math.round(point.x))),
    y: Math.min(maxY, Math.max(0, Math.round(point.y))),
  }
}

/**
 * Concrete top-left of the entrance pill: the dragged position when set,
 * otherwise the docked corner (using the configured `pillOffset` top).
 */
export function pillPosition(
  state: WindowState,
  viewport: Viewport,
  size: PillSize = PILL_FALLBACK_SIZE,
  options: { edge?: number; top?: number } = {},
): { left: number; top: number } {
  if (state.pillFree !== null) {
    const clamped = clampPill(state.pillFree, viewport, size)
    return { left: clamped.x, top: clamped.y }
  }
  const edge = options.edge ?? PILL_MARGIN
  const style = pillStyle(state.corner, options)
  const left = style.left !== undefined ? style.left : viewport.width - size.width - (style.right ?? edge)
  const top = style.top !== undefined ? style.top : viewport.height - size.height - (style.bottom ?? edge)
  return { left: Math.round(left), top: Math.round(top) }
}

/** Move the pill to an absolute position (clamped) and remember it. */
export function movePill(state: WindowState, left: number, top: number, viewport: Viewport, size: PillSize = PILL_FALLBACK_SIZE): WindowState {
  return { ...state, pillFree: clampPill({ x: left, y: top }, viewport, size) }
}

/** Re-dock the pill to the window's corner (keeps the window geometry). */
export function resetPill(state: WindowState): WindowState {
  return { ...state, pillFree: null }
}

export function defaultState(corner: DockCorner = 'top-right'): WindowState {
  return {
    corner,
    x: 18,
    y: 18,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minimized: false,
    collapsed: false,
    pillFree: null,
  }
}

export function isCorner(value: unknown): value is DockCorner {
  return typeof value === 'string' && (CORNERS as string[]).includes(value)
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Clamp a geometry to the viewport-aware min/max box. */
export function clampGeometry(geometry: WindowGeometry, viewport: Viewport): WindowGeometry {
  const maxWidth = Math.max(MIN_WIDTH, Math.floor(viewport.width * MAX_WIDTH_RATIO))
  const maxHeight = Math.max(MIN_HEIGHT, Math.floor(viewport.height * MAX_HEIGHT_RATIO))
  return {
    width: Math.min(maxWidth, Math.max(MIN_WIDTH, Math.round(geometry.width))),
    height: Math.min(maxHeight, Math.max(MIN_HEIGHT, Math.round(geometry.height))),
  }
}

/** Clamp the corner offset so the window can never be dragged fully off-screen. */
export function clampOffset(state: WindowState, viewport: Viewport): WindowState {
  const geometry = clampGeometry(state, viewport)
  const maxX = Math.max(0, viewport.width - geometry.width)
  const maxY = Math.max(0, viewport.height - geometry.height)
  return { ...state, ...geometry, x: Math.min(maxX, Math.max(0, Math.round(state.x))), y: Math.min(maxY, Math.max(0, Math.round(state.y))) }
}

/**
 * Convert a state + viewport into concrete CSS coordinates.
 * This is the single place that knows how a corner maps to top/left.
 */
export function computePosition(state: WindowState, viewport: Viewport): { left: number; top: number } {
  const clamped = clampOffset(state, viewport)
  const left =
    clamped.corner === 'top-left' || clamped.corner === 'bottom-left'
      ? clamped.x
      : Math.max(0, viewport.width - clamped.width - clamped.x)
  const top =
    clamped.corner === 'top-left' || clamped.corner === 'top-right'
      ? clamped.y
      : Math.max(0, viewport.height - clamped.height - clamped.y)
  return { left: Math.round(left), top: Math.round(top) }
}

/** True when the position is close enough to an edge to snap. */
export function nearestCorner(left: number, top: number, viewport: Viewport): DockCorner {
  const horizontal = left + 0 < viewport.width / 2 ? 'left' : 'right'
  const vertical = top < viewport.height / 2 ? 'top' : 'bottom'
  return `${vertical}-${horizontal}` as DockCorner
}

/**
 * Distance (in px) from the window to the nearest viewport edge, used to decide
 * whether a release should snap.
 */
export function edgeDistance(left: number, top: number, geometry: WindowGeometry, viewport: Viewport): number {
  return Math.min(
    left,
    top,
    Math.max(0, viewport.width - (left + geometry.width)),
    Math.max(0, viewport.height - (top + geometry.height)),
  )
}

/** Apply a drag delta to a state. `from` is the position at pointer-down. */
export function applyDrag(state: WindowState, from: Point, delta: Point, viewport: Viewport): WindowState {
  const left = Math.max(0, Math.min(viewport.width - state.width, from.x + delta.x))
  const top = Math.max(0, Math.min(viewport.height - state.height, from.y + delta.y))
  return fromPosition({ ...state, minimized: false }, left, top, viewport, nearestCorner(left, top, viewport))
}

/** Snap a dragged window when released near an edge; otherwise keep the free position. */
export function release(
  state: WindowState,
  left: number,
  top: number,
  viewport: Viewport,
): WindowState {
  const distance = edgeDistance(left, top, state, viewport)
  if (distance > SNAP_DISTANCE) {
    // Not near an edge: keep it where it is, encoded against the nearest corner.
    return fromPosition({ ...state, minimized: false }, left, top, viewport, nearestCorner(left, top, viewport))
  }
  const corner = nearestCorner(left, top, viewport)
  const snapped = computePosition({ ...state, corner }, viewport)
  return fromPosition({ ...state, minimized: false }, snapped.left, snapped.top, viewport, corner)
}

/** Encode an absolute (left, top) position as corner + offset. */
export function fromPosition(
  state: WindowState,
  left: number,
  top: number,
  viewport: Viewport,
  corner: DockCorner = state.corner,
): WindowState {
  const geometry = clampGeometry(state, viewport)
  const x =
    corner === 'top-left' || corner === 'bottom-left'
      ? left
      : viewport.width - geometry.width - left
  const y =
    corner === 'top-left' || corner === 'top-right'
      ? top
      : viewport.height - geometry.height - top
  return clampOffset({ ...state, corner, ...geometry, x, y }, viewport)
}

/**
 * Resize from the bottom-right handle. The top-left corner stays fixed, so the
 * work is clamping the new size and re-encoding the offset from the corner.
 */
export function applyResize(
  state: WindowState,
  startLeft: number,
  startTop: number,
  delta: Point,
  viewport: Viewport,
): WindowState {
  const geometry = clampGeometry({ width: state.width + delta.x, height: state.height + delta.y }, viewport)
  return fromPosition({ ...state, ...geometry }, startLeft, startTop, viewport, state.corner)
}

export function toggleMinimized(state: WindowState): WindowState {
  return { ...state, minimized: !state.minimized, collapsed: false }
}

export function toggleCollapsed(state: WindowState): WindowState {
  return { ...state, collapsed: !state.collapsed, minimized: false }
}

export function focusOnly(state: WindowState): WindowState {
  return { ...state, minimized: false }
}

/** Persist/restore. Never throws: a corrupted value falls back to defaults. */
export function serialize(state: WindowState): string {
  return JSON.stringify({
    schema: WINDOW_STORAGE_SCHEMA,
    corner: state.corner,
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minimized: state.minimized,
    collapsed: state.collapsed,
    pillFree: state.pillFree,
  })
}

export function restore(raw: string | null | undefined, viewport: Viewport, fallbackCorner: DockCorner = 'top-right'): WindowState {
  const base = defaultState(fallbackCorner)
  if (typeof raw !== 'string' || raw.length === 0) return clampOffset(base, viewport)
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed === null || typeof parsed !== 'object') return clampOffset(base, viewport)
    // A v1 record (no schema) is ignored on purpose: v1 pinned the initial
    // default corner on first mount, so honouring it would defeat the configured
    // default. This is the one-time migration. v2 records (schema 2) are still
    // accepted and simply start with a docked pill.
    const schema = parsed['schema']
    if (schema !== 2 && schema !== WINDOW_STORAGE_SCHEMA) return clampOffset(base, viewport)
    const freeRaw = parsed['pillFree']
    const pillFree =
      typeof freeRaw === 'object' && freeRaw !== null && typeof (freeRaw as Point).x === 'number' && typeof (freeRaw as Point).y === 'number'
        ? clampPill({ x: (freeRaw as Point).x, y: (freeRaw as Point).y }, viewport, PILL_FALLBACK_SIZE)
        : null
    const state: WindowState = {
      corner: isCorner(parsed['corner']) ? parsed['corner'] : fallbackCorner,
      x: num(parsed['x'], base.x, 0, Math.max(0, viewport.width)),
      y: num(parsed['y'], base.y, 0, Math.max(0, viewport.height)),
      width: num(parsed['width'], base.width, MIN_WIDTH, Math.max(MIN_WIDTH, viewport.width)),
      height: num(parsed['height'], base.height, MIN_HEIGHT, Math.max(MIN_HEIGHT, viewport.height)),
      minimized: parsed['minimized'] === true,
      collapsed: parsed['collapsed'] === true,
      pillFree,
    }
    return clampOffset(state, viewport)
  } catch {
    return clampOffset(base, viewport)
  }
}

/** True when two states would render the same (used to skip redundant writes). */
export function sameState(left: WindowState, right: WindowState): boolean {
  const samePill =
    (left.pillFree === null && right.pillFree === null) ||
    (left.pillFree !== null && right.pillFree !== null && left.pillFree.x === right.pillFree.x && left.pillFree.y === right.pillFree.y)
  return (
    left.corner === right.corner &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.minimized === right.minimized &&
    left.collapsed === right.collapsed &&
    samePill
  )
}
