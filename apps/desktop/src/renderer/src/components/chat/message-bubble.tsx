import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from './types'
import { ThinkingBlock } from './thinking-block'
import { ToolCallCard } from './tool-call-card'
import { FileAttachmentList } from './file-attachment'
import { cn } from '@/lib/utils'

export interface MessageBubbleProps {
  message: ChatMessage
}

/** 格式化时间戳为 HH:mm */
function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 用户头像显示文本：当前未接入用户资料，默认显示 MJ */
function getUserInitials(): string {
  return 'MJ'
}

/**
 * MessageBubble：单条消息气泡（Craft 风格）
 *
 * - 助手消息左对齐：紫色头像 "C" + 名字 "Craft" + 浅灰/白色气泡
 * - 用户消息右对齐：深色头像 "MJ" + 紫色气泡
 * - 保留思考块、工具调用卡片、Markdown 渲染与文件附件
 */
export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user'

  // 显示内容：流式时用 streamingBuffer，完成时用 content
  const displayContent = message.streamingBuffer ?? message.content

  return (
    <article className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      {isUser ? (
        /* 用户消息：气泡 + 右侧头像 */
        <div className="relative max-w-[70%] pr-9">
          <div
            className="flex size-7 items-center justify-center rounded-full bg-user-avatar-bg text-user-avatar-text text-[10px] font-semibold absolute top-0 right-0"
            aria-label="用户头像"
          >
            {getUserInitials()}
          </div>

          {/* 文件附件 */}
          {message.attachments && message.attachments.length > 0 && (
            <FileAttachmentList attachments={message.attachments} />
          )}

          {/* 文本气泡 */}
          {displayContent ? (
            <div className="rounded-[12px] bg-primary px-4 py-3.5 text-primary-foreground text-sm leading-relaxed break-words">
              <p className="whitespace-pre-wrap">{displayContent}</p>
              {message.createdAt && (
                <div className="mt-1.5 text-xs text-primary-foreground/80">
                  {formatTimestamp(message.createdAt)}
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        /* 助手消息：左侧头像 + Craft 名字 + 正文 */
        <div className="flex items-start gap-3 max-w-[80%] min-w-0">
          <div
            className="flex size-6 items-center justify-center rounded-full bg-avatar-bg text-avatar-text text-[10px] font-semibold shrink-0"
            aria-label="助手头像"
          >
            C
          </div>
          <div className="flex flex-col gap-2 min-w-0">
            <span className="text-sm font-medium text-text">Craft</span>

            {/* 思考块 */}
            {message.thinking && message.thinking.content && (
              <ThinkingBlock
                content={message.thinking.content}
                isStreaming={message.thinking.isStreaming}
              />
            )}

            {/* 工具调用卡片 */}
            {message.toolCalls.length > 0 && (
              <div className="w-full min-w-0 space-y-1.5">
                {message.toolCalls.map((tc) => (
                  <ToolCallCard key={tc.toolCallId} toolCall={tc} />
                ))}
              </div>
            )}

            {/* 文本内容 */}
            {displayContent ? (
              <div className="text-sm text-text-secondary leading-relaxed min-w-0 break-words">
                <div className="prose prose-sm max-w-none
                  prose-p:my-2 prose-p:leading-relaxed
                  prose-headings:my-3 prose-headings:leading-tight
                  prose-h1:text-base prose-h2:text-sm prose-h3:text-sm
                  prose-ul:my-2 prose-ol:my-2
                  prose-li:my-0.5
                  prose-pre:my-3 prose-pre:rounded-md prose-pre:bg-muted/60 prose-pre:border prose-pre:border-border prose-pre:overflow-x-auto prose-pre:max-w-full
                  prose-code:before:content-none prose-code:after:content-none prose-code:text-primary prose-code:bg-muted/60 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[0.85em]
                  prose-blockquote:my-2 prose-blockquote:border-l-primary prose-blockquote:text-muted-foreground
                  prose-hr:my-3 prose-hr:border-border
                  prose-a:text-primary prose-a:no-underline hover:prose-a:underline
                  prose-strong:text-text prose-em:text-text-secondary
                  prose-table:text-xs
                ">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown>
                </div>
              </div>
            ) : null}

            {/* 错误标记 */}
            {message.status === 'error' && message.error && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
                {message.error}
              </div>
            )}
          </div>
        </div>
      )}
    </article>
  )
}
