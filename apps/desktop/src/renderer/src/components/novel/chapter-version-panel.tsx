/**
 * 章节正文版本历史面板
 *
 * 功能：
 * - 左侧版本列表（sequence 倒序，显示 phase/trigger/字数差/时间）
 * - 右侧详情 / Diff 对比切换
 * - 回滚（二次确认）+ 手动快照
 *
 * 遵循用户偏好：
 * - 操作后 toast 通知
 * - 列表加载用骨架屏，不显示全屏 loading
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { toastSuccess, toastError } from '@/hooks/use-toast'
import {
  listChapterVersions, getChapterVersion, diffChapterVersions,
  rollbackChapter, createChapterSnapshot,
} from '@/api/novel-client'
import type {
  ChapterVersion, ChapterVersionSummary, ChapterVersionDiff,
  ChapterVersionPhase, RollbackResult,
} from '@repo/shared/novel'
import { cn } from '@/lib/utils'

// ── phase 中文映射 ──

const PHASE_LABEL: Record<ChapterVersionPhase, string> = {
  writer_initial: '初稿',
  reviser_final: '修订后',
  rewrite_pre: '重写前',
  postwrite_guard_pre: '守门重写前',
  discussion_weaver: '群聊编织',
  manual_patch: '手动编辑',
  rollback_pre: '回滚前',
  rollback_applied: '回滚应用',
  manual_snapshot: '手动快照',
  import: '导入',
}

const PHASE_COLOR: Record<ChapterVersionPhase, string> = {
  writer_initial: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  reviser_final: 'bg-purple-500/15 text-purple-700 dark:text-purple-300',
  rewrite_pre: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  postwrite_guard_pre: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  discussion_weaver: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',
  manual_patch: 'bg-slate-500/15 text-slate-700 dark:text-slate-300',
  rollback_pre: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  rollback_applied: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  manual_snapshot: 'bg-slate-500/15 text-slate-700 dark:text-slate-300',
  import: 'bg-slate-500/15 text-slate-700 dark:text-slate-300',
}

// ── 时间格式化 ──

function formatTime(ts: number): string {
  const now = Date.now()
  const diff = now - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatDelta(delta: number): string {
  if (delta === 0) return ''
  return delta > 0 ? `+${delta}` : `${delta}`
}

// ── Props ──

interface ChapterVersionPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  chapterId: string | null
  /** 回滚成功后回调，通知编辑器刷新内容 */
  onRollbackSuccess?: (content: string, wordCount: number) => void
}

