/**
 * Host-half tests for the two newer API capabilities:
 *
 * - `POST /threads/<id>/truncate` — the "regenerate answer" primitive: drop a
 *   message and everything after it, then ask again.
 * - `GET /models` — the lazy provider/model catalogue behind the in-window
 *   model picker. It is a separate route because the host's
 *   `ctx.llm.listModels(provider)` is async and may be slow, absent, or broken;
 *   bootstrap must stay synchronous.
 *
 * Run with: `node scripts/build.mjs` then `node --test`.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import {
  API_VERSION,
  FakeLlm,
  ROUTE,
  baseConfig,
  getRequest,
  jsonRequest,
  loadHostPlugin,
  mountHost,
  tempHome,
} from './harness/fake-context.mjs'

const plugin = await loadHostPlugin()

after(() => {
  delete process.env.DSH_HOME
})

/** Mount the host with a fresh throwaway `$DSH_HOME` (mirrors host.http.test). */
function mount(t, { config = {}, llm, defaultModel } = {}) {
  const home = tempHome()
  const host = mountHost(plugin, baseConfig(config), { llm, defaultModel, dshHome: home.dir })
  t.after(() => {
    try {
      host.dispose()
    } finally {
      home.cleanup()
      delete process.env.DSH_HOME
    }
  })
  return { host, home }
}

/** Distinct answer per call so truncation is observable in the thread text. */
function answerLlm() {
  return new FakeLlm({
    script: (callIndex) => ({ mode: 'success', answer: `回答-${callIndex}`, usage: { inputTokens: 10, outputTokens: 4 } }),
  })
}

async function ask(host, threadId, question) {
  return host.request(
    jsonRequest(ROUTE.ask, { apiVersion: API_VERSION, requestId: 'req-truncate', threadId, question, context: null }),
  )
}

async function threadTexts(host, threadId) {
  const response = await host.request(getRequest(ROUTE.thread(threadId)))
  assert.equal(response.statusCode, 200)
  return response.json.messages.map((message) => message.text)
}

// ----------------------------------------------------------------- truncate

describe('POST /threads/<id>/truncate', () => {
  it('removes the chosen message and everything after it, keeping earlier messages', async (t) => {
    const { host } = mount(t, { llm: answerLlm() })
    await ask(host, 'th-truncate-tail', '第一问')
    await ask(host, 'th-truncate-tail', '第二问')
    assert.deepEqual(await threadTexts(host, 'th-truncate-tail'), ['第一问', '回答-1', '第二问', '回答-2'])

    const before = await host.request(getRequest(ROUTE.thread('th-truncate-tail')))
    const secondUser = before.json.messages[2]
    const response = await host.request(
      jsonRequest(ROUTE.truncate('th-truncate-tail'), { fromMessageId: secondUser.id }),
    )
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json, { removed: 2 })
    assert.deepEqual(await threadTexts(host, 'th-truncate-tail'), ['第一问', '回答-1'])

    // Truncating from an assistant answer drops just that answer, not its question.
    const partial = await host.request(
      jsonRequest(ROUTE.truncate('th-truncate-tail'), { fromMessageId: before.json.messages[1].id }),
    )
    assert.equal(partial.statusCode, 200)
    assert.deepEqual(partial.json, { removed: 1 })
    assert.deepEqual(await threadTexts(host, 'th-truncate-tail'), ['第一问'])
  })

  it('answers 404 for an unknown thread and removes nothing for an unknown message id', async (t) => {
    const { host } = mount(t, { llm: answerLlm() })
    await ask(host, 'th-truncate-known', '问题')

    const missingThread = await host.request(
      jsonRequest(ROUTE.truncate('th-truncate-missing'), { fromMessageId: 'm-1' }),
    )
    assert.equal(missingThread.statusCode, 404)
    assert.equal(missingThread.json.error.code, 'BAD_REQUEST')

    const missingMessage = await host.request(
      jsonRequest(ROUTE.truncate('th-truncate-known'), { fromMessageId: 'm-does-not-exist' }),
    )
    assert.equal(missingMessage.statusCode, 200)
    assert.deepEqual(missingMessage.json, { removed: 0 })
    // A no-op truncate must not alter the thread.
    assert.deepEqual(await threadTexts(host, 'th-truncate-known'), ['问题', '回答-1'])
  })

  it('answers 400 for a bad body and 405 for a non-POST truncate', async (t) => {
    const { host } = mount(t, { llm: answerLlm() })
    await ask(host, 'th-truncate-bad', '问题')

    const badBodies = [
      jsonRequest(ROUTE.truncate('th-truncate-bad'), {}),
      jsonRequest(ROUTE.truncate('th-truncate-bad'), { fromMessageId: 42 }),
      jsonRequest(ROUTE.truncate('th-truncate-bad'), { fromMessageId: '' }),
      jsonRequest(ROUTE.truncate('th-truncate-bad'), '{not json'),
    ]
    for (const request of badBodies) {
      const response = await host.request(request)
      assert.equal(response.statusCode, 400, `expected 400 for body ${request.body}`)
      assert.equal(response.json.error.code, 'BAD_REQUEST')
    }

    const notPost = await host.request(getRequest(ROUTE.truncate('th-truncate-bad')))
    assert.equal(notPost.statusCode, 405)
    assert.equal(notPost.headers.allow, 'POST')
  })

  it('appends again after truncate, with the kept exchange in the prompt history', async (t) => {
    const llm = answerLlm()
    const { host } = mount(t, { llm })
    await ask(host, 'th-regenerate', '第一问')
    await ask(host, 'th-regenerate', '第二问')

    const before = await host.request(getRequest(ROUTE.thread('th-regenerate')))
    const truncated = await host.request(
      jsonRequest(ROUTE.truncate('th-regenerate'), { fromMessageId: before.json.messages[2].id }),
    )
    assert.deepEqual(truncated.json, { removed: 2 })

    const answered = await ask(host, 'th-regenerate', '重新问')
    assert.equal(answered.events.some((event) => event.type === 'done'), true)

    assert.deepEqual(await threadTexts(host, 'th-regenerate'), ['第一问', '回答-1', '重新问', '回答-3'])
    const promptBody = llm.lastRequest.messages[1].content[0].text
    assert.match(promptBody, /回答-1/, 'the kept answer must be replayed as prompt history')
    assert.match(promptBody, /重新问/)
    assert.equal(promptBody.includes('第二问'), false, 'a truncated question leaked into the prompt')
    assert.equal(promptBody.includes('回答-2'), false, 'a truncated answer leaked into the prompt')
  })

  it('applies the same-origin guard', async (t) => {
    const { host } = mount(t, { llm: answerLlm() })
    await ask(host, 'th-truncate-cors', '问题')
    const response = await host.request(
      jsonRequest(
        ROUTE.truncate('th-truncate-cors'),
        { fromMessageId: 'whatever' },
        { headers: { origin: 'https://evil.example', host: '127.0.0.1:3000' } },
      ),
    )
    assert.equal(response.statusCode, 403)
  })
})

