/**
 * Context details popover.
 *
 * The spec requires transparency about what the answer saw: how much of the
 * budget was used, how many messages were de-duplicated, how many secrets were
 * masked, and which degradations were applied. This panel is that disclosure —
 * it is the difference between "trust me" and "here is exactly what was read".
 */

import type { ContextSource } from './context-source.js'
import type { SideAskStore, UiState } from './store.js'

export interface ContextPanelProps {
  store: SideAskStore
  state: UiState
  contextSource: ContextSource
  onClose: () => void
}

const REASON_TEXT: Record<string, string> = {
  ok: '已读取当前对话',
  disabled: '上下文读取已关闭',
  'no-session': '未绑定主对话',
  'no-feed': '读不到会话事件流',
  timeout: '读取超时，已降级为仅回答',
  aborted: '读取被取消',
  error: '读取出错，已降级为仅回答',
}

const DEGRADATION_TEXT: Record<string, string> = {
  'summary-dropped-for-recent': '丢弃了历史摘要，优先保留最近的对话',
  'summary-pending': '历史摘要正在后台生成，本轮先用最近消息',
  'recent-trimmed': '最近消息被预算截断',
  'pins-trimmed': '钉住的消息超出预算，部分被丢弃',
  'question-only': '没有可用上下文，仅基于问题回答',
  'context-disabled': '上下文读取被关闭',
  'extraction-failed': '上下文提取失败',
  'over-budget-trimmed': '为防止超预算做了额外裁剪',
  'preamble-dropped': '为节省预算省略了部分说明',
}

function excerpt(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

export function ContextPanel({ store, state, contextSource, onClose }: ContextPanelProps): React.ReactElement {
  const details = state.contextDetails
  const stats = details?.stats
  const cache = contextSource.stats()
  const provider = state.bootstrap?.model

  return (
    <div className="sa-panel-detail" data-testid="sideask-context-details">
      <div className="sa-detail-title">
        上下文详情
        <button type="button" className="sa-iconbtn" style={{ float: 'right' }} onClick={onClose} title="关闭">
          ×
        </button>
      </div>

      <div className="sa-kv">
        <span>读取状态</span>
        <b>
          {state.extractionReason === null
            ? '尚未读取（发送第一个问题后显示统计）'
            : REASON_TEXT[state.extractionReason] ?? state.extractionReason}
        </b>
      </div>
      <div className="sa-kv">
        <span>模型</span>
        <b>{provider === null || provider === undefined ? '宿主默认' : `${provider.provider}/${provider.model}`}</b>
      </div>
      {stats === undefined ? null : (
        <>
          <div className="sa-kv">
            <span>预算 / 已用</span>
            <b>
              {stats.usedTokens} / {stats.budgetTokens} token
            </b>
          </div>
          <div className="sa-kv">
            <span>条目（引用编号）</span>
            <b>{details?.items.length ?? 0} 条</b>
          </div>
          <div className="sa-kv">
            <span>考虑过的消息</span>
            <b>{stats.consideredCount}</b>
          </div>
          <div className="sa-kv">
            <span>去重 / 脱敏</span>
            <b>
              {stats.dedupedCount} / {stats.redactedCount}
            </b>
          </div>
          <div className="sa-kv">
            <span>截断（选中/最近/摘要）</span>
            <b>
              {stats.truncations.selection} / {stats.truncations.recent} / {stats.truncations.summary}
            </b>
          </div>
          <div className="sa-kv">
            <span>钉住 / 选中</span>
            <b>
              {stats.pinnedTokens} / {stats.selectionTokens} token
            </b>
          </div>
          <div className="sa-kv">
            <span>历史摘要</span>
            <b>
              {stats.summaryTokens > 0 ? `${stats.summaryTokens} token` : '无（窗口内消息已覆盖）'}
            </b>
          </div>
        </>
      )}

      {details !== null && details.items.length > 0 ? (
        <div className="sa-ctx-items">
          <div className="sa-detail-sub">将发送的上下文（取消勾选即排除）</div>
          {details.items.map((item) => {
            const excluded = state.excludedMessageIds.includes(item.messageId)
            return (
              <label key={item.ref} className="sa-ctx-item" data-excluded={excluded}>
                <input
                  type="checkbox"
                  checked={!excluded}
                  onChange={() => store.toggleExclusion(item.messageId)}
                />
                <span className="sa-ctx-ref">{item.ref}</span>
                <span className="sa-ctx-src">
                  {item.source === 'selection' ? '选中' : item.source === 'pinned' ? '钉住' : item.role === 'assistant' ? 'AI' : '我'}
                </span>
                <span className="sa-ctx-text">{excerpt(item.text, 90)}</span>
              </label>
            )
          })}
          {state.excludedMessageIds.length > 0 ? (
            <button type="button" className="sa-chip" onClick={() => store.clearExclusions()}>
              恢复全部（{state.excludedMessageIds.length} 条已排除）
            </button>
          ) : null}
        </div>
      ) : null}

      {details === null ? (
        <div className="sa-actions" style={{ marginTop: 8 }}>
          <button type="button" className="sa-chip" onClick={() => void store.previewContext()} disabled={state.extracting}>
            {state.extracting ? '读取中…' : '读取当前上下文'}
          </button>
        </div>
      ) : null}
      <div className="sa-kv">
        <span>投影缓存命中 / 未命中</span>
        <b>
          {cache.hits} / {cache.misses}
        </b>
      </div>
      {stats !== undefined && stats.degradations.length > 0 ? (
        <div className="sa-degr">
          {stats.degradations.map((degradation) => (
            <span key={degradation}>· {DEGRADATION_TEXT[degradation] ?? degradation}</span>
          ))}
        </div>
      ) : null}
      <div className="sa-actions" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="sa-chip"
          onClick={() => store.setContextOn(!state.contextOn)}
          title="快速切换本轮是否携带上下文"
        >
          {state.contextOn ? '本轮：带上下文' : '本轮：按问题回答'}
        </button>
        <button
          type="button"
          className="sa-chip"
          onClick={() => {
            void store.clearAllHistory()
            onClose()
          }}
          title="删除插件自己保存的全部旁问历史（不影响主对话）"
        >
          清空全部历史
        </button>
      </div>
      <div className="sa-hint" style={{ marginTop: 6 }}>
        读取范围仅限当前主对话的可见消息；永不写入主对话。
      </div>
    </div>
  )
}
