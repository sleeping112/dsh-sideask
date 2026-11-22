import assert from 'node:assert/strict'
import test from 'node:test'

import { buildHandoffText, toQuoteBlock } from '../lib/client/writeback.js'

test('buildHandoffText frames the answer as an explicit task', () => {
  const text = buildHandoffText('  建议先跑回归测试  ')
  assert.match(text, /请执行以下旁问结论/)
  assert.ok(text.includes('建议先跑回归测试'))
  assert.ok(!text.includes('  '), 'outer whitespace trimmed')
})

test('buildHandoffText keeps multi-line answers intact', () => {
  const text = buildHandoffText('第一行\n第二行')
  assert.ok(text.includes('第一行\n第二行'))
})

test('toQuoteBlock prefixes every line and appends the note once', () => {
  const block = toQuoteBlock('a\nb', '引用自旁问')
  assert.equal(block.split('\n')[0], '> a')
  assert.ok(block.startsWith('> a\n> b'))
  assert.ok(block.includes('— 引用自旁问（来自旁问）'))
})
