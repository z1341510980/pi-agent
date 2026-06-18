import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { FactStore } from '../core/memory/fact-store.js'
import { SessionSummaryStore } from '../core/memory/session-summary.js'

/**
 * Memory 存储插件
 * - 创建 FactStore 和 SessionSummaryStore 实例（单例）
 * - 挂载到 Fastify 实例，供路由使用
 * - onClose 时持久化
 */
export const memoryStorePlugin: FastifyPluginAsync = fp(async (app) => {
  const dataDir = process.env.PI_DATA_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE}/.pi`
  const factStore = new FactStore(dataDir)
  const summaryStore = new SessionSummaryStore(dataDir)

  app.decorate('factStore', factStore)
  app.decorate('summaryStore', summaryStore)

  app.addHook('onClose', async () => {
    await factStore.close()
  })
})
