import { useCallback, useEffect, useRef, useState } from 'react'
import { EventType, type BaseEvent } from '@repo/protocol/events'
import type { ChatMessage, ToolCallInfo } from './types'
import { createAssistantMessage } from './types'
import { MessageBubble } from './message-bubble'
import { StreamingIndicator } from './streaming-indicator'
import { ErrorCard } from './error-card'
import { EmptyState } from './empty-state'

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
export function applyEvent(
  state: MessageStreamState,
  event: BaseEvent,
): MessageStreamState {
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
        messages: [...state.messages, assistantMsg],
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
        streamingBuffer: (msg.streamingBuffer ?? '') + delta,
      }))
    }

    case EventType.TEXT_MESSAGE_END: {
      return updateActiveAssistant(state, (msg) => ({
        ...msg,
        content: msg.streamingBuffer ?? msg.content,
        streamingBuffer: undefined,
      }))
    }

    case EventType.THINKING_TEXT_MESSAGE_CONTENT:
    case EventType.REASONING_MESSAGE_CONTENT: {
      const delta = (e.delta as string) ?? ''
      if (!delta) return state
      return updateActiveAssistant(state, (msg) => ({
        ...msg,
        thinking: {
          content: (msg.thinking?.content ?? '') + delta,
          isStreaming: true,
        },
      }))
    }

    case EventType.THINKING_END:
    case EventType.REASONING_END: {
      return updateActiveAssistant(state, (msg) => ({
        ...msg,
        thinking: msg.thinking
          ? { ...msg.thinking, isStreaming: false }
          : undefined,
      }))
    }

    case EventType.STEP_STARTED: {
      const stepName = (e.stepName as string) ?? ''
      // stepName 格式为 "pi:{toolName}"
      const toolName = stepName.startsWith('pi:')
        ? stepName.slice(3)
        : stepName
      const toolCallId = crypto.randomUUID()
      const toolCall: ToolCallInfo = {
        toolCallId,
        toolName,
        status: 'running',
        startedAt: Date.now(),
      }
      return updateActiveAssistant(state, (msg) => ({
        ...msg,
        toolCalls: [...msg.toolCalls, toolCall],
      }))
    }

    case EventType.STEP_FINISHED: {
      const stepName = (e.stepName as string) ?? ''
      const toolName = stepName.startsWith('pi:')
        ? stepName.slice(3)
        : stepName
      return updateActiveAssistant(state, (msg) => ({
        ...msg,
        toolCalls: msg.toolCalls.map((tc, idx) => {
          // 找到最后一个匹配的 running 工具
          if (
            tc.toolName === toolName &&
            tc.status === 'running' &&
            idx === msg.toolCalls.findIndex(
              (t) => t.toolName === toolName && t.status === 'running',
            )
          ) {
            return {
              ...tc,
              status: 'success' as const,
              endedAt: Date.now(),
            }
          }
          return tc
        }),
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
          if (
            tc.toolName === value.toolName &&
            tc.status === 'running'
          ) {
            return {
              ...tc,
              args: value.args ?? tc.args,
              partialResult: value.partialResult ?? tc.partialResult,
            }
          }
          return tc
        }),
      }))
    }

    case EventType.RUN_FINISHED: {
      const reason = (e as { reason?: string }).reason
      // abort 的 RUN_FINISHED 不改变消息状态（状态由 hook 管理）
      if (reason === 'aborted') {
        return {
          ...state,
          activeRunId: null,
        }
      }
      const result = (e as { result?: string }).result
      return {
        ...state,
        activeRunId: null,
        messages: finishActiveAssistant(state, result),
      }
    }

    case EventType.RUN_ERROR: {
      const message = (e.message as string) ?? '未知错误'
      return {
        ...state,
        activeRunId: null,
        streamError: message,
        messages: errorActiveAssistant(state, message),
      }
    }

    default:
      return state
  }
}

/** 更新当前活跃的助手消息 */
function updateActiveAssistant(
  state: MessageStreamState,
  updater: (msg: ChatMessage) => ChatMessage,
): MessageStreamState {
  if (!state.activeRunId) return state
  return {
    ...state,
    messages: state.messages.map((msg) =>
      msg.runId === state.activeRunId && msg.role === 'assistant'
        ? updater(msg)
        : msg,
    ),
  }
}

/** 标记活跃助手消息为完成 */
function finishActiveAssistant(
  state: MessageStreamState,
  result?: string,
): ChatMessage[] {
  return state.messages.map((msg) => {
    if (msg.runId === state.activeRunId && msg.role === 'assistant') {
      return {
        ...msg,
        status: 'complete' as const,
        content: result || msg.streamingBuffer || msg.content,
        streamingBuffer: undefined,
        thinking: msg.thinking
          ? { ...msg.thinking, isStreaming: false }
          : undefined,
      }
    }
    return msg
  })
}

/** 标记活跃助手消息为错误 */
function errorActiveAssistant(
  state: MessageStreamState,
  errorMessage: string,
): ChatMessage[] {
  return state.messages.map((msg) => {
    if (msg.runId === state.activeRunId && msg.role === 'assistant') {
      return {
        ...msg,
        status: 'error' as const,
        error: errorMessage,
        streamingBuffer: undefined,
        thinking: msg.thinking
          ? { ...msg.thinking, isStreaming: false }
          : undefined,
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
}

/**
 * MessageStream：消息流容器组件
 *
 * 渲染消息列表 + 流式指示器 + 错误卡片 + 空状态
 * 自动滚动到底部（流式时跟随，手动滚动后停止跟随）
 */
export function MessageStream({
  messages,
  isStreaming,
  streamError,
  onRetry,
  onDismissError,
}: MessageStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

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
  }, [messages, isStreaming, autoScroll])

  const isEmpty = messages.length === 0 && !isStreaming && !streamError

  return (
    <section
      ref={scrollRef}
      onScroll={handleScroll}
      className="min-h-0 flex-1 overflow-auto px-5 py-6"
      aria-label="消息流"
    >
      <div className="mx-auto max-w-[720px] space-y-4">
        {isEmpty ? (
          <EmptyState />
        ) : (
          <>
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}

            {isStreaming && <StreamingIndicator />}

            {streamError && (
              <ErrorCard
                message={streamError}
                onRetry={onRetry}
                onDismiss={onDismissError}
              />
            )}
          </>
        )}
      </div>
    </section>
  )
}
