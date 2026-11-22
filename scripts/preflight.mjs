#!/usr/bin/env node
/**
 * Preflight: checks the repository against the delivery / listing rules.
 *
 * This is deliberately blunt and offline: manifest shape, built artifacts,
 * package contents, screenshots, metadata accuracy and README basics. CI runs it
 * after the build, and `prepublishOnly` runs it before publishing, so a broken
 * tarball or an uninstallable manifest cannot leave the machine.
 */

import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const failures = []
const checks = []

function check(name, run) {
  try {
    const detail = run()
    checks.push({ name, ok: true, detail })
  } catch (error) {
    checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
    failures.push(name)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
}

function exists(relative) {
  return fs.existsSync(path.join(root, relative))
}

const pkg = readJson('package.json')
const CHANGELOG = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
const README = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
const README_ZH = fs.readFileSync(path.join(root, 'README.zh.md'), 'utf8')
const PATCH = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')

const MARKETING = [
  'best ',
  'amazing',
  'powerful',
  'ultimate',
  'revolutionary',
  'world-class',
  'blazing',
  'seamless',
  'effortless',
  'unmatched',
  'state-of-the-art',
  'number one',
  '#1 ',
]

check('package.json parses and is named dsh-sideask', () => {
  assert(pkg.name === 'dsh-sideask', `name is "${pkg.name}"`)
  return pkg.name
})

check('version matches the newest CHANGELOG heading', () => {
  const match = CHANGELOG.match(/^## \[(\d+\.\d+\.\d+)\]/m)
  assert(match !== null, 'no "## [x.y.z]" heading in CHANGELOG.md')
  assert(match[1] === pkg.version, `package ${pkg.version} vs changelog ${match[1]}`)
  return pkg.version
})

check('description is accurate-looking and free of marketing words', () => {
  const description = pkg.description ?? ''
  assert(typeof description === 'string' && description.trim().length >= 40, 'description is too short')
  assert(description.trim().endsWith('.'), 'description must end with a period')
  assert(description.length <= 240, `description is ${description.length} chars (max 240)`)
  const lower = description.toLowerCase()
  for (const word of MARKETING) assert(!lower.includes(word), `description contains "${word.trim()}"`)
  return `${description.length} chars`
})

check('repository / homepage / bugs point at the public repo', () => {
  const url = pkg.repository?.url ?? ''
  assert(url.includes('sleeping112/dsh-sideask'), 'repository.url does not point at sleeping112/dsh-sideask')
  assert((pkg.homepage ?? '').includes('sleeping112/dsh-sideask'), 'homepage missing or wrong')
  assert((pkg.bugs?.url ?? '').includes('sleeping112/dsh-sideask'), 'bugs.url missing or wrong')
  return url
})

check('dsh.bundle manifest declares the cordis patch (installable)', () => {
  const patch = pkg.dsh?.bundle?.patch
  assert(typeof patch === 'string' && patch.length > 0, 'dsh.bundle.patch is missing')
  assert(exists(patch.replace(/^\.\//, '')), `${patch} does not exist`)
  return patch
})

check('cordis.patch.yml inserts this package', () => {
  assert(PATCH.includes('insert:'), 'no insert: section')
  assert(PATCH.includes(`name: ${pkg.name}`), `patch does not reference name: ${pkg.name}`)
  assert(/id:\s*sideask/.test(PATCH), 'patch does not declare id: sideask')
  return 'id: sideask'
})

check('dsh.client declares the web UI (only alongside dsh.bundle)', () => {
  assert(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform is not "web"')
  return `immediately: ${String(pkg.dsh?.client?.immediately ?? false)}`
})

check('built artifacts exist (lib/host/index.js, lib/client.js)', () => {
  for (const file of ['lib/host/index.js', 'lib/client.js']) assert(exists(file), `${file} is missing — run npm run build`)
  const size = fs.statSync(path.join(root, 'lib/client.js')).size
  assert(size > 20_000, `client bundle is suspiciously small (${size} bytes)`)
  return `${(size / 1024).toFixed(1)} KiB client bundle`
})

check('files[] ships everything the plugin needs at runtime', () => {
  const required = ['lib', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'CHANGELOG.md', 'LICENSE', 'screenshots.json', 'assets']
  const files = pkg.files ?? []
  for (const entry of required) assert(files.includes(entry), `files[] does not include "${entry}"`)
  return `${files.length} entries`
})

check('LICENSE file exists and package license is MIT', () => {
  assert(exists('LICENSE'), 'LICENSE file is missing')
  assert(pkg.license === 'MIT', `license is ${pkg.license}`)
  return pkg.license
})

check('official @deepseek-ai packages are peer dependencies, not dependencies', () => {
  const deps = Object.keys(pkg.dependencies ?? {})
  const bad = deps.filter((name) => name.startsWith('@deepseek-ai/'))
  assert(bad.length === 0, `dependencies contain ${bad.join(', ')} — move them to peerDependencies`)
  assert(Object.keys(pkg.peerDependencies ?? {}).some((name) => name.startsWith('@deepseek-ai/')), 'no @deepseek-ai peer dependency declared')
  return Object.keys(pkg.peerDependencies ?? {}).join(', ')
})

check('keywords include dsh-plugin', () => {
  assert(Array.isArray(pkg.keywords) && pkg.keywords.includes('dsh-plugin'), 'keywords must include "dsh-plugin"')
  return `${pkg.keywords.length} keywords`
})

check('screenshots.json is valid (1-8 local raster images)', () => {
  const parsed = readJson('screenshots.json')
  const list = Array.isArray(parsed) ? parsed : parsed.screenshots
  assert(Array.isArray(list), 'screenshots.json must be an array or {"screenshots": [...]}')
  assert(list.length >= 1 && list.length <= 8, `screenshots count is ${list.length} (1-8 allowed)`)
  for (const entry of list) {
    assert(typeof entry === 'string' && entry.length > 0, 'screenshot entries must be strings')
    assert(!entry.startsWith('/') && !entry.includes('..'), `screenshot path must stay inside the repo: ${entry}`)
    assert(/\.(png|jpe?g|webp)$/i.test(entry), `screenshot must be a raster image: ${entry}`)
    assert(exists(entry), `screenshot file is missing: ${entry}`)
  }
  return `${list.length} screenshots`
})

check('storefront icon exists', () => {
  assert(exists('assets/icon-180.png'), 'assets/icon-180.png is missing')
  return 'assets/icon-180.png'
})

check('README describes installation from the public repo', () => {
  assert(README.includes('dsh plugin'), 'README does not mention "dsh plugin"')
  assert(README.includes('github:sleeping112/dsh-sideask'), 'README does not show the github: install target')
  assert(README_ZH.includes('dsh plugin'), 'README.zh.md does not mention "dsh plugin"')
  assert(README.includes('LEGEND') === false, 'placeholder text left in README')
  return 'README + README.zh.md'
})

check('SECURITY.md and CONTRIBUTING.md are present', () => {
  assert(exists('SECURITY.md'), 'SECURITY.md is missing')
  assert(exists('CONTRIBUTING.md'), 'CONTRIBUTING.md is missing')
  return 'both present'
})

// --------------------------------------------------------------------- output

const width = Math.max(...checks.map((check) => check.name.length))
for (const item of checks) {
  const mark = item.ok ? '✓' : '✗'
  console.log(`${mark} ${item.name.padEnd(width)}  ${item.detail}`)
}
console.log('')
if (failures.length > 0) {
  console.error(`preflight failed: ${failures.length} check(s) — ${failures.join('; ')}`)
  process.exit(1)
}
console.log(`preflight ok: ${checks.length} checks`)
