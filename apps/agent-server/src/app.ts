import Fastify from 'fastify'
import { corsPlugin } from './plugins/cors.plugin.js'
import { rateLimitPlugin } from './plugins/rate-limit.plugin.js'
import { errorHandlerPlugin } from './plugins/error-handler.plugin.js'
import { requestContextPlugin } from './plugins/request-context.plugin.js'
import { eventBusPlugin } from './plugins/event-bus.plugin.js'
import { websocketSupportPlugin } from './plugins/websocket.plugin.js'
import { piSdkPlugin } from './plugins/pi-sdk.plugin.js'
import { usageLedgerPlugin } from './plugins/usage-ledger.plugin.js'
import { memoryStorePlugin } from './plugins/memory-store.plugin.js'
import { subagentPlugin } from './plugins/subagent-plugin.js'
import { teamPlugin } from './plugins/team-plugin.js'
import { databasePlugin } from './plugins/database.plugin.js'
import { pluginLoaderPlugin } from './plugins/plugin-loader.plugin.js'
import { cronPlugin } from './plugins/cron-plugin.js'
import { healthRoute } from './routes/health.route.js'
import { aguiRoute } from './routes/agui.route.js'
import { copilotkitRoute } from './routes/copilotkit.route.js'
import { confirmationRoute } from './routes/confirmation.route.js'
import { websocketRoute } from './routes/websocket.route.js'
import { gateRoute } from './routes/gate.route.js'
import { memoryRoute } from './routes/memory.route.js'
import { usageRoute } from './routes/usage.route.js'
import { providerRoute } from './routes/provider.route.js'
import { sessionRoute } from './routes/session.route.js'
import { settingsRoute } from './routes/settings.route.js'
import { agentsRoute } from './routes/agents.route.js'
import { teamsRoute } from './routes/teams.route.js'
import { i18nRoute } from './routes/i18n.route.js'
import { cronRoute } from './routes/cron.route.js'
import { workspaceRoute } from './routes/workspace.route.js'
import { skillsRoute } from './routes/skills.route.js'
import { searchRoute } from './routes/search.route.js'
import { traceRoute } from './routes/trace.route.js'
import { PiAgUiAgent } from './core/agent/pi-agui-agent.js'
import { PiSessionStore } from './core/agent/session-store.js'
import { SqliteSessionIdentityRegistry } from './core/agent/session-identity-registry.js'
import { RuntimeRunRegistry } from './core/agent/runtime-run-registry.js'
import { BackgroundWorkRegistry } from './core/agent/background-work-registry.js'
import { PiActorsKernel } from './core/agent/pi-actors-kernel.js'
import { PiSubagentsHost } from './core/agent/pi-subagents-host.js'
import { createPiSubagentsBridge } from './core/agent/pi-subagents-bridge.js'
import { Gate } from './core/tool/gate.js'
import { ConfirmationManager } from './core/tool/confirmation-manager.js'
import { createPiSession } from './core/agent/pi-session.js'
import { Tracer, SqliteTraceStore, createTraceTables } from './core/tracer/index.js'
import { createMediaGenerator } from './core/config/media-generator.js'