export function ChapterVersionPanel({
  open, onOpenChange, chapterId, onRollbackSuccess,
}: ChapterVersionPanelProps) {
  const [versions, setVersions] = useState<ChapterVersionSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedDetail, setSelectedDetail] = useState<ChapterVersion | null>(null)
  const [diffFromId, setDiffFromId] = useState<string | null>(null)
  const [diffToId, setDiffToId] = useState<string | null>(null)
  const [diffResult, setDiffResult] = useState<ChapterVersionDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [confirmRollbackId, setConfirmRollbackId] = useState<string | null>(null)
  const [rolling, setRolling] = useState(false)
  const selectedIsCurrent = versions.some(
    (version) => version.id === selectedDetail?.id && version.isCurrent,
  )

  // 加载版本列表
  const loadVersions = useCallback(async () => {
    if (!chapterId) return
    setLoading(true)
    try {
      const list = await listChapterVersions(chapterId)
      setVersions(list)
      // 默认选中最新版
      if (list.length > 0 && !selectedId) {
        setSelectedId(list[0].id)
      }
    } catch (err: any) {
      toastError('加载版本列表失败', err?.message)
    } finally {
      setLoading(false)
    }
  }, [chapterId, selectedId])

  useEffect(() => {
    if (open && chapterId) {
      setSelectedId(null)
      setDiffFromId(null)
      setDiffToId(null)
      setDiffResult(null)
      loadVersions()
    }
  }, [open, chapterId, loadVersions])

  // 加载选中版本详情
  useEffect(() => {
    if (!open || !chapterId || !selectedId) {
      setSelectedDetail(null)
      return
    }
    let cancelled = false
    getChapterVersion(chapterId, selectedId)
      .then(v => { if (!cancelled) setSelectedDetail(v) })
      .catch(err => { if (!cancelled) toastError('加载版本详情失败', err?.message) })
    return () => { cancelled = true }
  }, [open, chapterId, selectedId])

  // 计算两个选中用于 diff 的版本
  const diffCandidates = useMemo(() => {
    if (diffFromId && diffToId && diffFromId !== diffToId) {
      return { from: diffFromId, to: diffToId }
    }
    return null
  }, [diffFromId, diffToId])

  // 加载 diff
  useEffect(() => {
    if (!open || !chapterId || !diffCandidates) {
      setDiffResult(null)
      return
    }
    let cancelled = false
    setDiffLoading(true)
    diffChapterVersions(chapterId, diffCandidates.from, diffCandidates.to)
      .then(d => { if (!cancelled) setDiffResult(d) })
      .catch(err => { if (!cancelled) toastError('加载 diff 失败', err?.message) })
      .finally(() => { if (!cancelled) setDiffLoading(false) })
    return () => { cancelled = true }
  }, [open, chapterId, diffCandidates])

  // 勾选版本用于 diff（点击 checkbox）
  const toggleDiffSelect = (id: string) => {
    if (diffFromId === id) { setDiffFromId(null); return }
    if (diffToId === id) { setDiffToId(null); return }
    if (!diffFromId) { setDiffFromId(id); return }
    if (!diffToId) { setDiffToId(id); return }
    // 两个都选了，替换 to
    setDiffToId(id)
  }

  // 回滚
  const handleRollback = async () => {
    if (!chapterId || !confirmRollbackId) return
    setRolling(true)
    try {
      const result: RollbackResult = await rollbackChapter(chapterId, confirmRollbackId)
      toastSuccess('已回滚', `当前正文已更新（保留前一版为 rollback_pre）`)
      onRollbackSuccess?.(result.currentContent, result.currentWordCount)
      setConfirmRollbackId(null)
      // 刷新版本列表
      setSelectedId(null)
      setDiffFromId(null)
      setDiffToId(null)
      setDiffResult(null)
      setLoading(true)
      const list = await listChapterVersions(chapterId)
      setVersions(list)
      if (list.length > 0) setSelectedId(list[0].id)
    } catch (err: any) {
      toastError('回滚失败', err?.message)
    } finally {
      setRolling(false)
    }
  }

  // 手动快照
  const handleSnapshot = async () => {
    if (!chapterId) return
    try {
      await createChapterSnapshot(chapterId, '用户手动创建快照')
      toastSuccess('已创建快照', '当前正文已保存为新版本')
      // 刷新列表
      setLoading(true)
      const list = await listChapterVersions(chapterId)
      setVersions(list)
    } catch (err: any) {
      toastError('创建快照失败', err?.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-5xl !w-[90vw] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>章节正文版本历史</DialogTitle>
        </DialogHeader>

        <div className="flex-1 grid grid-cols-[280px_1fr] gap-4 overflow-hidden min-h-0">
          {/* 左侧版本列表 */}
          <div className="border rounded-md flex flex-col overflow-hidden">
            <div className="px-3 py-2 text-xs text-muted-foreground border-b bg-muted/30 flex items-center justify-between">
              <span>版本列表（{versions.length}）</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={handleSnapshot}
                disabled={loading || versions.length === 0}
              >
                手动快照
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {loading && versions.length === 0 && (
                <div className="p-3 space-y-2">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="h-16 rounded bg-muted/40 animate-pulse" />
                  ))}
                </div>
              )}
              {!loading && versions.length === 0 && (
                <div className="p-4 text-center text-sm text-muted-foreground">
                  暂无历史版本
                </div>
              )}
              {versions.map(v => {
                const isSelected = selectedId === v.id
                const isDiffFrom = diffFromId === v.id
                const isDiffTo = diffToId === v.id
                return (
                  <button
                    key={v.id}
                    onClick={() => setSelectedId(v.id)}
                    className={cn(
                      'w-full text-left px-3 py-2 border-b hover:bg-accent/50 transition-colors',
                      isSelected && 'bg-accent',
                    )}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <input
                        type="checkbox"
                        className="h-3 w-3 rounded"
                        checked={isDiffFrom || isDiffTo}
                        onChange={(e) => { e.stopPropagation(); toggleDiffSelect(v.id) }}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <Badge
                        variant="secondary"
                        className={cn('text-[10px] px-1.5 py-0', v.phase ? PHASE_COLOR[v.phase] : '')}
                      >
                        {v.phase ? PHASE_LABEL[v.phase] : '未知'}
                      </Badge>
                      {v.isCurrent && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">当前</Badge>
                      )}
                      {isDiffFrom && <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-rose-600">源</Badge>}
                      {isDiffTo && <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-emerald-600">目标</Badge>}
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>第 {v.sequence} 版 · {v.wordCount} 字</span>
                      <span className={cn(
                        v.wordCountDelta > 0 && 'text-emerald-600',
                        v.wordCountDelta < 0 && 'text-rose-600',
                      )}>
                        {formatDelta(v.wordCountDelta)}
                      </span>
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {formatTime(v.createdAt)}
                      {v.trigger ? ` · ${v.trigger.slice(0, 30)}` : ''}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* 右侧详情/Diff */}
          <div className="border rounded-md flex flex-col overflow-hidden min-h-0">
            <Tabs defaultValue="detail" className="flex-1 flex flex-col overflow-hidden">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="detail">版本详情</TabsTrigger>
                <TabsTrigger value="diff" disabled={!diffCandidates}>
                  Diff 对比{diffCandidates ? '' : '（勾选两版）'}
                </TabsTrigger>
              </TabsList>

              {/* 版本详情 */}
              <TabsContent value="detail" className="flex-1 overflow-y-auto p-4 m-0">
                {!selectedDetail && (
                  <div className="text-center text-sm text-muted-foreground py-8">
                    {selectedId ? '加载中...' : '请从左侧选择一个版本'}
                  </div>
                )}
                {selectedDetail && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 flex-wrap text-xs">
                      <Badge className={selectedDetail.phase ? PHASE_COLOR[selectedDetail.phase] : ''}>
                        {selectedDetail.phase ? PHASE_LABEL[selectedDetail.phase] : '未知'}
                      </Badge>
                      <span className="text-muted-foreground">
                        第 {selectedDetail.sequence} 版 · {selectedDetail.wordCount} 字 · {formatTime(selectedDetail.createdAt)}
                      </span>
                      {selectedDetail.agentType && (
                        <Badge variant="outline" className="text-[10px]">agent: {selectedDetail.agentType}</Badge>
                      )}
                    </div>
                    {selectedDetail.trigger && (
                      <div className="text-xs text-muted-foreground">触发：{selectedDetail.trigger}</div>
                    )}
                    <pre className="whitespace-pre-wrap text-sm leading-relaxed font-sans bg-muted/30 p-3 rounded-md border">
                      {selectedDetail.content || '（空正文）'}
                    </pre>
                    {!selectedIsCurrent && (
                      <div className="pt-2">
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => setConfirmRollbackId(selectedDetail.id)}
                        >
                          回滚到此版本
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </TabsContent>

              {/* Diff 对比 */}
              <TabsContent value="diff" className="flex-1 overflow-y-auto p-4 m-0">
                {diffLoading && (
                  <div className="text-center text-sm text-muted-foreground py-8">计算 diff 中...</div>
                )}
                {!diffLoading && !diffResult && (
                  <div className="text-center text-sm text-muted-foreground py-8">
                    在左侧列表勾选两个版本的 checkbox（源 + 目标）以查看对比
                  </div>
                )}
                {diffResult && (
                  <div className="space-y-2">
                    <div className="text-xs text-muted-foreground flex gap-3 flex-wrap">
                      <span>新增 {diffResult.stats.added}</span>
                      <span>删除 {diffResult.stats.removed}</span>
                      <span>修改 {diffResult.stats.modified}</span>
                      <span>未变 {diffResult.stats.unchanged}</span>
                      <span className={cn(
                        diffResult.stats.wordCountDelta > 0 && 'text-emerald-600',
                        diffResult.stats.wordCountDelta < 0 && 'text-rose-600',
                      )}>
                        字数差 {formatDelta(diffResult.stats.wordCountDelta)}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {diffResult.segments.map((seg, idx) => {
                        if (seg.type === 'unchanged') {
                          return (
                            <div key={idx} className="px-2 py-1 text-sm text-muted-foreground whitespace-pre-wrap border-l-2 border-transparent">
                              {seg.content}
                            </div>
                          )
                        }
                        if (seg.type === 'added') {
                          return (
                            <div key={idx} className="px-2 py-1 text-sm bg-emerald-500/10 border-l-2 border-emerald-500 whitespace-pre-wrap">
                              <span className="text-emerald-700 dark:text-emerald-300 text-xs mr-2">+</span>
                              {seg.content}
                            </div>
                          )
                        }
                        if (seg.type === 'removed') {
                          return (
                            <div key={idx} className="px-2 py-1 text-sm bg-rose-500/10 border-l-2 border-rose-500 whitespace-pre-wrap line-through decoration-rose-400/50">
                              <span className="text-rose-700 dark:text-rose-300 text-xs mr-2">-</span>
                              {seg.content}
                            </div>
                          )
                        }
                        // modified
                        return (
                          <div key={idx} className="grid grid-cols-2 gap-1">
                            <div className="px-2 py-1 text-sm bg-rose-500/10 border-l-2 border-rose-500 whitespace-pre-wrap">
                              <span className="text-rose-700 dark:text-rose-300 text-xs mr-2">-旧</span>
                              {seg.fromContent}
                            </div>
                            <div className="px-2 py-1 text-sm bg-emerald-500/10 border-l-2 border-emerald-500 whitespace-pre-wrap">
                              <span className="text-emerald-700 dark:text-emerald-300 text-xs mr-2">+新</span>
                              {seg.toContent}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>

      {/* 回滚二次确认 */}
      <Dialog open={!!confirmRollbackId} onOpenChange={(o) => !o && setConfirmRollbackId(null)}>
        <DialogContent className="!max-w-md">
          <DialogHeader>
            <DialogTitle>确认回滚</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            回滚后当前正文会被目标版本替换。<br />
            当前正文会先保存为 <code className="px-1 bg-muted rounded">rollback_pre</code> 版本，可随时再次回滚回来。
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmRollbackId(null)} disabled={rolling}>
              取消
            </Button>
            <Button variant="destructive" onClick={handleRollback} disabled={rolling}>
              {rolling ? '回滚中...' : '确认回滚'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  )
}
