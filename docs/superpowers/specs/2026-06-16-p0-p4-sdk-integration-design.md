# P0-P4 SDK 集成设计规格

> 文档版本：2026-06-16
> 状态：草案
> 适用项目：pi-agent

---

## 1. 设计背景

pi-agent 是一个基于 Electron + Fastify 的桌面 AI Agent 应用，采用 AG-UI 协议与前端通信。原始架构文档假设我们需要从零构建大部分组件（Agent Loop、Session 管理、Compaction 等）。经过对 Pi SDK 的调研，我们发现它已经提供了这些核心能力。设计策略因此转向 **"SDK 优先，薄适配层"**——以 Pi SDK 为核心引擎，仅构建必要的薄适配层。

### Pi SDK 核心包

| 包名 | 职责 |
|------|------|
| `@earendil-works/pi-ai` | LLM 协议层（Provider 适配、流式传输、tool_call、Token/成本追踪） |
| `@earendil-works/pi-agent-core` | Agent 核心（Agent 类、agentLoop、工具执行、事件流、steering/followUp、beforeToolCall/afterToolCall 钩子） |
| `@earendil-works/pi-coding-agent` | 完整 SDK（createAgentSession、AuthStorage、ModelRegistry、SessionManager、Compaction、Extensions/Skills/Prompts、PackageManager） |

### 参考项目

`d:\WebWork\AI\pi-agui-reference` 提供了可运行的 AG-UI + Pi SDK 集成模板，是我们实现 AG-UI 适配层的重要参考。

---

## 2. 核心决策

| 决策 | 选择 | 理由 |
|------|------|------|
| SDK 集成策略 | 方案 A：SDK 优先，薄适配层 | Pi SDK 成熟（0.79.1），避免重复造轮子 |
| API Key 存储 | Electron safeStorage + Pi SDK getApiKey 回调 | 安全性优于 Pi SDK 默认明文存储 |
| 工具集 | Pi SDK 内置 + Extensions 扩展 | 复用成熟工具，按需扩展 |
| Session 管理 | 直接用 Pi SDK SessionManager | 内置 JSONL + 树结构 + 分支 + Compaction |
| System Prompt | DefaultResourceLoader + systemPromptOverride | 复用 AGENTS.md/Skills/Templates，按需覆盖 |
| AG-UI 适配 | 参考 pi-agui 模板的 StreamEmitter | 已验证的映射逻辑 |

---

## 3. 自建 vs Pi SDK 分工

| 模块 | Pi SDK 提供 | 自建 |
|------|------------|------|
| Agent Loop | ✅ Agent + agentLoop | — |
| 工具执行 | ✅ parallel/sequential + beforeToolCall/afterToolCall | — |
| Session | ✅ SessionManager + JSONL + 树 + 分支 | — |
| Compaction | ✅ 内置 compaction + autoCompaction | — |
| Auth/Model | ✅ AuthStorage + ModelRegistry | CredentialBridge（safeStorage → getApiKey） |
| System Prompt | ✅ DefaultResourceLoader + AGENTS.md | systemPromptOverride（Token 预算） |
| Steering | ✅ steer/followUp | — |
| 事件流 | ✅ subscribe 全套事件 | AG-UI 事件映射（StreamEmitter） |
| 工具集 | ✅ read/bash/edit/write/grep/find/ls | Extensions（web_search/web_fetch） |
| Memory | — | ✅ FactStore + MemoryTicker |
| Gate 权限 | — | ✅ beforeToolCall 钩子实现 |
| EventBus | — | ✅ 进程内事件总线 |
| AG-UI 适配 | — | ✅ SSE 流式输出 |
| 安全基线 | — | ✅ CORS + 认证 + 速率限制 + 错误脱敏 |
| 迁移系统 | — | ✅ 自定义数据迁移 |

---

## 4. P0 基础设施 + 安全基线

### 4.1 项目结构调整

保留现有 `packages/shared` 和 `packages/config`，新增 `packages/protocol`：

```
packages/
  shared/           # 共享类型 + 错误体系 + EventBus
    src/
      errors/       # AppError + ErrorCode + 错误脱敏 (sanitizeErrorMessage)
      events/       # EventBus 定义
      types/        # 通用类型
      utils/        # atomicWriteSync, retry, i18n
  protocol/         # AG-UI 协议类型
    src/
      events.ts     # AG-UI 事件类型（从 @ag-ui/core 重导出）
      schemas.ts    # Zod schema 校验
  config/           # 配置 schema（保留现有）
```

