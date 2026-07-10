# Phase 3：多 Agent 编排实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现 Director→Writer→Reviewer→Reviser→Memory 自动创作流程，带 2 个检查点（叙事任务确认、验收确认），通过 AG-UI SSE 流式输出到前端，Agent 间 Session 隔离。

**架构：** NovelEngine 编排 5 个 Agent，每个 Agent 通过 NovelSessionFactory 创建独立 Pi SDK Session。检查点通过 EventEmitter + WebSocket 推送到前端，用户确认后继续流程。

**技术栈：** TypeScript、Pi SDK、EventEmitter、WebSocket、AG-UI SSE

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `apps/agent-server/src/plugins/novel-plugin/core/novel-agents.ts` | 5 个 Agent 配置定义 |
| `apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts` | 多 Agent 编排引擎 |

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `apps/agent-server/src/plugins/novel-plugin/core/novel-engine.ts` | 集成 Orchestrator，添加 createChapterWithFlow 方法 |
| `apps/agent-server/src/plugins/novel-plugin/novel-routes.ts` | 新增创作流程 API 端点 |
| `apps/agent-server/src/plugins/novel-plugin/index.ts` | 注册新服务 |

---

## 任务 1：定义 5 个 Agent 配置

**文件：**
- 创建：`apps/agent-server/src/plugins/novel-plugin/core/novel-agents.ts`

- [ ] **步骤 1：创建 Agent 配置类型和定义**

```typescript
/**
 * 小说创作 Agent 配置
 *
 * 每个 Agent 有独立的系统提示词和工具集，通过 NovelSessionFactory 创建隔离 Session。
 * - Director/Writer/Reviewer/Reviser 只使用读工具（novel_query_state）
 * - Memory 使用写工具（更新角色/伏笔/冲突/线索/关系）
 */

/** Agent 类型 */
export type NovelAgentType = 'director' | 'writer' | 'reviewer' | 'reviser' | 'memory'

/** Agent 配置 */
export interface NovelAgentConfig {
  /** Agent 类型 */
  type: NovelAgentType
  /** Agent ID（用于 Pi SDK Session） */
  id: string
  /** 显示名称 */
  name: string
  /** 身份描述（注入到系统提示词） */
  identity: string
  /** 可用的工具列表（工具名） */
  tools: string[]
  /** 角色模板名（对应 prompts/role-{type}.md） */
  roleTemplate: string
}

/** 5 个 Agent 的配置 */
export const NOVEL_AGENT_CONFIGS: Record<NovelAgentType, NovelAgentConfig> = {
  director: {
    type: 'director',
    id: 'novel-director',
    name: '导演 Agent',
    identity: '你是一个专业的小说导演，负责分析故事状态并规划章节叙事任务。你需要判断当前剧情阶段、确定叙事任务类型、分配信息差、控制节奏。',
    tools: ['novel_query_state'],
    roleTemplate: 'role-director',
  },
  writer: {
    type: 'writer',
    id: 'novel-writer',
    name: '写作 Agent',
    identity: '你是一个专业的小说作家，根据叙事任务和约束创作章节正文。你需要使用工具查询最新故事状态，确保内容与已有设定一致。',
    tools: ['novel_query_state'],
    roleTemplate: 'role-writer',
  },
  reviewer: {
    type: 'reviewer',
    id: 'novel-reviewer',
    name: '审稿 Agent',
    identity: '你是一个严格的审稿编辑，检查章节的设定一致性、角色一致性、叙事任务完成度、线索推进度、伏笔状态变化、节奏合理性、信息揭露是否越界、读者钩子和语言风格。',
    tools: ['novel_query_state'],
    roleTemplate: 'role-reviewer',
  },
  reviser: {
    type: 'reviser',
    id: 'novel-reviser',
    name: '修订 Agent',
    identity: '你是一个修订专家，根据审稿问题重写章节局部内容。保持未受影响的段落不变，只修改有问题的部分。',
    tools: ['novel_query_state'],
    roleTemplate: 'role-reviser',
  },
  memory: {
    type: 'memory',
    id: 'novel-memory',
    name: '记忆 Agent',
    identity: '你是一个记忆管理 Agent，负责从章节中提取状态变更并更新故事状态系统。你需要使用工具更新角色动态状态、伏笔状态、冲突阶段、线索进度和关系阶段。',
    tools: [
      'novel_query_state',
      'novel_update_character',
      'novel_update_foreshadow',
      'novel_update_conflict',
      'novel_update_clue',
      'novel_update_relationship',
    ],
    roleTemplate: 'role-memory',
  },
}

/** 创作流程阶段 */
export type CreationPhase =
  | 'idle'
  | 'directing'
  | 'checkpoint_narrative'
  | 'writing'
  | 'reviewing'
  | 'checkpoint_review'
  | 'revising'
  | 'rewriting'
  | 'memory'
  | 'completed'
  | 'cancelled'
  | 'error'

/** 检查点类型 */
export type CheckpointType = 'narrative_task' | 'review'

/** 检查点数据 */
export interface CheckpointData {
  type: CheckpointType
  phase: CreationPhase
  data: unknown
  /** 用户决策：approve / reject / revise / rewrite */
  decision?: 'approve' | 'reject' | 'revise' | 'rewrite'
}

/** 创作流程事件 */
export interface CreationFlowEvent {
  /** 事件类型 */
  type: 'phase_change' | 'agent_event' | 'checkpoint' | 'error' | 'completed'
  /** 当前阶段 */
  phase: CreationPhase
  /** 事件数据 */
  data?: unknown
  /** 时间戳 */
  timestamp: number
}
```

