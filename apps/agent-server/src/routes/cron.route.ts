/**
 * Cron API 路由
 *
 * 端点：
 * - GET /api/cron/jobs — 列出所有定时任务
 * - POST /api/cron/jobs — 创建定时任务
 * - PUT /api/cron/jobs/:id — 更新任务
 * - DELETE /api/cron/jobs/:id — 删除任务
 * - POST /api/cron/jobs/:id/run — 手动触发任务
 * - POST /api/cron/jobs/:id/enable — 启用任务
 * - POST /api/cron/jobs/:id/disable — 禁用任务
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { success } from '../lib/api-response.js'
import { validateBody } from '../lib/validate.js'
import { isValidCronExpression } from '../core/cron/cron-scheduler.js'

const createJobSchema = z.object({
  name: z.string().min(1).max(100),
  agentId: z.string().optional(),
  schedule: z.string().min(1),
  prompt: z.string().min(1),
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
})

const updateJobSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  agentId: z.string().optional(),
  schedule: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
})

export const cronRoute: FastifyPluginAsync = async (app) => {
  const scheduler = app.cronScheduler

  // GET /api/cron/jobs — 列出所有定时任务
  app.get('/api/cron/jobs', async (request) => {
    return success({ jobs: scheduler.listJobs() }, request.traceId)
  })

  // POST /api/cron/jobs — 创建定时任务
  app.post('/api/cron/jobs', async (request, reply) => {
    const input = validateBody(createJobSchema, request, reply)
    if (!input) return

    if (!isValidCronExpression(input.schedule)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        '无效的 cron 表达式',
        400,
        `无效的 cron 表达式: ${input.schedule}`,
      )
    }

    const job = scheduler.addJob(input)
    app.log.info({ traceId: request.traceId, jobId: job.id }, '已创建定时任务')
    return success(job, request.traceId)
  })

  // PUT /api/cron/jobs/:id — 更新任务
  app.put('/api/cron/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const input = validateBody(updateJobSchema, request, reply)
    if (!input) return

    if (input.schedule && !isValidCronExpression(input.schedule)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        '无效的 cron 表达式',
        400,
        `无效的 cron 表达式: ${input.schedule}`,
      )
    }

    try {
      const job = scheduler.updateJob(id, input)
      app.log.info({ traceId: request.traceId, jobId: id }, '已更新定时任务')
      return success(job, request.traceId)
    } catch {
      throw new AppError(ErrorCode.NOT_FOUND, '任务不存在', 404, `任务不存在: ${id}`)
    }
  })

  // DELETE /api/cron/jobs/:id — 删除任务
  app.delete('/api/cron/jobs/:id', async (request) => {
    const { id } = request.params as { id: string }
    const removed = scheduler.removeJob(id)
    if (!removed) {
      throw new AppError(ErrorCode.NOT_FOUND, '任务不存在', 404, `任务不存在: ${id}`)
    }
    app.log.info({ traceId: request.traceId, jobId: id }, '已删除定时任务')
    return success({ removed: true }, request.traceId)
  })

  // POST /api/cron/jobs/:id/run — 手动触发任务
  app.post('/api/cron/jobs/:id/run', async (request) => {
    const { id } = request.params as { id: string }
    try {
      const result = await scheduler.runJob(id)
      app.log.info(
        { traceId: request.traceId, jobId: id, success: result.success },
        '手动触发定时任务完成',
      )
      return success(result, request.traceId)
    } catch {
      throw new AppError(ErrorCode.NOT_FOUND, '任务不存在', 404, `任务不存在: ${id}`)
    }
  })

  // POST /api/cron/jobs/:id/enable — 启用任务
  app.post('/api/cron/jobs/:id/enable', async (request) => {
    const { id } = request.params as { id: string }
    try {
      const job = scheduler.enableJob(id)
      return success(job, request.traceId)
    } catch {
      throw new AppError(ErrorCode.NOT_FOUND, '任务不存在', 404, `任务不存在: ${id}`)
    }
  })

  // POST /api/cron/jobs/:id/disable — 禁用任务
  app.post('/api/cron/jobs/:id/disable', async (request) => {
    const { id } = request.params as { id: string }
    try {
      const job = scheduler.disableJob(id)
      return success(job, request.traceId)
    } catch {
      throw new AppError(ErrorCode.NOT_FOUND, '任务不存在', 404, `任务不存在: ${id}`)
    }
  })
}
