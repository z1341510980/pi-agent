/**
 * 追踪系统 API 路由
 *
 * 对标 DSH 的 session-query 查询能力
 * 端点：/api/traces
 */

import type { FastifyPluginAsync } from 'fastify'
import type { Tracer } from '../core/tracer/tracer.js'

export const traceRoute: FastifyPluginAsync = async (app) => {
  // 获取追踪系统实例
  const tracer = (app as any).tracer as Tracer | undefined

  if (!tracer) {
    app.log.warn('Tracer 未初始化，追踪路由不可用')
    return
  }

  // GET /api/traces/:traceId - 获取完整追踪
  app.get<{ Params: { traceId: string } }>('/api/traces/:traceId', async (req, reply) => {
    const { traceId } = req.params
    const trace = tracer.getTrace(traceId)
    if (!trace) {
      return reply.status(404).send({ error: 'Trace not found' })
    }
    return {
      id: trace.id,
      sessionId: trace.sessionId,
      runId: trace.runId,
      startedAt: trace.startedAt,
      endedAt: trace.endedAt,
      status: trace.status,
      eventCount: trace.events.length,
      metadata: trace.metadata,
      // 默认不返回完整事件列表，用 /events 单独获取
    }
  })

  // GET /api/traces/:traceId/events - 获取追踪的事件列表
  app.get<{ Params: { traceId: string }; Querystring: { offset?: string; limit?: string } }>(
    '/api/traces/:traceId/events',
    async (req, reply) => {
      const { traceId } = req.params
      const offset = parseInt(req.query.offset ?? '0', 10)
      const limit = parseInt(req.query.limit ?? '50', 10)

      const trace = tracer.getTrace(traceId)
      if (!trace) {
        return reply.status(404).send({ error: 'Trace not found' })
      }

      const events = trace.events.slice(offset, offset + limit)
      return {
        traceId,
        total: trace.events.length,
        offset,
        limit,
        events: events.map((e) => ({
          seq: e.seq,
          type: e.type,
          time: e.time,
          status: e.status,
          data: e.data,
          parentSeq: e.parentSeq,
          sourceEventSeqs: e.sourceEventSeqs,
          spanId: e.spanId,
        })),
      }
    },
  )

  // GET /api/traces/:traceId/surface - 获取当前表面（折叠后的事件）
  app.get<{ Params: { traceId: string } }>('/api/traces/:traceId/surface', async (req, reply) => {
    const { traceId } = req.params
    const trace = tracer.getTrace(traceId)
    if (!trace) {
      return reply.status(404).send({ error: 'Trace not found' })
    }

    const folded = tracer.foldSurface(traceId)
    const surfaceEvents = trace.events.filter((e) => folded.nodes.includes(e.seq))

    return {
      traceId,
      nodes: folded.nodes,
      replacements: folded.replacements,
      surfaceEvents: surfaceEvents.map((e) => ({
        seq: e.seq,
        type: e.type,
        time: e.time,
        status: e.status,
        data: e.data,
      })),
    }
  })

  // GET /api/traces/:traceId/trace-event/:seq - 追踪事件关系
  app.get<{ Params: { traceId: string; seq: string } }>(
    '/api/traces/:traceId/trace-event/:seq',
    async (req, reply) => {
      const { traceId, seq } = req.params
      const seqNum = parseInt(seq, 10)

      try {
        const result = tracer.traceEvent(traceId, seqNum)
        return {
          target: {
            seq: result.target.seq,
            type: result.target.type,
            time: result.target.time,
            status: result.target.status,
          },
          replacedBy: result.replacedBy,
          replacementChain: result.replacementChain,
          replacedEventSeqs: result.replacedEventSeqs,
          sourceEventSeqs: result.sourceEventSeqs,
          derivedEventSeqs: result.derivedEventSeqs,
        }
      } catch (err) {
        return reply.status(404).send({
          error: err instanceof Error ? err.message : 'Event not found',
        })
      }
    },
  )

  // GET /api/traces/session/:sessionId - 获取会话的所有追踪
  app.get<{ Params: { sessionId: string } }>(
    '/api/traces/session/:sessionId',
    async (req, reply) => {
      const { sessionId } = req.params
      const traces = await tracer.getSessionTraces(sessionId)
      return {
        sessionId,
        count: traces.length,
        traces: traces.map((t) => ({
          id: t.id,
          runId: t.runId,
          startedAt: t.startedAt,
          status: t.status,
          eventCount: t.events.length,
        })),
      }
    },
  )

  // GET /api/traces/query - 查询事件
  app.get<{ Querystring: { sessionId?: string; type?: string; status?: string; startTime?: string; endTime?: string; limit?: string; offset?: string } }>(
    '/api/traces/query',
    async (req, reply) => {
      const { sessionId, type, status, startTime, endTime, limit, offset } = req.query

      const events = await tracer.queryEvents({
        sessionId,
        type: type as any,
        status: status as any,
        startTime: startTime ? parseInt(startTime, 10) : undefined,
        endTime: endTime ? parseInt(endTime, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : 50,
        offset: offset ? parseInt(offset, 10) : 0,
      })

      return {
        count: events.length,
        events: events.map((e) => ({
          traceId: e.traceId,
          seq: e.seq,
          type: e.type,
          time: e.time,
          status: e.status,
          data: e.data,
        })),
      }
    },
  )

  // DELETE /api/traces/cleanup - 清理过期追踪
  app.post<{ Body: { retentionHours?: number } }>(
    '/api/traces/cleanup',
    async (req, reply) => {
      const retentionHours = req.body?.retentionHours ?? 24
      const removed = await tracer.cleanup(retentionHours)
      return { removed, retentionHours }
    },
  )

  // GET /api/traces/stats - 获取统计信息
  app.get('/api/traces/stats', async () => {
    return tracer.getStats()
  })
}