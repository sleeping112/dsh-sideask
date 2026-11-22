import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  PILL_FALLBACK_SIZE,
  SNAP_DISTANCE,
  WINDOW_STORAGE_KEY,
  applyDrag,
  applyResize,
  clampGeometry,
  clampPill,
  computePosition,
  defaultState,
  fromPosition,
  movePill,
  pillPosition,
  pillStyle,
  release,
  resetPill,
  restore,
  serialize,
  toggleCollapsed,
  toggleMinimized,
} from '../lib/client/window-state.js'

const VIEWPORT = { width: 1200, height: 800 }

test('defaultState uses the top-right corner by default', () => {
  assert.equal(defaultState().corner, 'top-right')
  assert.equal(restore(null, VIEWPORT).corner, 'top-right')
})

test('pillStyle anchors the pill at each corner with the configured offsets', () => {
  // Top corners use the configurable top offset (default 40) so the pill clears
  // the window/title row; bottom corners use the edge margin.
  assert.deepEqual(pillStyle('top-left'), { top: 40, left: 18 })
  assert.deepEqual(pillStyle('top-right'), { top: 40, right: 18 })
  assert.deepEqual(pillStyle('bottom-left'), { bottom: 18, left: 18 })
  assert.deepEqual(pillStyle('bottom-right'), { bottom: 18, right: 18 })
  assert.deepEqual(pillStyle('top-right', { top: 64 }), { top: 64, right: 18 })
  assert.deepEqual(pillStyle('top-right', { edge: 8, top: 24 }), { top: 24, right: 8 })
})

test('defaultState sits in the bottom-right corner', () => {
  const state = defaultState('bottom-right')
  assert.equal(state.corner, 'bottom-right')
  assert.equal(state.width, DEFAULT_WIDTH)
  assert.equal(state.height, DEFAULT_HEIGHT)
  const position = computePosition(state, VIEWPORT)
  assert.equal(position.left, VIEWPORT.width - DEFAULT_WIDTH - state.x)
  assert.equal(position.top, VIEWPORT.height - DEFAULT_HEIGHT - state.y)
})

test('computePosition maps each corner to the expected edge', () => {
  // 400x360 stays above the enforced minimum, so clamping does not interfere.
  const base = { ...defaultState('top-left'), width: 400, height: 360, x: 10, y: 20 }
  assert.deepEqual(computePosition(base, VIEWPORT), { left: 10, top: 20 })
  assert.deepEqual(computePosition({ ...base, corner: 'top-right' }, VIEWPORT), { left: VIEWPORT.width - 410, top: 20 })
  assert.deepEqual(computePosition({ ...base, corner: 'bottom-left' }, VIEWPORT), { left: 10, top: VIEWPORT.height - 380 })
  assert.deepEqual(computePosition({ ...base, corner: 'bottom-right' }, VIEWPORT), {
    left: VIEWPORT.width - 410,
    top: VIEWPORT.height - 380,
  })
})

test('clampGeometry enforces the min and viewport-relative max', () => {
  assert.deepEqual(clampGeometry({ width: 10, height: 10 }, VIEWPORT), { width: MIN_WIDTH, height: MIN_HEIGHT })
  const huge = clampGeometry({ width: 5000, height: 5000 }, VIEWPORT)
  assert.equal(huge.width, Math.floor(VIEWPORT.width * 0.7))
  assert.equal(huge.height, Math.floor(VIEWPORT.height * 0.8))
})

test('applyDrag never lets the window leave the viewport', () => {
  const state = defaultState('top-left')
  const from = { x: 0, y: 0 }
  assert.equal(applyDrag(state, from, { x: -500, y: -500 }, VIEWPORT).x, 0)
  const far = applyDrag(state, from, { x: 5000, y: 5000 }, VIEWPORT)
  const position = computePosition(far, VIEWPORT)
  assert.ok(position.left + far.width <= VIEWPORT.width)
  assert.ok(position.top + far.height <= VIEWPORT.height)
})

