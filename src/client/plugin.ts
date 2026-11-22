/**
 * Plugin wiring for the browser half.
 *
 * Hard rule learned from two real incidents: **`apply()` must never throw.**
 * A throw inside a client plugin's `apply` fails that entry, fails web boot, and
 * makes the app offer to disable ALL third-party plugins. So every optional
 * registration is wrapped: a failing feature degrades to "not available", and
 * the plugin still activates.
 *
 * Registrations:
 *   1. locale dictionaries (zh + en are required by the locale contract);
 *   2. the plugin-owned global hotkey (`keydown` listener — see `hotkey.ts` for
 *      why the host shortcut service is not used: it rejects Web bindings
 *      without `primary` and throws, which is what broke boot);
 *   3. the selection interaction (captures selected text as top-priority context);
 *   4. a zero-height session probe in a session-scoped slot (current conversation);
 *   5. the floating window in the root `shell.overlay` slot.
 */

import * as React from 'react'
import { createRoot } from 'react-dom/client'

import type {
  ConversationService,
  LocaleService,
  PluginContext,
  SessionsService,
  SlotOptions,
  SlotsService,
  UiConversationService,
} from './types.js'
import { createHostApi } from './host-api.js'
import { ContextSource } from './context-source.js'
import { reveal } from './jump.js'
import { matchesHotkey, parseHotkey } from './hotkey.js'
import { SessionProbe } from './session-probe.js'
import { pickFallbackSession } from './session-fallback.js'
import { SideAskStore } from './store.js'
import { ShadowHost } from './window-shell.js'

export const PLUGIN_NAME = 'dsh-sideask'
export const LOCALE_NAMESPACE = 'dsh-sideask'

const DICTIONARIES = {
  zh: {
    toggle: '打开/收起旁问',
    title: '旁问',
    nav: '旁问',
    hint: '只读主对话 · 只有点动作按钮才写回',
  },
  en: {
    toggle: 'Toggle Side Ask',
    title: 'Side Ask',
    nav: 'Side Ask',
    hint: 'Read-only context · write-back only on explicit click',
  },
}

export interface PluginExports {
  name: string
  inject: string[]
  apply(ctx: PluginContext): void
}

function service<T>(ctx: PluginContext, name: string): T | undefined {
  try {
    const value = ctx.get(name)
    return value === undefined || value === null ? undefined : (value as T)
  } catch {
    return undefined
  }
}

const NOOP = (): void => {}

function warn(message: string, error: unknown): void {
  try {
    // eslint-disable-next-line no-console
    console.warn(`[dsh-sideask] ${message}`, error)
  } catch {
    // Never let logging break activation.
  }
}

