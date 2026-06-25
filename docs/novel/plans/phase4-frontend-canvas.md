# Phase 4：前端无限画布实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 使用 React Flow 构建小说创作无限画布，支持角色/伏笔/线索/冲突/章节节点可视化，关系连线，3 种布局算法，右侧栏模式切换（属性/对话/预览/检查点），画布位置持久化。

**架构：** 作为 App.tsx 的顶层视图（与 chat/settings 平级），新建 `components/novel/` 功能域目录。Zustand 管理状态，TanStack Query 获取 API 数据，React Flow 渲染画布。

**技术栈：** React Flow（@xyflow/react）、Zustand、TanStack Query、Tailwind CSS、Framer Motion

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `apps/desktop/src/renderer/src/stores/novel-store.ts` | 小说前端 Zustand store |
| `apps/desktop/src/renderer/src/api/novel-client.ts` | 小说 API 客户端 |
| `apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx` | 小说工作台主容器 |
| `apps/desktop/src/renderer/src/components/novel/novel-canvas.tsx` | React Flow 画布 |
| `apps/desktop/src/renderer/src/components/novel/nodes/character-node.tsx` | 角色节点 |
| `apps/desktop/src/renderer/src/components/novel/nodes/foreshadow-node.tsx` | 伏笔节点 |
| `apps/desktop/src/renderer/src/components/novel/nodes/conflict-node.tsx` | 冲突节点 |
| `apps/desktop/src/renderer/src/components/novel/nodes/clue-node.tsx` | 线索节点 |
| `apps/desktop/src/renderer/src/components/novel/nodes/chapter-node.tsx` | 章节节点 |
| `apps/desktop/src/renderer/src/components/novel/novel-sidebar.tsx` | 左侧栏（项目树+章节列表） |
| `apps/desktop/src/renderer/src/components/novel/novel-right-panel.tsx` | 右侧栏（属性/对话/预览/检查点） |
| `apps/desktop/src/renderer/src/components/novel/novel-toolbar.tsx` | 顶栏（项目切换+模式+布局） |
| `apps/desktop/src/renderer/src/components/novel/novel-status-bar.tsx` | 底栏（缓存命中率+Agent状态） |
| `apps/desktop/src/renderer/src/components/novel/novel-checkpoint.tsx` | 检查点确认面板 |

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `apps/desktop/src/renderer/src/App.tsx` | 添加 'novel' 视图类型和条件渲染 |
| `apps/desktop/src/renderer/src/stores/index.ts` | re-export novel-store |
| `apps/desktop/src/renderer/src/api/index.ts` | re-export novel-client |
| `apps/desktop/package.json` | 添加 @xyflow/react 依赖 |

---

## 任务 1：安装依赖和创建 API 客户端

**文件：**
- 修改：`apps/desktop/package.json`
- 创建：`apps/desktop/src/renderer/src/api/novel-client.ts`
- 修改：`apps/desktop/src/renderer/src/api/index.ts`

- [ ] **步骤 1：安装 @xyflow/react**

运行：
```bash
cd apps/desktop && npm install @xyflow/react
```

- [ ] **步骤 2：创建 novel-client.ts**

