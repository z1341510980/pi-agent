import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { motion } from 'framer-motion'
import { AlertTriangle, CheckCircle2, Check, RefreshCw, XCircle, PenLine, ArrowRightLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ConversationMessage } from './types'

export interface CheckpointMessageProps {
  message: ConversationMessage
  /** 决策回调；comment 为卡片内修改意见（可选，随决策一并提交）。返回 promise 时组件会跟踪提交完成 */
  onResolve: (action: string, comment?: string) => void | Promise<void>
  /**
   * 是否显示修改意见输入框（默认 true）。
   * discussion 检查点传 false：decision 端点只对 workflow 分支消费 userMessages，
   * 群聊分支会静默丢弃意见，保留输入框只会误导用户（反馈走底部插话输入）。
   */
  allowComment?: boolean
}

/** checkpointType → 标题 */
const CHECKPOINT_TITLES: Record<NonNullable<ConversationMessage['checkpointType']>, string> = {
  narrative_task: '叙事确认',
  review: '验收确认',
  discussion_pause: '主持人暂停',
  arrange_review: 'AI 编排确认',
  post_write_guard: '守护触发',
  writer_pushback: '写作推回',
  guard_degraded: '守护降级',
  chapter_budget: '成本闸门',
}

/** action → 图标映射 */
const ACTION_ICONS: Record<string, typeof Check> = {
  approve: Check,
  revise: PenLine,
  rewrite: RefreshCw,
  reject: XCircle,
}

/** variant → 卡片样式 */
const VARIANT_CARD_STYLES: Record<string, string> = {
  default: 'border-primary/30 hover:border-primary/60 hover:bg-primary/5 text-primary',
  outline: 'border-border hover:border-text-secondary/50 hover:bg-surface-2 text-text',
  destructive: 'border-destructive/30 hover:border-destructive/60 hover:bg-destructive/5 text-destructive',
  ghost: 'border-border/60 hover:border-border hover:bg-surface-2 text-text-secondary',
}

/** variant → 已选中样式 */
const VARIANT_SELECTED_STYLES: Record<string, string> = {
  default: 'border-primary/50 bg-primary/8 text-primary',
  outline: 'border-emerald-500/50 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300',
  destructive: 'border-destructive/40 bg-destructive/8 text-destructive',
  ghost: 'border-emerald-500/40 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300',
}

/** 判断 onResolve 调用链是否返回可跟踪的 promise（async 提交链在运行时返回 Promise） */
function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as PromiseLike<unknown>).then === 'function'
  )
}

/**
 * CheckpointMessage：检查点决策卡片
 *
 * - 居中卡片，左侧主色边框
 * - 显示 checkpointType 标题 + Markdown 内容
 * - 未解决：渲染卡片式决策选项组（每个选项带图标 + 标题 + 说明）
 * - 已解决：高亮已选卡片，其余淡化
 * - 提交中（in-flight）：任一选项点击后禁用全部选项与修改意见输入，
 *   防止重复提交（onResolve 返回 promise 时跟踪完成，失败自动解锁可重试）
 */
export function CheckpointMessage({ message, onResolve, allowComment = true }: CheckpointMessageProps) {
  const resolved = !!message.checkpointResolved
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const title = message.checkpointType
    ? CHECKPOINT_TITLES[message.checkpointType]
    : '检查点确认'
  const options = message.checkpointOptions ?? []

  const handleResolve = (action: string) => {
    if (submitting) return
    const result = onResolve(action, comment.trim() || undefined)
    // 一次性锁：点击即锁。onResolve 为 async 调用链时跟踪 promise（完成/失败后解锁）；
    // 否则维持锁定，直到决策成功（checkpointResolved 更新）或组件卸载自然失效。
    setSubmitting(true)
    if (isPromiseLike(result)) {
      // 提交链自身负责错误呈现（如 submitCheckpoint 内部 setError），这里只负责解锁
      void result.finally(() => setSubmitting(false)).catch(() => {})
    }
  }

  return (
    <motion.article
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="flex justify-center"
    >
      <div
        className={cn(
          'w-full max-w-[92%] overflow-hidden rounded-lg border bg-card shadow-sm',
          'border-l-[3px]',
          resolved
            ? 'border-emerald-500/30 border-l-emerald-500'
            : 'border-amber-500/30 border-l-primary',
        )}
        role="alertdialog"
        aria-label={title}
      >
        {/* 标题行 */}
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
          {resolved && (
            <span className="ml-auto text-[10px] font-normal text-emerald-600/80">
              已决策
            </span>
          )}
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

        {/* 修改意见输入（对话化交互形态 §3.2）：可选，随决策一并提交给下一个 Agent；
            已决策后隐藏；discussion 检查点（allowComment=false）不渲染——
            decision 端点群聊分支不消费意见，反馈应走底部插话输入 */}
        {!resolved && allowComment && (
          <div className="px-3 pt-1.5">
            <input
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              disabled={submitting}
              placeholder="修改意见（可选）：随决策一并发给下一个 Agent"
              aria-label="检查点修改意见"
              className={cn(
                'w-full rounded-md border border-border bg-input-bg px-2.5 py-1.5',
                'text-xs leading-relaxed text-text placeholder:text-hint',
                'focus-visible:outline-none focus-visible:border-primary',
              )}
            />
          </div>
        )}

        {/* 决策选项：卡片式按钮组 */}
        <div className="border-t border-border/60 px-3 py-2.5">
          <div className="grid gap-1.5" style={{ gridTemplateColumns: options.length <= 3 ? `repeat(${options.length}, 1fr)` : 'repeat(2, 1fr)' }}>
            {options.map((opt) => {
              const Icon = ACTION_ICONS[opt.action] ?? ArrowRightLeft
              const isSelected = resolved && message.checkpointResolved === opt.action
              const isDimmed = resolved && !isSelected

              return (
                <button
                  key={opt.action}
                  type="button"
                  disabled={resolved || submitting}
                  onClick={() => handleResolve(opt.action)}
                  className={cn(
                    'group flex flex-col items-start gap-1 rounded-lg border px-2.5 py-2 text-left',
                    'transition-all duration-150 ease-out',
                    !resolved && 'cursor-pointer active:scale-[0.97]',
                    !resolved && (VARIANT_CARD_STYLES[opt.variant] ?? VARIANT_CARD_STYLES.ghost),
                    isSelected && (VARIANT_SELECTED_STYLES[opt.variant] ?? VARIANT_SELECTED_STYLES.outline),
                    isDimmed && 'border-border/40 bg-transparent text-muted-foreground/50 opacity-50',
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="text-xs font-medium leading-none">{opt.label}</span>
                    {isSelected && (
                      <CheckCircle2 className="size-3 ml-auto text-emerald-500" aria-hidden="true" />
                    )}
                  </span>
                  {opt.description && (
                    <span className={cn(
                      'text-[10px] leading-snug',
                      isSelected ? 'text-emerald-600/70 dark:text-emerald-400/70' : 'text-muted-foreground/70',
                    )}>
                      {opt.description}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </motion.article>
  )
}
