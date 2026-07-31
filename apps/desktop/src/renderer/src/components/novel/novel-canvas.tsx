import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge,
  type Node,
  type Edge,
  type Connection,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AlertTriangle, Layers } from 'lucide-react'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { useNovelUiStore, type NovelNodeType } from '@/stores/novel-ui-store'
import {
  deleteCharacter,
  deleteConflict,
  deleteForeshadow,
  deleteFaction,
  deleteLocation,
  deleteWorldElement,
  deleteNodePosition,
  upsertNodePositions,
  createEdge,
  deleteEdge,
  type NovelNodePosition,
  type NovelNodeTypeName,
  type NodePositionInput,
  type NovelEdge,
  type NovelEdgeType,
} from '@/api/novel-client'
import { CreationProgressOverlay } from './creation-progress-overlay'
import type { CreationPhase } from '@/hooks/use-novel-creation-flow'
import { cn } from '@/lib/utils'
import { applyForceLayout } from './force-layout'
import { COMPACT_THRESHOLD, WARNING_THRESHOLD, POSITION_SYNC_DEBOUNCE_MS, EDGE_TYPE_LABELS } from './canvas/constants'
import { parseNodeId } from './canvas/node-utils'
import { buildLayout, isValidConnection, computePulsingNodeIds } from './canvas/layout'
import { MemoizedMiniMap, nodeTypes } from './canvas/mini-map'

// ── 主组件 ──

export interface NovelCanvasProps {
  /** 触发重新布局的信号（每次点击重排按钮自增） */
  relayoutSignal?: number
  /** 创作流程当前阶段（用于节点高亮） */
  creationPhase?: CreationPhase
  /** 创作流程是否运行中 */
  creationRunning?: boolean
  /** 创作流程错误 */
  creationError?: string | null
  /** 取消创作流程 */
  onCancelCreation?: () => void
  /** 节点数量变化回调（供工具栏显示） */
  onNodeCountChange?: (count: number) => void
  /** 节点删除完成后的回调（删除逻辑在画布内处理：调用 store + API） */
  onDeleteNode?: () => void
}

