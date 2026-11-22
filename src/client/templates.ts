/**
 * Quick prompt templates.
 *
 * A side question is usually one of a few shapes ("explain this", "what could go
 * wrong", "write tests"). Templates insert a well-formed question into the
 * composer so the user can edit before sending — they are never sent directly.
 */

export interface PromptTemplate {
  id: string
  label: string
  text: string
  /** Shown in the picker to explain when the template is useful. */
  hint: string
}

export const PROMPT_TEMPLATES: PromptTemplate[] = [
  { id: 'explain', label: '解释这段', text: '请逐段解释我选中的内容，指出关键概念、前提和结论。', hint: '适合选中一段代码或文字后使用' },
  { id: 'risks', label: '找风险', text: '请找出这段内容的风险、边界条件和可能被忽略的失败情形。', hint: '评审方案 / 设计 / 代码' },
  { id: 'tests', label: '列测试', text: '请为这段内容列出应覆盖的测试用例（正常、边界、异常）。', hint: '把结论变成可执行的检查项' },
  { id: 'clearer', label: '说清楚点', text: '请用更清晰、更简洁的方式重写这段内容，保留原有信息量。', hint: '改写表达' },
  { id: 'summary', label: '总结要点', text: '请把上面的对话总结成不超过 5 条要点。', hint: '长对话压缩' },
  { id: 'next', label: '下一步', text: '根据上面的对话，给出接下来最值得做的 3 个步骤。', hint: '决策卡住时' },
  { id: 'contradict', label: '矛盾检查', text: '上面的对话里有没有互相矛盾或前后不一致的地方？', hint: '审阅多轮结论' },
]

export function templateById(id: string): PromptTemplate | null {
  return PROMPT_TEMPLATES.find((template) => template.id === id) ?? null
}

/**
 * Merge a template into the current draft: keep what the user already typed and
 * append the template text as its own paragraph.
 */
export function applyTemplate(template: PromptTemplate, draft: string): string {
  const existing = draft.trim()
  if (existing.length === 0) return template.text
  return `${existing}\n\n${template.text}`
}

/** Order templates so selection-oriented ones come first when text is selected. */
export function orderedTemplates(hasSelection: boolean): PromptTemplate[] {
  if (!hasSelection) return [...PROMPT_TEMPLATES]
  const first = new Set(['explain', 'risks'])
  return [...PROMPT_TEMPLATES.filter((t) => first.has(t.id)), ...PROMPT_TEMPLATES.filter((t) => !first.has(t.id))]
}
