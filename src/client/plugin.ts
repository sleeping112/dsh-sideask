/**
 * Plugin wiring for the browser half.
 *
 * `apply(ctx)` registers five things, each inside `ctx.effect` so unloading the
 * plugin removes it cleanly:
 *   1. locale dictionaries (zh + en are required by the locale contract);
 *   2. the global toggle hotkey (with a `document` fallback if the service is
 *      absent, and no fallback at all when it is present, to avoid double firing);
 *   3. the selection interaction (captures selected text as top-priority context);
 *   4. a zero-height session probe in a session-scoped slot (current conversation);
 *   5. the floating window in the root `shell.overlay` slot.
 *
 * Every service is feature-detected. A missing service degrades one feature and
 * never throws: the floating window must keep working on a partially composed
 * profile.
 */

import * as React from 'react'
import { createRoot } from 'react-dom/client'

import type {
  ConversationService,
  LocaleService,
  PluginContext,
  SessionsService,
  ShortcutsService,
  SlotOptions,
  SlotsService,
  UiConversationService,
} from './types.js'
import { createHostApi } from './host-api.js'
import { ContextSource } from './context-source.js'
import { SessionProbe } from './session-probe.js'
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

export function createPlugin(): PluginExports {
  return {
    name: PLUGIN_NAME,
    // Declared dependencies: the slot/locale/shortcut/session services are all
    // optional at runtime, but listing them lets cordis order the boot.
    inject: ['slots', 'locale', 'shortcuts', 'sessions', 'uiConversation'],

    apply(ctx: PluginContext): void {
      const slots = service<SlotsService>(ctx, 'slots')
      const locale = service<LocaleService>(ctx, 'locale')
      const shortcuts = service<ShortcutsService>(ctx, 'shortcuts')
      const sessions = service<SessionsService>(ctx, 'sessions')
      const uiConversation = service<UiConversationService>(ctx, 'uiConversation')
      const conversation = service<ConversationService>(ctx, 'conversation')

      const contextSource = new ContextSource({ sessions })
      const store = new SideAskStore({ api: createHostApi(), contextSource, conversation })

      // Debug handle: lets a developer inspect state from the console without
      // adding a second RPC surface. Harmless in production.
      try {
        ;(window as unknown as Record<string, unknown>)['__dshSideAsk'] = { store, contextSource, version: '0.1.0' }
      } catch {
        // Non-browser context: nothing to expose.
      }

      // ---- 1. locale -----------------------------------------------------
      if (locale !== undefined) {
        ctx.effect(() => locale.register(LOCALE_NAMESPACE, DICTIONARIES), 'sideask: dictionaries')
      }

      // ---- 2. hotkey -----------------------------------------------------
      if (shortcuts !== undefined) {
        ctx.effect(
          () =>
            shortcuts.register({
              id: 'side-ask.toggle',
              label: () => '旁问：打开/收起',
              aliases: ['side ask', 'sideask', '旁问'],
              defaults: {
                'web:windows': { code: 'KeyA', modifiers: ['alt', 'shift'] },
                'web:macos': { code: 'KeyA', modifiers: ['alt', 'shift'] },
                'desktop:windows': { code: 'KeyA', modifiers: ['alt', 'shift'] },
                'desktop:macos': { code: 'KeyA', modifiers: ['alt', 'shift'] },
              },
              regions: ['page', 'editable'],
              resolve: () => ({ status: 'handled', run: () => store.toggleOpen() }),
            }),
          'sideask: hotkey',
        )
      } else {
        ctx.effect(() => {
          const onKeyDown = (event: KeyboardEvent): void => {
            if (event.altKey && event.shiftKey && (event.code === 'KeyA' || event.key.toLowerCase() === 'a')) {
              event.preventDefault()
              store.toggleOpen()
            }
          }
          window.addEventListener('keydown', onKeyDown)
          return () => window.removeEventListener('keydown', onKeyDown)
        }, 'sideask: hotkey fallback')
      }

      // ---- 3. selection interaction --------------------------------------
      // We capture the selection but deliberately do NOT call `request.open()`:
      // the gesture dispatch hands the popup to the FIRST opener, and stealing it
      // from the official quote plugin would be a hostile integration. The text
      // is attached to the next side-ask question instead.
      if (uiConversation !== undefined && uiConversation.interactions !== undefined) {
        ctx.effect(
          () =>
            uiConversation.interactions.register({
              id: 'sideask',
              onInteraction(request) {
                if (request.trigger !== 'selection') return
                let text: string | null = null
                try {
                  text = request.readText()
                } catch {
                  text = null
                }
                if (text === null || text.trim().length === 0) return
                store.setSelection({ text, sessionId: request.sessionId })
                if (typeof request.sessionId === 'string' && request.sessionId.length > 0) {
                  void store.setSession(request.sessionId)
                }
                store.toast('info', '已捕获选中片段，按 Alt+Shift+A 打开旁问即可提问')
              },
            }),
          'sideask: selection interaction',
        )
      }

      // ---- 4. current-session probe --------------------------------------
      // The session-scoped slot gives us the bound session; the probe renders
      // nothing. If the slot/name is unavailable this silently does nothing and
      // the fallback below picks the most recent session.
      if (slots !== undefined) {
        const probeComponent = (props: Record<string, unknown>): React.ReactNode =>
          React.createElement(SessionProbe, { ...props, store })
        const registrations: [string, SlotOptions][] = [
          ['conversation.input.dock', { name: 'conversation.input.dock', key: 'sideask-probe', order: 90 }],
          ['conversation.composer.dock', { name: 'conversation.composer.dock', key: 'sideask-probe', order: 90 }],
        ]
        for (const [slotName, options] of registrations) {
          ctx.effect(() => {
            try {
              return slots.inject(slotName, () => slots.register(options, probeComponent))
            } catch {
              return () => {}
            }
          }, `sideask: session probe (${slotName})`)
        }
      }

      // Fallback: if no probe fired shortly after boot, adopt the most recent
      // session from the catalog. Clearly best-effort — the window keeps working
      // either way, it just may start unbound.
      ctx.effect(() => {
        const timer = setTimeout(() => {
          if (store.getSnapshot().sessionId !== null) return
          const list = sessions?.list
          if (list === undefined) return
          try {
            const snapshot = list.getSnapshot()
            const id = snapshot.ids[0]
            if (typeof id === 'string' && id.length > 0) {
              const row = snapshot.byId[id]
              void store.setSession(id, row?.displayTitle ?? row?.title)
            }
          } catch {
            // Catalog shape differs: leave the window unbound.
          }
        }, 2500)
        ;(timer as unknown as { unref?: () => void }).unref?.()
        return () => clearTimeout(timer)
      }, 'sideask: session fallback')

      // ---- 5. floating window --------------------------------------------
      if (slots !== undefined) {
        const overlayComponent = (): React.ReactNode =>
          React.createElement(ShadowHost, { store, conversation, contextSource })
        ctx.effect(
          () => {
            try {
              return slots.inject('shell.overlay', () =>
                slots.register({ name: 'shell.overlay', id: 'sideask', order: 40 }, overlayComponent),
              )
            } catch (error) {
              // Last resort: mount directly into the body so the feature exists.
              try {
                const host = document.createElement('div')
                host.setAttribute('data-sideask', 'body-mount')
                document.body.appendChild(host)
                const root = createRoot(host)
                root.render(React.createElement(ShadowHost, { store, conversation, contextSource }))
                return () => {
                  root.unmount()
                  host.remove()
                }
              } catch {
                console.error('[dsh-sideask] 无法挂载悬浮窗', error)
                return () => {}
              }
            }
          },
          'sideask: overlay',
        )
      }

      // ---- dispose --------------------------------------------------------
      ctx.effect(
        () => () => {
          contextSource.release()
          store.dispose()
        },
        'sideask: dispose',
      )
    },
  }
}
