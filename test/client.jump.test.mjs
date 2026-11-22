/**
 * Jump contract tests.
 *
 * The host transcript does not guarantee stable `data-message-id` attributes,
 * so the locator must degrade gracefully: exact selector → attribute scan →
 * visible-text probe. These tests drive the pure module with plain-object
 * element fakes (no `instanceof Element` checks in the implementation), which is
 * also the environment the module must tolerate at runtime.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  JUMP_HIGHLIGHT_ATTR,
  findAnchor,
  findAnchorWithStrategy,
  highlight,
  probeText,
  reveal,
} from '../lib/client/jump.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Minimal structural element fake: attributes, text, style, scroll capture. */
function makeElement({ attributes = {}, textContent = '', tag = 'div', style = {} } = {}) {
  const attrs = { ...attributes }
  const scrollCalls = []
  return {
    tagName: tag.toUpperCase(),
    textContent,
    style,
    __attrs: attrs,
    __scrollCalls: scrollCalls,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null
    },
    setAttribute(name, value) {
      attrs[name] = String(value)
    },
    removeAttribute(name) {
      delete attrs[name]
    },
    scrollIntoView(options) {
      scrollCalls.push(options)
    },
  }
}

/** Minimal structural root fake, answering only the selectors the module uses. */
function makeRoot({ selectors = {}, tagged = [], candidates = [] } = {}) {
  const seen = []
  return {
    __seen: seen,
    querySelectorAll(selector) {
      if (selector === '[data-message-id]') return tagged
      if (selector === 'p,li,pre,code,div,span,td,blockquote') return candidates
      return []
    },
    querySelector(selector) {
      seen.push(selector)
      return Object.prototype.hasOwnProperty.call(selectors, selector) ? selectors[selector] : null
    },
  }
}

test('probeText collapses whitespace, truncates and rejects short probes', () => {
  assert.equal(probeText('  hello \n\t world  '), 'hello world')
  assert.equal(probeText('a'.repeat(40)), 'a'.repeat(24))
  assert.equal(probeText('a'.repeat(40), 12), 'a'.repeat(12))
  assert.equal(probeText('短'), '', 'probes shorter than 8 characters are useless')
  assert.equal(probeText('   '), '')
  assert.equal(probeText(''), '')
})

test('findAnchorWithStrategy resolves an exact data-message-id selector', () => {
  const element = makeElement({ attributes: { 'data-message-id': 'm1' } })
  const root = makeRoot({ selectors: { '[data-message-id="m1"]': element } })

  const found = findAnchorWithStrategy(root, { messageId: 'm1', excerpt: '' })
  assert.equal(found.element, element)
  assert.equal(found.strategy, 'message-id')
  assert.deepEqual(root.__seen, ['[data-message-id="m1"]'])
})

test('findAnchorWithStrategy escapes backslashes and quotes in the id', () => {
  const element = makeElement({ attributes: { 'data-message-id': 'a"b\\c' } })
  const selector = '[data-message-id="a\\"b\\\\c"]'
  const root = makeRoot({ selectors: { [selector]: element } })

  const found = findAnchorWithStrategy(root, { messageId: 'a"b\\c', excerpt: '' })
  assert.equal(found.element, element)
  assert.equal(found.strategy, 'message-id')
  assert.deepEqual(root.__seen, [selector], 'the id must be CSS-escaped locally')
})

test('findAnchorWithStrategy scans data-message-id when the selector misses', () => {
  const older = makeElement({ attributes: { 'data-message-id': 'm1' } })
  const newer = makeElement({ attributes: { 'data-message-id': 'm2' } })
  const root = makeRoot({ tagged: [older, newer] })

  const found = findAnchorWithStrategy(root, { messageId: 'm2', excerpt: '' })
  assert.equal(found.element, newer)
  assert.equal(found.strategy, 'message-id')
})

test('excerpt fallback picks the tightest matching element', () => {
  const container = makeElement({
    textContent: 'Unique excerpt text and a lot of surrounding prose that makes this container far too big to highlight. '.repeat(2),
  })
  const tight = makeElement({ tag: 'p', textContent: 'Unique   excerpt\ntext' })
  const loose = makeElement({ textContent: 'Unique excerpt text plus extra words' })
  const root = makeRoot({ candidates: [container, tight, loose] })

  const found = findAnchorWithStrategy(root, { messageId: 'missing', excerpt: 'Unique excerpt text' })
  assert.equal(found.element, tight)
  assert.equal(found.strategy, 'excerpt')
})

