/**
 * Browser bundle entry point.
 *
 * The dsh web client executes every plugin bundle as:
 *
 *     window.__ModuleLoader__.load({ id, factory: (require) => plugin })
 *
 * The registration itself is emitted by `scripts/build.mjs`, which wraps the
 * whole esbuild output in exactly ONE `__ModuleLoader__.load(...)` call. This
 * module must therefore NOT register anything: doing so used to produce a second
 * registration from inside the factory, which the loader rejects with
 * `duplicate factory registration for "dsh-sideask"` and which fails web boot.
 *
 * What this module does provide is the factory body: `createPlugin()` builds the
 * plugin object (`{ name, inject, apply }`) that the loader materializes.
 */

import { createPlugin, type PluginExports } from './plugin.js'

export { createPlugin }
export type { PluginExports }
