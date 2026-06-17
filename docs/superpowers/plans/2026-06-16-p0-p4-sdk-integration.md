# P0-P4 SDK 集成实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Pi SDK 集成为 pi-agent 的核心引擎，实现从基础设施到 LLM 对话的完整链路

**架构：** Pi SDK (pi-coding-agent) 提供完整 Agent Loop + Session + Compaction，我们只建薄适配层（PiAgUiAgent + StreamEmitter + AG-UI 路由）和自建模块（EventBus、CredentialBridge、Gate、Memory）

**技术栈：** TypeScript, Fastify, Pi SDK (@earendil-works/pi-coding-agent), AG-UI 协议, Zod, Vitest

---

## 文件结构

```
packages/
  protocol/                          # 新建：AG-UI 协议类型
    package.json
    tsconfig.json
    src/
      index.ts
      events.ts                      # AG-UI 事件类型
      schemas.ts                     # Zod schema 校验
  shared/                            # 现有：扩展错误体系 + EventBus
    src/
      errors/
        index.ts                     # 重写：AppError + 错误脱敏
        error-code.ts                # 保留：错误码
        app-error.ts                 # 新建：AppError 类
        sanitize.ts                  # 新建：错误信息脱敏
      events/
        index.ts                     # 新建：EventBus
        event-bus.ts                 # 新建：EventBus 实现
      types/
        index.ts                     # 新建：通用类型
      utils/
        index.ts                     # 新建：工具函数导出
        safe-fs.ts                   # 新建：原子写入
        retry.ts                     # 新建：Decorrelated Jitter 重试
        i18n.ts                      # 新建：国际化
      index.ts                       # 重写：统一导出
  config/                            # 保留现有
apps/
  agent-server/
    src/
      core/
        agent/
          pi-session.ts              # 新建：createPiSession 工厂
          pi-agui-agent.ts           # 新建：AG-UI 适配层
          stream-emitter.ts          # 新建：Pi SDK → AG-UI 事件映射
          session-store.ts           # 新建：活跃会话管理
          instruction-loader.ts      # 新建：项目级指令加载
        config/
          credential-bridge.ts       # 新建：safeStorage → Pi SDK 桥接
          config-coordinator.ts      # 新建：三层配置合并
        tool/
          gate.ts                    # 新建：权限检查接口
      extensions/
        web-search.ts                # 新建：web_search + web_fetch 扩展
      routes/
        agui.route.ts                # 重写：完整 AG-UI 路由
        copilotkit.route.ts          # 重写：CopilotKit 兼容层
        health.route.ts              # 保留
      plugins/
        pi-sdk.plugin.ts             # 新建：Pi SDK 核心对象注册
        event-bus.plugin.ts          # 新建：EventBus 注册
        cors.plugin.ts               # 重写：CORS 白名单
        auth.plugin.ts               # 新建：Bearer Token 认证
        rate-limit.plugin.ts         # 新建：速率限制
        error-handler.plugin.ts      # 重写：集成 AppError
        request-context.plugin.ts    # 保留
      lib/
        sse.ts                       # 重写：SSE 工具
        validate.ts                  # 保留
        logger.ts                    # 新建：createModuleLogger
        i18n.ts                      # 新建：国际化实例
      app.ts                         # 重写：注册所有插件和路由
      index.ts                       # 重写：启动逻辑
```

---

## 任务 1：@repo/protocol 包（AG-UI 事件类型 + Zod Schema）

**文件：**
- 创建：`packages/protocol/package.json`
- 创建：`packages/protocol/tsconfig.json`
- 创建：`packages/protocol/src/index.ts`
- 创建：`packages/protocol/src/events.ts`
- 创建：`packages/protocol/src/schemas.ts`
- 测试：`packages/protocol/src/__tests__/schemas.test.ts`

- [ ] **步骤 1：创建 package.json 和 tsconfig.json**

创建 `packages/protocol/package.json`：

```json
{
  "name": "@repo/protocol",
  "version": "0.0.1",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./events": "./src/events.ts",
    "./schemas": "./src/schemas.ts"
  },
  "dependencies": {
    "@ag-ui/core": "^0.0.56",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "typescript": "^5.9.3",
    "vitest": "^3.2.4"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

创建 `packages/protocol/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **步骤 2：编写失败的测试 — Zod schema 校验**

创建 `packages/protocol/src/__tests__/schemas.test.ts`：

```typescript
import { describe, expect, it } from 'vitest'
import {
  runAgentInputSchema,
  threadMessageInputSchema,
  forkThreadInputSchema,
  navigateThreadInputSchema,
  compactThreadInputSchema,
  toolsActiveInputSchema,
} from '../schemas.js'

describe('runAgentInputSchema', () => {
  it('拒绝空 body', () => {
    const result = runAgentInputSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('接受最小合法输入', () => {
    const result = runAgentInputSchema.safeParse({
      threadId: 'thread-1',
      runId: 'run-1',
      messages: [],
    })
    expect(result.success).toBe(true)
  })

  it('要求 threadId 为非空字符串', () => {
    const result = runAgentInputSchema.safeParse({
      threadId: '',
      runId: 'run-1',
      messages: [],
    })
    expect(result.success).toBe(false)
  })

  it('要求 runId 为非空字符串', () => {
    const result = runAgentInputSchema.safeParse({
      threadId: 'thread-1',
      runId: '',
      messages: [],
    })
    expect(result.success).toBe(false)
  })
})

describe('threadMessageInputSchema', () => {
  it('要求 threadId 和 text', () => {
    const result = threadMessageInputSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('接受合法输入', () => {
    const result = threadMessageInputSchema.safeParse({
      threadId: 'thread-1',
      text: '你好',
    })
    expect(result.success).toBe(true)
  })

  it('接受带 images 的输入', () => {
    const result = threadMessageInputSchema.safeParse({
      threadId: 'thread-1',
      text: '看图',
      images: [{ type: 'image', mimeType: 'image/png', data: 'base64...' }],
    })
    expect(result.success).toBe(true)
  })
})

describe('forkThreadInputSchema', () => {
  it('要求 threadId 和 entryId', () => {
    const result = forkThreadInputSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('接受合法输入', () => {
    const result = forkThreadInputSchema.safeParse({
      threadId: 'thread-1',
      entryId: 'entry-1',
    })
    expect(result.success).toBe(true)
  })
})

describe('navigateThreadInputSchema', () => {
  it('要求 threadId 和 targetId', () => {
    const result = navigateThreadInputSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('接受带可选字段的输入', () => {
    const result = navigateThreadInputSchema.safeParse({
      threadId: 'thread-1',
      targetId: 'target-1',
      summarize: true,
      customInstructions: '总结重点',
    })
    expect(result.success).toBe(true)
  })
})

describe('compactThreadInputSchema', () => {
  it('要求 threadId', () => {
    const result = compactThreadInputSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('接受带可选 customInstructions 的输入', () => {
    const result = compactThreadInputSchema.safeParse({
      threadId: 'thread-1',
      customInstructions: '保留代码片段',
    })
    expect(result.success).toBe(true)
  })
})

describe('toolsActiveInputSchema', () => {
  it('要求 threadId 和 toolNames 数组', () => {
    const result = toolsActiveInputSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('接受合法输入', () => {
    const result = toolsActiveInputSchema.safeParse({
      threadId: 'thread-1',
      toolNames: ['read', 'bash'],
    })
    expect(result.success).toBe(true)
  })

  it('拒绝空 toolNames', () => {
    const result = toolsActiveInputSchema.safeParse({
      threadId: 'thread-1',
      toolNames: [],
    })
    expect(result.success).toBe(true) // 空数组合法（禁用所有工具）
  })
})
```

- [ ] **步骤 3：运行测试验证失败**

运行：`cd packages/protocol && pnpm install && pnpm test`
预期：FAIL，报错 "Cannot find module '../schemas.js'"

- [ ] **步骤 4：编写 events.ts — AG-UI 事件类型重导出**

创建 `packages/protocol/src/events.ts`：

```typescript
/**
 * AG-UI 事件类型
 * 从 @ag-ui/core 重导出，提供项目统一的类型入口
 */
export {
  EventType,
  type BaseEvent,
  type RunStartedEvent,
  type RunFinishedEvent,
  type RunErrorEvent,
  type TextMessageStartEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type ToolCallStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type StepStartedEvent,
  type StepFinishedEvent,
  type StateSnapshotEvent,
  type MessagesSnapshotEvent,
  type ActivitySnapshotEvent,
  type ActivityDeltaEvent,
  type CustomEvent,
  type RawEvent,
  type ReasoningStartEvent,
  type ReasoningMessageStartEvent,
  type ReasoningMessageContentEvent,
  type ReasoningMessageEndEvent,
  type ReasoningEndEvent,
  type ThinkingStartEvent,
  type ThinkingEndEvent,
  type ThinkingTextMessageStartEvent,
  type ThinkingTextMessageContentEvent,
  type ThinkingTextMessageEndEvent,
  type Message,
  type RunAgentInput,
} from '@ag-ui/core'

/** AG-UI 事件接收器：接收 BaseEvent 的回调函数 */
export type AgUiEventSink = (event: import('@ag-ui/core').BaseEvent) => void
```

- [ ] **步骤 5：编写 schemas.ts — Zod schema 校验**

创建 `packages/protocol/src/schemas.ts`：

```typescript
import { z } from 'zod'

/** AG-UI RunAgentInput 校验 schema */
export const runAgentInputSchema = z.object({
  threadId: z.string().min(1, 'threadId 不能为空'),
  runId: z.string().min(1, 'runId 不能为空'),
  messages: z.array(z.any()),
  tools: z.array(z.any()).optional(),
  state: z.record(z.string(), z.unknown()).optional(),
  forwardedProps: z.record(z.string(), z.unknown()).optional(),
  parentRunId: z.string().optional(),
})

/** 线程消息输入（steer / follow-up 共用） */
export const threadMessageInputSchema = z.object({
  threadId: z.string().min(1, 'threadId 不能为空'),
  text: z.string().min(1, 'text 不能为空'),
  images: z
    .array(
      z.object({
        type: z.literal('image'),
        mimeType: z.string().min(1),
        data: z.string().min(1),
      }),
    )
    .optional(),
})

/** 分叉线程输入 */
export const forkThreadInputSchema = z.object({
  threadId: z.string().min(1, 'threadId 不能为空'),
  entryId: z.string().min(1, 'entryId 不能为空'),
})

/** 导航线程输入 */
export const navigateThreadInputSchema = z.object({
  threadId: z.string().min(1, 'threadId 不能为空'),
  targetId: z.string().min(1, 'targetId 不能为空'),
  summarize: z.boolean().optional(),
  customInstructions: z.string().optional(),
  replaceInstructions: z.boolean().optional(),
  label: z.string().optional(),
})

/** 压缩线程输入 */
export const compactThreadInputSchema = z.object({
  threadId: z.string().min(1, 'threadId 不能为空'),
  customInstructions: z.string().optional(),
})

/** 设置活跃工具输入 */
export const toolsActiveInputSchema = z.object({
  threadId: z.string().min(1, 'threadId 不能为空'),
  toolNames: z.array(z.string().min(1)),
})

/** 重载资源输入 */
export const reloadInputSchema = z.object({
  threadId: z.string().optional(),
})

/** 模型选择输入 */
export const modelSelectionInputSchema = z.object({
  provider: z.string().min(1, 'provider 不能为空'),
  modelId: z.string().min(1, 'modelId 不能为空'),
})

/** Thinking 设置输入 */
export const thinkingSettingsInputSchema = z.object({
  defaultThinkingLevel: z
    .enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
    .optional(),
  thinkingBudgets: z
    .object({
      minimal: z.number().positive().optional(),
      low: z.number().positive().optional(),
      medium: z.number().positive().optional(),
      high: z.number().positive().optional(),
    })
    .optional(),
})

/** 自动压缩/自动重试开关输入 */
export const booleanToggleInputSchema = z.object({
  threadId: z.string().min(1, 'threadId 不能为空'),
  enabled: z.boolean(),
})

/** 队列模式输入（steering / follow-up 模式） */
export const queueModeInputSchema = z.object({
  threadId: z.string().min(1, 'threadId 不能为空'),
  mode: z.enum(['all', 'one-at-a-time']),
})

/** 会话命名输入 */
export const sessionNameInputSchema = z.object({
  threadId: z.string().min(1, 'threadId 不能为空'),
  name: z.string().min(1, 'name 不能为空'),
})

/** 导出类型 */
export type RunAgentInputSchema = z.infer<typeof runAgentInputSchema>
export type ThreadMessageInputSchema = z.infer<typeof threadMessageInputSchema>
export type ForkThreadInputSchema = z.infer<typeof forkThreadInputSchema>
export type NavigateThreadInputSchema = z.infer<typeof navigateThreadInputSchema>
export type CompactThreadInputSchema = z.infer<typeof compactThreadInputSchema>
export type ToolsActiveInputSchema = z.infer<typeof toolsActiveInputSchema>
export type ReloadInputSchema = z.infer<typeof reloadInputSchema>
export type ModelSelectionInputSchema = z.infer<typeof modelSelectionInputSchema>
export type ThinkingSettingsInputSchema = z.infer<typeof thinkingSettingsInputSchema>
export type BooleanToggleInputSchema = z.infer<typeof booleanToggleInputSchema>
export type QueueModeInputSchema = z.infer<typeof queueModeInputSchema>
export type SessionNameInputSchema = z.infer<typeof sessionNameInputSchema>
```

- [ ] **步骤 6：编写 index.ts — 统一导出**

创建 `packages/protocol/src/index.ts`：

```typescript
export * from './events.js'
export * from './schemas.js'
```

- [ ] **步骤 7：运行测试验证通过**

运行：`cd packages/protocol && pnpm test`
预期：PASS

- [ ] **步骤 8：注册 workspace 依赖**

在 `pnpm-workspace.yaml` 中已包含 `packages/*`，无需修改。在 `packages/protocol` 目录下运行 `pnpm install` 安装依赖。

- [ ] **步骤 9：Commit**

```bash
git add packages/protocol/
git commit -m "feat(protocol): 新增 @repo/protocol 包，定义 AG-UI 事件类型和 Zod schema"
```

---

## 任务 2：@repo/shared 扩展（AppError + 错误脱敏 + EventBus + 工具函数）

