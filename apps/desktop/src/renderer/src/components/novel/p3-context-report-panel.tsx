/**
 * P3 灰度看板面板（T03-8 前端）
 *
 * 展示 GET /p3/context-report 的聚合数据：
 * - baseline：现状 shared 字符/token（P3 验收对照基线）
 * - chunk 明细：id/标题/优先级/默认模式/字符/token
 * - 降级模拟：预算不足时的降级步骤与 token 节省
 * - 角色组装对照：flag 开时该 Agent 的 shared token vs baseline
 * - 身份 token
 */

import { useMemo, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw, Gauge, Layers, ShieldAlert, User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { getP3ContextReport } from '@/api/novel-client'

const AGENT_LABELS: Record<string, string> = {
  director: '导演',
  writer: '写作',
  reviewer: '审稿',
  reviser: '修订',
  memory: '记忆',
}

const PRIORITY_COLORS: Record<string, string> = {
  required: 'bg-blue-500/15 text-blue-500',
  recommended: 'bg-amber-500/15 text-amber-600',
  optional: 'bg-zinc-500/15 text-zinc-500',
}

export interface P3ContextReportPanelProps {
  chapterNumber?: number
}

export function P3ContextReportPanel({ chapterNumber }: P3ContextReportPanelProps): ReactElement {
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const [agentType, setAgentType] = useState<string>('memory')
  const [budgetTokens, setBudgetTokens] = useState<string>('4000')
  const [refreshKey, setRefreshKey] = useState(0)

  const budget = Number.parseInt(budgetTokens, 10)
  const reportQuery = useQuery({
    queryKey: ['novel-p3-context-report', currentProjectId, chapterNumber, agentType, Number.isFinite(budget) ? budget : null, refreshKey],
    queryFn: () => {
      if (!currentProjectId || !chapterNumber) throw new Error('缺少项目或章节')
      return getP3ContextReport(currentProjectId, {
        chapterNumber,
        agentType,
        budgetTokens: Number.isFinite(budget) ? budget : undefined,
      })
    },
    enabled: Boolean(currentProjectId && chapterNumber),
    staleTime: 30_000,
  })

  const report = reportQuery.data

  // chunk 汇总：按优先级分组计数
  const prioritySummary = useMemo(() => {
    if (!report) return []
    const counts = new Map<string, number>()
    for (const c of report.chunks) counts.set(c.priority, (counts.get(c.priority) ?? 0) + 1)
    return Array.from(counts.entries())
  }, [report])

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2">
        <Gauge className="h-4 w-4 text-green-500" />
        <span className="font-medium">P3 上下文灰度看板</span>
        <Badge variant="outline" className="ml-auto">
          {report ? `${report.baseline.sharedTokens} tok 基线` : '--'}
        </Badge>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setRefreshKey((k) => k + 1)}
          title="刷新"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* 参数区 */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={agentType}
          onChange={(e) => setAgentType(e.target.value)}
          className="h-8 rounded-md border bg-transparent px-2 text-xs"
        >
          {Object.entries(AGENT_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <input
          type="number"
          value={budgetTokens}
          onChange={(e) => setBudgetTokens(e.target.value)}
          placeholder="预算 token"
          className="h-8 w-24 rounded-md border bg-transparent px-2 text-xs"
          title="降级模拟预算（token）"
        />
        <span className="text-xs text-zinc-500">降级模拟预算</span>
      </div>

      {reportQuery.isLoading && <div className="text-xs text-zinc-500">加载中…</div>}
      {reportQuery.isError && (
        <div className="text-xs text-red-500">报告加载失败，请确认项目与章节编号</div>
      )}

      {report && (
        <>
          {/* baseline + chunk 汇总 */}
          <div className="grid grid-cols-3 gap-2">
            <Metric label="shared 字符" value={String(report.baseline.sharedChars)} />
            <Metric label="shared token" value={String(report.baseline.sharedTokens)} />
            <Metric label="chunk 数" value={String(report.baseline.chunkCount)} />
          </div>

          {/* 优先级汇总 */}
          <div className="flex flex-wrap gap-1.5">
            {prioritySummary.map(([priority, count]) => (
              <Badge key={priority} className={cn('text-xs', PRIORITY_COLORS[priority] ?? 'bg-zinc-500/15')}>
                {priority} × {count}
              </Badge>
            ))}
          </div>

          {/* 角色组装对照 */}
          {report.roleAssembly && (
            <div className="rounded-md border border-green-500/20 bg-green-500/5 p-2.5 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-green-600">
                <Layers className="h-3.5 w-3.5" />
                {AGENT_LABELS[report.roleAssembly.agentType] ?? report.roleAssembly.agentType} 角色组装（flag 开）
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span>{report.roleAssembly.tokens} tok</span>
                <span className="text-zinc-500">vs 基线 {report.baseline.sharedTokens} tok</span>
                <span className={cn('font-medium', report.roleAssembly.savedPercent > 0 ? 'text-green-600' : 'text-zinc-500')}>
                  -{report.roleAssembly.savedPercent}%
                </span>
              </div>
            </div>
          )}

          {/* 降级模拟 */}
          {report.degradation && (
            <div className="rounded-md border p-2.5 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <ShieldAlert className={cn('h-3.5 w-3.5', report.degradation.fits ? 'text-zinc-400' : 'text-red-500')} />
                降级模拟（预算 {report.degradation.budgetTokens} tok）
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span>{report.degradation.tokensBefore} → {report.degradation.tokensAfter} tok</span>
                <span className={cn('font-medium', report.degradation.savedPercent > 0 ? 'text-green-600' : 'text-zinc-500')}>
                  -{report.degradation.savedPercent}%
                </span>
                {!report.degradation.fits && (
                  <Badge className="bg-red-500/15 text-red-500 text-xs">超限（阻止生成）</Badge>
                )}
              </div>
              {report.degradation.appliedSteps.length > 0 && (
                <div className="text-xs text-zinc-500">
                  步骤：{report.degradation.appliedSteps.join(' → ')}
                </div>
              )}
            </div>
          )}

          {/* chunk 明细 */}
          <div>
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-zinc-600">
              <Gauge className="h-3.5 w-3.5" /> chunk 明细
            </div>
            <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
              {report.chunks.map((c) => (
                <div key={c.chunkId} className="flex items-center gap-2 rounded-md bg-zinc-500/5 px-2 py-1 text-xs">
                  <span className="w-28 shrink-0 font-medium">{c.title}</span>
                  <Badge className={cn('text-[10px]', PRIORITY_COLORS[c.priority] ?? 'bg-zinc-500/15')}>
                    {c.priority}
                  </Badge>
                  <span className="text-zinc-500">{c.defaultMode}</span>
                  <span className="ml-auto tabular-nums">{c.tokens} tok</span>
                </div>
              ))}
            </div>
          </div>

          {/* 身份 token */}
          {report.identity && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              <User className="h-3.5 w-3.5" />
              {AGENT_LABELS[report.identity.agentType] ?? report.identity.agentType} 身份：
              {report.identity.chars} 字符 / {report.identity.tokens} tok
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="rounded-md border bg-zinc-500/5 p-2 text-center">
      <div className="text-base font-semibold tabular-nums">{value}</div>
      <div className="text-[10px] text-zinc-500">{label}</div>
    </div>
  )
}