- [ ] **步骤 2：验证编译**

运行：`cd apps/agent-server && npx tsc --noEmit`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add apps/agent-server/src/plugins/novel-plugin/core/novel-agents.ts
git commit -m "feat(novel): 定义 5 个 Agent 配置和创作流程类型"
```

---

## 任务 2：实现多 Agent 编排引擎

**文件：**
- 创建：`apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts`

- [ ] **步骤 1：创建 NovelOrchestrator 类**

```typescript
import { EventEmitter } from 'node:events'
import type { NovelStore } from './novel-store.js'
import type { NovelSessionFactory } from './novel-session.js'
import type { NovelPromptBuilder } from './prompt-builder.js'
import type { NovelEngine } from './novel-engine.js'
import { NOVEL_AGENT_CONFIGS, type NovelAgentType, type CreationPhase, type CheckpointData, type CreationFlowEvent } from './novel-agents.js'
import type { NarrativeTask, ChapterConstraints } from './types.js'

/** 创作流程选项 */
export interface CreationOptions {
  /** 检查点回调（返回用户决策） */
  onCheckpoint: (checkpoint: CheckpointData) => Promise<'approve' | 'reject' | 'revise' | 'rewrite'>
  /** 进度回调（推送事件到前端） */
  onProgress: (event: CreationFlowEvent) => void
  /** 中止信号 */
  signal?: AbortSignal
}

/** 创作流程结果 */
export interface CreationResult {
  status: 'completed' | 'cancelled' | 'error'
  chapterId?: string
  content?: string
  stateChanges?: Array<{ type: string; description: string }>
  error?: string
}

/**
 * 小说多 Agent 编排引擎
 *
 * 编排 Director → Writer → Reviewer → Reviser → Memory 创作流程，
 * 在 Director 和 Reviewer 之后设置检查点，用户确认后继续。
 */
export class NovelOrchestrator extends EventEmitter {
  constructor(
    private store: NovelStore,
    private sessionFactory: NovelSessionFactory,
    private promptBuilder: NovelPromptBuilder,
    private engine: NovelEngine,
  ) {
    super()
  }

