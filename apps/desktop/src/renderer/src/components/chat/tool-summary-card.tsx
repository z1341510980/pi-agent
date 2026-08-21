import { useState } from 'react'
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
    <div className="flex min-w-0 flex-col">
      {/* 折叠态标题（dsh ToolRow 风格：单行、无卡片边框） */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="dsh-sweep-host -mx-1 flex w-[calc(100%+8px)] items-center rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent"
        data-running={hasRunning ? 'true' : undefined}
        aria-expanded={expanded}
      >
        <span className="relative mr-1.5 inline-flex size-4 shrink-0 items-center justify-center text-subtle" aria-hidden="true">
          <Layers className="size-3.5" />
        </span>
        <span className="shrink-0 text-sm leading-6 text-text-secondary">
          调用了 {totalCount} 个工具
        </span>
        {durationLabel && (
          <span className="ml-2 shrink-0 font-mono text-[11px] text-hint">{durationLabel}</span>
        )}
        {summary && (
          <>
            <span className="mx-2 size-0.5 shrink-0 rounded-full bg-hint" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-sm leading-6 text-subtle">{summary}</span>
          </>
        )}
        <ChevronDown
          className={cn(
            'ml-auto h-3.5 w-3.5 shrink-0 text-hint transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {/* 展开态：依次渲染工具行 */}
      {expanded && (
        <div className="mt-1 space-y-1 pl-1">
          {toolCalls.map((tc) => (
            <ToolCallCard key={tc.toolCallId} toolCall={tc} />
          ))}
        </div>
      )}
    </div>
  )
}
