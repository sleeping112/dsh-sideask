/**
 * Thread menu: list / create / switch / delete the side threads.
 *
 * The host owns thread history; this menu is the UI for it. Kept as a small
 * popover anchored under the header button so it never competes with the message
 * list for space, and so a mis-click cannot destroy a thread (delete is explicit
 * and only for the current one).
 */

import type { SideAskStore, UiState } from './store.js'

export interface ThreadMenuProps {
  store: SideAskStore
  state: UiState
  onClose: () => void
}

function relativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp
  if (!Number.isFinite(delta) || delta < 0) return ''
  const minute = 60_000
  if (delta < minute) return '刚刚'
  if (delta < 60 * minute) return `${Math.floor(delta / minute)} 分钟前`
  if (delta < 24 * 60 * minute) return `${Math.floor(delta / (60 * minute))} 小时前`
  return `${Math.floor(delta / (24 * 60 * minute))} 天前`
}

export function ThreadMenu({ store, state, onClose }: ThreadMenuProps): React.ReactElement {
  const currentId = state.thread?.id ?? null
  const threads = state.threads

  const run = (action: () => Promise<void>): void => {
    void action().finally(onClose)
  }

  return (
    <div className="sa-menu" data-testid="sideask-thread-menu">
      <div className="sa-menu-head">
        <span>旁问线程</span>
        <span className="sa-menu-count">{threads.length}</span>
      </div>

      <div className="sa-menu-list" data-testid="sideask-thread-list">
        {threads.length === 0 ? (
          <div className="sa-menu-empty">还没有线程，发一个问题就会创建。</div>
        ) : (
          threads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              className="sa-menu-item"
              data-active={thread.id === currentId}
              title={thread.id}
              onClick={() => run(() => store.selectThread(thread.id))}
            >
              <span className="sa-menu-title">{thread.title || '未命名线程'}</span>
              <span className="sa-menu-meta">
                {thread.messageCount} 条 · {relativeTime(thread.updatedAt)}
              </span>
            </button>
          ))
        )}
      </div>

      <div className="sa-menu-actions">
        <button
          type="button"
          className="sa-chip"
          onClick={() => run(() => store.newThread())}
          title="新建一个空的旁问线程"
        >
          ＋ 新建
        </button>
        <button
          type="button"
          className="sa-chip"
          disabled={currentId === null}
          onClick={() => run(() => store.deleteCurrentThread())}
          title="删除当前线程（不影响主对话）"
        >
          删除当前
        </button>
      </div>
    </div>
  )
}
