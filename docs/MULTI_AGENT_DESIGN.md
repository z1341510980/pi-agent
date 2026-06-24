# 多 Agent 协作完善方案

> 审查日期：2026-06-24 | 审查者：吴八哥 (Senior Developer)

---

## 一、现状盘点

### 1.1 已实现部分

| 模块 | 文件 | 状态 |
|------|------|------|
| AgentConfig 定义 | `subagent-tool.ts` (L20-36) | 已完成 |
| AgentManager 管理器 | `subagent-tool.ts` (L104-273) | 已完成 |
| ConcurrencyLimiter 限流 | `concurrency-limiter.ts` | 已完成 |
| AgentChannel 通信 | `agent-channel.ts` | 已完成 |
| SubagentPlugin 插件 | `subagent-plugin.ts` | 已完成 |
| SubagentTool 定义 | `subagent-tool.ts` (L64-91, L281-289) | 已完成 |
| REST API 路由 | `agents.route.ts` | 已完成 |
| 前端 AgentSelector | `agent-selector.tsx` | 已完成 |
| 前端 SubagentCard | `subagent-card.tsx` | 已完成 |
| 前端 CommunicationPanel | `agent-communication-panel.tsx` | 已完成 |
| 前端 HTTP Client | `http-client.ts` (L256-325) | 已完成 |
| session-store | `session-store.ts` | 已完成 |

### 1.2 核心缺口（按优先级排序）

**子代理 (Sub-agent)：**

| # | 缺口 | 严重度 | 说明 |
|---|------|--------|------|
| G1 | subagent 工具未注册到 Pi SDK | **P0** | `subagentToolDefinition` 使用纯 JSON Schema 格式，与 SDK 的 `ToolDefinition`（TypeBox）不兼容，需重写为 `defineTool()` 格式后注册到 `customTools` |
| G2 | Agent 无持久化 | **P0** | Agent 只在内存 Map 中，重启后丢失 |
| G3 | 缺少 subagent_reply / subagent_close | **P1** | 架构文档 §9.2 定义的生命周期不完整，每次 dispatch 创建新 session 无法续接 |
| G4 | subagent 结果无流式推送 | **P1** | dispatchFn 只返回最终字符串，父 Agent 看不到子 Agent 的工具调用/思考过程 |
| G5 | 缺少 Agent CRUD API | **P1** | 无法通过 API 创建/修改/删除 Agent，只能启动时静态注册 |
| G6 | Agent 身份模板未加载 | **P2** | 架构文档 §8.6 定义的 identity.md / personality.md 未读取注入 |

**Agent Team：**

| # | 缺口 | 严重度 | 说明 |
|---|------|--------|------|
| G7 | 无 Team 抽象 | **P0** | 没有团队概念，无法将多个 Agent 组织为协作单元 |
| G8 | 无 team 工具 | **P0** | LLM 无法通过工具调用来组建/协调团队 |
| G9 | 无 Team 执行计划 | **P1** | 不能定义并行/串行执行策略 |
| G10 | 无 Team 前端 UI | **P2** | 前端无 Team 管理界面 |

---

## 二、子代理（Sub-agent）完善方案

### 2.1 核心架构（当前 vs 目标）

```
【当前架构】
LLM → tool_call(subagent) → AgentManager.dispatchToAgent()
                                    → 每次创建新 session → prompt(task) → 返回最终字符串

问题：
1. subagent 工具未注册 → LLM 根本不知道有 subagent 工具可用
2. 每次创建新 session → 无上下文延续（无法 subagent_reply）
3. 只返回最终字符串 → 无实时流式反馈
4. Agent 只存内存 → 重启丢失
```

```
【目标架构】
LLM → tool_call(subagent) → AgentManager.dispatchToAgent()
         │
         ├── 创建或复用 subagent session（支持 subagent_reply 续接）
         ├── SDK 原生 onUpdate 回调：subagent 进度 → 前端实时可见
         │     ├── 开始: "正在派遣任务给 code-reviewer..."
         │     ├── 进度: "子 Agent 调用工具: read_file" / "子 Agent 思考中..."
         │     └── 完成: 通过工具结果返回最终输出
         ├── 持久化到 SQLite (agents 表 + team_members 表)
         └── 完整生命周期 (subagent / subagent_reply / subagent_close)
```

### 2.2 实现步骤

#### Step 1：注册 subagent 工具到 Pi SDK [P0]

**文件**：`apps/agent-server/src/core/agent/subagent-tool.ts`（重写工具定义部分）

Pi SDK 的 `createAgentSession` 已验证支持 `customTools?: ToolDefinition[]` 参数（见 [sdk.d.ts](../node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts)）。

**关键约束**：SDK 的 `ToolDefinition` 接口与当前 `subagentToolDefinition` 的纯 JSON Schema 格式**不兼容**：

| 维度 | 当前代码 | SDK 要求 |
|------|----------|----------|
| parameters | 纯 JSON Schema 对象 | TypeBox `TSchema`（`Type.Object({...})`） |
| execute 签名 | `(args) => Promise<string>` | `(toolCallId, params, signal, onUpdate, ctx) => Promise<AgentToolResult>` |
| label | 缺失 | 必填（UI 展示用） |
| promptSnippet | 缺失 | 可选（不提供则工具不出现在 system prompt 工具列表中） |