test('excerpt fallback resolves equal-size matches to the last one', () => {
  const earlier = makeElement({ tag: 'p', textContent: 'xx probe text' })
  const later = makeElement({ tag: 'p', textContent: 'probe text xx' })
  const root = makeRoot({ candidates: [earlier, later] })

  const found = findAnchorWithStrategy(root, { messageId: 'missing', excerpt: 'probe text' })
  assert.equal(found.element, later)
})

test('too-short excerpts never match and yield null', () => {
  const element = makeElement({ textContent: 'short' })
  const root = makeRoot({ candidates: [element] })
  assert.equal(findAnchorWithStrategy(root, { messageId: 'missing', excerpt: 'short' }), null)
})

test('a long excerpt with no matching text yields null', () => {
  const root = makeRoot({ candidates: [makeElement({ textContent: 'totally different content here' })] })
  assert.equal(findAnchorWithStrategy(root, { messageId: 'missing', excerpt: 'Unique excerpt text' }), null)
  assert.equal(findAnchorWithStrategy(makeRoot(), { messageId: 'missing', excerpt: 'Unique excerpt text' }), null)
})

test('findAnchor wraps the strategy result', () => {
  const element = makeElement({ attributes: { 'data-message-id': 'm9' } })
  assert.equal(findAnchor(makeRoot({ selectors: { '[data-message-id="m9"]': element } }), { messageId: 'm9', excerpt: '' }), element)
  assert.equal(findAnchor(makeRoot(), { messageId: 'nope', excerpt: '' }), null)
})

test('reveal scrolls once with smooth centering, highlights and reports the strategy', () => {
  const element = makeElement({ attributes: { 'data-message-id': 'm7' } })
  const root = makeRoot({ selectors: { '[data-message-id="m7"]': element } })

  assert.equal(reveal(root, { messageId: 'm7', excerpt: '' }), 'message-id')
  assert.deepEqual(element.__scrollCalls, [{ block: 'center', behavior: 'smooth' }])
  assert.equal(element.__attrs[JUMP_HIGHLIGHT_ATTR], '1')
})

test('reveal falls back to a plain scrollIntoView when options are rejected', () => {
  const element = makeElement({ attributes: { 'data-message-id': 'm8' } })
  const calls = []
  element.scrollIntoView = (options) => {
    calls.push(options)
    if (options !== undefined) throw new Error('options unsupported')
  }
  const root = makeRoot({ selectors: { '[data-message-id="m8"]': element } })

  assert.equal(reveal(root, { messageId: 'm8', excerpt: '' }), 'message-id')
  assert.deepEqual(calls, [{ block: 'center', behavior: 'smooth' }, undefined])
})

test('reveal reports the excerpt strategy and not-found', () => {
  const tight = makeElement({ tag: 'p', textContent: 'Unique excerpt text' })
  const excerptRoot = makeRoot({ candidates: [tight] })
  assert.equal(reveal(excerptRoot, { messageId: 'missing', excerpt: 'Unique excerpt text' }), 'excerpt')
  assert.equal(tight.__scrollCalls.length, 1)

  assert.equal(reveal(makeRoot(), { messageId: 'missing', excerpt: 'Unique excerpt text' }), 'not-found')
})

test('highlight sets then restores the attribute and inline styles', async () => {
  const element = makeElement({
    attributes: { [JUMP_HIGHLIGHT_ATTR]: 'previous' },
    style: { outline: '1px solid red', outlineOffset: '0px', borderRadius: '0px' },
  })
  highlight(element, 20)

  assert.equal(element.__attrs[JUMP_HIGHLIGHT_ATTR], '1')
  assert.equal(element.style.outline, '2px solid #4d7ef0')
  assert.equal(element.style.outlineOffset, '2px')
  assert.equal(element.style.borderRadius, '6px')

  await sleep(120)
  assert.equal(element.__attrs[JUMP_HIGHLIGHT_ATTR], 'previous')
  assert.equal(element.style.outline, '1px solid red')
  assert.equal(element.style.outlineOffset, '0px')
  assert.equal(element.style.borderRadius, '0px')
})

test('highlight removes a highlight it added and tolerates a style-less element', async () => {
  const element = makeElement({ style: {} })
  highlight(element, 20)
  assert.equal(element.__attrs[JUMP_HIGHLIGHT_ATTR], '1')
  await sleep(120)
  assert.equal(element.getAttribute(JUMP_HIGHLIGHT_ATTR), null)
  assert.equal('outline' in element.style, false)

  const styleless = {
    attributes: {},
    getAttribute() {
      return null
    },
    setAttribute() {},
    removeAttribute() {},
  }
  assert.doesNotThrow(() => highlight(styleless, 5))
})
