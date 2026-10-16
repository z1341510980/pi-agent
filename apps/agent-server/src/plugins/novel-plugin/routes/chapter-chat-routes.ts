import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { createNovelAgUiEmitter, createSseEmitterSink } from '../utils/sse-emitter.js'
import { persistRouteFailureAudit } from './route-failure-audit.js'
import { modelSelectionSchema } from './model-selection-contract.js'
import { requireNovelChapter } from './chapter-route-helpers.js'

const chatBodySchema = z.object({
  message: z.string().min(1).max(8000),
  mentionedAgents: z.array(z.string()).max(10).optional(),
  modelId: modelSelectionSchema.optional(),
  styleExpertIds: z.array(z.string().min(1).max(80)).max(8).optional(),
})

const persistChatSchema = z.object({
  phase: z.enum(['pre_creation', 'checkpoint', 'discussion', 'review']),
  role: z.enum(['user', 'system']).default('user'),
  content: z.string().min(1).max(20000),
  fromId: z.string().optional().default('user'),
  fromName: z.string().optional().default('用户'),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export function createChapterChatRoutes(
  services: Pick<NovelServices, 'store' | 'chapterChatStore' | 'chapterChatRunner'>,
): RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/projects/:projectId/chapters/:chapterNumber/chat',
      handler: async (request: any) => {
        const { projectId, chapterNumber } = request.params
        const chapterNum = requireNovelChapter(services, projectId, chapterNumber)
        return success(services.chapterChatStore.list(projectId, chapterNum), request.traceId)
      },
    },
    {
      method: 'DELETE',
      path: '/projects/:projectId/chapters/:chapterNumber/chat',
      handler: async (request: any) => {
        const { projectId, chapterNumber } = request.params
        const chapterNum = requireNovelChapter(services, projectId, chapterNumber)
        services.chapterChatStore.clear(projectId, chapterNum)
        return success({ cleared: true }, request.traceId)
      },
    },
    {
      method: 'POST',
      path: '/projects/:projectId/chapters/:chapterNumber/chat',
      handler: async (request: any, reply: any) => {
        const { projectId, chapterNumber } = request.params
        const input = validateBody(chatBodySchema, request, reply)
        if (!input) return reply
        const chapterNum = requireNovelChapter(services, projectId, chapterNumber)

        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': request.headers.origin || '*',
          'Access-Control-Allow-Credentials': 'true',
        })
        request.raw.socket?.setNoDelay?.(true)

        const heartbeat = setInterval(() => {
          reply.raw.write(': keepalive\\n\\n')
        }, 15000)
        const threadId = 'novel:chat:' + projectId + ':' + chapterNum
        const emitter = createNovelAgUiEmitter(
          createSseEmitterSink((data) => reply.raw.write(data)),
          threadId,
          randomUUID(),
        )
        const startedAt = Date.now()

        try {
          const result = await services.chapterChatRunner.run(
            projectId,
            chapterNum,
            { message: input.message, mentionedAgents: input.mentionedAgents },
            {
              emit: emitter.emit,
              modelId: input.modelId,
              styleExpertIds: input.styleExpertIds,
            },
          )
          emitter.result({ status: 'completed', replies: result.replies })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          persistRouteFailureAudit({
            store: services.store,
            request,
            sourceFile: 'apps/agent-server/src/plugins/novel-plugin/routes/chapter-chat-routes.ts',
            sourceSymbol: 'createChapterChatRoutes > POST /projects/:projectId/chapters/:chapterNumber/chat',
            projectId,
            chapterNumber: chapterNum,
            operation: 'chapter-chat',
            input,
            errorCode: 'chapter_chat_request_failed',
            error,
            durationMs: Date.now() - startedAt,
            phase: 'chat',
            auditFailureMessage: '章节聊天错误审计写入失败',
          })
          emitter.error(message)
        } finally {
          clearInterval(heartbeat)
          reply.raw.end()
        }
      },
    },
    {
      method: 'POST',
      path: '/projects/:projectId/chapters/:chapterNumber/chat/persist',
      handler: async (request: any, reply: any) => {
        const { projectId, chapterNumber } = request.params
        const input = validateBody(persistChatSchema, request, reply)
        if (!input) return reply
        const chapterNum = requireNovelChapter(services, projectId, chapterNumber)
        const message = services.chapterChatStore.add({
          projectId,
          chapterNumber: chapterNum,
          role: input.role,
          fromId: input.fromId,
          fromName: input.fromName,
          content: input.content,
          phase: input.phase,
          metadata: input.metadata as Record<string, unknown> | undefined,
        })
        return success(message, request.traceId)
      },
    },
  ]
}
