import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  FileInput,
  GitCompareArrows,
  History,
  LoaderCircle,
  RefreshCw,
  RotateCcw
} from 'lucide-react'
import type {
  ChapterVersion,
  ChapterVersionDiff,
  ChapterVersionPhase,
  ChapterVersionSummary,
  RollbackResult
} from '@repo/shared/novel'
import {
  applyChapterVersion,
  createChapterSnapshot,
  diffChapterVersions,
  getChapterVersion,
  listChapterVersions,
  listContentRevisions,
  rollbackToContentRevision,
} from '@/api/novel-client'
import type { ContentRevisionSummary } from '@repo/shared/novel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toastError, toastSuccess } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'

const PHASE_LABEL: Record<ChapterVersionPhase, string> = {
  writer_initial: '初稿',
  reviser_final: '修订后',
  rewrite_pre: '重写前',
  postwrite_guard_pre: '守门重写前',
  discussion_weaver: '群聊编织',
  manual_patch: '手动编辑',
  rollback_pre: '应用前',
  rollback_applied: '已应用',
  manual_snapshot: '手动快照',
  import: '导入'
}

const PHASE_COLOR: Record<ChapterVersionPhase, string> = {
  writer_initial: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  reviser_final: 'bg-purple-500/15 text-purple-700 dark:text-purple-300',
  rewrite_pre: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  postwrite_guard_pre: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  discussion_weaver: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',
  manual_patch: 'bg-muted text-text',
  rollback_pre: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  rollback_applied: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  manual_snapshot: 'bg-muted text-text',
  import: 'bg-muted text-text'
}

type VersionTab = 'detail' | 'diff' | 'chain'

interface ChapterVersionPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  chapterId: string | null
  onBeforeApply?: () => Promise<boolean>
  onApplySuccess?: (content: string, wordCount: number) => void
}

function formatTime(timestamp: number): string {
  const difference = Date.now() - timestamp
  if (difference < 60_000) return '刚刚'
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)} 分钟前`
  if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)} 小时前`

  const date = new Date(timestamp)
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatDelta(delta: number): string {
  if (delta === 0) return ''
  return delta > 0 ? `+${delta}` : String(delta)
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined
}

