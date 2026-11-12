#!/usr/bin/env node
/**
 * Build both halves of the plugin.
 *
 * - host half: `tsc -p tsconfig.host.json` emits ESM for Node into `lib/host`
 *   and `lib/shared`. `@deepseek-ai/*` imports stay external: the host loads the
 *   package (and its peer dependencies) from the profile's module graph.
 * - pure client modules: `tsc -p tsconfig.pure.json` emits the DOM-free client
 *   modules (window-state / stream / transcript / markdown) as ESM into
 *   `lib/client/` so `node --test` can unit-test them without a browser.
 * - browser bundle: esbuild bundles `src/client/index.ts` (plus shared modules)
 *   as CJS with React left external, then this script wraps it in the DSH
 *   Module Loader registration. That is what lets the bundle use
 *   `require('react')` from the platform seed table while every other import is
 *   inlined.
 *
 * `--watch` only rebuilds the browser half (the host half is re-required by the
 * loader on file change) and is meant for the local dev loop.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const node = process.execPath

function run(args) {
  const result = spawnSync(node, args, { stdio: 'inherit', cwd: root })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function buildTypes() {
  fs.rmSync(path.join(root, 'lib', 'host'), { recursive: true, force: true })
  fs.rmSync(path.join(root, 'lib', 'shared'), { recursive: true, force: true })
  fs.rmSync(path.join(root, 'lib', 'client'), { recursive: true, force: true })
  run([tsc, '-p', 'tsconfig.host.json'])
  run([tsc, '-p', 'tsconfig.pure.json'])
  console.log('types: lib/host + lib/shared + lib/client (pure modules)')
}

/** The exact registration wrapper the DSH web client expects. */
const BUNDLE_HEADER = `/* dsh-sideask browser bundle — built by scripts/build.mjs. Do not edit. */
window.__ModuleLoader__.load({
  id: "dsh-sideask",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
`
const BUNDLE_FOOTER = `
    return module.exports;
  }
});
`

/** Modules the platform seed table provides; everything else is bundled. */
const EXTERNAL = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']

function bundleOptions() {
  return {
    entryPoints: [path.join(root, 'src', 'client', 'index.ts')],
    outfile: path.join(root, 'lib', 'client.bundle.tmp.js'),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: ['chrome110', 'firefox110', 'safari16'],
    charset: 'utf8',
    legalComments: 'none',
    sourcemap: false,
    minify: false,
    jsx: 'automatic',
    external: EXTERNAL,
    logLevel: 'warning',
  }
}

function wrapBundle() {
  const tmp = path.join(root, 'lib', 'client.bundle.tmp.js')
  const body = fs.readFileSync(tmp, 'utf8')
  fs.rmSync(tmp, { force: true })
  const file = path.join(root, 'lib', 'client.js')
  fs.writeFileSync(file, `${BUNDLE_HEADER}${body}${BUNDLE_FOOTER}`, 'utf8')
  return file
}

function verifyBundle() {
  const file = path.join(root, 'lib', 'client.js')
  const source = fs.readFileSync(file, 'utf8')
  const checks = [
    [/window\.__ModuleLoader__\.load\(/, 'must register through window.__ModuleLoader__.load'],
    [/id:\s*["']dsh-sideask["']/, "loader id must be 'dsh-sideask'"],
    [/factory\s*:\s*function\s*\(\s*require\s*\)/, 'must expose a factory(require)'],
    [/\bapply\s*\(\s*ctx/, 'must expose apply(ctx)'],
    [/require\(["']react["']\)/, 'React must stay a runtime require (host seed table)'],
  ]
  for (const [pattern, message] of checks) {
    if (!pattern.test(source)) {
      console.error(`lib/client.js: ${message}`)
      process.exit(1)
    }
  }
  const kib = (source.length / 1024).toFixed(1)
  console.log(`client: lib/client.js (${kib} KiB)`)
  if (source.length > 512 * 1024) {
    console.error('lib/client.js: bundle too large (>512 KiB)')
    process.exit(1)
  }
}

async function main() {
  buildTypes()
  if (watch) {
    const context = await esbuild.context({
      ...bundleOptions(),
      outfile: path.join(root, 'lib', 'client.raw.js'),
    })
    await context.watch()
    console.log('client: watching src/client (raw output -> lib/client.raw.js)')
    return
  }
  await esbuild.build(bundleOptions())
  wrapBundle()
  verifyBundle()
}

await main()
