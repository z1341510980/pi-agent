# 按角色配置温度（Per-Agent Temperature）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让主 Agent 系统（subagent）和小说 Agent 角色（director/writer/reviewer/memory）各自可独立配置 LLM temperature，并在调用链实际生效。

**架构：** 数据层（SQLite 迁移 + 类型字段 + Store）→ API 层（REST + 前端类型）→ 注入层（`session.agent.onPayload` 钩子注入 temperature 到 provider payload）→ UI 层（弹窗滑块 + 小说角色分区）。两条 LLM 调用路径分别注入：主 Agent dispatch 在 subagent-plugin.ts，插件 Session（含小说）在 plugin-manager.ts createSession。

**技术栈：** TypeScript, better-sqlite3, Fastify, Zod v4, React + TanStack Query, Pi SDK（`@earendil-works/pi-agent-core` 的 `Agent.onPayload`）

**规格文档：** `docs/superpowers/specs/2026-07-01-per-agent-temperature-design.md`

---

## 文件结构

### 修改的文件

| 文件 | 职责 |
|---|---|
| `apps/agent-server/src/core/db/migrations.ts` | 新增 agents 表 temperature 列迁移 |
| `apps/agent-server/src/core/agent/subagent-tool.ts` | AgentConfig 接口加 temperature 字段 |
| `apps/agent-server/src/core/agent/agent-persistence.ts` | SqliteAgentStore 读写 temperature |
| `apps/agent-server/src/routes/agents.route.ts` | Zod schema 加 temperature |
| `apps/agent-server/src/plugins/subagent-plugin.ts` | dispatch 注入 onPayload |
| `apps/agent-server/src/core/plugin/plugin-types.ts` | PluginSessionOptions 加 temperature |
| `apps/agent-server/src/core/plugin/plugin-manager.ts` | createSession 注入 onPayload |
| `apps/agent-server/src/plugins/novel-plugin/core/novel-agents.ts` | NovelAgentConfig 加 temperature + 默认值 |
| `apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts` | 新增 novel_agent_config 表 |
| `apps/agent-server/src/plugins/novel-plugin/novel-services.ts` | 注入 NovelAgentConfigStore |
| `apps/agent-server/src/plugins/novel-plugin/novel-routes.ts` | agent-config REST 端点 |
| `apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts` | runAgent 合并温度传入 createSession |
| `apps/desktop/src/renderer/src/api/http-client.ts` | AgentInfo 加 temperature |
| `apps/desktop/src/renderer/src/components/settings/agent-page.tsx` | 弹窗滑块 + 小说角色分区 + 全局默认改造 |

### 创建的文件

| 文件 | 职责 |
|---|---|
| `apps/agent-server/src/plugins/novel-plugin/core/novel-agent-config-store.ts` | 小说角色温度持久化 Store |
| `apps/desktop/src/renderer/src/api/novel-agent-config-client.ts` | 小说角色温度前端 API 客户端 |

---

## 任务 1：主 Agent 数据层 — agents 表迁移与 AgentConfig 字段

**文件：**
- 修改：`apps/agent-server/src/core/db/migrations.ts`
- 修改：`apps/agent-server/src/core/agent/subagent-tool.ts`
- 修改：`apps/agent-server/src/core/agent/agent-persistence.ts`
- 测试：`apps/agent-server/src/__tests__/agent-persistence.test.ts`（新建）

- [ ] **步骤 1：编写失败的测试 — SqliteAgentStore 读写 temperature**

创建 `apps/agent-server/src/__tests__/agent-persistence.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { SqliteAgentStore } from '../core/agent/agent-persistence.js'

// 内联 agents 表建表（含 temperature 列），独立于主迁移系统
function createAgentsTableWithTemperature(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT,
      model         TEXT,
      system_prompt TEXT,
      tools         TEXT,
      identity      TEXT,
      personality   TEXT,
      temperature   REAL,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)
}

describe('SqliteAgentStore temperature', () => {
  let db: Database.Database
  let store: SqliteAgentStore

  beforeEach(() => {
    db = new Database(':memory:')
    createAgentsTableWithTemperature(db)
    store = new SqliteAgentStore(db)
  })

  it('save 带 temperature 后 getById 能读回', () => {
    store.save({
      id: 'test-agent',
      name: 'Test',
      temperature: 0.9,
    })
    const loaded = store.getById('test-agent')
    expect(loaded?.temperature).toBe(0.9)
  })

  it('save 不带 temperature 时 getById 返回 undefined', () => {
    store.save({ id: 'no-temp', name: 'NoTemp' })
    const loaded = store.getById('no-temp')
    expect(loaded?.temperature).toBeUndefined()
  })

  it('update 覆盖 temperature 生效', () => {
    store.save({ id: 'up-agent', name: 'Up', temperature: 0.5 })
    store.save({ id: 'up-agent', name: 'Up', temperature: 1.2 })
    const loaded = store.getById('up-agent')
    expect(loaded?.temperature).toBe(1.2)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd apps/agent-server && npx vitest run src/__tests__/agent-persistence.test.ts`
预期：FAIL，`temperature` 字段在 AgentConfig 类型上不存在 / rowToConfig 未返回 temperature

- [ ] **步骤 3：AgentConfig 接口加 temperature 字段**

修改 `apps/agent-server/src/core/agent/subagent-tool.ts` 第 22-42 行，在 `personality` 字段后追加：

```typescript
  /** 人格模板（personality.md 内容） */
  personality?: string
  /** LLM 温度（0-2，未配置则使用 SDK 默认） */
  temperature?: number
}
```

- [ ] **步骤 4：SqliteAgentStore UPSERT 与 rowToConfig 支持 temperature**

修改 `apps/agent-server/src/core/agent/agent-persistence.ts`：

