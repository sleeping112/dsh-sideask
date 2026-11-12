/**
 * Memory-bound tests.
 *
 * The plugin must not be able to grow its own state without limit: that is the
 * difference between "a floating helper" and "the thing that ate my RAM". These
 * tests pin every unbounded-looking structure to an explicit bound.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ProjectionCache, buildContext } from '../lib/shared/context.js'
import { SseDecoder } from '../lib/client/stream.js'
import { ThreadStore } from '../lib/host/store.js'

const SETTINGS = {
  readContext: true,
  recentMessageLimit: 20,
  contextBudgetTokens: 4000,
  autoSummary: true,
  redactSensitive: true,
}

test('ProjectionCache never exceeds its entry limit', () => {
  const cache = new ProjectionCache(64)
  for (let index = 0; index < 5000; index += 1) {
    cache.project({ id: `m${index}`, role: 'user', text: `消息内容 ${index} `.repeat(5) })
  }
  assert.ok(cache.stats().size <= 64, `size ${cache.stats().size} > 64`)
})

test('buildContext over a huge transcript stays within budget and cache bound', () => {
  const cache = new ProjectionCache(256)
  const messages = []
  for (let index = 0; index < 20000; index += 1) {
    messages.push({ id: `m${index}`, role: index % 2 === 0 ? 'user' : 'assistant', text: `第 ${index} 条 `.repeat(20) })
  }
  const bundle = buildContext({
    snapshot: { sessionId: 's', revision: messages.length, messages },
    question: '总结',
    settings: { ...SETTINGS, contextBudgetTokens: 3000 },
    cache,
  })
  const used = bundle.items.reduce((total, item) => total + item.tokens, 0)
  assert.ok(used <= 3000, `used ${used}`)
  assert.ok(cache.stats().size <= 256, `cache ${cache.stats().size}`)
  assert.ok(bundle.items.length <= SETTINGS.recentMessageLimit)
})

test('ThreadStore trims threads and messages to its configured limits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sideask-bounds-'))
  const file = path.join(dir, 'threads.json')
  const store = new ThreadStore(file, { maxThreads: 3, maxMessagesPerThread: 5 })
  store.setPersist(false)
  store.load()

  for (let index = 0; index < 20; index += 1) {
    const thread = store.create('s1')
    for (let message = 0; message < 12; message += 1) {
      store.append(thread.id, { id: `m${message}`, role: message % 2 === 0 ? 'user' : 'assistant', text: `内容 ${message}`, createdAt: Date.now() })
    }
  }
  const list = store.list()
  assert.ok(list.length <= 3, `threads ${list.length}`)
  for (const entry of list) {
    const thread = store.get(entry.id)
    assert.ok(thread.messages.length <= 5, `messages ${thread.messages.length}`)
  }
  store.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('ThreadStore flushes a bounded file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sideask-file-'))
  const file = path.join(dir, 'threads.json')
  const store = new ThreadStore(file, { maxThreads: 2, maxMessagesPerThread: 4 })
  store.load()
  const thread = store.create('s1')
  for (let index = 0; index < 50; index += 1) {
    store.append(thread.id, { id: `m${index}`, role: 'user', text: 'x'.repeat(200), createdAt: Date.now() })
  }
  store.flush()
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(parsed.threads.length, 1)
  assert.ok(parsed.threads[0].messages.length <= 4)
  store.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('SseDecoder keeps only an unfinished frame, not the whole stream', () => {
  const decoder = new SseDecoder()
  for (let index = 0; index < 5000; index += 1) {
    decoder.push(`data: ${JSON.stringify({ type: 'delta', requestId: 'r', text: 'x'.repeat(40) })}\n\n`)
  }
  assert.equal(decoder.pending.length, 0)
  // A partial frame is buffered, but only that frame.
  decoder.push('data: {"type":"delta",')
  assert.ok(decoder.pending.length < 200, `pending ${decoder.pending.length}`)
})

test('an answer state holds exactly one answer, not an accumulating history', async () => {
  const { reduceAnswer, initialAnswer } = await import('../lib/client/stream.js')
  let state = initialAnswer()
  for (let index = 0; index < 1000; index += 1) {
    state = reduceAnswer(state, { type: 'accepted', requestId: `r${index}`, mode: 'context' })
    state = reduceAnswer(state, { type: 'delta', requestId: `r${index}`, text: 'x' })
  }
  // A new accepted event resets the textual accumulator.
  assert.equal(state.text, 'x')
})
