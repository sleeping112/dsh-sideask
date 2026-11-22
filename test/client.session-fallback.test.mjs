/**
 * Session fallback contract tests.
 *
 * The side chat must bind to the conversation the user is looking at — the most
 * recently updated non-blank session, preferring the one the main view retained
 * — instead of blindly taking `ids[0]`. It must return null rather than adopt a
 * blank/unknown session.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { pickFallbackSession } from '../lib/client/session-fallback.js'

test('pickFallbackSession returns null for missing, junk or empty snapshots', () => {
  assert.equal(pickFallbackSession(null), null)
  assert.equal(pickFallbackSession(undefined), null)
  assert.equal(pickFallbackSession({ ids: [] }), null)
  assert.equal(pickFallbackSession({ ids: [], byId: {} }), null)
  assert.equal(pickFallbackSession({}), null)
})

test('all-blank catalogs are never guessed', () => {
  assert.equal(
    pickFallbackSession({
      ids: ['a', 'b'],
      byId: { a: { blank: true }, b: { blank: true } },
    }),
    null,
  )
  assert.equal(pickFallbackSession({ ids: ['a'], byId: { a: { blank: true, updatedAt: 999 } } }), null)
})

test('a blank retained session loses to a visible one', () => {
  assert.deepEqual(
    pickFallbackSession({
      ids: ['blankRetained', 'visible'],
      byId: {
        blankRetained: { blank: true, updatedAt: 999, retainedBy: { mainView: 3 } },
        visible: { updatedAt: 1 },
      },
    }),
    { id: 'visible' },
  )
})

test('retained sessions beat newer unretained ones', () => {
  assert.deepEqual(
    pickFallbackSession({
      ids: ['old', 'new'],
      byId: {
        old: { updatedAt: 100, retainedBy: { mainView: 1 } },
        new: { updatedAt: 900 },
      },
    }),
    { id: 'old' },
  )
})

test('among retained sessions the largest updatedAt wins', () => {
  assert.deepEqual(
    pickFallbackSession({
      ids: ['r1', 'r2', 'r3'],
      byId: {
        r1: { updatedAt: 100, retainedBy: { mainView: 2 } },
        r2: { updatedAt: 200, retainedBy: { mainView: 1 } },
        r3: { blank: true, updatedAt: 300, retainedBy: { mainView: 5 } },
      },
    }),
    { id: 'r2' },
  )
})

test('mainView 0 or a missing retainedBy does not count as retained', () => {
  assert.deepEqual(
    pickFallbackSession({
      ids: ['zero', 'newest'],
      byId: {
        zero: { updatedAt: 50, retainedBy: { mainView: 0 } },
        newest: { updatedAt: 60 },
      },
    }),
    { id: 'newest' },
  )
})

test('without retained sessions the largest updatedAt wins', () => {
  assert.deepEqual(
    pickFallbackSession({
      ids: ['a', 'b', 'c'],
      byId: { a: { updatedAt: 100 }, b: { updatedAt: 300 }, c: { updatedAt: 200 } },
    }),
    { id: 'b' },
  )
})

test('missing updatedAt sorts last', () => {
  assert.deepEqual(
    pickFallbackSession({
      ids: ['missing', 'fresh'],
      byId: { missing: {}, fresh: { updatedAt: 5 } },
    }),
    { id: 'fresh' },
  )
  // Both timestamps missing: deterministic snapshot order, not a crash.
  assert.deepEqual(
    pickFallbackSession({ ids: ['first', 'second'], byId: { first: {}, second: {} } }),
    { id: 'first' },
  )
})

test('ids absent from byId count as visible sessions with updatedAt 0', () => {
  assert.deepEqual(pickFallbackSession({ ids: ['ghost'], byId: {} }), { id: 'ghost' })
  assert.deepEqual(pickFallbackSession({ ids: ['ghost'] }), { id: 'ghost' })
  // A real timestamp still beats the byId-less row.
  assert.deepEqual(
    pickFallbackSession({ ids: ['ghost', 'seen'], byId: { seen: { updatedAt: 3 } } }),
    { id: 'seen' },
  )
})

test('empty or non-string ids are ignored', () => {
  assert.deepEqual(pickFallbackSession({ ids: ['', 'x'] }), { id: 'x' })
  assert.equal(pickFallbackSession({ ids: [''] }), null)
})
