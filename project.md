# pi-agent 项目文档

> 基于 DeepSeek Harness 架构理念重构的 AI Agent 桌面应用

## 1. 项目概述

pi-agent 是一个基于 Electron + Fastify + AG-UI 协议的 AI Agent 桌面应用。核心能力包括：

- **多插件架构**：借鉴 DSH 的 Cordis 理念，所有功能以插件形式组织
- **配置驱动**：通过 `config/plugins.yml` 声明式管理插件
- **服务容器**：插件间通过 `provide`/`get` 实现依赖注入
- **Realm 隔离**：插件可运行在独立数据库和上下文中
- **热重载**：开发时修改插件代码无需重启服务

### 1.1 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Fastify, TypeScript, better-sqlite3 |
| 前端 | Electron, React, Vite |
| 通信 | AG-UI 协议, WebSocket |
| 构建 | pnpm workspace, tsx, tsc |
| AI SDK | @earendil-works/pi-agent-core |

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Electron Desktop App                     │
│  ┌─────────────────────────────────────────────────────┐   │
│  │           Renderer (React + Vite)                   │   │
│  │  ┌──────────────┐  ┌──────────────┐               │   │
│  │  │  Chat UI     │  │  Plugin UI  │               │   │
│  │  └──────────────┘  └──────────────┘               │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │ IPC                           │
│  ┌─────────────────────────────────────────────────────┐   │
│  │           Main Process (Electron)                   │   │
│  │         Fastify Server + Plugin Runtime             │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────────┐
│                    Plugin System                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │
│  │ novel    │ │ web-     │ │ hello-   │ │ custom   │      │
│  │ plugin   │ │ search   │ │ plugin   │ │ plugin   │      │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘      │
│                            │                               │
│                    Service Container                        │
│              (provide / get / dependsOn)                   │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 目录结构

```
pi-agent/
├── apps/
│   ├── agent-server/          # Fastify 后端服务
│   │   ├── src/
│   │   │   ├── core/          # 核心模块
│   │   │   │   ├── agent/     # Agent 管理
│   │   │   │   ├── plugin/    # 插件系统核心
│   │   │   │   ├── config/    # 配置管理
│   │   │   │   └── session/   # 会话管理
│   │   │   └── plugins/       # 内置插件实现
│   │   └── package.json
│   └── desktop/               # Electron 桌面应用
├── packages/
│   ├── config/                # 共享配置
│   ├── protocol/              # AG-UI 协议定义
│   └── shared/                # 共享工具
├── config/
│   └── plugins.yml            # 插件配置文件
└── project.md                 # 本文档
```

---

## 3. 插件系统

### 3.1 核心概念

pi-agent 的插件系统借鉴了 DeepSeek Harness 的 Cordis 架构，但实现上更轻量：

| 概念 | 说明 |
|------|------|
| **Plugin** | 实现 `Plugin` 接口的模块，包含 `manifest` 和 `setup` |
| **PluginContext** | 插件运行时上下文，提供注册 API 和服务容器 |
| **PluginEntry** | 插件运行时条目，维护状态和注册项 |
| **PluginManager** | 插件生命周期管理（加载/启动/停止/重载） |

### 3.2 插件接口

```typescript
// core/plugin/plugin-types.ts

export interface Plugin {
  readonly manifest: PluginManifest
  readonly migrations?: MigrationDefinition[]
  setup(context: PluginContext): void | Promise<void>
  teardown?(): void | Promise<void>
}

export interface PluginManifest {
  name: string          // 插件唯一标识
  version: string       // 语义化版本
  description?: string
  author?: string
  dependencies?: string[]  // 依赖的其他插件
  permissions?: string[]   // 需要的权限
}
```

### 3.3 PluginContext API

插件在 `setup` 中通过 `context` 注册能力：

```typescript
interface PluginContext {
  // 插件元信息
  readonly pluginName: string
  readonly config: Record<string, unknown>  // 从 plugins.yml 注入
  readonly logger: FastifyBaseLogger
  readonly db: Database
  readonly cwd: string
  readonly dataDir: string

  // 服务容器（对标 DSH Cordis）
  provide<T>(key: string, service: T): void
  get<T>(key: string): T | undefined
  dependsOn(pluginNames: string[]): void

  // 注册能力
  registerTool(tool: ToolDefinition): void
  registerRoute(route: RouteDefinition): void
  onEvent(type: string, handler: EventHandler): void
  registerPanel(panel: PanelDefinition): void
  registerMigration(migration: MigrationDefinition): void
  registerSessionTools(tools: PiToolDefinition[]): void
  registerService(name: string, service: unknown): void
  registerPromptTemplates(dir: string): void

  // 创建会话
  createSession(options: PluginSessionOptions): Promise<PluginSessionHandle>
  createAgUiSession(options: PluginSessionOptions): Promise<AgUiSessionHandle>
}
```

---

## 4. 配置驱动加载

### 4.1 配置文件

