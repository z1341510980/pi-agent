/**
 * 多 Agent 协作 API 路由
 *
 * 端点：
 * - GET    /api/agents                — 列出所有可用 Agent
 * - GET    /api/agents/channels       — 列出所有频道
 * - POST   /api/agents/:id/channel    — 发送频道消息
 * - POST   /api/agents/:id/dm         — 发送私信
 * - POST   /api/agents/:id/dispatch   — 派遣子任务（手动触发 subagent）
 * - GET    /api/agents/limiter/stats  — 并发限流器状态
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { success } from '../lib/api-response.js'
import { validateBody } from '../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

export const agentsRoute: FastifyPluginAsync = async (app) => {
  const manager = app.subagentManager
  const channel = manager.getChannel()

  /**
   * GET /api/agents
   * 列出所有可用 Agent
   */
  app.get('/api/agents', async (req) => {
    const agents = manager.listAgents()
    return success(agents, req.traceId)
  })

  /**
   * GET /api/agents/channels
   * 列出所有频道
   */
  app.get('/api/agents/channels', async (req) => {
    const channels = channel.listChannels()
    return success(channels, req.traceId)
  })

  /**
   * GET /api/agents/limiter/stats
   * 并发限流器状态
   */
  app.get('/api/agents/limiter/stats', async (req) => {
    const limiter = manager.getLimiter()
    return success(
      {
        activeCount: limiter.getActiveCount(),
        totalCount: limiter.getTotalCount(),
        queueLength: limiter.getQueueLength(),
      },
      req.traceId,
    )
  })

  /**
   * POST /api/agents/:id/channel
   * 发送频道消息
   *
   * Body: { channel: string, content: unknown }
   */
  const channelSchema = z.object({
    channel: z.string().min(1).describe('频道名'),
    content: z.unknown().describe('消息内容'),
  })

  app.post<{ Params: { id: string } }>(
    '/api/agents/:id/channel',
    async (req, reply) => {
      const input = validateBody(channelSchema, req, reply)
      if (!input) return reply

      const agentId = req.params.id
      // 验证 Agent 存在
      if (!manager.getAgent(agentId)) {
        throw new AppError(ErrorCode.NOT_FOUND, `Agent 不存在: ${agentId}`, 404)
      }

      const deliveredTo = channel.broadcast(input.channel, agentId, input.content)
      return success(
        { channel: input.channel, fromAgentId: agentId, deliveredTo },
        req.traceId,
      )
    },
  )

  /**
   * POST /api/agents/:id/dm
   * 发送私信
   *
   * Body: { toAgentId: string, content: unknown }
   */
  const dmSchema = z.object({
    toAgentId: z.string().min(1).describe('接收者 Agent ID'),
    content: z.unknown().describe('消息内容'),
  })

  app.post<{ Params: { id: string } }>(
    '/api/agents/:id/dm',
    async (req, reply) => {
      const input = validateBody(dmSchema, req, reply)
      if (!input) return reply

      const fromAgentId = req.params.id
      // 验证发送者存在
      if (!manager.getAgent(fromAgentId)) {
        throw new AppError(ErrorCode.NOT_FOUND, `Agent 不存在: ${fromAgentId}`, 404)
      }
      // 验证接收者存在
      if (!manager.getAgent(input.toAgentId)) {
        throw new AppError(ErrorCode.NOT_FOUND, `接收者 Agent 不存在: ${input.toAgentId}`, 404)
      }

      channel.sendDm(fromAgentId, input.toAgentId, input.content)
      return success(
        { fromAgentId, toAgentId: input.toAgentId, sent: true },
        req.traceId,
      )
    },
  )

  /**
   * POST /api/agents/:id/dispatch
   * 手动派遣子任务给指定 Agent
   *
   * Body: { task: string, timeout?: number }
   */
  const dispatchSchema = z.object({
    task: z.string().min(1).describe('任务描述'),
    timeout: z.number().min(1000).max(600000).optional().describe('超时毫秒数'),
  })

  app.post<{ Params: { id: string } }>(
    '/api/agents/:id/dispatch',
    async (req, reply) => {
      const input = validateBody(dispatchSchema, req, reply)
      if (!input) return reply

      const agentId = req.params.id
      if (!manager.getAgent(agentId)) {
        throw new AppError(ErrorCode.NOT_FOUND, `Agent 不存在: ${agentId}`, 404)
      }

      const result = await manager.dispatchToAgent(agentId, input.task, {
        timeoutMs: input.timeout,
      })
      return success(result, req.traceId)
    },
  )

  /**
   * POST /api/agents/:id/subscribe
   * 订阅 Agent 到指定频道
   *
   * Body: { channel: string }
   */
  const subscribeSchema = z.object({
    channel: z.string().min(1).describe('频道名'),
  })

  app.post<{ Params: { id: string } }>(
    '/api/agents/:id/subscribe',
    async (req, reply) => {
      const input = validateBody(subscribeSchema, req, reply)
      if (!input) return reply

      const agentId = req.params.id
      if (!manager.getAgent(agentId)) {
        throw new AppError(ErrorCode.NOT_FOUND, `Agent 不存在: ${agentId}`, 404)
      }

      channel.subscribe(input.channel, agentId)
      return success(
        { agentId, channel: input.channel, subscribed: true },
        req.traceId,
      )
    },
  )

  /**
   * GET /api/agents/:id/dm
   * 获取 Agent 的私信历史
   */
  app.get<{ Params: { id: string } }>(
    '/api/agents/:id/dm',
    async (req) => {
      const agentId = req.params.id
      if (!manager.getAgent(agentId)) {
        throw new AppError(ErrorCode.NOT_FOUND, `Agent 不存在: ${agentId}`, 404)
      }
      const messages = channel.getDmMessages(agentId)
      return success(messages, req.traceId)
    },
  )

  /**
   * GET /api/agents/channels/:name/messages
   * 获取频道消息历史
   */
  app.get<{ Params: { name: string } }>(
    '/api/agents/channels/:name/messages',
    async (req) => {
      const messages = channel.getChannelMessages(req.params.name)
      return success(messages, req.traceId)
    },
  )
}
