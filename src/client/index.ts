/**
 * Browser bundle entry point.
 *
 * The dsh web client executes every plugin bundle as:
 *
 *     window.__ModuleLoader__.load({ id, factory: (require) => exports })
 *
 * Executing the bundle only REGISTERS the factory; the body of `factory` runs
 * later, at first materialization, and that is where every side effect lives
 * (CSS injection, listeners, the floating window).
 *
 * `id` must equal the package name the host resolved, otherwise the loader
 * refuses the registration ("loaded without registering … via
 * __ModuleLoader__.load"). The bundle is built as CJS with React left external
 * and wrapped in this registration by `scripts/build.mjs`.
 */

import type { RequireFn } from './types.js'
import { createPlugin, type PluginExports } from './plugin.js'

export interface ModuleLoaderDefinition {
  id: string
  factory: (require: RequireFn) => unknown
}

declare global {
  interface Window {
    __ModuleLoader__?: {
      load(definition: ModuleLoaderDefinition): void
    }
  }
}

export const definition: ModuleLoaderDefinition = {
  id: 'dsh-sideask',
  factory: (_require: RequireFn): PluginExports => createPlugin(),
}

const loader = typeof window === 'undefined' ? undefined : window.__ModuleLoader__
if (loader !== undefined) loader.load(definition)

// Also exported for tests and for the CJS wrapper's `module.exports`.
export { createPlugin }
export type { PluginExports }
