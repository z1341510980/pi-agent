import type { FastifyPluginAsync } from 'fastify'
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

    const result = await app.usageLedger.query({
      from: query.from ? Number(query.from) : undefined,
      to: query.to ? Number(query.to) : undefined,
      model: query.model,
      agentId: query.agentId,
      sessionId: query.sessionId,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    })

    return success(result, request.traceId)
  })

  // 获取汇总统计
  app.get('/api/usage/summary', async (request) => {
    const query = request.query as Record<string, string | undefined>

    const summary = await app.usageLedger.getSummary({
      from: query.from ? Number(query.from) : undefined,
      to: query.to ? Number(query.to) : undefined,
      agentId: query.agentId,
    })

    return success(summary, request.traceId)
  })

  // 获取会话用量
  app.get('/api/usage/session/:sessionId', async (request) => {
    const { sessionId } = request.params as { sessionId: string }

    const summary = await app.usageLedger.getSessionUsage(sessionId)

    return success(summary, request.traceId)
  })
}
