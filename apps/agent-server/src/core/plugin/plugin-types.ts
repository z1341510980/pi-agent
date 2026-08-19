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
import type { AgentCallLogger } from '../agent/agent-call-logger.js'
import type { TeamManager } from '../agent/team-manager.js'
import type { AgUiEventSink } from '@repo/protocol/events'
import type { StreamEmitter } from '../agent/stream-emitter.js'
import type { ReasoningPipeline } from '../agent/reasoning-pipeline.js'
import type { ConfirmationManager } from '../tool/confirmation-manager.js'
// pi-coding-agent 的 ToolDefinition（泛型版，由 defineTool 创建，execute 为 5 参数签名）。
// 与下方 plugin-types 的 ToolDefinition（2 参数 execute，仅用于 registerTool 列表展示）区分。
// registerSessionTools 注入的工具会进入 Pi SDK 的 customTools，由 createAgentSession
// 按 5 参数签名调用，因此必须使用 pi-coding-agent 的 ToolDefinition 类型。
import type { ToolDefinition as PiToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ModelRegistryLike } from './cache-control-support.js'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type Database from 'better-sqlite3'

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
  /** 单路由请求体上限（字节）；省略时沿用 Fastify 默认值。 */
  bodyLimit?: number
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
  /**
   * 在 SQL 之前于同一事务中执行的兼容准备步骤。
   * 仅用于无法用 SQLite 静态 SQL 表达的旧库结构迁移。
   */
  beforeApply?: (db: Database.Database) => void
  /** 在 SQL 之后于同一事务中执行的数据回填步骤。 */
  afterApply?: (db: Database.Database) => void
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
  /** 插件配置（从 plugins.yml 加载时传入） */
  readonly config: Record<string, unknown>
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
  /**
   * AgentCallLogger（由 subagentPlugin 提供，通用 Agent 调用日志记录器）
   *
   * 在 subagentPlugin 之后加载的插件可通过此引用记录 Agent 调用日志。
   * 领域插件（如 novel）可在自身编排流程中显式调用 record，
   * 并在 metadata 携带领域扩展字段（projectId / chapterNumber 等）。
   * 若 subagentPlugin 未注册则为 undefined。
   */
  readonly agentCallLogger?: AgentCallLogger
  /**
   * ModelRegistry（由 PluginManager 透传，app.ts 启动后期经 setModelRegistry 注入）
   *
   * 供插件按「与实际路由判定相同的来源」解析模型元信息（如 baseUrl）：
   * PluginManager.createSession 判定 cache_control 适用性时读的就是
   * modelRegistry.find(provider, modelId) 的 baseUrl（cache-control-support 的
   * findModelBaseUrl 封装了同一读取），遥测等旁路判定必须同源取数。
   * 实现上为 getter（注入晚于插件 setup，直接取值会拿到 undefined）。
   */
  readonly modelRegistry?: ModelRegistryLike
  /**
   * ConfirmationManager（chat 底座共享，由 app.ts 注入到 PluginManager）
   *
   * 供插件复用 chat 的统一确认/决策流程：
   * - 拿到默认 120s 超时机制（避免永久 pending）
   * - 复用 pending 列表与 'confirmation:request' / 'confirmation:resolved' 事件
   * - 旧 boolean API（requestConfirmation/respond）与新 string API（requestDecision/respondDecision）均可调用
   */
  readonly confirmationManager: ConfirmationManager
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
  registerSessionTools(tools: PiToolDefinition[]): void
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

  /**
   * 创建 AG-UI Session（工厂方法，封装 StreamEmitter + ReasoningPipeline + 订阅连接）
   *
   * 与 createSession 的区别：createSession 只返回裸 Pi Session 句柄，
   * 插件需要自己 new StreamEmitter + new ReasoningPipeline + session.subscribe。
   * createAgUiSession 把这些基础设施层封装好，插件只负责编排逻辑。
   *
   * 工厂内部完成：
   * 1. 调用 createSession 创建 Pi Session
   * 2. 生成 messageId（统一格式，供 agent_start 关联）
   * 3. new ReasoningPipeline(emit, messageId)
   * 4. new StreamEmitter(emit, messageId, reasoningPipeline, { emitRaw })
   * 5. session.subscribe(streamEmitter.handleSessionEvent)
   *
   * 插件拿到句柄后只需：
   * - 发射 agent_start（带返回的 messageId）
   * - 调用 handle.prompt() 触发 LLM
   * - 调用 handle.dispose() 清理
   *
   * @returns AG-UI Session 句柄（含 session / streamEmitter / messageId / dispose）
   */
  createAgUiSession(options: PluginSessionOptions & {
    /** AG-UI 事件 sink（StreamEmitter 发射目标） */
    emit: AgUiEventSink
    /** 是否发射 RAW 事件（默认 false，插件不需要；chat 显式开启用于调试） */
    emitRaw?: boolean
  }): Promise<AgUiSessionHandle>
}

