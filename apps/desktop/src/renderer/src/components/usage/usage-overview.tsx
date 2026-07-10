import type { ReactElement } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, DollarSign, Hash, Database, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface UsageSummary {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalCostUsd: number
  totalCalls: number
  /** 最近一次 LLM 调用的输入 token 数（代表当前上下文窗口实际占用） */
  lastInputTokens: number
  byModel: Record<
    string,
    { calls: number; costUsd: number; inputTokens: number; outputTokens: number }
  >
  byAgent: Record<string, { calls: number; costUsd: number }>
}

/** 预算与当月用量信息（由 /api/usage/budget 返回） */
export interface UsageBudgetInfo {
  /** 月度预算（USD），0 表示未设置 */
  monthlyBudgetUsd: number
  /** 告警阈值（百分比 0-100） */
  alertThreshold: number
  /** 当月已用成本（USD） */
  costUsd: number
  /** 预算使用百分比（0-100+） */
  percentage: number
  /** 是否已超出预算 */
  exceeded: boolean
  /** 是否达到告警阈值 */
  warning: boolean
}

export interface UsageOverviewProps {
  summary: UsageSummary | undefined
  isLoading: boolean
  /** 预算信息（可选，传入后显示预算告警卡片） */
  budget?: UsageBudgetInfo
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`
}

interface StatCardProps {
  icon: ReactElement
  label: string
  value: string
  sublabel?: string
  accent?: boolean
}

function StatCard({ icon, label, value, sublabel, accent }: StatCardProps): ReactElement {
  return (
    <div className="bg-surface-2 rounded-lg shadow-[0_1px_2px_rgba(0,0,0,0.04),0_2px_8px_rgba(0,0,0,0.06)] grid gap-1 p-3">
      <div className="flex items-center gap-1.5">
        <span className={cn('size-3.5', accent ? 'text-accent' : 'text-muted-foreground')}>
          {icon}
        </span>
        <p className="text-subtle text-xs font-[760] m-0">{label}</p>
      </div>
      <strong className={cn('font-[780] leading-tight text-lg tabular-nums', accent && 'text-accent')}>
        {value}
      </strong>
      {sublabel && <p className="text-muted-foreground text-[10px] m-0">{sublabel}</p>}
    </div>
  )
}

export function UsageOverview({ summary, isLoading, budget }: UsageOverviewProps): ReactElement {
  const totalTokens = (summary?.totalInputTokens ?? 0) + (summary?.totalOutputTokens ?? 0)
  const cacheTotal = (summary?.totalCacheReadTokens ?? 0) + (summary?.totalCacheWriteTokens ?? 0)
  const cacheHitRate =
    totalTokens + cacheTotal > 0
      ? ((summary?.totalCacheReadTokens ?? 0) / (totalTokens + cacheTotal)) * 100
      : 0

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-2.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="bg-surface-2 rounded-lg shadow-[0_1px_2px_rgba(0,0,0,0.04),0_2px_8px_rgba(0,0,0,0.06)] p-3 animate-pulse">
            <div className="h-3 bg-muted/30 rounded w-12 mb-2" />
            <div className="h-5 bg-muted/30 rounded w-16" />
          </div>
        ))}
      </div>
    )
  }

  // 预算告警卡片（仅在设置了预算时显示）
  const showBudget = budget && budget.monthlyBudgetUsd > 0
  const budgetWarning = budget?.warning ?? false
  const budgetExceeded = budget?.exceeded ?? false

  return (
    <div className="grid gap-2.5">
      {showBudget && (budgetWarning || budgetExceeded) && (
        <div
          role="alert"
          className={cn(
            'border rounded-lg p-2.5 flex items-start gap-2 text-xs',
            budgetExceeded
              ? 'border-danger/40 bg-danger/10 text-danger'
              : 'border-warning/40 bg-warning/10 text-warning'
          )}
        >
          <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
          <div className="grid gap-0.5">
            <p className="font-[760] m-0">
              {budgetExceeded ? '预算已超出' : '预算告警'}
            </p>
            <p className="m-0 text-[11px] tabular-nums">
              当月已用 {formatCost(budget!.costUsd)} / 预算 {formatCost(budget!.monthlyBudgetUsd)}
              （{budget!.percentage.toFixed(1)}%）
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2.5">
        <StatCard
          icon={<ArrowUpFromLine className="size-3.5" />}
          label="输入 Token"
          value={formatTokens(summary?.totalInputTokens ?? 0)}
        />
        <StatCard
          icon={<ArrowDownToLine className="size-3.5" />}
          label="输出 Token"
          value={formatTokens(summary?.totalOutputTokens ?? 0)}
        />
        <StatCard
          icon={<DollarSign className="size-3.5" />}
          label="总成本"
          value={formatCost(summary?.totalCostUsd ?? 0)}
          accent
        />
        <StatCard
          icon={<Hash className="size-3.5" />}
          label="调用次数"
          value={formatTokens(summary?.totalCalls ?? 0)}
        />
        <StatCard
          icon={<Database className="size-3.5" />}
          label="缓存命中率"
          value={`${cacheHitRate.toFixed(1)}%`}
          sublabel={`读 ${formatTokens(summary?.totalCacheReadTokens ?? 0)} / 写 ${formatTokens(summary?.totalCacheWriteTokens ?? 0)}`}
        />
      </div>
    </div>
  )
}
