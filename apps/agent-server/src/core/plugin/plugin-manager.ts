/**
 * 插件管理器
 *
 * 职责：
 * 1. 扫描本地插件目录和 node_modules 中的 npm 插件
 * 2. 加载插件模块（错误隔离：单个插件失败不影响其他插件）
 * 3. 生命周期管理：init → start → stop，支持 enable/disable/reload
 * 4. 维护插件注册的工具、路由、事件监听器、UI 面板
 *
 * 安全提示：
 * - 插件代码在主进程中运行，与宿主共享 Node.js 权限
 * - 当前实现未提供沙箱隔离，仅加载可信插件
 * - 未来可考虑使用 worker_threads 或 vm 模块实现沙箱
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type Database from 'better-sqlite3'
import type { FastifyBaseLogger } from 'fastify'
import type { EventBus } from '@repo/shared/events'
import type { PiSessionStore } from '../agent/session-store.js'
import { withAgentConfig } from '../agent/pi-session.js'
import { AgentRuntimeRegistry, DEFAULT_AGENT_RUNTIME_KIND } from '../agent/agent-runtime.js'
import { composeSkillBlocks, fingerprintSkillContent } from './skill-compose.js'
import { createSkillReadTool } from './skill-read-tool.js'
import { resolveDependencyOrder, type DependencyNode } from './plugin-catalog.js'
import { verifyPackageIntegrity } from './plugin-integrity.js'
import { bumpHotGeneration } from './hot-module-cache.js'
import { resolveWithin } from './path-guard.js'
import type { PluginCatalogItem } from './plugin-catalog.js'
import { cancelDebug } from '../../lib/cancel-debug-log.js'
import { sessionDiag } from './session-diag.js'
import { StreamEmitter } from '../agent/stream-emitter.js'
import { ReasoningPipeline } from '../agent/reasoning-pipeline.js'
import { runtimePerformance } from '../../config/performance.js'
import type { AgentConfig, AgentManager } from '../agent/subagent-tool.js'
import type { ProviderConfigStore } from '../config/provider-config-store.js'
import {
  supportsAnthropicCacheControl,
  usesOpenAiPromptCacheKey,
  buildPromptCacheKey,
  type ModelRegistryLike
} from './cache-control-support.js'
import {
  getAssistantTerminalError,
  isFinalAssistantSuccess,
  waitForFinalAssistantOrPrompt
} from './plugin-session-outcome.js'
import {
  buildResponseFormatInjection,
  resolveJsonSchemaSupport
} from './structured-outputs-support.js'
import type { AgentCallLogger } from '../agent/agent-call-logger.js'
import type { TeamManager } from '../agent/team-manager.js'
import type { BackgroundWorkRegistry, BackgroundWorkProvider } from '../agent/background-work-registry.js'
import type { ConfirmationManager } from '../tool/confirmation-manager.js'
import type { Tracer } from '../tracer/tracer.js'
import type { EventStatus, TraceEventType } from '../tracer/types.js'
import type { ToolDefinition as PiToolDefinition } from '@earendil-works/pi-coding-agent'
import type {
  Plugin,
  PluginCapability,
  PluginContext,
  PluginEntry,
  PluginFactory,
  PluginListItem,
  PluginManagerOptions,
  PluginSessionHandle,
  PluginEffectDisposer,
  PluginEffectMetadata,
  PluginEffectRecord,
  PluginSessionOptions,
  AgUiSessionHandle,
  RouteDefinition,
  ToolDefinition,
   PanelDefinition,
   PluginUiContribution,
   PluginSettingField,
   EventHandler,
   MigrationDefinition
} from './plugin-types.js'

/** npm 插件包名前缀 */
const NPM_PLUGIN_PREFIX = 'wenlang-agent-plugin-'

export function buildPluginSessionPrompt(
  userMessage: string,
  skill?: { name: string; path: string },
  extraSkills: Array<{ name: string; path: string }> = []
): string {
  if (!skill) return userMessage
  // 单 Skill：Pi 原生 /skill: 展开（已验证路径）
  if (extraSkills.length === 0) return `/skill:${skill.name} ${userMessage}`
  // 多 Skill 组合（方案 §9.1）：Pi 原生一次只展开一个，编排层确定性编译
  // [主 Skill → 附加 Skill] 的 <skill> 块，前置到任务消息。
  return `${composeSkillBlocks([skill, ...extraSkills])}\n\n${userMessage}`
}

/** trace 事件里字符串字段的截断上限：trace 是排查用的，不需要完整 payload */
const TRACE_STRING_LIMIT = 2000

function summarizeToolArgsForTrace(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.slice(0, TRACE_STRING_LIMIT)
  try {
    return JSON.stringify(value)?.slice(0, TRACE_STRING_LIMIT) ?? ''
  } catch {
    return String(value).slice(0, TRACE_STRING_LIMIT)
  }
}

export class PluginManager {
  private readonly entries = new Map<string, PluginEntry>()
  private readonly logger: FastifyBaseLogger
  private readonly eventBus: EventBus
  private readonly options: PluginManagerOptions
  private readonly db: Database.Database
  private readonly cwd: string
  private readonly dataDir: string
  private initialized = false
  /**
   * Pi SessionStore（用于 createSession API）
   *
   * 通过 setSessionStore() 在 app.ts 启动后期注入，
   * 因为 PluginManager 在 pluginLoaderPlugin 中创建（app.ts:73），
   * 而 SessionStore 在其后创建（app.ts:85）。
   */
  private sessionStore?: PiSessionStore
  /**
   * AgentManager（由 subagentPlugin 提供）
   *
   * 在 pluginLoaderPlugin 中创建 PluginManager 之前 subagentPlugin 已注册，
   * 因此可在 manager.start() 之前通过 setAgentManager 注入。
   * 注入后插件 setup 可通过 context.subagentManager 注册 Agent。
   */
  private agentManager?: AgentManager
  /**
   * TeamManager（由 teamPlugin 提供）
   *
   * 同 AgentManager，teamPlugin 在 pluginLoaderPlugin 之前注册。
   * 注入后插件 setup 可通过 context.teamManager 访问。
   */
  private teamManager?: TeamManager
  /** Host-owned read-only registry for plugin background-work observation. */
  private backgroundWorkRegistry?: BackgroundWorkRegistry
  /**
   * ConfirmationManager（chat 底座共享）
   *
   * 由 app.ts 在 pluginLoaderPlugin 注册之前创建并 decorate 到 fastify 实例，
   * plugin-loader 在 manager.start() 之前注入到 PluginManager，
   * 插件 setup 可通过 context.confirmationManager 复用 chat 的确认/决策流程。
   */
  private confirmationManager?: ConfirmationManager
  /**
   * AgentCallLogger（由 subagentPlugin 提供，通用 Agent 调用日志记录器）
   *
   * 同 AgentManager，subagentPlugin 在 pluginLoaderPlugin 之前注册。
   * 注入后插件 setup 可通过 context.agentCallLogger 记录 Agent 调用日志。
   */
  private agentCallLogger?: AgentCallLogger
  /**
   * ModelRegistry（用于 createSession 的 modelId 切换）
   *
   * 通过 setModelRegistry() 在 app.ts 启动后期注入，
   * 与 SessionStore 同时期注入。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private modelRegistry?: any
  /**
   * ProviderConfigStore（用于读取 stream_options 屏蔽开关等应用级配置）
   *
   * 通过 setProviderConfigStore() 在 app.ts 启动后期注入，
   * 与 SessionStore / ModelRegistry 同时期注入。
   */
  private providerConfigStore?: ProviderConfigStore
  private mediaGenerator?: {
     generateImage(input: { prompt: string; references?: string[]; model?: string; size?: string; count?: number; signal?: AbortSignal }): Promise<{ images: string[] }>
    generateAudio(input: { prompt: string; model?: string; voice?: string; format?: string; speed?: number; signal?: AbortSignal }): Promise<{ outputs: Array<{ url: string; mimeType: string }> }>
    generateVideo(input: { prompt: string; model?: string; size?: string; seconds?: number; signal?: AbortSignal }): Promise<{ outputs: Array<{ url: string; mimeType: string }> }>
    editImage?(input: { prompt: string; image: string; images?: string[]; mask?: string; model?: string; size?: string; signal?: AbortSignal }): Promise<{ images: string[] }>
  }
  /** Tracer 在 app 启动后注入；未注入时插件会话保持原有行为。 */
  private tracer?: Tracer
  /**
   * AgentRuntime 注册表（方案 §9.3）。
   *
   * 承载第三方运行时适配器（pi-subagents / pi-actors 等）；默认 kind
   * 'pi-session' 走 createSession 的内联实现，不占用注册表条目。
   * createSession 按 PluginSessionOptions.runtime 路由，未注册的 kind 显式抛错。
   */
  private readonly runtimeRegistry: AgentRuntimeRegistry
  /** 插件目录配置（从 YAML 加载，包括 disabled 插件） */
  private catalogConfigs: PluginCatalogItem[] = []
  /** Service registry for dynamic service lookup (service name → plugin name → service instance) */
  private serviceRegistry = new Map<string, Map<string, { service: unknown; pluginId: string }>>()
  /** Policy Hook Manager（由 plugin-loader 注入） */
  private hookManager?: import('../policy/policy-hook-manager.js').PolicyHookManager
  /**
   * 宿主是否已完成启动期的 route 挂载与 service decorate。
   *
   * Fastify 只能在启动期注册路由和 decoration。一旦这个阶段结束，运行期 enable 的插件
   * 即使 setup 成功，它的 route/service 也只存在于 catalog 投影里 —— HTTP 请求打不到，
   * `app.decorate` 也不会再执行。API 必须如实区分这两种"enabled"（研究文档 §10.11）。
   */
  private hostMounted = false

  /**
   * 标记宿主启动期挂载已完成。
   *
   * 由 plugin-loader 在挂完 route 与 service 之后调用。之后每次 startPlugin
   * 若注册了 route/service，都会把 effectiveAfterRestart 置为 true。
   */
  markHostMounted(): void {
    this.hostMounted = true
    // 启动期已挂载的 route/service effect 才算真正 attached
    for (const entry of this.entries.values()) {
      if (entry.status !== 'enabled') continue
      this.applyHostAttachment(entry)
    }
  }

  /**
   * 按当前宿主阶段修正 entry 的 route/service effect 归属。
   *
   * - 启动期（hostMounted=false → markHostMounted 时）：本次注册的 route/service
   *   会被宿主挂载，hostAttached=true，effectiveAfterRestart=false。
   * - 运行期（hostMounted=true 时 startPlugin）：宿主不会再挂载，
   *   hostAttached=false，effectiveAfterRestart=true。
   */
  private applyHostAttachment(entry: PluginEntry): void {
    const registeredHostResources = entry.routes.length > 0 || entry.services.length > 0
    // startPlugin 发生在启动期挂载之前 → 本次注册项会被挂上；否则不会
    const attachedByHost = registeredHostResources && entry.activationMountedByHost
    entry.effectiveAfterRestart = registeredHostResources && !entry.activationMountedByHost
    for (const effect of entry.effects) {
      if (effect.activationGeneration !== entry.activationGeneration) continue
      if (effect.kind !== 'route' && effect.kind !== 'service') continue
      effect.hostAttached = attachedByHost
    }
  }

  /**
   * 注入 Policy Hook Manager
   */
  setHookManager(hookManager: import('../policy/policy-hook-manager.js').PolicyHookManager): void {
    this.hookManager = hookManager
    // 如果 sessionStore 已经注入，立即传递
    if (this.sessionStore && typeof this.sessionStore.setHookManager === 'function') {
      this.sessionStore.setHookManager(hookManager)
    }
    this.logger.debug('已注入 PolicyHookManager')
  }

  constructor(
    logger: FastifyBaseLogger,
    eventBus: EventBus,
    db: Database.Database,
    cwd: string,
    dataDir: string,
    options: PluginManagerOptions = {}
  ) {
    this.logger = logger
    this.eventBus = eventBus
    this.db = db
    this.cwd = cwd
    this.dataDir = dataDir
    this.options = options
    this.runtimeRegistry = options.runtimeRegistry ?? new AgentRuntimeRegistry()
  }

  /**
   * 设置插件目录配置（供管理界面使用）
   */
  setCatalogConfigs(configs: PluginCatalogItem[]): void {
    this.catalogConfigs = configs
  }

  /**
   * 更新插件的运行期配置/授权/期望状态，并同步回 catalog 投影。
   *
   * 所有变更都标记 restartRequired：capability grant 只在下一次 activation 生效，
   * 运行中的 route/service 不会因为 grants 变化而重新校验。
   */
  updateCatalogConfig(
    pluginId: string,
    patch: { enabled?: boolean; config?: Record<string, unknown>; grants?: PluginCapability[] }
  ): void {
    const entry = this.entries.get(pluginId)
    if (!entry) throw new Error(`插件 ${pluginId} 不存在`)
    if (patch.config) entry.config = { ...entry.config, ...patch.config }
    if (patch.grants) entry.grants = new Set(patch.grants)
    if (patch.enabled !== undefined) entry.desiredEnabled = patch.enabled
    entry.restartRequired = true
    this.syncCatalog(entry, patch)
  }

  /**
   * 把 entry 的期望状态写回 catalog 投影。
   *
   * enable/disable 必须走这里，否则 persistCatalog 写回的是旧的 enabled 值，
   * 重启后用户的开关意图丢失。
   */
  private syncCatalog(
    entry: PluginEntry,
    patch: { enabled?: boolean; config?: Record<string, unknown>; grants?: PluginCapability[] } = {}
  ): void {
    const catalog = this.catalogConfigs.find((item) => item.catalogId === entry.catalogId)
    if (!catalog) return
    catalog.enabled = entry.desiredEnabled
    if (patch.config) catalog.config = { ...(catalog.config ?? {}), ...patch.config }
    if (patch.grants) catalog.grants = [...patch.grants]
  }

  getCatalogConfigs(): PluginCatalogItem[] {
    return this.catalogConfigs
  }

  /**
   * 注入 PiSessionStore（在 SessionStore 创建后调用）
   *
   * PluginManager 在 pluginLoaderPlugin 注册时创建，但 SessionStore
   * 在其后才创建。因此通过 setter 延迟注入。
   * createSession 调用时（请求期）SessionStore 必然已注入。
   */
  setSessionStore(store: PiSessionStore): void {
    this.sessionStore = store
    this.logger.info('已注入 PiSessionStore，插件可使用 createSession API')
  }