**重写 subagent 工具定义**：

```typescript
// subagent-tool.ts — 使用 defineTool + TypeBox 重写
import { Type, type TSchema, type Static } from '@sinclair/typebox'
import { defineTool, type ToolDefinition, type AgentToolResult } from '@earendil-works/pi-coding-agent'

/** subagent 工具参数 TypeBox Schema */
const SubagentToolParams = Type.Object({
  agentId: Type.String({ description: '目标 Agent ID' }),
  task: Type.String({ minLength: 1, description: '任务描述' }),
  timeout: Type.Number({
    minimum: 1000,
    maximum: 600000,
    default: 60000,
    description: '超时毫秒数（默认 60s）',
  }),
})

type SubagentToolInput = Static<typeof SubagentToolParams>

/** 创建 subagent 工具（Pi SDK ToolDefinition 格式） */
export function createSubagentTool(manager: AgentManager): ToolDefinition<typeof SubagentToolParams> {
  return defineTool({
    name: 'subagent',
    label: '子代理',
    description:
      '派遣子任务给指定 Agent 执行。当需要其他 Agent 的专长时调用此工具。' +
      '注意：嵌套深度和并发数受限流器控制，超限时会抛错。',
    promptSnippet: '派遣子任务给指定 Agent 执行',
    parameters: SubagentToolParams,
    async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult> {
      const result = await manager.executeSubagentTool(params)
      if (!result.success) {
        return {
          content: [{ type: 'text', text: `子 Agent 执行失败: ${result.error ?? '未知错误'}` }],
          isError: true,
        }
      }
      return {
        content: [{ type: 'text', text: result.result }],
      }
    },
  })
}
```

**注册到 Pi SDK**：

```typescript
// pi-session.ts — 在 createAgentSession 调用时注入 customTools
import { createSubagentTool } from './subagent-tool.js'

export async function createPiSession(deps: PiSessionDeps): Promise<AgentSession> {
  // ... 现有逻辑 ...

  // 获取 subagentManager（通过 Fastify decorator 延迟获取，见下方依赖注入方案）
  const subagentManager = deps.subagentManager
  const customTools = subagentManager ? [createSubagentTool(subagentManager)] : []

  const { session } = await createAgentSession({
    // ... 现有参数 ...
    customTools,
  })

  // ... 现有逻辑 ...
}
```

**依赖注入方案**：`createPiSession` 目前不持有 `AgentManager` 引用。在 `PiSessionDeps` 中新增：

```typescript
export interface PiSessionDeps {
  // ... 现有字段
  subagentManager?: AgentManager  // 新增：可选，subagent 插件初始化后注入
}
```

**时序问题**：`subagentPlugin` 在 `setSessionFactory` 之后注册，导致创建 session 时 `subagentManager` 尚不可用。

**解决方案**：调整 `app.ts` 中的插件注册顺序，确保 `subagentPlugin` 在 session factory 之前注册。`subagentPlugin` 不依赖 session factory（它只创建 AgentManager 并注册到 Fastify decorator），因此可以安全提前：

```typescript
// app.ts — 调整注册顺序
app.register(subagentPlugin)       // 先注册，挂载 app.subagentManager
app.register(memoryStorePlugin)    // 挂载 app.factStore
// ... 其他不依赖 session 的插件 ...
app.register(piSdkPlugin)          // 最后注册，内部调用 setSessionFactory
```

在 `pi-sdk.plugin.ts` 的 `setSessionFactory` 中，从 Fastify 实例获取 `subagentManager`：

```typescript
// pi-sdk.plugin.ts
app.setSessionFactory(async (threadId) => {
  const subagentManager = app.hasDecorator('subagentManager')
    ? app.subagentManager
    : undefined

  return createPiSession({
    // ... 现有 deps ...
    subagentManager,
  })
})
```

> **注意**：不使用模块级可变变量（Lazy Holder 模式）。模块级全局状态无法被 Fastify 生命周期管理追踪，测试时难以重置，且在未初始化时静默返回 undefined 而不报错。

#### Step 2：Agent 持久化 [P0]

**文件**：`apps/agent-server/src/core/agent/agent-persistence.ts`（新建）

**设计决策**：使用 SQLite 数据库而非 JSON 文件。理由：
1. **用户自定义**：Agent 配置需要频繁 CRUD，数据库比文件系统更适合查询、更新、事务
2. **结构化查询**：支持按名称搜索、按标签筛选、按创建时间排序等，文件系统无法高效实现
3. **并发安全**：SQLite 自带 WAL 模式并发读写，无需手动加锁或 atomicWriteSync
4. **扩展性**：后续 Team、执行历史等数据可复用同一数据库，统一持久化层
5. **Electron 友好**：SQLite 是嵌入式数据库，无需额外服务进程，`better-sqlite3` 是 Node.js 生态最成熟的同步 SQLite 驱动

**新增依赖**：`better-sqlite3` + `@types/better-sqlite3`

