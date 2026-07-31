import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ReactElement } from 'react'
import type { ChatMessage, FileAttachment } from './types'
import { ThinkingBlock } from './thinking-block'
import { ToolCallCard } from './tool-call-card'
import { ToolSummaryCard } from './tool-summary-card'
import { MessageHoverActions } from './message-hover-actions'
import { FileAttachmentList } from './file-attachment'
import { cn } from '@/lib/utils'
import type { FilePreviewState } from '@/stores/ui-store'

export interface MessageBubbleProps {
  message: ChatMessage
  onFilePreview?: (file: FilePreviewState) => void
  /** 引用消息到输入框 */
  onQuote?: (text: string) => void
  /** 重新生成（仅 assistant 完成消息） */
  onRegenerate?: (message: ChatMessage) => void
}

/** 格式化时间戳为 HH:mm */
function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * MessageBubble：单条消息气泡（AionUi 风格对齐）
 *
 * 设计要点（借鉴 AionUi MessageText）：
 *   - 不显示头像与 Agent 名字（保持极简，对齐 AionUi）
 *   - 用户气泡：淡灰背景 (bg-surface-3) + 不对称圆角 (8px 0 8px 8px)，左上角无圆角
 *   - AI 消息：无背景色，仅 Markdown 文本与子组件（思考/工具调用）
 *   - 复制按钮 + 时间戳：默认 opacity-0，group-hover 时显现，固定行高避免抖动
 */
export function MessageBubble({
  message,
  onFilePreview,
  onQuote,
  onRegenerate
}: MessageBubbleProps): ReactElement {
  const isUser = message.role === 'user'

  // 显示内容：流式时用 streamingBuffer，完成时用 content
  const displayContent = message.streamingBuffer ?? message.content

  // 是否有可复制的文本内容（用于决定是否显示 hover 行）
  const hasCopyableText = Boolean(displayContent && displayContent.trim().length > 0)

  return (
    <article
      className={cn('group flex min-w-0', isUser ? 'justify-end' : 'justify-start')}
      data-message-role={message.role}
    >
      <div
        className={cn(
          'min-w-0 flex flex-col',
          isUser ? 'items-end max-w-[76%]' : 'items-start max-w-[88%]'
        )}
      >
        {/* ── 文件附件 ── */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="mb-2 min-w-0 max-w-full">
            <FileAttachmentList
              attachments={message.attachments}
              onPreview={
                onFilePreview
                  ? (att: FileAttachment) =>
                      onFilePreview({
                        name: att.name,
                        content: att.content,
                        encoding: att.encoding,
                        mimeType: att.mimeType,
                        thumbnail: att.thumbnail,
                        size: att.size,
                        type: att.type
                      })
                  : undefined
              }
            />
          </div>
        )}

        {/* ── 文本气泡 ── */}
        {isUser ? (
          displayContent ? (
            <div className="message-user-bubble px-3.5 py-2.5 text-text text-sm leading-relaxed break-words [border-radius:14px_4px_14px_14px]">
              <p className="m-0 whitespace-pre-wrap text-pretty">{displayContent}</p>
            </div>
          ) : null
        ) : (
          /* AI 消息：透明背景 + 子组件序列（思考 → 工具调用 → Markdown 文本 → 错误） */
          <div className="text-sm text-text-secondary leading-relaxed min-w-0 break-words w-full">
            {/* 思考块 */}
            {message.thinking && message.thinking.content && (
              <ThinkingBlock
                content={message.thinking.content}
                isStreaming={message.thinking.isStreaming}
                startedAt={message.thinking.startedAt}
                endedAt={message.thinking.endedAt}
              />
            )}

            {/* 工具调用卡片：>=3 个时合并为 SummaryCard 折叠展示 */}
            {message.toolCalls.length > 0 && (
              <div className="w-full min-w-0 space-y-1.5 mb-2">
                {message.toolCalls.length >= 3 ? (
                  <ToolSummaryCard toolCalls={message.toolCalls} />
                ) : (
                  message.toolCalls.map((tc) => <ToolCallCard key={tc.toolCallId} toolCall={tc} />)
                )}
              </div>
            )}

            {/* Markdown 文本内容 */}
            {displayContent ? (
              <div
                className="message-markdown prose prose-sm max-w-none
                  prose-p:my-2 prose-p:leading-relaxed
                  prose-headings:my-3 prose-headings:leading-tight
                  prose-h1:text-base prose-h2:text-sm prose-h3:text-sm
                  prose-ul:my-2 prose-ol:my-2
                  prose-li:my-0.5
                  prose-pre:my-3 prose-pre:rounded-xl prose-pre:bg-muted/60 prose-pre:border-0 prose-pre:overflow-x-auto prose-pre:max-w-full
                  prose-code:before:content-none prose-code:after:content-none prose-code:text-primary prose-code:bg-muted/60 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[0.85em]
                  prose-blockquote:my-2 prose-blockquote:border-l-primary prose-blockquote:text-muted-foreground
                  prose-hr:my-3 prose-hr:border-border
                  prose-a:text-primary prose-a:no-underline hover:prose-a:underline
                  prose-strong:text-text prose-em:text-text-secondary
                  prose-table:text-xs
                "
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown>
              </div>
            ) : null}

            {/* 错误标记 */}
            {message.status === 'error' && message.error && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
                {message.error}
              </div>
            )}
          </div>
        )}

        {/* ── Hover 动作栏 + 时间戳（固定高度，避免抖动） ── */}
        {hasCopyableText && (
          <div
            className={cn(
              'h-6 flex items-center mt-1 gap-1.5 select-none',
              isUser && 'flex-row-reverse'
            )}
          >
            <MessageHoverActions message={message} onQuote={onQuote} onRegenerate={onRegenerate} />
            {message.createdAt && (
              <span className="text-[11px] text-hint opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                {formatTimestamp(message.createdAt)}
              </span>
            )}
          </div>
        )}
      </div>
    </article>
  )
}
