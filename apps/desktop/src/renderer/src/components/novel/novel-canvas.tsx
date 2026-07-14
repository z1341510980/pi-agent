import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge,
  type Node,
  type Edge,
  type NodeTypes,
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
import { CharacterNode } from './nodes/CharacterNode'
import { ConflictNode } from './nodes/ConflictNode'
import { ForeshadowNode } from './nodes/ForeshadowNode'
import { GroupNode } from './nodes/GroupNode'
import { FactionNode } from './nodes/FactionNode'
import { LocationNode } from './nodes/LocationNode'
import { WorldElementNode } from './nodes/WorldElementNode'
import { CreationProgressOverlay } from './creation-progress-overlay'
import type { CreationPhase } from '@/hooks/use-novel-creation-flow'
import { cn } from '@/lib/utils'

// ── 节点类型注册（必须在组件外定义，避免每次渲染重建） ──

const nodeTypes: NodeTypes = {
  character: CharacterNode,
  conflict: ConflictNode,
  foreshadow: ForeshadowNode,
  group: GroupNode,
  faction: FactionNode,
  location: LocationNode,
  world_element: WorldElementNode,
}

// ── MiniMap 性能优化 ──
// 说明：@xyflow/react v12 的 <MiniMap> 不再接受 onlyRenderVisibleElements 属性
// （该属性在 v11 中曾存在，v12 将其合并到 <ReactFlow> 顶层，控制 NodeRenderer /
//  EdgeRenderer 的视口裁剪）。因此这里采用两种互补优化：
//   1. 在 <ReactFlow> 上启用 onlyRenderVisibleElements（节点/边虚拟化）
//   2. 将 <MiniMap> 包装为 memo 组件，仅在节点数 > COMPACT_THRESHOLD 时挂载
//      小项目下 MiniMap 价值有限，省去 SVG 全量渲染开销；大项目时才出现
//      导航缩略图。nodeColor 提到模块作用域以稳定 props 引用，避免不必要重渲染。

function miniMapNodeColor(n: Node): string {
  const type = n.type
  if (type === 'character') return '#3b82f6'
  if (type === 'conflict') return '#f43f5e'
  if (type === 'foreshadow') return '#f59e0b'
  if (type === 'group') return '#6366f1'
  if (type === 'faction') return '#a855f7'
  if (type === 'location') return '#06b6d4'
  if (type === 'world_element') return '#4f46e5'
  return '#6b7280'
}

const MemoizedMiniMap = memo(function MemoizedMiniMap({ visible }: { visible: boolean }) {
  if (!visible) return null
  return (
    <MiniMap
      pannable
      zoomable
      className="!bg-card !border !border-border"
      maskColor="rgba(0,0,0,0.05)"
      nodeColor={miniMapNodeColor}
    />
  )
})

// ── 布局常量 ──

const CHAR_X = -380
const CONFLICT_X_OFFSET = 200
const FORESHADOW_Y = 280
const FORESHADOW_X_START = -380
const FACTION_X = 380
const FACTION_Y_START = -280
const LOCATION_Y = 560
const LOCATION_X_START = -380
const WORLD_ELEMENT_Y = 820
const WORLD_ELEMENT_X_START = -380
const NODE_SPACING_Y = 110
const NODE_SPACING_X = 240

/** 节点数超过此阈值时切换紧凑渲染 */
const COMPACT_THRESHOLD = 50
/** 节点数超过此阈值时显示性能警告 */
const WARNING_THRESHOLD = 100

/** 位置持久化防抖时间 */
const POSITION_SYNC_DEBOUNCE_MS = 1000

// ── 节点 ID 前缀工具 ──

function nodeId(type: NovelNodeType, id: string): string {
  return `${type}:${id}`
}

/**
 * 解析节点 ID：仅在第一个冒号处拆分。
 *
 * 必须使用 indexOf 而非 split(':')，否则当 id 本身含冒号时
 * （例如 "chapter:uuid:1" 这种复合 ID），split 会把 id 截断，
 * 导致后续按 entityId 发起的 DELETE / GET 请求拿到不完整的 id 而 404。
 */
function parseNodeId(nodeId: string): [string, string] {
  const idx = nodeId.indexOf(':')
  return idx >= 0 ? [nodeId.slice(0, idx), nodeId.slice(idx + 1)] : [nodeId, '']
}