  /**
   * 创作章节（自动流程 + 检查点）
   */
  async createChapterWithFlow(
    projectId: string,
    chapterNumber: number,
    options: CreationOptions,
  ): Promise<CreationResult> {
    try {
      // Phase 1: Director - 分析故事状态，生成叙事任务
      this.emitProgress(options, 'directing', { message: '导演 Agent 正在分析故事状态...' })
      const directorResult = await this.runAgent('director', projectId, {
        task: `请分析当前故事状态，为第 ${chapterNumber} 章规划叙事任务。需要包含：1. 叙事任务类型和描述 2. 节奏类型 3. 信息差分配 4. 需要推进的伏笔/线索`,
      })

      // 检查点 1：用户确认叙事任务
      this.emitProgress(options, 'checkpoint_narrative', { message: '等待用户确认叙事任务...' })
      const narrativeDecision = await options.onCheckpoint({
        type: 'narrative_task',
        phase: 'checkpoint_narrative',
        data: directorResult,
      })

      if (narrativeDecision === 'reject') {
        this.emitProgress(options, 'cancelled', { message: '用户取消了创作流程' })
        return { status: 'cancelled' }
      }

      // 解析叙事任务
      const narrativeTask: NarrativeTask = this.parseNarrativeTask(directorResult, chapterNumber)

      // Phase 2: Writer - 创作章节正文
      this.emitProgress(options, 'writing', { message: '写作 Agent 正在创作章节正文...' })
      const constraints = this.engine.buildChapterConstraints(projectId)
      const writerResult = await this.runWriterAgent(projectId, chapterNumber, narrativeTask, constraints, options)

      // Phase 3: Reviewer - 验收章节
      this.emitProgress(options, 'reviewing', { message: '审稿 Agent 正在检查章节...' })
      const reviewResult = await this.runAgent('reviewer', projectId, {
        task: `请验收第 ${chapterNumber} 章的内容，检查：设定一致性、角色一致性、叙事任务完成度、线索推进度、伏笔状态变化、节奏合理性、信息揭露是否越界、读者钩子、语言风格。`,
        content: writerResult,
      })

      // 检查点 2：用户查看验收报告
      this.emitProgress(options, 'checkpoint_review', { message: '等待用户确认验收报告...' })
      const reviewDecision = await options.onCheckpoint({
        type: 'review',
        phase: 'checkpoint_review',
        data: reviewResult,
      })

      let finalContent = writerResult

      if (reviewDecision === 'revise') {
        // Phase 4a: Reviser - 局部重写
        this.emitProgress(options, 'revising', { message: '修订 Agent 正在重写局部内容...' })
        const reviseResult = await this.runAgent('reviser', projectId, {
          task: `请根据审稿问题修订第 ${chapterNumber} 章，保持未受影响的段落不变。`,
          content: writerResult,
          issues: reviewResult,
        })
        finalContent = reviseResult
      } else if (reviewDecision === 'rewrite') {
        // Phase 4b: 重写（回到 Writer）
        this.emitProgress(options, 'rewriting', { message: '重新创作章节...' })
        return this.createChapterWithFlow(projectId, chapterNumber, options)
      }

      // Phase 5: Memory - 提取状态变更
      this.emitProgress(options, 'memory', { message: '记忆 Agent 正在提取状态变更...' })
      const memoryResult = await this.runAgent('memory', projectId, {
        task: `请从第 ${chapterNumber} 章中提取状态变更，使用工具更新角色动态状态、伏笔状态、冲突阶段、线索进度和关系阶段。`,
        content: finalContent,
      })

      // 保存章节
      const chapter = await this.engine.completeChapter(
        (await this.engine.createChapter(projectId, chapterNumber, narrativeTask)).chapterId,
        finalContent,
      )

      this.emitProgress(options, 'completed', { message: '章节创作完成', chapterId: chapter.id })

      return {
        status: 'completed',
        chapterId: chapter.id,
        content: finalContent,
        stateChanges: this.parseStateChanges(memoryResult),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emitProgress(options, 'error', { message })
      return { status: 'error', error: message }
    }
  }

  /** 运行单个 Agent */
  private async runAgent(agentType: NovelAgentType, projectId: string, input: unknown): Promise<string> {
    const config = NOVEL_AGENT_CONFIGS[agentType]
    const systemPrompt = this.promptBuilder.buildSystemPrompt(projectId, agentType)

    // 通过 SessionFactory 创建 Session
    // 实际的 LLM 调用通过 Pi SDK 完成
    // 这里返回 LLM 生成的文本
    // ⚠️ 需要通过 createPiSession 创建实际 Session 并运行
    // 暂时返回占位文本，实际实现在集成 Pi SDK 后完成
    throw new Error('runAgent 需要集成 Pi SDK Session，在任务 3 中实现')
  }

  /** 运行 Writer Agent（需要章节上下文） */
  private async runWriterAgent(
    projectId: string,
    chapterNumber: number,
    narrativeTask: NarrativeTask,
    constraints: ChapterConstraints,
    options: CreationOptions,
  ): Promise<string> {
    const config = NOVEL_AGENT_CONFIGS['writer']
    const systemPrompt = this.promptBuilder.buildSystemPrompt(projectId, 'writer')
    const chapterContext = this.promptBuilder.buildChapterContext(
      projectId,
      chapterNumber,
      narrativeTask,
      constraints,
    )

    // 通过 Pi SDK Session 运行
    throw new Error('runWriterAgent 需要集成 Pi SDK Session，在任务 3 中实现')
  }

  /** 解析叙事任务 */
  private parseNarrativeTask(directorOutput: string, chapterNumber: number): NarrativeTask {
    // 简单解析，实际可使用结构化输出
    return {
      type: 'advance_plot',
      description: directorOutput.slice(0, 500),
      priority: 'high',
      targetChapter: chapterNumber,
    }
  }

  /** 解析状态变更 */
  private parseStateChanges(memoryOutput: string): Array<{ type: string; description: string }> {
    return [{ type: 'memory', description: memoryOutput.slice(0, 200) }]
  }

  /** 推送进度事件 */
  private emitProgress(options: CreationOptions, phase: CreationPhase, data: unknown): void {
    const event: CreationFlowEvent = {
      type: phase === 'completed' || phase === 'error' || phase === 'cancelled' ? phase : 'phase_change',
      phase,
      data,
      timestamp: Date.now(),
    }
    options.onProgress(event)
    this.emit('event', event)
  }
}
```

- [ ] **步骤 2：验证编译**

运行：`cd apps/agent-server && npx tsc --noEmit`
预期：PASS（runAgent 和 runWriterAgent 抛出错误是预期的，将在任务 3 实现）

- [ ] **步骤 3：Commit**

```bash
git add apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts
git commit -m "feat(novel): 创建多 Agent 编排引擎（含检查点机制）"
```

---

## 任务 3：集成 Pi SDK Session 运行 Agent

**文件：**
- 修改：`apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts`

- [ ] **步骤 1：注入 PiSessionStore 依赖**

修改 `NovelOrchestrator` 构造函数，添加 `PiSessionStore` 和 `PiAgUiAgent` 依赖：

```typescript
import type { PiSessionStore } from '../../../core/agent/session-store.js'
import type { PiAgUiAgent } from '../../../core/agent/pi-agui-agent.js'

export class NovelOrchestrator extends EventEmitter {
  constructor(
    private store: NovelStore,
    private sessionFactory: NovelSessionFactory,
    private promptBuilder: NovelPromptBuilder,
    private engine: NovelEngine,
    private piSessionStore: PiSessionStore,
    private piAgUiAgent: PiAgUiAgent,
  ) {
    super()
  }
```

- [ ] **步骤 2：实现 runAgent 方法**

```typescript
/** 运行单个 Agent（通过 Pi SDK Session） */
private async runAgent(agentType: NovelAgentType, projectId: string, input: unknown): Promise<string> {
  const config = NOVEL_AGENT_CONFIGS[agentType]
  const systemPrompt = this.promptBuilder.buildSystemPrompt(projectId, agentType)

  // 创建 Session（使用 Agent ID 作为 threadId，实现 Session 隔离）
  const threadId = `${config.id}-${projectId}-${Date.now()}`
  const session = await this.piSessionStore.getOrCreate(threadId)

  // 发送系统提示词（通过 systemPromptOverride 已在创建时注入）
  // 发送用户消息
  const inputText = typeof input === 'string' ? input : JSON.stringify(input)

  // 通过 AG-UI 运行并收集结果
  let result = ''
  const events: BaseEvent[] = []

  await this.piAgUiAgent.streamRun(
    {
      threadId,
      runId: randomUUID(),
      messages: [{ role: 'user', content: inputText }],
    },
    (event) => {
      events.push(event)
      // 收集文本消息
      if (event.type === 'TEXT_MESSAGE_CONTENT') {
        result += (event as any).content
      }
    },
    { signal: undefined as any },
  )

  return result
}
```

- [ ] **步骤 3：实现 runWriterAgent 方法**

```typescript
/** 运行 Writer Agent（需要章节上下文作为首条消息） */
private async runWriterAgent(
  projectId: string,
  chapterNumber: number,
  narrativeTask: NarrativeTask,
  constraints: ChapterConstraints,
  options: CreationOptions,
): Promise<string> {
  const config = NOVEL_AGENT_CONFIGS['writer']
  const systemPrompt = this.promptBuilder.buildSystemPrompt(projectId, 'writer')
  const chapterContext = this.promptBuilder.buildChapterContext(
    projectId,
    chapterNumber,
    narrativeTask,
    constraints,
  )

  // 创建 Writer Session
  const threadId = `${config.id}-${projectId}-ch${chapterNumber}-${Date.now()}`
  const session = await this.piSessionStore.getOrCreate(threadId)

  // 章节上下文作为首条消息，创作指令作为第二条
  let result = ''
  await this.piAgUiAgent.streamRun(
    {
      threadId,
      runId: randomUUID(),
      messages: [
        { role: 'user', content: chapterContext },
        { role: 'user', content: `请根据以上章节上下文和叙事任务，创作第 ${chapterNumber} 章的正文。` },
      ],
    },
    (event) => {
      // 转发事件到前端
      options.onProgress({
        type: 'agent_event',
        phase: 'writing',
        data: event,
        timestamp: Date.now(),
      })
      // 收集文本
      if (event.type === 'TEXT_MESSAGE_CONTENT') {
        result += (event as any).content
      }
    },
    { signal: options.signal as any },
  )

  return result
}
```

- [ ] **步骤 4：在 novel-services.ts 中注册 Orchestrator**

修改 `createNovelServices` 函数，添加 Orchestrator 初始化：

```typescript
import { NovelOrchestrator } from './novel-orchestrator.js'
import type { PiSessionStore } from '../../../core/agent/session-store.js'
import type { PiAgUiAgent } from '../../../core/agent/pi-agui-agent.js'

export interface NovelServices {
  store: NovelStore
  promptManager: PromptManager
  promptBuilder: NovelPromptBuilder
  sessionFactory: NovelSessionFactory
  engine: NovelEngine
  orchestrator: NovelOrchestrator
  tools: ToolDefinition[]
}

/** 初始化小说系统所有服务 */
export function createNovelServices(
  db: Database.Database,
  cwd: string,
  piSessionStore: PiSessionStore,
  piAgUiAgent: PiAgUiAgent,
): NovelServices {
  const store = new NovelStore(db)
  const promptManager = new PromptManager(db, cwd)
  const promptBuilder = new NovelPromptBuilder(promptManager, store)
  const sessionFactory = new NovelSessionFactory(store, promptManager)
  const engine = new NovelEngine(store, sessionFactory)
  const orchestrator = new NovelOrchestrator(store, sessionFactory, promptBuilder, engine, piSessionStore, piAgUiAgent)
  const tools = createNovelTools(store)

  return { store, promptManager, promptBuilder, sessionFactory, engine, orchestrator, tools }
}
```

- [ ] **步骤 5：更新 index.ts 传递 piSessionStore 和 piAgUiAgent**

```typescript
async setup(context: PluginContext) {
  // ... 迁移注册不变 ...

  // 获取 PiSessionStore 和 PiAgUiAgent（由核心插件提供）
  // 注意：这些服务在 pluginLoaderPlugin 执行时已由 app.ts 装饰
  const piSessionStore = (context as any).piSessionStore as PiSessionStore
  const piAgUiAgent = (context as any).piAgUiAgent as PiAgUiAgent

  const services = createNovelServices(context.db, context.cwd, piSessionStore, piAgUiAgent)

  // ... 其余注册不变 ...
  context.registerService('novelOrchestrator', services.orchestrator)
}
```

注意：这里需要在 PluginContext 中添加 `piSessionStore` 和 `piAgUiAgent` 的访问。回到 plugin-types.ts 扩展：

在 PluginContext 中添加：
```typescript
/** PiSessionStore（由核心插件提供，用于创建 Agent Session） */
readonly piSessionStore?: PiSessionStore
/** PiAgUiAgent（由核心插件提供，用于运行 Agent） */
readonly piAgUiAgent?: PiAgUiAgent
```

并在 plugin-manager.ts 的 createPluginContext 中传入（需要 PluginManager 构造函数接收这些依赖）。

- [ ] **步骤 6：验证编译**

运行：`cd apps/agent-server && npx tsc --noEmit`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add apps/agent-server/src/plugins/novel-plugin/
git commit -m "feat(novel): 集成 Pi SDK Session 运行 Agent"
```

---

## 任务 4：添加创作流程 API 端点

**文件：**
- 修改：`apps/agent-server/src/plugins/novel-plugin/novel-routes.ts`

- [ ] **步骤 1：添加创作流程启动端点（SSE 流式）**

```typescript
// 在 createNovelRoutes 函数中添加

routes.push({
  method: 'POST',
  path: '/projects/:projectId/chapters/:chapterNumber/create',
  handler: async (req: any, reply: any) => {
    const { projectId, chapterNumber } = req.params
    const orchestrator = services.orchestrator

    // 设置 SSE
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    // 心跳
    const heartbeat = setInterval(() => {
      reply.raw.write(': keepalive\n\n')
    }, 15000)

    try {
      const result = await orchestrator.createChapterWithFlow(
        projectId,
        parseInt(chapterNumber, 10),
        {
          onCheckpoint: async (checkpoint) => {
            // 推送检查点到前端
            reply.raw.write(`data: ${JSON.stringify({ type: 'checkpoint', data: checkpoint })}\n\n`)
            // 等待用户决策（通过另一个 API 端点提交）
            return new Promise((resolve) => {
              const handler = (decision: string) => {
                resolve(decision as any)
              }
              // 注册一次性回调
              orchestrator.once(`checkpoint:${checkpoint.type}`, handler)
            })
          },
          onProgress: (event) => {
            reply.raw.write(`data: ${JSON.stringify({ type: 'progress', data: event })}\n\n`)
          },
        },
      )

      reply.raw.write(`data: ${JSON.stringify({ type: 'result', data: result })}\n\n`)
    } catch (err) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: String(err) })}\n\n`)
    } finally {
      clearInterval(heartbeat)
      reply.raw.end()
    }
  },
})

