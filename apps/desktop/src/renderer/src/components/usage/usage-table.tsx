import type { ReactElement } from 'react'
import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { getApi } from '@/api'
import { Button } from '@/components/ui/button'

export interface UsageRecord {
  id: string
  agentId: string
  sessionId: string
  model: string
  /** Provider 名（部分历史记录可能缺失） */
  provider?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  createdAt: string
}

interface UsageListResponse {
  items: UsageRecord[]
  total: number
}

export interface UsageTableProps {
  limit?: number
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  } catch {
    return iso
  }
}

export function UsageTable({ limit = 10 }: UsageTableProps): ReactElement {
  const [offset, setOffset] = useState(0)

  const listQuery = useQuery({
    queryKey: ['usage-list', limit, offset],
    queryFn: () => getApi<UsageListResponse>(`/api/usage?limit=${limit}&offset=${offset}`),
    refetchInterval: 30_000
  })

  const items = listQuery.data?.items ?? []
  const total = listQuery.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / limit))
  const currentPage = Math.floor(offset / limit) + 1

  const handlePrev = useCallback(() => {
    setOffset((prev) => Math.max(0, prev - limit))
  }, [limit])

  const handleNext = useCallback(() => {
    setOffset((prev) => Math.min(Math.max(0, (totalPages - 1) * limit), prev + limit))
  }, [limit, totalPages])

  return (
    <div className="bg-surface-2 rounded-lg grid gap-2 p-3 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_2px_8px_rgba(0,0,0,0.06)]">
      <div className="flex items-center justify-between">
        <p className="text-subtle text-xs font-[760] m-0">调用明细</p>
        <span className="text-muted-foreground text-[10px] tabular-nums">
          {total > 0 ? `${offset + 1}-${Math.min(offset + limit, total)} / ${total}` : '0 条'}
        </span>
      </div>

      {listQuery.isLoading && (
        <div className="animate-pulse grid gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-8 bg-muted/20 rounded" />
          ))}
        </div>
      )}

      {listQuery.error && (
        <p className="text-danger text-xs">
          加载失败: {listQuery.error instanceof Error ? listQuery.error.message : '未知错误'}
        </p>
      )}

      {!listQuery.isLoading && items.length === 0 && (
        <p className="text-muted-foreground text-xs">暂无调用记录</p>
      )}

      {items.length > 0 && (
        <>
          {/* 表头（含 Provider 列） */}
          <div className="grid grid-cols-[1fr_60px_60px_60px_50px_50px] gap-1 text-[10px] text-muted-foreground font-[760] px-1">
            <span>模型</span>
            <span className="text-right">输入</span>
            <span className="text-right">输出</span>
            <span className="text-right">成本</span>
            <span>Provider</span>
            <span className="text-right">时间</span>
          </div>
          {/* 行 */}
          <div className="grid gap-0.5 max-h-[240px] overflow-auto">
            {items.map((item) => (
              <div
                key={item.id}
                className="grid grid-cols-[1fr_60px_60px_60px_50px_50px] gap-1 text-[11px] px-1 py-1 rounded hover:bg-surface-1/50"
              >
                <span className="truncate" title={item.model}>
                  {item.model.length > 16 ? `${item.model.slice(0, 14)}…` : item.model}
                </span>
                <span className="text-right text-muted-foreground tabular-nums">
                  {formatTokens(item.inputTokens)}
                </span>
                <span className="text-right text-muted-foreground tabular-nums">
                  {formatTokens(item.outputTokens)}
                </span>
                <span className="text-right font-mono tabular-nums">{formatCost(item.costUsd)}</span>
                <span
                  className="truncate text-muted-foreground"
                  title={item.provider ?? ''}
                >
                  {item.provider ? (item.provider.length > 8 ? `${item.provider.slice(0, 6)}…` : item.provider) : '—'}
                </span>
                <span className="text-right text-muted-foreground tabular-nums">
                  {formatTime(item.createdAt)}
                </span>
              </div>
            ))}
          </div>

          {/* 分页 */}
          <div className="flex items-center justify-between pt-1">
            <span className="text-muted-foreground text-[10px] tabular-nums">
              第 {currentPage} / {totalPages} 页
            </span>
            <div className="flex gap-1">
              <Button variant="ghost" size="xs" disabled={offset === 0} onClick={handlePrev}>
                <ChevronLeft className="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={currentPage >= totalPages}
                onClick={handleNext}
              >
                <ChevronRight className="size-3" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
