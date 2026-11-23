/**
 * dsh-sideask — host half entry.
 *
 * A floating "side ask" light conversation beside the main chat. The host half
 * owns the model call, the thread store, and the HTTP API; the browser half
 * (`lib/client.js`) owns the window, the transcript extraction, and every
 * write-back decision.
 *
 * Loaded by the dsh plugin loader as a row whose `name` is `dsh-sideask`; the
 * bundle patch is `cordis.patch.yml` in this package.
 */

import { Config, readConfig } from './config.js'
import { registerRoutes } from './http.js'
import { SideAskRuntime, type HostContext } from './runtime.js'

export const name = 'sideask'

export { Config }

/**
 * Mount the plugin.
 *
 * The web server and DSH's connection service are injected rather than
 * assumed: `ctx.inject(['webServer', 'connection'], …)` is the verified cordis
 * pattern, and `connection.requestRejection` is the Host/Origin + browser-auth
 * fence every route applies. A profile with either service missing still loads
 * the plugin and simply has no HTTP surface — a visible, non-fatal state.
 */
export function apply(ctx: unknown, config: unknown): void {
  const hostCtx = ctx as HostContext

  // Normalise once so a malformed profile entry cannot crash the loader.
  try {
    readConfig(config)
  } catch {
    // `readConfig` has defaults for everything; a bad row is not fatal.
  }

  const runtime = new SideAskRuntime(hostCtx, config)

  try {
    hostCtx.provide?.('sideAsk', runtime)
  } catch {
    // Another composition may already provide this service name.
  }

  hostCtx.inject?.(['webServer', 'connection'], (child) => {
    child.effect?.(() => registerRoutes(child, runtime), 'sideask: http routes')
  })

  hostCtx.effect?.(() => () => runtime.dispose(), 'sideask: runtime dispose')
}