```typescript
import { getApi, postApi, putApi, deleteApi } from './http-client'

// ── 类型定义 ──

export interface NovelProject {
  id: string
  title: string
  genre: string
  synopsis: string
  targetWords: number
  currentVolume: number
  currentChapter: number
  currentStage: string
  status: string
  createdAt: number
  updatedAt: number
}

export interface NovelCharacter {
  id: string
  projectId: string
  name: string
  description: string
  identity: string
  personality: string
  appearance: string
  currentState: string
  currentGoal: string
  currentPressure: string
  secret: string
  arcStage: string
  arcHistory: string
  speechStyle: string
  createdAt: number
  updatedAt: number
}

export interface NovelChapter {
  id: string
  projectId: string
  volume: number
  chapterNumber: number
  title: string
  content: string
  wordCount: number
  status: string
  narrativeTask: string
  acceptanceResult: string | null
  createdAt: number
  updatedAt: number
}

export interface NovelRelationship {
  id: string
  projectId: string
  characterA: string
  characterB: string
  relationType: string
  currentStage: string
  stageHistory: string
  createdAt: number
  updatedAt: number
}

export interface NovelForeshadow {
  id: string
  projectId: string
  description: string
  category: string
  status: string
  firstChapter: number | null
  lastChapter: number | null
  recoverByChapter: number | null
  linkedCharacters: string
  linkedClues: string
  createdAt: number
  updatedAt: number
}

export interface NovelConflict {
  id: string
  projectId: string
  description: string
  type: string
  intensity: number
  stage: string
  participants: string
  createdAt: number
  updatedAt: number
}

export interface NovelClue {
  id: string
  projectId: string
  description: string
  pointsTo: string
  progress: number
  currentStep: string
  nextStep: string
  isMisleading: boolean
  linkedForeshadow: string | null
  createdAt: number
  updatedAt: number
}

// ── API 调用 ──

const BASE = '/api/plugins/novel'

export const novelApi = {
  // 项目
  listProjects: () => getApi<NovelProject[]>(`${BASE}/projects`),
  createProject: (data: { title: string; genre: string; synopsis?: string; targetWords?: number }) =>
    postApi<NovelProject>(`${BASE}/projects`, data),
  getProject: (id: string) => getApi<NovelProject>(`${BASE}/projects/${id}`),
  updateProject: (id: string, data: Partial<NovelProject>) => putApi<NovelProject>(`${BASE}/projects/${id}`, data),
  deleteProject: (id: string) => deleteApi(`${BASE}/projects/${id}`),

  // 章节
  listChapters: (projectId: string) => getApi<NovelChapter[]>(`${BASE}/projects/${projectId}/chapters`),
  createChapter: (projectId: string, data: { chapterNumber: number; title?: string }) =>
    postApi<NovelChapter>(`${BASE}/projects/${projectId}/chapters`, data),
  getChapter: (id: string) => getApi<NovelChapter>(`${BASE}/chapters/${id}`),

  // 角色
  listCharacters: (projectId: string) => getApi<NovelCharacter[]>(`${BASE}/projects/${projectId}/characters`),
  createCharacter: (projectId: string, data: Partial<NovelCharacter>) =>
    postApi<NovelCharacter>(`${BASE}/projects/${projectId}/characters`, data),
  updateCharacter: (id: string, data: Partial<NovelCharacter>) =>
    putApi<NovelCharacter>(`${BASE}/characters/${id}`, data),
  deleteCharacter: (id: string) => deleteApi(`${BASE}/characters/${id}`),

  // 关系
  listRelationships: (projectId: string) => getApi<NovelRelationship[]>(`${BASE}/projects/${projectId}/relationships`),
  createRelationship: (projectId: string, data: Partial<NovelRelationship>) =>
    postApi<NovelRelationship>(`${BASE}/projects/${projectId}/relationships`, data),

  // 伏笔
  listForeshadows: (projectId: string) => getApi<NovelForeshadow[]>(`${BASE}/projects/${projectId}/foreshadowing`),
  createForeshadow: (projectId: string, data: Partial<NovelForeshadow>) =>
    postApi<NovelForeshadow>(`${BASE}/projects/${projectId}/foreshadowing`, data),
  updateForeshadow: (id: string, data: Partial<NovelForeshadow>) =>
    putApi<NovelForeshadow>(`${BASE}/foreshadowing/${id}`, data),

  // 冲突
  listConflicts: (projectId: string) => getApi<NovelConflict[]>(`${BASE}/projects/${projectId}/conflicts`),
  createConflict: (projectId: string, data: Partial<NovelConflict>) =>
    postApi<NovelConflict>(`${BASE}/projects/${projectId}/conflicts`, data),
  updateConflict: (id: string, data: Partial<NovelConflict>) =>
    putApi<NovelConflict>(`${BASE}/conflicts/${id}`, data),

  // 线索
  listClues: (projectId: string) => getApi<NovelClue[]>(`${BASE}/projects/${projectId}/clues`),
  createClue: (projectId: string, data: Partial<NovelClue>) =>
    postApi<NovelClue>(`${BASE}/projects/${projectId}/clues`, data),
  updateClue: (id: string, data: Partial<NovelClue>) => putApi<NovelClue>(`${BASE}/clues/${id}`, data),

  // 创作流程（SSE）
  createChapterFlow: (projectId: string, chapterNumber: number) =>
    `${BASE}/projects/${projectId}/chapters/${chapterNumber}/create`,
  submitCheckpoint: (projectId: string, type: string, decision: string) =>
    postApi(`${BASE}/projects/${projectId}/checkpoint/${type}/decision`, { decision }),
}
```

- [ ] **步骤 3：更新 api/index.ts**

```typescript
export * from './novel-client'
```

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/package.json apps/desktop/src/renderer/src/api/novel-client.ts apps/desktop/src/renderer/src/api/index.ts
git commit -m "feat(novel): 安装 React Flow 并创建小说 API 客户端"
```

---

## 任务 2：创建小说 Zustand Store

**文件：**
- 创建：`apps/desktop/src/renderer/src/stores/novel-store.ts`
- 修改：`apps/desktop/src/renderer/src/stores/index.ts`

- [ ] **步骤 1：创建 novel-store.ts**

```typescript
import { create } from 'zustand'
import type {
  NovelProject,
  NovelCharacter,
  NovelChapter,
  NovelRelationship,
  NovelForeshadow,
  NovelConflict,
  NovelClue,
} from '@/api/novel-client'

// ── 画布节点类型 ──

export type EntityType = 'character' | 'foreshadow' | 'conflict' | 'clue' | 'chapter'

export interface CanvasNodeData {
  entityType: EntityType
  entityId: string
  label: string
  [key: string]: unknown
}

export interface CanvasEdgeData {
  relationType: string
  label?: string
}

// ── 右侧栏模式 ──

export type RightPanelMode = 'properties' | 'chat' | 'preview' | 'checkpoint'

// ── Agent 执行状态 ──

export type AgentPhase =
  | 'idle'
  | 'directing'
  | 'checkpoint_narrative'
  | 'writing'
  | 'reviewing'
  | 'checkpoint_review'
  | 'revising'
  | 'memory'
  | 'completed'
  | 'error'

export interface AgentExecutionState {
  phase: AgentPhase
  status: 'idle' | 'running' | 'paused' | 'completed' | 'error'
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string; timestamp: number }>
  checkpointData: unknown | null
}

// ── 布局模式 ──

export type CanvasLayout = 'force' | 'timeline' | 'group'

// ── Store 接口 ──

interface NovelState {
  // 项目
  currentProject: NovelProject | null
  projects: NovelProject[]

  // 画布
  selectedNodeId: string | null
  canvasLayout: CanvasLayout
  canvasPositions: Record<string, { x: number; y: number }>

