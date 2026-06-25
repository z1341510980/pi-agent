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
import type { AgentConfig, AgentManager } from '../agent/subagent-tool.js'
import type { TeamManager } from '../agent/team-manager.js'
import type {
  Plugin,
  PluginContext,
  PluginEntry,
  PluginFactory,
  PluginListItem,
  PluginManagerOptions,
  PluginSessionHandle,
  PluginSessionOptions,
  RouteDefinition,
  ToolDefinition,
  PanelDefinition,
  EventHandler,
  MigrationDefinition,
} from './plugin-types.js'

/** npm 插件包名前缀 */
const NPM_PLUGIN_PREFIX = 'pi-agent-plugin-'

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
   * 注入后插件 setup 可通过 context.teamManager 注册 Team。
   */
  private teamManager?: TeamManager
  /**
   * ModelRegistry（用于 createSession 的 modelId 切换）
   *
   * 通过 setModelRegistry() 在 app.ts 启动后期注入，
   * 与 SessionStore 同时期注入。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private modelRegistry?: any

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
      for (const { plugin } of this.options.builtinPlugins) {
        await this.loadPluginEntry(plugin, 'builtin')
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

    // 停止并清理
    if (entry.status === 'enabled') {
      await this.stopPlugin(name)
    }

    const filePath = entry.filePath
    const source = entry.source

    // 从注册表中移除
    this.entries.delete(name)

    // 重新加载
    if (source === 'builtin' || !filePath) {
      // 内置插件无法重载（无文件路径），需要重新注册
      throw new Error(`内置插件 ${name} 不支持重载，请重启服务`)
    }

    // ESM 模块重载：通过添加 query 参数强制重新加载
    await this.loadFromFile(filePath, source, true)
    await this.startPlugin(name)

    this.logger.info({ plugin: name }, '插件重载完成')
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
  getAllSessionTools(): ToolDefinition[] {
    const all: ToolDefinition[] = []
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
   */
  private async loadFromFile(
    filePath: string,
    source: 'local' | 'npm',
    reload = false,
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

      await this.loadPluginEntry(plugin, source, filePath)
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
        tools: [],
        routes: [],
        panels: [],
        eventHandlers: [],
        // 收集插件静态声明的迁移（在 setup 之前执行，确保 setup 时表已存在）
        migrations: [...(plugin.migrations ?? [])],
        sessionTools: [],
        services: [],
        promptTemplateDirs: [],
      }
      this.entries.set(manifest.name, entry)
      this.logger.info(
        { plugin: manifest.name, version: manifest.version, source },
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

    return {
      pluginName,
      logger,
      db: this.db,
      cwd: this.cwd,
      dataDir: this.dataDir,
      subagentManager: this.agentManager,
      teamManager: this.teamManager,
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
      registerSessionTools: (tools: ToolDefinition[]) => {
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
      createSession: async (options: PluginSessionOptions): Promise<PluginSessionHandle> => {
        if (!this.sessionStore) {
          throw new Error('SessionStore 未注入，无法创建 Pi Session')
        }

        const threadId = `plugin:${pluginName}:${randomUUID()}`

        // 构建 AgentConfig，通过 withAgentConfig 注入 systemPrompt 到 system role。
        // createPiSession 内的 buildSystemPrompt 会从 agentConfigStorage 读取
        // systemPrompt 并拼入系统提示词的 `## Agent 自定义指令` 部分
        // （参考 core/agent/pi-session.ts），不再拼接到 userMessage 头部，
        // 从而保持 userMessage 纯净，不破坏 prompt cache 前缀匹配。
        const agentConfig: AgentConfig = {
          id: `plugin-session-${randomUUID()}`,
          name: `${pluginName} session`,
          systemPrompt: options.systemPrompt,
          ...(options.modelId ? { model: options.modelId } : {}),
        }

        // 在 withAgentConfig 上下文中创建 session：
        // buildSystemPrompt 在 resourceLoader.reload() 时被调用，因此
        // 必须在 session 创建期间持有 agentConfigStorage 上下文。
        const threadSession = await withAgentConfig(agentConfig, async () => {
          return await this.sessionStore!.getOrCreate(threadId)
        })

        // 收集 assistant 文本（事件格式参考 core/agent/stream-emitter.ts）
        let completeText = ''
        const unsubscribe = threadSession.session.subscribe((event: Record<string, unknown>) => {
          if (event.type !== 'message_update') return
          const assistantMessageEvent = event.assistantMessageEvent as
            | Record<string, unknown>
            | undefined
          if (!assistantMessageEvent) return
          if (assistantMessageEvent.type !== 'text_delta') return
          const delta = (assistantMessageEvent.delta as string) ?? ''
          completeText += delta
        })

        // 模型切换（如指定）
        if (options.modelId) {
          if (this.modelRegistry) {
            const targetModel = this.modelRegistry.find(
              options.modelId.provider,
              options.modelId.modelId,
            )
            if (targetModel) {
              await threadSession.session.setModel(targetModel)
            } else {
              logger.warn(
                { provider: options.modelId.provider, modelId: options.modelId.modelId },
                'modelRegistry 未找到指定模型，使用默认模型',
              )
            }
          } else {
            logger.warn(
              'ModelRegistry 未注入，无法切换模型，使用默认模型',
            )
          }
        }

        // 中止信号转发
        if (options.signal) {
          options.signal.addEventListener(
            'abort',
            () => {
              try {
                threadSession.session.abort()
              } catch (err) {
                logger.warn({ err }, '中止 Pi Session 失败')
              }
            },
            { once: true },
          )
        }

        return {
          prompt: async (): Promise<string> => {
            completeText = '' // 重置
            // 在 withAgentConfig 上下文中调用 prompt（session 已创建，但保险起见）
            await withAgentConfig(agentConfig, async () => {
              await threadSession.session.prompt(options.userMessage)
            })
            return completeText
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
  ToolDefinition,
  RouteDefinition,
  PanelDefinition,
  EventHandler,
} from './plugin-types.js'
