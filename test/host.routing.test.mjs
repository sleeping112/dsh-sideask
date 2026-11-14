/**
 * Route-selection tests.
 *
 * The policy these pin down was learned from a real failure: the host's *global
 * default model* pointed at `deepseek-official` (an API-key route with no key in
 * this environment), while the conversation was running on `deepseek-account`
 * (the signed-in account route). A side question must follow the conversation's
 * route, not the global default.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { candidateRoutes } from '../lib/host/llm.js'

const llmWith = (...ids) => ({
  listProviders: () => ids.map((id) => ({ id })),
  async *stream() {},
})

const defaultModel = (provider, model) => ({ currentSelection: () => ({ provider, model }) })

const EMPTY_CONFIG = { provider: '', model: '' }

test('route hint outranks the host default model', () => {
  const routes = candidateRoutes(
    EMPTY_CONFIG,
    llmWith('deepseek-official', 'deepseek-account'),
    defaultModel('deepseek-official', 'deepseek-flash'),
    { provider: 'deepseek-account', model: 'deepseek-flash' },
  )
  assert.deepEqual(routes[0], { provider: 'deepseek-account', model: 'deepseek-flash', source: 'route-hint' })
})

test('explicit plugin config outranks everything', () => {
  const routes = candidateRoutes(
    { provider: 'deepseek-account', model: 'deepseek-flash' },
    llmWith('deepseek-official'),
    defaultModel('deepseek-official', 'deepseek-flash'),
    { provider: 'deepseek-account', model: 'pro' },
  )
  assert.deepEqual(routes[0], { provider: 'deepseek-account', model: 'deepseek-flash', source: 'config' })
})

test('without a hint the default model is used', () => {
  const routes = candidateRoutes(EMPTY_CONFIG, llmWith('deepseek-official'), defaultModel('deepseek-official', 'deepseek-flash'))
  assert.equal(routes[0].provider, 'deepseek-official')
  assert.equal(routes[0].source, 'default-model')
})

test('other providers are queued as fallbacks with a known model', () => {
  const routes = candidateRoutes(
    EMPTY_CONFIG,
    llmWith('deepseek-official', 'deepseek-account'),
    defaultModel('deepseek-official', 'deepseek-flash'),
    { provider: 'deepseek-account', model: 'deepseek-flash' },
  )
  const providers = routes.map((route) => route.provider)
  assert.deepEqual(providers, ['deepseek-account', 'deepseek-official'])
})

test('routes are de-duplicated', () => {
  const routes = candidateRoutes(
    { provider: 'deepseek-account', model: 'deepseek-flash' },
    llmWith('deepseek-account', 'deepseek-official'),
    defaultModel('deepseek-account', 'deepseek-flash'),
    { provider: 'deepseek-account', model: 'deepseek-flash' },
  )
  assert.equal(routes.filter((route) => route.provider === 'deepseek-account').length, 1)
})

test('an unavailable llm yields no candidates', () => {
  assert.deepEqual(candidateRoutes(EMPTY_CONFIG, undefined, undefined, null), [])
})

test('a broken default-model service does not break candidate building', () => {
  const routes = candidateRoutes(
    EMPTY_CONFIG,
    llmWith('deepseek-account'),
    {
      currentSelection: () => {
        throw new Error('settings unavailable')
      },
    },
    { provider: 'deepseek-account', model: 'deepseek-flash' },
  )
  assert.equal(routes[0].provider, 'deepseek-account')
})
