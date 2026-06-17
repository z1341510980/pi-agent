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