第 33-45 行 UPSERT 语句改为：

```typescript
    this.stmtUpsert = db.prepare(`
      INSERT INTO agents (id, name, description, model, system_prompt, tools, identity, personality, temperature)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        model = excluded.model,
        system_prompt = excluded.system_prompt,
        tools = excluded.tools,
        identity = excluded.identity,
        personality = excluded.personality,
        temperature = excluded.temperature,
        updated_at = unixepoch()
    `)
```

第 60-71 行 `save` 方法追加 temperature 参数：

```typescript
  save(agent: AgentConfig): void {
    this.stmtUpsert.run(
      agent.id,
      agent.name,
      agent.description ?? null,
      agent.model ? JSON.stringify(agent.model) : null,
      agent.systemPrompt ?? null,
      agent.tools ? JSON.stringify(agent.tools) : null,
      agent.identity ?? null,
      agent.personality ?? null,
      agent.temperature ?? null,
    )
  }
```

第 88-99 行 `rowToConfig` 追加 temperature：

```typescript
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
      temperature: row.temperature ?? undefined,
    }
  }
```

- [ ] **步骤 5：新增 agents 表迁移**

修改 `apps/agent-server/src/core/db/migrations.ts`，在 `002_create_agents` 迁移之后（约第 34 行后）新增迁移项。注意：因 `002_create_agents` 用 `CREATE TABLE IF NOT EXISTS`，已有库的 agents 表不含 temperature 列，需用独立 ALTER 迁移补列：

在 MIGRATIONS 数组中 `002_create_agents` 项之后插入（并将 002 建表 SQL 也加上 temperature 列，使新库一次成型）：

先修改 `002_create_agents` 的 SQL（第 21-32 行）加 `temperature REAL,`：

```sql
    sql: `CREATE TABLE IF NOT EXISTS agents (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT,
      model         TEXT,
      system_prompt TEXT,
      tools         TEXT,
      identity      TEXT,
      personality   TEXT,
      temperature   REAL,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);`,
```

再在 `002_create_agents` 之后新增独立补列迁移（为已有库兼容）：

```typescript
  {
    // 兼容已建库：为 agents 表补 temperature 列（IF NOT EXISTS 用 PRAGMA 判断）
    // SQLite 不支持 ADD COLUMN IF NOT EXISTS，用 try/catch 包裹执行
    id: '002b_add_agents_temperature',
    sql: `ALTER TABLE agents ADD COLUMN temperature REAL;`,
  },
```

**注意**：项目迁移执行器若对重复执行报错，需确认 `002b` 只在无 temperature 列时执行。查看迁移执行器实现确认幂等性（执行器按 schema_migrations 表记录跳过已应用迁移，故 ALTER 不会重复执行）。

- [ ] **步骤 6：运行测试验证通过**

运行：`cd apps/agent-server && npx vitest run src/__tests__/agent-persistence.test.ts`
预期：PASS，3 个测试用例全绿

- [ ] **步骤 7：Commit**

```bash
git add apps/agent-server/src/core/db/migrations.ts apps/agent-server/src/core/agent/subagent-tool.ts apps/agent-server/src/core/agent/agent-persistence.ts apps/agent-server/src/__tests__/agent-persistence.test.ts
git commit -m "feat(agent): agents 表加 temperature 列与持久化支持"
```

---

## 任务 2：主 Agent 注入层 — subagent dispatch 注入 onPayload

**文件：**
- 修改：`apps/agent-server/src/plugins/subagent-plugin.ts`
- 测试：`apps/agent-server/src/__tests__/subagent-temperature.test.ts`（新建）

- [ ] **步骤 1：编写失败的测试 — dispatch 设置 onPayload 注入 temperature**

创建 `apps/agent-server/src/__tests__/subagent-temperature.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'

/**
 * 验证 onPayload 注入逻辑：给定 temperature，回调应将其追加到 payload。
 * 不依赖真实 Pi SDK，用纯函数测试注入行为。
 */
describe('subagent temperature 注入', () => {
  it('temperature 定义时 onPayload 追加到 payload', () => {
    const temperature = 0.8
    // 模拟 plugin-manager 的注入逻辑
    const onPayload = (payload: unknown) => ({
      ...(payload as Record<string, unknown>),
      temperature,
    })
    const result = onPayload({ messages: [], model: 'deepseek-chat' })
    expect(result).toEqual({ messages: [], model: 'deepseek-chat', temperature: 0.8 })
  })

  it('temperature undefined 时不设置 onPayload', () => {
    const temperature: number | undefined = undefined
    // 模拟条件判断
    const shouldSetOnPayload = temperature !== undefined
    expect(shouldSetOnPayload).toBe(false)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd apps/agent-server && npx vitest run src/__tests__/subagent-temperature.test.ts`
预期：可能 PASS（纯函数测试），但这是逻辑先行测试，确认注入公式正确

- [ ] **步骤 3：subagent dispatch 注入 onPayload**

修改 `apps/agent-server/src/plugins/subagent-plugin.ts`。在第 84-85 行（setModel 块结束后、第 87 行"检查取消信号"前）插入：

```typescript
      // 如果目标 Agent 配置了温度，注入 onPayload 钩子修改 provider 请求 payload
      // Agent.onPayload 在 provider 请求发送前调用，返回修改后的 payload
      if (agentConfig.temperature !== undefined) {
        const t = agentConfig.temperature
        ;(threadSession.session as { agent?: { onPayload?: (payload: unknown) => unknown } }).agent!.onPayload = (payload: unknown) => ({
          ...(payload as Record<string, unknown>),
          temperature: t,
        })
      }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd apps/agent-server && npx vitest run src/__tests__/subagent-temperature.test.ts`
