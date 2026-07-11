import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { ConversationMessage } from './types'
import { MessageBubble } from './message-bubble'
import { CheckpointMessage } from './checkpoint-message'
import { SystemMessage } from './system-message'

export interface ConversationStreamProps {
  /** 消息列表 */
  messages: ConversationMessage[]
  /** 检查点决策回调 */
  onCheckpointResolve?: (action: string) => void
  /** 系统消息操作回调 */
  onSystemAction?: (action: string) => void
  /** 空状态文案 */
  emptyHint?: string
}

/**
 * ConversationStream：消息流容器
 *
 * - 按 role 分发到 MessageBubble / CheckpointMessage / SystemMessage
 * - 自动滚动到底部（检测用户是否在底部 50px 内，手动上滚后停止跟随）
 * - 空状态显示 emptyHint
 */
export function ConversationStream({
  messages,
  onCheckpointResolve,
  onSystemAction,
  emptyHint = '暂无消息',
}: ConversationStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  // 检测用户是否手动滚动（距底部 50px 内视为在底部）
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
  }, [messages, autoScroll])

  const isEmpty = messages.length === 0

  return (
    <section
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-3 py-3"
      aria-label="消息流"
    >
      <div
        className={cn(
          'min-w-0 space-y-3',
          isEmpty && 'flex flex-1 flex-col justify-center text-xs',
        )}
      >
        {isEmpty ? (
          <div className="text-center text-xs text-hint">{emptyHint}</div>
        ) : (
          messages.map((msg) => {
            if (msg.role === 'checkpoint') {
              return (
                <CheckpointMessage
                  key={msg.id}
                  message={msg}
                  onResolve={(action) => onCheckpointResolve?.(action)}
                />
              )
            }
            if (msg.role === 'system') {
              return (
                <SystemMessage
                  key={msg.id}
                  message={msg}
                  onAction={(action) => onSystemAction?.(action)}
                />
              )
            }
            return <MessageBubble key={msg.id} message={msg} />
          })
        )}
      </div>
    </section>
  )
}
