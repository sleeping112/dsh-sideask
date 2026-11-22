import assert from 'node:assert/strict'
import test from 'node:test'

import { PROMPT_TEMPLATES, applyTemplate, orderedTemplates, templateById } from '../lib/client/templates.js'

test('templates have unique ids, labels and non-empty text', () => {
  const ids = new Set()
  for (const template of PROMPT_TEMPLATES) {
    assert.ok(template.id.length > 0)
    assert.ok(template.label.length > 0)
    assert.ok(template.text.length > 6)
    assert.ok(template.hint.length > 0)
    assert.ok(!ids.has(template.id), `duplicate id ${template.id}`)
    ids.add(template.id)
  }
  assert.ok(PROMPT_TEMPLATES.length >= 5)
})

test('templateById finds known templates and rejects unknown ids', () => {
  assert.equal(templateById('risks')?.label, '找风险')
  assert.equal(templateById('nope'), null)
})

test('applyTemplate replaces an empty draft and appends to a non-empty one', () => {
  const template = templateById('summary')
  assert.equal(applyTemplate(template, ''), template.text)
  assert.equal(applyTemplate(template, '   '), template.text)
  const merged = applyTemplate(template, '先看这个：\nfoo')
  assert.ok(merged.startsWith('先看这个：\nfoo'))
  assert.ok(merged.endsWith(template.text))
  assert.ok(merged.includes('\n\n'))
})

test('orderedTemplates puts selection-oriented templates first when selecting', () => {
  const ordered = orderedTemplates(true)
  assert.equal(ordered[0].id, 'explain')
  assert.equal(ordered[1].id, 'risks')
  assert.equal(ordered.length, PROMPT_TEMPLATES.length)
  assert.deepEqual(orderedTemplates(false), PROMPT_TEMPLATES)
})