### 4.2 安全基线

- **CORS 白名单**：只允许 `localhost` 和 `127.0.0.1`
- **Bearer Token 认证**：Main 进程启动 agent-server 时生成随机 Token
- **输入验证**：Zod schema 校验所有 API 入参
- **速率限制**：`@fastify/rate-limit`，SSE 端点放宽
- **错误脱敏**：`AppError` 的 `userMessage` 自动脱敏（API Key、路径、Token）

### 4.3 交付物

| 交付物 | 说明 |
|--------|------|
| `@repo/protocol` 包 | AG-UI 事件类型 + Zod schema |
| `@repo/shared` AppError 体系 | 错误码 + 错误脱敏 |
| 目录结构重组 | 按上述结构调整 |
| `lib/safe-fs.ts` | atomicWriteSync / safeReadYAMLSync |
| `lib/retry.ts` | Decorrelated Jitter 退避 |
| `lib/i18n.ts` | 中文优先国际化 |
| `lib/event-bus.ts` | 进程内事件总线 |
| CORS 白名单中间件 | 仅允许本地来源 |
| Bearer Token 认证骨架 | 随机 Token 生成 + 校验 |
| 输入验证 | Zod schema 统一校验 |
| `@fastify/rate-limit` | 速率限制配置 |

### 4.4 验证标准

- `pnpm typecheck` 通过
- 非白名单来源被 CORS 拒绝
- 无 Token 请求返回 401

---

## 5. P1 配置 + 容器

### 5.1 Pi SDK 插件注册

```typescript
// agent-server/src/plugins/pi-sdk.plugin.ts
import { AuthStorage, ModelRegistry, SessionManager } from '@earendil-works/pi-coding-agent'

export const piSdkPlugin: FastifyPluginAsync = async (app) => {
  const dataDir = app.config.dataDir

  const authStorage = AuthStorage.create(dataDir + '/auth.json')
  const modelRegistry = ModelRegistry.create(authStorage, dataDir + '/models.json')
  const sessionManager = SessionManager.create(dataDir + '/sessions')

  // getApiKey 回调：从 Electron safeStorage 获取解密后的 API Key
  const getApiKey = async (provider: string) => {
    return ipcClient.call('credential:get', provider)
  }

  app.decorate('authStorage', authStorage)
  app.decorate('modelRegistry', modelRegistry)
  app.decorate('sessionManager', sessionManager)
  app.decorate('getApiKey', getApiKey)
}
```

### 5.2 CredentialBridge

Electron Main 进程用 `safeStorage` 加密存储 API Key，agent-server 通过 HTTP API 从 Main 进程获取解密后的 Key。

```
┌──────────────────┐     HTTP API      ┌──────────────────┐
│   agent-server   │ ────────────────── │   Electron Main  │
│  (getApiKey 回调) │ ◀──────────────── │  (safeStorage)   │
└──────────────────┘   返回解密后 Key   └──────────────────┘
```

关键文件：

- `desktop/src/main/credential-store.ts` — Electron safeStorage 加密存储
- `agent-server/src/lib/credential-bridge.ts` — HTTP API 获取解密后的 Key

### 5.3 ConfigService

三层配置通过 Pi SDK 的 `settings.json` + `DefaultResourceLoader` 实现：

| 层级 | 路径 | 说明 |
|------|------|------|
| Global | `~/.pi/agent/settings.json` | 全局默认配置 |
| Project | `.pi/settings.json` | 项目级覆盖 |
| Session | `agent.state` 动态修改 | 会话级临时覆盖 |

### 5.4 交付物

| 交付物 | 说明 |
|--------|------|
| Service Container | Fastify 插件模式依赖注入 |
| EventBus 插件注册 | 事件总线挂载到 Fastify 实例 |
| Pi SDK 插件 | authStorage, modelRegistry, sessionManager, getApiKey |
| CredentialBridge | safeStorage → getApiKey 桥接 |
| ConfigService | 三层配置合并 |
| OutboundProxy | 系统/手动代理配置 |
| LoggerService | createModuleLogger 工厂 |
| Graceful Shutdown | 优雅关闭处理 |
| server-info.json | 服务元信息文件 |

### 5.5 验证标准

- agent-server 可启动
- `GET /api/health` 返回 200

---

## 6. P2 迁移 + Provider

### 6.1 迁移系统

