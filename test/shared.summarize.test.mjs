import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_SUMMARY_MAX_CHARS,
  MIN_SUMMARY_CHARS,
  SUMMARY_MAX_INPUT_CHARS,
  SUMMARY_MAX_MESSAGES,
  buildSummaryInstruction,
  clampSummaryMessages,
  planSummaryMessages,
  summarizeKey,
} from '../lib/shared/summarize.js'

const message = (index, role = 'user') => ({ id: `m${index}`, role, text: `内容 ${index}` })

test('planSummaryMessages splits overflow from the recent window', () => {
  const messages = [message(0), message(1), message(2), message(3)]
  const plan = planSummaryMessages(messages, 2)
  assert.deepEqual(plan.ids, ['m0', 'm1'])
  assert.deepEqual(plan.overflow.map((m) => m.text), ['内容 0', '内容 1'])
})

test('planSummaryMessages handles short transcripts and degenerate limits', () => {
  assert.deepEqual(planSummaryMessages([message(0)], 10).ids, [])
  assert.deepEqual(planSummaryMessages([], 3).ids, [])
  const plan = planSummaryMessages([message(0), message(1)], 0)
  assert.deepEqual(plan.ids, ['m0'], 'limit is clamped to at least 1 recent message')
})

test('summarizeKey is stable and changes with the overflowing set', () => {
  const a = summarizeKey(['a', 'b'])
  assert.equal(a, summarizeKey(['a', 'b']))
  assert.notEqual(a, summarizeKey(['a', 'c']))
  assert.notEqual(a, summarizeKey(['a']))
  assert.match(a, /^s[0-9a-z]+$/)
})

test('clampSummaryMessages keeps the newest tail and caps input size', () => {
  const messages = Array.from({ length: SUMMARY_MAX_MESSAGES + 10 }, (_, index) => ({
    id: `m${index}`,
    role: 'user',
    text: `第 ${index} 条消息`,
  }))
  const kept = clampSummaryMessages(messages)
  assert.equal(kept.length, SUMMARY_MAX_MESSAGES)
  assert.equal(kept[kept.length - 1].id, `m${SUMMARY_MAX_MESSAGES + 9}`, 'newest message kept')
  assert.ok(kept.every((m, index) => index === 0 || kept[index - 1].id.localeCompare(m.id) < 0), 'order restored')

  const huge = clampSummaryMessages([{ id: 'big', role: 'user', text: 'x'.repeat(SUMMARY_MAX_INPUT_CHARS + 500) }])
  assert.equal(huge.length, 1)
  assert.equal(huge[0].text.length, SUMMARY_MAX_INPUT_CHARS)
})

test('clampSummaryMessages drops empty text', () => {
  assert.deepEqual(clampSummaryMessages([{ id: 'e', role: 'user', text: '   ' }]), [])
})

test('buildSummaryInstruction states the target length and the no-fabrication rule', () => {
  const instruction = buildSummaryInstruction(500)
  assert.match(instruction, /500 字/)
  assert.match(instruction, /不要编造/)
  assert.match(instruction, /待办/)
  assert.ok(DEFAULT_SUMMARY_MAX_CHARS >= 200)
  assert.ok(MIN_SUMMARY_CHARS > 0)
})
