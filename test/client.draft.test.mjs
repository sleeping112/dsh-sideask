import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DRAFT_STORAGE_KEY,
  MAX_DRAFT_CHARS,
  MAX_DRAFTS,
  NEW_THREAD_DRAFT_KEY,
  draftKey,
  getDraft,
  loadDrafts,
  saveDrafts,
  setDraft,
} from '../lib/client/draft.js'

test('draftKey uses a stable slot for "no thread yet"', () => {
  assert.equal(draftKey(null), NEW_THREAD_DRAFT_KEY)
  assert.equal(draftKey(undefined), NEW_THREAD_DRAFT_KEY)
  assert.equal(draftKey(''), NEW_THREAD_DRAFT_KEY)
  assert.equal(draftKey('thread-1'), 'thread-1')
})

test('loadDrafts degrades corrupt input to an empty map', () => {
  assert.deepEqual(loadDrafts(null), {})
  assert.deepEqual(loadDrafts(''), {})
  assert.deepEqual(loadDrafts('not json'), {})
  assert.deepEqual(loadDrafts('[]'), {})
  assert.deepEqual(loadDrafts('"text"'), {})
  assert.deepEqual(loadDrafts('{"a": 1, "b": "ok"}'), { b: 'ok' })
})

test('loadDrafts caps draft count and length', () => {
  const raw = JSON.stringify(
    Object.fromEntries(Array.from({ length: MAX_DRAFTS + 10 }, (_, index) => [`t${index}`, 'x'.repeat(MAX_DRAFT_CHARS + 50)])),
  )
  const drafts = loadDrafts(raw)
  assert.ok(Object.keys(drafts).length <= MAX_DRAFTS)
  for (const value of Object.values(drafts)) assert.ok(value.length <= MAX_DRAFT_CHARS)
})

test('saveDrafts drops empty drafts so storage cannot grow', () => {
  const saved = JSON.parse(saveDrafts({ a: 'hello', b: '', c: 'x' }))
  assert.deepEqual(saved, { a: 'hello', c: 'x' })
})

test('getDraft reads the current slot and defaults to empty', () => {
  const drafts = { [NEW_THREAD_DRAFT_KEY]: 'new-slot', t1: 'thread one' }
  assert.equal(getDraft(drafts, null), 'new-slot')
  assert.equal(getDraft(drafts, 't1'), 'thread one')
  assert.equal(getDraft(drafts, 'missing'), '')
})

test('setDraft sets one slot without touching the others, empty deletes', () => {
  const base = { t1: 'one' }
  const added = setDraft(base, 't2', 'two')
  assert.deepEqual(added, { t1: 'one', t2: 'two' })
  assert.equal(base.t2, undefined, 'must not mutate the input map')
  const removed = setDraft(added, 't1', '')
  assert.deepEqual(removed, { t2: 'two' })
})

test('setDraft caps very long drafts', () => {
  const long = setDraft({}, 't1', 'y'.repeat(MAX_DRAFT_CHARS + 100))
  assert.equal(long.t1.length, MAX_DRAFT_CHARS)
})

test('storage key is versioned (schema changes cannot race old data)', () => {
  assert.match(DRAFT_STORAGE_KEY, /draft\.v2$/)
})
