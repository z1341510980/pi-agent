# pi-agent 架构设计文档

> 本文档定义 pi-agent 的核心架构决策、设计模式、模块划分和实施路线图。
> 基于 openhanako 项目的架构经验，结合 pi-agent 的技术栈特点（TypeScript / Fastify / AG-UI / Electron）做出适配。

---

## 1. 架构决策总览

| # | 决策点 | 选定方案 |
|---|--------|----------|
| 1 | 核心架构模式 | 模块化 Service Locator |
| 2 | LLM 调用层 | Pi SDK 优先（pi-coding-agent SDK 提供完整 Agent Loop + Session + Compaction），自建薄适配层 |
| 3 | Prompt 拼装 | 混合模式：代码生成核心规则 + 模板文件可编辑 + 动态注入 |
| 4 | 工具系统 | Pi SDK 内置工具（read/bash/edit/write/grep/find/ls）+ Extensions 扩展（web_search/web_fetch） |
| 5 | 记忆系统 | 完整复刻（FactStore + SessionSummary + MemoryTicker），无向量搜索 |
| 6 | 通信协议 | SSE（AG-UI 流式）+ WebSocket（服务端推送） |
| 7 | 配置管理 | 三层配置（Global → Agent → Session） |
| 8 | 多 Agent | 多 Agent 协作（含 subagent 派遣 + 频道/DM） |
| 9 | 插件系统 | 完整插件（Tool + 路由 + 事件 + UI） |
| 10 | 数据目录 | Electron appData + agent-server 独立进程 |
| 11 | 日志/错误 | pino + createModuleLogger + 混合错误传播 |
| 12 | 前端状态 | Zustand + TanStack Query，CopilotKit 仅做 UI 组件 |
| 13 | LLM Provider | Pi SDK 全栈（pi-ai 协议层 + pi-agent-core Agent 核心 + pi-coding-agent 完整 SDK） |
| 14 | AG-UI 集成 | Pi SDK 事件 → StreamEmitter → AG-UI 事件映射（参考 pi-agui 模板） |
| 15 | 目录结构 | 按领域分 |
| 16 | Service Container | Fastify 插件即容器 |
| 17 | 共享包 | 按职责拆分（@repo/shared + @repo/protocol + @repo/config） |
| 18 | 测试 | 混合（单元 + 集成）+ Vitest |
| 19 | Electron IPC | HTTP + WebSocket 控制通道 |
| 20 | 工具安全 | 权限模式（Auto / Plan / Read-only） |
| 21 | 数据迁移 | 版本化迁移系统（_dataVersion 追踪，启动时自动执行） |
| 22 | 上下文溢出 | Pi SDK 内置 Compaction（autoCompaction + 手动 compact + 三级阈值） |
| 23 | 用量追踪 | Usage Ledger（token 用量 / 成本 / 归因记录） |
| 24 | Session 健康 | 健康检查 + 孤儿 toolResult 修复 |
| 25 | 凭证安全 | Electron safeStorage + Pi SDK getApiKey 回调（CredentialBridge 桥接） |
| 26 | 文件写入 | 原子写入（write tmp → rename，防崩溃损坏） |
| 27 | 自动更新 | Electron auto-updater |
| 28 | 国际化 | i18n（中文优先） |
| 29 | 会话文件 | SessionFileRegistry（工具产出文件的生命周期管理） |
| 30 | 模型注册 | Pi SDK ModelRegistry（内置模型 + 自定义模型 + added-models.yaml） |
| 31 | 重试机制 | Decorrelated jitter 重试（AWS 推荐），AppError.retryable 驱动 |
| 32 | 速率限制 | SearchRateLimiter（per-Provider 并发/间隔/冷却/429 退避） |
| 33 | 权限控制 | Gate 接口（工具执行前权限检查）+ read-only 模式 + 工具白名单 |
| 34 | 流式解析 | Pi SDK 事件流（message_update 包含 text_delta/thinking_delta/toolcall）+ StreamEmitter 映射 |
| 35 | 并发限流 | Subagent 信号量 + 总数 backstop（防失控） |
| 36 | Memory 调度 | Turn-based 触发 + 启动检查 + 崩溃恢复 + 步骤健康状态 |
| 37 | 任务验证 | Evidence Ledger + Final Readiness Check（防 Agent 假装完成） |
| 38 | 记忆反思 | Memory Reflection（shadow/write 模式验证记忆编译质量） |
| 39 | 优雅关闭 | Graceful Shutdown（等活跃任务完成 + 清理定时器） |
| 40 | 中途引导 | Pi SDK steer/followUp（运行中注入用户消息） |
| 41 | Agent 循环 | Pi SDK Agent Loop（内置 LLM → tool_call → 工具 → LLM 循环 + parallel/sequential 执行） |
| 42 | 出站代理 | OutboundProxy（系统代理 / 手动代理 / noProxy，国内用户刚需） |
| 43 | CORS / 认证 | Fastify CORS + Bearer Token 认证中间件 |
| 44 | 项目指令 | InstructionLoader（自动加载 .pi-instructions.md / CLAUDE.md 等） |
| 45 | Cron 自动化 | CronScheduler（定时任务调度） |
| 46 | server-info | agent-server 启动后写入端口信息，Main 进程读取连接 |
| 47 | 会话标题 | 首轮对话后 LLM 自动生成会话标题 |

---

## 2. 核心架构模式：模块化 Service Locator

### 2.1 模式说明

不采用 openhanako 的 Engine Facade 模式（Engine 类膨胀至 2000+ 行），而是采用 **模块化 Service Locator**：

- 每个 Service 是独立的 Fastify 插件，通过 `fastify.decorate()` 注册
- 路由和其他 Service 通过 `fastify.xxx` 按名访问
- Service 之间通过构造函数参数声明依赖，Fastify 的插件加载顺序保证依赖已就绪
- 无中心类膨胀问题，每个 Service 独立演进

### 2.2 与 Engine Facade 的对比

```
openhanako (Engine Facade):
  Engine.agent  → Engine._agentMgr.agent
  Engine.config → Engine._configCoord.config
  所有调用经 Engine 中转

pi-agent (Service Locator):
  fastify.agentManager  → AgentManager 实例
  fastify.configService → ConfigService 实例
  调用方直接访问目标 Service
```

### 2.3 Service 注册示例

```typescript
// core/agent/agent-manager.plugin.ts
import type { FastifyPluginAsync } from 'fastify'
import { AgentManager } from './agent-manager.js'

declare module 'fastify' {
  interface FastifyInstance {
    agentManager: AgentManager
  }
}

export const agentManagerPlugin: FastifyPluginAsync = async (app) => {
  const manager = new AgentManager({
    agentsDir: app.configService.getAgentsDir(),
    getLLMService: () => app.llmService,
  })
  await manager.init()
  app.decorate('agentManager', manager)
  app.addHook('onClose', () => manager.dispose())
}
```

---

## 3. LLM 调用层：Pi SDK 全栈集成

### 3.1 架构

Pi SDK 提供三层能力，我们直接复用，只建薄适配层：

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────────────────────┐
│ AG-UI Route │────→│  PiAgUiAgent     │────→│ pi-coding-agent SDK          │
│ CopilotKit  │────→│  (薄适配层)       │     │ ├── Agent (pi-agent-core)    │
└─────────────┘     │ ├── StreamEmitter │     │ ├── SessionManager (JSONL)   │
                    │ └── SessionStore  │     │ ├── AuthStorage + ModelReg   │
                    └──────────────────┘     │ ├── DefaultResourceLoader    │
                                              │ └── Extensions (工具扩展)    │
                                              │     │
                                              │     ├── pi-ai (Provider 适配) │
                                              │     │   ├── OpenAI             │
                                              │     │   ├── Anthropic          │
                                              │     │   ├── Gemini             │
                                              │     │   └── 20+ Providers     │
                                              │     │
                                              └─────┘
```

### 3.2 职责划分

| 层 | 职责 | 不负责 |
|----|------|--------|
| **Pi SDK (pi-coding-agent)** | Agent Loop、工具执行、Session 管理、Compaction、Auth/Model 管理 | AG-UI 协议、Electron 集成 |
| **Pi SDK (pi-agent-core)** | Agent 类、事件流、steer/followUp、beforeToolCall/afterToolCall 钩子 | 业务逻辑 |
| **Pi SDK (pi-ai)** | Provider 适配、流式输出、tool_call 解析、token/cost 追踪 | Agent Loop |
| **PiAgUiAgent** | AG-UI 事件映射、SSE 流式输出、会话路由 | LLM 调用、工具执行 |
| **StreamEmitter** | Pi SDK 事件 → AG-UI 事件转换 | 业务逻辑 |
| **CopilotKit 适配** | CopilotKit 请求 → PiAgUiAgent 调用 | 流式处理 |

> **关键归属**：Agent Loop 由 **Pi SDK 内置提供**（`pi-agent-core` 的 `Agent` 类），
> 包括 LLM → tool_call → 工具执行 → LLM 循环、parallel/sequential 执行模式、
> 错误恢复、最大迭代控制。我们不再自建 Agent Loop，只通过 `beforeToolCall`/`afterToolCall`
> 钩子注入 Gate 权限检查和 EventBus 事件。

### 3.3 Pi SDK → AG-UI 事件映射

通过 `StreamEmitter` 将 Pi SDK 事件映射为 AG-UI 事件（参考 pi-agui 模板）：

| Pi SDK 事件 | AG-UI 事件 |
|-------------|-----------|
| message_start (assistant) | `TEXT_MESSAGE_START` |
| message_update (text_delta) | `TEXT_MESSAGE_CONTENT` |
| message_update (thinking_delta) | `REASONING_MESSAGE_CONTENT` + `THINKING_TEXT_MESSAGE_CONTENT` |
| message_update (toolcall_start/delta/end) | `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END` |
| message_end (assistant) | `TEXT_MESSAGE_END` |
| tool_execution_start | `STEP_STARTED` + `ACTIVITY_SNAPSHOT` |
| tool_execution_end | `STEP_FINISHED` + `ACTIVITY_DELTA` |
| tool_execution_update | `CUSTOM` (PI_TOOL_EXECUTION_UPDATE) |
| compaction_start | `STATE_SNAPSHOT` (compacting) |
| compaction_end | `STATE_SNAPSHOT` (ready) |

---

## 3.5 Agent 循环（Agent Loop）— Pi SDK 内置

### 3.5.1 核心变更

Agent Loop 由 Pi SDK 的 `pi-agent-core` 包内置提供，**不再自建**。

Pi SDK Agent Loop 已包含：
- LLM → tool_call → 工具执行 → LLM 循环
- `toolExecution: 'parallel' | 'sequential'` 并行/串行执行模式
- `maxTurns` 最大迭代控制
- `beforeToolCall` / `afterToolCall` 钩子
- `steer()` / `followUp()` 中途引导
- 错误恢复和重试
- `validateToolCall` 工具参数校验

### 3.5.2 我们的定制点

通过 `createAgentSession` 的钩子注入定制逻辑：

```typescript
// agent-server/src/agents/pi-session.ts

const { session } = await createAgentSession({
  authStorage,
  modelRegistry,
  sessionManager,
  resourceLoader,
  getApiKey,                    // Electron safeStorage 回调

  toolExecution: 'parallel',    // 并行执行多 tool_call

  // Gate 权限控制：工具执行前检查
  beforeToolCall: async ({ toolCall, args, context }) => {
    const gateResult = gate.check(toolCall.name, args)
    if (!gateResult.allowed) {
      if (gateResult.needsConfirmation) {
        // 通过 WebSocket 推送确认请求，等待用户响应
        const confirmed = await waitForConfirmation(toolCall, args)
        if (!confirmed) throw new AppError({ code: 'GATE_DENIED' })
      } else {
        throw new AppError({ code: 'GATE_DENIED' })
      }
    }
  },

  // 工具执行后：EventBus 事件 + Evidence 追踪
  afterToolCall: async ({ toolCall, result, isError, context }) => {
    eventBus.emit('tool:executed', { toolCall, result, isError })
    if (!isError) evidenceLedger.record(toolCall, result)
  },
})
```

### 3.5.3 Storm Breaker 集成

Storm Breaker 通过 `afterToolCall` 钩子实现：

```typescript
afterToolCall: async ({ toolCall, result, isError }) => {
  if (isError) {
    stormBreaker.record(toolCall.name, result)
    if (stormBreaker.isStuck(toolCall.name)) {
      // 通过 steer() 注入指令要求改变策略
      session.steer('你已连续 3 次在相同工具上失败，请改变策略或向用户求助。')
    }
  }
}
```

---

## 3.6 结构化输出（JSON Mode）

### 3.6.1 两个参考项目的实现对比

**openhanako**：用 **Structured Output Tool** 模式。
- 创建一个名为 `structured_output` 的特殊工具，其 `parameters` 就是用户提供的 JSON Schema
- 在 prompt 中追加"完成后必须调用 structured_output 工具"
- Agent 通过 tool_call 返回结构化结果，`getResult()` 取出
- 不做深度 schema 校验（MVP），依赖 LLM 被 schema 约束

**DeepSeek-Reasonix**：用 **Provider 原生 tool_use** 模式。
- 不使用 `response_format: { type: "json_object" }` 或 `json_schema`
- 所有结构化输出都通过 tool_call 的 `input` 字段返回（天然 JSON）
- `schema_canonicalize.go` 对工具参数 schema 做标准化：排序 `required`、清理无效字段、空 schema 补 `{"type":"object"}`
- Anthropic 用 `tool_use` content block，OpenAI 用 `function` 格式

### 3.6.2 pi-agent 的策略

采用 **Provider 原生 tool_use + Structured Output Tool 补充** 双模式：

| 模式 | 用途 | 实现 |
|------|------|------|
| **原生 tool_use** | Agent 日常工具调用 | Pi SDK 自动处理，参数天然 JSON |
| **Structured Output Tool** | Subagent / Workflow 需要返回结构化结果时 | 参考 openhanako，注入 `structured_output` 工具 |

### 3.6.3 Schema 标准化

工具参数 schema 在发送给 Provider 前必须标准化，确保缓存一致性：

```typescript
// core/llm/schema-canonicalize.ts

function canonicalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  // 1. 排序 required 数组（防注册顺序变化导致 toolsHash 变化）
  if (Array.isArray(schema.required)) {
    schema.required = [...schema.required].sort()
  }

  // 2. 清理无效字段（如 OpenAPI 风格的 required: true → 删除）
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    delete schema.required
  }

  // 3. 空 schema 补 {"type":"object"}
  if (!schema || Object.keys(schema).length === 0) {
    return { type: 'object', properties: {} }
  }

  // 4. 递归处理 properties / $defs / definitions
  if (schema.properties) canonicalizeNamedSchemas(schema.properties)
  if (schema.$defs) canonicalizeNamedSchemas(schema.$defs)
  if (schema.definitions) canonicalizeNamedSchemas(schema.definitions)

  return schema
}
```

### 3.6.4 Structured Output Tool

```typescript
// core/tool/structured-output.ts

function createStructuredOutputTool(schema: Record<string, unknown>) {
  let captured: unknown

  const tool: Tool = {
    name: 'structured_output',
    description: '返回严格符合所需 schema 的结构化结果。完成任务后必须调用一次。',
    parameters: schema,
    async execute(_toolCallId, params) {
      captured = params
      return { output: '结果已记录', isError: false }
    },
  }

  return {
    tool,
    getResult() { return captured },
  }
}
```

在 Subagent 派遣时使用：

```typescript
// subagent 工具内部
const structured = createStructuredOutputTool(opts.schema)
const extraTools = [...baseTools, structured.tool]
const prompt = task + '\n\n完成后必须调用一次 structured_output 工具，返回严格符合所需 schema 的结果。'

const result = await agentManager.dispatchToAgent(agentId, prompt, { extraTools })
return structured.getResult() ?? result
```

---

## 3.6 流式解析器链

### 3.6.1 问题背景

LLM 的流式输出中可能包含结构化标签（thinking 块、情绪标记、卡片数据等），
需要在流式传输过程中实时解析，而不是等完整响应后再处理。

### 3.6.2 设计

参考 openhanako 的 `events.js`，采用三级解析器链：

```
LLM 原始输出流
  │
  ▼
┌─────────────────┐
│ ThinkTagParser  │  解析 <thinking>...</thinking> 标签
│                 │  → 提取推理过程，标记为 thinking 类型
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ MoodParser      │  解析 <mood>...</mood> 标签
│                 │  → 提取 Agent 情绪状态（用于 UI 展示）
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ CardParser      │  解析 <card>...</card> 标签
│                 │  → 提取结构化卡片数据（用于 UI 渲染）
└────────┬────────┘
         │
         ▼
  纯文本内容 → AG-UI TEXT_MESSAGE_CONTENT 事件
```

### 3.6.3 解析器接口

```typescript
interface StreamParser {
  /** 处理一块原始文本，返回解析出的事件和剩余未消费文本 */
  feed(chunk: string): { events: ParsedEvent[]; remainder: string }
  /** 流结束时，刷新缓冲区 */
  flush(): ParsedEvent[]
}

interface ParsedEvent {
  type: 'text' | 'thinking' | 'mood' | 'card'
  content: string
  metadata?: Record<string, unknown>
}
```

### 3.6.4 与 AG-UI 适配器的关系

解析器链位于 Pi SDK 输出和 AG-UI 适配器之间：

```
Pi SDK 流式输出 → 解析器链 → AG-UI 适配器 → SSE 事件
```

解析出的 thinking 块映射为 AG-UI 的自定义事件（`THINKING_START` / `THINKING_CONTENT` / `THINKING_END`），
mood/card 映射为 WebSocket 推送事件。

---

## 3.8 端到端数据流图

用户发送消息到 Agent 回复的完整数据流：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Renderer (React)                                                            │
│                                                                              │
│  用户输入 "帮我重构这个函数"                                                   │
│       │                                                                      │
│       ▼                                                                      │
│  POST /ag-ui/agent/:id/run ───────────────────────────────────────────┐    │
│       │                                                                │    │
│       │ SSE 连接建立                                                    │    │
│       ◄───────────────────────────────────────────────────────────── │    │
│       │                                                                │    │
│       │  RUN_STARTED                                                   │    │
│       │  TEXT_MESSAGE_START                                             │    │
│       │  TEXT_MESSAGE_CONTENT (×N)  ←── 流式输出                        │    │
│       │  TOOL_CALL_START                                                │    │
│       │  TOOL_CALL_ARGS                                                 │    │
│       │  TOOL_CALL_END                                                  │    │
│       │  ... (可能多轮 tool_call)                                        │    │
│       │  TEXT_MESSAGE_START (续)                                         │    │
│       │  TEXT_MESSAGE_CONTENT (×N)                                      │    │
│       │  RUN_FINISHED                                                   │    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ agent-server (Fastify)                                                      │
│                                                                              │
│  agui.route.ts → PiAgUiAgent.streamRun()                                    │
│       │                                                                      │
│       ▼                                                                      │
│  Pi SDK (createAgentSession)                                                 │
│       │                                                                      │
│       ├── 1. DefaultResourceLoader                                           │
│       │      ├── AGENTS.md / Skills / Prompt Templates                       │
│       │      ├── systemPromptOverride → 混合拼装 + token 预算                │
│       │      └── InstructionLoader → 项目级指令                              │
│       │                                                                      │
│       ├── 2. Agent Loop (Pi SDK 内置)                                        │
│       │      ├── session.prompt(userMessage)                                 │
│       │      ├── Pi SDK Provider 适配 (pi-ai)                                │
│       │      ├── OutboundProxy.getAgentForUrl()                              │
│       │      └── 流式响应 → subscribe() → StreamEmitter → AG-UI 事件 → SSE  │
│       │                                                                      │
│       ├── 3. 工具执行 (Pi SDK 内置)                                          │
│       │      ├── beforeToolCall → Gate.check() 权限检查                      │
│       │      │    └── needs_confirmation → WebSocket 推送 → 等待用户确认     │
│       │      ├── 内置工具: read/bash/edit/write/grep/find/ls                 │
│       │      ├── Extensions: web_search/web_fetch (自建)                     │
│       │      ├── SearchRateLimiter.acquire() (搜索工具)                      │
│       │      └── afterToolCall → EventBus + Evidence Ledger                 │
│       │                                                                      │
│       ├── 4. 循环控制 (Pi SDK 内置)                                          │
│       │      ├── maxTurns 检查                                               │
│       │      ├── AbortSignal 检查                                            │
│       │      ├── Storm Breaker (afterToolCall 钩子)                          │
│       │      └── steer/followUp (Pi SDK 内置中途引导)                        │
│       │                                                                      │
│       └── 5. 完成后                                                           │
│              ├── UsageLedger.record() → eventBus.emit('llm:call_complete')  │
│              ├── Pi SDK autoCompaction → 自动压缩（如需要）                  │
│              └── MemoryTicker.onTurnComplete() → 检查是否需要编译记忆        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Prompt 拼装：混合模式

### 4.1 三层拼装

```
┌─────────────────────────────────────────────────┐
│ System Prompt                                    │
│                                                  │
│  ┌────────────────────────────────────────────┐ │
│  │ 1. 代码生成（不可编辑）                      │ │
│  │    - 工具使用纪律                           │ │
│  │    - 安全规则                               │ │
│  │    - 输出格式约束                           │ │
│  │    - 当前时间 / cwd 注入                    │ │
│  └────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────┐ │
│  │ 2. 模板文件（可编辑）                        │ │
│  │    - identity.md    → Agent 身份            │ │
│  │    - personality.md → 人格描述              │ │
│  │    - user.md        → 用户档案              │ │
│  └────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────┐ │
│  │ 3. 动态注入（运行时）                        │ │
│  │    - 记忆块（memory.md）                    │ │
│  │    - 工具列表（Tool schema）                │ │
│  │    - 置顶记忆（pinned.md）                  │ │
│  └────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### 4.2 拼装顺序（缓存优化，参考 openhanako + DeepSeek-Reasonix）

