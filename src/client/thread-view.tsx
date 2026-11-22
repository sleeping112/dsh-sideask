/**
 * The side thread: message list, streaming answer, citations, composer.
 *
 * Rendering is deliberately plain React over the parsed Markdown AST: no HTML
 * injection anywhere (`dangerouslySetInnerHTML` never appears in this file), so a
 * model answer cannot execute markup. Citation markers become buttons bound to
 * the citation list returned by the host.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { Citation, SideAskError, ThreadMessage } from '../shared/contract.js'
import { markdownBucket, parseMarkdown, type Block, type Inline } from './markdown.js'
import { getDraft } from './draft.js'
import { reveal, type LocatableRoot } from './jump.js'
import type { SideAskStore, UiState } from './store.js'
import { visibleMessages } from './store.js'
import type { ContextSource } from './context-source.js'
import { writeBack, type WritebackKind } from './writeback.js'
import type { ConversationService } from './types.js'

export interface ThreadViewProps {
  store: SideAskStore
  state: UiState
  conversation: ConversationService | undefined
  contextSource: ContextSource
  /** Open the `#` pin picker (owned by the window shell). */
  onOpenPins: () => void
  /** Open the model picker (owned by the window shell). */
  onOpenModels: () => void
}

// ------------------------------------------------------------------ markdown

function renderInline(inlines: Inline[], citations: Map<string, Citation>, onCite: (citation: Citation) => void): React.ReactNode[] {
  return inlines.map((inline, index) => {
    switch (inline.type) {
      case 'bold':
        return <strong key={index}>{inline.text}</strong>
      case 'code':
        return (
          <code className="sa-md-inline" key={index}>
            {inline.text}
          </code>
        )
      case 'citation': {
        const citation = citations.get(inline.ref)
        return (
          <button
            key={index}
            type="button"
            className="sa-cite"
            title={citation === undefined ? '该引用不在本次上下文中' : `${citation.messageId}｜${citation.excerpt}`}
            data-ref={inline.ref}
            onClick={() => {
              if (citation !== undefined) onCite(citation)
            }}
          >
            <span className="sa-cite-num">{inline.ref}</span>
          </button>
        )
      }
      default:
        return <span key={index}>{inline.text}</span>
    }
  })
}

function renderBlocks(blocks: Block[], citations: Map<string, Citation>, onCite: (citation: Citation) => void): React.ReactNode[] {
  return blocks.map((block, index) => {
    switch (block.type) {
      case 'code':
        return (
          <code className="sa-md-code" key={index} data-lang={block.lang ?? ''}>
            {block.text}
          </code>
        )
      case 'heading': {
        const Tag = (block.level === 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5') as 'h3' | 'h4' | 'h5'
        return (
          <Tag className="sa-md-h" key={index}>
            {renderInline(block.inlines, citations, onCite)}
          </Tag>
        )
      }
      case 'list': {
        const Tag = block.ordered ? 'ol' : 'ul'
        return (
          <Tag className="sa-md-list" key={index}>
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>{renderInline(item, citations, onCite)}</li>
            ))}
          </Tag>
        )
      }
      case 'quote':
        return (
          <div className="sa-md-quote" key={index}>
            {renderInline(block.inlines, citations, onCite)}
          </div>
        )
      default:
        return (
          <p className="sa-md-p" key={index}>
            {renderInline(block.inlines, citations, onCite)}
          </p>
        )
    }
  })
}

/** Answer body: Markdown AST plus a caret while streaming. */
function AnswerBody({
  text,
  citations,
  streaming,
  onCite,
}: {
  text: string
  citations: Citation[]
  streaming: boolean
  onCite: (citation: Citation) => void
}): React.ReactElement {
  // Re-parsing the whole answer on every token is O(n²) for long answers. The
  // memo key is a *bucket* (see markdownBucket), so streaming re-renders at most
  // once per STREAM_BUCKET_CHARS characters, and the settled text is parsed once
  // more from the authoritative value.
  const latest = useRef(text)
  latest.current = text
  const bucket = markdownBucket(text, streaming)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const blocks = useMemo(() => parseMarkdown(latest.current), [bucket])
  const citationMap = useMemo(() => new Map(citations.map((citation) => [citation.ref, citation])), [citations])
  return (
    <>
      {renderBlocks(blocks, citationMap, onCite)}
      {streaming ? <span className="sa-caret" aria-hidden="true" /> : null}
    </>
  )
}