/**
 * AG-UI Session 句柄（由 createAgUiSession 工厂创建）
 *
 * 封装了 Pi Session + StreamEmitter + ReasoningPipeline，
 * 插件不再需要自己 new 这些基础设施层实例。
 */
export interface AgUiSessionHandle {
  /** 底层 Pi Session 句柄（可调用 prompt / abort） */
  readonly session: PluginSessionHandle
  /** 底层 Pi Session 的稳定 ID，用于精确关联 usage_records */
  readonly sessionId?: string
  /** StreamEmitter 实例（已订阅 Pi Session 事件流） */
  readonly streamEmitter: StreamEmitter
  /** ReasoningPipeline 实例 */
  readonly reasoningPipeline: ReasoningPipeline
  /** 本次 assistant 消息的 messageId（agent_start 用此关联 TEXT_MESSAGE_*） */
  readonly messageId: string
  /** 释放资源（取消订阅 + dispose session） */
  dispose(): void
}

/**
 * 插件创建 Pi Session 的选项
 */
export interface PluginSessionOptions {
  /** 系统提示词（覆盖默认的 Wenlang Agent 提示词） */
  systemPrompt: string
  /**
   * 前缀用户消息（SEMI 层，跨 Agent 稳定的章节上下文）。
   *
   * 若提供，会在 session 创建后、prompt() 调用前，作为独立 user 消息
   * 注入到对话历史首部。这样 LLM 收到的对话为：
   *   system → prefixUserMessage[0] → prefixUserMessage[1] → ... → userMessage
   *
   * 支持两种形式：
   * - **string**：单条前缀消息，整条打一个 cache_control breakpoint
   * - **string[]**：多条前缀消息，每条独立打 cache_control breakpoint。
   *   用于"共享前缀 + Agent 专属后缀"分离：shared 跨 Agent 完全相同，
   *   suffix 各 Agent 不同。这样 shared 部分能跨 Agent 命中 prompt cache，
   *   suffix 部分 miss 但内容少。
   *
   * prefixUserMessage 前缀稳定，可被 prompt cache 命中；
   * userMessage 为 DYNAMIC 层（每次任务不同）。
   */
  prefixUserMessage?: string | string[]
  /**
   * prompt 缓存共享域。
   *
   * 用于让「共享同一段前缀的多次调用」命中同一份服务端前缀缓存。
   *
   * 背景：每次 createSession 都用随机 UUID 作 threadId → 新 Pi sessionId，
   * 而 pi-ai 把 sessionId 直接当 OpenAI 的 `prompt_cache_key`（一个路由提示：
   * 相同 key 尽量导到同一台机器，从而命中那台机器上的前缀缓存）。
   * 于是同一章的 Director / Writer / Reviewer 各拿一个随机 key，
   * 明明共享 system + shared 前缀，却被路由到不同机器，缓存全落空。
   *
   * 传入稳定值（如 `novel:${projectId}:${chapterNumber}`）即可让这一组调用共享缓存。
   * 不传则沿用 sessionId（旧行为）。
   */
  promptCacheScope?: string
  /** 首条用户消息（章节上下文/生成指令） */
  userMessage: string
  /**
   * 显式授权给本次插件 Session 的 Skill。
   *
   * 底座仅加载该路径，并在 prompt() 时使用 Pi 原生 `/skill:<name>` 语法展开正文；
   * 不会扫描或暴露环境中的其他 Skills。Pi 原生一次只展开一个 Skill，因此这里保持单值契约。
   */
  skill?: { name: string; path: string }
  /**
   * 与主 skill 确定性组合的附加 Skill（方案 §9.1）。
   *
   * Pi 原生一次只展开一个 Skill；多个 Skill 时由编排层确定性编译：
   * 剥离各 SKILL.md 的 frontmatter，按 [skill, ...extraSkills] 顺序包成
   * `<skill name="...">` 块，前置到任务消息。仅显式授权的路径会被加载。
   */
  extraSkills?: Array<{ name: string; path: string }>
  /**
   * 受限 skill_read 工具授权（方案 §9.2）。
   *
   * 提供后为本次会话注入只读授权 Skill 目录的 skill_read 工具
   * （路径穿越/扩展名/大小三重校验），不开放通用 read。
   */
  skillRead?: {
    /** 授权可读的根目录列表 */
    roots: string[]
    /** 单文件大小上限（字节），默认 64KB */
    maxBytes?: number
    /** 允许的扩展名白名单，默认 ['.md', '.txt', '.json'] */
    extensions?: string[]
  }
  /**
   * 本次会话使用的 AgentRuntime 标识（方案 §9.3）。
   *
   * 默认 'pi-session'（直连 Pi SDK）；未注册的标识会在 createSession 时显式抛错。
   * 未来接入 pi-subagents / pi-actors 等第三方运行时时通过 AgentRuntimeRegistry 注册适配器。
   */
  runtime?: string
  /** 自定义工具。undefined 注入默认插件工具；[] 显式禁用工具；非空数组为本次会话白名单。 */
  tools?: PiToolDefinition[]
  /** 模型 ID（可选，默认使用已配置的第一个 Provider 的第一个模型） */
  modelId?: { provider: string; modelId: string; thinkingLevel?: ThinkingLevel | null }
  /** 中止信号 */
  signal?: AbortSignal
  /** LLM 温度（0-2，未配置则使用 SDK 默认） */
  temperature?: number
  /** LLM 最大输出 token 数（未配置则从模型注册信息自动读取） */
  maxTokens?: number
  /** 响应格式：'json' 强制 JSON 输出，但不会移除工具定义；只读 JSON 会话仍需显式 tools: []。 */
  responseFormat?: 'json' | 'text'
  /** LLM 调用超时时间（毫秒），默认 120000（2 分钟）。写作等长文本 Agent 建议设 300000+ */
  timeoutMs?: number
  /**
   * 首 token 回调（可选）
   * 当 Pi Session 首次发射 text_delta 事件时调用，供编排层通知前端"开始生成"。
   *
   * 此回调由 createAgUiSession 工厂在内部订阅事件流时触发，
   * 插件无需自行 subscribe 检测首 token，复用工厂能力即可。
   * 回调在 StreamEmitter 处理事件的同一次订阅中同步触发，确保时序正确。
   */
  onFirstText?: () => void
  /**
   * 每次真实发往 provider 的 payload 体积回调。
   *
   * ## 为什么需要
   *
   * 小说侧的 agent 日志一直只记 systemPrompt / chapterContext / userMessage 的字符数，
   * 三者相加约 1 万字符，而同一次调用的 `inputTokens` 是 2~4 万 —— 中文 1 字符通常
   * ≤ 1 token，这个倍数说明**有一份和它们体量相当甚至更大的内容被送进去了，
   * 却完全不在日志里**（最可能是 SDK 默认系统提示词与内置工具集）。
   *
   * 想优化 token 必须先能看见它。这个回调在 `onPayload` 里对**最终 payload**
   * （注入参数、打完 cache 断点之后）做序列化计量，每次 LLM 往返触发一次 ——
   * 所以工具调用导致的多次往返也能被数出来。
   *
   * 只做计量，不改 payload。
   */
  onPayloadStats?: (stats: PluginPayloadStats) => void
}