静态前缀在前、动态尾部在后，最大化 LLM 的 prefix cache 命中率。

**关键原则**（来自 DeepSeek-Reasonix 的 `PrefixShape` 诊断）：
- system prompt 和 tools schema 构成缓存前缀，任何变化都会导致 cache miss
- 动态内容（记忆、时间）放在 system prompt 末尾，变化时只影响尾部
- tools schema 按名称排序注册，避免注册顺序变化导致 `toolsHash` 变化

```
┌─────────────────────────────────────────────────────┐
│ System Prompt（缓存前缀，尽量不变）                    │
│                                                     │
│  1. 平台声明（代码生成）              ← 永不变        │
│  2. 执行环境（代码生成）              ← 永不变        │
│  3. 行为指南：工具纪律 / 安全（代码生成）← 永不变     │
│                                                     │
│  ── cache 分界线 ──────────────────────────────────  │
│                                                     │
│  4. 用户档案（模板文件）              ← 很少变        │
│  5. Agent 身份 + 人格（模板文件）     ← 很少变        │
│  6. 工作台 / cwd（动态注入）          ← 切换时变      │
│  7. 记忆规则 + 置顶记忆 + 记忆（动态）← 编译时变      │
│  8. 当前时间（动态注入）              ← 每轮变        │
└─────────────────────────────────────────────────────┘

Tools Schema（缓存前缀，按名称排序注册）
  - 注册顺序固定 → toolsHash 不变
  - Plan mode 切换不改 tools → 不破缓存
```

### 4.3 System Prompt Token 预算

System prompt 各区域有 token 预算上限，防止某个区域膨胀导致 context window 被占满：

```typescript
// core/agent/prompt-budget.ts

const PROMPT_BUDGETS = {
  // 区域 → token 预算（估算，1 token ≈ 4 chars）
  codegenRules: 2000,       // 代码生成规则（不可编辑，固定大小）
  templates: 1000,          // 模板文件（identity + personality + user）
  projectInstructions: 1500, // 项目指令（.pi-instructions.md 等）
  memory: 3000,             // 记忆块（pinned + today + week + longterm）
  dynamicContext: 500,      // 动态注入（时间 / cwd / 工作台）
  toolsSchema: 4000,        // 工具列表（按工具数量动态调整）

  // 总 system prompt 预算
  totalSystemMax: 12000,    // 超过此值时截断尾部区域
}

function enforceBudget(sections: PromptSection[]): PromptSection[] {
  let total = 0
  const result: PromptSection[] = []

  for (const section of sections) {
    const budget = PROMPT_BUDGETS[section.id] ?? Infinity
    const tokens = estimateTokens(section.content)

    if (total + tokens > budget) {
      // 截断到预算内
      const allowed = budget - (total > budget ? 0 : total - (total - tokens))
      section.content = truncateToTokens(section.content, Math.max(0, budget - total))
      section.truncated = true
    }

    total += estimateTokens(section.content)
    if (total >= PROMPT_BUDGETS.totalSystemMax) break
    result.push(section)
  }

  return result
}
```

**截断优先级**：代码生成规则 > 模板文件 > 项目指令 > 动态上下文 > 记忆（记忆最重要，放最后可保证不被前面的区域挤掉）。

**缓存影响分析**：

| 变化类型 | 影响范围 | 缓存 miss 原因 |
|----------|----------|---------------|
| 用户发消息 | 追加消息 | append-only，前缀不变，cache 命中 |
| 工具执行 | 追加 tool result | append-only，cache 命中 |
| Plan mode 切换 | 无变化 | 不改 prompt/tools，execute 时拒绝 |
| 记忆编译 | system prompt 尾部 | 只影响尾部，前缀 cache 命中 |
| Compaction | 重写历史 | `logRewriteVersion` 变化，全量 miss |
| Agent 切换 | system + tools 都变 | `systemHash` + `toolsHash` 都变 |

---

## 5. 工具系统：Pi SDK 内置 + Extensions 扩展

### 5.1 架构

Pi SDK 内置完整的工具系统，我们通过 Extensions 机制扩展自定义工具：

```
┌──────────────────────────────────────────────────┐
│ Pi SDK 工具系统                                    │
│                                                   │
│  内置工具（pi-coding-agent 默认提供）：            │
│  ├── read      读取文件                           │
│  ├── bash      执行命令                           │
│  ├── edit      编辑文件（搜索替换）                │
│  ├── write     写入文件                           │
│  ├── grep      搜索文件内容                       │
│  ├── find      查找文件                           │
│  └── ls        列出目录                           │
│                                                   │
│  Extensions（自建，通过 Pi SDK Extensions API）：  │
│  ├── web_search   搜索互联网                      │
│  ├── web_fetch    抓取网页内容                     │
│  ├── memory_search 搜索记忆                       │
│  └── ... (后续扩展)                               │
│                                                   │
│  钩子（beforeToolCall / afterToolCall）：          │
│  ├── Gate 权限检查                                │
│  ├── SearchRateLimiter 搜索限流                   │
│  ├── Evidence Ledger 任务验证                     │
│  └── EventBus 事件发布                            │
└──────────────────────────────────────────────────┘
```

### 5.2 Pi SDK Extensions API

Pi SDK 通过 Extensions 机制注册自定义工具：

```typescript
// agent-server/src/extensions/web-search.ts

import { Extension } from '@earendil-works/pi-coding-agent'

export const webSearchExtension: Extension = {
  name: 'web-search',
  tools: [
    {
      name: 'web_search',
      description: '搜索互联网获取信息',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
        },
        required: ['query'],
      },
      execute: async (args, context) => {
        // 搜索实现
      },
    },
    {
      name: 'web_fetch',
      description: '抓取网页内容',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '网页 URL' },
        },
        required: ['url'],
      },
      execute: async (args, context) => {
        // 抓取实现
      },
    },
  ],
}
```

### 5.3 钩子注入

通过 `createAgentSession` 的 `beforeToolCall` / `afterToolCall` 注入定制逻辑：

```typescript
beforeToolCall: async ({ toolCall, args }) => {
  // Gate 权限检查
  const result = gate.check(toolCall.name, args)
  if (!result.allowed) throw new AppError({ code: 'GATE_DENIED' })

  // 搜索限流
  if (['web_search', 'web_fetch'].includes(toolCall.name)) {
    await searchRateLimiter.acquire(toolCall.name)
  }
},

afterToolCall: async ({ toolCall, result, isError }) => {
  // EventBus 事件
  eventBus.emit('tool:executed', { toolCall, result, isError })

  // Evidence 追踪
  if (!isError) evidenceLedger.record(toolCall, result)
},
```

### 5.4 工具开关

Pi SDK 支持 `tools.active` 配置，动态启用/禁用工具：

```typescript
// 通过 AG-UI API 动态切换
POST /ag-ui/agent/:id/tools/active
{ "tools": ["read", "bash", "edit", "write", "web_search"] }
```

---

## 6. 记忆系统

### 6.1 架构

```
┌──────────────────────────────────────────────────┐
│ Agent                                             │
│                                                   │
│  ┌────────────┐  ┌──────────────────┐            │
│  │ FactStore  │  │ SessionSummary   │            │
│  │ (SQLite)   │  │ Manager          │            │
│  │            │  │ (LLM 压缩摘要)    │            │
│  └─────┬──────┘  └────────┬─────────┘            │
│        │                  │                      │
│        └───────┬──────────┘                      │
│                ▼                                  │
│  ┌──────────────────────┐    ┌────────────────┐  │
│  │ MemoryTicker         │───→│ memory.md      │  │
│  │ (定时编译)            │    │ today.md       │  │
│  │                      │    │ week.md        │  │
│  │                      │    │ longterm.md    │  │
│  └──────────────────────┘    └────────────────┘  │
│                │                                  │
│                ▼                                  │
│        buildSystemPrompt()                        │
│        (注入到 System Prompt 末尾)                 │
└──────────────────────────────────────────────────┘
```

### 6.2 组件职责

| 组件 | 职责 | 存储 |
|------|------|------|
| **FactStore** | 存储事实性记忆，支持标签/关键词检索 | sql.js（WASM SQLite，无原生依赖） |
| **SessionSummaryManager** | LLM 驱动的会话摘要压缩 | 文件 (`summaries/*.md`) |
| **MemoryTicker** | 定时触发：编译记忆 → 更新 md 文件 → 刷新 system prompt | 内存调度器 |

### 6.3 记忆检索策略

**无向量搜索**，采用标签/关键词检索 + LLM 注意力机制：

- **显式检索**：`memory_search` 工具，标签匹配 + 关键词搜索
- **隐式检索**：编译后的 `memory.md` 注入 system prompt，LLM 通过注意力自动提取相关记忆
- **记忆量级**：单用户桌面应用，记忆量不会超过关键词检索能力

预留 `MemoryStore` 接口的 `semanticSearch()` 方法，后续可扩展向量搜索。

### 6.3.1 为什么选 sql.js 而非 better-sqlite3

| 维度 | better-sqlite3 | sql.js |
|------|---------------|--------|
| 原生依赖 | 需要 node-gyp + Python + C++ 编译工具链 | 纯 WASM，零原生依赖 |
| Electron 打包 | 需要 electron-rebuild，平台特定二进制 | 单一 .wasm 文件，跨平台 |
| 性能 | 更快（C++ 绑定） | 略慢（WASM），但桌面单用户场景可忽略 |
| 安装体验 | Windows 用户常遇 node-gyp 编译失败 | `pnpm install` 即可 |

**结论**：桌面应用 + Electron 场景下，sql.js 的零原生依赖优势远大于 better-sqlite3 的性能优势。

### 6.3.2 FactStore LRU 缓存

sql.js 是 WASM 实现，每次查询都涉及磁盘 I/O。为减少磁盘读取，在 FactStore 上层加 LRU 缓存：

```typescript
// core/memory/fact-store.ts

import { LRUCache } from 'lru-cache'

class FactStore {
  private cache: LRUCache<string, Fact[]>

  constructor(dbPath: string) {
    this.cache = new LRUCache<string, Fact[]>({
      max: 500,               // 最多缓存 500 条查询结果
      ttl: 5 * 60 * 1000,    // 5 分钟过期
    })
  }

  async searchByTag(tag: string): Promise<Fact[]> {
    const cached = this.cache.get(`tag:${tag}`)
    if (cached) return cached

    const facts = await this.dbQuery('SELECT * FROM facts WHERE tags LIKE ?', [`%${tag}%`])
    this.cache.set(`tag:${tag}`, facts)
    return facts
  }

  async searchByKeyword(keyword: string): Promise<Fact[]> {
    const cached = this.cache.get(`kw:${keyword}`)
    if (cached) return cached

    const facts = await this.dbQuery('SELECT * FROM facts WHERE content LIKE ?', [`%${keyword}%`])
    this.cache.set(`kw:${keyword}`, facts)
    return facts
  }

  /** 写入时清除相关缓存 */
  async addFact(fact: Fact): Promise<void> {
    await this.dbInsert(fact)
    this.cache.clear()  // 简单策略：写入时全清（写入频率低，可接受）
  }
}
```

**缓存策略**：读多写少（记忆编译是低频操作），LRU 缓存命中率预期 > 90%。

### 6.4 Memory Ticker 完整调度逻辑

参考 openhanako 的 `memory-ticker.js`，Memory Ticker 不仅仅是"定时编译"，
而是一个完整的调度系统，包含 turn-based 触发、启动检查、崩溃恢复和步骤健康状态。

#### 6.4.1 触发方式

| 触发方式 | 时机 | 执行内容 |
|----------|------|----------|
| **Turn-based** | 每 N 轮对话（默认 10 轮） | 滚动摘要（compileSession → compileWeek） |
| **启动检查** | 应用启动时 | 检查上次编译时间，超过 24 小时则补执行 compileWeek → compileLongterm → compileFacts → assemble |
| **手动触发** | 用户调用 `memory_compile` 工具 | 完整编译流程 |
| **崩溃恢复** | 启动时检测 `_recoverUnsummarized` | 补执行上次未完成的摘要 |

> **简化说明**：不设独立的"每日定时任务"（如 00:00 触发），改为**启动时检查**。
> 桌面应用不是常驻服务，用户可能每天只开一次，启动时检查更可靠。
> 如果用户长时间不关机，turn-based 触发也会定期编译记忆。

#### 6.4.2 编译流水线

```
每日任务完整流水线：

1. compileSession(sessionId)
   → LLM 压缩当前会话 → summaries/{sid}.md

2. compileWeek()
   → 合并最近 7 天的 session summaries → today.md + week.md

3. compileLongterm()
   → 合并 week.md → longterm.md（长期记忆，保留关键事实）

4. compileFacts()
   → 从 longterm.md 提取结构化事实 → facts.db（标签/关键词索引）

5. assemble()
   → 拼装 memory.md = pinned.md + today.md + week.md + longterm.md

6. deepMemory()
   → LLM 反思验证记忆质量（可选，shadow/write 模式）
```

#### 6.4.3 步骤健康状态

每个编译步骤有独立的健康状态，防止单步失败阻塞整个流水线：

```typescript
type StepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped'

interface TickerStepHealth {
  compileSession: StepStatus
  compileWeek: StepStatus
  compileLongterm: StepStatus
  compileFacts: StepStatus
  assemble: StepStatus
  deepMemory: StepStatus
  lastRunAt: string | null
  lastError: string | null
}
```

失败步骤不影响后续步骤（如 `compileFacts` 失败不影响 `assemble`），
但 `assemble` 会使用上一次成功的结果。

#### 6.4.4 崩溃恢复

```typescript
// 启动时检查
async function recoverFromCrash(): Promise<void> {
  const marker = await this.store.getRecoveryMarker()
  if (!marker) return

  // 上次有未完成的摘要任务
  if (marker.pendingSessionId) {
    await this.compileSession(marker.pendingSessionId)
  }

  // 清理临时文件
  await this.store.clearRecoveryMarker()
}
```

每次编译步骤开始前写入 recovery marker，完成后清除。
启动时检测到 marker 说明上次崩溃，补执行未完成步骤。

---

## 7. 通信协议：SSE + WebSocket

### 7.1 分工

| 通道 | 方向 | 用途 | 协议 |
|------|------|------|------|
| **SSE** | Client → Server (HTTP POST) → SSE 流 | LLM 流式输出、Run 生命周期 | AG-UI |
| **WebSocket** | Server → Client 推送 | 确认请求、状态变更、通知 | 自定义事件 |

### 7.2 SSE（AG-UI 协议）

前端主动发起 `POST /agui/runs`，服务端返回 SSE 流：

```
RUN_STARTED → TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT (×N) → TEXT_MESSAGE_END
→ TOOL_CALL_START → TOOL_CALL_ARGS → TOOL_CALL_END
→ TEXT_MESSAGE_START → ... → RUN_FINISHED
```

### 7.3 WebSocket 事件

```typescript
// 服务端推送事件类型
type WsServerEvent =
  | { type: 'confirmation_request'; confirmId: string; tool: string; params: any }
  | { type: 'memory_updated'; agentId: string }
  | { type: 'agent_status'; agentId: string; status: string }
  | { type: 'notification'; title: string; body: string; agentId?: string }
  | { type: 'devlog'; text: string; level: string }
  | { type: 'plugin_event'; pluginId: string; event: string; data: any }

// 客户端发送事件类型
type WsClientEvent =
  | { type: 'confirm'; confirmId: string; action: 'approve' | 'deny' }
  | { type: 'subscribe'; agentId: string }
```

---

## 7.5 Event Bus（事件总线）

### 7.5.1 问题背景

系统内多个模块需要解耦通信（记忆编译完成 → 通知前端、工具执行 → 推送确认请求、
LLM 调用完成 → 更新 Usage），直接互相引用会导致循环依赖。

### 7.5.2 设计

```typescript
// lib/event-bus.ts

type EventHandler = (...args: any[]) => void

class EventBus {
  private handlers = new Map<string, Set<EventHandler>>()

  on(event: string, handler: EventHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    this.handlers.get(event)!.add(handler)

    // 返回取消订阅函数
    return () => this.handlers.get(event)?.delete(handler)
  }

  once(event: string, handler: EventHandler): () => void {
    const wrapper = (...args: any[]) => {
      unsub()
      handler(...args)
    }
    const unsub = this.on(event, wrapper)
    return unsub
  }

  emit(event: string, ...args: any[]): void {
    this.handlers.get(event)?.forEach(h => {
      try { h(...args) } catch (err) {
        logger.error(`event handler error on "${event}":`, err)
      }
    })
  }

  removeAllForEvent(event: string): void {
    this.handlers.delete(event)
  }
}
```

### 7.5.3 核心事件定义

| 事件 | 发布者 | 订阅者 | 用途 |
|------|--------|--------|------|
| `llm:call_complete` | LLMService | UsageLedger, SessionCoordinator | LLM 调用完成（含 token 用量） |
| `llm:call_error` | LLMService | UsageLedger, MidTurnSteerer | LLM 调用失败 |
| `memory:compiled` | MemoryTicker | WebSocket 推送 | 记忆编译完成 |
| `memory:compile_failed` | MemoryTicker | WebSocket 推送, DevLog | 记忆编译失败 |
| `tool:confirmation_request` | GateWrapper | WebSocket 推送 | 工具需要用户确认 |
| `tool:confirmation_response` | WebSocket handler | GateWrapper | 用户确认/拒绝 |
| `session:compacted` | SessionCoordinator | WebSocket 推送 | 会话压缩完成 |
| `session:health_check` | SessionHealth | WebSocket 推送 | 会话健康状态变更 |
| `agent:status_change` | AgentManager | WebSocket 推送 | Agent 状态变更 |
| `plugin:loaded` | PluginManager | DevLog | 插件加载 |
| `cron:job_executed` | CronScheduler | WebSocket 推送 | 定时任务执行完成 |

### 7.5.4 与 WebSocket 推送的关系

