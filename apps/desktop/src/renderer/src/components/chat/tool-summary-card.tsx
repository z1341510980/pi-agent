import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, Layers } from 'lucide-react'
import type { ToolCallInfo } from './types'
import { ToolCallCard } from './tool-call-card'
import { cn } from '@/lib/utils'

export interface ToolSummaryCardProps {
  /** 需要合并展示的工具调用列表 */
  toolCalls: ToolCallInfo[]
}

/**
 * ToolSummaryCard：连续工具调用合并卡片
 *
 * 当 assistant 消息中 toolCalls.length >= 3 时使用，减少视觉噪声：
 *   - 折叠态：图标 + "调用了 N 个工具" + 状态计数
 *   - 展开态：依次展示每个 ToolCallCard
 *
 * 流式中（存在 running 工具）默认展开，便于观察进度；
 * 全部完成后默认折叠，便于回顾。
 */
export function ToolSummaryCard({ toolCalls }: ToolSummaryCardProps) {
  const hasRunning = toolCalls.some((tc) => tc.status === 'running')
  const [expanded, setExpanded] = useState(hasRunning)

  // 状态统计
  const successCount = toolCalls.filter((tc) => tc.status === 'success').length
  const errorCount = toolCalls.filter((tc) => tc.status === 'error').length
  const runningCount = toolCalls.filter((tc) => tc.status === 'running').length
  const totalCount = toolCalls.length

  // 总耗时（首尾工具的 startedAt/endedAt 范围）
  const firstStart = toolCalls
    .map((tc) => tc.startedAt)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b)[0]
  const lastEnd = toolCalls
    .map((tc) => tc.endedAt)
    .filter((v): v is number => v != null)
    .sort((a, b) => b - a)[0]
  const totalDurationMs =
    firstStart && lastEnd ? lastEnd - firstStart : null
  const durationLabel =
    totalDurationMs != null && totalDurationMs >= 0
      ? totalDurationMs < 1000
        ? `${totalDurationMs}ms`
        : `${(totalDurationMs / 1000).toFixed(1)}s`
      : null

  // 摘要：状态计数
  const summaryParts: string[] = []
  if (successCount > 0) summaryParts.push(`成功 ${successCount}`)
  if (errorCount > 0) summaryParts.push(`失败 ${errorCount}`)
  if (runningCount > 0) summaryParts.push(`进行中 ${runningCount}`)
  const summary = summaryParts.join(' · ')

  return (
    <div className={cn(
      'rounded-lg border border-border bg-background overflow-hidden',
      'dark:bg-surface-1',
    )}>
      {/* 折叠态标题 */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-muted/50 dark:hover:bg-surface-2/50 transition-colors"
        aria-expanded={expanded}
      >
        <span className="flex size-5 items-center justify-center rounded-md bg-primary/10 text-primary" aria-hidden="true">
          <Layers className="size-3" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-text">
            调用了 {totalCount} 个工具
          </div>
          {summary && (
            <div className="mt-0.5 text-[11px] text-hint truncate">
              {summary}
            </div>
          )}
        </div>
        {durationLabel && (
          <span className="shrink-0 text-[11px] text-hint">
            ⏱ {durationLabel}
          </span>
        )}
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-hint transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {/* 展开态：依次渲染工具卡片 */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="tool-list"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden border-t border-border/60"
          >
            <div className="p-2 space-y-1.5">
              {toolCalls.map((tc) => (
                <ToolCallCard key={tc.toolCallId} toolCall={tc} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
