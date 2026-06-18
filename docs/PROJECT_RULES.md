# pi-agent 项目规则

> 本文档定义 pi-agent 项目中**必须遵守**的规则和约定。
> 任何 AI Agent 或开发者在修改本项目代码时都必须遵循这些规则。
> 最后更新：2026-06-18

---

## 1. TypeScript 规则

### 1.1 strict: true

所有 tsconfig.json 必须启用 `"strict": true`。不允许使用 `any` 绕过类型检查。

- `@typescript-eslint/no-explicit-any` 设为 `warn`，但应尽量避免
- 如必须使用 `any`，必须添加注释说明原因

### 1.2 ESM 模块

- 后端（agent-server）：`"module": "NodeNext"`，`"moduleResolution": "NodeNext"`
- 导入路径**必须**包含 `.js` 后缀：`import { foo } from './bar.js'`
- 前端（desktop）：Vite 处理，不需要 `.js` 后缀

### 1.3 类型导入

使用 `import type` 导入纯类型：

```typescript
// 正确
import type { BaseEvent } from '@repo/protocol/events'
import { EventType, type BaseEvent } from '@repo/protocol/events'

// 错误
import { BaseEvent } from '@repo/protocol/events'  // BaseEvent 是类型，不应作为值导入
```

---

## 2. 共享包规则

### 2.1 类型必须从共享包导入

前后端共享的类型**必须**从 `@repo/shared`、`@repo/protocol`、`@repo/config` 导入，**禁止**在两端重复定义。

| 类型 | 导入路径 |
|------|----------|
| AgentMessage, AgentRole, AgentRunInput | `@repo/shared/agent` |
| AppError, ErrorCode | `@repo/shared/errors` |
| ApiResponse, ApiSuccess, ApiFailure | `@repo/shared/api` |
| BaseEvent, EventType, RunStartedEvent 等 | `@repo/protocol/events` |
| BrowserConfig | `@repo/config/browser` |

```typescript
// 正确
import type { AgentMessage } from '@repo/shared/agent'
import { EventType, type BaseEvent } from '@repo/protocol/events'
import { AppError, ErrorCode } from '@repo/shared/errors'

// 错误 — 重复定义
interface AgentMessage { id: string; role: string; content: string }  // 禁止！
```

### 2.2 共享包导出结构

```
@repo/shared          → { api, errors, agent, agui, events, types, utils }
@repo/shared/agent    → { AgentMessage, AgentRole, AgentRunInput }
@repo/shared/errors   → { AppError, ErrorCode, sanitizeErrorMessage }
@repo/shared/api      → { ApiResponse, ApiSuccess, ApiFailure, isApiSuccess }
@repo/protocol/events → { EventType, BaseEvent, RunStartedEvent, ... }
@repo/protocol/schemas→ { Zod schemas }
@repo/config/browser  → { browserConfig, BrowserConfig }
```

---

## 3. 后端规则（agent-server）

### 3.1 错误处理

**所有业务错误必须使用 AppError**，禁止直接 `throw new Error()`。

```typescript
// 正确
throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, '描述用户可见的消息', 500, '原始内部消息')

// 错误
throw new Error('出错了')  // 禁止！
```

AppError 构造函数参数：
1. `code: ErrorCode` — 错误码（必须从 ErrorCode 枚举中选取）
2. `userMessage: string` — 用户可见消息（会自动脱敏）
3. `statusCode: number` — HTTP 状态码（默认 500）
4. `internalMessage?: string` — 内部日志消息（不脱敏，仅写日志）

**ErrorCode 可用值**：
`BAD_REQUEST` / `UNAUTHORIZED` / `FORBIDDEN` / `NOT_FOUND` / `VALIDATION_ERROR` / `INTERNAL_SERVER_ERROR` / `AGENT_RUN_FAILED` / `AGENT_CANCELLED` / `TOOL_EXECUTION_FAILED` / `CONFIG_ERROR`

