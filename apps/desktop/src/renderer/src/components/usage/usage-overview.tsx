import type { ReactElement } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, DollarSign, Hash, Database } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface UsageSummary {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalCostUsd: number
  totalCalls: number
  byModel: Record<
    string,
    { calls: number; costUsd: number; inputTokens: number; outputTokens: number }
  >
  byAgent: Record<string, { calls: number; costUsd: number }>
}

export interface UsageOverviewProps {
  summary: UsageSummary | undefined
  isLoading: boolean
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
    <div className="bg-surface-2 border border-border rounded-lg grid gap-1 p-3">
      <div className="flex items-center gap-1.5">
        <span className={cn('size-3.5', accent ? 'text-accent' : 'text-muted-foreground')}>
          {icon}
        </span>
        <p className="text-subtle text-xs font-[760] m-0">{label}</p>
      </div>
      <strong className={cn('font-[780] leading-tight text-lg', accent && 'text-accent')}>
        {value}
      </strong>
      {sublabel && <p className="text-muted text-[10px] m-0">{sublabel}</p>}
    </div>
  )
}

export function UsageOverview({ summary, isLoading }: UsageOverviewProps): ReactElement {
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
          <div key={i} className="bg-surface-2 border border-border rounded-lg p-3 animate-pulse">
            <div className="h-3 bg-muted/30 rounded w-12 mb-2" />
            <div className="h-5 bg-muted/30 rounded w-16" />
          </div>
        ))}
      </div>
    )
  }

  return (
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
  )
}
