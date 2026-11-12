import assert from 'node:assert/strict'
import test from 'node:test'

import { excerptOf, finaliseAnswer, parseAnswer, resolveCitations } from '../lib/shared/citations.js'
import { buildPrompt, buildSummaryPrompt } from '../lib/shared/prompt.js'

const items = [
  { ref: 'c1', messageId: 'm1', role: 'user', text: '第一条消息的内容', tokens: 10, truncated: false, source: 'recent' },
  { ref: 'c2', messageId: 'm2', role: 'assistant', text: '第二条消息的内容，比较长一些以便测试摘要。', tokens: 12, truncated: false, source: 'recent' },
]

test('parseAnswer: trailing citation block is stripped as text', () => {
  const parsed = parseAnswer('回答正文。\n\n⟦refs: c1, c2⟧')
  assert.equal(parsed.text, '回答正文。')
  assert.deepEqual(parsed.refs, ['c1', 'c2'])
  assert.equal(parsed.hasInlineMarkers, false)
})

test('parseAnswer: full-width brackets are accepted', () => {
  const parsed = parseAnswer('答案\n［refs：c2］')
  assert.equal(parsed.text, '答案')
  assert.deepEqual(parsed.refs, ['c2'])
})

test('parseAnswer: inline markers are recognised and kept in the text', () => {
  const parsed = parseAnswer('根据 [c1] 与 [c2]，答案是 42。')
  assert.deepEqual(parsed.refs, ['c1', 'c2'])
  assert.ok(parsed.text.includes('[c1]'))
  assert.equal(parsed.hasInlineMarkers, true)
})

test('parseAnswer: an empty refs block means no citations', () => {
  const parsed = parseAnswer('答案\n⟦refs:⟧')
  assert.equal(parsed.text, '答案')
  assert.deepEqual(parsed.refs, [])
})

test('parseAnswer: missing block leaves the answer untouched', () => {
  const parsed = parseAnswer('只有答案。')
  assert.equal(parsed.text, '只有答案。')
  assert.deepEqual(parsed.refs, [])
})

test('resolveCitations: unknown refs are dropped, never invented', () => {
  const citations = resolveCitations(['c1', 'c9'], items)
  assert.equal(citations.length, 1)
  assert.equal(citations[0].ref, 'c1')
  assert.equal(citations[0].messageId, 'm1')
})

test('resolveCitations: duplicate refs resolve once', () => {
  const citations = resolveCitations(['c1', 'c1'], items)
  assert.equal(citations.length, 1)
})

test('resolveCitations: excerpt is single-line and bounded', () => {
  const long = { ref: 'c3', messageId: 'm3', role: 'user', text: 'x'.repeat(500), tokens: 1, truncated: false, source: 'recent' }
  const [citation] = resolveCitations(['c3'], [long])
  assert.ok(citation.excerpt.length <= 120)
  assert.ok(!citation.excerpt.includes('\n'))
})

test('excerptOf: collapses whitespace', () => {
  assert.equal(excerptOf('a\n\n  b\tc'), 'a b c')
})

test('finaliseAnswer: text and citations are split consistently', () => {
  const result = finaliseAnswer('正文 [c2]\n⟦refs: c1⟧', items)
  assert.equal(result.text, '正文 [c2]')
  assert.deepEqual(result.citations.map((citation) => citation.ref), ['c1', 'c2'])
})

test('buildPrompt: full context prompt contains every section', () => {
  const bundle = {
    items,
    summary: '历史摘要内容',
    selection: null,
    stats: {},
  }
  const prompt = buildPrompt({ question: '怎么做？', bundle, history: [], requireCitations: true })
  assert.ok(prompt.system.includes('旁问'))
  assert.ok(prompt.system.includes('⟦refs:'))
  assert.ok(prompt.user.includes('历史摘要内容'))
  assert.ok(prompt.user.includes('[c1｜用户｜msg:m1]'))
  assert.ok(prompt.user.includes('## 当前问题'))
  assert.ok(prompt.user.includes('怎么做？'))
})

test('buildPrompt: question-only prompt says so explicitly', () => {
  const prompt = buildPrompt({ question: '只有问题', bundle: null, history: [], requireCitations: true })
  assert.ok(prompt.user.includes('没有可用的上下文'))
  assert.ok(prompt.user.includes('只有问题'))
})

test('buildPrompt: citations instruction can be disabled', () => {
  const prompt = buildPrompt({ question: 'q', bundle: null, history: [], requireCitations: false })
  assert.ok(!prompt.system.includes('⟦refs: c1'))
  assert.ok(prompt.system.includes('不需要输出引用块'))
})

test('buildPrompt: prior side-thread turns are embedded as a transcript', () => {
  const history = [
    { id: 'h1', role: 'user', text: '之前的问题', createdAt: 1 },
    { id: 'h2', role: 'assistant', text: '之前的回答', createdAt: 2 },
  ]
  const prompt = buildPrompt({ question: '追问', bundle: null, history, requireCitations: true })
  assert.ok(prompt.user.includes('Q: 之前的问题'))
  assert.ok(prompt.user.includes('A: 之前的回答'))
})

test('buildPrompt: history is bounded by historyTurns', () => {
  const history = []
  for (let index = 0; index < 20; index += 1) {
    history.push({ id: `h${index}`, role: index % 2 === 0 ? 'user' : 'assistant', text: `轮次 ${index}`, createdAt: index })
  }
  const prompt = buildPrompt({ question: 'q', bundle: null, history, requireCitations: true, historyTurns: 2 })
  assert.equal((prompt.user.match(/Q: /g) ?? []).length, 1)
  assert.ok(prompt.user.includes('轮次 18'))
  assert.ok(!prompt.user.includes('轮次 0'))
})

test('buildSummaryPrompt: asks for a bounded Chinese summary', () => {
  const prompt = buildSummaryPrompt([{ role: 'user', text: '目标：重构插件' }])
  assert.ok(prompt.system.includes('摘要'))
  assert.ok(prompt.user.includes('重构插件'))
})