`config/plugins.yml` 声明所有插件：

```yaml
plugins:
  - id: novel-plugin
    source: builtin
    enabled: true
    isolate: false
    config:
      dataDir: ./data/novel
      maxChapters: 100
      maxTokensPerChapter: 8000

  - id: web-search-plugin
    source: builtin
    enabled: true
    config:
      searchEngine: google
      apiKey: ${WEB_SEARCH_API_KEY}  # 环境变量
      timeoutMs: 30000
```

### 4.2 配置字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 插件标识（对应工厂映射表的 key） |
| `source` | `builtin` \| `local` \| `npm` | 插件来源 |
| `enabled` | boolean | 是否启用 |
| `isolate` | boolean | 是否隔离运行 |
| `config` | Record<string, unknown> | 插件自定义配置 |

### 4.3 内置插件工厂映射

在 `plugin-loader.plugin.ts` 中注册：

```typescript
const pluginFactories: Record<string, () => Plugin> = {
  'novel-plugin': createNovelPlugin,
  'web-search-plugin': createWebSearchPlugin,
  'hello-plugin': createHelloPlugin,
}
```

---

## 5. 服务容器

### 5.1 设计目标

插件间通过服务容器通信，避免直接依赖：

```typescript
// 提供服务
setup(ctx) {
  ctx.provide('storage', new StorageService())
}

// 消费服务
setup(ctx) {
  const storage = ctx.get('storage')
  if (storage) {
    storage.save(data)
  }
}
```

### 5.2 查找顺序

1. 当前插件通过 `provide` 注册的服务
2. 其他已启用插件通过 `provide` 注册的服务

### 5.3 依赖声明

```typescript
setup(ctx) {
  ctx.dependsOn(['database-plugin', 'config-plugin'])
  // 确保依赖插件已加载
  const db = ctx.get('database')
}
```

---

## 6. Realm 隔离模式

### 6.1 设计目标

当插件设置 `isolate: true` 时，自动获得独立的运行时环境：

```yaml
plugins:
  - id: untrusted-plugin
    source: local
    enabled: true
    isolate: true  # 隔离运行
```

### 6.2 隔离内容

| 资源 | 共享模式 | 隔离模式 |
|------|----------|----------|
| 数据库连接 | 共享主 DB | 独立 `plugins/<name>/data.db` |
| 数据目录 | 共享 `dataDir` | 独立 `dataDir/plugins/<name>/` |
| 事件总线 | 全局共享 | 独立订阅（仅接收本插件事件）|
| 日志上下文 | 共享 logger | 独立 logger（带 plugin 标签）|

### 6.3 实现原理

```typescript
// plugin-manager.ts - createPluginContext
if (entry.isolate) {
  const isolateDataDir = join(this.dataDir, 'plugins', pluginName)
  mkdirSync(isolateDataDir, { recursive: true })
  const dbPath = join(isolateDataDir, 'data.db')
  dbInstance = new Database(dbPath)
}
```

---

## 7. 热重载

### 7.1 使用方式

```typescript
// 通过 API 重载插件
await app.pluginManager.reload('novel-plugin')
```

### 7.2 支持范围

| 插件来源 | 热重载支持 |
|----------|-----------|
| `builtin` | ❌ 不支持（需重启） |
| `local` | ✅ 支持 |
| `npm` | ✅ 支持 |

### 7.3 实现原理

1. 停止插件（调用 `teardown`，清理注册项）
2. 保存配置（`config` + `isolate`）
3. 从注册表移除条目
4. ESM 重载：给模块 URL 添加 `?t=${Date.now()}` 强制重新加载
5. 恢复配置并启动

---

## 8. 插件开发指南

### 8.1 最小插件示例

```typescript
// plugins/my-plugin/index.ts
import type { Plugin, PluginContext } from '../../core/plugin/plugin-types.js'

export function createMyPlugin(): Plugin {
  return {
    manifest: {
      name: 'my-plugin',
      version: '1.0.0',
      description: 'My first pi-agent plugin',
    },
    setup: async (ctx: PluginContext) => {
      ctx.logger.info('My plugin started!')

      // 读取配置
      const greeting = ctx.config.greeting ?? 'Hello'

      // 注册工具
      ctx.registerTool({
        name: 'my-tool',
        description: 'A simple tool',
        execute: async (args) => {
          return { ok: true, data: `${greeting}, ${args.name || 'World'}!` }
        }
      })

      // 注册路由
      ctx.registerRoute({
        method: 'GET',
        path: '/status',
        handler: async (req, reply) => {
          return { status: 'ok', plugin: ctx.pluginName }
        }
      })
    },
    teardown: async () => {
      console.log('My plugin stopped')
    }
  }
}
```

### 8.2 在配置中启用

```yaml
# config/plugins.yml
plugins:
  - id: my-plugin
    source: builtin
    enabled: true
    isolate: false
    config:
      greeting: "Bonjour"
```

