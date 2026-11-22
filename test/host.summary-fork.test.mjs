/**
 * Host-half tests for the v0.4 capabilities:
 *
 * - `POST /api/summarize` — compress main-conversation messages that fell out of
 *   the recent window. JSON, not SSE: the client only injects the finished text
 *   into a later prompt, so there is nothing to stream.
 * - `POST /api/threads/<id>/fork` — copy a side-thread prefix into a NEW thread
 *   so the user can branch a line of questioning without touching the source.
 *
 * Both routes are exercised through the BUILT plugin (`lib/host/index.js`) and
 * the fake cordis host, mirroring `test/host.truncate.test.mjs`.
 *
 * Run with: `node scripts/build.mjs` then `node --test`.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import {
  API_VERSION,
  FakeLlm,
  ROUTE,
  ROUTE_PREFIX,
  baseConfig,
  getRequest,
  jsonRequest,
  loadHostPlugin,
  mountHost,
  tempHome,
} from './harness/fake-context.mjs'

const plugin = await loadHostPlugin()

/** Routes added by this feature; not in the shared harness ROUTE table. */
const SUMMARIZE = `${ROUTE_PREFIX}/summarize`
const forkPath = (threadId) => `${ROUTE.thread(threadId)}/fork`

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

/** Distinct answer per call so copied prefixes are observable in the texts. */
function answerLlm() {
  return new FakeLlm({
    script: (callIndex) => ({ mode: 'success', answer: `回答-${callIndex}`, usage: { inputTokens: 10, outputTokens: 4 } }),
  })
}

async function ask(host, threadId, question) {
  return host.request(
    jsonRequest(ROUTE.ask, { apiVersion: API_VERSION, requestId: 'req-summary-fork', threadId, question, context: null }),
  )
}

async function readThread(host, threadId) {
  const response = await host.request(getRequest(ROUTE.thread(threadId)))
  assert.equal(response.statusCode, 200)
  return response.json
}

// --------------------------------------------------------------------- fork

