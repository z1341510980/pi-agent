import Fastify from 'fastify'
import { nodeConfig } from '@repo/config/node'
import { corsPlugin } from './plugins/cors.plugin.js'
import { authPlugin } from './plugins/auth.plugin.js'
import { rateLimitPlugin } from './plugins/rate-limit.plugin.js'
import { errorHandlerPlugin } from './plugins/error-handler.plugin.js'
import { requestContextPlugin } from './plugins/request-context.plugin.js'
import { eventBusPlugin } from './plugins/event-bus.plugin.js'
import { websocketSupportPlugin } from './plugins/websocket.plugin.js'
import { piSdkPlugin } from './plugins/pi-sdk.plugin.js'
import { usageLedgerPlugin } from './plugins/usage-ledger.plugin.js'
import { memoryStorePlugin } from './plugins/memory-store.plugin.js'
import { healthRoute } from './routes/health.route.js'
import { aguiRoute } from './routes/agui.route.js'
import { copilotkitRoute } from './routes/copilotkit.route.js'
import { confirmationRoute } from './routes/confirmation.route.js'
import { websocketRoute } from './routes/websocket.route.js'
import { gateRoute } from './routes/gate.route.js'
import { memoryRoute } from './routes/memory.route.js'
import { usageRoute } from './routes/usage.route.js'
import { PiAgUiAgent } from './core/agent/pi-agui-agent.js'
import { PiSessionStore } from './core/agent/session-store.js'
import { Gate } from './core/tool/gate.js'
import { ConfirmationManager } from './core/tool/confirmation-manager.js'
import { createPiSession } from './core/agent/pi-session.js'
import { CredentialBridge } from './core/config/credential-bridge.js'

export async function createApp(): Promise<Fastify.FastifyInstance> {
  const app = Fastify({
    logger: true,
  })

  // 核心插件（顺序重要）
  await app.register(requestContextPlugin)
  await app.register(corsPlugin)
  await app.register(authPlugin)
  await app.register(rateLimitPlugin)
  await app.register(errorHandlerPlugin)
  await app.register(eventBusPlugin)

  // 业务插件
  await app.register(websocketSupportPlugin)
  await app.register(piSdkPlugin)
  await app.register(usageLedgerPlugin)
  await app.register(memoryStorePlugin)

  // 创建 CredentialBridge、Gate、SessionStore
  const cwd = process.env.PI_CWD ?? process.cwd()
  const dataDir = process.env.PI_DATA_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE}/.pi`
  const credentialBridge = new CredentialBridge()
  const gate = new Gate({
    mode: 'auto',
    workspace: cwd,
    agentDir: dataDir,
  })
  const confirmationManager = new ConfirmationManager(app.eventBus)
  const sessionStore = new PiSessionStore()

  // 注入 Session 工厂
  sessionStore.setSessionFactory(async (threadId) => {
    return createPiSession({
      threadId,
      authStorage: app.authStorage,
      modelRegistry: app.modelRegistry,
      sessionManager: app.sessionManager,
      credentialBridge,
      gate,
      confirmationManager,
      eventBus: app.eventBus,
      config: {
        cwd,
        dataDir,
        llm: nodeConfig.llm,
      },
    })
  })

  const piAgUiAgent = new PiAgUiAgent(sessionStore)

  // 挂载到 Fastify 实例
  app.decorate('confirmationManager', confirmationManager)
  app.decorate('piAgUiAgent', piAgUiAgent)
  app.decorate('piSessionStore', sessionStore)
  app.decorate('gate', gate)
  app.addHook('onClose', () => confirmationManager.dispose())

  // 路由
  await app.register(healthRoute)
  await app.register(confirmationRoute)
  await app.register(websocketRoute)
  await app.register(gateRoute)
  await app.register(memoryRoute)
  await app.register(usageRoute)
  await app.register(aguiRoute)
  await app.register(copilotkitRoute)

  return app
}