```typescript
// Agent 持久化接口
interface AgentPersistenceStore {
  loadAll(): AgentConfig[]
  getById(agentId: string): AgentConfig | undefined
  save(agent: AgentConfig): void
  delete(agentId: string): void
  exists(agentId: string): boolean
  search(query: { name?: string; tags?: string[] }): AgentConfig[]
}

// 基于 SQLite 的实现
class SqliteAgentStore implements AgentPersistenceStore {
  private db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        model       TEXT,          -- JSON: { provider, modelId }
        system_prompt TEXT,
        tools       TEXT,          -- JSON: string[]
        identity    TEXT,          -- identity.md 内容（可选）
        personality TEXT,          -- personality.md 内容（可选）
        created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
    `)
  }

  loadAll(): AgentConfig[] {
    return this.db.prepare('SELECT * FROM agents ORDER BY created_at').all().map(row => this.rowToConfig(row))
  }

  getById(agentId: string): AgentConfig | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId)
    return row ? this.rowToConfig(row) : undefined
  }

  save(agent: AgentConfig): void {
    this.db.prepare(`
      INSERT INTO agents (id, name, description, model, system_prompt, tools, identity, personality)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        model = excluded.model,
        system_prompt = excluded.system_prompt,
        tools = excluded.tools,
        identity = excluded.identity,
        personality = excluded.personality,
        updated_at = unixepoch()
    `).run(
      agent.id,
      agent.name,
      agent.description ?? null,
      agent.model ? JSON.stringify(agent.model) : null,
      agent.systemPrompt ?? null,
      agent.tools ? JSON.stringify(agent.tools) : null,
      (agent as any).identity ?? null,
      (agent as any).personality ?? null,
    )
  }

  delete(agentId: string): void {
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(agentId)
  }

  exists(agentId: string): boolean {
    return (this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agentId)) != null
  }

  search(query: { name?: string }): AgentConfig[] {
    let sql = 'SELECT * FROM agents WHERE 1=1'
    const params: any[] = []
    if (query.name) {
      sql += ' AND name LIKE ?'
      params.push(`%${query.name}%`)
    }
    sql += ' ORDER BY created_at'
    return this.db.prepare(sql).all(...params).map(row => this.rowToConfig(row))
  }

  private rowToConfig(row: any): AgentConfig {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      model: row.model ? JSON.parse(row.model) : undefined,
      systemPrompt: row.system_prompt ?? undefined,
      tools: row.tools ? JSON.parse(row.tools) : undefined,
      identity: row.identity ?? undefined,
      personality: row.personality ?? undefined,
    }
  }
}
```

**数据库文件路径**：`{dataDir}/pi-agent.db`（与现有 `facts.json` 同级目录）

**数据库插件**（统一管理 SQLite 连接）：

```typescript
// apps/agent-server/src/plugins/database.plugin.ts（新建）
import fp from 'fastify-plugin'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

