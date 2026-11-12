/**
 * Sensitive-data masking.
 *
 * Two independent layers use this module:
 * 1. the browser, before anything leaves the page (minimisation), and
 * 2. the host, before anything reaches a model provider (defence in depth).
 *
 * The masks are intentionally *lossy and local*: the original value is never
 * forwarded, and we never try to be clever about partial credentials. False
 * positives are acceptable (a masked word still reads as redacted); false
 * negatives on credential-shaped strings are not.
 *
 * Platform-free by design: the caller supplies the home directory / username
 * to mask, so the same module runs in the browser bundle and in Node.
 */

export interface RedactOptions {
  /** Extra user-supplied regular expressions (invalid ones are ignored). */
  customPatterns?: string[]
  /** Absolute home directory to replace with a placeholder. */
  homeDir?: string
  /** OS user name to replace when it appears inside a path. */
  username?: string
}

export interface RedactCount {
  kind: string
  count: number
}

export interface RedactionResult {
  text: string
  /** Masks applied per kind; empty when the text was clean. */
  counts: RedactCount[]
  /** Total masks applied. */
  total: number
}

interface Rule {
  kind: string
  pattern: RegExp
  replace: (match: string, groups: string[]) => string
}

function mask(kind: string, length: number): string {
  const width = Math.min(8, Math.max(3, Math.round(length / 6)))
  return `«${kind}:${'*'.repeat(width)}»`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildRules(options: RedactOptions): Rule[] {
  const rules: Rule[] = [
    {
      kind: 'pem',
      pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      replace: (m) => mask('私钥', m.length),
    },
    {
      kind: 'env-assignment',
      // FOO_KEY=..., FOO_TOKEN: ..., FOO_SECRET=..., PASSWORD=...
      pattern:
        /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*("([^"\n]{4,})"|'([^'\n]{4,})'|([^\s,;]{4,}))/g,
      replace: (m, groups) => {
        const name = groups[0] ?? 'VALUE'
        return `${name}=${mask('凭据', Math.max(0, m.length - name.length))}`
      },
    },
    {
      kind: 'api-key',
      pattern: /\b(?:sk|ak|rk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g,
      replace: (m) => mask('密钥', m.length),
    },
    {
      kind: 'jwt',
      pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
      replace: (m) => mask('JWT', m.length),
    },
    {
      kind: 'bearer',
      pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g,
      replace: (m) => mask('令牌', m.length),
    },
    {
      kind: 'email',
      pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      replace: (m) => mask('邮箱', m.length),
    },
    {
      kind: 'phone-cn',
      pattern: /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g,
      replace: (m) => mask('手机号', m.length),
    },
    {
      kind: 'card',
      pattern: /(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/g,
      replace: (m) => mask('卡号', m.length),
    },
    {
      kind: 'ipv4',
      pattern:
        /\b(?!127\.0\.0\.1|0\.0\.0\.0|255\.255\.255\.255)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-4]\d|25[0-5]|1?\d?\d)\b/g,
      replace: (m) => mask('IP', m.length),
    },
  ]

  const home = options.homeDir?.trim()
  if (home !== undefined && home.length > 3) {
    rules.push({
      kind: 'home-path',
      pattern: new RegExp(escapeRegExp(home), 'gi'),
      replace: () => '«用户目录»',
    })
  }
  const user = options.username?.trim()
  if (user !== undefined && user.length > 2) {
    rules.push({
      kind: 'username',
      pattern: new RegExp(`(?<=[\\\\/](?:[^\\\\/\\s]{0,32}[\\\\/]){0,3})${escapeRegExp(user)}(?=[\\\\/])`, 'gi'),
      replace: () => '«用户名»',
    })
  }

  for (const source of options.customPatterns ?? []) {
    const trimmed = source.trim()
    if (trimmed.length === 0 || trimmed.length > 512) continue
    try {
      rules.push({
        kind: 'custom',
        pattern: new RegExp(trimmed, 'g'),
        replace: (m) => mask('自定义', m.length),
      })
    } catch {
      // An invalid user regex must never break the answer path.
    }
  }
  return rules
}

/**
 * Mask sensitive spans. Safe to run twice (browser then host): the produced
 * masks do not match the rules again, so the second pass is a no-op.
 */
export function redact(text: string, options: RedactOptions = {}): RedactionResult {
  if (text.length === 0) return { text: '', counts: [], total: 0 }
  const counts = new Map<string, number>()
  let output = text

  for (const rule of buildRules(options)) {
    output = output.replace(rule.pattern, (...args: unknown[]) => {
      const match = typeof args[0] === 'string' ? args[0] : ''
      const groups: string[] = []
      // The trailing two args are offset and the full input string.
      for (let index = 1; index < args.length - 2; index += 1) {
        const value = args[index]
        groups.push(typeof value === 'string' ? value : '')
      }
      const replaced = rule.replace(match, groups)
      if (replaced !== match) counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1)
      return replaced
    })
  }

  let total = 0
  const list: RedactCount[] = []
  for (const [kind, count] of counts) {
    total += count
    list.push({ kind, count })
  }
  return { text: output, counts: list, total }
}

/** Convenience wrapper for callers that only need the masked string. */
export function redactText(text: string, options: RedactOptions = {}): string {
  return redact(text, options).text
}
