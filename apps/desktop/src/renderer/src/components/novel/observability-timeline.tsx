/**
 * 调用趋势视图（观测 timeline + Agent 汇总）
 *
 * 纯 CSS 条形展示最近 N 次模型调用的输入+缓存读 token 量与命中率，
 * 不引入图表库。失败调用以红色条呈现。
 * 弹窗内容分上下两段：上段 timeline 条形列表，下段按 Agent 分组汇总
 * （调用次数/成功率/命中率/平均耗时/最近错误）。
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { Activity, Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { getObservabilityTimeline, getObservabilityAgents, type ObservabilityAgentRow } from '@/api/novel-client'

const AGENT_COLORS: Record<string, string> = {
  director: 'bg-blue-500',
  writer: 'bg-emerald-500',
  reviewer: 'bg-orange-500',
  reviser: 'bg-purple-500',
  memory: 'bg-gray-500',
}

export function ObservabilityTimeline(): ReactElement {
  const projectId = useNovelDataStore((s) => s.currentProjectId)
  const q = useQuery({
    queryKey: ['novel-observability-timeline', projectId],
    queryFn: () => getObservabilityTimeline(projectId!, { limit: 50 }),
    enabled: !!projectId,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  })
  const agentsQuery = useQuery({
    queryKey: ['novel-observability-agents', projectId],
    queryFn: () => getObservabilityAgents(projectId!),
    enabled: !!projectId,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  })
  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
        请先选择项目
      </div>
    )
  }
  const rows = q.data ?? []
  const max = Math.max(1, ...rows.map((r) => r.inputTokens + r.cacheReadTokens))
  return (
    <div className="flex h-full flex-col bg-surface-1">
      {/* 上段：调用趋势条形列表 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
          <Activity className="size-4 text-primary" />
          <span className="text-sm font-semibold text-text">调用趋势</span>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-1">
          {rows.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {q.isLoading ? '加载中...' : '暂无调用数据'}
            </div>
          ) : (
            rows.map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-nano">
                <span className="w-14 shrink-0 text-muted-foreground tabular-nums">第{r.chapterNumber}章</span>
                <span className="w-12 shrink-0 truncate text-text-secondary" title={r.phase}>
                  {AGENT_LABEL(r.agentType)}
                </span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full transition-[width] duration-300',
                      r.status === 'success' ? (AGENT_COLORS[r.agentType] ?? 'bg-primary') : 'bg-destructive',
                    )}
                    style={{ width: `${((r.inputTokens + r.cacheReadTokens) / max) * 100}%` }}
                  />
                </div>
                <span className="w-12 shrink-0 text-right text-muted-foreground tabular-nums">
                  {r.cacheHitRate != null ? `${(r.cacheHitRate * 100).toFixed(0)}%` : '—'}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
      {/* 下段：Agent 汇总 */}
      <ObservabilityAgentSummary rows={agentsQuery.data ?? []} isLoading={agentsQuery.isLoading} />
    </div>
  )
}

/** Agent 汇总表（flex 行实现，不引入表格组件） */
function ObservabilityAgentSummary({
  rows,
  isLoading,
}: {
  rows: ObservabilityAgentRow[]
  isLoading: boolean
}): ReactElement {
  return (
    <div className="flex max-h-[38%] shrink-0 flex-col border-t border-border">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
        <Bot className="size-4 text-primary" />
        <span className="text-sm font-semibold text-text">Agent 汇总</span>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 px-3 py-2 space-y-1">
        {rows.length === 0 ? (
          <div className="flex h-full min-h-10 items-center justify-center text-xs text-muted-foreground">
            {isLoading ? '加载中...' : '暂无 Agent 统计'}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-nano text-muted-foreground">
              <span className="w-12 shrink-0">Agent</span>
              <span className="w-10 shrink-0 text-right">调用</span>
              <span className="w-12 shrink-0 text-right">成功率</span>
              <span className="w-12 shrink-0 text-right">命中率</span>
              <span className="w-14 shrink-0 text-right">平均耗时</span>
              <span className="flex-1 min-w-0 truncate">最近错误</span>
            </div>
            {rows.map((r) => (
              <div key={r.agentType} className="flex items-center gap-2 text-nano">
                <span className="w-12 shrink-0 truncate text-text-secondary">{AGENT_LABEL(r.agentType)}</span>
                <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">{r.calls}</span>
                <span className="w-12 shrink-0 text-right tabular-nums">{(r.successRate * 100).toFixed(0)}%</span>
                <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
                  {r.cacheHitRate != null ? `${(r.cacheHitRate * 100).toFixed(0)}%` : '—'}
                </span>
                <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                  {r.avgDurationMs != null ? formatDuration(r.avgDurationMs) : '—'}
                </span>
                {r.lastError ? (
                  <span className="flex-1 min-w-0 truncate text-danger" title={r.lastError}>
                    {r.lastError}
                  </span>
                ) : (
                  <span className="flex-1 min-w-0 truncate text-muted-foreground">—</span>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

/** 格式化耗时：<1s 显示 ms，<1min 显示秒（一位小数），否则显示分秒 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s}s`
}

function AGENT_LABEL(agentType: string): string {
  const labels: Record<string, string> = {
    director: '导演',
    writer: '写作',
    reviewer: '审稿',
    reviser: '修订',
    memory: '记忆',
  }
  return labels[agentType] ?? agentType
}
