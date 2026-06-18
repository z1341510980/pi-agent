import type { FastifyPluginAsync } from 'fastify'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { success } from '../lib/api-response.js'

/**
 * Usage API 路由
 * - GET /api/usage — 查询用量记录
 * - GET /api/usage/summary — 获取汇总统计
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

  // 获取会话用量
  app.get('/api/usage/session/:sessionId', async (request) => {
    const { sessionId } = request.params as { sessionId: string }

    if (!sessionId || sessionId.trim().length === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'sessionId 不能为空', 400)
    }

    const summary = app.usageLedger.getSessionUsage(sessionId)

    return success(summary, request.traceId)
  })
}
