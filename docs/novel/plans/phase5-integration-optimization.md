# Phase 5：集成与优化实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将多 Agent 创作流程的执行进度可视化到画布上，章节正文实时渲染，缓存命中率监控面板，大项目性能优化（节点数 > 100），端到端测试。

**架构：** 前端通过 SSE 接收创作流程事件，实时更新画布节点状态和右侧栏内容。后端 NovelOrchestrator 推送 phase_change/agent_event/checkpoint 事件。性能优化通过 React Flow 的节点虚拟化和分页加载。

**技术栈：** React Flow、Zustand、SSE、TanStack Query

---

## 文件结构

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `apps/desktop/src/renderer/src/components/novel/novel-canvas.tsx` | 添加 Agent 执行进度可视化 + 性能优化 |
| `apps/desktop/src/renderer/src/components/novel/novel-toolbar.tsx` | 完善 SSE 创作流程连接 |
| `apps/desktop/src/renderer/src/components/novel/novel-right-panel.tsx` | 章节正文实时渲染 |
| `apps/desktop/src/renderer/src/components/novel/novel-status-bar.tsx` | 缓存命中率显示 |
| `apps/desktop/src/renderer/src/components/novel/nodes/character-node.tsx` | 添加执行状态高亮 |
| `apps/desktop/src/renderer/src/api/novel-client.ts` | 添加画布位置持久化 API |

### 新建文件

| 文件 | 职责 |
|------|------|
| `apps/desktop/src/renderer/src/hooks/use-novel-creation-flow.ts` | 创作流程 SSE hook |
| `apps/desktop/src/renderer/src/components/novel/novel-cache-monitor.tsx` | 缓存命中率监控面板 |

---

## 任务 1：创建创作流程 SSE Hook

**文件：**
- 创建：`apps/desktop/src/renderer/src/hooks/use-novel-creation-flow.ts`

- [ ] **步骤 1：创建 useNovelCreationFlow hook**

```typescript
import { useCallback, useRef, useState } from 'react'
import { useNovelStore } from '@/stores/novel-store'
import { novelApi } from '@/api/novel-client'
import type { CreationFlowEvent } from '@/api/novel-client'

interface UseNovelCreationFlowResult {
  startCreation: (projectId: string, chapterNumber: number) => void
  submitCheckpoint: (type: string, decision: string) => Promise<void>
  isRunning: boolean
  error: string | null
}

export function useNovelCreationFlow(): UseNovelCreationFlowResult {
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)

  const setAgentPhase = useNovelStore((s) => s.setAgentPhase)
  const addAgentMessage = useNovelStore((s) => s.addAgentMessage)
  const setCheckpointData = useNovelStore((s) => s.setCheckpointData)
  const setRightPanelMode = useNovelStore((s) => s.setRightPanelMode)
  const resetAgentExecution = useNovelStore((s) => s.resetAgentExecution)
  const currentProject = useNovelStore((s) => s.currentProject)

  const startCreation = useCallback((projectId: string, chapterNumber: number) => {
    setIsRunning(true)
    setError(null)
    resetAgentExecution()
    setRightPanelMode('chat')

    const url = novelApi.createChapterFlow(projectId, chapterNumber)
    const eventSource = new EventSource(url)
    eventSourceRef.current = eventSource

    eventSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as { type: string; data: CreationFlowEvent | unknown }

        switch (event.type) {
          case 'progress': {
            const flowEvent = event.data as CreationFlowEvent
            setAgentPhase(flowEvent.phase)

            // 如果是 agent_event，添加消息
            if (flowEvent.type === 'agent_event' && flowEvent.data) {
              const agentData = flowEvent.data as { content?: string }
              if (agentData.content) {
                addAgentMessage({ role: 'assistant', content: agentData.content })
              }
            }
            break
          }
          case 'checkpoint': {
            setCheckpointData(event.data)
            setRightPanelMode('checkpoint')
            break
          }
          case 'result': {
            const result = event.data as { status: string; chapterId?: string; content?: string }
            if (result.status === 'completed' && result.content) {
              addAgentMessage({ role: 'system', content: `章节创作完成: ${result.chapterId}` })
            }
            setIsRunning(false)
            eventSource.close()
            break
          }
          case 'error': {
            const errData = event.data as { error: string }
            setError(errData.error)
            setIsRunning(false)
            eventSource.close()
            break
          }
        }
      } catch {
        // 忽略解析错误
      }
    }

    eventSource.onerror = () => {
      setError('SSE 连接断开')
      setIsRunning(false)
      eventSource.close()
    }
  }, [setAgentPhase, addAgentMessage, setCheckpointData, setRightPanelMode, resetAgentExecution])

  const submitCheckpoint = useCallback(async (type: string, decision: string) => {
    if (!currentProject) return
    await novelApi.submitCheckpoint(currentProject.id, type, decision)
    setRightPanelMode('chat')
  }, [currentProject, setRightPanelMode])

  return { startCreation, submitCheckpoint, isRunning, error }
}
```