EventBus 是进程内事件总线，WebSocket 是跨进程推送通道。两者关系：

```
模块 A → eventBus.emit('xxx') → WebSocket handler → ws.send() → Renderer
```

WebSocket handler 订阅 EventBus 事件，转发给前端。模块只依赖 EventBus，不直接依赖 WebSocket。

### 7.5.5 注册为 Fastify 插件

```typescript
// lib/event-bus.plugin.ts

export const eventBusPlugin: FastifyPluginAsync = async (app) => {
  const bus = new EventBus()
  app.decorate('eventBus', bus)
  app.addHook('onClose', () => bus.removeAllForEvent('*'))
}
```

---

## 8. 三层配置管理

### 8.1 配置层级

**核心原则：LLM 配置不是写死的，而是通过页面动态配置，持久化到本地文件。**

```
Global (preferences.yaml)
  ├── 搜索配置
  ├── 沙盒开关
  ├── 语言 / 主题
  └── 插件全局配置

Provider 注册表 (providers.yaml)          ← 独立文件，页面动态管理
  ├── Provider 列表
  │   ├── {providerId}:
  │   │   ├── name: "OpenAI"
  │   │   ├── api: "openai-completions"
  │   │   ├── baseUrl: "https://api.openai.com/v1"
  │   │   └── models: [...]              ← 每个模型的能力声明
  │   └── {providerId}:
  │       ├── name: "Anthropic"
  │       ├── api: "anthropic-messages"
  │       ├── baseUrl: "https://api.anthropic.com"
  │       └── models: [...]
  └── API Key → CredentialStore（不存此文件）

自定义模型 (added-models.yaml)            ← 独立文件，页面动态管理
  └── 用户添加的本地/第三方模型

Agent (agents/{id}/config.yaml)
  ├── 人格名称
  ├── 模型选择（chat / utility / utility_large）← 引用 providers.yaml 中的模型
  ├── providerId                           ← 指定使用哪个 Provider
  ├── 记忆开关
  ├── 工具开关
  ├── home 目录
  └── yuan 类型

Session (agents/{id}/sessions/{sid}/meta.json)
  ├── 当前模型覆盖                          ← 临时切换模型，不持久化到 Agent
  ├── providerId 覆盖                      ← 临时切换 Provider
  ├── 记忆开关覆盖
  ├── cwd
  ├── 权限模式
  └── projectId
```

### 8.2 LLM 动态配置架构

```
┌──────────────────────────────────────────────────────────────┐
│ 前端设置页面                                                  │
│                                                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │ Provider 管理    │  │ 模型管理         │  │ API Key 管理 │ │
│  │ - 添加/删除      │  │ - 添加自定义模型  │  │ - 输入/测试   │ │
│  │ - 编辑 Base URL  │  │ - 声明能力       │  │ - 验证连通性  │ │
│  │ - 选择 API 类型  │  │ - 设置上下文窗口  │  │ - OS Keychain│ │
│  └────────┬────────┘  └────────┬────────┘  └──────┬───────┘ │
│           │                    │                   │         │
│           └────────────────────┼───────────────────┘         │
│                                │ IPC (安全敏感操作)            │
└────────────────────────────────┼─────────────────────────────┘
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│ Electron Main Process                                        │
│                                                              │
│  1. 接收前端配置请求                                          │
│  2. 验证 API Key 连通性（调用 Provider 的 /models 端点）      │
│  3. 写入 providers.yaml / added-models.yaml                  │
│  4. API Key → CredentialStore                                │
│  5. 通知 agent-server 刷新 ProviderRegistry                  │
└──────────────────────────────────────────────────────────────┘
                                 │
                                 │ HTTP POST /api/config/refresh
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│ agent-server                                                 │
│                                                              │
│  ProviderRegistry.refresh()                                  │
│  → 重新加载 providers.yaml + added-models.yaml               │
│  → 重新生成 models.json 投影                                 │
│  → 下次 LLM 调用使用新配置                                   │
└──────────────────────────────────────────────────────────────┘
```

### 8.3 Provider 配置 API

```typescript
// 前端 → Main Process (IPC)
interface ProviderConfigAPI {
  // Provider CRUD
  listProviders(): ProviderConfig[]
  addProvider(provider: Omit<ProviderConfig, 'id'>): ProviderConfig
  updateProvider(id: string, patch: Partial<ProviderConfig>): ProviderConfig
  deleteProvider(id: string): void

  // API Key 管理
  setApiKey(providerId: string, apiKey: string): Promise<void>
  deleteApiKey(providerId: string): Promise<void>
  testApiKey(providerId: string): Promise<{ ok: boolean; models?: string[]; error?: string }>

  // 自定义模型
  addCustomModel(model: CustomModelConfig): void
  removeCustomModel(modelId: string): void

  // 刷新
  refreshProviders(): Promise<void>  // 通知 agent-server 重新加载
}
```

### 8.4 API Key 连通性验证

添加/修改 Provider 时，自动验证 API Key 是否有效：

```typescript
async function testApiKey(provider: ProviderConfig, apiKey: string): Promise<TestResult> {
  try {
    const response = await fetch(`${provider.baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (response.ok) {
      const data = await response.json()
      return { ok: true, models: data.data?.map((m: any) => m.id) ?? [] }
    }
    return { ok: false, error: `HTTP ${response.status}` }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
```

### 8.5 合并策略

```
最终值 = Session 覆盖 ?? Agent 覆盖 ?? Global 默认值
```

缺失时向上查找，Session 级配置不持久化到 Agent 级。

### 8.6 数据目录

```
{appData}/pi-agent/           # app.getPath('userData')
  ├── preferences.yaml        # Global 配置
  ├── user/user.md            # 用户档案
  ├── providers.yaml          # Provider 注册
  ├── added-models.yaml       # 自定义模型
  ├── agents/
  │   └── {agentId}/
  │       ├── config.yaml     # Agent 配置
  │       ├── identity.md     # Agent 身份模板
  │       ├── personality.md  # Agent 人格模板
  │       ├── pinned.md       # 置顶记忆
  │       ├── memory/
  │       │   ├── facts.db    # SQLite 事实存储
  │       │   ├── memory.md   # 编译后记忆
  │       │   ├── today.md
  │       │   ├── week.md
  │       │   ├── longterm.md
  │       │   └── summaries/  # 会话摘要
  │       └── sessions/
  │           └── {sid}.jsonl # 会话消息
  ├── plugins/                # 用户插件
  ├── skills/                 # 技能目录
  └── channels/               # 频道数据
```

---

## 9. 多 Agent 协作

### 9.1 协作方式

| 方式 | 描述 | 场景 |
|------|------|------|
| **手动切换** | 用户在 UI 上切换活跃 Agent | 不同专长的 Agent 日常使用 |
| **Subagent 派遣** | 主 Agent 通过 `subagent` 工具派遣子任务 | 需要其他 Agent 专长时 |
| **频道通信** | 多 Agent 在频道中异步交流 | 团队协作场景 |
| **私信 (DM)** | Agent 之间一对一通信 | 定向请求协助 |

### 9.2 Subagent 生命周期

```
主 Agent 调用 subagent(agentId, task)
  → AgentManager 创建隔离 Session
  → 子 Agent 执行任务（独立工具循环）
  → 返回结果给主 Agent
  → 可选：subagent_reply(threadId, task) 续接
  → 可选：subagent_close(threadId) 关闭
```

### 9.3 AgentManager

```typescript
class AgentManager {
  agents: Map<string, Agent>           // 所有 Agent 实例
  activeAgentId: string                // 当前活跃 Agent

  getAgent(agentId: string): Agent
  createAgent(opts: CreateAgentOpts): Promise<Agent>
  switchAgent(agentId: string): Promise<void>
  deleteAgent(agentId: string): Promise<void>
  ensureAgentRuntime(agentId: string): Promise<Agent>
}
```

---

## 9.5 并发限流器（Concurrency Limiter）

### 9.5.1 问题背景

多 Agent 协作中，subagent 可能无限制地派遣子任务，导致：
- LLM API 费用失控
- 系统资源耗尽
- 上下文窗口被撑爆

参考 openhanako 的 `concurrency.js`，需要硬性 backstop 限制。

### 9.5.2 设计

```typescript
// core/agent/concurrency-limiter.ts

interface ConcurrencyLimits {
  maxSubagents: number          // 同时运行的 subagent 上限（默认 3）
  maxTotalSubagents: number     // 单次主任务的总 subagent 上限（默认 10）
  maxSubagentDepth: number      // subagent 嵌套深度上限（默认 2）
}

class ConcurrencyLimiter {
  private activeCount = 0
  private totalCount = 0
  private queue: Array<() => void> = []

  constructor(private limits: ConcurrencyLimits) {}

  async acquire(depth: number): Promise<ReleaseFunction> {
    if (depth > this.limits.maxSubagentDepth) {
      throw new AppError({
        code: 'SUBAGENT_DEPTH_EXCEEDED',
        severity: 'degraded',
        message: `subagent nesting depth ${depth} exceeds limit ${this.limits.maxSubagentDepth}`,
      })
    }
    if (this.totalCount >= this.limits.maxTotalSubagents) {
      throw new AppError({
        code: 'SUBAGENT_TOTAL_EXCEEDED',
        severity: 'degraded',
        message: `total subagent count ${this.totalCount} exceeds limit ${this.limits.maxTotalSubagents}`,
      })
    }

    if (this.activeCount >= this.limits.maxSubagents) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }

    this.activeCount++
    this.totalCount++

    let released = false
    return () => {
      if (released) return
      released = true
      this.activeCount--
      if (this.queue.length > 0) {
        this.queue.shift()!()
      }
    }
  }
}
```

### 9.5.3 与 Subagent 的集成

```typescript
// subagent 工具内部
const release = await this.concurrencyLimiter.acquire(depth)
try {
  const result = await agentManager.dispatchToAgent(agentId, task, { signal })
  return result
} finally {
  release()
}
```

---

## 10. 插件系统

### 10.1 插件能力

| 能力 | API | 说明 |
|------|-----|------|
| 注册工具 | `registerTool(tool)` | 给 Agent 添加新能力 |
| 注册路由 | `registerRoute(route)` | 暴露 HTTP/WebSocket 端点 |
| 监听事件 | `onEvent(type, handler)` | 响应系统事件 |
| 注册 UI 面板 | `registerPanel(panel)` | 在前端显示自定义面板 |

### 10.2 插件生命周期

```
扫描 (scan) → 加载 (load) → 启用 (enable) → 运行 (running)
                                              ↓
                           禁用 (disable) ← 卸载 (unload)
```

### 10.3 插件 SDK（参考 openhanako）

```typescript
// packages/plugin-sdk/src/index.ts
interface PluginSDK {
  // 通信
  postMessage(type: string, data: any): void
  onMessage(type: string, handler: (data: any) => void): void

  // 注册
  registerTool(tool: ToolDefinition): void
  registerRoute(route: RouteDefinition): void
  onEvent(type: string, handler: EventHandler): void
  registerPanel(panel: PanelDefinition): void

  // 宿主信息
  getAgentInfo(): AgentInfo
  getTheme(): ThemeInfo
}
```

---

## 11. 权限模式

### 11.1 三档权限

| 模式 | 读操作 | 写操作 | Shell | 说明 |
|------|--------|--------|-------|------|
| **Auto** | 自动 | 危险操作弹确认 | 弹确认 | 默认模式 |
| **Plan** | 自动 | 先输出计划，用户确认后执行 | 先输出计划 | 审慎模式 |
| **Read-only** | 自动 | 禁止 | 禁止 | 安全模式 |

### 11.2 工具风险分级

```typescript
type ToolRiskLevel = 'safe' | 'moderate' | 'dangerous'

// safe: read_file, list_directory, memory_search
// moderate: write_file, edit_file, web_fetch
// dangerous: shell, delete_file, web_search (可能触发 API 费用)
```

### 11.3 确认机制

```
Agent 调用危险工具
  → Tool 暂停执行，发送 confirmation_request (WebSocket)
  → 前端展示确认对话框
  → 用户 approve/deny (WebSocket)
  → Tool 继续执行或返回错误
```

---

## 12. 数据迁移系统

### 12.1 问题背景

用户数据格式会随版本迭代变更（配置字段重命名、目录结构迁移、模型引用格式变更等）。
openhanako 已有 37 条迁移记录，证明迁移系统是**必须有的基础设施**。

没有迁移系统，任何数据格式变更都会破坏用户数据，导致启动失败或运行时异常。

### 12.2 设计

```typescript
// core/migration/migration-runner.ts

interface MigrationContext {
  dataDir: string           // {appData}/pi-agent
  agentsDir: string         // {dataDir}/agents
  prefs: PreferencesStore   // Global 配置读写
  providerRegistry: ProviderRegistry
  log: (msg: string) => void
}

type MigrationFn = (ctx: MigrationContext) => void

// 迁移表：key 为递增整数版本号
const migrations: Record<number, MigrationFn> = {
  // 示例：#1 — 清理悬空 provider 引用
  1: cleanDanglingProviderRefs,
  // 示例：#2 — 模型引用从裸 id 迁移为 {id, provider} 复合键
  2: migrateModelRefsToCompositeKey,
}

function runMigrations(ctx: MigrationContext): void {
  const preferences = ctx.prefs.getPreferences()
  const currentVersion = preferences._dataVersion ?? 0

  const pending = Object.keys(migrations)
    .map(Number)
    .filter(v => v > currentVersion)
    .sort((a, b) => a - b)

  if (!pending.length) return

  for (const v of pending) {
    try {
      migrations[v](ctx)
      // 每跑完一条就持久化版本号，防中途崩溃导致重跑
      const fresh = ctx.prefs.getPreferences()
      fresh._dataVersion = v
      ctx.prefs.savePreferences(fresh)
    } catch (err) {
      // 失败则停在当前版本，不继续后续迁移
      break
    }
  }
}
```

### 12.3 迁移原则

- **幂等**：同一条迁移多次执行结果一致
- **容错**：失败停在当前版本，不阻塞启动
- **增量**：每条迁移完成后立即持久化 `_dataVersion`，防崩溃重跑
- **原子写入**：所有文件操作用 `atomicWriteSync`（写 tmp → rename）
- **不删旧字段**：迁移只补新字段/重命名，旧字段保留一段时间后在下个迁移中清理

### 12.4 触发时机

agent-server 启动时，在所有 Service 初始化之前执行 `runMigrations()`。

---

## 13. Session Compaction（上下文溢出处理）

> **重要更新**：Pi SDK (`pi-coding-agent`) 内置了 Session Compaction 功能，包括
> `autoCompaction` 自动压缩、手动 `compact()` API、三级阈值控制。
> 本节描述的 Compaction 设计原则（append-only + 低频压缩 + 前缀稳定 + 诊断归因）
> 仍然有效，Pi SDK 的实现遵循了相同的原则。
>
> **我们的工作**：不再自建 Compaction 引擎，而是：
> 1. 使用 Pi SDK 内置的 `autoCompaction` 配置
> 2. 通过 `POST /ag-ui/agent/:id/compact` 暴露手动压缩 API
> 3. 通过 `compaction_start` / `compaction_end` 事件通知前端
> 4. 保留本节描述的 kept/fold 分区策略和 PrefixShape 诊断作为理解参考

### 13.1 问题背景

对话超过 LLM context window 时，每次发消息都会因 context overflow 报错，
导致会话"卡死"——反复写入 error → 反复失败。

### 13.2 核心原则（参考 DeepSeek-Reasonix）

DeepSeek-Reasonix 的缓存策略核心是 **"append-only + 低频压缩"**：

1. **Append-Only 增长**：正常对话中，消息只追加不修改，前缀完全不变，Provider 端的 prompt cache 持续命中
2. **低频压缩**：只在 prompt 达到 context window 的 80% 时才触发压缩，而非每轮都重写
3. **前缀稳定**：system prompt + tools schema 在 plan mode 切换时不变，切换不破缓存
4. **诊断归因**：每次 LLM 调用后比较前缀 SHA，精确诊断缓存 miss 的原因

### 13.3 设计

```
┌──────────────────────────────────────────────────────────────────┐
│ Session Compaction 流程（参考 DeepSeek-Reasonix）                  │
│                                                                  │
│  ┌─ 正常对话（append-only，高缓存命中）──────────────────────┐    │
│  │  消息只追加，前缀不变 → Provider prompt cache 持续命中     │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─ 50% 软阈值 ──────────────────────────────────────────────┐    │
│  │  报告 context 增长，但不压缩（压缩会破缓存，不值得）        │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─ 80% 硬阈值 ──────────────────────────────────────────────┐    │
│  │  1. 先 Prune：elide 过期 tool result（免费，不调 LLM）      │    │
│  │  2. Prune 后仍超阈值 → 触发 Compaction                     │    │
│  │  3. 分区：kept（用户事实 + 旧摘要）vs fold（可压缩部分）    │    │
│  │  4. LLM 摘要 fold 部分 → 替换中间历史                      │    │
│  │  5. 保留 pinned prefix + recent tail verbatim               │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─ 90% 强制阈值 ────────────────────────────────────────────┐    │
│  │  跳过 fold-economics 检查，强制压缩                         │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─ 连续压缩检测 ────────────────────────────────────────────┐    │
│  │  如果压缩后下一轮又触发压缩 → context window 太小           │    │
│  │  暂停自动压缩，通知用户                                      │    │
│  └────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

### 13.4 三级阈值

```typescript
const COMPACT_THRESHOLDS = {
  softRatio: 0.5,       // 报告 context 增长，不压缩
  compactRatio: 0.8,    // 触发压缩
  forceRatio: 0.9,      // 强制压缩（跳过经济性检查）
  tailTokens: 16384,    // verbatim recent-tail 预算（token）
  minRecentKeep: 2,     // 最少保留的最近消息数
}
```

### 13.5 Prune → Compact 两阶段

**阶段 1：Prune（免费，不调 LLM）**

过期的 tool result 可以重新执行获取，直接 elide 不需要摘要：

```typescript
// 过期 tool result → 替换为 "[elided tool result — {name}, {n} bytes dropped]"
// 条件：tool result > 1024 bytes + 不在 recent tail 内 + 不是 error/blocked
function pruneStaleToolResults(session: Session): PruneStats
```

Prune 后如果 token 降到阈值以下，跳过 Compaction，**保留缓存前缀**。

**阶段 2：Compact（调 LLM 摘要）**

```
Session 消息布局：
  [system] [pinned prefix] [compactable region] [recent tail]
                           ↑                     ↑
                           head                  start
                           └─── fold 这部分 ─────┘

pinned prefix = system prompt + 首条用户消息（如足够小）+ 历史摘要
recent tail = 最近 N 条消息（token 预算内，verbatim 保留）
compactable region = 中间可压缩部分
```

### 13.6 分区策略：kept vs fold

参考 DeepSeek-Reasonix 的 `partitionFold`，将 compactable region 分为：

| 类型 | 保留（kept） | 压缩（fold） |
|------|-------------|-------------|
| **用户消息** | 小消息 verbatim 保留（用户事实永不摘要化） | 大消息（粘贴内容）fold |
| **历史摘要** | verbatim 保留（旧摘要不再重摘要，防事实漂移） | — |
| **错误消息** | KeepErrors 策略保留 | — |
| **用户标记** | `[keep]` / `[[keep]]` 标记的消息保留 | — |
| **Assistant + Tool** | — | fold（工具参数只保留 key 列表，不保留完整参数） |
| **tool_call 配对** | kept 的 tool result 自动保留其 caller | 孤儿 tool result 不单独保留 |

### 13.7 摘要格式（参考 DeepSeek-Reasonix）

```markdown
## Standing facts & constraints
用户声明的所有持久约束 — 名称、路径、ID、版本、偏好、硬性规则。原话保留，宁可多不可少。

## Goal
用户的请求和意图。

## Decisions & rationale
已做出的关键选择及原因 — 避免重新争论。

## Files & code
读取或修改的文件，关键事实：签名、行号、数据结构、具体编辑。

## Commands & outcomes
运行的命令（构建、测试、git）及相关结果。

## Errors & fixes
遇到的问题及解决方式（或未解决），避免重复死路。

## Pending & next step
仍在进行或未开始的工作，以及最具体的下一步行动。
```

