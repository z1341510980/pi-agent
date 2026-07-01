import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ReactFlowProvider } from '@xyflow/react'
import { ArrowLeft, Download, Sparkles, Database, ScrollText, LayoutGrid, Grid3x3, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ResizableSplitter } from '@/components/ui/resizable-splitter'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
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
  listFactions,
  listLocations,
  listWorldElements,
  listEdges,
  listVolumes,
  createChapter,
  completeChapter,
} from '@/api/novel-client'
import { useNovelCreationFlow } from '@/hooks/use-novel-creation-flow'
import { NovelSidebar } from './novel-sidebar'
import { NovelToolbar } from './novel-toolbar'
import { NovelCanvas } from './novel-canvas'
import { NovelDetailPanel } from './novel-detail-panel'
import { ChapterLivePanel } from './chapter-live-view'
import { CacheMonitorPanel } from './cache-monitor-panel'
import { AgentLogPanel } from './agent-log-panel'
import { MatrixWorkspace } from './matrix/matrix-workspace'
import { ChapterContentEditor } from './chapter-content-editor'

// ── 视图切换组件（矩阵 / 画布）──

interface ViewSwitcherProps {
  value: 'matrix' | 'canvas'
  onChange: (mode: 'matrix' | 'canvas') => void
}

function ViewSwitcher({ value, onChange }: ViewSwitcherProps): ReactElement {
  const base = 'inline-flex items-center gap-1 h-7 px-2.5 text-[11px] rounded-md transition-colors'
  const active = 'bg-surface-3 text-text border border-border'
  const inactive = 'text-muted-foreground hover:text-text hover:bg-muted/50 border border-transparent'
  return (
    <div className="inline-flex items-center gap-0.5 p-0.5 bg-surface-1 border border-border rounded-lg">
      <button
        type="button"
        className={`${base} ${value === 'matrix' ? active : inactive}`}
        onClick={() => onChange('matrix')}
        title="矩阵视图"
      >
        <Grid3x3 className="size-3" />
        <span className="leading-none">矩阵</span>
      </button>
      <button
        type="button"
        className={`${base} ${value === 'canvas' ? active : inactive}`}
        onClick={() => onChange('canvas')}
        title="画布视图"
      >
        <LayoutGrid className="size-3" />
        <span className="leading-none">画布</span>
      </button>
    </div>
  )
}

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
  const factions = useNovelStore((s) => s.factions)
  const locations = useNovelStore((s) => s.locations)
  const worldElements = useNovelStore((s) => s.worldElements)
  const upsertChapter = useNovelStore((s) => s.upsertChapter)
  const viewMode = useNovelStore((s) => s.viewMode)
  const setViewMode = useNovelStore((s) => s.setViewMode)
  const characterHistory = useNovelStore((s) => s.characterHistory)
  const setCreationMode = useNovelStore((s) => s.setCreationMode)

  const queryClient = useQueryClient()

  // 创作流程
  const creationFlow = useNovelCreationFlow()
  const [creationChapterNumber, setCreationChapterNumber] = useState<number | undefined>(undefined)

  const [relayoutSignal, setRelayoutSignal] = useState(0)
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const [detailWidth, setDetailWidth] = useState(420)
  const [nodeCount, setNodeCount] = useState(0)
  const [cachePanelOpen, setCachePanelOpen] = useState(false)
  const [logPanelOpen, setLogPanelOpen] = useState(false)

  // 正文编辑器高度（垂直分割持久化到 localStorage）
  const [contentEditorHeight, setContentEditorHeight] = useState<number>(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('pi-agent-content-split') : null
    return saved ? Number(saved) : 300
  })

  const handleContentEditorHeightChange = useCallback((size: number) => {
    setContentEditorHeight(size)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('pi-agent-content-split', String(size))
    }
  }, [])

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
        facs,
        locs,
        wel,
        eds,
        vols,
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
        listFactions(currentProjectId),
        listLocations(currentProjectId),
        listWorldElements(currentProjectId),
        listEdges(currentProjectId),
        listVolumes(currentProjectId),
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
        factions: facs,
        locations: locs,
        worldElements: wel,
        edges: eds,
        volumes: vols,
      }
    },
    enabled: !!currentProjectId,
    refetchInterval: 300_000,
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
      factions,
      locations,
      worldElements,
      exportedAt: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${currentProject.title || 'novel'}-export.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [currentProject, characters, chapters, conflicts, foreshadows, relationships, clues, worldRules, styleGuides, constraints, infoLayers, factions, locations, worldElements])

  // ── 创作流程 ──

  const handleStartCreation = useCallback(async (mode: 'manual' | 'ai-arrange') => {
    if (!currentProjectId || creationFlow.isRunning) return
    const playhead = useNovelStore.getState().playheadChapter
    const chapter = chapters.find((c) => c.chapterNumber === playhead)
    if (!chapter) return
    setCreationMode(mode)
    setCreationChapterNumber(playhead)
    if (mode === 'manual') {
      // 模式1：从矩阵本章列读取已编排实体
      const arranged = {
        characterIds: characterHistory.filter((h) => h.chapterNumber === playhead).map((h) => h.characterId),
        conflictIds: conflicts.filter((c) => c.firstChapter === playhead).map((c) => c.id),
        foreshadowIds: foreshadows.filter((f) => f.firstChapter === playhead).map((f) => f.id),
      }
      await creationFlow.startCreation(currentProjectId, playhead, { arrangedEntities: arranged })
    } else {
      // 模式2：AI 编排
      await creationFlow.aiArrange(currentProjectId, playhead)
    }
  }, [currentProjectId, chapters, creationFlow, characterHistory, conflicts, foreshadows, setCreationMode])

  // 重新创作已有章节：右键章节节点触发，章节已存在无需 createChapter，
  // 直接以原章节号启动创作流程（覆盖旧内容）
  const handleRegenerateChapter = useCallback(async (chapterNumber: number) => {
    if (!currentProjectId || creationFlow.isRunning) return
    const chapter = chapters.find((c) => c.chapterNumber === chapterNumber)
    if (!chapter) return
    setCreationChapterNumber(chapterNumber)
    await creationFlow.startCreation(currentProjectId, chapterNumber)
  }, [currentProjectId, chapters, creationFlow])

  // 从指定章节开始新创作流程（用于时间轴右键菜单"从此章开始创作"）
  // 若该章节号不存在，先创建空章节再启动流程
  const handleStartCreationAt = useCallback(async (chapterNumber: number) => {
    if (!currentProjectId || creationFlow.isRunning) return
    const existing = chapters.find((c) => c.chapterNumber === chapterNumber)
    if (!existing) {
      try {
        const chapter = await createChapter(currentProjectId, {
          chapterNumber,
          narrativeTask: {
            description: '推进主线剧情',
            type: 'advance_mainline',
            priority: 'medium',
          },
        })
        upsertChapter(chapter)
        void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
      } catch {
        return
      }
    }
    setCreationChapterNumber(chapterNumber)
    await creationFlow.startCreation(currentProjectId, chapterNumber)
  }, [currentProjectId, chapters, creationFlow, upsertChapter, queryClient])

  // 收到 data_changed 事件时刷新画布（替代轮询）
  // Memory Agent 写入实体状态后会推送带 dataChanged 标记的 agent_output，
  // 监听 agentOutputs 末尾的 dataChanged 标记，触发 React Query 失效刷新。
  useEffect(() => {
    const lastOutput = creationFlow.agentOutputs[creationFlow.agentOutputs.length - 1]
    if (lastOutput?.dataChanged && currentProjectId) {
      void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
    }
  }, [creationFlow.agentOutputs, currentProjectId, queryClient])

  // 创作完成后不自动保存——由用户通过"保存到章节"按钮手动触发，
  // 避免 useEffect 依赖 chapters 导致 completeChapter → upsertChapter → chapters 变化 → 无限循环
  const handleSaveChapter = useCallback(async (content: string) => {
    if (!currentProjectId || creationChapterNumber == null) return
    const targetChapter = chapters.find((c) => c.chapterNumber === creationChapterNumber)
    if (!targetChapter) return
    try {
      const updated = await completeChapter(targetChapter.id, { content })
      upsertChapter(updated)
      void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
      // 保存成功后重置创作流程状态，切回节点详情面板
      creationFlow.reset()
    } catch (err) {
      console.error('[NovelWorkspace] 保存章节失败:', err)
    }
  }, [currentProjectId, creationChapterNumber, chapters, upsertChapter, queryClient, creationFlow])

  const handleDiscardCreation = useCallback(() => {
    creationFlow.cancel()
    creationFlow.reset()
    if (currentProjectId) {
      void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
    }
  }, [creationFlow, currentProjectId, queryClient])

  const handleSendMessage = useCallback((message: string) => {
    creationFlow.sendMessage(message)
  }, [creationFlow])

  // 创作激活状态：运行中或处于非 idle 阶段时，右侧栏切换为创作预览面板
  const isCreationActive = creationFlow.isRunning || creationFlow.phase !== 'idle'

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
            {nodeCount > 0 && (
              <span className="text-[10px] text-muted-foreground bg-muted/50 rounded px-1.5 py-0.5">
                {nodeCount} 节点
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="default"
              onClick={() => handleStartCreation('manual')}
              disabled={!currentProject || creationFlow.isRunning}
              title="模式1：从矩阵本章列读取已编排实体，启动多 Agent 创作流程"
            >
              <Sparkles className="size-3.5" />
              <span className="hidden sm:inline">手动编排</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleStartCreation('ai-arrange')}
              disabled={!currentProject || creationFlow.isRunning}
              title="模式2：AI 自动编排实体并生成正文"
            >
              <Wand2 className="size-3.5" />
              <span className="hidden sm:inline">AI编排</span>
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setCachePanelOpen(true)}
              disabled={!currentProject}
              title="缓存诊断"
            >
              <Database className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setLogPanelOpen(true)}
              disabled={!currentProject}
              title="Agent 调用日志"
            >
              <ScrollText className="size-3.5" />
            </Button>
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

        {/* 工具栏（仅画布视图显示；矩阵视图自带工具栏） */}
        {currentProject && viewMode === 'canvas' && (
          <NovelToolbar
            onRelayout={handleRelayout}
            onExport={handleExport}
          />
        )}

        {/* 主体三栏布局 */}
        <div className="flex min-h-0 flex-1">
          {/* 左侧栏 */}
          <div style={{ width: sidebarWidth }} className="shrink-0 h-full min-h-0 overflow-hidden">
            <NovelSidebar onStartCreation={handleStartCreation} />
          </div>
          <ResizableSplitter
            direction="horizontal"
            size={sidebarWidth}
            minSize={180}
            maxSize={360}
            onSizeChange={setSidebarWidth}
            side="left"
          />

          {/* 主内容区：矩阵 / 画布可切换 */}
          <main className="flex-1 min-w-0 h-full overflow-hidden flex flex-col">
            {currentProject ? (
              <>
                {/* 视图切换条 */}
                <div
                  className="flex items-center justify-between px-3 h-9 border-b shrink-0"
                  style={{
                    background: 'var(--color-surface-1)',
                    borderColor: 'var(--color-border)',
                  }}
                >
                  <ViewSwitcher value={viewMode} onChange={setViewMode} />
                  <span
                    className="text-[10px]"
                    style={{ color: 'var(--color-subtle)' }}
                  >
                    {viewMode === 'matrix' ? '矩阵视图' : '画布视图'}
                  </span>
                </div>

                <div className="flex-1 min-h-0 flex flex-col">
                  {viewMode === 'matrix' ? (
                    <>
                      {/* 上：章节正文编辑器 */}
                      <div style={{ height: contentEditorHeight }} className="shrink-0 min-h-[120px] overflow-hidden">
                        <ChapterContentEditor
                          isCreationActive={isCreationActive}
                          creationChapterNumber={creationChapterNumber}
                          creationChapterContent={creationFlow.chapterContent}
                        />
                      </div>
                      <ResizableSplitter
                        direction="vertical"
                        size={contentEditorHeight}
                        minSize={120}
                        maxSize={800}
                        onSizeChange={handleContentEditorHeightChange}
                        side="top"
                      />
                      {/* 下：矩阵视图 */}
                      <div className="flex-1 min-h-[200px] overflow-hidden">
                        <MatrixWorkspace
                          creationRunning={creationFlow.isRunning}
                          creationChapterNumber={creationChapterNumber}
                          onRegenerateChapter={handleRegenerateChapter}
                          onStartCreationAt={handleStartCreationAt}
                        />
                      </div>
                    </>
                  ) : (
                    <NovelCanvas
                      relayoutSignal={relayoutSignal}
                      creationPhase={creationFlow.phase}
                      creationRunning={creationFlow.isRunning}
                      creationChapterNumber={creationChapterNumber}
                      creationError={creationFlow.error}
                      onCancelCreation={handleDiscardCreation}
                      onNodeCountChange={setNodeCount}
                      onRegenerateChapter={handleRegenerateChapter}
                    />
                  )}
                </div>
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                <div className="text-center">
                  <p className="text-sm">请在左侧选择或创建一个项目</p>
                </div>
              </div>
            )}
          </main>

          {/* 右侧详情栏：创作中显示实时预览面板，否则显示详情面板 */}
          <ResizableSplitter
            direction="horizontal"
            size={detailWidth}
            minSize={280}
            maxSize={600}
            onSizeChange={setDetailWidth}
            side="right"
          />
          <aside style={{ width: detailWidth }} className="shrink-0 h-full min-h-0 overflow-hidden">
            {isCreationActive ? (
              <ChapterLivePanel
                phase={creationFlow.phase}
                isRunning={creationFlow.isRunning}
                chapterContent={creationFlow.chapterContent}
                agentOutputs={creationFlow.agentOutputs}
                chapterNumber={creationChapterNumber}
                currentCheckpoint={creationFlow.currentCheckpoint}
                result={creationFlow.result}
                error={creationFlow.error}
                onSubmitCheckpoint={creationFlow.submitCheckpoint}
                onSave={handleSaveChapter}
                onDiscard={handleDiscardCreation}
                onSendMessage={handleSendMessage}
                userMessages={creationFlow.userMessages}
              />
            ) : (
              <NovelDetailPanel />
            )}
          </aside>
        </div>

        {/* 缓存诊断弹窗 */}
        <Dialog open={cachePanelOpen} onOpenChange={setCachePanelOpen}>
          <DialogContent className="sm:max-w-md max-h-[80vh] p-0 gap-0">
            <DialogHeader className="px-4 py-3 border-b border-border">
              <DialogTitle className="flex items-center gap-2 text-sm">
                <Database className="size-4 text-primary" />
                缓存诊断
              </DialogTitle>
              <DialogDescription className="text-xs">
                提示词缓存命中率监控
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[60vh] overflow-y-auto">
              <CacheMonitorPanel chapterNumber={creationChapterNumber} />
            </div>
          </DialogContent>
        </Dialog>

        {/* Agent 调用日志弹窗 */}
        <Dialog open={logPanelOpen} onOpenChange={setLogPanelOpen}>
          <DialogContent className="sm:max-w-2xl max-h-[85vh] p-0 gap-0">
            <DialogHeader className="px-4 py-3 border-b border-border">
              <DialogTitle className="flex items-center gap-2 text-sm">
                <ScrollText className="size-4 text-primary" />
                Agent 调用日志
              </DialogTitle>
              <DialogDescription className="text-xs">
                记录每次 Agent 调用的完整上下文（系统提示词 / 章节上下文 / 任务指令 / 工具 / 结果）
              </DialogDescription>
            </DialogHeader>
            <div className="h-[70vh]">
              <AgentLogPanel chapterNumber={creationChapterNumber} />
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </ReactFlowProvider>
  )
}
