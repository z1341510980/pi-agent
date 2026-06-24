import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { CronScheduler } from '../core/cron/cron-scheduler.js'

/**
 * Cron 调度器插件
 * - 创建 CronScheduler 实例（单例）
 * - 启动定时检查
 * - 挂载到 Fastify 实例
 * - onClose 时停止调度器（数据已实时持久化到 SQLite）
 */
export const cronPlugin: FastifyPluginAsync = fp(async (app) => {
  const scheduler = new CronScheduler(app.db, app.eventBus)

  // 启动调度器
  scheduler.start()

  app.decorate('cronScheduler', scheduler)

  app.addHook('onClose', () => {
    scheduler.close()
  })
})
