import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  AGENT_COLORS,
  AGENT_LABELS,
  formatTimestamp,
  type ConversationMessage,
} from './types'

export interface MessageBubbleProps {
  message: ConversationMessage
}

/**
 * MessageBubble：通用单条消息气泡（chat / novel 共用）
 *
 * - 用户消息：右对齐，主色背景，白字
 * - Agent 消息：左对齐，头像（首字）+ 名称 + Badge + 浅灰气泡
 * - 流式时：名称旁 animate-pulse 圆点 + "正在生成..."
 * - 错误状态：红色边框
 */
export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user'

  // 显示内容：流式时用 streamingBuffer，完成时用 content
  const displayContent = message.streamingBuffer ?? message.content
  const isStreaming = message.status === 'streaming'

  if (isUser) {
    return (
      <article className="flex justify-end">
        <div className="relative max-w-[75%]">
          {displayContent ? (
            <div className="rounded-[10px] bg-primary px-3 py-2 text-xs leading-relaxed text-primary-foreground break-words">
              <p className="whitespace-pre-wrap">{displayContent}</p>
              <div className="mt-1 text-[10px] text-primary-foreground/70">
                {formatTimestamp(message.timestamp)}
              </div>
            </div>
          ) : null}
        </div>
      </article>
    )
  }

  // ── Agent 消息 ──
  const agentType = message.agentType
  const color = agentType ? AGENT_COLORS[agentType] : null
  const agentLabel = agentType ? AGENT_LABELS[agentType] : undefined
  // 头像首字：优先 agentName 首字，否则用中文标签首字
  const avatarChar = (message.agentName?.[0] ?? agentLabel?.[0] ?? 'A').toUpperCase()
  const isError = message.status === 'error'

  return (
    <article className="flex max-w-[85%] min-w-0 items-start gap-2 justify-start">
      {/* 头像 */}
      <div
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white',
          color?.avatarClass ?? 'bg-gray-500',
        )}
        aria-label="Agent 头像"
      >
        {avatarChar}
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        {/* 名称 + Badge + 流式指示 */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-text">
            {message.agentName ?? agentLabel ?? '助手'}
          </span>
          {agentLabel && color && (
            <Badge variant="outline" className={cn('border text-[10px] px-1 py-0', color.badgeClass)}>
              {agentLabel}
            </Badge>
          )}
          {isStreaming && (
            <span className="flex items-center gap-1 text-[10px] text-hint">
              <span className="size-1 animate-pulse rounded-full bg-primary" aria-hidden="true" />
              正在生成...
            </span>
          )}
        </div>

        {/* 文本气泡（浅灰背景 + agent 边框色；错误时红色边框） */}
        {displayContent ? (
          <div
            className={cn(
              'min-w-0 max-w-full rounded-[10px] border bg-muted/40 px-3 py-2 break-words',
              isError ? 'border-destructive/60' : 'border-border',
            )}
            style={isError ? undefined : { borderColor: color?.borderColor ?? undefined }}
          >
            <div
              className={cn(
                'prose prose-sm max-w-none',
                'prose-p:my-1 prose-p:leading-relaxed prose-p:text-xs',
                'prose-headings:my-2 prose-headings:leading-tight',
                'prose-h1:text-sm prose-h2:text-xs prose-h3:text-xs',
                'prose-ul:my-1 prose-ol:my-1 prose-li:my-0',
                'prose-pre:my-2 prose-pre:rounded-md prose-pre:bg-muted/60 prose-pre:border prose-pre:border-border prose-pre:overflow-x-auto prose-pre:max-w-full prose-pre:text-[11px]',
                'prose-code:before:content-none prose-code:after:content-none prose-code:text-primary prose-code:bg-muted/60 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[0.85em]',
                'prose-blockquote:my-1 prose-blockquote:border-l-primary prose-blockquote:text-muted-foreground',
                'prose-hr:my-2 prose-hr:border-border',
                'prose-a:text-primary prose-a:no-underline hover:prose-a:underline',
                'prose-strong:text-text prose-em:text-text-secondary',
                'prose-table:text-[10px]',
              )}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown>
            </div>
          </div>
        ) : null}

        {/* 错误信息 */}
        {isError && message.error ? (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {message.error}
          </div>
        ) : null}

        {/* 时间戳 */}
        {!isStreaming && displayContent ? (
          <div className="text-[10px] text-hint">{formatTimestamp(message.timestamp)}</div>
        ) : null}
      </div>
    </article>
  )
}
