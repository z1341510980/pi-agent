import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BarChart3, FileInput, Files, ScanText, Plus, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
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

type ReferencePage = 'sources' | 'import' | 'quality' | 'report'

const PAGE_ITEMS = [
  { id: 'sources' as const, label: '参考源', icon: Files },
  { id: 'import' as const, label: '导入确认', icon: FileInput },
  { id: 'quality' as const, label: '文本质量', icon: ScanText },
  { id: 'report' as const, label: '本地报告', icon: BarChart3 }
]

interface ReferenceAnalysisWorkspaceProps {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ReferenceAnalysisWorkspace({
  projectId,
  open,
  onOpenChange
}: ReferenceAnalysisWorkspaceProps): ReactElement {
  const queryClient = useQueryClient()
  const [page, setPage] = useState<ReferencePage>('sources')
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [resumeSourceId, setResumeSourceId] = useState<string | null>(null)

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

  function refreshSources(source?: ReferenceSourceDetail): void {
    if (source) setSelectedSourceId(source.id)
    void queryClient.invalidateQueries({ queryKey: ['reference-analysis', projectId, 'sources'] })
  }

  function handleParsed(source: ReferenceSourceDetail): void {
    setResumeSourceId(null)
    refreshSources(source)
    void queryClient.invalidateQueries({ queryKey: ['reference-analysis', source.id] })
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(860px,calc(100vh-32px))] w-[min(1180px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12">
          <DialogTitle>参考小说分析</DialogTitle>
          <DialogDescription>阶段 1 本地分析 · 原文与当前项目事实隔离</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1">
          <aside className="w-44 shrink-0 border-r border-border bg-surface-1 p-2">
            <nav className="space-y-0.5" aria-label="参考小说分析页面">
              {PAGE_ITEMS.map((item) => {
                const Icon = item.icon
                const disabled = (item.id === 'quality' || item.id === 'report') && !parsed
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setPage(item.id)}
                    disabled={disabled}
                    className={`flex h-9 w-full items-center gap-2 rounded px-2.5 text-left text-xs font-medium transition-colors ${page === item.id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-text'} disabled:pointer-events-none disabled:opacity-40`}
                  >
                    <Icon className="size-4" /> {item.label}
                  </button>
                )
              })}
            </nav>
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
                sources={sourcesQuery.data ?? []}
                selectedSourceId={selectedSourceId}
                onSelect={(source) => {
                  const hasReport =
                    source.parseStatus === 'parsed' || source.parseStatus === 'confirmed'
                  setSelectedSourceId(source.id)
                  setResumeSourceId(hasReport ? null : source.id)
                  setPage(hasReport ? 'report' : 'import')
                }}
                onImport={() => {
                  setSelectedSourceId(null)
                  setResumeSourceId(null)
                  setPage('import')
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
              />
            )}
            {page === 'quality' && (
              <div className="grid h-full min-h-0 grid-rows-[minmax(220px,0.8fr)_minmax(260px,1.2fr)]">
                <div className="min-h-0 overflow-hidden border-b border-border">
                  {qualityQuery.data ? (
                    <ReferenceQualityPanel report={qualityQuery.data} />
                  ) : (
                    <LoadingState label="读取数据质量报告" />
                  )}
                </div>
                <div className="min-h-0 overflow-y-auto">
                  <div className="flex items-center justify-between px-4 py-3">
                    <div>
                      <h3 className="text-xs font-semibold text-text">章节边界与分析范围</h3>
                      <p className="text-[11px] text-muted-foreground">
                        偏移基于标准化文本，保存时执行版本与重叠检查
                      </p>
                    </div>
                  </div>
                  {sectionsQuery.data ? (
                    <ReferenceSectionList
                      sections={sectionsQuery.data}
                      onUpdated={handleSectionsUpdated}
                    />
                  ) : (
                    <LoadingState label="读取章节" />
                  )}
                </div>
              </div>
            )}
            {page === 'report' &&
              (reportQuery.data ? (
                <ReferenceLocalReportPanel report={reportQuery.data} />
              ) : (
                <LoadingState label="读取本地分析报告" />
              ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SourcePage({
  loading,
  sources,
  selectedSourceId,
  onSelect,
  onImport
}: {
  loading: boolean
  sources: ReferenceSourceDetail[]
  selectedSourceId: string | null
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
              className={`grid w-full gap-2 px-5 py-3 text-left transition-colors sm:grid-cols-[1fr_120px_120px_100px] sm:items-center ${selectedSourceId === source.id ? 'bg-primary/5' : 'hover:bg-muted/60'}`}
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
