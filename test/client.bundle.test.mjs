/**
 * Bundle contract test — executes the REAL built `lib/client.js` under a fake
 * Module Loader and asserts the exact contract dsh's web client relies on.
 *
 * This test exists because of a real incident: the bundle used to register its
 * factory twice (once in the build wrapper, once from `src/client/index.ts`
 * inside the factory body). The dsh loader rejects that with
 * `duplicate factory registration for "dsh-sideask"` and web boot fails — the
 * app then offers to disable third-party plugins. A plain "does the file contain
 * `__ModuleLoader__.load`" check cannot catch it, so here we actually run it.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = path.join(root, 'lib', 'client.js')
const source = fs.existsSync(bundlePath) ? fs.readFileSync(bundlePath, 'utf8') : ''

/** Modules the platform seed table may provide; anything else is a hard failure. */
const SEED = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'])

function reactStub() {
  const hook = () => undefined
  return {
    createElement: () => null,
    Fragment: {},
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, hook],
    useEffect: hook,
    useLayoutEffect: hook,
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
    useCallback: (callback) => callback,
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    memo: (component) => component,
  }
}

/** A sandbox that records registrations and refuses unexpected requires. */
function runBundle() {
  const registrations = []
  const requestedModules = []
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    AbortController,
    navigator: {},
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    document: {
      createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, remove() {} }),
      querySelector: () => null,
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
    window: {
      __ModuleLoader__: {
        load(definition) {
          registrations.push(definition)
        },
      },
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      localStorage: { getItem: () => null, setItem: () => undefined },
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })

  const requireStub = (id) => {
    requestedModules.push(id)
    if (!SEED.has(id)) throw new Error(`unexpected require("${id}") — must be bundled or in the seed table`)
    if (id === 'react') return reactStub()
    if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: {} }
    if (id === 'react-dom') return { createPortal: () => null }
    return { createRoot: () => ({ render() {}, unmount() {} }) }
  }
  return { registrations, requestedModules, requireStub }
}

test('the bundle registers exactly one Module Loader factory', () => {
  assert.ok(source.length > 0, 'lib/client.js must exist — run npm run build')
  const { registrations } = runBundle()
  assert.equal(registrations.length, 1, 'exactly one registration, otherwise dsh rejects the bundle')
  assert.equal(registrations[0].id, 'dsh-sideask')
  assert.equal(typeof registrations[0].factory, 'function')
})

test('materialising the factory yields a plugin with name/inject/apply', () => {
  const { registrations, requestedModules, requireStub } = runBundle()
  const plugin = registrations[0].factory(requireStub)

  assert.equal(typeof plugin, 'object')
  assert.equal(plugin.name, 'dsh-sideask')
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(Array.isArray(plugin.inject))
  assert.ok(plugin.inject.includes('slots'), 'must declare the slots dependency')
  // The host shortcut service rejects Web bindings without `primary` and THROWS;
  // that throw used to fail web boot. The plugin owns its hotkey instead, so it
  // must never depend on the host service again.
  assert.ok(!plugin.inject.includes('shortcuts'), 'must not depend on the host shortcuts service')

  // The regression that broke web boot: a registration from inside the factory.
  assert.equal(registrations.length, 1, 'factory execution must NOT register a second factory')
  assert.equal(registrations[0].id, 'dsh-sideask')
})

test('the factory only requires modules from the platform seed table', () => {
  const { registrations, requestedModules, requireStub } = runBundle()
  registrations[0].factory(requireStub)
  const unexpected = requestedModules.filter((id) => !SEED.has(id))
  assert.deepEqual(unexpected, [], `unexpected requires: ${unexpected.join(', ')}`)
})

test('apply() tolerates a bare context (no services at all)', () => {
  const { registrations, requireStub } = runBundle()
  const plugin = registrations[0].factory(requireStub)
  const disposers = []
  const bareContext = {
    get: () => undefined,
    effect: (setup) => {
      const dispose = setup()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    inject: () => undefined,
    provide: () => undefined,
  }
  // Must not throw: a partially composed profile only degrades features.
  plugin.apply(bareContext)
  assert.equal(registrations.length, 1)
  for (const dispose of disposers) dispose()
})

/**
 * Regression for the second real boot failure: the host shortcut service throws
 * `Unsupported Web shortcut` for Alt+Shift+A, and that throw propagated out of
 * apply() and failed web boot. `apply()` must never throw, no matter which
 * service throws.
 */
test('apply() never throws even when every service throws', () => {
  const { registrations, requireStub } = runBundle()
  const plugin = registrations[0].factory(requireStub)
  const hostileContext = {
    get: () => ({
      register: () => {
        throw new Error('Unsupported Web shortcut: side-ask.toggle')
      },
      interactions: {
        register: () => {
          throw new Error('duplicate interaction id')
        },
      },
      inject: () => {
        throw new Error('unknown slot')
      },
      list: {
        getSnapshot: () => {
          throw new Error('catalog unavailable')
        },
      },
    }),
    effect: (setup) => {
      try {
        setup()
      } catch {
        // A real cordis effect would surface this; the plugin must already have
        // contained it.
      }
    },
    inject: () => undefined,
    provide: () => undefined,
  }
  assert.doesNotThrow(() => plugin.apply(hostileContext))
  assert.equal(registrations.length, 1)
})
