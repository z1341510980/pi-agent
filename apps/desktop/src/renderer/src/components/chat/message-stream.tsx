import { useEffect, useMemo, useRef } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Loader2, ArrowDown } from 'lucide-react'
import { EventType, type BaseEvent } from '@repo/protocol/events'
import type { ChatMessage, MessageSegment, ToolCallInfo, ToolResultDetails } from './types'
import {
  appendText,
  appendThinking,
  appendToolCall,
  closeThinking,
  createAssistantMessage,
  nextSegmentId,
  segmentsToText,
  updateToolCall
} from './types'
import { MessageBubble } from './message-bubble'
import { StreamingIndicator } from './streaming-indicator'
import { ErrorCard } from './error-card'
import { EmptyState } from './empty-state'
import { PermissionRequestCard } from './permission-request-card'
import { useAutoScroll } from '@/hooks/use-auto-scroll'
import { cn } from '@/lib/utils'
import type { FilePreviewState } from '@/stores/ui-store'
import type { ConfirmationRequestPayload } from '@/hooks/use-websocket'

/**
 * 消息流状态：管理 ChatMessage 列表 + 当前流式 runId
 */
export interface MessageStreamState {
  messages: ChatMessage[]
  /** 当前流式 run 的 runId（用于关联事件到助手消息） */
  activeRunId: string | null
  /** 流式错误（RUN_ERROR） */
  streamError: string | null
}

/**
 * 将 AG-UI 事件应用到消息流状态，返回新状态。
 *
 * ## 分段模型
 *
 * 所有内容都进 `msg.segments`，顺序即事件到达顺序。文本 delta 追加到末尾的文本
 * 分段；一旦中间插入了工具分段，后续文本会自然落到新的文本分段 —— 这就是
 * 「文本 → 工具 → 文本」交错的实现。
 *
 * ## 工具身份
 *
 * 优先用后端 `PI_TOOL_CALL_START` / `PI_TOOL_CALL_END` 带来的**真实 toolCallId**。
 * `STEP_STARTED` / `STEP_FINISHED` 的 AG-UI 形状里只有 `stepName`，装不下 id，
 * 只能按「同名 + running」回配，同名并发必然错配。所以它们退化为兜底路径：
 * 只有在没收到对应 CUSTOM 事件时才建分段 / 收尾。
 */
export function applyEvent(state: MessageStreamState, event: BaseEvent): MessageStreamState {
  const e = event as Record<string, unknown>
  const type = e.type as string

  switch (type) {
    case EventType.RUN_STARTED: {
      const runId = e.runId as string
      const assistantMsg = createAssistantMessage(runId)
      return {
        ...state,
        activeRunId: runId,
        streamError: null,
        messages: [...state.messages, assistantMsg]
      }
    }

    case EventType.TEXT_MESSAGE_START:
      // 分段模型下无需预建：第一个 delta 到达时自然会开一个文本分段
      return state

    case EventType.TEXT_MESSAGE_CONTENT: {
      const delta = (e.delta as string) ?? ''
      if (!delta) return state
      return updateActiveAssistant(state, (msg) =>
        withSegments(msg, appendText(msg.segments, delta))
      )
    }

    case EventType.TEXT_MESSAGE_END:
      // content 由 withSegments 持续同步，这里无需再搬一次缓冲
      return state

    case EventType.THINKING_TEXT_MESSAGE_CONTENT: {
      const delta = (e.delta as string) ?? ''
      if (!delta) return state
      const now = Date.now()
      return updateActiveAssistant(state, (msg) =>
        withSegments(msg, appendThinking(msg.segments, delta, now))
      )
    }

    case EventType.REASONING_MESSAGE_CONTENT:
      // 与 THINKING_TEXT_MESSAGE_CONTENT 内容相同，跳过避免重复
      return state

    case EventType.THINKING_END:
    case EventType.REASONING_END: {
      const now = Date.now()
      return updateActiveAssistant(state, (msg) =>
        withSegments(msg, closeThinking(msg.segments, now))
      )
    }

    case EventType.STEP_STARTED: {
      const toolName = parseStepName(e.stepName)
      if (!toolName) return state
      return updateActiveAssistant(state, (msg) => {
        // 已由 PI_TOOL_CALL_START 建好分段时不重复建
        if (hasPendingToolCall(msg.segments, toolName)) return msg
        return withSegments(
          msg,
          appendToolCall(msg.segments, {
            // 没有真实 id 的兜底路径：标记出来，便于后续事件识别"这是猜的"
            toolCallId: `synthetic:${nextSegmentId('call')}`,
            toolName,
            status: 'running',
            startedAt: Date.now()
          })
        )
      })
    }

    case EventType.STEP_FINISHED: {
      const toolName = parseStepName(e.stepName)
      if (!toolName) return state
      return updateActiveAssistant(state, (msg) =>
        withSegments(
          msg,
          updateToolCall(
            msg.segments,
            (call) => call.toolName === toolName && call.status === 'running',
            (call) => ({ ...call, status: 'success', endedAt: Date.now() })
          )
        )
      )
    }

    case EventType.CUSTOM:
      return applyCustomEvent(state, e)

    case EventType.RUN_FINISHED: {
      const reason = (e as { reason?: string }).reason
      // abort 的 RUN_FINISHED 不改变消息状态（状态由 hook 管理）
      if (reason === 'aborted') {
        return { ...state, activeRunId: null }
      }
      const result = (e as { result?: string }).result
      return {
        ...state,
        activeRunId: null,
        messages: finishActiveAssistant(state, result)
      }
    }

    case EventType.RUN_ERROR: {
      const message = (e.message as string) ?? '未知错误'
      return {
        ...state,
        activeRunId: null,
        streamError: message,
        messages: errorActiveAssistant(state, message)
      }
    }

    default:
      return state
  }
}