  // 章节列表
  chapters: NovelChapter[]
  currentChapter: NovelChapter | null

  // 右侧栏
  rightPanelMode: RightPanelMode
  selectedEntity: { type: EntityType; id: string } | null

  // Agent 执行
  agentExecution: AgentExecutionState

  // Actions
  setCurrentProject: (project: NovelProject | null) => void
  setProjects: (projects: NovelProject[]) => void
  setSelectedNode: (id: string | null) => void
  setCanvasLayout: (layout: CanvasLayout) => void
  setCanvasPosition: (nodeId: string, x: number, y: number) => void
  setChapters: (chapters: NovelChapter[]) => void
  setCurrentChapter: (chapter: NovelChapter | null) => void
  setRightPanelMode: (mode: RightPanelMode) => void
  setSelectedEntity: (entity: { type: EntityType; id: string } | null) => void
  setAgentPhase: (phase: AgentPhase) => void
  addAgentMessage: (message: { role: 'user' | 'assistant' | 'system'; content: string }) => void
  setCheckpointData: (data: unknown | null) => void
  resetAgentExecution: () => void
}

const initialAgentExecution: AgentExecutionState = {
  phase: 'idle',
  status: 'idle',
  messages: [],
  checkpointData: null,
}

export const useNovelStore = create<NovelState>()((set) => ({
  currentProject: null,
  projects: [],

  selectedNodeId: null,
  canvasLayout: 'force',
  canvasPositions: {},

  chapters: [],
  currentChapter: null,

  rightPanelMode: 'properties',
  selectedEntity: null,

  agentExecution: initialAgentExecution,

  setCurrentProject: (project) => set({ currentProject: project }),
  setProjects: (projects) => set({ projects }),
  setSelectedNode: (id) => set({ selectedNodeId: id }),
  setCanvasLayout: (layout) => set({ canvasLayout: layout }),
  setCanvasPosition: (nodeId, x, y) =>
    set((state) => ({
      canvasPositions: { ...state.canvasPositions, [nodeId]: { x, y } },
    })),
  setChapters: (chapters) => set({ chapters }),
  setCurrentChapter: (chapter) => set({ currentChapter: chapter }),
  setRightPanelMode: (mode) => set({ rightPanelMode: mode }),
  setSelectedEntity: (entity) => set({ selectedEntity: entity }),
  setAgentPhase: (phase) =>
    set((state) => ({
      agentExecution: { ...state.agentExecution, phase, status: phase === 'idle' ? 'idle' : 'running' },
    })),
  addAgentMessage: (message) =>
    set((state) => ({
      agentExecution: {
        ...state.agentExecution,
        messages: [...state.agentExecution.messages, { ...message, timestamp: Date.now() }],
      },
    })),
  setCheckpointData: (data) =>
    set((state) => ({
      agentExecution: { ...state.agentExecution, checkpointData: data, status: 'paused' },
    })),
  resetAgentExecution: () => set({ agentExecution: initialAgentExecution }),
}))
```

- [ ] **步骤 2：更新 stores/index.ts**

```typescript
export * from './novel-store'
```

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/stores/novel-store.ts apps/desktop/src/renderer/src/stores/index.ts
git commit -m "feat(novel): 创建小说前端 Zustand store"
```

---

## 任务 3：创建画布节点组件

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/novel/nodes/character-node.tsx`
- 创建：`apps/desktop/src/renderer/src/components/novel/nodes/foreshadow-node.tsx`
- 创建：`apps/desktop/src/renderer/src/components/novel/nodes/conflict-node.tsx`
- 创建：`apps/desktop/src/renderer/src/components/novel/nodes/clue-node.tsx`
- 创建：`apps/desktop/src/renderer/src/components/novel/nodes/chapter-node.tsx`

- [ ] **步骤 1：创建角色节点**

```tsx
import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { cn } from '@/lib/utils'
import type { CanvasNodeData } from '@/stores/novel-store'

function CharacterNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as CanvasNodeData
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-1 rounded-full border-2 bg-surface-1 px-4 py-3 min-w-[100px]',
        selected ? 'border-primary shadow-lg' : 'border-border',
      )}
    >
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/20 text-lg font-bold">
        {nodeData.label?.[0] ?? '?'}
      </div>
      <span className="text-xs font-medium">{nodeData.label}</span>
      {nodeData.currentState && (
        <span className="text-[10px] text-text-muted">{nodeData.currentState}</span>
      )}
      <Handle type="source" position={Position.Bottom} className="opacity-0" />
      <Handle type="target" position={Position.Left} className="opacity-0" />
      <Handle type="source" position={Position.Right} className="opacity-0" />
    </div>
  )
}

export const CharacterNode = memo(CharacterNodeComponent)
```

- [ ] **步骤 2：创建伏笔节点**

```tsx
import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { cn } from '@/lib/utils'
import type { CanvasNodeData } from '@/stores/novel-store'

const STATUS_COLORS: Record<string, string> = {
  planned: 'bg-blue-500/20 border-blue-500',
  planted: 'bg-yellow-500/20 border-yellow-500',
  reinforced: 'bg-orange-500/20 border-orange-500',
  partially_revealed: 'bg-purple-500/20 border-purple-500',
  recovering: 'bg-cyan-500/20 border-cyan-500',
  recovered: 'bg-green-500/20 border-green-500',
  abandoned: 'bg-gray-500/20 border-gray-500',
}

function ForeshadowNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as CanvasNodeData
  const statusColor = STATUS_COLORS[nodeData.status as string] ?? 'bg-surface-1 border-border'

  return (
    <div
      className={cn(
        'flex flex-col items-center gap-1 rounded-lg border-2 px-3 py-2 min-w-[120px] rotate-45',
        statusColor,
        selected ? 'shadow-lg ring-2 ring-primary' : '',
      )}
    >
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <Handle type="source" position={Position.Bottom} className="opacity-0" />
      <div className="-rotate-45 flex flex-col items-center">
        <span className="text-xs font-medium">{nodeData.label}</span>
        <span className="text-[10px] text-text-muted">{nodeData.status}</span>
      </div>
    </div>
  )
}

export const ForeshadowNode = memo(ForeshadowNodeComponent)
```

- [ ] **步骤 3：创建冲突节点**

```tsx
import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { cn } from '@/lib/utils'
import type { CanvasNodeData } from '@/stores/novel-store'

function ConflictNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as CanvasNodeData
  const intensity = (nodeData.intensity as number) ?? 50
  const intensityColor = intensity > 70 ? 'bg-red-500/20 border-red-500' : intensity > 40 ? 'bg-orange-500/20 border-orange-500' : 'bg-yellow-500/20 border-yellow-500'

  return (
    <div
      className={cn(
        'flex flex-col items-center gap-1 border-2 px-3 py-2 min-w-[100px] bg-surface-1',
        'clip-path-polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
        intensityColor,
        selected ? 'shadow-lg ring-2 ring-primary' : '',
      )}
      style={{ clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)' }}
    >
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <Handle type="source" position={Position.Bottom} className="opacity-0" />
      <span className="text-xs font-medium">{nodeData.label}</span>
      <div className="h-1 w-full overflow-hidden rounded-full bg-border">
        <div className="h-full bg-red-500" style={{ width: `${intensity}%` }} />
      </div>
    </div>
  )
}

export const ConflictNode = memo(ConflictNodeComponent)
```

- [ ] **步骤 4：创建线索节点**

```tsx
import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { cn } from '@/lib/utils'
import type { CanvasNodeData } from '@/stores/novel-store'

function ClueNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as CanvasNodeData
  const progress = (nodeData.progress as number) ?? 0

  return (
    <div
      className={cn(
        'flex flex-col items-center gap-1 border-2 bg-surface-1 px-3 py-2 min-w-[100px]',
        'border-cyan-500/50',
        selected ? 'shadow-lg ring-2 ring-primary' : '',
      )}
      style={{ clipPath: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)' }}
    >
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <Handle type="source" position={Position.Bottom} className="opacity-0" />
      <span className="text-xs font-medium">{nodeData.label}</span>
      <span className="text-[10px] text-text-muted">{progress}%</span>
    </div>
  )
}

export const ClueNode = memo(ClueNodeComponent)
```

- [ ] **步骤 5：创建章节节点**

```tsx
import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { cn } from '@/lib/utils'
import type { CanvasNodeData } from '@/stores/novel-store'

const STATUS_COLORS: Record<string, string> = {
  planned: 'border-blue-500/50 bg-blue-500/10',
  draft: 'border-yellow-500/50 bg-yellow-500/10',
  review: 'border-orange-500/50 bg-orange-500/10',
  published: 'border-green-500/50 bg-green-500/10',
}

function ChapterNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as CanvasNodeData
  const statusColor = STATUS_COLORS[nodeData.status as string] ?? 'border-border bg-surface-1'

  return (
    <div
      className={cn(
        'flex flex-col items-start gap-1 border-2 rounded-lg px-3 py-2 min-w-[140px] max-w-[200px]',
        statusColor,
        selected ? 'shadow-lg ring-2 ring-primary' : '',
      )}
    >
      <Handle type="target" position={Position.Left} className="opacity-0" />
      <Handle type="source" position={Position.Right} className="opacity-0" />
      <span className="text-xs font-bold">第 {nodeData.chapterNumber} 章</span>
      <span className="text-xs text-text-muted truncate w-full">{nodeData.label}</span>
      <span className="text-[10px] text-text-muted">{nodeData.status}</span>
    </div>
  )
}

export const ChapterNode = memo(ChapterNodeComponent)
```

- [ ] **步骤 6：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/nodes/
git commit -m "feat(novel): 创建 5 种画布节点组件"
```

---

## 任务 4：创建画布主组件

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/novel/novel-canvas.tsx`

- [ ] **步骤 1：创建 NovelCanvas 组件**

```tsx
import { useMemo, useCallback } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeTypes,
  type Connection,
  type NodeMouseHandler,
  BackgroundVariant,
  ConnectionMode,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { CharacterNode } from './nodes/character-node'
import { ForeshadowNode } from './nodes/foreshadow-node'
import { ConflictNode } from './nodes/conflict-node'
import { ClueNode } from './nodes/clue-node'
import { ChapterNode } from './nodes/chapter-node'
import { useNovelStore } from '@/stores/novel-store'
import { novelApi } from '@/api/novel-client'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'

const nodeTypes: NodeTypes = {
  character: CharacterNode,
  foreshadow: ForeshadowNode,
  conflict: ConflictNode,
  clue: ClueNode,
  chapter: ChapterNode,
}