// ------------------------------------------------------------------ actions

function errorText(error: SideAskError | null | undefined): string {
  if (error === null || error === undefined) return ''
  return `${error.code}：${error.message}`
}

const ACTION_LABELS: { kind: WritebackKind; label: string; title: string }[] = [
  { kind: 'copy', label: '复制', title: '复制到剪贴板' },
  { kind: 'quote', label: '插入引用块', title: '以 Markdown 引用块插入主对话输入框' },
  { kind: 'quote-with-note', label: '引用到主对话', title: '插入引用块并标注来源' },
  { kind: 'draft', label: '作为草稿', title: '替换主对话输入框内容' },
]

function MessageActions({
  store,
  text,
  conversation,
  contextSource,
  canRegenerate,
  onRegenerate,
  canFork,
  onFork,
}: {
  store: SideAskStore
  text: string
  conversation: ConversationService | undefined
  contextSource: ContextSource
  canRegenerate: boolean
  onRegenerate: () => void
  canFork: boolean
  onFork: () => void
}): React.ReactElement {
  const [busy, setBusy] = useState<WritebackKind | null>(null)
  const [handoffBusy, setHandoffBusy] = useState(false)
  const run = useCallback(
    async (kind: WritebackKind) => {
      setBusy(kind)
      try {
        const result = await writeBack(kind, text, {
          conversation,
          getSessionCtx: () => contextSource.sessionCtx,
        })
        if (result.ok) store.toast('ok', result.note ?? (result.via === 'clipboard' ? '已复制' : '已写入主对话输入框'))
        else store.toast('error', result.note ?? '写入失败')
      } finally {
        setBusy(null)
      }
    },
    [conversation, contextSource, store, text],
  )

  return (
    <div className="sa-actions">
      {canRegenerate ? (
        <button
          type="button"
          className="sa-chip"
          title="删掉这条回答并重新提问（只影响本侧线程）"
          disabled={busy !== null}
          onClick={onRegenerate}
        >
          重新生成
        </button>
      ) : null}
      {canFork ? (
        <button
          type="button"
          className="sa-chip"
          title="以这条回答为终点，复制出一个新的旁问线程继续聊"
          disabled={busy !== null}
          onClick={onFork}
        >
          分叉
        </button>
      ) : null}
      {text.length > 0 ? (
        <button
          type="button"
          className="sa-chip"
          title="把这条结论写成主对话输入框里的任务（不会自动发送）"
          disabled={handoffBusy}
          onClick={() => {
            setHandoffBusy(true)
            void store.handoff(text).finally(() => setHandoffBusy(false))
          }}
        >
          {handoffBusy ? '…' : '交给主对话'}
        </button>
      ) : null}
      {text.length > 0
        ? ACTION_LABELS.map((action) => (
            <button
              key={action.kind}
              type="button"
              className="sa-chip"
              title={action.title}
              disabled={busy !== null}
              onClick={() => void run(action.kind)}
            >
              {busy === action.kind ? '…' : action.label}
            </button>
          ))
        : null}
    </div>
  )
}

// ------------------------------------------------------------------- thread

