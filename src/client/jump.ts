/**
 * Citation jump — map a `{ messageId, excerpt }` citation back onto the host
 * page's conversation transcript.
 *
 * The main transcript does not guarantee stable `data-message-id` attributes, so
 * jumping cannot rely on one selector alone. The strategy ladder is:
 *
 * 1. exact `[data-message-id="…"]` selector (cheap, authoritative when present);
 * 2. attribute scan, comparing `getAttribute` values (some clients render the
 *    attribute through a wrapper, so the selector may miss it);
 * 3. visible-text probe: locate the tightest element whose normalized
 *    `textContent` contains the citation excerpt, walking backwards from the
 *    newest messages so a repeated phrase resolves to the latest occurrence.
 *
 * Everything here is DOM-structural and side-effect free except `highlight` /
 * `reveal`, which are explicitly user-visible. Tests drive the same code with
 * plain-object fakes, so no `instanceof Element` checks are used.
 */

/** One citation target: the source message id plus a short usable excerpt. */
export interface JumpTarget {
  messageId: string
  excerpt: string
}

/**
 * Normalize an excerpt into the text probe used for fallback matching.
 *
 * Whitespace is collapsed (transcript markup breaks text across nodes), the
 * result is trimmed, and only the first `maxChars` characters are kept. Very
 * short probes are useless (they would match half the page), so they are
 * rejected with `''`.
 */
export function probeText(excerpt: string, maxChars = 24): string {
  if (typeof excerpt !== 'string') return ''
  const collapsed = excerpt.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return ''
  const limit =
    typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 24
  const probe = collapsed.slice(0, limit)
  return probe.length < 8 ? '' : probe
}

/** Minimal structural view of a DOM root (`Document`, `Element`, or a fake). */
export interface LocatableRoot {
  querySelectorAll(selector: string): ArrayLike<Element>
  querySelector(selector: string): Element | null
}

/** Element kinds that can hold one message's visible text. */
const TEXT_CANDIDATE_SELECTOR = 'p,li,pre,code,div,span,td,blockquote'
const MESSAGE_ID_ATTR = 'data-message-id'

/** Escape a value for use inside a double-quoted CSS attribute selector. */
function cssEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Collapse an element's visible text the same way `probeText` collapses input. */
function normalizedText(element: Element): string {
  const text = element.textContent
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
}

/** Run a DOM lookup defensively: hostile/fake roots may throw, never crash. */
function safeQuerySelector(root: LocatableRoot, selector: string): Element | null {
  try {
    return root.querySelector(selector)
  } catch {
    return null
  }
}

function safeQuerySelectorAll(root: LocatableRoot, selector: string): ArrayLike<Element> | null {
  try {
    return root.querySelectorAll(selector)
  } catch {
    return null
  }
}

/**
 * Locate the transcript element for a citation target.
 *
 * Returns the matched element and which rule found it, or `null`. The excerpt
 * rule prefers the element with the SMALLEST normalized `textContent` that still
 * contains the probe (so a tight `<p>` beats the giant chat container around
 * it); equal-size matches resolve to the LAST one in document order.
 */
export function findAnchorWithStrategy(
  root: LocatableRoot,
  target: JumpTarget,
): { element: Element; strategy: 'message-id' | 'excerpt' } | null {
  if (root === null || root === undefined || typeof root !== 'object') return null
  const messageId = typeof target.messageId === 'string' ? target.messageId : ''

  // 1. Exact attribute selector.
  const exact = safeQuerySelector(root, `[${MESSAGE_ID_ATTR}="${cssEscape(messageId)}"]`)
  if (exact !== null) return { element: exact, strategy: 'message-id' }

  // 2. Scan every tagged element and compare the attribute value ourselves.
  const tagged = safeQuerySelectorAll(root, `[${MESSAGE_ID_ATTR}]`)
  if (tagged !== null) {
    for (let index = 0; index < tagged.length; index += 1) {
      const element = tagged[index]
      if (element === undefined || element === null) continue
      let value: string | null = null
      try {
        value = element.getAttribute(MESSAGE_ID_ATTR)
      } catch {
        value = null
      }
      if (value === messageId) return { element, strategy: 'message-id' }
    }
  }

  // 3. Visible-text probe, tightest match wins.
  const probe = probeText(target.excerpt)
  if (probe.length === 0) return null
  const candidates = safeQuerySelectorAll(root, TEXT_CANDIDATE_SELECTOR)
  if (candidates === null) return null

  let best: Element | null = null
  let bestLength = Number.POSITIVE_INFINITY
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    if (candidate === undefined || candidate === null) continue
    const text = normalizedText(candidate)
    if (text.length < probe.length || !text.includes(probe)) continue
    // `<=` makes later equal-size matches win (newest occurrence in document order).
    if (text.length <= bestLength) {
      best = candidate
      bestLength = text.length
    }
  }
  return best === null ? null : { element: best, strategy: 'excerpt' }
}