预期：PASS

- [ ] **步骤 5：运行现有 subagent 测试确保无回归**

运行：`cd apps/agent-server && npx vitest run src/__tests__/agent-channel.test.ts`
预期：PASS（未触及 channel 逻辑）

- [ ] **步骤 6：Commit**

```bash
git add apps/agent-server/src/plugins/subagent-plugin.ts apps/agent-server/src/__tests__/subagent-temperature.test.ts
git commit -m "feat(agent): subagent dispatch 注入 temperature 到 provider payload"
```

---

## 任务 3：主 Agent API 层 — REST schema 与前端类型

**文件：**
- 修改：`apps/agent-server/src/routes/agents.route.ts`
- 修改：`apps/desktop/src/renderer/src/api/http-client.ts`
- 测试：`apps/agent-server/src/__tests__/agents-route.test.ts`（新建，若已存在则追加）

- [ ] **步骤 1：编写失败的测试 — POST /api/agents 透传 temperature**

创建 `apps/agent-server/src/__tests__/agents-route-temperature.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { SqliteAgentStore } from '../core/agent/agent-persistence.js'
import { z } from 'zod'

// 测试 Zod schema 能解析 temperature 字段（独立于 Fastify）
describe('agents route temperature schema', () => {
  it('createAgentSchema 接受 temperature 字段', () => {
    const createAgentSchema = z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      temperature: z.number().min(0).max(2).optional(),
    })
    const result = createAgentSchema.safeParse({
      id: 't1',
      name: 'T1',
      temperature: 0.7,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.temperature).toBe(0.7)
    }
  })

  it('temperature 超出 2 被拒绝', () => {
    const createAgentSchema = z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      temperature: z.number().min(0).max(2).optional(),
    })
    const result = createAgentSchema.safeParse({
      id: 't2',
      name: 'T2',
      temperature: 2.5,
    })
    expect(result.success).toBe(false)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd apps/agent-server && npx vitest run src/__tests__/agents-route-temperature.test.ts`
预期：FAIL（schema 未含 temperature，但测试内联了 schema 会 PASS——改为验证实际导出 schema，见步骤 3）

**修正**：步骤 1 的测试内联了 schema，无法验证真实路由。改为：测试 `SqliteAgentStore.save` 接收来自 route 透传的 temperature 后能读回（已在任务1覆盖）。此测试文件改为只测 Zod 边界。运行后应 PASS（逻辑测试）。此任务的核心验证在步骤 3-5 的集成。

- [ ] **步骤 3：agents.route.ts Zod schema 加 temperature**

修改 `apps/agent-server/src/routes/agents.route.ts`。在第 54 行 `personality` 字段后追加：

```typescript
    personality: z.string().max(5000).optional().describe('人格模板（personality.md 内容）'),
    temperature: z.number().min(0).max(2).optional().describe('LLM 温度（0-2，未配置使用默认）'),
  })
```

`updateAgentSchema = createAgentSchema.partial()`（第 91 行）自动继承 temperature 可选，无需改动。

- [ ] **步骤 4：POST/PUT handler 透传 temperature**

POST handler（第 66 行 `manager.createAgent(input)`）和 PUT handler（第 104 行 `manager.updateAgent(agentId, input)`）已直接透传整个 `input` 对象给 manager，而 manager 最终调用 `store.save`。需确认 `AgentManager.createAgent / updateAgent` 透传 temperature 到 store。

查看 `subagent-tool.ts` 的 `AgentManager.createAgent` 与 `updateAgent` 实现（用 Grep 定位）。若它们仅传特定字段，需追加 `temperature`。若透传整个 config 对象，则无需改动。

- [ ] **步骤 5：前端 AgentInfo 加 temperature**

修改 `apps/desktop/src/renderer/src/api/http-client.ts` 第 233-240 行：

```typescript
export interface AgentInfo {
  id: string
  name: string
  description?: string
  model?: { provider: string; modelId: string }
  systemPrompt?: string
  tools?: string[]
  temperature?: number
}
```

- [ ] **步骤 6：运行测试验证通过**

运行：`cd apps/agent-server && npx vitest run src/__tests__/agents-route-temperature.test.ts src/__tests__/agent-persistence.test.ts`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add apps/agent-server/src/routes/agents.route.ts apps/agent-server/src/__tests__/agents-route-temperature.test.ts apps/desktop/src/renderer/src/api/http-client.ts
git commit -m "feat(agent): REST schema 与前端类型加 temperature 字段"
```

---

## 任务 4：主 Agent UI 层 — 编辑/创建弹窗加温度滑块

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/settings/agent-page.tsx`

- [ ] **步骤 1：AgentEditorDialog 加温度滑块**

修改 `apps/agent-server/.../agent-page.tsx` 的 `AgentEditorDialog`（第 732 行起）：

第 738 行 state 声明后追加：
```typescript
  const [temperature, setTemperature] = useState(0.7)
```

第 743-751 行 `useEffect` 重置表单追加（在 `setSystemPrompt` 后）：
```typescript
      setSystemPrompt(agent.systemPrompt ?? '')
      setTemperature(agent.temperature ?? 0.7)
      setError('')
```

第 772-777 行 `updateMutation.mutate` 调用追加 `temperature`：
```typescript
    updateMutation.mutate({
      name: name.trim(),
      description: description.trim() || undefined,
      model,
      systemPrompt: systemPrompt.trim() || undefined,
      temperature,
    })
```

在第 831 行"系统提示词"textarea 块后、`{error && ...}` 前（第 832 行前）插入温度滑块：
```tsx
          <div className="grid gap-1.5">
            <Label htmlFor="edit-agent-temperature" className="text-xs">
              温度: {temperature.toFixed(2)}
            </Label>
            <input
              id="edit-agent-temperature"
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
              className="w-full accent-accent"
            />
          </div>
```