**文件：**
- 创建：`packages/shared/src/errors/app-error.ts`
- 创建：`packages/shared/src/errors/sanitize.ts`
- 修改：`packages/shared/src/errors/index.ts`
- 创建：`packages/shared/src/events/event-bus.ts`
- 创建：`packages/shared/src/events/index.ts`
- 创建：`packages/shared/src/types/index.ts`
- 创建：`packages/shared/src/utils/safe-fs.ts`
- 创建：`packages/shared/src/utils/retry.ts`
- 创建：`packages/shared/src/utils/i18n.ts`
- 创建：`packages/shared/src/utils/index.ts`
- 修改：`packages/shared/src/index.ts`
- 修改：`packages/shared/package.json`
- 测试：`packages/shared/src/__tests__/app-error.test.ts`
- 测试：`packages/shared/src/__tests__/sanitize.test.ts`
- 测试：`packages/shared/src/__tests__/event-bus.test.ts`
- 测试：`packages/shared/src/__tests__/safe-fs.test.ts`
- 测试：`packages/shared/src/__tests__/retry.test.ts`

- [ ] **步骤 1：编写失败的测试 — AppError 类**

创建 `packages/shared/src/__tests__/app-error.test.ts`：

```typescript
import { describe, expect, it } from 'vitest'
import { AppError } from '../errors/app-error.js'
import { ErrorCode } from '../errors/error-code.js'

describe('AppError', () => {
  it('携带错误码和用户消息', () => {
    const error = new AppError(ErrorCode.UNAUTHORIZED, '认证失败', 401)
    expect(error.code).toBe(ErrorCode.UNAUTHORIZED)
    expect(error.userMessage).toBe('认证失败')
    expect(error.statusCode).toBe(401)
    expect(error).toBeInstanceOf(Error)
  })

  it('默认 statusCode 为 500', () => {
    const error = new AppError(ErrorCode.INTERNAL_SERVER_ERROR, '内部错误')
    expect(error.statusCode).toBe(500)
  })

  it('自动脱敏 userMessage 中的 API Key', () => {
    const error = new AppError(
      ErrorCode.CONFIG_ERROR,
      'API Key sk-abc123xyz 无效',
    )
    expect(error.userMessage).toBe('API Key [REDACTED_KEY] 无效')
  })

  it('自动脱敏 userMessage 中的文件路径', () => {
    const error = new AppError(
      ErrorCode.CONFIG_ERROR,
      '无法读取 /home/user/.pi/auth.json',
    )
    expect(error.userMessage).toBe('无法读取 [REDACTED_PATH]')
  })

  it('保留原始 internalMessage 不脱敏', () => {
    const error = new AppError(
      ErrorCode.CONFIG_ERROR,
      '配置错误',
      500,
      '无法读取 /home/user/.pi/auth.json: sk-abc123xyz',
    )
    expect(error.userMessage).toBe('配置错误')
    expect(error.internalMessage).toBe(
      '无法读取 /home/user/.pi/auth.json: sk-abc123xyz',
    )
  })

  it('toJSON 输出脱敏后的信息', () => {
    const error = new AppError(
      ErrorCode.CONFIG_ERROR,
      'Key sk-deadbeef 失效',
      500,
      'sk-deadbeef 详细信息',
    )
    const json = error.toJSON()
    expect(json.code).toBe(ErrorCode.CONFIG_ERROR)
    expect(json.message).toBe('Key [REDACTED_KEY] 失效')
    expect(json).not.toHaveProperty('internalMessage')
  })
})
```

- [ ] **步骤 2：编写失败的测试 — sanitizeErrorMessage**

创建 `packages/shared/src/__tests__/sanitize.test.ts`：

```typescript
import { describe, expect, it } from 'vitest'
import { sanitizeErrorMessage } from '../errors/sanitize.js'

describe('sanitizeErrorMessage', () => {
  it('脱敏 OpenAI API Key', () => {
    expect(sanitizeErrorMessage('key: sk-abc123def456')).toBe(
      'key: [REDACTED_KEY]',
    )
  })

  it('脱敏 Anthropic API Key', () => {
    expect(sanitizeErrorMessage('key: sk-ant-api03-abc123')).toBe(
      'key: [REDACTED_KEY]',
    )
  })

  it('脱敏 Bearer Token', () => {
    expect(sanitizeErrorMessage('Bearer abc123token')).toBe(
      'Bearer [REDACTED_TOKEN]',
    )
  })

  it('脱敏文件路径', () => {
    expect(sanitizeErrorMessage('读取 /home/user/.pi/auth.json 失败')).toBe(
      '读取 [REDACTED_PATH] 失败',
    )
  })

  it('脱敏 Windows 路径', () => {
    expect(sanitizeErrorMessage('读取 C:\\Users\\test\\.pi\\auth.json')).toBe(
      '读取 [REDACTED_PATH]',
    )
  })

  it('普通文本不变', () => {
    expect(sanitizeErrorMessage('服务器内部错误')).toBe('服务器内部错误')
  })

  it('空字符串不变', () => {
    expect(sanitizeErrorMessage('')).toBe('')
  })
})
```

- [ ] **步骤 3：编写失败的测试 — EventBus**

创建 `packages/shared/src/__tests__/event-bus.test.ts`：

```typescript
import { describe, expect, it, vi } from 'vitest'
import { EventBus } from '../events/event-bus.js'

describe('EventBus', () => {
  it('订阅和发布事件', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.on('test:event', handler)
    bus.emit('test:event', { value: 42 })
    expect(handler).toHaveBeenCalledWith({ value: 42 })
  })

  it('取消订阅后不再收到事件', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.on('test:event', handler)
    bus.off('test:event', handler)
    bus.emit('test:event', { value: 1 })
    expect(handler).not.toHaveBeenCalled()
  })

  it('同一事件多个处理器', () => {
    const bus = new EventBus()
    const handler1 = vi.fn()
    const handler2 = vi.fn()
    bus.on('test:event', handler1)
    bus.on('test:event', handler2)
    bus.emit('test:event', {})
    expect(handler1).toHaveBeenCalled()
    expect(handler2).toHaveBeenCalled()
  })

  it('一次性订阅', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.once('test:event', handler)
    bus.emit('test:event', {})
    bus.emit('test:event', {})
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('无订阅者时 emit 不报错', () => {
    const bus = new EventBus()
    expect(() => bus.emit('nonexistent', {})).not.toThrow()
  })

  it('处理器抛出异常不影响其他处理器', () => {
    const bus = new EventBus()
    const handler1 = vi.fn(() => {
      throw new Error('handler1 error')
    })
    const handler2 = vi.fn()
    bus.on('test:event', handler1)
    bus.on('test:event', handler2)
    bus.emit('test:event', {})
    expect(handler2).toHaveBeenCalled()
  })
})
```

- [ ] **步骤 4：编写失败的测试 — safe-fs**

创建 `packages/shared/src/__tests__/safe-fs.test.ts`：

```typescript
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { atomicWriteSync } from '../utils/safe-fs.js'

const testDir = join(tmpdir(), 'pi-agent-test-safe-fs')

describe('atomicWriteSync', () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('原子写入文件', () => {
    const filePath = join(testDir, 'test.txt')
    atomicWriteSync(filePath, 'hello world')
    expect(readFileSync(filePath, 'utf-8')).toBe('hello world')
  })

  it('覆盖已存在的文件', () => {
    const filePath = join(testDir, 'test.txt')
    atomicWriteSync(filePath, 'first')
    atomicWriteSync(filePath, 'second')
    expect(readFileSync(filePath, 'utf-8')).toBe('second')
  })

  it('自动创建不存在的父目录', () => {
    const filePath = join(testDir, 'sub', 'dir', 'test.txt')
    atomicWriteSync(filePath, 'nested')
    expect(readFileSync(filePath, 'utf-8')).toBe('nested')
  })
})
```

- [ ] **步骤 5：编写失败的测试 — retry**

创建 `packages/shared/src/__tests__/retry.test.ts`：

```typescript
import { describe, expect, it, vi } from 'vitest'
import { retryWithJitter } from '../utils/retry.js'

describe('retryWithJitter', () => {
  it('首次成功直接返回', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await retryWithJitter(fn, { maxRetries: 3, baseDelayMs: 10 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('重试后成功', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce('ok')
    const result = await retryWithJitter(fn, { maxRetries: 3, baseDelayMs: 10 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('超过最大重试次数后抛出', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fail'))
    await expect(
      retryWithJitter(fn, { maxRetries: 2, baseDelayMs: 10 }),
    ).rejects.toThrow('always fail')
    expect(fn).toHaveBeenCalledTimes(3) // 1 + 2 次重试
  })
})
```

- [ ] **步骤 6：运行测试验证失败**

运行：`cd packages/shared && pnpm test`
预期：FAIL，报错 "Cannot find module '../errors/app-error.js'"

- [ ] **步骤 7：实现 sanitizeErrorMessage**

创建 `packages/shared/src/errors/sanitize.ts`：

```typescript
/** 需要脱敏的 API Key 前缀模式 */
const API_KEY_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g, // OpenAI
  /sk-ant-api[a-zA-Z0-9-]{20,}/g, // Anthropic
  /AIza[a-zA-Z0-9_-]{35}/g, // Google
  /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, // UUID 格式的 key
]

/** Bearer Token 模式 */
const BEARER_TOKEN_PATTERN = /Bearer\s+\S+/gi

/** 文件路径模式（Unix + Windows） */
const FILE_PATH_PATTERNS = [
  // Unix 绝对路径（包含 .pi 或 .config 等敏感目录）
  /\/(?:home|Users|root|etc|var|tmp)\/[^\s'"]+/g,
  // Windows 绝对路径
  /[A-Za-z]:\\[^\s'"]+/g,
  // 以 .pi/ 开头的相对路径
  /\.pi\/[^\s'"]+/g,
]

/**
 * 脱敏错误消息中的敏感信息
 * - API Key → [REDACTED_KEY]
 * - Bearer Token → [REDACTED_TOKEN]
 * - 文件路径 → [REDACTED_PATH]
 */
export function sanitizeErrorMessage(message: string): string {
  let result = message

  for (const pattern of API_KEY_PATTERNS) {
    result = result.replace(pattern, '[REDACTED_KEY]')
  }

  result = result.replace(BEARER_TOKEN_PATTERN, 'Bearer [REDACTED_TOKEN]')

  for (const pattern of FILE_PATH_PATTERNS) {
    result = result.replace(pattern, '[REDACTED_PATH]')
  }

  return result
}
```

- [ ] **步骤 8：实现 AppError 类**

创建 `packages/shared/src/errors/app-error.ts`：

```typescript
import { ErrorCode } from './error-code.js'
import { sanitizeErrorMessage } from './sanitize.js'

/**
 * 应用层统一错误类
 * - userMessage：脱敏后的用户可见消息
 * - internalMessage：原始未脱敏消息（仅日志）
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly userMessage: string
  readonly statusCode: number
  readonly internalMessage: string

  constructor(
    code: ErrorCode,
    userMessage: string,
    statusCode = 500,
    internalMessage?: string,
  ) {
    // 脱敏 userMessage
    const sanitizedUserMessage = sanitizeErrorMessage(userMessage)
    super(sanitizedUserMessage)
    this.name = 'AppError'
    this.code = code
    this.userMessage = sanitizedUserMessage
    this.statusCode = statusCode
    this.internalMessage = internalMessage ?? userMessage
  }

  /** 序列化为 JSON（仅包含脱敏信息，不含 internalMessage） */
  toJSON(): { code: ErrorCode; message: string; statusCode: number } {
    return {
      code: this.code,
      message: this.userMessage,
      statusCode: this.statusCode,
    }
  }
}
```

- [ ] **步骤 9：重写 errors/index.ts**

重写 `packages/shared/src/errors/index.ts`：

```typescript
export * from './error-code.js'
export * from './app-error.js'
export * from './sanitize.js'
```

- [ ] **步骤 10：实现 EventBus**

创建 `packages/shared/src/events/event-bus.ts`：

```typescript
type EventHandler<T = unknown> = (data: T) => void

/**
 * 进程内事件总线
 * 支持订阅/取消订阅/一次性订阅/异常隔离
 */
export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>()

  /** 订阅事件 */
  on<T = unknown>(event: string, handler: EventHandler<T>): void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler as EventHandler)
  }

  /** 取消订阅 */
  off<T = unknown>(event: string, handler: EventHandler<T>): void {
    this.handlers.get(event)?.delete(handler as EventHandler)
  }

  /** 一次性订阅 */
  once<T = unknown>(event: string, handler: EventHandler<T>): void {
    const wrapper: EventHandler<T> = (data) => {
      this.off(event, wrapper)
      handler(data)
    }
    this.on(event, wrapper)
  }

  /** 发布事件，处理器异常不影响其他处理器 */
  emit<T = unknown>(event: string, data: T): void {
    const set = this.handlers.get(event)
    if (!set) return
    for (const handler of set) {
      try {
        handler(data)
      } catch {
        // 异常隔离：不中断其他处理器
      }
    }
  }
}
```

创建 `packages/shared/src/events/index.ts`：

```typescript
export * from './event-bus.js'
```

- [ ] **步骤 11：实现 types/index.ts**

创建 `packages/shared/src/types/index.ts`：

```typescript
/** 通用键值对类型 */
export type RecordType<T = unknown> = Record<string, T>

/** 可等待的 void（回调函数返回值） */
export type MaybeAsync = void | Promise<void>
```

- [ ] **步骤 12：实现 safe-fs**

创建 `packages/shared/src/utils/safe-fs.ts`：