export function ChapterVersionPanel({
  open,
  onOpenChange,
  chapterId,
  onBeforeApply,
  onApplySuccess
}: ChapterVersionPanelProps): ReactElement {
  const [versions, setVersions] = useState<ChapterVersionSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [snapshotting, setSnapshotting] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedDetail, setSelectedDetail] = useState<ChapterVersion | null>(null)
  // P1-1 版本链收敛：主读源切 V2（content revision 链），默认展示 chain 页
  const [activeTab, setActiveTab] = useState<VersionTab>('chain')
  const [diffFromId, setDiffFromId] = useState<string | null>(null)
  const [diffToId, setDiffToId] = useState<string | null>(null)
  const [diffResult, setDiffResult] = useState<ChapterVersionDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [confirmApplyId, setConfirmApplyId] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  // V2 不可变版本链（content revision）
  const [chainRevisions, setChainRevisions] = useState<ContentRevisionSummary[]>([])
  const [chainLoading, setChainLoading] = useState(false)
  const [chainApplyingId, setChainApplyingId] = useState<string | null>(null)

  const selectedSummary = useMemo(
    () => versions.find((version) => version.id === selectedDetail?.id) ?? null,
    [selectedDetail?.id, versions]
  )
  const pendingApplyVersion = useMemo(
    () => versions.find((version) => version.id === confirmApplyId) ?? null,
    [confirmApplyId, versions]
  )
  const selectedIsCurrent = Boolean(selectedSummary?.isCurrent)

  const loadVersions = useCallback(
    async (selectLatest = false): Promise<void> => {
      if (!chapterId) return
      const requestChapterId = chapterId // 记录发起请求时的章节
      setLoading(true)
      try {
        const list = await listChapterVersions(requestChapterId)
        // 校验：如果章节已切换，忽略旧请求的结果
        if (requestChapterId !== chapterId) {
          return
        }
        setVersions(list)
        setSelectedId((current) => {
          if (!selectLatest && current && list.some((version) => version.id === current)) {
            return current
          }
          return list[0]?.id ?? null
        })
      } catch (error) {
        if (requestChapterId === chapterId) {
          toastError('加载版本列表失败', errorMessage(error))
        }
      } finally {
        if (requestChapterId === chapterId) {
          setLoading(false)
        }
      }
    },
    [chapterId]
  )

  // V2 版本链加载
  const loadChain = useCallback(async (): Promise<void> => {
    if (!chapterId) return
    setChainLoading(true)
    try {
      const list = await listContentRevisions(chapterId)
      setChainRevisions(list)
    } catch (error) {
      toastError('加载版本链失败', errorMessage(error))
    } finally {
      setChainLoading(false)
    }
  }, [chapterId])

  useEffect(() => {
    if (!open || !chapterId) return
    let cancelled = false
    setVersions([])
    setSelectedId(null)
    setSelectedDetail(null)
    setActiveTab('chain')
    setDiffFromId(null)
    setDiffToId(null)
    setDiffResult(null)
    setConfirmApplyId(null)
    
    const load = async () => {
      if (cancelled) return
      await loadVersions(true)
      if (!cancelled) await loadChain()
    }
    load()
    
    return () => { cancelled = true }
  }, [chapterId, loadVersions, loadChain, open])

  // V2 版本链回滚（不可变语义：生成 rollback_applied 新版本）
  const handleChainRollback = useCallback(async (revisionId: string): Promise<void> => {
    if (!chapterId) return
    // 校验该版本是否属于当前章节（链表中所有版本都属于该章节，但安全起见检查）
    const targetRevision = chainRevisions.find(r => r.id === revisionId)
    if (!targetRevision) {
      toastError('回滚失败', '未找到该版本')
      return
    }
    setChainApplyingId(revisionId)
    try {
      // 与 handleApplyVersion 一致：回滚前先保存未落库的正文，避免覆盖用户刚编辑的内容
      const ready = (await onBeforeApply?.()) ?? true
      if (!ready) {
        toastError('回滚已取消', '请先保存当前正文再回滚')
        return
      }
      const result = await rollbackToContentRevision(chapterId, revisionId)
      toastSuccess('已回滚', `已从版本链恢复到 ${result.wordCount} 字正文（生成新版本，历史保留）`)
      onApplySuccess?.(result.content, result.wordCount)
      await Promise.all([loadChain(), loadVersions(true)])
    } catch (error) {
      toastError('回滚失败', errorMessage(error))
    } finally {
      setChainApplyingId(null)
    }
  }, [chapterId, chainRevisions, loadChain, loadVersions, onBeforeApply, onApplySuccess])

  useEffect(() => {
    if (!open || !chapterId || !selectedId) {
      setSelectedDetail(null)
      return
    }

    let cancelled = false
    getChapterVersion(chapterId, selectedId)
      .then((version) => {
        if (!cancelled) setSelectedDetail(version)
      })
      .catch((error: unknown) => {
        if (!cancelled) toastError('加载版本详情失败', errorMessage(error))
      })
    return () => {
      cancelled = true
    }
  }, [chapterId, open, selectedId])

  const diffCandidates = useMemo(() => {
    if (diffFromId && diffToId && diffFromId !== diffToId) {
      return { from: diffFromId, to: diffToId }
    }
    return null
  }, [diffFromId, diffToId])

  useEffect(() => {
    if (!diffCandidates && activeTab === 'diff') setActiveTab('chain')
  }, [activeTab, diffCandidates])

  useEffect(() => {
    if (!open || !chapterId || !diffCandidates) {
      setDiffResult(null)
      return
    }

    let cancelled = false
    setDiffLoading(true)
    diffChapterVersions(chapterId, diffCandidates.from, diffCandidates.to)
      .then((result) => {
        if (!cancelled) setDiffResult(result)
      })
      .catch((error: unknown) => {
        if (!cancelled) toastError('加载版本对比失败', errorMessage(error))
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [chapterId, diffCandidates, open])

  function toggleDiffSelect(id: string): void {
    if (diffFromId === id) {
      setDiffFromId(null)
      return
    }
    if (diffToId === id) {
      setDiffToId(null)
      return
    }
    if (!diffFromId) {
      setDiffFromId(id)
      return
    }
    if (!diffToId) {
      setDiffToId(id)
      setActiveTab('diff')
      return
    }
    setDiffToId(id)
    setActiveTab('diff')
  }

  function selectVersion(id: string): void {
    if (selectedId === id) return
    setSelectedDetail(null)
    setSelectedId(id)
    setActiveTab('detail')
  }

  async function handleApplyVersion(): Promise<void> {
    if (!chapterId || !confirmApplyId) return
    setApplying(true)
    try {
      const ready = (await onBeforeApply?.()) ?? true
      if (!ready) {
        toastError('未应用版本', '当前正文尚未保存，请先处理保存状态后重试')
        return
      }

      const result: RollbackResult = await applyChapterVersion(chapterId, confirmApplyId)
      toastSuccess(
        '版本已应用',
        pendingApplyVersion ? `第 ${pendingApplyVersion.sequence} 版已写入当前正文` : undefined
      )
      onApplySuccess?.(result.currentContent, result.currentWordCount)
      setConfirmApplyId(null)
      setDiffFromId(null)
      setDiffToId(null)
      setDiffResult(null)
      setActiveTab('detail')
      await loadVersions(true)
    } catch (error) {
      toastError('应用版本失败', errorMessage(error))
    } finally {
      setApplying(false)
    }
  }

  async function handleSnapshot(): Promise<void> {
    if (!chapterId || snapshotting) return
    setSnapshotting(true)
    try {
      await createChapterSnapshot(chapterId, '用户手动创建快照')
      toastSuccess('已创建快照', '当前正文已保存为新版本')
      await loadVersions()
    } catch (error) {
      toastError('创建快照失败', errorMessage(error))
    } finally {
      setSnapshotting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(780px,calc(100vh-32px))] w-[min(1120px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12">
          <DialogTitle className="flex items-center gap-2 text-balance">
            <History className="size-4 text-primary" />
            正文版本历史
          </DialogTitle>
          <DialogDescription className="text-pretty">
            查看和对比章节版本，并将选定版本安全应用到当前正文。
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(180px,0.8fr)_minmax(260px,1.2fr)] md:grid-cols-[300px_minmax(0,1fr)] md:grid-rows-1">
          <section className="flex min-h-0 flex-col border-b border-border bg-surface-1/40 md:border-r md:border-b-0">
            <div className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
              <div>
                <h3 className="text-xs font-semibold text-text">版本记录</h3>
                <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
                  共 {versions.length} 个版本
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-10"
                onClick={() => void handleSnapshot()}
                disabled={loading || snapshotting}
              >
                {snapshotting ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Camera className="size-3.5" />
                )}
                快照
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading && versions.length === 0 && (
                <div className="space-y-2 p-3" aria-label="正在加载版本列表">
                  {[1, 2, 3].map((item) => (
                    <div key={item} className="h-[76px] animate-pulse rounded-md bg-muted/50" />
                  ))}
                </div>
              )}
              {!loading && versions.length === 0 && (
                <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-5 text-center">
                  <History className="size-5 text-muted-foreground" />
                  <p className="text-sm font-medium text-text">暂无历史版本</p>
                  <p className="text-xs text-muted-foreground">可为当前正文创建第一个快照。</p>
                </div>
              )}
              {versions.map((version) => {
                const isSelected = selectedId === version.id
                const isDiffFrom = diffFromId === version.id
                const isDiffTo = diffToId === version.id
                return (
                  <div
                    key={version.id}
                    className={cn(
                      'group grid grid-cols-[44px_minmax(0,1fr)] border-b border-l-2 border-border transition-[color,background-color,border-color]',
                      isSelected
                        ? 'border-l-primary bg-primary/[0.06]'
                        : 'border-l-transparent hover:bg-muted/50'
                    )}
                  >
                    <label className="flex min-h-[76px] cursor-pointer items-start justify-center pt-3.5">
                      <input
                        type="checkbox"
                        className="size-4 rounded accent-primary"
                        checked={isDiffFrom || isDiffTo}
                        onChange={() => toggleDiffSelect(version.id)}
                        aria-label={`选择第 ${version.sequence} 版用于对比`}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => selectVersion(version.id)}
                      aria-pressed={isSelected}
                      className="min-w-0 px-2 pr-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <div className="mb-1.5 flex min-w-0 items-center gap-1.5">
                        <span className="shrink-0 text-xs font-semibold tabular-nums text-text">
                          第 {version.sequence} 版
                        </span>
                        <Badge
                          variant="secondary"
                          className={cn(
                            'min-w-0 px-1.5 py-0 text-[10px]',
                            version.phase ? PHASE_COLOR[version.phase] : ''
                          )}
                        >
                          {version.phase ? PHASE_LABEL[version.phase] : '未知'}
                        </Badge>
                        {version.isCurrent && (
                          <CheckCircle2 className="ml-auto size-3.5 shrink-0 text-success" />
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
                        <span>{version.wordCount.toLocaleString()} 字</span>
                        <span
                          className={cn(
                            version.wordCountDelta > 0 && 'text-success',
                            version.wordCountDelta < 0 && 'text-destructive'
                          )}
                        >
                          {formatDelta(version.wordCountDelta)}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-[11px] text-muted-foreground">
                        {formatTime(version.createdAt)}
                        {version.trigger ? ` · ${version.trigger}` : ''}
                      </p>
                      {(isDiffFrom || isDiffTo) && (
                        <span className="mt-1.5 inline-flex text-[10px] font-medium text-primary">
                          {isDiffFrom ? '对比源' : '对比目标'}
                        </span>
                      )}
                    </button>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="flex min-h-0 flex-col bg-popover">
            <Tabs
              value={activeTab}
              onValueChange={(value) => setActiveTab(value as VersionTab)}
              className="min-h-0 flex-1 gap-0"
            >
              <div className="flex min-h-14 shrink-0 items-end border-b border-border px-5">
                <TabsList variant="line" className="h-11">
                  <TabsTrigger value="detail" className="min-w-28 px-3">
                    <FileInput className="size-3.5" />
                    版本详情
                  </TabsTrigger>
                  <TabsTrigger value="diff" className="min-w-28 px-3" disabled={!diffCandidates}>
                    <GitCompareArrows className="size-3.5" />
                    版本对比
                  </TabsTrigger>
                  <TabsTrigger value="chain" className="min-w-28 px-3">
                    <History className="size-3.5" />
                    版本链
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="detail" className="m-0 min-h-0 overflow-y-auto p-5">
                {!selectedDetail && (
                  <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
                    {selectedId ? (
                      <span className="inline-flex items-center gap-2">
                        <LoaderCircle className="size-4 animate-spin" /> 加载版本正文
                      </span>
                    ) : (
                      '尚未选择版本'
                    )}
                  </div>
                )}
                {selectedDetail && (
                  <div className="min-h-full">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <Badge
                        className={selectedDetail.phase ? PHASE_COLOR[selectedDetail.phase] : ''}
                      >
                        {selectedDetail.phase ? PHASE_LABEL[selectedDetail.phase] : '未知'}
                      </Badge>
                      {selectedIsCurrent && (
                        <span className="inline-flex items-center gap-1 text-success">
                          <CheckCircle2 className="size-3.5" /> 当前正文
                        </span>
                      )}
                      <span className="tabular-nums text-muted-foreground">
                        第 {selectedDetail.sequence} 版 ·{' '}
                        {selectedDetail.wordCount.toLocaleString()} 字 ·{' '}
                        {formatTime(selectedDetail.createdAt)}
                      </span>
                      {selectedDetail.agentType && (
                        <Badge variant="outline" className="text-[10px]">
                          {selectedDetail.agentType}
                        </Badge>
                      )}
                    </div>
                    {selectedDetail.trigger && (
                      <p className="mt-2 text-xs text-muted-foreground">{selectedDetail.trigger}</p>
                    )}
                    <pre className="mt-4 min-h-56 whitespace-pre-wrap break-words rounded-md bg-surface-1 p-4 font-sans text-sm leading-7 text-text shadow-[0_0_0_1px_rgba(0,0,0,0.06)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
                      {selectedDetail.content || '（空正文）'}
                    </pre>
                    <div className="sticky bottom-0 -mx-5 mt-5 flex min-h-16 items-center justify-between gap-3 border-t border-border bg-popover/95 px-5 py-3 backdrop-blur">
                      <p className="text-xs text-muted-foreground">
                        {selectedIsCurrent ? '该版本已是当前正文' : '当前正文将在应用前自动保存'}
                      </p>
                      <Button
                        className="h-10"
                        variant={selectedIsCurrent ? 'outline' : 'default'}
                        disabled={selectedIsCurrent}
                        onClick={() => setConfirmApplyId(selectedDetail.id)}
                      >
                        {selectedIsCurrent ? (
                          <CheckCircle2 className="size-4" />
                        ) : (
                          <FileInput className="size-4" />
                        )}
                        {selectedIsCurrent ? '当前正文版本' : '应用到正文'}
                      </Button>
                    </div>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="diff" className="m-0 min-h-0 overflow-y-auto p-5">
                {diffLoading && (
                  <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <LoaderCircle className="size-4 animate-spin" /> 计算版本差异
                  </div>
                )}
                {!diffLoading && !diffResult && (
                  <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
                    尚未选择两个对比版本
                  </div>
                )}
                {diffResult && (
                  <div className="space-y-4">
                    <div className="flex flex-wrap gap-x-4 gap-y-2 border-b border-border pb-3 text-xs tabular-nums text-muted-foreground">
                      <span className="text-success">新增 {diffResult.stats.added}</span>
                      <span className="text-destructive">删除 {diffResult.stats.removed}</span>
                      <span>修改 {diffResult.stats.modified}</span>
                      <span>未变 {diffResult.stats.unchanged}</span>
                      <span
                        className={cn(
                          diffResult.stats.wordCountDelta > 0 && 'text-success',
                          diffResult.stats.wordCountDelta < 0 && 'text-destructive'
                        )}
                      >
                        字数差 {formatDelta(diffResult.stats.wordCountDelta)}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {diffResult.segments.map((segment, index) => {
                        if (segment.type === 'unchanged') {
                          return (
                            <div
                              key={index}
                              className="border-l-2 border-transparent px-3 py-1.5 text-sm whitespace-pre-wrap text-muted-foreground"
                            >
                              {segment.content}
                            </div>
                          )
                        }
                        if (segment.type === 'added') {
                          return (
                            <div
                              key={index}
                              className="border-l-2 border-emerald-500 bg-emerald-500/10 px-3 py-1.5 text-sm whitespace-pre-wrap"
                            >
                              <span className="mr-2 text-xs text-emerald-700 dark:text-emerald-300">
                                +
                              </span>
                              {segment.content}
                            </div>
                          )
                        }
                        if (segment.type === 'removed') {
                          return (
                            <div
                              key={index}
                              className="border-l-2 border-rose-500 bg-rose-500/10 px-3 py-1.5 text-sm whitespace-pre-wrap line-through decoration-rose-400/50"
                            >
                              <span className="mr-2 text-xs text-rose-700 dark:text-rose-300">
                                -
                              </span>
                              {segment.content}
                            </div>
                          )
                        }
                        return (
                          <div key={index} className="grid gap-1 lg:grid-cols-2">
                            <div className="border-l-2 border-rose-500 bg-rose-500/10 px-3 py-1.5 text-sm whitespace-pre-wrap">
                              <span className="mr-2 text-xs text-rose-700 dark:text-rose-300">
                                -旧
                              </span>
                              {segment.fromContent}
                            </div>
                            <div className="border-l-2 border-emerald-500 bg-emerald-500/10 px-3 py-1.5 text-sm whitespace-pre-wrap">
                              <span className="mr-2 text-xs text-emerald-700 dark:text-emerald-300">
                                +新
                              </span>
                              {segment.toContent}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="chain" className="m-0 min-h-0 overflow-y-auto p-5">
                <div className="mb-4 flex items-center justify-between">
                  <h4 className="text-sm font-medium">不可变版本链（V2）</h4>
                  <Button size="sm" variant="outline" onClick={() => void loadChain()} disabled={chainLoading}>
                    <RefreshCw className="size-3.5" /> 刷新
                  </Button>
                </div>
                {chainLoading ? (
                  <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
                    <LoaderCircle className="size-4 animate-spin" /> 加载版本链
                  </div>
                ) : chainRevisions.length === 0 ? (
                  <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
                    暂无版本链记录（保存正文后自动生成）
                  </div>
                ) : (
                  <ol className="space-y-2">
                    {chainRevisions.map((revision) => (
                      <li
                        key={revision.id}
                        className={cn(
                          'flex items-center justify-between gap-3 rounded-md border p-3',
                          revision.isCurrent && 'border-emerald-500/40 bg-emerald-500/5',
                        )}
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="tabular-nums font-medium">rev {revision.revision}</span>
                            {revision.isCurrent && (
                              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                                <CheckCircle2 className="size-3.5" /> 当前正文
                              </span>
                            )}
                            <Badge variant={revision.status === 'superseded' ? 'outline' : 'default'}>
                              {revision.status === 'committed' ? '已确认' : revision.status === 'superseded' ? '已替代' : '回滚应用'}
                            </Badge>
                            <span className="text-muted-foreground">{revision.wordCount.toLocaleString()} 字</span>
                            <span className="text-muted-foreground">{formatTime(revision.createdAt)}</span>
                          </div>
                          {revision.trigger && (
                            <p className="truncate text-xs text-muted-foreground">{revision.trigger}</p>
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={revision.isCurrent || chainApplyingId === revision.id}
                          onClick={() => void handleChainRollback(revision.id)}
                          className="shrink-0"
                        >
                          {chainApplyingId === revision.id
                            ? <LoaderCircle className="size-3.5 animate-spin" />
                            : <RotateCcw className="size-3.5" />}
                          回滚到此版
                        </Button>
                      </li>
                    ))}
                  </ol>
                )}
              </TabsContent>
            </Tabs>
          </section>
        </div>

        <DialogFooter className="min-h-14 shrink-0 flex-row items-center justify-between border-t border-border px-5 py-2.5 sm:justify-between">
          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <CheckCircle2 className="size-3.5 text-success" />
            应用版本不会删除历史记录
          </span>
          <Button variant="ghost" className="h-10" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>

      <Dialog
        open={Boolean(confirmApplyId)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !applying) setConfirmApplyId(null)
        }}
      >
        <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-md" showCloseButton={!applying}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-balance">
              <AlertTriangle className="size-4 text-amber-500" />
              应用此版本到正文？
            </DialogTitle>
            <DialogDescription className="text-pretty">
              当前正文会先保存为历史版本，再由所选版本替换；之后仍可从版本历史恢复。
            </DialogDescription>
          </DialogHeader>
          {pendingApplyVersion && (
            <div className="rounded-md bg-surface-1 px-4 py-3 shadow-[0_0_0_1px_rgba(0,0,0,0.06)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
              <p className="text-sm font-medium text-text">第 {pendingApplyVersion.sequence} 版</p>
              <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                {pendingApplyVersion.wordCount.toLocaleString()} 字 ·{' '}
                {formatTime(pendingApplyVersion.createdAt)}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              className="h-10"
              onClick={() => setConfirmApplyId(null)}
              disabled={applying}
            >
              取消
            </Button>
            <Button className="h-10" onClick={() => void handleApplyVersion()} disabled={applying}>
              {applying ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <FileInput className="size-4" />
              )}
              {applying ? '应用中' : '确认应用'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  )
}