function MessageRow({
  message,
  store,
  state,
  conversation,
  contextSource,
  streaming,
  suppressError,
  onCite,
  canRegenerate,
  onRegenerate,
  canFork,
  onFork,
}: {
  message: ThreadMessage
  store: SideAskStore
  state: UiState
  conversation: ConversationService | undefined
  contextSource: ContextSource
  streaming: boolean
  /** The live ErrorState card already explains this failure. */
  suppressError: boolean
  onCite: (citation: Citation) => void
  canRegenerate: boolean
  onRegenerate: () => void
  canFork: boolean
  onFork: () => void
}): React.ReactElement {
  const isUser = message.role === 'user'
  return (
    <div className={isUser ? 'sa-msg sa-msg-user' : 'sa-msg sa-msg-assistant'}>
      <div className="sa-bubble">
        <AnswerBody text={message.text} citations={message.citations ?? []} streaming={streaming} onCite={onCite} />
        {!suppressError && message.error !== null && message.error !== undefined ? (
          <div className="sa-error-code" style={{ marginTop: 4 }}>
            {errorText(message.error)}
          </div>
        ) : null}
      </div>
      {!isUser && !streaming && (message.text.length > 0 || canRegenerate) ? (
        <MessageActions
          store={store}
          text={message.text}
          conversation={conversation}
          contextSource={contextSource}
          canRegenerate={canRegenerate}
          onRegenerate={onRegenerate}
          canFork={canFork}
          onFork={onFork}
        />
      ) : null}
      {!isUser && (message.citations ?? []).length > 0 ? (
        <div className="sa-actions">
          {(message.citations ?? []).map((citation) => (
            <button
              key={citation.ref}
              type="button"
              className="sa-chip"
              title={`${citation.messageId}｜${citation.excerpt}（点击定位主对话原文）`}
              data-message-id={citation.messageId}
              onClick={() => onCite(citation)}
            >
              引用 {citation.ref}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function EmptyState({ store, state }: { store: SideAskStore; state: UiState }): React.ReactElement {
  const suggestions = state.selection !== null
    ? ['解释我选中的这段内容', '这段有没有潜在问题？', '给它写一条更清晰的版本']
    : ['用一句话总结上面的对话', '上面有没有自相矛盾的地方？', '下一步最该做什么？']
  return (
    <div className="sa-empty" data-testid="sideask-empty">
      <div>
        {state.sessionId === null
          ? '还没有绑定当前对话：仍可直接提问，或在主对话里选中文字后点「旁问」。'
          : '在这个小窗里问吧：不会打断也不会改写你的主对话。'}
      </div>
      <div className="sa-suggest">
        {suggestions.map((suggestion) => (
          <button key={suggestion} type="button" onClick={() => void store.send(suggestion)}>
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  )
}

function ErrorState({ store, state }: { store: SideAskStore; state: UiState }): React.ReactElement | null {
  const error = state.answer.error
  if (error === null) return null
  return (
    <div className="sa-error" data-testid="sideask-error">
      <div className="sa-error-code">{error.code}</div>
      <div>{error.message}</div>
      <div className="sa-error-actions">
        {error.retryable ? (
          <button type="button" className="sa-btn sa-btn-primary" onClick={() => void store.retry()}>
            重试
          </button>
        ) : null}
        {error.degradableToQuestionOnly ? (
          <button type="button" className="sa-btn" onClick={() => void store.retryWithoutContext()}>
            仅用问题回答
          </button>
        ) : null}
        <button type="button" className="sa-btn" onClick={() => store.stop()}>
          停止
        </button>
      </div>
    </div>
  )
}

function Composer({
  store,
  state,
  onOpenPins,
  onOpenModels,
}: {
  store: SideAskStore
  state: UiState
  onOpenPins: () => void
  onOpenModels: () => void
}): React.ReactElement {
  // The draft lives in the store, keyed by thread id, so switching threads keeps
  // each thread's own draft (and it survives a page reload via localStorage).
  const draft = getDraft(state.drafts, state.thread?.id ?? null)
  const setDraft = useCallback((text: string): void => store.setComposerDraft(text), [store])
  const textarea = useRef<HTMLTextAreaElement | null>(null)
  const streaming = state.answer.status === 'streaming'
  const tokens = state.contextDetails?.stats.usedTokens ?? 0
  const budget = state.contextDetails?.stats.budgetTokens ?? state.settings.contextBudgetTokens

  useLayoutEffect(() => {
    const element = textarea.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(132, element.scrollHeight)}px`
  }, [draft])

  const submit = useCallback(() => {
    const text = draft.trim()
    if (text.length === 0 || streaming) return
    setDraft('')
    void store.send(text)
  }, [draft, store, streaming])

  return (
    <div className="sa-composer">
      <div className="sa-toolbar">
        <label className="sa-toggle" title="把当前主对话的最近消息带进上下文（只读）">
          <input
            type="checkbox"
            checked={state.contextOn}
            onChange={(event) => store.setContextOn(event.target.checked)}
          />
          <span>带上上下文</span>
        </label>
        <span
          className="sa-token"
          data-over={tokens > budget}
          title="点开查看上下文详情"
          onClick={() => store.toast('info', '点标题栏的「详情」查看上下文统计')}
        >
          {state.extracting ? '整理上下文…' : `${tokens}/${budget} token`}
        </span>
      </div>
      {state.pins.length > 0 ? (
        <div className="sa-pins" data-testid="sideask-pins">
          {state.pins.map((pin) => (
            <button
              key={pin.messageId}
              type="button"
              className="sa-chip"
              data-kind="pin"
              title={`${pin.messageId}｜${pin.text.slice(0, 80)}（点击取消钉住）`}
              onClick={() => store.togglePin({ id: pin.messageId, role: pin.role, text: pin.text })}
            >
              # {pin.role === 'assistant' ? 'AI' : '我'} · {pin.text.replace(/\s+/g, ' ').trim().slice(0, 18)}
            </button>
          ))}
          <button type="button" className="sa-chip" onClick={() => store.clearPins()}>
            清空
          </button>
        </div>
      ) : null}
      <div className="sa-ctxline">
        <button
          type="button"
          className="sa-chip"
          data-testid="sideask-pin-button"
          onClick={onOpenPins}
          title="钉住主对话中的消息，作为本次提问的高优先级上下文"
        >
          ＃ 钉住
        </button>
        <button
          type="button"
          className="sa-chip"
          data-testid="sideask-model-button"
          onClick={onOpenModels}
          title="选择旁问使用的模型（只影响旁问）"
        >
          模型：{state.modelOverride === null ? '跟随主对话' : state.modelOverride.model}
        </button>
      </div>
      <div className="sa-inputrow">
        <textarea
          ref={textarea}
          className="sa-input"
          value={draft}
          placeholder={streaming ? '正在回答…' : '问点什么（Enter 发送，Shift+Enter 换行）'}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        {streaming ? (
          <button type="button" className="sa-btn sa-send" onClick={() => store.stop()}>
            停止
          </button>
        ) : (
          <button type="button" className="sa-btn sa-btn-primary sa-send" onClick={submit} disabled={draft.trim().length === 0}>
            发送
          </button>
        )}
      </div>
      <div className="sa-hint">只读主对话 · 只有点动作按钮才写回</div>
    </div>
  )
}

export function ThreadView({ store, state, conversation, contextSource, onOpenPins, onOpenModels }: ThreadViewProps): React.ReactElement {
  const messages = visibleMessages(state)
  const scroller = useRef<HTMLDivElement | null>(null)
  const streaming = state.answer.status === 'streaming'

  /**
   * Jump to the cited message in the main conversation. The host transcript has
   * no stable message ids, so `reveal` falls back to matching the citation
   * excerpt; when even that fails we show the excerpt instead of failing silently.
   */
  const onCite = useCallback(
    (citation: Citation) => {
      let outcome: 'message-id' | 'excerpt' | 'not-found' = 'not-found'
      try {
        outcome = reveal(document as unknown as LocatableRoot, {
          messageId: citation.messageId,
          excerpt: citation.excerpt,
        })
      } catch {
        outcome = 'not-found'
      }
      if (outcome === 'not-found') {
        store.toast('info', `无法定位原文，摘录：${citation.excerpt.slice(0, 80)}`)
      }
    },
    [store],
  )

  // The live ErrorState card is the single error surface while a failure is the
  // current answer; the matching bubble must not repeat the same text.
  const lastAssistantId = (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === 'assistant') return messages[index]?.id ?? null
    }
    return null
  })()
  const errorCardVisible = state.answer.error !== null

  // Keep the newest content in view while streaming, but never fight a user
  // who scrolled up to read: only auto-scroll when already near the bottom.
  useEffect(() => {
    const element = scroller.current
    if (element === null) return
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80
    if (nearBottom) element.scrollTop = element.scrollHeight
  }, [messages.length, streaming, state.answer.text])

  return (
    <>
      <div className="sa-thread" ref={scroller} data-testid="sideask-thread">
        {messages.length === 0 && !streaming ? <EmptyState store={store} state={state} /> : null}
        {messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            store={store}
            state={state}
            conversation={conversation}
            contextSource={contextSource}
            streaming={streaming && message.id.startsWith('stream-')}
            suppressError={errorCardVisible && message.id === lastAssistantId}
            onCite={onCite}
            canRegenerate={message.id === lastAssistantId && !streaming && state.answer.status !== 'streaming'}
            onRegenerate={() => void store.regenerate(message)}
            canFork={message.role === 'assistant' && message.text.length > 0 && state.thread !== null && state.thread.messages.length > 0}
            onFork={() => void store.forkThread(message.id)}
          />
        ))}
        <ErrorState store={store} state={state} />
      </div>
      <Composer store={store} state={state} onOpenPins={onOpenPins} onOpenModels={onOpenModels} />
    </>
  )
}
