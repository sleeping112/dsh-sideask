/**
 * Quick template picker. Clicking a template merges it into the current draft
 * (never sends) so the user keeps control of the final wording.
 */

import { applyTemplate, orderedTemplates } from './templates.js'
import type { SideAskStore, UiState } from './store.js'

export interface TemplatesPanelProps {
  store: SideAskStore
  state: UiState
  onClose: () => void
}

export function TemplatesPanel({ store, state, onClose }: TemplatesPanelProps): React.ReactElement {
  const templates = orderedTemplates(state.selection !== null)
  return (
    <div className="sa-menu" data-testid="sideask-templates-panel">
      <div className="sa-menu-head">
        <span>快捷模板</span>
        <span className="sa-menu-count">写入输入框</span>
      </div>
      <div className="sa-menu-list">
        {templates.map((template) => (
          <button
            key={template.id}
            type="button"
            className="sa-menu-item"
            title={template.hint}
            onClick={() => {
              store.setComposerDraft(applyTemplate(template, store.draftForCurrentThread()))
              onClose()
            }}
          >
            <span className="sa-menu-title">{template.label}</span>
            <span className="sa-menu-meta">{template.hint}</span>
          </button>
        ))}
      </div>
      <div className="sa-hint" style={{ marginTop: 6 }}>
        只写入输入框，不会自动发送；可在「详」里继续调整上下文。
      </div>
    </div>
  )
}