### 13.8 缓存诊断（PrefixShape）

参考 DeepSeek-Reasonix 的 `cache_shape.go`，每次 LLM 调用后比较前缀 SHA：

```typescript
interface PrefixShape {
  systemHash: string       // system prompt 的 SHA256 前 8 位
  toolsHash: string        // tools schema（排序后）的 SHA256
  prefixHash: string       // system + tools 组合 hash
  logRewriteVersion: number // session 被重写的次数（compact/prune 递增）
  toolSchemaTokens: number  // tools schema 估算 token 数
}

interface CacheDiagnostics {
  prefixHash: string
  prefixChanged: boolean
  prefixChangeReasons: ('system' | 'tools' | 'log_rewrite')[]
  cacheMissTokens: number
  cacheHitTokens: number
}
```

**诊断逻辑**：
- `systemHash` 变了 → system prompt 被修改（如记忆编译刷新了 memory 块）
- `toolsHash` 变了 → 工具列表变了（如 Agent 切换导致工具集不同）
- `logRewriteVersion` 变了 → compaction 重写了历史

**工具 Schema 排序**：`normalizeToolSchemas` 按名称排序，避免工具注册顺序变化导致缓存 miss。

### 13.9 缓存友好的设计决策

| 决策 | 做法 | 缓存效果 |
|------|------|----------|
| Plan mode 切换 | 不改 system prompt 和 tools，只在 execute 时拒绝写操作 | 切换不破缓存 |
| 记忆编译 | memory 块放在 system prompt 末尾（cache 分界线之后） | 记忆更新只影响尾部 |
| 工具注册顺序 | 按名称排序后注册 | 顺序不变则 toolsHash 不变 |
| Mid-turn steer | 追加用户消息而非修改已有消息 | 前缀不变，一次 cache miss |
| Compaction | 只在 80% 阈值触发，非每轮 | 大幅减少重写次数 |
| Session rewrite version | compact/prune 后递增 | 诊断时区分"历史被重写"vs"前缀真变了" |

### 13.10 工具输出截断

参考 DeepSeek-Reasonix 的 `maxToolOutputBytes = 32KB`：

```typescript
const MAX_TOOL_OUTPUT_BYTES = 32 * 1024  // ~8K tokens

function truncateToolOutput(output: string): { body: string; truncated: boolean; notice?: string } {
  if (output.length <= MAX_TOOL_OUTPUT_BYTES) {
    return { body: output, truncated: false }
  }
  const keep = MAX_TOOL_OUTPUT_BYTES / 2
  const head = output.slice(0, keep)
  const tail = output.slice(output.length - keep)
  const omitted = output.length - head.length - tail.length
  return {
    body: `${head}\n\n…[truncated ${omitted} of ${output.length} bytes]…\n\n${tail}`,
    truncated: true,
    notice: `tool output truncated: ${omitted} of ${output.length} bytes elided`,
  }
}
```

### 13.11 死循环防护（Storm Breaker）

参考 DeepSeek-Reasonix 的 `applyStormBreaker`：

- 追踪连续相同失败的签名（tool name + error，不含 args）
- 连续 3 次相同失败 → 注入指令要求改变策略
- 连续成功写操作也追踪（防止反复写同一文件）
- 任何不同操作重置计数器

### 13.12 与 SessionCoordinator 的关系

Compaction 是 SessionCoordinator 的职责之一：

```typescript
class SessionCoordinator {
  private compactStuck = false
  private consecutiveCompacts = 0
  private softCompactNoticed = false
  private lastPrefixShape?: PrefixShape

  // 在每次 LLM 调用后调用
  async maybeCompact(sessionId: string, usage: Usage): Promise<void> {
    if (this.contextWindow <= 0 || !usage || usage.promptTokens === 0) return

    const high = Math.floor(this.contextWindow * this.compactRatio)
    const soft = Math.floor(this.contextWindow * this.softCompactRatio)

    // 软阈值：只报告，不压缩（保留缓存）
    if (usage.promptTokens >= soft && usage.promptTokens < high && !this.softCompactNoticed) {
      this.softCompactNoticed = true
      this.emitNotice('info', `context reached ${this.softCompactRatio * 100}% of window`)
      return
    }

    if (usage.promptTokens < high) {
      this.consecutiveCompacts = 0
      this.compactStuck = false
      return
    }

    if (this.compactStuck) return

    const force = usage.promptTokens >= Math.floor(this.contextWindow * this.forceRatio)

    // 先 prune（免费）
    const pruneStats = await this.pruneStaleToolResults(sessionId)
    if (!force && usage.promptTokens - pruneStats.savedTokens < high) return

    // 再 compact（调 LLM）
    await this.compact(sessionId, 'auto', '', force)

    // 连续压缩检测
    this.consecutiveCompacts++
    if (this.consecutiveCompacts >= 2) {
      this.compactStuck = true
      this.emitNotice('warn', 'context window too small for compaction to help; auto-compaction paused')
    }
  }
}
```

### 13.13 Compaction 异步化

Compaction 涉及 LLM 调用，可能耗时数秒。为避免阻塞用户对话，采用**异步后台压缩**：

```typescript
class SessionCoordinator {
  private compactPromise: Promise<void> | null = null

  async maybeCompact(sessionId: string, usage: Usage): Promise<void> {
    // ... 阈值判断同上 ...

    // 如果已有压缩任务在运行，跳过（不排队）
    if (this.compactPromise) {
      this.emitNotice('info', 'compaction already in progress, skipping')
      return
    }

    // 异步执行压缩，不阻塞当前对话
    this.compactPromise = this.doCompact(sessionId, force)
      .then(() => {
        this.compactPromise = null
        this.eventBus.emit('session:compacted', { sessionId })
      })
      .catch((err) => {
        this.compactPromise = null
        logger.error('compaction failed:', err)
      })
  }
}
```

**关键设计**：
- 压缩在后台执行，用户可以继续发消息
- 同一时刻只有一个压缩任务运行，不排队
- 压缩完成后通过 EventBus 通知前端
- 压缩期间新消息追加到 session 尾部，压缩只处理压缩开始前的消息
- 压缩完成后下次 LLM 调用会看到压缩后的历史

---

## 14. Usage Ledger（LLM 用量追踪）

### 14.1 问题背景

LLM 调用产生 token 费用，用户需要知道：
- 总共花了多少钱
- 哪个 Agent 消耗最多
- 哪个会话最贵
- 是否被异常调用消耗

### 14.2 设计

```typescript
// core/usage/usage-ledger.ts

interface UsageEntry {
  requestId: string
  startedAt: string          // ISO 时间
  endedAt: string
  durationMs: number
  status: 'ok' | 'error' | 'aborted' | 'usage_missing'
  source: {
    subsystem: string        // 'chat' | 'compaction' | 'memory' | 'subagent'
    operation: string        // 'stream' | 'summarize' | 'compile'
  }
  attribution: {
    agentId: string
    sessionId?: string
    threadId?: string        // subagent 归因
  }
  model: {
    provider: string
    modelId: string
    api: string
  }
  usage: {
    inputTokens: number
    outputTokens: number
    cacheHitTokens: number
    totalTokens: number
    estimatedCost: number    // USD
  }
  error: { name: string; message: string } | null
}

interface UsageLedger {
  start(meta: StartMeta): { requestId: string; startedAt: string }
  finish(requestId: string, result: FinishResult): UsageEntry | null
  recordError(requestId: string, error: Error, status?: string): UsageEntry | null
  list(filter: UsageFilter): { entries: UsageEntry[] }
  clear(): void
}
```

### 14.3 存储与查询

- **存储**：JSON 文件（`{dataDir}/usage-ledger.json`），最多保留 5000 条
- **查询 API**：`GET /api/usage?since=...&until=...&agentId=...`
- **前端展示**：设置页面的用量面板，按日/周/月聚合

### 14.4 成本估算

```typescript
// 按 provider + model 查询价格表
const COST_RATES: Record<string, Record<string, { input: number; output: number; cache: number }>> = {
  openai: {
    'gpt-4o': { input: 2.5e-6, output: 10e-6, cache: 1.25e-6 },  // USD per token
  },
  anthropic: {
    'claude-sonnet-4-20250514': { input: 3e-6, output: 15e-6, cache: 0.3e-6 },
  },
}
```

### 14.5 事件推送

每次 LLM 调用完成后，通过事件总线推送 `llm_usage` 事件，前端可实时更新用量显示。

---

## 15. Session 健康检查 + 孤儿修复

### 15.1 问题背景

上游 Provider 的 `empty_stream` / `context overflow` 等失败会被 Pi SDK 持久化为
`stopReason: "error"` 的 assistant 消息。用户重新打开会话时，context 已撑爆，
每次发消息都立即失败 → 反复写入新 error → 桌面端体感"卡死"。

此外，agentic 工具循环中 `stopReason=error/aborted` 的 assistant 会导致其
toolResult 变成孤儿（父 toolCall 已被 SDK 丢弃），重放时 Provider 返回 400。

### 15.2 健康检查

```typescript
// core/session/session-health.ts

interface SessionHealth {
  healthy: boolean
  recentErrors: number     // 最近 N 条 assistant 中的 error 数
  totalChecked: number
  exists: boolean
}

function evaluateSessionHealth(
  sessionPath: string,
  opts?: { lookback?: number; errorThreshold?: number }
): SessionHealth

// 默认：检查最后 10 条 assistant，>= 3 条 error 视为 unhealthy
```

### 15.3 孤儿 toolResult 修复

```typescript
// 读时修复：在 SessionManager.open 之前执行
function repairOrphanToolResultEntries(entries: SessionEntry[]): {
  entries: SessionEntry[]
  removed: number
}

// 落盘修复：直接修复 jsonl 文件
function repairOrphanToolResultEntriesInFile(sessionPath: string): {
  repaired: boolean
  removed: number
}
```

### 15.4 修复时机

- **读时修复**：每次打开会话前自动执行
- **健康评估**：会话恢复前检查，unhealthy 时提示用户或跳过自动恢复
- **容错优先**：任何异常一律视为 healthy，绝不阻塞合法会话

---

## 16. API Key 安全存储

### 16.1 问题背景

API Key 明文存储在 YAML 配置文件中是安全隐患：
- 文件可能被其他应用读取
- 日志/错误报告可能意外泄露
- 版本控制误提交

### 16.2 方案

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **A. Electron safeStorage + Pi SDK getApiKey** | 用 `electron.safeStorage` 加密 API Key，通过 `getApiKey` 回调注入 Pi SDK | 零原生依赖，Pi SDK AuthStorage 管理模型配置，safeStorage 管理密钥安全 | 需要 IPC 桥接 |
| **B. Pi SDK AuthStorage 默认** | 直接用 Pi SDK 的 AuthStorage（auth.json 明文存储） | 最简单 | API Key 明文存储在磁盘 |

**推荐方案 A**：Electron `safeStorage` 加密 + Pi SDK `getApiKey` 回调注入。

> **CredentialBridge 架构**：Pi SDK 的 `AuthStorage` 负责管理模型配置（provider、base_url 等），
> 但 API Key 的实际存储和加解密由 Electron safeStorage 处理。
> `getApiKey` 回调在 Pi SDK 需要 API Key 时，通过 IPC 从 Main 进程获取解密后的 Key。
> 这样 API Key 永远不会明文落盘在 agent-server 侧。

### 16.3 接口

```typescript
// desktop/src/main/credential-store.ts
// 运行在 Electron Main 进程，通过 IPC 暴露给 Renderer

import { safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'

class CredentialStore {
  private storePath: string  // {appData}/pi-agent/credentials.enc

  constructor(dataDir: string) {
    this.storePath = path.join(dataDir, 'credentials.enc')
  }

  async get(providerId: string): Promise<string | null> {
    const entries = this.readStore()
    const encrypted = entries[providerId]
    if (!encrypted) return null

    // safeStorage 解密
    const buffer = Buffer.from(encrypted, 'base64')
    return safeStorage.decryptString(buffer)
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    const entries = this.readStore()

    // safeStorage 加密
    const encrypted = safeStorage.encryptString(apiKey).toString('base64')
    entries[providerId] = encrypted

    this.writeStore(entries)
  }

  async delete(providerId: string): Promise<void> {
    const entries = this.readStore()
    delete entries[providerId]
    this.writeStore(entries)
  }

  async list(): Promise<string[]> {
    return Object.keys(this.readStore())
  }

  private readStore(): Record<string, string> {
    if (!fs.existsSync(this.storePath)) return {}
    const raw = fs.readFileSync(this.storePath, 'utf-8')
    return JSON.parse(raw)
  }

  private writeStore(entries: Record<string, string>): void {
    atomicWriteSync(this.storePath, JSON.stringify(entries, null, 2))
  }
}
```

### 16.4 IPC 桥接

Renderer 进程无法直接调用 `safeStorage`（仅 Main 进程可用），需要通过 IPC 桥接：

```typescript
// desktop/src/main/ipc/credential-handler.ts

ipcMain.handle('credential:get', (_, providerId) => credentialStore.get(providerId))
ipcMain.handle('credential:set', (_, providerId, apiKey) => credentialStore.set(providerId, apiKey))
ipcMain.handle('credential:delete', (_, providerId) => credentialStore.delete(providerId))
ipcMain.handle('credential:list', () => credentialStore.list())
ipcMain.handle('credential:test', (_, providerId) => testApiKey(providerId))
```

### 16.5 与配置系统的关系

- `providers.yaml` 只存储非敏感配置（base_url、api 类型、模型列表）
- API Key 通过 `CredentialStore`（Electron safeStorage 加密）读写
- 运行时合并：`provider.config + credentialStore.get(provider.id)` → 完整 Provider 信息
- agent-server 通过 HTTP API 从 Main 进程获取解密后的 API Key（不落盘明文）

---

## 17. 原子写入

### 17.1 问题背景

进程在写入配置/会话文件时崩溃，会导致文件内容损坏（半写状态）。
openhanako 用 `atomicWriteSync` 解决：先写临时文件，再 rename 替换。

### 17.2 实现

```typescript
// lib/safe-fs.ts

import fs from 'fs'
import path from 'path'

/**
 * 原子写入：先写 .tmp 文件，再 rename 替换目标文件。
 * rename 是 POSIX 原子操作，Windows 上也保证原子性（NTFS）。
 */
export function atomicWriteSync(filePath: string, content: string): void {
  const tmpPath = filePath + '.tmp'
  fs.writeFileSync(tmpPath, content, 'utf-8')
  fs.renameSync(tmpPath, filePath)
}

/**
 * 安全读取 YAML：文件不存在或解析失败返回默认值，不抛异常。
 */
export function safeReadYAMLSync<T>(
  filePath: string,
  defaultValue: T,
  yaml: typeof import('js-yaml')
): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = yaml.load(raw)
    return (parsed && typeof parsed === 'object') ? parsed as T : defaultValue
  } catch {
    return defaultValue
  }
}
```

### 17.3 使用场景

- 配置文件写入（preferences.yaml、config.yaml）→ **atomicWriteSync**
- 会话消息追加（.jsonl）→ **append-only 追加写入**（见下文）
- 迁移脚本中的文件修改 → **atomicWriteSync**
- Usage Ledger 持久化 → **atomicWriteSync**
- CredentialStore 写入 → **atomicWriteSync**

### 17.4 JSONL Append-Only 写入

会话消息文件（`.jsonl`）采用 **append-only 追加写入**，而非 atomicWriteSync：

```typescript
// core/session/session-store.ts

import fs from 'fs'

class SessionStore {
  /**
   * 追加一条消息到 JSONL 文件。
   * append-only 写入保证前缀不变，最大化 LLM prompt cache 命中率。
   * OS 保证 append 写入的原子性（单次 write ≤ PIPE_BUF 时）。
   */
  appendMessage(sessionPath: string, entry: SessionEntry): void {
    const line = JSON.stringify(entry) + '\n'
    fs.appendFileSync(sessionPath, line, 'utf-8')
  }

  /**
   * 读取所有消息。
   */
  readMessages(sessionPath: string): SessionEntry[] {
    const raw = fs.readFileSync(sessionPath, 'utf-8')
    return raw.split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line))
  }
}
```

**为什么 JSONL 不用 atomicWriteSync**：
- `atomicWriteSync` 是全量重写（写 tmp → rename），每次追加消息都要重写整个文件
- `appendFileSync` 是追加写入，只写新增行，前缀不变
- 前缀不变 = LLM prompt cache 持续命中（参考 DeepSeek-Reasonix 的 append-only 原则）
- 只有 Compaction（重写历史）时才需要 atomicWriteSync 重写整个 JSONL

**数据安全**：
- 单行 JSON ≤ 64KB 时，OS 保证 append 写入的原子性
- 崩溃恢复：最后一行可能不完整，`JSON.parse` 失败时跳过即可
- Compaction 重写时使用 atomicWriteSync

---

## 18. 自动更新

### 18.1 设计

Electron 桌面应用需要自动更新机制。使用 `electron-updater`（electron-builder 内置）。

```typescript
// desktop/src/main/auto-updater.ts

import { autoUpdater } from 'electron-updater'

export function setupAutoUpdater() {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    // 通知渲染进程有新版本
    mainWindow.webContents.send('update-available', info)
  })

  autoUpdater.on('download-progress', (progress) => {
    mainWindow.webContents.send('update-progress', progress)
  })

  // 启动时检查更新
  autoUpdater.checkForUpdates()
}
```

### 18.2 更新策略

- 启动时检查更新（不自动下载）
- 用户确认后下载
- 下载完成后下次退出时安装
- 支持手动检查更新

---

## 19. 国际化（i18n）

### 19.1 设计

中文优先，预留多语言扩展能力。

```typescript
// packages/shared/src/i18n/index.ts

const messages: Record<string, Record<string, string>> = {
  'zh-CN': {
    'error.llm_timeout': 'AI 响应超时，请稍后重试',
    'error.llm_auth_failed': 'API Key 无效，请检查配置',
    'tool.confirm.title': '操作确认',
    'tool.confirm.execute': '执行',
    'tool.confirm.cancel': '取消',
    'permission.auto': '自动模式',
    'permission.plan': '计划模式',
    'permission.readonly': '只读模式',
  },
  'en': {
    'error.llm_timeout': 'AI response timed out, please try again later',
    'error.llm_auth_failed': 'Invalid API Key, please check configuration',
    // ...
  },
}

export function t(key: string, locale?: string): string {
  const lang = locale ?? detectLocale()
  return messages[lang]?.[key] ?? messages['zh-CN']?.[key] ?? key
}
```

### 19.2 语言检测优先级

1. 用户显式设置（preferences.yaml 的 `language` 字段）
2. OS 语言（`app.getLocale()`）
3. 默认中文

---

## 20. 会话文件管理（SessionFileRegistry）

### 20.1 问题背景

工具执行会产生文件（截图、artifact、代码文件等），这些文件需要：
- 生命周期管理（会话结束后是否清理）
- 去重（同一文件多次引用）
- 恢复（重新打开会话时能找到文件）

### 20.2 设计

```typescript
// core/session/session-file-registry.ts

interface SessionFileRecord {
  fileId: string            // 唯一 ID
  filePath: string          // 绝对路径
  sessionPath: string       // 所属会话
  label: string             // 显示名称
  origin: string            // 来源：agent_output | stage_files | plugin_output | ...
  storageKind: string       // 存储类型：managed_cache | external | install_source
  createdAt: string
  sizeBytes?: number
}

class SessionFileRegistry {
  registerFile(record: Omit<SessionFileRecord, 'fileId' | 'createdAt'>): SessionFileRecord
  getFilesForSession(sessionPath: string): SessionFileRecord[]
  getFileById(fileId: string): SessionFileRecord | null
  cleanupSession(sessionPath: string): number  // 清理 managed_cache 文件
}
```

