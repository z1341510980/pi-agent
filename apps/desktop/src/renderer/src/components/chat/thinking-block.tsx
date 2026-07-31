import { ChevronDown, Clock } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { ThinkingBlock as ThinkingBlockData } from './types'
import { cn } from '@/lib/utils'

export interface ThinkingBlockProps extends ThinkingBlockData {}

/** 格式化耗时（ms → 可读字符串） */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return `${minutes}m${seconds}s`
}

/**
 * ThinkingBlock：思考状态卡片（可折叠）
 *
 * 显示 REASONING_/THINKING_ 事件的内容
 * 流式时默认展开，完成后默认折叠
 * 紫色圆点 + 耗时标识
 */
export function ThinkingBlock({ content, isStreaming, startedAt, endedAt }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(isStreaming)

  // 流式时实时刷新耗时
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!isStreaming) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [isStreaming])

  // 标题
  const title = isStreaming ? '正在分析你的需求' : '分析完成'

  // 描述：内容首行 或 默认提示
  const description =
    content.trim().split('\n')[0] ||
    (isStreaming ? '正在整理推理步骤…' : '已生成思考过程')

  // 耗时
  const durationMs = startedAt
    ? (endedAt ?? now) - startedAt
    : null
  const durationLabel =
    durationMs != null && durationMs >= 0 ? formatDuration(durationMs) : null

  return (
    <div className={cn(
      'rounded-lg border border-border bg-background',
      'dark:bg-surface-1',
    )}>
      <motion.button
        type="button"
        onClick={() => setExpanded(!expanded)}
        whileTap={{ scale: 0.96 }}
        transition={{ duration: 0.1 }}
        className={cn(
          'flex w-full items-start gap-3 px-3.5 py-2.5 text-left',
          'hover:bg-muted/50 dark:hover:bg-surface-2/50',
        )}
      >
        {/* 紫色状态圆点 */}
        <span className={cn(
          'mt-1.5 size-2 shrink-0 rounded-full bg-purple-500',
          isStreaming && 'animate-pulse',
        )} />

        {/* 标题与描述 */}
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-text">
            {title}
          </div>
          <div className={cn(
            'mt-0.5 text-[11px] text-muted-foreground',
            'line-clamp-1',
          )}>
            {expanded ? '点击折叠详情' : description}
          </div>
        </div>

        {/* 耗时标识 */}
        {durationLabel && (
          <span className="mt-0.5 flex items-center gap-1 shrink-0 text-[11px] text-muted-foreground">
            <Clock className="size-3" />
            {durationLabel}
          </span>
        )}

        <ChevronDown
          className={cn(
            'mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </motion.button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="thinking-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden border-t border-border/60"
          >
            <div className="px-3.5 py-2.5">
              <pre className="whitespace-pre-wrap text-xs text-foreground/90 font-mono">
                {content}
              </pre>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
