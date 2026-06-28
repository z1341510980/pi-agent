/**
 * 插件系统类型定义
 *
 * 参考 docs/ARCHITECTURE.md §10 插件系统设计：
 * - 插件可注册：工具、路由、事件监听、UI 面板
 * - 生命周期：扫描 (scan) → 加载 (load) → 启用 (enable) → 运行 (running)
 *                                      ↓
 *                    禁用 (disable) ← 卸载 (unload)
 *
 * 安全提示：
 * - 插件代码在主进程中运行，与宿主共享 Node.js 进程权限
 * - 当前实现未提供沙箱隔离，仅加载可信插件
 * - 未来可考虑使用 worker_threads 或 vm 模块实现沙箱
 */

import type { FastifyBaseLogger } from 'fastify'
import type { AgentManager } from '../agent/subagent-tool.js'
import type { TeamManager } from '../agent/team-manager.js'

/** 插件状态 */
export type PluginStatus = 'loaded' | 'enabled' | 'disabled' | 'error'

/** 工具参数 JSON Schema（简化版，兼容 AG-UI Tool 定义） */
export interface ToolParameterSchema {
  type: string
  description?: string
  properties?: Record<string, ToolParameterSchema>
  required?: string[]
  items?: ToolParameterSchema
}

/** 工具执行上下文 */
export interface ToolExecutionContext {
  /** 调用方 threadId（可选） */
  threadId?: string
  /** 调用方 runId（可选） */
  runId?: string
  /** 中止信号 */
  signal?: AbortSignal
}

/** 工具执行结果 */
export interface ToolExecutionResult {
  /** 是否成功 */
  ok: boolean
  /** 返回数据 */
  data?: unknown
  /** 错误信息（ok=false 时） */
  error?: string
}

