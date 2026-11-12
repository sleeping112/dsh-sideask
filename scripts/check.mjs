#!/usr/bin/env node
/**
 * Static sanity checks that do not need a running host.
 *
 * These exist because a plugin that half-loads is the most expensive failure
 * mode: the page shows nothing and the reason is buried in a console. Failing
 * the build on the cheap invariants keeps that rare.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

function check(condition, message) {
  if (!condition) problems.push(message)
}

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'))
}

const pkg = readJson('package.json')
check(pkg.name === 'dsh-sideask', 'package.json: name must be dsh-sideask')
check(pkg.type === 'module', 'package.json: type must be module (host half is ESM)')
check(pkg.dsh?.manifestVersion === 1, 'package.json: dsh.manifestVersion must be 1')
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json: dsh.bundle.patch must point at cordis.patch.yml')
check(pkg.dsh?.client?.platform === 'web', 'package.json: dsh.client.platform must be web')
check(typeof pkg.exports?.['./client'] === 'string', 'package.json: exports["./client"] must expose the bundle')
check(fs.existsSync(path.join(root, 'cordis.patch.yml')), 'cordis.patch.yml is missing')
check(fs.existsSync(path.join(root, 'lib', 'host', 'index.js')), 'lib/host/index.js is missing — run npm run build')

const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
check(/name:\s*dsh-sideask/.test(patch), 'cordis.patch.yml: row name must be dsh-sideask')
check(/id:\s*sideask/.test(patch), 'cordis.patch.yml: row id must be sideask')

const hostEntry = path.join(root, 'lib', 'host', 'index.js')
if (fs.existsSync(hostEntry)) {
  const source = fs.readFileSync(hostEntry, 'utf8')
  check(/export\s+function\s+apply/.test(source), 'lib/host/index.js: must export apply(ctx, config)')
  check(/export\s*\{[^}]*\bConfig\b|export\s+const\s+Config/.test(source), 'lib/host/index.js: must export a schemastery Config')
}

// The schema itself lives in config.js; the entry only re-exports it.
const hostConfig = path.join(root, 'lib', 'host', 'config.js')
if (fs.existsSync(hostConfig)) {
  const source = fs.readFileSync(hostConfig, 'utf8')
  check(/schemastery/.test(source), 'lib/host/config.js: Config must use @deepseek-ai/schemastery')
  check(/z\.object\(/.test(source), 'lib/host/config.js: Config must be a z.object schema')
}

const clientEntry = path.join(root, 'lib', 'client.js')
if (fs.existsSync(clientEntry)) {
  const source = fs.readFileSync(clientEntry, 'utf8')
  check(source.includes('__ModuleLoader__'), 'lib/client.js: must register through window.__ModuleLoader__')
  check(/id:\s*["']dsh-sideask["']/.test(source), 'lib/client.js: loader id must be dsh-sideask')
  check(/factory\s*:\s*function\s*\(\s*require\s*\)/.test(source), 'lib/client.js: must expose factory(require)')
  check(/require\(["']react["']\)/.test(source), 'lib/client.js: React must stay a runtime require')
  check(!/\bimport\s*\(/.test(source), 'lib/client.js: bundle must not contain dynamic import()')
  check(!/^\s*import\s+[^(]/m.test(source), 'lib/client.js: bundle must not contain static imports')
  check(!source.includes('dangerouslySetInnerHTML'), 'lib/client.js: answers must never be injected as HTML')
}

// Pure client modules are emitted separately so `node --test` can unit-test them.
for (const name of ['window-state', 'stream', 'transcript', 'markdown']) {
  check(fs.existsSync(path.join(root, 'lib', 'client', `${name}.js`)), `lib/client/${name}.js is missing — run npm run build`)
}

if (problems.length > 0) {
  console.error('check failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('check ok')