  /**
   * 注入 ModelRegistry（在 SessionStore 创建后调用）
   *
   * 用于 createSession 的 modelId 切换：
   * 通过 modelRegistry.find() 查找模型后调用 session.setModel()。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setModelRegistry(registry: any): void {
    this.modelRegistry = registry
    this.logger.info('已注入 ModelRegistry，插件 createSession 支持 modelId 切换')
  }

  /**
   * 注入 ProviderConfigStore（在 SessionStore 创建后调用）
   *
   * 用于读取应用级配置（如 stream_options 屏蔽开关），
   * 与 SessionStore / ModelRegistry 同时期在 app.ts 注入。
   */
  setProviderConfigStore(store: ProviderConfigStore): void {
    this.providerConfigStore = store
    this.logger.debug('已注入 ProviderConfigStore，onPayload 可读取应用级配置')
  }

  setMediaGenerator(generator: {
     generateImage(input: { prompt: string; references?: string[]; model?: string; size?: string; count?: number; signal?: AbortSignal }): Promise<{ images: string[] }>
    generateAudio(input: { prompt: string; model?: string; voice?: string; format?: string; speed?: number; signal?: AbortSignal }): Promise<{ outputs: Array<{ url: string; mimeType: string }> }>
    generateVideo(input: { prompt: string; model?: string; size?: string; seconds?: number; signal?: AbortSignal }): Promise<{ outputs: Array<{ url: string; mimeType: string }> }>
    editImage?(input: { prompt: string; image: string; images?: string[]; mask?: string; model?: string; size?: string; signal?: AbortSignal }): Promise<{ images: string[] }>
  }): void {
    this.mediaGenerator = generator
    this.logger.debug('已注入媒体生成服务')
  }

  private mediaGeneratorFacade(): PluginContext['media'] {
    return this.mediaGenerator
  }

  /** 注入 Tracer，供显式声明 trace 归属的插件 Session 写入追踪时间线。 */
  setTracer(tracer: Tracer): void {
    this.tracer = tracer
    this.logger.debug('已注入 Tracer，插件 Session 可按领域会话写入追踪')
  }

  /**
   * 注入 AgentManager（在 manager.start() 之前调用）
   *
   * subagentPlugin 在 pluginLoaderPlugin 之前注册，app.subagentManager
   * 在 pluginLoaderPlugin 执行时已可用。注入后插件 setup 可通过
   * context.subagentManager 访问。
   */
  setAgentManager(manager: AgentManager): void {
    this.agentManager = manager
    this.logger.debug('已注入 AgentManager，插件可通过 context.subagentManager 访问')
  }

  /**
   * 注入 TeamManager（在 manager.start() 之前调用）
   *
   * teamPlugin 在 pluginLoaderPlugin 之前注册，app.teamManager
   * 在 pluginLoaderPlugin 执行时已可用。注入后插件 setup 可通过
   * context.teamManager 访问。
   */
  setTeamManager(manager: TeamManager): void {
    this.teamManager = manager
    this.logger.debug('已注入 TeamManager，插件可通过 context.teamManager 访问')
  }

  /** Inject the host background-work registry before plugin setup runs. */
  setBackgroundWorkRegistry(registry: BackgroundWorkRegistry): void {
    this.backgroundWorkRegistry = registry
    this.logger.debug('已注入 BackgroundWorkRegistry，插件可登记后台工作观测 provider')
  }

  /**
   * 注入 ConfirmationManager（在 manager.start() 之前调用）
   *
   * app.ts 在 pluginLoaderPlugin 注册之前创建 ConfirmationManager 并 decorate，
   * plugin-loader 在 manager.start() 之前通过此方法注入。
   * 注入后插件 setup 可通过 context.confirmationManager 复用 chat 的确认/决策流程
   * （超时机制 + pending 列表 + 'confirmation:request' / 'confirmation:resolved' 事件）。
   */
  setConfirmationManager(manager: ConfirmationManager): void {
    this.confirmationManager = manager
    this.logger.debug('已注入 ConfirmationManager，插件可通过 context.confirmationManager 访问')
  }

  /**
   * 注入 AgentCallLogger（在 manager.start() 之前调用）
   *
   * subagentPlugin 在 pluginLoaderPlugin 之前注册，app.agentCallLogger
   * 在 pluginLoaderPlugin 执行时已可用。注入后插件 setup 可通过
   * context.agentCallLogger 记录 Agent 调用日志（含领域扩展字段）。
   */
  setAgentCallLogger(logger: AgentCallLogger): void {
    this.agentCallLogger = logger
    this.logger.debug('已注入 AgentCallLogger，插件可通过 context.agentCallLogger 访问')
  }

  /**
   * 初始化：扫描并加载所有插件（不启用）
   * 此阶段只加载插件清单，不调用 setup()
   */
  async init(): Promise<void> {
    if (this.initialized) {
      this.logger.warn('PluginManager 已初始化，跳过重复初始化')
      return
    }

    this.logger.info('开始初始化插件系统')

    // 1. 加载内置插件
    if (this.options.builtinPlugins) {
      for (const item of this.options.builtinPlugins) {
        // catalogId 必须透传：它是配置身份（plugins.yml 的 id），与 manifest.name
        // 不同。缺了它，catalog 回写会找不到条目，grants/enabled 变更无法持久化。
        // filePath 是可选的源码入口：提供时 builtin 也参与热更新重载。
        await this.loadPluginEntry(
          item.plugin,
          'builtin',
          item.filePath,
          item.config,
          item.isolate,
          item.catalogId,
          undefined,
          item.filePath ? resolve(item.filePath, '..') : undefined
        )
      }
    }

    // 2. 加载本地插件目录
    if (this.options.localPluginsDir) {
      await this.scanLocalPlugins(this.options.localPluginsDir)
    }

    // 3. 加载 npm 插件
    if (this.options.enableNpmPlugins) {
      await this.scanNpmPlugins()
    }

    this.initialized = true
    const loadedCount = this.entries.size
    const errorCount = Array.from(this.entries.values()).filter((e) => e.status === 'error').length
    this.logger.info(`插件系统初始化完成：共加载 ${loadedCount} 个插件，其中 ${errorCount} 个失败`)
  }

  /**
   * 启动所有已加载的插件（调用 setup）
   *
   * 顺序由 manifest.dependencies 的拓扑排序决定：依赖先于消费方启动。
   * 缺失依赖、循环依赖或被上游阻断的插件不 setup，而是标记为 error 并写入
   * dependencyDiagnostics —— 让它照常启动只会在 setup 里拿不到服务而报模糊错误。
   *
   * desiredEnabled=false 的插件保留在 catalog 中但不 setup，
   * 之后可通过 enable() 恢复。
   *
   * 错误隔离：单个插件 setup 失败不影响其他插件。
   */
  async start(): Promise<void> {
    this.logger.info('开始启动插件')

    const nodes: DependencyNode[] = Array.from(this.entries.values()).map((entry) => ({
      pluginId: entry.pluginId,
      dependencies: entry.manifest.dependencies ?? []
    }))
    const { order, missing, cycles, blocked } = resolveDependencyOrder(nodes)

    // 先把被阻断的插件标成 error，避免它们被后续消费方误认为可用
    for (const entry of this.entries.values()) {
      if (!blocked.has(entry.pluginId)) {
        entry.dependencyDiagnostics = undefined
        continue
      }
      const diagnostics: string[] = []
      const absent = missing.get(entry.pluginId)
      if (absent?.length) diagnostics.push(`缺失依赖: ${absent.join(', ')}`)
      const cycle = cycles.get(entry.pluginId)
      if (cycle?.length) diagnostics.push(`循环依赖: ${cycle.join(' -> ')}`)
      if (diagnostics.length === 0) diagnostics.push('依赖链上游被阻断，无法安全启动')
      entry.dependencyDiagnostics = diagnostics
      entry.status = 'error'
      entry.lifecycle = 'error'
      entry.error = diagnostics.join('；')
      this.logger.error({ plugin: entry.pluginId, diagnostics }, '插件依赖不满足，跳过启动')
    }

    for (const pluginId of order) {
      const entry = this.entries.get(pluginId)
      if (!entry) continue
      if (!entry.desiredEnabled) {
        // 配置里关着：保持可见但不 setup，disabled 是期望状态而非发现失败
        entry.status = 'disabled'
        entry.lifecycle = 'disabled'
        this.logger.info({ plugin: pluginId }, '插件在配置中被禁用，跳过启动')
        continue
      }
      if (entry.status === 'loaded' || entry.status === 'error') {
        await this.startPlugin(pluginId)
      }
    }
    this.logger.info('插件启动完成')
  }

  /** 停止所有插件（调用 teardown） */
  async stop(): Promise<void> {
    this.logger.info('开始停止插件')
    for (const [name, entry] of this.entries) {
      if (entry.status === 'enabled') {
        await this.stopPlugin(name)
      }
    }
    this.logger.info('插件停止完成')
  }

  /**
   * 启用指定插件（调用 setup）
   *
   * 会把 desiredEnabled 置为 true，使配置中被禁用的插件可以恢复。
   * 依赖不满足时拒绝启动并返回诊断，而不是让 setup 报模糊错误。
   */
  async enable(name: string): Promise<void> {
    const entry = this.entries.get(name)
    if (!entry) {
      throw new Error(`插件不存在: ${name}`)
    }
    if (entry.status === 'enabled') {
      this.logger.warn({ plugin: name }, '插件已启用，无需重复启用')
      return
    }
    const unmet = this.findUnmetDependencies(entry)
    if (unmet.length > 0) {
      entry.dependencyDiagnostics = [`缺失或未启用的依赖: ${unmet.join(', ')}`]
      throw new Error(`插件 ${name} 依赖不满足: ${unmet.join(', ')}`)
    }
    entry.desiredEnabled = true
    entry.dependencyDiagnostics = undefined
    await this.startPlugin(name)
    // 期望状态写回 catalog，使重启后仍保持启用
    this.syncCatalog(entry)
  }

  /**
   * 找出该插件当前不满足的依赖。
   *
   * 依赖必须既存在于 catalog，也处于 enabled 状态 —— 依赖插件被禁用时，
   * 消费方拿到的服务引用会是 stale 的。
   */
  private findUnmetDependencies(entry: PluginEntry): string[] {
    const unmet: string[] = []
    for (const dependency of entry.manifest.dependencies ?? []) {
      const target = this.entries.get(dependency)
      if (!target || target.status !== 'enabled') unmet.push(dependency)
    }
    return unmet
  }

  /** 禁用指定插件（调用 teardown 并清理注册项） */
  async disable(name: string): Promise<void> {
    const entry = this.entries.get(name)
    if (!entry) {
      throw new Error(`插件不存在: ${name}`)
    }
    // 期望状态先落定：即使当前不是 enabled，用户的"关掉它"意图也要被记录，
    // 否则重启后配置回写会把它又打开。
    entry.desiredEnabled = false
    this.syncCatalog(entry)
    if (entry.status !== 'enabled') {
      this.logger.warn({ plugin: name }, `插件当前状态为 ${entry.status}，无需禁用`)
      return
    }
    await this.stopPlugin(name)
  }

  /**
   * 重载指定插件：候选先行（import-before-dispose），成功后再替换运行中的实例
   *
   * 预检先行（研究文档 §10.11）：旧实现先 stop 并 `entries.delete()`，之后才检查
   * `source === 'builtin'` 并抛错。结果是 builtin 插件被从 catalog 里删掉、
   * 请求返回 500，而已挂到 Fastify 的旧 route/service 仍在工作，连 `/enable`
   * 也找不回来。任何拒绝条件都必须在破坏状态之前判定。
   *
   * 候选先行（参考 dsh/Cordis HMR 的事务化重载契约）：先把磁盘上的新模块完整
   * 导入并校验出 Plugin 实例，全部通过后才卸载旧实例。导入或校验失败时直接抛错，
   * 旧插件保持原状继续运行 —— 热更新绝不能把一个活着的插件降级成不可用。
   *
   * 完整性锁同样属于预检（§6.3）：磁盘代码可能已被替换，带 resolvedVersion/
   * integrity 锁的插件必须在重新 import 之前通过校验；校验失败拒绝重载且保留
   * 当前运行状态 —— 热更新不能成为绕过封存校验的旁路。
   */
  async reload(name: string): Promise<void> {
    const entry = this.entries.get(name)
    if (!entry) {
      throw new Error(`插件不存在: ${name}`)
    }

    // ---- 预检：在任何破坏性操作之前 ----
    // builtin 不再一刀切拒绝：dev 下 loader 会解析出源码入口（src/plugins/<dir>/index.ts），
    // 带 filePath 的 builtin 走与 local/npm 完全相同的候选先行重载；
    // 打包构建里解析不到源码目录时 filePath 为空，退化为"重载需重启"。
    if (!entry.filePath) {
      throw new Error(
        entry.source === 'builtin'
          ? `内置插件 ${name} 没有可重载的源码入口，请重启服务`
          : `插件 ${name} 没有文件路径，不支持重载，请重启服务`
      )
    }
    // 重载前重新校验完整性锁：锁定插件的磁盘文件一旦变更，摘要必然不匹配，
    // 此时必须拒绝重载并提示重新封存，而不是把篡改后的代码换进运行时。
    const locked = this.catalogConfigs.find(
      (item) =>
        item.catalogId === entry.catalogId &&
        (item.integrity !== undefined || item.resolvedVersion !== undefined)
    )
    let reloadedIntegrity: 'verified' | 'unverified' | undefined
    if (locked) {
      const verification = verifyPackageIntegrity({
        packageDir: entry.packageDir ?? resolve(entry.filePath, '..'),
        ...(locked.integrity !== undefined ? { integrity: locked.integrity } : {}),
        ...(locked.resolvedVersion !== undefined
          ? { resolvedVersion: locked.resolvedVersion }
          : {})
      })
      if (!verification.ok) {
        throw new Error(
          `插件 ${name} 完整性校验失败（${verification.reason}），拒绝重载；` +
            '请重新安装插件并运行 scripts/seal-plugin.ts 更新 plugins.yml 的锁定信息'
        )
      }
      reloadedIntegrity = 'verified'
    } else {
      // 无锁插件保持原校验状态，不让重载悄悄改变信任级别
      reloadedIntegrity =
        entry.integrityStatus === 'unverified'
          ? 'unverified'
          : entry.integrityStatus === 'verified'
            ? 'verified'
            : undefined
    }

    this.logger.info({ plugin: name }, '开始重载插件')

    // ---- 候选先行：新代码完整可用之前，不动旧插件 ----
    const candidatePlugin = await this.importPluginModule(entry.filePath, true)

    // 保存配置和隔离设置（重载后恢复）
    const savedConfig = entry.config ?? {}
    const savedIsolate = entry.isolate ?? false
    const savedCatalogId = entry.catalogId
    const savedDesiredEnabled = entry.desiredEnabled
    const savedPackageDir = entry.packageDir
    const filePath = entry.filePath
    const source = entry.source

    // 候选就绪，进入替换段：停止旧实例 → 移除注册 → 登记候选 → 按期望状态启动
    if (entry.status === 'enabled') {
      await this.stopPlugin(name)
    }
    this.entries.delete(name)
    await this.loadPluginEntry(
      candidatePlugin,
      source,
      filePath,
      savedConfig,
      savedIsolate,
      savedCatalogId,
      reloadedIntegrity,
      savedPackageDir
    )
    const reloaded = this.entries.get(name)
    if (!reloaded) {
      // 候选已在上面校验过 manifest；走到这里说明同名条目登记被拒，
      // 必须明确报出来而不是静默成功
      throw new Error(`插件 ${name} 重载后未能重新注册，请检查插件文件并重启服务`)
    }
    reloaded.desiredEnabled = savedDesiredEnabled
    if (savedDesiredEnabled) {
      await this.startPlugin(name)
    }

    this.logger.info(
      { plugin: name, configRestored: Object.keys(savedConfig).length > 0 },
      '插件重载完成'
    )
  }

