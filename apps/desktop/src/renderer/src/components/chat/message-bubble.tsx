import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Bot, User } from 'lucide-react'
import type { ChatMessage } from './types'
import { ThinkingBlock } from './thinking-block'
import { ToolCallCard } from './tool-call-card'
import { cn } from '@/lib/utils'

export interface MessageBubbleProps {
  message: ChatMessage
}

/**
 * MessageBubble：单条消息气泡
 *
 * 用户消息右对齐，助手消息左对齐
 * 助手消息包含：思考块 + Markdown 内容 + 工具调用卡片
 */
export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user'

  // 显示内容：流式时用 streamingBuffer，完成时用 content
  const displayContent = message.streamingBuffer ?? message.content

  return (
    <article
      className={cn(
        'flex items-start gap-3',
        isUser ? 'flex-row-reverse' : 'flex-row',
      )}
    >
      {/* 头像 */}
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground',
        )}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>

      {/* 消息内容 */}
      <div
        className={cn(
          'min-w-0 flex-1 space-y-2',
          isUser ? 'items-end text-right' : 'items-start',
        )}
      >
        {/* 思考块 */}
        {!isUser && message.thinking && message.thinking.content && (
          <ThinkingBlock
            content={message.thinking.content}
            isStreaming={message.thinking.isStreaming}
          />
        )}

        {/* 工具调用卡片 */}
        {!isUser && message.toolCalls.length > 0 && (
          <div className="space-y-2">
            {message.toolCalls.map((tc) => (
              <ToolCallCard key={tc.toolCallId} toolCall={tc} />
            ))}
          </div>
        )}

        {/* 文本内容 */}
        {displayContent ? (
          <div
            className={cn(
              'inline-block rounded-lg px-4 py-2.5 text-sm',
              isUser
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-foreground',
            )}
          >
            {isUser ? (
              <p className="whitespace-pre-wrap">{displayContent}</p>
            ) : (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {displayContent}
                </ReactMarkdown>
              </div>
            )}
          </div>
        ) : null}

        {/* 错误标记 */}
        {!isUser && message.status === 'error' && message.error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
            {message.error}
          </div>
        )}
      </div>
    </article>
  )
}
