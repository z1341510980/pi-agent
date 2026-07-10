import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ConversationMessage } from './types'

export interface CheckpointMessageProps {
  message: ConversationMessage
  onResolve: (action: string) => void
}

/** checkpointType → 标题 */
const CHECKPOINT_TITLES: Record<NonNullable<ConversationMessage['checkpointType']>, string> = {
  narrative: '叙事确认',
  review: '验收确认',
}

/**
 * CheckpointMessage：检查点消息卡片
 *
 * - 居中卡片，黄色警示边框
 * - 显示 checkpointType 标题
 * - 用 Markdown 渲染 content
 * - 渲染 checkpointOptions 按钮列表
 * - 已解决（checkpointResolved 有值）时显示已选决策并禁用按钮
 */
export function CheckpointMessage({ message, onResolve }: CheckpointMessageProps) {
  const resolved = !!message.checkpointResolved
  const title = message.checkpointType
    ? CHECKPOINT_TITLES[message.checkpointType]
    : '检查点确认'
  const options = message.checkpointOptions ?? []

  return (
    <article className="flex justify-center">
      <div
        className={cn(
          'w-full max-w-[90%] rounded-[10px] border-2 bg-card px-3 py-3 shadow-sm',
          resolved ? 'border-emerald-500/50' : 'border-amber-500/60',
        )}
        role="alertdialog"
        aria-label={title}
      >
        {/* 标题行 */}
        <div className="mb-2 flex items-center gap-2">
          {resolved ? (
            <CheckCircle2 className="size-3.5 text-emerald-500" aria-hidden="true" />
          ) : (
            <AlertTriangle className="size-3.5 text-amber-500" aria-hidden="true" />
          )}
          <span className="text-xs font-semibold text-text">{title}</span>
        </div>

        {/* 内容 */}
        {message.content ? (
          <div
            className={cn(
              'prose prose-sm max-w-none',
              'prose-p:my-1 prose-p:leading-relaxed prose-p:text-xs',
              'prose-headings:my-1.5',
              'prose-ul:my-1 prose-ol:my-1',
              'prose-li:my-0',
              'prose-pre:rounded-md prose-pre:bg-muted/60 prose-pre:border prose-pre:border-border prose-pre:text-[11px]',
              'prose-code:before:content-none prose-code:after:content-none prose-code:text-primary',
              'prose-blockquote:border-l-primary',
            )}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </div>
        ) : null}

        {/* 已解决：显示已选决策 */}
        {resolved ? (
          <div className="mt-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-700 dark:text-emerald-300">
            已决策：{message.checkpointResolved}
          </div>
        ) : (
          /* 未解决：渲染操作按钮 */
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {options.map((opt) => (
              <Button
                key={opt.action}
                type="button"
                variant={opt.variant}
                size="sm"
                disabled={resolved}
                onClick={() => onResolve(opt.action)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </article>
  )
}