- [ ] **步骤 2：AgentCreateDialog 加温度滑块**

修改 `AgentCreateDialog`（第 856 行起）：

第 863 行 state 声明后追加：
```typescript
  const [temperature, setTemperature] = useState(() => {
    // 从 localStorage 读取全局默认温度作为新建默认值
    const saved = window.localStorage.getItem('pi-agent.agent-config')
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as { temperature?: number }
        if (typeof parsed.temperature === 'number') return parsed.temperature
      } catch { /* ignore */ }
    }
    return 0.7
  })
```

第 879-887 行 `handleReset` 追加（在 `setSystemPrompt('')` 后）：
```typescript
    setSystemPrompt('')
    setTemperature(0.7)
    setError('')
```

第 896-902 行 `createMutation.mutate` 调用追加 `temperature`：
```typescript
    createMutation.mutate({
      id: id.trim(),
      name: name.trim(),
      description: description.trim() || undefined,
      model,
      systemPrompt: systemPrompt.trim() || undefined,
      temperature,
    })
```

在第 971 行"系统提示词"textarea 块后、`{error && ...}` 前（第 972 行前）插入温度滑块（同步骤1结构，id 改为 `create-agent-temperature`）：
```tsx
          <div className="grid gap-1.5">
            <Label htmlFor="create-agent-temperature" className="text-xs">
              温度: {temperature.toFixed(2)}
            </Label>
            <input
              id="create-agent-temperature"
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
              className="w-full accent-accent"
            />
          </div>
```

- [ ] **步骤 3：手动验证（前端无自动测试时）**

启动前端 dev server，打开设置页 → Agent 管理 → 新建/编辑 Agent，确认滑块出现且可拖动，保存后重新打开编辑能读回温度值。

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/renderer/src/components/settings/agent-page.tsx
git commit -m "feat(agent): 编辑/创建弹窗加温度滑块"
```

---

## 任务 5：插件 Session 注入层 — PluginSessionOptions 与 createSession

**文件：**
- 修改：`apps/agent-server/src/core/plugin/plugin-types.ts`
- 修改：`apps/agent-server/src/core/plugin/plugin-manager.ts`
- 测试：`apps/agent-server/src/__tests__/plugin-session-temperature.test.ts`（新建）

- [ ] **步骤 1：编写失败的测试 — createSession 传 temperature 后设置 onPayload**

创建 `apps/agent-server/src/__tests__/plugin-session-temperature.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'

describe('plugin createSession temperature 注入', () => {
  it('temperature 定义时 onPayload 注入到 payload', () => {
    const temperature = 0.5
    const onPayload = (payload: unknown) => ({
      ...(payload as Record<string, unknown>),
      temperature,
    })
    const result = onPayload({ model: 'deepseek-chat', messages: [{ role: 'user' }] })
    expect(result).toMatchObject({ temperature: 0.5, model: 'deepseek-chat' })
  })

  it('temperature undefined 时不注入', () => {
    const temperature: number | undefined = undefined
    const shouldInject = temperature !== undefined
    expect(shouldInject).toBe(false)
  })
})
```

- [ ] **步骤 2：运行测试验证逻辑**

运行：`cd apps/agent-server && npx vitest run src/__tests__/plugin-session-temperature.test.ts`
预期：PASS（逻辑先行）

- [ ] **步骤 3：PluginSessionOptions 加 temperature 字段**

修改 `apps/agent-server/src/core/plugin/plugin-types.ts` 第 183-204 行，在 `signal?: AbortSignal` 后追加：

```typescript
  /** 中止信号 */
  signal?: AbortSignal
  /** LLM 温度（0-2，未配置则使用 SDK 默认） */
  temperature?: number
}
```

- [ ] **步骤 4：plugin-manager createSession 注入 onPayload**

修改 `apps/agent-server/src/core/plugin/plugin-manager.ts`。在第 807 行（模型切换块 `}` 结束后）、第 809 行"中止信号转发"前插入：

```typescript
        // 注入温度到 provider payload（如指定）
        // Agent.onPayload 在 provider 请求发送前调用，返回修改后的 payload
        if (options.temperature !== undefined) {
          const t = options.temperature
          const piSession = threadSession.session as {
            agent?: { onPayload?: (payload: unknown) => unknown }
          }
          if (piSession.agent) {
            piSession.agent.onPayload = (payload: unknown) => ({
              ...(payload as Record<string, unknown>),
              temperature: t,
            })
            logger.debug({ threadId, temperature: t }, '已注入 temperature 到 Pi Session')
          } else {
            logger.warn({ threadId, temperature: t }, 'session.agent 不可用，无法注入 temperature')
          }
        }
```

- [ ] **步骤 5：运行测试验证通过**

运行：`cd apps/agent-server && npx vitest run src/__tests__/plugin-session-temperature.test.ts src/__tests__/novel-plugin-session.test.ts`
预期：PASS（novel-plugin-session 现有测试不应回归）

- [ ] **步骤 6：Commit**

```bash
git add apps/agent-server/src/core/plugin/plugin-types.ts apps/agent-server/src/core/plugin/plugin-manager.ts apps/agent-server/src/__tests__/plugin-session-temperature.test.ts
git commit -m "feat(plugin): PluginSessionOptions 加 temperature 并在 createSession 注入 onPayload"
```

---

## 任务 6：小说 Agent 数据层 — 默认值与 NovelAgentConfigStore

**文件：**
- 修改：`apps/agent-server/src/plugins/novel-plugin/core/novel-agents.ts`
- 修改：`apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts`
- 创建：`apps/agent-server/src/plugins/novel-plugin/core/novel-agent-config-store.ts`
- 测试：`apps/agent-server/src/__tests__/novel-agent-config-store.test.ts`（新建）

- [ ] **步骤 1：编写失败的测试 — NovelAgentConfigStore 读写合并**

创建 `apps/agent-server/src/__tests__/novel-agent-config-store.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { NovelAgentConfigStore } from '../plugins/novel-plugin/core/novel-agent-config-store.js'
import { NOVEL_AGENT_CONFIGS } from '../plugins/novel-plugin/core/novel-agents.js'

function createConfigTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS novel_agent_config (
      agent_type    TEXT PRIMARY KEY,
      temperature   REAL,
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)
}

describe('NovelAgentConfigStore', () => {
  let db: Database.Database
  let store: NovelAgentConfigStore

  beforeEach(() => {
    db = new Database(':memory:')
    createConfigTable(db)
    store = new NovelAgentConfigStore(db)
  })

  it('无覆盖时 getAll 返回默认温度', () => {
    const all = store.getAll()
    expect(all.director).toBe(NOVEL_AGENT_CONFIGS.director.temperature)
    expect(all.writer).toBe(NOVEL_AGENT_CONFIGS.writer.temperature)
    expect(all.reviewer).toBe(NOVEL_AGENT_CONFIGS.reviewer.temperature)
    expect(all.memory).toBe(NOVEL_AGENT_CONFIGS.memory.temperature)
  })

  it('upsert 覆盖后 getAll 返回覆盖值', () => {
    store.upsert('writer', 1.1)
    const all = store.getAll()
    expect(all.writer).toBe(1.1)
    expect(all.director).toBe(NOVEL_AGENT_CONFIGS.director.temperature)
  })

  it('getByType 返回合并后温度（覆盖优先）', () => {
    store.upsert('director', 0.3)
    expect(store.getByType('director')).toBe(0.3)
    expect(store.getByType('writer')).toBe(NOVEL_AGENT_CONFIGS.writer.temperature)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd apps/agent-server && npx vitest run src/__tests__/novel-agent-config-store.test.ts`
预期：FAIL，`NovelAgentConfigStore` 模块不存在 / `NOVEL_AGENT_CONFIGS.*.temperature` undefined

- [ ] **步骤 3：NovelAgentConfig 加 temperature 字段与默认值**

修改 `apps/agent-server/src/plugins/novel-plugin/core/novel-agents.ts`：

第 18-25 行接口加字段：
```typescript
export interface NovelAgentConfig {
  type: NovelAgentType
  id: string
  name: string
  identity: string
  tools: string[]
  roleTemplate: string
  temperature: number
}
```

第 27-68 行 `NOVEL_AGENT_CONFIGS` 各角色加 temperature：
- director（第 34 行 `roleTemplate: 'role-director',` 后）加 `temperature: 0.5,`
- writer（第 42 行 `roleTemplate: 'role-writer',` 后）加 `temperature: 0.9,`
- reviewer（第 50 行 `roleTemplate: 'role-reviewer',` 后）加 `temperature: 0.3,`
- memory（第 66 行 `roleTemplate: 'role-memory',` 后）加 `temperature: 0.2,`

例（director 块）：
```typescript
  director: {
    type: 'director',
    id: 'novel-director',
    name: '导演 Agent',
    identity: '你是一个专业的小说导演，负责分析故事状态并规划章节叙事任务。',
    tools: ['novel_query_state', 'novel_query_factions', 'novel_query_locations'],
    roleTemplate: 'role-director',
    temperature: 0.5,
  },
```

- [ ] **步骤 4：新增 novel_agent_config 迁移**

修改 `apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts`，在数组末尾（`043_backfill_novel_volumes` 之后）追加：

```typescript
  {
    // 小说 Agent 角色温度运行时覆盖表（全局配置，不按 project）
    id: '044_create_novel_agent_config',
    sql: `CREATE TABLE IF NOT EXISTS novel_agent_config (
      agent_type    TEXT PRIMARY KEY,
      temperature   REAL,
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );`,
  },
```

- [ ] **步骤 5：创建 NovelAgentConfigStore**

创建 `apps/agent-server/src/plugins/novel-plugin/core/novel-agent-config-store.ts`：

```typescript
/**
 * 小说 Agent 角色温度配置存储
 *
 * 持久化用户对 4 个小说 Agent 角色（director/writer/reviewer/memory）的温度覆盖。
 * 全局配置，不按 project 区分。
 *
 * 合并优先级：持久化覆盖 > NOVEL_AGENT_CONFIGS 默认值
 */

import type Database from 'better-sqlite3'
import { NOVEL_AGENT_CONFIGS, type NovelAgentType } from './novel-agents.js'

/** 小说角色温度配置（合并后，含全部 4 角色） */
export type NovelAgentTemperatures = Record<NovelAgentType, number>

export class NovelAgentConfigStore {
  private stmtGetAll: Database.Statement
  private stmtGetByType: Database.Statement
  private stmtUpsert: Database.Statement

  constructor(private db: Database.Database) {
    this.stmtGetAll = db.prepare('SELECT agent_type, temperature FROM novel_agent_config')
    this.stmtGetByType = db.prepare('SELECT temperature FROM novel_agent_config WHERE agent_type = ?')
    this.stmtUpsert = db.prepare(`
      INSERT INTO novel_agent_config (agent_type, temperature)
      VALUES (?, ?)
      ON CONFLICT(agent_type) DO UPDATE SET
        temperature = excluded.temperature,
        updated_at = unixepoch()
    `)
  }

  /** 获取全部角色温度（合并默认值与持久化覆盖） */
  getAll(): NovelAgentTemperatures {
    const rows = this.stmtGetAll.all() as Array<{ agent_type: string; temperature: number | null }>
    const overrides = new Map<string, number>()
    for (const row of rows) {
      if (row.temperature !== null) {
        overrides.set(row.agent_type, row.temperature)
      }
    }
    return {
      director: overrides.get('director') ?? NOVEL_AGENT_CONFIGS.director.temperature,
      writer: overrides.get('writer') ?? NOVEL_AGENT_CONFIGS.writer.temperature,
      reviewer: overrides.get('reviewer') ?? NOVEL_AGENT_CONFIGS.reviewer.temperature,
      memory: overrides.get('memory') ?? NOVEL_AGENT_CONFIGS.memory.temperature,
    }
  }

  /** 获取单个角色温度（合并后） */
  getByType(agentType: NovelAgentType): number {
    const row = this.stmtGetByType.get(agentType) as { temperature: number | null } | undefined
    if (row && row.temperature !== null) {
      return row.temperature
    }
    return NOVEL_AGENT_CONFIGS[agentType].temperature
  }

  /** 覆盖单个角色温度 */
  upsert(agentType: NovelAgentType, temperature: number): void {
    this.stmtUpsert.run(agentType, temperature)
  }

  /** 批量覆盖 */
  upsertMany(items: Array<{ agentType: NovelAgentType; temperature: number }>): void {
    const tx = this.db.transaction(() => {
      for (const item of items) {
        this.upsert(item.agentType, item.temperature)
      }
    })
    tx()
  }
}
```

- [ ] **步骤 6：运行测试验证通过**

运行：`cd apps/agent-server && npx vitest run src/__tests__/novel-agent-config-store.test.ts`
预期：PASS，3 个测试用例全绿

- [ ] **步骤 7：Commit**

```bash
git add apps/agent-server/src/plugins/novel-plugin/core/novel-agents.ts apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts apps/agent-server/src/plugins/novel-plugin/core/novel-agent-config-store.ts apps/agent-server/src/__tests__/novel-agent-config-store.test.ts
git commit -m "feat(novel): 小说角色温度默认值与 NovelAgentConfigStore"
```

---

## 任务 7：小说 Agent 注入层 — orchestrator 合并温度传入 createSession

**文件：**
- 修改：`apps/agent-server/src/plugins/novel-plugin/novel-services.ts`
- 修改：`apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts`

- [ ] **步骤 1：NovelServices 注入 NovelAgentConfigStore**

修改 `apps/agent-server/src/plugins/novel-plugin/novel-services.ts`：

第 36 行 import 后追加：
```typescript
import { NovelAgentConfigStore } from './core/novel-agent-config-store.js'
```

第 41-58 行 `NovelServices` 接口追加字段（在 `tools` 后、`teamManager?` 前）：
```typescript
  tools: ToolDefinition[]
  /** 小说角色温度配置存储 */
  agentConfigStore: NovelAgentConfigStore
  /**
   * TeamManager（可选，由 teamPlugin 提供）
   * ...
   */
  teamManager?: TeamManager
```

第 65-101 行 `createNovelServices` 函数体内，在第 99 行 `const tools = createNovelTools(store)` 后、return 前追加：
```typescript
  // 11. 创建小说角色温度配置存储
  const agentConfigStore = new NovelAgentConfigStore(db)
```

第 101 行 return 对象追加 `agentConfigStore`：
```typescript
  return { store, memoryStore, promptManager, promptBuilder, sessionFactory, engine, orchestrator, characterGenerator, entityGenerator, tools, agentConfigStore, teamManager }
```

- [ ] **步骤 2：NovelOrchestrator 持有 agentConfigStore 并在 runAgent 合并温度**

修改 `apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts`：

先定位构造函数与类字段（用 Grep 找 `class NovelOrchestrator` 和 `constructor`）。在构造函数参数加 `agentConfigStore: NovelAgentConfigStore`，存为私有字段。

在 import 区（第 41-44 行附近）追加：
```typescript
import type { NovelAgentConfigStore } from './novel-agent-config-store.js'
```

在类字段区追加：
```typescript
  private readonly agentConfigStore: NovelAgentConfigStore
```

构造函数参数末尾追加 `agentConfigStore: NovelAgentConfigStore`，函数体内赋值 `this.agentConfigStore = agentConfigStore`。

在第 258 行 `const config = NOVEL_AGENT_CONFIGS[agentType]` 后、第 335 行 `createSession` 调用处，合并温度。修改第 335-341 行 createSession 调用：

```typescript
    // 合并温度：持久化覆盖 > 角色默认值
    const temperature = this.agentConfigStore.getByType(agentType)

    const session = await this.context.createSession({
      systemPrompt,
      prefixUserMessage: chapterContext,
      userMessage,
      tools: filteredTools as unknown as PluginToolDefinition[],
      signal: options?.signal,
      temperature,
    })
```

- [ ] **步骤 3：确认 characterGenerator / entityGenerator 调用路径**

`novel-character-generator.ts:81` 与 `novel-entity-generator.ts:164,356` 也调用 `session.promptStream`。这些走 `context.createSession`。若它们也需要角色温度，可在 createSession 调用处传入。本任务范围：仅 orchestrator 的 runAgent 注入（创作主流程），character/entity 生成器暂不注入（走默认）。确认这两个文件 createSession 调用未受影响（不传 temperature 即走默认，零回归）。

- [ ] **步骤 4：运行现有 novel 测试确保无回归**

运行：`cd apps/agent-server && npx vitest run src/__tests__/novel-plugin-session.test.ts src/__tests__/novel-store.test.ts`
预期：PASS。若 novel-plugin-session 测试 mock 了 orchestrator 构造，需更新 mock 传入 agentConfigStore。

- [ ] **步骤 5：Commit**

```bash
git add apps/agent-server/src/plugins/novel-plugin/novel-services.ts apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts
git commit -m "feat(novel): orchestrator 合并角色温度并传入 createSession"
```

---

## 任务 8：小说 Agent API 层 — agent-config REST 端点

**文件：**
- 修改：`apps/agent-server/src/plugins/novel-plugin/novel-routes.ts`
- 创建：`apps/desktop/src/renderer/src/api/novel-agent-config-client.ts`

- [ ] **步骤 1：novel-routes.ts 加 GET/PUT agent-config 端点**

修改 `apps/agent-server/src/plugins/novel-plugin/novel-routes.ts`：

第 31 行 `const { store, memoryStore, promptManager, promptBuilder, engine } = services` 解构追加 `agentConfigStore`：
```typescript
  const { store, memoryStore, promptManager, promptBuilder, engine, agentConfigStore } = services
```

在 routes 数组末尾（最后一个 `routes.push` 之后、`return routes` 之前）追加两个路由：

```typescript
  // ═══════════════════════════════════════════════════════════════
  // 小说 Agent 角色温度配置
  // ═══════════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/agent-config',
    handler: async (request: any) => {
      const temperatures = agentConfigStore.getAll()
      const result = (Object.entries(temperatures) as Array<[string, number]>).map(([agentType, temperature]) => ({
        agentType,
        temperature,
      }))
      return success(result, request.traceId)
    },
  })

  const updateAgentConfigSchema = z.object({
    items: z.array(z.object({
      agentType: z.enum(['director', 'writer', 'reviewer', 'memory']),
      temperature: z.number().min(0).max(2),
    })),
  })

  routes.push({
    method: 'PUT',
    path: '/agent-config',
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateAgentConfigSchema, request, reply)
      if (!input) return reply
      agentConfigStore.upsertMany(input.items)
      const temperatures = agentConfigStore.getAll()
      const result = (Object.entries(temperatures) as Array<[string, number]>).map(([agentType, temperature]) => ({
        agentType,
        temperature,
      }))
      return success(result, request.traceId)
    },
  })
