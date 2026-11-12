/**
 * Host-half HTTP integration tests against the BUILT plugin
 * (`lib/host/index.js`) and a fake cordis host.
 *
 * The fake host mirrors the shipped host's route matching and request-lifecycle
 * timing (see `test/harness/fake-context.mjs`), so these tests fail for real
 * integration mistakes — a trailing-slash prefix route, aborting on the wrong
 * event — and not only for logic bugs.
 *
 * Run with: `node --test test/` after `node scripts/build.mjs`.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { after, describe, it } from 'node:test'

import { buildContext } from '../lib/shared/context.js'
import { estimateTokens } from '../lib/shared/tokens.js'
import {
  API_VERSION,
  FakeDefaultModel,
  FakeLlm,
  ROUTE,
  baseConfig,
  contextBundle,
  contextItem,
  delay,
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

/**
 * Mount the host with a fresh throwaway `$DSH_HOME`; cleans both up when the
 * test finishes (dispose first so the store's deferred flush cannot race the
 * temp-directory removal).
 */
function mount(t, { config = {}, llm, defaultModel, services } = {}) {
  const home = tempHome()
  const host = mountHost(plugin, baseConfig(config), { llm, defaultModel, services, dshHome: home.dir })
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

/** Answer used by the streaming tests; the trailing block is machine-readable. */
const CITED_ANSWER = '因为函数没有 return 语句，所以返回 undefined。[c1]\n⟦refs: c1⟧'

function successLlm(answer = CITED_ANSWER, usage = { inputTokens: 111, outputTokens: 22 }) {
  return new FakeLlm({ script: { mode: 'success', answer, usage } })
}

/** The two messages the gateway sends: instruction, then question + context body. */
function sentMessages(llm) {
  const request = llm.lastRequest
  assert.ok(request !== undefined, 'the fake llm received no stream() call')
  return request.messages
}

function bodyText(llm) {
  return sentMessages(llm)[1].content[0].text
}

// ---------------------------------------------------------------- bootstrap

describe('GET /bootstrap', () => {
  it('returns the client settings projection and the resolved model', async (t) => {
    const { host } = mount(t)
    const response = await host.request(getRequest(ROUTE.bootstrap))

    assert.equal(response.statusCode, 200)
    assert.match(response.headers['content-type'], /application\/json/)
    const body = response.json
    assert.equal(body.apiVersion, API_VERSION)
    assert.equal(body.settings.readContext, true)
    assert.equal(body.settings.persistHistory, true)
    assert.equal(body.settings.defaultCorner, 'bottom-right')
    assert.equal(body.settings.hotkey, 'Alt+Shift+A')
    assert.deepEqual(body.model, { provider: 'deepseek', model: 'deepseek-chat' })
    assert.deepEqual(body.providers, ['deepseek'])
    assert.equal(body.unavailable, null)
  })

  it('reports NO_ADAPTER instead of failing when the host has no model service', async (t) => {
    const { host } = mount(t, { llm: null, defaultModel: null })
    const response = await host.request(getRequest(ROUTE.bootstrap))

    assert.equal(response.statusCode, 200)
    assert.equal(response.json.model, null)
    assert.equal(response.json.unavailable.code, 'NO_ADAPTER')
    assert.deepEqual(response.json.providers, [])
  })

  it('rejects non-GET methods', async (t) => {
    const { host } = mount(t)
    const response = await host.request(jsonRequest(ROUTE.bootstrap, {}))
    assert.equal(response.statusCode, 405)
    assert.equal(response.headers.allow, 'GET, HEAD')
  })
})

// ---------------------------------------------------------------------- ask

describe('POST /ask', () => {
  it('streams accepted → delta* → usage → done with citations parsed from the answer', async (t) => {
    const llm = successLlm()
    const { host } = mount(t, { llm })
    const bundle = contextBundle({
      items: [contextItem({ ref: 'c1', messageId: 'm-1', role: 'assistant', text: 'function f () {}' })],
    })

    const response = await host.request(
      jsonRequest(
        ROUTE.ask,
        {
          apiVersion: API_VERSION,
          requestId: 'req-citations',
          threadId: 'th-citations',
          question: '为什么返回 undefined？',
          context: bundle,
        },
        { headers: { origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' } },
      ),
    )

    assert.equal(response.statusCode, 200)
    assert.match(response.headers['content-type'], /text\/event-stream/)

    const events = response.events
    assert.ok(events.length >= 5, `expected a streaming session, got ${events.length} events`)
    assert.deepEqual(
      events.map((event) => event.type).filter((type) => type !== 'delta'),
      ['accepted', 'settings', 'usage', 'done'],
    )

    const accepted = events[0]
    assert.equal(accepted.requestId, 'req-citations')
    assert.equal(accepted.mode, 'context')

    const settings = events.find((event) => event.type === 'settings')
    assert.equal(settings.settings.readContext, true)

    const deltas = events.filter((event) => event.type === 'delta')
    assert.ok(deltas.length >= 2, 'the answer must stream in more than one delta')
    assert.ok(deltas.every((event) => event.requestId === 'req-citations'))
    assert.equal(deltas.map((event) => event.text).join(''), CITED_ANSWER)

    const usage = events.find((event) => event.type === 'usage')
    assert.equal(usage.promptTokens, 111)
    assert.equal(usage.completionTokens, 22)

    const done = events.find((event) => event.type === 'done')
    assert.equal(done.requestId, 'req-citations')
    assert.equal(done.text, '因为函数没有 return 语句，所以返回 undefined。[c1]')
    assert.equal(typeof done.messageId, 'string')
    assert.deepEqual(
      done.citations.map((citation) => ({ ref: citation.ref, messageId: citation.messageId, role: citation.role })),
      [{ ref: 'c1', messageId: 'm-1', role: 'assistant' }],
    )
    assert.ok(done.citations[0].excerpt.length > 0)

    // The gateway was called once with the resolved route and the plugin's caps.
    assert.equal(llm.requests.length, 1)
    assert.equal(llm.lastRequest.provider, 'deepseek')
    assert.equal(llm.lastRequest.model, 'deepseek-chat')
    assert.equal(llm.lastRequest.maxTokens, 1200)
    assert.equal(llm.lastRequest.temperature, 0.4)
    assert.equal(sentMessages(llm).length, 2)
    // Context really was forwarded in context mode.
    assert.match(bodyText(llm), /function f \(\) \{\}/)
    assert.match(bodyText(llm), /为什么返回 undefined？/)
  })

  it('fails with API_MISMATCH when a stale client sends another apiVersion', async (t) => {
    const llm = successLlm()
    const { host } = mount(t, { llm })
    const response = await host.request(jsonRequest(ROUTE.ask, { apiVersion: API_VERSION + 1, requestId: 'r', question: 'hi' }))

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.events.map((event) => event.type), ['error'])
    assert.equal(response.events[0].error.code, 'API_MISMATCH')
    assert.equal(llm.requests.length, 0)
  })

  it('answers BAD_REQUEST for an unparsable JSON body', async (t) => {
    const { host } = mount(t)
    const response = await host.request(jsonRequest(ROUTE.ask, '{not json'))
    assert.equal(response.statusCode, 400)
    assert.equal(response.json.error.code, 'BAD_REQUEST')
  })

  it('rejects GET', async (t) => {
    const { host } = mount(t)
    const response = await host.request(getRequest(ROUTE.ask))
    assert.equal(response.statusCode, 405)
    assert.equal(response.headers.allow, 'POST')
  })

  it('keeps the answer out of the main conversation: it only appends to the side thread store', async (t) => {
    const llm = successLlm('旁问回答')
    const { host } = mount(t, { llm })
    await host.request(jsonRequest(ROUTE.ask, { apiVersion: API_VERSION, requestId: 'r', threadId: 'th-only', question: 'q' }))

    const thread = await host.request(getRequest(ROUTE.thread('th-only')))
    assert.equal(thread.statusCode, 200)
    assert.deepEqual(
      thread.json.messages.map((message) => ({ role: message.role, text: message.text })),
      [
        { role: 'user', text: 'q' },
        { role: 'assistant', text: '旁问回答' },
      ],
    )
  })
})

// --------------------------------------------------------- provider failures

describe('provider failures map to contract SideAskError codes', () => {
  const cases = [
    {
      name: 'terminal error chunk RATE_LIMIT',
      llm: () => new FakeLlm({ script: { mode: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } }),
      code: 'RATE_LIMIT',
      retryable: true,
      degradable: false,
    },
    {
      name: 'terminal error chunk AUTH',
      llm: () => new FakeLlm({ script: { mode: 'error', failure: { code: 'AUTH', message: 'bad key' } } }),
      code: 'AUTH',
      retryable: false,
      degradable: false,
    },
    {
      name: 'ACCOUNT_QUOTA normalises to QUOTA',
      llm: () => new FakeLlm({ script: { mode: 'error', failure: { code: 'ACCOUNT_QUOTA', message: 'no quota' } } }),
      code: 'QUOTA',
      retryable: false,
      degradable: false,
    },
    {
      name: 'CONTEXT_WINDOW_EXCEEDED is degradable to question-only',
      llm: () =>
        new FakeLlm({ script: { mode: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' } } }),
      code: 'CONTEXT_WINDOW_EXCEEDED',
      retryable: false,
      degradable: true,
    },
    {
      name: 'a thrown provider error is still classified by code',
      llm: () => new FakeLlm({ script: { mode: 'throw', error: { code: 'AUTH', message: 'invalid key' } } }),
      code: 'AUTH',
      retryable: false,
      degradable: false,
    },
    {
      name: 'an aborted stream yields ABORTED',
      llm: () => new FakeLlm({ script: { mode: 'abort' } }),
      code: 'ABORTED',
      retryable: false,
      degradable: false,
    },
  ]

  for (const testCase of cases) {
    it(testCase.name, async (t) => {
      const llm = testCase.llm()
      const { host } = mount(t, { llm })
      const response = await host.request(
        jsonRequest(ROUTE.ask, { apiVersion: API_VERSION, requestId: 'req-fail', threadId: 'th-fail', question: 'q' }),
      )

      assert.equal(response.statusCode, 200)
      const events = response.events
      const terminal = events[events.length - 1]
      assert.equal(terminal.type, 'error', `expected a terminal error, got ${JSON.stringify(events)}`)
      assert.equal(terminal.error.code, testCase.code)
      assert.equal(terminal.error.retryable, testCase.retryable)
      assert.equal(terminal.error.degradableToQuestionOnly, testCase.degradable)
      assert.equal(typeof terminal.error.message, 'string')
      assert.equal(events.some((event) => event.type === 'done'), false)
    })
  }

  it('fails with NO_ADAPTER when the llm service is absent', async (t) => {
    const { host } = mount(t, { llm: null, defaultModel: null })
    const response = await host.request(
      jsonRequest(ROUTE.ask, { apiVersion: API_VERSION, requestId: 'req-noadapter', question: 'q' }),
    )
    assert.deepEqual(response.events.map((event) => event.type), ['error'])
    assert.equal(response.events[0].error.code, 'NO_ADAPTER')
  })
})

// ------------------------------------------------------- question-only mode

describe('readContext:false', () => {
  it('answers question-only and never forwards the transcript', async (t) => {
    const llm = successLlm('这是通用回答。')
    const { host } = mount(t, { llm, config: { readContext: false } })
    const marker = 'SECRET_TRANSCRIPT_MARKER_XYZ'
    const bundle = contextBundle({
      items: [contextItem({ ref: 'c1', messageId: 'm-1', text: `${marker} 主对话正文` })],
      summary: `${marker} 摘要`,
      selection: { text: `${marker} 选中文本`, messageId: 'm-1' },
    })

    const response = await host.request(
      jsonRequest(ROUTE.ask, {
        apiVersion: API_VERSION,
        requestId: 'req-question-only',
        threadId: 'th-question-only',
        question: '只回答这个问题',
        context: bundle,
      }),
    )

    const events = response.events
    assert.equal(events[0].type, 'accepted')
    assert.equal(events[0].mode, 'question-only')
    assert.equal(events.some((event) => event.type === 'done'), true)

    // The privacy gate: none of the browser-supplied context reached the model.
    assert.equal(llm.sentText().includes(marker), false, 'transcript leaked into the prompt')
    const body = bodyText(llm)
    assert.match(body, /只回答这个问题/)
    assert.match(body, /本次没有可用的上下文/)
    // Question-only mode also switches the citation protocol off.
    assert.match(sentMessages(llm)[0].content[0].text, /本次不需要输出引用块/)

    const done = events.find((event) => event.type === 'done')
    assert.deepEqual(done.citations, [])
  })
})

// ------------------------------------------------------------ same-origin

describe('cross-origin protection', () => {
  it('rejects an Origin that does not match the Host with 403', async (t) => {
    const { host } = mount(t)
    const response = await host.request(
      getRequest(ROUTE.bootstrap, { headers: { origin: 'https://evil.example', host: '127.0.0.1:3000' } }),
    )
    assert.equal(response.statusCode, 403)
    assert.equal(response.json.error.code, 'BAD_REQUEST')
    assert.match(response.json.error.message, /跨站/)
  })

  it('rejects Sec-Fetch-Site: cross-site with 403', async (t) => {
    const { host } = mount(t)
    const response = await host.request(
      getRequest(ROUTE.bootstrap, {
        headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example', host: '127.0.0.1:3000' },
      }),
    )
    assert.equal(response.statusCode, 403)
  })

  it('accepts a same-origin request', async (t) => {
    const { host } = mount(t)
    const response = await host.request(
      getRequest(ROUTE.bootstrap, { headers: { origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' } }),
    )
    assert.equal(response.statusCode, 200)
  })

  it('rejects a cross-site ask before calling the model', async (t) => {
    const llm = successLlm()
    const { host } = mount(t, { llm })
    const response = await host.request(
      jsonRequest(
        ROUTE.ask,
        { apiVersion: API_VERSION, requestId: 'r', question: 'q' },
        { headers: { origin: 'https://evil.example', host: '127.0.0.1:3000' } },
      ),
    )
    assert.equal(response.statusCode, 403)
    assert.equal(llm.requests.length, 0)
  })
})

// ------------------------------------------------------------------ threads

describe('thread store HTTP round-trip', () => {
  it('create → list → get → ask appends → delete → clear', async (t) => {
    const llm = successLlm('旁问回答')
    const { host } = mount(t, { llm })

    const created = await host.request(jsonRequest(ROUTE.threads, { sessionId: 'sess-1' }))
    assert.equal(created.statusCode, 201)
    const thread = created.json
    assert.equal(typeof thread.id, 'string')
    assert.equal(thread.sessionId, 'sess-1')
    assert.equal(thread.title, '新旁问')
    assert.deepEqual(thread.messages, [])

    const listed = await host.request(getRequest(ROUTE.threads))
    assert.equal(listed.statusCode, 200)
    assert.deepEqual(
      listed.json.map((entry) => ({ id: entry.id, messageCount: entry.messageCount })),
      [{ id: thread.id, messageCount: 0 }],
    )

    const fetched = await host.request(getRequest(ROUTE.thread(thread.id)))
    assert.equal(fetched.statusCode, 200, 'GET /threads/:id must be routable (prefix-route contract)')
    assert.equal(fetched.json.id, thread.id)

    const answered = await host.request(
      jsonRequest(ROUTE.ask, {
        apiVersion: API_VERSION,
        requestId: 'req-thread',
        threadId: thread.id,
        question: '旁问问题',
        context: null,
      }),
    )
    assert.equal(answered.events.some((event) => event.type === 'done'), true)

    const afterAnswer = await host.request(getRequest(ROUTE.thread(thread.id)))
    assert.equal(afterAnswer.statusCode, 200)
    assert.deepEqual(
      afterAnswer.json.messages.map((message) => ({ role: message.role, text: message.text })),
      [
        { role: 'user', text: '旁问问题' },
        { role: 'assistant', text: '旁问回答' },
      ],
    )
    // The first user message names the thread.
    assert.notEqual(afterAnswer.json.title, '新旁问')

    const deleted = await host.request({ method: 'DELETE', url: ROUTE.thread(thread.id), headers: {}, body: '' })
    assert.equal(deleted.statusCode, 200)
    assert.deepEqual(deleted.json, { deleted: true })

    const missing = await host.request(getRequest(ROUTE.thread(thread.id)))
    assert.equal(missing.statusCode, 404)
    assert.equal(missing.json.error.code, 'BAD_REQUEST')

    // Clear removes every remaining thread.
    await host.request(jsonRequest(ROUTE.threads, {}))
    await host.request(jsonRequest(ROUTE.threads, {}))
    const cleared = await host.request({ method: 'DELETE', url: ROUTE.threads, headers: {}, body: '' })
    assert.equal(cleared.statusCode, 200)
    assert.deepEqual(cleared.json, { cleared: 2 })
    const empty = await host.request(getRequest(ROUTE.threads))
    assert.deepEqual(empty.json, [])
  })

  it('rejects unknown methods on the collection and the item', async (t) => {
    const { host } = mount(t)
    const collection = await host.request({ method: 'PUT', url: ROUTE.threads, headers: {}, body: '' })
    assert.equal(collection.statusCode, 405)
    const created = await host.request(jsonRequest(ROUTE.threads, {}))
    const item = await host.request({ method: 'POST', url: ROUTE.thread(created.json.id), headers: {}, body: '{}' })
    assert.equal(item.statusCode, 405)
  })
})

// -------------------------------------------------------------- persistence

describe('thread persistence honours persistHistory', () => {
  it('persistHistory:true writes $DSH_HOME/storages/sideask/threads.json', async (t) => {
    const { host, home } = mount(t, { config: { persistHistory: true }, llm: successLlm('回答') })
    await host.request(jsonRequest(ROUTE.threads, { sessionId: 'sess-persist' }))
    await delay(600) // the store debounces flushes by 400 ms
    host.dispose()

    assert.equal(fs.existsSync(home.threadsFile()), true, 'persisted history file is missing')
    const payload = JSON.parse(fs.readFileSync(home.threadsFile(), 'utf8'))
    assert.equal(payload.schema, 1)
    assert.equal(Array.isArray(payload.threads), true)
    assert.equal(payload.threads.length, 1)
    assert.equal(payload.threads[0].sessionId, 'sess-persist')
  })

  it('persistHistory:false leaves no file on disk', async (t) => {
    const { host, home } = mount(t, { config: { persistHistory: false }, llm: successLlm('回答') })
    await host.request(jsonRequest(ROUTE.threads, { sessionId: 'sess-nopersist' }))
    await host.request(
      jsonRequest(ROUTE.ask, {
        apiVersion: API_VERSION,
        requestId: 'req-nopersist',
        threadId: 'th-nopersist',
        question: '会被持久化吗？',
      }),
    )

    await delay(600)
    host.dispose()

    assert.equal(fs.existsSync(home.threadsFile()), false, 'persistHistory:false still wrote a history file')
    const storageDir = home.threadsFile().replace(/threads\.json$/, '')
    if (fs.existsSync(storageDir)) {
      assert.deepEqual(fs.readdirSync(storageDir), [], 'persistHistory:false left store artifacts behind')
    }
  })
})

// -------------------------------------------------------------- token budget

describe('context token budget', () => {
  it('a huge transcript is budgeted before the model sees it', async (t) => {
    const llm = successLlm('按预算回答')
    const { host } = mount(t, { llm, config: { contextBudgetTokens: 1000, recentMessageLimit: 80, redactSensitive: false } })

    const messages = Array.from({ length: 60 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `message-${index} ` + '这是一段很长的历史对话内容。'.repeat(4000),
    }))
    const bundle = buildContext({
      snapshot: { sessionId: 'sess-budget', revision: 1, messages },
      question: '总结一下当前进度',
      settings: { readContext: true, recentMessageLimit: 80, contextBudgetTokens: 1000, autoSummary: true, redactSensitive: false },
    })

    assert.ok(bundle.items.length > 0, 'the budgeter produced no context at all')
    assert.ok(bundle.stats.usedTokens <= 1000, `budgeter overshot: ${bundle.stats.usedTokens} > 1000`)

    const response = await host.request(
      jsonRequest(ROUTE.ask, {
        apiVersion: API_VERSION,
        requestId: 'req-budget',
        threadId: 'th-budget',
        question: '总结一下当前进度',
        context: bundle,
      }),
    )
    assert.equal(response.events[0].mode, 'context')

    const body = bodyText(llm)
    assert.match(body, /总结一下当前进度/)
    const promptTokens = estimateTokens(sentMessages(llm)[0].content[0].text) + estimateTokens(body)
    assert.ok(
      promptTokens <= 1000 + 400,
      `prompt estimate ${promptTokens} exceeded budget 1000 plus framing allowance`,
    )
    // Only the budgeted tail of a 60-message transcript may appear.
    const seen = messages.filter((message) => body.includes(`message-${message.id.slice(2)} `)).length
    assert.ok(seen <= 3, `${seen} transcript messages reached the prompt`)
    assert.equal(body.includes('message-0 '), false, 'the oldest message must be the first budget casualty')
  })

  it('re-clamps an over-budget client bundle instead of trusting it', async (t) => {
    const llm = successLlm('回答')
    const { host } = mount(t, { llm, config: { contextBudgetTokens: 1000 } })
    const items = Array.from({ length: 40 }, (_, index) =>
      contextItem({
        ref: `c${index + 1}`,
        messageId: `m-${index}`,
        text: `marker-${index} ` + 'A'.repeat(400),
        source: 'recent',
      }),
    )

    const response = await host.request(
      jsonRequest(ROUTE.ask, {
        apiVersion: API_VERSION,
        requestId: 'req-overbudget',
        threadId: 'th-overbudget',
        question: 'q',
        context: contextBundle({ items }),
      }),
    )
    assert.equal(response.events[0].mode, 'context')

    const body = bodyText(llm)
    const promptTokens = estimateTokens(sentMessages(llm)[0].content[0].text) + estimateTokens(body)
    assert.ok(promptTokens <= 1000 + 400, `host let an over-budget bundle through: ${promptTokens} tokens`)
    assert.equal(body.includes('marker-39'), true, 'newest item should survive the clamp')
    assert.equal(body.includes('marker-0'), false, 'oldest item should be dropped first')

    // The side-thread message records the host-side accounting.
    const thread = await host.request(getRequest(ROUTE.thread('th-overbudget')))
    assert.equal(thread.statusCode, 200)
    const stats = thread.json.messages[0].context
    assert.equal(stats.budgetTokens, 1000)
    assert.ok(stats.usedTokens <= 1000)
    assert.equal(stats.consideredCount, 40)
  })
})

// ------------------------------------------------------------------ routes

describe('route registration', () => {
  it('registers the contracted routes once and disposers remove them', async (t) => {
    const { host } = mount(t)
    const paths = host.webServer.routePaths()
    for (const expected of [
      `exact:${ROUTE.bootstrap}`,
      `exact:${ROUTE.ask}`,
      `exact:${ROUTE.cancel}`,
      `exact:${ROUTE.threads}`,
      // Slash-less prefix: the host matcher only resolves `prefix + '/'`
      // children, so a trailing-slash prefix would never match /threads/<id>.
      `prefix:${ROUTE.threads}`,
      `exact:${ROUTE.health}`,
    ]) {
      assert.equal(paths.filter((entry) => entry === expected).length, 1, `route ${expected} must be registered exactly once`)
    }

    // The plugin injected the web server rather than assuming it.
    assert.deepEqual(host.ctx.injections, [['webServer']])

    host.dispose()
    assert.equal(host.webServer.registrations.length, 0, 'route disposers did not run')
  })

  it('GET /health answers 200 while a model route exists', async (t) => {
    const { host } = mount(t)
    const response = await host.request(getRequest(ROUTE.health))
    assert.equal(response.statusCode, 200)
    assert.equal(response.json.ok, true)
    assert.deepEqual(response.json.model, { provider: 'deepseek', model: 'deepseek-chat' })
  })
})
