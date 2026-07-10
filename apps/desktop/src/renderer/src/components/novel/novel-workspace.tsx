import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ReactFlowProvider } from '@xyflow/react'
import { DndContext, DragOverlay, PointerSensor, KeyboardSensor, useSensor, useSensors, closestCenter, type Active } from '@dnd-kit/core'
import { ArrowLeft, Download, Sparkles, Database, ScrollText, LayoutGrid, Grid3x3, Sparkle } from 'lucide-react'
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
  listProjectCharacterHistory,
  createChapter,
  completeChapter,
  type SimilarityEntityKind,
} from '@/api/novel-client'
import { useNovelCreationFlow } from '@/hooks/use-novel-creation-flow'
import { useNovelSimilarityScan } from '@/hooks/use-novel-similarity-scan'
import { useShortcut } from '@/hooks/use-shortcut'
import { toastSuccess, toastError } from '@/hooks/use-toast'
import { NovelSidebar } from './novel-sidebar'
import { NovelToolbar } from './novel-toolbar'
import { NovelCanvas } from './novel-canvas'
import { NovelDetailPanel } from './novel-detail-panel'
import { ChapterLivePanel } from './chapter-live-view'
import { SimilarityScanPanel } from './similarity-scan-panel'
import { CacheMonitorPanel } from './cache-monitor-panel'
import { AgentLogPanel } from './agent-log-panel'
import { MatrixWorkspace } from './matrix/matrix-workspace'
import { computeCharacterSpans, GROUP_META, type MatrixDragData } from './matrix/matrix-logic'
import { ChapterContentEditor } from './chapter-content-editor'
import { ErrorBoundary } from '@/components/overlays/error-boundary'
import { MatrixErrorFallback } from './matrix-error-fallback'
import { CanvasErrorFallback } from './canvas-error-fallback'
import { CreationErrorFallback } from './creation-error-fallback'

// ── 视图切换组件（矩阵 / 画布）──

interface ViewSwitcherProps {
  value: 'matrix' | 'canvas'
  onChange: (mode: 'matrix' | 'canvas') => void
}