/** CUSTOM 事件分派（工具生命周期与结果细节） */
function applyCustomEvent(
  state: MessageStreamState,
  e: Record<string, unknown>
): MessageStreamState {
  const name = (e.name as string) ?? ''

  switch (name) {
    /** 带真实 toolCallId 的工具开始 —— 权威路径 */
    case 'PI_TOOL_CALL_START': {
      const value = e.value as {
        toolCallId?: string
        toolName?: string
        args?: unknown
        startedAt?: number
      }
      const toolName = value?.toolName
      if (!toolName) return state
      const toolCallId = value.toolCallId
      if (!toolCallId) return state

      return updateActiveAssistant(state, (msg) => {
        // 事件重放 / 重复投递时不重复建分段
        if (msg.segments.some((s) => s.kind === 'tool' && s.call.toolCallId === toolCallId)) {
          return msg
        }
        // STEP_STARTED 已经建了一个 synthetic 分段时，改为认领它而不是再建一个
        const claimed = updateToolCall(
          msg.segments,
          (call) =>
            call.toolName === toolName &&
            call.status === 'running' &&
            call.toolCallId.startsWith('synthetic:'),
          (call) => ({ ...call, toolCallId, args: value.args ?? call.args })
        )
        if (claimed !== msg.segments) return withSegments(msg, claimed)

        return withSegments(
          msg,
          appendToolCall(msg.segments, {
            toolCallId,
            toolName,
            args: value.args,
            status: 'running',
            startedAt: value.startedAt ?? Date.now()
          })
        )
      })
    }

    /** 带真实 toolCallId 的工具结束 */
    case 'PI_TOOL_CALL_END': {
      const value = e.value as {
        toolCallId?: string
        toolName?: string
        isError?: boolean
        endedAt?: number
      }
      if (!value) return state
      return updateActiveAssistant(state, (msg) =>
        withSegments(
          msg,
          updateToolCall(
            msg.segments,
            (call) => matchToolCall(call, value.toolCallId, value.toolName, 'running'),
            (call) => ({
              ...call,
              status: value.isError ? 'error' : 'success',
              endedAt: value.endedAt ?? Date.now()
            })
          )
        )
      )
    }

    /** 参数与中间结果 */
    case 'PI_TOOL_EXECUTION_UPDATE': {
      const value = e.value as {
        toolCallId?: string
        toolName?: string
        args?: unknown
        partialResult?: unknown
      }
      if (!value) return state
      return updateActiveAssistant(state, (msg) =>
        withSegments(
          msg,
          updateToolCall(
            msg.segments,
            (call) => matchToolCall(call, value.toolCallId, value.toolName, 'running'),
            (call) => ({
              ...call,
              args: value.args ?? call.args,
              partialResult: value.partialResult ?? call.partialResult
            })
          )
        )
      )
    }

    /**
     * 结构化结果细节（diff / patch）。
     *
     * 按 toolCallId 精确匹配；没有 id 时才退化为「同名 + 尚无 details」。
     * details 是"改了哪个文件"这种关键信息，配错比不显示更糟。
     */
    case 'PI_TOOL_RESULT': {
      const value = e.value as {
        toolCallId?: string
        toolName?: string
        isError?: boolean
        details?: ToolResultDetails
      }
      if (!value?.details) return state
      return updateActiveAssistant(state, (msg) =>
        withSegments(
          msg,
          updateToolCall(
            msg.segments,
            (call) =>
              value.toolCallId != null
                ? call.toolCallId === value.toolCallId
                : call.toolName === value.toolName && call.details === undefined,
            (call) => ({
              ...call,
              details: value.details,
              status: value.isError ? 'error' : call.status
            })
          )
        )
      )
    }

    default:
      return state
  }
}

