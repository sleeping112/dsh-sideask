import assert from 'node:assert/strict'
import test from 'node:test'

import { parseInline, parseMarkdown, refsInText } from '../lib/client/markdown.js'
import { STREAM_BUCKET_CHARS, markdownBucket } from '../lib/client/markdown.js'

test('parseInline: plain text stays text', () => {
  assert.deepEqual(parseInline('你好'), [{ type: 'text', text: '你好' }])
})

test('parseInline: bold and inline code', () => {
  const inlines = parseInline('用 **粗体** 和 `代码` 混排')
  assert.deepEqual(
    inlines.map((inline) => inline.type),
    ['text', 'bold', 'text', 'code', 'text'],
  )
  assert.equal(inlines[1].text, '粗体')
  assert.equal(inlines[3].text, '代码')
})

test('parseInline: citation markers become citation nodes', () => {
  const inlines = parseInline('因为 [c1] 与 [C2] 都成立')
  const citations = inlines.filter((inline) => inline.type === 'citation')
  assert.deepEqual(citations.map((citation) => citation.ref), ['c1', 'c2'])
})

test('parseInline: unmatched markers degrade to text', () => {
  const inlines = parseInline('**没有闭合')
  assert.ok(inlines.every((inline) => inline.type === 'text'))
  assert.equal(inlines.map((inline) => inline.text).join(''), '**没有闭合')
})

test('parseMarkdown: paragraphs and blank lines', () => {
  const blocks = parseMarkdown('第一段\n\n第二段')
  assert.deepEqual(blocks.map((block) => block.type), ['paragraph', 'paragraph'])
})

test('parseMarkdown: fenced code keeps content verbatim', () => {
  const blocks = parseMarkdown('前\n```ts\nconst a = 1\nconst b = 2\n```\n后')
  const code = blocks.find((block) => block.type === 'code')
  assert.equal(code.lang, 'ts')
  assert.equal(code.text, 'const a = 1\nconst b = 2')
})

test('parseMarkdown: headings and lists', () => {
  const blocks = parseMarkdown('## 标题\n\n- 一\n- 二\n\n1. 甲\n2. 乙')
  assert.deepEqual(blocks.map((block) => block.type), ['heading', 'list', 'list'])
  assert.equal(blocks[0].level, 2)
  assert.equal(blocks[1].ordered, false)
  assert.equal(blocks[2].ordered, true)
})

test('parseMarkdown: blockquote', () => {
  const blocks = parseMarkdown('> 引用一\n> 引用二')
  assert.equal(blocks[0].type, 'quote')
  const text = blocks[0].inlines.map((inline) => inline.text).join('')
  assert.ok(text.includes('引用一') && text.includes('引用二'))
})

test('parseMarkdown: incomplete fence does not crash', () => {
  const blocks = parseMarkdown('```\n没有结束')
  assert.equal(blocks[0].type, 'code')
})

test('parseMarkdown: HTML-looking text is preserved as text (never markup)', () => {
  const blocks = parseMarkdown('<img src=x onerror=alert(1)>')
  const text = blocks[0].inlines.map((inline) => inline.text).join('')
  assert.ok(text.includes('<img'))
  assert.equal(blocks[0].type, 'paragraph')
})

test('refsInText collects unique refs in order', () => {
  assert.deepEqual(refsInText('a [c2] b [c1] c [c2]'), ['c2', 'c1'])
  assert.deepEqual(refsInText('无引用'), [])
})

test('markdownBucket keeps the parse key stable within a streaming bucket', () => {
  const a = 'x'.repeat(10)
  const b = 'x'.repeat(STREAM_BUCKET_CHARS - 1)
  assert.equal(markdownBucket(a, true), markdownBucket(b, true))
  // Crossing a bucket boundary must produce a new key.
  assert.notEqual(markdownBucket('x'.repeat(STREAM_BUCKET_CHARS + 1), true), markdownBucket(b, true))
  assert.notEqual(markdownBucket('x'.repeat(STREAM_BUCKET_CHARS * 2 + 1), true), markdownBucket(a, true))
})

test('markdownBucket always re-parses once the stream settles', () => {
  const text = '已经完成的长回答'.repeat(10)
  const streamingKey = markdownBucket(text, true)
  const finalKey = markdownBucket(text, false)
  assert.notEqual(streamingKey, finalKey)
  assert.ok(finalKey.startsWith('final:'))
  // Two different settled lengths must not share a key (final text replaced).
  assert.notEqual(markdownBucket(text, false), markdownBucket(text + 'x', false))
})
