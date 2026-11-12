import assert from 'node:assert/strict'
import test from 'node:test'

import { SseDecoder, decodeFrame, initialAnswer, isTerminal, mergeCitations, reduceAnswer } from '../lib/client/stream.js'

const accepted = 'data: {"type":"accepted","requestId":"r1","mode":"context"}\n\n'
const delta = (text) => `data: ${JSON.stringify({ type: 'delta', requestId: 'r1', text })}\n\n`

test('SseDecoder: one frame per chunk', () => {
  const decoder = new SseDecoder()
  const events = decoder.push(accepted)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'accepted')
  assert.equal(decoder.pending, '')
})

test('SseDecoder: a frame split across chunks is reassembled', () => {
  const decoder = new SseDecoder()
  const frame = delta('你好')
  const first = decoder.push(frame.slice(0, 12))
  assert.deepEqual(first, [])
  const second = decoder.push(frame.slice(12))
  assert.equal(second.length, 1)
  assert.equal(second[0].text, '你好')
})

test('SseDecoder: several frames in one chunk', () => {
  const decoder = new SseDecoder()
  const events = decoder.push(accepted + delta('a') + delta('b'))
  assert.deepEqual(events.map((event) => event.type), ['accepted', 'delta', 'delta'])
  assert.deepEqual(events.map((event) => event.text ?? ''), ['', 'a', 'b'])
})

test('SseDecoder: malformed JSON is skipped without killing the stream', () => {
  const decoder = new SseDecoder()
  const events = decoder.push('data: {oops\n\n' + delta('ok'))
  assert.equal(events.length, 1)
  assert.equal(events[0].text, 'ok')
})

test('SseDecoder: comment/heartbeat frames are ignored', () => {
  const decoder = new SseDecoder()
  assert.deepEqual(decoder.push(': keep-alive\n\n'), [])
})

test('SseDecoder: flush drains a trailing frame with no blank line', () => {
  const decoder = new SseDecoder()
  decoder.push('data: {"type":"done","requestId":"r1","messageId":"m","text":"hi","citations":[]}')
  const events = decoder.flush()
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'done')
})

test('decodeFrame: rejects non-object and typeless payloads', () => {
  assert.equal(decodeFrame('data: 42'), null)
  assert.equal(decodeFrame('data: {"no":"type"}'), null)
  assert.equal(decodeFrame('event: x'), null)
})

test('reduceAnswer: text accumulates, terminal states are sticky', () => {
  let state = initialAnswer()
  state = reduceAnswer(state, { type: 'accepted', requestId: 'r1', mode: 'context' })
  assert.equal(state.status, 'streaming')
  state = reduceAnswer(state, { type: 'delta', requestId: 'r1', text: '你' })
  state = reduceAnswer(state, { type: 'delta', requestId: 'r1', text: '好' })
  assert.equal(state.text, '你好')
  state = reduceAnswer(state, { type: 'done', requestId: 'r1', messageId: 'm1', text: '你好。', citations: [] })
  assert.equal(state.status, 'done')
  assert.equal(state.text, '你好。')
  // A late delta after done must not regress the answer.
  const after = reduceAnswer(state, { type: 'delta', requestId: 'r1', text: '!!!' })
  assert.equal(after.text, '你好。')
})

test('reduceAnswer: error carries the contract error and stays terminal', () => {
  let state = reduceAnswer(initialAnswer(), { type: 'accepted', requestId: 'r1', mode: 'question-only' })
  state = reduceAnswer(state, {
    type: 'error',
    requestId: 'r1',
    error: { code: 'RATE_LIMIT', message: 'slow down', retryable: true, degradableToQuestionOnly: false },
  })
  assert.equal(state.status, 'error')
  assert.equal(state.error.code, 'RATE_LIMIT')
  assert.equal(state.error.retryable, true)
})

test('reduceAnswer: mode and usage are captured', () => {
  let state = reduceAnswer(initialAnswer(), { type: 'accepted', requestId: 'r1', mode: 'question-only' })
  assert.equal(state.mode, 'question-only')
  state = reduceAnswer(state, { type: 'usage', requestId: 'r1', promptTokens: 100, completionTokens: 20 })
  assert.equal(state.promptTokens, 100)
  assert.equal(state.completionTokens, 20)
})

test('isTerminal only recognises done and error', () => {
  assert.equal(isTerminal({ type: 'done' }), true)
  assert.equal(isTerminal({ type: 'error' }), true)
  assert.equal(isTerminal({ type: 'delta' }), false)
  assert.equal(isTerminal({ type: 'usage' }), false)
})

test('mergeCitations keeps one entry per ref, last wins', () => {
  const merged = mergeCitations(
    [{ ref: 'c1', messageId: 'm1', role: 'user', excerpt: 'old' }],
    [{ ref: 'c1', messageId: 'm1', role: 'user', excerpt: 'new' }, { ref: 'c2', messageId: 'm2', role: 'assistant', excerpt: 'x' }],
  )
  assert.equal(merged.length, 2)
  assert.equal(merged[0].excerpt, 'new')
})