/** `pi:{toolName}` → toolName */
function parseStepName(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  return raw.startsWith('pi:') ? raw.slice(3) : raw
}

/** 是否已有同名的进行中工具分段 */
function hasPendingToolCall(segments: MessageSegment[], toolName: string): boolean {
  return segments.some(
    (s) => s.kind === 'tool' && s.call.toolName === toolName && s.call.status === 'running'
  )
}

/** 优先按 id 匹配，无 id 时退化为同名 + 指定状态 */
function matchToolCall(
  call: ToolCallInfo,
  toolCallId: string | undefined,
  toolName: string | undefined,
  status: ToolCallInfo['status']
): boolean {
  if (toolCallId != null) return call.toolCallId === toolCallId
  return call.toolName === toolName && call.status === status
}

/** 替换分段并同步 content（content 是文本分段的拼接，不是独立事实来源） */
function withSegments(msg: ChatMessage, segments: MessageSegment[]): ChatMessage {
  if (segments === msg.segments) return msg
  return { ...msg, segments, content: segmentsToText(segments) }
}

/** 更新当前活跃的助手消息 */
function updateActiveAssistant(
  state: MessageStreamState,
  updater: (msg: ChatMessage) => ChatMessage
): MessageStreamState {
  if (!state.activeRunId) return state
  return {
    ...state,
    messages: state.messages.map((msg) =>
      msg.runId === state.activeRunId && msg.role === 'assistant' ? updater(msg) : msg
    )
  }
}

/** 标记活跃助手消息为完成 */
function finishActiveAssistant(state: MessageStreamState, result?: string): ChatMessage[] {
  const now = Date.now()
  return state.messages.map((msg) => {
    if (msg.runId !== state.activeRunId || msg.role !== 'assistant') return msg
    let segments = closeThinking(msg.segments, now)
    // 后端给了最终文本、而流式期间一个 delta 都没到过时，补一个文本分段
    if (result && segmentsToText(segments).length === 0) {
      segments = appendText(segments, result)
    }
    return { ...msg, status: 'complete' as const, segments, content: segmentsToText(segments) }
  })
}

/** 标记活跃助手消息为错误 */
function errorActiveAssistant(state: MessageStreamState, errorMessage: string): ChatMessage[] {
  const now = Date.now()
  return state.messages.map((msg) => {
    if (msg.runId !== state.activeRunId || msg.role !== 'assistant') return msg
    return {
      ...msg,
      status: 'error' as const,
      error: errorMessage,
      segments: closeThinking(msg.segments, now)
    }
  })
}
export interface MessageStreamProps {
  /** 消息列表 */
  messages: ChatMessage[]
  /** 是否正在流式输出 */
  isStreaming: boolean
  /** 流式错误 */
  streamError: string | null
  /** 重试回调 */
  onRetry?: () => void
  /** 清空错误 */
  onDismissError?: () => void
  /** 顶部横幅（如压缩横幅） */
  banner?: ReactNode
  /** 点击示例问题回调（空状态时） */
  onExampleClick?: (text: string) => void
  /** 会话标识（用于会话切换时触发淡入动画） */
  sessionKey?: string
  /** 附件预览回调 */
  onFilePreview?: (file: FilePreviewState) => void
  /** 取消流式生成 */
  onCancelStream?: () => void
  /** 引用消息到输入框 */
  onQuote?: (text: string) => void
  /** 重新生成（仅 assistant 完成消息） */
  onRegenerate?: (message: ChatMessage) => void
  /** 打开设置页（错误卡片的修复入口） */
  onOpenSettings?: () => void
  /** 压缩上下文（错误卡片的修复入口） */
  onCompact?: () => void
  /** 待审批的工具执行请求（内联在消息流末尾） */
  pendingConfirmations?: ConfirmationRequestPayload[]
  /** 审批回调 */
  onRespondConfirmation?: (id: string, approved: boolean) => void
  /** 加载更早的消息回调（滚动到顶部时触发） */
  onLoadMore?: () => void
  /** 是否还有更早的消息可加载 */
  hasMore?: boolean
  /** 是否正在加载更多（非初始） */
  isLoadingMore?: boolean
  /** 是否正在初始加载（用于显示骨架屏） */
  isLoadingInitial?: boolean
}

