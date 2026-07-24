import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { ConversationMessage } from './types'
import { MessageBubble } from './message-bubble'
import { CheckpointMessage } from './checkpoint-message'
import { SystemMessage } from './system-message'
import { ConversationEmptyState, type EmptyStateVariant } from './empty-state'

export interface ConversationStreamProps {
  /** 消息列表 */
  messages: ConversationMessage[]
  /** 检查点决策回调 */
  onCheckpointResolve?: (action: string) => void
  /** 系统消息操作回调 */
  onSystemAction?: (action: string) => void
  /** 空状态文案 */
  emptyHint?: string
  /** 空状态标题 */
  emptyTitle?: string
  /** 空状态插图变体 */
  emptyVariant?: EmptyStateVariant
}

/** 分组后的渲染单元 */
type RenderItem =
  | { kind: 'message'; message: ConversationMessage; compact: boolean }
  | { kind: 'checkpoint'; message: ConversationMessage }
  | { kind: 'system'; message: ConversationMessage }

/**
 * 将连续同一 Agent 的 assistant 消息合并为一组。
 * 组内第一条 compact=false（显示头像+名称），后续 compact=true。
 * 非 assistant 消息（user/checkpoint/system）始终独立。
 */
function groupMessages(messages: ConversationMessage[]): RenderItem[] {
  const items: RenderItem[] = []
  let prevAgentKey: string | null = null

  for (const msg of messages) {
    if (msg.role === 'checkpoint') {
      prevAgentKey = null
      items.push({ kind: 'checkpoint', message: msg })
    } else if (msg.role === 'system') {
      prevAgentKey = null
      items.push({ kind: 'system', message: msg })
    } else if (msg.role === 'user') {
      prevAgentKey = null
      items.push({ kind: 'message', message: msg, compact: false })
    } else {
      // assistant：按 agentType + agentName 分组
      const agentKey = `${msg.agentType ?? ''}:${msg.agentName ?? ''}`
      const isConsecutive = agentKey === prevAgentKey
      items.push({ kind: 'message', message: msg, compact: isConsecutive })
      prevAgentKey = agentKey
    }
  }

  return items
}

/**
 * ConversationStream：消息流容器
 *
 * - 同 Agent 连续消息分组（共享头像/名称，后续消息紧凑排列）
 * - 按 role 分发到 MessageBubble / CheckpointMessage / SystemMessage
 * - 自动滚动到底部（检测用户是否在底部 50px 内，手动上滚后停止跟随）
 * - 空状态显示 emptyHint
 */
export function ConversationStream({
  messages,
  onCheckpointResolve,
  onSystemAction,
  emptyHint = '暂无消息',
  emptyTitle = '开始对话',
  emptyVariant = 'default',
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

  // 分组计算
  const renderItems = useMemo(() => groupMessages(messages), [messages])

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
          <ConversationEmptyState
            variant={emptyVariant}
            title={emptyTitle}
            hint={emptyHint}
          />
        ) : (
          renderItems.map((item) => {
            if (item.kind === 'checkpoint') {
              return (
                <CheckpointMessage
                  key={item.message.id}
                  message={item.message}
                  onResolve={(action) => onCheckpointResolve?.(action)}
                />
              )
            }
            if (item.kind === 'system') {
              return (
                <SystemMessage
                  key={item.message.id}
                  message={item.message}
                  onAction={(action) => onSystemAction?.(action)}
                />
              )
            }
            // 分组内紧凑消息：减小与上一条的间距
            return (
              <div key={item.message.id} className={cn(item.compact && '-mt-2')}>
                <MessageBubble message={item.message} compact={item.compact} />
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}