仍需自建。Pi SDK 的 `auth.json`/`models.json`/`settings.json` 格式固定，我们的迁移针对自己的扩展数据（FactStore schema、配置扩展字段等）。

### 6.2 Provider 管理

- Pi SDK `ModelRegistry` 管理内置模型 + 自定义模型
- 前端 Provider 设置页面 → 写入 `models.json` + `auth.json`（通过 CredentialBridge）
- API Key 验证：调用 `modelRegistry.getAvailable()` 检查连通性

### 6.3 交付物

| 交付物 | 说明 |
|--------|------|
| Migration 系统 | migration-runner + 首条迁移 |
| Provider 配置 API | 前端 → Main → agent-server 链路 |
| API Key 连通性验证 | 调用 ModelRegistry 验证 Key 有效性 |

### 6.4 验证标准

- 可通过 API 添加 Provider
- 可验证 API Key 连通性

---

## 7. P3 Agent 类 + Prompt

### 7.1 Agent 创建

使用 `createAgentSession()` 工厂函数：

```typescript
// agent-server/src/agents/pi-session.ts
import { createAgentSession, DefaultResourceLoader } from '@earendil-works/pi-coding-agent'

export async function createPiSession(deps: PiSessionDeps) {
  const resourceLoader = new DefaultResourceLoader({
    cwd: deps.config.cwd,
    agentDir: deps.config.dataDir,
    systemPromptOverride: () => buildSystemPrompt(deps.config),
  })
  await resourceLoader.reload()

  const { session } = await createAgentSession({
    authStorage: deps.authStorage,
    modelRegistry: deps.modelRegistry,
    sessionManager: deps.sessionManager,
    resourceLoader,
    getApiKey: deps.getApiKey,
    toolExecution: 'parallel',
    beforeToolCall: async ({ toolCall, args }) => deps.gate.check(toolCall.name, args),
    afterToolCall: async ({ toolCall, result, isError }) => {
      deps.eventBus.emit('tool:executed', { toolCall, result, isError })
    },
  })

  return session
}
```

### 7.2 System Prompt 混合拼装

- `DefaultResourceLoader` 加载 AGENTS.md / Skills / Prompt Templates
- `systemPromptOverride` 覆盖默认 prompt，实现混合拼装
- Token 预算在 `systemPromptOverride` 内实现

拼装顺序：

1. 身份模板（identity.md / personality.md）
2. 项目级指令（InstructionLoader）
3. Pi SDK 默认资源（AGENTS.md / Skills / Templates）
4. Token 预算裁剪

### 7.3 交付物

| 交付物 | 说明 |
|--------|------|
| Pi Session 工厂 | createPiSession |
| DefaultResourceLoader + systemPromptOverride | Prompt 混合拼装 |
| Prompt Token 预算 | 超限自动裁剪 |
| 身份模板 | identity.md / personality.md |
| InstructionLoader | 项目级指令加载 |
| 缓存优化 | PrefixShape 诊断 |
| 会话标题自动生成 | 首轮对话后生成标题 |

### 7.4 验证标准

- Agent 可创建
- `buildSystemPrompt()` 输出完整 prompt

---

## 8. P4 LLM 接入

### 8.1 AG-UI 路由改造