### 20.3 存储位置

```
{dataDir}/session-files/          # managed_cache 文件
  └── {hash}/                     # 按文件内容 hash 组织
{agentDir}/sessions/{sid}/.files.json  # 会话文件索引 sidecar
```

---

## 21. 模型注册表（ProviderRegistry）

### 21.1 问题背景

用户可能使用自定义模型（本地 Ollama、第三方 API 代理等），需要：
- 注册自定义 Provider 和模型
- 声明模型能力（text/image/video/thinking）
- 模型引用统一为 `{id, provider}` 复合键

### 21.2 设计

```typescript
// core/llm/provider-registry.ts

interface ProviderConfig {
  id: string                // Provider 唯一标识
  name: string              // 显示名称
  api: string               // API 类型：openai-completions | anthropic-messages | google-generative-ai
  baseUrl: string           // API Base URL
  models: ModelConfig[]     // 可用模型列表
}

interface ModelConfig {
  id: string                // 模型 ID
  input: ('text' | 'image')[]  // 输入能力（Pi SDK 标准）
  compat?: {
    hanaVideoInput?: boolean   // Hana 扩展：视频输入能力
  }
  contextWindow?: number    // 上下文窗口大小
  thinking?: boolean        // 是否支持 thinking/extended thinking
}

class ProviderRegistry {
  get(providerId: string): ProviderConfig | null
  getAllProviders(): ProviderConfig[]
  getModel(modelRef: { id: string; provider: string }): ModelConfig | null
  getDefaultModels(providerId: string): ModelConfig[]
  refresh(): void           // 重新加载 added-models.yaml
}
```

### 21.3 数据来源

- **内置模型**：代码中硬编码的已知 Provider/模型（OpenAI、Anthropic、Gemini 等）
- **用户模型**：`{dataDir}/added-models.yaml`（设置页面管理）
- **投影缓存**：`{dataDir}/models.json`（运行时生成的模型能力投影，含 compat 字段）

---

## 22. 错误体系

### 22.1 AppError 类

```typescript
class AppError extends Error {
  code: string              // 错误码（如 LLM_TIMEOUT）
  severity: ErrorSeverity   // critical | degraded | cosmetic
  category: ErrorCategory   // network | llm | filesystem | ipc | ...
  retryable: boolean        // 是否可重试
  httpStatus: number        // HTTP 状态码
  userMessageKey: string    // i18n 键
  context: Record<string, unknown>  // 附加上下文
  traceId: string           // 追踪 ID
}
```

### 22.2 错误传播

- **用户侧**：友好提示文本（如"我暂时无法回应"），不暴露技术细节
- **开发者侧**：结构化 AppError 信息推送到 DevLog 面板（WebSocket）
- **AG-UI 侧**：`RUN_ERROR` 事件携带 AppError 的 JSON 序列化

### 22.2.1 错误信息脱敏

AppError 在输出给用户或前端之前必须脱敏，防止泄露 API Key、文件路径等敏感信息：

```typescript
// lib/errors.ts

const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,          // OpenAI API Key
  /key[a-z]*[=:]\s*['"]?\S{10,}/gi, // 通用 key=xxx 模式
  /Bearer\s+\S+/gi,                  // Bearer Token
  /password[a-z]*[=:]\s*['"]?\S+/gi, // 密码
  /[A-Z]:\\Users\\[^\s]+/g,          // Windows 用户路径
  /\/home\/[^\s]+/g,                 // Linux 用户路径
]

function sanitizeErrorMessage(message: string): string {
  let sanitized = message
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]')
  }
  return sanitized
}

class AppError extends Error {
  /** 用户可见的错误消息（已脱敏） */
  get userMessage(): string {
    return sanitizeErrorMessage(this.message)
  }

  /** 完整错误信息（仅 DevLog，不推送到前端） */
  get debugMessage(): string {
    return this.message
  }
}
```

**脱敏规则**：
- `userMessage`：脱敏后的消息，用于 AG-UI 事件和前端展示
- `debugMessage`：原始消息，仅写入 DevLog 面板（开发者可见）
- 日志文件中的错误信息也使用脱敏版本

### 22.3 错误定义表

```typescript
const ERROR_DEFS = {
  LLM_TIMEOUT:         { severity: 'degraded',  category: 'llm',        retryable: true,  httpStatus: 504 },
  LLM_RATE_LIMITED:    { severity: 'degraded',  category: 'llm',        retryable: true,  httpStatus: 429 },
  LLM_AUTH_FAILED:     { severity: 'degraded',  category: 'llm',        retryable: false, httpStatus: 401 },
  LLM_EMPTY_RESPONSE:  { severity: 'degraded',  category: 'llm',        retryable: true,  httpStatus: 502 },
  AGENT_RUN_FAILED:    { severity: 'degraded',  category: 'llm',        retryable: true,  httpStatus: 500 },
  FS_PERMISSION:       { severity: 'critical',  category: 'filesystem', retryable: false, httpStatus: 500 },
  FS_NOT_FOUND:        { severity: 'degraded',  category: 'filesystem', retryable: false, httpStatus: 404 },
  CONFIG_PARSE:        { severity: 'critical',  category: 'config',     retryable: false, httpStatus: 500 },
  MEMORY_COMPILE_FAILED: { severity: 'degraded', category: 'unknown',   retryable: true },
  PLUGIN_LOAD_FAILED:  { severity: 'degraded',  category: 'ipc',        retryable: false },
  UNKNOWN:             { severity: 'degraded',  category: 'unknown',    retryable: false, httpStatus: 500 },
}
```

---

## 22.5 重试机制

### 22.5.1 设计原则

LLM 调用、搜索 API 等外部请求都可能因网络抖动、速率限制等原因失败。
需要统一的、带 jitter 的重试机制，避免雪崩式重试。

### 22.5.2 Decorrelated Jitter（AWS 推荐）

参考 openhanako 的 `retry.js`，采用 AWS 推荐的 Decorrelated Jitter 策略：

```typescript
// lib/retry.ts

async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 1000, maxDelayMs = 30000, signal, shouldRetry } = opts
  let prevDelay = baseDelayMs

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const appErr = AppError.wrap(err)
      const retry = shouldRetry ? shouldRetry(appErr) : appErr.retryable
      if (!retry || attempt === maxAttempts - 1) throw appErr

      if (signal?.aborted) throw appErr

      // delay = min(maxDelay, random(baseDelay, previousDelay * 3))
      const delay = Math.min(maxDelayMs, randomBetween(baseDelayMs, prevDelay * 3))
      prevDelay = delay
      await sleep(delay, signal)
    }
  }
  throw new Error('unreachable')
}
```

### 22.5.3 重试策略映射

| 场景 | maxAttempts | baseDelayMs | maxDelayMs | shouldRetry |
|------|-------------|-------------|------------|-------------|
| LLM 流式调用 | 2 | 1000 | 10000 | timeout / 429 / 5xx |
| 搜索 API | 3 | 1000 | 30000 | 429 / network error |
| 文件操作 | 2 | 500 | 5000 | EBUSY / EAGAIN |
| 记忆编译 | 1 | — | — | 不重试（后台任务，下次 tick 补偿） |

---

## 22.6 搜索速率限制（SearchRateLimiter）

### 22.6.1 问题背景

搜索 API（Bing、DuckDuckGo、Google、Brave、Tavily、Serper 等）各有独立的速率限制。
不加控制会导致 429 封禁，影响 Agent 正常工作。

### 22.6.2 设计

参考 openhanako 的 `search-rate-limiter.js`，每个 Provider 独立的速率策略：

```typescript
interface RateLimitPolicy {
  minIntervalMs: number      // 两次请求的最小间隔
  jitterMs: number           // 随机抖动范围
  maxConcurrent: number      // 最大并发数
  rateLimitBaseDelayMs: number  // 429 后的基础退避延迟
  retryJitterMs: number      // 退避抖动
  maxCooldownMs: number      // 最大冷却时间
}

const DEFAULT_POLICIES: Record<string, RateLimitPolicy> = {
  brave:    { minIntervalMs: 1100, jitterMs: 400,  maxConcurrent: 3, rateLimitBaseDelayMs: 2000,  retryJitterMs: 1000, maxCooldownMs: 300_000 },
  tavily:   { minIntervalMs: 650,  jitterMs: 350,  maxConcurrent: 3, rateLimitBaseDelayMs: 2000,  retryJitterMs: 1000, maxCooldownMs: 300_000 },
  serper:   { minIntervalMs: 1000, jitterMs: 500,  maxConcurrent: 3, rateLimitBaseDelayMs: 2000,  retryJitterMs: 1000, maxCooldownMs: 300_000 },
  bing:     { minIntervalMs: 3000, jitterMs: 4000, maxConcurrent: 1, rateLimitBaseDelayMs: 10000, retryJitterMs: 1000, maxCooldownMs: 300_000 },
  google:   { minIntervalMs: 6000, jitterMs: 8000, maxConcurrent: 1, rateLimitBaseDelayMs: 30000, retryJitterMs: 1000, maxCooldownMs: 600_000 },
}
```

### 22.6.3 429 退避

收到 429 响应后：
1. 读取 `Retry-After` header（如有）
2. 否则指数退避：`baseDelay * 2^failures + jitter`
3. 冷却期间所有该 Provider 的请求排队等待

---

## 22.7 权限控制（Gate 接口）

### 22.7.1 设计原则

参考 DeepSeek-Reasonix 的 `Gate` 接口模式，**不做 OS 级沙盒**，只在应用层做权限检查。
理由：
- OS 沙盒（macOS Seatbelt / Linux bwrap / Windows Restricted Token）实现复杂度高
- Windows Restricted Token 需要 Win32 API 专业知识
- 应用层权限检查已覆盖 80% 安全需求（防止 Agent 越权操作）
- PathGuard + 权限模式组合足以保护用户数据

### 22.7.2 Gate 接口

```typescript
// core/tool/gate.ts

type ToolOperation = 'read' | 'write' | 'shell'

interface GateResult {
  allowed: boolean
  reason?: string        // 拒绝原因（展示给前端）
}

interface Gate {
  /** 检查工具调用是否被允许 */
  check(toolName: string, params: Record<string, unknown>, operation: ToolOperation): GateResult
}
```

### 22.7.3 内置 Gate 实现

```typescript
// core/tool/default-gate.ts

class DefaultGate implements Gate {
  constructor(private opts: {
    mode: 'auto' | 'plan' | 'readonly'
    workspace: string          // 工作目录白名单
    agentDir: string           // Agent 数据目录
    getExternalReadPaths?: () => string[]  // 用户授权的外部只读路径
  }) {}

  check(toolName, params, operation): GateResult {
    // 1. read-only 模式：拒绝所有写操作和 shell
    if (this.opts.mode === 'readonly') {
      const writeOps = ['write_file', 'edit_file', 'shell', 'delete_file']
      if (writeOps.includes(toolName) || operation === 'write') {
        return { allowed: false, reason: 'read-only mode: writing is disabled' }
      }
    }

    // 2. 文件操作：检查路径是否在白名单内
    if (this.isFileTool(toolName)) {
      return this.checkPath(params.path ?? params.filePath)
    }

    // 3. Shell 操作：始终需要确认（Auto 模式下也弹确认）
    if (toolName === 'shell') {
      return { allowed: false, reason: 'needs_confirmation' }
    }

    // 4. 其他工具：默认允许
    return { allowed: true }
  }

  private checkPath(rawPath: string): GateResult {
    if (!rawPath) return { allowed: true }
    const abs = path.resolve(this.opts.workspace, rawPath)
    const real = fs.realpathSync(abs, { throwIfNoEntry: false }) ?? abs

    // 白名单：workspace + agentDir + 外部只读路径
    const allowed = [this.opts.workspace, this.opts.agentDir]
      .concat(this.opts.getExternalReadPaths?.() ?? [])

    const inside = allowed.some(root => real.startsWith(root))
    if (!inside) {
      return { allowed: false, reason: `path outside workspace: ${rawPath}` }
    }

    return { allowed: true }
  }
}
```

### 22.7.4 工具包装

```typescript
// core/tool/gate-wrapper.ts

function withGate(tool: Tool, gate: Gate): Tool {
  return {
    ...tool,
    async execute(toolCallId, params, signal) {
      // 确定操作类型
      const operation = this.inferOperation(tool.name)

      // 执行权限检查
      const result = gate.check(tool.name, params, operation)

      if (!result.allowed) {
        if (result.reason === 'needs_confirmation') {
          // 需要用户确认 → 发送 confirmation_request 事件
          await this.requestConfirmation({
            tool: tool.name,
            params,
            reason: result.reason,
          })
          // 等待用户响应后继续执行
          return tool.execute(toolCallId, params, signal)
        }

        // 直接拒绝
        return { output: `blocked: ${result.reason}`, isError: true }
      }

      // 通过检查，正常执行
      return tool.execute(toolCallId, params, signal)
    },
  }
}
```

### 22.7.5 与权限模式的集成

| 模式 | 写工具 | 读工具 | Shell | 说明 |
|------|--------|--------|-------|------|
| **Auto** | 自动执行，危险操作弹确认 | 自动执行 | 弹确认 | 默认模式 |
| **Plan** | 先输出计划，用户确认后执行 | 自动执行 | 输出计划 | 审慎模式 |
| **Read-only** | 拒绝 | 自动执行 | 拒绝 | 安全模式 |

### 22.7.6 外部只读路径

用户可以显式授权 Agent 访问 workspace 以外的路径：

```
用户："你可以读取 D:\Projects\other-project 的代码"
→ 将该路径加入 externalReadPaths
→ Agent 的 readFile/grep/find 工具可访问该路径（只读）
→ writeFile/editFile 仍然被拦截
```

---

## 22.8 任务验证：Evidence Ledger + Final Readiness

### 22.8.1 问题背景

Agent 可能"假装完成"——输出"已完成"但实际没做。
参考 DeepSeek-Reasonix 的 `evidence` 包，需要验证 Agent 是否真正完成了任务。

### 22.8.2 设计

```typescript
// core/tool/evidence-ledger.ts

interface EvidenceEntry {
  stepId: string             // 步骤 ID
  claim: string              // Agent 声称完成了什么
  evidence: string           // 证据（文件内容、命令输出、URL）
  evidenceType: 'file_exists' | 'file_contains' | 'command_output' | 'url_accessible'
  verifiedAt: string | null  // 验证时间
  verified: boolean | null   // 验证结果
}

class EvidenceLedger {
  /** Agent 调用 todo_write / complete_step 时自动记录证据 */
  recordClaim(stepId: string, claim: string, evidence: string, type: string): void

  /** Final Readiness Check：验证所有未验证的 claim */
  async verifyAll(): Promise<ReadinessReport>
}

interface ReadinessReport {
  total: number
  verified: number
  failed: number
  unverified: number
  details: Array<{ stepId: string; claim: string; verified: boolean | null; reason?: string }>
}
```

### 22.8.3 验证方式

| evidenceType | 验证方法 |
|-------------|---------|
| `file_exists` | `fs.existsSync()` |
| `file_contains` | 读取文件内容，检查是否包含预期字符串 |
| `command_output` | 执行验证命令，检查输出 |
| `url_accessible` | HTTP HEAD 请求，检查 2xx |

### 22.8.4 与工具系统的集成

Agent 调用 `complete_step` 工具时，自动要求提供证据：

```
Agent: "我已完成文件创建"
  → complete_step(stepId, claim="创建了 config.yaml", evidenceType="file_exists", evidence="config.yaml")
  → EvidenceLedger 记录 claim
  → Run 结束前 Final Readiness Check 验证
```

---

## 22.9 记忆反思（Memory Reflection）

### 22.9.1 问题背景

记忆编译可能产生事实漂移（摘要丢失关键细节）或幻觉（摘要添加了不存在的信息）。
需要验证编译质量。

### 22.9.2 设计

参考 openhanako 的 shadow/write 双模式：

| 模式 | 做法 | 用途 |
|------|------|------|
| **shadow** | 编译后，用旧记忆回答一组测试问题，对比新旧答案的一致性 | 检测事实丢失 |
| **write** | 编译后，让 LLM 审查新记忆，标记可能的幻觉或矛盾 | 检测事实添加 |

```typescript
// core/memory/memory-reflection.ts

interface ReflectionResult {
  mode: 'shadow' | 'write'
  quality: 'good' | 'degraded' | 'poor'
  issues: ReflectionIssue[]
  recommendation: 'accept' | 'rollback' | 'recompile'
}

interface ReflectionIssue {
  type: 'fact_loss' | 'hallucination' | 'contradiction' | 'stale'
  description: string
  affectedSection: string
  severity: 'low' | 'medium' | 'high'
}
```

### 22.9.3 触发时机

- 每日编译流水线的 `deepMemory()` 步骤
- 用户手动触发 `memory_reflect` 工具
- 检测到记忆质量下降时自动触发

---

## 22.10 优雅关闭（Graceful Shutdown）

### 22.10.1 问题背景

Agent 运行中有活跃的 LLM 调用、工具执行、记忆编译等任务。
直接杀进程会导致数据损坏（半写文件）和资源泄漏。

### 22.10.2 设计

```typescript
// app.ts

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`received ${signal}, starting graceful shutdown`)

  // 1. 停止接受新请求
  await fastify.close()

  // 2. 等待活跃 LLM 调用完成（最多 10 秒）
  await Promise.race([
    llmService.waitForActiveCalls(),
    sleep(10_000),
  ])

  // 3. 等待活跃工具执行完成（最多 5 秒）
  await Promise.race([
    toolRegistry.waitForActiveExecutions(),
    sleep(5_000),
  ])

  // 4. 完成当前记忆编译步骤（最多 30 秒）
  await Promise.race([
    memoryTicker.finishCurrentStep(),
    sleep(30_000),
  ])

  // 5. 清理定时器
  memoryTicker.stop()
  cronScheduler.stop()

  // 6. 持久化 Usage Ledger
  await usageLedger.flush()

  // 7. 关闭数据库连接
  await factStore.close()

  logger.info('graceful shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
```

### 22.10.3 与 Fastify 插件的关系

每个 Service 插件的 `onClose` 钩子负责清理自己的资源：

```typescript
app.addHook('onClose', async () => {
  await manager.dispose()  // 每个 Manager 自己的清理逻辑
})
```

Fastify 的 `close()` 会按注册逆序调用 `onClose` 钩子。

---

## 22.11 中途引导（Mid-turn Steer）

### 22.11.1 问题背景

Agent 正在执行长任务时，用户可能需要：
- 补充信息（"顺便也检查一下 test 目录"）
- 修正方向（"不要删那个文件"）
- 提前终止（"够了，停吧"）

参考 DeepSeek-Reasonix 的 mid-turn steer 机制。

### 22.11.2 设计

```typescript
// core/llm/mid-turn-steer.ts

interface SteerMessage {
  type: 'supplement' | 'correction' | 'abort'
  content: string
  injectedAt: number        // 注入时的消息序号
}

class MidTurnSteerer {
  private pendingSteers: SteerMessage[] = []

  /** 用户发送中途引导（通过 WebSocket） */
  injectSteer(message: SteerMessage): void {
    this.pendingSteers.push(message)
  }

  /** LLM 调用前，将 pending steers 追加到消息列表 */
  consumeSteers(): SteerMessage[] {
    const steers = [...this.pendingSteers]
    this.pendingSteers = []
    return steers
  }
}
```

### 22.11.3 消息注入方式

```
用户在 Agent 运行中发送消息
  → WebSocket 发送 { type: 'steer', content: '...' }
  → MidTurnSteerer.injectSteer()
  → 下次 LLM 调用时，steer 消息追加到消息列表末尾
  → LLM 看到用户新消息，调整行为
```

关键：steer 消息是**追加**而非**修改**已有消息，前缀不变，cache 命中。

### 22.11.4 Abort 处理

