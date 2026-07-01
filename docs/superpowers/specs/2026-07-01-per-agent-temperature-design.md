# 按角色配置温度（Per-Agent Temperature）设计

- **日期**：2026-07-01
- **状态**：已批准，待规格审查
- **范围**：主 Agent 系统（subagent）+ 小说 Agent 角色（director/writer/reviewer/memory）

## 1. 背景与问题

项目存在两套 Agent 系统，二者当前都无法按角色调节温度：

1. **主 Agent 系统**：用户在设置页自定义的 subagent（编程专家/数据分析师等），配置存 SQLite `agents` 表。
2. **小说 Agent 系统**：`novel-agents.ts` 硬编码的 4 个创作角色（导演/写作/审稿/记忆）。

温度参数当前处于**完全断链**状态：

- 前端设置页有一个温度滑块（`agent-page.tsx:559-574`），但仅写入 localStorage（key `pi-agent.agent-config`），从不发送到后端。
- 后端所有 LLM 调用（`session.prompt()` / `session.promptStream()`）均不传温度，统一走 Pi SDK 默认值。
- `AgentConfig` / `NovelAgentConfig` / `agents` 表 / `PluginSessionOptions` 全部没有 `temperature` 字段。
- 不存在任何按角色配置温度的雏形。

## 2. 目标

- 两套 Agent 系统均支持**按角色独立配置温度**。
- 温度配置可持久化、可在 UI 编辑、并在 LLM 调用链实际生效。
- 保留"未配置则不传"的语义，避免覆盖 SDK/Provider 默认行为。

## 3. 技术调研结论

### 3.1 SDK 各层对 temperature 的支持

| 层级 | 是否支持 | 说明 |
|---|---|---|
| DeepSeek / OpenAI API | 是 | 标准 chat completion 参数 |
| `@earendil-works/pi-ai` provider 层 | 是 | `StreamOptions.temperature?: number`；DeepSeek 走 `openai-completions` provider |
| `OpenAICompletionsOptions extends StreamOptions` | 是 | 继承 temperature |
| `AgentSession.prompt(text, PromptOptions)` | 否 | `PromptOptions` 仅含 `images / streamingBehavior / source` 等 |
| `CreateAgentSessionOptions` | 否 | 仅含 `model / thinkingLevel / tools` 等 |
| **`Agent.onPayload` 钩子** | 是（注入点） | `(payload, model) => modifiedPayload \| undefined`，provider 请求发送前调用 |

### 3.2 注入机制

`@earendil-works/pi-agent-core` 的 `Agent` 类暴露公共字段：

```ts
onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>
// "Optional callback for inspecting or replacing provider payloads before sending.
//  Return undefined to keep the payload unchanged."
```

项目代码已能直接访问 `session.agent`（`pi-session.ts:148` 已用同样方式设置 `beforeToolCall`）。

**结论**：通过 `session.agent.onPayload = (payload) => ({ ...payload, temperature })` 即可注入温度，无需依赖扩展系统（`BeforeProviderRequestEvent`），方案比最初设想更简单可靠。

### 3.3 payload 格式

openai-completions provider 的 payload 形如 `{ messages, model, ... }`，追加 `temperature` 字段即被 DeepSeek/OpenAI 兼容接口接受。其他 provider（anthropic-messages 等）payload 同样接受顶层 `temperature`。

## 4. 架构设计

### 4.1 数据层

#### 4.1.1 主 Agent 系统

**迁移**：在 `core/db/migrations.ts` 新增迁移，给 `agents` 表添加列：

```sql
ALTER TABLE agents ADD COLUMN temperature REAL;
```

**类型**：`subagent-tool.ts:22` 的 `AgentConfig` 接口新增字段：

```ts
export interface AgentConfig {
  // ...existing fields
  temperature?: number
}
```

**持久化**：`agent-persistence.ts` 的 `SqliteAgentStore`：
- UPSERT SQL（第 33-45 行）新增 `temperature` 列与占位符。
- `rowToConfig`（第 88-99 行）从 row 解析 `temperature`（`row.temperature ?? undefined`）。

#### 4.1.2 小说 Agent 系统

**类型**：`novel-agents.ts:18` 的 `NovelAgentConfig` 新增字段，`NOVEL_AGENT_CONFIGS` 4 个角色加默认值（见 4.6）：

```ts
export interface NovelAgentConfig {
  // ...existing fields
  temperature?: number
}
```

**迁移**：在 `novel-migrations.ts` 新增 `044_create_novel_agent_config`，建表存运行时覆盖（全局配置，不按 project 区分）：

```sql
CREATE TABLE IF NOT EXISTS novel_agent_config (
  agent_type    TEXT PRIMARY KEY,
  temperature   REAL,
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
```

### 4.2 API 层

#### 4.2.1 主 Agent REST

`routes/agents.route.ts` 的 Zod schema（第 43-55 行）新增：

```ts
temperature: z.number().min(0).max(2).optional()
```

POST/PUT handler 透传 `temperature` 到 store。

#### 4.2.2 前端类型

