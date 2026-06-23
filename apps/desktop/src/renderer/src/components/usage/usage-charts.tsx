import { useMemo, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  BarChart,
  Bar,
  Legend
} from 'recharts'
import { getApi } from '@/api'
import type { UsageSummary } from './usage-overview'

interface DailyUsagePoint {
  date: string
  costUsd: number
  inputTokens: number
  outputTokens: number
  calls: number
}

/** 按 Provider 聚合的统计项 */
interface ProviderUsageStat {
  calls: number
  costUsd: number
  inputTokens: number
  outputTokens: number
}

/** 按模型聚合的统计项 */
interface ModelUsageStat {
  calls: number
  costUsd: number
  inputTokens: number
  outputTokens: number
}

export interface UsageChartsProps {
  summary: UsageSummary | undefined
  isLoading: boolean
  isOnline: boolean
}

/** 聚合粒度 */
type TrendGranularity = 'day' | 'week' | 'month'

/** 将 byModel 转为柱状图数据（来自 summary） */
function buildModelChartData(byModel: UsageSummary['byModel']): Array<{
  model: string
  costUsd: number
  calls: number
  inputTokens: number
  outputTokens: number
}> {
  return Object.entries(byModel).map(([model, data]) => ({
    model: model.length > 20 ? `${model.slice(0, 18)}…` : model,
    costUsd: Number(data.costUsd.toFixed(4)),
    calls: data.calls,
    inputTokens: data.inputTokens,
    outputTokens: data.outputTokens
  }))
}

/** 将 byAgent 转为柱状图数据（按成本降序） */
function buildAgentChartData(byAgent: UsageSummary['byAgent']): Array<{
  agent: string
  costUsd: number
  calls: number
}> {
  return Object.entries(byAgent)
    .map(([agent, data]) => ({
      agent: agent.length > 16 ? `${agent.slice(0, 14)}…` : agent,
      costUsd: Number(data.costUsd.toFixed(4)),
      calls: data.calls
    }))
    .sort((a, b) => b.costUsd - a.costUsd)
}

/** 将 byProvider 转为柱状图数据（按成本降序） */
function buildProviderChartData(
  byProvider: Record<string, ProviderUsageStat> | undefined,
): Array<{ provider: string; costUsd: number; calls: number; inputTokens: number; outputTokens: number }> {
  if (!byProvider) return []
  return Object.entries(byProvider)
    .map(([provider, data]) => ({
      provider: provider.length > 16 ? `${provider.slice(0, 14)}…` : provider,
      costUsd: Number(data.costUsd.toFixed(4)),
      calls: data.calls,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
    }))
    .sort((a, b) => b.costUsd - a.costUsd)
}

/** 将 byModel（来自 by-model 端点）转为柱状图数据 */
function buildByModelChartData(
  byModel: Record<string, ModelUsageStat> | undefined,
): Array<{ model: string; costUsd: number; calls: number; inputTokens: number; outputTokens: number }> {
  if (!byModel) return []
  return Object.entries(byModel)
    .map(([model, data]) => ({
      model: model.length > 20 ? `${model.slice(0, 18)}…` : model,
      costUsd: Number(data.costUsd.toFixed(4)),
      calls: data.calls,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
    }))
    .sort((a, b) => b.costUsd - a.costUsd)
}

/**
 * 按指定粒度聚合按日用量数据
 * - day: 直接返回按日数据
 * - week: 按周聚合（以周一为起始）
 * - month: 按月聚合（YYYY-MM）
 */
function aggregateTrend(
  daily: DailyUsagePoint[] | undefined,
  granularity: TrendGranularity,
): Array<{ date: string; cost: number; input: number; output: number }> {
  if (!daily || daily.length === 0) return []

  if (granularity === 'day') {
    return daily.map((d) => {
      const [, month, day] = d.date.split('-')
      return {
        date: `${Number(month)}/${Number(day)}`,
        cost: Number(d.costUsd.toFixed(4)),
        input: d.inputTokens,
        output: d.outputTokens,
      }
    })
  }

  // 周/月聚合：使用 Map 按聚合键累加
  const aggregated = new Map<
    string,
    { cost: number; input: number; output: number; sortKey: string }
  >()

  for (const d of daily) {
    const date = new Date(d.date)
    let key: string
    let sortKey: string

    if (granularity === 'week') {
      // 计算所在周的周一日期
      const dayOfWeek = date.getDay() // 0=周日, 1=周一
      const offset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
      const monday = new Date(date)
      monday.setDate(date.getDate() + offset)
      const y = monday.getFullYear()
      const m = String(monday.getMonth() + 1).padStart(2, '0')
      const dd = String(monday.getDate()).padStart(2, '0')
      key = `${m}/${dd}`
      sortKey = `${y}-${m}-${dd}`
    } else {
      // month
      const y = date.getFullYear()
      const m = String(date.getMonth() + 1).padStart(2, '0')
      key = `${y}/${m}`
      sortKey = `${y}-${m}`
    }

    const entry = aggregated.get(key) ?? { cost: 0, input: 0, output: 0, sortKey }
    entry.cost += d.costUsd
    entry.input += d.inputTokens
    entry.output += d.outputTokens
    aggregated.set(key, entry)
  }

  // 按 sortKey 升序返回
  return Array.from(aggregated.entries())
    .sort((a, b) => a[1].sortKey.localeCompare(b[1].sortKey))
    .map(([date, v]) => ({
      date,
      cost: Number(v.cost.toFixed(4)),
      input: v.input,
      output: v.output,
    }))
}