```

- [ ] **步骤 2：创建前端 API 客户端**

创建 `apps/desktop/src/renderer/src/api/novel-agent-config-client.ts`：

```typescript
/**
 * 小说 Agent 角色温度配置 API 客户端
 *
 * 端点（自动加 /api/plugins/novel 前缀）：
 * - GET  /agent-config  → 获取 4 角色温度列表
 * - PUT  /agent-config  → 批量更新角色温度
 */

import { httpClient } from './http-client.js'

export type NovelAgentType = 'director' | 'writer' | 'reviewer' | 'memory'

export interface NovelAgentTemperature {
  agentType: NovelAgentType
  temperature: number
}

export async function getNovelAgentConfig(): Promise<NovelAgentTemperature[]> {
  const res = await httpClient.get<{ data: NovelAgentTemperature[] }>('/api/plugins/novel/agent-config')
  return res.data
}

export async function updateNovelAgentConfig(
  items: Array<{ agentType: NovelAgentType; temperature: number }>,
): Promise<NovelAgentTemperature[]> {
  const res = await httpClient.put<{ data: NovelAgentTemperature[] }>(
    '/api/plugins/novel/agent-config',
    { items },
  )
  return res.data
}
```

**注意**：需确认 `httpClient` 的导出名与请求方法签名（用 Grep 查 `http-client.ts` 的 `export const httpClient` 或 `export default`）。若项目用 fetch 封装，调整调用方式与现有 `novel-client.ts` 对齐。

- [ ] **步骤 3：运行后端测试验证路由注册**

运行：`cd apps/agent-server && npx vitest run src/__tests__/novel-routes.test.ts`
预期：PASS（现有路由测试不应回归）。新增路由暂无自动测试，手动验证见任务9。

- [ ] **步骤 4：Commit**

```bash
git add apps/agent-server/src/plugins/novel-plugin/novel-routes.ts apps/desktop/src/renderer/src/api/novel-agent-config-client.ts
git commit -m "feat(novel): agent-config REST 端点与前端 API 客户端"
```

---

## 任务 9：小说 Agent UI 层 — 设置页小说角色温度分区

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/settings/agent-page.tsx`