// 检查点决策端点
routes.push({
  method: 'POST',
  path: '/projects/:projectId/checkpoint/:type/decision',
  handler: async (req: any, reply: any) => {
    const { projectId, type } = req.params
    const { decision } = req.body
    services.orchestrator.emit(`checkpoint:${type}`, decision)
    return { ok: true, data: { accepted: true } }
  },
})
```

- [ ] **步骤 2：验证编译**

运行：`cd apps/agent-server && npx tsc --noEmit`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add apps/agent-server/src/plugins/novel-plugin/novel-routes.ts
git commit -m "feat(novel): 添加创作流程 SSE 端点和检查点决策端点"
```

---

## 任务 5：端到端验证

- [ ] **步骤 1：启动服务**

运行：`cd apps/agent-server && npm run dev`
预期：服务正常启动，日志显示 novel 插件加载成功

- [ ] **步骤 2：创建测试项目并添加基础数据**

```bash
# 创建项目
curl -X POST http://localhost:3900/api/plugins/novel/projects \
  -H "Content-Type: application/json" \
  -d '{"title":"测试小说","genre":"奇幻","synopsis":"一个剑士的冒险故事"}'

# 创建角色
curl -X POST http://localhost:3900/api/plugins/novel/projects/{id}/characters \
  -H "Content-Type: application/json" \
  -d '{"name":"主角","identity":"剑士","personality":"勇敢"}'

# 创建世界规则
curl -X POST http://localhost:3900/api/plugins/novel/projects/{id}/world-rules \
  -H "Content-Type: application/json" \
  -d '{"category":"magic","rule":"魔法需要消耗体力","isFixed":true}'
```

- [ ] **步骤 3：启动创作流程**

```bash
curl -N http://localhost:3900/api/plugins/novel/projects/{id}/chapters/1/create
```
预期：收到 SSE 事件流，包含 phase_change 和 checkpoint 事件

- [ ] **步骤 4：Commit**

```bash
git add -A
git commit -m "test(novel): 多 Agent 编排端到端验证"
```

---

## 自检

### 规格覆盖度

| 规格需求 | 对应任务 |
|----------|----------|
| 定义 5 个 AgentConfig | 任务 1 |
| NovelEngine.createChapter 实现 | 任务 2 + 任务 3 |
| 检查点机制（WebSocket 推送） | 任务 2 + 任务 4 |
| Agent 间 Session 隔离 | 任务 3 |
| 验证端到端创作流程 | 任务 5 |

### 类型一致性

- `NovelAgentType` 在任务 1 定义，在任务 2/3 使用
- `CreationPhase` 在任务 1 定义，在任务 2/4 使用
- `CheckpointData` 在任务 1 定义，在任务 2/4 使用
- `NovelOrchestrator` 在任务 2 定义，在任务 3/4 使用
- `createNovelServices` 参数在任务 3 扩展，需同步更新 index.ts
