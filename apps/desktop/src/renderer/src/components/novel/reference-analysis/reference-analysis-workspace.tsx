import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  BarChart3,
  Check,
  FileInput,
  Files,
  FlaskConical,
  Layers,
  ListChecks,
  LoaderCircle,
  Plus,
  RotateCcw,
  ScanText,
  Sparkles
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  getReferenceLocalReport,
  getReferenceQualityReport,
  listReferenceSections,
  listReferenceSources,
  type ReferenceSection,
  type ReferenceSourceDetail
} from '@/api/novel-client'
import { ReferenceImportPanel } from './reference-import-panel'
import { ReferenceSectionList } from './reference-section-list'
import { ReferenceLocalReportPanel, ReferenceQualityPanel } from './reference-report-panels'
import { StyleDistillReviewDialog } from './style-distill-review-dialog'
import { ReferenceRunSection, ReferenceReviewSection } from './reference-run-panel'
import { ReferenceTemplatePanel } from './reference-template-panel'
import { createWritingStyleExpert } from '@/api/novel-client'
import { WritingStyleProfileEditor } from '../writing-style-profile-editor'

type ReferencePage = 'sources' | 'import' | 'quality' | 'report' | 'analysis' | 'review' | 'template'
type QualityView = 'overview' | 'sections'

const PAGE_ITEMS = [
  { id: 'sources' as const, label: '参考源', icon: Files, step: 1 },
  { id: 'import' as const, label: '导入确认', icon: FileInput, step: 2 },
  { id: 'quality' as const, label: '质量与章节', icon: ScanText, step: 3 },
  { id: 'report' as const, label: '本地报告', icon: BarChart3, step: 4 },
  { id: 'analysis' as const, label: '远端分析', icon: FlaskConical, step: 5 },
  { id: 'review' as const, label: '档案审核', icon: ListChecks, step: 6 },
  { id: 'template' as const, label: '模板与验证', icon: Layers, step: 7 }
]

interface ReferenceAnalysisWorkspaceProps {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onStyleExpertsChanged?: () => void
}

export type ReferenceStyleWorkspaceTab = 'sources' | 'baseline' | 'experts'