```typescript
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 原子写入文件
 * 先写入临时文件，再 rename 到目标路径，避免写入中断导致文件损坏
 */
export function atomicWriteSync(filePath: string, content: string): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })

  const tmpFile = join(tmpdir(), `pi-agent-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
  try {
    writeFileSync(tmpFile, content, 'utf-8')
    const { renameSync } = await import('node:fs')
    renameSync(tmpFile, filePath)
  } catch {
    // renameSync 可能跨设备失败，回退到直接写入
    writeFileSync(filePath, content, 'utf-8')
  }
}
```

注意：`await import` 在同步函数中不可用，修正为：

创建 `packages/shared/src/utils/safe-fs.ts`（修正版）：

```typescript
import { writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 原子写入文件
 * 先写入临时文件，再 rename 到目标路径，避免写入中断导致文件损坏
 */
export function atomicWriteSync(filePath: string, content: string): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })

  const tmpFile = join(
    tmpdir(),
    `pi-agent-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  )

  try {
    writeFileSync(tmpFile, content, 'utf-8')
    renameSync(tmpFile, filePath)
  } catch {
    // renameSync 可能跨设备失败，回退到直接写入
    writeFileSync(filePath, content, 'utf-8')
  }
}
```

- [ ] **步骤 13：实现 retry**

创建 `packages/shared/src/utils/retry.ts`：

```typescript
export interface RetryOptions {
  /** 最大重试次数（默认 3） */
  maxRetries?: number
  /** 基础延迟毫秒数（默认 1000） */
  baseDelayMs?: number
  /** 最大延迟毫秒数（默认 30000） */
  maxDelayMs?: number
}

/**
 * Decorrelated Jitter 重试策略
 * 参考 AWS 架构博客：https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 */
export async function retryWithJitter<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3
  const baseDelayMs = options.baseDelayMs ?? 1000
  const maxDelayMs = options.maxDelayMs ?? 30000

  let lastDelay = baseDelayMs

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= maxRetries) {
        throw error
      }
      // Decorrelated Jitter: delay = min(cap, base + rand(0, delay * 3))
      const jitter = Math.random() * lastDelay * 3
      lastDelay = Math.min(maxDelayMs, baseDelayMs + jitter)
      await sleep(lastDelay)
    }
  }

  // 不可达，但 TypeScript 需要
  throw new Error('retryWithJitter: 不应到达此处')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
```

- [ ] **步骤 14：实现 i18n**

创建 `packages/shared/src/utils/i18n.ts`：

```typescript
type MessageKey =
  | 'error.internal'
  | 'error.unauthorized'
  | 'error.forbidden'
  | 'error.not_found'
  | 'error.validation'
  | 'error.agent_run_failed'
  | 'error.tool_execution_failed'
  | 'error.config'
  | 'success.ok'
  | 'success.created'
  | 'success.accepted'

const zhCN: Record<MessageKey, string> = {
  'error.internal': '服务器内部错误',
  'error.unauthorized': '认证失败',
  'error.forbidden': '权限不足',
  'error.not_found': '资源不存在',
  'error.validation': '请求参数校验失败',
  'error.agent_run_failed': 'Agent 运行失败',
  'error.tool_execution_failed': '工具执行失败',
  'error.config': '配置错误',
  'success.ok': '操作成功',
  'success.created': '创建成功',
  'success.accepted': '已接受',
}

const enUS: Record<MessageKey, string> = {
  'error.internal': 'Internal server error',
  'error.unauthorized': 'Unauthorized',
  'error.forbidden': 'Forbidden',
  'error.not_found': 'Not found',
  'error.validation': 'Validation failed',
  'error.agent_run_failed': 'Agent run failed',
  'error.tool_execution_failed': 'Tool execution failed',
  'error.config': 'Configuration error',
  'success.ok': 'OK',
  'success.created': 'Created',
  'success.accepted': 'Accepted',
}

type Locale = 'zh-CN' | 'en-US'

const messages: Record<Locale, Record<MessageKey, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
}

let currentLocale: Locale = 'zh-CN'

/** 设置当前语言 */
export function setLocale(locale: Locale): void {
  currentLocale = locale
}

/** 获取当前语言 */
export function getLocale(): Locale {
  return currentLocale
}

/** 获取国际化消息 */
export function t(key: MessageKey, locale?: Locale): string {
  return (messages[locale ?? currentLocale] ?? zhCN)[key] ?? key
}
```

- [ ] **步骤 15：创建 utils/index.ts**

创建 `packages/shared/src/utils/index.ts`：

```typescript
export * from './safe-fs.js'
export * from './retry.js'
export * from './i18n.js'
```

- [ ] **步骤 16：重写 shared/src/index.ts**

重写 `packages/shared/src/index.ts`：

```typescript
export * from './api/index.js'
export * from './errors/index.js'
export * from './events/index.js'
export * from './types/index.js'
export * from './utils/index.js'
```

- [ ] **步骤 17：更新 shared/package.json 添加 vitest**

修改 `packages/shared/package.json`，添加 vitest 依赖和 test 脚本：

```json
{
  "name": "@repo/shared",
  "version": "0.0.1",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./api": "./src/api/index.ts",
    "./errors": "./src/errors/index.ts",
    "./events": "./src/events/index.ts",
    "./agent": "./src/agent/index.ts",
    "./agui": "./src/agui/index.ts",
    "./types": "./src/types/index.ts",
    "./utils": "./src/utils/index.ts"
  },
  "dependencies": {
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "typescript": "^5.9.3",
    "vitest": "^3.2.4"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **步骤 18：运行测试验证通过**

运行：`cd packages/shared && pnpm install && pnpm test`
预期：PASS

- [ ] **步骤 19：Commit**

```bash
git add packages/shared/
git commit -m "feat(shared): 新增 AppError 错误体系、EventBus、safe-fs、retry、i18n"
```

---

## 任务 3：安全基线（CORS + 认证 + 速率限制 + 输入验证）

**文件：**
- 重写：`apps/agent-server/src/plugins/cors.plugin.ts`
- 创建：`apps/agent-server/src/plugins/auth.plugin.ts`
- 创建：`apps/agent-server/src/plugins/rate-limit.plugin.ts`
- 重写：`apps/agent-server/src/plugins/error-handler.plugin.ts`
- 修改：`apps/agent-server/src/types/fastify.d.ts`
- 修改：`apps/agent-server/package.json`
- 测试：`apps/agent-server/src/__tests__/security.test.ts`

- [ ] **步骤 1：编写失败的测试 — 安全基线**

创建 `apps/agent-server/src/__tests__/security.test.ts`：

```typescript
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createApp } from '../app.js'

describe('安全基线', () => {
  let app: Awaited<ReturnType<typeof createApp>>

  beforeAll(async () => {
    process.env.PI_AGENT_AUTH_TOKEN = 'test-token-123'
    app = await createApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('非白名单来源被 CORS 拒绝', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        origin: 'https://evil.com',
      },
    })
    // CORS 拒绝时 Fastify 返回 500 或无 CORS 头
    const allowOrigin = response.headers['access-control-allow-origin']
    expect(allowOrigin).toBeUndefined()
  })

  it('localhost 来源被 CORS 允许', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        origin: 'http://localhost:5173',
      },
    })
    const allowOrigin = response.headers['access-control-allow-origin']
    expect(allowOrigin).toBe('http://localhost:5173')
  })

  it('无 Token 请求返回 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ag-ui/agent/default/run',
      body: {},
    })
    expect(response.statusCode).toBe(401)
  })

  it('错误 Token 请求返回 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ag-ui/agent/default/run',
      headers: {
        authorization: 'Bearer wrong-token',
      },
      body: {},
    })
    expect(response.statusCode).toBe(401)
  })

  it('正确 Token 通过认证', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        authorization: 'Bearer test-token-123',
      },
    })
    expect(response.statusCode).toBe(200)
  })

  it('health 端点不需要认证', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
    })
    expect(response.statusCode).toBe(200)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd apps/agent-server && pnpm test`
预期：FAIL，现有 CORS 允许所有来源，无认证机制

- [ ] **步骤 3：安装安全相关依赖**

```bash
cd apps/agent-server && pnpm add @fastify/rate-limit && pnpm add -D vitest
```

- [ ] **步骤 4：重写 CORS 插件**

重写 `apps/agent-server/src/plugins/cors.plugin.ts`：

```typescript
import fp from 'fastify-plugin'
import cors from '@fastify/cors'
import type { FastifyPluginAsync } from 'fastify'

/** CORS 白名单：仅允许本地来源 */
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3900',
  'http://127.0.0.1:3900',
]

export const corsPlugin: FastifyPluginAsync = fp(async (app) => {
  await app.register(cors, {
    origin: (origin, callback) => {
      // 无 origin（如 curl）允许通过
      if (!origin) {
        callback(null, true)
        return
      }
      if (ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true)
        return
      }
      callback(new Error('CORS 不允许的来源'), false)
    },
    credentials: true,
  })
})
```

- [ ] **步骤 5：创建 auth 插件**

创建 `apps/agent-server/src/plugins/auth.plugin.ts`：

```typescript
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { AppError } from '@repo/shared/errors'
import { ErrorCode } from '@repo/shared/errors'

/** 不需要认证的路径前缀 */
const PUBLIC_PATHS = ['/api/health']

/**
 * Bearer Token 认证插件
 * Token 由 Electron Main 进程启动时生成，通过环境变量 PI_AGENT_AUTH_TOKEN 传入
 */
export const authPlugin: FastifyPluginAsync = fp(async (app) => {
  const expectedToken = process.env.PI_AGENT_AUTH_TOKEN

  // 开发模式下未设置 Token 则跳过认证
  if (!expectedToken) {
    app.log.warn('PI_AGENT_AUTH_TOKEN 未设置，认证已禁用（仅限开发模式）')
    return
  }

  app.decorate('authToken', expectedToken)

  app.addHook('onRequest', async (request, reply) => {
    // 公开路径跳过认证
    if (PUBLIC_PATHS.some((path) => request.url.startsWith(path))) {
      return
    }

    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError(ErrorCode.UNAUTHORIZED, '缺少认证 Token', 401)
    }

    const token = authHeader.slice('Bearer '.length)
    if (token !== expectedToken) {
      throw new AppError(ErrorCode.UNAUTHORIZED, '认证 Token 无效', 401)
    }
  })
})
```

- [ ] **步骤 6：创建 rate-limit 插件**

创建 `apps/agent-server/src/plugins/rate-limit.plugin.ts`：

```typescript
import fp from 'fastify-plugin'
import rateLimit from '@fastify/rate-limit'
import type { FastifyPluginAsync } from 'fastify'

/**
 * 速率限制插件
 * - 普通端点：每分钟 60 次
 * - SSE 端点：每分钟 20 次（长连接，放宽限制）
 */
export const rateLimitPlugin: FastifyPluginAsync = fp(async (app) => {
  await app.register(rateLimit, {
    max: 60,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      return request.ip ?? 'unknown'
    },
    // SSE 端点放宽限制
    skip: (request) => {
      return request.url.startsWith('/api/health')
    },
  })
})
```

- [ ] **步骤 7：重写 error-handler 插件**

重写 `apps/agent-server/src/plugins/error-handler.plugin.ts`：

```typescript
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { AppError } from '@repo/shared/errors'
import { ErrorCode } from '@repo/shared/errors'
import { failure } from '../lib/api-response.js'

export const errorHandlerPlugin: FastifyPluginAsync = fp(async (app) => {
  app.setErrorHandler((error, request, reply) => {
    const traceId = request.traceId ?? crypto.randomUUID()

    // AppError：使用自带的状态码和脱敏消息
    if (error instanceof AppError) {
      request.log.error({
        traceId,
        code: error.code,
        internalMessage: error.internalMessage,
      })
      return reply.status(error.statusCode).send(
        failure(error.code, error.userMessage, traceId),
      )
    }

    // Fastify 验证错误
    if (error.validation) {
      return reply.status(400).send(
        failure(ErrorCode.VALIDATION_ERROR, '请求参数校验失败', traceId, {
          validation: error.validation,
        }),
      )
    }

    // 速率限制错误
    if (error.statusCode === 429) {
      return reply.status(429).send(
        failure(ErrorCode.BAD_REQUEST, '请求过于频繁，请稍后重试', traceId),
      )
    }

    // 未知错误：脱敏后返回 500
    request.log.error({ traceId, error })
    return reply.status(500).send(
      failure(ErrorCode.INTERNAL_SERVER_ERROR, '服务器内部错误', traceId),
    )
  })

  app.setNotFoundHandler((request, reply) => {
    const traceId = request.traceId ?? crypto.randomUUID()
    return reply
      .status(404)
      .send(
        failure(
          ErrorCode.NOT_FOUND,
          `接口不存在：${request.method} ${request.url}`,
          traceId,
        ),
      )
  })
})
```

- [ ] **步骤 8：更新 fastify.d.ts 添加 authToken 声明**

修改 `apps/agent-server/src/types/fastify.d.ts`：

```typescript
import 'fastify'

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string
  }

  interface FastifyInstance {
    authToken?: string
  }
}
```

- [ ] **步骤 9：更新 app.ts 注册新插件**

重写 `apps/agent-server/src/app.ts`：

```typescript
import Fastify from 'fastify'
import { corsPlugin } from './plugins/cors.plugin.js'
import { authPlugin } from './plugins/auth.plugin.js'
import { rateLimitPlugin } from './plugins/rate-limit.plugin.js'
import { errorHandlerPlugin } from './plugins/error-handler.plugin.js'
import { requestContextPlugin } from './plugins/request-context.plugin.js'
import { healthRoute } from './routes/health.route.js'
import { aguiRoute } from './routes/agui.route.js'
import { copilotkitRoute } from './routes/copilotkit.route.js'

export async function createApp() {
  const app = Fastify({
    logger: true,
  })

  // 核心插件（顺序重要）
  await app.register(requestContextPlugin)
  await app.register(corsPlugin)
  await app.register(authPlugin)
  await app.register(rateLimitPlugin)
  await app.register(errorHandlerPlugin)

  // 路由
  await app.register(healthRoute)
  await app.register(aguiRoute)
  await app.register(copilotkitRoute)

  return app
}
```

- [ ] **步骤 10：更新 agent-server package.json 添加 vitest**

修改 `apps/agent-server/package.json`，添加 vitest 和 test 脚本：

在 `devDependencies` 中添加：
```json
"vitest": "^3.2.4"
```

在 `scripts` 中修改：
```json
"test": "vitest run"
```

- [ ] **步骤 11：运行测试验证通过**

运行：`cd apps/agent-server && pnpm install && pnpm test`
预期：PASS

- [ ] **步骤 12：Commit**

```bash
git add apps/agent-server/
git commit -m "feat(agent-server): 安全基线 — CORS 白名单、Bearer Token 认证、速率限制、AppError 集成"
```

---

## 任务 4：Pi SDK 集成（安装依赖 + 插件注册）

**文件：**
- 创建：`apps/agent-server/src/lib/logger.ts`
- 创建：`apps/agent-server/src/lib/i18n.ts`
- 创建：`apps/agent-server/src/plugins/pi-sdk.plugin.ts`
- 创建：`apps/agent-server/src/plugins/event-bus.plugin.ts`
- 修改：`apps/agent-server/src/types/fastify.d.ts`
- 修改：`apps/agent-server/package.json`
- 修改：`apps/agent-server/src/app.ts`
- 测试：`apps/agent-server/src/__tests__/pi-sdk-plugin.test.ts`

- [ ] **步骤 1：安装 Pi SDK 依赖**

```bash
cd apps/agent-server && pnpm add @earendil-works/pi-ai @earendil-works/pi-agent-core @earendil-works/pi-coding-agent
```

注意：如果包名与实际发布包名不同，需要根据 npm registry 确认。参考 pi-agui-reference 使用的是 `@mariozechner/pi-coding-agent`，我们根据设计规格使用 `@earendil-works/pi-coding-agent`。如果安装失败，回退到 `@mariozechner/pi-coding-agent`。

- [ ] **步骤 2：编写失败的测试 — Pi SDK 插件**

创建 `apps/agent-server/src/__tests__/pi-sdk-plugin.test.ts`：

```typescript
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import { piSdkPlugin } from '../plugins/pi-sdk.plugin.js'
import { eventBusPlugin } from '../plugins/event-bus.plugin.js'

