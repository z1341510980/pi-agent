import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'
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
import { useNovelStore } from '@/stores/novel-store'
import type { NovelNodeType } from '@/stores/novel-store'
import {
  deleteProject,
  deleteCharacter,
  deleteChapter,
  deleteConflict,
  deleteForeshadow,
  deleteNodePosition,
  upsertNodePositions,
  type NovelNodePosition,
  type NovelNodeTypeName,
  type NodePositionInput,
} from '@/api/novel-client'
import { ProjectNode } from './nodes/ProjectNode'
import { CharacterNode } from './nodes/CharacterNode'
import { ChapterNode } from './nodes/ChapterNode'
import { ConflictNode } from './nodes/ConflictNode'
import { ForeshadowNode } from './nodes/ForeshadowNode'
import { GroupNode } from './nodes/GroupNode'
import { CreationProgressOverlay } from './creation-progress-overlay'
import type { CreationPhase } from '@/hooks/use-novel-creation-flow'
import { cn } from '@/lib/utils'

// ── 节点类型注册（必须在组件外定义，避免每次渲染重建） ──

const nodeTypes: NodeTypes = {
  project: ProjectNode,
  character: CharacterNode,
  chapter: ChapterNode,
  conflict: ConflictNode,
  foreshadow: ForeshadowNode,
  group: GroupNode,
}

// ── 布局常量 ──

const PROJECT_POS = { x: 0, y: 0 }
const CHAR_X = -380
const CHAPTER_Y = 280
const CONFLICT_X_OFFSET = 200
const FORESHADOW_Y = 560
const NODE_SPACING_Y = 110
const CHAPTER_SPACING_X = 240

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
 * 判断源节点到目标节点的连接是否合法。
 * 允许：
 *   - character ↔ chapter    （角色出现在章节中）
 *   - character ↔ character  （角色关系）
 *   - conflict  → character   （冲突涉及角色，方向性）
 *   - foreshadow → chapter    （伏笔埋设/回收于章节）
 *   - group     → chapter     （集合节点关联到章节）
 *   - project   → any / any → project （通常自动生成）
 * 禁止：
 *   - character → conflict    （应使用 conflict → character）
 */
function isValidConnection(sourceType: string, targetType: string): boolean {
  // 明确禁止：character → conflict（方向性冲突，应反向连接）
  if (sourceType === 'character' && targetType === 'conflict') return false

  // project 与任意实体可互连（通常自动生成）
  if (sourceType === 'project' || targetType === 'project') return true

  // character ↔ chapter
  if (
    (sourceType === 'character' && targetType === 'chapter') ||
    (sourceType === 'chapter' && targetType === 'character')
  ) return true

  // character ↔ character
  if (sourceType === 'character' && targetType === 'character') return true

  // conflict → character（方向性，反向已被上方规则禁止）
  if (sourceType === 'conflict' && targetType === 'character') return true

  // foreshadow ↔ chapter（允许双向以改善 UX）
  if (
    (sourceType === 'foreshadow' && targetType === 'chapter') ||
    (sourceType === 'chapter' && targetType === 'foreshadow')
  ) return true

  // group ↔ chapter（允许双向）
  if (
    (sourceType === 'group' && targetType === 'chapter') ||
    (sourceType === 'chapter' && targetType === 'group')
  ) return true

  return false
}

// ── 布局函数：根据 store 数据生成节点与边 ──

interface LayoutResult {
  nodes: Node[]
  edges: Edge[]
}

