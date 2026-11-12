/**
 * Prompt assembly.
 *
 * Kept in `shared/` (not in the host half) because it is pure string logic and
 * is covered by unit tests: the prompt *is* the privacy boundary, so its exact
 * shape must be reviewable and assertable.
 *
 * Two rules the prompt must enforce on the model:
 * - answer only from the supplied context + the user's question;
 * - append the `⟦refs: …⟧` citation block.
 *
 * Multi-turn note: we send ONE user message that embeds the prior side-thread
 * turns as a labelled transcript. That keeps the host call to the provider
 * neutral API surface (`GenerateOptions.messages` with request-only user
 * inputs) instead of depending on synthesising durable assistant messages,
 * which would require session identity we deliberately do not create.
 */

import type { ContextBundle, ThreadMessage } from './contract.js'
import { excerptOf } from './citations.js'

export interface PromptInput {
  question: string
  bundle: ContextBundle | null
  history: ThreadMessage[]
  requireCitations: boolean
  /** Max prior side-thread turns embedded into the prompt. */
  historyTurns?: number
  /** UI language hint; `auto` keeps the user's language. */
  locale?: string
}

export interface Prompt {
  system: string
  user: string
}

const MAX_HISTORY_TURNS = 8

const ROLE_LABEL: Record<string, string> = {
  user: '用户',
  assistant: '助手',
  system: '系统',
  tool: '工具',
  developer: '开发者',
}

export function buildSystemPrompt(requireCitations: boolean): string {
  const citationRule = requireCitations
    ? [
        '引用规则：',
        '- 上下文条目带有编号（如 c1、c2）。',
        '- 回答结束时，必须另起一行输出引用块：⟦refs: c1, c3⟧（只列你实际使用的编号，用英文逗号分隔）。',
        '- 没有使用任何上下文条目时，输出 ⟦refs:⟧。',
        '- 不要在正文里编造编号。',
      ].join('\n')
    : '引用规则：本次不需要输出引用块。'

  return [
    '你是 DSH 主对话旁的「旁问」助手。',
    '',
    '你的职责：',
    '- 基于用户提供的、来自主对话的只读上下文，回答用户的补充问题。',
    '- 回答要简洁、直接、可执行；默认不超过 12 行，除非用户要求展开。',
    '- 上下文不足以回答时，明确说「上下文里没有」，再给出你需要的信息；不要臆测。',
    '- 你无法修改主对话，也不要声称已经修改。',
    '- 不要输出你的推理过程，直接给结论与必要的依据。',
    '',
    citationRule,
    '',
    '输出语言：与用户提问语言一致（默认中文）。',
  ].join('\n')
}

function renderItems(bundle: ContextBundle): string {
  const lines: string[] = []
  for (const item of bundle.items) {
    const origin = item.source === 'selection' ? '用户选中' : ROLE_LABEL[item.role] ?? item.role
    const truncated = item.truncated ? '｜已截断' : ''
    const messageRef = item.messageId.startsWith('selection:') ? '' : `｜msg:${item.messageId}`
    lines.push(`[${item.ref}｜${origin}${messageRef}${truncated}]`)
    lines.push(item.text)
    lines.push('')
  }
  return lines.join('\n').trim()
}

function renderHistory(history: ThreadMessage[], limit: number): string {
  const recent = history.filter((message) => message.role === 'user' || message.role === 'assistant').slice(-limit)
  if (recent.length === 0) return ''
  const lines: string[] = []
  for (const message of recent) {
    const label = message.role === 'user' ? 'Q' : 'A'
    lines.push(`${label}: ${excerptOf(message.text, 600)}`)
  }
  return lines.join('\n')
}

/**
 * Assemble the single user message. Sections are omitted when empty so the
 * prompt stays small for question-only mode.
 */
export function buildPrompt(input: PromptInput): Prompt {
  const system = buildSystemPrompt(input.requireCitations)
  const bundle = input.bundle
  const parts: string[] = []

  const history = renderHistory(input.history, input.historyTurns ?? MAX_HISTORY_TURNS)
  if (history.length > 0) {
    parts.push('## 之前的旁问对话（仅用于理解你的追问所指）')
    parts.push(history)
    parts.push('')
  }

  if (bundle !== null && bundle.summary !== null && bundle.summary.trim().length > 0) {
    parts.push('## 主对话历史摘要（更早的消息）')
    parts.push(bundle.summary)
    parts.push('')
  }

  const items = bundle === null ? '' : renderItems(bundle)
  if (items.length > 0) {
    parts.push('## 主对话上下文（只读，按编号引用）')
    parts.push(items)
    parts.push('')
  }

  if (items.length === 0 && (bundle === null || (bundle.summary ?? '').length === 0)) {
    parts.push('## 主对话上下文')
    parts.push('（本次没有可用的上下文，请仅基于当前问题回答，并说明这是通用回答。）')
    parts.push('')
  }

  parts.push('## 当前问题')
  parts.push(input.question.trim())

  return { system, user: parts.join('\n').trim() }
}

/**
 * Prompt for the optional rolling summary of history that fell out of the
 * recent window (P1 feature; the planner keeps the interface so the extractor
 * can be upgraded without touching call sites).
 */
export function buildSummaryPrompt(messages: { role: string; text: string }[]): Prompt {
  const system = [
    '你是对话压缩器。把给定的历史消息压缩成一段中文摘要。',
    '要求：保留任务目标、关键结论、已确认的事实、未解决的疑问、以及用户明确的偏好与约束。',
    '不要保留寒暄、重复内容、工具调用的中间过程。',
    '输出纯文本，不超过 200 字，不要加标题或列表符号。',
  ].join('\n')
  const body = messages
    .map((message) => `${ROLE_LABEL[message.role] ?? message.role}: ${message.text}`)
    .join('\n\n')
  return { system, user: body }
}
