/**
 * Explicit write-back into the main conversation.
 *
 * THE ONLY module in the browser half that can change the main conversation,
 * and every entry point is user-triggered. The spec's hard rule — "default: do
 * not write back" — is enforced structurally: nothing calls these functions
 * except a click handler.
 *
 * Fallback ladder for a quote (each step is verified against the research doc):
 *   1. `inputActions.insertQuote(text)`  — native quote node, Markdown on send;
 *   2. `captureInsertion()` + `insertText(text, span)` — insert at the caret;
 *   3. `setDraft(text)`                  — replace the draft (destructive, last);
 *   4. clipboard                          — never loses the user's text.
 *
 * `insertQuote` only applies while the composer is in plain mode and returns
 * `false` otherwise, which is exactly why the ladder exists.
 */

import type { ComposerActions, ConversationService } from './types.js'

export type WritebackKind = 'copy' | 'quote' | 'quote-with-note' | 'draft'

export interface WritebackResult {
  ok: boolean
  /** Which mechanism actually succeeded, for diagnostics/toasts. */
  via: 'quote' | 'insert' | 'draft' | 'clipboard'
  /** Set when the action could not complete fully. */
  note?: string
}

export interface WritebackDeps {
  conversation: ConversationService | undefined
  /** Session-scoped ctx from the retained binding (required by `input.for`). */
  getSessionCtx: () => unknown
  clipboard?: (text: string) => Promise<void>
  /**
   * Ask before replacing the main composer draft. Default true; callers that
   * already confirmed intent (e.g. the explicit "hand off to main chat" action)
   * pass false to avoid a double dialog.
   */
  confirmDraft?: boolean
}

/** Resolve the composer action face for the bound session, or null. */
export function resolveComposerActions(deps: WritebackDeps): ComposerActions | null {
  const conversation = deps.conversation
  if (conversation === undefined || conversation === null) return null
  try {
    const sessionCtx = deps.getSessionCtx()
    if (sessionCtx === null || sessionCtx === undefined) return null
    const shell = conversation.input.for(sessionCtx)
    return shell.actions ?? null
  } catch {
    // `input.for` throws for a non-retained session scope.
    return null
  }
}

async function copyText(text: string, deps: WritebackDeps): Promise<boolean> {
  try {
    if (deps.clipboard !== undefined) {
      await deps.clipboard(text)
      return true
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to legacy copy.
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

/** Quote block used when the composer path is unavailable or for "with note". */
export function toQuoteBlock(text: string, note?: string): string {
  const lines = text.split(/\r?\n/).map((line) => `> ${line}`)
  if (note === undefined || note.trim().length === 0) return lines.join('\n')
  return `${lines.join('\n')}\n\n— ${note}（来自旁问）`
}

/**
 * Text used for "hand this answer to the main conversation": an explicit
 * instruction so the main agent treats it as a task, not as chit-chat.
 */
export function buildHandoffText(text: string): string {
  return `请执行以下旁问结论：\n\n${text.trim()}`
}

/**
 * Insert `text` into the main composer.
 *
 * `quote-with-note` adds a one-line attribution so the main conversation can
 * tell what came from the side thread.
 */
export async function writeBack(kind: WritebackKind, text: string, deps: WritebackDeps): Promise<WritebackResult> {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ok: false, via: 'clipboard', note: '内容为空' }

  if (kind === 'copy') {
    const ok = await copyText(trimmed, deps)
    return ok ? { ok: true, via: 'clipboard' } : { ok: false, via: 'clipboard', note: '剪贴板不可用' }
  }

  const body = kind === 'quote-with-note' ? toQuoteBlock(trimmed, '引用自旁问') : trimmed
  const actions = resolveComposerActions(deps)

  if (kind === 'draft') {
    if (actions !== null) {
      // "Insert as draft" replaces whatever is in the main composer: make that
      // destructive step explicit instead of silently overwriting a draft.
      const confirmed =
        deps.confirmDraft === false ||
        typeof window === 'undefined' ||
        typeof window.confirm !== 'function'
          ? true
          : window.confirm('将用旁问内容替换主对话输入框里现有的草稿，继续？')
      if (!confirmed) return { ok: false, via: 'draft', note: '已取消（未修改主对话草稿）' }
      try {
        actions.setDraft(body)
        return { ok: true, via: 'draft' }
      } catch {
        // Fall through to clipboard.
      }
    }
    const ok = await copyText(body, deps)
    return ok
      ? { ok: true, via: 'clipboard', note: '输入框不可用，已复制到剪贴板，请手动粘贴' }
      : { ok: false, via: 'clipboard', note: '输入框与剪贴板都不可用' }
  }

  // kind === 'quote' | 'quote-with-note'
  if (actions !== null) {
    try {
      if (actions.insertQuote(body)) return { ok: true, via: 'quote' }
    } catch {
      // Continue down the ladder.
    }
    try {
      const span = actions.captureInsertion()
      if (actions.insertText(body, span)) return { ok: true, via: 'insert' }
    } catch {
      // Continue down the ladder.
    }
    try {
      actions.setDraft(body)
      return { ok: true, via: 'draft', note: '输入框当前不是纯文本模式，已作为草稿写入（会替换现有草稿）' }
    } catch {
      // Continue down the ladder.
    }
  }

  const ok = await copyText(body, deps)
  return ok
    ? { ok: true, via: 'clipboard', note: '无法直接写入输入框，已复制引用块，请手动粘贴' }
    : { ok: false, via: 'clipboard', note: '无法写入输入框，剪贴板也不可用' }
}