export function ReferenceAnalysisWorkspace({
  projectId,
  open,
  onOpenChange,
  onStyleExpertsChanged
}: ReferenceAnalysisWorkspaceProps): ReactElement {
  const queryClient = useQueryClient()
  const [page, setPage] = useState<ReferencePage>('sources')
  const [qualityView, setQualityView] = useState<QualityView>('overview')
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [resumeSourceId, setResumeSourceId] = useState<string | null>(null)
  const [importDirty, setImportDirty] = useState(false)
  const [sectionsDirty, setSectionsDirty] = useState(false)
  const [styleDistillOpen, setStyleDistillOpen] = useState(false)
  const [workspaceTab, setWorkspaceTab] = useState<ReferenceStyleWorkspaceTab>('sources')
  // P4/P5：远端分析产出的待审核档案 id
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null)

  const sourcesQuery = useQuery({
    queryKey: ['reference-analysis', projectId, 'sources'],
    queryFn: () => listReferenceSources(projectId),
    enabled: open
  })
  const selectedSource = useMemo(
    () => sourcesQuery.data?.find((source) => source.id === selectedSourceId) ?? null,
    [selectedSourceId, sourcesQuery.data]
  )
  const parsed =
    selectedSource?.parseStatus === 'parsed' || selectedSource?.parseStatus === 'confirmed'
  const sectionsQuery = useQuery({
    queryKey: ['reference-analysis', selectedSourceId, 'sections'],
    queryFn: () => listReferenceSections(selectedSourceId!),
    enabled: open && parsed && Boolean(selectedSourceId)
  })
  const qualityQuery = useQuery({
    queryKey: ['reference-analysis', selectedSourceId, 'quality'],
    queryFn: () => getReferenceQualityReport(selectedSourceId!),
    enabled: open && parsed && Boolean(selectedSourceId)
  })
  const reportQuery = useQuery({
    queryKey: ['reference-analysis', selectedSourceId, 'report'],
    queryFn: () => getReferenceLocalReport(selectedSourceId!),
    enabled: open && parsed && Boolean(selectedSourceId)
  })

  useEffect(() => {
    if (!selectedSourceId && sourcesQuery.data?.[0]) setSelectedSourceId(sourcesQuery.data[0].id)
  }, [selectedSourceId, sourcesQuery.data])

  function hasUnsavedChanges(): boolean {
    return (
      (page === 'import' && importDirty) ||
      (page === 'quality' && qualityView === 'sections' && sectionsDirty)
    )
  }

  function confirmDiscardChanges(): boolean {
    return !hasUnsavedChanges() || window.confirm('当前页面有未保存的修改，确认放弃并离开吗？')
  }

  function requestPage(nextPage: ReferencePage): void {
    if (nextPage === page || !confirmDiscardChanges()) return
    setImportDirty(false)
    setSectionsDirty(false)
    setPage(nextPage)
  }

  function requestQualityView(nextView: QualityView): void {
    if (nextView === qualityView || !confirmDiscardChanges()) return
    setSectionsDirty(false)
    setQualityView(nextView)
  }

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen && !confirmDiscardChanges()) return
    if (!nextOpen) {
      setImportDirty(false)
      setSectionsDirty(false)
    }
    onOpenChange(nextOpen)
  }

  function refreshSources(source?: ReferenceSourceDetail): void {
    if (source) setSelectedSourceId(source.id)
    void queryClient.invalidateQueries({ queryKey: ['reference-analysis', projectId, 'sources'] })
  }

  function openStyleWorkspaceTab(tab: ReferenceStyleWorkspaceTab): void {
    setWorkspaceTab(tab)
    if (tab === 'experts' || tab === 'baseline') {
      setStyleDistillOpen(false)
    }
  }

  function handleParsed(source: ReferenceSourceDetail): void {
    setResumeSourceId(null)
    setImportDirty(false)
    refreshSources(source)
    void queryClient.invalidateQueries({ queryKey: ['reference-analysis', source.id] })
    setQualityView('overview')
    setPage('quality')
  }

  function handleSectionsUpdated(sections: ReferenceSection[]): void {
    queryClient.setQueryData(['reference-analysis', selectedSourceId, 'sections'], sections)
    void queryClient.invalidateQueries({
      queryKey: ['reference-analysis', selectedSourceId, 'report']
    })
    void queryClient.invalidateQueries({ queryKey: ['reference-analysis', projectId, 'sources'] })
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="flex h-[min(900px,calc(100vh-32px))] w-[min(1280px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
          <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12">
            <DialogTitle>参考小说与文风工作台</DialogTitle>
            <DialogDescription className="text-pretty">
              从参考小说导入、分析并蒸馏文风专家，再在写作会话中召集。
            </DialogDescription>
          </DialogHeader>
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-4 py-2">
            {([
              ['sources', '参考小说'],
              ['baseline', '文风基线'],
              ['experts', '文风专家']
            ] as const).map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                onClick={() => openStyleWorkspaceTab(tab)}
                className={`rounded-md px-3 py-1.5 text-xs ${workspaceTab === tab ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {workspaceTab === 'sources' ? (
            <div className="flex min-h-0 flex-1">
              <aside className="w-48 shrink-0 border-r border-border bg-surface-1 p-2.5">
                <nav className="space-y-0.5" aria-label="参考小说分析页面">
                  {PAGE_ITEMS.map((item) => {
                    const Icon = item.icon
                    const disabled =
                      ((item.id === 'quality' || item.id === 'report' || item.id === 'analysis') && !parsed) ||
                      ((item.id === 'review' || item.id === 'template') && !activeProfileId)
                    const complete =
                      (item.id === 'sources' && Boolean(sourcesQuery.data?.length)) ||
                      (item.id === 'import' && parsed) ||
                      (item.id === 'quality' && Boolean(qualityQuery.data)) ||
                      (item.id === 'report' && Boolean(reportQuery.data)) ||
                      (item.id === 'review' && Boolean(activeProfileId)) ||
                      (item.id === 'template' && Boolean(activeProfileId))
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => requestPage(item.id)}
                        disabled={disabled}
                        aria-current={page === item.id ? 'page' : undefined}
                        className={`flex h-11 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs font-medium transition-[color,background-color,transform] active:scale-[0.96] ${page === item.id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-text'} disabled:pointer-events-none disabled:opacity-40`}
                      >
                        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-2 font-mono text-[10px] tabular-nums">
                          {complete ? <Check className="size-3" /> : item.step}
                        </span>
                        <Icon className="size-4" />
                        <span className="min-w-0 truncate">{item.label}</span>
                      </button>
                    )
                  })}
                </nav>
                {!parsed && selectedSource && (
                  <p className="mx-2 mt-2 text-pretty text-[11px] leading-4 text-muted-foreground">
                    完成编码预检和本地解析后，可查看质量与报告。
                  </p>
                )}
                {selectedSource && (
                  <div className="mt-4 border-t border-border px-2 pt-3">
                    <p
                      className="truncate text-xs font-medium text-text"
                      title={selectedSource.displayName}
                    >
                      {selectedSource.displayName}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {selectedSource.encoding.toUpperCase()} · {selectedSource.chapterCount} 章
                    </p>
                  </div>
                )}
              </aside>
              <div className="min-w-0 flex-1">
                {page === 'sources' && (
                  <SourcePage
                    loading={sourcesQuery.isLoading}
                    error={sourcesQuery.error}
                    sources={sourcesQuery.data ?? []}
                    selectedSourceId={selectedSourceId}
                    onRetry={() => void sourcesQuery.refetch()}
                    onSelect={(source) => {
                      const hasReport =
                        source.parseStatus === 'parsed' || source.parseStatus === 'confirmed'
                      setSelectedSourceId(source.id)
                      setResumeSourceId(hasReport ? null : source.id)
                      requestPage(hasReport ? 'report' : 'import')
                    }}
                    onImport={() => {
                      setSelectedSourceId(null)
                      setResumeSourceId(null)
                      requestPage('import')
                    }}
                  />
                )}
                {page === 'import' && (
                  <ReferenceImportPanel
                    key={resumeSourceId ?? 'new-reference-source'}
                    projectId={projectId}
                    initialSource={
                      sourcesQuery.data?.find((source) => source.id === resumeSourceId) ?? null
                    }
                    onSourceCreated={refreshSources}
                    onParsed={handleParsed}
                    onDirtyChange={setImportDirty}
                  />
                )}
                {page === 'quality' && (
                  <div className="flex h-full min-h-0 flex-col">
                    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
                      <Tabs
                        value={qualityView}
                        onValueChange={(value) => requestQualityView(value as QualityView)}
                      >
                        <TabsList className="h-10">
                          <TabsTrigger value="overview" className="px-3 text-xs">
                            <ScanText className="size-3.5" /> 质量概览
                          </TabsTrigger>
                          <TabsTrigger value="sections" className="px-3 text-xs">
                            <ListChecks className="size-3.5" /> 章节边界
                            {qualityQuery.data?.lowConfidenceSectionIds.length ? (
                              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] tabular-nums text-amber-700 dark:text-amber-300">
                                {qualityQuery.data.lowConfidenceSectionIds.length}
                              </span>
                            ) : null}
                          </TabsTrigger>
                        </TabsList>
                      </Tabs>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!sectionsQuery.data?.some((section) => section.included)}
                          onClick={() => setStyleDistillOpen(true)}
                        >
                          <Sparkles className="size-3.5" /> 蒸馏文风专家
                        </Button>
                        <Button size="sm" onClick={() => requestPage('report')}>
                          <BarChart3 className="size-3.5" /> 查看本地报告
                        </Button>
                      </div>
                    </div>
                    {qualityView === 'overview' ? (
                      <div className="min-h-0 flex-1 overflow-hidden">
                        {qualityQuery.isError ? (
                          <QueryErrorState
                            label="数据质量报告读取失败"
                            error={qualityQuery.error}
                            onRetry={() => void qualityQuery.refetch()}
                          />
                        ) : qualityQuery.data ? (
                          <ReferenceQualityPanel report={qualityQuery.data} />
                        ) : (
                          <LoadingState label="读取数据质量报告" />
                        )}
                      </div>
                    ) : (
                      <div className="min-h-0 flex-1 overflow-y-auto">
                        <div className="border-b border-border px-5 py-3">
                          <h3 className="text-balance text-xs font-semibold text-text">
                            章节边界与分析范围
                          </h3>
                          <p className="mt-1 text-pretty text-[11px] text-muted-foreground">
                            优先确认低置信度边界；偏移基于标准化文本，保存时执行版本与重叠检查。
                          </p>
                        </div>
                        {sectionsQuery.isError ? (
                          <QueryErrorState
                            label="章节边界读取失败"
                            error={sectionsQuery.error}
                            onRetry={() => void sectionsQuery.refetch()}
                          />
                        ) : sectionsQuery.data ? (
                          <ReferenceSectionList
                            sections={sectionsQuery.data}
                            attentionSectionIds={qualityQuery.data?.lowConfidenceSectionIds ?? []}
                            onUpdated={handleSectionsUpdated}
                            onDirtyChange={setSectionsDirty}
                          />
                        ) : (
                          <LoadingState label="读取章节" />
                        )}
                      </div>
                    )}
                  </div>
                )}
                {page === 'report' &&
                  (reportQuery.isError ? (
                    <QueryErrorState
                      label="本地分析报告读取失败"
                      error={reportQuery.error}
                      onRetry={() => void reportQuery.refetch()}
                    />
                  ) : reportQuery.data ? (
                    <ReferenceLocalReportPanel report={reportQuery.data} />
                  ) : (
                    <LoadingState label="读取本地分析报告" />
                  ))}
                {page === 'analysis' && (
                  <div className="h-full min-h-0 overflow-y-auto">
                    <ReferenceRunSection
                      sourceId={selectedSourceId}
                      parsed={parsed}
                      onProfileReady={(profileId) => {
                        setActiveProfileId(profileId)
                        setPage('review')
                      }}
                    />
                  </div>
                )}
                {page === 'review' && (
                  <div className="h-full min-h-0 overflow-y-auto">
                    <ReferenceReviewSection profileId={activeProfileId} />
                  </div>
                )}
                {page === 'template' && (
                  <div className="h-full min-h-0 overflow-hidden">
                    <ReferenceTemplatePanel profileId={activeProfileId} projectId={projectId} />
                  </div>
                )}
              </div>
            </div>
          ) : workspaceTab === 'baseline' ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <WritingStyleProfileEditor projectId={projectId} mode="baseline" />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <WritingStyleProfileEditor projectId={projectId} mode="experts" />
            </div>
          )}
        </DialogContent>
      </Dialog>
      {selectedSource && sectionsQuery.data ? (
        <StyleDistillReviewDialog
          sourceId={selectedSource.id}
          sourceTitle={selectedSource.displayName}
          sectionIds={sectionsQuery.data.filter((section) => section.included).map((section) => section.id)}
          open={styleDistillOpen}
          onOpenChange={setStyleDistillOpen}
          onAccepted={async (draft) => {
            await createWritingStyleExpert(projectId, {
              name: draft.name,
              sourceTitle: selectedSource.displayName,
              description: draft.description,
              distilledPrompt: draft.distilledPrompt,
              metrics: draft.metrics,
              techniques: draft.techniques,
              exclusions: draft.exclusions,
              exemplarPassages: draft.exemplarPassages,
              enabled: true,
              sortOrder: 0,
            })
            onStyleExpertsChanged?.()
          }}
        />
      ) : null}
      </>
  )
}

