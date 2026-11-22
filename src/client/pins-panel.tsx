/**
 * `#` pin picker: list the newest main-conversation messages and pin the ones the
 * answer should prioritise. Pins are explicit intent — they rank above the
 * automatic recent window but below a live selection, and they are consumed by
 * the next question.
 */

import type { SideAskStore, UiState } from './store.js'

export interface PinsPanelProps {
  store: SideAskStore
  state: UiState
  onClose: () => void
}

function excerpt(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

export function PinsPanel({ store, state, onClose }: PinsPanelProps): React.ReactElement {
  // Newest first: those are usually the ones a follow-up question is about.
  const messages = store.mainMessages(20).slice().reverse()
  return (
    <div className="sa-menu" data-testid="sideask-pins-panel">
      <div className="sa-menu-head">
        <span>钉住上下文（#）</span>
        <span className="sa-menu-count">{state.pins.length}</span>
      </div>
      <div className="sa-menu-list">
        {messages.length === 0 ? (
          <div className="sa-menu-empty">主对话里还没有可钉住的消息（或尚未绑定会话）。</div>
        ) : (
          messages.map((message) => {
            const pinned = store.isPinned(message.id)
            return (
              <button
                key={message.id}
                type="button"
                className="sa-menu-item"
                data-active={pinned}
                title={message.id}
                onClick={() => store.togglePin(message)}
              >
                <span className="sa-menu-title">
                  {message.role === 'assistant' ? 'AI' : '我'}：{excerpt(message.text, 56)}
                </span>
                <span className="sa-menu-meta">{pinned ? '已钉住 · 点击取消' : '点击钉住'}</span>
              </button>
            )
          })
        )}
      </div>
      <div className="sa-menu-actions">
        <button type="button" className="sa-chip" onClick={() => store.clearPins()} disabled={state.pins.length === 0}>
          清空钉住
        </button>
        <button type="button" className="sa-chip" onClick={onClose}>
          完成
        </button>
      </div>
      <div className="sa-hint" style={{ marginTop: 6 }}>
        钉住的消息会作为高优先级上下文（引用编号 c1 起），仅本次提问有效。
      </div>
    </div>
  )
}
