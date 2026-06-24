import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { success } from '../lib/api-response.js'
import { validateBody } from '../lib/validate.js'

const budgetSchema = z.object({
  monthlyBudgetUsd: z.number().min(0).optional(),
  alertThreshold: z.number().min(0).max(100).optional(),
})

/**
 * Usage API 路由
 * - GET /api/usage — 查询用量记录
 * - GET /api/usage/summary — 获取汇总统计
 * - GET /api/usage/daily — 获取按日聚合用量
 * - GET /api/usage/by-provider — 按 Provider 聚合
 * - GET /api/usage/by-model — 按模型聚合
 * - GET /api/usage/export — 导出 CSV
 * - GET /api/usage/budget — 获取预算设置
 * - PUT /api/usage/budget — 设置预算
 * - GET /api/usage/session/:sessionId — 获取会话用量
 */
export const usageRoute: FastifyPluginAsync = async (app) => {
  // 查询用量记录
  app.get('/api/usage', async (request) => {
    const query = request.query as Record<string, string | undefined>

    const from = query.from ? Number(query.from) : undefined
    const to = query.to ? Number(query.to) : undefined
    const limit = query.limit ? Number(query.limit) : undefined
    const offset = query.offset ? Number(query.offset) : undefined

    // 参数验证
    if (from !== undefined && (!Number.isFinite(from) || from < 0)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'from 必须为非负数字', 400)
    }
    if (to !== undefined && (!Number.isFinite(to) || to < 0)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'to 必须为非负数字', 400)
    }
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1 || limit > 1000)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'limit 必须为 1-1000 之间的数字', 400)
    }
    if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'offset 必须为非负数字', 400)
    }

    const result = app.usageLedger.query({
      from,
      to,
      model: query.model,
      provider: query.provider,
      agentId: query.agentId,
      sessionId: query.sessionId,
      limit,
      offset,
    })

    return success(result, request.traceId)
  })

  // 获取汇总统计
  app.get('/api/usage/summary', async (request) => {
    const query = request.query as Record<string, string | undefined>

    const from = query.from ? Number(query.from) : undefined
    const to = query.to ? Number(query.to) : undefined

    if (from !== undefined && (!Number.isFinite(from) || from < 0)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'from 必须为非负数字', 400)
    }
    if (to !== undefined && (!Number.isFinite(to) || to < 0)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'to 必须为非负数字', 400)
    }

    const summary = app.usageLedger.getSummary({
      from,
      to,
      agentId: query.agentId,
    })

    return success(summary, request.traceId)
  })

  // 获取按日聚合用量
  app.get('/api/usage/daily', async (request) => {
    const query = request.query as Record<string, string | undefined>

    const days = query.days ? Number(query.days) : undefined

    if (days !== undefined && (!Number.isFinite(days) || days < 1 || days > 90)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'days 必须为 1-90 之间的数字', 400)
    }

    const daily = app.usageLedger.getDaily({
      days,
      agentId: query.agentId,
    })

    return success(daily, request.traceId)
  })

  // 按 Provider 聚合
  app.get('/api/usage/by-provider', async (request) => {
    const query = request.query as Record<string, string | undefined>

    const from = query.from ? Number(query.from) : undefined
    const to = query.to ? Number(query.to) : undefined

    const result = app.usageLedger.getByProvider({
      from,
      to,
      agentId: query.agentId,
    })

    return success(result, request.traceId)
  })

  // 按模型聚合
  app.get('/api/usage/by-model', async (request) => {
    const query = request.query as Record<string, string | undefined>

    const from = query.from ? Number(query.from) : undefined
    const to = query.to ? Number(query.to) : undefined

    const result = app.usageLedger.getByModel({
      from,
      to,
      agentId: query.agentId,
      provider: query.provider,
    })

    return success(result, request.traceId)
  })

  // 导出 CSV
  app.get('/api/usage/export', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>

    const from = query.from ? Number(query.from) : undefined
    const to = query.to ? Number(query.to) : undefined

    const csv = app.usageLedger.exportCsv({
      from,
      to,
      agentId: query.agentId,
    })

    // 直接返回 CSV 文本（不走 ApiResponse 包装）
    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="usage-${Date.now()}.csv"`)
    return reply.send(csv)
  })

  // 获取预算设置
  app.get('/api/usage/budget', async (request) => {
    const budget = app.usageLedger.getBudget()
    const monthly = app.usageLedger.getMonthlyUsage()
    return success({ ...budget, ...monthly }, request.traceId)
  })

  // 设置预算
  app.put('/api/usage/budget', async (request, reply) => {
    const input = validateBody(budgetSchema, request, reply)
    if (!input) return

    const budget = app.usageLedger.setBudget(input)
    const monthly = app.usageLedger.getMonthlyUsage()
    app.log.info(
      { traceId: request.traceId, budget },
      '已更新用量预算',
    )
    return success({ ...budget, ...monthly }, request.traceId)
  })

  // 获取会话用量
  app.get('/api/usage/session/:sessionId', async (request) => {
    const { sessionId } = request.params as { sessionId: string }

    if (!sessionId || sessionId.trim().length === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'sessionId 不能为空', 400)
    }

    const summary = app.usageLedger.getSessionUsage(sessionId)

    return success(summary, request.traceId)
  })

  // 获取线程用量（前端用 threadId 查询，而非 sessionId）
  app.get('/api/usage/thread/:threadId', async (request) => {
    const { threadId } = request.params as { threadId: string }

    if (!threadId || threadId.trim().length === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'threadId 不能为空', 400)
    }

    const summary = app.usageLedger.getThreadUsage(threadId)

    return success(summary, request.traceId)
  })
}
