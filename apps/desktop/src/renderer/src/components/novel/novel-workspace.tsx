import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ReactFlowProvider } from '@xyflow/react'
import { ArrowLeft, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ResizableSplitter } from '@/components/ui/resizable-splitter'
import { useNovelStore } from '@/stores/novel-store'
import {
  listCharacters,
  listChapters,
  listConflicts,
  listForeshadowing,
  listRelationships,
  listClues,
  listWorldRules,
  listStyleGuides,
  listConstraints,
  listInfoLayers,
} from '@/api/novel-client'
import { NovelSidebar } from './novel-sidebar'
import { NovelToolbar } from './novel-toolbar'
import { NovelCanvas } from './novel-canvas'
import { NovelDetailPanel } from './novel-detail-panel'

export interface NovelWorkspaceProps {
  onClose: () => void
}

export function NovelWorkspace({ onClose }: NovelWorkspaceProps): ReactElement {
  const currentProjectId = useNovelStore((s) => s.currentProjectId)
  const projects = useNovelStore((s) => s.projects)
  const loadProjectData = useNovelStore((s) => s.loadProjectData)
  const clearProjectData = useNovelStore((s) => s.clearProjectData)
  const characters = useNovelStore((s) => s.characters)
  const chapters = useNovelStore((s) => s.chapters)
  const conflicts = useNovelStore((s) => s.conflicts)
  const foreshadows = useNovelStore((s) => s.foreshadows)
  const relationships = useNovelStore((s) => s.relationships)
  const clues = useNovelStore((s) => s.clues)
  const worldRules = useNovelStore((s) => s.worldRules)
  const styleGuides = useNovelStore((s) => s.styleGuides)
  const constraints = useNovelStore((s) => s.constraints)
  const infoLayers = useNovelStore((s) => s.infoLayers)

  const [layoutMode, setLayoutMode] = useState<'auto' | 'free'>('auto')
  const [relayoutSignal, setRelayoutSignal] = useState(0)
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const [detailWidth, setDetailWidth] = useState(320)

  const currentProject = projects.find((p) => p.id === currentProjectId) ?? null

  // 拉取当前项目的全部实体数据
  const projectDataQuery = useQuery({
    queryKey: ['novel-project-data', currentProjectId],
    queryFn: async () => {
      if (!currentProjectId) return null
      const [
        chars,
        chaps,
        confl,
        fores,
        rels,
        cls,
        wrules,
        sguides,
        constr,
        infos,
      ] = await Promise.all([
        listCharacters(currentProjectId),
        listChapters(currentProjectId),
        listConflicts(currentProjectId),
        listForeshadowing(currentProjectId),
        listRelationships(currentProjectId),
        listClues(currentProjectId),
        listWorldRules(currentProjectId),
        listStyleGuides(currentProjectId),
        listConstraints(currentProjectId),
        listInfoLayers(currentProjectId),
      ])
      return {
        characters: chars,
        chapters: chaps,
        conflicts: confl,
        foreshadows: fores,
        relationships: rels,
        clues: cls,
        worldRules: wrules,
        styleGuides: sguides,
        constraints: constr,
        infoLayers: infos,
      }
    },
    enabled: !!currentProjectId,
    refetchInterval: 30_000,
  })

  // 同步到 store
  useEffect(() => {
    if (projectDataQuery.data) {
      loadProjectData(projectDataQuery.data)
    }
  }, [projectDataQuery.data, loadProjectData])

  // 切换项目时清空旧数据
  useEffect(() => {
    if (!currentProjectId) {
      clearProjectData()
    }
  }, [currentProjectId, clearProjectData])

  const handleRelayout = useCallback(() => {
    setRelayoutSignal((n) => n + 1)
  }, [])

  const handleExport = useCallback(() => {
    if (!currentProject) return
    const payload = {
      project: currentProject,
      characters,
      chapters,
      conflicts,
      foreshadows,
      relationships,
      clues,
      worldRules,
      styleGuides,
      constraints,
      infoLayers,
      exportedAt: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${currentProject.title || 'novel'}-export.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [currentProject, characters, chapters, conflicts, foreshadows, relationships, clues, worldRules, styleGuides, constraints, infoLayers])

  return (
    <ReactFlowProvider>
      <div className="flex h-screen flex-col bg-app-bg text-text overflow-hidden">
        {/* 顶部标题栏 */}
        <header className="flex items-center justify-between h-11 px-3 border-b border-border bg-surface-1 shrink-0">
          <div className="flex items-center gap-2">
            <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="返回">
              <ArrowLeft className="size-4" />
            </Button>
            <span className="text-sm font-semibold">
              {currentProject?.title ?? '小说工作台'}
            </span>
            {currentProject && (
              <span className="text-xs text-muted-foreground">
                · {currentProject.genre}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={handleExport}
              disabled={!currentProject}
              title="导出项目数据"
            >
              <Download className="size-3.5" />
              <span className="hidden sm:inline">导出</span>
            </Button>
          </div>
        </header>

        {/* 工具栏 */}
        <NovelToolbar
          layoutMode={layoutMode}
          onLayoutModeChange={setLayoutMode}
          onRelayout={handleRelayout}
          onExport={handleExport}
        />

        {/* 主体三栏布局 */}
        <div className="flex min-h-0 flex-1">
          {/* 左侧栏 */}
          <div style={{ width: sidebarWidth }} className="shrink-0 h-full min-h-0 overflow-hidden">
            <NovelSidebar />
          </div>
          <ResizableSplitter
            direction="horizontal"
            size={sidebarWidth}
            minSize={180}
            maxSize={360}
            onSizeChange={setSidebarWidth}
            side="left"
          />

          {/* 画布 */}
          <main className="flex-1 min-w-0 h-full overflow-hidden">
            {currentProject ? (
              <NovelCanvas layoutMode={layoutMode} relayoutSignal={relayoutSignal} />
            ) : (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                <div className="text-center">
                  <p className="text-sm">请在左侧选择或创建一个项目</p>
                </div>
              </div>
            )}
          </main>

          {/* 右侧详情栏 */}
          <ResizableSplitter
            direction="horizontal"
            size={detailWidth}
            minSize={240}
            maxSize={520}
            onSizeChange={setDetailWidth}
            side="right"
          />
          <aside style={{ width: detailWidth }} className="shrink-0 h-full min-h-0 overflow-hidden">
            <NovelDetailPanel />
          </aside>
        </div>
      </div>
    </ReactFlowProvider>
  )
}
