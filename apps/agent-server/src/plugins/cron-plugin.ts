import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { CronScheduler } from '../core/cron/cron-scheduler.js'

/**
 * Cron 调度器插件
 * - 创建 CronScheduler 实例（单例）
 * - 启动定时检查
 * - 挂载到 Fastify 实例
 * - onClose 时停止调度器并持久化
 */
export const cronPlugin: FastifyPluginAsync = fp(async (app) => {
  const dataDir = process.env.PI_DATA_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE}/.pi`
  const scheduler = new CronScheduler(dataDir, app.eventBus)

  // 启动调度器
  scheduler.start()

  app.decorate('cronScheduler', scheduler)

  app.addHook('onClose', () => {
    scheduler.close()
  })
})