describe('POST /threads/<id>/fork', () => {
  it('copies the prefix through fromMessageId, regenerates ids, remaps replyTo, and leaves the source untouched', async (t) => {
    const { host } = mount(t, { llm: answerLlm() })
    await ask(host, 'th-fork-source', '第一问')
    await ask(host, 'th-fork-source', '第二问')
    const sourceBefore = await readThread(host, 'th-fork-source')
    assert.deepEqual(
      sourceBefore.messages.map((message) => message.text),
      ['第一问', '回答-1', '第二问', '回答-2'],
    )
    const pivot = sourceBefore.messages[2]

    const response = await host.request(jsonRequest(forkPath('th-fork-source'), { fromMessageId: pivot.id }))
    assert.equal(response.statusCode, 200)
    assert.match(response.headers['content-type'], /application\/json/)
    assert.equal(response.json.apiVersion, API_VERSION)
    const forked = response.json.thread

    // A brand-new thread with the copied prefix, tail dropped.
    assert.equal(typeof forked.id, 'string')
    assert.notEqual(forked.id, sourceBefore.id)
    assert.equal(forked.sessionId, sourceBefore.sessionId)
    assert.equal(forked.title, `${sourceBefore.title} · 分叉`)
    assert.deepEqual(
      forked.messages.map((message) => message.text),
      ['第一问', '回答-1', '第二问'],
    )
    assert.equal(typeof forked.createdAt, 'number')
    assert.equal(forked.createdAt, forked.updatedAt)

    // Ids are fresh (an id must address exactly one message across the store)...
    for (const [index, message] of forked.messages.entries()) {
      assert.notEqual(message.id, sourceBefore.messages[index].id, `message ${index} kept the source id`)
    }
    // ...and replyTo is remapped onto the copied question, never left dangling.
    assert.equal(forked.messages[1].replyTo, forked.messages[0].id)
    assert.equal(forked.messages[2].replyTo, undefined)
    // The cited/errored payloads, when present, are copied per message.
    assert.deepEqual(forked.messages.map((message) => message.role), ['user', 'assistant', 'user'])

    // The source is byte-for-byte unchanged and the fork is independently stored.
    assert.deepEqual(await readThread(host, 'th-fork-source'), sourceBefore)
    assert.deepEqual(await readThread(host, forked.id), forked)

    // Forking from the LAST message copies the whole thread (inclusivity).
    const whole = await host.request(
      jsonRequest(forkPath('th-fork-source'), { fromMessageId: sourceBefore.messages[3].id }),
    )
    assert.equal(whole.statusCode, 200)
    assert.deepEqual(
      whole.json.thread.messages.map((message) => message.text),
      ['第一问', '回答-1', '第二问', '回答-2'],
    )
    assert.notEqual(whole.json.thread.id, forked.id)
  })

  it('answers 404 for an unknown thread and for an unknown message id', async (t) => {
    const { host } = mount(t, { llm: answerLlm() })
    await ask(host, 'th-fork-known', '问题')

    const missingThread = await host.request(
      jsonRequest(forkPath('th-fork-missing'), { fromMessageId: 'm-1' }),
    )
    assert.equal(missingThread.statusCode, 404)
    assert.equal(missingThread.json.error.code, 'BAD_REQUEST')

    const missingMessage = await host.request(
      jsonRequest(forkPath('th-fork-known'), { fromMessageId: 'm-does-not-exist' }),
    )
    assert.equal(missingMessage.statusCode, 404)
    assert.equal(missingMessage.json.error.code, 'BAD_REQUEST')
    // A failed fork must not create a thread behind the user's back.
    const list = await host.request(getRequest(ROUTE.threads))
    assert.equal(list.json.length, 1)
  })

  it('answers 400 for a bad body and 405 for a non-POST fork', async (t) => {
    const { host } = mount(t, { llm: answerLlm() })
    await ask(host, 'th-fork-bad', '问题')

    const badBodies = [
      jsonRequest(forkPath('th-fork-bad'), {}),
      jsonRequest(forkPath('th-fork-bad'), { fromMessageId: 42 }),
      jsonRequest(forkPath('th-fork-bad'), { fromMessageId: '' }),
      jsonRequest(forkPath('th-fork-bad'), '{not json'),
    ]
    for (const request of badBodies) {
      const response = await host.request(request)
      assert.equal(response.statusCode, 400, `expected 400 for body ${request.body}`)
      assert.equal(response.json.error.code, 'BAD_REQUEST')
    }

    const notPost = await host.request(getRequest(forkPath('th-fork-bad')))
    assert.equal(notPost.statusCode, 405)
    assert.equal(notPost.headers.allow, 'POST')
  })
})

// ---------------------------------------------------------------- summarize

/** The two-message transcript most summarize tests compress. */
function historyMessages() {
  return [
    { id: 'm-1', role: 'user', text: '函数为什么返回 undefined？' },
    { id: 'm-2', role: 'assistant', text: '因为缺少 return 语句。' },
  ]
}