用户发送 `abort` 类型的 steer：
1. 设置 `AbortSignal` 的 aborted 标志
2. 当前工具执行完成后停止
3. Agent 输出终止消息
4. 发送 `RUN_FINISHED` 事件

---

## 23. 日志体系

### 23.1 模块级 Logger

```typescript
// lib/logger.ts
function createModuleLogger(module: string) {
  const logger = pino({ name: `pi-agent:${module}` })
  return {
    log: (msg: string) => logger.info(msg),
    warn: (msg: string) => logger.warn(msg),
    error: (msg: string) => logger.error(msg),
  }
}
```

### 23.2 DevLog 系统

```typescript
// Engine 级别的开发日志，通过 WebSocket 推送到前端
emitDevLog(text: string, level: 'info' | 'warn' | 'error'): void
getDevLogs(): DevLogEntry[]  // 最近 200 条
```

---

## 24. Electron 进程模型

### 24.1 进程架构

```
┌─────────────────────────────────────────────────┐
│ Electron Main Process                            │
│  - 窗口管理                                      │
│  - agent-server 生命周期管理                      │
│  - WS 控制通道（接收 agent-server 状态事件）       │
│  - 系统托盘 / 通知                                │
│  - 配置读写代理（安全敏感操作）                     │
└───────────┬──────────────────┬───────────────────┘
            │ IPC              │ HTTP + WS
            ▼                  ▼
┌───────────────────┐  ┌───────────────────────────┐
│ Renderer Process  │  │ agent-server (子进程)      │
│  - React UI       │  │  - Fastify HTTP + SSE      │
│  - Zustand 状态    │  │  - WebSocket 推送          │
│  - TanStack Query │  │  - Pi SDK LLM 调用         │
│  - SSE/WS 直连    │  │  - Agent / Memory / Tool   │
│    agent-server   │  │  - Plugin 系统              │
└───────────────────┘  └───────────────────────────┘
```

### 24.2 通信路径

| 路径 | 用途 | 协议 |
|------|------|------|
| Renderer → agent-server | LLM 流式输出 | SSE (AG-UI) |
| Renderer → agent-server | 服务端推送接收 | WebSocket |
| Renderer → Main | 配置读写（API Key 等） | Electron IPC |
| Main → agent-server | 生命周期管理 | HTTP |
| agent-server → Main | 状态事件推送 | WebSocket 控制通道 |

---

## 24.5 出站网络代理

### 24.5.1 问题背景

国内用户访问 OpenAI / Anthropic / Gemini 等 LLM API 通常需要代理。
openhanako 的 `outbound-proxy.js` 实现了完整的出站代理调度器，支持 HTTP/HTTPS/SOCKS 代理。

### 24.5.2 设计

```typescript
// core/config/outbound-proxy.ts

interface ProxyConfig {
  mode: 'none' | 'system' | 'manual'
  manualUrl?: string           // 如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080
  noProxy?: string[]           // 不走代理的域名列表
}

class OutboundProxyRuntime {
  private dispatcher: ProxyDispatcher | null = null

  /** 应用代理配置 */
  apply(config: ProxyConfig): void {
    this.close()
    if (config.mode === 'none') return

    const proxyUrl = config.mode === 'system'
      ? getSystemProxy()       // 读取系统代理设置
      : config.manualUrl

    if (proxyUrl) {
      this.dispatcher = createProxyDispatcher(proxyUrl, config.noProxy)
    }
  }

  /** 为指定 URL 获取代理 agent */
  getAgentForUrl(url: string): http.Agent | null {
    return this.dispatcher?.getAgent(url) ?? null
  }

  close(): void { this.dispatcher?.close() }
}
```

### 24.5.3 代理配置

- **系统代理**：自动读取 OS 代理设置（Windows: 注册表 / macOS: SystemConfiguration / Linux: env vars）
- **手动代理**：用户在设置页面输入代理地址
- **不走代理**：`noProxy` 列表（如本地 Ollama `127.0.0.1:11434`）

### 24.5.4 与 LLM 调用的集成

所有 LLM API 请求和搜索 API 请求通过 `OutboundProxyRuntime.getAgentForUrl()` 获取代理 agent：

```typescript
const agent = outboundProxy.getAgentForUrl(provider.baseUrl)
const response = await fetch(provider.baseUrl + '/chat/completions', {
  ...opts,
  agent,  // Node.js fetch 支持 agent
})
```

---

## 24.6 CORS 与认证

### 24.6.1 CORS

agent-server 是独立进程，Renderer 直连需要 CORS 支持：

```typescript
// app.ts
import cors from '@fastify/cors'

app.register(cors, {
  origin: (origin, cb) => {
    // 允许 Electron renderer 和开发服务器
    const allowed = ['http://localhost:5173', 'http://localhost:4173']
    if (!origin || allowed.includes(origin) || origin.startsWith('file://')) {
      cb(null, true)
    } else {
      cb(new Error('Not allowed'), false)
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
})
```

### 24.6.2 认证

单用户桌面应用默认不需要认证，但预留认证中间件：

```typescript
// lib/auth.ts

function authMiddleware(request: FastifyRequest, reply: FastifyReply, done: () => void) {
  // 开发模式跳过认证
  if (process.env.NODE_ENV === 'development') return done()

  // 检查 API Token（由 Main 进程在启动 agent-server 时传入）
  const token = request.headers['authorization']?.replace('Bearer ', '')
  if (token && token === serverConfig.apiToken) return done()

  // 健康检查端点不需要认证
  if (request.url === '/api/health') return done()

  reply.code(401).send({ error: 'Unauthorized' })
}
```

### 24.6.3 agent-server 速率限制

使用 `@fastify/rate-limit` 防止本地恶意脚本或 bug 导致的请求洪泛：

```typescript
// app.ts
import rateLimit from '@fastify/rate-limit'

app.register(rateLimit, {
  max: 100,               // 每个时间窗口最大请求数
  timeWindow: '1 minute',
  allowList: ['127.0.0.1', '::1'],  // 本地回环地址可放宽
  // 针对不同路由的独立限制
  keyGenerator: (request) => {
    // 按 IP + 路由分组
    return `${request.ip}:${request.routeOptions.url}`
  },
})

// SSE 流式端点单独放宽（长连接）
app.register(rateLimit, {
  max: 20,
  timeWindow: '1 minute',
}, { routePrefix: '/agui' })
```

### 24.6.4 WebSocket 认证

WebSocket 连接在 upgrade 时验证 Token，防止未授权连接：

```typescript
// routes/ws.route.ts

app.get('/ws', { websocket: true }, (socket, request) => {
  // 从 query 参数或 Sec-WebSocket-Protocol header 获取 token
  const token = request.query.token
    ?? request.headers['sec-websocket-protocol']

  if (process.env.NODE_ENV !== 'development') {
    if (!token || token !== serverConfig.apiToken) {
      socket.close(4001, 'Unauthorized')
      return
    }
  }

  // 认证通过，注册事件监听
  socket.on('message', (data) => {
    const event = JSON.parse(data.toString())
    handleWsClientEvent(event, socket)
  })
})
```

前端连接 WebSocket 时携带 Token：

```typescript
const ws = new WebSocket(`ws://localhost:${port}/ws?token=${apiToken}`)
```

---

## 24.7 项目级指令加载

### 24.7.1 问题背景

用户通常在项目根目录放置指令文件（如 `.pi-instructions.md`、`CLAUDE.md`、`.cursorrules`），
Agent 应自动加载这些指令并注入 system prompt。

参考 DeepSeek-Reasonix 的 `instruction/` 包。

### 24.7.2 设计

```typescript
// core/agent/instruction-loader.ts

interface InstructionFile {
  path: string                 // 文件路径
  name: string                 // 显示名称
  content: string              // 文件内容
  priority: number             // 优先级（数字越小越靠前）
}

const INSTRUCTION_FILE_PATTERNS = [
  { pattern: '.pi-instructions.md',   priority: 10 },
  { pattern: 'CLAUDE.md',             priority: 20 },
  { pattern: '.cursorrules',          priority: 30 },
  { pattern: '.github/copilot-instructions.md', priority: 40 },
]

class InstructionLoader {
  /** 从项目目录加载指令文件 */
  loadFromDir(projectDir: string): InstructionFile[] {
    const results: InstructionFile[] = []
    for (const { pattern, priority } of INSTRUCTION_FILE_PATTERNS) {
      const filePath = path.join(projectDir, pattern)
      if (fs.existsSync(filePath)) {
        results.push({
          path: filePath,
          name: pattern,
          content: fs.readFileSync(filePath, 'utf-8'),
          priority,
        })
      }
    }
    return results.sort((a, b) => a.priority - b.priority)
  }
}
```

### 24.7.3 与 Prompt 拼装的集成

项目指令注入到 system prompt 的"工作台 / cwd"区域之后、"记忆"区域之前：

```
...
6. 工作台 / cwd（动态注入）
6.5 项目指令（从 cwd 目录加载的 .pi-instructions.md 等）
7. 记忆规则 + 置顶记忆 + 记忆（动态注入）
...
```

---

## 24.8 Cron 自动化

### 24.8.1 设计

参考 openhanako 的 `cron-scheduler.js`，支持定时任务：

```typescript
// core/agent/cron-scheduler.ts

interface CronJob {
  id: string
  agentId: string
  schedule: string             // cron 表达式
  prompt: string               // 执行的 prompt
  enabled: boolean
  lastRunAt: string | null
  lastResult: 'success' | 'error' | null
  timeoutMs: number            // 执行超时（默认 300000 = 5 分钟）
}

class CronScheduler {
  private timer: NodeJS.Timer | null = null

