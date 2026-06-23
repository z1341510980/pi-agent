import { useState } from 'react'
import { ChevronDown, Loader2, Wrench } from 'lucide-react'
import type { ToolCallInfo } from './types'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export interface ToolCallCardProps {
  toolCall: ToolCallInfo
}

/** 状态标签配置（移除三色方案，改用 Badge 变体） */
const STATUS_META = {
  pending: { label: '等待', variant: 'secondary' as const },
  running: { label: '执行中', variant: 'default' as const },
  success: { label: '完成', variant: 'outline' as const },
  error: { label: '失败', variant: 'destructive' as const },
}

/**
 * ToolCallCard：工具调用卡片
 *
 * 白色圆角卡片，顶部展示工具图标、名称与状态 badge
 * 中间折叠显示参数/结果摘要，底部展示元信息与查看详情
 */
export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const { toolName, status, args, partialResult, startedAt, endedAt } = toolCall
  const [expanded, setExpanded] = useState(false)

  const meta = STATUS_META[status] ?? STATUS_META.pending

  // 计算耗时
  const duration =
    startedAt && endedAt
      ? ((endedAt - startedAt) / 1000).toFixed(1) + 's'
      : startedAt && status === 'running'
        ? '...'
        : null

  // 参数摘要：展示关键参数值（便于在卡片底部一眼看到文件/目标）
  const argsSummary =
    args === undefined
      ? null
      : typeof args === 'string'
        ? args.slice(0, 80)
        : Object.values(args as Record<string, unknown>)
            .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
            .join(', ')
            .slice(0, 80)

  // 结果摘要
  const resultSummary =
    partialResult === undefined
      ? null
      : typeof partialResult === 'string'
        ? partialResult.slice(0, 120)
        : JSON.stringify(partialResult).slice(0, 120)

  const hasDetails = args !== undefined || partialResult !== undefined

  return (
    <div className={cn(
      'rounded-lg border border-border bg-background text-xs',
      'dark:bg-surface-1',
    )}>
      {/* 顶部标题行：图标 + 工具名 + 状态 badge */}
      <button
        type="button"
        onClick={() => hasDetails && setExpanded(!expanded)}
        className={cn(
          'flex w-full items-center gap-2 px-3.5 py-2.5 text-left',
          hasDetails && 'hover:bg-muted/50 dark:hover:bg-surface-2/50',
        )}
      >
        <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono font-medium text-foreground truncate">
          {toolName}
        </span>
        <Badge
          variant={meta.variant}
          className="ml-auto shrink-0"
        >
          {status === 'running' && (
            <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
          )}
          {meta.label}
        </Badge>
      </button>

      {/* 中间：参数/结果摘要 */}
      {hasDetails && expanded && (
        <div className="border-t border-border/60 px-3.5 py-2.5 space-y-2">
          {args !== undefined && (
            <div>
              <div className="mb-1 text-[11px] text-muted-foreground">参数</div>
              <pre className="max-h-32 overflow-auto rounded bg-muted/50 p-2 text-[11px] text-foreground/90">
                {typeof args === 'string' ? args : JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {partialResult !== undefined && (
            <div>
              <div className="mb-1 text-[11px] text-muted-foreground">结果</div>
              <pre className="max-h-40 overflow-auto rounded bg-muted/50 p-2 text-[11px] text-foreground/90">
                {typeof partialResult === 'string'
                  ? partialResult
                  : JSON.stringify(partialResult, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* 底部：元信息 + 查看详情 */}
      <div className={cn(
        'flex items-center gap-3 border-t border-border/60 px-3.5 py-1.5',
        'text-[11px] text-muted-foreground',
      )}>
        {hasDetails ? (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 hover:text-foreground"
          >
            <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
            {expanded ? '收起详情' : '查看详情'}
          </button>
        ) : (
          <span>无详情</span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {argsSummary && !expanded && (
            <span className="truncate max-w-[180px]" title="参数">{argsSummary}</span>
          )}
          {resultSummary && !expanded && (
            <span className="truncate max-w-[180px]" title="结果">{resultSummary}</span>
          )}
          {duration && (
            <span>⏱ {duration}</span>
          )}
        </div>
      </div>
    </div>
  )
}