describe('POST /summarize', () => {
  it('returns the streamed model text as the summary and calls the model with the summary protocol', async (t) => {
    const answer = '摘要：用户问函数为什么返回 undefined，结论是缺少 return。'
    const llm = new FakeLlm({ script: { mode: 'success', answer } })
    const { host } = mount(t, { llm })

    const response = await host.request(
      jsonRequest(
        SUMMARIZE,
        {
          apiVersion: API_VERSION,
          requestId: 'req-summary-happy',
          messages: historyMessages(),
          // The route hint must outrank the host default model.
          routeHint: { provider: 'hint-provider', model: 'hint-model' },
        },
        { headers: { origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' } },
      ),
    )

    assert.equal(response.statusCode, 200)
    assert.match(response.headers['content-type'], /application\/json/)
    assert.equal(response.json.apiVersion, API_VERSION)
    assert.equal(response.json.summary, answer)
    assert.equal(response.json.truncated, false)

    assert.equal(llm.requests.length, 1)
    assert.equal(llm.lastRequest.provider, 'hint-provider')
    assert.equal(llm.lastRequest.model, 'hint-model')
    assert.equal(llm.lastRequest.temperature, 0.1)
    assert.equal(llm.lastRequest.maxTokens, 500)
    const [instruction, body] = llm.lastRequest.messages.map((message) => message.content[0].text)
    assert.match(instruction, /对话历史压缩器/)
    assert.match(instruction, /不超过 1200 字/, 'default maxChars is DEFAULT_SUMMARY_MAX_CHARS')
    assert.equal(body, '1. [m-1] user: 函数为什么返回 undefined？\n2. [m-2] assistant: 因为缺少 return 语句。')
  })

  it('answers an empty summary without calling the model when there is nothing valid to compress', async (t) => {
    const llm = new FakeLlm()
    const { host } = mount(t, { llm })

    const empty = await host.request(jsonRequest(SUMMARIZE, { apiVersion: API_VERSION, requestId: 'req-empty', messages: [] }))
    assert.equal(empty.statusCode, 200)
    assert.deepEqual(empty.json, { apiVersion: API_VERSION, summary: '', truncated: false })

    // A missing/non-array messages field is the same empty case, still no call.
    const notArray = await host.request(
      jsonRequest(SUMMARIZE, { apiVersion: API_VERSION, requestId: 'req-not-array', messages: 'nope' }),
    )
    assert.equal(notArray.statusCode, 200)
    assert.deepEqual(notArray.json, { apiVersion: API_VERSION, summary: '', truncated: false })
    assert.equal(llm.requests.length, 0, 'empty input must not spend a provider call')
  })

  it('answers empty input without a model service at all', async (t) => {
    const { host } = mount(t, { llm: null, defaultModel: null })
    const response = await host.request(jsonRequest(SUMMARIZE, { apiVersion: API_VERSION, requestId: 'r', messages: [] }))
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json, { apiVersion: API_VERSION, summary: '', truncated: false })
  })

  it('drops malformed role/id/text entries instead of sending them to the model', async (t) => {
    const llm = new FakeLlm({ script: { mode: 'success', answer: '摘要' } })
    const { host } = mount(t, { llm })
    const messages = [
      { id: 'm-keep-1', role: 'user', text: '保留的提问 MARKER_KEEP_1' },
      null,
      { id: 42, role: 'user', text: '坏的 id MARKER_BAD_ID' },
      { id: 'm-system', role: 'system', text: '系统消息 MARKER_SYSTEM' },
      { id: 'm-bad-text', role: 'assistant', text: 99 },
      { id: '', role: 'user', text: '空 id MARKER_EMPTY_ID' },
      { id: 'm-keep-2', role: 'assistant', text: '保留的回答 MARKER_KEEP_2' },
      'not-an-object',
    ]

    const response = await host.request(
      jsonRequest(SUMMARIZE, { apiVersion: API_VERSION, requestId: 'req-dirty', messages }),
    )
    assert.equal(response.statusCode, 200)
    assert.equal(response.json.summary, '摘要')

    const body = llm.lastRequest.messages[1].content[0].text
    assert.match(body, /MARKER_KEEP_1/)
    assert.match(body, /MARKER_KEEP_2/)
    for (const dropped of ['MARKER_BAD_ID', 'MARKER_SYSTEM', 'MARKER_EMPTY_ID']) {
      assert.equal(body.includes(dropped), false, `${dropped} should have been dropped`)
    }
    assert.deepEqual(body.split('\n'), [
      '1. [m-keep-1] user: 保留的提问 MARKER_KEEP_1',
      '2. [m-keep-2] assistant: 保留的回答 MARKER_KEEP_2',
    ])
  })

  it('keeps only the 40 newest messages when the batch is larger', async (t) => {
    const llm = new FakeLlm({ script: { mode: 'success', answer: '摘要' } })
    const { host } = mount(t, { llm })
    const messages = Array.from({ length: 55 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `消息 ${index} MARKER_${index}`,
    }))

    const response = await host.request(
      jsonRequest(SUMMARIZE, { apiVersion: API_VERSION, requestId: 'req-cap', messages }),
    )
    assert.equal(response.statusCode, 200)
    const body = llm.lastRequest.messages[1].content[0].text
    const lines = body.split('\n')
    assert.equal(lines.length, 40, 'the batch must be capped at 40 messages')
    assert.match(lines[0], /消息 15 /, 'the cap must keep the newest tail, not the oldest head')
    assert.match(lines[39], /消息 54 /)
    assert.equal(body.includes('消息 0 '), false)
  })

  it('clamps maxChars to [120, 2000], slices the answer, and reports truncation', async (t) => {
    const llm = new FakeLlm({ script: { mode: 'success', answer: '摘'.repeat(500) } })
    const { host } = mount(t, { llm })
    const messages = [{ id: 'm-1', role: 'user', text: '要压缩的历史' }]

    const narrow = await host.request(
      jsonRequest(SUMMARIZE, { apiVersion: API_VERSION, requestId: 'req-narrow', messages, maxChars: 50 }),
    )
    assert.equal(narrow.statusCode, 200)
    assert.equal(narrow.json.summary.length, 120, 'maxChars below 120 must clamp up')
    assert.equal(narrow.json.truncated, true)
    assert.match(llm.lastRequest.messages[0].content[0].text, /不超过 120 字/)

    // A too-large target is capped at 2000, and a short answer is not truncated.
    llm.setScript({ mode: 'success', answer: '短摘要' })
    const wide = await host.request(
      jsonRequest(SUMMARIZE, { apiVersion: API_VERSION, requestId: 'req-wide', messages, maxChars: 5000 }),
    )
    assert.equal(wide.statusCode, 200)
    assert.equal(wide.json.summary, '短摘要')
    assert.equal(wide.json.truncated, false)
    assert.match(llm.lastRequest.messages[0].content[0].text, /不超过 2000 字/)

    // Absent or non-numeric maxChars falls back to DEFAULT_SUMMARY_MAX_CHARS.
    llm.setScript({ mode: 'success', answer: '默认摘要' })
    const fallback = await host.request(
      jsonRequest(SUMMARIZE, { apiVersion: API_VERSION, requestId: 'req-default', messages, maxChars: 'big' }),
    )
    assert.equal(fallback.statusCode, 200)
    assert.equal(fallback.json.summary, '默认摘要')
    assert.match(llm.lastRequest.messages[0].content[0].text, /不超过 1200 字/)
  })

  it('maps a total provider failure to 502 with the contract error object', async (t) => {
    const llm = new FakeLlm({
      script: { mode: 'error', failure: { code: 'PROVIDER_ERROR', message: 'upstream exploded' } },
    })
    const { host } = mount(t, { llm })

    const response = await host.request(
      jsonRequest(SUMMARIZE, { apiVersion: API_VERSION, requestId: 'req-fail', messages: historyMessages() }),
    )
    assert.equal(response.statusCode, 502)
    assert.equal(response.json.error.code, 'PROVIDER_ERROR')
    assert.equal(response.json.error.message, 'upstream exploded')
    assert.equal(typeof response.json.error.retryable, 'boolean')
    assert.equal(response.json.summary, undefined)
  })

  it('maps a missing model service to 502 NO_ADAPTER', async (t) => {
    const { host } = mount(t, { llm: null, defaultModel: null })
    const response = await host.request(
      jsonRequest(SUMMARIZE, { apiVersion: API_VERSION, requestId: 'req-noadapter', messages: historyMessages() }),
    )
    assert.equal(response.statusCode, 502)
    assert.equal(response.json.error.code, 'NO_ADAPTER')
  })

  it('answers 400 for an unparsable or non-object body and 405 for GET', async (t) => {
    const { host } = mount(t)
    for (const request of [
      jsonRequest(SUMMARIZE, '{not json'),
      jsonRequest(SUMMARIZE, JSON.stringify([1, 2, 3])),
    ]) {
      const response = await host.request(request)
      assert.equal(response.statusCode, 400, `expected 400 for body ${request.body}`)
      assert.equal(response.json.error.code, 'BAD_REQUEST')
    }

    const get = await host.request(getRequest(SUMMARIZE))
    assert.equal(get.statusCode, 405)
    assert.equal(get.headers.allow, 'POST')
  })

  it('rejects a cross-site summarize before calling the model', async (t) => {
    const llm = new FakeLlm()
    const { host } = mount(t, { llm })
    const response = await host.request(
      jsonRequest(
        SUMMARIZE,
        { apiVersion: API_VERSION, requestId: 'req-cors', messages: historyMessages() },
        { headers: { origin: 'https://evil.example', host: '127.0.0.1:3000' } },
      ),
    )
    assert.equal(response.statusCode, 403)
    assert.equal(response.json.error.code, 'BAD_REQUEST')
    assert.equal(llm.requests.length, 0)
  })
})