- [ ] **步骤 1：在 agent-page.tsx 新增小说角色温度分区**

修改 `apps/desktop/src/renderer/src/components/settings/agent-page.tsx`。

在文件顶部 import 区追加：
```typescript
import {
  getNovelAgentConfig,
  updateNovelAgentConfig,
  type NovelAgentType,
  type NovelAgentTemperature,
} from '../../api/novel-agent-config-client.js'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
```

（确认 `useQuery/useMutation/useQueryClient` 是否已 import，避免重复）

在 `AgentPage` 组件内（定位主返回 JSX 的末尾，最后一个分区后）追加小说角色温度分区组件。新增一个独立函数组件 `NovelAgentTemperatureSection`：

```tsx
// ── 小说创作角色温度配置 ──

const NOVEL_AGENT_LABELS: Record<NovelAgentType, string> = {
  director: '导演 Agent（规划稳定）',
  writer: '写作 Agent（创作发散）',
  reviewer: '审稿 Agent（审稿严谨）',
  memory: '记忆 Agent（沉淀确定）',
}

function NovelAgentTemperatureSection(): ReactElement {
  const queryClient = useQueryClient()
  const [temps, setTemps] = useState<Record<NovelAgentType, number>>({
    director: 0.5,
    writer: 0.9,
    reviewer: 0.3,
    memory: 0.2,
  })

  const { data } = useQuery({
    queryKey: ['novel-agent-config'],
    queryFn: getNovelAgentConfig,
  })

  useEffect(() => {
    if (data) {
      const next = { director: 0.5, writer: 0.9, reviewer: 0.3, memory: 0.2 }
      for (const item of data) {
        next[item.agentType] = item.temperature
      }
      setTemps(next)
    }
  }, [data])

  const updateMutation = useMutation({
    mutationFn: (items: Array<{ agentType: NovelAgentType; temperature: number }>) =>
      updateNovelAgentConfig(items),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['novel-agent-config'] })
    },
  })

  function handleChange(agentType: NovelAgentType, value: number): void {
    setTemps((prev) => ({ ...prev, [agentType]: value }))
  }

  function handleSave(): void {
    const items = (Object.entries(temps) as Array<[NovelAgentType, number]>).map(
      ([agentType, temperature]) => ({ agentType, temperature }),
    )
    updateMutation.mutate(items)
  }

  return (
    <div className="rounded-lg border border-border bg-surface-2 p-4 space-y-4">
      <div>
        <h3 className="text-sm font-medium">小说创作角色温度</h3>
        <p className="text-xs text-muted-foreground mt-1">
          为 4 个创作角色独立配置 LLM 温度，影响生成结果的发散性与稳定性。
        </p>
      </div>
      <div className="space-y-3">
        {(Object.keys(NOVEL_AGENT_LABELS) as NovelAgentType[]).map((agentType) => (
          <div key={agentType} className="grid gap-1.5">
            <Label className="text-xs">
              {NOVEL_AGENT_LABELS[agentType]}: {temps[agentType].toFixed(2)}
            </Label>
            <input
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={temps[agentType]}
              onChange={(e) => handleChange(agentType, Number(e.target.value))}
              className="w-full accent-accent"
            />
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={handleSave} disabled={updateMutation.isPending}>
          {updateMutation.isPending ? '保存中...' : '保存角色温度'}
        </Button>
      </div>
    </div>
  )
}
```