export const databasePlugin = fp(async (app) => {
  const dataDir = process.env.PI_DATA_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE}/.pi`
  mkdirSync(join(dataDir, 'agent'), { recursive: true })

  const dbPath = join(dataDir, 'pi-agent.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  app.decorate('db', db)

  app.addHook('onClose', () => {
    db.close()
  })

  app.log.info({ dbPath }, 'SQLite 数据库已初始化')
})
```

> **注意**：后续 Team 持久化、执行历史、甚至现有 FactStore/UsageLedger 都可以迁移到此数据库，逐步替代散落的 JSON 文件。但当前阶段只用于 Agent 存储，避免一次性重构范围过大。

**AgentManager 集成**：
```typescript
// subagent-tool.ts 中 AgentManager 新增方法
class AgentManager {
  private store: AgentPersistenceStore

  async loadPersistedAgents(): void { /* 从数据库加载 */ }
  async createAgent(config: Omit<AgentConfig, 'id'> & { id: string }): Promise<AgentConfig> { /* 注册 + 持久化到数据库 */ }
  async updateAgent(id: string, patch: Partial<AgentConfig>): Promise<AgentConfig> { /* 更新 + 持久化 */ }
  async deleteAgent(id: string): Promise<void> { /* 注销 + 从数据库删除 */ }
}
```

#### Step 3：subagent 生命周期工具 [P1]

**新增工具**：`subagent_reply` 和 `subagent_close`

**subagent_reply**：续接已有 subagent session
```typescript
// subagent-tool.ts — 使用 defineTool + TypeBox
const SubagentReplyParams = Type.Object({
  threadId: Type.String({ description: '子 Agent 的 threadId（从 subagent 调用结果中获取）' }),
  task: Type.String({ minLength: 1, description: '后续任务描述' }),
  timeout: Type.Number({ minimum: 1000, maximum: 600000, default: 60000 }),
})

export function createSubagentReplyTool(manager: AgentManager): ToolDefinition<typeof SubagentReplyParams> {
  return defineTool({
    name: 'subagent_reply',
    label: '子代理续接',
    description: '向已存在的子 Agent 会话发送后续消息，用于多轮交互。',
    promptSnippet: '续接已有子 Agent 会话',
    parameters: SubagentReplyParams,
    async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult> {
      const result = await manager.replyToAgent(params.threadId, params.task, {
        timeoutMs: params.timeout,
        signal,
      })
      if (!result.success) {
        return { content: [{ type: 'text', text: `续接失败: ${result.error}` }], isError: true }
      }
      return { content: [{ type: 'text', text: result.result }] }
    },
  })
}
```

**subagent_close**：关闭 subagent session 释放资源
```typescript
const SubagentCloseParams = Type.Object({
  threadId: Type.String({ description: '要关闭的子 Agent threadId' }),
})

export function createSubagentCloseTool(manager: AgentManager): ToolDefinition<typeof SubagentCloseParams> {
  return defineTool({
    name: 'subagent_close',
    label: '子代理关闭',
    description: '关闭子 Agent 会话，释放资源。',
    promptSnippet: '关闭子 Agent 会话',
    parameters: SubagentCloseParams,
    async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult> {
      await manager.closeAgentSession(params.threadId)
      return { content: [{ type: 'text', text: `子 Agent 会话 ${params.threadId} 已关闭` }] }
    },
  })
}
```

**AgentManager 新增**：
```typescript
class AgentManager {
  // 活跃的子 Agent session 注册表
  private activeSubagentSessions = new Map<string, {
    threadId: string
    agentId: string
    createdAt: number
    session: PiThreadSession  // 复用现有类型
  }>()
  
  async replyToAgent(threadId: string, task: string, options: DispatchOptions): Promise<SubagentResult>
  async closeAgentSession(threadId: string): Promise<void>
}
```

**subagent 工具结果增强**（携带 threadId 供 reply 使用）：
```typescript
export interface SubagentResult {
  // ... 现有字段
  threadId: string  // 新增：子 Agent 的 threadId，供 subagent_reply 使用
}
```

#### Step 4：subagent 流式进度推送 [P1]

Pi SDK 的 `ToolDefinition.execute` 已原生支持流式更新：`onUpdate: AgentToolUpdateCallback` 参数。无需自定义 CUSTOM 事件，直接使用 SDK 原生机制即可。

**实现方式**：在 `createSubagentTool` 的 `execute` 中，利用 `onUpdate` 回调推送 subagent 执行进度：

```typescript
async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult> {
  // 1. 通知前端：子 Agent 开始执行
  onUpdate?.({
    content: [{ type: 'text', text: `正在派遣任务给 ${params.agentId}...` }],
  })

  const result = await manager.executeSubagentTool(params, {
    signal,
    // 2. 通过 onProgress 回调接收子 Agent 的中间进度
    onProgress: (progress) => {
      onUpdate?.({
        content: [{ type: 'text', text: progress.text }],
        details: {
          type: 'subagent_progress',
          agentId: params.agentId,
          phase: progress.phase,  // 'thinking' | 'tool_call' | 'output'
        },
      })
    },
  })

  // 3. 返回最终结果
  if (!result.success) {
    return { content: [{ type: 'text', text: `子 Agent 执行失败: ${result.error}` }], isError: true }
  }
  return { content: [{ type: 'text', text: result.result }] }
}
```

**DispatchFn 签名扩展**（非破坏性，新增可选参数）：

```typescript
// subagent-tool.ts — 扩展 DispatchFn（向后兼容）
export type DispatchFn = (
  agentId: string,
  task: string,
  options: {
    signal?: AbortSignal
    depth: number
    onProgress?: (progress: { text: string; phase: 'thinking' | 'tool_call' | 'output' }) => void  // 新增：可选
  },
) => Promise<string>
```

**subagent-plugin.ts 中的 dispatchFn 改造**：

```typescript
// subagent-plugin.ts — 在 dispatchFn 中桥接 onProgress
manager.setDispatchFn(async (agentId, task, dispatchOptions) => {
  const subagentThreadId = `subagent-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const threadSession = await app.piSessionStore.getOrCreate(subagentThreadId)

  // ... 现有模型切换逻辑 ...

  // 监听 subagent session 事件，转发为 onProgress
  if (dispatchOptions.onProgress) {
    threadSession.session.subscribe((event) => {
      if (event.type === 'tool_execution_start') {
        dispatchOptions.onProgress!({
          text: `子 Agent 调用工具: ${(event as any).toolName}`,
          phase: 'tool_call',
        })
      }
      if (event.type === 'message_update') {
        const msg = (event as any).message
        if (msg?.content) {
          dispatchOptions.onProgress!({
            text: `子 Agent 思考中...`,
            phase: 'thinking',
          })
        }
      }
    })
  }

  // ... 现有 prompt 执行逻辑 ...
})
```

**关键设计决策**：
- 使用 SDK 原生 `onUpdate` 而非自定义 CUSTOM 事件，避免与 AG-UI 协议冲突
- `onProgress` 是可选参数，现有 `dispatchFn` 实现无需修改即可继续工作
- 流式进度不影响父 Agent 的文本消息流，仅在工具调用期间可见

#### Step 5：Agent CRUD API [P1]

**扩展 `agents.route.ts`**：

```
POST   /api/agents              — 创建 Agent（持久化到磁盘）
PUT    /api/agents/:id          — 更新 Agent 配置
DELETE /api/agents/:id          — 删除 Agent
GET    /api/agents/:id          — 获取单个 Agent 详情
GET    /api/agents/:id/sessions — 获取 Agent 的活跃 subagent sessions
```

**Zod Schema**（用于请求验证）：
```typescript
const createAgentSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1).max(128),
  description: z.string().max(500).optional(),
  model: z.object({
    provider: z.string(),
    modelId: z.string(),
  }).optional(),
  systemPrompt: z.string().max(10000).optional(),
  tools: z.array(z.string()).optional(),
  // 新增：身份和人格模板
  identity: z.string().max(5000).optional(),    // identity.md 内容
  personality: z.string().max(5000).optional(),  // personality.md 内容
})
```

#### Step 6：身份模板加载 [P2]

在子 Agent 执行时，加载其 `identity.md` 和 `personality.md`，追加到系统提示词中：

```typescript
// subagent-plugin.ts 的 dispatchFn 中
const agentConfig = manager.getAgent(agentId)
if (agentConfig) {
  // 加载身份模板
  const identity = await loadAgentTemplate(agentId, 'identity.md')
  const personality = await loadAgentTemplate(agentId, 'personality.md')
  
  // 构建增强的系统提示词
  const enhancedSystemPrompt = [
    agentConfig.systemPrompt ?? '',
    identity ? `\n## 身份\n${identity}` : '',
    personality ? `\n## 人格\n${personality}` : '',
  ].filter(Boolean).join('\n')
  
  // TODO: 将 enhancedSystemPrompt 注入到 subagent session
}
```

### 2.3 子代理完整数据流

```
用户输入 → PiAgentSession.prompt()
  ↓
