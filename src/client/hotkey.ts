/**
 * Hotkey parsing and matching — pure, DOM-free, unit-tested.
 *
 * Why the plugin owns its hotkey instead of registering with the host shortcuts
 * service: that service rejects any Web binding that is not "3+ modifiers" or
 * "contains primary (Ctrl/⌘)" (`dsh-client-shortcuts/lib/client.js:109-1220`),
 * and it THROWS on rejection. A throw inside `apply()` fails the whole client
 * entry, which fails web boot and makes the application offer to disable
 * third-party plugins. `Alt+Shift+A` is exactly such a rejected binding.
 *
 * So: the plugin listens on `keydown` itself. If the user wants the shortcut to
 * appear in the host's shortcut list later, a *display-only* `registerFixed`
 * contribution can be added without binding behaviour to it.
 */

export interface ParsedHotkey {
  alt: boolean
  ctrl: boolean
  meta: boolean
  shift: boolean
  /** KeyboardEvent.code, e.g. `KeyA`, `Digit1`, `F5`. */
  code: string
}

const MODIFIER_ALIASES: Record<string, 'alt' | 'ctrl' | 'meta' | 'shift'> = {
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  ctrl: 'ctrl',
  control: 'ctrl',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  win: 'meta',
  shift: 'shift',
}

/** Parse `Ctrl+Shift+A` / `Alt+Shift+A` / `F5` into a matcher. */
export function parseHotkey(spec: string): ParsedHotkey | null {
  const parts = spec
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length === 0) return null

  const parsed: ParsedHotkey = { alt: false, ctrl: false, meta: false, shift: false, code: '' }
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()]
    if (modifier !== undefined) {
      parsed[modifier] = true
      continue
    }
    const code = toCode(part)
    if (code === null) return null
    if (parsed.code.length > 0) return null // only one non-modifier key
    parsed.code = code
  }
  return parsed.code.length > 0 ? parsed : null
}

/** Map a printed key to `KeyboardEvent.code`. */
function toCode(key: string): string | null {
  if (/^[a-zA-Z]$/u.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/u.test(key)) return `Digit${key}`
  if (/^f([1-9]|1[0-9]|2[0-4])$/iu.test(key)) return key.toUpperCase()
  const named: Record<string, string> = {
    space: 'Space',
    escape: 'Escape',
    esc: 'Escape',
    enter: 'Enter',
    tab: 'Tab',
    backquote: 'Backquote',
    slash: 'Slash',
    comma: 'Comma',
    period: 'Period',
    backslash: 'Backslash',
    semicolon: 'Semicolon',
    quote: 'Quote',
    minus: 'Minus',
    equal: 'Equal',
    arrowup: 'ArrowUp',
    arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight',
  }
  return named[key.toLowerCase()] ?? null
}

/** True when a keyboard event exactly matches the parsed hotkey. */
export function matchesHotkey(
  parsed: ParsedHotkey,
  event: {
    altKey: boolean
    ctrlKey: boolean
    metaKey: boolean
    shiftKey: boolean
    code: string
  },
): boolean {
  return (
    parsed.alt === event.altKey &&
    parsed.ctrl === event.ctrlKey &&
    parsed.meta === event.metaKey &&
    parsed.shift === event.shiftKey &&
    parsed.code === event.code
  )
}

/** Human-readable form used in tooltips and toasts (`Alt+Shift+A`). */
export function formatHotkey(parsed: ParsedHotkey): string {
  const labels: string[] = []
  if (parsed.ctrl) labels.push('Ctrl')
  if (parsed.meta) labels.push('Meta')
  if (parsed.alt) labels.push('Alt')
  if (parsed.shift) labels.push('Shift')
  const key = parsed.code.replace(/^(Key|Digit)/u, '')
  labels.push(key)
  return labels.join('+')
}