  start(): void {
    // 每分钟检查是否有任务到期
    this.timer = setInterval(() => this.checkJobs(), 60_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private async checkJobs(): Promise<void> {
    const now = new Date()
    const jobs = this.getEnabledJobs()

    for (const job of jobs) {
      if (!isDue(job.schedule, now)) continue

      try {
        await Promise.race([
          this.executeJob(job),
          sleep(job.timeoutMs).then(() => { throw new AppError({ code: 'CRON_TIMEOUT' }) }),
        ])
        job.lastResult = 'success'
      } catch {
        job.lastResult = 'error'
      }
      job.lastRunAt = now.toISOString()
    }
  }
}
```

### 24.8.2 存储与 API

- **存储**：`{dataDir}/cron-jobs.yaml`
- **API**：`GET/POST/PUT/DELETE /api/cron`
- **前端**：设置页面的"自动化"标签

---

## 24.9 server-info.json

### 24.9.1 设计

agent-server 启动后写入端口信息，Main 进程读取连接：

```typescript
// agent-server 启动后
const serverInfo = {
  pid: process.pid,
  port: server.addresses().port,
  startedAt: new Date().toISOString(),
  version: APP_VERSION,
}
fs.writeFileSync(path.join(dataDir, 'server-info.json'), JSON.stringify(serverInfo, null, 2))
```

Main 进程启动 agent-server 后，轮询 `server-info.json` 直到文件出现，然后读取端口建立连接。

---

## 24.10 会话标题自动生成

### 24.10.1 设计

首轮对话完成后，用 LLM 生成简短的会话标题：

```typescript
// core/session/session-title.ts

async function generateSessionTitle(
  firstUserMessage: string,
  firstAssistantReply: string,
): Promise<string> {
  // 用 utility 模型（便宜快速）生成标题
  const prompt = `根据以下对话，生成一个 5-10 字的简短标题，只输出标题本身，不加引号：\n\n用户：${firstUserMessage}\n助手：${firstAssistantReply.slice(0, 200)}`

  const result = await llmService.call(prompt, { model: 'utility' })
  return result.trim().slice(0, 30)  // 截断保底
}
```

触发时机：首轮 assistant 消息完成后异步生成，不阻塞对话流。

---

## 25. 共享包划分

### 25.1 @repo/shared

纯工具函数 + 通用类型，不依赖任何运行时环境。

```
@repo/shared/
  ├── api/          # ApiSuccess / ApiFailure / PageQuery / PageResult
  ├── errors/       # AppError / ErrorSeverity / ErrorCategory / ERROR_DEFS
  └── utils/        # 通用工具函数
```

### 25.2 @repo/protocol

AG-UI 协议定义 + API 请求/响应契约。前后端都依赖此包保证协议一致。

```
@repo/protocol/
  ├── agui/         # AG-UI 事件类型（RUN_STARTED, TEXT_MESSAGE_CONTENT, ...）
  ├── agent/        # AgentMessage / AgentRunInput / AgentRole
  ├── ws/           # WebSocket 事件类型（WsServerEvent / WsClientEvent）
  └── api/          # API 路由的请求/响应类型
```

### 25.3 @repo/config

配置 Schema + 环境变量解析。

```
@repo/config/
  ├── shared/       # RuntimeMode / BrowserConfig / NodeConfig
  ├── node/         # nodeEnvSchema / nodeConfig
  ├── browser/      # browserEnvSchema / browserConfig
  └── schema/       # 三层配置的 Zod Schema
      ├── preferences-schema.ts   # Global 配置
      ├── agent-config-schema.ts  # Agent 配置
      └── session-meta-schema.ts  # Session 配置
```

---

## 26. 目录结构（重组后）

```
agent-server/src/
  core/                          # 核心领域（按领域分）
    agent/
      pi-session.ts              # Pi SDK createAgentSession 工厂 + 钩子注入
      pi-agui-agent.ts           # PiAgUiAgent（AG-UI 适配层，参考 pi-agui 模板）
      stream-emitter.ts          # Pi SDK 事件 → AG-UI 事件映射
      session-store.ts           # PiSessionStore（活跃会话管理）
      instruction-loader.ts      # 项目级指令加载
      concurrency-limiter.ts     # Subagent 并发限流
      cron-scheduler.ts          # 定时任务调度
    session/
      session-health.ts          # 健康检查 + 孤儿修复
      session-file-registry.ts   # 会话文件生命周期管理
      # 注：SessionManager/SessionStore/Compaction 由 Pi SDK 内置提供
    memory/
      fact-store.ts              # sql.js（WASM SQLite）事实存储 + LRU 缓存
      session-summary.ts         # LLM 会话摘要
      memory-ticker.ts           # 定时编译调度（turn-based + 启动检查 + 崩溃恢复）
      memory-store.ts            # 接口定义
      memory-reflection.ts       # 记忆反思（shadow/write 模式）
      memory.plugin.ts
    config/
      config-coordinator.ts      # 三层配置合并
      preferences-store.ts       # Global 配置读写
      credential-bridge.ts       # Electron safeStorage → Pi SDK getApiKey 桥接
      outbound-proxy.ts          # 出站网络代理（HTTP/HTTPS/SOCKS）
      config-schema.ts           # Zod Schema
      config.plugin.ts
    tool/
      gate.ts                    # 权限检查接口（Gate + DefaultGate）
      evidence-ledger.ts         # 任务验证（Evidence + Final Readiness）
      search-rate-limiter.ts     # 搜索 API 速率限制
      # 注：内置工具（read/bash/edit/write/grep/find/ls）由 Pi SDK 提供
      # 注：工具注册/查询由 Pi SDK ToolRegistry 提供
    migration/
      migration-runner.ts        # 迁移执行器
      migrations/                # 各迁移实现
        001-clean-dangling-providers.ts
        002-migrate-model-refs.ts
        ...
    usage/
      usage-ledger.ts            # LLM 用量追踪
      cost-rates.ts              # 成本估算价格表
      usage.plugin.ts
  extensions/                    # Pi SDK Extensions（自定义工具）
    web-search.ts                # web_search + web_fetch 扩展
    memory-search.ts             # memory_search 扩展
    ...
  routes/                        # HTTP 路由（薄层）
    agui.route.ts                # AG-UI 协议（参考 pi-agui 模板完整路由）
    copilotkit.route.ts          # CopilotKit 适配
    config.route.ts              # 配置读写 + Provider 刷新
    usage.route.ts               # 用量查询
    health.route.ts              # 健康检查
  plugins/                       # Fastify 插件
    pi-sdk.plugin.ts             # Pi SDK 核心对象注册（AuthStorage/ModelRegistry/SessionManager）
    event-bus.plugin.ts          # EventBus 注册
    cors.plugin.ts               # CORS 白名单
    auth.plugin.ts               # Bearer Token 认证
    rate-limit.plugin.ts         # 速率限制
    error-handler.plugin.ts      # 错误处理
  lib/                           # 基础设施
    sse.ts                       # SSE 工具
    validate.ts                  # 请求校验
    logger.ts                    # createModuleLogger
    errors.ts                    # AppError 工厂 + 错误脱敏
    retry.ts                     # Decorrelated Jitter 重试
    safe-fs.ts                   # atomicWriteSync / safeReadYAMLSync
    event-bus.ts                 # EventBus 进程内事件总线
    ws-events.ts                 # WebSocket 事件类型
    i18n.ts                      # 国际化
  app.ts                         # Fastify 应用（注册所有插件和路由 + graceful shutdown）
  index.ts                       # 入口
```

> **与原方案的主要差异**：
> - `core/llm/` 目录删除（LLMService、agent-loop、stream-parsers、mid-turn-steer 等由 Pi SDK 内置）
> - `core/tool/tools/` 目录删除（内置工具由 Pi SDK 提供，自建工具移到 `extensions/`）
> - `core/session/` 精简（SessionManager/Compaction 由 Pi SDK 内置）
> - 新增 `extensions/` 目录（Pi SDK Extensions 机制）
> - 新增 `plugins/pi-sdk.plugin.ts`（Pi SDK 核心对象注册）
> - `credential-store.ts` → `credential-bridge.ts`（桥接 safeStorage → Pi SDK）

---

## 27. 测试策略

### 27.1 混合测试

| 类型 | 范围 | 工具 | 速度 |
|------|------|------|------|
| **单元测试** | Agent 类、Memory 编译、Prompt 拼装、Tool 逻辑 | Vitest | 快 |
| **集成测试** | API 路由（Fastify inject）、Service 交互 | Vitest + Fastify | 中 |

### 27.2 测试原则

- 核心领域逻辑必须有单元测试
- API 路由用 `fastify.inject()` 做集成测试
- Pi SDK 调用在测试中 mock
- FactStore 测试用 sql.js 内存模式（`:memory:`）

---

## 28. 实施路线图

> 核心原则：**先通后优**。每个阶段结束后都有可运行的交付物，而不是全部做完才能用。
> v1.0 范围 = P0-P10（单 Agent 可日常使用的完整体验），P11-P13 移至 v1.1+。

```
v1.0 主线（P0→P1→P2→P3→P4→P5→P6→P7→P8→P9→P10）

P0 基础设施 + 安全基线
 │
P1 配置 + 容器
 │
 ├─→ P2 迁移 + Provider ──→ P4 LLM 接入 ──→ P5 工具系统 ──→ P6 Session ──→ P7 Compaction ──→ P8 Memory
 │                                              │                    │
 │                                              ├─→ P9 Usage(并行)   └─→ P10 WebSocket
 │                                              │
 │                                              └─→ P13a 前端最小集(并行)
 │
P3 Agent 类 + Prompt ──────────→ P4

v1.1+ 支线
P11 Plugin 系统 ──→ P12 Subagent 协作
P13b 前端完善
```

### 阶段 0：基础设施 + 安全基线（P0）

**目标**：项目骨架可编译，共享包可用，安全基线就位。

| 内容 | 交付物 |
|------|--------|
| `@repo/protocol` 包（AG-UI 事件类型 + API 契约） | 新包 |
| `@repo/shared` AppError 体系 + ERROR_DEFS + 错误脱敏 | 错误体系 |
| 目录结构重组（按领域分） | 目录骨架 |
| `lib/safe-fs.ts`（atomicWriteSync / safeReadYAMLSync） | 安全文件操作 |
| `lib/retry.ts`（Decorrelated Jitter 重试） | 重试基础设施 |
| `lib/i18n.ts`（中文优先） | 国际化基础 |
| `lib/event-bus.ts`（EventBus 进程内事件总线） | 模块解耦基础 |
| CORS 白名单中间件 | 防止非授权来源访问 agent-server |
| Bearer Token 认证骨架 | 防止本地其他应用调用 API |
| 输入验证（Zod schema 校验所有 API 入参） | 防注入 |
| `@fastify/rate-limit` 速率限制 | 防请求洪泛 |

**验证**：`pnpm typecheck` 通过，`@repo/protocol` 和 `@repo/shared` 可被其他包引用，
非白名单来源的请求被 CORS 拒绝，无 Token 请求返回 401。

---

### 阶段 1：配置 + 容器（P1）

**目标**：配置可读写，Pi SDK 可注册，应用可启动和关闭。

| 内容 | 交付物 |
|------|--------|
| Service Container（Fastify 插件模式） | 服务注册/发现 |
| EventBus 插件注册 | 进程内事件总线 |
| Pi SDK 插件（AuthStorage + ModelRegistry + SessionManager + getApiKey） | Pi SDK 核心对象 |
| CredentialBridge（Electron safeStorage → Pi SDK getApiKey 桥接） | API Key 安全存储 |
| ConfigService（三层配置合并） | 配置读写 |
| OutboundProxy（系统/手动代理） | 网络代理 |
| LoggerService（createModuleLogger） | 模块日志 |
| Graceful Shutdown | 优雅关闭 |
| server-info.json（端口写入） | Main 进程连接 |

**验证**：agent-server 可启动，`GET /api/health` 返回 200，配置文件可读写。

---

### 阶段 2：迁移 + Provider（P2）

**目标**：数据可迁移，Provider 可注册。

| 内容 | 交付物 |
|------|--------|
| Migration 系统（migration-runner + 首条迁移） | 数据迁移基础设施 |
| Pi SDK ModelRegistry（内置模型 + 自定义模型） | 模型能力声明 |
| Provider 配置 API（前端 → Main → agent-server） | 页面动态配置 Provider |
| API Key 连通性验证 | 配置即时反馈 |

**验证**：可通过 API 添加 Provider，验证 API Key，agent-server 刷新后新 Provider 可用。

---

### 阶段 3：Agent 类 + Prompt（P3）

**目标**：Agent 可实例化，Prompt 可拼装。

| 内容 | 交付物 |
|------|--------|
| Pi Session 工厂（createPiSession + createAgentSession） | Agent 实例 |
| PiAgUiAgent（AG-UI 适配层，参考 pi-agui 模板） | AG-UI 事件映射 |
| StreamEmitter（Pi SDK 事件 → AG-UI 事件） | SSE 流式输出 |
| DefaultResourceLoader + systemPromptOverride | Prompt 混合拼装 |
| Prompt Token 预算（各区域 token 上限 + enforceBudget） | 防 system prompt 膨胀 |
| 身份模板（identity.md / personality.md） | 可编辑人格 |
| InstructionLoader（项目级指令加载） | 自动加载 .pi-instructions.md 等 |
| 缓存优化（PrefixShape 诊断 + tools schema 排序） | 缓存命中率追踪 |
| Pi SDK 会话标题自动生成 | 会话列表可读 |

**验证**：Agent 可创建，`systemPromptOverride()` 输出完整 prompt，PrefixShape 可诊断缓存命中，
token 预算超限时自动截断。

---

### 阶段 4：LLM 接入（P4）

**目标**：Agent 可以真正对话。这是**第一个可用的里程碑**。

| 内容 | 交付物 |
|------|--------|
| PiAgUiAgent.streamRun()（主运行方法） | SSE 流式对话 |
| AG-UI 完整路由（参考 pi-agui 模板：run/steer/followUp/fork/compact/models/tools） | AG-UI REST API |
| PiSessionStore（活跃会话管理） | 会话复用 |
| Pi SDK Agent Loop（内置 LLM → tool_call → 工具 → LLM 循环 + parallel 执行） | 核心执行逻辑 |
| Pi SDK steer/followUp（内置中途引导） | 运行中注入用户消息 |
| Pi SDK validateToolCall（内置工具参数校验） | 缓存一致性 |
| CopilotKit 兼容层 | CopilotKit 请求适配 |

**验证**：前端发消息 → agent-server 调用 LLM → SSE 流式返回 → 前端显示。

---

### 阶段 5：工具系统（P5）

**目标**：Agent 可以执行操作。

| 内容 | 交付物 |
|------|--------|
| Pi SDK 内置工具（read/bash/edit/write/grep/find/ls） | 文件和命令操作 |
| Extensions（web_search / web_fetch / memory_search） | 网络和记忆工具 |
| Gate 接口 + DefaultGate（beforeToolCall 钩子实现权限检查） | 权限控制 |
| SearchRateLimiter（per-Provider 速率策略） | 搜索限流 |
| Evidence Ledger（afterToolCall 钩子实现任务验证） | 防假装完成 |

**验证**：Agent 可搜索网页、读写文件、执行 shell，权限模式生效，Gate 拦截越权操作。

---

### 阶段 6：Session 管理（P6）

**目标**：多轮对话持久化，会话可恢复。

| 内容 | 交付物 |
|------|--------|
| Pi SDK SessionManager（JSONL + 树结构 + 分支） | 会话持久化 |
| Session Health（健康检查 + 孤儿修复） | 坏会话自动修复 |
| SessionFileRegistry（工具产出文件管理） | 文件生命周期 |

**验证**：关闭应用后重新打开，历史会话可恢复，坏会话自动修复。

---

### 阶段 7：Session Compaction（P7）

**目标**：长对话不卡死。

| 内容 | 交付物 |
|------|--------|
| Pi SDK autoCompaction（内置自动压缩） | 上下文溢出处理 |
| 手动 compact API（POST /ag-ui/agent/:id/compact） | 用户手动触发 |
| Storm Breaker（afterToolCall 钩子实现死循环防护） | 工具调用死循环检测 |
| 工具输出截断（32KB head+tail） | 防单工具撑爆 context |

**验证**：对话超过 context window 80% 时自动后台压缩，用户可继续对话，压缩完成后 EventBus 通知前端。

---

### 阶段 8：Memory 系统（P8）

**目标**：Agent 有记忆。

| 内容 | 交付物 |
|------|--------|
| FactStore（sql.js 事实存储 + LRU 缓存 + 标签/关键词检索） | 结构化记忆 |
| SessionSummary（LLM 会话摘要） | 会话压缩 |
| MemoryTicker（完整调度：turn-based + 启动检查 + 崩溃恢复 + 步骤健康） | 记忆编译流水线 |
| Memory Reflection（shadow/write 双模式） | 记忆质量验证 |
| memory_search 工具 | 记忆检索 |

**验证**：Agent 可记住用户偏好，跨会话记忆可用，记忆编译失败不影响正常对话。

---

### 支线：Usage Ledger（P9，P4 起并行）

**目标**：成本感知。

| 内容 | 交付物 |
|------|--------|
| UsageLedger（token 用量 + 成本 + 归因） | 用量追踪 |
| cost-rates.ts（Provider 价格表） | 成本估算 |
| `GET /api/usage` 查询 API | 前端用量面板 |
| EventBus 集成（llm:call_complete 事件驱动记录） | 实时用量更新 |

**验证**：每次 LLM 调用后 UsageLedger 有记录，前端可查看用量。

---

### 支线：WebSocket 双向通信（P10，依赖 P6）

**目标**：实时推送 + 工具确认。

| 内容 | 交付物 |
|------|--------|
| Fastify WebSocket 插件 | WS 服务端 |
| WebSocket 认证（upgrade 时验证 Token） | 防未授权连接 |
| EventBus → WebSocket 转发 | 实时推送 |
| confirmation_request / memory_updated / agent_status / notification | 推送事件类型 |

**验证**：工具需要确认时前端弹出确认框，记忆编译完成时前端收到通知，未认证 WS 连接被拒绝。

---

### 支线：前端最小集（P13a，P4 起并行，v1.0 必须）

**目标**：v1.0 必须可用的前端功能。

| 内容 | 交付物 |
|------|--------|
| Provider 设置页面（动态配置 LLM + API Key 管理） | 页面配置 |
| Zustand 状态管理 | 客户端状态 |
| 混合 IPC（SSE/WS 直连 + 配置走 Main） | 通信优化 |
| 自动更新（electron-updater） | 版本更新 |

**验证**：桌面应用可通过设置页面配置 Provider 和 API Key，可自动更新。

---

### v1.1+ 支线

#### Plugin 系统（P11，依赖 P8）

**目标**：可扩展。

| 内容 | 交付物 |
|------|--------|
| PluginManager（扫描 / 加载 / 卸载） | 插件生命周期 |
| Plugin SDK（registerTool / registerRoute / onEvent / registerPanel） | 插件 API |

**验证**：可加载外部插件，插件注册的工具在 Agent 中可用。

---

#### Subagent 协作（P12，依赖 P11）

**目标**：多 Agent 协作。

| 内容 | 交付物 |
|------|--------|
| subagent 工具（派遣子任务） | Agent 间协作 |
| ConcurrencyLimiter（并发 + 深度 + 总数限制） | 防失控 |
| 频道 / DM 通信 | Agent 间异步交流 |

**验证**：主 Agent 可派遣子任务给其他 Agent，并发数受控。

---

#### 前端完善（P13b）

**目标**：完整桌面体验。

| 内容 | 交付物 |
|------|--------|
| i18n 完善 | 多语言 |
| Cron 管理页面 | 定时任务 UI |
| Usage 面板（用量图表） | 成本可视化 |

**验证**：桌面应用完整可用，多语言切换正常，定时任务可管理。

---

### 里程碑总结

| 里程碑 | 阶段 | 能力 | 版本 |
|--------|------|------|------|
| **Alpha** | P0-P4 | Agent 可以对话（echo → 真实 LLM） | 内测 |
| **Beta** | P5-P6 | Agent 可以操作（工具 + 持久化） | 公测 |
| **RC** | P7-P8 | Agent 有记忆（Compaction + Memory） | 候选 |
| **v1.0** | P0-P10 + P13a | 单 Agent 可日常使用（用量 + WS + Provider 设置） | 正式 |
| **v1.1** | P11-P12 | 可扩展 + 多 Agent 协作 | 增强 |
| **v1.2** | P13b | 前端完善（i18n + Cron + Usage 面板） | 完善 |

### v1.0 范围收敛

**v1.0 包含**（P0-P10 + P13a）：
- P0 基础设施 + 安全基线
- P1 配置 + 容器
- P2 迁移 + Provider
- P3 Agent 类 + Prompt（含 Token 预算）
- P4 LLM 接入（自建 Agent Loop + 工具并行化）
- P5 工具系统（Gate 权限控制）
- P6 Session 管理（JSONL append-only）
- P7 Session Compaction（异步后台压缩）
- P8 Memory 系统（sql.js + LRU 缓存 + 启动检查）
- P9 Usage Ledger
- P10 WebSocket 双向通信（含认证）
- P13a 前端最小集（Provider 设置页面）

**v1.0 不包含**（移至 v1.1+）：
- P11 Plugin 系统 → v1.1
- P12 Subagent 协作 → v1.1
- P13b 前端完善 → v1.2

> **原则**：v1.0 必须是"单 Agent 可日常使用"的完整体验。
> Plugin 和 Subagent 是增强功能，不影响核心使用。

---

## 29. 后续实施计划（P0-P4 SDK 集成完成后）

> **背景**：P0-P4 SDK 集成已通过 8 个子代理任务完成（35 个测试通过，4 次 commit）。
> 本章节描述从当前状态推进到 v1.0 Alpha 里程碑的后续工作。

### 29.1 当前状态盘点

**已完成（P0-P4 等价交付）：**

| 模块 | 交付物 | 测试 |
|------|--------|------|
| `@repo/protocol` | AG-UI 事件类型 + 12 个 Zod schema | 16 |
| `@repo/shared` | AppError + EventBus + safe-fs + retry + i18n | 25 |
| 安全基线 | CORS 白名单 + Bearer Token（timingSafeEqual）+ 速率限制 + AppError 集成 | 6 |
| Pi SDK 集成 | AuthStorage + ModelRegistry + SessionManager + EventBus 插件 | 5 |
| CredentialBridge | 三级优先级 API Key 获取 | 4 |
| ConfigCoordinator | 三层配置合并（global → project → session） | 3 |
| 核心适配层 | StreamEmitter + ReasoningPipeline + PiAgUiAgent + SessionStore + Gate | 12 |
| AG-UI 路由 | 12 个 REST 端点 + SSE 流式 + CopilotKit 弃用层 | 5 |
| 启动逻辑 | 优雅关闭 + 端点日志 + web-search 扩展骨架 | - |

**已知遗留问题（不阻塞 Alpha，但需在 Beta 前修复）：**

| 编号 | 问题 | 影响 | 修复时机 | 状态 |
|------|------|------|----------|------|
| L1 | `createAgentSession` 类型不接受 `getApiKey`/`beforeToolCall`/`afterToolCall` | 类型检查警告，运行时待验证 | P5 启动前 | ✅ 已修复（commit cda6146） |
| L2 | `agui.route.ts` 双重类型断言 `input as unknown as RunAgentInput` | 类型安全性降低 | P5 | ✅ 已修复（定义 StreamRunInput） |
| L3 | `PiAgUiAgent.threadStateByThread` 死代码 | 代码冗余 | P5 | ✅ 已修复 |
| L4 | `pnpm test` 触发 `ERR_PNPM_IGNORED_BUILDS` | 测试命令需绕过 pnpm | P5 | ✅ 已验证正常 |
| L5 | `ConfigCoordinator` 浅合并，对象类型配置被整体替换 | 嵌套配置合并异常 | P6 | 待修复 |
| L6 | `navigate` 路由直接访问 `threadSession.session.navigateTree` | 破坏封装性 | P6 | 待修复 |
| L7 | Fastify JSON 解析错误(400)被误转为 500 | 错误状态码不正确 | P5 | ✅ 已修复（添加 4xx 分支） |

### 29.2 Alpha 冲刺（目标：真实 LLM 对话可用）

**阶段 A1：端到端启动验证（优先级最高）**

| 任务 | 验证标准 |
|------|----------|
| 配置真实 API Key（PI_API_KEY 或 PI_API_KEY_ANTHROPIC） | 环境变量就位 |
| 启动 agent-server（`pnpm dev`） | 监听 127.0.0.1:3900 |
| `curl /api/health` | 返回 200 |
| `curl /ag-ui/info` | 返回协议信息 |
| `curl -N POST /ag-ui/agent/default/run` | SSE 流式返回 RUN_STARTED → TEXT_MESSAGE_* → RUN_FINISHED |
| 修复 L1：Pi SDK API 差异 | 类型检查无警告 |
| 修复 L4：pnpm test 脚本 | `pnpm test` 直接可用 |

**阶段 A2：P5 工具系统完善**

| 任务 | 依赖 | 验证标准 |
|------|------|----------|
| Gate 集成到 `createPiSession` 的 `beforeToolCall` | A1 | 工具调用前权限检查生效 |
| Pi SDK 内置工具激活（read/bash/edit/write/grep/find/ls） | A1 | Agent 可读写文件、执行命令 |
| web-search 扩展实现（接入实际搜索 API） | A1 | `web_search`/`web_fetch` 可用 |
| Evidence Ledger（`afterToolCall` 钩子） | A1 | 工具产出记录可查 |
| SearchRateLimiter（per-Provider 速率策略） | A1 | 搜索工具限流生效 |
| 修复 L2、L3 | A1 | 类型安全 + 清理死代码 |

**阶段 A3：P6 Session 持久化验证**

| 任务 | 依赖 | 验证标准 |
|------|------|----------|
| Pi SDK SessionManager 持久化验证 | A2 | 关闭重启后会话可恢复 |
| Session Health（尾扫描 + 读时修复） | A2 | 坏会话自动修复 |
| SessionFileRegistry（工具产出文件管理） | A2 | 文件生命周期可追踪 |
| 修复 L5、L6 | A2 | 深合并 + 封装修复 |

**Alpha 里程碑验证**：
```
1. 启动 agent-server
2. 发送 "读取 package.json 并总结" → Agent 调用 read 工具 → 返回总结
3. 关闭 agent-server → 重新启动 → 历史会话可恢复
4. Gate 拦截危险工具（如 rm -rf）
```

### 29.3 Beta 冲刺（目标：长对话 + 记忆 + 成本感知）

**阶段 B1：P7 Session Compaction**

| 任务 | 依赖 | 验证标准 |
|------|------|----------|
| Pi SDK autoCompaction 验证 | Alpha | 上下文溢出时自动后台压缩 |
| 手动 compact API 验证 | Alpha | `POST /ag-ui/agent/:id/compact` 可用 |
| Storm Breaker（`afterToolCall` 死循环防护） | Alpha | 工具调用死循环被检测 |
| 工具输出截断（32KB head+tail） | Alpha | 单工具输出不撑爆 context |

**阶段 B2：P8 Memory 系统**

| 任务 | 依赖 | 验证标准 |
|------|------|----------|
| FactStore（sql.js + LRU 缓存 + 标签检索） | B1 | 结构化记忆可读写 |
| SessionSummary（LLM 会话摘要） | B1 | 会话压缩可用 |
| MemoryTicker（turn-based + 启动检查 + 崩溃恢复） | B1 | 记忆编译流水线运行 |
| Memory Reflection（shadow/write 双模式） | B1 | 记忆质量验证 |
| `memory_search` 工具 | B1 | Agent 可检索记忆 |

**阶段 B3：P9 Usage Ledger（与 B1/B2 并行）**

| 任务 | 依赖 | 验证标准 |
|------|------|----------|
| UsageLedger（token + 成本 + 归因） | Alpha | 每次 LLM 调用有记录 |
| cost-rates.ts（Provider 价格表） | Alpha | 成本可估算 |
| `GET /api/usage` 查询 API | Alpha | 前端可查询用量 |
| EventBus 集成（`llm:call_complete` 驱动） | Alpha | 实时用量更新 |

**Beta 里程碑验证**：
```
1. 长对话超过 context window 80% → 自动压缩 → 可继续对话
2. Agent 记住用户偏好（如"我喜欢 TypeScript"）→ 跨会话生效
3. 前端可查看 token 用量和成本
4. 工具调用死循环被 Storm Breaker 中断
```

### 29.4 RC 冲刺（目标：实时推送 + 桌面应用可用）

**阶段 C1：P10 WebSocket 双向通信**

| 任务 | 依赖 | 验证标准 |
|------|------|----------|
| Fastify WebSocket 插件 | Beta | WS 服务端运行 |
| WebSocket 认证（upgrade 时验证 Token） | Beta | 未认证连接被拒绝 |
| EventBus → WebSocket 转发 | Beta | 实时推送生效 |
| 推送事件类型（confirmation_request / memory_updated / agent_status / notification） | Beta | 前端收到推送 |

**阶段 C2：P13a 前端最小集（与 C1 并行）**

| 任务 | 依赖 | 验证标准 |
|------|------|----------|
| Provider 设置页面（动态配置 LLM + API Key 管理） | Alpha | 页面可配置 |
| Zustand 状态管理 | Alpha | 客户端状态管理 |
| 混合 IPC（SSE/WS 直连 + 配置走 Main） | C1 | 通信优化 |
| 自动更新（electron-updater） | Alpha | 版本可更新 |

**RC 里程碑验证**：
```
1. 桌面应用可安装运行
2. 设置页面可配置 Provider 和 API Key
3. 工具需要确认时前端弹出确认框
4. 记忆编译完成时前端收到通知
5. 应用可自动更新
```

### 29.5 v1.0 发布清单

**必须完成：**
- [ ] Alpha：端到端启动 + P5 工具系统 + P6 Session 持久化
- [ ] Beta：P7 Compaction + P8 Memory + P9 Usage
- [ ] RC：P10 WebSocket + P13a 前端最小集
- [ ] 全量测试通过（目标 100+ 测试）
- [ ] 类型检查无错误（修复 L1-L6）
- [ ] 安全审计（CORS + 认证 + 速率限制 + 输入验证）
- [ ] 性能基线（首 token < 2s，长对话不卡死）

**不包含（移至 v1.1+）：**
- P11 Plugin 系统
- P12 Subagent 协作
- P13b 前端完善（i18n + Cron + Usage 面板）

### 29.6 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| Pi SDK API 与文档不符（L1） | 高 | 高 | 端到端启动验证时优先确认，必要时联系 SDK 作者 |
| sql.js 在 Electron 中加载问题 | 中 | 中 | 预先做 spike，备选 better-sqlite3 |
| WebSocket 认证与 SSE 认证冲突 | 中 | 中 | 统一 Token 来源，upgrade 时复用 Bearer Token |
| 前端 SSE 兼容性（Edge/Firefox） | 低 | 低 | 使用 EventSource polyfill |
| Memory 编译失败影响对话 | 中 | 高 | Memory Reflection shadow 模式 + 失败降级 |

### 29.7 子代理任务划分建议

后续阶段建议继续使用子代理驱动开发模式，任务划分原则：
- **单任务单文件族**：一个任务只涉及一个领域（如工具、会话、记忆）
- **TDD 强制**：每个任务必须先写测试
- **两阶段审查**：规格合规 + 代码质量
- **独立可 commit**：每个任务完成后可独立提交

**建议任务粒度（P5-P8）：**
- P5：4 个任务（Gate 集成、内置工具激活、web-search 实现、Evidence Ledger）
- P6：3 个任务（SessionManager 验证、Session Health、SessionFileRegistry）
- P7：3 个任务（autoCompaction 验证、Storm Breaker、工具输出截断）
- P8：5 个任务（FactStore、SessionSummary、MemoryTicker、Memory Reflection、memory_search 工具）

---

## 30. 前端实施计划（F0-F9）

> **背景**：前端完整规格见 [`docs/FRONTEND_DEVELOPMENT.md`](./FRONTEND_DEVELOPMENT.md)（14 章节，约 2000 行）。
> 本章节将其整合进主架构文档，定义与后端阶段的并行推进策略与启动时机。
> 配套可视化文档：
> - [`docs/pi_agent_前端信息架构总览.html`](./pi_agent_前端信息架构总览.html)
> - [`docs/主对话工作台界面线框.html`](./主对话工作台界面线框.html)
> - [`docs/消息类型与状态卡片规范.html`](./消息类型与状态卡片规范.html)
> - [`docs/实时交互时序流程.html`](./实时交互时序流程.html)
> - [`docs/Provider_管理设置页面.html`](./Provider_管理设置页面.html)

### 30.1 前端技术栈定型

| 层 | 技术 | 选型理由 |
|----|------|----------|
| 框架 | React 19 + TypeScript 5.9（strict） | 已有，并发特性支持流式渲染 |
| 构建 | electron-vite + Vite 7 | 已有，HMR + ESM |
| 样式 | Tailwind CSS v4（CSS 变量驱动主题） | utility-first，与 shadcn/ui 同源 |
| 组件库 | shadcn/ui + Radix UI | 可定制、a11y 内置、无运行时 license 风险 |
| 图标 | Lucide React | tree-shakeable，与 shadcn/ui 默认搭配 |
| 客户端状态 | Zustand 5 | §12 指定，轻量、无 Provider |
| 服务端状态 | TanStack Query 5 | 已有，SSE/WS 数据缓存与同步 |
| 动画 | Framer Motion 11 | 声明式动画，layout 动画 |
| Markdown | react-markdown + remark-gfm + rehype-highlight | Agent 输出渲染 |
| 代码高亮 | Shiki | VS Code 级别，与后端同源 |
| 表单 | react-hook-form + zod | 与后端 Zod schema 复用 |
| 图表 | Recharts 2 | 用量面板折线/饼/柱状图 |
| 虚拟列表 | @tanstack/react-virtual 3 | 会话列表/消息流长列表 |
| 快捷键 | react-hotkeys-hook | 全局快捷键 |
| 拖拽 | @dnd-kit/core | 会话排序、面板拖拽 |

> **CopilotKit 决策**：v1.0 移除 CopilotKit，自建完整对话 UI。原因：CopilotKit Sidebar 无法满足工具卡/思考块/确认卡等复杂需求，自研 UI 更好对接 AG-UI 协议细粒度事件，减少依赖体积。

### 30.2 信息架构与后端能力映射

| 前端模块 | 后端能力（ARCHITECTURE 章节） | 通信方式 | 启动依赖 |
|----------|------------------------------|----------|----------|
| 消息流 | §3.5 Agent Loop / §3.8 端到端数据流 | SSE (AG-UI) | P4 完成 ✅ |
| 工具确认 | §11.3 确认机制 / §22.7 Gate | WebSocket | P5 + P10 |
| 中途引导 (steer) | §22.11 Mid-turn Steer | SSE (POST) / WebSocket | P4 完成 ✅ |
| 会话管理 | §3.5 / §20 SessionFileRegistry | HTTP REST | P6 |
| Compaction 状态 | §13 Session Compaction | WebSocket | P7 |
| 记忆状态 | §6 记忆系统 / §22.9 Memory Reflection | WebSocket | P8 |
| Provider/模型配置 | §8 三层配置 / §21 ProviderRegistry | Electron IPC → Main | P4 完成 ✅ |
| API Key | §16 CredentialStore (safeStorage) | Electron IPC → Main | P4 完成 ✅ |
| 用量 | §14 Usage Ledger | HTTP REST + WebSocket | P9 |
| 权限模式 | §11 / §22.7 Gate | HTTP REST | P5 |
| 出站代理 | §24.5 OutboundProxy | Electron IPC → Main | 任意时机 |
| 自动更新 | §18 auto-updater | Electron IPC | 任意时机 |
| Cron | §24.8 CronScheduler | HTTP REST | v1.2 |
| DevLog | §23.2 DevLog | WebSocket | P10 |
| 通知 | §7.5 EventBus → WebSocket | WebSocket | P10 |

### 30.3 前端阶段与后端阶段并行策略

```
后端时间轴 ─────────────────────────────────────────────────────▶
  P0-P4 ✅    P5    P6    P7    P8    P9    P10    RC
   │           │     │     │     │     │     │      │
前端时间轴 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ▶
              F0    F1    F2    F3    F4    F5    F6  F7  F8  F9
              脚手架 对话  工具卡 会话  压缩  记忆  用量 推送 设置 打磨
```

**关键并行节点：**
- **F0 脚手架** 可立即启动（不依赖后端，仅搭 UI 骨架）
- **F1 对话可用** 依赖 P4（已完成 ✅），可立即启动
- **F2 工具卡** 依赖 P5（工具系统），需先完成 P5
- **F3 会话持久化** 依赖 P6（Session 持久化）
- **F4 压缩状态** 依赖 P7（Compaction）
- **F5 记忆面板** 依赖 P8（Memory 系统）
- **F6 用量面板** 依赖 P9（Usage Ledger）
- **F7 实时推送** 依赖 P10（WebSocket）
- **F8 设置中心** 部分依赖 P4（已完成 ✅），可与 F1-F7 并行
- **F9 打磨** 依赖 F0-F8 基本完成

### 30.4 立即可启动的前端工作

**当前后端状态**：P0-P4 完成，DeepSeek 真实 LLM 对话已验证通过。

**可立即启动的前端阶段：**

| 阶段 | 内容 | 依赖 | 预估工期 |
|------|------|------|----------|
| **F0 脚手架** | Tailwind + shadcn/ui 接入、三栏布局、主题系统、路由骨架、移除 CopilotSidebar | 无 | 1 周 |
| **F1 对话最小可用** | SSE 流式对话、消息流、输入区、会话列表、中断、三态 | P4 ✅ | 1.5 周 |
| **F8 设置中心（部分）** | Provider 管理、API Key 配置、通用设置 | P4 ✅ | 1 周（部分） |

**建议启动顺序：**
1. **立即启动 F0**（脚手架） — 不阻塞任何后端工作
2. **F0 完成后启动 F1**（对话可用） — 后端 P4 已就绪，可端到端验证
3. **F1 进行中并行启动 F8 部分**（Provider 设置） — 让用户能配置 API Key
4. **等待 P5 完成后启动 F2**（工具卡）

### 30.5 F0-F9 详细任务清单

#### F0 脚手架（1 周）

| 任务 | 验收标准 |
|------|----------|
| 接入 Tailwind v4 + shadcn/ui CLI | `pnpm dlx shadcn@latest init` 可用 |
| 安装 Lucide / Framer Motion / Zustand | 依赖就位 |
| 自定义标题栏组件 | 可拖拽，最小/最大/关闭可用 |
| 三栏布局骨架 | 左/中/右栏可折叠 |
| 主题系统（Light/Dark/System） | 切换生效并持久化 |
| 路由骨架（react-router） | `/` 与 `/settings` 可切 |
| 移除 CopilotSidebar，自建空壳 | 编译通过 |
| 全局状态栏 | 显示占位状态 |

#### F1 对话最小可用（1.5 周）

| 任务 | 验收标准 |
|------|----------|
| `useStreamingRun` hook | SSE 流接入，AG-UI 事件接收 |
| `MessageStream` 组件 | 流式文本逐字显示 |
| `MessageBubble` 用户/助手气泡 | Markdown 渲染 |
| `InputArea` 组件 | 多行输入，Enter 发送 |
| `SessionList` 组件 | 列表显示，新建会话 |
| `sessionStore` | 当前会话/消息状态 |
| 流式占位（打字指示） | 思考中有反馈 |
| 中断按钮 | 可中断运行 |
| 会话标题自动生成 | 首轮后显示标题 |
| 三态（loading/error/empty） | 全覆盖 |

#### F2 工具卡 + 确认（1 周，依赖 P5）

| 任务 | 验收标准 |
|------|----------|
| `ToolCallCard` 通用组件 | 状态机：pending→running→success/error |
| 工具类型差异化（read/bash/edit/grep/web_search） | 各类型专属展示 |
| `ConfirmationCard` 确认卡 | 嵌入消息流 |
| 顶部确认通知条 | 不阻塞 |
| WebSocket 客户端 | 接收 confirmation_request |
| 权限模式切换器 | Auto/Plan/Read-only 切换生效 |
| 危险操作红色强调 | 视觉区分 |

#### F3 会话持久化（1 周，依赖 P6）

| 任务 | 验收标准 |
|------|----------|
| 会话恢复（重开应用） | 历史会话可见 |
| 会话搜索 | 实时过滤 |
| 会话重命名/删除/导出 | 右键菜单 |
| 会话分支（Pi SDK 树结构） | 分支切换 |
| 会话列表虚拟化 | 1000+ 会话流畅 |
| 草稿持久化 | 切换不丢失输入 |

#### F4 压缩状态（0.5 周，依赖 P7）

| 任务 | 验收标准 |
|------|----------|
| 压缩横幅 | compaction 事件触发 |
| 上下文面板（右栏） | token 用量、阈值、缓存诊断 |
| 手动压缩按钮 | 确认弹窗 + 执行 |
| 压缩完成通知 | WebSocket 推送 |

#### F5 记忆面板（1 周，依赖 P8）

| 任务 | 验收标准 |
|------|----------|
| 记忆编译状态页 | 流水线步骤状态 |
| 事实库浏览 | 搜索/标签筛选 |
| 立即编译按钮 | 触发并反馈 |
| 记忆标签页（右栏） | 置顶记忆概览 |
| 反思验证入口 | shadow/write 模式 |

#### F6 用量面板（1 周，依赖 P9）

| 任务 | 验收标准 |
|------|----------|
| 用量概览卡片 | 总 token/成本/调用/缓存 |
| 成本趋势折线图 | Recharts |
| Agent 归因饼图 | Recharts |
| 模型明细柱状图 | Recharts |
| 明细列表分页 | 服务端分页 |
| 本轮用量提示 | 输入区下方 |
| 状态栏用量 | 实时更新 |
| 用量预警通知 | 阈值可配 |

#### F7 实时推送（0.5 周，依赖 P10）

| 任务 | 验收标准 |
|------|----------|
| WebSocket 重连 | 指数退避 |
| 通知中心 | 右上角下拉 |
| DevLog 面板 | 底部抽屉 |
| 通知分类与已读 | 按类型筛选 |
| 实时用量更新 | WS 推送刷新 |

#### F8 设置中心（1.5 周，部分可并行）

| 任务 | 验收标准 |
|------|----------|
| 设置布局（左导航+右内容） | 导航切换 |
| Provider 管理完整流程 | 增删改查 + API Key 测试 |
| 模型管理 | 自定义模型增删 |
| Agent 管理 | 编辑/人格模板编辑器 |
| 权限与安全 | 模式切换 + 目录白名单 |
| 通用设置 | 语言/主题/代理/数据目录 |
| 出站代理配置 | 系统代理/手动/测试 |
| 关于页 | 版本 + 检查更新 |
| 表单校验 | react-hook-form + zod |

#### F9 打磨（1 周）

| 任务 | 验收标准 |
|------|----------|
| 命令面板（Cmd+K） | 全局搜索命令 |
| 全套快捷键 | 见前端文档 §11.3 |
| 动画打磨 | 60fps，自然过渡 |
| a11y 审计 | 键盘全可达，对比度达标 |
| 性能优化 | 虚拟化、防抖、memo |
| 系统托盘 | 最小化、快速操作 |
| 自动更新 UI | 发现/下载/安装 |
| 错误边界 | 优雅降级 |
| 空状态设计 | 每个空状态有引导 |

### 30.6 前端里程碑

| 里程碑 | 前端阶段 | 后端依赖 | 能力 |
|--------|----------|----------|------|
| **M1 对话可用** | F0 + F1 | P4 ✅ | 能和 Agent 流式对话 |
| **M2 工具+持久化** | F2 + F3 | P5 + P6 | 工具卡、确认、会话恢复 |
| **M3 上下文+记忆** | F4 + F5 | P7 + P8 | 压缩感知、记忆管理 |
| **M4 用量+实时** | F6 + F7 | P9 + P10 | 成本可视、实时推送 |
| **M5 完整体验** | F8 + F9 | 全部 | 设置完整、交互打磨 |

### 30.7 性能基线（v1.0 验收）

| 指标 | 目标 |
|------|------|
| 首屏渲染 | < 500ms |
| 会话切换 | < 100ms（数据就绪后） |
| 流式首 token 显示 | < 200ms（收到事件后） |
| 长会话滚动 | 60fps（1000+ 消息） |
| 设置页打开 | < 300ms |
| 内存占用 | < 300MB（10 个会话） |

### 30.8 前端目录结构规范

```
apps/desktop/src/renderer/src/
├── components/
│   ├── ui/                    # shadcn/ui 基础组件（generated，约 20 个）
│   ├── chat/                  # 对话专用（11 个）
│   │   ├── chat-workspace.tsx
│   │   ├── session-list.tsx
│   │   ├── message-stream.tsx
│   │   ├── message-bubble.tsx
│   │   ├── thinking-block.tsx
│   │   ├── tool-call-card.tsx
│   │   ├── confirmation-card.tsx
│   │   ├── input-area.tsx
│   │   └── steer-indicator.tsx
│   ├── settings/              # 设置专用（10 个）
│   ├── overlays/              # 浮层（4 个）
│   └── shared/                # 通用业务组件（6 个）
├── hooks/                     # 自定义 hooks（6 个）
├── stores/                    # Zustand stores（4 个）
├── lib/                       # 工具函数（6 个）
├── routes/                    # 路由（2 个）
└── types/                     # 前端专用类型
```

预估组件总数：**约 70 个文件**。

### 30.9 前后端契约对齐

前端所有 API 调用与 WS 事件的类型，必须从 `@repo/protocol` 导入，确保前后端类型一致：

```typescript
import type {
  AguiAnyEvent,
  RunAgentInput,
  WsServerEvent,
  WsClientEvent,
} from '@repo/protocol'
```

**当前 `@repo/protocol` 已提供：**
- AG-UI 事件类型重导出（`events.ts`）
- 12 个 Zod schema（`schemas.ts`）：runAgentInput、threadMessage、forkThread、navigateThread、compactThread、toolsActive、reload、modelSelection、thinkingSettings、booleanToggle、queueMode、sessionName

**前端需补充的类型（F0 阶段）：**
- `WsServerEvent` / `WsClientEvent`（WebSocket 事件类型，待 P10 定义）
- `SessionSummary` / `Message` / `StreamingMessage`（前端状态类型）
- `ProviderConfig` / `AgentConfig` / `UsageRecord`（设置与用量类型）

---

## 附录 A：设计模式索引

| 模式 | 应用位置 | 说明 |
|------|----------|------|
| Service Locator | Service Container | Fastify 插件即容器，`fastify.xxx` 按名访问 |
| 工厂方法 | Pi Session | `createPiSession(deps)` + `createAgentSession()` 工厂 |
| 观察者 | EventBus | 进程内事件解耦，on/once/emit，WebSocket handler 订阅转发 |
| 适配器 | StreamEmitter | Pi SDK 事件 → AG-UI 事件格式转换（参考 pi-agui 模板） |
| 策略 | 权限模式 | Auto / Plan / Read-only 三种执行策略（beforeToolCall 钩子） |
| 策略 | SearchRateLimiter | per-Provider 独立速率策略 |
| 模板方法 | Prompt 拼装 | DefaultResourceLoader + systemPromptOverride |
| 门面 | PiAgUiAgent | 对 Pi SDK AgentSession 的 AG-UI 适配门面 |
| 代理 | CopilotKit 适配 | CopilotKit 请求代理到 PiAgUiAgent |
| 扩展 | Extensions | Pi SDK Extensions 机制注册自定义工具 |
| 迁移模式 | Migration 系统 | 版本化迁移表 + 增量执行 + 幂等 |
| 策略 | CredentialBridge | Electron safeStorage 加密 + Pi SDK getApiKey 回调 |
| 健康检查 | Session Health | 尾扫描评估 + 读时修复 |
| 钩子 | beforeToolCall/afterToolCall | Pi SDK 工具执行前后注入 Gate/Evidence/EventBus |
| 信号量 | ConcurrencyLimiter | Subagent 并发控制 + 总数 backstop |
| 重试 | withRetry | Decorrelated Jitter，AppError.retryable 驱动 |
| 证据 | EvidenceLedger | 任务完成验证 + Final Readiness Check |
| 反思 | MemoryReflection | shadow/write 双模式验证记忆质量 |

## 附录 B：参考项目对比

| 维度 | openhanako | DeepSeek-Reasonix | pi-agent | 理由 |
|------|-----------|-------------------|----------|------|
| 语言 | JavaScript | Go | TypeScript | 类型安全，IDE 支持 |
| 架构 | Engine Facade | — | Service Locator | 避免 Engine 膨胀 |
| HTTP 框架 | Hono | — | Fastify | 已有技术栈 |
| Service 注册 | Engine 属性 | — | Fastify 插件 | 复用 Fastify 生命周期 |
| 向量搜索 | 无 | — | 无 | 初期不需要 |
| 通信 | WebSocket 为主 | — | SSE + WebSocket | AG-UI 协议基于 SSE |
| 配置 | 两层（Global + Agent） | — | 三层（+ Session） | 会话级覆盖需求 |
| 插件 | 完整 | — | 完整 | 对齐 |
| 多 Agent | 协作 | — | 协作 | 对齐 |
| 缓存优化 | Prompt 排序 | PrefixShape 诊断 + append-only + 低频压缩 | 两者结合 | DeepSeek-Reasonix 的缓存策略更系统化 |
| Compaction | SessionSummary | 三级阈值 + Prune→Compact + kept/fold 分区 | 参考 DeepSeek-Reasonix | 更精细的压缩控制 |
| 死循环防护 | 无 | Storm Breaker | 参考 DeepSeek-Reasonix | 防止工具调用死循环 |
| 工具输出截断 | 无 | 32KB head+tail | 参考 DeepSeek-Reasonix | 防止单个工具输出撑爆 context |
