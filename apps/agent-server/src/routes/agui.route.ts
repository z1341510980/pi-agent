import type { FastifyPluginAsync } from 'fastify'
import type { RunAgentInput } from '@ag-ui/core'
import { setupSse, sendSseEvent, sendSseComment, closeSse } from '../lib/sse.js'
import { validateBody } from '../lib/validate.js'
import {
  runAgentInputSchema,
  threadMessageInputSchema,
  forkThreadInputSchema,
  navigateThreadInputSchema,
  compactThreadInputSchema,
  toolsActiveInputSchema,
  reloadInputSchema,
} from '@repo/protocol/schemas'
import { AppError, ErrorCode } from '@repo/shared/errors'

export const aguiRoute: FastifyPluginAsync = async (app) => {
  function getAgent() {
    return app.piAgUiAgent
  }

  function validateAgentId(agentId: string): void {
    const agent = getAgent()
    if (agentId !== agent.agentId) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        `未知的 Agent '${agentId}'，期望 '${agent.agentId}'`,
        404,
      )
    }
  }

  function getThreadIdFromQuery(query: Record<string, unknown>): string {
    const threadId = typeof query.threadId === 'string' ? query.threadId.trim() : ''
    if (!threadId.length) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'threadId 查询参数必填', 400)
    }
    return threadId
  }

  // AG-UI 信息端点
  app.get('/ag-ui/info', async () => {
    const agent = getAgent()
    const stats = app.piSessionStore.getStats()
    return {
      protocol: 'ag-ui',
      version: '0.0.42',
      agents: [
        {
          id: agent.agentId,
          name: 'Pi AG-UI Agent',
          description: '基于 Pi SDK 的 AG-UI 协议端点',
          runEndpoint: `/ag-ui/agent/${agent.agentId}/run`,
        },
      ],
      endpoints: {
        info: '/ag-ui/info',
        run: `/ag-ui/agent/${agent.agentId}/run`,
        steer: `/ag-ui/agent/${agent.agentId}/steer`,
        followUp: `/ag-ui/agent/${agent.agentId}/follow-up`,
        fork: `/ag-ui/agent/${agent.agentId}/fork`,
        navigate: `/ag-ui/agent/${agent.agentId}/navigate`,
        reload: `/ag-ui/agent/${agent.agentId}/reload`,
        tree: `/ag-ui/agent/${agent.agentId}/tree`,
        models: `/ag-ui/agent/${agent.agentId}/models`,
        tools: `/ag-ui/agent/${agent.agentId}/tools`,
        activeTools: `/ag-ui/agent/${agent.agentId}/tools/active`,
        compact: `/ag-ui/agent/${agent.agentId}/compact`,
      },
      sessions: stats,
    }
  })

  // 主运行端点（SSE 流式）
  app.post('/ag-ui/agent/:agentId/run', async (request, reply) => {
    const { agentId } = request.params as { agentId: string }
    validateAgentId(agentId)

    const parsedInput = runAgentInputSchema.safeParse(request.body)
    if (!parsedInput.success) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '无效的 AG-UI RunAgentInput', 400)
    }

    const input = parsedInput.data
    setupSse(reply)
    sendSseComment(reply, `thread=${input.threadId} run=${input.runId}`)

    const abortController = new AbortController()
    const closeHandler = () => abortController.abort()
    request.raw.on('aborted', closeHandler)
    reply.raw.on('close', closeHandler)

    try {
      const agent = getAgent()
      await agent.streamRun(
        input as unknown as RunAgentInput,
        (event) => sendSseEvent(reply, event),
        { signal: abortController.signal },
      )
    } catch (error) {
      if (!abortController.signal.aborted) {
        const message = error instanceof Error ? error.message : 'AG-UI 运行失败'
        sendSseEvent(reply, { type: 'RUN_ERROR', message })
      }
    } finally {
      request.raw.off('aborted', closeHandler)
      reply.raw.off('close', closeHandler)
      closeSse(reply)
    }

    return reply
  })

  // 中途引导
  app.post('/ag-ui/agent/:agentId/steer', async (request, reply) => {
    const { agentId } = request.params as { agentId: string }
    validateAgentId(agentId)
    const input = validateBody(threadMessageInputSchema, request, reply)
    if (!input) return reply

    await getAgent().steerThread(input.threadId, input.text)
    return { status: 'accepted', threadId: input.threadId }
  })

  // 后续消息
  app.post('/ag-ui/agent/:agentId/follow-up', async (request, reply) => {
    const { agentId } = request.params as { agentId: string }
    validateAgentId(agentId)
    const input = validateBody(threadMessageInputSchema, request, reply)
    if (!input) return reply

    await getAgent().followUpThread(input.threadId, input.text)
    return { status: 'accepted', threadId: input.threadId }
  })

  // 分叉
  app.post('/ag-ui/agent/:agentId/fork', async (request, reply) => {
    const { agentId } = request.params as { agentId: string }
    validateAgentId(agentId)
    const input = validateBody(forkThreadInputSchema, request, reply)
    if (!input) return reply

    const result = await getAgent().forkThread(input.threadId, input.entryId)
    return { status: result.cancelled ? 'cancelled' : 'forked', ...result }
  })

  // 导航
  app.post('/ag-ui/agent/:agentId/navigate', async (request, reply) => {
    const { agentId } = request.params as { agentId: string }
    validateAgentId(agentId)
    const input = validateBody(navigateThreadInputSchema, request, reply)
    if (!input) return reply

    const threadSession = await app.piSessionStore.getOrCreate(input.threadId)
    const navResult = await threadSession.session.navigateTree(input.targetId, {
      summarize: input.summarize ?? true,
      ...(input.customInstructions ? { customInstructions: input.customInstructions } : {}),
    })
    return { status: 'navigated', ...navResult }
  })

  // 重载
  app.post('/ag-ui/agent/:agentId/reload', async (request, reply) => {
    const { agentId } = request.params as { agentId: string }
    validateAgentId(agentId)
    const input = validateBody(reloadInputSchema, request, reply)
    if (!input) return reply

    if (input?.threadId) {
      await getAgent().reloadThread(input.threadId)
      return { status: 'reloaded', threadsReloaded: 1 }
    }

    const sessions = app.piSessionStore.getActiveThreadSessions()
    for (const session of sessions) {
      await session.session.reload()
    }
    return { status: 'reloaded', threadsReloaded: sessions.length }
  })

  // 会话树
  app.get('/ag-ui/agent/:agentId/tree', async (request) => {
    const { agentId } = request.params as { agentId: string }
    validateAgentId(agentId)
    const threadId = getThreadIdFromQuery(request.query as Record<string, unknown>)
    const tree = await getAgent().getThreadTree(threadId)
    return { threadId, tree }
  })

  // 可用模型
  app.get('/ag-ui/agent/:agentId/models', async (request) => {
    const { agentId } = request.params as { agentId: string }
    validateAgentId(agentId)
    const threadId = getThreadIdFromQuery(request.query as Record<string, unknown>)
    const models = await getAgent().getThreadModels(threadId)
    return { threadId, models }
  })

  // 工具列表
  app.get('/ag-ui/agent/:agentId/tools', async (request) => {
    const { agentId } = request.params as { agentId: string }
    validateAgentId(agentId)
    const threadId = getThreadIdFromQuery(request.query as Record<string, unknown>)
    const toolsState = await getAgent().getThreadTools(threadId)
    return { threadId, ...toolsState }
  })

  // 设置活跃工具
  app.post('/ag-ui/agent/:agentId/tools/active', async (request, reply) => {
    const { agentId } = request.params as { agentId: string }
    validateAgentId(agentId)
    const input = validateBody(toolsActiveInputSchema, request, reply)
    if (!input) return reply

    const activeToolNames = await getAgent().setThreadActiveTools(input.threadId, input.toolNames)
    return { status: 'updated', threadId: input.threadId, activeToolNames }
  })

  // 手动压缩
  app.post('/ag-ui/agent/:agentId/compact', async (request, reply) => {
    const { agentId } = request.params as { agentId: string }
    validateAgentId(agentId)
    const input = validateBody(compactThreadInputSchema, request, reply)
    if (!input) return reply

    const result = await getAgent().compactThread(input.threadId, input.customInstructions)
    return { status: 'compacted', threadId: input.threadId, result }
  })
}