- [ ] **步骤 2：Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-novel-creation-flow.ts
git commit -m "feat(novel): 创建创作流程 SSE hook"
```

---

## 任务 2：Agent 执行进度可视化到画布

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/nodes/character-node.tsx`
- 修改：`apps/desktop/src/renderer/src/components/novel/novel-canvas.tsx`

- [ ] **步骤 1：在角色节点中添加执行状态高亮**

```tsx
// 在 character-node.tsx 中添加 active 状态支持
function CharacterNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as CanvasNodeData
  const isActive = nodeData.active === true  // Agent 正在操作此角色

  return (
    <div
      className={cn(
        'flex flex-col items-center gap-1 rounded-full border-2 bg-surface-1 px-4 py-3 min-w-[100px] transition-all',
        selected ? 'border-primary shadow-lg' : 'border-border',
        isActive && 'ring-2 ring-primary animate-pulse',
      )}
    >
      {/* ... 其余不变 ... */}
    </div>
  )
}
```

- [ ] **步骤 2：在画布中根据 Agent 阶段高亮相关节点**

```tsx
// 在 novel-canvas.tsx 的 nodes 构建中添加 active 状态
const agentPhase = useNovelStore((s) => s.agentExecution.phase)

const nodes: Node[] = useMemo(() => {
  // ... 现有逻辑 ...

  // 根据 Agent 阶段高亮节点
  if (agentPhase === 'memory') {
    // Memory 阶段高亮所有角色节点
    result.forEach((node) => {
      if (node.type === 'character') {
        (node.data as CanvasNodeData).active = true
      }
    })
  } else if (agentPhase === 'reviewing' || agentPhase === 'checkpoint_review') {
    // 审稿阶段高亮章节节点
    result.forEach((node) => {
      if (node.type === 'chapter') {
        (node.data as CanvasNodeData).active = true
      }
    })
  }

  return result
}, [/* ... 现有依赖 ..., */ agentPhase])
```

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/nodes/character-node.tsx apps/desktop/src/renderer/src/components/novel/novel-canvas.tsx
git commit -m "feat(novel): Agent 执行进度可视化到画布节点"
```

---

## 任务 3：章节正文实时渲染

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/novel-right-panel.tsx`

- [ ] **步骤 1：在右侧栏预览模式中添加实时渲染**

```tsx
// 在 NovelRightPanel 的 preview 模式中
{rightPanelMode === 'preview' && (
  <ChapterPreview />
)}

// 新增 ChapterPreview 组件
function ChapterPreview(): React.ReactElement {
  const currentChapter = useNovelStore((s) => s.currentChapter)
  const agentExecution = useNovelStore((s) => s.agentExecution)
  const agentMessages = agentExecution.messages

  // 如果 Agent 正在写作，实时拼接内容
  const liveContent = useMemo(() => {
    if (agentExecution.phase === 'writing' || agentExecution.phase === 'revising') {
      return agentMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => m.content)
        .join('\n\n')
    }
    return currentChapter?.content ?? ''
  }, [agentExecution.phase, agentMessages, currentChapter])

  if (!liveContent && !currentChapter) {
    return <p className="text-xs text-text-muted">暂无章节内容</p>
  }

  return (
    <div className="flex flex-col gap-2">
      {currentChapter && (
        <h3 className="text-sm font-semibold">
          第{currentChapter.chapterNumber}章 {currentChapter.title}
        </h3>
      )}
      {(agentExecution.phase === 'writing' || agentExecution.phase === 'revising') && (
        <div className="flex items-center gap-2 rounded bg-primary/10 px-2 py-1 text-xs text-primary">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
          实时生成中...
        </div>
      )}
      <div className="whitespace-pre-wrap text-sm leading-relaxed">
        {liveContent}
      </div>
    </div>
  )
}
```