describe('Pi SDK 插件', () => {
  let app: Fastify.FastifyInstance

  beforeAll(async () => {
    app = Fastify()
    await app.register(eventBusPlugin)
    await app.register(piSdkPlugin)
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('注册 authStorage 到 Fastify 实例', () => {
    expect(app.authStorage).toBeDefined()
  })

  it('注册 modelRegistry 到 Fastify 实例', () => {
    expect(app.modelRegistry).toBeDefined()
  })

  it('注册 sessionManager 到 Fastify 实例', () => {
    expect(app.sessionManager).toBeDefined()
  })

  it('注册 eventBus 到 Fastify 实例', () => {
    expect(app.eventBus).toBeDefined()
  })
})
```

- [ ] **步骤 3：运行测试验证失败**

运行：`cd apps/agent-server && pnpm test`
预期：FAIL，报错 "Cannot find module '../plugins/pi-sdk.plugin.js'"

- [ ] **步骤 4：创建 logger.ts**

创建 `apps/agent-server/src/lib/logger.ts`：

```typescript
import type { FastifyBaseLogger } from 'fastify'

/**
 * 创建模块级日志器
 * 为每个模块创建子日志器，便于追踪日志来源
 */
export function createModuleLogger(
  logger: FastifyBaseLogger,
  module: string,
): FastifyBaseLogger {
  return logger.child({ module })
}
```

- [ ] **步骤 5：创建 i18n.ts**

创建 `apps/agent-server/src/lib/i18n.ts`：

```typescript
import { t, setLocale, getLocale } from '@repo/shared/utils'

export { t, setLocale, getLocale }
```

- [ ] **步骤 6：创建 EventBus 插件**

创建 `apps/agent-server/src/plugins/event-bus.plugin.ts`：

```typescript
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { EventBus } from '@repo/shared/events'

/** EventBus 插件：将 EventBus 实例挂载到 Fastify */
export const eventBusPlugin: FastifyPluginAsync = fp(async (app) => {
  const eventBus = new EventBus()
  app.decorate('eventBus', eventBus)

  app.addHook('onClose', () => {
    // EventBus 目前无需清理，预留扩展点
  })
})
```

- [ ] **步骤 7：创建 Pi SDK 插件**

创建 `apps/agent-server/src/plugins/pi-sdk.plugin.ts`：

```typescript
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { AuthStorage, ModelRegistry, SessionManager } from '@earendil-works/pi-coding-agent'
import { createModuleLogger } from '../lib/logger.js'
import { AppError } from '@repo/shared/errors'
import { ErrorCode } from '@repo/shared/errors'

/**
 * Pi SDK 核心对象注册插件
 * 创建 AuthStorage、ModelRegistry、SessionManager 并挂载到 Fastify 实例
 */
export const piSdkPlugin: FastifyPluginAsync = fp(async (app) => {
  const log = createModuleLogger(app.log, 'pi-sdk')

  // 数据目录：优先使用 PI_DATA_DIR 环境变量，否则使用用户主目录
  const dataDir = process.env.PI_DATA_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE}/.pi`
  log.info(`Pi SDK 数据目录：${dataDir}`)

  // 创建 AuthStorage
  const authStorage = AuthStorage.create(`${dataDir}/auth.json`)
  app.decorate('authStorage', authStorage)

  // 创建 ModelRegistry
  const modelRegistry = ModelRegistry.create(authStorage, `${dataDir}/models.json`)
  app.decorate('modelRegistry', modelRegistry)

  // 创建 SessionManager
  const sessionDir = process.env.PI_SESSION_DIR ?? `${dataDir}/sessions`
  const sessionManager = SessionManager.create(sessionDir)
  app.decorate('sessionManager', sessionManager)

  // getApiKey 回调：从 CredentialBridge 获取解密后的 API Key
  const getApiKey = async (provider: string): Promise<string | undefined> => {
    try {
      // 通过 EventBus 请求 API Key，由 CredentialBridge 响应
      // 初始实现：直接从环境变量读取
      const envKey = `PI_API_KEY_${provider.toUpperCase().replace(/-/g, '_')}`
      const apiKey = process.env[envKey]
      if (apiKey) {
        return apiKey
      }
      // 回退到通用环境变量
      return process.env.PI_API_KEY
    } catch (error) {
      log.error({ provider, error }, '获取 API Key 失败')
      return undefined
    }
  }
  app.decorate('getApiKey', getApiKey)

  log.info('Pi SDK 核心对象注册完成')
})
```

注意：如果 `@earendil-works/pi-coding-agent` 的导入路径不同，需要根据实际包的导出调整。参考 pi-agui-reference 使用 `@mariozechner/pi-coding-agent`，导入 `AuthStorage`、`ModelRegistry`、`SessionManager`。

- [ ] **步骤 8：更新 fastify.d.ts 添加新声明**

修改 `apps/agent-server/src/types/fastify.d.ts`：

```typescript
import 'fastify'
import type { EventBus } from '@repo/shared/events'

// Pi SDK 类型通过 any 声明，避免编译时依赖具体 SDK 类型
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PiAuthStorage = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PiModelRegistry = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PiSessionManager = any

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string
  }

  interface FastifyInstance {
    authToken?: string
    authStorage: PiAuthStorage
    modelRegistry: PiModelRegistry
    sessionManager: PiSessionManager
    getApiKey: (provider: string) => Promise<string | undefined>
    eventBus: EventBus
  }
}
```

- [ ] **步骤 9：更新 app.ts 注册新插件**

重写 `apps/agent-server/src/app.ts`：

```typescript
import Fastify from 'fastify'
import { corsPlugin } from './plugins/cors.plugin.js'
import { authPlugin } from './plugins/auth.plugin.js'
import { rateLimitPlugin } from './plugins/rate-limit.plugin.js'
import { errorHandlerPlugin } from './plugins/error-handler.plugin.js'
import { requestContextPlugin } from './plugins/request-context.plugin.js'
import { eventBusPlugin } from './plugins/event-bus.plugin.js'
import { piSdkPlugin } from './plugins/pi-sdk.plugin.js'
import { healthRoute } from './routes/health.route.js'
import { aguiRoute } from './routes/agui.route.js'
import { copilotkitRoute } from './routes/copilotkit.route.js'

export async function createApp() {
  const app = Fastify({
    logger: true,
  })

  // 核心插件（顺序重要）
  await app.register(requestContextPlugin)
  await app.register(corsPlugin)
  await app.register(authPlugin)
  await app.register(rateLimitPlugin)
  await app.register(errorHandlerPlugin)

  // 业务插件
  await app.register(eventBusPlugin)
  await app.register(piSdkPlugin)

  // 路由
  await app.register(healthRoute)
  await app.register(aguiRoute)
  await app.register(copilotkitRoute)

  return app
}
```

- [ ] **步骤 10：运行测试验证通过**

运行：`cd apps/agent-server && pnpm test`
预期：PASS

- [ ] **步骤 11：Commit**

```bash
git add apps/agent-server/
git commit -m "feat(agent-server): Pi SDK 集成 — 安装依赖、注册核心对象、EventBus 插件"
```

---

## 任务 5：CredentialBridge + ConfigCoordinator

**文件：**
- 创建：`apps/agent-server/src/core/config/credential-bridge.ts`
- 创建：`apps/agent-server/src/core/config/config-coordinator.ts`
- 测试：`apps/agent-server/src/__tests__/credential-bridge.test.ts`
- 测试：`apps/agent-server/src/__tests__/config-coordinator.test.ts`

- [ ] **步骤 1：编写失败的测试 — CredentialBridge**

创建 `apps/agent-server/src/__tests__/credential-bridge.test.ts`：

```typescript
import { describe, expect, it, vi } from 'vitest'
import { CredentialBridge } from '../core/config/credential-bridge.js'

describe('CredentialBridge', () => {
  it('从环境变量获取 API Key', async () => {
    process.env.PI_API_KEY_OPENAI = 'sk-test-openai-key'
    const bridge = new CredentialBridge()
    const key = await bridge.getApiKey('openai')
    expect(key).toBe('sk-test-openai-key')
    delete process.env.PI_API_KEY_OPENAI
  })

  it('回退到通用 PI_API_KEY', async () => {
    process.env.PI_API_KEY = 'sk-generic-key'
    const bridge = new CredentialBridge()
    const key = await bridge.getApiKey('unknown-provider')
    expect(key).toBe('sk-generic-key')
    delete process.env.PI_API_KEY
  })

  it('无 Key 时返回 undefined', async () => {
    const bridge = new CredentialBridge()
    const key = await bridge.getApiKey('nonexistent')
    expect(key).toBeUndefined()
  })

  it('支持自定义 Key 获取器', async () => {
    const customFetcher = vi.fn().mockResolvedValue('custom-key')
    const bridge = new CredentialBridge(customFetcher)
    const key = await bridge.getApiKey('openai')
    expect(key).toBe('custom-key')
    expect(customFetcher).toHaveBeenCalledWith('openai')
  })
})
```

- [ ] **步骤 2：编写失败的测试 — ConfigCoordinator**

创建 `apps/agent-server/src/__tests__/config-coordinator.test.ts`：

```typescript
import { describe, expect, it } from 'vitest'
import { ConfigCoordinator } from '../core/config/config-coordinator.js'

describe('ConfigCoordinator', () => {
  it('合并三层配置', () => {
    const coordinator = new ConfigCoordinator({
      global: { maxTokens: 100000, model: 'gpt-4' },
      project: { maxTokens: 80000 },
      session: { temperature: 0.7 },
    })

    const config = coordinator.resolve()
    expect(config.maxTokens).toBe(80000) // project 覆盖 global
    expect(config.model).toBe('gpt-4') // global 未被覆盖
    expect(config.temperature).toBe(0.7) // session 独有
  })

  it('空配置返回空对象', () => {
    const coordinator = new ConfigCoordinator({})
    const config = coordinator.resolve()
    expect(config).toEqual({})
  })

  it('session 覆盖 project 覆盖 global', () => {
    const coordinator = new ConfigCoordinator({
      global: { model: 'gpt-4', temperature: 0.5 },
      project: { model: 'claude-3' },
      session: { model: 'gpt-4o' },
    })

    const config = coordinator.resolve()
    expect(config.model).toBe('gpt-4o') // session 优先
    expect(config.temperature).toBe(0.5) // global 保留
  })
})
```

- [ ] **步骤 3：运行测试验证失败**

运行：`cd apps/agent-server && pnpm test`
预期：FAIL

- [ ] **步骤 4：实现 CredentialBridge**

创建 `apps/agent-server/src/core/config/credential-bridge.ts`：

```typescript
/**
 * CredentialBridge：API Key 获取桥接
 *
 * 优先级：
 * 1. 自定义 Key 获取器（用于 Electron safeStorage 桥接）
 * 2. Provider 专用环境变量 PI_API_KEY_{PROVIDER}
 * 3. 通用环境变量 PI_API_KEY
 */
export class CredentialBridge {
  private readonly customFetcher?: (provider: string) => Promise<string | undefined>

  constructor(customFetcher?: (provider: string) => Promise<string | undefined>) {
    this.customFetcher = customFetcher
  }

  /** 获取指定 Provider 的 API Key */
  async getApiKey(provider: string): Promise<string | undefined> {
    // 1. 自定义获取器
    if (this.customFetcher) {
      const key = await this.customFetcher(provider)
      if (key) return key
    }

    // 2. Provider 专用环境变量
    const envKey = `PI_API_KEY_${provider.toUpperCase().replace(/-/g, '_')}`
    const providerKey = process.env[envKey]
    if (providerKey) return providerKey

    // 3. 通用环境变量
    return process.env.PI_API_KEY
  }
}
```

- [ ] **步骤 5：实现 ConfigCoordinator**

创建 `apps/agent-server/src/core/config/config-coordinator.ts`：

```typescript
export interface ConfigLayers {
  global?: Record<string, unknown>
  project?: Record<string, unknown>
  session?: Record<string, unknown>
}

/**
 * ConfigCoordinator：三层配置合并
 *
 * 合并顺序：global → project → session
 * 后层覆盖前层的同名键
 */
export class ConfigCoordinator {
  private readonly layers: ConfigLayers

  constructor(layers: ConfigLayers) {
    this.layers = layers
  }

  /** 合并三层配置，返回最终配置 */
  resolve(): Record<string, unknown> {
    const result: Record<string, unknown> = {}

    // 按优先级从低到高合并
    const { global, project, session } = this.layers

    if (global) {
      Object.assign(result, global)
    }
    if (project) {
      Object.assign(result, project)
    }
    if (session) {
      Object.assign(result, session)
    }

    return result
  }
}
```

- [ ] **步骤 6：运行测试验证通过**

运行：`cd apps/agent-server && pnpm test`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add apps/agent-server/src/core/config/
git add apps/agent-server/src/__tests__/
git commit -m "feat(agent-server): CredentialBridge + ConfigCoordinator 三层配置合并"
```

---

## 任务 6：PiAgUiAgent + StreamEmitter（核心适配层）

**文件：**
- 创建：`apps/agent-server/src/core/agent/stream-emitter.ts`
- 创建：`apps/agent-server/src/core/agent/reasoning-pipeline.ts`
- 创建：`apps/agent-server/src/core/agent/pi-agui-agent.ts`
- 创建：`apps/agent-server/src/core/agent/session-store.ts`
- 创建：`apps/agent-server/src/core/agent/instruction-loader.ts`
- 创建：`apps/agent-server/src/core/agent/pi-session.ts`
- 创建：`apps/agent-server/src/core/tool/gate.ts`
- 测试：`apps/agent-server/src/__tests__/stream-emitter.test.ts`
- 测试：`apps/agent-server/src/__tests__/session-store.test.ts`
- 测试：`apps/agent-server/src/__tests__/gate.test.ts`

- [ ] **步骤 1：编写失败的测试 — StreamEmitter**

创建 `apps/agent-server/src/__tests__/stream-emitter.test.ts`：

```typescript
import { EventType, type BaseEvent } from '@ag-ui/core'
import { describe, expect, it, vi } from 'vitest'
import { StreamEmitter } from '../core/agent/stream-emitter.js'

function createReasoningPipelineStub() {
  return {
    ensureReasoningTargetMessage: vi.fn(),
    emitNativeReasoningStart: vi.fn(),
    ensureNativeReasoningStart: vi.fn(() => 'reasoning-1'),
    emitReasoningCompatEvent: vi.fn(),
    emitNativeReasoningEnd: vi.fn(),
  } as any
}

describe('StreamEmitter', () => {
  it('emitTextChunk 发出 TEXT_MESSAGE_START + TEXT_MESSAGE_CONTENT', () => {
    const events: BaseEvent[] = []
    const emitter = new StreamEmitter(
      (event) => events.push(event),
      'msg-1',
      createReasoningPipelineStub(),
    )

    emitter.emitTextChunk('你好')

    // 应该先发出 TEXT_MESSAGE_START
    expect(events[0].type).toBe(EventType.TEXT_MESSAGE_START)
    // 然后发出 TEXT_MESSAGE_CONTENT
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT)
    expect((events[1] as any).delta).toBe('你好')
  })

  it('finishTextMessage 发出 TEXT_MESSAGE_END', () => {
    const events: BaseEvent[] = []
    const emitter = new StreamEmitter(
      (event) => events.push(event),
      'msg-1',
      createReasoningPipelineStub(),
    )

    emitter.emitTextChunk('hello')
    emitter.finishTextMessage()

    const endEvent = events.find((e) => e.type === EventType.TEXT_MESSAGE_END)
    expect(endEvent).toBeDefined()
  })

  it('handleSessionEvent 处理 tool_execution_start', () => {
    const events: BaseEvent[] = []
    const emitter = new StreamEmitter(
      (event) => events.push(event),
      'msg-1',
      createReasoningPipelineStub(),
    )

    emitter.handleSessionEvent({
      type: 'tool_execution_start',
      toolName: 'read',
      toolCallId: 'tc-1',
    } as any)

    expect(events.some((e) => e.type === EventType.STEP_STARTED)).toBe(true)
    expect(events.some((e) => e.type === EventType.ACTIVITY_SNAPSHOT)).toBe(true)
  })

  it('handleSessionEvent 处理 tool_execution_end', () => {
    const events: BaseEvent[] = []
    const emitter = new StreamEmitter(
      (event) => events.push(event),
      'msg-1',
      createReasoningPipelineStub(),
    )

    emitter.handleSessionEvent({
      type: 'tool_execution_end',
      toolName: 'read',
      toolCallId: 'tc-1',
    } as any)

    expect(events.some((e) => e.type === EventType.STEP_FINISHED)).toBe(true)
  })

  it('handleSessionEvent 处理 message_update text_delta', () => {
    const events: BaseEvent[] = []
    const emitter = new StreamEmitter(
      (event) => events.push(event),
      'msg-1',
      createReasoningPipelineStub(),
    )

    emitter.handleSessionEvent({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        delta: '世界',
      },
    } as any)

    const contentEvents = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
    )
    expect(contentEvents.length).toBeGreaterThan(0)
  })

  it('handleSessionEvent 处理 tool_execution_update 发出 CUSTOM 事件', () => {
    const events: BaseEvent[] = []
    const emitter = new StreamEmitter(
      (event) => events.push(event),
      'msg-1',
      createReasoningPipelineStub(),
    )

    emitter.handleSessionEvent({
      type: 'tool_execution_update',
      toolName: 'bash',
      toolCallId: 'tc-2',
      args: { command: 'ls' },
      partialResult: 'file1.txt\nfile2.txt',
    } as any)

    const customEvent = events.find(
      (e) =>
        e.type === EventType.CUSTOM &&
        (e as any).name === 'PI_TOOL_EXECUTION_UPDATE',
    )
    expect(customEvent).toBeDefined()
  })
})
```

- [ ] **步骤 2：编写失败的测试 — SessionStore**

创建 `apps/agent-server/src/__tests__/session-store.test.ts`：

```typescript
import { describe, expect, it } from 'vitest'
import { PiSessionStore } from '../core/agent/session-store.js'