### 3.2 API 响应格式

所有 API 响应必须使用统一的 `success()` / `failure()` 函数：

```typescript
import { success, failure } from '../lib/api-response.js'

// 成功
return reply.status(200).send(success(data, traceId))

// 失败
return reply.status(400).send(failure(ErrorCode.BAD_REQUEST, '消息', traceId))
```

响应结构：
```typescript
// 成功
{ ok: true, data: T, meta: { traceId, timestamp } }
// 失败
{ ok: false, error: { code, message, details? }, meta: { traceId, timestamp } }
```

### 3.3 日志

使用 `createModuleLogger` 创建模块级子日志器：

```typescript
import { createModuleLogger } from '../lib/logger.js'

// 在 Fastify 插件内
const log = createModuleLogger(app.log, 'module-name')
log.info({ key: 'value' }, '消息')
```

**禁止**使用 `console.log`。ESLint 规则 `no-console: ['warn', { allow: ['warn', 'error'] }]`。

### 3.4 Fastify 插件模式

- 插件必须用 `fp()` 包装以确保作用域隔离
- 通过 `fastify.decorate()` 注册服务
- 通过 TypeScript 模块扩展声明类型

```typescript
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'

declare module 'fastify' {
  interface FastifyInstance {
    myService: MyService
  }
}

export const myServicePlugin: FastifyPluginAsync = fp(async (app) => {
  const service = new MyService()
  app.decorate('myService', service)
})
```

### 3.5 路由模式

路由函数签名：

```typescript
import type { FastifyPluginAsync } from 'fastify'

export const myRoute: FastifyPluginAsync = async (app) => {
  app.get('/api/path', async (request, reply) => {
    // ...
  })
}
```

在 `app.ts` 中注册路由：

```typescript
await app.register(myRoute)
```

### 3.6 AG-UI 协议契约

**必须遵守的事件顺序**：

```
RUN_STARTED → [MESSAGES_SNAPSHOT] → [TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT ×N → TEXT_MESSAGE_END]
→ [STEP_STARTED → TOOL_CALL_START → TOOL_CALL_ARGS → TOOL_CALL_END → STEP_FINISHED]
→ RUN_FINISHED | RUN_ERROR
```

**关键不变量**：
1. `RUN_STARTED` 必须是第一个事件
2. `RUN_FINISHED` 或 `RUN_ERROR` 必须是最后一个事件
3. `RUN_FINISHED` 和 `RUN_ERROR` **互斥**：一次 streamRun 恰好发射一个终止事件
4. abort 时发射 `RUN_FINISHED`（reason='aborted'），**不是** `RUN_ERROR`
5. 同线程 run 互斥：并发 run 返回 `RUN_ERROR`（code: RUN_ALREADY_IN_PROGRESS）

### 3.7 SSE 心跳

AG-UI SSE 路由必须每 15 秒发送 keepalive 注释：

```typescript
const keepalive = setInterval(() => {
  sendSseComment(reply, 'keepalive')
}, 15_000)
```

### 3.8 资源清理

所有长生命周期资源（interval、event subscription、activeRunId）必须在 finally 块中清理：

```typescript
try {
  // 业务逻辑
} finally {
  clearInterval(keepalive)
  unsubscribe()
  sessionStore.releaseRun(threadId, runId)
}
```

---

## 4. 前端规则（desktop）

### 4.1 组件结构

- 使用**函数组件** + TypeScript，禁止 class 组件
- Props 必须定义 `interface` 并导出
- 组件使用**命名导出**（`export function`），不使用默认导出

```typescript
// 正确
export interface MyComponentProps {
  title: string
  onAction: () => void
}

export function MyComponent({ title, onAction }: MyComponentProps) {
  return <div>{title}</div>
}

// 错误
export default function MyComponent(props: any) { ... }  // 禁止默认导出 + any
```

### 4.2 路径别名

- `@/` → `src/renderer/src/`
- `@renderer/` → `src/renderer/src/`

