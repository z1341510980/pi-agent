/**
 * 创作流程相关路由
 *
 * 拆分自原 novel-routes.ts（PR-6），包含所有 SSE 流式创作流程：
 * - cancel-active-flow（统一取消：工作流/群聊/编排/反推共用同一任务控制器）
 * - create-flow（多 Agent 创作流程 SSE + 检查点）
 * - 检查点决策（workflow / discussion 共用）
 * - create-discussion（群聊共创 SSE）+ 断点续跑 + 群聊检查点
 * - discussion-settings（群聊模式设置 GET/PUT）
 * - ai-arrange（按章纲生成实体并编排到矩阵 SSE）
 * - reverse-arrange（从已写正文反推实体到矩阵 SSE）
 * - create-team（TeamManager 统一触发 pipeline）
 * - agent-logs（Agent 调用日志 GET/DELETE）
 * - markers（时间轴标记 CRUD）
 * - agent-config（Agent 角色温度配置 GET/PUT）
 * - chat（章节聊天 GET/POST/DELETE + persist）
 *
 * 共享状态：通过 utils/chapter-task-registry.ts 模块级单例 Map/Set 跨子路由共享锁与 abort 控制器。
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import type { NovelMarker } from '../core/types.js'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import type { CheckpointDecision, CheckpointType } from '@repo/shared/novel'
import { getAllNovelAgentTemperatures, updateNovelAgentTemperatures, type NovelAgentType } from '../core/novel-agents.js'
import { persistDiscussionHistory } from '../core/discussion-history.js'
import type { DiscussionResult } from '../../../core/agent/discussion-types.js'
import {
  aiArrangeLocks,
  chapterCreationLocks,
  activeNovelChapterTasks,
  registerNovelChapterTask,
  finishNovelChapterTask,
} from '../utils/chapter-task-registry.js'
import { createNovelAgUiEmitter, createSseEmitterSink } from '../utils/sse-emitter.js'
import { cancelDebug } from '../utils/cancel-debug-log.js'
import {
  creationFlowBodySchema,
  parseArrangedEntities,
  findForeignArrangedEntities,
} from './arranged-entities-contract.js'

export function createCreationFlowRoutes(services: NovelServices): RouteDefinition[] {
  const { store } = services
  const routes: RouteDefinition[] = []

  // ═══════════════════════════════════════════════════════════════
  // 多 Agent 创作流程（SSE + 检查点）
  // ═══════════════════════════════════════════════════════════════

  // 章节大流程统一取消：工作流、群聊、编排、反推均使用同一个任务控制器。
  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters/:chapterNumber/cancel-active-flow',
    handler: async (request: any, reply: any) => {
      const { projectId, chapterNumber } = request.params as { projectId: string; chapterNumber: string }
      const lockKey = `${projectId}:${chapterNumber}`
      const task = activeNovelChapterTasks.get(lockKey)
      cancelDebug('cancel-entry', { projectId, chapterNumber, lockKey, hasTask: !!task, kind: task?.kind })
      if (!task) {
        cancelDebug('cancel-no-task', { projectId, chapterNumber })
        return reply.send({ ok: true, data: { cancelled: false, reason: '当前没有运行中的章节流程' } })
      }

      // 如果已经 abort 过（重复取消请求），直接等待 donePromise
      const alreadyAborted = task.controller.signal.aborted
      cancelDebug('cancel-abort-check', { projectId, chapterNumber, alreadyAborted, kind: task.kind })

      // 检查点可能正在等待一个无超时 Promise。先用 reject 唤醒它，再中止 LLM。
      if (!alreadyAborted) {
        const workflowThreadId = `novel-checkpoint-${projectId}-${chapterNumber}`
        const discussionThreadId = `novel-discussion-${projectId}-${chapterNumber}`
        const pendingList = services.confirmationManager.listPending()
        const matchedPending = pendingList.filter(
          (p) => p.threadId === workflowThreadId || p.threadId === discussionThreadId,
        )
        cancelDebug('cancel-pending', { projectId, chapterNumber, pendingCount: pendingList.length, matchedCount: matchedPending.length })
        for (const pending of matchedPending) {
          services.confirmationManager.respondDecision(pending.id, 'reject')
        }
        task.controller.abort(new Error('用户手动停止创作流程'))
        cancelDebug('cancel-abort-called', { projectId, chapterNumber, signalAborted: task.controller.signal.aborted })
      }

      // 等待 orchestrator 真正完成：LLM 自己响应 abort → catch → finally 块清理锁。
      await task.donePromise
      cancelDebug('cancel-done-resolved', { projectId, chapterNumber, kind: task.kind, lockStillExists: activeNovelChapterTasks.has(lockKey) })

      return reply.send({
        ok: true,
        data: { cancelled: true, kind: task.kind, startedAt: task.startedAt },
      })
    },
  })

  // 创作流程启动端点（SSE）
  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters/:chapterNumber/create-flow',
    handler: async (request: any, reply: any) => {
      const { projectId, chapterNumber } = request.params
      const orchestrator = services.orchestrator
      const input = validateBody(creationFlowBodySchema, request, reply)
      if (!input) return reply
      const arrangedEntities = parseArrangedEntities(input)

      if (arrangedEntities) {
        const invalid = findForeignArrangedEntities(store, projectId, arrangedEntities)
        if (invalid.length > 0) {
          reply.code(400).send({ ok: false, error: `编排实体不属于当前项目或不存在: ${invalid.join(', ')}` })
          return
        }
      }

      const creationLockKey = `${projectId}:${chapterNumber}`
      if (chapterCreationLocks.has(creationLockKey) || aiArrangeLocks.has(creationLockKey) || activeNovelChapterTasks.has(creationLockKey)) {
        reply.code(409).send({ ok: false, error: '该章节正在创作中，请勿重复启动编排或群聊流程' })
        return
      }

      // 设置 SSE
      // 注意：reply.raw.writeHead 绕过 Fastify 的 CORS 中间件，需手动附加 CORS 头，
      // 否则浏览器会以 CORS 策略拦截跨域 SSE 请求（如 localhost:5173 → 127.0.0.1:3900）。
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': request.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true',
      })
      // 禁用 Nagle 算法，确保 SSE 事件立即 flush 到客户端
      request.raw.socket?.setNoDelay?.(true)

      const heartbeat = setInterval(() => {
        reply.raw.write(': keepalive\n\n')
      }, 15000)

      const emitter = createNovelAgUiEmitter(
        createSseEmitterSink((data) => reply.raw.write(data)),
        `novel:chapter:${projectId}:${chapterNumber}`,
        randomUUID(),
      )
      const chapterNumberValue = parseInt(chapterNumber, 10)
      const workflowRunId = randomUUID()
      const persistWorkflowMessage = (message: {
        role: 'agent' | 'system'
        fromId: string
        fromName: string
        content: string
        phase: 'pre_creation' | 'checkpoint' | 'discussion' | 'review'
        metadata?: Record<string, unknown>
      }): void => {
        services.chapterChatStore.add({
          projectId,
          chapterNumber: chapterNumberValue,
          ...message,
          metadata: {
            ...message.metadata,
            flowMode: 'workflow',
            workflowRunId,
          },
        })
      }
      const task = registerNovelChapterTask(creationLockKey, 'workflow')
      const abortOnDisconnect = () => {
        if (!reply.raw.writableEnded && !task.controller.signal.aborted) {
          task.controller.abort(new Error('客户端已断开创作流'))
        }
      }
      reply.raw.once('close', abortOnDisconnect)

      try {
        chapterCreationLocks.add(creationLockKey)
        persistWorkflowMessage({
          role: 'system',
          fromId: 'system',
          fromName: '系统',
          content: `开始第 ${chapterNumberValue} 章工作流创作`,
          phase: 'pre_creation',
          metadata: { workflowMessageType: 'run_start' },
        })
        const result = await orchestrator.createChapterWithFlow(
          projectId,
          chapterNumberValue,
          {
            emit: emitter.emit,
            onCheckpoint: async (checkpoint) => {
              // 通过 ConfirmationManager 发起决策请求
              // timeoutMs=0 表示无超时：用户可能需要长时间阅读/checkpoint 内容并思考，
              // 不应因超时自动 reject 导致弹框消失、创作被取消
              const toolCallId = randomUUID()
              const checkpointCreatedAt = Date.now()
              const decisionPromise = services.confirmationManager.requestDecision({
                threadId: `novel-checkpoint-${projectId}-${chapterNumber}`,
                toolCallId,
                toolName: `checkpoint_${checkpoint.type}`,
                args: { checkpoint, workflowRunId } as Record<string, unknown>,
                reason: `等待用户确认 ${checkpoint.type} 检查点`,
              }, 0)
              // requestDecision 内部已同步把 pending 加入 Map，listPending 立即可见
              // 通过 toolCallId 反查拿到 ConfirmationRequest.id，推给前端用于决策路由
              const pending = services.confirmationManager.listPending().find((r) => r.toolCallId === toolCallId)
              const persistedCheckpoint = {
                ...checkpoint,
                checkpointId: pending?.id,
                createdAt: checkpointCreatedAt,
              }
              persistWorkflowMessage({
                role: 'system',
                fromId: 'system',
                fromName: '检查点',
                content: typeof checkpoint.data === 'string'
                  ? checkpoint.data
                  : JSON.stringify(checkpoint.data) ?? '',
                phase: 'checkpoint',
                metadata: {
                  workflowMessageType: 'checkpoint',
                  checkpointId: pending?.id,
                  checkpointType: checkpoint.type,
                  checkpointData: checkpoint.data,
                  checkpointOptions: checkpoint.options,
                },
              })
              emitter.checkpoint(persistedCheckpoint)
              return decisionPromise as Promise<'approve' | 'reject' | 'revise' | 'rewrite'>
            },
            onProgress: (event) => emitter.progress(event),
            onConversationMessage: persistWorkflowMessage,
            signal: task.controller.signal,
            arrangedEntities,
          },
        )
        persistWorkflowMessage({
          role: 'system',
          fromId: 'system',
          fromName: '系统',
          content: result.status === 'completed'
            ? '工作流创作完成'
            : result.status === 'cancelled'
              ? '工作流创作已取消'
              : `工作流创作结束：${result.error ?? result.status}`,
          phase: 'review',
          metadata: { workflowMessageType: 'run_end' },
        })
        emitter.result(result)
      } catch (err) {
        persistWorkflowMessage({
          role: 'system',
          fromId: 'system',
          fromName: '系统',
          content: `工作流创作失败：${err instanceof Error ? err.message : String(err)}`,
          phase: 'review',
          metadata: { workflowMessageType: 'run_end', failed: true },
        })
        cancelDebug('create-flow-catch', { projectId, chapterNumber, errMessage: err instanceof Error ? err.message : String(err), errStack: err instanceof Error ? err.stack : undefined, signalAborted: task.controller.signal.aborted })
        emitter.error(String(err))
      } finally {
        clearInterval(heartbeat)
        reply.raw.off('close', abortOnDisconnect)
        cancelDebug('create-flow-finally-pre', { projectId, chapterNumber, signalAborted: task.controller.signal.aborted })
        finishNovelChapterTask(creationLockKey, task)
        chapterCreationLocks.delete(creationLockKey)
        cancelDebug('create-flow-finally-post', { projectId, chapterNumber, lockExists: chapterCreationLocks.has(creationLockKey), taskExists: activeNovelChapterTasks.has(creationLockKey) })
        reply.raw.end()
      }
    },
  })

  // 检查点决策端点
  // 路径参数 :checkpointId 对应 ConfirmationManager 内部生成的 ConfirmationRequest.id
  // （由 onCheckpoint 在创建决策请求后通过 SSE 推送给前端，前端在用户点决策时回传）
  // type 仍在 body 中传递，便于日志/校验（不再作为路由参数）
  //
  // 同时接受 workflow（novel-checkpoint-）与群聊（novel-discussion-）两种 threadId 前缀：
  // 前端 use-novel-creation-flow.ts 的 submitCheckpoint 统一调用本端点，
  // 群聊模式的 /discussion-checkpoint/.../decision 端点作为别名保留。
  routes.push({
    method: 'POST',
    path: '/projects/:projectId/checkpoint/:checkpointId/decision',
    handler: async (request: any, reply: any) => {
      const { projectId, checkpointId } = request.params as { projectId: string; checkpointId: string }
      const { decision, userMessages } = request.body as { decision: string; userMessages?: string[] }
      const pending = services.confirmationManager.listPending().find((r) => r.id === checkpointId)
      const isWorkflow = pending?.threadId.startsWith(`novel-checkpoint-${projectId}-`)
      const isDiscussion = pending?.threadId.startsWith(`novel-discussion-${projectId}-`)
      if (!pending || (!isWorkflow && !isDiscussion)) {
        reply.code(404).send({ ok: false, error: '检查点不存在或已处理' })
        return
      }
      const pendingCheckpoint = (pending.args as { checkpoint?: { options?: CheckpointDecision[] } }).checkpoint
      if (!pendingCheckpoint?.options?.includes(decision as CheckpointDecision)) {
        reply.code(400).send({ ok: false, error: '该检查点不支持此决策，可能已过期' })
        return
      }
      // 先写入用户消息，再唤醒等待中的 create-flow，避免恢复后的 Agent 抢先读取空消息。
      if (isWorkflow && userMessages && userMessages.length > 0) {
        const chapterText = pending.threadId.slice(`novel-checkpoint-${projectId}-`.length)
        const chapterNumber = Number(chapterText)
        if (Number.isInteger(chapterNumber) && chapterNumber > 0) {
          services.orchestrator.setUserMessages(projectId, chapterNumber, userMessages)
        }
      }

      if (isWorkflow) {
        const chapterText = pending.threadId.slice(`novel-checkpoint-${projectId}-`.length)
        const chapterNumber = Number(chapterText)
        const checkpointArgs = pending.args as {
          checkpoint?: { type?: CheckpointType }
          workflowRunId?: string
        }
        if (Number.isInteger(chapterNumber) && chapterNumber > 0) {
          const checkpointType = checkpointArgs.checkpoint?.type
          services.chapterChatStore.add({
            projectId,
            chapterNumber,
            role: 'system',
            fromId: 'system',
            fromName: '检查点决策',
            content: `用户选择：${describeDecision(checkpointType, decision)}`,
            phase: 'checkpoint',
            metadata: {
              flowMode: 'workflow',
              workflowRunId: checkpointArgs.workflowRunId,
              workflowMessageType: 'decision',
              checkpointId,
              checkpointType: checkpointArgs.checkpoint?.type,
              decision,
            },
          })
        }
      }

      // 委托 ConfirmationManager 响应决策（resolve 对应 pending Promise）
      const accepted = services.confirmationManager.respondDecision(checkpointId, decision)
      if (!accepted) {
        reply.code(404).send({ ok: false, error: '检查点不存在或已处理' })
        return
      }
      return { ok: true, data: { accepted: true } }
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 群聊共创模式（SSE + 检查点）
  // ═══════════════════════════════════════════════════════════════

  // 群聊创作流程启动端点（SSE）
  // 与 /create-flow 结构一致，把 orchestrator.createChapterWithFlow 换成 discussionRunner.run。
  // 每次运行时从 discussionSettingsStore 读取最新 moderatorModel，使 PUT /discussion-settings 的修改即时生效。
  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters/:chapterNumber/create-discussion',
    handler: async (request: any, reply: any) => {
      const { projectId, chapterNumber } = request.params
      const discussionRunner = services.discussionRunner

      // 解析请求体中的 arrangedEntities（与 create-flow 端点一致，复用同一 schema）
      const input = validateBody(creationFlowBodySchema, request, reply)
      if (!input) return reply
      const arrangedEntities = parseArrangedEntities(input)

      // 校验编排实体属于当前项目（与 create-flow 一致）
      if (arrangedEntities) {
        const invalid = findForeignArrangedEntities(store, projectId, arrangedEntities)
        if (invalid.length > 0) {
          reply.code(400).send({ ok: false, error: `编排实体不属于当前项目或不存在: ${invalid.join(', ')}` })
          return
        }
      }

      const creationLockKey = `${projectId}:${chapterNumber}`
      if (chapterCreationLocks.has(creationLockKey) || aiArrangeLocks.has(creationLockKey) || activeNovelChapterTasks.has(creationLockKey)) {
        reply.code(409).send({ ok: false, error: '该章节正在创作中，请勿重复启动编排或群聊流程' })
        return
      }

      // 设置 SSE（与 create-flow 一致，绕过 Fastify CORS 中间件需手动附加 CORS 头）
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': request.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true',
      })
      // 禁用 Nagle 算法，确保 SSE 事件立即 flush 到客户端
      request.raw.socket?.setNoDelay?.(true)

      const heartbeat = setInterval(() => {
        reply.raw.write(': keepalive\n\n')
      }, 15000)

      const discussionRunId = randomUUID()
      const emitter = createNovelAgUiEmitter(
        createSseEmitterSink((data) => reply.raw.write(data)),
        `novel:discussion:${projectId}:${chapterNumber}`,
        discussionRunId,
      )
      const task = registerNovelChapterTask(creationLockKey, 'discussion')
      const abortOnDisconnect = () => {
        if (!reply.raw.writableEnded && !task.controller.signal.aborted) {
          task.controller.abort(new Error('客户端已断开群聊创作流'))
        }
      }
      reply.raw.once('close', abortOnDisconnect)

      try {
        chapterCreationLocks.add(creationLockKey)
        // 运行时读取最新设置，让 moderatorModel / 其他参数的修改即时生效
        const settings = services.discussionSettingsStore.get()
        const result = await discussionRunner.run(
          projectId,
          parseInt(chapterNumber, 10),
          {
            emit: emitter.emit,
            onCheckpoint: async (checkpoint) => {
              // 通过 ConfirmationManager 发起决策请求（与 create-flow 的 onCheckpoint 一致）
              // timeoutMs=0 表示无超时：用户可能需要长时间阅读检查点内容并思考
              const toolCallId = randomUUID()
              const checkpointWithOptions = {
                ...checkpoint,
                options: checkpoint.options ?? ['approve', 'revise', 'reject'],
              }
              const decisionPromise = services.confirmationManager.requestDecision({
                threadId: `novel-discussion-${projectId}-${chapterNumber}`,
                toolCallId,
                toolName: `discussion_${checkpoint.type}`,
                args: { checkpoint: checkpointWithOptions } as Record<string, unknown>,
                reason: `等待用户确认群聊检查点：${checkpoint.question}`,
              }, 0)
              // requestDecision 内部已同步把 pending 加入 Map，listPending 立即可见
              const pending = services.confirmationManager.listPending().find((r) => r.toolCallId === toolCallId)
              emitter.checkpoint({ ...checkpointWithOptions, checkpointId: pending?.id })
              return decisionPromise as Promise<'approve' | 'reject' | 'revise' | string>
            },
            onProgress: (event) => emitter.progress(event),
            moderatorModel: settings.moderatorModel,
            signal: task.controller.signal,
          },
          arrangedEntities,
        )
        services.discussionRunStore.save({
          id: discussionRunId,
          projectId,
          chapterNumber: parseInt(chapterNumber, 10),
          status: result.status,
          failedPhase: result.failedPhase,
          transcript: result.transcript,
          scenes: result.scenes,
          arrangedEntities,
          content: result.content,
          error: result.error,
        })
        try {
          persistDiscussionHistory(
            services.chapterChatStore,
            projectId,
            parseInt(chapterNumber, 10),
            result,
            discussionRunId,
          )
        } catch (historyError) {
          request.log.error(
            { err: historyError, projectId, chapterNumber, discussionRunId },
            '群聊历史持久化失败',
          )
        }
        emitter.result({
          ...result,
          discussionRunId,
          canResume: result.status === 'error' && result.failedPhase === 'chapter_weaving',
        })
      } catch (err) {
        emitter.error(String(err))
      } finally {
        clearInterval(heartbeat)
        reply.raw.off('close', abortOnDisconnect)
        finishNovelChapterTask(creationLockKey, task)
        chapterCreationLocks.delete(creationLockKey)
        reply.raw.end()
      }
    },
  })

  // 群聊断点续跑：仅支持 Writer 全章编织阶段，复用已持久化的场景和 transcript。
  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters/:chapterNumber/create-discussion/:runId/resume',
    handler: async (request: any, reply: any) => {
      const { projectId, chapterNumber, runId } = request.params as {
        projectId: string
        chapterNumber: string
        runId: string
      }
      const chapter = parseInt(chapterNumber, 10)
      const snapshot = services.discussionRunStore.get(runId)
      if (!snapshot || snapshot.projectId !== projectId || snapshot.chapterNumber !== chapter) {
        reply.code(404).send({ ok: false, error: '未找到该章节的群聊中断记录' })
        return
      }
      if (snapshot.status !== 'error' || snapshot.failedPhase !== 'chapter_weaving') {
        reply.code(409).send({ ok: false, error: '该群聊记录不支持从写作阶段继续' })
        return
      }

      const creationLockKey = `${projectId}:${chapterNumber}`
      if (chapterCreationLocks.has(creationLockKey) || aiArrangeLocks.has(creationLockKey) || activeNovelChapterTasks.has(creationLockKey)) {
        reply.code(409).send({ ok: false, error: '该章节正在创作中，请勿重复启动断点续跑' })
        return
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': request.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true',
      })
      request.raw.socket?.setNoDelay?.(true)
      const heartbeat = setInterval(() => reply.raw.write(': keepalive\n\n'), 15000)
      const resumeRunId = randomUUID()
      const emitter = createNovelAgUiEmitter(
        createSseEmitterSink((data) => reply.raw.write(data)),
        `novel:discussion-resume:${projectId}:${chapterNumber}`,
        resumeRunId,
      )
      const task = registerNovelChapterTask(creationLockKey, 'discussion-resume')
      const abortOnDisconnect = () => {
        if (!reply.raw.writableEnded && !task.controller.signal.aborted) {
          task.controller.abort(new Error('客户端已断开群聊断点续跑'))
        }
      }
      reply.raw.once('close', abortOnDisconnect)

      try {
        chapterCreationLocks.add(creationLockKey)
        const settings = services.discussionSettingsStore.get()
        const result = await services.discussionRunner.run(
          projectId,
          chapter,
          {
            emit: emitter.emit,
            onCheckpoint: async (checkpoint) => {
              const toolCallId = randomUUID()
              const checkpointWithOptions = {
                ...checkpoint,
                options: checkpoint.options ?? ['approve', 'revise', 'reject'],
              }
              const decisionPromise = services.confirmationManager.requestDecision({
                threadId: `novel-discussion-${projectId}-${chapterNumber}`,
                toolCallId,
                toolName: `discussion_${checkpoint.type}`,
                args: { checkpoint: checkpointWithOptions } as Record<string, unknown>,
                reason: `等待用户确认群聊断点续跑检查点：${checkpoint.question}`,
              }, 0)
              const pending = services.confirmationManager.listPending().find(request => request.toolCallId === toolCallId)
              emitter.checkpoint({ ...checkpointWithOptions, checkpointId: pending?.id })
              return decisionPromise as Promise<'approve' | 'reject' | 'revise' | string>
            },
            onProgress: event => emitter.progress(event),
            moderatorModel: settings.moderatorModel,
            signal: task.controller.signal,
          },
          snapshot.arrangedEntities,
          {
            phase: 'chapter_weaving',
            transcript: snapshot.transcript,
            scenes: snapshot.scenes,
          },
        )

        services.discussionRunStore.save({
          id: resumeRunId,
          projectId,
          chapterNumber: chapter,
          status: result.status,
          failedPhase: result.failedPhase,
          transcript: result.transcript,
          scenes: result.scenes,
          arrangedEntities: snapshot.arrangedEntities,
          content: result.content,
          error: result.error,
          resumedFromRunId: runId,
        })

        const previousMessageIds = new Set(snapshot.transcript.map(message => message.id))
        const historyDelta: DiscussionResult = {
          ...result,
          transcript: result.transcript.filter(message => !previousMessageIds.has(message.id)),
        }
        try {
          persistDiscussionHistory(
            services.chapterChatStore,
            projectId,
            chapter,
            historyDelta,
            resumeRunId,
          )
        } catch (historyError) {
          request.log.error(
            { err: historyError, projectId, chapterNumber, resumeRunId },
            '群聊断点续跑历史持久化失败',
          )
        }

        emitter.result({
          ...result,
          discussionRunId: resumeRunId,
          resumedFromRunId: runId,
          canResume: result.status === 'error' && result.failedPhase === 'chapter_weaving',
        })
      } catch (err) {
        emitter.error(String(err))
      } finally {
        clearInterval(heartbeat)
        reply.raw.off('close', abortOnDisconnect)
        finishNovelChapterTask(creationLockKey, task)
        chapterCreationLocks.delete(creationLockKey)
        reply.raw.end()
      }
    },
  })

  // 群聊检查点决策端点
  // 与 create-flow 的 checkpoint decision 端点对应，threadId 前缀为 novel-discussion-。
  // 不调用 orchestrator.setUserMessages（群聊流程的用户消息机制独立于 orchestrator）。
  routes.push({
    method: 'POST',
    path: '/projects/:projectId/discussion-checkpoint/:checkpointId/decision',
    handler: async (request: any, reply: any) => {
      const { projectId, checkpointId } = request.params as { projectId: string; checkpointId: string }
      const { decision } = request.body as { decision: string }
      const pending = services.confirmationManager.listPending().find((r) => r.id === checkpointId)
      if (!pending || !pending.threadId.startsWith(`novel-discussion-${projectId}-`)) {
        reply.code(404).send({ ok: false, error: '群聊检查点不存在或已处理' })
        return
      }
      const allowedDecisions = (pending.args as { checkpoint?: { options?: string[] } }).checkpoint?.options
      if (!allowedDecisions?.includes(decision)) {
        reply.code(400).send({ ok: false, error: '该群聊检查点不支持此决策，可能已过期' })
        return
      }
      // 委托 ConfirmationManager 响应决策（resolve 对应 pending Promise）
      const accepted = services.confirmationManager.respondDecision(checkpointId, decision)
      if (!accepted) {
        reply.code(404).send({ ok: false, error: '群聊检查点不存在或已处理' })
        return
      }
      return { ok: true, data: { accepted: true } }
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 群聊模式设置
  // ═══════════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/discussion-settings',
    handler: async (request: any) => {
      return success(services.discussionSettingsStore.get(), request.traceId)
    },
  })

  const updateDiscussionSettingsSchema = z.object({
    moderatorModel: z.object({
      provider: z.string().min(1),
      modelId: z.string().min(1),
    }).optional(),
    maxRounds: z.number().int().min(1).optional(),
    maxRoundsPerScene: z.number().int().min(1).optional(),
    characterTemperature: z.number().min(0).max(2).optional(),
  })

  routes.push({
    method: 'PUT',
    path: '/discussion-settings',
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateDiscussionSettingsSchema, request, reply)
      if (!input) return reply
      services.discussionSettingsStore.update(input)
      return success(services.discussionSettingsStore.get(), request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 模式2：AI 编排（SSE）——按章纲生成实体并编排到矩阵，不生成正文
  // ═══════════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters/:chapterNumber/ai-arrange',
    handler: async (request: any, reply: any) => {
      const { projectId, chapterNumber } = request.params
      const entityGenerator = services.entityGenerator

      // 并发锁：同一章节不允许并发 ai-arrange，避免重复生成实体
      const lockKey = `${projectId}:${chapterNumber}`
      if (aiArrangeLocks.has(lockKey) || chapterCreationLocks.has(lockKey) || activeNovelChapterTasks.has(lockKey)) {
        reply.code(409).send({ error: '该章节正在编排中，请稍后' })
        return
      }

      // 客户端断开感知：必须监听 reply.raw（response）的 close 事件，
      // 而非 request.raw（IncomingMessage）的 close。
      // 原因：request.raw 的 close 事件在 POST 请求体读取完成后立即触发（非客户端断开），
      // 会导致 clientDisconnected 被误判为 true，之后所有 SSE 事件被 writeRaw 静默丢弃。
      // reply.raw 的 close 事件在 response 流关闭时触发，
      // 配合 writableEnded 检查可区分"正常结束"与"客户端中途断开"。
      let clientDisconnected = false
      const task = registerNovelChapterTask(lockKey, 'ai-arrange')
      const abortOnDisconnect = () => {
        if (!reply.raw.writableEnded) {
          clientDisconnected = true
          if (!task.controller.signal.aborted) task.controller.abort(new Error('客户端已断开 AI 编排流'))
        }
      }
      reply.raw.on('close', abortOnDisconnect)

      // SSE 设置（与 create-flow 一致，绕过 Fastify CORS 中间件需手动附加 CORS 头）
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': request.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true',
      })
      // 禁用 Nagle 算法，确保 SSE 事件立即 flush 到客户端
      request.raw.socket?.setNoDelay?.(true)
      const writeRaw = (data: string) => {
        if (clientDisconnected || reply.raw.writableEnded) return
        reply.raw.write(data)
      }
      const emitter = createNovelAgUiEmitter(
        createSseEmitterSink(writeRaw),
        `novel:arrange:${projectId}:${chapterNumber}`,
        randomUUID(),
      )
      const heartbeat = setInterval(() => {
        if (clientDisconnected || reply.raw.writableEnded) return
        reply.raw.write(': keepalive\n\n')
      }, 15000)

      // 锁置入 try 块开头：确保 finally 必定执行 delete，避免 SSE 设置抛错导致锁残留
      try {
        aiArrangeLocks.set(lockKey, Promise.resolve())
        const chNum = parseInt(chapterNumber, 10)
        const chapter = store.getChapter(projectId, chNum)
        if (!chapter) throw new Error(`章节不存在: ${chNum}`)
        if (!chapter.outline?.trim()) throw new Error('章纲为空，无法 AI 编排')

        // 阶段1：AI 编排（生成实体并落库到本章列）
        // 注意：本接口仅做矩阵编排，不衔接 create-flow 创作流程。
        // arrange 进度事件统一带 phase='arranging'，前端据此在对话时间线展示处理步骤。
        emitter.progress({ type: 'arrange_start', phase: 'arranging', message: '开始 AI 编排实体...' })
        const arrangedEntities = await entityGenerator.generateAndArrange(
          projectId,
          chNum,
          chapter.outline,
          // 注意：...evt 必须放在 phase 之前，否则 evt.phase 会覆盖 'arranging'，
          // 导致前端无法识别为编排阶段（前端以 phase='arranging' 作为对话气泡判定条件）。
          (evt) => emitter.progress({ type: 'arrange_progress', ...evt, phase: 'arranging' }),
          'outline',
          task.controller.signal,
        )
        const totalCount = arrangedEntities.characterIds.length
          + arrangedEntities.conflictIds.length
          + arrangedEntities.foreshadowIds.length
          + (arrangedEntities.clueIds ?? []).length
          + arrangedEntities.factionIds.length
          + arrangedEntities.locationIds.length
          + (arrangedEntities.itemIds ?? []).length
        emitter.progress({
          type: 'arrange_done',
          phase: 'arranging',
          message: `编排完成：共生成 ${totalCount} 个实体已落入矩阵`,
          data: arrangedEntities,
          // 携带 detail 用于前端展示编排结果汇总气泡（与 arranged 阶段事件互补）
          detail: {
            kind: 'arrange_summary',
            total: totalCount,
            characters: arrangedEntities.characterIds.length,
            conflicts: arrangedEntities.conflictIds.length,
            foreshadows: arrangedEntities.foreshadowIds.length,
            clues: (arrangedEntities.clueIds ?? []).length,
            factions: arrangedEntities.factionIds.length,
            locations: arrangedEntities.locationIds.length,
            items: (arrangedEntities.itemIds ?? []).length,
          },
        })
        // 编排结束：发 result（status=completed，不带 content），前端据此显示"编排完成"并关闭面板
        emitter.result({
          status: 'completed',
          stateChanges: [{
            type: 'arrange',
            description: `AI 编排完成，已生成 ${totalCount} 个实体落入第 ${chNum} 章矩阵`,
          }],
        })
      } catch (err) {
        emitter.error(String(err))
      } finally {
        clearInterval(heartbeat)
        reply.raw.off('close', abortOnDisconnect)
        finishNovelChapterTask(lockKey, task)
        if (!reply.raw.writableEnded) reply.raw.end()
        aiArrangeLocks.delete(lockKey)
      }
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 模式3：从已写好的正文反推实体到矩阵（SSE）
  // 用户手写了章节正文，调用此接口从正文提取实体（角色/冲突/伏笔/势力/地点）并落库到矩阵
  // ═══════════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters/:chapterNumber/reverse-arrange',
    handler: async (request: any, reply: any) => {
      const { projectId, chapterNumber } = request.params
      const entityGenerator = services.entityGenerator

      // 并发锁：与 ai-arrange 共用锁池，同一章节不允许并发编排
      const lockKey = `${projectId}:${chapterNumber}`
      if (aiArrangeLocks.has(lockKey) || chapterCreationLocks.has(lockKey) || activeNovelChapterTasks.has(lockKey)) {
        reply.code(409).send({ error: '该章节正在编排中，请稍后' })
        return
      }

      let clientDisconnected = false
      const task = registerNovelChapterTask(lockKey, 'reverse-arrange')
      const abortOnDisconnect = () => {
        if (!reply.raw.writableEnded) {
          clientDisconnected = true
          if (!task.controller.signal.aborted) task.controller.abort(new Error('客户端已断开反推编排流'))
        }
      }
      reply.raw.on('close', abortOnDisconnect)

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': request.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true',
      })
      request.raw.socket?.setNoDelay?.(true)
      const writeRaw = (data: string) => {
        if (clientDisconnected || reply.raw.writableEnded) return
        reply.raw.write(data)
      }
      const emitter = createNovelAgUiEmitter(
        createSseEmitterSink(writeRaw),
        `novel:reverse-arrange:${projectId}:${chapterNumber}`,
        randomUUID(),
      )
      const heartbeat = setInterval(() => {
        if (clientDisconnected || reply.raw.writableEnded) return
        reply.raw.write(': keepalive\n\n')
      }, 15000)

      try {
        aiArrangeLocks.set(lockKey, Promise.resolve())
        const chNum = parseInt(chapterNumber, 10)
        const chapter = store.getChapter(projectId, chNum)
        if (!chapter) throw new Error(`章节不存在: ${chNum}`)
        if (!chapter.content?.trim()) throw new Error('章节正文为空，无法反推实体')

        emitter.progress({ type: 'arrange_start', phase: 'arranging', message: '开始从正文反推实体...' })
        const arrangedEntities = await entityGenerator.generateAndArrange(
          projectId,
          chNum,
          chapter.content,
          (evt) => emitter.progress({ type: 'arrange_progress', ...evt, phase: 'arranging' }),
          'content', // source='content' 表示从正文反推
          task.controller.signal,
        )
        const totalCount = arrangedEntities.characterIds.length
          + arrangedEntities.conflictIds.length
          + arrangedEntities.foreshadowIds.length
          + (arrangedEntities.clueIds ?? []).length
          + arrangedEntities.factionIds.length
          + arrangedEntities.locationIds.length
        emitter.progress({
          type: 'arrange_done',
          phase: 'arranging',
          message: `反推完成：共提取 ${totalCount} 个实体已落入矩阵`,
          data: arrangedEntities,
          detail: {
            kind: 'arrange_summary',
            total: totalCount,
            characters: arrangedEntities.characterIds.length,
            conflicts: arrangedEntities.conflictIds.length,
            foreshadows: arrangedEntities.foreshadowIds.length,
            clues: (arrangedEntities.clueIds ?? []).length,
            factions: arrangedEntities.factionIds.length,
            locations: arrangedEntities.locationIds.length,
          },
        })
        emitter.result({
          status: 'completed',
          stateChanges: [{
            type: 'reverse-arrange',
            description: `从正文反推完成，已提取 ${totalCount} 个实体落入第 ${chNum} 章矩阵`,
          }],
        })
      } catch (err) {
        emitter.error(String(err))
      } finally {
        clearInterval(heartbeat)
        reply.raw.off('close', abortOnDisconnect)
        finishNovelChapterTask(lockKey, task)
        if (!reply.raw.writableEnded) reply.raw.end()
        aiArrangeLocks.delete(lockKey)
      }
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // TeamManager 统一触发（pipeline 策略：Director → Writer → Reviewer → Reviser → Memory）
  // ═══════════════════════════════════════════════════════════════

  const createTeamSchema = z.object({
    narrativeTask: z.string().min(1).describe('本章叙事任务描述'),
    rhythm: z.string().optional().describe('节奏建议（可选）'),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters/:chapterNumber/create-team',
    handler: async (request: any, reply: any) => {
      const { projectId, chapterNumber } = request.params as { projectId: string; chapterNumber: string }
      const input = validateBody(createTeamSchema, request, reply)
      if (!input) return reply

      const teamManager = services.teamManager
      if (!teamManager) {
        throw new AppError(
          ErrorCode.CONFIG_ERROR,
          'TeamManager 不可用（teamPlugin 未注册或 plugin-loader 未注入），无法触发团队创作',
          503,
        )
      }

      const team = teamManager.getTeam('novel-team')
      if (!team) {
        throw new AppError(
          ErrorCode.CONFIG_ERROR,
          'Novel Team 未注册，请检查 novel-plugin 初始化日志',
          503,
        )
      }

      const project = store.getProject(projectId)
      if (!project) {
        throw new AppError(ErrorCode.NOT_FOUND, `项目不存在: ${projectId}`, 404)
      }

      const chapterNum = parseInt(chapterNumber, 10)
      if (Number.isNaN(chapterNum) || chapterNum < 1) {
        throw new AppError(ErrorCode.BAD_REQUEST, `无效的 chapterNumber: ${chapterNumber}`, 400)
      }

      // 构建团队任务描述（pipeline 下作为首个 Agent 的输入，后续 Agent 接收前一阶段输出）
      const task = [
        `为项目《${project.title}》创作第 ${chapterNum} 章。`,
        `叙事任务：${input.narrativeTask}`,
        input.rhythm ? `节奏建议：${input.rhythm}` : '',
      ].filter(Boolean).join('\n')

      const result = await teamManager.execute('novel-team', task, {
        strategy: 'pipeline',
      })

      return success(result, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // Agent 调用日志（记录每次 Agent 调用的完整上下文：系统提示词/章节上下文/任务指令/工具/结果）
  // ═══════════════════════════════════════════════════════════════

  // 列出日志（精简字段，支持按章节/Agent 类型过滤）
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/agent-logs',
    handler: async (request: any) => {
      const { projectId } = request.params as { projectId: string }
      const query = request.query as {
        chapterNumber?: string
        agentType?: string
        limit?: string
      }
      const limit = query.limit ? parseInt(query.limit, 10) : 100
      const filter: { chapterNumber?: number; agentType?: string } = {}
      if (query.chapterNumber != null) {
        const n = parseInt(query.chapterNumber, 10)
        if (!Number.isNaN(n)) filter.chapterNumber = n
      }
      if (query.agentType) filter.agentType = query.agentType

      const logs = store.listAgentLogs(projectId, Object.keys(filter).length > 0 ? filter : undefined, limit)
      return success(logs, request.traceId)
    },
  })

  // 获取单条日志详情（含完整 systemPrompt / userMessage / result 全文）
  routes.push({
    method: 'GET',
    path: '/agent-logs/:id',
    handler: async (request: any) => {
      const log = store.getAgentLog(request.params.id)
      if (!log) throw new AppError(ErrorCode.NOT_FOUND, `日志不存在: ${request.params.id}`, 404)
      return success(log, request.traceId)
    },
  })

  // 删除项目下所有日志
  routes.push({
    method: 'DELETE',
    path: '/projects/:projectId/agent-logs',
    handler: async (request: any) => {
      const deleted = store.deleteAgentLogsByProject(request.params.projectId)
      return success({ projectId: request.params.projectId, deleted }, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 时间轴标记
  // ═══════════════════════════════════════════════════════════════

  const createMarkerSchema = z.object({
    chapter: z.number().int().min(1),
    title: z.string().default(''),
    note: z.string().default(''),
    type: z.enum(['bookmark', 'turning-point', 'foreshadow', 'climax', 'note', 'clip-note', 'in', 'out']).default('bookmark'),
    color: z.enum(['blue', 'yellow', 'green', 'red', 'purple']).default('blue'),
    entityType: z.string().nullable().default(null),
    entityId: z.string().nullable().default(null),
  })

  const updateMarkerSchema = z.object({
    chapter: z.number().int().min(1).optional(),
    title: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    type: z.enum(['bookmark', 'turning-point', 'foreshadow', 'climax', 'note', 'clip-note', 'in', 'out']).optional(),
    color: z.enum(['blue', 'yellow', 'green', 'red', 'purple']).optional(),
    entityType: z.string().nullable().optional(),
    entityId: z.string().nullable().optional(),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/markers',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createMarkerSchema, request, reply)
      if (!input) return reply

      const marker = store.createMarker({
        id: randomUUID(),
        projectId: request.params.projectId,
        ...input,
      })
      return success(marker, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/markers',
    handler: async (request: any) => {
      return success(store.listMarkers(request.params.projectId), request.traceId)
    },
  })

  routes.push({
    method: 'PATCH',
    path: '/markers/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateMarkerSchema, request, reply)
      if (!input) return reply

      const updated = store.updateMarker(request.params.id, input as Partial<NovelMarker>)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `标记不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/markers/:id',
    handler: async (request: any) => {
      const deleted = store.deleteMarker(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `标记不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 小说 Agent 角色温度配置（全局，不按 project 区分）
  // ═══════════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/agent-config',
    handler: async (request: any) => {
      const temperatures = getAllNovelAgentTemperatures(services.agentManager)
      const result = (Object.entries(temperatures) as Array<[NovelAgentType, number]>).map(([agentType, temperature]) => ({
        agentType,
        temperature,
      }))
      return success(result, request.traceId)
    },
  })

  const updateAgentConfigSchema = z.object({
    items: z.array(z.object({
      agentType: z.enum(['director', 'writer', 'reviser', 'reviewer', 'memory']),
      temperature: z.number().min(0).max(2),
    })),
  })

  routes.push({
    method: 'PUT',
    path: '/agent-config',
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateAgentConfigSchema, request, reply)
      if (!input) return reply
      updateNovelAgentTemperatures(input.items, services.agentManager)
      // updateNovelAgentTemperatures 内部已通过 agentManager.updateAgent 同步温度，
      // subagent / team_execute 路径立即可见，无需手动同步
      const temperatures = getAllNovelAgentTemperatures(services.agentManager)
      const result = (Object.entries(temperatures) as Array<[NovelAgentType, number]>).map(([agentType, temperature]) => ({
        agentType,
        temperature,
      }))
      return success(result, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 章节聊天（按章节持久化用户输入 + 自由聊天）
  // ═══════════════════════════════════════════════════════════════

  // GET /projects/:projectId/chapters/:chapterNumber/chat — 获取章节聊天历史
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/chapters/:chapterNumber/chat',
    handler: async (request: any) => {
      const { projectId, chapterNumber } = request.params
      const messages = services.chapterChatStore.list(projectId, parseInt(chapterNumber, 10))
      return success(messages, request.traceId)
    },
  })

  // DELETE /projects/:projectId/chapters/:chapterNumber/chat — 清空章节聊天历史
  routes.push({
    method: 'DELETE',
    path: '/projects/:projectId/chapters/:chapterNumber/chat',
    handler: async (request: any) => {
      const { projectId, chapterNumber } = request.params
      services.chapterChatStore.clear(projectId, parseInt(chapterNumber, 10))
      return success({ cleared: true }, request.traceId)
    },
  })

  // POST /projects/:projectId/chapters/:chapterNumber/chat — 自由聊天（SSE 流式）
  //
  // Body: { message: string, mentionedAgents?: string[] }
  // - mentionedAgents 非空时，依次让被 @ 的 Agent 回复
  // - 否则由 Moderator 单轮决策选一个 Agent 回复
  const chatBodySchema = z.object({
    message: z.string().min(1).max(8000),
    mentionedAgents: z.array(z.string()).max(10).optional(),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters/:chapterNumber/chat',
    handler: async (request: any, reply: any) => {
      const { projectId, chapterNumber } = request.params
      const input = validateBody(chatBodySchema, request, reply)
      if (!input) return reply

      const chapterNum = parseInt(chapterNumber, 10)
      const settings = services.discussionSettingsStore.get()

      // SSE 设置（与 create-flow / create-discussion 一致）
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': request.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true',
      })
      request.raw.socket?.setNoDelay?.(true)

      const heartbeat = setInterval(() => {
        reply.raw.write(': keepalive\n\n')
      }, 15000)

      const threadId = `novel:chat:${projectId}:${chapterNum}`
      const emitter = createNovelAgUiEmitter(
        createSseEmitterSink((data) => reply.raw.write(data)),
        threadId,
        randomUUID(),
      )

      try {
        const result = await services.chapterChatRunner.run(
          projectId,
          chapterNum,
          { message: input.message, mentionedAgents: input.mentionedAgents },
          {
            emit: emitter.emit,
            moderatorModel: settings.moderatorModel,
          },
        )
        emitter.result({ status: 'completed', replies: result.replies })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        emitter.error(message)
      } finally {
        clearInterval(heartbeat)
        reply.raw.end()
      }
    },
  })

  // POST /projects/:projectId/chapters/:chapterNumber/chat/persist — 持久化创作流程中的用户输入
  //
  // 供前端在创作流程各阶段（启动前/检查点/群聊）调用，把用户输入落库。
  // Body: {
  //   phase: 'pre_creation' | 'checkpoint' | 'discussion' | 'review',
  //   role: 'user' | 'system',
  //   content: string,
  //   fromId?: string, fromName?: string,
  //   metadata?: object
  // }
  const persistChatSchema = z.object({
    phase: z.enum(['pre_creation', 'checkpoint', 'discussion', 'review']),
    role: z.enum(['user', 'system']).default('user'),
    content: z.string().min(1).max(20000),
    fromId: z.string().optional().default('user'),
    fromName: z.string().optional().default('用户'),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters/:chapterNumber/chat/persist',
    handler: async (request: any, reply: any) => {
      const { projectId, chapterNumber } = request.params
      const input = validateBody(persistChatSchema, request, reply)
      if (!input) return reply
      const message = services.chapterChatStore.add({
        projectId,
        chapterNumber: parseInt(chapterNumber, 10),
        role: input.role,
        fromId: input.fromId,
        fromName: input.fromName,
        content: input.content,
        phase: input.phase,
        metadata: input.metadata as Record<string, unknown> | undefined,
      })
      return success(message, request.traceId)
    },
  })

  return routes
}

/**
 * 决策记录的中文措辞。
 *
 * **必须按检查点类型分别映射。** 同一个 action 在不同检查点是不同的事：
 * 在 `narrative_task` 上 `approve` 是"确认叙事任务"，在 `review` 上 `approve` 是
 * "接受这一版正文、跳过修订"。用一张全局 action→文案表会把前者记成后者，
 * 事后翻记录直接误判用户当时的意图。
 *
 * 措辞与前端按钮保持一致（见 novel-conversation-panel 的各 *_OPTIONS）：
 * 按钮说的是后果，记录也必须说后果。
 */