function CostTooltip({
  active,
  payload,
  label
}: {
  active?: boolean
  payload?: Array<{ value: number; name: string; color: string }>
  label?: string
}): ReactElement | null {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-xs shadow-lg">
      <p className="font-[760] mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="m-0" style={{ color: p.color }}>
          {p.name}: {p.name === 'cost' ? `$${p.value.toFixed(4)}` : p.value.toLocaleString()}
        </p>
      ))}
    </div>
  )
}

function ModelTooltip({
  active,
  payload,
  label
}: {
  active?: boolean
  payload?: Array<{ value: number; name: string; color: string }>
  label?: string
}): ReactElement | null {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-xs shadow-lg">
      <p className="font-[760] mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="m-0" style={{ color: p.color }}>
          {p.name === 'costUsd' ? '成本' : p.name === 'calls' ? '调用' : p.name}:{' '}
          {p.name === 'costUsd' ? `$${p.value.toFixed(4)}` : p.value.toLocaleString()}
        </p>
      ))}
    </div>
  )
}

export function UsageCharts({ summary, isLoading, isOnline }: UsageChartsProps): ReactElement {
  const [days, setDays] = useState(7)
  const [granularity, setGranularity] = useState<TrendGranularity>('day')

  // 根据粒度切换自动调整 days 范围
  const effectiveDays = useMemo(() => {
    if (granularity === 'week') return 30
    if (granularity === 'month') return 90
    return days
  }, [granularity, days])

  // 按 Provider 聚合
  const providerQuery = useQuery({
    queryKey: ['usage-by-provider'],
    queryFn: () => getApi<Record<string, ProviderUsageStat>>('/api/usage/by-provider'),
    refetchInterval: 30_000,
    enabled: isOnline
  })

  // 按模型聚合（使用专用端点获取更完整数据）
  const byModelQuery = useQuery({
    queryKey: ['usage-by-model'],
    queryFn: () => getApi<Record<string, ModelUsageStat>>('/api/usage/by-model'),
    refetchInterval: 30_000,
    enabled: isOnline
  })

  // 按日用量数据（粒度切换时自动调整查询范围）
  const dailyQuery = useQuery({
    queryKey: ['usage-daily', effectiveDays],
    queryFn: () => getApi<DailyUsagePoint[]>(`/api/usage/daily?days=${effectiveDays}`),
    refetchInterval: 30_000,
    enabled: isOnline
  })

  if (isLoading) {
    return (
      <div className="grid gap-2.5">
        <div className="bg-surface-2 border border-border rounded-lg p-3 animate-pulse">
          <div className="h-3 bg-muted/30 rounded w-24 mb-3" />
          <div className="h-[160px] bg-muted/20 rounded" />
        </div>
        <div className="bg-surface-2 border border-border rounded-lg p-3 animate-pulse">
          <div className="h-3 bg-muted/30 rounded w-24 mb-3" />
          <div className="h-[160px] bg-muted/20 rounded" />
        </div>
      </div>
    )
  }

  if (!summary) {
    return (
      <div className="grid gap-2.5">
        <div className="bg-surface-2 border border-border rounded-lg p-3">
          <p className="text-muted-foreground text-xs">暂无图表数据</p>
        </div>
      </div>
    )
  }

  const trendData = aggregateTrend(dailyQuery.data, granularity)
  const summaryModelData = buildModelChartData(summary.byModel)
  const byModelData = buildByModelChartData(byModelQuery.data)
  const modelData = byModelData.length > 0 ? byModelData : summaryModelData
  const agentData = buildAgentChartData(summary.byAgent)
  const providerData = buildProviderChartData(providerQuery.data)

  return (
    <div className="grid gap-2.5">
      {/* 成本趋势折线图 */}
      <div className="bg-surface-2 border border-border rounded-lg grid gap-2 p-3">
        <div className="flex items-center justify-between flex-wrap gap-1">
          <p className="text-subtle text-xs font-[760] m-0">成本趋势</p>
          <div className="flex items-center gap-1">
            {/* 粒度切换 */}
            <button
              className={`px-2 py-0.5 text-xs rounded ${granularity === 'day' ? 'bg-accent/10 text-accent' : 'text-muted-foreground'}`}
              onClick={() => setGranularity('day')}
            >
              日
            </button>
            <button
              className={`px-2 py-0.5 text-xs rounded ${granularity === 'week' ? 'bg-accent/10 text-accent' : 'text-muted-foreground'}`}
              onClick={() => setGranularity('week')}
            >
              周
            </button>
            <button
              className={`px-2 py-0.5 text-xs rounded ${granularity === 'month' ? 'bg-accent/10 text-accent' : 'text-muted-foreground'}`}
              onClick={() => setGranularity('month')}
            >
              月
            </button>
            <span className="text-muted-foreground/40 mx-0.5">|</span>
            {/* 仅在日粒度下显示天数切换 */}
            <button
              className={`px-2 py-0.5 text-xs rounded ${granularity === 'day' && days === 7 ? 'bg-accent/10 text-accent' : 'text-muted-foreground'}`}
              onClick={() => {
                setGranularity('day')
                setDays(7)
              }}
              disabled={granularity !== 'day'}
            >
              7天
            </button>
            <button
              className={`px-2 py-0.5 text-xs rounded ${granularity === 'day' && days === 30 ? 'bg-accent/10 text-accent' : 'text-muted-foreground'}`}
              onClick={() => {
                setGranularity('day')
                setDays(30)
              }}
              disabled={granularity !== 'day'}
            >
              30天
            </button>
          </div>
        </div>
        <div className="h-[160px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trendData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="rgba(255,255,255,0.3)" />
              <YAxis tick={{ fontSize: 10 }} stroke="rgba(255,255,255,0.3)" />
              <Tooltip content={<CostTooltip />} />
              <Line
                type="monotone"
                dataKey="cost"
                name="cost"
                stroke="#f2c14e"
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 按 Provider 分组柱状图 */}
      {providerData.length > 0 && (
        <div className="bg-surface-2 border border-border rounded-lg grid gap-2 p-3">
          <p className="text-subtle text-xs font-[760] m-0">Provider 明细</p>
          <div className="h-[180px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={providerData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="provider" tick={{ fontSize: 9 }} stroke="rgba(255,255,255,0.3)" />
                <YAxis tick={{ fontSize: 10 }} stroke="rgba(255,255,255,0.3)" />
                <Tooltip content={<ModelTooltip />} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar dataKey="costUsd" name="costUsd" fill="#c084fc" radius={[2, 2, 0, 0]} />
                <Bar dataKey="calls" name="calls" fill="#6ee7b7" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* 模型明细柱状图 */}
      {modelData.length > 0 && (
        <div className="bg-surface-2 border border-border rounded-lg grid gap-2 p-3">
          <p className="text-subtle text-xs font-[760] m-0">模型明细</p>
          <div className="h-[180px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={modelData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="model" tick={{ fontSize: 9 }} stroke="rgba(255,255,255,0.3)" />
                <YAxis tick={{ fontSize: 10 }} stroke="rgba(255,255,255,0.3)" />
                <Tooltip content={<ModelTooltip />} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar dataKey="costUsd" name="costUsd" fill="#f2c14e" radius={[2, 2, 0, 0]} />
                <Bar dataKey="calls" name="calls" fill="#6ee7b7" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Agent 明细柱状图 */}
      {agentData.length > 0 && (
        <div className="bg-surface-2 border border-border rounded-lg grid gap-2 p-3">
          <p className="text-subtle text-xs font-[760] m-0">Agent 明细</p>
          <div className="h-[180px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={agentData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="agent" tick={{ fontSize: 9 }} stroke="rgba(255,255,255,0.3)" />
                <YAxis tick={{ fontSize: 10 }} stroke="rgba(255,255,255,0.3)" />
                <Tooltip content={<ModelTooltip />} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar dataKey="costUsd" name="costUsd" fill="#60a5fa" radius={[2, 2, 0, 0]} />
                <Bar dataKey="calls" name="calls" fill="#6ee7b7" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  )
}
