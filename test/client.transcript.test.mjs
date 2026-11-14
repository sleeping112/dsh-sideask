import assert from 'node:assert/strict'
import test from 'node:test'

import {
  entriesToMessages,
  entryToMessage,
  hashMessage,
  lastRouteHint,
  projectIncrementally,
  textOfContent,
} from '../lib/client/transcript.js'

const userEntry = (id, text, seq = 1) => ({
  event: { type: 'user/message', seq, time: 1700000000000 + seq, data: { id, content: [{ type: 'text', text }] } },
})
const assistantEntry = (id, text, seq = 2) => ({
  event: {
    type: 'assistant/message',
    seq,
    time: 1700000000000 + seq,
    data: { message: { id, content: [{ type: 'text', text }] } },
  },
})

test('textOfContent joins only text blocks', () => {
  assert.equal(textOfContent([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(textOfContent([{ type: 'image', url: 'x' }]), '')
  assert.equal(textOfContent('plain'), 'plain')
  assert.equal(textOfContent(undefined), '')
})

test('entryToMessage maps user and assistant messages', () => {
  const user = entryToMessage(userEntry('u1', '你好'))
  assert.equal(user.role, 'user')
  assert.equal(user.id, 'u1')
  assert.equal(user.text, '你好')

  const assistant = entryToMessage(assistantEntry('a1', '你好呀'))
  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.id, 'a1')
})

test('entryToMessage skips hidden reasoning, tool events and structure', () => {
  assert.equal(entryToMessage({ event: { type: 'turn/start', data: {} } }), null)
  assert.equal(entryToMessage({ event: { type: 'step/start', data: {} } }), null)
  assert.equal(entryToMessage({ event: { type: 'assistant/message', data: { message: { id: 'x', content: [{ type: 'reasoning', text: 'cot' }] } } } }), null)
  assert.equal(entryToMessage({ event: { type: 'tool/result', data: { text: 'out' } } }), null)
  assert.equal(entryToMessage({ event: { type: 'user/message', data: { id: 'u', content: [] } } }), null)
})

test('entriesToMessages preserves order and dedupes ids', () => {
  const messages = entriesToMessages([userEntry('u1', '一'), assistantEntry('a1', '二'), userEntry('u1', '一')])
  assert.deepEqual(messages.map((message) => message.id), ['u1', 'a1'])
  assert.deepEqual(messages.map((message) => message.text), ['一', '二'])
})

test('entriesToMessages tolerates junk input', () => {
  assert.deepEqual(entriesToMessages(null), [])
  assert.deepEqual(entriesToMessages('nope'), [])
  assert.deepEqual(entriesToMessages([null, 42, {}]), [])
})

test('projectIncrementally reports only new or changed messages', () => {
  const cache = new Map()
  const first = projectIncrementally([userEntry('u1', '一'), assistantEntry('a1', '二')], cache)
  assert.deepEqual(first.changedIds.sort(), ['a1', 'u1'])
  assert.deepEqual(first.removedIds, [])

  const second = projectIncrementally([userEntry('u1', '一'), assistantEntry('a1', '二')], cache)
  assert.deepEqual(second.changedIds, [])

  const grown = projectIncrementally([userEntry('u1', '一'), assistantEntry('a1', '二'), userEntry('u2', '三')], cache)
  assert.deepEqual(grown.changedIds, ['u2'])

  // A streamed assistant message that grew must be re-projected.
  const edited = projectIncrementally([userEntry('u1', '一'), assistantEntry('a1', '二，追加')], cache)
  assert.deepEqual(edited.changedIds, ['a1'])
})

test('projectIncrementally drops messages outside the window', () => {
  const cache = new Map()
  projectIncrementally([userEntry('u1', '一'), userEntry('u2', '二')], cache)
  const next = projectIncrementally([userEntry('u2', '二')], cache)
  assert.deepEqual(next.removedIds, ['u1'])
  assert.deepEqual([...cache.keys()], ['u2'])
})

test('hashMessage is stable and content-sensitive', () => {
  const message = { id: 'm1', role: 'user', text: 'x' }
  assert.equal(hashMessage(message), hashMessage({ ...message }))
  assert.notEqual(hashMessage(message), hashMessage({ ...message, text: 'y' }))
  assert.notEqual(hashMessage(message), hashMessage({ ...message, role: 'assistant' }))
})

const assistantWithSource = (id, provider, model, seq = 5) => ({
  event: {
    type: 'assistant/message',
    seq,
    data: {
      message: {
        id,
        content: [{ type: 'text', text: 'answer' }],
        source: { kind: 'model', provider, model },
      },
    },
  },
})

test('lastRouteHint reads the newest assistant message source', () => {
  const entries = [
    assistantWithSource('a1', 'deepseek-official', 'deepseek-flash', 1),
    assistantWithSource('a2', 'deepseek-account', 'deepseek-flash', 2),
    { event: { type: 'user/message', seq: 3, data: { id: 'u1', content: [{ type: 'text', text: 'hi' }] } } },
  ]
  assert.deepEqual(lastRouteHint(entries), { provider: 'deepseek-account', model: 'deepseek-flash' })
})

test('lastRouteHint returns null when no assistant message carries a model source', () => {
  assert.equal(lastRouteHint([]), null)
  assert.equal(lastRouteHint(null), null)
  assert.equal(
    lastRouteHint([{ event: { type: 'assistant/message', data: { message: { id: 'a', content: [{ type: 'text', text: 'x' }] } } } }]),
    null,
  )
  assert.equal(
    lastRouteHint([{ event: { type: 'assistant/message', data: { message: { id: 'a', source: { provider: 'p' } } } } }]),
    null,
  )
})
