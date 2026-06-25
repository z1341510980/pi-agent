import { useCallback, useEffect, useMemo, useRef, type MouseEvent, type ReactElement } from 'react'
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
import { useNovelStore } from '@/stores/novel-store'
import type { NovelNodeType } from '@/stores/novel-store'
import { ProjectNode } from './nodes/ProjectNode'
import { CharacterNode } from './nodes/CharacterNode'
import { ChapterNode } from './nodes/ChapterNode'
import { ConflictNode } from './nodes/ConflictNode'
import { ForeshadowNode } from './nodes/ForeshadowNode'

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

  return { nodes, edges }
}

// ── 主组件 ──

export interface NovelCanvasProps {
  /** 布局模式：auto = 数据变化时自动重排；free = 保留拖拽位置 */
  layoutMode: 'auto' | 'free'
  /** 触发重新布局的信号（每次点击重排按钮自增） */
  relayoutSignal?: number
}

export function NovelCanvas({ layoutMode, relayoutSignal = 0 }: NovelCanvasProps): ReactElement {
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

  const project = useMemo(
    () => projects.find((p) => p.id === currentProjectId) ?? null,
    [projects, currentProjectId],
  )

  // 计算布局
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

  // 同步 store 选中状态到节点 selected 标记
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => {
        const [type, id] = n.id.split(':') as [NovelNodeType, string]
        const isSelected = id === selectedNodeId && type === selectedNodeType
        return n.selected === isSelected ? n : { ...n, selected: isSelected }
      }),
    )
  }, [selectedNodeId, selectedNodeType, setNodes])

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
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
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
    </div>
  )
}