参考 pi-agui 模板的 `routes.ts`，将 `agui.route.ts` 改造为完整 AG-UI 端点：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/ag-ui/agent/:agentId/run` | 主运行端点（SSE 流式） |
| POST | `/ag-ui/agent/:agentId/steer` | 中途引导 |
| POST | `/ag-ui/agent/:agentId/follow-up` | 后续消息 |
| POST | `/ag-ui/agent/:agentId/fork` | 分叉会话 |
| POST | `/ag-ui/agent/:agentId/navigate` | 导航会话树 |
| POST | `/ag-ui/agent/:agentId/compact` | 手动压缩 |
| POST | `/ag-ui/agent/:agentId/reload` | 重载资源 |
| GET | `/ag-ui/agent/:agentId/tree` | 获取会话树 |
| GET | `/ag-ui/agent/:agentId/sync` | 同步快照 |
| GET | `/ag-ui/agent/:agentId/models` | 获取可用模型 |
| GET | `/ag-ui/agent/:agentId/tools` | 获取工具列表 |
| POST | `/ag-ui/agent/:agentId/tools/active` | 设置活跃工具 |
| GET | `/ag-ui/info` | Agent 信息 |

### 8.2 StreamEmitter（Pi SDK 事件 → AG-UI 事件映射）

直接参考 pi-agui 模板的 StreamEmitter，核心映射：

| Pi SDK 事件 | AG-UI 事件 |
|-------------|-----------|
| `message_start`（assistant） | `TEXT_MESSAGE_START` |
| `message_update`（text_delta） | `TEXT_MESSAGE_CONTENT` |
| `message_update`（thinking_delta） | `REASONING_MESSAGE_CONTENT` + `THINKING_TEXT_MESSAGE_CONTENT` |
| `message_update`（toolcall_start/delta/end） | `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END` |
| `message_end`（assistant） | `TEXT_MESSAGE_END` |
| `tool_execution_start` | `STEP_STARTED` + `ACTIVITY_SNAPSHOT` |
| `tool_execution_end` | `STEP_FINISHED` + `ACTIVITY_DELTA` |
| `tool_execution_update` | `CUSTOM`（PI_TOOL_EXECUTION_UPDATE） |

### 8.3 PiAgUiAgent 核心类

参考 pi-agui 模板的 `PiAgUiAgent` 类，封装以下方法：

| 方法 | 说明 |
|------|------|
| `streamRun()` | 主运行方法，订阅 Pi SDK 事件 → StreamEmitter → SSE |
| `steerThread()` | 中途引导 |
| `followUpThread()` | 后续消息 |
| `forkThread()` | 分叉 |
| `compactThread()` | 压缩 |
| `getThreadTree()` | 获取树 |
| `getThreadModels()` | 获取模型 |
| `getThreadTools()` | 获取工具 |

### 8.4 Session 复用

```typescript
// agent-server/src/lib/session-store.ts
class PiSessionStore implements PiSessionStoreLike {
  private sessions = new Map<string, PiThreadSession>()

  async getOrCreate(threadId: string): Promise<PiThreadSession> {
    if (this.sessions.has(threadId)) return this.sessions.get(threadId)!
    // 创建新 session
    const session = await createPiSession(this.deps)
    const threadSession = {
      threadId,
      session,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      pendingToolCalls: new Map(),
    }
    this.sessions.set(threadId, threadSession)
    return threadSession
  }
}
```

### 8.5 CopilotKit 适配

保留 `copilotkit.route.ts` 作为兼容层，内部调用 `PiAgUiAgent`。

### 8.6 交付物

| 交付物 | 说明 |
|--------|------|
| PiAgUiAgent 核心类 | Agent 封装 |
| StreamEmitter | Pi SDK → AG-UI 事件映射 |
| AG-UI 路由 | 完整 REST API |
| PiSessionStore | 会话管理 |
| CopilotKit 兼容层 | 内部调用 PiAgUiAgent |
| ReasoningPipeline | thinking 解析 |

### 8.7 验证标准

- 前端发消息 → agent-server 调用 LLM → SSE 流式返回 → 前端显示

---

## 9. 架构文档更新清单

以下架构文档章节需要更新以反映 Pi SDK 集成：

| 章节 | 更新内容 |
|------|----------|
| §3 LLM 调用层 | 重写：Pi SDK 提供完整 Agent Loop，不再自建 |
| §3.5 Agent Loop | 重写：Pi SDK 内置，自建部分仅为 Gate 钩子 |
| §3.8 端到端数据流图 | 更新：加入 Pi SDK 层 |
| §5 工具系统 | 更新：Pi SDK 内置工具 + Extensions |
| §6 记忆系统 | 保留：Memory 仍需自建 |
| §7 通信协议 | 更新：AG-UI 路由参考 pi-agui 模板 |
| §13 Session Compaction | 重写：Pi SDK 内置 Compaction |
| §16 API Key 安全 | 更新：CredentialBridge 方案 |
| §26 目录结构 | 更新：反映 Pi SDK 集成后的结构 |
| §28 实施路线图 | 更新：P0-P4 内容大幅简化 |

---

## 10. 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| Pi SDK API 变更导致适配层失效 | 锁定版本，升级时回归测试 |
| Pi SDK 不支持某些定制需求 | 通过 beforeToolCall/afterToolCall 钩子 + systemPromptOverride 扩展 |
| pi-agui 模板是第三方维护 | 参考其设计思路但不直接依赖其代码 |
| Electron safeStorage + Pi SDK AuthStorage 集成复杂 | CredentialBridge 隔离层，getApiKey 回调注入 |