### 8.3 在 plugin-loader 中注册

```typescript
// apps/agent-server/src/plugins/plugin-loader.plugin.ts
import { createMyPlugin } from './my-plugin/index.js'

const pluginFactories: Record<string, () => Plugin> = {
  // ... 已有工厂
  'my-plugin': createMyPlugin,
}
```

---

## 9. 前后端通信协议

### 9.1 AG-UI 协议

pi-agent 使用 AG-UI 协议（`@ag-ui/core`）进行前后端通信：

| 事件类型 | 方向 | 说明 |
|----------|------|------|
| `RUN_STARTED` | Server → Client | Agent 运行开始 |
| `RUN_FINISHED` | Server → Client | Agent 运行结束 |
| `RUN_ERROR` | Server → Client | Agent 运行错误 |
| `MESSAGES_SNAPSHOT` | Server → Client | 消息快照 |
| `TOOL_CALL_RESULT` | Server → Client | 工具调用结果 |
| `TEXT_MESSAGE_*` | Server → Client | 文本消息流 |

### 9.2 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/agui/run` | POST | 启动 Agent 运行（SSE 流） |
| `/api/agui/steer` | POST | 干预当前运行 |
| `/api/agui/follow-up` | POST | 跟进对话 |
| `/api/agui/fork` | POST | 分叉对话 |
| `/api/agui/navigate` | POST | 导航到历史节点 |
| `/api/plugins/:pluginName/*` | 动态 | 插件自定义路由 |

### 9.3 StreamRun 输入

```typescript
interface StreamRunInput {
  threadId: string
  runId: string
  messages: Array<{
    id: string
    role: string
    content: string | unknown
    toolCallId?: string
  }>
  model?: { provider: string; modelId: string }
  temperature?: number
}
```

---

## 10. 代码生成规则

### 10.1 文件命名

| 类型 | 命名规范 | 示例 |
|------|----------|------|
| 核心类 | `kebab-case.ts` | `plugin-manager.ts` |
| 类型定义 | `kebab-case.ts` | `plugin-types.ts` |
| 插件入口 | `index.ts` | `novel-plugin/index.ts` |
| 测试文件 | `*.test.ts` | `plugin-manager.test.ts` |

### 10.2 模块导出

```typescript
// 每个包通过 index.ts 统一导出
export * from './core/plugin/plugin-manager.js'
export * from './core/plugin/plugin-types.js'
```

### 10.3 错误处理

```typescript
// 使用 AppError 统一错误格式
import { AppError, ErrorCode } from '@repo/shared/errors'
throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, '错误描述', 500)
```

### 10.4 日志规范

```typescript
// 使用结构化日志
ctx.logger.info({ threadId, runId }, 'Run completed')
ctx.logger.error({ err, threadId }, 'Run failed')
```

---

## 11. 扩展点

### 11.1 新增插件类型

1. 在 `plugins/` 下创建新目录
2. 实现 `Plugin` 接口
3. 在 `plugin-loader.plugin.ts` 注册工厂
4. 在 `config/plugins.yml` 添加配置

### 11.2 新增插件来源

目前支持 `builtin`、`local`、`npm` 三种来源：

- `builtin`：内置插件（在 plugin-loader 中注册工厂）
- `local`：本地文件系统（需配置 `PI_PLUGINS_DIR`）
- `npm`：npm 包（包名以 `wenlang-agent-plugin-` 开头）

### 11.3 自定义 AgentRuntime

```typescript
// 注册自定义运行时
const registry = new AgentRuntimeRegistry()
registry.register('my-runtime', {
  createSession: async (options) => { /* ... */ }
})
```

---

## 12. 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PI_CWD` | 工作目录 | `process.cwd()` |
| `PI_DATA_DIR` | 数据目录 | `~/.pi` |
| `PI_PLUGINS_DIR` | 本地插件目录 | 未设置 |
| `PI_PLUGINS_ENABLE_NPM` | 启用 npm 插件 | `false` |
| `PI_PLUGINS_ENABLE_EXAMPLES` | 启用示例插件 | `true` |
| `WEB_SEARCH_API_KEY` | 搜索 API Key | - |

---

## 13. 性能优化建议

1. **构建优化**：考虑使用 `tsdown` 替代 `tsc`
2. **懒加载**：插件按需加载，非启动时全部加载
3. **连接池**：复用数据库和 LLM 客户端连接
4. **缓存**：LLM 响应缓存，减少重复调用
5. **虚拟列表**：长对话使用虚拟滚动

---

## 14. 参考资料

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) - 架构灵感来源
- [AG-UI Protocol](https://github.com/ag-ui/core) - 通信协议
- [Cordis](https://cordis.js.org/) - DI 容器参考
- [Fastify](https://fastify.dev/) - 后端框架
- [Electron](https://www.electronjs.org/) - 桌面应用框架

---

*文档版本: 1.0.0 | 更新日期: 2026-08-19*