```typescript
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
```

### 4.3 样式规则

- 使用 Tailwind CSS utility classes，不写自定义 CSS
- 条件类名使用 `cn()` 工具函数（clsx + tailwind-merge）

```typescript
import { cn } from '@/lib/utils'

<div className={cn('base-class', condition && 'conditional-class')} />
```

### 4.4 UI 组件来源

- 基础 UI 组件（Button、Dialog、Input 等）从 `@/components/ui/` 导入
- 这些组件由 shadcn/ui 生成，**不要手动修改** `components/ui/` 下的文件
- 业务组件放在 `@/components/chat/`、`@/components/settings/`、`@/components/overlays/`

### 4.5 三态必做

每个数据驱动组件**必须**实现 loading / error / empty 三态：

```typescript
if (isLoading) return <Skeleton />
if (isError) return <ErrorState error={error} onRetry={refetch} />
if (!data?.length) return <EmptyState title="暂无数据" />
return <ActualContent data={data} />
```

### 4.6 Hooks 规则

- 自定义 hooks 放在 `src/renderer/src/hooks/`
- 命名以 `use-` 为文件前缀（kebab-case），导出以 `use` 为前缀（camelCase）
- 回调引用使用 `useRef` 存储以避免触发不必要的重渲染

```typescript
// 文件：use-streaming-run.ts
export function useStreamingRun(options: UseStreamingRunOptions): UseStreamingRunReturn {
  const onEventRef = useRef(options.onEvent)
  onEventRef.current = options.onEvent  // 保持最新引用
}
```

### 4.7 SSE 流解析

前端 SSE 解析必须使用 `ReadableStream` + `TextDecoder`，按 `\n\n` 分割事件：

```typescript
const reader = response.body.getReader()
const decoder = new TextDecoder('utf-8')
let buffer = ''

while (true) {
  const { value, done } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  const chunks = buffer.split('\n\n')
  buffer = chunks.pop() ?? ''
  for (const chunk of chunks) {
    const event = parseSseChunk(chunk)
    if (event) onEvent(event)
  }
}
```

### 4.8 AbortController 中断

所有可中断的异步操作必须支持 `AbortSignal`：

```typescript
const response = await fetch(url, { signal })
// AbortError 不视为错误
if (error instanceof DOMException && error.name === 'AbortError') return
```

### 4.9 IME 组合输入

输入框必须处理 IME（中文输入法）组合状态，避免 Enter 确认时误触发发送：

```typescript
const isComposingRef = useRef(false)
onCompositionStart={() => { isComposingRef.current = true }}
onCompositionEnd={() => { isComposingRef.current = false }}
onKeyDown={(e) => {
  if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
    e.preventDefault()
    handleSend()
  }
}}
```

---

## 5. 测试规则

### 5.1 测试框架

- 使用 Vitest
- 后端测试环境：Node.js（默认）
- 前端测试环境：jsdom

### 5.2 测试文件位置

- 后端：`apps/agent-server/src/__tests__/`
- 前端：与源文件同目录（`*.test.tsx`）

### 5.3 测试命名

```typescript
describe('模块名 / 功能名', () => {
  it('TC-XX: 具体行为描述', async () => {
    // ...
  })
})
```

### 5.4 Mock 规则

- 使用 `vi.fn()` 和 `vi.mock()`
- Mock 外部依赖（Pi SDK、fetch），不 mock 内部模块
- 测试文件顶部声明所有 mock

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@repo/config/browser', () => ({
  browserConfig: { /* ... */ }
}))
```

### 5.5 契约测试

对于跨模块/跨进程的协议（如 AG-UI 事件顺序），必须编写契约测试验证不变量，而非仅测试实现细节。

---

## 6. Git 规则

### 6.1 提交消息格式

```
type(scope): 简短描述

