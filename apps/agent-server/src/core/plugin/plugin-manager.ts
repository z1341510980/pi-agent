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

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type Database from 'better-sqlite3'
import type { FastifyBaseLogger } from 'fastify'
import type { EventBus } from '@repo/shared/events'
import type { PiSessionStore } from '../agent/session-store.js'
import { withAgentConfig } from '../agent/pi-session.js'
import {
  AgentRuntimeRegistry,
  DEFAULT_AGENT_RUNTIME_KIND,
} from '../agent/agent-runtime.js'
import { composeSkillBlocks, fingerprintSkillContent } from './skill-compose.js'
import { createSkillReadTool } from './skill-read-tool.js'
import { cancelDebug } from '../../plugins/novel-plugin/utils/cancel-debug-log.js'
import { StreamEmitter } from '../agent/stream-emitter.js'
import { ReasoningPipeline } from '../agent/reasoning-pipeline.js'
import { runtimePerformance } from '../../config/performance.js'
import type { AgentConfig, AgentManager } from '../agent/subagent-tool.js'
import type { ProviderConfigStore } from '../config/provider-config-store.js'
import { supportsAnthropicCacheControl, usesOpenAiPromptCacheKey, buildPromptCacheKey, type ModelRegistryLike } from './cache-control-support.js'
import {
  getAssistantTerminalError,
  isFinalAssistantSuccess,
  waitForFinalAssistantOrPrompt,
} from './plugin-session-outcome.js'
import type { AgentCallLogger } from '../agent/agent-call-logger.js'
import type { TeamManager } from '../agent/team-manager.js'
import type { ConfirmationManager } from '../tool/confirmation-manager.js'
import type { ToolDefinition as PiToolDefinition } from '@earendil-works/pi-coding-agent'
import type {
  Plugin,
  PluginContext,
  PluginEntry,
  PluginFactory,
  PluginListItem,
  PluginManagerOptions,
  PluginSessionHandle,
  PluginSessionOptions,
  AgUiSessionHandle,
  RouteDefinition,
  ToolDefinition,
  PanelDefinition,
  EventHandler,
  MigrationDefinition,
} from './plugin-types.js'

/** npm 插件包名前缀 */
const NPM_PLUGIN_PREFIX = 'wenlang-agent-plugin-'

