import { useState, type ReactElement } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { browserConfig } from '@repo/config/browser'
import { getApi, putApi, ApiClientError } from '@/api'
import { Button } from '@/components/ui/button'
import { UsageOverview, type UsageSummary, type UsageBudgetInfo } from '@/components/usage/usage-overview'
import { UsageCharts } from '@/components/usage/usage-charts'
import { UsageTable } from '@/components/usage/usage-table'

export interface UsagePanelProps {
  isOnline: boolean
}

/** 预算端点返回的数据（budget 字段 + 当月用量） */
interface BudgetResponse extends UsageBudgetInfo {
  /** 当月已用成本（与 UsageBudgetInfo.costUsd 同义，端点返回字段名） */
  costUsd: number
  /** 预算（与 monthlyBudgetUsd 同义） */
  budgetUsd: number
  /** 告警阈值 */
  threshold: number
  /** 使用百分比 */
  percentage: number
  /** 是否超出 */
  exceeded: boolean
  /** 是否告警 */
  warning: boolean
}

export function UsagePanel({ isOnline }: UsagePanelProps): ReactElement {
  const queryClient = useQueryClient()
  const [budgetInput, setBudgetInput] = useState('')
  const [thresholdInput, setThresholdInput] = useState('')
  const [budgetSaved, setBudgetSaved] = useState(false)

  const summaryQuery = useQuery({
    queryKey: ['usage-summary'],
    queryFn: () => getApi<UsageSummary>('/api/usage/summary'),
    refetchInterval: 30_000,
    enabled: isOnline
  })

  // 预算信息
  const budgetQuery = useQuery({
    queryKey: ['usage-budget'],
    queryFn: () => getApi<BudgetResponse>('/api/usage/budget'),
    refetchInterval: 30_000,
    enabled: isOnline
  })

  // 同步预算到本地输入框（首次加载时）
  if (budgetQuery.data && budgetInput === '' && thresholdInput === '' && !budgetSaved) {
    setBudgetInput(String(budgetQuery.data.monthlyBudgetUsd ?? 0))
    setThresholdInput(String(budgetQuery.data.alertThreshold ?? 80))
  }

  // 保存预算
  const budgetMutation = useMutation({
    mutationFn: (input: { monthlyBudgetUsd?: number; alertThreshold?: number }) =>
      putApi<BudgetResponse>('/api/usage/budget', input),
    onSuccess: (data) => {
      setBudgetInput(String(data.monthlyBudgetUsd ?? 0))
      setThresholdInput(String(data.alertThreshold ?? 80))
      setBudgetSaved(true)
      setTimeout(() => setBudgetSaved(false), 2000)
      void queryClient.invalidateQueries({ queryKey: ['usage-budget'] })
    }
  })

  const handleSaveBudget = () => {
    const monthly = Number(budgetInput)
    const threshold = Number(thresholdInput)
    const payload: { monthlyBudgetUsd?: number; alertThreshold?: number } = {}
    if (Number.isFinite(monthly) && monthly >= 0) {
      payload.monthlyBudgetUsd = monthly
    }
    if (Number.isFinite(threshold) && threshold >= 0 && threshold <= 100) {
      payload.alertThreshold = threshold
    }
    if (Object.keys(payload).length > 0) {
      budgetMutation.mutate(payload)
    }
  }

  // 导出 CSV：直接打开浏览器下载（不走 ApiResponse 包装）
  const handleExportCsv = () => {
    const url = `${browserConfig.apiBaseUrl}/api/usage/export`
    // 使用 fetch 拿到 CSV 文本，再通过 Blob 触发下载（保留鉴权头未来扩展空间）
    void fetch(url)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`导出失败: HTTP ${res.status}`)
        }
        return res.text()
      })
      .then((csv) => {
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
        const blobUrl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = blobUrl
        a.download = `usage-${Date.now()}.csv`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(blobUrl)
      })
      .catch((err: unknown) => {
        console.error('[UsagePanel] CSV 导出失败:', err)
      })
  }

  // 将 BudgetResponse 映射为 UsageBudgetInfo
  const budgetInfo: UsageBudgetInfo | undefined = budgetQuery.data
    ? {
        monthlyBudgetUsd: budgetQuery.data.monthlyBudgetUsd ?? 0,
        alertThreshold: budgetQuery.data.alertThreshold ?? 80,
        costUsd: budgetQuery.data.costUsd ?? 0,
        percentage: budgetQuery.data.percentage ?? 0,
        exceeded: budgetQuery.data.exceeded ?? false,
        warning: budgetQuery.data.warning ?? false,
      }
    : undefined

  const budgetError = budgetMutation.error instanceof ApiClientError
    ? budgetMutation.error.message
    : budgetMutation.error instanceof Error
      ? budgetMutation.error.message
      : undefined

  return (
    <section className="grid gap-3.5 min-h-0 overflow-auto p-4 align-content-start">
      <UsageOverview summary={summaryQuery.data} isLoading={summaryQuery.isLoading} budget={budgetInfo} />

      {/* 预算设置 + CSV 导出 */}
      <div className="bg-surface-2 border border-border rounded-lg grid gap-2 p-3">
        <div className="flex items-center justify-between">
          <p className="text-subtle text-xs font-[760] m-0">预算与导出</p>
          <Button
            variant="outline"
            size="xs"
            onClick={handleExportCsv}
            disabled={!isOnline}
            title="导出全部用量为 CSV 文件"
          >
            <Download className="size-3" />
            导出 CSV
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1">
            <span className="text-muted-foreground text-[10px]">月度预算（USD，0=不限制）</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={budgetInput}
              onChange={(e) => setBudgetInput(e.target.value)}
              className="bg-surface-1 border border-border rounded px-2 py-1 text-xs"
              placeholder="0"
            />
          </label>
          <label className="grid gap-1">
            <span className="text-muted-foreground text-[10px]">告警阈值（%，0-100）</span>
            <input
              type="number"
              min={0}
              max={100}
              step="1"
              value={thresholdInput}
              onChange={(e) => setThresholdInput(e.target.value)}
              className="bg-surface-1 border border-border rounded px-2 py-1 text-xs"
              placeholder="80"
            />
          </label>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="default"
            size="xs"
            onClick={handleSaveBudget}
            disabled={budgetMutation.isPending}
          >
            {budgetMutation.isPending ? '保存中…' : '保存预算'}
          </Button>
          {budgetSaved && (
            <span className="text-accent text-[10px]">已保存</span>
          )}
          {budgetError && (
            <span className="text-danger text-[10px]">{budgetError}</span>
          )}
          {budgetInfo && budgetInfo.monthlyBudgetUsd > 0 && (
            <span className="text-muted-foreground text-[10px] ml-auto">
              当月 {budgetInfo.costUsd.toFixed(4)} / {budgetInfo.monthlyBudgetUsd.toFixed(2)} USD（{budgetInfo.percentage.toFixed(1)}%）
            </span>
          )}
        </div>
      </div>

      <UsageCharts
        summary={summaryQuery.data}
        isLoading={summaryQuery.isLoading}
        isOnline={isOnline}
      />
      <UsageTable limit={10} />
    </section>
  )
}
