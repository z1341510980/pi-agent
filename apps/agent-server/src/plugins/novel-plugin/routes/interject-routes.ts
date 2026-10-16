import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import {
  activeNovelChapterTasks,
  announceInterjectQueued,
  getInterjectEnqueuer,
} from '../utils/chapter-task-registry.js'

export function createInterjectRoutes(services: Pick<NovelServices, 'orchestrator' | 'chapterChatStore'>): RouteDefinition[] {
  const routes: RouteDefinition[] = []

    const interjectMessageSchema = z.object({
      content: z.string().min(1).max(4000),
      targetAgent: z.enum(['director', 'writer', 'reviewer', 'reviser', 'memory']).optional(),
      chapterNumber: z.number().int().min(1).optional(),
    })

    routes.push({
      method: 'POST',
      path: '/projects/:projectId/flows/:flowId/messages',
      handler: async (request: any, reply: any) => {
        const { projectId, flowId } = request.params as { projectId: string; flowId: string }
        const input = validateBody(interjectMessageSchema, request, reply)
        if (!input) return reply

        const queryChapter = Number((request.query as Record<string, string | undefined>)?.chapterNumber)
        let chapterNumber = input.chapterNumber
          ?? (Number.isInteger(queryChapter) && queryChapter > 0 ? queryChapter : undefined)

        // create-flow（kind='workflow'）经 orchestrator 消费（drain）并终态收尾（dropped）插话；
        // create-discussion（kind='discussion'，批次 1 任务 3）经 runner 登记的 engine
        // enqueue 闭包入队，Moderator 每轮 decide 前 drain、engine 收尾 dropped。
        // 其余流程（编排/反推等）无此通道，入队只会石沉大海。
        const locateByFlowId = chapterNumber == null
        let task = chapterNumber
          ? activeNovelChapterTasks.get(`${projectId}:${chapterNumber}`)
          : undefined
        if (locateByFlowId) {
          for (const [candidateLockKey, candidateTask] of activeNovelChapterTasks) {
            if (!candidateLockKey.startsWith(`${projectId}:`) || candidateTask.flowId !== flowId) continue
            const candidateChapter = Number(candidateLockKey.slice(projectId.length + 1))
            if (!Number.isInteger(candidateChapter) || candidateChapter < 1) continue
            chapterNumber = candidateChapter
            task = candidateTask
            break
          }
        }
        if (!task || (task.kind !== 'workflow' && task.kind !== 'discussion' && task.kind !== 'discussion-resume')) {
          reply.code(409).send({ ok: false, error: '该章节当前没有运行中的可插话创作流程（工作流/群聊），无法接收插话' })
          return
        }
        if (task.flowId !== flowId) {
          reply.code(409).send({ ok: false, error: 'flowId 已过期或不属于当前运行中的创作流程' })
          return
        }

        // 命中任务后 chapterNumber 必然来自显式参数或活动任务 key。
        const resolvedChapterNumber = chapterNumber as number
        const flowKey = `${projectId}|${resolvedChapterNumber}|${task.flowId}`

        // 群聊分支：无 targetAgent 语义（Moderator 自主决定响应方式），定向字段直接拒绝
        if (task.kind === 'discussion' || task.kind === 'discussion-resume') {
          if (input.targetAgent) {
            reply.code(400).send({
              ok: false,
              error: '群聊插话不支持 targetAgent：由主持人自主决定如何响应，请省略 targetAgent 后重试',
            })
            return
          }
          const enqueue = getInterjectEnqueuer(flowKey)
          if (!enqueue) {
            // 极小竞态窗口：任务已注册但 runner 尚未创建 engine（或刚好已收尾）
            reply.code(409).send({ ok: false, error: '群聊引擎尚未就绪或已结束，请稍后重试' })
            return
          }
          const discussionMessageId = randomUUID()
          // 闭包存活标记（TOCTOU 防护）：取到闭包与实际投递之间引擎可能刚好收尾
          // （engine finally 已 flush dropped），enqueue 返回 false 时按已收尾拒绝，
          // 不推 queued 事件、不落库，让前端立即感知流程已结束。
          if (!enqueue({
            id: discussionMessageId,
            content: input.content,
            createdAt: Date.now(),
          })) {
            reply.code(409).send({ ok: false, error: '群聊引擎已收尾，不再接收插话' })
            return
          }
          announceInterjectQueued({
            flowKey,
            flowId,
            messageId: discussionMessageId,
            content: input.content,
          })
          // queued 状态经 flow 注册的 publisher → emitter → mirror sink 落事件流，
          // 与旧 SSE 同一条 novel:user-message 事件契约。
          try {
            services.chapterChatStore.add({
              projectId,
              chapterNumber: resolvedChapterNumber,
              role: 'user',
              fromId: 'user',
              fromName: '用户',
              content: input.content,
              phase: 'discussion',
              metadata: {
                interject: true,
                messageId: discussionMessageId,
                flowMode: 'discussion',
                flowId,
                interjectStatus: 'queued',
              },
            })
          } catch (err) {
            request.log.error({ err, projectId, chapterNumber: resolvedChapterNumber, messageId: discussionMessageId }, '群聊插话消息落库失败')
          }
          reply.code(201).send(success({ flowId, messageId: discussionMessageId, status: 'queued' }, request.traceId))
          return
        }
        const messageId = randomUUID()
        const accepted = services.orchestrator.enqueueUserMessage({
          id: messageId,
          content: input.content,
          targetAgent: input.targetAgent,
          flowKey,
        })
        if (!accepted) {
          reply.code(409).send({
            ok: false,
            error: '创作流程已收尾，不再接收插话',
          })
          return
        }

        // 立即向该 flow 的 SSE 通道推 queued 事件（登记详情供 hooks 回查 injected/dropped）
        announceInterjectQueued({
          flowKey,
          flowId,
          messageId,
          content: input.content,
          targetAgent: input.targetAgent,
        })

        // 插话成功即写 chapterChatStore（前端按 metadata.interject 渲染状态徽标）；
        // 写入失败只记日志，不影响 201 响应、flow 运行（端点本就在 flow 之外，无共享可变状态）。
        try {
          services.chapterChatStore.add({
            projectId,
            chapterNumber: resolvedChapterNumber,
            role: 'user',
            fromId: 'user',
            fromName: '用户',
            content: input.content,
            phase: 'checkpoint',
            metadata: {
              interject: true,
              messageId,
              targetAgent: input.targetAgent,
              flowMode: 'workflow',
              flowId,
              interjectStatus: 'queued',
            },
          })
        } catch (err) {
          request.log.error({ err, projectId, chapterNumber: resolvedChapterNumber, messageId }, '插话消息落库失败')
        }

        reply.code(201).send(success({ flowId, messageId, status: 'queued' }, request.traceId))
      },
    })

  return routes
}
