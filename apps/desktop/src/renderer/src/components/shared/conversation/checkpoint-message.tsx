import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { motion } from 'framer-motion'
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
  narrative_task: '叙事确认',
  review: '验收确认',
  post_write_guard: '守护触发',
  writer_pushback: '写作推回',
  guard_degraded: '守护降级',
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
    <motion.article
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="flex justify-center"
    >
      <div
        className={cn(
          // 左侧 3px 主色边框 + 浅色全边框 + 圆角 + 阴影（与 HTML 样例对齐）
          'w-full max-w-[90%] overflow-hidden rounded-lg border bg-card shadow-sm',
          'border-l-[3px]',
          resolved
            ? 'border-emerald-500/30 border-l-emerald-500'
            : 'border-amber-500/30 border-l-primary',
        )}
        role="alertdialog"
        aria-label={title}
      >
        {/* 标题行：浅色背景 + 图标 + 标题 */}
        <div
          className={cn(
            'flex items-center gap-2 px-3 py-2 text-xs font-semibold',
            resolved ? 'bg-emerald-500/8 text-emerald-600' : 'bg-primary/8 text-primary',
          )}
        >
          {resolved ? (
            <CheckCircle2 className="size-3.5" aria-hidden="true" />
          ) : (
            <AlertTriangle className="size-3.5" aria-hidden="true" />
          )}
          <span>{title}</span>
        </div>

        {/* 内容 */}
        {message.content ? (
          <div
            className={cn(
              'prose prose-sm max-w-none px-3 py-2.5',
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
          <div className="mx-3 mb-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-700 dark:text-emerald-300">
            已决策：{message.checkpointResolved}
          </div>
        ) : (
          /* 未解决：渲染操作按钮（顶部加分隔线）*/
          <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 px-3 py-2">
            {options.map((opt) => (
              <Button
                key={opt.action}
                type="button"
                variant={opt.variant}
                size="sm"
                disabled={resolved}
                onClick={() => onResolve(opt.action)}
                className="active:scale-[0.96] transition-transform"
              >
                {opt.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </motion.article>
  )
}