详细说明（可选）
```

type 范围：
- `feat` — 新功能
- `fix` — 修复
- `refactor` — 重构
- `chore` — 构建/工具/依赖
- `test` — 测试
- `docs` — 文档

scope 范围：
- `desktop` — 前端
- `agent-server` — 后端
- `shared` / `protocol` / `config` — 共享包

### 6.2 禁止的操作

- **禁止** `git push --force`
- **禁止** `git reset --hard`
- **禁止** 提交 `.env`、`credentials`、API Key
- **禁止** 提交 `node_modules/`、`dist/`、`out/`

---

## 7. 安全规则

### 7.1 敏感信息脱敏

- API Key、Bearer Token、文件路径在错误消息中**必须脱敏**
- 使用 `sanitizeErrorMessage()` 自动脱敏
- `AppError.userMessage` 自动脱敏，`AppError.internalMessage` 不脱敏（仅日志）

### 7.2 凭证存储

- API Key 通过 Electron `safeStorage` 加密存储
- 前端通过 IPC 桥接（`CredentialBridge`）访问
- **禁止**明文存储 API Key 到 localStorage 或文件

### 7.3 权限模式

- 危险工具（bash、write、edit）**必须**经过 Gate 权限检查
- Auto 模式：读操作自动，写操作/Shell 弹确认
- Plan 模式：先输出计划，用户确认后执行写操作
- Read-only 模式：仅允许读操作

---

## 8. 架构不变量

### 8.1 Pi SDK Agent Loop 不可绕过

Pi SDK 提供 Agent Loop（LLM → tool_call → 工具 → LLM 循环），我们的代码**不能**自建 Agent Loop。定制点仅限：
- Gate（工具执行前权限检查）
- Evidence Ledger（任务验证）
- EventBus（事件总线）
- AG-UI 事件映射

### 8.2 通信路径分工

| 通道 | 用途 | 协议 |
|------|------|------|
| SSE | LLM 流式输出、Run 生命周期 | AG-UI |
| WebSocket | 确认请求、状态变更、通知 | 自定义事件 |
| HTTP REST | 配置、查询、权限模式 | 统一 ApiResponse |
| Electron IPC | API Key、代理、数据目录 | Main ↔ Renderer |

**禁止**在错误的通道上传输数据（如通过 HTTP 轮询确认请求）。

### 8.3 CopilotKit 降级

CopilotKit 的 `CopilotSidebar` 已被自研 `ChatWorkspace` 替代。**禁止**重新引入 CopilotSidebar。仅保留 `@copilotkit/react-core` 的 hook 用于 AG-UI 协议对接（如需）。

---

## 9. 依赖规则

### 9.1 依赖安装

- 使用 pnpm（非 npm/yarn）
- 添加依赖：`pnpm add <package> --filter <workspace>`
- workspace 内部依赖使用 `"workspace:*"` 协议

### 9.2 禁止重复安装

- React/React DOM 仅在 `apps/desktop` 安装
- Fastify 仅在 `apps/agent-server` 安装
- 共享工具放 `packages/shared`，类型放 `packages/protocol`

---

## 10. JSDoc 注释规则

**禁止**在 JSDoc 注释内使用 `*/` 序列，这会提前关闭注释块导致编译错误：

```typescript
// 错误 — `*/` 提前关闭注释
/** 显示 REASONING_*/THINKING_* 事件的内容 */

// 正确 — 用下划线替代星号
/** 显示 REASONING_/THINKING_ 事件的内容 */
```

---

## 11. 验证清单

每次提交前必须通过：

```bash
# 后端
pnpm --filter agent-server exec tsc --noEmit
pnpm --filter agent-server test

# 前端
cd apps/desktop && npx tsc --noEmit -p tsconfig.web.json --composite false
cd apps/desktop && npx tsc --noEmit -p tsconfig.node.json --composite false
cd apps/desktop && npx vitest run --environment jsdom

# 共享包
pnpm --filter @repo/protocol test
pnpm --filter @repo/shared test
```