test('release snaps to a corner when within the snap distance', () => {
  const state = defaultState('top-left')
  // 10px from the left/top edge → snap to top-left.
  const snapped = release(state, 10, 10, VIEWPORT)
  assert.equal(snapped.corner, 'top-left')
  const position = computePosition(snapped, VIEWPORT)
  assert.ok(position.left <= SNAP_DISTANCE && position.top <= SNAP_DISTANCE)
})

test('release keeps a free position when far from every edge', () => {
  const state = defaultState('top-left')
  const free = release(state, 400, 150, VIEWPORT)
  const position = computePosition(free, VIEWPORT)
  assert.equal(position.left, 400)
  assert.equal(position.top, 150)
})

test('release snaps to the right edge when released near it', () => {
  const state = defaultState('bottom-right')
  const left = VIEWPORT.width - state.width - 8
  const snapped = release(state, left, 300, VIEWPORT)
  const position = computePosition(snapped, VIEWPORT)
  assert.ok(VIEWPORT.width - (position.left + snapped.width) <= SNAP_DISTANCE)
})

test('applyResize clamps and keeps the top-left corner fixed', () => {
  const state = defaultState('top-left')
  const grown = applyResize(state, 100, 100, { x: 200, y: 120 }, VIEWPORT)
  assert.equal(grown.width, DEFAULT_WIDTH + 200)
  assert.equal(grown.height, DEFAULT_HEIGHT + 120)
  assert.deepEqual(computePosition(grown, VIEWPORT), { left: 100, top: 100 })

  const shrunk = applyResize(state, 100, 100, { x: -9999, y: -9999 }, VIEWPORT)
  assert.equal(shrunk.width, MIN_WIDTH)
  assert.equal(shrunk.height, MIN_HEIGHT)
})

test('fromPosition round-trips with computePosition for all corners', () => {
  for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
    const state = { ...defaultState(corner), width: 340, height: 400 }
    const target = { left: 260, top: 120 }
    const encoded = fromPosition(state, target.left, target.top, VIEWPORT, corner)
    const decoded = computePosition(encoded, VIEWPORT)
    assert.deepEqual(decoded, target, corner)
  }
})

test('toggleMinimized and toggleCollapsed are mutually exclusive', () => {
  const minimized = toggleMinimized(defaultState())
  assert.equal(minimized.minimized, true)
  const collapsed = toggleCollapsed(minimized)
  assert.equal(collapsed.minimized, false)
  assert.equal(collapsed.collapsed, true)
})

test('serialize/restore round-trips and survives corrupt values', () => {
  const state = { ...defaultState('top-right'), x: 40, y: 50, width: 360, height: 420, collapsed: true }
  assert.equal(WINDOW_STORAGE_KEY, 'dsh-sideask.window.v2')
  const restored = restore(serialize(state), VIEWPORT)
  assert.equal(restored.corner, 'top-right')
  assert.equal(restored.width, 360)
  assert.equal(restored.height, 420)
  assert.equal(restored.collapsed, true)

  for (const raw of [null, undefined, '', 'not json', '{}', '{"width":"x"}', '[]']) {
    const fallback = restore(raw, VIEWPORT, 'bottom-left')
    assert.equal(fallback.corner, 'bottom-left')
    assert.ok(fallback.width >= MIN_WIDTH)
  }
})

test('a stale v1 record is ignored so the configured default applies', () => {
  // v1 wrote the initial geometry on mount; honouring it would pin the old
  // default corner forever. v2 requires `schema: 2`.
  const stale = JSON.stringify({ corner: 'bottom-right', x: 18, y: 18, width: 380, height: 520 })
  assert.equal(restore(stale, VIEWPORT).corner, 'top-right')
  const current = { ...defaultState('bottom-left') }
  assert.equal(restore(serialize(current), VIEWPORT).corner, 'bottom-left')
})