export async function createApp(): Promise<Fastify.FastifyInstance> {
  const app = Fastify({
    logger: true,
  })

  // 核心插件（顺序重要）
  await app.register(requestContextPlugin)
  await app.register(corsPlugin)
  await app.register(rateLimitPlugin)
  await app.register(errorHandlerPlugin)
  await app.register(eventBusPlugin)

  // 业务插件（databasePlugin 必须最先注册，其他插件依赖 app.db）
  await app.register(databasePlugin)
  await app.register(websocketSupportPlugin)
  await app.register(piSdkPlugin)

  // 运行时运行注册表（§9.3.3）：进程内观测记录，供 pi-subagents 可观测桥读取。
  // 在 subagentPlugin 之前 decorate，使 dispatch 路径能记录起止状态。
  const runtimeRuns = new RuntimeRunRegistry()
  app.decorate('runtimeRuns', runtimeRuns)
  // Plugins register background-work observation providers during setup.
  // The host owns the registry so app.ts never imports a plugin module.
  const backgroundWorkRegistry = new BackgroundWorkRegistry()
  app.decorate('backgroundWorkRegistry', backgroundWorkRegistry)
  // pi-actors 长任务 Run 内核（§9.3.4：能力级接入，非 CLI）：
  // 本地命令/Recipe 的 spawn → 状态/trace/输出 → cancel/kill，观测写入 runtimeRuns。
  const piActorsKernel = new PiActorsKernel({ runtimeRuns })
  app.decorate('piActorsKernel', piActorsKernel)

  // Subagent 协作插件（在 session factory 之前注册，使 app.subagentManager 可用于 customTools 注入）
  // dispatchFn 闭包在运行时访问 app.piSessionStore / app.modelRegistry，初始化时不需要
  await app.register(subagentPlugin)

  // Team 协作插件（依赖 app.subagentManager 和 app.db，在 session factory 之前注册）
  await app.register(teamPlugin)

  await app.register(usageLedgerPlugin)
  await app.register(memoryStorePlugin)

  // 创建 ConfirmationManager 并提前 decorate 到 Fastify 实例
  // （必须在 pluginLoaderPlugin 之前完成，使 plugin-loader 能在 manager.start() 之前
  // 通过 setConfirmationManager 注入到 PluginManager，进而供插件 setup 复用 chat 的确认/决策流程）
  const confirmationManager = new ConfirmationManager(app.eventBus)
  app.decorate('confirmationManager', confirmationManager)

  // 插件加载器（依赖 eventBus 和 app.db；扫描并加载所有插件，注册插件路由）
  // 必须在 sessionStore.setSessionFactory 之前注册，因为 setSessionFactory 的闭包在运行时访问 app.pluginManager
  await app.register(pluginLoaderPlugin)

  // 创建 Gate、SessionStore
  const cwd = process.env.PI_CWD ?? process.cwd()
  const dataDir = process.env.PI_DATA_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE}/.pi`
  const gate = new Gate({
    mode: 'auto',
    workspace: cwd,
    agentDir: dataDir,
  })
  const sessionStore = new PiSessionStore()
  // 会话身份索引 P0（方案 §9.4）：threadId → sessionPath 持久化，
  // 支撑历史消息分页与聊天线程在重启/LRU 淘汰后的会话恢复。
  sessionStore.setIdentityRegistry(new SqliteSessionIdentityRegistry(app.db))
  // 产品级会话退休通知（§10.12）：idle/LRU/配置失效/关闭时发射 `session:retired`。
  // 这是本仓库自己的事件，不是 Pi SDK 的 session_shutdown。
  sessionStore.setEventBus(app.eventBus)

  // pi-subagents 无头扩展宿主（§9.3.5：能力级接入，非 CLI）：
  // 承载扩展工厂，服务端闭环 /delegation 事件协议；绑定会话后委托派生子进程执行。
  const piSubagentsHost = new PiSubagentsHost({
    cwd,
    eventBus: app.eventBus,
    sessionProvider: (threadId) => ({
      sessionId: threadId,
      // 会话文件路径异步可得；宿主桩允许 null（扩展回退临时目录）
      sessionFile: null,
      entries: [],
    }),
  })
  app.decorate('piSubagentsHost', piSubagentsHost)
  await piSubagentsHost.start()

  // 注入 Session 工厂（注入 subagentManager 用于 customTools）
  sessionStore.setSessionFactory(async (threadId, factoryContext) => {
    return createPiSession({
      threadId,
      modelRuntime: app.modelRuntime,
      sessionManager: app.sessionManager,
      settingsManager: app.settingsManager,
      providerConfigStore: app.providerConfigStore,
      gate,
      confirmationManager,
      eventBus: app.eventBus,
      getApiKey: app.getApiKey,
      factStore: app.factStore,
      subagentManager: app.subagentManager,
      teamManager: app.teamManager,
      pluginSessionTools: app.pluginManager?.getAllSessionTools() ?? [],
      threadSettingsStore: app.threadSettingsStore,
      db: app.db,
      ...(factoryContext?.resumePath ? { resumePath: factoryContext.resumePath } : {}),
      config: {
        cwd,
        dataDir,
      },
      terminalShell: app.providerConfigStore.getTerminalShell(),
    })
  })

  // 注入 SessionStore 到 PluginManager（供插件 createSession API 使用）
  // PluginManager 在 pluginLoaderPlugin 中创建（line 73），早于 SessionStore（line 85），
  // 因此通过 setter 延迟注入。createSession 在请求期调用，此时必然已注入。
  app.pluginManager?.setSessionStore(sessionStore)
  // 注入 ModelRegistry（供 createSession 的 modelId 切换）
  app.pluginManager?.setModelRegistry(app.modelRegistry)
  // 注入 ProviderConfigStore（供 onPayload 读取 stream_options 屏蔽开关等应用级配置）
  app.pluginManager?.setProviderConfigStore(app.providerConfigStore)
  app.pluginManager?.setMediaGenerator(createMediaGenerator(app.providerConfigStore, undefined, { logger: app.log }))

  // ===== 初始化追踪系统（对标 DSH session-query） =====
  const tracerStore = new SqliteTraceStore(app.db)
  createTraceTables(app.db)
  const tracer = new Tracer(tracerStore, {
    maxEvents: 10000,
    recordPayloadDetails: true,
  })
  app.log.info('追踪系统已初始化（Tracer）')
  app.pluginManager?.setTracer(tracer)

  const piAgUiAgent = new PiAgUiAgent(
    sessionStore,
    app.modelRegistry,
    app.providerConfigStore,
    app.threadSettingsStore,
    app.eventBus,
    'default',
    tracer,  // 注入 tracer
  )

  // pi-subagents 可观测桥（§9.3.3）：把章节任务与运行时运行注册为
  // pi-subagents 的 background-work / external-runs provider（供给侧，无调度语义）。
  const piSubagentsBridge = createPiSubagentsBridge({
    backgroundWork: backgroundWorkRegistry,
    runtimeRuns,
  })

  // 挂载到 Fastify 实例（confirmationManager 已在 pluginLoaderPlugin 之前 decorate）
  app.decorate('piAgUiAgent', piAgUiAgent)
  app.decorate('piSessionStore', sessionStore)
  app.decorate('gate', gate)
  app.addHook('onClose', () => {
    piSubagentsBridge.dispose()
    confirmationManager.dispose()
    sessionStore.dispose()
    void piSubagentsHost.dispose()
  })

  // Cron 调度器插件（依赖 eventBus）
  await app.register(cronPlugin)

  // 路由
  await app.register(healthRoute)
  await app.register(confirmationRoute)
  await app.register(websocketRoute)
  await app.register(gateRoute)
  await app.register(memoryRoute)
  await app.register(usageRoute)
  await app.register(providerRoute)
  await app.register(sessionRoute)
  await app.register(settingsRoute)
  await app.register(agentsRoute)
  await app.register(teamsRoute)
  await app.register(aguiRoute)
  await app.register(copilotkitRoute)
  await app.register(i18nRoute)
  await app.register(cronRoute)
  await app.register(workspaceRoute)
  await app.register(skillsRoute)
  await app.register(searchRoute)

  // 暴露 tracer 供路由使用（必须在 traceRoute 注册之前）
  app.decorate('tracer', tracer)

  await app.register(traceRoute)

  return app
}