function parseParticipants(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

// ── 边打包：统计同一 target 的边数，用于降低视觉密度 ──

function computeTargetBundleCount(edges: Edge[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const e of edges) {
    if (e.target) {
      counts.set(e.target, (counts.get(e.target) ?? 0) + 1)
    }
  }
  return counts
}

// ── 连接规则校验 ──

/**
 * 判断源节点到目标节点的连接是否合法（纯实体关系图）。
 * 允许：
 *   - character ↔ character  （角色关系）
 *   - conflict  → character   （冲突涉及角色，方向性）
 *   - faction   ↔ character   （势力与角色：首领/成员）
 *   - location  ↔ location    （地点层级：父/子）
 *   - faction   ↔ location    （势力归属地点）
 *   - faction   ↔ faction     （势力间盟友/敌对关系）
 *   - foreshadow ↔ any / any ↔ foreshadow （伏笔可关联任意实体）
 *   - group     ↔ any / any ↔ group       （视觉分组可关联任意实体）
 *   - world_element → any / any → world_element （世界观要素可关联任意实体）
 * 禁止：
 *   - character → conflict    （应使用 conflict → character）
 */
function isValidConnection(sourceType: string, targetType: string): boolean {
  // 明确禁止：character → conflict（方向性冲突，应反向连接）
  if (sourceType === 'character' && targetType === 'conflict') return false

  // world_element 与任意实体可互连（世界观要素是元数据层）
  if (sourceType === 'world_element' || targetType === 'world_element') return true

  // foreshadow 与任意实体可互连（伏笔可关联角色/冲突等）
  if (sourceType === 'foreshadow' || targetType === 'foreshadow') return true

  // group 与任意实体可互连（视觉分组）
  if (sourceType === 'group' || targetType === 'group') return true

  // character ↔ character
  if (sourceType === 'character' && targetType === 'character') return true

  // conflict → character（方向性，反向已被上方规则禁止）
  if (sourceType === 'conflict' && targetType === 'character') return true

  // faction ↔ character（势力首领/成员）
  if (
    (sourceType === 'faction' && targetType === 'character') ||
    (sourceType === 'character' && targetType === 'faction')
  ) return true

  // location ↔ location（地点层级：父/子）
  if (sourceType === 'location' && targetType === 'location') return true

  // faction ↔ location（势力归属地点）
  if (
    (sourceType === 'faction' && targetType === 'location') ||
    (sourceType === 'location' && targetType === 'faction')
  ) return true

  // faction ↔ faction（势力间盟友/敌对关系）
  if (sourceType === 'faction' && targetType === 'faction') return true

  return false
}

// ── 边类型标签（过滤下拉用）──

const EDGE_TYPE_LABELS: Record<NovelEdgeType, string> = {
  appearance: '出场',
  relationship: '关系',
  involvement: '参与',
  foreshadow: '伏笔',
  base: '场景',
  member: '成员',
  hierarchy: '层级',
  association: '关联',
  mentor: '师徒',
  kinship: '亲属',
  rivalry: '敌对',
  alliance: '同盟',
  subordinate: '隶属',
  trigger: '触发',
  causality: '因果',
}

// ── 布局函数：根据 store 数据生成节点与边 ──

interface LayoutResult {
  nodes: Node[]
  edges: Edge[]
}

function buildLayout(params: {
  characters: Array<{ id: string; name: string; identity: string; arcStage: string; currentState: string }>
  conflicts: Array<{ id: string; description: string; type: string; intensity: number; stage: string; participants: string }>
  foreshadows: Array<{ id: string; description: string; category: string; status: string; firstChapter: number | null; lastChapter: number | null; recoverByChapter: number | null }>
  factions: Array<{ id: string; name: string; description: string; type: string; strength: string; status: string; leaderId: string | null; allies: string[]; enemies: string[] }>
  locations: Array<{ id: string; name: string; description: string; type: string; parentId: string | null; factionId: string | null; significance: string; firstChapter: number | null; status: string }>
  worldElements: Array<{ id: string; name: string; description: string; category: string; parentId: string | null; attributes: Record<string, unknown> }>
  savedPositions: Map<string, { x: number; y: number }>
  /** 已持久化的手动边（auto=false），与自动边合并并按 source-target 去重 */
  manualEdges: NovelEdge[]
}): LayoutResult {
  const { characters, conflicts, foreshadows, factions, locations, worldElements, savedPositions, manualEdges } = params
  const nodes: Node[] = []
  const edges: Edge[] = []

  /** 优先使用已保存位置，否则使用计算位置 */
  const resolvePos = (type: string, id: string, computed: { x: number; y: number }) => {
    const saved = savedPositions.get(`${type}:${id}`)
    return saved ?? computed
  }

  // 角色节点（左侧竖向排列）
  const charYStart = -((characters.length - 1) * NODE_SPACING_Y) / 2
  characters.forEach((c, i) => {
    nodes.push({
      id: nodeId('character', c.id),
      type: 'character',
      position: resolvePos('character', c.id, { x: CHAR_X, y: charYStart + i * NODE_SPACING_Y }),
      data: { entity: c },
    })
  })

  // 冲突节点（连接到参与角色，保留原有 conflict → character 边）
  conflicts.forEach((cf, i) => {
    const participants = parseParticipants(cf.participants)
    const firstParticipant = participants[0]
    const charIdx = firstParticipant ? characters.findIndex((c) => c.id === firstParticipant) : -1
    const baseY = charIdx >= 0 ? -((characters.length - 1) * NODE_SPACING_Y) / 2 + charIdx * NODE_SPACING_Y : i * NODE_SPACING_Y
    nodes.push({
      id: nodeId('conflict', cf.id),
      type: 'conflict',
      position: resolvePos('conflict', cf.id, { x: CHAR_X + CONFLICT_X_OFFSET, y: baseY + 60 }),
      data: { entity: cf },
    })
    // 连接冲突 → 参与角色
    participants.forEach((pid) => {
      if (characters.some((c) => c.id === pid)) {
        edges.push({
          id: `e-conf-${cf.id}-char-${pid}`,
          source: nodeId('conflict', cf.id),
          target: nodeId('character', pid),
          style: { stroke: 'var(--color-danger)', strokeWidth: 1.5, strokeDasharray: '4 3' },
          data: { auto: true, edgeType: 'involvement' as NovelEdgeType },
        })
      }
    })
  })

  // 伏笔节点（横向排列，纯实体关系图不再关联章节）
  foreshadows.forEach((f, i) => {
    nodes.push({
      id: nodeId('foreshadow', f.id),
      type: 'foreshadow',
      position: resolvePos('foreshadow', f.id, { x: FORESHADOW_X_START + i * NODE_SPACING_X, y: FORESHADOW_Y }),
      data: { entity: f },
    })
  })

  // 势力节点（右侧竖向排列，连接首领角色与盟友/敌对势力）
  factions.forEach((f, i) => {
    nodes.push({
      id: nodeId('faction', f.id),
      type: 'faction',
      position: resolvePos('faction', f.id, { x: FACTION_X, y: FACTION_Y_START + i * NODE_SPACING_Y }),
      data: { entity: f },
    })
    // 势力 → 首领角色
    if (f.leaderId && characters.some((c) => c.id === f.leaderId)) {
      edges.push({
        id: `e-fac-${f.id}-leader-${f.leaderId}`,
        source: nodeId('faction', f.id),
        target: nodeId('character', f.leaderId),
        style: { stroke: '#a855f7', strokeWidth: 1.5 },
        data: { auto: true, edgeType: 'member' as NovelEdgeType },
      })
    }
    // 势力 → 盟友势力
    f.allies.forEach((aid) => {
      if (factions.some((x) => x.id === aid)) {
        edges.push({
          id: `e-fac-${f.id}-ally-${aid}`,
          source: nodeId('faction', f.id),
          target: nodeId('faction', aid),
          style: { stroke: '#10b981', strokeWidth: 1, strokeDasharray: '2 3' },
          data: { auto: true, edgeType: 'alliance' as NovelEdgeType },
        })
      }
    })
    // 势力 → 敌对势力
    f.enemies.forEach((eid) => {
      if (factions.some((x) => x.id === eid)) {
        edges.push({
          id: `e-fac-${f.id}-enemy-${eid}`,
          source: nodeId('faction', f.id),
          target: nodeId('faction', eid),
          style: { stroke: '#f43f5e', strokeWidth: 1, strokeDasharray: '4 2' },
          data: { auto: true, edgeType: 'rivalry' as NovelEdgeType },
        })
      }
    })
  })

  // 地点节点（左下方横向排列，构建父子层级与势力归属）
  locations.forEach((l, i) => {
    nodes.push({
      id: nodeId('location', l.id),
      type: 'location',
      position: resolvePos('location', l.id, { x: LOCATION_X_START + i * NODE_SPACING_X, y: LOCATION_Y }),
      data: { entity: l },
    })
    // 地点 → 父级地点
    if (l.parentId && locations.some((x) => x.id === l.parentId)) {
      edges.push({
        id: `e-loc-${l.id}-parent-${l.parentId}`,
        source: nodeId('location', l.id),
        target: nodeId('location', l.parentId),
        style: { stroke: '#06b6d4', strokeWidth: 1, strokeDasharray: '2 3' },
        data: { auto: true, edgeType: 'hierarchy' as NovelEdgeType },
      })
    }
    // 地点 → 归属势力
    if (l.factionId && factions.some((x) => x.id === l.factionId)) {
      edges.push({
        id: `e-loc-${l.id}-fac-${l.factionId}`,
        source: nodeId('location', l.id),
        target: nodeId('faction', l.factionId),
        style: { stroke: '#0891b2', strokeWidth: 1, strokeDasharray: '3 2' },
        data: { auto: true, edgeType: 'association' as NovelEdgeType },
      })
    }
  })

  // 世界观要素节点（最下方横向排列，构建父子层级）
  worldElements.forEach((we, i) => {
    nodes.push({
      id: nodeId('world_element', we.id),
      type: 'world_element',
      position: resolvePos('world_element', we.id, { x: WORLD_ELEMENT_X_START + i * NODE_SPACING_X, y: WORLD_ELEMENT_Y }),
      data: { entity: we },
    })
    // 世界观要素 → 父级要素
    if (we.parentId && worldElements.some((x) => x.id === we.parentId)) {
      edges.push({
        id: `e-we-${we.id}-parent-${we.parentId}`,
        source: nodeId('world_element', we.id),
        target: nodeId('world_element', we.parentId),
        style: { stroke: '#4f46e5', strokeWidth: 1, strokeDasharray: '2 3' },
        data: { auto: true, edgeType: 'hierarchy' as NovelEdgeType },
      })
    }
  })

  // ── 合并手动边（从 store 读取的已持久化边，auto=false）──
  // 与自动边按 source-target 去重，手动边优先保留（用户意图优先于算法推断）
  const manualFlowEdges: Edge[] = manualEdges
    .filter((e) => !e.auto)
    .map((e) => ({
      id: `edge-${e.id}`,
      source: `${e.sourceType}:${e.sourceId}`,
      target: `${e.targetType}:${e.targetId}`,
      type: 'smoothstep',
      animated: false,
      // cursor:pointer + 略粗线宽提示可交互（hover/选中样式由全局 CSS 控制）
      style: { stroke: 'var(--color-primary)', strokeWidth: 1.5, cursor: 'pointer' },
      data: { auto: false, edgeId: e.id, edgeType: e.edgeType },
    }))

  if (manualFlowEdges.length > 0) {
    const seen = new Set<string>()
    for (const e of edges) {
      const key = `${e.source}-${e.target}`
      seen.add(key)
    }
    for (const me of manualFlowEdges) {
      const key = `${me.source}-${me.target}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push(me)
    }
  }

  // ── 边打包：同一 target 有多条边时降低透明度与线宽 ──
  const bundleCounts = computeTargetBundleCount(edges)
  for (const e of edges) {
    const count = e.target ? bundleCounts.get(e.target) ?? 0 : 0
    if (count > 3) {
      // 打包：使用 smoothstep 类型 + 降低视觉权重
      e.type = 'smoothstep'
      e.animated = false
      e.style = {
        ...(e.style ?? {}),
        strokeWidth: 1,
        opacity: 0.5,
      }
    }
  }

  return { nodes, edges }
}

// ── 创作流程节点高亮 ──

/** 根据创作阶段返回应高亮（脉冲）的节点 ID 集合 */
function computePulsingNodeIds(
  phase: CreationPhase,
  characters: Array<{ id: string }>,
  conflicts: Array<{ id: string }>,
  foreshadows: Array<{ id: string }>,
): Set<string> {
  const ids = new Set<string>()
  if (phase === 'idle' || phase === 'completed' || phase === 'cancelled' || phase === 'error') {
    return ids
  }

  // memory：高亮角色/冲突/伏笔节点（状态更新目标）
  // 注：画布已收敛为纯实体关系图，project/chapter 节点不再渲染，
  // 故 directing/writing 等阶段不再产生脉冲节点
  if (phase === 'memory') {
    characters.forEach((c) => ids.add(nodeId('character', c.id)))
    conflicts.forEach((c) => ids.add(nodeId('conflict', c.id)))
    foreshadows.forEach((f) => ids.add(nodeId('foreshadow', f.id)))
  }

  return ids
}

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

  const { fitView } = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  /** 关系类型过滤：'all' 或具体 edge_type */
  const [edgeTypeFilter, setEdgeTypeFilter] = useState<NovelEdgeType | 'all'>('all')
  /** 点节点高亮的邻居集合（null=未选中，所有节点 opacity 1） */
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<Set<string> | null>(null)
  const isFirstLayout = useRef(true)
  /** 位置批量同步 API 的防抖定时器 */
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 待同步到 API 的位置变更队列（key: `${nodeType}:${entityId}`） */
  const pendingPositionsRef = useRef<Map<string, NodePositionInput>>(new Map())
  /** relayout 时跳过 prev 位置保留的标记 */
  const skipPrevPositionsRef = useRef(false)
  /** 通过 ref 访问最新的 nodePositions / currentProjectId，避免在 relayout effect 中引入额外依赖 */
  const nodePositionsRef = useRef(nodePositions)
  nodePositionsRef.current = nodePositions
  const currentProjectIdRef = useRef(currentProjectId)
  currentProjectIdRef.current = currentProjectId
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
  const layout = useMemo(
    () => buildLayout({
      characters,
      conflicts,
      foreshadows,
      factions,
      locations,
      worldElements,
      savedPositions: savedPositionsMap,
      manualEdges,
    }),
    [characters, conflicts, foreshadows, factions, locations, worldElements, savedPositionsMap, manualEdges],
  )

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
  const handleNodeDragStop = useCallback((_evt: MouseEvent | TouchEvent, node: Node) => {
    const pid = currentProjectIdRef.current
    if (!pid) return
    const [nodeType, entityId] = parseNodeId(node.id) as [NovelNodeTypeName, string]
    // group 节点不持久化位置
    if (nodeType === 'group') return
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
    setHighlightedNodeIds(null)
    setEdgeTypeFilter('all')
  }, [currentProjectId])

  // 同步 store 选中状态 + 创作高亮 + 邻居高亮到节点标记
  useEffect(() => {
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
        // 邻居高亮：未选中时 opacity 1；选中时邻居 1，非邻居 0.2
        const opacity = highlightedNodeIds === null ? 1 : (highlightedNodeIds.has(n.id) ? 1 : 0.2)
        const currentOpacity = n.style?.opacity ?? 1
        if (n.selected === nextSelected && n.className === nextClassName && currentOpacity === opacity) return n
        return { ...n, selected: nextSelected, className: nextClassName, style: { ...n.style, opacity } }
      }),
    )
  }, [selectedNodeId, selectedNodeType, setNodes, pulsingIds, isCompact, highlightedNodeIds])

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
      // 高亮邻居：当前节点 + 所有直接相连节点
      const neighbors = new Set<string>([node.id])
      edges.forEach((e) => {
        if (e.source === node.id) neighbors.add(e.target)
        if (e.target === node.id) neighbors.add(e.source)
      })
      setHighlightedNodeIds(neighbors)
    },
    [selectNode, edges],
  )

  const handlePaneClick = useCallback(() => {
    clearSelection()
    setSelectedEdgeId(null)
    setHighlightedNodeIds(null)
  }, [clearSelection])

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
          stroke: #6366f1;
          stroke-width: 3;
          filter: drop-shadow(0 0 4px rgba(99, 102, 241, 0.5));
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
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} className="!text-muted-foreground/40" />
        <MemoizedMiniMap visible={nodeCount > COMPACT_THRESHOLD} />
        <Controls className="!bg-card !border !border-border !shadow-md" showInteractive={false} />
      </ReactFlow>

      {/* 关系类型过滤：按 edge_type 过滤边 */}
      <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-md border border-border bg-card/90 px-2 py-1 text-xs backdrop-blur-sm">
        <span className="text-[10px] text-muted-foreground">过滤</span>
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
          按 <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-foreground">Delete</kbd> 删除连线，或双击 / 右键连线直接删除
        </div>
      )}

      {/* 节点计数 + 性能警告 */}
      <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-card/90 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur-sm tabular-nums">
          <Layers className="size-3" />
          <span>{nodeCount} 节点</span>
          {isCompact && <span className="text-amber-500">· 紧凑模式</span>}
        </div>
        {showPerfWarning && (
          <div className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-600 dark:text-amber-300">
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
        onCancel={() => onCancelCreation?.()}
      />
    </div>
  )
}