export function buildPluginSessionPrompt(
  userMessage: string,
  skill?: { name: string; path: string },
  extraSkills: Array<{ name: string; path: string }> = [],
): string {
  if (!skill) return userMessage
  // 单 Skill：Pi 原生 /skill: 展开（已验证路径）
  if (extraSkills.length === 0) return `/skill:${skill.name} ${userMessage}`
  // 多 Skill 组合（方案 §9.1）：Pi 原生一次只展开一个，编排层确定性编译
  // [主 Skill → 附加 Skill] 的 <skill> 块，前置到任务消息。
  return `${composeSkillBlocks([skill, ...extraSkills])}\n\n${userMessage}`
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
  /**
   * AgentRuntime 注册表（方案 §9.3）。
   *
   * 承载第三方运行时适配器（pi-subagents / pi-actors 等）；默认 kind
   * 'pi-session' 走 createSession 的内联实现，不占用注册表条目。
   * createSession 按 PluginSessionOptions.runtime 路由，未注册的 kind 显式抛错。
   */
  private readonly runtimeRegistry: AgentRuntimeRegistry

  constructor(
    logger: FastifyBaseLogger,
    eventBus: EventBus,
    db: Database.Database,
    cwd: string,
    dataDir: string,
    options: PluginManagerOptions = {},
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
        // 支持两种格式：{ plugin } 或 { plugin, config, isolate }
        const plugin = item.plugin
        const config = (item as { config?: Record<string, unknown> }).config
        const isolate = (item as { isolate?: boolean }).isolate
        await this.loadPluginEntry(plugin, 'builtin', undefined, config, isolate)
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
   * 错误隔离：单个插件 setup 失败不影响其他插件
   */
  async start(): Promise<void> {
    this.logger.info('开始启动插件')
    for (const [name, entry] of this.entries) {
      if (entry.status === 'loaded' || entry.status === 'error') {
        await this.startPlugin(name)
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
   * 已启用的插件会先停止再重新启动
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
    await this.startPlugin(name)
  }

  /** 禁用指定插件（调用 teardown 并清理注册项） */
  async disable(name: string): Promise<void> {
    const entry = this.entries.get(name)
    if (!entry) {
      throw new Error(`插件不存在: ${name}`)
    }
    if (entry.status !== 'enabled') {
      this.logger.warn({ plugin: name }, `插件当前状态为 ${entry.status}，无需禁用`)
      return
    }
    await this.stopPlugin(name)
  }

  /**
   * 重载指定插件：先停止，再重新加载模块和启动
   * 用于开发期热更新
   */
  async reload(name: string): Promise<void> {
    const entry = this.entries.get(name)
    if (!entry) {
      throw new Error(`插件不存在: ${name}`)
    }

    this.logger.info({ plugin: name }, '开始重载插件')

    // 保存配置和隔离设置（重载后恢复）
    const savedConfig = entry.config ?? {}
    const savedIsolate = entry.isolate ?? false
    const filePath = entry.filePath
    const source = entry.source

    // 停止并清理
    if (entry.status === 'enabled') {
      await this.stopPlugin(name)
    }

    // 从注册表中移除
    this.entries.delete(name)

    // 重新加载
    if (source === 'builtin' || !filePath) {
      // 内置插件无法重载（无文件路径），需要重新注册
      throw new Error(`内置插件 ${name} 不支持重载，请重启服务`)
    }

    // ESM 模块重载：通过添加 query 参数强制重新加载
    // 传入保存的配置和隔离设置，确保重载后恢复
    await this.loadFromFile(filePath, source, true, savedConfig, savedIsolate)
    await this.startPlugin(name)

    this.logger.info({ plugin: name, configRestored: Object.keys(savedConfig).length > 0 }, '插件重载完成')
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
      error: entry.error,
      toolCount: entry.tools.length,
      routeCount: entry.routes.length,
      panelCount: entry.panels.length,
      eventHandlerCount: entry.eventHandlers.length,
      migrationCount: entry.migrations.length,
      sessionToolCount: entry.sessionTools.length,
      serviceCount: entry.services.length,
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

      await this.loadFromFile(entryFile, 'local')
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

      await this.loadFromFile(entryFile, 'npm')
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
   * 从文件加载插件（错误隔离）
   * @param reload 是否为重载（添加时间戳 query 强制 ESM 重新加载）
   * @param config 插件配置（重载时恢复）
   * @param isolate 是否隔离运行（重载时恢复）
   */
  private async loadFromFile(
    filePath: string,
    source: 'local' | 'npm',
    reload = false,
    config?: Record<string, unknown>,
    isolate?: boolean,
  ): Promise<void> {
    try {
      // ESM 重载：添加 query 参数强制重新加载模块
      const fileUrl = reload
        ? `${pathToFileURL(filePath).href}?t=${Date.now()}`
        : pathToFileURL(filePath).href
      const mod = await import(fileUrl)

      // 支持 default 导出或命名导出
      const factory: PluginFactory | Plugin | undefined =
        mod.default ?? mod.createPlugin ?? mod.plugin
      if (!factory) {
        throw new Error('插件模块未导出 default / createPlugin / plugin')
      }

      let plugin: Plugin
      if (typeof factory === 'function') {
        plugin = await (factory as PluginFactory)()
      } else {
        plugin = factory
      }

      await this.loadPluginEntry(plugin, source, filePath, config, isolate)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.logger.error({ filePath, err }, `加载插件文件失败: ${errorMsg}`)
      // 错误隔离：不抛出，继续加载其他插件
    }
  }

  /** 加载插件实例到注册表（错误隔离） */
  private async loadPluginEntry(
    plugin: Plugin,
    source: 'builtin' | 'local' | 'npm',
    filePath?: string,
    config?: Record<string, unknown>,
    isolate?: boolean,
  ): Promise<void> {
    try {
      const manifest = plugin.manifest
      if (!manifest || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
        throw new Error('插件 manifest 缺少 name 或 version')
      }

      if (this.entries.has(manifest.name)) {
        this.logger.warn({ plugin: manifest.name }, '插件已存在，跳过重复加载')
        return
      }

      const entry: PluginEntry = {
        manifest,
        plugin,
        status: 'loaded',
        source,
        filePath,
        config: config ?? {},
        isolate: isolate ?? false,
        tools: [],
        routes: [],
        panels: [],
        eventHandlers: [],
        // 收集插件静态声明的迁移（在 setup 之前执行，确保 setup 时表已存在）
        migrations: [...(plugin.migrations ?? [])],
        sessionTools: [],
        services: [],
        promptTemplateDirs: [],
        providedServices: new Map(),
      }
      this.entries.set(manifest.name, entry)
      this.logger.info(
        { plugin: manifest.name, version: manifest.version, source, hasConfig: !!config },
        '插件已加载',
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
      // 清空之前的注册项（防止重复启动累积）
      // 注意：migrations 保留静态声明的部分，setup 中通过 registerMigration 注册的会在 setup 时追加
      entry.tools = []
      entry.routes = []
      entry.panels = []
      entry.eventHandlers = []
      entry.migrations = [...(entry.plugin.migrations ?? [])]
      entry.sessionTools = []
      entry.services = []
      entry.promptTemplateDirs = []

      const context = this.createPluginContext(entry)
      await entry.plugin.setup(context)
      entry.status = 'enabled'
      entry.error = undefined

      this.logger.info(
        {
          plugin: name,
          tools: entry.tools.length,
          routes: entry.routes.length,
          panels: entry.panels.length,
          eventHandlers: entry.eventHandlers.length,
        },
        '插件已启用',
      )
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      entry.status = 'error'
      entry.error = errorMsg
      this.logger.error({ plugin: name, err }, `插件启动失败: ${errorMsg}`)
    }
  }

  /** 停止单个插件（调用 teardown 并取消事件订阅） */
  private async stopPlugin(name: string): Promise<void> {
    const entry = this.entries.get(name)
    if (!entry) return

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

    entry.tools = []
    entry.routes = []
    entry.panels = []
    entry.eventHandlers = []
    entry.migrations = []
    entry.sessionTools = []
    entry.services = []
    entry.promptTemplateDirs = []
    entry.status = 'disabled'

    this.logger.info({ plugin: name }, '插件已禁用')
  }

  /** 创建插件上下文 */
  private createPluginContext(entry: PluginEntry): PluginContext {
    const pluginName = entry.manifest.name
    const logger = this.logger.child({ plugin: pluginName })
    // 对象字面量 getter 内的 this 指向字面量自身，因此通过闭包延迟读取。
    const getModelRegistry = (): ModelRegistryLike | undefined =>
      this.modelRegistry as ModelRegistryLike | undefined

    return {
      pluginName,
      config: entry.config ?? {},
      logger,
      db: this.db,
      cwd: this.cwd,
      dataDir: this.dataDir,
      subagentManager: this.agentManager,
      teamManager: this.teamManager,
      confirmationManager: this.confirmationManager!,
      agentCallLogger: this.agentCallLogger,
      // getter 而非直接取值：setModelRegistry 在 app.ts 启动后期才调用，
      // 晚于插件 setup（createPluginContext 构建本 context 的时机），
      // 直接传 this.modelRegistry 会把 undefined 固化进 context。
      get modelRegistry(): ModelRegistryLike | undefined {
        return getModelRegistry()
      },
      registerTool: (tool: ToolDefinition) => {
        entry.tools.push(tool)
        logger.debug({ tool: tool.name }, '工具已注册')
      },
      registerRoute: (route: RouteDefinition) => {
        entry.routes.push(route)
        logger.debug({ method: route.method, path: route.path }, '路由已注册')
      },
      onEvent: (type: string, handler: EventHandler) => {
        this.eventBus.on(type, handler)
        entry.eventHandlers.push({ type, handler })
        logger.debug({ event: type }, '事件监听已注册')
      },
      registerPanel: (panel: PanelDefinition) => {
        entry.panels.push(panel)
        logger.debug({ panel: panel.id }, 'UI 面板已注册')
      },
      registerMigration: (migration: MigrationDefinition) => {
        entry.migrations.push(migration)
        logger.debug({ migrationId: migration.id }, '已注册数据库迁移')
      },
      registerSessionTools: (tools: PiToolDefinition[]) => {
        entry.sessionTools.push(...tools)
        logger.debug({ count: tools.length }, '已注册 Session 工具')
      },
      registerService: (name: string, service: unknown) => {
        entry.services.push({ name, service })
        logger.debug({ serviceName: name }, '已注册 Fastify 服务')
      },
      registerPromptTemplates: (dir: string) => {
        entry.promptTemplateDirs.push(dir)
        logger.debug({ dir }, '已注册提示词模板目录')
      },
      // ===== 服务容器 API（对标 DSH Cordis 的 provide/get） =====
      provide: <T>(key: string, service: T) => {
        entry.providedServices.set(key, service)
        logger.debug({ key, serviceType: typeof service }, '服务已注册（provide）')
      },
      get: <T>(key: string): T | undefined => {
        // 1. 先查本插件提供的服务
        if (entry.providedServices.has(key)) {
          return entry.providedServices.get(key) as T
        }
        // 2. 遍历所有已启用插件，查找服务
        for (const [name, otherEntry] of this.entries) {
          if (name === pluginName) continue
          if (otherEntry.status !== 'enabled') continue
          if (otherEntry.providedServices.has(key)) {
            logger.debug({ key, provider: name }, '服务已从其他插件获取（get）')
            return otherEntry.providedServices.get(key) as T
          }
        }
        logger.debug({ key }, '服务未找到')
        return undefined
      },
      dependsOn: (pluginNames: string[]) => {
        // 记录依赖关系（用于加载顺序校验）
        // 实际依赖检查在启动时由 PluginManager 处理
        logger.debug({ dependencies: pluginNames }, '插件声明依赖')
        // 可以在这里添加依赖验证逻辑，例如检查依赖插件是否已加载
        for (const name of pluginNames) {
          if (!this.entries.has(name)) {
            logger.warn({ dependency: name }, '依赖的插件尚未加载')
          }
        }
      },
      createSession: async (options: PluginSessionOptions): Promise<PluginSessionHandle> => {
        // AgentRuntime 路由（方案 §9.3）：默认 'pi-session' 走下方内联实现；
        // 第三方运行时（pi-subagents / pi-actors 等）通过 PluginManagerOptions
        // 注入的注册表承载，未注册的 kind 显式抛错。
        const runtimeKind = options.runtime ?? DEFAULT_AGENT_RUNTIME_KIND
        if (runtimeKind !== DEFAULT_AGENT_RUNTIME_KIND) {
          const runtime = this.runtimeRegistry.get(runtimeKind)
          if (!runtime) {
            throw new Error(
              `未注册的 AgentRuntime: ${runtimeKind}（可用: ${this.runtimeRegistry.listKinds().join(', ') || '无'}）`,
            )
          }
          return runtime.createSession(options)
        }

        if (!this.sessionStore) {
          throw new Error('SessionStore 未注入，无法创建 Pi Session')
        }

        const threadId = `plugin:${pluginName}:${randomUUID()}`

        // 多 Skill 白名单（方案 §9.1）：主 skill + extraSkills 全部只经
        // additionalSkillPaths 定向加载，不扫描环境中的其他 Skills。
        const authorizedSkills = [
          ...(options.skill ? [options.skill] : []),
          ...(options.extraSkills ?? []),
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
            ? { skillPaths: authorizedSkills.map(s => s.path) }
            : {}),
          ...(Array.isArray(options.tools)
            ? {
                tools: options.tools.map(t => t.name),
                extraTools: options.tools,
              }
            : {}),
          // 受限 skill_read（方案 §9.2）：仅当本次会话显式授权了 Skill 且调用方
          // 声明 skillRead 时注入；授权范围绑定到本次会话的 skill 根目录。
          ...(options.skillRead && authorizedSkills.length > 0
            ? { extraTools: [...(Array.isArray(options.tools) ? options.tools : []), createSkillReadTool(options.skillRead)] }
            : {}),
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
            const loaded = loadedSkills.find(skill => skill.name === authorized.name)
            if (!loaded || resolve(loaded.filePath) !== resolve(authorized.path)) {
              throw new Error(`插件 Session 未能加载授权 Skill: ${authorized.name}`)
            }
          }
          // 增强：Skill 内容指纹审计（SHA-256 前 16 位），用于规则漂移检测与日志留痕。
          const fingerprints = authorizedSkills.map(skill => {
            let fingerprint = ''
            try {
              fingerprint = fingerprintSkillContent(readFileSync(skill.path, 'utf-8'))
            } catch {
              fingerprint = '(unreadable)'
            }
            return { name: skill.name, fingerprint }
          })
          logger.info({ threadId, skillFingerprints: fingerprints }, '插件 Session 已加载授权 Skill（指纹审计）')
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
              timestamp: now + i,
            }))
            const existing = piSession.agent.state.messages ?? []
            piSession.agent.state.messages = [...existing, ...prefixMessages]
            logger.debug(
              { threadId, prefixCount: prefixMessages.length, prefixLengths: prefixes.map(p => p.length) },
              '已注入 SEMI 层前缀消息（每条独立打 cache_control breakpoint）',
            )
          } else {
            logger.warn(
              { threadId },
              '无法注入前缀消息：session.agent.state 不可用，将回退到拼接模式',
            )
          }
        }

        // 收集 assistant 文本（事件格式参考 core/agent/stream-emitter.ts）
        let completeText = ''
        // Pi SDK 在 LLM 调用失败时不抛异常，而是产生 stopReason="error" 的 message_end 事件。
        // 这里捕获错误信息，供 prompt/promptStream 在调用后检查并抛出，避免"空响应+success"的假象。
        let lastErrorMessage = ''
        let resolveFinalAssistant: (() => void) | undefined
        const unsubscribe = threadSession.session.subscribe((event: Record<string, unknown>) => {
          if (event.type === 'message_end') {
            const message = event.message as Record<string, unknown> | undefined
            const terminalError = getAssistantTerminalError(message, {
              requireComplete: options.responseFormat === 'json',
            })
            cancelDebug('message_end-received', { threadId, stopReason: message?.stopReason, hasError: !!terminalError, errorMessage: terminalError || undefined })
            if (terminalError !== null) {
              lastErrorMessage = terminalError
            }
            if (terminalError) {
              logger.error(
                { threadId, errorMessage: lastErrorMessage, provider: message?.provider, model: message?.model },
                'Pi Session LLM 调用失败（message_end stopReason=error）',
              )
            }
            if (isFinalAssistantSuccess(message)) {
              resolveFinalAssistant?.()
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
          completeText += delta
        })

        const runPromptUntilFinalAssistant = async (): Promise<void> => {
          const timeoutMs = options.timeoutMs ?? runtimePerformance.llm.timeoutMs
          let resolveCurrentFinalAssistant: (() => void) | undefined
          const finalAssistantPromise = new Promise<void>((resolve) => {
            resolveCurrentFinalAssistant = resolve
            resolveFinalAssistant = resolve
          })
          const promptPromise = withAgentConfig(agentConfig, async () => {
            await threadSession.session.prompt(
              buildPluginSessionPrompt(options.userMessage, options.skill, options.extraSkills),
            )
          })

          try {
            await waitForFinalAssistantOrPrompt({
              promptPromise,
              finalAssistantPromise,
              timeoutMs,
            })
          } finally {
            if (resolveFinalAssistant === resolveCurrentFinalAssistant) {
              resolveFinalAssistant = undefined
            }
          }
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
            if (this.modelRegistry) {
            const targetModel = this.modelRegistry.find(
              options.modelId.provider,
              options.modelId.modelId,
            )
            if (targetModel) {
               await threadSession.session.setModel(targetModel)
               if (options.modelId.thinkingLevel) {
                 threadSession.session.setThinkingLevel(options.modelId.thinkingLevel)
               }
              modelMaxTokens = targetModel.maxTokens
              cacheControlTarget = {
                provider: options.modelId.provider,
                modelId: options.modelId.modelId,
                baseUrl: (targetModel as { baseUrl?: string }).baseUrl,
              }
            } else {
              logger.warn(
                { provider: options.modelId.provider, modelId: options.modelId.modelId },
                'modelRegistry 未找到指定模型，使用默认模型',
              )
              // 查不到 baseUrl 时仍按 provider/modelId 判断，避免直接退回到"全量打断点"
              cacheControlTarget = {
                provider: options.modelId.provider,
                modelId: options.modelId.modelId,
              }
            }
          } else {
            logger.warn(
              'ModelRegistry 未注入，无法切换模型，使用默认模型',
            )
            cacheControlTarget = {
              provider: options.modelId.provider,
              modelId: options.modelId.modelId,
            }
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
              baseUrl: allModels[0].baseUrl,
            }
          }
        }

        const cacheControlSupported = supportsAnthropicCacheControl(cacheControlTarget)
        // OpenAI 的 prompt_cache_key 是路由提示：相同 key 尽量导到同一台机器，
        // 才可能命中那台机器上的前缀缓存。pi-ai 默认用 sessionId，而我们每次
        // runAgent 都新建 session → 随机 key → 同一章的多个 Agent 各走一台机器，
        // 共享前缀白建。有 promptCacheScope 时改用稳定 key。
        const promptCacheKey = options.promptCacheScope && usesOpenAiPromptCacheKey(cacheControlTarget)
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
          if (options.responseFormat === 'json') {
            inject.response_format = { type: 'json_object' }
            // 实体规划/生成阶段只需纯 JSON 输出，不需要工具调用。
            // 禁用工具可避免某些 OpenAI 兼容网关在 response_format=json 时
            // 仍 emit tool_calls 导致 messages 历史不一致
            // （LLM 网关报 400 "tool_calls must be followed by tool messages"）。
            //
            // ⚠️ 仅限 responseFormat='json' 场景：
            //   - planEntitiesFromOutline（实体规划）
            //   - generate()（5 类实体生成）
            //   - character-generator / memory-generator 的纯 JSON 生成
            // Writer/Reviewer/Memory 等 create-flow Agent 走 createAgUiSession，
            // 不传 responseFormat，因此仍保留全部工具能力。
            inject.tool_choice = 'none'
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
                payload.system = [{
                  type: 'text',
                  text: payload.system,
                  cache_control: { type: 'ephemeral' },
                }]
              } else if (Array.isArray(payload.system) && payload.system.length > 0) {
                const last = payload.system[payload.system.length - 1] as Record<string, unknown>
                if (last && typeof last === 'object' && !last.cache_control) {
                  payload.system = [...payload.system.slice(0, -1), { ...last, cache_control: { type: 'ephemeral' } }]
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
                      content: [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }],
                    }
                    markedAny = true
                    breakpointCount++
                  } else if (Array.isArray(content) && content.length > 0) {
                    const lastBlock = content[content.length - 1] as Record<string, unknown>
                    if (lastBlock && typeof lastBlock === 'object' && !lastBlock.cache_control) {
                      messages[i] = {
                        ...msg,
                        content: [...content.slice(0, -1), { ...lastBlock, cache_control: { type: 'ephemeral' } }],
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
              logger.warn({ threadId, hasStreamOptions: false }, '⚠️ strip 开启但 payload 未检测到 stream_options 字段')
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
                injectKeys: Object.keys(inject),
              },
              '🔧 已注入 onPayload 钩子到 Pi Session',
            )
          } else {
            logger.warn({ threadId, ...inject }, 'session.agent 不可用，无法注入生成参数')
          }
        }

        // 中止信号转发
        if (options.signal) {
          const signalAlreadyAborted = options.signal.aborted
          cancelDebug('createSession-register-listener', { threadId, signalAlreadyAborted, hasAgent: !!(threadSession.session as any).agent })
          if (signalAlreadyAborted) {
            // signal 已 abort：立即调用 session.abort()。但此时 session 还没有 activeRun，
            // session.abort() 内部 this.activeRun?.abortController.abort() 无操作。
            // 后续 prompt() 入口会再次检查 signal.aborted 并抛错。
            try {
              threadSession.session.abort()
              cancelDebug('createSession-already-aborted-call', { threadId, hasActiveRun: !!(threadSession.session as any).agent?.activeRun })
            } catch (err) {
              cancelDebug('createSession-already-aborted-fail', { threadId, errMessage: err instanceof Error ? err.message : String(err) })
            }
          }
          options.signal.addEventListener(
            'abort',
            () => {
              cancelDebug('signal-abort-event', { threadId, hasActiveRun: !!(threadSession.session as any).agent?.activeRun })
              try {
                threadSession.session.abort()
              } catch (err) {
                cancelDebug('signal-abort-event-fail', { threadId, errMessage: err instanceof Error ? err.message : String(err) })
              }
            },
            { once: true },
          )
        }

        return {
          sessionId: (threadSession.session as { sessionId?: string }).sessionId,
          prompt: async (): Promise<string> => {
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
            completeText = '' // 重置
            lastErrorMessage = '' // 重置
            // message_end(stop/length) 已代表正文完成。Pi SDK 随后的自动压缩
            // 属于 Session 维护，不应阻塞一次性的 create-flow Agent。
            await runPromptUntilFinalAssistant()
            // stopReason='error' 时即使有部分文本也视为失败（截断结果不可信）
            if (lastErrorMessage) {
              cancelDebug('prompt-error-detected', { threadId, lastErrorMessage, signalAborted: options.signal?.aborted })
              throw new Error(`LLM 调用失败: ${lastErrorMessage}`)
            }
            return completeText
          },
          promptStream: async (onDelta: (delta: string) => void): Promise<string> => {
            // 见 prompt() 中的注释：signal 已 abort 时必须立即抛错，
            // 否则跨 Agent 之间的 abort 无法生效。
            if (options.signal?.aborted) {
              cancelDebug('promptStream-aborted-at-entry', { threadId })
              throw new Error('LLM 调用已被中止')
            }
            completeText = '' // 重置
            lastErrorMessage = '' // 重置
            // 临时订阅 text_delta 事件，在 prompt 执行期间推送 delta 给调用方。
            const streamUnsubscribe = threadSession.session.subscribe((event: Record<string, unknown>) => {
              if (event.type === 'message_end') {
                const message = event.message as Record<string, unknown> | undefined
                const terminalError = getAssistantTerminalError(message, {
                  requireComplete: options.responseFormat === 'json',
                })
                if (terminalError !== null) {
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
            })
            try {
              await runPromptUntilFinalAssistant()
              // stopReason='error' 时即使有部分文本也视为失败（截断结果不可信）
              if (lastErrorMessage) {
                throw new Error(`LLM 调用失败: ${lastErrorMessage}`)
              }
              return completeText
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
            try {
              unsubscribe()
            } catch (err) {
              logger.warn({ err }, '取消订阅 Pi Session 事件失败')
            }
          },
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
        },
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
            !firstTextFired
            && onFirstText
            && event.type === 'message_update'
            && (event as Record<string, unknown>).assistantMessageEvent
            && ((event as Record<string, unknown>).assistantMessageEvent as Record<string, unknown>).type === 'text_delta'
            && ((event as Record<string, unknown>).assistantMessageEvent as Record<string, unknown>).delta
          ) {
            firstTextFired = true
            try { onFirstText() } catch { /* 忽略回调错误，避免影响事件流 */ }
          }
        })
        return {
          session,
          sessionId: session.sessionId,
          streamEmitter,
          reasoningPipeline,
          messageId,
          dispose(): void {
            try { unsubscribe() } catch { /* 忽略 */ }
            try { session.dispose() } catch { /* 忽略 */ }
          },
        }
      },
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
  EventHandler,
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
    totalChars: safeLength(payload),
  }
}
