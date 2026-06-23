import type { FastifyPluginAsync } from 'fastify'
import { join } from 'node:path'
import { success } from '../lib/api-response.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import {
  evaluateSessionHealth,
  repairOrphanToolResultEntriesInFile,
  type SessionHealthOptions,
} from '../core/session/session-health.js'

export const sessionRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/sessions
   * 列出所有活跃会话（来自 PiSessionStore 内存缓存）
   */
  app.get('/api/sessions', async (req, reply) => {
    const sessions = app.piSessionStore.getActiveThreadSessions()
    const data = sessions.map((s) => ({
      threadId: s.threadId,
      createdAt: s.createdAt,
      lastAccessedAt: s.lastAccessedAt,
      lastRunId: s.lastRunId,
      hasActiveRun: !!s.activeRunId,
      pendingToolCalls: s.pendingToolCalls.size,
    }))
    return success(data, req.traceId)
  })

  /**
   * GET /api/sessions/stats
   * 会话存储统计
   */
  app.get('/api/sessions/stats', async (req, reply) => {
    const stats = app.piSessionStore.getStats()
    return success(stats, req.traceId)
  })

  /**
   * GET /api/sessions/:threadId/health
   * 评估会话健康状态
   */
  app.get<{ Params: { threadId: string }; Querystring: SessionHealthOptions }>(
    '/api/sessions/:threadId/health',
    async (req, reply) => {
      const { threadId } = req.params
      const { lookback, errorThreshold } = req.query ?? {}
      const dataDir = process.env.PI_DATA_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE}/.pi`
      const sessionPath = join(dataDir, 'agent', 'sessions', `${threadId}.jsonl`)
      const health = await evaluateSessionHealth(sessionPath, {
        lookback: lookback ? Number(lookback) : undefined,
        errorThreshold: errorThreshold ? Number(errorThreshold) : undefined,
      })
      return success(health, req.traceId)
    },
  )

  /**
   * POST /api/sessions/:threadId/repair
   * 修复孤儿 toolResult 条目
   */
  app.post<{ Params: { threadId: string } }>(
    '/api/sessions/:threadId/repair',
    async (req, reply) => {
      const { threadId } = req.params
      const dataDir = process.env.PI_DATA_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE}/.pi`
      const sessionPath = join(dataDir, 'agent', 'sessions', `${threadId}.jsonl`)
      try {
        const repaired = await repairOrphanToolResultEntriesInFile(sessionPath)
        return success({ repaired, threadId }, req.traceId)
      } catch (err) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          `修复会话失败: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  )

  /**
   * POST /api/sessions/sweep
   * 手动触发空闲会话淘汰
   */
  app.post('/api/sessions/sweep', async (req, reply) => {
    const evicted = app.piSessionStore.sweepIdle()
    return success({ evicted }, req.traceId)
  })
}