LLM 调用（带 customTools，其中包含 subagent 工具）
  ↓
LLM 决定调用 subagent(agentId='code-reviewer', task='审查安全性')
  ↓
subagent 工具 execute() → AgentManager.dispatchToAgent()
  ↓
┌─ AgentManager ───────────────────────────────────┐
│ 1. ConcurrencyLimiter.acquire(depth=1)          │
│ 2. 检查/创建 subagent session                   │
│    - 首次: 创建新 session（threadId 返回给工具结果）│
│    - reply: 复用已有 session                     │
│ 3. 注入 subagent 身份/人格模板                    │
│ 4. subagentSession.prompt(task)                 │
│ 5. SDK onUpdate 回调 → 前端实时可见子 Agent 进度  │
│ 6. 返回最终结果 AgentToolResult（携带 threadId）  │
│ 7. ConcurrencyLimiter.release()                 │
└──────────────────────────────────────────────────┘
  ↓
工具结果返回给 LLM → LLM 继续推理
  ↓
LLM 可选: subagent_reply(threadId, '深入分析第X行')  // 续接
  ↓
LLM 可选: subagent_close(threadId)                   // 关闭
```

---

## 三、Agent Team 完善方案

### 3.1 核心概念

**Agent Team** = 一个有组织结构的 Agent 集合，包含：
- **Team Lead**（主协调者）：负责任务分解、分配、汇总
- **Team Members**（成员）：具有各自专长的 Agent
- **Execution Plan**（执行计划）：定义并行/串行/条件执行策略

> **Shared Context（共享上下文）**：Team 级别的共享记忆，当前阶段不实现。后续迭代可通过共享一个 `team:{id}:context` 的 FactStore 标签来实现，避免每个成员的 system prompt 膨胀。

### 3.2 Team 数据模型

```typescript
// packages/shared/src/agent/team.ts（新建）

/** Team 配置 */
export interface TeamConfig {
  /** Team ID */
  id: string
  /** Team 名称 */
  name: string
  /** Team 描述 */
  description: string
  /** Team Lead 的 Agent ID（必须已注册的 Agent） */
  leadAgentId: string
  /** Team 成员配置 */
  members: TeamMemberConfig[]
  /** 默认执行策略 */
  defaultStrategy: ExecutionStrategy
  /** 最大并发成员数 */
  maxParallel: number
}

/** Team 成员 */
export interface TeamMemberConfig {
  /** 引用的 Agent ID */
  agentId: string
  /** 在 Team 中的角色 */
  role: 'researcher' | 'coder' | 'reviewer' | 'tester' | 'writer' | 'analyst' | 'custom'
  /** 自定义角色描述 */
  roleDescription?: string
}

/** 执行策略 */
export type ExecutionStrategy = 
  | 'sequential'    // 串行：按顺序执行
  | 'parallel'      // 并行：同时执行
  | 'coordinated'   // 协调：由 Team Lead 动态决策
  | 'pipeline'      // 管道：前一个的输出是后一个的输入

/** Team 执行状态 */
export interface TeamExecution {
  /** 执行 ID */
  executionId: string
  /** Team ID */
  teamId: string
  /** 初始任务描述 */
  task: string
  /** 执行策略 */
  strategy: ExecutionStrategy
  /** 当前阶段 */
  phase: 'planning' | 'executing' | 'summarizing' | 'completed' | 'failed'
  /** 成员执行结果（使用 Record 而非 Map，确保 JSON 序列化正确） */
  memberResults: Record<string, SubagentResult>
  /** 开始时间 */
  startedAt: number
}
```

### 3.3 Team 执行流程

```
用户: "审查并优化 pi-agent 的性能"
         ↓
Team Lead (default) 接收任务
         ↓
【Planning 阶段】
Team Lead 分解任务:
  ├── 成员 1 (researcher): "分析当前性能瓶颈"
  ├── 成员 2 (coder): "实现优化方案"
  └── 成员 3 (reviewer): "审查优化代码"
         ↓