export function NovelCanvas({
  relayoutSignal = 0,
  creationPhase = 'idle',
  creationRunning = false,
  creationError = null,
  onCancelCreation,
  onNodeCountChange,
  onDeleteNode,
}: NovelCanvasProps): ReactElement {
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const characters = useNovelDataStore((s) => s.characters)
  const conflicts = useNovelDataStore((s) => s.conflicts)
  const foreshadows = useNovelDataStore((s) => s.foreshadows)
  const factions = useNovelDataStore((s) => s.factions)
  const locations = useNovelDataStore((s) => s.locations)
  const worldElements = useNovelDataStore((s) => s.worldElements)
  const nodePositions = useNovelDataStore((s) => s.nodePositions)
  const selectedNodeId = useNovelUiStore((s) => s.selectedNodeId)
  const selectedNodeType = useNovelUiStore((s) => s.selectedNodeType)
  const selectNode = useNovelUiStore((s) => s.selectNode)
  const clearSelection = useNovelUiStore((s) => s.clearSelection)
  const upsertNodePosition = useNovelDataStore((s) => s.upsertNodePosition)
  const setNodePositions = useNovelDataStore((s) => s.setNodePositions)
  const removeNodePosition = useNovelDataStore((s) => s.removeNodePosition)
  const removeCharacter = useNovelDataStore((s) => s.removeCharacter)
  const removeConflict = useNovelDataStore((s) => s.removeConflict)
  const removeForeshadow = useNovelDataStore((s) => s.removeForeshadow)
  const removeFaction = useNovelDataStore((s) => s.removeFaction)
  const removeLocation = useNovelDataStore((s) => s.removeLocation)
  const removeWorldElement = useNovelDataStore((s) => s.removeWorldElement)
  // 边数据：手动边来自 store（已持久化），与 buildLayout 自动边合并后渲染
  // 注意：store 的 addEdge/removeEdge 与 xyflow 的 addEdge 同名，这里别名以避免冲突
  const manualEdges = useNovelDataStore((s) => s.edges)
  const addEdgeToStore = useNovelDataStore((s) => s.addEdge)
  const removeEdgeFromStore = useNovelDataStore((s) => s.removeEdge)
  const canvasEdgeType = useNovelUiStore((s) => s.canvasEdgeType)
  // 画布布局模式：grouped（按类型分区）/ force（d3-force 力导向，相关节点聚类）
  const canvasLayoutMode = useNovelUiStore((s) => s.canvasLayoutMode)
  // 来自 toolbar 按钮的高亮（API 驱动，比本地点击高亮更全面）
  const storeHighlightedNodeIds = useNovelUiStore((s) => s.highlightedNodeIds)
  const storeHighlightedEdgeIds = useNovelUiStore((s) => s.highlightedEdgeIds)
  const clearStoreHighlight = useNovelUiStore((s) => s.clearHighlight)

  const { fitView } = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  /** 关系类型过滤：'all' 或具体 edge_type */
  const [edgeTypeFilter, setEdgeTypeFilter] = useState<NovelEdgeType | 'all'>('all')
  /** 点节点高亮的邻居集合（null=未选中，所有节点 opacity 1） */
  const [localHighlightedNodeIds, setLocalHighlightedNodeIds] = useState<Set<string> | null>(null)
  const isFirstLayout = useRef(true)
  /** 位置批量同步 API 的防抖定时器 */
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 待同步到 API 的位置变更队列（key: `${nodeType}:${entityId}`） */
  const pendingPositionsRef = useRef<Map<string, NodePositionInput>>(new Map())
  /** relayout 时跳过 prev 位置保留的标记 */
  const skipPrevPositionsRef = useRef(false)
  /** 通过 ref 访问最新的 nodePositions / currentProjectId / canvasLayoutMode，避免在 effect 中引入额外依赖 */
  const nodePositionsRef = useRef(nodePositions)
  nodePositionsRef.current = nodePositions
  const currentProjectIdRef = useRef(currentProjectId)
  currentProjectIdRef.current = currentProjectId
  const canvasLayoutModeRef = useRef(canvasLayoutMode)
  canvasLayoutModeRef.current = canvasLayoutMode
  const [showPerfWarning, setShowPerfWarning] = useState(false)

  // 已保存的位置 Map（key: `${nodeType}:${entityId}`）
  const savedPositionsMap = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>()
    for (const p of nodePositions) {
      if (p.projectId === currentProjectId) {
        map.set(`${p.nodeType}:${p.entityId}`, { x: p.posX, y: p.posY })
      }
    }
    return map
  }, [nodePositions, currentProjectId])

  // 计算布局（memoized）
  // grouped 模式：buildLayout 按实体类型分区（角色左、势力右等）
  // force 模式：在 buildLayout 基础上叠加 d3-force 力导向，让相关节点自然聚类
  //   - 所有节点都参与力模拟（不锁定），让用户立即看到聚类效果
  //   - 不持久化 force 结果，切回 grouped 仍能看到原 savedPositions
  //   - 初始位置取 buildLayout 的 computed（忽略 savedPositions），避免锁定
  //   - 边改为 straight 类型：力导向布局下直线最清晰，避免 smoothstep 折线交叉
  const layout = useMemo(() => {
    if (canvasLayoutMode !== 'force') {
      return buildLayout({
        characters,
        conflicts,
        foreshadows,
        factions,
        locations,
        worldElements,
        savedPositions: savedPositionsMap,
        manualEdges,
      })
    }
    // force 模式：用空 savedPositions 让 buildLayout 返回 computed 初始位置
    // 再叠加力导向，所有节点都参与模拟
    const base = buildLayout({
      characters,
      conflicts,
      foreshadows,
      factions,
      locations,
      worldElements,
      savedPositions: new Map(),  // 忽略已保存位置，让所有节点都参与力模拟
      manualEdges,
    })
    const forceNodes = applyForceLayout(base.nodes, base.edges, new Set())
    // force 模式下边用 default（贝塞尔曲线）类型：参考 graphify 风格，
    // 曲线连线在多对多关系下能自然分离，避免直线交叉的视觉混乱
    // 移除 smoothstep 折线（折线在力导向下会显得生硬）
    // 边样式统一：略低透明度 + 保持原颜色，让节点成为视觉焦点
    const forceEdges = base.edges.map((e) => ({
      ...e,
      type: 'default' as const,
      animated: false,
      style: {
        ...(e.style ?? {}),
        strokeWidth: 1.2,
        opacity: 0.6,
      },
    }))
    return { nodes: forceNodes, edges: forceEdges }
  }, [characters, conflicts, foreshadows, factions, locations, worldElements, savedPositionsMap, manualEdges, canvasLayoutMode])

  // 节点总数
  const nodeCount = layout.nodes.length
  const isCompact = nodeCount > COMPACT_THRESHOLD

  // 通知父组件节点数量变化
  useEffect(() => {
    onNodeCountChange?.(nodeCount)
    setShowPerfWarning(nodeCount > WARNING_THRESHOLD)
  }, [nodeCount, onNodeCountChange])

  // 计算应高亮的节点 ID
  const pulsingIds = useMemo(
    () => computePulsingNodeIds(
      creationPhase,
      characters,
      conflicts,
      foreshadows,
    ),
    [creationPhase, characters, conflicts, foreshadows],
  )

  // ── 节点删除：调用 API + 更新 store ──
  const handleDeleteNode = useCallback(async (targetId: string, targetType: NovelNodeType) => {
    const pid = currentProjectIdRef.current
    if (!pid) return
    // group 节点不对应持久化实体，无需调用 API
    if (targetType === 'group') return
    if (!window.confirm('确认删除此节点？相关数据将被永久移除。')) return
    try {
      switch (targetType) {
        case 'character':
          await deleteCharacter(targetId)
          removeCharacter(targetId)
          break
        case 'conflict':
          await deleteConflict(targetId)
          removeConflict(targetId)
          break
        case 'foreshadow':
          await deleteForeshadow(targetId)
          removeForeshadow(targetId)
          break
        case 'faction':
          await deleteFaction(targetId)
          removeFaction(targetId)
          break
        case 'location':
          await deleteLocation(targetId)
          removeLocation(targetId)
          break
        case 'world_element':
          await deleteWorldElement(targetId)
          removeWorldElement(targetId)
          break
        default:
          return
      }
      // 删除节点位置（best-effort）
      try {
        await deleteNodePosition(pid, targetType as NovelNodeTypeName, targetId)
      } catch {
        // 位置删除失败不阻塞主流程
      }
      removeNodePosition(targetType as NovelNodeTypeName, targetId)
      clearSelection()
      onDeleteNode?.()
    } catch {
      // 静默失败（可在通知中心提示）
    }
  }, [removeCharacter, removeConflict, removeForeshadow, removeFaction, removeLocation, removeWorldElement, removeNodePosition, clearSelection, onDeleteNode])

  // ── 位置批量同步：将待同步队列一次性 PUT 到 API ──
  const flushPositions = useCallback(() => {
    const pid = currentProjectIdRef.current
    if (!pid) return
    const pending = Array.from(pendingPositionsRef.current.values())
    if (pending.length === 0) return
    pendingPositionsRef.current.clear()
    void upsertNodePositions(pid, pending).catch(() => {
      // 静默失败：本地 store 已更新，下次拖拽或刷新会再次尝试
    })
  }, [])

  // ── 节点拖拽结束：更新 store + 入队 + 防抖 API 同步 ──
  // force 模式下不持久化位置：力导向布局是"探索视图"，用户切回 grouped 仍应看到原位置
  // grouped 模式下正常持久化（与原行为一致）
  const handleNodeDragStop = useCallback((_evt: MouseEvent | TouchEvent, node: Node) => {
    const pid = currentProjectIdRef.current
    if (!pid) return
    const [nodeType, entityId] = parseNodeId(node.id) as [NovelNodeTypeName, string]
    // group 节点不持久化位置
    if (nodeType === 'group') return
    // force 模式下跳过持久化（位置仅在当前会话有效）
    if (canvasLayoutModeRef.current === 'force') return
    // 查找现有位置记录以保留 id（避免在 upsertInList 中产生重复）
    const existing = nodePositionsRef.current.find(
      (p) => p.nodeType === nodeType && p.entityId === entityId && p.projectId === pid,
    )
    const pos: NovelNodePosition = {
      id: existing?.id ?? `${pid}:${nodeType}:${entityId}`,
      projectId: pid,
      nodeType,
      entityId,
      posX: node.position.x,
      posY: node.position.y,
      updatedAt: Date.now(),
    }
    upsertNodePosition(pos)
    // 入队待同步
    pendingPositionsRef.current.set(`${nodeType}:${entityId}`, {
      nodeType,
      entityId,
      posX: node.position.x,
      posY: node.position.y,
    })
    // 防抖 API 同步
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null
      flushPositions()
    }, POSITION_SYNC_DEBOUNCE_MS)
  }, [upsertNodePosition, flushPositions])

  // ── 手动连接：onConnect ──
  // 持久化到后端 → 更新 store → 更新 xyflow edges
  // 失败时静默返回，不污染画布（store 未变，layout 不会重算）
  const handleConnect = useCallback(async (params: Connection) => {
    if (!params.source || !params.target) return
    const pid = currentProjectIdRef.current
    if (!pid) return
    const [sourceType, sourceId] = parseNodeId(params.source)
    const [targetType, targetId] = parseNodeId(params.target)
    if (!sourceId || !targetId) return
    if (!isValidConnection(sourceType, targetType)) return
    // 关系类型由工具栏选择器决定（store.canvasEdgeType）
    const edgeType = canvasEdgeType
    let edge: NovelEdge
    try {
      edge = await createEdge(pid, {
        sourceId,
        sourceType: sourceType as NovelNodeTypeName,
        targetId,
        targetType: targetType as NovelNodeTypeName,
        edgeType,
        label: '',
        auto: false,
      })
    } catch {
      return
    }
    addEdgeToStore(edge)
    // id 与 buildLayout 中手动边的 id 格式一致（`edge-${edge.id}`），
    // 避免 store 更新触发布局重算与此处 addEdge 同时执行时产生重复边
    setEdges((eds) => addEdge(
      {
        ...params,
        id: `edge-${edge.id}`,
        animated: false,
        style: { stroke: 'var(--color-primary)', strokeWidth: 1.5, cursor: 'pointer' },
        data: { auto: false, edgeId: edge.id, edgeType },
      },
      eds,
    ))
  }, [setEdges, addEdgeToStore, canvasEdgeType])

  // ── 同步布局到 nodes/edges ──
  // - 保留已存在节点的拖拽位置（prev）
  // - 新节点使用 layout 中的位置（saved 或 computed）
  // - 切换 layoutMode 时跳过 prev 位置（避免旧位置覆盖新布局）
  // - 为每个节点注入 onDelete 回调
  useEffect(() => {
    setNodes((prev) => {
      if (skipPrevPositionsRef.current) {
        // relayout 模式：忽略 prev 位置，使用 layout（computed）
        skipPrevPositionsRef.current = false
        return layout.nodes.map((n) => {
          const [type, id] = parseNodeId(n.id)
          return {
            ...n,
            data: {
              ...n.data,
              onDelete: () => { void handleDeleteNode(id, type as NovelNodeType) },
            },
          }
        })
      }
      const prevPosMap = new Map(prev.map((n) => [n.id, n.position]))
      return layout.nodes.map((n) => {
        const [type, id] = parseNodeId(n.id)
        const prevPos = prevPosMap.get(n.id)
        return {
          ...n,
          position: prevPos ?? n.position,
          data: {
            ...n.data,
            onDelete: () => { void handleDeleteNode(id, type as NovelNodeType) },
          },
        }
      })
    })
    setEdges(layout.edges)
  }, [layout, setNodes, setEdges, handleDeleteNode])

  // ── 切换布局模式：跳过 prev 位置 + 自动 fitView ──
  // force 模式的力导向位置 / grouped 模式的分区位置都应该完整应用，
  // 不被 prev 拖拽位置覆盖。fitView 让用户立即看到新布局全貌。
  useEffect(() => {
    skipPrevPositionsRef.current = true
    const timer = setTimeout(() => {
      try {
        fitView({ padding: 0.2, duration: 400 })
      } catch {
        // ignore
      }
    }, 50)
    return () => clearTimeout(timer)
  }, [canvasLayoutMode, fitView])

  // ── relayout：清除已保存位置 + 重建为计算位置 ──
  useEffect(() => {
    if (relayoutSignal === 0) return
    const pid = currentProjectIdRef.current
    if (!pid) return
    skipPrevPositionsRef.current = true
    // 清除 store 中当前项目的位置记录
    const positions = nodePositionsRef.current
    const projectPositions = positions.filter((p) => p.projectId === pid)
    setNodePositions(positions.filter((p) => p.projectId !== pid))
    // 删除 API 端位置（best-effort）
    for (const p of projectPositions) {
      void deleteNodePosition(pid, p.nodeType, p.entityId).catch(() => {})
    }
    // relayout 后自动 fitView
    const timer = setTimeout(() => {
      try {
        fitView({ padding: 0.2, duration: 400 })
      } catch {
        // ignore
      }
    }, 50)
    return () => clearTimeout(timer)
  }, [relayoutSignal, setNodePositions, fitView])

  // 首次布局或切换项目后自动 fitView
  useEffect(() => {
    isFirstLayout.current = false
    const timer = setTimeout(() => {
      try {
        fitView({ padding: 0.2, duration: 400 })
      } catch {
        // React Flow 尚未就绪时忽略
      }
    }, 50)
    return () => clearTimeout(timer)
  }, [currentProjectId, fitView])

  // 切换项目时重置首次布局标记，并清空画布本地状态
  // 避免旧项目的邻居 Set 残留导致新项目节点全被降至 0.2 透明度
  useEffect(() => {
    isFirstLayout.current = true
    setLocalHighlightedNodeIds(null)
    clearStoreHighlight()
    setEdgeTypeFilter('all')
  }, [currentProjectId, clearStoreHighlight])

  // 同步 store 选中状态 + 创作高亮 + 邻居高亮（本地点击 + store API）到节点标记
  useEffect(() => {
    // 合并本地点击高亮与 store API 高亮：任一非空即激活"高亮模式"
    const storeNodeSet = storeHighlightedNodeIds.length > 0
      ? new Set(storeHighlightedNodeIds)
      : null
    const localSet = localHighlightedNodeIds
    const hasAnyHighlight = storeNodeSet !== null || localSet !== null

    setNodes((prev) =>
      prev.map((n) => {
        const [type, id] = parseNodeId(n.id) as [NovelNodeType, string]
        const isSelected = id === selectedNodeId && type === selectedNodeType
        const isPulsing = pulsingIds.has(n.id)
        const nextSelected = n.selected === isSelected ? n.selected : isSelected
        const nextClassName = cn(
          isPulsing && 'novel-node-pulsing',
          isCompact && 'novel-node-compact',
        )
        // 高亮模式下：在 localSet 或 storeNodeSet 中 opacity 1，否则 0.2
        const isInHighlight =
          (localSet?.has(n.id) ?? false) || (storeNodeSet?.has(n.id) ?? false)
        const opacity = hasAnyHighlight ? (isInHighlight ? 1 : 0.2) : 1
        const currentOpacity = n.style?.opacity ?? 1
        if (n.selected === nextSelected && n.className === nextClassName && currentOpacity === opacity) return n
        return { ...n, selected: nextSelected, className: nextClassName, style: { ...n.style, opacity } }
      }),
    )
  }, [selectedNodeId, selectedNodeType, setNodes, pulsingIds, isCompact, localHighlightedNodeIds, storeHighlightedNodeIds])

  // 同步 store 边高亮到 xyflow edges style
  // 高亮的边：stroke 加粗 + 颜色 primary；非高亮：opacity 0.15
  useEffect(() => {
    if (storeHighlightedEdgeIds.length === 0) {
      // 恢复默认（移除高亮 override）
      setEdges((prev) =>
        prev.map((e) => {
          if (!e.data?.highlightOverride) return e
          // 移除高亮 override，恢复原始 style
          const { highlightOverride, ...restData } = e.data as any
          const origStyle = (e.data as any)?.origStyle
          return {
            ...e,
            style: origStyle ?? e.style,
            data: restData,
          }
        }),
      )
      return
    }
    const highlightSet = new Set(storeHighlightedEdgeIds)
    setEdges((prev) =>
      prev.map((e) => {
        const isHighlighted = highlightSet.has(e.id)
        const alreadyHighlighted = (e.data as any)?.highlightOverride === true
        if (isHighlighted && alreadyHighlighted) return e
        if (!isHighlighted && !(e.data as any)?.highlightOverride) {
          // 非高亮且未标记：只设置 opacity（保留原 stroke）
          return {
            ...e,
            style: { ...e.style, opacity: 0.15 },
            data: { ...e.data, highlightOverride: false, origStyle: e.style },
          }
        }
        if (isHighlighted) {
          return {
            ...e,
            style: {
              ...e.style,
              stroke: 'var(--color-primary)',
              strokeWidth: 2.5,
              opacity: 1,
            },
            data: { ...e.data, highlightOverride: true, origStyle: e.style },
          }
        }
        // 非高亮但已被标记：降级 opacity
        return {
          ...e,
          style: { ...e.style, opacity: 0.15 },
        }
      }),
    )
  }, [storeHighlightedEdgeIds, setEdges])

  // ── 边删除：调用 API + 更新 store + 移除 xyflow 边 ──
  // 手动边（data.edgeId 存在）调 API + 更新 store；自动边仅从 xyflow state 移除
  // （自动边由布局重算生成，下次 layout 会重建，但即时移除给用户明确反馈）
  const handleDeleteEdge = useCallback(async (edge: Edge) => {
    const edgeId = edge.data?.edgeId
    // 有 edgeId 的手动边：调 API 持久化删除 + 更新 store
    if (typeof edgeId === 'string') {
      try {
        await deleteEdge(edgeId)
      } catch {
        return
      }
      removeEdgeFromStore(edgeId)
    }
    // 无论手动边还是自动边，都从 React Flow state 中移除
    setEdges((eds) => eds.filter((e) => e.id !== edge.id))
    setSelectedEdgeId(null)
  }, [deleteEdge, removeEdgeFromStore, setEdges])

  // ── 键盘删除：Delete / Backspace ──
  // 优先删除选中的节点；若未选中节点但选中了边，则删除边
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      // 输入框中不触发删除
      const evtTarget = e.target as HTMLElement | null
      if (evtTarget && (evtTarget.tagName === 'INPUT' || evtTarget.tagName === 'TEXTAREA' || evtTarget.isContentEditable)) return
      if (selectedNodeId && selectedNodeType) {
        e.preventDefault()
        void handleDeleteNode(selectedNodeId, selectedNodeType)
        return
      }
      if (selectedEdgeId) {
        e.preventDefault()
        const edgeToDelete = edges.find((ed) => ed.id === selectedEdgeId)
        if (edgeToDelete) void handleDeleteEdge(edgeToDelete)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedNodeId, selectedNodeType, selectedEdgeId, edges, handleDeleteNode, handleDeleteEdge])

  // ── 卸载 / 项目切换前刷新待同步位置 ──
  useEffect(() => {
    return () => {
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current)
        syncTimerRef.current = null
      }
      flushPositions()
    }
  }, [flushPositions])

  const handleNodeClick = useCallback(
    (_evt: ReactMouseEvent, node: Node) => {
      const [type, id] = parseNodeId(node.id)
      // group 节点内部处理点击（展开/折叠），不参与选中
      if (type === 'group') return
      selectNode(id, type as NovelNodeType)
      // 切换到本地点击高亮模式，清掉 store 的 toolbar 高亮
      clearStoreHighlight()
      // 高亮邻居：当前节点 + 所有直接相连节点
      const neighbors = new Set<string>([node.id])
      edges.forEach((e) => {
        if (e.source === node.id) neighbors.add(e.target)
        if (e.target === node.id) neighbors.add(e.source)
      })
      setLocalHighlightedNodeIds(neighbors)
    },
    [selectNode, edges, clearStoreHighlight],
  )

  const handlePaneClick = useCallback(() => {
    clearSelection()
    setSelectedEdgeId(null)
    setLocalHighlightedNodeIds(null)
    clearStoreHighlight()
  }, [clearSelection, clearStoreHighlight])

  // 点击边：选中（用于键盘删除）；仅在画布内追踪，不污染 store 选中状态
  const handleEdgeClick = useCallback((_evt: ReactMouseEvent, edge: Edge) => {
    setSelectedEdgeId(edge.id)
  }, [])

  // 双击边：直接删除（手动边 + 自动边均可）
  // 改为无 confirm 直删：双击是明确的删除意图，confirm 在 Electron 下体验不佳
  const handleEdgeDoubleClick = useCallback((_evt: ReactMouseEvent, edge: Edge) => {
    void handleDeleteEdge(edge)
  }, [handleDeleteEdge])

  // 右键边：直接删除（补充双击与键盘 Delete 之外的交互方式）
  // preventDefault 阻止浏览器默认右键菜单
  const handleEdgeContextMenu = useCallback((evt: ReactMouseEvent, edge: Edge) => {
    evt.preventDefault()
    void handleDeleteEdge(edge)
  }, [handleDeleteEdge])

  // ── 关系类型过滤：按 edgeTypeFilter 过滤边（nodes 不变，只过滤 edges）──
  const filteredEdges = useMemo(() => {
    if (edgeTypeFilter === 'all') return edges
    return edges.filter((e) => e.data?.edgeType === edgeTypeFilter)
  }, [edges, edgeTypeFilter])

  // ── 边选中视觉反馈 ──
  // ReactFlow 原生支持 edge.selected（默认选中样式：粗线 + 高亮色），
  // 但默认样式较弱且不易察觉。这里在传入前显式标记 selected，
  // 配合下方 .novel-edge-selected CSS 提供更明显的视觉反馈，
  // 让用户知道"边已被选中，可按 Delete 删除"。
  const edgesWithSelection = useMemo(
    () => filteredEdges.map((e) => (e.id === selectedEdgeId ? { ...e, selected: true } : { ...e, selected: false })),
    [filteredEdges, selectedEdgeId],
  )

  return (
    <div className="relative h-full w-full bg-workspace-bg">
      {/* 节点脉冲动画样式 + 紧凑模式样式 + 边选中/hover 样式 */}
      <style>{`
        @keyframes novel-node-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.4); }
          50% { box-shadow: 0 0 0 8px rgba(139, 92, 246, 0); }
        }
        .novel-node-pulsing .react-flow__node {
          animation: novel-node-pulse 1.5s ease-in-out infinite;
          border-radius: 0.5rem;
        }
        .novel-node-compact .react-flow__node {
          transform: scale(0.85);
          transform-origin: center top;
        }
        /* 手动边 hover：略粗 + 主色加亮，提示可交互 */
        .novel-canvas .react-flow__edge:hover .react-flow__edge-path {
          stroke-width: 2.5;
          cursor: pointer;
        }
        /* 选中边：粗线 + 醒目强调色 + 轻微动画 */
        .novel-canvas .react-flow__edge.novel-edge-selected .react-flow__edge-path,
        .novel-canvas .react-flow__edge.selected .react-flow__edge-path {
          stroke: #4b3fe3;
          stroke-width: 3;
          filter: drop-shadow(0 0 4px rgba(75, 63, 227, 0.5));
        }
      `}</style>

      <ReactFlow
        nodes={nodes}
        edges={edgesWithSelection}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onEdgeDoubleClick={handleEdgeDoubleClick}
        onEdgeContextMenu={handleEdgeContextMenu}
        onPaneClick={handlePaneClick}
        onNodeDragStop={handleNodeDragStop}
        onConnect={handleConnect}
        fitView
        minZoom={0.2}
        maxZoom={2}
        defaultEdgeOptions={{ animated: false, interactionWidth: 20 }}
        proOptions={{ hideAttribution: true }}
        onlyRenderVisibleElements
        className="novel-canvas"
        data-tour="canvas"
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} className="!text-muted-foreground/40" />
        <MemoizedMiniMap visible={nodeCount > COMPACT_THRESHOLD} data-tour="canvas-minimap" />
        <Controls className="!bg-card !border !border-border !shadow-md" showInteractive={false} />
      </ReactFlow>

      {/* 关系类型过滤：按 edge_type 过滤边 */}
      <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-md border border-border bg-card/90 px-2 py-1 text-xs backdrop-blur-sm">
        <span className="text-nano text-muted-foreground">过滤</span>
        <select
          value={edgeTypeFilter}
          onChange={(e) => setEdgeTypeFilter(e.target.value as NovelEdgeType | 'all')}
          className="h-6 rounded border border-border bg-transparent px-1 text-xs text-foreground outline-none"
          title="按关系类型过滤连线"
        >
          <option value="all">全部</option>
          {(Object.entries(EDGE_TYPE_LABELS) as [NovelEdgeType, string][]).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      {/* 边删除提示：选中边时显示，引导用户按 Delete 删除或双击/右键直删 */}
      {selectedEdgeId && (
        <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs text-muted-foreground shadow-md backdrop-blur-sm">
          按 <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-nano text-foreground">Delete</kbd> 删除连线，或双击 / 右键连线直接删除
        </div>
      )}

      {/* 节点计数 + 性能警告 */}
      <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-card/90 px-2 py-1 text-nano text-muted-foreground backdrop-blur-sm tabular-nums">
          <Layers className="size-3" />
          <span>{nodeCount} 节点</span>
          {isCompact && <span className="text-amber-500">· 紧凑模式</span>}
        </div>
        {showPerfWarning && (
          <div className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-nano text-amber-600 dark:text-amber-300">
            <AlertTriangle className="size-3" />
            <span>节点过多，建议按类型筛选</span>
          </div>
        )}
      </div>

      {/* 创作流程进度浮层 */}
      <CreationProgressOverlay
        phase={creationPhase}
        isRunning={creationRunning}
        error={creationError}
        onCancel={() => { void onCancelCreation?.() }}
      />
    </div>
  )
}
