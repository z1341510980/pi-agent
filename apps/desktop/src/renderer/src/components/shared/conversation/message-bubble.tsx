import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { motion } from 'framer-motion'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  AGENT_COLORS,
  AGENT_LABELS,
  formatTimestamp,
  type ConversationAgentType,
  type ConversationMessage,
} from './types'

export interface MessageBubbleProps {
  message: ConversationMessage
  /** 紧凑模式：隐藏头像和名称（用于同 Agent 连续消息分组内的后续消息） */
  compact?: boolean
}

/** 插话状态徽标（对话化交互形态 §3.1）：queued 灰 / injected 绿 / dropped 红 */
const INTERJECT_BADGES: Record<
  NonNullable<ConversationMessage['interjectStatus']>,
  { label: string; className: string }
> = {
  queued: {
    label: '已排队',
    className: 'border-border bg-surface-2 text-muted-foreground',
  },
  injected: {
    label: '已注入',
    className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  },
  dropped: {
    label: '已丢弃',
    className: 'border-destructive/40 bg-destructive/10 text-destructive',
  },
}

/** 组装插话徽标文案与样式；injected 且有 agentType 时展示「已注入·导演」 */
function getInterjectBadge(message: ConversationMessage): { label: string; className: string } | null {
  if (!message.interjectStatus) return null
  const badge = INTERJECT_BADGES[message.interjectStatus]
  if (message.interjectStatus === 'injected' && message.interjectAgentType) {
    const agentLabel = AGENT_LABELS[message.interjectAgentType as ConversationAgentType] ?? message.interjectAgentType
    return { ...badge, label: `已注入·${agentLabel}` }
  }
  return badge
}

/**
 * MessageBubble：通用单条消息气泡（chat / novel 共用）
 *
 * - 用户消息：右对齐，主色背景，白字
 * - Agent 消息：左对齐，头像（首字）+ 名称 + Badge + 浅灰气泡
 * - 流式时：名称旁 animate-pulse 圆点 + "正在生成..."
 * - 错误状态：红色边框
 */
export function MessageBubble({ message, compact = false }: MessageBubbleProps) {
  const isUser = message.role === 'user'

  // 显示内容：流式时用 streamingBuffer，完成时用 content
  const displayContent = message.streamingBuffer ?? message.content
  const isStreaming = message.status === 'streaming'

  if (isUser) {
    const interjectBadge = getInterjectBadge(message)
    return (
      <motion.article
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="flex justify-end"
      >
        <div className="relative max-w-[75%]">
          {displayContent ? (
            <div className="rounded-[10px] bg-primary px-3 py-2 text-sm leading-relaxed text-primary-foreground break-words">
              <p className="whitespace-pre-wrap">{displayContent}</p>
              <div className="mt-1 text-[10px] text-primary-foreground/70">
                {formatTimestamp(message.timestamp)}
              </div>
            </div>
          ) : null}
          {/* 插话状态徽标（已排队/已注入/已丢弃），气泡下方右对齐 */}
          {interjectBadge && (
            <div className="mt-1 flex justify-end">
              <span
                className={cn(
                  'rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none',
                  interjectBadge.className,
                )}
                data-interject-status={message.interjectStatus}
              >
                {interjectBadge.label}
              </span>
            </div>
          )}
        </div>
      </motion.article>
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
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className={cn(
        'flex max-w-[85%] min-w-0 items-start gap-2 justify-start',
        compact && 'pl-7', // 对齐头像宽度(20px) + gap(8px)
      )}
    >
      {/* 头像（紧凑模式隐藏） */}
      {!compact && (
        <div
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white',
            color?.avatarClass ?? 'bg-gray-500',
          )}
          aria-label="Agent 头像"
        >
          {avatarChar}
        </div>
      )}

      <div className="flex min-w-0 flex-col gap-1">
        {/* 名称 + Badge + 流式指示（紧凑模式隐藏） */}
        {!compact && (
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
                <span
                  className="size-1.5 rounded-full bg-primary animate-[streaming-pulse_1.2s_ease-in-out_infinite]"
                  aria-hidden="true"
                />
                正在生成...
              </span>
            )}
          </div>
        )}

        {/* 思考过程（推理模型，2026-08-24）：可展开区块，默认折叠，正文开始后不再丢弃 */}
        {message.thinking ? (
          <details className="group/thinking max-w-full rounded-md border border-border/60 bg-surface-2/60">
            <summary className="flex cursor-pointer select-none items-center gap-1 px-2.5 py-1 text-[10px] font-medium text-muted-foreground hover:text-text">
              <span className="transition-transform group-open/thinking:rotate-90" aria-hidden="true">▶</span>
              思考过程
              <span className="text-hint">（{message.thinking.length} 字）</span>
            </summary>
            <div className="max-h-64 overflow-y-auto whitespace-pre-wrap border-t border-border/50 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
              {message.thinking}
            </div>
          </details>
        ) : null}

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
                'prose-p:my-1 prose-p:leading-relaxed',
                'prose-headings:my-2 prose-headings:leading-tight',
                'prose-ul:my-1 prose-ol:my-1 prose-li:my-0',
                'prose-pre:my-2 prose-pre:rounded-md prose-pre:bg-muted/60 prose-pre:border prose-pre:border-border prose-pre:overflow-x-auto prose-pre:max-w-full prose-pre:text-[12px]',
                'prose-code:before:content-none prose-code:after:content-none prose-code:text-primary prose-code:bg-muted/60 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[0.85em]',
                'prose-blockquote:my-1 prose-blockquote:border-l-primary prose-blockquote:text-muted-foreground',
                'prose-hr:my-2 prose-hr:border-border',
                'prose-a:text-primary prose-a:no-underline hover:prose-a:underline',
                'prose-strong:text-text prose-em:text-text-secondary',
                'prose-table:text-xs',
              )}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown>
              {/* 流式时末尾闪烁光标 */}
              {isStreaming && (
                <span
                  className="inline-block w-[2px] h-[14px] ml-0.5 align-text-bottom bg-primary animate-[cursor-blink_1s_step-end_infinite]"
                  aria-hidden="true"
                />
              )}
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
    </motion.article>
  )
}