function SourcePage({
  loading,
  error,
  sources,
  selectedSourceId,
  onRetry,
  onSelect,
  onImport
}: {
  loading: boolean
  error: Error | null
  sources: ReferenceSourceDetail[]
  selectedSourceId: string | null
  onRetry: () => void
  onSelect: (source: ReferenceSourceDetail) => void
  onImport: () => void
}): ReactElement {
  return (
    <div className="h-full overflow-y-auto">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div>
          <h3 className="text-xs font-semibold text-text">参考源</h3>
          <p className="text-[11px] text-muted-foreground">导入草稿、本地解析状态与报告入口</p>
        </div>
        <Button size="sm" onClick={onImport}>
          <Plus className="size-4" /> 导入
        </Button>
      </div>
      {loading ? (
        <LoadingState label="读取参考源" />
      ) : error ? (
        <QueryErrorState label="参考源读取失败" error={error} onRetry={onRetry} />
      ) : sources.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
          <Files className="size-8 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">当前项目还没有参考源</p>
          <Button variant="outline" size="sm" onClick={onImport}>
            <Plus className="size-4" /> 导入第一个参考源
          </Button>
        </div>
      ) : (
        <div className="divide-y divide-border">
          {sources.map((source) => (
            <button
              key={source.id}
              type="button"
              onClick={() => onSelect(source)}
              aria-pressed={selectedSourceId === source.id}
              className={`grid min-h-14 w-full gap-2 px-5 py-3 text-left transition-[color,background-color,transform] active:scale-[0.99] sm:grid-cols-[1fr_120px_120px_100px] sm:items-center ${selectedSourceId === source.id ? 'bg-primary/5' : 'hover:bg-muted/60'}`}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text">{source.displayName}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {source.inputKind === 'file' ? '文件' : '粘贴'} ·{' '}
                  {source.fileFormat.toUpperCase()} · {(source.fileSize / 1024).toFixed(1)} KB
                </p>
              </div>
              <span className="text-xs text-text">{source.encoding.toUpperCase()}</span>
              <span className="text-xs tabular-nums text-text">
                {source.characterCount.toLocaleString()} 字符
              </span>
              <span
                className={`text-xs ${source.parseStatus === 'parsed' ? 'text-success' : 'text-amber-600 dark:text-amber-300'}`}
              >
                {source.parseStatus === 'parsed' ? '报告已生成' : '待确认'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function LoadingState({ label }: { label: string }): ReactElement {
  return (
    <div className="flex h-full min-h-32 items-center justify-center gap-2 text-xs text-muted-foreground">
      <LoaderCircle className="size-4 animate-spin" /> {label}
    </div>
  )
}

function QueryErrorState({
  label,
  error,
  onRetry
}: {
  label: string
  error: unknown
  onRetry: () => void
}): ReactElement {
  const message = error instanceof Error ? error.message : '请检查本地服务后重试'
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertCircle className="size-5" />
      </span>
      <div>
        <p className="text-sm font-medium text-text">{label}</p>
        <p className="mt-1 max-w-md text-pretty text-xs text-muted-foreground">{message}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RotateCcw className="size-3.5" /> 重试
      </Button>
    </div>
  )
}
