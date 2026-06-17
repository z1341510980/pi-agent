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
