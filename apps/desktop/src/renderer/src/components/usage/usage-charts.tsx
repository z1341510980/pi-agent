import type { ReactElement } from 'react'
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
import type { UsageSummary } from './usage-overview'

export interface UsageChartsProps {
  summary: UsageSummary | undefined
  isLoading: boolean
}

/** 将 byModel 转为柱状图数据 */
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

/** 构造模拟趋势数据（按模型分日成本） */
function buildTrendData(
  summary: UsageSummary
): Array<{ date: string; cost: number; input: number; output: number }> {
  // 后端暂不提供按日数据，这里用汇总构造单点趋势
  // 后续可对接 GET /api/usage?from=...&to=... 按日聚合
  const now = new Date()
  const today = `${now.getMonth() + 1}/${now.getDate()}`
  return [
    {
      date: today,
      cost: Number(summary.totalCostUsd.toFixed(4)),
      input: summary.totalInputTokens,
      output: summary.totalOutputTokens
    }
  ]
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

export function UsageCharts({ summary, isLoading }: UsageChartsProps): ReactElement {
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
          <p className="text-muted text-xs">暂无图表数据</p>
        </div>
      </div>
    )
  }

  const trendData = buildTrendData(summary)
  const modelData = buildModelChartData(summary.byModel)

  return (
    <div className="grid gap-2.5">
      {/* 成本趋势折线图 */}
      <div className="bg-surface-2 border border-border rounded-lg grid gap-2 p-3">
        <p className="text-subtle text-xs font-[760] m-0">成本趋势</p>
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
    </div>
  )
}
