import assert from 'node:assert/strict'
import test from 'node:test'

import { SUMMARY_CACHE_LIMIT, SummaryCache, planOverflow, summaryStatus } from '../lib/client/summary.js'

const message = (index) => ({ id: `m${index}`, role: 'user', text: `内容 ${index}` })

test('planOverflow splits the transcript and keys the overflow', () => {
  const plan = planOverflow([message(0), message(1), message(2), message(3)], 2)
  assert.deepEqual(plan.ids, ['m0', 'm1'])
  assert.equal(plan.overflow.length, 2)
  assert.match(plan.key, /^s/)
})

test('planOverflow returns an empty plan when everything fits the window', () => {
  const plan = planOverflow([message(0)], 5)
  assert.deepEqual(plan.ids, [])
  assert.equal(plan.overflow.length, 0)
})

test('SummaryCache stores, trims and evicts oldest entries', () => {
  const cache = new SummaryCache(2)
  cache.put('a', '  摘要 A  ')
  cache.put('b', '摘要 B')
  assert.equal(cache.get('a'), '摘要 A')
  cache.put('c', '摘要 C')
  assert.equal(cache.size, 2)
  assert.equal(cache.get('a'), null, 'oldest evicted')
  assert.equal(cache.get('b'), '摘要 B')
  assert.equal(cache.get('c'), '摘要 C')
})

test('SummaryCache ignores empty text and supports clear', () => {
  const cache = new SummaryCache()
  cache.put('a', '   ')
  assert.equal(cache.size, 0)
  cache.put('b', 'ok')
  cache.clear()
  assert.equal(cache.size, 0)
  assert.equal(SUMMARY_CACHE_LIMIT, 8)
})

test('summaryStatus only asks for a run when nothing is cached or in flight', () => {
  const plan = planOverflow([message(0), message(1)], 1)
  assert.deepEqual(summaryStatus(plan, null, null), { needed: true, cached: false, pending: true })
  assert.deepEqual(summaryStatus(plan, '已有摘要', null), { needed: false, cached: true, pending: false })
  assert.deepEqual(summaryStatus(plan, null, plan.key), { needed: false, cached: false, pending: true })
  const empty = planOverflow([], 2)
  assert.equal(summaryStatus(empty, null, null).needed, false)
})