test('restore clamps a saved position that no longer fits the viewport', () => {
  const raw = JSON.stringify({ corner: 'bottom-right', x: 99999, y: 99999, width: 500, height: 600 })
  const restored = restore(raw, { width: 640, height: 480 })
  const position = computePosition(restored, { width: 640, height: 480 })
  assert.ok(position.left >= 0 && position.top >= 0)
})

// ------------------------------------------------------- draggable entrance pill

test('defaultState starts with a docked pill (pillFree = null)', () => {
  assert.equal(defaultState().pillFree, null)
})

test('pillPosition docks to each corner when the pill is not dragged', () => {
  const size = { width: 96, height: 34 }
  const topRight = pillPosition({ ...defaultState('top-right') }, VIEWPORT, size, { top: 110 })
  assert.equal(topRight.left, VIEWPORT.width - size.width - 18)
  assert.equal(topRight.top, 110)
  const topLeft = pillPosition({ ...defaultState('top-left') }, VIEWPORT, size, { top: 110 })
  assert.equal(topLeft.left, 18)
  assert.equal(topLeft.top, 110)
  const bottomRight = pillPosition({ ...defaultState('bottom-right') }, VIEWPORT, size)
  assert.equal(bottomRight.top, VIEWPORT.height - size.height - 18)
  const bottomLeft = pillPosition({ ...defaultState('bottom-left') }, VIEWPORT, size)
  assert.equal(bottomLeft.left, 18)
})

test('clampPill keeps the pill fully inside the viewport', () => {
  const size = PILL_FALLBACK_SIZE
  assert.deepEqual(clampPill({ x: -50, y: -50 }, VIEWPORT, size), { x: 0, y: 0 })
  assert.deepEqual(clampPill({ x: 99999, y: 99999 }, VIEWPORT, size), {
    x: VIEWPORT.width - size.width,
    y: VIEWPORT.height - size.height,
  })
})

test('movePill remembers a clamped free position and resetPill re-docks it', () => {
  const moved = movePill(defaultState('top-right'), 300, 200, VIEWPORT, PILL_FALLBACK_SIZE)
  assert.deepEqual(moved.pillFree, { x: 300, y: 200 })
  const position = pillPosition(moved, VIEWPORT, PILL_FALLBACK_SIZE)
  assert.equal(position.left, 300)
  assert.equal(position.top, 200)
  assert.equal(resetPill(moved).pillFree, null)
  // The window geometry must not change when the pill is dragged.
  assert.equal(moved.corner, 'top-right')
  assert.equal(moved.width, moved.width)
})

test('serialize/restore round-trips the free pill position', () => {
  const state = movePill(defaultState('bottom-left'), 500, 300, VIEWPORT, PILL_FALLBACK_SIZE)
  const restored = restore(serialize(state), VIEWPORT)
  assert.deepEqual(restored.pillFree, { x: 500, y: 300 })
})

test('a v2 record (without pillFree) is still accepted with a docked pill', () => {
  const v2 = JSON.stringify({
    schema: 2,
    corner: 'bottom-right',
    x: 18,
    y: 18,
    width: 360,
    height: 420,
    minimized: false,
    collapsed: false,
  })
  const restored = restore(v2, VIEWPORT)
  assert.equal(restored.corner, 'bottom-right')
  assert.equal(restored.width, 360)
  assert.equal(restored.pillFree, null)
})

test('restore clamps a persisted free pill that no longer fits', () => {
  const state = movePill(defaultState(), 500, 300, VIEWPORT, PILL_FALLBACK_SIZE)
  const restored = restore(serialize(state), { width: 320, height: 240 })
  assert.ok((restored.pillFree?.x ?? 0) >= 0)
  assert.ok((restored.pillFree?.x ?? 0) <= 320 - PILL_FALLBACK_SIZE.width)
  assert.ok((restored.pillFree?.y ?? 0) <= 240 - PILL_FALLBACK_SIZE.height)
})