【Executing 阶段】
根据 defaultStrategy 执行:
  - parallel: 3 个成员同时开始
  - sequential: researcher → coder → reviewer
  - pipeline: researcher 输出 → coder 输入 → reviewer 输入
         ↓
【Summarizing 阶段】
Team Lead 收集所有结果，汇总输出
```

### 3.4 team 工具定义

```typescript
// apps/agent-server/src/core/agent/team-tool.ts（新建）
import { Type } from '@sinclair/typebox'
import { defineTool, type ToolDefinition, type AgentToolResult } from '@earendil-works/pi-coding-agent'

const TeamExecuteParams = Type.Object({
  teamId: Type.String({ description: 'Team ID（从可用团队列表中选择）' }),
  task: Type.String({ minLength: 1, description: '团队要执行的总任务描述' }),
  members: Type.Optional(Type.Array(Type.Object({
    agentId: Type.String({ description: '成员 Agent ID' }),
    role: Type.Optional(Type.String({ description: '成员角色的简短描述' })),
    subtask: Type.String({ description: '分配给该成员的具体子任务' }),
  }))),
  strategy: Type.Optional(Type.Union([
    Type.Literal('sequential'),
    Type.Literal('parallel'),
    Type.Literal('pipeline'),
  ])),
  timeout: Type.Optional(Type.Number({
    default: 300000,
    description: '整个团队任务的总超时毫秒数',
  })),
})

export function createTeamExecuteTool(teamManager: TeamManager): ToolDefinition<typeof TeamExecuteParams> {
  return defineTool({
    name: 'team_execute',
    label: '团队执行',
    description:
      '组建团队执行复杂任务。Team Lead 负责分解任务、分配子任务给成员、收集结果并汇总。' +
      '适用于需要多角色协作的复杂任务。',
    promptSnippet: '组建团队执行复杂任务',
    parameters: TeamExecuteParams,
    async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult> {
      const result = await teamManager.execute(params.teamId, params.task, {
        members: params.members,
        strategy: params.strategy,
        timeoutMs: params.timeout,
        signal,
        onProgress: (progress) => {
          onUpdate?.({
            content: [{ type: 'text', text: progress.text }],
          })
        },
      })
      if (!result.success) {
        return { content: [{ type: 'text', text: `团队执行失败: ${result.error}` }], isError: true }
      }
      return { content: [{ type: 'text', text: result.summary }] }
    },
  })
}
```

> **注意**：`strategy` 不包含 `coordinated`。Coordinated 策略需要额外的 LLM 调用做任务规划，当前阶段未定义规划 prompt 和 fallback 机制，后续迭代再实现。

### 3.5 TeamManager 实现

```typescript
// apps/agent-server/src/core/agent/team-manager.ts（新建）

export class TeamManager {
  private teams = new Map<string, TeamConfig>()
  private activeExecutions = new Map<string, TeamExecution>()
  
  constructor(
    private agentManager: AgentManager,
    private channel: AgentChannel,
    private sessionStore: PiSessionStore,
    private store: TeamPersistenceStore,
  ) {}
  
  // ── Team CRUD ──
  async createTeam(config: Omit<TeamConfig, 'id'> & { id: string }): Promise<TeamConfig>
  async updateTeam(id: string, patch: Partial<TeamConfig>): Promise<TeamConfig>
  async deleteTeam(id: string): Promise<void>
  getTeam(id: string): TeamConfig | undefined
  listTeams(): TeamConfig[]
  
  // ── 核心执行 ──
  async execute(teamId: string, task: string, options: TeamExecuteOptions): Promise<TeamResult>
  