function ViewSwitcher({ value, onChange }: ViewSwitcherProps): ReactElement {
  const base = 'inline-flex items-center gap-1 h-7 px-2.5 text-[11px] rounded-md transition-[color,background-color,border-color,transform] active:scale-[0.96]'
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

// ── 相似度扫描实体类型中文标签（含 world_element）──
const SIMILARITY_KIND_LABEL: Record<SimilarityEntityKind, string> = {
  character: '角色',
  conflict: '冲突',
  foreshadow: '伏笔',
  faction: '势力',
  location: '地点',
  world_element: '世界要素',
}

function similarityKindLabel(kind: SimilarityEntityKind): string {
  return SIMILARITY_KIND_LABEL[kind] ?? kind
}

// ── 拖拽预览卡片：根据拖源类型渲染不同的 floating 提示 ──
function MatrixDragPreview({ data }: { data: MatrixDragData | null }): ReactElement | null {
  if (!data) return null
  const meta = GROUP_META[data.entityType]
  if (data.source === 'sidebar') {
    return (
      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border bg-surface-1 shadow-lg text-xs" style={{ borderColor: meta.color }}>
        <span className="size-2 rounded-full" style={{ background: meta.color }} />
        <span className="font-medium text-text">{data.name}</span>
        <span className="text-muted-foreground">拖到章节列标记出场</span>
      </div>
    )
  }
  if (data.source === 'endpoint') {
    return (
      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border bg-surface-1 shadow-lg text-xs" style={{ borderColor: meta.color }}>
        <span className="size-2 rounded-full" style={{ background: meta.color }} />
        <span className="font-medium text-text">{data.end === 'start' ? '调整起点' : '调整终点'}</span>
      </div>
    )
  }
  // cell
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border bg-surface-1 shadow-lg text-xs" style={{ borderColor: meta.color }}>
      <span className="size-2 rounded-full" style={{ background: meta.color }} />
      <span className="font-medium text-text">移动到新章节</span>
    </div>
  )
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
  const setCharacterHistory = useNovelStore((s) => s.setCharacterHistory)
  const setCreationMode = useNovelStore((s) => s.setCreationMode)
  const creationMode = useNovelStore((s) => s.creationMode)
  const playheadChapter = useNovelStore((s) => s.playheadChapter)

  // ── 全局快捷键：撤销/重做（编辑器内由 Tiptap 自行处理）──
  useShortcut({
    onUndo: () => useNovelStore.getState().undo(),
    onRedo: () => useNovelStore.getState().redo(),
  })

  const queryClient = useQueryClient()

  // 创作流程
  const creationFlow = useNovelCreationFlow()
  const [creationChapterNumber, setCreationChapterNumber] = useState<number | undefined>(undefined)
  // 创作子模式切换：编排模式（create-flow）/ 群聊模式（create-discussion）
  const [creationMode2, setCreationMode2] = useState<'workflow' | 'discussion'>('workflow')
  // 互斥锁：防止 header 按钮快速双击导致 creationMode 标记与流程实际启动状态错位
  // （creationFlow.isRunning 是 React state，setState 异步生效，ref 在 await 期间立即生效）
  const startCreationLockRef = useRef(false)

  const [relayoutSignal, setRelayoutSignal] = useState(0)
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const [detailWidth, setDetailWidth] = useState(420)
  const [nodeCount, setNodeCount] = useState(0)
  const [cachePanelOpen, setCachePanelOpen] = useState(false)
  const [logPanelOpen, setLogPanelOpen] = useState(false)

  // ── LLM 相似度扫描（SSE 流式扫描 + 多选弹框 + REST 合并）──
  const similarityScan = useNovelSimilarityScan()
  const [similarityDialogOpen, setSimilarityDialogOpen] = useState(false)
  // 用户勾选的组索引集合（默认全选）
  const [selectedGroupIndices, setSelectedGroupIndices] = useState<Set<number>>(new Set())
  // 记录是否已对本次扫描 toast 过"开始扫描"，避免重复
  const similarityStartedRef = useRef(false)

  // ── @dnd-kit 拖拽上下文：侧边栏 → 矩阵 + 矩阵内端点/单元格拖拽 ──
  // PointerSensor 使用 distance:6 激活约束，区分点击（< 6px）与拖拽（≥ 6px），
  // 保证单元格 onClick 切换出场、实体项 onClick 选中仍能正常触发。
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  )
  const [activeDrag, setActiveDrag] = useState<Active | null>(null)

  // 正文编辑器高度（垂直分割持久化到 localStorage）
  const [contentEditorHeight, setContentEditorHeight] = useState<number>(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('wenlang-agent-content-split') : null
    return saved ? Number(saved) : 300
  })

  const handleContentEditorHeightChange = useCallback((size: number) => {
    setContentEditorHeight(size)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('wenlang-agent-content-split', String(size))
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

  // ── LLM 相似度扫描（SSE 流式扫描 + 多选弹框 + REST 合并）──

  // 启动扫描：重置 ref 标记并调用 hook
  const handleStartSimilarityScan = useCallback(async () => {
    if (!currentProjectId || similarityScan.isScanning) return
    similarityStartedRef.current = false
    setSelectedGroupIndices(new Set())
    await similarityScan.startScan(currentProjectId)
  }, [currentProjectId, similarityScan])

  // 监听扫描阶段变化：打开/关闭弹框 + toast 关键节点
  // 注意：依赖项只取 phase/report/error/reset 这些稳定引用，不能放整个 similarityScan 对象
  // （hook 每次重渲染返回新对象引用，会导致 effect 重复触发 → setState → 无限循环）
  const { phase: scanPhase, report: scanReport, error: scanError, reset: scanReset } = similarityScan
  useEffect(() => {
    // scanning 开始时 toast 一次
    if (scanPhase === 'scanning' && !similarityStartedRef.current) {
      similarityStartedRef.current = true
      toastSuccess('开始 AI 相似度扫描', '正在用 LLM 分析语义相似的实体...')
    }
    // 扫描完成且有报告 → 打开弹框，默认全选
    if (scanPhase === 'completed' && scanReport) {
      if (scanReport.groups.length === 0) {
        toastSuccess('未发现相似实体', '所有实体条目均唯一，无需整理')
        scanReset()
        return
      }
      // 默认全选所有组
      setSelectedGroupIndices(new Set(scanReport.groups.map((_, i) => i)))
      setSimilarityDialogOpen(true)
    }
    // 取消 → 关闭弹框
    if (scanPhase === 'cancelled') {
      setSimilarityDialogOpen(false)
    }
    // 错误 → toast
    if (scanPhase === 'error' && scanError) {
      setSimilarityDialogOpen(false)
      toastError('相似度扫描失败', scanError)
    }
  }, [scanPhase, scanReport, scanError, scanReset])

  // 切换某组的勾选状态
  const toggleGroupSelection = useCallback((idx: number) => {
    setSelectedGroupIndices((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }, [])

  // 全选 / 全不选
  const toggleAllGroups = useCallback((selectAll: boolean) => {
    if (!similarityScan.report) return
    setSelectedGroupIndices(selectAll ? new Set(similarityScan.report.groups.map((_, i) => i)) : new Set())
  }, [similarityScan.report])

  // 确认合并：把勾选的组提交给后端执行字段级合并
  const handleSimilarityMerge = useCallback(async () => {
    if (!currentProjectId || !similarityScan.report || similarityScan.isMerging) return
    const selectedGroups = similarityScan.report.groups.filter((_, i) => selectedGroupIndices.has(i))
    if (selectedGroups.length === 0) return
    try {
      const result = await similarityScan.mergeSelected(currentProjectId, selectedGroups)

      // 后端已删除 removed 中的实体，但本地 store 的 loadProjectData 用 mergeListById
      // 会保留"本地有但后端没有"的条目（本意是保护新建未同步的实体），
      // 这会导致被删除的实体仍残留在 UI。这里主动按 kind 从本地 store 移除。
      const store = useNovelStore.getState()
      for (const g of selectedGroups) {
        for (const r of g.removed) {
          switch (g.kind) {
            case 'character': store.removeCharacter(r.id); break
            case 'conflict': store.removeConflict(r.id); break
            case 'foreshadow': store.removeForeshadow(r.id); break
            case 'faction': store.removeFaction(r.id); break
            case 'location': store.removeLocation(r.id); break
            case 'world_element': store.removeWorldElement(r.id); break
          }
        }
      }

      // 后台刷新项目数据，确保 edges/关联表等也同步
      void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
      setSimilarityDialogOpen(false)
      similarityScan.reset()
      if (result.totalMerged > 0) {
        toastSuccess(
          `已合并 ${result.totalMerged} 个相似实体`,
          selectedGroups.map((g) => `${similarityKindLabel(g.kind)}：${g.removed.map((r) => r.name).join('、')}`).join('\n'),
        )
      } else {
        toastSuccess('合并完成', '未实际删除实体')
      }
    } catch (err) {
      toastError('合并失败', err instanceof Error ? err.message : '未知错误')
    }
  }, [currentProjectId, similarityScan, selectedGroupIndices, queryClient])

  // ── 创作流程 ──

  // 从矩阵本章列读取已编排实体（与矩阵 computeCellSymbol 判定保持一致）。
  // 提取为独立函数供 handleStartCreation / handleRegenerateChapter / handleStartCreationAt 复用，
  // 避免任一入口漏传 arrangedEntities 导致 Writer 看不到矩阵编排约束。
  const collectArrangedEntities = useCallback((playhead: number) => {
    return {
      characterIds: characters.filter((c) => {
        const history = characterHistory.filter((h) => h.characterId === c.id)
        const spans = computeCharacterSpans(history)
        return spans.some((s) => playhead >= s.start && playhead <= s.end)
      }).map((c) => c.id),
      conflictIds: conflicts.filter((c) =>
        c.chapterSpans.some(([s, e]) => playhead >= s && playhead <= e)
      ).map((c) => c.id),
      foreshadowIds: foreshadows.filter((f) => {
        if (f.firstChapter == null) return false
        return playhead >= f.firstChapter && (f.recoverByChapter == null || playhead <= f.recoverByChapter)
      }).map((f) => f.id),
      factionIds: factions.filter((f) =>
        f.chapterSpans.some(([s, e]) => playhead >= s && playhead <= e)
      ).map((f) => f.id),
      locationIds: locations.filter((l) => {
        return l.appearChapters.includes(playhead)
      }).map((l) => l.id),
    }
  }, [characters, characterHistory, conflicts, foreshadows, factions, locations])

  const handleStartCreation = useCallback(async (mode: 'manual' | 'ai-arrange', chapterNumber?: number) => {
    if (!currentProjectId || creationFlow.isRunning) return
    // ref 级互斥锁：creationFlow.isRunning 是 React state（setState 异步生效），
    // 快速双击时第二次点击仍读到 false；用 ref 在 try 块执行期间（含 await）立即拦截
    if (startCreationLockRef.current) return
    startCreationLockRef.current = true
    try {
      // 优先用入参 chapterNumber（来自大纲树右键直接传值），回退到 playheadChapter
      // 修复 React state 闭包陷阱：setPlayheadChapter 后同步连调 onStartCreation 时，
      // 闭包内的 playheadChapter 还是旧值，必须用入参绕开
      const playhead = chapterNumber ?? playheadChapter
      const chapter = chapters.find((c) => c.chapterNumber === playhead)
      if (!chapter) return
      setCreationMode(mode)
      setCreationChapterNumber(playhead)
      if (mode === 'manual') {
        // 模式1：从矩阵本章列读取已编排实体
        // 根据 creationMode2 选择编排模式（create-flow）或群聊模式（create-discussion）
        const arrangedEntities = collectArrangedEntities(playhead)
        if (creationMode2 === 'discussion') {
          await creationFlow.startDiscussion(currentProjectId, playhead, { arrangedEntities })
        } else {
          await creationFlow.startCreation(currentProjectId, playhead, { arrangedEntities })
        }
      } else {
        // 模式2：AI 编排
        await creationFlow.aiArrange(currentProjectId, playhead)
      }
    } catch (err) {
      console.error('[NovelWorkspace] 启动创作失败:', err)
      setCreationMode(null)
      setCreationChapterNumber(undefined)
    } finally {
      startCreationLockRef.current = false
    }
  }, [currentProjectId, chapters, creationFlow, collectArrangedEntities, setCreationMode, setCreationChapterNumber, playheadChapter, creationMode2])

  // 重新创作已有章节：右键章节节点触发，章节已存在无需 createChapter，
  // 直接以原章节号启动创作流程（覆盖旧内容）
  // ⚠️ 必须传入 arrangedEntities：重新生成时 Writer 仍需看到矩阵本章列的编排约束，
  // 否则 Writer 完全不知道哪些角色/冲突/伏笔必须出场，导致剧情错乱。
  const handleRegenerateChapter = useCallback(async (chapterNumber: number) => {
    if (!currentProjectId || creationFlow.isRunning) return
    const chapter = chapters.find((c) => c.chapterNumber === chapterNumber)
    if (!chapter) return
    setCreationChapterNumber(chapterNumber)
    await creationFlow.startCreation(currentProjectId, chapterNumber, { arrangedEntities: collectArrangedEntities(chapterNumber) })
  }, [currentProjectId, chapters, creationFlow, collectArrangedEntities])

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
    await creationFlow.startCreation(currentProjectId, chapterNumber, { arrangedEntities: collectArrangedEntities(chapterNumber) })
  }, [currentProjectId, chapters, creationFlow, collectArrangedEntities, upsertChapter, queryClient])

  // 收到 data_changed 事件时刷新画布（替代轮询）
  // Memory Agent 写入实体状态 + orchestrator.syncChapterDimensions 补全章节维度后，
  // 推送带 dataChanged 标记的事件。此处需同时刷新实体列表与角色历史（characterHistory
  // 不在 projectDataQuery 范围内，单独拉取）。
  useEffect(() => {
    const lastOutput = creationFlow.agentOutputs[creationFlow.agentOutputs.length - 1]
    if (lastOutput?.dataChanged && currentProjectId) {
      void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
      // 角色 history 不在 projectDataQuery 范围，单独全量拉取刷新
      void listProjectCharacterHistory(currentProjectId)
        .then((history) => setCharacterHistory(history))
        .catch((err) => console.error('[NovelWorkspace] 刷新 characterHistory 失败:', err))
    }
  }, [creationFlow.agentOutputs, currentProjectId, queryClient, setCharacterHistory])

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

  const handleRetryCreation = useCallback((): void => {
    if (!currentProject || creationChapterNumber == null) return
    // 与 chat handleRetry 行为一致：清空错误，重新触发全新 SSE run
    // agentOutputs 和 chapterContent 半成品保留供用户对比
    creationFlow.reset()
    void creationFlow.startCreation(currentProject.id, creationChapterNumber)
  }, [currentProject, creationChapterNumber, creationFlow])

  const handleDismissError = useCallback((): void => {
    creationFlow.reset()
  }, [creationFlow])

  const handleSendMessage = useCallback((message: string) => {
    creationFlow.sendMessage(message)
  }, [creationFlow])

  // 创作激活状态：运行中或处于非 idle 阶段时，右侧栏切换为创作预览面板
  const isCreationActive = creationFlow.isRunning || creationFlow.phase !== 'idle'
  // 编辑器只读：仅在真正运行中（含 checkpoint 等待）时锁定，终态（completed/cancelled/error）恢复可编辑
  const isCreationRunning = creationFlow.isRunning

  // playhead 章是否存在：header 创作按钮依赖此判断，避免章节不存在时点击静默无反应
  const playheadChapterExists = chapters.some((c) => c.chapterNumber === playheadChapter)

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
              <span className="text-[10px] text-muted-foreground bg-muted/50 rounded px-1.5 py-0.5 tabular-nums">
                {nodeCount} 节点
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {/* 创作子模式切换：编排模式（create-flow）/ 群聊模式（create-discussion） */}
            <div className="inline-flex items-center gap-0.5 p-0.5 bg-surface-1 border border-border rounded-lg">
              <button
                type="button"
                className={`inline-flex items-center h-6 px-2 text-[11px] rounded-md transition-[color,background-color,border-color,transform] active:scale-[0.96] ${creationMode2 === 'workflow' ? 'bg-surface-3 text-text border border-border' : 'text-muted-foreground hover:text-text hover:bg-muted/50 border border-transparent'}`}
                onClick={() => setCreationMode2('workflow')}
                disabled={creationFlow.isRunning}
                title="编排模式：多 Agent 编排创作流程"
              >
                <span className="leading-none">编排</span>
              </button>
              <button
                type="button"
                className={`inline-flex items-center h-6 px-2 text-[11px] rounded-md transition-[color,background-color,border-color,transform] active:scale-[0.96] ${creationMode2 === 'discussion' ? 'bg-surface-3 text-text border border-border' : 'text-muted-foreground hover:text-text hover:bg-muted/50 border border-transparent'}`}
                onClick={() => setCreationMode2('discussion')}
                disabled={creationFlow.isRunning}
                title="群聊模式：多 Agent 群聊讨论创作"
              >
                <span className="leading-none">群聊</span>
              </button>
            </div>
            <Button
              size="sm"
              variant="default"
              onClick={() => handleStartCreation('manual')}
              disabled={!currentProject || creationFlow.isRunning || !playheadChapterExists}
              title={playheadChapterExists ? `${creationMode2 === 'discussion' ? '群聊模式' : '编排模式'}：从矩阵本章列读取已编排实体，启动多 Agent 创作流程` : '请先选择章节'}
            >
              <Sparkles className="size-3.5" />
              <span className="hidden sm:inline">生成第{playheadChapter}章</span>
            </Button>
            {/* <Button
              size="sm"
              variant="outline"
              onClick={() => handleStartCreation('ai-arrange')}
              disabled={!currentProject || creationFlow.isRunning || !playheadChapterExists}
              title={playheadChapterExists ? '模式2：AI 自动编排实体到矩阵' : '请先选择章节'}
            >
              <Wand2 className="size-3.5" />
              <span className="hidden sm:inline">AI编排</span>
            </Button> */}
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

        {/* 主体三栏布局（DndContext 覆盖侧边栏 + 矩阵，支持拖拽） */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={({ active }) => setActiveDrag(active)}
          onDragEnd={() => setActiveDrag(null)}
          onDragCancel={() => setActiveDrag(null)}
        >
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
                        <ErrorBoundary
                          fallback={(err, reset) => (
                            <MatrixErrorFallback
                              error={err}
                              reset={reset}
                              onSwitchToCanvas={() => setViewMode('canvas')}
                            />
                          )}
                        >
                          <ChapterContentEditor
                            isCreationActive={isCreationRunning}
                            creationChapterNumber={creationChapterNumber}
                            creationChapterContent={creationFlow.chapterContent}
                          />
                        </ErrorBoundary>
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
                        <ErrorBoundary
                          fallback={(err, reset) => (
                            <MatrixErrorFallback
                              error={err}
                              reset={reset}
                              onSwitchToCanvas={() => setViewMode('canvas')}
                            />
                          )}
                        >
                          <MatrixWorkspace
                            creationRunning={creationFlow.isRunning}
                            creationChapterNumber={creationChapterNumber}
                            onRegenerateChapter={handleRegenerateChapter}
                            onStartCreationAt={handleStartCreationAt}
                            onSimilarityScan={handleStartSimilarityScan}
                            similarityScanning={similarityScan.isScanning}
                          />
                        </ErrorBoundary>
                      </div>
                    </>
                  ) : (
                    <ErrorBoundary
                      fallback={(err, reset) => (
                        <CanvasErrorFallback
                          error={err}
                          reset={reset}
                          onSwitchToMatrix={() => setViewMode('matrix')}
                        />
                      )}
                    >
                      <NovelCanvas
                        relayoutSignal={relayoutSignal}
                        creationPhase={creationFlow.phase}
                        creationRunning={creationFlow.isRunning}
                        creationError={creationFlow.error}
                        onCancelCreation={handleDiscardCreation}
                        onNodeCountChange={setNodeCount}
                      />
                    </ErrorBoundary>
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
              <ErrorBoundary
                fallback={(err, reset) => (
                  <CreationErrorFallback
                    error={err}
                    reset={reset}
                    onDiscardCreation={handleDiscardCreation}
                  />
                )}
              >
                <ChapterLivePanel
                  phase={creationFlow.phase}
                  isRunning={creationFlow.isRunning}
                  chapterContent={creationFlow.chapterContent}
                  agentOutputs={creationFlow.agentOutputs}
                  chapterNumber={creationChapterNumber}
                  currentCheckpoint={creationFlow.currentCheckpoint}
                  result={creationFlow.result}
                  error={creationFlow.error}
                  onRetry={handleRetryCreation}
                  onDismissError={handleDismissError}
                  creationMode={creationMode}
                  onSubmitCheckpoint={creationFlow.submitCheckpoint}
                  onSave={handleSaveChapter}
                  onDiscard={handleDiscardCreation}
                  onSendMessage={handleSendMessage}
                  userMessages={creationFlow.userMessages}
                />
              </ErrorBoundary>
            ) : scanPhase !== 'idle' ? (
              <SimilarityScanPanel
                phase={scanPhase}
                isScanning={similarityScan.isScanning}
                progressEvents={similarityScan.progressEvents}
                groupCount={scanReport?.groups.length ?? 0}
                error={scanError}
                onCancel={similarityScan.cancel}
                onReset={similarityScan.reset}
              />
            ) : (
              <NovelDetailPanel />
            )}
          </aside>
        </div>

        {/* 拖拽预览：跟随光标 floating card，按拖源类型展示 */}
        <DragOverlay dropAnimation={null}>
          {activeDrag ? <MatrixDragPreview data={activeDrag.data.current as MatrixDragData | null} /> : null}
        </DragOverlay>
        </DndContext>

        {/* 缓存诊断弹窗 */}
        <Dialog open={cachePanelOpen} onOpenChange={setCachePanelOpen}>
          <DialogContent className="sm:max-w-md max-h-[80vh] p-0 gap-0">
            <DialogHeader className="px-4 py-3 border-b border-border">
              <DialogTitle className="flex items-center gap-2 text-sm">
                <Database className="size-4 text-primary" />
                缓存诊断
              </DialogTitle>
              <DialogDescription className="text-xs text-pretty">
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
              <DialogDescription className="text-xs text-pretty">
                记录每次 Agent 调用的完整上下文（系统提示词 / 章节上下文 / 任务指令 / 工具 / 结果）
              </DialogDescription>
            </DialogHeader>
            <div className="h-[70vh]">
              <AgentLogPanel chapterNumber={creationChapterNumber} />
            </div>
          </DialogContent>
        </Dialog>

        {/* LLM 相似度扫描多选对话框（勾选的组才合并） */}
        <Dialog open={similarityDialogOpen} onOpenChange={(open) => {
          // 合并执行中不允许通过点击遮罩/ESC 关闭，避免中断
          if (!similarityScan.isMerging) setSimilarityDialogOpen(open)
        }}>
          <DialogContent className="sm:max-w-2xl max-h-[85vh] p-0 gap-0">
            <DialogHeader className="px-4 py-3 border-b border-border">
              <DialogTitle className="flex items-center gap-2 text-sm">
                <Sparkle className="size-4 text-primary" />
                AI 相似度整理
              </DialogTitle>
              <DialogDescription className="text-xs text-pretty">
                勾选需要合并的组，未勾选的将跳过。合并后删除项的关联数据会迁移到保留项
              </DialogDescription>
            </DialogHeader>
            <div className="overflow-y-auto p-4 max-h-[60vh]">
              {similarityScan.report == null ? (
                <div className="text-xs text-muted-foreground py-8 text-center">等待扫描结果...</div>
              ) : similarityScan.report.groups.length === 0 ? (
                <div className="text-xs text-muted-foreground py-8 text-center">
                  未发现相似实体，所有条目均唯一
                </div>
              ) : (
                <div className="space-y-3">
                  {/* 全选 / 取消全选 + 统计 */}
                  <div className="flex items-center justify-between gap-2 pb-2 border-b border-border">
                    <label className="flex items-center gap-2 cursor-pointer text-xs text-text select-none">
                      <input
                        type="checkbox"
                        className="size-3.5 rounded border-border accent-primary cursor-pointer"
                        checked={selectedGroupIndices.size === similarityScan.report.groups.length}
                        ref={(el) => {
                          if (el && similarityScan.report) {
                            el.indeterminate = selectedGroupIndices.size > 0 && selectedGroupIndices.size < similarityScan.report.groups.length
                          }
                        }}
                        onChange={(e) => toggleAllGroups(e.target.checked)}
                      />
                      <span className="font-medium">
                        {selectedGroupIndices.size === similarityScan.report.groups.length ? '取消全选' : '全选'}
                      </span>
                    </label>
                    <div className="text-xs text-muted-foreground">
                      已选 <span className="text-text font-medium tabular-nums">{selectedGroupIndices.size}</span>
                      {' / '}
                      <span className="tabular-nums">{similarityScan.report.groups.length}</span> 组
                    </div>
                  </div>

                  {similarityScan.report.groups.map((g, idx) => {
                    const checked = selectedGroupIndices.has(idx)
                    return (
                      <label
                        key={`${g.kind}-${g.keptId}-${idx}`}
                        className={`block rounded-md border p-3 cursor-pointer transition-colors select-none ${checked ? 'border-primary/40 bg-primary/5' : 'border-border bg-surface-2/50 hover:bg-surface-2'}`}
                      >
                        <div className="flex items-start gap-2.5">
                          <input
                            type="checkbox"
                            className="mt-0.5 size-3.5 rounded border-border accent-primary cursor-pointer shrink-0"
                            checked={checked}
                            onChange={() => toggleGroupSelection(idx)}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">
                                {similarityKindLabel(g.kind)}
                              </span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 font-medium tabular-nums">
                                相似度 {Math.round(g.similarity * 100)}%
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground mb-2 italic leading-relaxed">
                              {g.reason}
                            </div>
                            <div className="text-xs space-y-1">
                              <div className="text-emerald-700">
                                保留：<span className="font-mono text-[11px]">{g.keptId.slice(0, 8)}</span>
                              </div>
                              <div className="text-amber-600">
                                删除：{g.removed.map((r) => (
                                  <span key={r.id} className="inline-block mr-1">
                                    {r.name}
                                    <span className="text-muted-foreground ml-0.5 text-[10px]">({r.id.slice(0, 8)})</span>
                                  </span>
                                ))}
                                <span className="text-muted-foreground ml-1">（共 {g.removed.length} 个）</span>
                              </div>
                              {g.fieldMerges && g.fieldMerges.length > 0 && (
                                <div className="mt-2 pt-2 border-t border-border/60">
                                  <div className="text-[11px] text-muted-foreground mb-1">字段级合并建议：</div>
                                  <div className="space-y-1">
                                    {g.fieldMerges.map((fm, fidx) => (
                                      <div key={fidx} className="text-[11px] text-muted-foreground leading-relaxed pl-2 border-l border-border">
                                        <span className="text-text font-medium">{fm.field}</span>
                                        <span className="mx-1">←</span>
                                        <span className="text-text">{fm.fromName}</span>
                                        <span className="text-muted-foreground ml-1 text-[10px]">({fm.fromId.slice(0, 8)})</span>
                                        <div className="text-[10px] italic">{fm.reason}</div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border bg-surface-1/50">
              <div className="text-xs text-muted-foreground">
                {selectedGroupIndices.size > 0 && (
                  <>将合并 <span className="text-amber-500 font-medium tabular-nums">{selectedGroupIndices.size}</span> 组</>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSimilarityDialogOpen(false)
                    similarityScan.reset()
                  }}
                  disabled={similarityScan.isMerging}
                >
                  取消
                </Button>
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => void handleSimilarityMerge()}
                  disabled={
                    similarityScan.isMerging ||
                    selectedGroupIndices.size === 0
                  }
                >
                  {similarityScan.isMerging ? '合并中...' : `确认合并${selectedGroupIndices.size > 0 ? `（${selectedGroupIndices.size} 组）` : ''}`}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </ReactFlowProvider>
  )
}
