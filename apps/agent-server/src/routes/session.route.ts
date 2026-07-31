import type { FastifyPluginAsync } from 'fastify'
import { join } from 'node:path'
import { success } from '../lib/api-response.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import {
  evaluateSessionHealth,
  repairOrphanToolResultEntriesInFile,
  type SessionHealthOptions,
} from '../core/session/session-health.js'
import { readSessionMessages } from '../core/session/session-reader.js'

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
   * GET /api/sessions/:threadId/messages
   * 按行号游标分页读取会话消息（最新在前）
   *
   * Query:
   * - before: 行号游标，返回 lineIndex < before 的消息；缺省时从最新开始
   * - limit:  单次返回上限，默认 30，最大 100
   */
  app.get<{
    Params: { threadId: string }
    Querystring: { before?: string; limit?: string }
  }>('/api/sessions/:threadId/messages', async (req, reply) => {
    const { threadId } = req.params
    const { before, limit } = req.query ?? {}

    const dataDir =
      process.env.PI_DATA_DIR ??
      `${process.env.HOME ?? process.env.USERPROFILE}/.pi`
    const sessionPath = join(dataDir, 'agent', 'sessions', `${threadId}.jsonl`)

    const beforeNum = before != null && before !== '' ? Number(before) : undefined
    if (beforeNum != null && (!Number.isFinite(beforeNum) || beforeNum < 0)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        '参数 before 必须是非负数字',
      )
    }

    const limitNum = limit != null && limit !== '' ? Number(limit) : undefined
    if (limitNum != null && (!Number.isFinite(limitNum) || limitNum < 1)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '参数 limit 必须是正整数')
    }

    const data = await readSessionMessages(sessionPath, {
      before: beforeNum,
      limit: limitNum,
    })
    return success(data, req.traceId)
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