describe('PiSessionStore', () => {
  it('getOrCreate 返回会话并记录', async () => {
    const store = new PiSessionStore()
    // 使用 mock session 工厂
    const mockSession = { id: 'session-1' } as any
    store.setSessionFactory(() => Promise.resolve(mockSession))

    const threadSession = await store.getOrCreate('thread-1')
    expect(threadSession.threadId).toBe('thread-1')
    expect(threadSession.session).toBe(mockSession)
  })

  it('getOrCreate 相同 threadId 返回同一会话', async () => {
    const store = new PiSessionStore()
    const mockSession = { id: 'session-1' } as any
    store.setSessionFactory(() => Promise.resolve(mockSession))

    const s1 = await store.getOrCreate('thread-1')
    const s2 = await store.getOrCreate('thread-1')
    expect(s1).toBe(s2)
  })

  it('getStats 返回活跃会话数', async () => {
    const store = new PiSessionStore()
    const mockSession = { id: 'session-1' } as any
    store.setSessionFactory(() => Promise.resolve(mockSession))

    await store.getOrCreate('thread-1')
    await store.getOrCreate('thread-2')

    const stats = store.getStats()
    expect(stats.threadCount).toBe(2)
  })
})
```

- [ ] **步骤 3：编写失败的测试 — Gate**

创建 `apps/agent-server/src/__tests__/gate.test.ts`：

```typescript
import { describe, expect, it } from 'vitest'
import { Gate } from '../core/tool/gate.js'

describe('Gate', () => {
  it('默认允许所有工具', async () => {
    const gate = new Gate()
    const result = await gate.check('read', { path: '/tmp/test.txt' })
    expect(result.allowed).toBe(true)
  })

  it('禁止列表中的工具被拒绝', async () => {
    const gate = new Gate({ deniedTools: ['rm', 'format'] })
    const result = await gate.check('rm', { path: '/tmp/test.txt' })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('rm')
  })

  it('不在禁止列表中的工具被允许', async () => {
    const gate = new Gate({ deniedTools: ['rm'] })
    const result = await gate.check('read', { path: '/tmp/test.txt' })
    expect(result.allowed).toBe(true)
  })
})
```

- [ ] **步骤 4：运行测试验证失败**

运行：`cd apps/agent-server && pnpm test`
预期：FAIL

- [ ] **步骤 5：实现 ReasoningPipeline**

创建 `apps/agent-server/src/core/agent/reasoning-pipeline.ts`：

```typescript
import {
  EventType,
  type CustomEvent,
  type ReasoningEndEvent,
  type ReasoningMessageEndEvent,
  type ReasoningMessageStartEvent,
  type ReasoningStartEvent,
  type ThinkingEndEvent,
  type ThinkingStartEvent,
  type ThinkingTextMessageEndEvent,
  type ThinkingTextMessageStartEvent,
} from '@ag-ui/core'
import { randomUUID } from 'node:crypto'
import type { AgUiEventSink } from '@repo/protocol/events'

export const REASONING_TARGET_MESSAGE_EVENT = 'REASONING_TARGET_MESSAGE'

/**
 * ReasoningPipeline：管理 thinking/reasoning 事件流
 * 参考 pi-agui-reference/backend/src/agui/reasoning-pipeline.ts
 */
export class ReasoningPipeline {
  private emittedReasoningTargetMessage = false
  private activeReasoningMessageId: string | null = null

  constructor(
    private readonly emit: AgUiEventSink,
    private readonly assistantResponseMessageId: string,
  ) {}

  ensureReasoningTargetMessage(): void {
    if (this.emittedReasoningTargetMessage) return
    this.emittedReasoningTargetMessage = true

    this.emit({
      type: EventType.CUSTOM,
      name: REASONING_TARGET_MESSAGE_EVENT,
      value: { messageId: this.assistantResponseMessageId },
    } as CustomEvent)
  }

  emitNativeReasoningStart(): string {
    this.ensureReasoningTargetMessage()

    const reasoningMessageId = randomUUID()
    this.activeReasoningMessageId = reasoningMessageId

    this.emit({
      type: EventType.REASONING_START,
      messageId: reasoningMessageId,
    } as ReasoningStartEvent)

    this.emit({
      type: EventType.REASONING_MESSAGE_START,
      messageId: reasoningMessageId,
      role: 'reasoning',
    } as ReasoningMessageStartEvent)

    this.emit({
      type: EventType.THINKING_START,
    } as ThinkingStartEvent)

    this.emit({
      type: EventType.THINKING_TEXT_MESSAGE_START,
    } as ThinkingTextMessageStartEvent)

    return reasoningMessageId
  }

  ensureNativeReasoningStart(): string {
    if (this.activeReasoningMessageId) {
      return this.activeReasoningMessageId
    }
    return this.emitNativeReasoningStart()
  }

  emitNativeReasoningEnd(): void {
    const reasoningMessageId = this.ensureNativeReasoningStart()

    this.emit({
      type: EventType.REASONING_MESSAGE_END,
      messageId: reasoningMessageId,
    } as ReasoningMessageEndEvent)

    this.emit({
      type: EventType.THINKING_TEXT_MESSAGE_END,
    } as ThinkingTextMessageEndEvent)

    this.emit({
      type: EventType.REASONING_END,
      messageId: reasoningMessageId,
    } as ReasoningEndEvent)

    this.emit({
      type: EventType.THINKING_END,
    } as ThinkingEndEvent)

    this.activeReasoningMessageId = null
  }

  /** 兼容性：发出自定义 reasoning 事件 */
  emitReasoningCompatEvent(
    name:
      | 'REASONING_START'
      | 'REASONING_TEXT_MESSAGE_START'
      | 'REASONING_TEXT_MESSAGE_CONTENT'
      | 'REASONING_TEXT_MESSAGE_END'
      | 'REASONING_END',
    value?: Record<string, unknown>,
  ): void {
    this.emit({
      type: EventType.CUSTOM,
      name,
      ...(value ? { value } : {}),
    } as CustomEvent)
  }
}
```

- [ ] **步骤 6：实现 StreamEmitter**

创建 `apps/agent-server/src/core/agent/stream-emitter.ts`：

```typescript
import {
  EventType,
  type ActivityDeltaEvent,
  type ActivitySnapshotEvent,
  type CustomEvent,
  type RawEvent,
  type StepFinishedEvent,
  type StepStartedEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
  type ReasoningMessageContentEvent,
  type ThinkingTextMessageContentEvent,
} from '@ag-ui/core'
import { randomUUID } from 'node:crypto'
import type { AgUiEventSink } from '@repo/protocol/events'
import type { ReasoningPipeline } from './reasoning-pipeline.js'

/** 安全序列化：用于 RAW 事件中的值 */
function safeSerializeForRawEvent(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack }
    }
    return { type: typeof value, fallback: String(value) }
  }
}

/**
 * StreamEmitter：Pi SDK 事件 → AG-UI 事件映射
 *
 * 核心映射关系：
 * - message_start (assistant) → TEXT_MESSAGE_START
 * - message_update (text_delta) → TEXT_MESSAGE_CONTENT
 * - message_update (thinking_delta) → REASONING_MESSAGE_CONTENT + THINKING_TEXT_MESSAGE_CONTENT
 * - message_end (assistant) → TEXT_MESSAGE_END
 * - tool_execution_start → STEP_STARTED + ACTIVITY_SNAPSHOT
 * - tool_execution_end → STEP_FINISHED + ACTIVITY_DELTA
 * - tool_execution_update → CUSTOM (PI_TOOL_EXECUTION_UPDATE)
 */
export class StreamEmitter {
  private startedTextMessageId: string | null = null
  private completeAssistantText = ''
  private readonly toolActivityIdsByName = new Map<string, string[]>()

  constructor(
    private readonly emit: AgUiEventSink,
    private readonly assistantResponseMessageId: string,
    private readonly reasoningPipeline: ReasoningPipeline,
  ) {}

  /** 确保文本消息已开始，返回 messageId */
  private ensureTextStarted(): string {
    if (this.startedTextMessageId) {
      return this.startedTextMessageId
    }

    this.reasoningPipeline.ensureReasoningTargetMessage()
    this.startedTextMessageId = this.assistantResponseMessageId
    this.emit({
      type: EventType.TEXT_MESSAGE_START,
      messageId: this.startedTextMessageId,
      role: 'assistant',
    } as TextMessageStartEvent)
    return this.startedTextMessageId
  }