/** Convenience wrapper: the element to reveal, ignoring which rule matched. */
export function findAnchor(root: LocatableRoot, target: JumpTarget): Element | null {
  const found = findAnchorWithStrategy(root, target)
  return found === null ? null : found.element
}

/** Attribute stamped on the element currently being highlighted. */
export const JUMP_HIGHLIGHT_ATTR = 'data-sideask-jump'

/** Inline styles applied while highlighted (JS property names + CSS values). */
const HIGHLIGHT_STYLES: ReadonlyArray<readonly [string, string]> = [
  ['outline', '2px solid #4d7ef0'],
  ['outlineOffset', '2px'],
  ['borderRadius', '6px'],
]

interface StyleRecord {
  [property: string]: unknown
}

/**
 * Apply the highlight inline styles and return a restore function.
 *
 * The style object is treated structurally because tests pass a plain `{}` and
 * some hosts may hand back a detached/partial node. Missing style support is a
 * no-op, not an error.
 */
function applyHighlightStyles(element: Element): () => void {
  const style = (element as Element & { style?: StyleRecord | undefined }).style
  if (style === null || style === undefined || typeof style !== 'object') return () => undefined

  const saved: Array<{ property: string; previous: unknown }> = []
  for (const [property, value] of HIGHLIGHT_STYLES) {
    saved.push({ property, previous: style[property] })
    try {
      style[property] = value
    } catch {
      // Read-only style object: keep going, best effort.
    }
  }
  return () => {
    for (const { property, previous } of saved) {
      try {
        if (previous === undefined) delete style[property]
        else style[property] = previous
      } catch {
        // Ignore restore failures; the highlight is cosmetic.
      }
    }
  }
}

/** Set the highlight attribute and return a restore function. */
function applyHighlightAttr(element: Element): () => void {
  let previous: string | null = null
  try {
    previous = element.getAttribute(JUMP_HIGHLIGHT_ATTR)
    element.setAttribute(JUMP_HIGHLIGHT_ATTR, '1')
  } catch {
    return () => undefined
  }
  return () => {
    try {
      if (previous === null) {
        if (typeof element.removeAttribute === 'function') element.removeAttribute(JUMP_HIGHLIGHT_ATTR)
        else element.setAttribute(JUMP_HIGHLIGHT_ATTR, '')
      } else {
        element.setAttribute(JUMP_HIGHLIGHT_ATTR, previous)
      }
    } catch {
      // Ignore restore failures; the highlight is cosmetic.
    }
  }
}

/**
 * Briefly mark an element as the jump destination.
 *
 * Stamps `data-sideask-jump`, applies a visible outline, then restores the
 * previous attribute value and inline styles after `durationMs` (default
 * 1600 ms). Never throws when `style`, `setTimeout`, or a style attribute is
 * missing — the jump itself must always succeed.
 */
export function highlight(element: Element, durationMs = 1600): void {
  if (element === null || element === undefined || typeof element !== 'object') return
  const restoreAttr = applyHighlightAttr(element)
  const restoreStyles = applyHighlightStyles(element)
  const restore = (): void => {
    restoreAttr()
    restoreStyles()
  }

  const delay =
    typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 1600
  if (typeof setTimeout !== 'function') return
  try {
    const timer = setTimeout(restore, delay)
    // Node's timer keeps `node --test` alive for the whole default duration
    // unless it is unref'd; browsers return a number without `unref`.
    ;(timer as unknown as { unref?: () => void }).unref?.()
  } catch {
    // No timer support: leave the highlight in place rather than throwing.
  }
}

/**
 * Scroll a citation target into view, highlight it, and report which strategy
 * matched. `'not-found'` means the transcript did not expose the message at all
 * and the caller may show a non-blocking hint.
 */
export function reveal(root: LocatableRoot, target: JumpTarget): 'message-id' | 'excerpt' | 'not-found' {
  const found = findAnchorWithStrategy(root, target)
  if (found === null) return 'not-found'

  try {
    found.element.scrollIntoView({ block: 'center', behavior: 'smooth' })
  } catch {
    try {
      found.element.scrollIntoView()
    } catch {
      // Detached node or hostile fake: the highlight still helps.
    }
  }

  highlight(found.element)
  return found.strategy
}
