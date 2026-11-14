import assert from 'node:assert/strict'
import test from 'node:test'

import { formatHotkey, matchesHotkey, parseHotkey } from '../lib/client/hotkey.js'

const event = (overrides = {}) => ({
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  code: 'KeyA',
  ...overrides,
})

test('parseHotkey parses the documented default', () => {
  assert.deepEqual(parseHotkey('Alt+Shift+A'), { alt: true, ctrl: false, meta: false, shift: true, code: 'KeyA' })
})

test('parseHotkey accepts primary-agnostic modifier aliases', () => {
  assert.deepEqual(parseHotkey('Ctrl+Shift+A'), { alt: false, ctrl: true, meta: false, shift: true, code: 'KeyA' })
  assert.deepEqual(parseHotkey('Cmd+Alt+K'), { alt: true, ctrl: false, meta: true, shift: false, code: 'KeyK' })
  assert.deepEqual(parseHotkey('Option+Shift+1').code, 'Digit1')
  assert.deepEqual(parseHotkey('F5'), { alt: false, ctrl: false, meta: false, shift: false, code: 'F5' })
})

test('parseHotkey rejects nonsense instead of throwing', () => {
  for (const spec of ['', '+', 'Alt+Shift', 'Alt+A+B', 'Alt+UnknownKey']) {
    assert.equal(parseHotkey(spec), null, spec)
  }
})

test('matchesHotkey requires an exact modifier match', () => {
  const parsed = parseHotkey('Alt+Shift+A')
  assert.equal(matchesHotkey(parsed, event({ altKey: true, shiftKey: true })), true)
  assert.equal(matchesHotkey(parsed, event({ altKey: true, shiftKey: true, ctrlKey: true })), false)
  assert.equal(matchesHotkey(parsed, event({ altKey: true })), false)
  assert.equal(matchesHotkey(parsed, event({ altKey: true, shiftKey: true, code: 'KeyB' })), false)
})

test('matchesHotkey never treats plain typing as the hotkey', () => {
  const parsed = parseHotkey('Alt+Shift+A')
  assert.equal(matchesHotkey(parsed, event()), false)
})

test('formatHotkey round-trips to a readable label', () => {
  assert.equal(formatHotkey(parseHotkey('Alt+Shift+A')), 'Alt+Shift+A')
  assert.equal(formatHotkey(parseHotkey('Ctrl+K')), 'Ctrl+K')
  assert.equal(formatHotkey(parseHotkey('F5')), 'F5')
})
