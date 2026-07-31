import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Loader2, ArrowDown } from 'lucide-react'
import { EventType, type BaseEvent } from '@repo/protocol/events'
import type { ChatMessage, ToolCallInfo } from './types'
import { createAssistantMessage } from './types'
import { MessageBubble } from './message-bubble'
import { StreamingIndicator } from './streaming-indicator'
import { ErrorCard } from './error-card'
import { EmptyState } from './empty-state'
import { cn } from '@/lib/utils'
import type { FilePreviewState } from '@/stores/ui-store'

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
 * 事件映射：
 *   RUN_STARTED → 创建空的助手消息
 *   TEXT_MESSAGE_START → 确保助手消息存在
 *   TEXT_MESSAGE_CONTENT → 追加 delta 到 streamingBuffer
 *   TEXT_MESSAGE_END → streamingBuffer → content
 *   THINKING_TEXT_MESSAGE_CONTENT / REASONING_MESSAGE_CONTENT → 追加到 thinking.content
 *   STEP_STARTED → 新建 ToolCallInfo (running)
 *   STEP_FINISHED → 标记工具完成
 *   CUSTOM (PI_TOOL_EXECUTION_UPDATE) → 更新工具 args/partialResult
 *   RUN_FINISHED → 标记助手消息 complete
 *   RUN_ERROR → 设置 streamError
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

    case EventType.TEXT_MESSAGE_START: {
      // 确保有活跃的助手消息
      if (!state.activeRunId) return state
      return state
    }

    case EventType.TEXT_MESSAGE_CONTENT: {
      const delta = (e.delta as string) ?? ''
      if (!delta) return state
      return updateActiveAssistant(state, (msg) => ({
        ...msg,
        streamingBuffer: (msg.streamingBuffer ?? '') + delta
      }))
    }

    case EventType.TEXT_MESSAGE_END: {
      return updateActiveAssistant(state, (msg) => ({
        ...msg,
        content: msg.streamingBuffer ?? msg.content,
        streamingBuffer: undefined
      }))
    }

    case EventType.THINKING_TEXT_MESSAGE_CONTENT: {
      const delta = (e.delta as string) ?? ''
      if (!delta) return state
      const now = Date.now()
      return updateActiveAssistant(state, (msg) => ({
        ...msg,
        thinking: {
          content: (msg.thinking?.content ?? '') + delta,
          isStreaming: true,
          startedAt: msg.thinking?.startedAt ?? now
        }
      }))
    }

    case EventType.REASONING_MESSAGE_CONTENT: {
      // 与 THINKING_TEXT_MESSAGE_CONTENT 内容相同，跳过避免重复
      return state
    }

    case EventType.THINKING_END:
    case EventType.REASONING_END: {
      return updateActiveAssistant(state, (msg) => ({
        ...msg,
        thinking: msg.thinking
          ? { ...msg.thinking, isStreaming: false, endedAt: Date.now() }
          : undefined
      }))
    }

    case EventType.STEP_STARTED: {
      const stepName = (e.stepName as string) ?? ''
      // stepName 格式为 "pi:{toolName}"
      const toolName = stepName.startsWith('pi:') ? stepName.slice(3) : stepName
      const toolCallId = crypto.randomUUID()
      const toolCall: ToolCallInfo = {
        toolCallId,
        toolName,
        status: 'running',
        startedAt: Date.now()
      }
      return updateActiveAssistant(state, (msg) => ({
        ...msg,
        toolCalls: [...msg.toolCalls, toolCall]
      }))
    }

    case EventType.STEP_FINISHED: {
      const stepName = (e.stepName as string) ?? ''
      const toolName = stepName.startsWith('pi:') ? stepName.slice(3) : stepName
      return updateActiveAssistant(state, (msg) => ({
        ...msg,
        toolCalls: msg.toolCalls.map((tc, idx) => {
          // 找到最后一个匹配的 running 工具
          if (
            tc.toolName === toolName &&
            tc.status === 'running' &&
            idx ===
              msg.toolCalls.findIndex((t) => t.toolName === toolName && t.status === 'running')
          ) {
            return {
              ...tc,
              status: 'success' as const,
              endedAt: Date.now()
            }
          }
          return tc
        })
      }))
    }

    case EventType.CUSTOM: {
      const name = (e.name as string) ?? ''
      if (name !== 'PI_TOOL_EXECUTION_UPDATE') return state

      const value = e.value as {
        toolCallId?: string
        toolName?: string
        args?: unknown
        partialResult?: unknown
      }
      if (!value) return state

      return updateActiveAssistant(state, (msg) => ({
        ...msg,
        toolCalls: msg.toolCalls.map((tc) => {
          // 按 toolName 匹配最后一个 running 的工具
          if (tc.toolName === value.toolName && tc.status === 'running') {
            return {
              ...tc,
              args: value.args ?? tc.args,
              partialResult: value.partialResult ?? tc.partialResult
            }
          }
          return tc
        })
      }))
    }

    case EventType.RUN_FINISHED: {
      const reason = (e as { reason?: string }).reason
      // abort 的 RUN_FINISHED 不改变消息状态（状态由 hook 管理）
      if (reason === 'aborted') {
        return {
          ...state,
          activeRunId: null
        }
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
  return state.messages.map((msg) => {
    if (msg.runId === state.activeRunId && msg.role === 'assistant') {
      return {
        ...msg,
        status: 'complete' as const,
        content: result || msg.streamingBuffer || msg.content,
        streamingBuffer: undefined,
        thinking: msg.thinking ? { ...msg.thinking, isStreaming: false } : undefined
      }
    }
    return msg
  })
}

/** 标记活跃助手消息为错误 */
function errorActiveAssistant(state: MessageStreamState, errorMessage: string): ChatMessage[] {
  return state.messages.map((msg) => {
    if (msg.runId === state.activeRunId && msg.role === 'assistant') {
      return {
        ...msg,
        status: 'error' as const,
        error: errorMessage,
        streamingBuffer: undefined,
        thinking: msg.thinking ? { ...msg.thinking, isStreaming: false } : undefined
      }
    }
    return msg
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
 * 自动滚动到底部（流式时跟随，手动滚动后停止跟随）
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
  onLoadMore,
  hasMore = false,
  isLoadingMore = false,
  isLoadingInitial = false
}: MessageStreamProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  // 保留最新的 onLoadMore 引用，避免 IntersectionObserver effect 频繁重建
  const onLoadMoreRef = useRef(onLoadMore)
  onLoadMoreRef.current = onLoadMore

  // 检测用户是否手动滚动
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50
    setAutoScroll(isAtBottom)
  }, [])

  // 自动滚动到底部
  useEffect(() => {
    if (!autoScroll) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, isStreaming, autoScroll, banner])

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
            onLoadMoreRef.current?.()
          }
        }
      },
      { root, threshold: 0, rootMargin: '50px 0px 0px 0px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, onLoadMore, messages.length])

  // 初始加载骨架屏：仅在首次拉取历史且尚无消息时显示
  const showInitialSkeleton = isLoadingInitial && messages.length === 0 && !isStreaming
  // 真正的空状态（首屏加载完成后仍无消息）
  const isEmpty = messages.length === 0 && !isStreaming && !streamError && !isLoadingInitial
  // 顶部"加载更多"区域：仅在已有消息且仍有更多时显示
  const showLoadMoreSentinel = hasMore && !showInitialSkeleton && messages.length > 0

  // 推断当前活跃的助手消息（最后一条 status === 'streaming' 的 assistant 消息）
  const activeMessage = messages.find((m) => m.role === 'assistant' && m.status === 'streaming')

  return (
    <div className="relative min-h-0 flex-1 flex flex-col">
      <section
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-5 flex flex-col"
        aria-label="消息流"
      >
        <div
          className={`mx-auto w-full max-w-[920px] space-y-5 min-w-0 ${isEmpty ? 'flex-1 flex flex-col justify-center' : ''}`}
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
                    onRegenerate={onRegenerate}
                  />
                ))}

                {isStreaming && (
                  <StreamingIndicator activeMessage={activeMessage} onCancel={onCancelStream} />
                )}

                {streamError && (
                  <ErrorCard message={streamError} onRetry={onRetry} onDismiss={onDismissError} />
                )}
              </motion.div>
            </AnimatePresence>
          )}
        </div>
      </section>

      {/* 滚动到底部浮动按钮（AionUi 风格：圆形 + 阴影） */}
      <AnimatePresence>
        {!autoScroll && messages.length > 0 && (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 8, scale: 0.8 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.8 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            onClick={() => {
              const el = scrollRef.current
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
              setAutoScroll(true)
            }}
            className="pi-floating-button absolute bottom-4 left-1/2 -translate-x-1/2 size-10 rounded-full bg-surface-1 flex items-center justify-center text-text-secondary hover:text-text hover:bg-surface-2 active:scale-[0.96] z-10"
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