// ------------------------------------------------------------------- models

describe('GET /models', () => {
  it('normalises, de-duplicates, and caps an async provider catalogue', async (t) => {
    const llm = new FakeLlm({
      providers: [{ id: 'deepseek' }, { id: 'other' }, { id: 'noisy' }, { id: 'broken' }],
      catalog: (provider) => {
        if (provider === 'broken') throw new Error('catalogue unavailable')
        if (provider === 'other') return []
        if (provider === 'noisy') return [{ id: `  ${'z'.repeat(80)}  ` }]
        return [
          { id: 'deepseek-chat', name: 'DeepSeek Chat' },
          { id: 'deepseek-chat', name: 'duplicate id' },
          { id: 'deepseek-reasoner' },
          { model: 'deepseek-legacy', name: 'Legacy' },
          { id: '' },
          { name: 'name-only' },
          ...Array.from({ length: 60 }, (_, index) => ({ id: `bulk-${index}`, name: `Bulk ${index}` })),
        ]
      },
    })
    const { host } = mount(t, { llm })

    const response = await host.request(getRequest(ROUTE.models))
    assert.equal(response.statusCode, 200)
    assert.match(response.headers['content-type'], /application\/json/)
    const body = response.json
    assert.equal(body.apiVersion, API_VERSION)
    assert.deepEqual(
      body.providers.map((entry) => entry.provider),
      ['deepseek', 'other', 'noisy', 'broken'],
    )

    const deepseek = body.providers[0]
    assert.deepEqual(deepseek.models.slice(0, 4), [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'deepseek-reasoner' },
      { id: 'deepseek-legacy', name: 'Legacy' },
      { id: 'name-only', name: 'name-only' },
    ])
    assert.equal(deepseek.models.length, 50, 'per-provider model cap must be 50')
    assert.equal(deepseek.models.filter((model) => model.id === 'deepseek-chat').length, 1)

    assert.deepEqual(body.providers[1], { provider: 'other', models: [] })
    assert.deepEqual(body.providers[2].models, [{ id: 'z'.repeat(64), name: 'z'.repeat(64) }])
    // A throwing adapter degrades to an empty list for that provider only.
    assert.deepEqual(body.providers[3], { provider: 'broken', models: [] })
  })

  it('caps the number of providers it queries', async (t) => {
    const providers = Array.from({ length: 10 }, (_, index) => ({ id: `p-${index}` }))
    const llm = new FakeLlm({
      providers,
      catalog: Object.fromEntries(providers.map((provider) => [provider.id, [{ id: 'm', name: 'M' }]])),
    })
    const { host } = mount(t, { llm })

    const response = await host.request(getRequest(ROUTE.models))
    assert.equal(response.statusCode, 200)
    assert.deepEqual(
      response.json.providers.map((entry) => entry.provider),
      ['p-0', 'p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6', 'p-7'],
    )
  })

  it('answers an empty catalogue when the host has no llm service', async (t) => {
    const { host } = mount(t, { llm: null, defaultModel: null })
    const response = await host.request(getRequest(ROUTE.models))
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json, { apiVersion: API_VERSION, providers: [] })
  })

  it('answers an empty catalogue when the llm does not advertise models', async (t) => {
    // The default FakeLlm has no `listModels` method at all.
    const { host } = mount(t)
    const response = await host.request(getRequest(ROUTE.models))
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json.providers, [])
  })

  it('rejects non-GET methods and cross-site requests', async (t) => {
    const { host } = mount(t)
    const post = await host.request(jsonRequest(ROUTE.models, {}))
    assert.equal(post.statusCode, 405)
    assert.equal(post.headers.allow, 'GET, HEAD')

    const crossSite = await host.request(
      getRequest(ROUTE.models, { headers: { origin: 'https://evil.example', host: '127.0.0.1:3000' } }),
    )
    assert.equal(crossSite.statusCode, 403)
    assert.equal(crossSite.json.error.code, 'BAD_REQUEST')
  })
})
