import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ReactFlowProvider } from '@xyflow/react'
import { DndContext, DragOverlay, PointerSensor, KeyboardSensor, useSensor, useSensors, closestCenter, type Active } from '@dnd-kit/core'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, Download, Database, ScrollText, LayoutGrid, Grid3x3, Sparkle, MessageSquare, Info, BookOpen, BookSearch, ShieldCheck, PenLine, Rows2, PanelLeft, PanelRight, Minimize2, Feather, Settings as SettingsIcon, Gauge } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ResizableSplitter } from '@/components/ui/resizable-splitter'
import { Segmented, type SegmentedOption } from '@/components/ui/segmented'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { useNovelUiStore } from '@/stores/novel-ui-store'
import { useNovelWorkspaceLayoutStore, type RightPanelView, type WorkspaceLayoutMode } from '@/stores/novel-workspace-layout-store'
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
  listItems,
  listNarratives,
  listEdges,
  listVolumes,
  listProjectCharacterHistory,
  getChapterArrangedEntities,
  createChapter,
  completeChapter,
  type SimilarityEntityKind,
} from '@/api/novel-client'
import { useNovelCreationFlow } from '@/hooks/use-novel-creation-flow'
import { useChapterChat } from '@/hooks/use-chapter-chat'
import { useNovelSimilarityScan } from '@/hooks/use-novel-similarity-scan'
import { useShortcut } from '@/hooks/use-shortcut'
import { useNovelWorkspaceShortcuts } from '@/hooks/use-novel-workspace-shortcuts'
import { toastSuccess, toastError } from '@/hooks/use-toast'
import { NovelSidebar } from './novel-sidebar'
import { NovelToolbar } from './novel-toolbar'
import { NovelCanvas } from './novel-canvas'
import { NovelDetailPanel } from './novel-detail-panel'
import { NovelConversationPanel, type NovelFlowType } from './novel-conversation-panel'
import { ChatPanel } from './chat-panel'
import { SettingsPanel } from './settings-panel'
import { ConsistencyAuditPanel } from './consistency-audit-panel'
import type { MentionOption } from '@/components/shared/conversation'
import { SimilarityScanPanel } from './similarity-scan-panel'
import { CacheMonitorPanel } from './cache-monitor-panel'
import { P3ContextReportPanel } from './p3-context-report-panel'
import { AgentLogPanel } from './agent-log-panel'
import { MatrixWorkspace } from './matrix/matrix-workspace'
import { computeCharacterSpans, GROUP_META, type MatrixDragData } from './matrix/matrix-logic'
import {
  foreshadowHasBeatAtChapter,
  resolveChapterTaskKind,
  resolveRetryChapterTask,
  resolveWritingTaskKind,
  type ChapterTaskSnapshot,
} from './chapter-task'
import { ChapterContentEditor } from './chapter-content-editor'
import { WritingStyleProfileEditor } from './writing-style-profile-editor'
import { ReferenceAnalysisWorkspace } from './reference-analysis/reference-analysis-workspace'
import { ErrorBoundary } from '@/components/overlays/error-boundary'
import { MatrixErrorFallback } from './matrix-error-fallback'
import { CanvasErrorFallback } from './canvas-error-fallback'
import { CreationErrorFallback } from './creation-error-fallback'

// ── 主工作区布局切换（四个互斥选项）──
//
// 取代原先的 MainModeSwitcher（写作/分屏/矩阵）+ ViewSwitcher（矩阵/画布）两个控件。
// 旧组合里「选了分屏却看不到编辑器」「选了画布却看到编辑器」都源于两个维度互相覆盖，
// 现在一个控件就是全部可达状态，选中项与屏幕内容一一对应。

const LAYOUT_MODE_OPTIONS: ReadonlyArray<SegmentedOption<WorkspaceLayoutMode>> = [
  { value: 'text', label: '正文', icon: PenLine, title: '正文：编辑器全宽 (Ctrl+1)' },
  { value: 'text-timeline', label: '正文+时间线', icon: Rows2, title: '正文 + 时间线：上下分屏 (Ctrl+2)' },
  { value: 'timeline', label: '时间线', icon: Grid3x3, title: '时间线：章节 × 实体矩阵全宽 (Ctrl+3)' },
  { value: 'graph', label: '关系图', icon: LayoutGrid, title: '关系图：实体关系画布全宽 (Ctrl+4)' },
]

// ── 右侧面板 Tab ──