export function createPlugin(): PluginExports {
  return {
    name: PLUGIN_NAME,
    // Only the services we truly need before activating. Every one of them is
    // also feature-detected below, so a partial composition still activates.
    inject: ['slots', 'locale', 'sessions', 'uiConversation'],

    apply(ctx: PluginContext): void {
      try {
        applyUnsafe(ctx)
      } catch (error) {
        // Last line of defence: never fail the host's web boot.
        warn('plugin activation failed; the floating window is unavailable', error)
      }
    },
  }

  function applyUnsafe(ctx: PluginContext): void {
    const slots = service<SlotsService>(ctx, 'slots')
    const locale = service<LocaleService>(ctx, 'locale')
    const sessions = service<SessionsService>(ctx, 'sessions')
    const uiConversation = service<UiConversationService>(ctx, 'uiConversation')
    const conversation = service<ConversationService>(ctx, 'conversation')

    const api = createHostApi()
    const contextSource = new ContextSource({
      sessions,
      // Background history compression: reuses the same host model routing as ask.
      summarize: (messages, signal) => api.summarize(messages, undefined, signal),
    })
    const store = new SideAskStore({ api, contextSource, conversation })

    // Debug handle: lets a developer inspect state from the console without
    // adding a second RPC surface.
    try {
      ;(window as unknown as Record<string, unknown>)['__dshSideAsk'] = { store, contextSource, reveal, version: '0.2.0' }
    } catch {
      // Non-browser context: nothing to expose.
    }

    /** Run one optional registration; a failure degrades only that feature. */
    const safe = (label: string, run: () => (() => void) | void): void => {
      try {
        const dispose = run()
        if (typeof dispose === 'function') ctx.effect(() => dispose, `sideask: ${label}`)
      } catch (error) {
        warn(`${label} unavailable`, error)
      }
    }

    // ---- 1. locale -------------------------------------------------------
    if (locale !== undefined) {
      safe('dictionaries', () => locale.register(LOCALE_NAMESPACE, DICTIONARIES))
    }

    // ---- 2. hotkey (plugin-owned) ---------------------------------------
    // The host shortcut service rejects `Alt+Shift+A` on Web and throws; a
    // plugin-owned listener keeps the documented default and cannot fail boot.
    safe('hotkey', () => {
      const onKeyDown = (event: KeyboardEvent): void => {
        // Never steal the key while an IME composition is in progress.
        if (event.isComposing) return
        const parsed = parseHotkey(store.getSnapshot().settings.hotkey)
        if (parsed === null) return
        if (!matchesHotkey(parsed, event)) return
        event.preventDefault()
        store.toggleOpen()
      }
      window.addEventListener('keydown', onKeyDown)
      return () => window.removeEventListener('keydown', onKeyDown)
    })

    // ---- 3. selection interaction ---------------------------------------
    // Capture the selection but deliberately do NOT call `request.open()`: the
    // gesture dispatch hands the popup to the FIRST opener, and stealing it from
    // the official quote plugin would be a hostile integration. The text becomes
    // the highest-priority context of the next side-ask question.
    if (uiConversation !== undefined && uiConversation.interactions !== undefined) {
      safe('selection interaction', () =>
        uiConversation.interactions.register({
          id: 'sideask',
          onInteraction(request) {
            try {
              if (request.trigger !== 'selection') return
              const text = request.readText()
              if (text === null || text.trim().length === 0) return
              store.setSelection({ text, sessionId: request.sessionId })
              if (typeof request.sessionId === 'string' && request.sessionId.length > 0) {
                void store.setSession(request.sessionId)
              }
              store.toast('info', `已捕获选中片段，按 ${store.getSnapshot().settings.hotkey} 打开旁问即可提问`)
            } catch (error) {
              warn('selection interaction handler failed', error)
            }
          },
        }),
      )
    }

    // ---- 4. current-session probe ---------------------------------------
    // A session-scoped slot gives us the bound session; the probe renders
    // nothing. Unknown slot names simply never fire (inject waits), so both
    // plausible dock slots are tried.
    if (slots !== undefined) {
      const probeComponent = (props: Record<string, unknown>): React.ReactNode =>
        React.createElement(SessionProbe, { ...props, store })
      const registrations: [string, SlotOptions][] = [
        // List slots require `id` (a `key` alone is rejected: "list slot … requires options.id").
        ['conversation.input.dock', { name: 'conversation.input.dock', id: 'sideask-probe', order: 90 }],
        ['conversation.composer.dock', { name: 'conversation.composer.dock', id: 'sideask-probe', order: 90 }],
      ]
      for (const [slotName, options] of registrations) {
        safe(`session probe (${slotName})`, () =>
          slots.inject(slotName, () => slots.register(options, probeComponent)),
        )
      }
    }

    // Fallback: if no probe fired shortly after boot, adopt the most plausible
    // session from the catalog. Never blindly `ids[0]`: the picker prefers the
    // session retained by the main view, then the most recently updated one, and
    // ignores blank sessions (wrong binding is worse than no binding).
    safe('session fallback', () => {
      const timer = setTimeout(() => {
        if (store.getSnapshot().sessionId !== null) return
        const list = sessions?.list
        if (list === undefined) return
        try {
          const picked = pickFallbackSession(list.getSnapshot())
          if (picked !== null) void store.setSession(picked.id)
        } catch (error) {
          warn('session fallback lookup failed', error)
        }
      }, 2500)
      ;(timer as unknown as { unref?: () => void }).unref?.()
      return () => clearTimeout(timer)
    })

    // ---- 5. floating window ---------------------------------------------
    if (slots !== undefined) {
      safe('overlay mount', () => {
        try {
          return slots.inject('shell.overlay', () =>
            slots.register({ name: 'shell.overlay', id: 'sideask', order: 40 }, () =>
              React.createElement(ShadowHost, { store, conversation, contextSource }),
            ),
          )
        } catch (error) {
          // Last resort: mount straight into the body so the feature exists.
          warn('shell.overlay unavailable, mounting into document.body', error)
          const host = document.createElement('div')
          host.setAttribute('data-sideask', 'body-mount')
          document.body.appendChild(host)
          const root = createRoot(host)
          root.render(React.createElement(ShadowHost, { store, conversation, contextSource }))
          return () => {
            root.unmount()
            host.remove()
          }
        }
      })
    }

    // ---- dispose ---------------------------------------------------------
    safe('dispose', () => () => {
      contextSource.release()
      store.dispose()
    })
  }
}
