import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { AlertTriangle, GitBranch, LoaderCircle, Route } from 'lucide-react'
import { getNarrativeMatrix, type NarrativeMatrixReport, type NarrativeMatrixRow } from '@/api/novel-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toastError } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'

const PROGRESS_TYPE_LABEL: Record<string, string> = {
  setup: '铺陈',
  advance: '推进',
  turn: '转向',
  reveal: '揭示',
  resolve: '收束',
  pause: '暂缓',
}

const PROGRESS_TYPE_COLOR: Record<string, string> = {
  setup: 'bg-slate-400',
  advance: 'bg-blue-500',
  turn: 'bg-amber-500',
  reveal: 'bg-violet-500',
  resolve: 'bg-emerald-500',
  pause: 'bg-zinc-400',
}

interface NarrativeTrackPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string | null
}

export function NarrativeTrackPanel({ open, onOpenChange, projectId }: NarrativeTrackPanelProps): ReactElement {
  const [report, setReport] = useState<NarrativeMatrixReport | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (!projectId) return
    setLoading(true)
    try {
      setReport(await getNarrativeMatrix(projectId))
    } catch (err) {
      toastError('加载剧情轨道失败', err instanceof Error ? err.message : '未知错误')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (open && projectId) void load()
  }, [open, projectId, load])

  // 去重章节列（来自 sceneNodes）
  const chapters = useMemo(() => {
    if (!report) return []
    const set = new Set<number>()
    for (const node of report.sceneNodes) if (node.chapterNumber != null) set.add(node.chapterNumber)
    return [...set].sort((a, b) => a - b)
  }, [report])

  const progressByCell = useMemo(() => {
    const map = new Map<string, NarrativeMatrixRow['progresses']>()
    if (!report) return map
    for (const row of report.rows) {
      for (const p of row.progresses) {
        if (p.chapterNumber == null) continue
        const key = `${row.storylineId}:${p.chapterNumber}`
        const list = map.get(key) ?? []
        list.push(p)
        map.set(key, list)
      }
    }
    return map
  }, [report])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            剧情推进轨道
          </DialogTitle>
          <DialogDescription>
            故事线如何被逐章推进（V2 叙事账本只读投影）。与矩阵的实体出场轨道分开展示。
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <LoaderCircle className="h-5 w-5 animate-spin mr-2" /> 加载中...
            </div>
          ) : !report ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              暂无数据
            </div>
          ) : (
            <>
              {report.staleCount > 0 && (
                <div className="mb-4 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  检测到中间章节重写，{report.staleCount} 条推进记录已标记待重建，请确认后从受影响章节开始重建。
                </div>
              )}

              {report.rows.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <Route className="h-8 w-8 mb-2" />
                  <p>暂无剧情推进记录（章节生成后由 Memory 提取）</p>
                  <p className="text-xs mt-1">需开启项目级 scenePlanV2Write 并生成章节</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="sticky left-0 bg-popover px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                          故事线
                        </th>
                        {chapters.map((ch) => (
                          <th key={ch} className="min-w-24 px-3 py-2 text-center text-xs font-medium text-muted-foreground">
                            第 {ch} 章
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {report.rows.map((row) => (
                        <tr key={row.storylineId} className="border-b border-border/50">
                          <td className="sticky left-0 bg-popover px-3 py-2">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{row.name}</span>
                              <Badge variant={row.maturity === 'established' ? 'default' : 'outline'} className="text-[10px]">
                                {row.maturity === 'established' ? '已确立' : '候选'}
                              </Badge>
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              {row.kind} · {row.progresses.length} 次推进
                            </div>
                          </td>
                          {chapters.map((ch) => {
                            const cells = progressByCell.get(`${row.storylineId}:${ch}`) ?? []
                            return (
                              <td key={ch} className="px-3 py-2 text-center align-top">
                                {cells.length === 0 ? (
                                  <span className="text-xs text-muted-foreground/40">—</span>
                                ) : (
                                  <div className="flex flex-wrap justify-center gap-1">
                                    {cells.map((p) => (
                                      <span
                                        key={p.progressId}
                                        title={`${PROGRESS_TYPE_LABEL[p.type] ?? p.type}${p.summary ? `：${p.summary}` : ''}${p.beforeState ? `（${p.beforeState} → ${p.afterState}）` : ''}`}
                                        className={cn(
                                          'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] text-white',
                                          PROGRESS_TYPE_COLOR[p.type] ?? 'bg-slate-400',
                                          p.primary && 'ring-2 ring-offset-1 ring-slate-400',
                                        )}
                                      >
                                        {PROGRESS_TYPE_LABEL[p.type] ?? p.type}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
