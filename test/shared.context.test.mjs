import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_SELECTION_RATIO,
  ProjectionCache,
  buildContext,
  buildQuestionOnlyBundle,
  dedupeMessages,
} from '../lib/shared/context.js'
import { estimateTokens } from '../lib/shared/tokens.js'

const SETTINGS = {
  readContext: true,
  recentMessageLimit: 12,
  contextBudgetTokens: 3000,
  autoSummary: true,
  redactSensitive: true,
}

let counter = 0
function message(role, text, id) {
  counter += 1
  return { id: id ?? `msg-${counter}`, role, text }
}

function snapshot(messages) {
  return { sessionId: 's1', revision: messages.length, messages }
}

/** Sum of item tokens + summary must never exceed the budget. */
function assertWithinBudget(bundle, budget) {
  const used =
    bundle.items.reduce((total, item) => total + item.tokens, 0) +
    (bundle.summary === null ? 0 : estimateTokens(bundle.summary))
  assert.ok(used <= budget, `used ${used} > budget ${budget}`)
  assert.ok(bundle.stats.usedTokens <= budget, `stats ${bundle.stats.usedTokens} > budget ${budget}`)
}

test('buildContext: reads nothing when context reading is disabled', () => {
  const bundle = buildContext({
    snapshot: snapshot([message('user', '你好')]),
    question: '为什么？',
    settings: { ...SETTINGS, readContext: false },
  })
  assert.equal(bundle.items.length, 0)
  assert.deepEqual(bundle.stats.degradations, ['context-disabled'])
})

test('buildContext: never exceeds the token budget', () => {
  const messages = []
  for (let index = 0; index < 40; index += 1) {
    messages.push(message(index % 2 === 0 ? 'user' : 'assistant', `第 ${index} 条消息 `.repeat(60)))
  }
  for (const budget of [256, 512, 1000, 3000]) {
    const bundle = buildContext({
      snapshot: snapshot(messages),
      question: '总结一下',
      settings: { ...SETTINGS, contextBudgetTokens: budget },
    })
    assertWithinBudget(bundle, budget)
  }
})

test('buildContext: user selection outranks recent messages', () => {
  const messages = []
  for (let index = 0; index < 20; index += 1) messages.push(message('user', `普通消息 ${index} `.repeat(30)))
  const budget = 900
  const bundle = buildContext({
    snapshot: snapshot(messages),
    question: '解释这段',
    selection: { text: '被选中的关键片段', messageId: 'target-1' },
    settings: { ...SETTINGS, contextBudgetTokens: budget },
  })
  const selectionItem = bundle.items.find((item) => item.source === 'selection')
  assert.ok(selectionItem, 'selection must survive budgeting')
  assert.equal(selectionItem.ref, 'c1')
  assertWithinBudget(bundle, budget)
})

test('buildContext: a huge selection is capped by the selection ratio', () => {
  const budget = 1000
  const bundle = buildContext({
    snapshot: snapshot([message('user', 'hi')]),
    question: '解释',
    selection: { text: '选中内容 '.repeat(2000) },
    settings: { ...SETTINGS, contextBudgetTokens: budget },
  })
  const cap = Math.floor(budget * DEFAULT_SELECTION_RATIO) + 1
  assert.ok(bundle.stats.selectionTokens <= cap, `${bundle.stats.selectionTokens} > ${cap}`)
  assert.ok(bundle.stats.truncations.selection >= 1)
})

test('buildContext: recent messages beat the history summary', () => {
  const messages = []
  for (let index = 0; index < 12; index += 1) messages.push(message('user', `最近消息 ${index} `.repeat(40)))
  const budget = 1500
  const bundle = buildContext({
    snapshot: snapshot(messages),
    question: '继续',
    settings: { ...SETTINGS, contextBudgetTokens: budget, recentMessageLimit: 12 },
    overflowSummary: { text: '更早的历史摘要 '.repeat(200), coversMessageIds: ['old-1'] },
  })
  // The summary cannot fit next to the recent window, so it is dropped first.
  assert.equal(bundle.summary, null)
  assert.ok(bundle.stats.degradations.includes('summary-dropped-for-recent'))
  assert.ok(bundle.items.length > 0)
  assertWithinBudget(bundle, budget)
})

test('buildContext: a small summary is kept when the budget allows', () => {
  const bundle = buildContext({
    snapshot: snapshot([message('user', '短消息')]),
    question: '继续',
    settings: { ...SETTINGS, contextBudgetTokens: 3000 },
    overflowSummary: { text: '这是更早对话的摘要。', coversMessageIds: ['old-1'] },
  })
  assert.equal(bundle.stats.summaryTokens > 0, true)
  assert.equal(bundle.summary, '这是更早对话的摘要。')
  assert.ok(!bundle.stats.degradations.includes('summary-dropped-for-recent'))
})

test('buildContext: duplicate messages are deduped, newest copy kept', () => {
  const text = '这是一条会被重复出现的消息，内容完全一致。'
  const bundle = buildContext({
    snapshot: snapshot([
      message('user', text, 'first'),
      message('assistant', '中间的回复'),
      message('user', text, 'second'),
    ]),
    question: '为什么重复？',
    settings: SETTINGS,
  })
  assert.equal(bundle.stats.dedupedCount, 1)
  const ids = bundle.items.map((item) => item.messageId)
  assert.ok(ids.includes('second'))
  assert.ok(!ids.includes('first'))
})

