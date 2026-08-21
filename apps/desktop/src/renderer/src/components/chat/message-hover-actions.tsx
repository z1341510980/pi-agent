import { Copy, Check, RefreshCw, Quote } from 'lucide-react'
import { useState, type MouseEvent } from 'react'
import type { ChatMessage } from './types'
import { cn } from '@/lib/utils'
import { SlotRenderer } from '../slot'

export interface MessageHoverActionsProps {
  /** 当前消息 */
  message: ChatMessage
  /** 引用消息到输入框 */
  onQuote?: (text: string) => void
  /** 重新生成（仅 assistant 消息） */
  onRegenerate?: (message: ChatMessage) => void
}

/**
 * MessageHoverActions：消息 hover 时显示的轻量动作栏
 *
 * 借鉴 AionUi：
 *   - 默认 opacity-0，group-hover 时显现
 *   - 复制（已有可保留逻辑，但本组件统一入口）
 *   - 引用（插入到输入框）
 *   - 重新生成（仅 assistant 完成消息）
 *
 * 不再单独显示时间戳，时间戳由 MessageBubble 统一管理。
 */
export function MessageHoverActions({ message, onQuote, onRegenerate }: MessageHoverActionsProps) {
  const [copied, setCopied] = useState(false)
  const isAssistant = message.role === 'assistant'
  const isComplete = message.status === 'complete'
  const displayContent = message.content
  const text = typeof displayContent === 'string' ? displayContent : ''

  const handleCopy = async (_e: MouseEvent<HTMLButtonElement>) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // 静默失败
    }
  }

  const handleQuote = () => {
    if (!text || !onQuote) return
    // 引用格式：以 > 开头，按行引用
    const quoted = text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    onQuote(quoted)
  }

  const handleRegenerate = () => {
    if (!isAssistant || !isComplete || !onRegenerate) return
    onRegenerate(message)
  }

  const canCopy = text.length > 0
  const canQuote = text.length > 0 && Boolean(onQuote)
  const canRegenerate = isAssistant && isComplete && Boolean(onRegenerate)

  // 插件贡献不参与 canCopy/canQuote/canRegenerate 判定：即使宿主三个动作都不可用，
  // 插件仍可能有自己的消息动作，所以容器不能提前 return null。

  return (
    <div
      className={cn(
        'flex items-center gap-0.5 select-none',
        'opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150',
      )}
    >
      {canCopy && (
        <ActionButton
          label={copied ? '已复制' : '复制'}
          onClick={handleCopy}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </ActionButton>
      )}

      {canQuote && (
        <ActionButton
          label="引用"
          onClick={handleQuote}
        >
          <Quote className="size-3.5" />
        </ActionButton>
      )}

      {canRegenerate && (
        <ActionButton
          label="重新生成"
          onClick={handleRegenerate}
        >
          <RefreshCw className="size-3.5" />
        </ActionButton>
      )}

      {/* 插件贡献的消息动作（list slot，宿主动作之后） */}
      <SlotRenderer name="chat.message.actions" fallback={null} extraProps={{ message }} />
    </div>
  )
}

/** 单个动作按钮（dsh IconActions：28px 圆形热区、三级灰、hover 提亮） */
function ActionButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: (e: MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full p-1.5 text-subtle transition-colors hover:bg-accent hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  )
}
