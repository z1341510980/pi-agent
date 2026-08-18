import { useCallback, useEffect, useState, type ChangeEvent, type ReactElement } from 'react'
import { useReactFlow, type Edge as XYEdge } from '@xyflow/react'
import { EntityCandidatePanel } from './entity-candidate-panel'
import { NarrativeTrackPanel } from './narrative-track-panel'
import { NarrativeRevisionPanel } from './narrative-revision-panel'
import { listEntityCandidates } from '@/api/novel-client'
import {
  Maximize,
  ZoomIn,
  ZoomOut,
  Download,
  Upload,
  Trash2,
  Share2,
  Route,
  Eraser,
  LayoutGrid,
  ShieldQuestion,
  GitBranch,
  Network,
  PenLine,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { useNovelUiStore } from '@/stores/novel-ui-store'
import {
  deleteCharacter,
  deleteConflict,
  deleteForeshadow,
  deleteFaction,
  deleteLocation,
  deleteWorldElement,
  deleteNodePosition,
  findGraphNeighbors,
  findGraphPath,
  type NovelEdgeType,
  type NovelNodeTypeName,
} from '@/api/novel-client'
import { toast, toastError, toastSuccess } from '@/hooks/use-toast'

// ── 手动连线可选的关系类型 ──
// 注：自动边类型（appearance/involvement/member/hierarchy/association/foreshadow/base）
// 由布局函数按实体语义派生，不在此处选择。此处仅列出用户在画布上手动拉线时
// 可能用到的语义化关系类型。
const RELATION_TYPES: { value: NovelEdgeType; label: string }[] = [
  { value: 'mentor', label: '师徒' },
  { value: 'kinship', label: '亲属' },
  { value: 'rivalry', label: '敌对' },
  { value: 'alliance', label: '同盟' },
  { value: 'subordinate', label: '隶属' },
  { value: 'trigger', label: '触发' },
  { value: 'causality', label: '因果' },
  { value: 'relationship', label: '关系' },
]

export interface NovelToolbarProps {
  /** 触发重新布局 */
  onRelayout: () => void
  /** 导出当前画布数据为 JSON */
  onExport?: () => void
  onImport?: () => void
}
export function NovelToolbar({
  onRelayout,
  onExport,
  onImport,
}: NovelToolbarProps): ReactElement {
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  // T04：待审实体候选（Memory 新冲突/线索 needs_review）
  const [candidatePanelOpen, setCandidatePanelOpen] = useState(false)
  const [pendingCandidateCount, setPendingCandidateCount] = useState(0)
  // 第二轮：剧情推进轨道（Storyline × 章节）
  const [trackPanelOpen, setTrackPanelOpen] = useState(false)
  // M2：故事线/场景人工修订与矩阵重投影
  const [revisionPanelOpen, setRevisionPanelOpen] = useState(false)
  useEffect(() => {
    let cancelled = false
    if (!currentProjectId) {
      setPendingCandidateCount(0)
      return
    }
    void listEntityCandidates(currentProjectId, 'needs_review')
      .then((data) => { if (!cancelled) setPendingCandidateCount(data.pendingCount) })
      .catch(() => { if (!cancelled) setPendingCandidateCount(0) })
    return () => { cancelled = true }
  }, [currentProjectId, candidatePanelOpen])
  const selectedNodeId = useNovelUiStore((s) => s.selectedNodeId)
  const selectedNodeType = useNovelUiStore((s) => s.selectedNodeType)
  const clearSelection = useNovelUiStore((s) => s.clearSelection)
  const removeCharacter = useNovelDataStore((s) => s.removeCharacter)
  const removeConflict = useNovelDataStore((s) => s.removeConflict)
  const removeForeshadow = useNovelDataStore((s) => s.removeForeshadow)
  const removeFaction = useNovelDataStore((s) => s.removeFaction)
  const removeLocation = useNovelDataStore((s) => s.removeLocation)
  const removeWorldElement = useNovelDataStore((s) => s.removeWorldElement)
  const removeNodePosition = useNovelDataStore((s) => s.removeNodePosition)
  const canvasEdgeType = useNovelUiStore((s) => s.canvasEdgeType)
  const setCanvasEdgeType = useNovelUiStore((s) => s.setCanvasEdgeType)
  // 画布布局模式：grouped（按类型分区）/ force（d3-force 力导向）
  const canvasLayoutMode = useNovelUiStore((s) => s.canvasLayoutMode)
  const setCanvasLayoutMode = useNovelUiStore((s) => s.setCanvasLayoutMode)
  const setHighlight = useNovelUiStore((s) => s.setHighlight)
  const clearHighlight = useNovelUiStore((s) => s.clearHighlight)
  const pathFindSourceId = useNovelUiStore((s) => s.pathFindSourceId)
  const setPathFindSource = useNovelUiStore((s) => s.setPathFindSource)
  const highlightedNodeIds = useNovelUiStore((s) => s.highlightedNodeIds)
  const characters = useNovelDataStore((s) => s.characters)
  const conflicts = useNovelDataStore((s) => s.conflicts)
  const factions = useNovelDataStore((s) => s.factions)
  const locations = useNovelDataStore((s) => s.locations)
  const worldElements = useNovelDataStore((s) => s.worldElements)
  const foreshadows = useNovelDataStore((s) => s.foreshadows)

  const { zoomIn, zoomOut, fitView, getEdges } = useReactFlow()

  const noProject = !currentProjectId
  const hasSelection = !!selectedNodeId && !!selectedNodeType
  const hasHighlight = highlightedNodeIds.length > 0

  /** 把 entityId + entityType 转为 xyflow node id（"type:id"） */
  const toNodeId = useCallback(
    (entityId: string, entityType: NovelNodeTypeName): string => `${entityType}:${entityId}`,
    [],
  )

  /** 从 store 中查找实体名称（用于 toast 提示） */
  const findEntityName = useCallback(
    (entityId: string, entityType: NovelNodeTypeName): string => {
      // 各实体的"显示名"字段：character/faction/location/world_element 用 name，
      // conflict/foreshadow 用 description（它们没有 name 字段）
      switch (entityType) {
        case 'character':
          return characters.find((e) => e.id === entityId)?.name ?? entityId
        case 'faction':
          return factions.find((e) => e.id === entityId)?.name ?? entityId
        case 'location':
          return locations.find((e) => e.id === entityId)?.name ?? entityId
        case 'world_element':
          return worldElements.find((e) => e.id === entityId)?.name ?? entityId
        case 'conflict':
          return conflicts.find((e) => e.id === entityId)?.description ?? entityId
        case 'foreshadow':
          return foreshadows.find((e) => e.id === entityId)?.description ?? entityId
        default:
          return entityId
      }
    },
    [characters, conflicts, factions, locations, worldElements, foreshadows],
  )

  // ── 高亮邻居：调用 graph API，高亮选中节点 + 所有邻居节点 + 相关边 ──
  const handleHighlightNeighbors = useCallback(async () => {
    if (!selectedNodeId || !selectedNodeType) return
    const currentXYId = toNodeId(selectedNodeId, selectedNodeType as NovelNodeTypeName)
    try {
      const graphEdges = await findGraphNeighbors(selectedNodeId)
      // 收集所有邻居节点 xyflow id
      const neighborNodeIds = new Set<string>([currentXYId])
      for (const ge of graphEdges) {
        neighborNodeIds.add(toNodeId(ge.sourceId, ge.sourceType))
        neighborNodeIds.add(toNodeId(ge.targetId, ge.targetType))
      }
      // 匹配画布上对应的边
      const allEdges: XYEdge[] = getEdges()
      const matchedEdgeIds: string[] = []
      for (const e of allEdges) {
        if (neighborNodeIds.has(e.source) && neighborNodeIds.has(e.target)) {
          matchedEdgeIds.push(e.id)
        }
      }
      setHighlight([...neighborNodeIds], matchedEdgeIds)
      toastSuccess(
        `已高亮 ${graphEdges.length} 条关系`,
        `涉及 ${neighborNodeIds.size} 个节点`,
      )
    } catch (err) {
      toastError('高亮邻居失败', err instanceof Error ? err.message : undefined)
    }
  }, [selectedNodeId, selectedNodeType, toNodeId, getEdges, setHighlight])

  // ── 查找路径：两步交互，第一次设起点，第二次调 API 查最短路径 ──
  const handleFindPath = useCallback(async () => {
    if (!selectedNodeId || !selectedNodeType) return

    // 第一步：设置起点
    if (!pathFindSourceId) {
      setPathFindSource(selectedNodeId)
      const name = findEntityName(selectedNodeId, selectedNodeType as NovelNodeTypeName)
      toast({
        title: '已选起点',
        description: `${name}，请选择终点节点后再次点击"查找路径"`,
        duration: 6000,
      })
      return
    }

    // 起点终点相同
    if (pathFindSourceId === selectedNodeId) {
      toastError('起点和终点相同', '请选择不同的节点作为终点')
      setPathFindSource(null)
      return
    }

    // 第二步：调用 API 查路径
    const fromId = pathFindSourceId
    const toId = selectedNodeId
    setPathFindSource(null)  // 立即清空，避免重复触发
    try {
      const path = await findGraphPath(fromId, toId, 6)
      if (!path.found || path.nodes.length === 0) {
        toastError('未找到路径', '两个节点之间不存在可达关系链')
        return
      }
      const pathNodeIds = path.nodes.map((n) => toNodeId(n.id, n.type))
      // 匹配画布上的边（按路径节点顺序匹配连续的边）
      const allEdges: XYEdge[] = getEdges()
      const matchedEdgeIds: string[] = []
      for (let i = 0; i < pathNodeIds.length - 1; i++) {
        const s = pathNodeIds[i]
        const t = pathNodeIds[i + 1]
        const found = allEdges.find(
          (e) =>
            (e.source === s && e.target === t) ||
            (e.source === t && e.target === s),
        )
        if (found) matchedEdgeIds.push(found.id)
      }
      setHighlight(pathNodeIds, matchedEdgeIds)
      toastSuccess(
        `找到路径`,
        `共 ${path.nodes.length} 个节点 · ${path.edges.length} 条边`,
      )
    } catch (err) {
      toastError('查找路径失败', err instanceof Error ? err.message : undefined)
    }
  }, [selectedNodeId, selectedNodeType, pathFindSourceId, setPathFindSource, findEntityName, toNodeId, getEdges, setHighlight])

  const handleClearHighlight = useCallback(() => {
    clearHighlight()
    setPathFindSource(null)
  }, [clearHighlight, setPathFindSource])

  const handleEdgeTypeChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      setCanvasEdgeType(e.target.value as NovelEdgeType)
    },
    [setCanvasEdgeType],
  )

  // ── 删除当前选中节点 ──
  // 画布已收敛为纯实体关系图，不再渲染 project/chapter 节点，
  // 因此删除分支仅保留实体类型。
  const handleDeleteSelected = useCallback(async () => {
    if (!currentProjectId || !selectedNodeId || !selectedNodeType) return
    // group 节点不对应持久化实体
    if (selectedNodeType === 'group') return
    if (!window.confirm('确认删除此节点？相关数据将被永久移除。')) return
    try {
      switch (selectedNodeType) {
        case 'character':
          await deleteCharacter(selectedNodeId)
          removeCharacter(selectedNodeId)
          break
        case 'conflict':
          await deleteConflict(selectedNodeId)
          removeConflict(selectedNodeId)
          break
        case 'foreshadow':
          await deleteForeshadow(selectedNodeId)
          removeForeshadow(selectedNodeId)
          break
        case 'faction':
          await deleteFaction(selectedNodeId)
          removeFaction(selectedNodeId)
          break
        case 'location':
          await deleteLocation(selectedNodeId)
          removeLocation(selectedNodeId)
          break
        case 'world_element':
          await deleteWorldElement(selectedNodeId)
          removeWorldElement(selectedNodeId)
          break
        default:
          return
      }
      // 删除节点位置（best-effort）
      try {
        await deleteNodePosition(currentProjectId, selectedNodeType as NovelNodeTypeName, selectedNodeId)
      } catch {
        // 位置删除失败不阻塞主流程
      }
      removeNodePosition(selectedNodeType as NovelNodeTypeName, selectedNodeId)
      clearSelection()
    } catch {
      // 静默失败
    }
  }, [currentProjectId, selectedNodeId, selectedNodeType, removeCharacter, removeConflict, removeForeshadow, removeFaction, removeLocation, removeWorldElement, removeNodePosition, clearSelection])

  return (
    <div className="flex items-center gap-1 px-3 h-11 border-b border-border bg-surface-1 shrink-0" data-tour="canvas-toolbar">
      {/* 布局模式切换：分组（按类型分区）/ 图谱（力导向聚类） */}
      <div className="inline-flex items-center gap-0.5 p-0.5 bg-surface-2 rounded-lg" role="group" aria-label="画布布局模式">
        <Button
          size="sm"
          variant={canvasLayoutMode === 'grouped' ? 'default' : 'ghost'}
          onClick={() => setCanvasLayoutMode('grouped')}
          disabled={noProject}
          title="按实体类型分区布局（角色左、势力右等）"
          className="h-6 px-2"
        >
          <LayoutGrid className="size-3" />
          <span className="hidden sm:inline text-micro">分组</span>
        </Button>
        <Button
          size="sm"
          variant={canvasLayoutMode === 'force' ? 'default' : 'ghost'}
          onClick={() => setCanvasLayoutMode('force')}
          disabled={noProject}
          title="力导向布局：相关节点自然聚类，已保存位置锁定"
          className="h-6 px-2"
        >
          <Network className="size-3" />
          <span className="hidden sm:inline text-micro">图谱</span>
        </Button>
      </div>

      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

      {/* 关系类型选择器：决定手动连线的边类型 */}
      <div className="flex items-center gap-1">
        <label htmlFor="novel-canvas-edge-type" className="text-xs text-text-secondary">
          关系类型
        </label>
        <select
          id="novel-canvas-edge-type"
          value={canvasEdgeType}
          onChange={handleEdgeTypeChange}
          disabled={noProject}
          className="h-7 rounded border border-border bg-surface-2 px-1.5 text-xs text-text-primary disabled:opacity-50"
          title="选择手动连线的关系类型"
        >
          {RELATION_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

      {/* 删除选中节点 + 重新排列 */}
      <div className="flex items-center gap-0.5">
        <Button
          size="sm"
          variant="ghost"
          onClick={handleDeleteSelected}
          disabled={!hasSelection}
          title="删除选中节点"
          className={cn(!hasSelection && 'opacity-50')}
        >
          <Trash2 className="size-3.5" />
          <span className="hidden sm:inline">删除</span>
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onRelayout}
          title="重新排列"
          disabled={noProject}
        >
          <Maximize className="size-3.5" />
        </Button>
      </div>

      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

      {/* 关系图分析：高亮邻居 / 查找路径 / 清除高亮 */}
      <div className="flex items-center gap-0.5">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={handleHighlightNeighbors}
          disabled={!hasSelection}
          title="高亮选中节点的所有邻居关系"
          className={cn(!hasSelection && 'opacity-50')}
        >
          <Share2 className="size-3.5" />
        </Button>
        <Button
          size="sm"
          variant={pathFindSourceId ? 'default' : 'ghost'}
          onClick={handleFindPath}
          disabled={!hasSelection}
          title={
            pathFindSourceId
              ? '已选起点，选中终点节点后点击此按钮查找路径'
              : '查找两个节点之间的最短路径（点击设置起点）'
          }
          className={cn(!hasSelection && 'opacity-50')}
        >
          <Route className="size-3.5" />
          <span className="hidden sm:inline">
            {pathFindSourceId ? '选终点' : '路径'}
          </span>
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={handleClearHighlight}
          disabled={!hasHighlight && !pathFindSourceId}
          title="清除高亮"
          className={cn(!hasHighlight && !pathFindSourceId && 'opacity-50')}
        >
          <Eraser className="size-3.5" />
        </Button>
      </div>

      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

      {/* T04：待审实体候选（Memory 新冲突/线索 needs_review） */}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setCandidatePanelOpen(true)}
        disabled={noProject}
        title="查看 Memory 提出、待你确认的新冲突/线索候选"
        className="relative"
      >
        <ShieldQuestion className="size-3.5" />
        <span className="hidden sm:inline">待审实体</span>
        {pendingCandidateCount > 0 && (
          <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-medium text-white">
            {pendingCandidateCount}
          </span>
        )}
      </Button>

      {/* 第二轮：剧情推进轨道 */}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setTrackPanelOpen(true)}
        disabled={noProject}
        title="查看故事线如何被逐章推进（剧情推进轨道）"
      >
        <GitBranch className="size-3.5" />
        <span className="hidden sm:inline">剧情轨道</span>
      </Button>

      {/* M2：故事线/场景人工修订 */}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setRevisionPanelOpen(true)}
        disabled={noProject}
        title="编辑故事线/场景规范事实（草稿→审核→批准→回滚）并重建矩阵"
      >
        <PenLine className="size-3.5" />
        <span className="hidden sm:inline">修订</span>
      </Button>

      <EntityCandidatePanel
        open={candidatePanelOpen}
        onOpenChange={setCandidatePanelOpen}
        projectId={currentProjectId}
      />
      <NarrativeTrackPanel
        open={trackPanelOpen}
        onOpenChange={setTrackPanelOpen}
        projectId={currentProjectId}
      />
      <NarrativeRevisionPanel
        open={revisionPanelOpen}
        onOpenChange={setRevisionPanelOpen}
        projectId={currentProjectId}
      />

      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

      {/* 缩放控制 */}
      <div className="flex items-center gap-0.5">
        <Button size="icon-sm" variant="ghost" onClick={() => zoomIn({ duration: 200 })} title="放大">
          <ZoomIn className="size-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={() => zoomOut({ duration: 200 })} title="缩小">
          <ZoomOut className="size-3.5" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => fitView({ padding: 0.2, duration: 300 })}
          title="适应视图"
        >
          <Maximize className="size-3.5" />
        </Button>
      </div>

      {/* 右侧：导出/导入 */}
      <div className="ml-auto flex items-center gap-0.5">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onImport}
          title="导入"
          className={cn(!onImport && 'hidden')}
        >
          <Upload className="size-3.5" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onExport}
          title="导出"
          className={cn(!onExport && 'hidden')}
        >
          <Download className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}