test('buildContext: containment dedupe drops the quoted older copy', () => {
  const long = 'A'.repeat(400)
  const result = dedupeMessages([
    { id: 'old', role: 'tool', text: long },
    { id: 'new', role: 'assistant', text: `${long} 补充说明` },
  ])
  assert.deepEqual(result.kept.map((entry) => entry.id), ['new'])
  assert.equal(result.dropped, 1)
})

test('buildContext: empty transcript degrades to question-only', () => {
  const bundle = buildContext({
    snapshot: snapshot([]),
    question: '只有问题',
    settings: SETTINGS,
  })
  assert.equal(bundle.items.length, 0)
  assert.ok(bundle.stats.degradations.includes('question-only'))
})

test('buildContext: redaction is applied and counted', () => {
  const bundle = buildContext({
    snapshot: snapshot([message('user', '我的 key 是 sk-abcdefghijklmnopqrstuvwx 别外传')]),
    question: '安全吗？',
    settings: SETTINGS,
  })
  assert.ok(bundle.stats.redactedCount >= 1)
  assert.ok(!bundle.items.some((item) => item.text.includes('sk-abcdefghijklmnopqrstuvwx')))
})

test('buildContext: redaction can be turned off', () => {
  const bundle = buildContext({
    snapshot: snapshot([message('user', '我的 key 是 sk-abcdefghijklmnopqrstuvwx')]),
    question: '安全吗？',
    settings: { ...SETTINGS, redactSensitive: false },
  })
  assert.ok(bundle.items.some((item) => item.text.includes('sk-abcdefghijklmnopqrstuvwx')))
  assert.equal(bundle.stats.redactedCount, 0)
})

test('buildContext: refs are sequential and stable in display order', () => {
  const messages = []
  for (let index = 0; index < 5; index += 1) messages.push(message('user', `消息 ${index}`))
  const bundle = buildContext({
    snapshot: snapshot(messages),
    question: 'q',
    selection: { text: '选中', messageId: 'sel' },
    settings: SETTINGS,
  })
  assert.deepEqual(
    bundle.items.map((item) => item.ref),
    bundle.items.map((_, index) => `c${index + 1}`),
  )
  assert.equal(bundle.items[0].messageId, 'sel')
})

test('ProjectionCache: unchanged messages are served from cache (incremental)', () => {
  const cache = new ProjectionCache()
  const messages = []
  for (let index = 0; index < 10; index += 1) messages.push(message('user', `消息 ${index} 内容`))

  const first = buildContext({ snapshot: snapshot(messages), question: 'q', settings: SETTINGS, cache })
  assert.ok(first.items.length > 0)
  const afterFirst = cache.stats()
  assert.equal(afterFirst.hits, 0)
  assert.ok(afterFirst.misses >= 1)

  // Same transcript, one new message appended: only the new message is projected.
  const grown = [...messages, message('assistant', '新增的一条回复')]
  buildContext({ snapshot: snapshot(grown), question: 'q', settings: SETTINGS, cache })
  const afterSecond = cache.stats()
  assert.equal(afterSecond.misses - afterFirst.misses, 1, 'exactly one new projection')
  assert.ok(afterSecond.hits > 0, 'previous messages came from cache')
})

test('ProjectionCache: edited message is re-projected', () => {
  const cache = new ProjectionCache()
  const first = message('assistant', '初稿', 'same-id')
  buildContext({ snapshot: snapshot([first]), question: 'q', settings: SETTINGS, cache })
  const missesAfterFirst = cache.stats().misses
  buildContext({
    snapshot: snapshot([{ ...first, text: '初稿 + 流式追加的内容' }]),
    question: 'q',
    settings: SETTINGS,
    cache,
  })
  assert.equal(cache.stats().misses - missesAfterFirst, 1)
})

test('ProjectionCache: prune drops messages outside the window', () => {
  const cache = new ProjectionCache()
  buildContext({
    snapshot: snapshot([message('user', 'a', 'keep'), message('user', 'b', 'drop')]),
    question: 'q',
    settings: SETTINGS,
    cache,
  })
  cache.prune(new Set(['keep']))
  assert.equal(cache.stats().size, 1)
})

test('buildContext: respects recentMessageLimit before budgeting', () => {
  const messages = []
  for (let index = 0; index < 30; index += 1) messages.push(message('user', `m${index}`))
  const bundle = buildContext({
    snapshot: snapshot(messages),
    question: 'q',
    settings: { ...SETTINGS, recentMessageLimit: 3 },
  })
  assert.ok(bundle.items.length <= 3)
  assert.deepEqual(
    bundle.items.map((item) => item.text),
    ['m27', 'm28', 'm29'],
  )
})

test('buildQuestionOnlyBundle marks why context is missing', () => {
  const disabled = buildQuestionOnlyBundle('q', { ...SETTINGS, readContext: false })
  assert.deepEqual(disabled.stats.degradations, ['context-disabled'])
  const failed = buildQuestionOnlyBundle('q', SETTINGS)
  assert.deepEqual(failed.stats.degradations, ['extraction-failed'])
})