/** 工具定义：插件可注册的自定义工具 */
export interface ToolDefinition {
  /** 工具名（建议使用插件名作为前缀避免冲突，如 hello.greet） */
  name: string
  /** 工具描述（供 LLM 理解工具用途） */
  description: string
  /** 参数 JSON Schema */
  parameters?: ToolParameterSchema
  /** 执行函数 */
  execute: (args: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<ToolExecutionResult>
}

/** 路由 HTTP 方法 */
export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

/** 路由定义：插件可注册的 HTTP 端点 */
export interface RouteDefinition {
  /** HTTP 方法 */
  method: RouteMethod
  /**
   * 路由路径（相对路径，自动添加 /api/plugins/:pluginName 前缀）
   * 例如：'/status' 会变成 '/api/plugins/hello/status'
   */
  path: string
  /** 路由处理器 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (request: any, reply: any) => Promise<any> | any
}

/** UI 面板定义：插件可注册的前端面板 */
export interface PanelDefinition {
  /** 面板 ID（全局唯一，建议使用插件名作为前缀） */
  id: string
  /** 面板标题 */
  title: string
  /** 前端组件名（前端需注册对应组件） */
  component: string
  /** 面板位置 */
  position?: 'sidebar' | 'main' | 'panel'
  /** 初始 props */
  props?: Record<string, unknown>
}

/** 事件处理器 */
export type EventHandler = (data: unknown) => void | Promise<void>

/** 数据库迁移定义：插件可注册的数据库表创建/变更 */
export interface MigrationDefinition {
  /** 迁移 ID（全局唯一，建议用数字前缀，如 '013_create_novel_projects'） */
  id: string
  /** SQL 语句（必须幂等，使用 IF NOT EXISTS） */
  sql: string
}

/** 插件清单：插件元数据 */
export interface PluginManifest {
  /** 插件名（唯一标识，建议使用 kebab-case） */
  name: string
  /** 插件版本（语义化版本） */
  version: string
  /** 插件描述 */
  description?: string
  /** 作者 */
  author?: string
  /** 主入口（相对路径，默认 index.js） */
  main?: string
  /** 依赖的其他插件 */
  dependencies?: string[]
  /** 需要的权限能力 */
  permissions?: string[]
  /** 是否为内置插件 */
  builtin?: boolean
}

/**
 * 插件上下文：插件 setup 时获取的运行环境
 * 插件通过 context 注册工具、路由、事件监听、UI 面板
 */
export interface PluginContext {
  /** 当前插件名 */
  readonly pluginName: string
  /** 模块级日志器（已绑定 pluginName） */
  readonly logger: FastifyBaseLogger
  /** SQLite 数据库连接（由 databasePlugin 提供） */
  readonly db: import('better-sqlite3').Database
  /** 当前工作目录 */
  readonly cwd: string
  /** 数据目录 */
  readonly dataDir: string
  /**
   * AgentManager（由 subagentPlugin 提供）
   * 在 subagentPlugin 之后加载的插件可通过此引用注册 Agent。
   * 若 subagentPlugin 未注册则为 undefined。
   */
  readonly subagentManager?: AgentManager
  /**
   * TeamManager（由 teamPlugin 提供）
   * 在 teamPlugin 之后加载的插件可通过此引用注册 Team。
   * 若 teamPlugin 未注册则为 undefined。
   */
  readonly teamManager?: TeamManager
  /** 注册工具 */
  registerTool(tool: ToolDefinition): void
  /** 注册 HTTP 路由（路径自动加 /api/plugins/:pluginName 前缀） */
  registerRoute(route: RouteDefinition): void
  /** 监听事件 */
  onEvent(type: string, handler: EventHandler): void
  /** 注册 UI 面板 */
  registerPanel(panel: PanelDefinition): void
  /** 注册数据库迁移（在 database 插件之后、session factory 之前执行） */
  registerMigration(migration: MigrationDefinition): void
  /** 注入 Pi Session customTools（每次创建 session 时注入） */
  registerSessionTools(tools: ToolDefinition[]): void
  /** 装饰 Fastify 实例（挂载服务供路由和其他插件使用） */
  registerService(name: string, service: unknown): void
  /** 注册提示词模板目录（三级覆盖中的默认文件目录） */
  registerPromptTemplates(dir: string): void
  /**
   * 创建独立的 Pi SDK Session（用于插件内部 LLM 调用，如多 Agent 编排）
   *
   * 与主聊天 Session 隔离：使用独立的 threadId，不污染用户对话历史。
   * 系统提示词、工具、模型均可自定义。
   *
   * @returns Session 句柄，可调用 prompt() 触发 LLM 推理并获取结果
   */
  createSession(options: PluginSessionOptions): Promise<PluginSessionHandle>
}

/**
 * 插件创建 Pi Session 的选项
 */
export interface PluginSessionOptions {
  /** 系统提示词（覆盖默认的 Pi Agent 提示词） */
  systemPrompt: string
  /**
   * 前缀用户消息（SEMI 层，跨 Agent 稳定的章节上下文）。
   *
   * 若提供，会在 session 创建后、prompt() 调用前，作为一条独立 user 消息
   * 注入到对话历史首部。这样 LLM 收到的对话为：
   *   system → prefixUserMessage → userMessage
   * prefixUserMessage 前缀稳定，可被 prompt cache 命中；
   * userMessage 为 DYNAMIC 层（每次任务不同）。
   */
  prefixUserMessage?: string
  /** 首条用户消息（章节上下文/生成指令） */
  userMessage: string
  /** 自定义工具（可选，默认注入插件工具） */
  tools?: ToolDefinition[]
  /** 模型 ID（可选，默认使用已配置的第一个 Provider 的第一个模型） */
  modelId?: { provider: string; modelId: string }
  /** 中止信号 */
  signal?: AbortSignal
}

/**
 * 插件创建的 Pi Session 句柄
 */
export interface PluginSessionHandle {
  /** 触发 LLM 推理，返回完整 assistant 文本 */
  prompt(): Promise<string>
  /**
   * 触发 LLM 推理，流式推送 delta 文本。
   *
   * 与 prompt() 的区别：在 LLM 推理期间，每收到一段 text_delta
   * 就调用 onDelta(delta) 推送给调用方，实现真正的流式体验。
   * 最终仍返回完整 assistant 文本。
   *
   * @param onDelta delta 文本回调（每次 LLM 输出一段文本时触发）
   * @returns 完整 assistant 文本（与 prompt() 返回值一致）
   */
  promptStream(onDelta: (delta: string) => void): Promise<string>
  /** 中止当前推理 */
  abort(): void
  /** 释放 Session（从 SessionStore 淘汰） */
  dispose(): void
}

/**
 * 插件接口：所有插件需实现此接口
 * 插件通过 setup(context) 注册自己的能力
 */
export interface Plugin {
  /** 插件清单 */
  readonly manifest: PluginManifest
  /**
   * 静态数据库迁移（可选）
   *
   * 在 setup() 之前执行，确保插件 setup 时表已存在。
   * 适用于 setup 中初始化依赖数据库表的服务的插件。
   * setup 中也可通过 context.registerMigration() 注册动态迁移（在 start() 后执行）。
   */
  readonly migrations?: MigrationDefinition[]
  /** 插件初始化（注册工具、路由、事件监听、面板） */
  setup(context: PluginContext): void | Promise<void>
  /** 可选：插件销毁时清理资源 */
  teardown?(): void | Promise<void>
}

/** 插件工厂函数：从模块导出的入口 */
export type PluginFactory = () => Plugin | Promise<Plugin>

/** 插件运行时条目：PluginManager 内部维护的插件状态 */
export interface PluginEntry {
  /** 插件清单 */
  manifest: PluginManifest
  /** 插件实例 */
  plugin: Plugin
  /** 当前状态 */
  status: PluginStatus
  /** 错误信息（status=error 时） */
  error?: string
  /** 插件来源 */
  source: 'builtin' | 'local' | 'npm'
  /** 插件文件路径 */
  filePath?: string
  /** 已注册的工具 */
  tools: ToolDefinition[]
  /** 已注册的路由 */
  routes: RouteDefinition[]
  /** 已注册的面板 */
  panels: PanelDefinition[]
  /** 已注册的事件监听器（用于卸载时取消订阅） */
  eventHandlers: Array<{ type: string; handler: EventHandler }>
  /** 已注册的数据库迁移 */
  migrations: MigrationDefinition[]
  /** 已注册的 Session 工具（注入到 Pi Session customTools） */
  sessionTools: ToolDefinition[]
  /** 已注册的 Fastify 服务 */
  services: Array<{ name: string; service: unknown }>
  /** 已注册的提示词模板目录 */
  promptTemplateDirs: string[]
}

/** 插件列表项（API 返回的简化形式） */
export interface PluginListItem {
  name: string
  version: string
  description?: string
  author?: string
  status: PluginStatus
  source: 'builtin' | 'local' | 'npm'
  error?: string
  toolCount: number
  routeCount: number
  panelCount: number
  eventHandlerCount: number
  migrationCount: number
  sessionToolCount: number
  serviceCount: number
}

/** 插件加载选项 */
export interface PluginManagerOptions {
  /** 本地插件目录（绝对路径） */
  localPluginsDir?: string
  /** 是否启用 npm 插件扫描（默认 false） */
  enableNpmPlugins?: boolean
  /** 是否启用内置示例插件（默认 false） */
  enableBuiltinExamples?: boolean
  /** 内置插件列表 */
  builtinPlugins?: Array<{ plugin: Plugin; source?: 'builtin' }>
}
