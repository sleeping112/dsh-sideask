/**
 * Minimal Markdown → AST parser — pure, DOM-free, XSS-safe by construction.
 *
 * No markdown library is available to a plugin bundle (and pulling one in would
 * cost ~40 KB for the five things an assistant answer actually uses), so this
 * parses the small subset and emits an AST. Rendering lives in the view layer
 * and builds React nodes — text is never interpreted as HTML.
 *
 * Supported: paragraphs, fenced code blocks, headings (1-3 `#`), unordered and
 * ordered lists, `**bold**`, `` `inline code` ``, and `[cN]` citation markers.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'code'; text: string }
  | { type: 'citation'; ref: string }

export type Block =
  | { type: 'paragraph'; inlines: Inline[] }
  | { type: 'heading'; level: number; inlines: Inline[] }
  | { type: 'code'; text: string; lang: string | null }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'quote'; inlines: Inline[] }

const CITATION = /^\[(c\d+)\]/i

/** Split one line into inline runs. */
export function parseInline(text: string): Inline[] {
  const inlines: Inline[] = []
  let index = 0
  let buffer = ''

  const flush = (): void => {
    if (buffer.length > 0) {
      inlines.push({ type: 'text', text: buffer })
      buffer = ''
    }
  }

  while (index < text.length) {
    const rest = text.slice(index)

    const citation = CITATION.exec(rest)
    if (citation !== null) {
      flush()
      inlines.push({ type: 'citation', ref: (citation[1] ?? '').toLowerCase() })
      index += citation[0].length
      continue
    }

    if (rest.startsWith('**')) {
      const end = rest.indexOf('**', 2)
      if (end > 2) {
        flush()
        inlines.push({ type: 'bold', text: rest.slice(2, end) })
        index += end + 2
        continue
      }
    }

    if (rest.startsWith('`')) {
      const end = rest.indexOf('`', 1)
      if (end > 1) {
        flush()
        inlines.push({ type: 'code', text: rest.slice(1, end) })
        index += end + 1
        continue
      }
    }

    buffer += text[index]
    index += 1
  }
  flush()
  return inlines
}

/** Parse a whole answer into blocks. Unknown syntax degrades to plain text. */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = []
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  let index = 0
  let paragraph: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const text = paragraph.join('\n').trim()
    if (text.length > 0) blocks.push({ type: 'paragraph', inlines: parseInline(text) })
    paragraph = []
  }

  while (index < lines.length) {
    const line = lines[index] ?? ''

    // Fenced code block.
    const fence = /^\s*```(\w*)\s*$/.exec(line)
    if (fence !== null) {
      flushParagraph()
      const lang = (fence[1] ?? '').trim()
      const body: string[] = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      blocks.push({ type: 'code', text: body.join('\n'), lang: lang.length > 0 ? lang : null })
      continue
    }

    if (/^\s*$/.test(line)) {
      flushParagraph()
      index += 1
      continue
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flushParagraph()
      blocks.push({ type: 'heading', level: (heading[1] ?? '#').length, inlines: parseInline(heading[2] ?? '') })
      index += 1
      continue
    }

    const quote = /^>\s?(.*)$/.exec(line)
    if (quote !== null) {
      flushParagraph()
      const body: string[] = [quote[1] ?? '']
      index += 1
      while (index < lines.length) {
        const next = /^>\s?(.*)$/.exec(lines[index] ?? '')
        if (next === null) break
        body.push(next[1] ?? '')
        index += 1
      }
      blocks.push({ type: 'quote', inlines: parseInline(body.join('\n')) })
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet !== null || ordered !== null) {
      flushParagraph()
      const isOrdered = ordered !== null
      const items: Inline[][] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        const match = isOrdered ? /^\s*\d+[.)]\s+(.*)$/.exec(current) : /^\s*[-*+]\s+(.*)$/.exec(current)
        if (match === null) break
        items.push(parseInline(match[1] ?? ''))
        index += 1
      }
      blocks.push({ type: 'list', ordered: isOrdered, items })
      continue
    }

    paragraph.push(line)
    index += 1
  }

  flushParagraph()
  return blocks
}

/** All citation refs mentioned in an answer body, in first-appearance order. */
export function refsInText(source: string): string[] {
  const refs: string[] = []
  for (const match of source.matchAll(/\[(c\d+)\]/gi)) {
    const ref = (match[1] ?? '').toLowerCase()
    if (!refs.includes(ref)) refs.push(ref)
  }
  return refs
}