/** 单次 provider 请求的 payload 体积计量 */
export interface PluginPayloadStats {
  /** `payload.messages` 序列化后的字符数（含 system 与全部历史） */
  messagesChars: number
  /** `payload.tools` 序列化后的字符数（工具 schema 的真实开销） */
  toolsChars: number
  /** 工具个数 */
  toolCount: number
  /** 整个 payload 序列化后的字符数 */
  totalChars: number
}

/**
 * 插件创建的 Pi Session 句柄
 */
export interface PluginSessionHandle {
  /** 底层 Pi Session 的稳定 ID，用于用量账本关联 */
  readonly sessionId?: string
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
  /**
   * 订阅 Pi Session 原始事件流（message_update / tool_execution_* / message_end 等）。
   *
   * 与 promptStream(onDelta) 的区别：onDelta 只拿到 text_delta 文本片段，
   * 而 subscribe 能拿到完整事件（含工具调用、推理过程等），供调用方
   * 映射为 AG-UI 标准事件（TEXT_MESSAGE_* / TOOL_CALL_* / STEP_*）。
   *
   * 多次 subscribe 互不干扰，每个返回独立的 unsubscribe 函数。
   *
   * @returns unsubscribe 函数
   */
  subscribe(handler: (event: Record<string, unknown>) => void): () => void
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
  /** 插件配置（从配置文件加载时传入） */
  config?: Record<string, unknown>
  /** 是否隔离运行（默认 false） */
  isolate?: boolean
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
  sessionTools: PiToolDefinition[]
  /** 已注册的 Fastify 服务 */
  services: Array<{ name: string; service: unknown }>
  /** 已注册的提示词模板目录 */
  promptTemplateDirs: string[]
  /** 插件提供的服务（供其他插件通过 get 消费） */
  providedServices: Map<string, unknown>
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
  /**
   * AgentRuntime 注册表（方案 §9.3）。
   *
   * 未提供时内部创建并注册默认 'pi-session' 运行时；提供时可追加
   * pi-subagents / pi-actors 等第三方运行时适配器。
   */
  runtimeRegistry?: import('../agent/agent-runtime.js').AgentRuntimeRegistry
}
