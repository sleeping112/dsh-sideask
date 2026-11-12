/**
 * Citation protocol.
 *
 * The model is handed context items with short references (`c1`, `c2`, …) and
 * is asked to answer normally and then append ONE machine-readable line:
 *
 *     ⟦refs: c1, c3⟧
 *
 * That trailing block is authoritative. Inline `[c2]` markers are also
 * accepted and preserved for rendering, because models reliably sprinkle them
 * into prose even when told not to. Unknown references are dropped: the model
 * must never be able to cite something the user was not shown.
 */

import type { Citation, ContextItem } from './contract.js'

/** Reference token: `c12`, `C12`. */
const REF_TOKEN = /c(\d+)/gi

/** Trailing block, tolerant of ASCII and full-width brackets. */
const TRAILING_BLOCK = /(?:⟦|\[\[|［［|［|【)\s*refs?\s*[:：]\s*([^⟧\]］】]*?)\s*(?:⟧|\]\]|］］|］|】)\s*$/i

export interface ParsedAnswer {
  /** Answer text with the trailing citation block removed. */
  text: string
  /** Referenced `ci` keys in first-appearance order, de-duplicated. */
  refs: string[]
  /** True when inline `[cN]` markers were found in the prose. */
  hasInlineMarkers: boolean
}

/**
 * Split the machine-readable citation block off the answer.
 *
 * The block must be the last non-whitespace thing in the text; anything else is
 * treated as prose so a model that forgets the protocol still produces a
 * usable answer.
 */
export function parseAnswer(raw: string): ParsedAnswer {
  const trimmedEnd = raw.replace(/\s+$/, '')
  const match = TRAILING_BLOCK.exec(trimmedEnd)
  const refs: string[] = []
  const push = (value: string | undefined): void => {
    if (value === undefined) return
    const normalized = value.toLowerCase()
    if (!refs.includes(normalized)) refs.push(normalized)
  }

  let text = trimmedEnd
  if (match !== null) {
    text = trimmedEnd.slice(0, match.index).replace(/\s+$/, '')
    const list = match[1] ?? ''
    for (const token of list.matchAll(REF_TOKEN)) push(token[0])
  }

  // Inline markers fill in refs the trailing block missed, in prose order.
  let hasInlineMarkers = false
  for (const token of text.matchAll(/\[(c\d+)\]/gi)) {
    hasInlineMarkers = true
    push(token[1])
  }

  return { text, refs, hasInlineMarkers }
}

/** Short, single-line excerpt used for citation chip tooltips. */
export function excerptOf(text: string, maxChars = 120): string {
  const flattened = text.replace(/\s+/g, ' ').trim()
  if (flattened.length <= maxChars) return flattened
  return `${flattened.slice(0, maxChars - 1)}…`
}

/**
 * Map parsed refs onto the context items that were actually sent.
 * Unresolvable refs are dropped rather than reported as a citation.
 */
export function resolveCitations(refs: string[], items: ContextItem[]): Citation[] {
  const byRef = new Map(items.map((item) => [item.ref.toLowerCase(), item]))
  const citations: Citation[] = []
  const seen = new Set<string>()
  for (const ref of refs) {
    const key = ref.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const item = byRef.get(key)
    if (item === undefined) continue
    citations.push({
      ref: item.ref,
      messageId: item.messageId,
      role: item.role,
      excerpt: excerptOf(item.text),
    })
  }
  return citations
}

/** Parse + resolve in one step, for the host's stream finaliser. */
export function finaliseAnswer(raw: string, items: ContextItem[]): { text: string; citations: Citation[] } {
  const parsed = parseAnswer(raw)
  return { text: parsed.text, citations: resolveCitations(parsed.refs, items) }
}