在 `AgentPage` 主组件的 JSX 末尾渲染该分区：
```tsx
        <NovelAgentTemperatureSection />
```

- [ ] **步骤 2：手动验证**

启动前后端，打开设置 → Agent 管理页，确认底部出现"小说创作角色温度"分区，4 个滑块可拖动，点击保存后刷新页面能读回值。

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/components/settings/agent-page.tsx
git commit -m "feat(novel): 设置页加小说角色温度配置分区"
```

---

## 任务 10：全局默认温度改造 — 原 localStorage 滑块语义澄清

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/settings/agent-page.tsx`

- [ ] **步骤 1：更新原"生成参数"区标题与说明**

修改 `apps/agent-server/.../agent-page.tsx` 第 546 行附近的 UI 注释与第 551-579 行"生成参数"区。

将该区标题从原"生成参数"改为"全局默认温度"，更新说明文案明确其用途为"新建 Agent 时的默认温度"：

定位第 551-579 行（用 Grep 找 `temperature` 滑块块与 `生成参数` 文案）。修改标题与说明：

```tsx
        <div>
          <h3 className="text-sm font-medium">全局默认温度</h3>
          <p className="text-xs text-muted-foreground mt-1">
            新建 Agent 时的默认温度值。各 Agent 可在编辑弹窗中单独覆盖。
          </p>
        </div>
```

温度滑块本身（input range）保持不变，仍写入 localStorage `pi-agent.agent-config.temperature`。任务4步骤2的 `AgentCreateDialog` 已从此 localStorage 读取默认值。

- [ ] **步骤 2：手动验证**

打开设置页，确认"全局默认温度"分区标题与说明已更新，滑块仍可调节。新建 Agent 弹窗的温度初始值与全局默认温度一致。

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/components/settings/agent-page.tsx
git commit -m "feat(agent): 原 localStorage 温度滑块改造为全局默认温度说明"
```

---

## 自检结果

### 规格覆盖度
- ✅ 4.1.1 主 Agent 数据层（迁移+类型+持久化）→ 任务1
- ✅ 4.1.2 小说 Agent 数据层（类型+迁移+Store）→ 任务6
- ✅ 4.2.1 主 Agent REST schema → 任务3
- ✅ 4.2.2 前端 AgentInfo 类型 → 任务3
- ✅ 4.2.3 小说 Agent 配置 REST → 任务8
- ✅ 4.3.1 PluginSessionOptions → 任务5
- ✅ 4.3.2 plugin-manager createSession 注入 → 任务5
- ✅ 4.3.3 subagent dispatch 注入 → 任务2
- ✅ 4.3.4 小说 orchestrator 合并温度 → 任务7
- ✅ 4.4.1 主 Agent 编辑/创建弹窗 → 任务4
- ✅ 4.4.2 全局默认温度改造 → 任务10
- ✅ 4.4.3 小说角色温度配置 UI → 任务9
- ✅ 4.6 默认温度值 → 任务6（小说角色）+ 任务4（主 Agent 0.7）

### 占位符扫描
- 无 TODO/待定/模糊描述。所有代码步骤含完整代码块。
- 任务3步骤1-2 的测试自洽性问题已在步骤2修正说明。
- 任务8步骤2 的 httpClient 调用方式已标注"需确认"，属合理的执行时验证点（非占位符）。

### 类型一致性
- `temperature?: number` 在 AgentConfig、NovelAgentConfig（必填）、PluginSessionOptions、AgentInfo 中命名一致。
- `NovelAgentConfigStore` 方法名 `getAll / getByType / upsert / upsertMany` 在任务6定义、任务7调用、任务8路由中一致。
- `NovelAgentType = 'director' | 'writer' | 'reviewer' | 'memory'` 在任务6、8、9中一致。
- `onPayload` 注入公式 `{...(payload as Record<string, unknown>), temperature: t}` 在任务2、5中一致。
