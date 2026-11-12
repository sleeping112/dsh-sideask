import assert from 'node:assert/strict'
import test from 'node:test'

import { MESSAGE_OVERHEAD_TOKENS, estimateMessageTokens, estimateTokens, truncateToTokens } from '../lib/shared/tokens.js'

test('estimateTokens: CJK costs about one token per character', () => {
  const tokens = estimateTokens('你好世界')
  assert.ok(tokens >= 3 && tokens <= 5, `expected 3..5, got ${tokens}`)
})

test('estimateTokens: latin text is about four characters per token', () => {
  const tokens = estimateTokens('the quick brown fox jumps over the lazy dog')
  assert.ok(tokens >= 8 && tokens <= 13, `expected 8..13, got ${tokens}`)
})

test('estimateTokens: empty string is zero tokens', () => {
  assert.equal(estimateTokens(''), 0)
})

test('estimateTokens: never zero for non-empty text', () => {
  assert.equal(estimateTokens('a'), 1)
})

test('estimateMessageTokens adds framing overhead', () => {
  assert.equal(estimateMessageTokens('hello'), estimateTokens('hello') + MESSAGE_OVERHEAD_TOKENS)
})

test('truncateToTokens: leaves short text untouched', () => {
  const result = truncateToTokens('short', 100)
  assert.equal(result.text, 'short')
  assert.equal(result.truncated, false)
})

test('truncateToTokens: result always fits the budget', () => {
  const text = '这是一段很长的中文文本，用来测试预算截断是否可靠。'.repeat(40)
  for (const budget of [20, 50, 120, 400]) {
    const result = truncateToTokens(text, budget)
    assert.ok(estimateTokens(result.text) <= budget, `budget ${budget} overflowed`)
    assert.equal(result.truncated, true)
  }
})

test('truncateToTokens: keeps head and tail markers', () => {
  const text = 'HEAD'.concat('x'.repeat(500)).concat('TAIL')
  const result = truncateToTokens(text, 60)
  assert.ok(result.text.startsWith('HEAD'))
  assert.ok(result.text.includes('已按上下文预算截断'))
})

test('truncateToTokens: zero budget yields empty text', () => {
  const result = truncateToTokens('anything', 0)
  assert.equal(result.text, '')
  assert.equal(result.truncated, true)
})