  /**
   * 收集支持热更新的插件监视目标。
   *
   * 带确定入口文件且期望启用的插件都可被外部重载 —— 包括 dev 下解析出
   * src 源码入口的 builtin 插件。打包构建里的 builtin（无源码目录）与
   * 期望状态为关闭的插件不监视：禁用的第三方代码不应因磁盘变更被重新
   * import（与启动期"禁用即不加载"一致）。
   *
   * watchDir 优先取包根目录：npm 的 main 可能指向 dist/index.js，
   * 按入口文件所在目录监听会漏掉包内其他目录的变更。
   */
  getHotReloadTargets(): Array<{ pluginId: string; filePath: string; watchDir: string }> {
    const targets: Array<{ pluginId: string; filePath: string; watchDir: string }> = []
    for (const entry of this.entries.values()) {
      if (!entry.filePath) continue
      if (!entry.desiredEnabled) continue
      targets.push({
        pluginId: entry.pluginId,
        filePath: entry.filePath,
        watchDir: entry.packageDir ?? resolve(entry.filePath, '..')
      })
    }
    return targets
  }

  /** 列出所有插件 */
  list(): PluginListItem[] {
    return Array.from(this.entries.values()).map((entry) => ({
      name: entry.manifest.name,
      version: entry.manifest.version,
      description: entry.manifest.description,
      author: entry.manifest.author,
      status: entry.status,
      source: entry.source,
      integrityStatus: entry.integrityStatus,
      error: entry.error,
      lifecycle: entry.lifecycle,
      desiredEnabled: entry.desiredEnabled,
      ...(entry.dependencyDiagnostics
        ? { dependencyDiagnostics: entry.dependencyDiagnostics }
        : {}),
      activationGeneration: entry.activationGeneration,
      runId: entry.runId,
      effectCount: entry.effects.length,
      activeEffectCount: entry.effects.filter((effect) => effect.state === 'active').length,
      hostAttached: entry.effects.some(
        (effect) =>
          effect.activationGeneration === entry.activationGeneration &&
          (effect.kind === 'route' || effect.kind === 'service') &&
          effect.hostAttached
      ),
      effectiveAfterRestart: entry.effectiveAfterRestart,
      lastStop: entry.lastStop,
      restartRequired: entry.restartRequired,
      unloadScope: entry.unloadScope,
      toolCount: entry.tools.length,
      routeCount: entry.routes.length,
      panelCount: entry.panels.length,
      eventHandlerCount: entry.eventHandlers.length,
      migrationCount: entry.migrations.length,
      sessionToolCount: entry.sessionTools.length,
      serviceCount: entry.services.length
    }))
  }

  /** 获取指定插件详情 */
  get(name: string): PluginEntry | undefined {
    return this.entries.get(name)
  }