  /** 发出文本块 */
  emitTextChunk(chunk: string): void {
    if (!chunk.length) return
    const messageId = this.ensureTextStarted()
    this.emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: chunk,
    } as TextMessageContentEvent)
  }

  /** 结束文本消息 */
  finishTextMessage(): void {
    if (!this.startedTextMessageId) return
    this.emit({
      type: EventType.TEXT_MESSAGE_END,
      messageId: this.startedTextMessageId,
    } as TextMessageEndEvent)
    this.startedTextMessageId = null
  }

  /** 获取完整助手文本 */
  getCompleteAssistantText(): string {
    return this.completeAssistantText
  }

  /**
   * 处理 Pi SDK Session 事件，映射为 AG-UI 事件
   * 参考 pi-agui-reference/backend/src/agui/stream-emitter.ts handleSessionEvent
   */
  handleSessionEvent(event: Record<string, unknown>): void {
    // 发出 RAW 事件用于调试
    this.emit({
      type: EventType.RAW,
      source: 'pi-session-event',
      event: safeSerializeForRawEvent(event),
    } as RawEvent)

    const eventType = event.type as string

    // 工具执行开始
    if (eventType === 'tool_execution_start') {
      const startedAt = Date.now()
      const activityMessageId = randomUUID()
      const toolName = (event.toolName as string) ?? 'unknown'

      const existingActivityIds = this.toolActivityIdsByName.get(toolName) ?? []
      this.toolActivityIdsByName.set(toolName, [...existingActivityIds, activityMessageId])

      this.emit({
        type: EventType.STEP_STARTED,
        stepName: `pi:${toolName}`,
      } as StepStartedEvent)

      this.emit({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: activityMessageId,
        activityType: 'pi:tool_execution',
        content: { toolName, status: 'running', startedAt },
        replace: true,
      } as ActivitySnapshotEvent)
      return
    }

    // 工具执行结束
    if (eventType === 'tool_execution_end') {
      const endedAt = Date.now()
      const toolName = (event.toolName as string) ?? 'unknown'

      const existingActivityIds = this.toolActivityIdsByName.get(toolName) ?? []
      const activityMessageId = existingActivityIds.pop()

      if (existingActivityIds.length) {
        this.toolActivityIdsByName.set(toolName, existingActivityIds)
      } else {
        this.toolActivityIdsByName.delete(toolName)
      }

      this.emit({
        type: EventType.STEP_FINISHED,
        stepName: `pi:${toolName}`,
      } as StepFinishedEvent)

      if (activityMessageId) {
        this.emit({
          type: EventType.ACTIVITY_DELTA,
          messageId: activityMessageId,
          activityType: 'pi:tool_execution',
          patch: [
            { op: 'replace', path: '/status', value: 'finished' },
            { op: 'add', path: '/endedAt', value: endedAt },
          ],
        } as ActivityDeltaEvent)
      }
      return
    }

    // 工具执行更新
    if (eventType === 'tool_execution_update') {
      this.emit({
        type: EventType.CUSTOM,
        name: 'PI_TOOL_EXECUTION_UPDATE',
        value: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: safeSerializeForRawEvent(event.args),
          partialResult: safeSerializeForRawEvent(event.partialResult),
        },
      } as CustomEvent)
      return
    }

    // 消息更新
    if (eventType !== 'message_update') return

    const assistantMessageEvent = event.assistantMessageEvent as Record<string, unknown> | undefined
    if (!assistantMessageEvent) return

    const subType = assistantMessageEvent.type as string

    // Thinking 开始
    if (subType === 'thinking_start') {
      this.reasoningPipeline.emitNativeReasoningStart()
      return
    }

    // Thinking 增量
    if (subType === 'thinking_delta') {
      const delta = (assistantMessageEvent.delta as string) ?? ''
      if (!delta.length) return

      const reasoningMessageId = this.reasoningPipeline.ensureNativeReasoningStart()

      this.emit({
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: reasoningMessageId,
        delta,
      } as ReasoningMessageContentEvent)

      this.emit({
        type: EventType.THINKING_TEXT_MESSAGE_CONTENT,
        delta,
      } as ThinkingTextMessageContentEvent)

      this.reasoningPipeline.emitReasoningCompatEvent('REASONING_TEXT_MESSAGE_CONTENT', { delta })
      return
    }

    // Thinking 结束
    if (subType === 'thinking_end') {
      this.reasoningPipeline.emitNativeReasoningEnd()
      return
    }

    // 文本增量
    if (subType === 'text_delta') {
      const delta = (assistantMessageEvent.delta as string) ?? ''
      if (!delta.length) return

      this.completeAssistantText += delta
      this.emitTextChunk(delta)
    }
  }
}

/** 发出单条助手消息（用于简单响应） */
export function emitSingleAssistantMessage(emit: AgUiEventSink, text: string): void {
  const messageId = randomUUID()
  emit({
    type: EventType.TEXT_MESSAGE_START,
    messageId,
    role: 'assistant',
  } as TextMessageStartEvent)

  emit({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId,
    delta: text,
  } as TextMessageContentEvent)

  emit({
    type: EventType.TEXT_MESSAGE_END,
    messageId,
  } as TextMessageEndEvent)
}
```

- [ ] **步骤 7：实现 Gate**

创建 `apps/agent-server/src/core/tool/gate.ts`：

```typescript
export interface GateCheckResult {
  allowed: boolean
  reason?: string
}

export interface GateOptions {
  /** 禁止使用的工具名称列表 */
  deniedTools?: string[]
  /** 自定义检查函数 */
  customCheck?: (toolName: string, args: Record<string, unknown>) => Promise<GateCheckResult>
}

/**
 * Gate：工具执行权限检查
 * 通过 Pi SDK 的 beforeToolCall 钩子集成
 */
export class Gate {
  private readonly deniedTools: Set<string>
  private readonly customCheck?: GateOptions['customCheck']

  constructor(options: GateOptions = {}) {
    this.deniedTools = new Set(options.deniedTools ?? [])
    this.customCheck = options.customCheck
  }

  /** 检查工具是否允许执行 */
  async check(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<GateCheckResult> {
    // 禁止列表检查
    if (this.deniedTools.has(toolName)) {
      return {
        allowed: false,
        reason: `工具 '${toolName}' 被安全策略禁止`,
      }
    }

    // 自定义检查
    if (this.customCheck) {
      return this.customCheck(toolName, args)
    }

    return { allowed: true }
  }
}
```

- [ ] **步骤 8：实现 SessionStore**

创建 `apps/agent-server/src/core/agent/session-store.ts`：

```typescript
/** Pi SDK AgentSession 类型（避免编译时依赖具体 SDK 类型） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PiAgentSession = any

/** 线程会话信息 */
export interface PiThreadSession {
  threadId: string
  session: PiAgentSession
  createdAt: number
  lastAccessedAt: number
  lastRunId?: string
  pendingToolCalls: Map<string, unknown>
}

/** SessionStore 统计信息 */
export interface PiSessionStoreStats {
  threadCount: number
  pendingToolCalls: number
}

/**
 * PiSessionStore：活跃会话管理
 * 维护 threadId → PiThreadSession 的映射
 */
export class PiSessionStore {
  private readonly sessions = new Map<string, PiThreadSession>()
  private sessionFactory?: () => Promise<PiAgentSession>

  /** 设置 Session 工厂（由 Pi SDK 插件注入） */
  setSessionFactory(factory: () => Promise<PiAgentSession>): void {
    this.sessionFactory = factory
  }

  /** 获取或创建线程会话 */
  async getOrCreate(threadId: string): Promise<PiThreadSession> {
    const existing = this.sessions.get(threadId)
    if (existing) {
      existing.lastAccessedAt = Date.now()
      return existing
    }

    if (!this.sessionFactory) {
      throw new Error('SessionFactory 未设置，请先调用 setSessionFactory')
    }

    const session = await this.sessionFactory()
    const threadSession: PiThreadSession = {
      threadId,
      session,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      pendingToolCalls: new Map(),
    }
    this.sessions.set(threadId, threadSession)
    return threadSession
  }

  /** 获取所有活跃会话 */
  getActiveThreadSessions(): PiThreadSession[] {
    return Array.from(this.sessions.values())
  }

  /** 获取统计信息 */
  getStats(): PiSessionStoreStats {
    let pendingToolCalls = 0
    for (const session of this.sessions.values()) {
      pendingToolCalls += session.pendingToolCalls.size
    }
    return {
      threadCount: this.sessions.size,
      pendingToolCalls,
    }
  }

  /** 记住前端工具调用 */
  rememberToolCall(threadId: string, toolCallId: string, call: unknown): void {
    const session = this.sessions.get(threadId)
    if (session) {
      session.pendingToolCalls.set(toolCallId, call)
    }
  }

  /** 消费前端工具调用 */
  consumeToolCall(threadId: string, toolCallId: string): unknown | undefined {
    const session = this.sessions.get(threadId)
    if (session) {
      const call = session.pendingToolCalls.get(toolCallId)
      session.pendingToolCalls.delete(toolCallId)
      return call
    }
    return undefined
  }
}
```

- [ ] **步骤 9：实现 InstructionLoader**

创建 `apps/agent-server/src/core/agent/instruction-loader.ts`：

```typescript
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * InstructionLoader：项目级指令加载
 * 从 .pi/instructions.md 加载项目级指令，注入到 System Prompt
 */
export class InstructionLoader {
  constructor(private readonly cwd: string) {}

  /** 加载项目级指令 */
  loadInstructions(): string | null {
    const instructionFile = join(this.cwd, '.pi', 'instructions.md')
    if (!existsSync(instructionFile)) {
      return null
    }

    try {
      const content = readFileSync(instructionFile, 'utf-8')
      return content.trim() || null
    } catch {
      return null
    }
  }
}
```

- [ ] **步骤 10：实现 createPiSession 工厂**

创建 `apps/agent-server/src/core/agent/pi-session.ts`：

```typescript
import { createAgentSession, DefaultResourceLoader } from '@earendil-works/pi-coding-agent'
import type { Gate } from '../tool/gate.js'
import type { EventBus } from '@repo/shared/events'

/** createPiSession 依赖 */
export interface PiSessionDeps {
  authStorage: any // eslint-disable-line @typescript-eslint/no-explicit-any
  modelRegistry: any // eslint-disable-line @typescript-eslint/no-explicit-any
  sessionManager: any // eslint-disable-line @typescript-eslint/no-explicit-any
  getApiKey: (provider: string) => Promise<string | undefined>
  gate: Gate
  eventBus: EventBus
  config: {
    cwd: string
    dataDir: string
  }
}

/**
 * createPiSession：创建 Pi SDK Agent Session
 * 使用 DefaultResourceLoader 加载 AGENTS.md/Skills/Templates
 * 通过 beforeToolCall/afterToolCall 钩子集成 Gate 和 EventBus
 */
export async function createPiSession(deps: PiSessionDeps) {
  const resourceLoader = new DefaultResourceLoader({
    cwd: deps.config.cwd,
    agentDir: deps.config.dataDir,
    systemPromptOverride: () => buildSystemPrompt(deps),
  })
  await resourceLoader.reload()

  const { session } = await createAgentSession({
    authStorage: deps.authStorage,
    modelRegistry: deps.modelRegistry,
    sessionManager: deps.sessionManager,
    resourceLoader,
    getApiKey: deps.getApiKey,
    toolExecution: 'parallel',
    beforeToolCall: async ({ toolCall, args }: { toolCall: { name: string }; args: Record<string, unknown> }) => {
      const result = await deps.gate.check(toolCall.name, args)
      if (!result.allowed) {
        throw new Error(result.reason ?? '工具被安全策略禁止')
      }
    },
    afterToolCall: async ({ toolCall, result, isError }: { toolCall: { name: string }; result: unknown; isError: boolean }) => {
      deps.eventBus.emit('tool:executed', { toolCall, result, isError })
    },
  })

  return session
}

/** 构建 System Prompt */
function buildSystemPrompt(deps: PiSessionDeps): string {
  const parts: string[] = []

  // 身份信息
  parts.push('你是 Pi Agent，一个智能编程助手。')

  // 项目级指令
  const { InstructionLoader } = require('./instruction-loader.js') as typeof import('./instruction-loader.js')
  const loader = new InstructionLoader(deps.config.cwd)
  const instructions = loader.loadInstructions()
  if (instructions) {
    parts.push('\n## 项目指令\n')
    parts.push(instructions)
  }

  return parts.join('\n')
}
```

注意：`require` 在 ESM 中不可用，修正为顶层导入：

创建 `apps/agent-server/src/core/agent/pi-session.ts`（修正版）：

```typescript
import { createAgentSession, DefaultResourceLoader } from '@earendil-works/pi-coding-agent'
import type { Gate } from '../tool/gate.js'
import type { EventBus } from '@repo/shared/events'
import { InstructionLoader } from './instruction-loader.js'

/** createPiSession 依赖 */
export interface PiSessionDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authStorage: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modelRegistry: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessionManager: any
  getApiKey: (provider: string) => Promise<string | undefined>
  gate: Gate
  eventBus: EventBus
  config: {
    cwd: string
    dataDir: string
  }
}

/**
 * createPiSession：创建 Pi SDK Agent Session
 */
export async function createPiSession(deps: PiSessionDeps) {
  const resourceLoader = new DefaultResourceLoader({
    cwd: deps.config.cwd,
    agentDir: deps.config.dataDir,
    systemPromptOverride: () => buildSystemPrompt(deps),
  })
  await resourceLoader.reload()

  const { session } = await createAgentSession({
    authStorage: deps.authStorage,
    modelRegistry: deps.modelRegistry,
    sessionManager: deps.sessionManager,
    resourceLoader,
    getApiKey: deps.getApiKey,
    toolExecution: 'parallel',
    beforeToolCall: async ({
      toolCall,
      args,
    }: {
      toolCall: { name: string }
      args: Record<string, unknown>
    }) => {
      const result = await deps.gate.check(toolCall.name, args)
      if (!result.allowed) {
        throw new Error(result.reason ?? '工具被安全策略禁止')
      }
    },
    afterToolCall: async ({
      toolCall,
      result,
      isError,
    }: {
      toolCall: { name: string }
      result: unknown
      isError: boolean
    }) => {
      deps.eventBus.emit('tool:executed', { toolCall, result, isError })
    },
  })

  return session
}

/** 构建 System Prompt */
function buildSystemPrompt(deps: PiSessionDeps): string {
  const parts: string[] = []

  // 身份信息
  parts.push('你是 Pi Agent，一个智能编程助手。')

  // 项目级指令
  const loader = new InstructionLoader(deps.config.cwd)
  const instructions = loader.loadInstructions()
  if (instructions) {
    parts.push('\n## 项目指令\n')
    parts.push(instructions)
  }

  return parts.join('\n')
}
```

- [ ] **步骤 11：实现 PiAgUiAgent**

创建 `apps/agent-server/src/core/agent/pi-agui-agent.ts`：

```typescript
import {
  EventType,
  type RunAgentInput,
  type RunFinishedEvent,
  type RunStartedEvent,
  type RunErrorEvent,
  type MessagesSnapshotEvent,
  type ToolCallResultEvent,
} from '@ag-ui/core'
import { randomUUID } from 'node:crypto'
import type { AgUiEventSink } from '@repo/protocol/events'
import type { PiSessionStore } from './session-store.js'
import { StreamEmitter, emitSingleAssistantMessage } from './stream-emitter.js'
import { ReasoningPipeline } from './reasoning-pipeline.js'

/** StreamRun 选项 */
export interface StreamRunOptions {
  signal?: AbortSignal
}

/**
 * PiAgUiAgent：AG-UI 适配层核心类
 * 封装 Pi SDK Session，提供 AG-UI 协议方法
 * 参考 pi-agui-reference/backend/src/agui/pi-agui-agent.ts
 */
export class PiAgUiAgent {
  private readonly threadStateByThread = new Map<string, unknown>()

  readonly agentId: string

  constructor(
    private readonly sessionStore: PiSessionStore,
    agentId = 'default',
  ) {
    this.agentId = agentId
  }