const RIGHT_PANEL_OPTIONS: ReadonlyArray<SegmentedOption<RightPanelView>> = [
  { value: 'conversation', label: '创作', icon: PenLine, title: '创作流程（工作流/群聊/反推/编排 + 进度/检查点）', dataTour: 'right-tab-conversation' },
  { value: 'chat', label: '聊天', icon: MessageSquare, title: '章节自由对话（@ Agent/角色 问答）', dataTour: 'right-tab-chat' },
  { value: 'detail', label: '详情', icon: Info, title: '实体查看/编辑（角色/冲突/伏笔/线索等）', dataTour: 'right-tab-detail' },
  { value: 'settings', label: '设置', icon: SettingsIcon, title: '项目级配置（标题/大纲/创作主模型/节奏模型/目标平台）', dataTour: 'right-tab-settings' },
  { value: 'audit', label: '审计', icon: ShieldCheck, title: '一致性诊断（伏笔回收/钩子/孤儿/时间线矛盾）', dataTour: 'right-tab-audit' },
]


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
  hook: '钩子',
  character_arc: '角色弧光',
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
        <span className="text-nano font-bold leading-none" style={{ color: meta.color }}>
          {data.entityType === 'foreshadow' ? (data.end === 'start' ? '●' : '○') : (data.end === 'start' ? '◀' : '▶')}
        </span>
        <span className="font-medium text-text">{data.end === 'start' ? '调整起点' : '调整终点'}</span>
      </div>
    )
  }
  if (data.source === 'span') {
    return (
      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border bg-surface-1 shadow-lg text-xs" style={{ borderColor: meta.color }}>
        <span className="h-2 w-5 rounded-sm" style={{ background: meta.color }} />
        <span className="font-medium text-text">移动范围</span>
        <span className="font-mono text-muted-foreground tabular-nums">{data.startChapter}-{data.endChapter}</span>
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
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const projects = useNovelDataStore((s) => s.projects)
  const loadProjectData = useNovelDataStore((s) => s.loadProjectData)
  const clearProjectData = useNovelDataStore((s) => s.clearProjectData)
  const characters = useNovelDataStore((s) => s.characters)
  const chapters = useNovelDataStore((s) => s.chapters)
  const conflicts = useNovelDataStore((s) => s.conflicts)
  const foreshadows = useNovelDataStore((s) => s.foreshadows)
  const relationships = useNovelDataStore((s) => s.relationships)
  const clues = useNovelDataStore((s) => s.clues)
  const worldRules = useNovelDataStore((s) => s.worldRules)
  const styleGuides = useNovelDataStore((s) => s.styleGuides)
  const constraints = useNovelDataStore((s) => s.constraints)
  const infoLayers = useNovelDataStore((s) => s.infoLayers)
  const factions = useNovelDataStore((s) => s.factions)
  const locations = useNovelDataStore((s) => s.locations)
  const worldElements = useNovelDataStore((s) => s.worldElements)
  const items = useNovelDataStore((s) => s.items)
  const upsertChapter = useNovelDataStore((s) => s.upsertChapter)
  const layoutMode = useNovelWorkspaceLayoutStore((s) => s.layoutMode)
  const setLayoutMode = useNovelWorkspaceLayoutStore((s) => s.setLayoutMode)
  const characterHistory = useNovelDataStore((s) => s.characterHistory)
  const setCharacterHistory = useNovelDataStore((s) => s.setCharacterHistory)
  const setCreationMode = useNovelUiStore((s) => s.setCreationMode)
  const creationMode = useNovelUiStore((s) => s.creationMode)
  const playheadChapter = useNovelUiStore((s) => s.playheadChapter)

  // ── 全局快捷键：撤销/重做（编辑器内由 Tiptap 自行处理）──
  useShortcut({
    onUndo: () => useNovelDataStore.getState().undo(),
    onRedo: () => useNovelDataStore.getState().redo(),
  })

  // ── 工作台快捷键：Ctrl+B/J/1/2/3/4、Ctrl+Shift+F 专注模式 ──
  useNovelWorkspaceShortcuts()

  const queryClient = useQueryClient()

  // 创作流程
  const creationFlow = useNovelCreationFlow()
  const [creationChapterNumber, setCreationChapterNumber] = useState<number | undefined>(undefined)
  // 创作子模式切换：编排模式（create-flow）/ 群聊模式（create-discussion）/ 反推（reverse-arrange）/ AI编排（ai-arrange）
  // 由右栏 NovelConversationPanel 的 Tab 控制，这里仅持有状态供 handleStartFlow 读取
  const [flowType, setFlowType] = useState<NovelFlowType>('workflow')
  // 保存实际启动的任务，而不是在重试时重新读取可能已经切换的 Tab。
  const [activeChapterTask, setActiveChapterTask] = useState<ChapterTaskSnapshot | null>(null)
  // 右栏视图切换：对话面板（选流程+开始+消息流）/ 详情面板（节点详情）/ 审计面板（一致性报告）
  // 创作运行中自动锁定到对话面板，结束后用户可手动切回详情
  const rightPanelView = useNovelWorkspaceLayoutStore((s) => s.rightPanelView)
  const setRightPanelView = useNovelWorkspaceLayoutStore((s) => s.setRightPanelView)
  // 互斥锁：防止 header 按钮快速双击导致 creationMode 标记与流程实际启动状态错位
  // （creationFlow.isRunning 是 React state，setState 异步生效，ref 在 await 期间立即生效）
  const startCreationLockRef = useRef(false)
  /** 本次创作 per-call 模型（输入框旁选择器传入；null = 默认） */
  const creationModelIdRef = useRef<{ provider: string; modelId: string } | null>(null)

  const [relayoutSignal, setRelayoutSignal] = useState(0)
  const sidebarVisible = useNovelWorkspaceLayoutStore((s) => s.sidebarVisible)
  const toggleSidebar = useNovelWorkspaceLayoutStore((s) => s.toggleSidebar)
  const sidebarWidth = useNovelWorkspaceLayoutStore((s) => s.sidebarWidth)
  const setSidebarWidth = useNovelWorkspaceLayoutStore((s) => s.setSidebarWidth)
  const detailWidth = useNovelWorkspaceLayoutStore((s) => s.rightPanelWidth)
  const setDetailWidth = useNovelWorkspaceLayoutStore((s) => s.setRightPanelWidth)
  const rightPanelVisible = useNovelWorkspaceLayoutStore((s) => s.rightPanelVisible)
  const toggleRightPanel = useNovelWorkspaceLayoutStore((s) => s.toggleRightPanel)
  const setRightPanelVisible = useNovelWorkspaceLayoutStore((s) => s.setRightPanelVisible)
  const focusMode = useNovelWorkspaceLayoutStore((s) => s.focusMode)
  const toggleFocusMode = useNovelWorkspaceLayoutStore((s) => s.toggleFocusMode)
  const [nodeCount, setNodeCount] = useState(0)
  const [cachePanelOpen, setCachePanelOpen] = useState(false)
  const [p3PanelOpen, setP3PanelOpen] = useState(false)
  const [logPanelOpen, setLogPanelOpen] = useState(false)
  const [stylePanelOpen, setStylePanelOpen] = useState(false)
  const [referenceAnalysisOpen, setReferenceAnalysisOpen] = useState(false)

  // ── 章节自由聊天（"聊天" Tab）──
  const chapterChat = useChapterChat()
  const chapterChatLoadHistory = chapterChat.loadHistory
  // 聊天目标章节：优先创作流程章节，回退到当前选中章节
  const chatChapterNumber = creationChapterNumber ?? playheadChapter ?? undefined

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

  // 正文编辑器高度（垂直分割，持久化到 workspace layout store）
  const contentEditorHeight = useNovelWorkspaceLayoutStore((s) => s.contentEditorHeight)
  const handleContentEditorHeightChange = useNovelWorkspaceLayoutStore((s) => s.setContentEditorHeight)

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
        its,
        narrs,
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
        listItems(currentProjectId),
        listNarratives(currentProjectId),
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
        items: its,
        narratives: narrs,
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

  // 项目加载/切换时拉取 characterHistory（loadProjectData 不含此数据，矩阵依赖它显示角色）
  useEffect(() => {
    if (!currentProjectId) {
      setCharacterHistory([])
      return
    }
    let cancelled = false
    void listProjectCharacterHistory(currentProjectId)
      .then((history) => {
        if (!cancelled) setCharacterHistory(history)
      })
      .catch((err) => console.error('[NovelWorkspace] 加载 characterHistory 失败:', err))
    return () => {
      cancelled = true
    }
  }, [currentProjectId, setCharacterHistory])

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
      items,
      exportedAt: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${currentProject.title || 'novel'}-export.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [currentProject, characters, chapters, conflicts, foreshadows, relationships, clues, worldRules, styleGuides, constraints, infoLayers, factions, locations, worldElements, items])

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
      const store = useNovelDataStore.getState()
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

  /**
   * 从本地实体字段派生本章编排实体。
   *
   * ⚠️ S4-2 之后这里是**降级路径**：正常情况下由后端
   * `GET /chapters/:n/arranged-entities` 给出（唯一事实源），
   * 只有请求失败时才退回本地计算，避免创作因为一次网络抖动中断。
   *
   * 保留它的代价是这份派生规则仍与后端并存；一旦后端接口稳定，
   * 应连同 foreshadowHasBeatAtChapter / computeCharacterSpans 的调用一起删除。
   */
  const collectArrangedEntitiesLocally = useCallback((playhead: number) => {
    return {
      characterIds: characters.filter((c) => {
        const history = characterHistory.filter((h) => h.characterId === c.id)
        const spans = computeCharacterSpans(history)
        return spans.some((s) => playhead >= s.start && playhead <= s.end)
      }).map((c) => c.id),
      conflictIds: conflicts.filter((c) =>
        c.chapterSpans.some(([s, e]) => playhead >= s && playhead <= e)
      ).map((c) => c.id),
      // 伏笔是离散事件链：只把本章确有“埋设/强化/揭示/回收”节点的伏笔交给 Writer。
      // 不能把埋设到回收之间的所有章节都当作伏笔出场章。
      foreshadowIds: foreshadows
        .filter((f) => foreshadowHasBeatAtChapter(f, playhead))
        .map((f) => f.id),
      clueIds: clues.filter((clue) =>
        clue.chapterSpans.some(([start, end]) => playhead >= start && playhead <= end)
      ).map((clue) => clue.id),
      factionIds: factions.filter((f) =>
        f.chapterSpans.some(([s, e]) => playhead >= s && playhead <= e)
      ).map((f) => f.id),
      locationIds: locations.filter((l) => {
        return l.appearChapters.includes(playhead)
      }).map((l) => l.id),
      // 物品同样是 Writer 的硬约束（归属与状态），早期漏传导致后端
      // "本章登场物品"提示段永远不渲染，Writer 会写错谁拿着什么。
      itemIds: items.filter((it) =>
        (it.chapterSpans ?? []).some(([s, e]) => playhead >= s && playhead <= e)
      ).map((it) => it.id),
    }
  }, [characters, characterHistory, conflicts, foreshadows, clues, factions, locations, items])

  /**
   * 取本章编排实体：优先服务端（唯一事实源），失败则退回本地派生。
   *
   * 服务端返回体里还带着另一种事实源的结果与差异；差异不为空时给出提示，
   * 而不是静默采用某一边 —— S4-1 的对账实测两侧确实存在反向漂移。
   */
  const resolveArrangedEntities = useCallback(async (projectId: string, playhead: number) => {
    try {
      const response = await getChapterArrangedEntities(projectId, playhead)
      const divergentFields = Object.keys(response.divergence)
      if (divergentFields.length > 0) {
        console.warn(
          `[NovelWorkspace] 第 ${playhead} 章的两种投影事实源存在差异（当前采用 ${response.source}）：`,
          response.divergence,
        )
      }
      return response.arrangedEntities
    } catch (err) {
      console.warn('[NovelWorkspace] 获取章节编排实体失败，退回本地派生：', err)
      return collectArrangedEntitiesLocally(playhead)
    }
  }, [collectArrangedEntitiesLocally])

  /** 所有章节任务的唯一分发入口；同时记录快照，保证失败重试执行同一种任务。 */
  const runChapterTask = useCallback(async (task: ChapterTaskSnapshot): Promise<void> => {
    if (task.kind === 'reverse') {
      const chapter = chapters.find((item) => item.chapterNumber === task.chapterNumber)
      if (!chapter?.content?.trim()) {
        toastError('章节正文为空，无法反推实体。请先编写正文或切换到编排模式。')
        setCreationMode(null)
        setCreationChapterNumber(undefined)
        return
      }
    }

    setActiveChapterTask(task)
    setCreationMode(task.kind === 'arrange' ? 'ai-arrange' : 'manual')
    setCreationChapterNumber(task.chapterNumber)

    if (task.kind === 'arrange') {
      await creationFlow.aiArrange(task.projectId, task.chapterNumber)
      return
    }
    if (task.kind === 'reverse') {
      await creationFlow.reverseArrange(task.projectId, task.chapterNumber)
      return
    }

    // 功能位（本章作用）不落库，只能从紧邻的那次 AI 编排结果里取。
    // 取不到就退化为原行为（Writer 只看到角色短卡，没有"本章作用"行）。
    const characterFunctions = creationFlow.takeArrangedCharacterFunctions(task.chapterNumber)
    const arrangedEntities = {
      ...(await resolveArrangedEntities(task.projectId, task.chapterNumber)),
      ...(characterFunctions ? { characterFunctions } : {}),
    }
    const creationModelId = creationModelIdRef.current ?? undefined
    if (task.kind === 'discussion') {
      await creationFlow.startDiscussion(task.projectId, task.chapterNumber, { arrangedEntities, modelId: creationModelId })
      return
    }
    await creationFlow.startCreation(task.projectId, task.chapterNumber, { arrangedEntities, modelId: creationModelId })
  }, [chapters, creationFlow, resolveArrangedEntities, setCreationMode])

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
      await runChapterTask({
        kind: resolveChapterTaskKind(flowType, mode),
        projectId: currentProjectId,
        chapterNumber: playhead,
      })
    } catch (err) {
      console.error('[NovelWorkspace] 启动创作失败:', err)
      setCreationMode(null)
      setCreationChapterNumber(undefined)
    } finally {
      startCreationLockRef.current = false
    }
  }, [currentProjectId, chapters, runChapterTask, setCreationMode, playheadChapter, flowType])

  // 重新创作已有章节：右键章节节点触发，章节已存在无需 createChapter，
  // 直接以原章节号启动创作流程（覆盖旧内容）
  // ⚠️ 必须传入 arrangedEntities：重新生成时 Writer 仍需看到矩阵本章列的编排约束，
  // 否则 Writer 完全不知道哪些角色/冲突/伏笔必须出场，导致剧情错乱。
  const handleRegenerateChapter = useCallback(async (chapterNumber: number) => {
    if (!currentProjectId || creationFlow.isRunning) return
    const chapter = chapters.find((c) => c.chapterNumber === chapterNumber)
    if (!chapter) return
    await runChapterTask({
      kind: resolveWritingTaskKind(flowType),
      projectId: currentProjectId,
      chapterNumber,
    })
  }, [currentProjectId, chapters, creationFlow.isRunning, flowType, runChapterTask])

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
    await runChapterTask({
      kind: resolveWritingTaskKind(flowType),
      projectId: currentProjectId,
      chapterNumber,
    })
  }, [currentProjectId, chapters, creationFlow.isRunning, flowType, runChapterTask, upsertChapter, queryClient])

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
      await chapterChatLoadHistory(currentProjectId, creationChapterNumber)
    } catch (err) {
      console.error('[NovelWorkspace] 保存章节失败:', err)
    }
  }, [currentProjectId, creationChapterNumber, chapters, upsertChapter, queryClient, creationFlow, chapterChatLoadHistory])

  const handleDiscardCreation = useCallback(async () => {
    // 等待后端真实断开后再 reset，确保 chapterCreationLocks 被清理（避免 409）
    await creationFlow.cancel()
    creationFlow.reset()
    if (currentProjectId) {
      void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
      if (creationChapterNumber != null) {
        void chapterChatLoadHistory(currentProjectId, creationChapterNumber)
      }
    }
  }, [creationFlow, currentProjectId, creationChapterNumber, queryClient, chapterChatLoadHistory])

  const handleRetryCreation = useCallback((): void => {
    if (!currentProject || creationChapterNumber == null) return
    const projectId = currentProject.id
    const chapterNumber = creationChapterNumber
    const task = resolveRetryChapterTask(
      activeChapterTask,
      flowType,
      projectId,
      chapterNumber,
    )
    creationFlow.reset()
    void chapterChatLoadHistory(projectId, chapterNumber).then(() => {
      return runChapterTask(task)
    })
  }, [currentProject, creationChapterNumber, activeChapterTask, creationFlow, chapterChatLoadHistory, flowType, runChapterTask])

  const handleDismissError = useCallback((): void => {
    creationFlow.reset()
    if (currentProjectId && creationChapterNumber != null) {
      void chapterChatLoadHistory(currentProjectId, creationChapterNumber)
    }
  }, [creationFlow, currentProjectId, creationChapterNumber, chapterChatLoadHistory])

  /**
   * 质量门修订失败后「再次修订」：仅对未通过项定向再修订，不复跑生成流程。
   * 直接使用失败时保留的修订稿（creationFlow.chapterContent 已在 error 结果中更新）。
   */
  const handleReRevise = useCallback((): void => {
    if (!currentProject || creationChapterNumber == null) return
    const content = creationFlow.chapterContent
    if (!content.trim()) {
      toastError('没有可修订的正文内容', '请先手动编辑正文或重新创作。')
      return
    }
    const projectId = currentProject.id
    const chapterNumber = creationChapterNumber
    setCreationMode('manual')
    void creationFlow.reRevise(projectId, chapterNumber, content)
  }, [currentProject, creationChapterNumber, creationFlow, setCreationMode])

  /**
   * 质量门修订失败后「手动编辑 / 保留草稿」：内容留在编辑器（不落库不丢弃），
   * 清空错误提示与结果，用户可直接修改后保存到章节。
   */
  const handleKeepDraft = useCallback((): void => {
    creationFlow.keepDraft()
    toastSuccess('修订稿已保留', '未落库，可直接在编辑器中修改后保存。')
  }, [creationFlow])

  const handleResumeDiscussion = useCallback((runId: string): void => {
    if (!currentProjectId) return
    const chapterNumber = creationChapterNumber ?? chatChapterNumber
    if (chapterNumber == null) return
    setFlowType('discussion')
    setCreationMode('manual')
    setCreationChapterNumber(chapterNumber)
    setActiveChapterTask({ kind: 'discussion', projectId: currentProjectId, chapterNumber })
    creationFlow.reset()
    void creationFlow.resumeDiscussion(currentProjectId, chapterNumber, runId)
  }, [currentProjectId, creationChapterNumber, chatChapterNumber, creationFlow, setCreationMode])

  const handleSendMessage = useCallback((message: string) => {
    creationFlow.sendMessage(message)
  }, [creationFlow])

  // 右栏对话面板"开始"按钮：根据 flowType 分发到对应流程
  const handleStartFlow = useCallback((modelId?: { provider: string; modelId: string } | null) => {
    creationModelIdRef.current = modelId ?? null
    if (flowType === 'arrange') {
      void handleStartCreation('ai-arrange')
    } else {
      void handleStartCreation('manual')
    }
  }, [flowType, handleStartCreation])

  // ── 章节自由聊天回调 ──
  // ⚠️ 只依赖 hook 返回的稳定方法（useCallback 引用），不依赖整个 chapterChat 对象，
  // 避免 NovelConversationPanel 因回调引用变化而频繁重渲染
  const chapterChatSendMessage = chapterChat.sendMessage
  const chapterChatAbort = chapterChat.abort
  const handleSendChapterChat = useCallback(
    (message: string, mentionedAgents?: string[], modelId?: { provider: string; modelId: string } | null) => {
      if (!currentProjectId || chatChapterNumber == null) return
      void chapterChatSendMessage(currentProjectId, chatChapterNumber, message, mentionedAgents, modelId)
    },
    [currentProjectId, chatChapterNumber, chapterChatSendMessage],
  )

  const handleAbortChapterChat = useCallback(() => {
    chapterChatAbort()
  }, [chapterChatAbort])

  // 切换章节时加载该章节的聊天历史
  // ⚠️ 只依赖 loadHistory（稳定的 useCallback 引用），不能依赖整个 chapterChat 对象，
  // 否则每次渲染都会触发 effect → 疯狂调用 loadHistory → 接口死循环
  useEffect(() => {
    if (!currentProjectId || chatChapterNumber == null) return
    void chapterChatLoadHistory(currentProjectId, chatChapterNumber)
  }, [currentProjectId, chatChapterNumber, chapterChatLoadHistory])

  // 构建 @ 提及候选列表：4 工种 Agent + 活跃角色（与后端 buildMembers 一致）
  const chatMentionOptions = useMemo<MentionOption[]>(() => {
    const options: MentionOption[] = [
      { id: 'novel-director', label: '导演 Agent', description: '分析故事状态，规划叙事' },
      { id: 'novel-writer', label: '写作 Agent', description: '创作章节正文' },
      { id: 'novel-reviewer', label: '审稿 Agent', description: '检查一致性与可读性' },
      { id: 'novel-reviser', label: '修订 Agent', description: '根据审稿意见修订' },
    ]
    for (const char of characters) {
      // 与后端一致：已 resolved 且无 currentGoal 的角色不参与
      if (char.arcStage === 'resolved' && !char.currentGoal) continue
      options.push({
        id: `char-${char.id}`,
        label: char.name,
        description: char.identity || char.personality || undefined,
      })
    }
    return options
  }, [characters])

  // 创作激活状态：运行中或处于非 idle 阶段时，右侧栏切换为创作预览面板
  const isCreationActive = creationFlow.isRunning || creationFlow.phase !== 'idle'
  // 编辑器只读：仅在真正运行中（含 checkpoint 等待）时锁定，终态（completed/cancelled/error）恢复可编辑
  const isCreationRunning = creationFlow.isRunning

  // 创作激活时自动打开右栏并切到对话面板。
  //
  // 这里只做"切一次"，不锁定：写作者最需要核对"这个角色的秘密是什么 / 这条伏笔埋在哪"的时刻，
  // 恰恰就是 Agent 正在写这一章的时刻。旧实现把详情/审计 Tab 设为 disabled，
  // 此时唯一的信息来源只剩右栏那条 max-w-[240px] truncate 的进度文字。
  // effect 只依赖 isCreationActive，因此仅在创作开始的那一次触发，之后用户可自由切换。
  useEffect(() => {
    if (isCreationActive) {
      setRightPanelView('conversation')
      setRightPanelVisible('open')
    }
  }, [isCreationActive])

  return (
    <ReactFlowProvider>
      <div className="flex h-screen flex-col bg-app-bg text-text overflow-hidden">
        {/* 专注模式：仅显示编辑器 + 浮动退出按钮 */}
        {focusMode ? (
          <div className="relative flex-1 min-h-0">
            <ChapterContentEditor
              isCreationActive={isCreationRunning}
              creationChapterNumber={creationChapterNumber}
              creationChapterContent={creationFlow.chapterContent}
            />
            <button
              type="button"
              onClick={toggleFocusMode}
              title="退出专注模式 (Esc)"
              className="absolute top-3 right-3 z-50 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-surface-1/90 border border-border/60 shadow-[var(--shadow-raised)] text-micro font-medium text-subtle hover:text-text transition-colors active:scale-[0.96]"
            >
              <Minimize2 className="size-3.5" />
              <span>退出专注</span>
            </button>
          </div>
        ) : (
          <>
        {/* 顶部标题栏：三栏 grid（左项目信息 / 中视图切换 / 右操作按钮） */}
        <header data-tour="novel-header" className="grid grid-cols-[1fr_auto_1fr] items-center h-12 px-4 bg-surface-1 border-b border-border/60 shrink-0">
          {/* 左：项目信息 */}
          <div className="flex items-center gap-2.5 min-w-0">
            <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="返回项目列表" className="text-subtle hover:text-text">
              <ArrowLeft className="size-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={toggleSidebar}
              aria-label={sidebarVisible ? '收起侧栏' : '展开侧栏'}
              title={sidebarVisible ? '收起侧栏 (Ctrl+B)' : '展开侧栏 (Ctrl+B)'}
              className={cn('text-subtle hover:text-text', !sidebarVisible && 'text-primary')}
            >
              <PanelLeft className="size-4" />
            </Button>
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-semibold text-text truncate">
                {currentProject?.title ?? '小说工作台'}
              </span>
              {currentProject && (
                <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-md text-nano font-medium bg-primary/8 text-primary tabular-nums">
                  {currentProject.genre}
                </span>
              )}
              {nodeCount > 0 && (
                <span className="shrink-0 text-nano text-hint tabular-nums">
                  {nodeCount} 节点
                </span>
              )}
            </div>
          </div>

          {/* 中：主工作区布局切换（四个互斥选项，始终全部可达） */}
          <div className="flex items-center justify-center gap-2">
            {currentProject && (
              <Segmented
                options={LAYOUT_MODE_OPTIONS}
                value={layoutMode}
                onChange={setLayoutMode}
                ariaLabel="主工作区布局"
                dataTour="layout-mode-switcher"
              />
            )}
          </div>

          {/* 右：操作按钮组 */}
          <div className="flex items-center justify-end gap-0.5">
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={toggleRightPanel}
              disabled={!currentProject}
              aria-label={rightPanelVisible === 'open' ? '收起右栏' : '展开右栏'}
              title={rightPanelVisible === 'open' ? '收起右栏 (Ctrl+J)' : '展开右栏 (Ctrl+J)'}
              className={cn('text-subtle hover:text-text', rightPanelVisible === 'closed' && 'text-primary')}
            >
              <PanelRight className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setCachePanelOpen(true)}
              disabled={!currentProject}
              title="缓存诊断"
              className="text-subtle hover:text-text"
            >
              <Database className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setP3PanelOpen(true)}
              disabled={!currentProject}
              title="P3 灰度看板"
              className="text-subtle hover:text-text"
            >
              <Gauge className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setLogPanelOpen(true)}
              disabled={!currentProject}
              title="Agent 调用日志"
              className="text-subtle hover:text-text"
            >
              <ScrollText className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setReferenceAnalysisOpen(true)}
              disabled={!currentProject}
              title="参考小说分析"
              className="text-subtle hover:text-text"
            >
              <BookSearch className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setStylePanelOpen(true)}
              disabled={!currentProject}
              title="文风设置"
              className="text-subtle hover:text-text"
            >
              <Feather className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleExport}
              disabled={!currentProject}
              title="导出项目数据"
              className="text-subtle hover:text-text gap-1.5"
            >
              <Download className="size-3.5" />
              <span className="hidden sm:inline text-xs">导出</span>
            </Button>
          </div>
        </header>

        {/* 工具栏（仅关系图显示；时间线自带工具栏） */}
        {currentProject && layoutMode === 'graph' && (
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
          {/* 左侧栏（可折叠，200ms 宽度过渡动画） */}
          <div
            style={{ width: sidebarVisible ? sidebarWidth : 0 }}
            className="shrink-0 h-full min-h-0 overflow-hidden bg-surface-1 border-r border-border/60 shadow-[var(--shadow-raised)] transition-[width] duration-200 ease-[cubic-bezier(0.2,0,0,1)]"
          >
            <div style={{ width: sidebarWidth }} className="h-full min-h-0 overflow-hidden">
              <NovelSidebar onStartCreation={handleStartCreation} />
            </div>
          </div>
          {sidebarVisible && (
            <ResizableSplitter
              direction="horizontal"
              size={sidebarWidth}
              minSize={180}
              maxSize={360}
              onSizeChange={setSidebarWidth}
              side="left"
            />
          )}

          {/* 主内容区：layoutMode 是唯一维度，四个分支互斥且穷尽 */}
          <main className="flex-1 min-w-0 h-full overflow-hidden flex flex-col">
            {currentProject ? (
              <>
                <div className="flex-1 min-h-0 flex flex-col">
                  {layoutMode === 'graph' ? (
                    <ErrorBoundary
                      fallback={(err, reset) => (
                        <CanvasErrorFallback
                          error={err}
                          reset={reset}
                          onSwitchToMatrix={() => setLayoutMode('timeline')}
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
                  ) : layoutMode === 'text' ? (
                    /* 正文：编辑器全宽 */
                    <div className="flex-1 min-h-0 overflow-hidden">
                      <ErrorBoundary
                        fallback={(err, reset) => (
                          <MatrixErrorFallback
                            error={err}
                            reset={reset}
                            onSwitchToCanvas={() => setLayoutMode('graph')}
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
                  ) : layoutMode === 'timeline' ? (
                    /* 时间线：矩阵全宽 */
                    <div className="flex-1 min-h-0 overflow-hidden">
                      <ErrorBoundary
                        fallback={(err, reset) => (
                          <MatrixErrorFallback
                            error={err}
                            reset={reset}
                            onSwitchToCanvas={() => setLayoutMode('graph')}
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
                  ) : (
                    /* 正文 + 时间线：上下分屏 */
                    <>
                      <div style={{ height: contentEditorHeight }} className="shrink-0 min-h-[120px] overflow-hidden">
                        <ErrorBoundary
                          fallback={(err, reset) => (
                            <MatrixErrorFallback
                              error={err}
                              reset={reset}
                              onSwitchToCanvas={() => setLayoutMode('graph')}
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
                      <div className="flex-1 min-h-[200px] overflow-hidden">
                        <ErrorBoundary
                          fallback={(err, reset) => (
                            <MatrixErrorFallback
                              error={err}
                              reset={reset}
                              onSwitchToCanvas={() => setLayoutMode('graph')}
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
                  )}
                </div>
              </>
            ) : (
              <div className="flex h-full items-center justify-center p-8">
                <div className="text-center max-w-[280px]">
                  {/* 装饰图标：对齐原型 empty-card 风格 */}
                  <div className="mx-auto mb-4 size-14 rounded-xl bg-primary/8 flex items-center justify-center shadow-sm">
                    <BookOpen className="size-7 text-primary" />
                  </div>
                  <h3 className="text-sm font-semibold text-text mb-1.5">开始你的小说创作</h3>
                  <p className="text-xs text-subtle leading-relaxed">
                    在左侧选择已有项目，或点击「新建项目」开始一段新的故事旅程
                  </p>
                </div>
              </div>
            )}
          </main>

          {/* 右侧详情栏：非模态侧滑/停靠，200ms 宽度过渡动画 */}
          {rightPanelVisible === 'open' && (
            <ResizableSplitter
              direction="horizontal"
              size={detailWidth}
              minSize={280}
              maxSize={600}
              onSizeChange={setDetailWidth}
              side="right"
            />
          )}
          <aside
            style={{ width: rightPanelVisible === 'open' ? detailWidth : 0 }}
            className="shrink-0 h-full min-h-0 overflow-hidden flex flex-col bg-surface-1 border-l border-border/60 shadow-[var(--shadow-raised)] transition-[width] duration-200 ease-[cubic-bezier(0.2,0,0,1)]"
          >
            <div style={{ width: detailWidth }} className="h-full min-h-0 overflow-hidden flex flex-col">
            {/* 右栏视图切换：对话 / 详情 / 审计（与顶栏布局切换共用 Segmented）
                扫描进行时显示"相似度扫描"标签，保持 tab 栏位置稳定避免布局抖动 */}
            <div className="shrink-0 mx-2 my-1.5">
              {scanPhase === 'idle' ? (
                <Segmented
                  options={RIGHT_PANEL_OPTIONS}
                  value={rightPanelView}
                  onChange={setRightPanelView}
                  ariaLabel="右侧面板视图"
                  size="sm"
                  className="w-full"
                />
              ) : (
                <div className="inline-flex items-center gap-0.5 p-0.5 bg-surface-2 rounded-lg">
                  <div className="inline-flex items-center gap-1.5 h-6 px-2.5 text-micro font-medium rounded-[6px] bg-surface-1 text-text shadow-sm">
                    <Sparkle className="size-3 text-primary" />
                    <span className="leading-none">相似度扫描</span>
                  </div>
                </div>
              )}
            </div>

            {/* 内容区 */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <AnimatePresence mode="wait">
                {scanPhase !== 'idle' ? (
                  <motion.div
                    key="scan"
                    className="h-full"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.2 }}
                  >
                    <SimilarityScanPanel
                      phase={scanPhase}
                      isScanning={similarityScan.isScanning}
                      progressEvents={similarityScan.progressEvents}
                      groupCount={scanReport?.groups.length ?? 0}
                      error={scanError}
                      onCancel={similarityScan.cancel}
                      onReset={similarityScan.reset}
                    />
                  </motion.div>
                ) : rightPanelView === 'conversation' ? (
                  <motion.div
                    key="conversation"
                    className="h-full"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.2 }}
                  >
                    <ErrorBoundary
                      fallback={(err, reset) => (
                        <CreationErrorFallback
                          error={err}
                          reset={reset}
                          onDiscardCreation={handleDiscardCreation}
                        />
                      )}
                    >
                      <NovelConversationPanel
                        phase={creationFlow.phase}
                        isRunning={creationFlow.isRunning}
                        progressMessage={creationFlow.progressMessage}
                        chapterContent={creationFlow.chapterContent}
                        agentOutputs={creationFlow.agentOutputs}
                        chapterNumber={creationChapterNumber}
                        currentCheckpoint={creationFlow.currentCheckpoint}
                        checkpointHistory={creationFlow.checkpointHistory}
                        result={creationFlow.result}
                        error={creationFlow.error}
                        onRetry={handleRetryCreation}
                        onDismissError={handleDismissError}
                        onReRevise={handleReRevise}
                        onKeepDraft={handleKeepDraft}
                        onResumeDiscussion={handleResumeDiscussion}
                        creationMode={creationMode}
                        onSubmitCheckpoint={creationFlow.submitCheckpoint}
                        onSave={handleSaveChapter}
                        onDiscard={handleDiscardCreation}
                        onSendMessage={handleSendMessage}
                        userMessages={creationFlow.userMessages}
                        flowType={flowType}
                        onFlowTypeChange={setFlowType}
                        onStartFlow={handleStartFlow}
                        onCancelFlow={handleDiscardCreation}
                        chapterChatMessages={chapterChat.messages}
                      />
                    </ErrorBoundary>
                  </motion.div>
                ) : rightPanelView === 'chat' ? (
                  <motion.div
                    key="chat"
                    className="h-full"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.2 }}
                  >
                    <ChatPanel
                      chapterChatMessages={chapterChat.messages}
                      chapterChatAgentOutputs={chapterChat.agentOutputs}
                      chapterChatRunning={chapterChat.isRunning}
                      chapterChatError={chapterChat.error}
                      onSendChapterChat={handleSendChapterChat}
                      onAbortChapterChat={handleAbortChapterChat}
                      chatMentionOptions={chatMentionOptions}
                    />
                  </motion.div>
                ) : rightPanelView === 'settings' ? (
                  <motion.div
                    key="settings"
                    className="h-full"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.2 }}
                  >
                    <SettingsPanel />
                  </motion.div>
                ) : rightPanelView === 'audit' ? (
                  <motion.div
                    key="audit"
                    className="h-full"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.2 }}
                  >
                    <ErrorBoundary
                      fallback={(err, reset) => (
                        <CreationErrorFallback
                          error={err}
                          reset={reset}
                          onDiscardCreation={handleDiscardCreation}
                        />
                      )}
                    >
                      <ConsistencyAuditPanel creationActive={isCreationActive} />
                    </ErrorBoundary>
                  </motion.div>
                ) : (
                  <motion.div
                    key="detail"
                    className="h-full"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.2 }}
                  >
                    <NovelDetailPanel creationActive={isCreationActive} />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            </div>
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

        {/* P3 灰度看板弹窗 */}
        <Dialog open={p3PanelOpen} onOpenChange={setP3PanelOpen}>
          <DialogContent className="sm:max-w-lg max-h-[80vh] p-0 gap-0">
            <DialogHeader className="px-4 py-3 border-b border-border">
              <DialogTitle className="flex items-center gap-2 text-sm">
                <Gauge className="size-4 text-primary" />
                P3 上下文灰度看板
              </DialogTitle>
              <DialogDescription className="text-xs text-pretty">
                chunk 明细 / 角色策略 / 降级模拟 / 角色组装对照
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[60vh] overflow-y-auto p-4">
              <P3ContextReportPanel chapterNumber={creationChapterNumber} />
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

        {/* 文风设置弹窗：从 header 入口打开，避免深藏在详情面板的 ProjectForm 末尾 */}
        <Dialog open={stylePanelOpen} onOpenChange={setStylePanelOpen}>
          <DialogContent className="sm:max-w-2xl max-h-[85vh] p-0 gap-0">
            <DialogHeader className="px-4 py-3 border-b border-border">
              <DialogTitle className="flex items-center gap-2 text-sm">
                <Feather className="size-4 text-primary" />
                文风设置
              </DialogTitle>
              <DialogDescription className="text-xs text-pretty">
                配置项目文风档案：叙事声音、规则约束、正反样本。系统会自动叠加从既有章节提取的文风指纹和声音锚点。
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[70vh] overflow-y-auto p-4">
              {currentProjectId && <WritingStyleProfileEditor projectId={currentProjectId} />}
            </div>
          </DialogContent>
        </Dialog>

        {currentProjectId && (
          <ReferenceAnalysisWorkspace
            projectId={currentProjectId}
            open={referenceAnalysisOpen}
            onOpenChange={setReferenceAnalysisOpen}
          />
        )}

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
                              <span className="text-nano px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">
                                {similarityKindLabel(g.kind)}
                              </span>
                              <span className="text-nano px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 font-medium tabular-nums">
                                相似度 {Math.round(g.similarity * 100)}%
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground mb-2 italic leading-relaxed">
                              {g.reason}
                            </div>
                            <div className="text-xs space-y-1">
                              <div className="text-emerald-700">
                                保留：<span className="font-mono text-micro">{g.keptId.slice(0, 8)}</span>
                              </div>
                              <div className="text-amber-600">
                                删除：{g.removed.map((r) => (
                                  <span key={r.id} className="inline-block mr-1">
                                    {r.name}
                                    <span className="text-muted-foreground ml-0.5 text-nano">({r.id.slice(0, 8)})</span>
                                  </span>
                                ))}
                                <span className="text-muted-foreground ml-1">（共 {g.removed.length} 个）</span>
                              </div>
                              {g.fieldMerges && g.fieldMerges.length > 0 && (
                                <div className="mt-2 pt-2 border-t border-border/60">
                                  <div className="text-micro text-muted-foreground mb-1">字段级合并建议：</div>
                                  <div className="space-y-1">
                                    {g.fieldMerges.map((fm, fidx) => (
                                      <div key={fidx} className="text-micro text-muted-foreground leading-relaxed pl-2 border-l border-border">
                                        <span className="text-text font-medium">{fm.field}</span>
                                        <span className="mx-1">←</span>
                                        <span className="text-text">{fm.fromName}</span>
                                        <span className="text-muted-foreground ml-1 text-nano">({fm.fromId.slice(0, 8)})</span>
                                        <div className="text-nano italic">{fm.reason}</div>
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
          </>
        )}
      </div>
    </ReactFlowProvider>
  )
}