function describeDecision(checkpointType: CheckpointType | undefined, decision: string): string {
  const byType: Partial<Record<CheckpointType, Record<string, string>>> = {
    narrative_task: {
      approve: '确认叙事任务',
      revise: '按意见重新规划',
      rewrite: '按意见重新规划',
      reject: '取消创作',
    },
    review: {
      approve: '接受这一版（跳过修订）',
      revise: '交给 Reviser 修订',
      rewrite: '退回 Writer 重写',
      reject: '取消',
    },
    post_write_guard: {
      approve: '接受草稿（忽略守护警告）',
      revise: '转 Reviser 局部修正',
      rewrite: '退回 Writer 按守护意见重写',
      reject: '取消',
    },
    writer_pushback: {
      approve: '同意 Writer 推回，重跑 Director',
      revise: '忽略推回，按原任务继续',
      rewrite: '忽略推回，按原任务继续',
      reject: '取消',
    },
    guard_degraded: {
      approve: '接受当前草稿',
      revise: '转 Reviser 尝试局部修正',
      rewrite: '从头重写（计入本章上限）',
      reject: '取消',
    },
    chapter_budget: {
      approve: '知晓成本，继续创作',
      reject: '停止创作',
    },
  }
  const fallback: Record<string, string> = {
    approve: '同意',
    revise: '修订',
    rewrite: '重写',
    reject: '取消',
  }
  const table = (checkpointType && byType[checkpointType]) || fallback
  return table[decision] ?? fallback[decision] ?? decision
}