- [ ] **步骤 2：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/novel-right-panel.tsx
git commit -m "feat(novel): 章节正文实时渲染"
```

---

## 任务 4：缓存命中率监控面板

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/novel/novel-cache-monitor.tsx`
- 修改：`apps/desktop/src/renderer/src/components/novel/novel-status-bar.tsx`

- [ ] **步骤 1：创建缓存监控组件**

```tsx
import { useQuery } from '@tanstack/react-query'
import { novelApi } from '@/api/novel-client'

interface CacheStats {
  systemHash: string
  toolsHash: string
  chapterHash: string
  hitRate: number
  totalCalls: number
  cacheHits: number
}

export function NovelCacheMonitor(): React.ReactElement {
  const { data: stats } = useQuery<CacheStats>({
    queryKey: ['novel-cache-stats'],
    queryFn: () => novelApi.getCacheStats(),
    refetchInterval: 5000,
  })

  if (!stats) {
    return <span className="text-[10px] text-text-muted">缓存: --</span>
  }

  const hitRatePercent = Math.round(stats.hitRate * 100)

  return (
    <div className="flex items-center gap-3 text-[10px]">
      <div className="flex items-center gap-1">
        <span className="text-text-muted">缓存命中率:</span>
        <span className={hitRatePercent > 80 ? 'text-green-500' : hitRatePercent > 50 ? 'text-yellow-500' : 'text-red-500'}>
          {hitRatePercent}%
        </span>
      </div>
      <div className="flex items-center gap-1">
        <span className="text-text-muted">System:</span>
        <code className="font-mono text-text-muted">{stats.systemHash}</code>
      </div>
      <div className="flex items-center gap-1">
        <span className="text-text-muted">Tools:</span>
        <code className="font-mono text-text-muted">{stats.toolsHash}</code>
      </div>
      <div className="flex items-center gap-1">
        <span className="text-text-muted">调用:</span>
        <span>{stats.cacheHits}/{stats.totalCalls}</span>
      </div>
    </div>
  )
}
```

- [ ] **步骤 2：在状态栏中集成缓存监控**

```tsx
// 在 novel-status-bar.tsx 中
import { NovelCacheMonitor } from './novel-cache-monitor'

export function NovelStatusBar(): React.ReactElement {
  const agentExecution = useNovelStore((s) => s.agentExecution)

  return (
    <div className="flex h-6 items-center gap-4 border-t border-border bg-surface-1 px-4 text-[10px] text-text-muted">
      <span>小说工作台</span>
      <span>•</span>
      <span>{phaseLabel[agentExecution.phase] ?? agentExecution.phase}</span>
      <div className="flex-1" />
      <NovelCacheMonitor />
    </div>
  )
}
```

- [ ] **步骤 3：在 novel-client.ts 中添加缓存统计 API**

```typescript
// 在 novelApi 对象中添加
getCacheStats: () => getApi<{ systemHash: string; toolsHash: string; chapterHash: string; hitRate: number; totalCalls: number; cacheHits: number }>(`${BASE}/cache-stats`),
```

- [ ] **步骤 4：在后端添加缓存统计端点**

在 `novel-routes.ts` 中添加：