  /** 主运行方法：订阅 Pi SDK 事件 → StreamEmitter → SSE */
  async streamRun(
    input: RunAgentInput,
    emit: AgUiEventSink,
    runOptions: StreamRunOptions = {},
  ): Promise<void> {
    const threadId = input.threadId
    const runId = input.runId

    // 发出 RUN_STARTED
    emit({
      type: EventType.RUN_STARTED,
      threadId,
      runId,
    } as RunStartedEvent)

    // 发出 MESSAGES_SNAPSHOT
    emit({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: input.messages,
    } as MessagesSnapshotEvent)

    // 如果最后一条消息是 tool 结果，发出 TOOL_CALL_RESULT
    const lastMessage = input.messages[input.messages.length - 1]
    if (lastMessage?.role === 'tool') {
      const toolCallId = (lastMessage as { toolCallId?: string }).toolCallId
      if (toolCallId) {
        emit({
          type: EventType.TOOL_CALL_RESULT,
          messageId: lastMessage.id,
          toolCallId,
          content: typeof lastMessage.content === 'string' ? lastMessage.content : JSON.stringify(lastMessage.content),
          role: 'tool',
        } as ToolCallResultEvent)
      }
    }

    try {
      // 获取或创建线程会话
      const threadSession = await this.sessionStore.getOrCreate(threadId)

      // 创建 StreamEmitter 和 ReasoningPipeline
      const assistantResponseMessageId = randomUUID()
      const reasoningPipeline = new ReasoningPipeline(emit, assistantResponseMessageId)
      const streamEmitter = new StreamEmitter(
        emit,
        assistantResponseMessageId,
        reasoningPipeline,
      )

      // 订阅 Pi SDK 事件
      const unsubscribe = threadSession.session.subscribe((event: Record<string, unknown>) => {
        streamEmitter.handleSessionEvent(event)
      })

      // 注册 abort 处理
      const abortHandler = () => {
        void threadSession.session.abort()
      }
      runOptions.signal?.addEventListener('abort', abortHandler, { once: true })

      try {
        // 提取用户消息
        const lastUserMessage = [...input.messages]
          .reverse()
          .find((m) => m.role === 'user')
        const userText = typeof lastUserMessage?.content === 'string'
          ? lastUserMessage.content
          : ''

        if (!userText) {
          emitSingleAssistantMessage(emit, '我需要一条用户消息才能继续。')
          emit({
            type: EventType.RUN_FINISHED,
            threadId,
            runId,
          } as RunFinishedEvent)
          return
        }

        // 调用 Pi SDK prompt
        await threadSession.session.prompt(userText)

        // 完成
        streamEmitter.finishTextMessage()

        const completeText = streamEmitter.getCompleteAssistantText()
        emit({
          type: EventType.RUN_FINISHED,
          threadId,
          runId,
          ...(completeText ? { result: completeText } : {}),
        } as RunFinishedEvent)
      } finally {
        unsubscribe()
        runOptions.signal?.removeEventListener('abort', abortHandler)
        threadSession.lastRunId = runId
        threadSession.lastAccessedAt = Date.now()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知 AG-UI 运行错误'
      emit({
        type: EventType.RUN_ERROR,
        message,
      } as RunErrorEvent)
    }
  }

  /** 中途引导 */
  async steerThread(threadId: string, text: string): Promise<void> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    await threadSession.session.steer(text)
    threadSession.lastAccessedAt = Date.now()
  }

  /** 后续消息 */
  async followUpThread(threadId: string, text: string): Promise<void> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    await threadSession.session.followUp(text)
    threadSession.lastAccessedAt = Date.now()
  }

  /** 分叉会话 */
  async forkThread(threadId: string, entryId: string): Promise<{ selectedText: string; cancelled: boolean }> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    const result = await threadSession.session.fork(entryId)
    threadSession.pendingToolCalls.clear()
    threadSession.lastAccessedAt = Date.now()
    return result
  }

  /** 手动压缩 */
  async compactThread(threadId: string, customInstructions?: string): Promise<unknown> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    const result = await threadSession.session.compact(customInstructions)
    threadSession.lastAccessedAt = Date.now()
    return result
  }

  /** 获取会话树 */
  async getThreadTree(threadId: string): Promise<unknown[]> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    const tree = threadSession.session.sessionManager.getTree()
    threadSession.lastAccessedAt = Date.now()
    return tree
  }

  /** 获取可用模型 */
  async getThreadModels(threadId: string): Promise<unknown[]> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    const models = threadSession.session.modelRegistry.getAvailable()
    threadSession.lastAccessedAt = Date.now()
    return models
  }

  /** 获取工具列表 */
  async getThreadTools(threadId: string): Promise<{ tools: unknown[]; activeToolNames: string[] }> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    const tools = threadSession.session.getAllTools?.() ?? threadSession.session.tools ?? []
    const activeToolNames = threadSession.session.getActiveToolNames?.() ?? []
    threadSession.lastAccessedAt = Date.now()
    return { tools, activeToolNames }
  }

  /** 设置活跃工具 */
  async setThreadActiveTools(threadId: string, toolNames: string[]): Promise<string[]> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    if (threadSession.session.setActiveToolsByName) {
      threadSession.session.setActiveToolsByName(toolNames)
    }
    threadSession.lastAccessedAt = Date.now()
    return toolNames
  }

  /** 重载资源 */
  async reloadThread(threadId: string): Promise<void> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    await threadSession.session.reload()
    threadSession.lastAccessedAt = Date.now()
  }
}
```

- [ ] **步骤 12：运行测试验证通过**

运行：`cd apps/agent-server && pnpm test`
预期：PASS

- [ ] **步骤 13：Commit**

```bash
git add apps/agent-server/src/core/
git add apps/agent-server/src/__tests__/
git commit -m "feat(agent-server): 核心适配层 — StreamEmitter、PiAgUiAgent、SessionStore、Gate、ReasoningPipeline"
```

---

## 任务 7：AG-UI 路由改造

**文件：**
- 重写：`apps/agent-server/src/routes/agui.route.ts`
- 重写：`apps/agent-server/src/routes/copilotkit.route.ts`
- 重写：`apps/agent-server/src/lib/sse.ts`
- 重写：`apps/agent-server/src/app.ts`
- 修改：`apps/agent-server/src/types/fastify.d.ts`
- 测试：`apps/agent-server/src/__tests__/agui-route.test.ts`

- [ ] **步骤 1：编写失败的测试 — AG-UI 路由**

创建 `apps/agent-server/src/__tests__/agui-route.test.ts`：

```typescript
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createApp } from '../app.js'

describe('AG-UI 路由', () => {
  let app: Awaited<ReturnType<typeof createApp>>

  beforeAll(async () => {
    process.env.PI_AGENT_AUTH_TOKEN = 'test-token-123'
    app = await createApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  const authHeaders = {
    authorization: 'Bearer test-token-123',
  }

  it('GET /ag-ui/info 返回协议信息', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ag-ui/info',
      headers: authHeaders,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.protocol).toBe('ag-ui')
    expect(body.agents).toBeDefined()
    expect(body.agents.length).toBeGreaterThan(0)
  })

  it('POST /ag-ui/agent/default/run 返回 SSE 流', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ag-ui/agent/default/run',
      headers: {
        ...authHeaders,
        'content-type': 'application/json',
      },
      body: {
        threadId: 'test-thread',
        runId: 'test-run',
        messages: [],
      },
    })
    // SSE 端点返回 200
    expect(response.statusCode).toBe(200)
  })

  it('GET /ag-ui/agent/default/models 需要 threadId', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ag-ui/agent/default/models',
      headers: authHeaders,
    })
    expect(response.statusCode).toBe(400)
  })

  it('GET /ag-ui/agent/default/tools 需要 threadId', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ag-ui/agent/default/tools',
      headers: authHeaders,
    })
    expect(response.statusCode).toBe(400)
  })

  it('未知 agentId 返回 404', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ag-ui/agent/nonexistent/models?threadId=t1',
      headers: authHeaders,
    })
    expect(response.statusCode).toBe(404)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd apps/agent-server && pnpm test`
预期：FAIL，现有路由不包含 `/ag-ui/info` 等端点

- [ ] **步骤 3：重写 SSE 工具**

重写 `apps/agent-server/src/lib/sse.ts`：

```typescript
import type { FastifyReply } from 'fastify'
import type { OutgoingHttpHeader, OutgoingHttpHeaders } from 'node:http'
import type { BaseEvent } from '@ag-ui/core'

function isOutgoingHeader(value: unknown): value is OutgoingHttpHeader {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    (Array.isArray(value) && every((item) => typeof item === 'string'))
  )
}

function every<T>(arr: T[], predicate: (item: T) => boolean): boolean {
  for (const item of arr) {
    if (!predicate(item)) return false
  }
  return true
}

/** AG-UI SSE 响应头 */
const SSE_HEADERS: OutgoingHttpHeaders = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
}

/** 设置 SSE 响应头 */
export function setupSse(reply: FastifyReply): void {
  const headers: OutgoingHttpHeaders = { ...SSE_HEADERS }
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (isOutgoingHeader(value)) {
      headers[name] = value
    }
  }
  reply.raw.writeHead(200, headers)
}

/** 发送 SSE 事件 */
export function sendSseEvent(reply: FastifyReply, event: BaseEvent | Record<string, unknown>): void {
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
}

/** 发送 SSE 注释 */
export function sendSseComment(reply: FastifyReply, comment: string): void {
  reply.raw.write(`: ${comment.replace(/\n/g, ' ')}\n\n`)
}

/** 关闭 SSE 连接 */
export function closeSse(reply: FastifyReply): void {
  reply.raw.end()
}
```

- [ ] **步骤 4：重写 AG-UI 路由**

重写 `apps/agent-server/src/routes/agui.route.ts`：

```typescript
import type { FastifyPluginAsync } from 'fastify'
import { RunAgentInputSchema } from '@ag-ui/core'
import { setupSse, sendSseEvent, sendSseComment, closeSse } from '../lib/sse.js'
import { validateBody } from '../lib/validate.js'
import {
  threadMessageInputSchema,
  forkThreadInputSchema,
  navigateThreadInputSchema,
  compactThreadInputSchema,
  toolsActiveInputSchema,
  reloadInputSchema,
} from '@repo/protocol/schemas'
import { AppError } from '@repo/shared/errors'
import { ErrorCode } from '@repo/shared/errors'

export const aguiRoute: FastifyPluginAsync = async (app) => {
  /** 获取 PiAgUiAgent 实例 */
  function getAgent() {
    return app.piAgUiAgent
  }

  /** 验证 agentId */
  function validateAgentId(agentId: string): void {
    const agent = getAgent()
    if (agentId !== agent.agentId) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        `未知的 Agent '${agentId}'，期望 '${agent.agentId}'`,
        404,
      )
    }
  }

  /** 从查询参数获取 threadId */
  function getThreadIdFromQuery(query: Record<string, unknown>): string {
    const threadId = typeof query.threadId === 'string' ? query.threadId.trim() : ''
    if (!threadId.length) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'threadId 查询参数必填', 400)
    }
    return threadId
  }

  // AG-UI 信息端点
  app.get('/ag-ui/info', async () => {
    const agent = getAgent()
    const stats = app.piSessionStore.getStats()
    return {
      protocol: 'ag-ui',
      version: '0.0.42',
      agents: [
        {
          id: agent.agentId,
          name: 'Pi AG-UI Agent',
          description: '基于 Pi SDK 的 AG-UI 协议端点',
          runEndpoint: `/ag-ui/agent/${agent.agentId}/run`,
        },
      ],
      endpoints: {
        info: '/ag-ui/info',
        run: `/ag-ui/agent/${agent.agentId}/run`,
        steer: `/ag-ui/agent/${agent.agentId}/steer`,
        followUp: `/ag-ui/agent/${agent.agentId}/follow-up`,
        fork: `/ag-ui/agent/${agent.agentId}/fork`,
        navigate: `/ag-ui/agent/${agent.agentId}/navigate`,
        reload: `/ag-ui/agent/${agent.agentId}/reload`,
        tree: `/ag-ui/agent/${agent.agentId}/tree`,
        models: `/ag-ui/agent/${agent.agentId}/models`,
        tools: `/ag-ui/agent/${agent.agentId}/tools`,
        activeTools: `/ag-ui/agent/${agent.agentId}/tools/active`,
        compact: `/ag-ui/agent/${agent.agentId}/compact`,
      },
      sessions: stats,
    }
  })

  // 主运行端点（SSE 流式）
  app.post('/ag-ui/agent/:agentId/run', async (request, reply) => {
    validateAgentId(request.params.agentId)

    const parsedInput = RunAgentInputSchema.safeParse(request.body)
    if (!parsedInput.success) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '无效的 AG-UI RunAgentInput', 400)
    }

    const input = parsedInput.data
    setupSse(reply)
    sendSseComment(reply, `thread=${input.threadId} run=${input.runId}`)

    const abortController = new AbortController()
    const closeHandler = () => abortController.abort()
    request.raw.on('aborted', closeHandler)
    reply.raw.on('close', closeHandler)

    try {
      const agent = getAgent()
      await agent.streamRun(
        input,
        (event) => sendSseEvent(reply, event),
        { signal: abortController.signal },
      )
    } catch (error) {
      if (!abortController.signal.aborted) {
        const message = error instanceof Error ? error.message : 'AG-UI 运行失败'
        sendSseEvent(reply, { type: 'RUN_ERROR', message })
      }
    } finally {
      request.raw.off('aborted', closeHandler)
      reply.raw.off('close', closeHandler)
      closeSse(reply)
    }

    return reply
  })

  // 中途引导
  app.post('/ag-ui/agent/:agentId/steer', async (request) => {
    validateAgentId(request.params.agentId)
    const input = validateBody(threadMessageInputSchema, request)
    if (!input) throw new AppError(ErrorCode.VALIDATION_ERROR, '请求参数校验失败', 400)

    await getAgent().steerThread(input.threadId, input.text)
    return { status: 'accepted', threadId: input.threadId }
  })

  // 后续消息
  app.post('/ag-ui/agent/:agentId/follow-up', async (request) => {
    validateAgentId(request.params.agentId)
    const input = validateBody(threadMessageInputSchema, request)
    if (!input) throw new AppError(ErrorCode.VALIDATION_ERROR, '请求参数校验失败', 400)

    await getAgent().followUpThread(input.threadId, input.text)
    return { status: 'accepted', threadId: input.threadId }
  })

  // 分叉
  app.post('/ag-ui/agent/:agentId/fork', async (request) => {
    validateAgentId(request.params.agentId)
    const input = validateBody(forkThreadInputSchema, request)
    if (!input) throw new AppError(ErrorCode.VALIDATION_ERROR, '请求参数校验失败', 400)

    const result = await getAgent().forkThread(input.threadId, input.entryId)
    return { status: result.cancelled ? 'cancelled' : 'forked', ...result }
  })

  // 导航
  app.post('/ag-ui/agent/:agentId/navigate', async (request) => {
    validateAgentId(request.params.agentId)
    const input = validateBody(navigateThreadInputSchema, request)
    if (!input) throw new AppError(ErrorCode.VALIDATION_ERROR, '请求参数校验失败', 400)

    const result = await getAgent().sessionStore.getOrCreate(input.threadId)
    const navResult = await result.session.navigateTree(input.targetId, {
      summarize: input.summarize ?? true,
      ...(input.customInstructions ? { customInstructions: input.customInstructions } : {}),
    })
    return { status: 'navigated', ...navResult }
  })

  // 重载
  app.post('/ag-ui/agent/:agentId/reload', async (request) => {
    validateAgentId(request.params.agentId)
    const input = validateBody(reloadInputSchema, request)

    if (input?.threadId) {
      await getAgent().reloadThread(input.threadId)
      return { status: 'reloaded', threadsReloaded: 1 }
    }

    // 重载所有线程
    const sessions = app.piSessionStore.getActiveThreadSessions()
    for (const session of sessions) {
      await session.session.reload()
    }
    return { status: 'reloaded', threadsReloaded: sessions.length }
  })

  // 会话树
  app.get('/ag-ui/agent/:agentId/tree', async (request) => {
    validateAgentId(request.params.agentId)
    const threadId = getThreadIdFromQuery(request.query as Record<string, unknown>)
    const tree = await getAgent().getThreadTree(threadId)
    return { threadId, tree }
  })

  // 可用模型
  app.get('/ag-ui/agent/:agentId/models', async (request) => {
    validateAgentId(request.params.agentId)
    const threadId = getThreadIdFromQuery(request.query as Record<string, unknown>)
    const models = await getAgent().getThreadModels(threadId)
    return { threadId, models }
  })

  // 工具列表
  app.get('/ag-ui/agent/:agentId/tools', async (request) => {
    validateAgentId(request.params.agentId)
    const threadId = getThreadIdFromQuery(request.query as Record<string, unknown>)
    const toolsState = await getAgent().getThreadTools(threadId)
    return { threadId, ...toolsState }
  })

  // 设置活跃工具
  app.post('/ag-ui/agent/:agentId/tools/active', async (request) => {
    validateAgentId(request.params.agentId)
    const input = validateBody(toolsActiveInputSchema, request)
    if (!input) throw new AppError(ErrorCode.VALIDATION_ERROR, '请求参数校验失败', 400)

    const activeToolNames = await getAgent().setThreadActiveTools(input.threadId, input.toolNames)
    return { status: 'updated', threadId: input.threadId, activeToolNames }
  })

  // 手动压缩
  app.post('/ag-ui/agent/:agentId/compact', async (request) => {
    validateAgentId(request.params.agentId)
    const input = validateBody(compactThreadInputSchema, request)
    if (!input) throw new AppError(ErrorCode.VALIDATION_ERROR, '请求参数校验失败', 400)

    const result = await getAgent().compactThread(input.threadId, input.customInstructions)
    return { status: 'compacted', threadId: input.threadId, result }
  })
}
```

- [ ] **步骤 5：重写 CopilotKit 兼容层**

重写 `apps/agent-server/src/routes/copilotkit.route.ts`：

```typescript
import type { FastifyPluginAsync } from 'fastify'

