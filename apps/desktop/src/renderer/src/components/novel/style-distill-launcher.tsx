import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  listReferenceSources,
  listReferenceSections,
  createWritingStyleExpert
} from '@/api/novel-client'
import type { ReferenceSection, ReferenceSourceDetail } from '@repo/shared/novel'
import {
  StyleDistillReviewDialog,
  type StyleDistillDraftApi
} from './reference-analysis/style-distill-review-dialog'

interface StyleDistillLauncherProps {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 专家入库成功后的回调（父级刷新专家列表） */
  onAccepted?: () => void
}

/**
 * 从文风专家面板直接发起蒸馏的轻量入口。
 *
 * 完整的参考小说导入与边界确认仍在「参考小说」页签；这里只负责：
 * 选一个已解析的参考源 → 勾选参与分析的章节 → 复用 StyleDistillReviewDialog
 * 完成"深度分析 → 手法卡逐条审核 → 入库"。让蒸馏不必绕道参考分析流程。
 */
export function StyleDistillLauncher({
  projectId,
  open,
  onOpenChange,
  onAccepted
}: StyleDistillLauncherProps): ReactElement {
  const [sources, setSources] = useState<ReferenceSourceDetail[]>([])
  const [sourcesLoading, setSourcesLoading] = useState(false)
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [sections, setSections] = useState<ReferenceSection[]>([])
  const [sectionsLoading, setSectionsLoading] = useState(false)
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set())
  const [distillOpen, setDistillOpen] = useState(false)

  const selectedSource = useMemo(
    () => sources.find((source) => source.id === selectedSourceId) ?? null,
    [selectedSourceId, sources]
  )
  const parsedSources = sources.filter(
    (source) => source.parseStatus === 'parsed' || source.parseStatus === 'confirmed'
  )
  const includedSections = useMemo(
    () => sections.filter((section) => section.included && checkedIds.has(section.id)),
    [sections, checkedIds]
  )

  // 打开时拉取参考源列表；只保留已完成解析的（可蒸馏的前提）
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setSourcesLoading(true)
    listReferenceSources(projectId)
      .then((items) => {
        if (cancelled) return
        const usable = items.filter(
          (source) => source.parseStatus === 'parsed' || source.parseStatus === 'confirmed'
        )
        setSources(usable)
        setSelectedSourceId((current) =>
          current && usable.some((source) => source.id === current)
            ? current
            : (usable[0]?.id ?? null)
        )
      })
      .catch(() => {
        if (!cancelled) setSources([])
      })
      .finally(() => {
        if (!cancelled) setSourcesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, projectId])

  // 选中参考源后拉取章节，默认全勾 included 的
  useEffect(() => {
    if (!open || !selectedSourceId) {
      setSections([])
      setCheckedIds(new Set())
      return
    }
    let cancelled = false
    setSectionsLoading(true)
    listReferenceSections(selectedSourceId)
      .then((items) => {
        if (cancelled) return
        setSections(items)
        setCheckedIds(
          new Set(items.filter((section) => section.included).map((section) => section.id))
        )
      })
      .catch(() => {
        if (!cancelled) {
          setSections([])
          setCheckedIds(new Set())
        }
      })
      .finally(() => {
        if (!cancelled) setSectionsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, selectedSourceId])

  function handleClose(nextOpen: boolean): void {
    if (!nextOpen) setDistillOpen(false)
    onOpenChange(nextOpen)
  }

  async function handleAccepted(draft: StyleDistillDraftApi): Promise<void> {
    if (!selectedSource) return
    await createWritingStyleExpert(projectId, {
      name: draft.name,
      sourceTitle: selectedSource.displayName,
      description: draft.description,
      distilledPrompt: draft.distilledPrompt,
      metrics: draft.metrics,
      techniques: draft.techniques,
      exclusions: draft.exclusions,
      exemplarPassages: draft.exemplarPassages,
      expressionDna: draft.expressionDna,
      tensions: draft.tensions,
      antiPatterns: draft.antiPatterns,
      boundaries: draft.boundaries,
      enabled: true,
      sortOrder: 0
    })
    onAccepted?.()
  }

  const totalChars = includedSections.reduce(
    (sum, section) => sum + (section.characterCount ?? 0),
    0
  )

  return (
    <>
      <Dialog open={open && !distillOpen} onOpenChange={handleClose}>
        <DialogContent className="flex max-h-[80vh] w-[min(640px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12">
            <DialogTitle>从参考小说蒸馏新专家</DialogTitle>
            <DialogDescription>
              选择一个已解析的参考源和参与分析的章节。导入新的参考小说请到「参考小说」页签。
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {sourcesLoading ? (
              <div className="py-8 text-center text-sm text-muted-foreground">读取参考源…</div>
            ) : parsedSources.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  还没有可蒸馏的参考小说。请先到「参考小说」页签导入并完成解析确认。
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <div className="mb-2 text-xs font-medium text-text">1 · 选择参考源</div>
                  <div className="space-y-1">
                    {parsedSources.map((source) => (
                      <button
                        key={source.id}
                        type="button"
                        className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left transition-colors ${
                          source.id === selectedSourceId
                            ? 'bg-primary/10 ring-1 ring-primary/40'
                            : 'hover:bg-surface-2'
                        }`}
                        onClick={() => setSelectedSourceId(source.id)}
                      >
                        <Sparkles className="size-3.5 shrink-0 text-primary" />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-text">
                          {source.displayName}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {selectedSourceId ? (
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <div className="text-xs font-medium text-text">2 · 选择参与分析的章节</div>
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span>
                          已选 {includedSections.length}/{sections.filter((s) => s.included).length}{' '}
                          章 · 约 {totalChars} 字
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[10px]"
                          onClick={() => {
                            const allIncluded = sections.filter((section) => section.included)
                            const allChecked =
                              allIncluded.length > 0 &&
                              allIncluded.every((section) => checkedIds.has(section.id))
                            setCheckedIds(
                              allChecked
                                ? new Set()
                                : new Set(allIncluded.map((section) => section.id))
                            )
                          }}
                        >
                          {allIncludedChecked(sections, checkedIds) ? '全不选' : '全选'}
                        </Button>
                      </div>
                    </div>
                    {sectionsLoading ? (
                      <div className="py-6 text-center text-xs text-muted-foreground">
                        读取章节…
                      </div>
                    ) : (
                      <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-md border border-border p-1">
                        {sections
                          .filter((section) => section.included)
                          .map((section) => (
                            <label
                              key={section.id}
                              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-2"
                            >
                              <input
                                type="checkbox"
                                className="size-3.5 accent-[var(--primary)]"
                                checked={checkedIds.has(section.id)}
                                onChange={(event) => {
                                  const next = new Set(checkedIds)
                                  if (event.target.checked) next.add(section.id)
                                  else next.delete(section.id)
                                  setCheckedIds(next)
                                }}
                              />
                              <span className="min-w-0 flex-1 truncate text-xs text-text">
                                {section.title ?? `第 ${section.order + 1} 节`}
                              </span>
                              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                                {section.characterCount} 字
                              </span>
                            </label>
                          ))}
                        {sections.filter((section) => section.included).length === 0 && (
                          <div className="p-4 text-center text-xs text-muted-foreground">
                            该参考源没有已确认的章节
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <DialogFooter className="shrink-0 border-t border-border px-5 py-3">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button disabled={includedSections.length === 0} onClick={() => setDistillOpen(true)}>
              <Sparkles className="size-3.5" /> 开始分析（{includedSections.length} 章）
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {selectedSource ? (
        <StyleDistillReviewDialog
          sourceId={selectedSource.id}
          sourceTitle={selectedSource.displayName}
          sectionIds={includedSections.map((section) => section.id)}
          open={distillOpen}
          onOpenChange={(next) => {
            setDistillOpen(next)
            if (!next) onOpenChange(false)
          }}
          onAccepted={handleAccepted}
        />
      ) : null}
    </>
  )
}

function allIncludedChecked(sections: ReferenceSection[], checkedIds: Set<string>): boolean {
  const allIncluded = sections.filter((section) => section.included)
  return allIncluded.length > 0 && allIncluded.every((section) => checkedIds.has(section.id))
}