/**
 * MessageStream：消息流容器组件
 *
 * 渲染消息列表 + 流式指示器 + 错误卡片 + 空状态
 * 自动跟随底部的逻辑抽到 `useAutoScroll`（意图式跟随，见该文件头部说明）
 * 会话切换时使用 AnimatePresence mode="wait" 淡入（200ms）
 */
export function MessageStream({
  messages,
  isStreaming,
  streamError,
  onRetry,
  onDismissError,
  banner,
  onExampleClick,
  sessionKey,
  onFilePreview,
  onCancelStream,
  onQuote,
  onRegenerate,
  onOpenSettings,
  onCompact,
  pendingConfirmations = [],
  onRespondConfirmation,
  onLoadMore,
  hasMore = false,
  isLoadingMore = false,
  isLoadingInitial = false
}: MessageStreamProps): ReactElement {
  const sentinelRef = useRef<HTMLDivElement>(null)
  const {
    scrollRef,
    contentRef,
    showJumpButton,
    scrollToBottom,
    forceFollow,
    beginPrepend,
    handlers
  } = useAutoScroll()

  // 保留最新的 onLoadMore 引用，避免 IntersectionObserver effect 频繁重建
  const onLoadMoreRef = useRef(onLoadMore)
  onLoadMoreRef.current = onLoadMore

  /**
   * 用户自己发的消息必须无条件贴底 —— 他刚提交的东西不可见是最糟的体验。
   * 靠「最后一条是不是 user 消息」判断，比让父组件多传一个回调简单。
   */
  const lastMessage = messages[messages.length - 1]
  const lastUserMessageId = lastMessage?.role === 'user' ? lastMessage.id : null
  useEffect(() => {
    if (lastUserMessageId) forceFollow()
  }, [lastUserMessageId, forceFollow])

  // 顶部"加载更多"哨兵：IntersectionObserver 检测滚动到顶部时触发
  // 依赖 messages.length 是为了在加载新页后重新观察（否则 sentinel 保持可见时不会再次触发）
  useEffect(() => {
    const sentinel = sentinelRef.current
    const root = scrollRef.current
    if (!sentinel || !root) return
    if (!hasMore) return
    if (!onLoadMore) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            // 先记录当前 scrollHeight/scrollTop：关掉 overflow-anchor 后
            // 前插历史不会自动保位，需要在内容长高时手动补偿
            beginPrepend()
            onLoadMoreRef.current?.()
          }
        }
      },
      { root, threshold: 0, rootMargin: '50px 0px 0px 0px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, onLoadMore, messages.length, scrollRef, beginPrepend])

  // 初始加载骨架屏：仅在首次拉取历史且尚无消息时显示
  const showInitialSkeleton = isLoadingInitial && messages.length === 0 && !isStreaming
  // 真正的空状态（首屏加载完成后仍无消息）
  const isEmpty = messages.length === 0 && !isStreaming && !streamError && !isLoadingInitial
  // 顶部"加载更多"区域：仅在已有消息且仍有更多时显示
  const showLoadMoreSentinel = hasMore && !showInitialSkeleton && messages.length > 0

  // 推断当前活跃的助手消息（最后一条 status === 'streaming' 的 assistant 消息）
  const activeMessage = messages.find((m) => m.role === 'assistant' && m.status === 'streaming')

  /**
   * 只有最后一条助手消息可以"重新生成"。
   *
   * 重新生成的语义是"丢掉这个回答再来一次"，对中间的历史消息做这件事会留下
   * 两个并排的回答（历史那条还在服务端 JSONL 里，本地删不掉）。限制到最后一条
   * 既符合惯例，也让实现能真正把旧回答清掉。
   */
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i].id
    }
    return null
  }, [messages])

  // 新消息到达时自动滚动到底部（使用 useAutoScroll 的 forceFollow）
  const prevLengthRef = useRef(messages.length)
  useEffect(() => {
    const currentLength = messages.length
    if (currentLength > prevLengthRef.current) {
      // 新消息到达，滚动到底部
      forceFollow()
    }
    prevLengthRef.current = currentLength
  }, [messages.length, forceFollow])

  // 用户消息后强制跟随
  useEffect(() => {
    if (lastUserMessageId) {
      forceFollow()
    }
  }, [lastUserMessageId, forceFollow])

  return (
    <div className="relative min-h-0 flex-1 flex flex-col">
      <section
        ref={scrollRef}
        onScroll={handlers.onScroll}
        onWheel={handlers.onWheel}
        onPointerDown={handlers.onPointerDown}
        onTouchStart={handlers.onTouchStart}
        onKeyDown={handlers.onKeyDown}
        // overflow-anchor: none —— Chrome 的滚动锚定会在内容变化时自行调整
        // scrollTop 保持视觉位置，这与"跟随底部"直接冲突。前插历史的保位
        // 改由 useAutoScroll 的 beginPrepend 手动补偿。
        style={{ overflowAnchor: 'none' }}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-5 flex flex-col"
        aria-label="消息流"
      >
        <div
          ref={contentRef}
          style={{ overflowAnchor: 'none' }}
          className={`mx-auto w-full max-w-[748px] space-y-4 min-w-0 ${isEmpty ? 'flex-1 flex flex-col justify-center' : ''}`}
        >
          {banner}
          {showLoadMoreSentinel && (
            <div
              ref={sentinelRef}
              className="flex justify-center items-center py-2 min-h-[1px]"
              aria-hidden={!isLoadingMore}
            >
              {isLoadingMore ? (
                <Loader2 className="size-4 animate-spin text-subtle" aria-label="加载更多消息" />
              ) : null}
            </div>
          )}
          {showInitialSkeleton ? (
            <MessageListSkeleton />
          ) : isEmpty ? (
            <EmptyState onExampleClick={onExampleClick} />
          ) : (
            <AnimatePresence initial={false} mode="wait">
              <motion.div
                key={sessionKey ?? 'default'}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                className="space-y-4"
              >
                {messages.map((msg) => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    onFilePreview={onFilePreview}
                    onQuote={onQuote}
                    onRegenerate={msg.id === lastAssistantId ? onRegenerate : undefined}
                  />
                ))}

                {isStreaming && (
                  <StreamingIndicator activeMessage={activeMessage} onCancel={onCancelStream} />
                )}

                {/* 审批卡片放在流末尾 —— 也就是 Agent 当前工作的位置。
                    这样用户能带着上下文做安全判断，而不是被模态框挡住一切。 */}
                {pendingConfirmations.length > 0 && onRespondConfirmation && (
                  <PermissionRequestCard
                    request={pendingConfirmations[0]}
                    queuedCount={pendingConfirmations.length - 1}
                    onRespond={onRespondConfirmation}
                  />
                )}

                {streamError && (
                  <ErrorCard
                    message={streamError}
                    onRetry={onRetry}
                    onDismiss={onDismissError}
                    onOpenSettings={onOpenSettings}
                    onCompact={onCompact}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          )}
        </div>
      </section>

      {/* 滚动到底部浮动按钮（dsh toBottom：34px 圆、发丝线、lv2 阴影） */}
      <AnimatePresence>
        {showJumpButton && messages.length > 0 && (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 8, scale: 0.8 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.8 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            onClick={() => scrollToBottom({ smooth: true })}
            className="absolute bottom-4 left-1/2 z-10 flex size-[34px] -translate-x-1/2 items-center justify-center rounded-full border border-border bg-[var(--dsw-alias-button-floating-fill)] text-text shadow-[var(--dsw-shadow-lv2)] transition-colors hover:bg-[var(--dsw-alias-button-floating-hover)] active:scale-[0.96]"
            aria-label="滚动到底部"
          >
            <ArrowDown className="size-4" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}

/** 初始加载时的骨架屏（避免空白闪烁） */
function MessageListSkeleton(): ReactElement {
  return (
    <div className="space-y-4 py-2" aria-label="加载中">
      {[0, 1, 2, 3].map((i) => {
        const isUser = i % 2 === 1
        return (
          <div key={i} className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
            <div
              className={cn(
                'h-12 rounded-xl bg-surface-2 animate-pulse',
                isUser ? 'w-1/2' : 'w-2/3'
              )}
            />
          </div>
        )
      })}
    </div>
  )
}