function buildLayout(params: {
  project: { id: string; title: string; genre: string; currentChapter: number; currentStage: string; status: string; targetWords: number } | null
  characters: Array<{ id: string; name: string; identity: string; arcStage: string; currentState: string }>
  chapters: Array<{ id: string; chapterNumber: number; title: string; status: string; wordCount: number; volume: number }>
  conflicts: Array<{ id: string; description: string; type: string; intensity: number; stage: string; participants: string }>
  foreshadows: Array<{ id: string; description: string; category: string; status: string; firstChapter: number | null; lastChapter: number | null; recoverByChapter: number | null }>
  savedPositions: Map<string, { x: number; y: number }>
}): LayoutResult {
  const { project, characters, chapters, conflicts, foreshadows, savedPositions } = params
  const nodes: Node[] = []
  const edges: Edge[] = []

  /** 优先使用已保存位置，否则使用计算位置 */
  const resolvePos = (type: string, id: string, computed: { x: number; y: number }) => {
    const saved = savedPositions.get(`${type}:${id}`)
    return saved ?? computed
  }

  // 项目节点（中心）
  if (project) {
    nodes.push({
      id: nodeId('project', project.id),
      type: 'project',
      position: resolvePos('project', project.id, PROJECT_POS),
      data: { entity: project },
    })
  }

  // 角色节点（左侧竖向排列，不再生成 character → project 噪声边）
  const charYStart = -((characters.length - 1) * NODE_SPACING_Y) / 2
  characters.forEach((c, i) => {
    nodes.push({
      id: nodeId('character', c.id),
      type: 'character',
      position: resolvePos('character', c.id, { x: CHAR_X, y: charYStart + i * NODE_SPACING_Y }),
      data: { entity: c },
    })
  })

  // 章节节点（下方横向序列，按章节号排序，相邻章节用序列边连接）
  const sortedChapters = [...chapters].sort((a, b) => a.chapterNumber - b.chapterNumber)
  const chapterXStart = -((sortedChapters.length - 1) * CHAPTER_SPACING_X) / 2
  const chapterByNumber = new Map<number, string>()
  sortedChapters.forEach((ch, i) => {
    const x = chapterXStart + i * CHAPTER_SPACING_X
    nodes.push({
      id: nodeId('chapter', ch.id),
      type: 'chapter',
      position: resolvePos('chapter', ch.id, { x, y: CHAPTER_Y }),
      data: { entity: ch },
    })
    chapterByNumber.set(ch.chapterNumber, ch.id)
    // 相邻章节序列边（distinct style，标记为 auto）
    if (i > 0) {
      const prevCh = sortedChapters[i - 1]
      edges.push({
        id: `e-chap-seq-${prevCh.id}-${ch.id}`,
        source: nodeId('chapter', prevCh.id),
        target: nodeId('chapter', ch.id),
        type: 'smoothstep',
        style: { stroke: 'var(--color-muted-foreground)', strokeWidth: 1, strokeDasharray: '2 3' },
        data: { auto: true },
      })
    }
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
          data: { auto: true },
        })
      }
    })
  })

  // 伏笔节点（连接到相关章节，保留原有 foreshadow → chapter 边）
  foreshadows.forEach((f, i) => {
    const targetChapterNum = f.firstChapter ?? f.recoverByChapter
    const targetChapterId = targetChapterNum != null ? chapterByNumber.get(targetChapterNum) : undefined
    const chapterIdx = targetChapterId ? chapters.findIndex((c) => c.id === targetChapterId) : -1
    const x = chapterIdx >= 0
      ? chapterXStart + chapterIdx * CHAPTER_SPACING_X
      : chapterXStart + i * CHAPTER_SPACING_X
    nodes.push({
      id: nodeId('foreshadow', f.id),
      type: 'foreshadow',
      position: resolvePos('foreshadow', f.id, { x, y: FORESHADOW_Y }),
      data: { entity: f },
    })
    if (targetChapterId) {
      edges.push({
        id: `e-fore-${f.id}-chap-${targetChapterId}`,
        source: nodeId('foreshadow', f.id),
        target: nodeId('chapter', targetChapterId),
        style: { stroke: 'var(--color-primary)', strokeWidth: 1.5, strokeDasharray: '2 4' },
        data: { auto: true },
      })
    }
  })

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
  project: { id: string } | null,
  chapters: Array<{ id: string; chapterNumber: number }>,
  characters: Array<{ id: string }>,
  conflicts: Array<{ id: string }>,
  foreshadows: Array<{ id: string }>,
  creationChapterNumber?: number,
): Set<string> {
  const ids = new Set<string>()
  if (phase === 'idle' || phase === 'completed' || phase === 'cancelled' || phase === 'error') {
    return ids
  }

  // directing / checkpoint_narrative：高亮项目节点
  if (phase === 'directing' || phase === 'checkpoint_narrative') {
    if (project) ids.add(nodeId('project', project.id))
  }

  // writing / reviewing / checkpoint_review：高亮目标章节节点
  if (phase === 'writing' || phase === 'reviewing' || phase === 'checkpoint_review' || phase === 'revising') {
    const targetChapter = creationChapterNumber != null
      ? chapters.find((c) => c.chapterNumber === creationChapterNumber)
      : chapters[chapters.length - 1]
    if (targetChapter) ids.add(nodeId('chapter', targetChapter.id))
  }

  // memory：高亮角色/冲突/伏笔节点（状态更新目标）
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
  /** 正在创作的章节编号 */
  creationChapterNumber?: number
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
  creationChapterNumber,
  creationError = null,
  onCancelCreation,
  onNodeCountChange,
  onDeleteNode,
}: NovelCanvasProps): ReactElement {
  const currentProjectId = useNovelStore((s) => s.currentProjectId)
  const projects = useNovelStore((s) => s.projects)
  const characters = useNovelStore((s) => s.characters)
  const chapters = useNovelStore((s) => s.chapters)
  const conflicts = useNovelStore((s) => s.conflicts)
  const foreshadows = useNovelStore((s) => s.foreshadows)
  const nodePositions = useNovelStore((s) => s.nodePositions)
  const selectedNodeId = useNovelStore((s) => s.selectedNodeId)
  const selectedNodeType = useNovelStore((s) => s.selectedNodeType)
  const selectNode = useNovelStore((s) => s.selectNode)
  const clearSelection = useNovelStore((s) => s.clearSelection)
  const upsertNodePosition = useNovelStore((s) => s.upsertNodePosition)
  const setNodePositions = useNovelStore((s) => s.setNodePositions)
  const removeNodePosition = useNovelStore((s) => s.removeNodePosition)
  const removeProject = useNovelStore((s) => s.removeProject)
  const removeCharacter = useNovelStore((s) => s.removeCharacter)
  const removeChapter = useNovelStore((s) => s.removeChapter)
  const removeConflict = useNovelStore((s) => s.removeConflict)
  const removeForeshadow = useNovelStore((s) => s.removeForeshadow)

  const { fitView } = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
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

  const project = useMemo(
    () => projects.find((p) => p.id === currentProjectId) ?? null,
    [projects, currentProjectId],
  )

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
      project,
      characters,
      chapters,
      conflicts,
      foreshadows,
      savedPositions: savedPositionsMap,
    }),
    [project, characters, chapters, conflicts, foreshadows, savedPositionsMap],
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
      project ? { id: project.id } : null,
      chapters,
      characters,
      conflicts,
      foreshadows,
      creationChapterNumber,
    ),
    [creationPhase, project, chapters, characters, conflicts, foreshadows, creationChapterNumber],
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
        case 'project':
          await deleteProject(targetId)
          removeProject(targetId)
          break
        case 'character':
          await deleteCharacter(targetId)
          removeCharacter(targetId)
          break
        case 'chapter':
          await deleteChapter(targetId)
          removeChapter(targetId)
          break
        case 'conflict':
          await deleteConflict(targetId)
          removeConflict(targetId)
          break
        case 'foreshadow':
          await deleteForeshadow(targetId)
          removeForeshadow(targetId)
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
  }, [removeProject, removeCharacter, removeChapter, removeConflict, removeForeshadow, removeNodePosition, clearSelection, onDeleteNode])

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
    const [nodeType, entityId] = node.id.split(':') as [NovelNodeTypeName, string]
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
  const handleConnect = useCallback((params: Connection) => {
    if (!params.source || !params.target) return
    const [sourceType] = params.source.split(':')
    const [targetType] = params.target.split(':')
    if (!isValidConnection(sourceType, targetType)) return
    setEdges((eds) => addEdge(
      {
        ...params,
        animated: false,
        style: { stroke: 'var(--color-primary)', strokeWidth: 1.5 },
        data: { auto: false },
      },
      eds,
    ))
  }, [setEdges])

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
          const [type, id] = n.id.split(':')
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
        const [type, id] = n.id.split(':')
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

  // 切换项目时重置首次布局标记
  useEffect(() => {
    isFirstLayout.current = true
  }, [currentProjectId])

  // 同步 store 选中状态 + 创作高亮到节点标记
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => {
        const [type, id] = n.id.split(':') as [NovelNodeType, string]
        const isSelected = id === selectedNodeId && type === selectedNodeType
        const isPulsing = pulsingIds.has(n.id)
        const nextSelected = n.selected === isSelected ? n.selected : isSelected
        const nextClassName = cn(
          isPulsing && 'novel-node-pulsing',
          isCompact && 'novel-node-compact',
        )
        if (n.selected === nextSelected && n.className === nextClassName) return n
        return { ...n, selected: nextSelected, className: nextClassName }
      }),
    )
  }, [selectedNodeId, selectedNodeType, setNodes, pulsingIds, isCompact])

  // ── 键盘删除：Delete / Backspace ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      // 输入框中不触发删除
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (!selectedNodeId || !selectedNodeType) return
      e.preventDefault()
      void handleDeleteNode(selectedNodeId, selectedNodeType)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedNodeId, selectedNodeType, handleDeleteNode])

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
      const [type, id] = node.id.split(':')
      // group 节点内部处理点击（展开/折叠），不参与选中
      if (type === 'group') return
      selectNode(id, type as NovelNodeType)
    },
    [selectNode],
  )

  const handlePaneClick = useCallback(() => {
    clearSelection()
  }, [clearSelection])

  return (
    <div className="relative h-full w-full bg-workspace-bg">
      {/* 节点脉冲动画样式 + 紧凑模式样式 */}
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
      `}</style>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        onNodeDragStop={handleNodeDragStop}
        onConnect={handleConnect}
        fitView
        minZoom={0.2}
        maxZoom={2}
        defaultEdgeOptions={{ animated: false }}
        proOptions={{ hideAttribution: true }}
        className="novel-canvas"
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} className="!text-muted-foreground/40" />
        <MiniMap
          pannable
          zoomable
          className="!bg-card !border !border-border"
          maskColor="rgba(0,0,0,0.05)"
          nodeColor={(n) => {
            const type = n.type
            if (type === 'project') return '#8b5cf6'
            if (type === 'character') return '#3b82f6'
            if (type === 'chapter') return '#10b981'
            if (type === 'conflict') return '#f43f5e'
            if (type === 'foreshadow') return '#f59e0b'
            if (type === 'group') return '#6366f1'
            return '#6b7280'
          }}
        />
        <Controls className="!bg-card !border !border-border !shadow-md" showInteractive={false} />
      </ReactFlow>

      {/* 节点计数 + 性能警告 */}
      <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-card/90 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur-sm">
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