```typescript
routes.push({
  method: 'GET',
  path: '/cache-stats',
  handler: (req: any) => {
    // 从 NovelSessionFactory 获取哈希信息
    // 暂时返回占位数据
    return {
      ok: true,
      data: {
        systemHash: '--------',
        toolsHash: '--------',
        chapterHash: '--------',
        hitRate: 0,
        totalCalls: 0,
        cacheHits: 0,
      },
      meta: { traceId: req.traceId, timestamp: Date.now() },
    }
  },
})
```

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/novel-cache-monitor.tsx apps/desktop/src/renderer/src/components/novel/novel-status-bar.tsx apps/desktop/src/renderer/src/api/novel-client.ts
git commit -m "feat(novel): 缓存命中率监控面板"
```

---

## 任务 5：性能优化（大项目节点数 > 100）

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/novel-canvas.tsx`

- [ ] **步骤 1：添加节点分页加载**

```tsx
// 在 novel-canvas.tsx 中添加分页逻辑
const [visibleCount, setVisibleCount] = useState(50)  // 初始显示 50 个节点

const allNodes = useMemo(() => {
  // ... 现有节点构建逻辑 ...
}, [/* 依赖 */])

// 只渲染可见节点
const nodes = useMemo(() => {
  return allNodes.slice(0, visibleCount)
}, [allNodes, visibleCount])

// 滚动到边缘时加载更多
const onMoveEnd = useCallback(() => {
  if (visibleCount < allNodes.length) {
    setVisibleCount((prev) => Math.min(prev + 50, allNodes.length))
  }
}, [visibleCount, allNodes.length])
```

- [ ] **步骤 2：添加 React Flow 性能优化配置**

```tsx
<ReactFlow
  nodes={nodes}
  edges={edges}
  nodeTypes={nodeTypes}
  onNodeClick={onNodeClick}
  onNodeDragStop={onNodeDragStop}
  onMoveEnd={onMoveEnd}
  connectionMode={ConnectionMode.Loose}
  fitView
  minZoom={0.25}
  maxZoom={4}
  onlyRenderVisibleElements  // 只渲染可见节点
  defaultEdgeOptions={{
    style: { stroke: 'var(--color-border)', strokeWidth: 2 },
  }}
>
```

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/novel-canvas.tsx
git commit -m "perf(novel): 大项目节点分页加载和只渲染可见节点"
```

---

## 任务 6：端到端测试

- [ ] **步骤 1：启动前后端服务**

```bash
# 终端 1：后端
cd apps/agent-server && npm run dev

# 终端 2：前端
cd apps/desktop && npm run dev
```

- [ ] **步骤 2：完整创作流程测试**

1. 打开应用，切换到小说工作台
2. 创建项目"测试小说"
3. 创建角色"主角"和"配角"
4. 创建关系"主角 ↔ 配角：朋友"
5. 验证画布显示 2 个角色节点 + 1 条关系连线
6. 点击"创作第 1 章"按钮
7. 验证右侧栏切换到对话模式
8. 验证 SSE 事件流推送 phase_change 事件
9. 当检查点出现时，验证右侧栏切换到检查点模式
10. 确认检查点后，验证流程继续

- [ ] **步骤 3：性能测试**

1. 创建 50+ 角色
2. 验证画布仍然流畅
3. 缩放和平移无卡顿
4. 验证 onlyRenderVisibleElements 生效

- [ ] **步骤 4：Commit**

```bash
git add -A
git commit -m "test(novel): Phase 5 集成与优化端到端测试"
```

---

## 自检

### 规格覆盖度

| 规格需求 | 对应任务 |
|----------|----------|
| Agent 执行进度可视化到画布 | 任务 2 |
| 章节正文实时渲染 | 任务 3 |
| 缓存命中率监控面板 | 任务 4 |
| 性能优化（大项目节点数 > 100） | 任务 5 |
| 端到端测试 | 任务 6 |

### 类型一致性

- `CreationFlowEvent` 在 Phase 3 定义，在任务 1 使用
- `CacheStats` 在任务 4 定义，在 novel-client.ts 和 novel-cache-monitor.tsx 使用
- `useNovelCreationFlow` 在任务 1 定义，在任务 2/3 中间接使用（通过 store 状态）