  /** 获取所有已启用插件注册的工具 */
  getAllTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = []
    for (const entry of this.entries.values()) {
      if (entry.status === 'enabled') {
        tools.push(...entry.tools)
      }
    }
    return tools
  }

  /** 获取所有已启用插件注册的路由 */
  getAllRoutes(): Array<{ pluginName: string; route: RouteDefinition }> {
    const routes: Array<{ pluginName: string; route: RouteDefinition }> = []
    for (const entry of this.entries.values()) {
      if (entry.status === 'enabled') {
        for (const route of entry.routes) {
          routes.push({ pluginName: entry.manifest.name, route })
        }
      }
    }
    return routes
  }

  /** 获取所有已启用插件注册的面板 */
  getAllPanels(): PanelDefinition[] {
    const panels: PanelDefinition[] = []
    for (const entry of this.entries.values()) {
      if (entry.status === 'enabled') {
        panels.push(...entry.panels)
      }
    }
    return panels
  }

  /** 获取当前启用插件的受信 renderer manifest。不会返回可执行源码。 */
  getAllUiContributions(): Array<
    PluginUiContribution & { pluginId: string; activationGeneration: number }
  > {
    const result: Array<PluginUiContribution & { pluginId: string; activationGeneration: number }> =
      []
    for (const entry of this.entries.values()) {
      if (entry.status !== 'enabled') continue
      for (const contribution of entry.uiContributions) {
        result.push({
          ...contribution,
          pluginId: entry.pluginId,
          activationGeneration: entry.activationGeneration
        })
      }
    }
    return result
  }

  /** 获取所有已启用插件声明的标量设置 schema（供桌面端通用渲染器生成表单） */
  getAllSettings(): Array<{
    pluginId: string
    label: string
    description?: string
    fields: PluginSettingField[]
  }> {
    const result: Array<{
      pluginId: string
      label: string
      description?: string
      fields: PluginSettingField[]
    }> = []
    for (const entry of this.entries.values()) {
      if (entry.status !== 'enabled') continue
      if (entry.settingsFields.length === 0) continue
      result.push({
        pluginId: entry.pluginId,
        label: entry.manifest.name,
        ...(entry.manifest.description ? { description: entry.manifest.description } : {}),
        fields: entry.settingsFields
      })
    }
    return result
  }

  /** 获取所有已启用插件的数据库迁移（按 id 排序） */
  getAllMigrations(): MigrationDefinition[] {
    const all: MigrationDefinition[] = []
    for (const entry of this.entries.values()) {
      if (entry.status === 'enabled') {
        all.push(...entry.migrations)
      }
    }
    return all.sort((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * 获取所有已加载插件的数据库迁移（按 id 排序）
   *
   * 与 getAllMigrations 的区别：不要求插件为 enabled 状态。
   * 用于在 start() 之前执行静态迁移，确保 setup 时表已存在。
   */
  getLoadedMigrations(): MigrationDefinition[] {
    const all: MigrationDefinition[] = []
    for (const entry of this.entries.values()) {
      if (entry.status === 'loaded' || entry.status === 'enabled') {
        all.push(...entry.migrations)
      }
    }
    return all.sort((a, b) => a.id.localeCompare(b.id))
  }

  /** 获取所有已启用插件注入的 Pi Session 工具 */
  getAllSessionTools(): PiToolDefinition[] {
    const all: PiToolDefinition[] = []
    for (const entry of this.entries.values()) {
      if (entry.status === 'enabled') {
        all.push(...entry.sessionTools)
      }
    }
    return all
  }

  /** 获取所有已启用插件注册的 Fastify 服务 */
  getAllServices(): Array<{ pluginName: string; name: string; service: unknown }> {
    const all: Array<{ pluginName: string; name: string; service: unknown }> = []
    for (const entry of this.entries.values()) {
      if (entry.status === 'enabled') {
        for (const { name, service } of entry.services) {
          all.push({ pluginName: entry.manifest.name, name, service })
        }
      }
    }
    return all
  }

  /** 获取所有已启用插件注册的提示词模板目录 */
  getAllPromptTemplateDirs(): string[] {
    const all: string[] = []
    for (const entry of this.entries.values()) {
      if (entry.status === 'enabled') {
        all.push(...entry.promptTemplateDirs)
      }
    }
    return all
  }

  // ============ 内部实现 ============

  /**
   * 对目录扫描发现的插件做完整性判定。
   *
   * 扫描路径（PI_PLUGINS_DIR / PI_PLUGINS_ENABLE_NPM）不经过 catalog 驱动的加载分支，
   * 因此这里补上同一套判定：catalog 里有锁就必须校验通过；没锁则允许加载但标记
   * unverified 并告警。不静默放行、也不因为没锁就拒绝本地开发。
   *
   * @returns 'verified' / 'unverified'；null 表示有锁但校验失败，调用方必须跳过加载
   */
  private resolveScannedIntegrity(
    packageDir: string,
    dirName: string,
    source: 'local' | 'npm'
  ): 'verified' | 'unverified' | null {
    const locked = this.catalogConfigs.find(
      (item) =>
        (item.integrity !== undefined || item.resolvedVersion !== undefined) &&
        (item.catalogId === dirName ||
          item.sourceRef === dirName ||
          (item.sourceRef !== undefined && resolve(item.sourceRef) === resolve(packageDir)))
    )
    if (!locked) {
      this.logger.warn(
        { packageDir, source },
        '扫描发现的插件未在 plugins.yml 声明 integrity/resolvedVersion，以 unverified 状态加载'
      )
      return 'unverified'
    }
    const verification = verifyPackageIntegrity({
      packageDir,
      ...(locked.integrity !== undefined ? { integrity: locked.integrity } : {}),
      ...(locked.resolvedVersion !== undefined
        ? { resolvedVersion: locked.resolvedVersion }
        : {})
    })
    if (!verification.ok) {
      this.logger.error(
        {
          packageDir,
          source,
          catalogId: locked.catalogId,
          reason: verification.reason,
          computedSri: verification.computedSri,
          actualVersion: verification.actualVersion
        },
        '扫描插件完整性校验失败，拒绝加载'
      )
      return null
    }
    this.logger.info(
      { packageDir, source, catalogId: locked.catalogId, fileCount: verification.fileCount },
      '扫描插件完整性校验通过'
    )
    return 'verified'
  }

  /** 扫描本地插件目录 */
  private async scanLocalPlugins(dir: string): Promise<void> {
    if (!existsSync(dir)) {
      this.logger.debug({ dir }, '本地插件目录不存在，跳过扫描')
      return
    }

    this.logger.info({ dir }, '扫描本地插件目录')
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch (err) {
      this.logger.error({ dir, err }, '读取本地插件目录失败')
      return
    }

    for (const name of entries) {
      const pluginPath = join(dir, name)
      let stat
      try {
        stat = statSync(pluginPath)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue

      // 查找入口文件：package.json main / index.js / index.ts
      const entryFile = this.resolvePluginEntry(pluginPath)
      if (!entryFile) {
        this.logger.warn({ pluginPath }, '未找到插件入口文件，跳过')
        continue
      }

      const integrityStatus = this.resolveScannedIntegrity(pluginPath, name, 'local')
      if (integrityStatus === null) continue

      await this.loadFromFile(
        entryFile,
        'local',
        false,
        undefined,
        undefined,
        undefined,
        integrityStatus,
        pluginPath
      )
    }
  }

  /** 扫描 node_modules 中的 npm 插件 */
  private async scanNpmPlugins(): Promise<void> {
    const nodeModulesDir = resolve(process.cwd(), 'node_modules')
    if (!existsSync(nodeModulesDir)) {
      return
    }

    this.logger.info({ dir: nodeModulesDir }, '扫描 npm 插件')

    let entries: string[] = []
    try {
      entries = readdirSync(nodeModulesDir)
    } catch (err) {
      this.logger.error({ dir: nodeModulesDir, err }, '读取 node_modules 失败')
      return
    }

    for (const name of entries) {
      if (!name.startsWith(NPM_PLUGIN_PREFIX)) continue

      const pluginDir = join(nodeModulesDir, name)
      let stat
      try {
        stat = statSync(pluginDir)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue

      const entryFile = this.resolvePluginEntry(pluginDir)
      if (!entryFile) {
        this.logger.warn({ pluginDir }, `npm 插件 ${name} 未找到入口文件，跳过`)
        continue
      }

      const integrityStatus = this.resolveScannedIntegrity(pluginDir, name, 'npm')
      if (integrityStatus === null) continue

      await this.loadFromFile(
        entryFile,
        'npm',
        false,
        undefined,
        undefined,
        undefined,
        integrityStatus,
        pluginDir
      )
    }
  }

  /**
   * 解析插件入口文件
   * 优先级：package.json main 字段 > index.js > index.ts
   */
  private resolvePluginEntry(pluginDir: string): string | undefined {
    const pkgJsonPath = join(pluginDir, 'package.json')
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
        if (typeof pkg.main === 'string' && pkg.main.length > 0) {
          const mainPath = resolve(pluginDir, pkg.main)
          if (existsSync(mainPath)) {
            return mainPath
          }
        }
      } catch {
        // 忽略 package.json 解析错误，继续尝试默认入口
      }
    }

    // 默认入口
    const indexJs = join(pluginDir, 'index.js')
    if (existsSync(indexJs)) return indexJs

    const indexTs = join(pluginDir, 'index.ts')
    if (existsSync(indexTs)) return indexTs

    return undefined
  }

  /**
   * 导入插件模块并解析出 Plugin 实例（供加载与候选先行重载共用）。
   *
   * @param bustCache true 时以 `?hot=<新代数>` 导入：配合 hot-module-cache
   *        的 resolve 钩子把整棵依赖子树换成全新 URL，多文件插件的子模块
   *        不再命中旧缓存
   * @throws 模块无法导入、未导出插件工厂、工厂执行失败或 manifest 非法时抛错；
   *         调用方决定错误是隔离吞掉（启动扫描）还是如实上抛（重载）
   */
  private async importPluginModule(filePath: string, bustCache = false): Promise<Plugin> {
    // ESM 重载：代数戳 + 解析钩子让整棵子树重新加载
    const fileUrl = bustCache
      ? `${pathToFileURL(filePath).href}?hot=${bumpHotGeneration()}`
      : pathToFileURL(filePath).href
    const mod = await import(fileUrl)

    // 支持 default 导出或命名导出
    const factory: PluginFactory | Plugin | undefined = mod.default ?? mod.createPlugin ?? mod.plugin
    if (!factory) {
      throw new Error('插件模块未导出 default / createPlugin / plugin')
    }

    let plugin: Plugin
    if (typeof factory === 'function') {
      plugin = await (factory as PluginFactory)()
    } else {
      plugin = factory
    }

    const manifest = plugin.manifest
    if (!manifest || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new Error('插件 manifest 缺少 name 或 version')
    }
    return plugin
  }

  /**
   * 从文件加载插件（错误隔离）
   * @param reload 是否为重载（添加时间戳 query 强制 ESM 重新加载）
   * @param config 插件配置（重载时恢复）
   * @param isolate 是否隔离运行（重载时恢复）
   * @param packageDir 插件包根目录（完整性校验的摘要范围；缺省取入口文件所在目录）
   */
  public async loadFromFile(
    filePath: string,
    source: 'local' | 'npm',
    reload = false,
    config?: Record<string, unknown>,
    isolate?: boolean,
    catalogId?: string,
    integrityStatus: 'verified' | 'unverified' = 'unverified',
    packageDir?: string
  ): Promise<void> {
    try {
      const plugin = await this.importPluginModule(filePath, reload)
      await this.loadPluginEntry(
        plugin,
        source,
        filePath,
        config,
        isolate,
        catalogId,
        integrityStatus,
        packageDir ?? resolve(filePath, '..')
      )
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.logger.error({ filePath, err }, `加载插件文件失败: ${errorMsg}`)
      // 错误隔离：不抛出，继续加载其他插件
    }
  }

  /** 加载插件实例到注册表（错误隔离） */
  public async loadPluginEntry(
    plugin: Plugin,
    source: 'builtin' | 'local' | 'npm',
    filePath?: string,
    config?: Record<string, unknown>,
    isolate?: boolean,
    catalogId?: string,
    integrityStatus?: 'verified' | 'unverified',
    packageDir?: string
  ): Promise<void> {
    try {
      const manifest = plugin.manifest
      if (!manifest || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
        throw new Error('插件 manifest 缺少 name 或 version')
      }

      // 如果未提供 catalogId，使用 manifest.name 作为默认值（向后兼容）
      const finalCatalogId = catalogId ?? manifest.name

      if (this.entries.has(manifest.name)) {
        this.logger.warn({ plugin: manifest.name }, '插件已存在，跳过重复加载')
        return
      }

      // 初始化能力授予：builtin 插件默认获得所有能力；local/npm 只授予 manifest.permissions 中声明的
      const allCapabilities: PluginCapability[] = [
        'tools.register',
        'agent.hooks',
        'provider.transform',
        'provider.observe',
        'routes.register',
        'storage.plugin',
        'ui.contribute',
        'network.outbound',
        'process.exec',
        'session.create',
        'agent.orchestrate',
        'confirmation.request',
        'media.generate'
      ]
      const configuredGrants =
        this.catalogConfigs.find((item) => item.catalogId === finalCatalogId)?.grants ?? []
      const grants = new Set<PluginCapability>()
      if (source === 'builtin') {
        // builtin 插件信任，授予所有能力。外部插件不能仅凭 manifest 自声明取得能力。
        for (const cap of allCapabilities) grants.add(cap)
      } else {
        // local/npm 只能使用宿主持久化的显式 grants，不能使用 manifest.permissions 自举。
        for (const cap of configuredGrants) {
          if (allCapabilities.includes(cap)) grants.add(cap)
        }
      }

      const entry: PluginEntry = {
        catalogId: finalCatalogId,
        pluginId: manifest.name,
        manifest,
        plugin,
        status: 'loaded',
        lifecycle: 'loaded',
        // 期望状态来自 catalog；未在 catalog 中出现的插件（如默认内置列表）默认期望启用。
        desiredEnabled:
          this.catalogConfigs.find((item) => item.catalogId === finalCatalogId)?.enabled ?? true,
        activationGeneration: 0,
        source,
        // builtin 随应用构建，不适用包级锁；local/npm 由调用方告知本次是否经过校验。
        integrityStatus: source === 'builtin' ? 'not-applicable' : (integrityStatus ?? 'unverified'),
        filePath,
        // 包根目录用于重载前的完整性锁复验；未显式提供时回退入口文件所在目录
        packageDir: source === 'builtin' ? undefined : (packageDir ?? (filePath ? resolve(filePath, '..') : undefined)),
        config: config ?? {},
        isolate: isolate ?? false,
        grants,
        restartRequired: false,
        unloadScope: 'none',
        effectiveAfterRestart: false,
        // 尚未 setup：留待 startPlugin 按当时的宿主阶段判定
        activationMountedByHost: false,
        effects: [],
        tools: [],
        routes: [],
        panels: [],
        uiContributions: [],
        eventHandlers: [],
        // 收集插件静态声明的迁移（在 setup 之前执行，确保 setup 时表已存在）
        migrations: [...(plugin.migrations ?? [])],
        settingsFields: [],
        sessionTools: [],
        services: [],
        promptTemplateDirs: [],
        providedServices: new Map()
      }
      this.entries.set(manifest.name, entry)
      this.logger.info(
        {
          plugin: manifest.name,
          catalogId: finalCatalogId,
          version: manifest.version,
          source,
          hasConfig: !!config
        },
        '插件已加载'
      )
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.logger.error({ err }, `加载插件实例失败: ${errorMsg}`)
    }
  }

  /** 启动单个插件（调用 setup，错误隔离） */
  private async startPlugin(name: string): Promise<void> {
    const entry = this.entries.get(name)
    if (!entry) return

    try {
      entry.lifecycle = 'starting'
      entry.activationGeneration += 1
      entry.runId = randomUUID()
      for (const effect of entry.effects) {
        if (effect.state === 'active') {
          effect.state = effect.unloadScope === 'restart-required' ? 'residual' : 'released'
          effect.disposedAt ??= Date.now()
        }
      }
      // 清空之前的注册项（防止重复启动累积）
      // 注意：migrations 保留静态声明的部分，setup 中通过 registerMigration 注册的会在 setup 时追加
      entry.tools = []
      entry.routes = []
      entry.panels = []
      entry.uiContributions = []
      entry.eventHandlers = []
      entry.migrations = [...(entry.plugin.migrations ?? [])]
      entry.settingsFields = []
      entry.sessionTools = []
      entry.services = []
      entry.promptTemplateDirs = []

      const context = this.createPluginContext(entry)
      try {
        await entry.plugin.setup(context)
      } catch (error) {
        // setup 可能已注册部分 EventBus/service；失败时必须走同一清理路径，
        // 防止重试累积幽灵 listener 或 stale service。
        for (const { type, handler } of entry.eventHandlers) this.eventBus.off(type, handler)
        for (const effect of entry.effects
          .filter((item) => item.activationGeneration === entry.activationGeneration)
          .reverse()) {
          try {
            await effect.dispose()
          } catch (cleanupError) {
            this.logger.warn(
              { plugin: name, effect: effect.kind, cleanupError },
              '插件 setup 失败清理 effect 失败'
            )
          }
        }
        for (const service of entry.services) {
          const pluginMap = this.serviceRegistry.get(service.name)
          pluginMap?.delete(entry.pluginId)
          if (pluginMap?.size === 0) this.serviceRegistry.delete(service.name)
        }
        entry.eventHandlers = []
        entry.services = []
        throw error
      }
      entry.status = 'enabled'
      entry.lifecycle = 'enabled'
      entry.error = undefined
      // route/service 只在宿主启动期被挂载：运行期 enable 的插件必须如实报告
      // "已 setup，但 route/service 要等重启才生效"。
      entry.activationMountedByHost = !this.hostMounted
      this.applyHostAttachment(entry)

      this.logger.info(
        {
          plugin: name,
          tools: entry.tools.length,
          routes: entry.routes.length,
          panels: entry.panels.length,
          eventHandlers: entry.eventHandlers.length,
          effectiveAfterRestart: entry.effectiveAfterRestart
        },
        '插件已启用'
      )
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      entry.status = 'error'
      entry.lifecycle = 'error'
      entry.error = errorMsg
      this.logger.error({ plugin: name, err }, `插件启动失败: ${errorMsg}`)
    }
  }

  /** 停止单个插件（调用 teardown 并取消事件订阅） */
  private async stopPlugin(name: string): Promise<void> {
    const entry = this.entries.get(name)
    if (!entry) return

    entry.lifecycle = 'stopping'
    // 调用 teardown（错误隔离）
    if (entry.plugin.teardown) {
      try {
        await entry.plugin.teardown()
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        this.logger.error({ plugin: name, err }, `插件 teardown 失败: ${errorMsg}`)
      }
    }

    // 取消所有事件订阅
    for (const { type, handler } of entry.eventHandlers) {
      this.eventBus.off(type, handler)
    }

    // 先移除 serviceRegistry 中属于本插件的实例，避免 proxy 继续返回 stale service。
    for (const service of entry.services) {
      const pluginMap = this.serviceRegistry.get(service.name)
      pluginMap?.delete(entry.pluginId)
      if (pluginMap?.size === 0) this.serviceRegistry.delete(service.name)
    }

    const stopErrors: string[] = []
    let disposedEffectCount = 0
    for (const effect of entry.effects
      .filter((item) => item.activationGeneration === entry.activationGeneration)
      .reverse()) {
      if (effect.state !== 'active') continue
      if (effect.unloadScope === 'restart-required' || effect.unloadScope === 'persistent') {
        effect.state = 'residual'
        continue
      }
      try {
        await effect.dispose()
        disposedEffectCount += 1
      } catch (error) {
        stopErrors.push(error instanceof Error ? error.message : String(error))
      }
    }

    // 检测残留：如果 routes 或 services 非空，说明有 Fastify 路由/服务未卸载
    const hasResidualRoutes = entry.routes.length > 0
    const hasResidualServices = entry.services.length > 0
    const restartRequired = hasResidualRoutes || hasResidualServices

    // 清除 tools/panels/eventHandlers/migrations/sessionTools/promptTemplateDirs
    // 但保留 routes 和 services 如果有残留，以便 list 能显示实际残留状态
    entry.tools = []
    entry.panels = []
    entry.eventHandlers = []
    entry.migrations = []
    entry.settingsFields = []
    entry.sessionTools = []
    entry.promptTemplateDirs = []
    if (!restartRequired) {
      entry.routes = []
      entry.services = []
    }
    entry.status = 'disabled'
    entry.lifecycle = 'disabled'
    entry.restartRequired = restartRequired
    entry.unloadScope = restartRequired ? 'restart-required' : 'none'
    entry.lastStop = {
      outcome: stopErrors.length > 0 ? 'failed' : restartRequired ? 'partial' : 'completed',
      activationGeneration: entry.activationGeneration,
      disposedEffectCount,
      residualEffectCount: entry.effects.filter((effect) => effect.state === 'residual').length,
      errors: stopErrors,
      at: Date.now()
    }

    this.logger.info(
      {
        plugin: name,
        restartRequired,
        routesCount: entry.routes.length,
        servicesCount: entry.services.length
      },
      '插件已禁用'
    )
  }

  /** 创建插件上下文 */
  private createPluginContext(entry: PluginEntry): PluginContext {
    const pluginName = entry.manifest.name
    const logger = this.logger.child({ plugin: pluginName })
    const hostDb = this.db
    const pluginDataDir = join(this.dataDir, 'plugins', entry.pluginId)
    // 约定辅助：把相对路径钉在 dataDir 内，越界抛错。
    // 这不是沙箱——插件仍可直接 import 'node:fs' 绕过（强制边界需 Worker/独立进程，属 P3）。
    // 提供它的目的是让"插件该往哪写"只有一个答案，将来收口时只改这一处。
    const resolvePluginPath = (...segments: string[]): string =>
      resolveWithin(
        pluginDataDir,
        segments,
        (attempted) => `插件 ${pluginName} 的路径 ${attempted} 越出 dataDir 边界，已拒绝`
      )
    const execPluginCommand = async (command: string): Promise<string> => {
      if (!/^[A-Za-z0-9._-]+(?:\s+[^;&|<>$`]+)?$/.test(command)) {
        throw new Error('process.exec 仅允许无 shell 的命令和参数')
      }
      const { execFile } = await import('node:child_process')
      return new Promise<string>((resolve, reject) => {
        execFile(
          command.split(/\s+/)[0],
          command.split(/\s+/).slice(1),
          {
            cwd: pluginDataDir,
            shell: false,
            timeout: 30_000,
            maxBuffer: 256 * 1024
          },
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error(stderr.trim() || error.message))
              return
            }
            resolve(stdout)
          }
        )
      })
    }
    const fetchPluginUrl = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('network.fetch 仅允许 HTTP(S)')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000)
      try {
        return await fetch(url, { ...init, signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
    }
    // 对象字面量 getter 内的 this 指向字面量自身，因此通过闭包延迟读取。
    const getModelRegistry = (): ModelRegistryLike | undefined =>
      this.modelRegistry as ModelRegistryLike | undefined
    const getMediaGenerator = (): PluginContext['media'] => this.mediaGenerator

    const registerEffect = (
      kind: string,
      metadata: PluginEffectMetadata,
      setup: () => PluginEffectDisposer | void
    ): PluginEffectDisposer => {
      const disposer = setup()
      const effect: PluginEffectRecord = {
        id: `${entry.pluginId}:${entry.activationGeneration}:${randomUUID()}`,
        kind,
        resourceId: String(metadata.resourceId ?? kind),
        owner: String(metadata.owner ?? entry.pluginId),
        activationGeneration: entry.activationGeneration,
        unloadScope: metadata.unloadScope ?? 'immediate',
        state: 'active',
        hostAttached: metadata.hostAttached !== false,
        createdAt: Date.now(),
        disposeAttempts: 0,
        dispose: async () => {
          const current = entry.effects.find((candidate) => candidate.id === effect.id)
          if (!current || current.state === 'released') return
          current.disposeAttempts += 1
          try {
            if (disposer) await disposer()
            current.state = 'released'
            current.disposedAt = Date.now()
          } catch (error) {
            current.state = 'failed'
            current.lastError = error instanceof Error ? error.message : String(error)
            throw error
          }
        }
      }
      entry.effects.push(effect)
      return effect.dispose
    }

    const pushTrackedEffect = (
      kind: string,
      resourceId: string,
      disposer: PluginEffectDisposer,
      metadata: PluginEffectMetadata = {}
    ): PluginEffectDisposer => {
      const normalized: PluginEffectMetadata = {
        resourceId,
        owner: entry.pluginId,
        ...metadata
      }
      return registerEffect(kind, normalized, () => disposer)
    }

    return {
      pluginName,
      config: entry.config ?? {},
      logger,
      // DB 访问按 capability 判定而非按 source 判定：builtin 默认持有全部
      // capability，local/npm 必须由宿主显式授予 storage.plugin。
      // 与 registerMigration / registerService 使用同一条 grant，避免出现
      // "能注册迁移但拿不到连接"的半可用状态。
      get db(): Database.Database {
        if (!entry.grants.has('storage.plugin')) {
          throw new Error(`插件 ${pluginName} 未获得 storage.plugin 能力，无法访问数据库`)
        }
        return hostDb
      },
      cwd: entry.source === 'builtin' ? this.cwd : pluginDataDir,
      dataDir: pluginDataDir,
      resolvePath: resolvePluginPath,
      registerBackgroundWork: (name: string, provider: BackgroundWorkProvider) => {
        if (!this.backgroundWorkRegistry) {
          throw new Error(`插件 ${pluginName} 无法注册后台工作 provider：宿主未提供 BackgroundWorkRegistry`)
        }
        const dispose = this.backgroundWorkRegistry.register(name, provider)
        pushTrackedEffect(
          'background-work',
          name,
          dispose,
          { unloadScope: 'immediate' },
        )
      },
      ...(entry.grants.has('process.exec') ? { process: { exec: execPluginCommand } } : {}),
      ...(entry.grants.has('network.outbound') ? { network: { fetch: fetchPluginUrl } } : {}),
      // 编排类宿主管理器同样按 capability 条件注入，与 process / network 一致：
      // 未授予 agent.orchestrate 的插件拿到 undefined，而不是可用的原始管理器。
      ...(entry.grants.has('agent.orchestrate')
        ? {
            subagentManager: this.agentManager,
            teamManager: this.teamManager,
            agentCallLogger: this.agentCallLogger
          }
        : {}),
      ...(entry.grants.has('confirmation.request')
        ? { confirmationManager: this.confirmationManager }
        : {}),
      get media(): PluginContext['media'] {
        return entry.grants.has('media.generate') ? getMediaGenerator() : undefined
      },
      // getter 而非直接取值：setModelRegistry 在 app.ts 启动后期才调用，
      // 晚于插件 setup（createPluginContext 构建本 context 的时机），
      // 直接传 this.modelRegistry 会把 undefined 固化进 context。
      get modelRegistry(): ModelRegistryLike | undefined {
        return getModelRegistry()
      },
      effect: registerEffect,
      registerDisposable: (dispose: PluginEffectDisposer, metadata: PluginEffectMetadata = {}) =>
        registerEffect('disposable', metadata, () => dispose),
      trackSession: (handle: PluginSessionHandle, metadata: PluginEffectMetadata = {}) =>
        registerEffect('session', metadata, () => async () => {
          handle.abort()
          handle.dispose()
        }),
      registerTool: (tool: ToolDefinition) => {
        if (!entry.grants.has('tools.register')) {
          throw new Error(
            `插件 ${pluginName} 未获得 tools.register 能力，无法注册工具 ${tool.name}`
          )
        }
        entry.tools.push(tool)
        pushTrackedEffect(
          'tool',
          tool.name,
          () => {
            entry.tools = entry.tools.filter((candidate) => candidate !== tool)
          },
          { unloadScope: 'immediate' }
        )
        logger.debug({ tool: tool.name }, '工具已注册')
      },
      registerRoute: (route: RouteDefinition) => {
        if (!entry.grants.has('routes.register')) {
          throw new Error(
            `插件 ${pluginName} 未获得 routes.register 能力，无法注册路由 ${route.method} ${route.path}`
          )
        }
        entry.routes.push(route)
        pushTrackedEffect(
          'route',
          `${route.method}:${route.path}`,
          () => {
            entry.routes = entry.routes.filter((candidate) => candidate !== route)
          },
          { unloadScope: 'restart-required', hostAttached: false }
        )
        logger.debug({ method: route.method, path: route.path }, '路由已注册')
      },
      onEvent: (type: string, handler: EventHandler) => {
        if (!entry.grants.has('agent.hooks')) {
          throw new Error(`插件 ${pluginName} 未获得 agent.hooks 能力，无法注册事件监听 ${type}`)
        }
        this.eventBus.on(type, handler)
        const eventRegistration = { type, handler }
        entry.eventHandlers.push(eventRegistration)
        pushTrackedEffect(
          'event',
          type,
          () => {
            this.eventBus.off(type, handler)
            entry.eventHandlers = entry.eventHandlers.filter(
              (candidate) => candidate !== eventRegistration
            )
          },
          { unloadScope: 'immediate' }
        )
        logger.debug({ event: type }, '事件监听已注册')
      },
      registerPanel: (panel: PanelDefinition) => {
        if (!entry.grants.has('ui.contribute')) {
          throw new Error(
            `插件 ${pluginName} 未获得 ui.contribute 能力，无法注册 UI 面板 ${panel.id}`
          )
        }
        entry.panels.push(panel)
        const slot =
          panel.slot ??
          (panel.position === 'sidebar'
            ? 'app.navigation'
            : panel.position === 'main'
              ? 'workspace.main'
              : 'right-panel.tab')
        const scope =
          panel.scope ?? (slot === 'workspace.main' || slot === 'right-panel.tab' ? 'page' : 'app')
        const allowedSlots: PluginUiContribution['slot'][] = [
          'app.navigation',
          'workspace.main',
          'right-panel.tab',
          'tool.detail',
          'trace.detail',
          'plugin-page.top',
          'plugin-settings',
          'home.showcase',
          'home.actions',
          'home.hero-aside',
          'home.footer'
        ]
        const state: PluginUiContribution['state'] =
          panel.rendererKey && allowedSlots.includes(slot) ? 'active' : 'invalid'
        entry.uiContributions.push({
          contributionId: panel.id,
          // title 转为显示名：右栏 tab 等位置需要人类可读标签，
          // 否则只能展示 contributionId 这类技术 id
          ...(panel.title ? { label: panel.title } : {}),
          slot,
          scope,
          priority: panel.priority ?? 0,
          rendererKey: panel.rendererKey ?? panel.component,
          entryKey: panel.entryKey,
          props: panel.props,
          state
        })
        pushTrackedEffect(
          'panel',
          panel.id,
          () => {
            entry.panels = entry.panels.filter((candidate) => candidate !== panel)
            entry.uiContributions = entry.uiContributions.filter(
              (candidate) => candidate.contributionId !== panel.id
            )
          },
          { unloadScope: 'immediate' }
        )
        logger.debug(
          { panel: panel.id, slot, rendererKey: panel.rendererKey ?? panel.component },
          'UI 面板已注册'
        )
      },
      registerSettings: (fields: PluginSettingField[]) => {
        if (!entry.grants.has('ui.contribute')) {
          throw new Error(
            `插件 ${pluginName} 未获得 ui.contribute 能力，无法声明设置项`
          )
        }
        if (!Array.isArray(fields)) {
          throw new Error(`插件 ${pluginName} registerSettings 需要字段数组`)
        }
        // 同键重复声明以最后一次为准；非法字段整体拒绝而不是静默跳过，
        // 否则桌面渲染器会拿到半残 schema 生成出不可用的表单
        const seen = new Set<string>()
        for (const field of fields) {
          if (
            !field ||
            typeof field.key !== 'string' ||
            field.key.length === 0 ||
            typeof field.label !== 'string' ||
            !['string', 'number', 'boolean', 'select', 'textarea'].includes(field.type)
          ) {
            throw new Error(`插件 ${pluginName} 声明了非法的设置字段：${JSON.stringify(field)}`)
          }
          if (field.type === 'select' && (!field.options || field.options.length === 0)) {
            throw new Error(`插件 ${pluginName} 的 select 设置 ${field.key} 缺少 options`)
          }
          if (seen.has(field.key)) {
            throw new Error(`插件 ${pluginName} 重复声明设置字段 ${field.key}`)
          }
          seen.add(field.key)
        }
        entry.settingsFields = [...fields]
        pushTrackedEffect(
          'settings',
          `${entry.pluginId}:settings`,
          () => {
            entry.settingsFields = []
          },
          { unloadScope: 'immediate' }
        )
        logger.debug({ count: fields.length }, '设置 schema 已声明')
      },
      registerMigration: (migration: MigrationDefinition) => {
        if (!entry.grants.has('storage.plugin')) {
          throw new Error(
            `插件 ${pluginName} 未获得 storage.plugin 能力，无法注册数据库迁移 ${migration.id}`
          )
        }
        entry.migrations.push(migration)
        logger.debug({ migrationId: migration.id }, '已注册数据库迁移')
      },
      registerSessionTools: (tools: PiToolDefinition[]) => {
        if (!entry.grants.has('tools.register')) {
          throw new Error(`插件 ${pluginName} 未获得 tools.register 能力，无法注册 Session 工具`)
        }
        entry.sessionTools.push(...tools)
        logger.debug({ count: tools.length }, '已注册 Session 工具')
      },
      registerService: (name: string, service: unknown) => {
        if (!entry.grants.has('storage.plugin')) {
          throw new Error(`插件 ${pluginName} 未获得 storage.plugin 能力，无法注册服务 ${name}`)
        }
        entry.services.push({ name, service })
        // 注册到 serviceRegistry 以便动态查找和替换
        if (!this.serviceRegistry.has(name)) {
          this.serviceRegistry.set(name, new Map())
        }
        const pluginMap = this.serviceRegistry.get(name)!
        pluginMap.set(entry.pluginId, { service, pluginId: entry.pluginId })
        pushTrackedEffect(
          'service',
          name,
          () => {
            const current = this.serviceRegistry.get(name)
            current?.delete(entry.pluginId)
            if (current?.size === 0) this.serviceRegistry.delete(name)
            entry.services = entry.services.filter(
              (candidate) => candidate.name !== name || candidate.service !== service
            )
          },
          { unloadScope: 'restart-required', hostAttached: true }
        )
        logger.debug(
          { serviceName: name, pluginId: entry.pluginId },
          '已注册 Fastify 服务（可替换）'
        )
      },
      registerPromptTemplates: (dir: string) => {
        // 提示词模板注册不需要特殊能力
        entry.promptTemplateDirs.push(dir)
        logger.debug({ dir }, '已注册提示词模板目录')
      },
      createSession: async (options: PluginSessionOptions): Promise<PluginSessionHandle> => {
        // 创建独立 Pi Session 会消耗模型额度并拿到工具集，属高风险能力：
        // 与 registerTool / registerRoute 同样按 grant 判定，local/npm 默认拒绝。
        if (!entry.grants.has('session.create')) {
          throw new Error(`插件 ${pluginName} 未获得 session.create 能力，无法创建 Session`)
        }
        // AgentRuntime 路由（方案 §9.3）：默认 'pi-session' 走下方内联实现；
        // 第三方运行时（pi-subagents / pi-actors 等）通过 PluginManagerOptions
        // 注入的注册表承载，未注册的 kind 显式抛错。
        const runtimeKind = options.runtime ?? DEFAULT_AGENT_RUNTIME_KIND
        if (runtimeKind !== DEFAULT_AGENT_RUNTIME_KIND) {
          const runtime = this.runtimeRegistry.get(runtimeKind)
          if (!runtime) {
            throw new Error(
              `未注册的 AgentRuntime: ${runtimeKind}（可用: ${this.runtimeRegistry.listKinds().join(', ') || '无'}）`
            )
          }
          return runtime.createSession(options)
        }

        if (!this.sessionStore) {
          throw new Error('SessionStore 未注入，无法创建 Pi Session')
        }

        const threadId = `plugin:${pluginName}:${randomUUID()}`
        const trace = options.trace
          ? this.tracer?.startTrace({
              sessionId: options.trace.sessionId,
              runId: options.trace.runId,
              metadata: {
                pluginName,
                ...(options.trace.metadata ?? {})
              }
            })
          : undefined
        let traceFinished = false
        const recordTraceEvent = (
          type: TraceEventType,
          data: Record<string, unknown>,
          sourceEventSeqs?: number[],
          status: EventStatus = 'completed'
        ): number | undefined => {
          if (!trace || !this.tracer) return undefined
          try {
            return this.tracer.addEvent(trace.id, { type, data, sourceEventSeqs, status }).seq
          } catch (err) {
            logger.debug({ err, traceId: trace.id, type }, '插件 Session 追踪事件写入失败')
            return undefined
          }
        }
        const finishTrace = (
          status: 'completed' | 'failed' | 'aborted',
          terminalData?: Record<string, unknown>
        ): void => {
          if (!trace || !this.tracer || traceFinished) return
          traceFinished = true
          try {
            this.tracer.finishTrace(trace.id, status, terminalData)
          } catch (err) {
            logger.debug({ err, traceId: trace.id }, '插件 Session 追踪结束写入失败')
          }
        }

        // 多 Skill 白名单（方案 §9.1）：主 skill + extraSkills 全部只经
        // additionalSkillPaths 定向加载，不扫描环境中的其他 Skills。
        const authorizedSkills = [
          ...(options.skill ? [options.skill] : []),
          ...(options.extraSkills ?? [])
        ]

        // 构建 AgentConfig，通过 withAgentConfig 注入 systemPrompt 到 system role。
        // createPiSession 内的 buildSystemPrompt 会从 agentConfigStorage 读取
        // systemPrompt 并拼入系统提示词的 `## Agent 自定义指令` 部分
        // （参考 core/agent/pi-session.ts），不再拼接到 userMessage 头部，
        // 从而保持 userMessage 纯净，不破坏 prompt cache 前缀匹配。
        //
        // ⚠️ tools 双轨透传：options.tools 是 PiToolDefinition[]（含 execute 实现）。
        // - tools: string[] — 工具名白名单，用于过滤 pluginSessionTools
        // - extraTools: ToolDefinition[] — 携带 execute 实现的工具实例，直接加入 customTools
        //
        // 双轨的原因：pluginSessionTools 是全局静态注册的工具（如 novel_save_chapter），
        // 只需要名字白名单过滤即可复用；而 extraTools 是 per-call 闭包工具
        // （如 novel_submit_narrative_task，绑定 draft 对象），其实例不在 pluginSessionTools 中，
        // 必须通过 extraTools 携带 execute 实现注入到 customTools，否则 LLM 看不到工具。
        //
        // 三种语义：
        // - options.tools === undefined → 不透传 → AgentConfig.tools undefined → 不过滤（默认 Agent）
        // - options.tools === [] → 透传 tools: [] → 清空 customTools（Writer/Reviewer 无工具场景）
        // - options.tools === [...] → 透传 tools: [...] + extraTools: [...] → 白名单过滤 + 闭包工具注入
        //
        // 之前用 `length > 0` 判断导致 tools=[] 被误解为"不过滤"，customTools 保留全部。
        // 现在 Array.isArray 区分 undefined 和 []：[] 也透传，pi-session 看到 [] 后清空。
        const agentConfig: AgentConfig = {
          id: `plugin-session-${randomUUID()}`,
          name: `${pluginName} session`,
          systemPrompt: options.systemPrompt,
          ...(options.modelId ? { model: options.modelId } : {}),
          ...(authorizedSkills.length > 0
            ? { skillPaths: authorizedSkills.map((s) => s.path) }
            : {}),
          ...(Array.isArray(options.tools)
            ? {
                tools: options.tools.map((t) => t.name),
                extraTools: options.tools
              }
            : {}),
          // 受限 skill_read（方案 §9.2）：仅当本次会话显式授权了 Skill 且调用方
          // 声明 skillRead 时注入；授权范围绑定到本次会话的 skill 根目录。
          ...(options.skillRead && authorizedSkills.length > 0
            ? {
                extraTools: [
                  ...(Array.isArray(options.tools) ? options.tools : []),
                  createSkillReadTool(options.skillRead)
                ]
              }
            : {})
        }

        // 在 withAgentConfig 上下文中创建 session：
        // buildSystemPrompt 在 resourceLoader.reload() 时被调用，因此
        // 必须在 session 创建期间持有 agentConfigStorage 上下文。
        const threadSession = await withAgentConfig(agentConfig, async () => {
          return await this.sessionStore!.getOrCreate(threadId)
        })

        if (authorizedSkills.length > 0) {
          const loadedSkills = threadSession.session.resourceLoader.getSkills().skills as Array<{
            name: string
            filePath: string
          }>
          for (const authorized of authorizedSkills) {
            const loaded = loadedSkills.find((skill) => skill.name === authorized.name)
            if (!loaded || resolve(loaded.filePath) !== resolve(authorized.path)) {
              throw new Error(`插件 Session 未能加载授权 Skill: ${authorized.name}`)
            }
          }
          // 增强：Skill 内容指纹审计（SHA-256 前 16 位），用于规则漂移检测与日志留痕。
          const fingerprints = authorizedSkills.map((skill) => {
            let fingerprint = ''
            try {
              fingerprint = fingerprintSkillContent(readFileSync(skill.path, 'utf-8'))
            } catch {
              fingerprint = '(unreadable)'
            }
            return { name: skill.name, fingerprint }
          })
          logger.info(
            { threadId, skillFingerprints: fingerprints },
            '插件 Session 已加载授权 Skill（指纹审计）'
          )
        }

        // 注入 SEMI 层前缀消息（章节上下文）：作为独立首条 user 消息加入对话历史，
        // 不触发 LLM 调用。这样 LLM 收到的对话为 system → prefixUserMessage → userMessage，
        // prefixUserMessage 跨 Agent 稳定，可被 prompt cache 命中。
        //
        // 支持 string | string[]：数组时每条作为独立 user 消息注入，各自打 cache_control
        // breakpoint。用于"共享前缀 + Agent 专属后缀"分离，最大化跨 Agent 缓存命中。
        if (options.prefixUserMessage) {
          const piSession = threadSession.session as {
            agent?: { state?: { messages?: unknown[] } }
          }
          if (piSession.agent?.state) {
            const prefixes = Array.isArray(options.prefixUserMessage)
              ? options.prefixUserMessage
              : [options.prefixUserMessage]
            const now = Date.now()
            const prefixMessages = prefixes.map((content, i) => ({
              role: 'user',
              content,
              timestamp: now + i
            }))
            const existing = piSession.agent.state.messages ?? []
            piSession.agent.state.messages = [...existing, ...prefixMessages]
            logger.debug(
              {
                threadId,
                prefixCount: prefixMessages.length,
                prefixLengths: prefixes.map((p) => p.length)
              },
              '已注入 SEMI 层前缀消息（每条独立打 cache_control breakpoint）'
            )
          } else {
            logger.warn(
              { threadId },
              '无法注入前缀消息：session.agent.state 不可用，将回退到拼接模式'
            )
          }
        }

        // 收集 assistant 文本（事件格式参考 core/agent/stream-emitter.ts）
        let completeText = ''
        // 进行中的工具调用 seq：收尾时用 sourceEventSeqs 把 tool_result 关联到 tool_call
        const pendingToolCallSeqs = new Map<string, number>()
        // Pi SDK 在 LLM 调用失败时不抛异常，而是产生 stopReason="error" 的 message_end 事件。
        // 这里捕获错误信息，供 prompt/promptStream 在调用后检查并抛出，避免"空响应+success"的假象。
        let lastErrorMessage = ''
        /**
         * 本轮是否已收到成功的终答 assistant 消息（stopReason=stop/length）。
         *
         * 终答之后 Pi Session 仍会继续往返（自动压缩等维护动作），这些往返同样会
         * emit `message_end`。若把其中的 `stopReason='error'` 计入 `lastErrorMessage`，
         * 已经完整产出的正文会被判定为失败 —— 实测 Writer 写满 3868 字（trace 里
         * llm_response 已记 completed），却因产出后一次 "A server error occurred"
         * 让整章 create-flow 作废。终答落地后的失败只记日志，不污染本轮结果。
         */
        let sawFinalAssistantSuccess = false
        let resolveFinalAssistant: (() => void) | undefined
        // ── 临时诊断（2026-08-26 群聊 Director 空响应）：统计全部 assistant 事件类型
        //    与 reasoning/text 各自的字符量。排查完删除。
        const diagEventTypes = new Map<string, number>()
        let diagTextChars = 0
        let diagReasoningChars = 0
        const unsubscribe = threadSession.session.subscribe((event: Record<string, unknown>) => {
          // 工具执行打点：Pi 的 tool_execution_* 事件之前从未进 trace，
          // 导致插件 Session 时间线上看不到任何 tool_call / tool_result。
          if (event.type === 'tool_execution_start') {
            const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : ''
            const callSeq = recordTraceEvent('tool_call', {
              source: 'plugin-session',
              toolCallId,
              toolName: (event.toolName as string) ?? 'unknown',
              args: summarizeToolArgsForTrace(event.args)
            }, undefined, 'pending')
            if (callSeq !== undefined && toolCallId) {
              pendingToolCallSeqs.set(toolCallId, callSeq)
            }
            return
          }
          if (event.type === 'tool_execution_end') {
            const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : ''
            const callSeq = toolCallId ? pendingToolCallSeqs.get(toolCallId) : undefined
            if (toolCallId) pendingToolCallSeqs.delete(toolCallId)
            recordTraceEvent('tool_result', {
              source: 'plugin-session',
              toolCallId,
              toolName: (event.toolName as string) ?? 'unknown',
              isError: event.isError === true
            }, callSeq === undefined ? undefined : [callSeq], event.isError === true ? 'failed' : 'completed')
            return
          }
          if (event.type === 'message_end') {
            const message = event.message as Record<string, unknown> | undefined
            const terminalError = getAssistantTerminalError(message, {
              requireComplete: options.responseFormat === 'json'
            })
            cancelDebug('message_end-received', {
              threadId,
              stopReason: message?.stopReason,
              hasError: !!terminalError,
              errorMessage: terminalError || undefined
            })
            if (sessionDiag.enabled) {
              const blocks = Array.isArray(message?.content)
                ? (message?.content as Array<Record<string, unknown>>).map(block => ({
                    type: String(block?.type ?? 'unknown'),
                    chars:
                      typeof block?.text === 'string'
                        ? block.text.length
                        : typeof block?.thinking === 'string'
                          ? block.thinking.length
                          : 0,
                  }))
                : undefined
              sessionDiag.messageEnd({
                threadId,
                stopReason: message?.stopReason,
                role: message?.role,
                provider: message?.provider,
                model: message?.model,
                usageRaw: message?.usage,
                textChars: diagTextChars,
                reasoningChars: diagReasoningChars,
                contentBlocks: blocks,
                assistantEventTypes: Object.fromEntries(diagEventTypes),
                errorMessage: terminalError ?? undefined,
              })
              diagEventTypes.clear()
              diagTextChars = 0
              diagReasoningChars = 0
            }
            if (terminalError !== null && !sawFinalAssistantSuccess) {
              lastErrorMessage = terminalError
            }
            if (terminalError) {
              logger.error(
                {
                  threadId,
                  errorMessage: terminalError,
                  provider: message?.provider,
                  model: message?.model,
                  afterFinalAssistant: sawFinalAssistantSuccess
                },
                sawFinalAssistantSuccess
                  ? 'Pi Session 终答之后的维护往返失败（不影响本轮结果）'
                  : 'Pi Session LLM 调用失败（message_end stopReason=error）'
              )
            }
            if (isFinalAssistantSuccess(message)) {
              sawFinalAssistantSuccess = true
              resolveFinalAssistant?.()
            }
            return
          }
          if (event.type !== 'message_update') return
          const assistantMessageEvent = event.assistantMessageEvent as
            | Record<string, unknown>
            | undefined
          if (!assistantMessageEvent) return
          if (sessionDiag.enabled) {
            const eventType = String(assistantMessageEvent.type ?? 'unknown')
            diagEventTypes.set(eventType, (diagEventTypes.get(eventType) ?? 0) + 1)
            const deltaLen =
              typeof assistantMessageEvent.delta === 'string' ? assistantMessageEvent.delta.length : 0
            if (eventType === 'text_delta') {
              diagTextChars += deltaLen
            } else if (eventType.includes('think') || eventType.includes('reason')) {
              diagReasoningChars += deltaLen
            }
          }
          if (assistantMessageEvent.type !== 'text_delta') return
          const delta = (assistantMessageEvent.delta as string) ?? ''
          completeText += delta
        })

        const runSinglePromptTurn = async (nextUserMessage?: string): Promise<void> => {
          if (sessionDiag.enabled) {
            sessionDiag.turnStart({
              threadId,
              hasTools: Array.isArray(options.tools) ? options.tools.length : 0,
              toolNames: (options.tools as Array<{ name?: string }> | undefined)?.map(t => t?.name ?? '?') ?? [],
              modelId: options.modelId
                ? `${options.modelId.provider}/${options.modelId.modelId}`
                : undefined,
              thinkingLevel: options.modelId?.thinkingLevel,
              temperature: options.temperature,
              responseFormat: options.responseFormat,
              maxTokens: effectiveMaxTokens,
              userMessageChars:
                (nextUserMessage === undefined ? options.userMessage : nextUserMessage).length,
            })
          }
          const visibleMessage =
            nextUserMessage === undefined ? options.userMessage : nextUserMessage
          const userSeq = recordTraceEvent('user_message', {
            source: 'plugin-session',
            length: visibleMessage.length,
            preview: visibleMessage.slice(0, 500)
          })
          const requestSeq = recordTraceEvent(
            'llm_request',
            {
              source: 'plugin-session',
              modelId: options.modelId,
              responseFormat: options.responseFormat ?? 'text'
            },
            userSeq === undefined ? undefined : [userSeq]
          )
          const timeoutMs = options.timeoutMs ?? runtimePerformance.llm.timeoutMs
          // ── 多轮 prompt 串行化（同会话分包/修复轮的生命线）──
          //
          // waitForFinalAssistantOrPrompt 刻意只等最终 assistant 消息、不等 Pi 的完整
          // prompt 生命周期（一次性 create-flow Agent 不该被自动压缩阻塞）。但 Pi 的
          // AgentSession.prompt() 在上一轮未走完（isStreaming=true）时会抛
          // "Agent is already processing"。两者组合下，同一 Session 的第二次
          // prompt(message) 必然撞上未结束的上一轮。
          //
          // 现有依赖方：reference-analysis-run-worker / beat-plan-generator /
          // chapter-outline-generator 的「协议解析失败后同会话修复轮」。
          //
          // 处理：发起本轮之前，先等上一次 prompt 的**完整生命周期**落定。
          // - 本轮自己的返回时机不变（终态消息即返回，仍不被压缩阻塞）；
          // - 栅栏加上与本次调用相同的超时上限：provider 挂死时不会把队列永久卡住，
          //   超限放行后下一轮会撞守卫并得到可观测的错误；
          // - 从栅栏放行到登记新 promptPromise 之间全部同步，并发 prompt 也严格排队。
          await Promise.race([
            lastPluginPromptSettled,
            new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
          ])
          let resolveCurrentFinalAssistant: (() => void) | undefined
          const finalAssistantPromise = new Promise<void>((resolve) => {
            resolveCurrentFinalAssistant = resolve
            resolveFinalAssistant = resolve
          })
          const promptPromise = withAgentConfig(agentConfig, async () => {
            await threadSession.session.prompt(
              nextUserMessage === undefined
                ? buildPluginSessionPrompt(options.userMessage, options.skill, options.extraSkills)
                : nextUserMessage
            )
          })
          lastPluginPromptSettled = promptPromise.then(
            () => undefined,
            () => undefined
          )

          try {
            await waitForFinalAssistantOrPrompt({
              promptPromise,
              finalAssistantPromise,
              timeoutMs
            })
            // Pi SDK 的 stopReason='error' 可能让 prompt 生命周期正常 resolve。
            // 在写入成功响应前检查终态，避免时间线出现“成功响应”后又失败的假象。
            if (lastErrorMessage) {
              throw new Error(`LLM 调用失败: ${lastErrorMessage}`)
            }
            recordTraceEvent(
              'llm_response',
              {
                source: 'plugin-session',
                length: completeText.length,
                preview: completeText.slice(0, 500)
              },
              requestSeq === undefined ? undefined : [requestSeq]
            )
            recordTraceEvent(
              'assistant_message',
              {
                source: 'plugin-session',
                length: completeText.length,
                preview: completeText.slice(0, 500)
              },
              requestSeq === undefined ? undefined : [requestSeq]
            )
          } catch (error) {
            finishTrace(options.signal?.aborted ? 'aborted' : 'failed', {
              source: 'plugin-session',
              message: error instanceof Error ? error.message : String(error),
              ...(requestSeq === undefined ? {} : { sourceEventSeq: requestSeq })
            })
            throw error
          } finally {
            if (resolveFinalAssistant === resolveCurrentFinalAssistant) {
              resolveFinalAssistant = undefined
            }
          }
        }

        /** 最近一次 prompt 的完整生命周期落定信号（成功/失败都算落定）；见上方串行化说明。 */
        let lastPluginPromptSettled: Promise<void> = Promise.resolve()

        const runPromptUntilFinalAssistant = async (nextUserMessage?: string): Promise<void> => {
          await runSinglePromptTurn(nextUserMessage)
        }

        // 模型切换（如指定）+ 读取模型 maxTokens 配置
        let modelMaxTokens: number | undefined
        /**
         * 目标模型的 provider / baseUrl，用于判断是否接受 Anthropic 风格 cache_control。
         *
         * 从 modelRegistry 解析：options.modelId 只有 provider + modelId，
         * baseUrl 要查注册表才能拿到（用户可能给自定义 provider 配了 Anthropic 端点）。
         */
        let cacheControlTarget: { provider?: string; modelId?: string; baseUrl?: string } = {}
        if (options.modelId) {
          if (!this.modelRegistry) {
            const message = `无法使用所选模型：ModelRegistry 未注入 (${options.modelId.provider}/${options.modelId.modelId})`
            finishTrace('failed', { source: 'plugin-session', message })
            throw new Error(message)
          }
          const targetModel = this.modelRegistry.find(
            options.modelId.provider,
            options.modelId.modelId
          )
          if (!targetModel) {
            const message = `未找到所选模型：${options.modelId.provider}/${options.modelId.modelId}`
            finishTrace('failed', { source: 'plugin-session', message })
            throw new Error(message)
          }
          await threadSession.session.setModel(targetModel)
          if (options.modelId.thinkingLevel) {
            threadSession.session.setThinkingLevel(options.modelId.thinkingLevel)
          }
          modelMaxTokens = targetModel.maxTokens
          cacheControlTarget = {
            provider: options.modelId.provider,
            modelId: options.modelId.modelId,
            baseUrl: (targetModel as { baseUrl?: string }).baseUrl
          }
        } else if (this.modelRegistry?.getAll) {
          // 未指定 modelId 时，尝试从注册表第一个模型读取 maxTokens
          const allModels = this.modelRegistry.getAll() as Array<{
            maxTokens?: number
            provider?: string
            id?: string
            baseUrl?: string
          }>
          if (allModels.length > 0 && allModels[0].maxTokens) {
            modelMaxTokens = allModels[0].maxTokens
          }
          // 走默认模型时同样要判定：默认 Provider 也可能不是 Anthropic
          if (allModels.length > 0) {
            cacheControlTarget = {
              provider: allModels[0].provider,
              modelId: allModels[0].id,
              baseUrl: allModels[0].baseUrl
            }
          }
        }

        const cacheControlSupported = supportsAnthropicCacheControl(cacheControlTarget)
        // OpenAI 的 prompt_cache_key 是路由提示：相同 key 尽量导到同一台机器，
        // 才可能命中那台机器上的前缀缓存。pi-ai 默认用 sessionId，而我们每次
        // runAgent 都新建 session → 随机 key → 同一章的多个 Agent 各走一台机器，
        // 共享前缀白建。有 promptCacheScope 时改用稳定 key。
        const promptCacheKey =
          options.promptCacheScope && usesOpenAiPromptCacheKey(cacheControlTarget)
            ? buildPromptCacheKey(options.promptCacheScope)
            : undefined

        // 注入生成参数到 provider payload（temperature / max_tokens / response_format / cache_control）
        // Agent.onPayload 在 provider 请求发送前调用，返回修改后的 payload
        const effectiveMaxTokens = options.maxTokens ?? modelMaxTokens
        const hasInjectables =
          options.temperature !== undefined ||
          effectiveMaxTokens !== undefined ||
          options.responseFormat !== undefined ||
          options.prefixUserMessage !== undefined ||
          promptCacheKey !== undefined

        // stream_options 屏蔽：某些 OpenAI 兼容中转（如 fastaitoken.com）不兼容
        // stream_options.include_usage 参数，收到后会断流导致
        // "Stream ended without finish_reason"。开启后 onPayload 移除该字段。
        // 开关由前端设置页控制，持久化到 app_settings.strip_stream_options。
        const stripStreamOptions = this.providerConfigStore?.getStripStreamOptions() ?? false

        // 计量回调也要求安装 onPayload 钩子：没有它就永远看不到真实 payload 体积。
        const needsPayloadHook = hasInjectables || stripStreamOptions || !!options.onPayloadStats

        if (needsPayloadHook) {
          const inject: Record<string, unknown> = {}
          if (options.temperature !== undefined) inject.temperature = options.temperature
          if (effectiveMaxTokens !== undefined) inject.max_tokens = effectiveMaxTokens
          // 稳定的缓存路由键：覆盖 pi-ai 按 sessionId 生成的随机值
          if (promptCacheKey !== undefined) inject.prompt_cache_key = promptCacheKey
          {
            // 响应格式注入（方案 A2）：提供 responseJsonSchema 且探测为 strict 的
            // provider 走 json_schema 严格结构化输出；否则维持 json_object 既有行为。
            // 探测口径与降级策略见 structured-outputs-support.ts。
            const schemaSupport = resolveJsonSchemaSupport(
              {
                provider: cacheControlTarget.provider,
                baseUrl: cacheControlTarget.baseUrl
              },
              process.env
            )
            Object.assign(
              inject,
              buildResponseFormatInjection({
                responseFormat: options.responseFormat,
                responseJsonSchema: options.responseJsonSchema,
                support: schemaSupport
              })
            )
          }

          const piSession = threadSession.session as {
            agent?: { onPayload?: (payload: unknown) => unknown }
          }
          if (piSession.agent) {
            // 当存在 SEMI 层 prefixUserMessage 时，在 system 与每条 prefix user 消息末尾
            // 显式打 cache_control breakpoint，提升 provider 端 prompt cache 命中率。
            //
            // "共享前缀 + Agent 专属后缀"分离策略：
            // - shared 消息末尾 breakpoint → 缓存 [system, shared]，跨 Agent 命中
            // - suffix 消息末尾 breakpoint → 缓存 [system, shared, suffix]，同 Agent 重试命中
            //
            // Anthropic 限制最多 4 个 breakpoint（含 system 的 1 个），因此 prefix 最多打 3 个。
            // 兼容多种 provider payload 结构（Anthropic / OpenAI 兼容）：
            // - Anthropic: system 为 string 或 content blocks 数组；messages 是数组
            // - OpenAI 兼容: system 在 messages[0].role === 'system'，无 payload.system 字段。
            //   OpenAI 要求 system 消息 content 为 string，不能包装为 content blocks 数组，
            //   因此不给 system 消息单独打 breakpoint。第一条 prefix user 消息的 breakpoint
            //   会将 [system, prefix1] 一起缓存，与 Anthropic 格式等价。
            // 仅在检测到可识别结构时打标，未识别结构保持原样（不破坏现有逻辑）。
            const applyCacheBreakpoints = (rawPayload: unknown): unknown => {
              if (!options.prefixUserMessage) return rawPayload
              // ⚠️ 只对认 Anthropic 风格 cache_control 的 provider 打断点。
              //
              // 其余 OpenAI 兼容 provider（DeepSeek / OpenAI / 各类中转）用的是
              // **自动前缀缓存**：服务端按 prompt 前缀自行命中，要求前缀逐字节稳定。
              // 把 content 从字符串改写成 [{type:'text',...,cache_control}] 数组
              // 会改变参与缓存键计算的序列化形态，反而把本来能命中的自动缓存打掉 ——
              // 我们以为在提升命中率，实际是在破坏它。这与实测「cache_read 极低」
              // 以及偶发的 400 missing field 'messages' 都吻合。
              if (!cacheControlSupported) return rawPayload
              const payload = rawPayload as Record<string, unknown>
              const messages = Array.isArray(payload.messages) ? [...payload.messages] : null

              // 1) 处理 system prompt（仅 Anthropic 格式：payload.system 为 string 或 content blocks）
              if (typeof payload.system === 'string' && payload.system.length > 0) {
                payload.system = [
                  {
                    type: 'text',
                    text: payload.system,
                    cache_control: { type: 'ephemeral' }
                  }
                ]
              } else if (Array.isArray(payload.system) && payload.system.length > 0) {
                const last = payload.system[payload.system.length - 1] as Record<string, unknown>
                if (last && typeof last === 'object' && !last.cache_control) {
                  payload.system = [
                    ...payload.system.slice(0, -1),
                    { ...last, cache_control: { type: 'ephemeral' } }
                  ]
                }
              }
              // OpenAI 兼容格式：system 在 messages[0].role === 'system'，content 为 string。
              // 不给 system 消息单独打 breakpoint（包装为数组会破坏 OpenAI API 兼容性），
              // 由下方 prefix user 消息的 breakpoint 覆盖 [system, prefix] 一起缓存。

              // 2) 处理 messages 数组：给每条 prefix user 消息的最后一个 content block 打 breakpoint
              //    prefixUserMessage 可能是 string（1条）或 string[]（多条）。
              //    prefix 消息在 createSession 中已作为首 N 条 user 消息注入到 messages 数组前部。
              //    每条 prefix 末尾打 breakpoint，使得：
              //    - shared 部分末尾 breakpoint → [system, shared] 跨 Agent 命中缓存
              //    - identity 部分末尾 breakpoint → [system, shared, identity] 同 Agent 重试命中
              //    Anthropic 限制最多 4 个 breakpoint（含 system 的 1 个），prefix 最多打 3 个。
              //
              //    ⚠️ 原代码用 break 跳过非 user 消息会导致 OpenAI 格式下 messages[0]
              //    为 system 消息时直接退出循环，所有 prefix 消息都打不上 breakpoint。
              //    改用 continue 跳过 + breakpointCount 计数，确保找到并标记前 3 条 user 消息。
              if (messages && messages.length > 0) {
                const prefixes = Array.isArray(options.prefixUserMessage)
                  ? options.prefixUserMessage
                  : [options.prefixUserMessage]
                // 最多给前 3 条 prefix 消息打 breakpoint（加上 system 共 4 个，不超 Anthropic 限制）
                const maxBreakpoints = Math.min(prefixes.length, 3)
                let markedAny = false
                let breakpointCount = 0

                for (let i = 0; i < messages.length && breakpointCount < maxBreakpoints; i++) {
                  const msg = messages[i] as Record<string, unknown>
                  // 跳过非 user 消息（如 OpenAI 格式的 system 消息），不 break
                  if (!msg || msg.role !== 'user') continue

                  const content = msg.content
                  if (typeof content === 'string') {
                    messages[i] = {
                      ...msg,
                      content: [
                        { type: 'text', text: content, cache_control: { type: 'ephemeral' } }
                      ]
                    }
                    markedAny = true
                    breakpointCount++
                  } else if (Array.isArray(content) && content.length > 0) {
                    const lastBlock = content[content.length - 1] as Record<string, unknown>
                    if (lastBlock && typeof lastBlock === 'object' && !lastBlock.cache_control) {
                      messages[i] = {
                        ...msg,
                        content: [
                          ...content.slice(0, -1),
                          { ...lastBlock, cache_control: { type: 'ephemeral' } }
                        ]
                      }
                      markedAny = true
                      breakpointCount++
                    }
                  }
                }

                if (markedAny) {
                  payload.messages = messages
                }
              }

              return payload
            }

            // 移除 stream_options 字段（兼容不完整的中转网关）
            const stripStreamOptionsFromPayload = (rawPayload: unknown): unknown => {
              const payload = rawPayload as Record<string, unknown>
              if (payload && typeof payload === 'object' && 'stream_options' in payload) {
                const rest = { ...payload }
                delete rest.stream_options
                logger.info({ threadId }, '✅ 已移除 stream_options 字段（兼容中转网关）')
                return rest
              }
              logger.warn(
                { threadId, hasStreamOptions: false },
                '⚠️ strip 开启但 payload 未检测到 stream_options 字段'
              )
              return payload
            }

            const prevOnPayload = piSession.agent.onPayload
            // 必须使用 async/await：Pi SDK 默认的 onPayload 是 async 函数，
            // 返回 Promise<payload>。若不 await，后续 spread Promise 会得到空对象，
            // 导致 messages 字段丢失，LLM 网关返回 400 "missing field 'messages'"。
            piSession.agent.onPayload = async (payload: unknown) => {
              let next = prevOnPayload ? await prevOnPayload(payload) : payload
              if (Object.keys(inject).length > 0) {
                next = { ...(next as Record<string, unknown>), ...inject }
              }
              next = applyCacheBreakpoints(next)
              if (stripStreamOptions) {
                next = stripStreamOptionsFromPayload(next)
              }
              // 对**最终** payload 计量：这才是真正发出去的东西。
              // 放在所有改写之后、return 之前，且只读不改。
              if (options.onPayloadStats) {
                try {
                  options.onPayloadStats(measurePayload(next))
                } catch {
                  /* 计量失败不能影响请求 */
                }
              }
              if (sessionDiag.enabled) {
                const p = next as Record<string, unknown>
                sessionDiag.payloadHookFired({
                  threadId,
                  payloadChars: JSON.stringify(next ?? {})?.length ?? 0,
                  keys: Object.keys(p ?? {}),
                  maxTokens: p?.max_tokens,
                  streamOptionsPresent: 'stream_options' in (p ?? {}),
                })
              }
              return next
            }
            logger.info(
              {
                threadId,
                hasInjectables,
                stripStreamOptions,
                hasProviderConfigStore: !!this.providerConfigStore,
                hasCacheBreakpoints: !!options.prefixUserMessage,
                // 未支持时不打断点，交由 provider 的自动前缀缓存命中
                cacheControlSupported,
                cacheControlTarget,
                injectKeys: Object.keys(inject)
              },
              '🔧 已注入 onPayload 钩子到 Pi Session'
            )
          } else {
            logger.warn({ threadId, ...inject }, 'session.agent 不可用，无法注入生成参数')
          }
        }

        // 中止信号转发
        if (options.signal) {
          const signalAlreadyAborted = options.signal.aborted
          cancelDebug('createSession-register-listener', {
            threadId,
            signalAlreadyAborted,
            hasAgent: !!(threadSession.session as any).agent
          })
          if (signalAlreadyAborted) {
            // signal 已 abort：立即调用 session.abort()。但此时 session 还没有 activeRun，
            // session.abort() 内部 this.activeRun?.abortController.abort() 无操作。
            // 后续 prompt() 入口会再次检查 signal.aborted 并抛错。
            try {
              threadSession.session.abort()
              cancelDebug('createSession-already-aborted-call', {
                threadId,
                hasActiveRun: !!(threadSession.session as any).agent?.activeRun
              })
            } catch (err) {
              cancelDebug('createSession-already-aborted-fail', {
                threadId,
                errMessage: err instanceof Error ? err.message : String(err)
              })
            }
          }
          options.signal.addEventListener(
            'abort',
            () => {
              cancelDebug('signal-abort-event', {
                threadId,
                hasActiveRun: !!(threadSession.session as any).agent?.activeRun
              })
              try {
                threadSession.session.abort()
              } catch (err) {
                cancelDebug('signal-abort-event-fail', {
                  threadId,
                  errMessage: err instanceof Error ? err.message : String(err)
                })
              }
            },
            { once: true }
          )
        }

        return {
          sessionId: (threadSession.session as { sessionId?: string }).sessionId,
          prompt: async (message?: string): Promise<string> => {
            // signal 已 abort 时立即抛错。
            //
            // 必须检查的原因：createSession 每次 runAgent 都用新 threadId 创建新 Pi Session，
            // signal abort listener 中调用的 session.abort() 只对"当前 activeRun"生效。
            // 当 abort 发生在两个 Agent 之间（Director 已结束，Writer 未开始）时：
            //   - Director 的 session.abort() 无效（已结束，无 activeRun）
            //   - Writer 的 session 还未创建，listener 在 createSession 时立即调用，
            //     但此时新 session 还没有 activeRun，session.abort() 内部
            //     `this.activeRun?.abortController.abort()` 无操作。
            //   - 随后 session.prompt() 创建新的 abortController，永不会被 abort。
            // 这会导致 orchestrator 继续执行到下一个 onCheckpoint，
            // 创建的新 pending 永远不会被 reject，donePromise 永不 resolve，
            // cancel-active-flow 路由卡死，整个取消流程崩溃。
            if (options.signal?.aborted) {
              cancelDebug('prompt-aborted-at-entry', { threadId })
              throw new Error('LLM 调用已被中止')
            }

            // === UserPromptSubmit Hook ===
            const hookMessage = message ?? options.userMessage
            let finalMessage = hookMessage
            if (this.hookManager) {
              try {
                const hookResult = await this.hookManager.runUserPromptSubmitHooks(
                  hookMessage,
                  options.signal ?? new AbortController().signal
                )
                if (hookResult.outcome.decision === 'deny') {
                  throw new Error(
                    `UserPromptSubmit Hook 拒绝: ${hookResult.outcome.reason ?? '无原因'}`
                  )
                }
                // 如果 Hook 返回了 additionalContext，将其前置到消息中
                if (hookResult.outcome.additionalContext.length > 0) {
                  const ctxText = hookResult.outcome.additionalContext.join('\n\n')
                  finalMessage = `${ctxText}\n\n${hookMessage}`
                  logger.debug(
                    { threadId, additionalContext: hookResult.outcome.additionalContext },
                    'UserPromptSubmit Hook 附加上下文已前置'
                  )
                }
                // 如果有系统消息，通过 eventBus 记录
                if (hookResult.outcome.systemMessages.length > 0) {
                  this.eventBus.emit('devlog:entry', {
                    level: 'info',
                    message: `UserPromptSubmit Hook 系统消息: ${hookResult.outcome.systemMessages.join(', ')}`,
                    source: 'agent'
                  })
                }
              } catch (error) {
                // 如果错误是阻断错误，重新抛出
                if (
                  error instanceof Error &&
                  error.message.startsWith('UserPromptSubmit Hook 拒绝')
                ) {
                  throw error
                }
                // 其他错误记录但不阻断
                logger.warn({ threadId, err: error }, 'UserPromptSubmit Hook 执行异常，继续执行')
              }
            }
            // ==================================

            completeText = '' // 重置
            lastErrorMessage = '' // 重置
            sawFinalAssistantSuccess = false // 重置：本轮终答标记不跨轮沿用
            const promptTurnStartedAt = Date.now()
            // message_end(stop/length) 已代表正文完成。Pi SDK 随后的自动压缩
            // 属于 Session 维护，不应阻塞一次性的 create-flow Agent。
            try {
              await runPromptUntilFinalAssistant(finalMessage)
              // stopReason='error' 时即使有部分文本也视为失败（截断结果不可信）
              if (lastErrorMessage) {
                cancelDebug('prompt-error-detected', {
                  threadId,
                  lastErrorMessage,
                  signalAborted: options.signal?.aborted
                })
                throw new Error(`LLM 调用失败: ${lastErrorMessage}`)
              }
              sessionDiag.promptResolved({
                threadId,
                resultChars: completeText.length,
                lastErrorMessage: lastErrorMessage || undefined,
                durationMs: Date.now() - promptTurnStartedAt,
              })
              return completeText
            } catch (error) {
              finishTrace(options.signal?.aborted ? 'aborted' : 'failed', {
                source: 'plugin-session',
                message: error instanceof Error ? error.message : String(error)
              })
              throw error
            }
          },
          promptStream: async (onDelta: (delta: string) => void): Promise<string> => {
            // 见 prompt() 中的注释：signal 已 abort 时必须立即抛错，
            // 否则跨 Agent 之间�� abort 无法生效。
            if (options.signal?.aborted) {
              cancelDebug('promptStream-aborted-at-entry', { threadId })
              throw new Error('LLM 调用已被中止')
            }

            // === UserPromptSubmit Hook ===
            const hookMessage = options.userMessage
            let finalMessage = hookMessage
            if (this.hookManager) {
              try {
                const hookResult = await this.hookManager.runUserPromptSubmitHooks(
                  hookMessage,
                  options.signal ?? new AbortController().signal
                )
                if (hookResult.outcome.decision === 'deny') {
                  throw new Error(
                    `UserPromptSubmit Hook 拒绝: ${hookResult.outcome.reason ?? '无原因'}`
                  )
                }
                // 如果 Hook 返回了 additionalContext，将其前置到消息中
                if (hookResult.outcome.additionalContext.length > 0) {
                  const ctxText = hookResult.outcome.additionalContext.join('\n\n')
                  finalMessage = `${ctxText}\n\n${hookMessage}`
                  logger.debug(
                    { threadId, additionalContext: hookResult.outcome.additionalContext },
                    'UserPromptSubmit Hook 附加上下文已前置'
                  )
                }
                // 如果有系统消息，通过 eventBus 记录
                if (hookResult.outcome.systemMessages.length > 0) {
                  this.eventBus.emit('devlog:entry', {
                    level: 'info',
                    message: `UserPromptSubmit Hook 系统消息: ${hookResult.outcome.systemMessages.join(', ')}`,
                    source: 'agent'
                  })
                }
              } catch (error) {
                // 如果错误是阻断错误，重新抛出
                if (
                  error instanceof Error &&
                  error.message.startsWith('UserPromptSubmit Hook 拒绝')
                ) {
                  throw error
                }
                // 其他错误记录但不阻断
                logger.warn({ threadId, err: error }, 'UserPromptSubmit Hook 执行异常，继续执行')
              }
            }
            // ==================================

            // 如果消息被 Hook 修改，使用修改后的消息重新构建 prompt
            const finalUserMessage = finalMessage !== hookMessage ? finalMessage : undefined

            completeText = '' // 重置
            lastErrorMessage = '' // 重置
            sawFinalAssistantSuccess = false // 重置：本轮终答标记不跨轮沿用
            const promptStreamTurnStartedAt = Date.now()
            // 临时订阅 text_delta 事件，在 prompt 执行期间推送 delta 给调用方。
            const streamUnsubscribe = threadSession.session.subscribe(
              (event: Record<string, unknown>) => {
                if (event.type === 'message_end') {
                  const message = event.message as Record<string, unknown> | undefined
                  const terminalError = getAssistantTerminalError(message, {
                    requireComplete: options.responseFormat === 'json'
                  })
                  // 与外层订阅同口径：终答成功后的维护往返失败不污染本轮结果
                  if (terminalError !== null && !sawFinalAssistantSuccess) {
                    lastErrorMessage = terminalError
                  }
                  return
                }
                if (event.type !== 'message_update') return
                const assistantMessageEvent = event.assistantMessageEvent as
                  | Record<string, unknown>
                  | undefined
                if (!assistantMessageEvent) return
                if (assistantMessageEvent.type !== 'text_delta') return
                const delta = (assistantMessageEvent.delta as string) ?? ''
                if (delta) onDelta(delta)
              }
            )
            try {
              try {
                // 如果消息被修改，传递修改后的消息
                if (finalUserMessage) {
                  await runPromptUntilFinalAssistant(finalUserMessage)
                } else {
                  await runPromptUntilFinalAssistant()
                }
                // stopReason='error' 时即使有部分文本也视为失败（截断结果不可信）
                if (lastErrorMessage) {
                  throw new Error(`LLM 调用失败: ${lastErrorMessage}`)
                }
                sessionDiag.promptResolved({
                  threadId,
                  resultChars: completeText.length,
                  lastErrorMessage: lastErrorMessage || undefined,
                  durationMs: Date.now() - promptStreamTurnStartedAt,
                })
                return completeText
              } catch (error) {
                finishTrace(options.signal?.aborted ? 'aborted' : 'failed', {
                  source: 'plugin-session',
                  message: error instanceof Error ? error.message : String(error)
                })
                throw error
              }
            } finally {
              streamUnsubscribe()
            }
          },
          subscribe: (handler: (event: Record<string, unknown>) => void): (() => void) => {
            return threadSession.session.subscribe(handler)
          },
          abort: () => {
            try {
              threadSession.session.abort()
            } catch (err) {
              logger.warn({ err }, '中止 Pi Session 失败')
            }
          },
          dispose: () => {
            // 取消订阅；PiSessionStore 自带 LRU 淘汰，无需显式 delete
            finishTrace(options.signal?.aborted ? 'aborted' : 'completed')
            try {
              unsubscribe()
            } catch (err) {
              logger.warn({ err }, '取消订阅 Pi Session 事件失败')
            }
          }
        }
      },

      /**
       * 创建 AG-UI Session：封装 StreamEmitter + ReasoningPipeline + 订阅连接。
       *
       * 插件不再需要自己 new 这些基础设施层实例，只负责编排逻辑。
       * 工厂内部：
       * 1. createSession 创建 Pi Session
       * 2. 生成 messageId
       * 3. new ReasoningPipeline + new StreamEmitter
       * 4. session.subscribe(streamEmitter.handleSessionEvent)
       */
      async createAgUiSession(
        agUiOptions: PluginSessionOptions & {
          emit: import('@repo/protocol/events').AgUiEventSink
          emitRaw?: boolean
        }
      ): Promise<AgUiSessionHandle> {
        // onFirstText 在此解构后不传入 createSession（createSession 不识别该字段）
        const { emit, emitRaw = false, onFirstText, ...sessionOptions } = agUiOptions
        const session = await this.createSession(sessionOptions)
        const messageId = randomUUID()
        const reasoningPipeline = new ReasoningPipeline(emit, messageId)
        const streamEmitter = new StreamEmitter(emit, messageId, reasoningPipeline, { emitRaw })

        // 首 token 检测：供编排层通知前端"开始生成"（只触发一次）
        // 与 StreamEmitter 的事件处理共享同一次订阅，确保时序一致
        let firstTextFired = false
        const unsubscribe = session.subscribe((event) => {
          streamEmitter.handleSessionEvent(event)
          // 检测首段 text_delta，触发 onFirstText 回调（只触发一次）
          if (
            !firstTextFired &&
            onFirstText &&
            event.type === 'message_update' &&
            (event as Record<string, unknown>).assistantMessageEvent &&
            ((event as Record<string, unknown>).assistantMessageEvent as Record<string, unknown>)
              .type === 'text_delta' &&
            ((event as Record<string, unknown>).assistantMessageEvent as Record<string, unknown>)
              .delta
          ) {
            firstTextFired = true
            try {
              onFirstText()
            } catch {
              /* 忽略回调错误，避免影响事件流 */
            }
          }
        })
        return {
          session,
          sessionId: session.sessionId,
          streamEmitter,
          reasoningPipeline,
          messageId,
          dispose(): void {
            try {
              unsubscribe()
            } catch {
              /* 忽略 */
            }
            try {
              session.dispose()
            } catch {
              /* 忽略 */
            }
          }
        }
      }
    }
  }
}

/** 重新导出常用类型，方便外部使用 */
export type {
  Plugin,
  PluginContext,
  PluginEntry,
  PluginListItem,
  PluginManagerOptions,
  PluginSessionHandle,
  PluginSessionOptions,
  AgUiSessionHandle,
  ToolDefinition,
  RouteDefinition,
  PanelDefinition,
  PluginUiContribution,
  EventHandler
} from './plugin-types.js'

/**
 * 计量单次 provider 请求的 payload 体积。
 *
 * 只用字符数而不换算 token：换算比随 tokenizer 与语言变化，会引入假精度。
 * 目的是回答"体积从哪来"，把 messages 与 tools 分开就够了 —— 前者是提示词与历史，
 * 后者是工具 schema，两者的优化手段完全不同。
 *
 * `JSON.stringify` 失败（循环引用等）时返回 0，不让计量影响请求。
 */
export function measurePayload(payload: unknown): import('./plugin-types.js').PluginPayloadStats {
  const safeLength = (value: unknown): number => {
    if (value === undefined || value === null) return 0
    try {
      return JSON.stringify(value)?.length ?? 0
    } catch {
      return 0
    }
  }
  const record = (payload ?? {}) as Record<string, unknown>
  const tools = Array.isArray(record.tools) ? record.tools : []
  return {
    // Some providers keep the system instruction outside `messages`.
    messagesChars: safeLength(record.messages) + safeLength(record.system),
    toolsChars: safeLength(record.tools),
    toolCount: tools.length,
    totalChars: safeLength(payload)
  }
}