`http-client.ts:233` 的 `AgentInfo` 新增 `temperature?: number`。

#### 4.2.3 小说 Agent 配置 REST

`novel-routes.ts` 新增两个端点（全局配置，不按 project）：

- `GET /api/novel/agent-config` → 返回 4 角色的 `{ agentType, temperature }` 列表（合并默认值与持久化覆盖）
- `PUT /api/novel/agent-config` → 批量更新（body: `[{ agentType, temperature }]`）

### 4.3 调用链注入层（核心）

#### 4.3.1 PluginSessionOptions

`core/plugin/plugin-types.ts:183` 的 `PluginSessionOptions` 新增：

```ts
temperature?: number
```

#### 4.3.2 plugin-manager createSession

`core/plugin/plugin-manager.ts` 的 createSession（第 787-807 行模型切换后、return 前）注入 `onPayload`：

```ts
if (options.temperature !== undefined) {
  const t = options.temperature
  threadSession.session.agent.onPayload = (payload) => ({
    ...(payload as Record<string, unknown>),
    temperature: t,
  })
}
```

#### 4.3.3 subagent dispatch

`plugins/subagent-plugin.ts:80-120`：在调用 createSession 时透传 `agentConfig.temperature`（`options.temperature = agentConfig.temperature`）。

#### 4.3.4 小说 orchestrator

`plugins/novel-plugin/core/novel-orchestrator.ts:335` 的 createSession 调用，传入合并后的温度：

```ts
// persistedOverride：从 novel_agent_config 表读取的运行时覆盖值（可能为 undefined）
const temperature = persistedOverride ?? novelAgentConfig.temperature
// 传给 context.createSession({ ..., temperature })
```

合并优先级：持久化覆盖 > 角色默认值 > 不传。

### 4.4 UI 层

#### 4.4.1 主 Agent 编辑/创建弹窗

`agent-page.tsx` 的 `AgentEditorDialog`（732-846）与 `AgentCreateDialog`（856-986）新增温度滑块，复用现有 559-574 行的滑块样式（`type="range" min="0" max="2" step="0.05"`）。

#### 4.4.2 全局默认温度

原"生成参数"区的 localStorage 温度滑块（551-579）改造为**"全局默认温度"**——新建 Agent 时的默认值（写入 localStorage `pi-agent.agent-config.temperature`），消除断链。

#### 4.4.3 小说角色温度配置

在 `agent-page.tsx` 设置页新增**"小说创作角色"分区**，4 个滑块对应 director/writer/reviewer/memory。与主 Agent 配置同页，体验一致。调用 `GET/PUT /api/novel/agent-config`。

### 4.5 状态流转

```
UI 滑块 → REST API → SQLite 持久化
                       ↓ (dispatch 时读取)
                   AgentConfig.temperature / NovelAgentConfig.temperature
                       ↓
                   PluginSessionOptions.temperature
                       ↓
                   plugin-manager createSession 注入
                       ↓
                   session.agent.onPayload(payload => {...payload, temperature})
                       ↓
                   pi-ai provider 调用带 temperature
                       ↓
                   DeepSeek/OpenAI API 实际生效
```

### 4.6 默认温度值

| 角色 | 默认温度 | 理由 |
|---|---|---|
| 主 Agent（新建） | 0.7 | 通用平衡值 |
| 主 Agent（未配置） | 不传 | 走 SDK 默认 |
| 小说 director（导演） | 0.5 | 规划稳定 |
| 小说 writer（写作） | 0.9 | 创作发散 |
| 小说 reviewer（审稿） | 0.3 | 审稿严谨 |
| 小说 memory（记忆） | 0.2 | 沉淀确定 |

## 5. 风险与降级

- **onPayload 兼容性**：已在 SDK 类型定义中确认 `Agent.onPayload` 为公共字段，低风险。
- **payload 格式**：openai-completions payload 追加 `temperature` 字段即生效；其他 provider 同理。返回 `{...payload, temperature}` 保留原字段。
- **temperature 为 undefined 时**：不设置 onPayload，行为与现状完全一致（走 SDK 默认），零回归风险。
- **数据库迁移幂等**：`ALTER TABLE ADD COLUMN` 在 SQLite 重复执行会报错；使用项目现有迁移机制（migrations 数组按 id 执行一次）保证幂等。

## 6. 测试策略

- **单元测试**：
  - `SqliteAgentStore` 读写 temperature 字段
  - `agent-persistence` rowToConfig 解析
  - novel-agent-config store 读写合并
- **集成测试**：
  - `plugin-manager.createSession` 传入 temperature 后 `session.agent.onPayload` 被正确设置
  - `onPayload` 回调对样例 payload 注入 temperature
  - REST API POST/PUT/GET 透传 temperature
- **回归测试**：temperature 为 undefined 时 createSession 行为与改动前一致（onPayload 未设置）

## 7. 不在范围内

- top_p / max_tokens / presence_penalty 等其他生成参数（YAGNI，仅做 temperature）
- 按 project 维度配置小说角色温度（统一全局配置）
- 主 Agent 温度的批量导入/导出
- 温度配置变更历史审计
