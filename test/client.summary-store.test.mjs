import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_SUMMARIES_PER_SESSION,
  MAX_SUMMARY_CHARS,
  MAX_SUMMARY_SESSIONS,
  SUMMARY_STORAGE_KEY,
  getSessionSummaries,
  loadSummaryStore,
  putSessionSummary,
  saveSummaryStore,
} from '../lib/client/summary-store.js'

test('loadSummaryStore degrades corrupt input to an empty store', () => {
  assert.deepEqual(loadSummaryStore(null), {})
  assert.deepEqual(loadSummaryStore(''), {})
  assert.deepEqual(loadSummaryStore('{oops'), {})
  assert.deepEqual(loadSummaryStore('[]'), {})
  assert.deepEqual(loadSummaryStore('{"s1":{"k1":"摘要"}}'), { s1: { k1: '摘要' } })
  assert.deepEqual(loadSummaryStore('{"s1":{"k1":"   "}}'), {})
  assert.deepEqual(loadSummaryStore('{"s1":42}'), {})
})

test('loadSummaryStore caps session count by recency', () => {
  const raw = JSON.stringify(
    Object.fromEntries(Array.from({ length: MAX_SUMMARY_SESSIONS + 2 }, (_, i) => [`s${i}`, { [`k${i}`]: 'x' }])),
  )
  const store = loadSummaryStore(raw)
  assert.ok(Object.keys(store).length <= MAX_SUMMARY_SESSIONS)
  assert.ok(!('s0' in store), 'oldest sessions dropped')
})

test('saveSummaryStore round-trips and caps entries and length', () => {
  const store = { s1: {} }
  for (let i = 0; i < MAX_SUMMARIES_PER_SESSION + 3; i += 1) store.s1[`k${i}`] = 'y'.repeat(MAX_SUMMARY_CHARS + 10)
  const saved = loadSummaryStore(saveSummaryStore(store))
  const keys = Object.keys(saved.s1)
  assert.ok(keys.length <= MAX_SUMMARIES_PER_SESSION)
  assert.ok(keys.includes(`k${MAX_SUMMARIES_PER_SESSION + 2}`), 'newest kept')
  for (const value of Object.values(saved.s1)) assert.ok(value.length <= MAX_SUMMARY_CHARS)
})

const MAX_SUMMARY_PER_SESSION_OVERFLOW = 5

test('putSessionSummary adds, refreshes and evicts without mutating the input', () => {
  const base = { s1: { old: '旧摘要' } }
  const added = putSessionSummary(base, 's1', 'k1', ' 新摘要 ')
  assert.deepEqual(added.s1.k1, '新摘要')
  assert.equal(base.s1.k1, undefined, 'input must not be mutated')

  let store = putSessionSummary({}, 's1', 'k', 's')
  for (let i = 0; i < MAX_SUMMARY_PER_SESSION_OVERFLOW; i += 1) store = putSessionSummary(store, 's1', `k${i}`, 's')
  assert.ok(Object.keys(store.s1).length <= MAX_SUMMARIES_PER_SESSION)
})

test('putSessionSummary drops the oldest session when over the cap', () => {
  let store = {}
  for (let i = 0; i < MAX_SUMMARY_SESSIONS + 1; i += 1) store = putSessionSummary(store, `s${i}`, 'k', '文本')
  assert.equal(Object.keys(store).length, MAX_SUMMARY_SESSIONS)
  assert.ok(!('s0' in store))
})

test('getSessionSummaries returns a copy', () => {
  const store = { s1: { k: 'v' } }
  const copy = getSessionSummaries(store, 's1')
  copy.k = 'changed'
  assert.equal(store.s1.k, 'v')
  assert.deepEqual(getSessionSummaries(store, 'missing'), {})
  assert.match(SUMMARY_STORAGE_KEY, /summary\.v1$/)
})