  // ── 内部方法 ──
  private async executeSequential(team: TeamConfig, plan: ExecutionPlan): Promise<TeamResult>
  private async executeParallel(team: TeamConfig, plan: ExecutionPlan): Promise<TeamResult>
  private async executeCoordinated(team: TeamConfig, task: string): Promise<TeamResult>
}
```

**核心执行逻辑**（`execute` 方法）：

```typescript
async execute(teamId: string, task: string, options: TeamExecuteOptions): Promise<TeamResult> {
  const team = this.teams.get(teamId)
  if (!team) throw new Error(`Team not found: ${teamId}`)

  const executionId = randomUUID()
  const startedAt = Date.now()

  // 1. 创建 Team 专属频道（用于成员间通信）
  const teamChannel = `team:${teamId}:${executionId}`
  for (const member of team.members) {
    this.channel.subscribe(teamChannel, member.agentId)
  }

  // 2. Planning 阶段：Team Lead 分解任务
  const plan = options.plan ?? await this.planTask(team, task)

  // 3. Executing 阶段
  let memberResults: Record<string, SubagentResult>
  switch (options.strategy ?? team.defaultStrategy) {
    case 'parallel':
      memberResults = await this.executeParallel(team, plan)
      break
    case 'sequential':
      memberResults = await this.executeSequential(team, plan)
      break
    case 'pipeline':
      memberResults = await this.executePipeline(team, plan)
      break
    default:
      memberResults = await this.executeParallel(team, plan)  // fallback
  }

  // 4. Summarizing 阶段：Team Lead 汇总
  const summary = await this.summarizeResults(team, task, memberResults)

  // 5. 清理
  for (const member of team.members) {
    this.channel.unsubscribe(teamChannel, member.agentId)
  }

  return {
    executionId,
    teamId,
    task,
    success: Object.values(memberResults).every(r => r.success),
    memberResults,
    summary,
    durationMs: Date.now() - startedAt,
  }
}
```

**并行执行**（注意：`maxParallel` 必须与 ConcurrencyLimiter 协调）：
```typescript
private async executeParallel(team: TeamConfig, plan: ExecutionPlan): Promise<Record<string, SubagentResult>> {
  const results: Record<string, SubagentResult> = {}

  // 向 ConcurrencyLimiter 查询剩余可用槽位，避免双重限流死等
  const limiter = this.agentManager.getLimiter()
  const availableSlots = limiter.getAvailableSlots()  // 新增方法
  const effectiveBatchSize = Math.min(team.maxParallel, availableSlots)
  const batches = this.chunkArray(plan.assignments, effectiveBatchSize)

  for (const batch of batches) {
    const batchPromises = batch.map(async (assignment) => {
      const result = await this.agentManager.dispatchToAgent(
        assignment.agentId,
        assignment.subtask,
        { timeoutMs: plan.timeoutPerMember }
      )
      // 通过 Team 频道广播进展
      this.channel.broadcast(teamChannel, assignment.agentId, {
        type: 'member_result',
        agentId: assignment.agentId,
        success: result.success,
      })
      return { agentId: assignment.agentId, result }
    })

    const batchResults = await Promise.all(batchPromises)
    for (const { agentId, result } of batchResults) {
      results[agentId] = result
    }
  }

  return results
}
```

> **双重限流问题**：TeamManager 的 `maxParallel` 和 ConcurrencyLimiter 的 `maxConcurrent` 是两层限流。如果 Team 层派发的并发数超过 ConcurrencyLimiter 的剩余槽位，会导致 `acquire()` 排队等待甚至超时。解决方案：TeamManager 在分批前查询 ConcurrencyLimiter 的剩余可用槽位（需在 ConcurrencyLimiter 中新增 `getAvailableSlots()` 方法），取 `min(maxParallel, availableSlots)` 作为实际批次大小。

### 3.6 Team 持久化

Team 配置同样存储在 SQLite 数据库中（复用 Step 2 的 `databasePlugin`），与 Agent 共享 `pi-agent.db`：

```sql
CREATE TABLE IF NOT EXISTS teams (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT,
  lead_agent_id     TEXT NOT NULL,
  default_strategy  TEXT NOT NULL DEFAULT 'parallel',
  max_parallel      INTEGER NOT NULL DEFAULT 2,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (lead_agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id         TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  role            TEXT NOT NULL,
  role_description TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, agent_id),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
```

**示例数据**：
```sql
INSERT INTO teams (id, name, description, lead_agent_id, default_strategy, max_parallel)
VALUES ('code-review-team', '代码审查团队', '由研究员、开发者和审查员组成的代码审查团队', 'default', 'pipeline', 2);

INSERT INTO team_members (team_id, agent_id, role, role_description, sort_order) VALUES
  ('code-review-team', 'researcher', 'researcher', '分析代码结构和潜在问题', 0),
  ('code-review-team', 'coder', 'coder', '实现具体的修复方案', 1),
  ('code-review-team', 'reviewer', 'reviewer', '最终审查修复质量', 2);
```

### 3.7 Team REST API

```
GET    /api/teams                     — 列出所有 Team
POST   /api/teams                     — 创建 Team
GET    /api/teams/:id                 — 获取 Team 详情
PUT    /api/teams/:id                 — 更新 Team 配置
DELETE /api/teams/:id                 — 删除 Team
POST   /api/teams/:id/execute         — 执行 Team 任务
GET    /api/teams/:id/executions      — 获取 Team 执行历史
GET    /api/teams/:id/executions/:eid — 获取单次执行详情
```

### 3.8 前端组件扩展

1. **TeamPanel**：在 Agent 设置页面中，新增 Team 管理标签页
   - Team 创建/编辑表单
   - Team 成员可视化（拖拽添加成员）
   - Team 执行历史列表

2. **TeamExecutionCard**：消息流中的 Team 执行卡片
   - 显示 Team 名称、执行阶段
   - 展开查看各成员执行结果
   - Pipeline 模式下显示阶段流转

---

## 四、实施路线图

### Phase A：子代理可用（1-2天）

| 步骤 | 内容 | 优先级 |
|------|------|--------|
| A1 | 重写 subagent 工具为 defineTool + TypeBox 格式，注册到 Pi SDK customTools | P0 |
| A2 | 调整 app.ts 插件注册顺序，确保 subagentPlugin 在 session factory 之前注册 | P0 |
| A3 | 新增 databasePlugin（SQLite）+ Agent 持久化（SqliteAgentStore） | P0 |
| A4 | AgentManager 集成持久化（loadPersisted / createAgent / deleteAgent） | P0 |
| A5 | 验证端到端：LLM 调用 subagent 工具并得到结果 | P0 |

### Phase B：子代理完善（2-3天）

| 步骤 | 内容 | 优先级 |
|------|------|--------|
| B1 | subagent_reply / subagent_close 工具实现（defineTool 格式） | P1 |
| B2 | subagent 流式进度推送（SDK 原生 onUpdate + DispatchFn onProgress 扩展） | P1 |
| B3 | Agent CRUD REST API（POST/PUT/DELETE /api/agents） | P1 |
| B4 | 身份模板加载（identity.md / personality.md） | P2 |

### Phase C：Agent Team 实现（3-4天）

| 步骤 | 内容 | 优先级 |
|------|------|--------|
| C1 | TeamConfig 类型定义 + Team 持久化 | P0 |
| C2 | TeamManager 核心执行引擎（sequential/parallel/pipeline） | P0 |
| C3 | team_execute 工具注册到 Pi SDK | P0 |
| C4 | Team REST API | P0 |
| C5 | 前端 TeamPanel + TeamExecutionCard | P2 |

---

## 五、关键设计决策

### 决策 1：subagent 工具的注册方式

**选择**：通过 Pi SDK 的 `customTools` 参数注入，而非在 beforeToolCall 中拦截。

**理由**：
- Pi SDK 已验证原生支持 `customTools?: ToolDefinition[]` 参数
- LLM 可以在一个工具调用周期内看到并调用 customTools 中的工具
- 不需要额外的工具拦截层
- 工具结果通过标准 `AgentToolResult` 返回

**已验证**：SDK 的 `ToolDefinition` 接口要求使用 TypeBox schema（非纯 JSON Schema）和特定的 `execute` 签名。当前 `subagentToolDefinition` 的格式需要重写为 `defineTool()` 格式。

### 决策 2：subagent 流式进度 vs 阻塞返回

**选择**：使用 SDK 原生 `onUpdate` 回调推送流式进度，执行完成后通过 `AgentToolResult` 返回终值。

**理由**：
- Pi SDK 的 `execute` 函数已原生提供 `onUpdate: AgentToolUpdateCallback` 参数，无需自定义 CUSTOM 事件
- 前端可以实时看到 subagent 进展（用户体验提升）
- 工具调用结果通过标准 `AgentToolResult` 返回（不破坏 LLM 工具调用语义）
- 流式进度是可选的增强，不影响核心工具调用的正确性

### 决策 3：Team 执行策略

**选择**：Phase C 先实现三种确定性策略（sequential / parallel / pipeline），coordinated 后续迭代。

**理由**：
- sequential/parallel/pipeline 覆盖 90% 常见场景
- coordinated 策略需要额外的 LLM 调用来做任务规划，当前未定义规划 prompt、结果解析和 fallback 机制
- 默认推荐 parallel 策略（最大化并行度，充分利用资源）

### 决策 4：Team 与 Subagent 的关系

**选择**：Team 是 Subagent 的上层抽象。
- Subagent 是基础：一个 Agent 派遣任务给另一个 Agent
- Team 是组合：将多个 subagent 调用组织为有结构的执行计划

TeamManager 内部通过 AgentManager.dispatchToAgent() 来执行每个成员任务，不重复造轮子。ConcurrencyLimiter 在 Team 层面表现为 `maxParallel` 参数（转为多个并发 acquire 调用）。

---

## 六、风险与注意事项

1. **ToolDefinition 格式不匹配（已修正）**：原方案使用纯 JSON Schema + `(args) => Promise<string>` 格式，与 SDK 要求的 TypeBox schema + `(toolCallId, params, signal, onUpdate, ctx) => Promise<AgentToolResult>` 不兼容。已在 Step 1/3/4/§3.4 中修正为 `defineTool()` 格式。

2. **subagent session 泄漏**：需确保 subagent session 在 `close` 或父 session 销毁时被清理。建议在 `PiSessionStore.dispose()` 中清理所有关联的 subagent session，并设置 session 空闲超时（如 30 分钟）自动回收。

3. **嵌套深度 vs LLM 上下文**：subagent 每嵌套一层增加一个 LLM 调用。深度为 3 意味着最坏情况下 1 + 3 + 9 = 13 个并发调用。当前 ConcurrencyLimiter 默认 maxConcurrent=5、maxTotal=20、maxDepth=3 已经覆盖了这个场景。

4. **Team 执行的错误处理**：如果 pipeline 模式下某一阶段失败，后续阶段如何处理？建议提供 `onError` 策略：`skip`（跳过失败继续）、`abort`（中止全部）、`retry`（重试 N 次）。

5. **Pipeline 无背压机制**：Pipeline 模式下前一个 Agent 的输出是后一个的输入。如果下游 Agent 处理慢，上游结果在内存中堆积。建议对 pipeline 中间结果设置大小限制（如 50KB），超出时截断并警告。

6. **双重限流冲突（已修正）**：TeamManager 的 `maxParallel` 和 ConcurrencyLimiter 的 `maxConcurrent` 是两层限流。已在 §3.5 中修正：TeamManager 在分批前查询 ConcurrencyLimiter 的剩余可用槽位，取 `min(maxParallel, availableSlots)` 作为实际批次大小。需在 ConcurrencyLimiter 中新增 `getAvailableSlots()` 方法。

7. **DispatchFn 签名扩展（向后兼容）**：Step 4 中 `DispatchFn` 新增了可选的 `onProgress` 参数，现有 `dispatchFn` 实现无需修改即可继续工作。但需注意 `subagent-plugin.ts` 中的 `dispatchFn` 需要逐步改造以支持 `onProgress` 转发。