export function NovelCanvas(): React.ReactElement {
  const projectId = useNovelStore((s) => s.currentProject?.id)
  const canvasLayout = useNovelStore((s) => s.canvasLayout)
  const selectedNodeId = useNovelStore((s) => s.selectedNodeId)
  const setSelectedNode = useNovelStore((s) => s.setSelectedNode)
  const setSelectedEntity = useNovelStore((s) => s.setSelectedEntity)
  const setRightPanelMode = useNovelStore((s) => s.setRightPanelMode)
  const canvasPositions = useNovelStore((s) => s.canvasPositions)
  const setCanvasPosition = useNovelStore((s) => s.setCanvasPosition)

  // 获取数据
  const { data: characters } = useQuery({
    queryKey: ['novel-characters', projectId],
    queryFn: () => novelApi.listCharacters(projectId!),
    enabled: !!projectId,
  })

  const { data: chapters } = useQuery({
    queryKey: ['novel-chapters', projectId],
    queryFn: () => novelApi.listChapters(projectId!),
    enabled: !!projectId,
  })

  const { data: relationships } = useQuery({
    queryKey: ['novel-relationships', projectId],
    queryFn: () => novelApi.listRelationships(projectId!),
    enabled: !!projectId,
  })

  const { data: foreshadows } = useQuery({
    queryKey: ['novel-foreshadows', projectId],
    queryFn: () => novelApi.listForeshadows(projectId!),
    enabled: !!projectId,
  })

  const { data: conflicts } = useQuery({
    queryKey: ['novel-conflicts', projectId],
    queryFn: () => novelApi.listConflicts(projectId!),
    enabled: !!projectId,
  })

  const { data: clues } = useQuery({
    queryKey: ['novel-clues', projectId],
    queryFn: () => novelApi.listClues(projectId!),
    enabled: !!projectId,
  })

  // 构建节点
  const nodes: Node[] = useMemo(() => {
    if (!projectId) return []
    const result: Node[] = []

    // 角色节点
    characters?.forEach((c, i) => {
      const pos = canvasPositions[c.id] ?? { x: 100 + i * 120, y: 100 }
      result.push({
        id: c.id,
        type: 'character',
        position: pos,
        data: {
          entityType: 'character',
          entityId: c.id,
          label: c.name,
          currentState: c.currentState,
        },
      })
    })

    // 章节节点
    chapters?.forEach((c, i) => {
      const pos = canvasPositions[c.id] ?? { x: 100 + i * 160, y: 300 }
      result.push({
        id: c.id,
        type: 'chapter',
        position: pos,
        data: {
          entityType: 'chapter',
          entityId: c.id,
          label: c.title || `第${c.chapterNumber}章`,
          chapterNumber: c.chapterNumber,
          status: c.status,
        },
      })
    })

    // 伏笔节点
    foreshadows?.forEach((f, i) => {
      const pos = canvasPositions[f.id] ?? { x: 100 + i * 120, y: 500 }
      result.push({
        id: f.id,
        type: 'foreshadow',
        position: pos,
        data: {
          entityType: 'foreshadow',
          entityId: f.id,
          label: f.description.slice(0, 20),
          status: f.status,
        },
      })
    })

    // 冲突节点
    conflicts?.forEach((c, i) => {
      const pos = canvasPositions[c.id] ?? { x: 400 + i * 120, y: 500 }
      result.push({
        id: c.id,
        type: 'conflict',
        position: pos,
        data: {
          entityType: 'conflict',
          entityId: c.id,
          label: c.description.slice(0, 20),
          intensity: c.intensity,
        },
      })
    })

    // 线索节点
    clues?.forEach((c, i) => {
      const pos = canvasPositions[c.id] ?? { x: 700 + i * 120, y: 500 }
      result.push({
        id: c.id,
        type: 'clue',
        position: pos,
        data: {
          entityType: 'clue',
          entityId: c.id,
          label: c.description.slice(0, 20),
          progress: c.progress,
        },
      })
    })

    return result
  }, [projectId, characters, chapters, foreshadows, conflicts, clues, canvasPositions])

  // 构建边
  const edges: Edge[] = useMemo(() => {
    if (!relationships) return []
    return relationships.map((r) => ({
      id: r.id,
      source: r.characterA,
      target: r.characterB,
      label: r.relationType,
      type: 'default',
      animated: r.currentStage !== 'resolved',
    }))
  }, [relationships])

  // 节点点击
  const onNodeClick: NodeMouseHandler = useCallback((_, node) => {
    setSelectedNode(node.id)
    setSelectedEntity({
      type: (node.data as { entityType: string }).entityType as any,
      id: node.id,
    })
    setRightPanelMode('properties')
  }, [setSelectedNode, setSelectedEntity, setRightPanelMode])

  // 节点拖拽结束（保存位置）
  const onNodeDragStop: NodeMouseHandler = useCallback((_, node) => {
    setCanvasPosition(node.id, node.position.x, node.position.y)
  }, [setCanvasPosition])

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onNodeDragStop={onNodeDragStop}
        connectionMode={ConnectionMode.Loose}
        fitView
        minZoom={0.25}
        maxZoom={4}
        defaultEdgeOptions={{
          style: { stroke: 'var(--color-border)', strokeWidth: 2 },
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls position="bottom-right" />
        <MiniMap
          position="bottom-left"
          className="bg-surface-1"
          nodeColor={(node) => {
            switch (node.type) {
              case 'character': return '#8b5cf6'
              case 'chapter': return '#3b82f6'
              case 'foreshadow': return '#eab308'
              case 'conflict': return '#ef4444'
              case 'clue': return '#06b6d4'
              default: return '#6b7280'
            }
          }}
        />
      </ReactFlow>
    </div>
  )
}
```

- [ ] **步骤 2：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/novel-canvas.tsx
git commit -m "feat(novel): 创建 React Flow 画布主组件"
```

---

## 任务 5：创建侧边栏、右侧栏和工具栏

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/novel/novel-sidebar.tsx`
- 创建：`apps/desktop/src/renderer/src/components/novel/novel-right-panel.tsx`
- 创建：`apps/desktop/src/renderer/src/components/novel/novel-toolbar.tsx`
- 创建：`apps/desktop/src/renderer/src/components/novel/novel-status-bar.tsx`
- 创建：`apps/desktop/src/renderer/src/components/novel/novel-checkpoint.tsx`

- [ ] **步骤 1：创建侧边栏**

```tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { novelApi } from '@/api/novel-client'
import { useNovelStore } from '@/stores/novel-store'
import { cn } from '@/lib/utils'

export function NovelSidebar(): React.ReactElement {
  const queryClient = useQueryClient()
  const currentProject = useNovelStore((s) => s.currentProject)
  const setCurrentProject = useNovelStore((s) => s.setCurrentProject)
  const setCurrentChapter = useNovelStore((s) => s.setCurrentChapter)

  const { data: projects } = useQuery({
    queryKey: ['novel-projects'],
    queryFn: novelApi.listProjects,
  })

  const { data: chapters } = useQuery({
    queryKey: ['novel-chapters', currentProject?.id],
    queryFn: () => novelApi.listChapters(currentProject!.id),
    enabled: !!currentProject,
  })

  const createProject = useMutation({
    mutationFn: () => novelApi.createProject({ title: '新小说', genre: '奇幻' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['novel-projects'] }),
  })

  return (
    <div className="flex h-full w-[240px] flex-col border-r border-border bg-surface-1">
      {/* 项目列表 */}
      <div className="border-b border-border p-2">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold text-text-muted">项目</span>
          <button
            onClick={() => createProject.mutate()}
            className="text-xs text-primary hover:underline"
          >
            + 新建
          </button>
        </div>
        <div className="flex flex-col gap-1">
          {projects?.map((p) => (
            <button
              key={p.id}
              onClick={() => setCurrentProject(p)}
              className={cn(
                'rounded px-2 py-1 text-left text-xs',
                currentProject?.id === p.id ? 'bg-primary/20 text-primary' : 'hover:bg-surface-2',
              )}
            >
              {p.title}
            </button>
          ))}
        </div>
      </div>

      {/* 章节列表 */}
      <div className="flex-1 overflow-auto p-2">
        <span className="mb-2 block text-xs font-semibold text-text-muted">章节</span>
        <div className="flex flex-col gap-1">
          {chapters?.map((c) => (
            <button
              key={c.id}
              onClick={() => setCurrentChapter(c)}
              className="rounded px-2 py-1 text-left text-xs hover:bg-surface-2"
            >
              第{c.chapterNumber}章 {c.title}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **步骤 2：创建右侧栏**

```tsx
import { useNovelStore } from '@/stores/novel-store'
import { novelApi } from '@/api/novel-client'
import { useQuery } from '@tanstack/react-query'
import { NovelCheckpoint } from './novel-checkpoint'
import { cn } from '@/lib/utils'

export function NovelRightPanel(): React.ReactElement {
  const selectedEntity = useNovelStore((s) => s.selectedEntity)
  const rightPanelMode = useNovelStore((s) => s.rightPanelMode)
  const currentChapter = useNovelStore((s) => s.currentChapter)
  const agentExecution = useNovelStore((s) => s.agentExecution)

  // 获取选中实体详情
  const { data: entityDetail } = useQuery({
    queryKey: ['novel-entity', selectedEntity?.type, selectedEntity?.id],
    queryFn: async () => {
      if (!selectedEntity) return null
      switch (selectedEntity.type) {
        case 'character':
          return novelApi.getChapter(selectedEntity.id)
        default:
          return null
      }
    },
    enabled: !!selectedEntity && selectedEntity.type === 'chapter',
  })

  return (
    <div className="flex h-full w-[320px] flex-col border-l border-border bg-surface-1">
      {/* 模式标签 */}
      <div className="flex border-b border-border">
        {(['properties', 'chat', 'preview', 'checkpoint'] as const).map((mode) => (
          <button
            key={mode}
            className={cn(
              'flex-1 px-2 py-1.5 text-xs',
              rightPanelMode === mode ? 'border-b-2 border-primary text-primary' : 'text-text-muted',
            )}
          >
            {mode === 'properties' ? '属性' : mode === 'chat' ? '对话' : mode === 'preview' ? '预览' : '检查点'}
          </button>
        ))}
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-auto p-3">
        {rightPanelMode === 'properties' && selectedEntity && (
          <div>
            <p className="text-xs text-text-muted">类型: {selectedEntity.type}</p>
            <p className="text-xs text-text-muted">ID: {selectedEntity.id}</p>
            {/* TODO: 根据 entity type 加载对应编辑表单 */}
          </div>
        )}

        {rightPanelMode === 'chat' && (
          <div className="flex flex-col gap-2">
            {agentExecution.messages.map((msg, i) => (
              <div key={i} className={cn('rounded p-2 text-xs', msg.role === 'user' ? 'bg-primary/10' : 'bg-surface-2')}>
                <p className="mb-1 text-[10px] text-text-muted">{msg.role}</p>
                <p>{msg.content}</p>
              </div>
            ))}
            {agentExecution.messages.length === 0 && (
              <p className="text-xs text-text-muted">点击"创作"按钮开始章节创作</p>
            )}
          </div>
        )}

        {rightPanelMode === 'preview' && currentChapter && (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <h3>第{currentChapter.chapterNumber}章 {currentChapter.title}</h3>
            <div className="whitespace-pre-wrap text-sm">{currentChapter.content}</div>
          </div>
        )}

        {rightPanelMode === 'checkpoint' && <NovelCheckpoint />}
      </div>
    </div>
  )
}
```

- [ ] **步骤 3：创建工具栏**

```tsx
import { useNovelStore } from '@/stores/novel-store'
import { novelApi } from '@/api/novel-client'
import { cn } from '@/lib/utils'

export function NovelToolbar(): React.ReactElement {
  const currentProject = useNovelStore((s) => s.currentProject)
  const canvasLayout = useNovelStore((s) => s.canvasLayout)
  const setCanvasLayout = useNovelStore((s) => s.setCanvasLayout)
  const setRightPanelMode = useNovelStore((s) => s.setRightPanelMode)
  const setAgentPhase = useNovelStore((s) => s.setAgentPhase)
  const chapters = useNovelStore((s) => s.chapters)

  const nextChapter = (chapters.length ?? 0) + 1

  const handleCreateChapter = () => {
    if (!currentProject) return
    setRightPanelMode('chat')
    setAgentPhase('directing')
    // 实际通过 SSE 调用创作流程 API
    const url = novelApi.createChapterFlow(currentProject.id, nextChapter)
    const eventSource = new EventSource(url)
    eventSource.onmessage = (e) => {
      const event = JSON.parse(e.data)
      if (event.type === 'checkpoint') {
        useNovelStore.getState().setCheckpointData(event.data)
        setRightPanelMode('checkpoint')
      }
    }
  }

  return (
    <div className="flex h-12 items-center gap-4 border-b border-border bg-surface-1 px-4">
      <span className="text-sm font-semibold">
        {currentProject?.title ?? '未选择项目'}
      </span>

      <div className="flex items-center gap-2">
        <span className="text-xs text-text-muted">布局:</span>
        {(['force', 'timeline', 'group'] as const).map((layout) => (
          <button
            key={layout}
            onClick={() => setCanvasLayout(layout)}
            className={cn(
              'rounded px-2 py-0.5 text-xs',
              canvasLayout === layout ? 'bg-primary/20 text-primary' : 'hover:bg-surface-2',
            )}
          >
            {layout === 'force' ? '力导向' : layout === 'timeline' ? '时间线' : '分组'}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      <button
        onClick={handleCreateChapter}
        disabled={!currentProject}
        className="rounded bg-primary px-4 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        创作第 {nextChapter} 章
      </button>
    </div>
  )
}
```

- [ ] **步骤 4：创建状态栏**

```tsx
import { useNovelStore } from '@/stores/novel-store'

export function NovelStatusBar(): React.ReactElement {
  const agentExecution = useNovelStore((s) => s.agentExecution)

  const phaseLabel: Record<string, string> = {
    idle: '空闲',
    directing: '导演规划中...',
    checkpoint_narrative: '等待确认叙事任务',
    writing: '写作中...',
    reviewing: '审稿中...',
    checkpoint_review: '等待确认验收报告',
    revising: '修订中...',
    memory: '状态更新中...',
    completed: '完成',
    error: '错误',
  }

  return (
    <div className="flex h-6 items-center gap-4 border-t border-border bg-surface-1 px-4 text-[10px] text-text-muted">
      <span>小说工作台</span>
      <span>•</span>
      <span>{phaseLabel[agentExecution.phase] ?? agentExecution.phase}</span>
      <div className="flex-1" />
      <span>缓存命中率: --</span>
      <span>•</span>
      <span>Token: --</span>
    </div>
  )
}
```

- [ ] **步骤 5：创建检查点面板**

```tsx
import { useNovelStore } from '@/stores/novel-store'
import { novelApi } from '@/api/novel-client'
import { cn } from '@/lib/utils'

export function NovelCheckpoint(): React.ReactElement {
  const agentExecution = useNovelStore((s) => s.agentExecution)
  const currentProject = useNovelStore((s) => s.currentProject)
  const setRightPanelMode = useNovelStore((s) => s.setRightPanelMode)
  const setAgentPhase = useNovelStore((s) => s.setAgentPhase)
  const resetAgentExecution = useNovelStore((s) => s.resetAgentExecution)

  const checkpoint = agentExecution.checkpointData as { type?: string; data?: unknown } | null

  const handleDecision = async (decision: 'approve' | 'reject' | 'revise' | 'rewrite') => {
    if (!currentProject || !checkpoint?.type) return
    await novelApi.submitCheckpoint(currentProject.id, checkpoint.type, decision)
    setRightPanelMode('chat')
    if (decision === 'reject') {
      resetAgentExecution()
    } else {
      setAgentPhase(decision === 'approve' ? 'writing' : decision === 'revise' ? 'revising' : 'writing')
    }
  }

  if (!checkpoint) {
    return <p className="text-xs text-text-muted">暂无检查点</p>
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">
        {checkpoint.type === 'narrative_task' ? '叙事任务确认' : '验收报告确认'}
      </h3>
      <pre className="whitespace-pre-wrap rounded bg-surface-2 p-2 text-xs">
        {JSON.stringify(checkpoint.data, null, 2)}
      </pre>
      <div className="flex gap-2">
        {checkpoint.type === 'narrative_task' ? (
          <>
            <button
              onClick={() => handleDecision('approve')}
              className="flex-1 rounded bg-primary px-3 py-1 text-xs text-primary-foreground"
            >
              确认开始
            </button>
            <button
              onClick={() => handleDecision('reject')}
              className="flex-1 rounded border border-border px-3 py-1 text-xs"
            >
              取消
            </button>
          </>
        ) : (
          <>
            <button onClick={() => handleDecision('approve')} className="flex-1 rounded bg-green-500/20 px-3 py-1 text-xs">通过</button>
            <button onClick={() => handleDecision('revise')} className="flex-1 rounded bg-yellow-500/20 px-3 py-1 text-xs">修订</button>
            <button onClick={() => handleDecision('rewrite')} className="flex-1 rounded bg-red-500/20 px-3 py-1 text-xs">重写</button>
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **步骤 6：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/novel-sidebar.tsx apps/desktop/src/renderer/src/components/novel/novel-right-panel.tsx apps/desktop/src/renderer/src/components/novel/novel-toolbar.tsx apps/desktop/src/renderer/src/components/novel/novel-status-bar.tsx apps/desktop/src/renderer/src/components/novel/novel-checkpoint.tsx
git commit -m "feat(novel): 创建侧边栏、右侧栏、工具栏、状态栏和检查点面板"
```

---

## 任务 6：创建工作台主容器并集成到 App.tsx

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx`
- 修改：`apps/desktop/src/renderer/src/App.tsx`

- [ ] **步骤 1：创建 NovelWorkspace 主容器**

```tsx
import { NovelSidebar } from './novel-sidebar'
import { NovelCanvas } from './novel-canvas'
import { NovelRightPanel } from './novel-right-panel'
import { NovelToolbar } from './novel-toolbar'
import { NovelStatusBar } from './novel-status-bar'

interface NovelWorkspaceProps {
  onClose: () => void
}

export function NovelWorkspace({ onClose }: NovelWorkspaceProps): React.ReactElement {
  return (
    <div className="grid h-screen grid-rows-[auto_1fr_auto]">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 border-b border-border bg-surface-1 px-4">
        <button onClick={onClose} className="text-xs text-text-muted hover:text-text">
          ← 返回对话
        </button>
        <span className="text-sm font-semibold">小说工作台</span>
      </div>

      {/* 主体三栏 */}
      <div className="flex min-h-0">
        <NovelSidebar />
        <div className="flex flex-1 flex-col">
          <NovelToolbar />
          <div className="flex-1 min-h-0">
            <NovelCanvas />
          </div>
        </div>
        <NovelRightPanel />
      </div>

      {/* 底栏 */}
      <NovelStatusBar />
    </div>
  )
}
```

- [ ] **步骤 2：修改 App.tsx 添加 novel 视图**

```tsx
type AppView = 'chat' | 'settings' | 'novel'

// 在条件渲染中添加
{view === 'settings' ? (
  <SettingsPage onClose={() => setView('chat')} />
) : view === 'novel' ? (
  <NovelWorkspace onClose={() => setView('chat')} />
) : (
  <ChatWorkspace
    onOpenSettings={() => setView('settings')}
    onOpenNovel={() => setView('novel')}
    ...
  />
)}
```

在 `ChatWorkspace` 的 header 或 sidebar 添加入口按钮：

```tsx
// 在 SessionList 底部添加
<button onClick={onOpenNovel} className="...">
  小说工作台
</button>
```

- [ ] **步骤 3：验证编译**

运行：`cd apps/desktop && npx tsc --noEmit`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx apps/desktop/src/renderer/src/App.tsx
git commit -m "feat(novel): 创建工作台主容器并集成到 App.tsx"
```

---

## 任务 7：端到端验证

- [ ] **步骤 1：启动前端开发服务器**

运行：`cd apps/desktop && npm run dev`
预期：前端正常启动

- [ ] **步骤 2：验证视图切换**

- 打开应用，默认显示对话视图
- 点击侧边栏底部的"小说工作台"按钮
- 验证切换到小说工作台视图
- 点击"← 返回对话"返回对话视图

- [ ] **步骤 3：验证画布交互**

- 创建项目后，画布显示空状态
- 创建角色后，角色节点出现在画布上
- 创建关系后，关系连线出现
- 点击节点，右侧栏切换到属性面板
- 拖拽节点，位置更新
- 缩放和平移正常

- [ ] **步骤 4：Commit**

```bash
git add -A
git commit -m "test(novel): 前端无限画布端到端验证"
```

---

## 自检

### 规格覆盖度

| 规格需求 | 对应任务 |
|----------|----------|
| 安装 React Flow + 依赖 | 任务 1 |
| 创建 novel-store（Zustand） | 任务 2 |
| 画布主界面 + 自定义节点 | 任务 3 + 任务 4 |
| 关系连线 + 布局算法 | 任务 4（边构建 + 布局切换） |
| 右侧栏模式切换 | 任务 5 |
| 画布位置持久化 | 任务 4（onNodeDragStop） |
| 验证画布交互 + 数据同步 | 任务 7 |

### 类型一致性

- `CanvasNodeData` 在任务 2 定义，在任务 3/4 使用
- `RightPanelMode` 在任务 2 定义，在任务 5 使用
- `AgentExecutionState` 在任务 2 定义，在任务 5 使用
- `novelApi` 在任务 1 定义，在任务 4/5 使用