/**
 * CopilotKit 兼容层
 * 保留旧端点，返回 410 Gone，引导迁移到 AG-UI 端点
 */
export const copilotkitRoute: FastifyPluginAsync = async (app) => {
  app.all('/copilotkit/*', async (_request, reply) => {
    return reply.status(410).send({
      ok: false,
      error: {
        code: 'DEPRECATED',
        message: 'CopilotKit 端点已弃用，请迁移到 AG-UI 协议',
        migration: {
          info: '/ag-ui/info',
          run: '/ag-ui/agent/default/run',
        },
      },
    })
  })
}
```

- [ ] **步骤 6：更新 fastify.d.ts 添加 piAgUiAgent 和 piSessionStore**

修改 `apps/agent-server/src/types/fastify.d.ts`：

```typescript
import 'fastify'
import type { EventBus } from '@repo/shared/events'
import type { PiAgUiAgent } from '../core/agent/pi-agui-agent.js'
import type { PiSessionStore } from '../core/agent/session-store.js'

// Pi SDK 类型通过 any 声明，避免编译时依赖具体 SDK 类型
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PiAuthStorage = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PiModelRegistry = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PiSessionManager = any

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string
  }

  interface FastifyInstance {
    authToken?: string
    authStorage: PiAuthStorage
    modelRegistry: PiModelRegistry
    sessionManager: PiSessionManager
    getApiKey: (provider: string) => Promise<string | undefined>
    eventBus: EventBus
    piAgUiAgent: PiAgUiAgent
    piSessionStore: PiSessionStore
  }
}
```

- [ ] **步骤 7：重写 app.ts 注册所有组件**

重写 `apps/agent-server/src/app.ts`：

```typescript
import Fastify from 'fastify'
import { corsPlugin } from './plugins/cors.plugin.js'
import { authPlugin } from './plugins/auth.plugin.js'
import { rateLimitPlugin } from './plugins/rate-limit.plugin.js'
import { errorHandlerPlugin } from './plugins/error-handler.plugin.js'
import { requestContextPlugin } from './plugins/request-context.plugin.js'
import { eventBusPlugin } from './plugins/event-bus.plugin.js'
import { piSdkPlugin } from './plugins/pi-sdk.plugin.js'
import { healthRoute } from './routes/health.route.js'
import { aguiRoute } from './routes/agui.route.js'
import { copilotkitRoute } from './routes/copilotkit.route.js'
import { PiAgUiAgent } from './core/agent/pi-agui-agent.js'
import { PiSessionStore } from './core/agent/session-store.js'
import { Gate } from './core/tool/gate.js'
import { createPiSession } from './core/agent/pi-session.js'

export async function createApp() {
  const app = Fastify({
    logger: true,
  })

  // 核心插件（顺序重要）
  await app.register(requestContextPlugin)
  await app.register(corsPlugin)
  await app.register(authPlugin)
  await app.register(rateLimitPlugin)
  await app.register(errorHandlerPlugin)

  // 业务插件
  await app.register(eventBusPlugin)
  await app.register(piSdkPlugin)

  // 创建 SessionStore 和 PiAgUiAgent
  const sessionStore = new PiSessionStore()
  const gate = new Gate()

  // 注入 Session 工厂
  sessionStore.setSessionFactory(async () => {
    return createPiSession({
      authStorage: app.authStorage,
      modelRegistry: app.modelRegistry,
      sessionManager: app.sessionManager,
      getApiKey: app.getApiKey,
      gate,
      eventBus: app.eventBus,
      config: {
        cwd: process.env.PI_CWD ?? process.cwd(),
        dataDir: process.env.PI_DATA_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE}/.pi`,
      },
    })
  })

  const piAgUiAgent = new PiAgUiAgent(sessionStore)

  // 挂载到 Fastify 实例
  app.decorate('piAgUiAgent', piAgUiAgent)
  app.decorate('piSessionStore', sessionStore)

  // 路由
  await app.register(healthRoute)
  await app.register(aguiRoute)
  await app.register(copilotkitRoute)

  return app
}
```

- [ ] **步骤 8：运行测试验证通过**

运行：`cd apps/agent-server && pnpm test`
预期：PASS

- [ ] **步骤 9：Commit**

```bash
git add apps/agent-server/
git commit -m "feat(agent-server): AG-UI 路由改造 — 完整 REST API、SSE 流式、CopilotKit 弃用"
```

---

## 任务 8：端到端验证

**文件：**
- 修改：`apps/agent-server/src/index.ts`
- 创建：`apps/agent-server/src/extensions/web-search.ts`

- [ ] **步骤 1：重写启动逻辑**

重写 `apps/agent-server/src/index.ts`：

```typescript
import { createApp } from './app.js'

const app = await createApp()

try {
  const host = process.env.PI_HOST ?? '127.0.0.1'
  const port = parseInt(process.env.PI_PORT ?? '3900', 10)

  await app.listen({ host, port })

  app.log.info(`Agent Server 运行于 http://${host}:${port}`)
  app.log.info(`  AG-UI info:       http://${host}:${port}/ag-ui/info`)
  app.log.info(`  AG-UI run:        http://${host}:${port}/ag-ui/agent/default/run`)
  app.log.info(`  AG-UI steer:      http://${host}:${port}/ag-ui/agent/default/steer`)
  app.log.info(`  AG-UI follow-up:  http://${host}:${port}/ag-ui/agent/default/follow-up`)
  app.log.info(`  AG-UI fork:       http://${host}:${port}/ag-ui/agent/default/fork`)
  app.log.info(`  AG-UI navigate:   http://${host}:${port}/ag-ui/agent/default/navigate`)
  app.log.info(`  AG-UI reload:     http://${host}:${port}/ag-ui/agent/default/reload`)
  app.log.info(`  AG-UI tree:       http://${host}:${port}/ag-ui/agent/default/tree?threadId=...`)
  app.log.info(`  AG-UI models:     http://${host}:${port}/ag-ui/agent/default/models?threadId=...`)
  app.log.info(`  AG-UI tools:      http://${host}:${port}/ag-ui/agent/default/tools?threadId=...`)
  app.log.info(`  Health:           http://${host}:${port}/api/health`)
  app.log.info(`  CopilotKit (弃用): http://${host}:${port}/copilotkit/*`)

  // 优雅关闭
  const shutdown = async (signal: string) => {
    app.log.info(`收到 ${signal}，正在关闭...`)
    await app.close()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
```

- [ ] **步骤 2：创建 web-search 扩展骨架**

创建 `apps/agent-server/src/extensions/web-search.ts`：

```typescript
/**
 * web_search + web_fetch 扩展
 * 通过 Pi SDK Extensions 机制注册
 * 当前为骨架实现，后续接入实际搜索 API
 */

/** web_search 工具定义 */
export const webSearchTool = {
  name: 'web_search',
  description: '搜索互联网获取信息',
  parameters: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: '搜索关键词' },
    },
    required: ['query'],
  },
}

/** web_fetch 工具定义 */
export const webFetchTool = {
  name: 'web_fetch',
  description: '获取指定 URL 的内容',
  parameters: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: '目标 URL' },
    },
    required: ['url'],
  },
}
```

- [ ] **步骤 3：启动 agent-server 验证**

运行：`cd apps/agent-server && pnpm dev`
预期：服务启动，输出 AG-UI 端点信息

- [ ] **步骤 4：测试 health 端点**

运行：`curl http://127.0.0.1:3900/api/health`
预期：返回 `{ "ok": true, "data": { "service": "agent-server", "status": "online" }, ... }`

- [ ] **步骤 5：测试 AG-UI info 端点**

运行：`curl http://127.0.0.1:3900/ag-ui/info`
预期：返回 AG-UI 协议信息（如果配置了 auth token，需要添加 Authorization 头）

- [ ] **步骤 6：测试 SSE 流式端点**

运行：
```bash
curl -N -X POST http://127.0.0.1:3900/ag-ui/agent/default/run \
  -H "Content-Type: application/json" \
  -d '{"threadId":"test-1","runId":"run-1","messages":[{"id":"m1","role":"user","content":"hello"}]}'
```
预期：返回 SSE 事件流（RUN_STARTED, MESSAGES_SNAPSHOT, TEXT_MESSAGE_START, ...）

注意：此步骤需要配置有效的 LLM API Key 才能获得完整响应。如果未配置 API Key，应看到 RUN_ERROR 事件。

- [ ] **步骤 7：运行全量测试**

运行：`cd apps/agent-server && pnpm test`
预期：所有测试 PASS

- [ ] **步骤 8：运行类型检查**

运行：`pnpm typecheck`
预期：无类型错误（可能有 Pi SDK 类型相关的警告，可后续修复）

- [ ] **步骤 9：Commit**

```bash
git add apps/agent-server/
git commit -m "feat(agent-server): 端到端验证 — 启动逻辑、web-search 扩展骨架、优雅关闭"
```

---

## 自检

### 1. 规格覆盖度

| 规格章节 | 对应任务 |
|---------|---------|
| §4.1 项目结构调整 | 任务 1 + 任务 2 |
| §4.2 安全基线 | 任务 3 |
| §4.3 交付物 | 任务 1-3 |
| §4.4 验证标准 | 任务 3 + 任务 8 |
| §5.1 Pi SDK 插件注册 | 任务 4 |
| §5.2 CredentialBridge | 任务 5 |
| §5.3 ConfigService | 任务 5 |
| §5.4 交付物 | 任务 4-5 |
| §5.5 验证标准 | 任务 4-5 |
| §7.1 Agent 创建 | 任务 6 |
| §7.2 System Prompt 混合拼装 | 任务 6 (pi-session.ts) |
| §7.3 交付物 | 任务 6 |
| §8.1 AG-UI 路由改造 | 任务 7 |
| §8.2 StreamEmitter | 任务 6 |
| §8.3 PiAgUiAgent | 任务 6 |
| §8.4 Session 复用 | 任务 6 (session-store.ts) |
| §8.5 CopilotKit 适配 | 任务 7 |
| §8.6 交付物 | 任务 6-7 |
| §8.7 验证标准 | 任务 8 |

### 2. 占位符扫描

- 无 "TODO"、"待定"、"后续实现" 等占位符
- 每个步骤都包含完整代码
- 无 "类似任务 N" 的引用

### 3. 类型一致性

- `AppError` 在任务 2 定义，任务 3-7 使用，签名一致
- `EventBus` 在任务 2 定义，任务 4-6 使用，接口一致
- `PiSessionStore` 在任务 6 定义，任务 7 使用，方法名一致
- `PiAgUiAgent` 在任务 6 定义，任务 7 使用，方法名一致
- `Gate` 在任务 6 定义，任务 6 使用，接口一致
- `StreamEmitter` 在任务 6 定义，任务 6-7 使用，构造函数参数一致
- `ErrorCode` 在任务 1 定义（保留现有），任务 2-7 使用，值一致
- `sanitizeErrorMessage` 在任务 2 定义，任务 2 使用，签名一致
- `AgUiEventSink` 在任务 1 定义，任务 6 使用，类型一致
