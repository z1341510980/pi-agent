import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AlertTriangle, Layers } from 'lucide-react'
import { useNovelStore } from '@/stores/novel-store'
import type { NovelNodeType } from '@/stores/novel-store'
import { ProjectNode } from './nodes/ProjectNode'
import { CharacterNode } from './nodes/CharacterNode'
import { ChapterNode } from './nodes/ChapterNode'
import { ConflictNode } from './nodes/ConflictNode'
import { ForeshadowNode } from './nodes/ForeshadowNode'
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
}): LayoutResult {
  const { project, characters, chapters, conflicts, foreshadows } = params
  const nodes: Node[] = []
  const edges: Edge[] = []

  // 项目节点（中心）
  if (project) {
    nodes.push({
      id: nodeId('project', project.id),
      type: 'project',
      position: PROJECT_POS,
      data: { entity: project },
    })
  }

  // 角色节点（左侧竖向排列）
  const charYStart = -((characters.length - 1) * NODE_SPACING_Y) / 2
  characters.forEach((c, i) => {
    nodes.push({
      id: nodeId('character', c.id),
      type: 'character',
      position: { x: CHAR_X, y: charYStart + i * NODE_SPACING_Y },
      data: { entity: c },
    })
    if (project) {
      edges.push({
        id: `e-char-${c.id}-proj`,
        source: nodeId('character', c.id),
        target: nodeId('project', project.id),
        style: { stroke: 'var(--color-primary)', strokeWidth: 1.5 },
      })
    }
  })

  // 章节节点（下方横向序列）
  const chapterXStart = -((chapters.length - 1) * CHAPTER_SPACING_X) / 2
  const chapterByNumber = new Map<number, string>()
  chapters.forEach((ch, i) => {
    const x = chapterXStart + i * CHAPTER_SPACING_X
    nodes.push({
      id: nodeId('chapter', ch.id),
      type: 'chapter',
      position: { x, y: CHAPTER_Y },
      data: { entity: ch },
    })
    chapterByNumber.set(ch.chapterNumber, ch.id)
    if (project) {
      edges.push({
        id: `e-chap-${ch.id}-proj`,
        source: nodeId('chapter', ch.id),
        target: nodeId('project', project.id),
        style: { stroke: 'var(--color-success)', strokeWidth: 1.5 },
      })
    }
  })

  // 冲突节点（连接到参与角色）
  conflicts.forEach((cf, i) => {
    const participants = parseParticipants(cf.participants)
    const firstParticipant = participants[0]
    const charIdx = firstParticipant ? characters.findIndex((c) => c.id === firstParticipant) : -1
    const baseY = charIdx >= 0 ? -((characters.length - 1) * NODE_SPACING_Y) / 2 + charIdx * NODE_SPACING_Y : i * NODE_SPACING_Y
    nodes.push({
      id: nodeId('conflict', cf.id),
      type: 'conflict',
      position: { x: CHAR_X + CONFLICT_X_OFFSET, y: baseY + 60 },
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
        })
      }
    })
  })

  // 伏笔节点（连接到相关章节）
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
      position: { x, y: FORESHADOW_Y },
      data: { entity: f },
    })
    if (targetChapterId) {
      edges.push({
        id: `e-fore-${f.id}-chap-${targetChapterId}`,
        source: nodeId('foreshadow', f.id),
        target: nodeId('chapter', targetChapterId),
        style: { stroke: 'var(--color-primary)', strokeWidth: 1.5, strokeDasharray: '2 4' },
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
  /** 布局模式：auto = 数据变化时自动重排；free = 保留拖拽位置 */
  layoutMode: 'auto' | 'free'
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
}

export function NovelCanvas({
  layoutMode,
  relayoutSignal = 0,
  creationPhase = 'idle',
  creationRunning = false,
  creationChapterNumber,
  creationError = null,
  onCancelCreation,
  onNodeCountChange,
}: NovelCanvasProps): ReactElement {
  const currentProjectId = useNovelStore((s) => s.currentProjectId)
  const projects = useNovelStore((s) => s.projects)
  const characters = useNovelStore((s) => s.characters)
  const chapters = useNovelStore((s) => s.chapters)
  const conflicts = useNovelStore((s) => s.conflicts)
  const foreshadows = useNovelStore((s) => s.foreshadows)
  const selectedNodeId = useNovelStore((s) => s.selectedNodeId)
  const selectedNodeType = useNovelStore((s) => s.selectedNodeType)
  const selectNode = useNovelStore((s) => s.selectNode)
  const clearSelection = useNovelStore((s) => s.clearSelection)

  const { fitView } = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const isFirstLayout = useRef(true)
  /** 节点位置更新防抖定时器 */
  const positionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showPerfWarning, setShowPerfWarning] = useState(false)

  const project = useMemo(
    () => projects.find((p) => p.id === currentProjectId) ?? null,
    [projects, currentProjectId],
  )

  // 计算布局（memoized）
  const layout = useMemo(
    () => buildLayout({
      project,
      characters,
      chapters,
      conflicts,
      foreshadows,
    }),
    [project, characters, chapters, conflicts, foreshadows],
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

  // 同步布局到 nodes/edges
  // - auto 模式：数据变化或 relayoutSignal 变化时重排
  // - free 模式：仅首次或切换项目时重排，否则保留用户拖拽位置
  useEffect(() => {
    setNodes((prev) => {
      // 保留已存在节点的拖拽位置（free 模式）
      if (layoutMode === 'free' && !isFirstLayout.current) {
        const posMap = new Map(prev.map((n) => [n.id, n.position]))
        return layout.nodes.map((n) => ({
          ...n,
          position: posMap.get(n.id) ?? n.position,
        }))
      }
      return layout.nodes
    })
    setEdges(layout.edges)
  }, [layout, layoutMode, setNodes, setEdges, currentProjectId, relayoutSignal])

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

  // 节点位置更新防抖：拖拽时延迟同步，避免高频渲染
  const debouncedOnNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      onNodesChange(changes)
      if (positionDebounceRef.current) clearTimeout(positionDebounceRef.current)
      // 防抖仅用于触发后续副作用（如持久化），实际位置已由 onNodesChange 即时更新
      positionDebounceRef.current = setTimeout(() => {
        positionDebounceRef.current = null
      }, 300)
    },
    [onNodesChange],
  )

  const handleNodeClick = useCallback(
    (_evt: MouseEvent, node: Node) => {
      const [type, id] = node.id.split(':') as [NovelNodeType, string]
      selectNode(id, type)
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
        onNodesChange={debouncedOnNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
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
          onlyRenderVisibleElements
          className="!bg-card !border !border-border"
          maskColor="rgba(0,0,0,0.05)"
          nodeColor={(n) => {
            const type = n.type
            if (type === 'project') return '#8b5cf6'
            if (type === 'character') return '#3b82f6'
            if (type === 'chapter') return '#10b981'
            if (type === 'conflict') return '#f43f5e'
            if (type === 'foreshadow') return '#f59e0b'
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
