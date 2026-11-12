#!/usr/bin/env node
/**
 * Memory-growth check (no Electron, no network).
 *
 * Drives the REAL host plugin module with a fake cordis context and a fake model
 * stream for `--turns` turns, then asserts:
 *   1. the V8 heap does not grow across the run (the plugin keeps no per-turn
 *      history in memory beyond the bounded thread store), and
 *   2. the thread store still respects `maxThreads`.
 *
 * This exists because "a floating helper" must not become "the thing that ate my
 * RAM": every structure that could grow is pinned by a bound somewhere, and this
 * script proves it end to end rather than per-structure.
 *
 * Usage: node scripts/memory-check.mjs [--turns 200]
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const turnsArg = process.argv.indexOf('--turns')
const totalTurns = turnsArg > 0 ? Number(process.argv[turnsArg + 1]) || 200 : 200

// Isolated home: never touch the user's real dsh state.
process.env['DSH_HOME'] = path.join(root, '_tmp', 'memory-home')

let modelCalls = 0
const fakeLlm = {
  listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek Account' }],
  async *stream() {
    modelCalls += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '好的，这是回答 [c1]。\n⟦refs: c1⟧' }
    yield { type: 'usage', usage: { inputTokens: 400, outputTokens: 30 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

const routes = []
function makeContext() {
  const ctx = {
    get: (name) =>
      name === 'llm' ? fakeLlm
        : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
        : name === 'webServer' ? ctx.server
        : undefined,
    effect: (fn) => fn(),
    inject: (names, callback) => callback(ctx),
    provide: () => {},
    server: {
      register(spec) {
        routes.push(spec)
        return () => {}
      },
    },
  }
  return ctx
}

const plugin = await import('file:///' + path.join(root, 'lib', 'host', 'index.js'))
plugin.apply(makeContext(), {
  persistHistory: false,
  contextBudgetTokens: 2000,
  recentMessageLimit: 20,
  maxThreads: 3,
  maxMessagesPerThread: 20,
})

function makeResponse() {
  const chunks = []
  return {
    writableEnded: false,
    writeHead() {},
    write(chunk) {
      chunks.push(chunk)
      return true
    },
    end(chunk) {
      if (typeof chunk === 'string') chunks.push(chunk)
      this.writableEnded = true
    },
    on() {},
    once() {},
    flushHeaders() {},
    body() {
      return chunks.join('')
    },
  }
}

function makeRequest(method, url, body) {
  const listeners = new Map()
  const text = typeof body === 'string' ? body : ''
  const request = {
    method,
    url,
    headers: { host: '127.0.0.1:1' },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      if (event === 'data') queueMicrotask(() => { if (text.length > 0) listener(text) })
      if (event === 'end') queueMicrotask(() => listener())
      return request
    },
    destroy() {},
  }
  return request
}

async function settle(response) {
  const deadline = Date.now() + 5000
  while (!response.writableEnded && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2))
}

const findRoute = (routePath) => routes.find((route) => route.path === routePath)
const askRoute = findRoute('/plugins/dsh-sideask/api/ask')
assert.ok(askRoute, 'ask route must be registered')

const context = {
  items: [{ ref: 'c1', messageId: 'm1', role: 'user', text: 'function retry() { ... }', tokens: 40, truncated: false, source: 'recent' }],
  summary: null,
  selection: null,
  stats: { budgetTokens: 2000, usedTokens: 40, degradations: [] },
}

const heapSeries = []
const rssSeries = []
globalThis.gc?.()
heapSeries.push(process.memoryUsage().heapUsed)
rssSeries.push(process.memoryUsage().rss)

const sampleEvery = Math.max(1, Math.floor(totalTurns / 5))

for (let index = 0; index < totalTurns; index += 1) {
  const response = makeResponse()
  askRoute.handler(
    makeRequest(
      'POST',
      '/plugins/dsh-sideask/api/ask',
      JSON.stringify({
        apiVersion: 1,
        requestId: `r${index}`,
        threadId: `t${index % 5}`,
        question: `第 ${index} 个问题：这个函数需要重试吗？`,
        context,
      }),
    ),
    response,
  )
  await settle(response)
  if (response.body().includes('"type":"error"')) {
    throw new Error(`turn ${index} failed: ${response.body().slice(0, 200)}`)
  }
  if ((index + 1) % sampleEvery === 0 || index === totalTurns - 1) {
    globalThis.gc?.()
    heapSeries.push(process.memoryUsage().heapUsed)
    rssSeries.push(process.memoryUsage().rss)
  }
}

const mb = (value) => Math.round(value / 1024 / 1024)
const baseline = heapSeries.length > 1 ? heapSeries[1] : heapSeries[0]
const growthMb = (heapSeries[heapSeries.length - 1] - baseline) / 1024 / 1024

console.log(`turns completed : ${modelCalls}`)
console.log(`rss  (MB)       : ${rssSeries.map(mb).join(' -> ')}`)
console.log(`heap (MB)       : ${heapSeries.map(mb).join(' -> ')}`)
console.log(`heap growth     : ${growthMb.toFixed(2)} MB after warm-up`)

assert.ok(growthMb < 40, `heap grew ${growthMb.toFixed(1)} MB over ${totalTurns} turns`)

const threadsRoute = findRoute('/plugins/dsh-sideask/api/threads')
const listResponse = makeResponse()
threadsRoute.handler(makeRequest('GET', '/plugins/dsh-sideask/api/threads'), listResponse)
await settle(listResponse)
const threads = JSON.parse(listResponse.body())
console.log(`threads kept    : ${threads.length} (cap 3)`)
assert.ok(threads.length <= 3, 'thread store must respect maxThreads')

// Explicit exit: the plugin's debounced writers may leave unref'd timers around,
// and a CI job should never wait on them.
await new Promise((resolve) => process.stdout.write('MEMORY CHECK PASSED\n', resolve))
process.exit(0)
