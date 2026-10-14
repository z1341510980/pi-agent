/**
 * 创作流程相关路由
 *
 * 拆分自原 novel-routes.ts（PR-6），包含所有 SSE 流式创作流程：
 * - cancel-active-flow（统一取消：工作流/群聊/编排/反推共用同一任务控制器）
 * - create-flow（多 Agent 创作流程 SSE + 检查点）
 * - flows/:flowId/messages（create-flow 运行中插话：REST 受理 + SSE 状态回显 + 落库）
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
import { getAllNovelAgentTemperatures, updateNovelAgentTemperatures, getAllNovelAgentModels, updateNovelAgentModel, type NovelAgentType } from '../core/domain/novel-agents.js'
import { persistDiscussionHistory } from '../core/discussion/discussion-history.js'
import { deriveResumeInfo } from '../core/discussion/discussion-event-store.js'
import type { DiscussionResult } from '../core/discussion/engine/discussion-types.js'
import {
  aiArrangeLocks,
  chapterCreationLocks,
  activeNovelChapterTasks,
  registerNovelChapterTask,
  finishNovelChapterTask,
  registerInterjectFlow,
  unregisterInterjectFlow,
  announceInterjectQueued,
  getInterjectEnqueuer,
  dispatchInterjectStatus,
} from '../utils/chapter-task-registry.js'
import { createNovelAgUiEmitter, createSseEmitterSink } from '../utils/sse-emitter.js'
import { cancelDebug } from '../../../lib/cancel-debug-log.js'
import {
  creationFlowBodySchema,
  arrangedEntitiesSchema,
  parseArrangedEntities,
  findForeignArrangedEntities,
} from './arranged-entities-contract.js'
import { buildArrangeReviewDetails } from './arrange-review-contract.js'
import { parseNovelModelRef } from '../core/domain/novel-model-ref.js'
import type { ArrangeDraftHandle } from '../core/generation/novel-entity-generator.js'
import { modelSelectionSchema } from './model-selection-contract.js'
import { persistNovelFailureAudit } from '../core/observability/novel-error-audit.js'
import { registerCheckpointFeedback, appendCheckpointFeedback, clearCheckpointFeedback, clearCheckpointFeedbackForRun } from '../utils/checkpoint-feedback-registry.js'
import { waitForCheckpointDecision, withDiscussionCheckpointOptions } from '../utils/checkpoint-controller.js'
import type { CreationRunStage } from '../core/runtime/creation-run-state.js'

/**
 * 群聊可续跑阶段：这些阶段失败时快照携带足够状态（transcript/scenes/content/
 * failedSceneId）从断点继续。planning 阶段失败无可续跑产物，仍整场重来。
 */
const DISCUSSION_RESUMABLE_PHASES = new Set(['chapter_weaving', 'reviewing', 'acting', 'scene_setup'])
// 检查点请求与后台 discussion run 解耦；用户意见先按 checkpointId 暂存，
// 等待中的 engine 在恢复后把它们写入 transcript，供下一位 Agent 读取。
const CREATION_FLOW_ROUTES_FILE = 'apps/agent-server/src/plugins/novel-plugin/routes/creation-flow-routes.ts'

export function createCreationFlowRoutes(services: NovelServices): RouteDefinition[] {
  const { store } = services
  const routes: RouteDefinition[] = []

  const persistRouteFailureAudit = (params: {
    request: any
    projectId: string
    chapterNumber: number
    operation: string
    sourceSymbol: string
    input: unknown
    errorCode: string
    error: unknown
    durationMs: number
    result?: unknown
    agentType?: string
    agentName?: string
    displayAgentType?: string
    displayAgentName?: string
    phase?: string
  }): void => {
    persistNovelFailureAudit({
      store,
      projectId: params.projectId,
      chapterNumber: params.chapterNumber,
      operation: params.operation,
      source: { file: CREATION_FLOW_ROUTES_FILE, symbol: params.sourceSymbol },
      input: params.input,
      errorCode: params.errorCode,
      error: params.error,
      durationMs: params.durationMs,
      result: params.result,
      requestTraceId: params.request.traceId,
      agentType: params.agentType,
      agentName: params.agentName,
      displayAgentType: params.displayAgentType,
      displayAgentName: params.displayAgentName,
      phase: params.phase,
      onAuditFailure: (auditError) => params.request.log?.error?.(
        { err: auditError, projectId: params.projectId, chapterNumber: params.chapterNumber, operation: params.operation },
        '创作流程错误审计写入失败',
      ),
    })
  }

  const aiArrangeBodySchema = z.object({
    /** 本次编排的临时模型覆盖；未传时按项目主模型/novel-director/系统默认解析。 */
    modelId: modelSelectionSchema.optional(),
  }).optional().default({})
  const reverseArrangeBodySchema = z.object({
    modelId: modelSelectionSchema.optional(),
  }).optional().default({})

  const requireChapter = (projectId: string, chapterNumber: string): number => {
    const parsed = Number(chapterNumber)
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new AppError(ErrorCode.BAD_REQUEST, `无效的 chapterNumber: ${chapterNumber}`, 400)
    }
    if (!store.getProject(projectId)) {
      throw new AppError(ErrorCode.NOT_FOUND, `项目不存在: ${projectId}`, 404)
    }
    if (!store.getChapter(projectId, parsed)) {
      throw new AppError(ErrorCode.NOT_FOUND, `章节不存在或不属于该项目: ${chapterNumber}`, 404)
    }
    return parsed
  }

  const requireWritableChapter = (projectId: string, chapterNumber: string): number => {
    const parsed = requireChapter(projectId, chapterNumber)
    if (store.getChapter(projectId, parsed)?.status === 'published') {
      throw new AppError(ErrorCode.CONFLICT, '已发布章节不能重新创作，请先进入修订流程', 409)
    }
    try {
      store.assertTimelineAllowsGeneration?.(projectId, parsed)
    } catch (error) {
      throw new AppError(
        ErrorCode.CONFLICT,
        error instanceof Error ? error.message : String(error),
        409,
      )
    }
    return parsed
  }

  /** 会写实体/矩阵当前态的入口从失效起始章起即禁止，避免叠加到未来活库。 */
  const requireDerivedStateWritableChapter = (projectId: string, chapterNumber: string): number => {
    const parsed = requireWritableChapter(projectId, chapterNumber)
    try {
      store.assertTimelineAllowsPublish?.(projectId, parsed)
    } catch (error) {
      throw new AppError(
        ErrorCode.CONFLICT,
        error instanceof Error ? error.message : String(error),
        409,
      )
    }
    return parsed
  }

  /** 一个章节同一时间只允许存在一份待确认编排草稿。 */
  const pendingArrangeDrafts = new Map<string, {
    draftId: string
    handle: ArrangeDraftHandle
    modelId?: { provider: string; modelId: string; thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null }
    feedback?: string
  }>()
  /** arrange_review 的意见在 ConfirmationManager 唤醒前暂存，供下一轮规划提示词使用。 */
  const arrangeDecisionFeedback = new Map<string, string>()

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
        const arrangeThreadId = `novel-arrange-${projectId}-${chapterNumber}`
        const pendingList = services.confirmationManager.listPending()
        const matchedPending = pendingList.filter(
          (p) => p.threadId === workflowThreadId || p.threadId === discussionThreadId || p.threadId === arrangeThreadId,
        )
        cancelDebug('cancel-pending', { projectId, chapterNumber, pendingCount: pendingList.length, matchedCount: matchedPending.length })
        for (const pending of matchedPending) {
          if (pending.threadId === arrangeThreadId) {
            pendingArrangeDrafts.get(lockKey)?.handle.rollback()
            pendingArrangeDrafts.delete(lockKey)
          }
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
      const chapterNumberValue = requireWritableChapter(projectId, chapterNumber)
      const arrangedEntities = parseArrangedEntities(input)

      if (arrangedEntities) {
        const invalid = findForeignArrangedEntities(store, projectId, arrangedEntities)
        if (invalid.length > 0) {
          reply
            .code(400)
            .send({ ok: false, error: `编排实体不属于当前项目或不存在: ${invalid.join(', ')}` })
          return
        }
      }

      const creationLockKey = `${projectId}:${chapterNumber}`
      if (
        chapterCreationLocks.has(creationLockKey) ||
        aiArrangeLocks.has(creationLockKey) ||
        activeNovelChapterTasks.has(creationLockKey)
      ) {
        reply.code(409).send({ ok: false, error: '该章节正在创作中，请勿重复启动编排或群聊流程' })
        return
      }

      // T8（2026-10）：run 脱离 HTTP 生命周期。
      //
      // 旧实现把 orchestrator 跑在本请求里，并把 `reply.raw` 的 close 当作取消信号。
      // 代价是刷新页面 / 切路由 / 渲染进程重载 / 代理掐连接 / 后端重启都会写死整章：
      // `novel_workflow_runs` 的 6 条 error 里有 5 条正是「服务重启导致创作流程中断」。
      // 现在 POST 只受理并返回 202 + runId，执行转入后台任务；进度与结果写入
      // `novel_workflow_events`，前端用 events 端点 tail（断线重连只是重新 tail）。
      // 只有显式 cancel（/cancel-active-flow）才停 —— 与群聊模式（create-discussion）同语义。
      const workflowRunId = randomUUID()
      const creationRunLifecycle = services.creationRunLifecycle
      if (creationRunLifecycle) {
        try {
          creationRunLifecycle.start({
            runId: workflowRunId,
            projectId,
            chapterNumber: chapterNumberValue,
            mode: 'workflow',
          })
        } catch (error) {
          request.log.warn({ error, projectId, chapterNumber: chapterNumberValue, workflowRunId }, '统一创作运行内核受理失败')
          reply.code(409).send({ ok: false, error: '该章节已有一个活动创作运行，请先结束或恢复现有运行' })
          return
        }
      }
      const eventsPath = `/projects/${projectId}/workflow-runs/${workflowRunId}/events`
      const emitter = createNovelAgUiEmitter(
        (event) => {
          // 与群聊同构：emit 通道整体镜像进事件流（type='agui'，payload 即原 AG-UI 事件）。
          // 不镜像的话流式体验会退化成"输出完成后一次性出现"。
          services.workflowEventStore.append(
            workflowRunId,
            'agui',
            event as unknown as Record<string, unknown>
          )
        },
        `novel:chapter:${projectId}:${chapterNumber}`,
        workflowRunId
      )
      // 插话回显通道（§3.1/§4）：把本 flow 的 emitter 登记到插话注册表，
      // 供 POST /projects/:projectId/flows/:flowId/messages 端点与 orchestrator
      // 插话 hooks（injected/dropped）推 novel:user-message 事件。
      // 后台 run 没有连接可写，状态一律进事件流。
      const interjectFlowKey = `${projectId}|${chapterNumberValue}|${workflowRunId}`
      registerInterjectFlow(interjectFlowKey, (event) => {
        emitter.userMessage(event)
      })
      // run_started 同步入流：保证 202 返回时 events 端点已能定位该 run，
      // 也让"面板重开 → active-workflow-run → 重连 tail"有据可依。
      services.workflowEventStore.append(workflowRunId, 'run_started', {
        projectId,
        chapterNumber: chapterNumberValue,
        workflowRunId
      })
      // 陈旧插话清理：上一 flow 的终态收尾（orchestrator finally）先于任务表删除
      // （route finally）执行，窗口内入队的定向插话会残留在单例 orchestrator 队列，
      // 被本次重启的同章 flow 误注入——启动前按 flowKey 清掉（经 dropped 回调暴露）。
      if (typeof orchestrator.clearStaleInterjectMessages === 'function') {
        orchestrator.clearStaleInterjectMessages(interjectFlowKey)
      }
      // ── 断点续跑快照：阶段边界即时落库 + 运行终态收尾 ──
      // 边界即时落库保证进程崩溃也能保住最后一次边界（快照 row status='running'）。
      // 失败终态把最后边界固化为 status='error' + phase，前端据此展示「从中断处继续」。
      let lastBoundary: import('../core/workflow-run-store.js').WorkflowResumeState | undefined
      const saveRunSnapshot = (
        status: 'running' | 'completed' | 'cancelled' | 'error',
        extra?: { failedPhase?: string; error?: string; resumedFromRunId?: string }
      ): void => {
        const boundary = lastBoundary
        try {
          services.workflowRunStore.save({
            id: workflowRunId,
            projectId,
            chapterNumber: chapterNumberValue,
            status,
            // 未到达任何边界（Director 阶段即失败）时不落 phase：无可续跑产物
            phase: boundary?.entry,
            failedPhase: extra?.failedPhase as
              | import('@repo/shared/novel').CreationPhase
              | undefined,
            directorTask: boundary?.directorTask,
            directorOutput: boundary?.directorOutput,
            rhythmSuggestion: boundary?.rhythmSuggestion,
            arrangedEntities: boundary?.arrangedEntities,
            writerDraft: boundary?.writerDraft,
            writerScenes: boundary?.writerScenes,
            finalContent: boundary?.finalContent,
            modelId: input.modelId,
            styleExpertIds: input.styleExpertIds,
            error: extra?.error,
            resumedFromRunId: extra?.resumedFromRunId
          })
        } catch (snapshotError) {
          request.log.warn(
            { err: snapshotError, projectId, chapterNumber, workflowRunId },
            '工作流运行快照落库失败（不影响创作流程）'
          )
        }
      }
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
            workflowRunId
          }
        })
      }
      const task = registerNovelChapterTask(creationLockKey, 'workflow', workflowRunId)
      const startedAt = Date.now()

      const executeRun = async (): Promise<void> => {
        try {
            chapterCreationLocks.add(creationLockKey)
            persistWorkflowMessage({
              role: 'system',
              fromId: 'system',
              fromName: '系统',
              content: `开始第 ${chapterNumberValue} 章工作流创作${input.styleExpertIds?.length ? `（召集 ${input.styleExpertIds.length} 个文风专家）` : ''}`,
              phase: 'pre_creation',
              metadata: { workflowMessageType: 'run_start', styleExpertIds: input.styleExpertIds }
            })
            const result = await orchestrator.createChapterWithFlow(projectId, chapterNumberValue, {
              emit: emitter.emit,
              // per-call 模型覆盖（输入框旁选择器传入）
              modelId: input.modelId,
              flowKey: interjectFlowKey,
              styleExpertIds: input.styleExpertIds,
              // 断点续跑：阶段边界快照（Director 批准 / Writer 成稿 / 正文定稿）
              onRunStateUpdate: (state) => {
                lastBoundary = state
                saveRunSnapshot('running')
              },
              onCheckpoint: async (checkpoint) => {
                // 通过 ConfirmationManager 发起决策请求
                // timeoutMs=0 表示无超时：用户可能需要长时间阅读/checkpoint 内容并思考，
                // 不应因超时自动 reject 导致弹框消失、创作被取消
                const toolCallId = randomUUID()
                const checkpointCreatedAt = Date.now()
                const decisionPromise = services.confirmationManager.requestDecision(
                  {
                    threadId: `novel-checkpoint-${projectId}-${chapterNumber}`,
                    toolCallId,
                    toolName: `checkpoint_${checkpoint.type}`,
                    args: { checkpoint, workflowRunId } as Record<string, unknown>,
                    reason: `等待用户确认 ${checkpoint.type} 检查点`
                  },
                  0
                )
                // requestDecision 内部已同步把 pending 加入 Map，listPending 立即可见
                // 通过 toolCallId 反查拿到 ConfirmationRequest.id，推给前端用于决策路由
                const pending = services.confirmationManager
                  .listPending()
                  .find((r) => r.toolCallId === toolCallId)
                const persistedCheckpoint = {
                  ...checkpoint,
                  checkpointId: pending?.id,
                  createdAt: checkpointCreatedAt
                }
                if (creationRunLifecycle) {
                  try {
                    creationRunLifecycle.awaitCheckpoint(workflowRunId, pending?.id ?? toolCallId, checkpointCreatedAt)
                  } catch (error) {
                    request.log.warn({ error, workflowRunId, checkpointType: checkpoint.type }, '统一运行内核记录检查点失败')
                  }
                }
                persistWorkflowMessage({
                  role: 'system',
                  fromId: 'system',
                  fromName: '检查点',
                  content:
                    typeof checkpoint.data === 'string'
                      ? checkpoint.data
                      : (JSON.stringify(checkpoint.data) ?? ''),
                  phase: 'checkpoint',
                  metadata: {
                    workflowMessageType: 'checkpoint',
                    checkpointId: pending?.id,
                    checkpointType: checkpoint.type,
                    checkpointData: checkpoint.data,
                    checkpointOptions: checkpoint.options
                  }
                })
                emitter.checkpoint(persistedCheckpoint)
                return decisionPromise as Promise<'approve' | 'reject' | 'revise' | 'rewrite'>
              },
              onProgress: (event) => {
                emitter.progress(event)
                if (creationRunLifecycle) {
                  try {
                    creationRunLifecycle.observePhase(workflowRunId, event.phase)
                  } catch (error) {
                    request.log.warn({ error, workflowRunId, phase: event.phase }, '统一运行内核阶段投影失败')
                  }
                }
              },
              onConversationMessage: persistWorkflowMessage,
              signal: task.controller.signal,
              arrangedEntities
            })
             if (creationRunLifecycle) {
               try {
                 creationRunLifecycle.finish(workflowRunId, {
                   status: result.status,
                   error: result.error,
                 })
               } catch (error) {
                 request.log.warn({ error, workflowRunId, status: result.status }, '统一运行内核终态投影失败')
               }
             }
            persistWorkflowMessage({
              role: 'system',
              fromId: 'system',
              fromName: '系统',
              content:
                result.status === 'completed'
                  ? '工作流创作完成'
                  : result.status === 'cancelled'
                    ? '工作流创作已取消'
                    : `工作流创作结束：${result.error ?? result.status}`,
              phase: 'review',
              metadata: { workflowMessageType: 'run_end', styleExpertIds: input.styleExpertIds }
            })
            // 快照终态：失败且有边界产物 → 标记可续跑；完成/取消 → 关闭续跑入口
            const resumable = result.status === 'error' && lastBoundary != null
            saveRunSnapshot(result.status, {
              failedPhase: result.failedPhase,
              error: result.error
            })
            if (result.status === 'error') {
              persistRouteFailureAudit({
                request,
                projectId,
                chapterNumber: chapterNumberValue,
                operation: 'create-flow',
                sourceSymbol:
                  'createCreationFlowRoutes > POST /projects/:projectId/chapters/:chapterNumber/create-flow',
                input,
                errorCode: 'create_flow_failed',
                error: new Error(result.error ?? '工作流创作失败'),
                durationMs: Date.now() - startedAt,
                result,
                phase: result.failedPhase ?? 'workflow'
              })
            }
            const runFinishedPayload = resumable
              ? { ...result, workflowRunId, canResume: true }
              : { ...result, workflowRunId }
            // 终态只走 run_finished：前端 tail 收到后合成 novel:result + RUN_FINISHED，
            // 与旧 SSE 的收尾序列一致（不再单独 emitter.result，避免重复收尾）。
            services.workflowEventStore.append(
              workflowRunId,
              'run_finished',
              runFinishedPayload as unknown as Record<string, unknown>
            )
          } catch (err) {
            const errMessage = err instanceof Error ? err.message : String(err)
            persistWorkflowMessage({
              role: 'system',
              fromId: 'system',
              fromName: '系统',
              content: `工作流创作失败：${errMessage}`,
              phase: 'review',
              metadata: { workflowMessageType: 'run_end', failed: true }
            })
            // 路由层异常（orchestrator 未返回 result）：有边界产物同样可续跑
            if (lastBoundary != null) saveRunSnapshot('error', { error: errMessage })
             if (creationRunLifecycle) {
               try {
                 creationRunLifecycle.finish(workflowRunId, {
                   status: task.controller.signal.aborted ? 'cancelled' : 'error',
                   error: errMessage,
                 })
               } catch (lifecycleError) {
                 request.log.warn({ error: lifecycleError, workflowRunId }, '统一运行内核异常终态投影失败')
               }
             }
            cancelDebug('create-flow-catch', {
              projectId,
              chapterNumber,
              errMessage,
              errStack: err instanceof Error ? err.stack : undefined,
              signalAborted: task.controller.signal.aborted
            })
            if (!task.controller.signal.aborted) {
              persistRouteFailureAudit({
                request,
                projectId,
                chapterNumber: chapterNumberValue,
                operation: 'create-flow',
                sourceSymbol:
                  'createCreationFlowRoutes > POST /projects/:projectId/chapters/:chapterNumber/create-flow',
                input,
                errorCode: 'create_flow_request_failed',
                error: err,
                durationMs: Date.now() - startedAt,
                phase: 'workflow'
              })
            } else {
              // 用户显式取消：快照落 cancelled，让本章退出「进行中」状态。
              saveRunSnapshot('cancelled', { error: errMessage })
            }
            // 异常也必须写终态事件：缺失会让前端 tail 永远轮询等结果。
            services.workflowEventStore.append(workflowRunId, 'run_finished', {
              status: task.controller.signal.aborted ? 'cancelled' : 'error',
              workflowRunId,
              error: errMessage,
              canResume: lastBoundary != null
            })
          } finally {
            cancelDebug('create-flow-finally-pre', {
              projectId,
              chapterNumber,
              signalAborted: task.controller.signal.aborted
            })
            finishNovelChapterTask(creationLockKey, task)
            chapterCreationLocks.delete(creationLockKey)
            // 注销插话回显通道：orchestrator 终态 dropped 事件已在 createChapterWithFlow
            // 的 finally 内推出，此处仅清理注册表，防止向已结束的 run 推送。
            unregisterInterjectFlow(interjectFlowKey)
            cancelDebug('create-flow-finally-post', {
              projectId,
              chapterNumber,
              lockExists: chapterCreationLocks.has(creationLockKey),
              taskExists: activeNovelChapterTasks.has(creationLockKey)
            })
          }
        }
        // 后台执行：不 await，也不把生命周期绑到本请求。（显式取消走 /cancel-active-flow）
        void executeRun()

        reply.code(202).send({
          ok: true,
          runId: workflowRunId,
          eventsPath,
          message: '工作流创作已受理，正在后台执行；通过 events 端点消费进度与结果'
        })
      },
    })

    // 章节工作流事件 tail。`?from=seq` 支持重放 + 实时续传：面板重开先全量补齐
    // （from=0）再接实时；断线重连传上次游标即可补增量。轮询事件库实现 tail，
    // 与后台执行完全解耦；run_finished 写出后结束流。
    routes.push({
      method: 'GET',
      path: '/projects/:projectId/workflow-runs/:runId/events',
      handler: async (request: any, reply: any) => {
        const { runId } = request.params as { runId: string }
        const eventStore = services.workflowEventStore
        const fromParam = Number((request.query as { from?: string }).from ?? '0')
        const fromSeq = Number.isFinite(fromParam) && fromParam >= 0 ? Math.floor(fromParam) : 0

        if (eventStore.lastSeq(runId) === 0) {
          reply.code(404).send({ ok: false, error: '未找到该工作流运行的事件流' })
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

        const write = (data: unknown): void => {
          if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
        }
        let cursor = fromSeq
        let closed = false
        const cleanup = (): void => {
          if (closed) return
          closed = true
          clearInterval(heartbeat)
          clearInterval(poll)
          if (!reply.raw.writableEnded) reply.raw.end()
        }
        // 返回 true 表示已追到终态（run_finished 已写出）
        const pump = (): boolean => {
          if (closed) return true
          for (const event of eventStore.list(runId, cursor + 1)) {
            write({ type: event.type, seq: event.seq, payload: event.payload, createdAt: event.createdAt })
            cursor = event.seq
            if (event.type === 'run_finished') return true
          }
          return false
        }
        const heartbeat = setInterval(() => {
          if (!reply.raw.writableEnded) reply.raw.write(': keepalive\n\n')
        }, 15000)
        const poll = setInterval(() => {
          if (pump()) cleanup()
        }, 1000)
        reply.raw.once('close', cleanup)
        // 先补历史再接实时：重连面板靠 from=游标 补齐缺口后继续轮询
        if (pump()) cleanup()
      },
    })

    // 查找该章节仍在后台执行的章节工作流 run：面板重开后用户再点"开始创作"
    // 会收到 409，前端据此取回 runId 转入事件 tail 观看，而不是报错阻断。
    routes.push({
      method: 'GET',
      path: '/projects/:projectId/chapters/:chapterNumber/active-workflow-run',
      handler: async (request: any, reply: any) => {
        const { projectId } = request.params as { projectId: string }
        const chapterNumber = Number((request.params as { chapterNumber: string }).chapterNumber)
        const active = services.workflowEventStore.findActiveRun(projectId, chapterNumber)
        if (!active) {
          reply.code(404).send({ ok: false, error: '该章节没有正在执行的工作流创作' })
          return
        }
        reply.send({
          ok: true,
          runId: active.runId,
          cursorSeq: active.cursorSeq,
          eventsPath: `/projects/${projectId}/workflow-runs/${active.runId}/events`,
        })
      },
    })

    // 工作流断点续跑：从失败快照恢复，跳过已完成阶段（Director 已批准 → 跳过 Director；
    // Writer 草稿已成 → 跳过 Writer；正文定稿 → 只剩落库与记忆提取）。
    // runId 传 'latest' 时取该章最近一条可续跑快照（应用重启后前端已丢失 result.runId）。
    routes.push({
      method: 'POST',
      path: '/projects/:projectId/chapters/:chapterNumber/create-flow/:runId/resume',
      handler: async (request: any, reply: any) => {
        const { projectId, chapterNumber, runId } = request.params as {
          projectId: string
          chapterNumber: string
          runId: string
        }
        const orchestrator = services.orchestrator
        const chapter = requireWritableChapter(projectId, chapterNumber)
        const snapshot = runId === 'latest'
          ? services.workflowRunStore.getLatestResumable(projectId, chapter)
          : services.workflowRunStore.get(runId)
        if (!snapshot || snapshot.projectId !== projectId || snapshot.chapterNumber !== chapter) {
          reply.code(404).send({ ok: false, error: '未找到该章节的工作流中断记录' })
          return
        }
        if (snapshot.status === 'completed' || snapshot.status === 'cancelled' || !snapshot.phase) {
          reply.code(409).send({ ok: false, error: '该工作流记录不支持断点续跑' })
          return
        }
        // 后台闭包里用：属性收窄不会穿过函数边界，先把已收窄的阶段固化成常量。
        const resumePhase = snapshot.phase

        // 快照冻结模型失效兜底：Provider 模型列表可能已变更（删除/裁剪），
        // 沿用失效模型会让整条续跑在首个 Agent 调用就报"未找到所选模型"。
        // 此时丢弃 per-call 覆盖，让解析链回落到项目主模型/Agent 配置，并明确告知用户。
        let frozenModelId = snapshot.modelId
        if (frozenModelId) {
          const registry = services.context?.modelRegistry
          // 仅在注册表可用且明确查不到时降级；注册表缺失（测试/异常装配）保持透传原行为
          if (typeof registry?.find === 'function' && !registry.find(frozenModelId.provider, frozenModelId.modelId)) {
            request.log.warn(
              { projectId, chapterNumber: chapter, runId, modelId: frozenModelId },
              '续跑快照冻结的模型已不存在，降级为默认解析链'
            )
            frozenModelId = undefined
          }
        }

        const creationLockKey = `${projectId}:${chapterNumber}`
        if (chapterCreationLocks.has(creationLockKey) || aiArrangeLocks.has(creationLockKey) || activeNovelChapterTasks.has(creationLockKey)) {
          reply.code(409).send({ ok: false, error: '该章节正在创作中，请勿重复启动断点续跑' })
          return
        }

        // 与 create-flow 同构：run 脱离 HTTP 生命周期（断线/关面板不 abort，
        // 只有显式 cancel 才停），进度与结果经 events 端点 tail 消费。
        const resumeRunId = randomUUID()
        const eventsPath = `/projects/${projectId}/workflow-runs/${resumeRunId}/events`
        const emitter = createNovelAgUiEmitter(
          (event) => {
            services.workflowEventStore.append(resumeRunId, 'agui', event as unknown as Record<string, unknown>)
          },
          `novel:chapter-resume:${projectId}:${chapterNumber}`,
          resumeRunId,
        )
        // 插话回显通道与 create-flow 同构
        const interjectFlowKey = `${projectId}|${chapter}|${resumeRunId}`
        registerInterjectFlow(interjectFlowKey, (event) => {
          emitter.userMessage(event)
        })
        services.workflowEventStore.append(resumeRunId, 'run_started', {
          projectId,
          chapterNumber: chapter,
          workflowRunId: resumeRunId,
          resumedFromRunId: snapshot.id,
        })
        if (typeof orchestrator.clearStaleInterjectMessages === 'function') {
          orchestrator.clearStaleInterjectMessages(interjectFlowKey)
        }
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
            chapterNumber: chapter,
            ...message,
            metadata: {
              ...message.metadata,
              flowMode: 'workflow',
              workflowRunId: resumeRunId,
            },
          })
        }
        const task = registerNovelChapterTask(creationLockKey, 'workflow', resumeRunId)
        const startedAt = Date.now()

        // 续跑快照：沿用原快照的阶段产物，模型冻结为首跑选择（避免同一次创作换模型）。
        // 先用原边界初始化，确保续跑在产生新边界前再次失败时仍可继续。
        let lastBoundary: import('../core/workflow-run-store.js').WorkflowResumeState = {
          entry: snapshot.phase,
          directorTask: snapshot.directorTask,
          directorOutput: snapshot.directorOutput,
          rhythmSuggestion: snapshot.rhythmSuggestion,
          arrangedEntities: snapshot.arrangedEntities,
          writerDraft: snapshot.writerDraft,
          writerScenes: snapshot.writerScenes,
          finalContent: snapshot.finalContent,
        }
        const saveRunSnapshot = (
          status: 'running' | 'completed' | 'cancelled' | 'error',
          extra?: { failedPhase?: string; error?: string },
        ): void => {
          const boundary = lastBoundary
          try {
            services.workflowRunStore.save({
              id: resumeRunId,
              projectId,
              chapterNumber: chapter,
              status,
              phase: boundary?.entry,
              failedPhase: extra?.failedPhase as import('@repo/shared/novel').CreationPhase | undefined,
              directorTask: boundary?.directorTask,
              directorOutput: boundary?.directorOutput,
              rhythmSuggestion: boundary?.rhythmSuggestion,
              arrangedEntities: boundary?.arrangedEntities,
              writerDraft: boundary?.writerDraft,
              writerScenes: boundary?.writerScenes,
              finalContent: boundary?.finalContent,
              modelId: frozenModelId,
              styleExpertIds: snapshot.styleExpertIds,
              error: extra?.error,
              resumedFromRunId: snapshot.id,
            })
          } catch (snapshotError) {
            request.log.warn(
              { err: snapshotError, projectId, chapterNumber, resumeRunId },
              '工作流续跑快照落库失败（不影响创作流程）',
            )
          }
        }

        const executeRun = async (): Promise<void> => {
          try {
            chapterCreationLocks.add(creationLockKey)
            persistWorkflowMessage({
              role: 'system',
              fromId: 'system',
              fromName: '系统',
              content: `从第 ${chapter} 章工作流的${snapshot.phase === 'writing' ? '写作' : snapshot.phase === 'reviewing' ? '审稿' : '收尾'}阶段断点继续`,
              phase: 'pre_creation',
              metadata: { workflowMessageType: 'run_start', resumedFromRunId: snapshot.id },
            })
            const result = await orchestrator.createChapterWithFlow(
              projectId,
              chapter,
              {
                emit: emitter.emit,
                // 模型冻结：续跑沿用首跑的 per-call 模型
                modelId: frozenModelId,
                flowKey: interjectFlowKey,
                onRunStateUpdate: (state) => {
                  lastBoundary = state
                  saveRunSnapshot('running')
                },
                // 断点续跑状态：跳过快照边界之前的所有阶段
                resume: {
                  entry: resumePhase,
                  directorTask: snapshot.directorTask,
                  directorOutput: snapshot.directorOutput,
                  rhythmSuggestion: snapshot.rhythmSuggestion,
                  arrangedEntities: snapshot.arrangedEntities,
                  writerDraft: snapshot.writerDraft,
                  writerScenes: snapshot.writerScenes,
                  finalContent: snapshot.finalContent,
                },
                styleExpertIds: snapshot.styleExpertIds,
                onCheckpoint: async (checkpoint) => {
                  const toolCallId = randomUUID()
                  const checkpointCreatedAt = Date.now()
                  const decisionPromise = services.confirmationManager.requestDecision({
                    threadId: `novel-checkpoint-${projectId}-${chapterNumber}`,
                    toolCallId,
                    toolName: `checkpoint_${checkpoint.type}`,
                    args: { checkpoint, workflowRunId: resumeRunId } as Record<string, unknown>,
                    reason: `等待用户确认 ${checkpoint.type} 检查点（断点续跑）`,
                  }, 0)
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
                arrangedEntities: snapshot.arrangedEntities,
              },
            )
            persistWorkflowMessage({
              role: 'system',
              fromId: 'system',
              fromName: '系统',
              content: result.status === 'completed'
                ? '工作流断点续跑完成'
                : result.status === 'cancelled'
                  ? '工作流断点续跑已取消'
                  : `工作流断点续跑结束：${result.error ?? result.status}`,
              phase: 'review',
              metadata: { workflowMessageType: 'run_end' },
            })
            const resumable = result.status === 'error' && lastBoundary != null
            saveRunSnapshot(result.status, {
              failedPhase: result.failedPhase,
              error: result.error,
            })
            if (result.status === 'error') {
              persistRouteFailureAudit({
                request,
                projectId,
                chapterNumber: chapter,
                operation: 'create-flow-resume',
                sourceSymbol: 'createCreationFlowRoutes > POST /projects/:projectId/chapters/:chapterNumber/create-flow/:runId/resume',
                input: request.body ?? {},
                errorCode: 'create_flow_resume_failed',
                error: new Error(result.error ?? '工作流断点续跑失败'),
                durationMs: Date.now() - startedAt,
                result,
                phase: result.failedPhase ?? snapshot.phase,
              })
            }
            services.workflowEventStore.append(
              resumeRunId,
              'run_finished',
              (resumable
                ? { ...result, workflowRunId: resumeRunId, canResume: true }
                : { ...result, workflowRunId: resumeRunId }) as unknown as Record<string, unknown>,
            )
            } catch (err) {
            const errMessage = err instanceof Error ? err.message : String(err)
            persistWorkflowMessage({
              role: 'system',
              fromId: 'system',
              fromName: '系统',
              content: `工作流断点续跑失败：${errMessage}`,
              phase: 'review',
              metadata: { workflowMessageType: 'run_end', failed: true },
            })
            if (lastBoundary != null) saveRunSnapshot('error', { error: errMessage })
            if (!task.controller.signal.aborted) {
              persistRouteFailureAudit({
                request,
                projectId,
                chapterNumber: chapter,
                operation: 'create-flow-resume',
                sourceSymbol: 'createCreationFlowRoutes > POST /projects/:projectId/chapters/:chapterNumber/create-flow/:runId/resume',
                input: request.body ?? {},
                errorCode: 'create_flow_resume_request_failed',
                error: err,
                durationMs: Date.now() - startedAt,
                phase: snapshot.phase,
              })
            }
            services.workflowEventStore.append(resumeRunId, 'run_finished', {
              status: task.controller.signal.aborted ? 'cancelled' : 'error',
              workflowRunId: resumeRunId,
              error: errMessage,
              canResume: lastBoundary != null,
            })
          } finally {
            finishNovelChapterTask(creationLockKey, task)
            chapterCreationLocks.delete(creationLockKey)
            unregisterInterjectFlow(interjectFlowKey)
          }
        }
        void executeRun()

        reply.code(202).send({
          ok: true,
          runId: resumeRunId,
          eventsPath,
          message: '工作流断点续跑已受理，正在后台执行；通过 events 端点消费进度与结果',
        })
      },
    })

    // 定向再修订：质量门修订失败后，仅针对已保留修订稿的未通过项再次定向修订。
    // 不复跑 Director/Writer/Reviewer，避免失败后整条重跑烧掉大量 token；
    // 通过后**不自动落库**，由前端把修订稿交还用户（可手动编辑或保存到章节）。
    routes.push({
      method: 'POST',
      path: '/projects/:projectId/chapters/:chapterNumber/re-revise',
      handler: async (request: any, reply: any) => {
        const { projectId, chapterNumber } = request.params
        const reReviseBodySchema = z.object({
          content: z.string().min(1, '缺少待修订正文'),
          arrangedEntities: arrangedEntitiesSchema.optional(),
          /** 本次定向修订使用的临时模型覆盖；未传时按项目/角色配置解析。 */
          modelId: modelSelectionSchema.optional(),
        })
        const input = validateBody(reReviseBodySchema, request, reply)
        if (!input) return reply
        const chapterNumberValue = requireWritableChapter(projectId, chapterNumber)
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
          reply.code(409).send({ ok: false, error: '该章节正在创作中，请勿重复启动修订流程' })
          return
        }

        // SSE 设置与 create-flow 一致（绕过 Fastify CORS 中间件，需手动附加 CORS 头）
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

        const emitter = createNovelAgUiEmitter(
          createSseEmitterSink((data) => reply.raw.write(data)),
          `novel:chapter:${projectId}:${chapterNumber}:re-revise`,
          randomUUID(),
        )
        const task = registerNovelChapterTask(creationLockKey, 're-revise')
        const abortOnDisconnect = () => {
          if (!reply.raw.writableEnded && !task.controller.signal.aborted) {
            task.controller.abort(new Error('客户端已断开修订流'))
          }
        }
        reply.raw.once('close', abortOnDisconnect)

        const startedAt = Date.now()
        try {
          chapterCreationLocks.add(creationLockKey)
          const result = await services.orchestrator.reviseOnly({
            projectId,
            chapterNumber: chapterNumberValue,
            content: input.content,
            arrangedEntities,
            options: {
              emit: emitter.emit,
              // re-revise 无用户检查点；成本闸门若意外触发（预算从零起，正常不会），
              // 防御性继续，避免流程被未知决策打断。
              onCheckpoint: async () => 'approve' as const,
              onProgress: (event) => emitter.progress(event),
              signal: task.controller.signal,
              modelId: input.modelId,
            },
          })
          if (result.status === 'error') {
            persistRouteFailureAudit({
              request,
              projectId,
              chapterNumber: chapterNumberValue,
              operation: 're-revise',
              sourceSymbol: 'createCreationFlowRoutes > POST /projects/:projectId/chapters/:chapterNumber/re-revise',
              input,
              errorCode: result.errorCode ?? 're_revise_failed',
              error: new Error(result.error ?? '定向再修订失败'),
              durationMs: Date.now() - startedAt,
              result,
              agentType: 'reviser',
              agentName: '再修订审计',
              displayAgentType: 'reviser',
              displayAgentName: '修订错误审计',
              phase: 'revising',
            })
          }
          emitter.result(result)
        } catch (err) {
          cancelDebug('re-revise-catch', { projectId, chapterNumber, errMessage: err instanceof Error ? err.message : String(err), signalAborted: task.controller.signal.aborted })
          if (!task.controller.signal.aborted) {
            persistRouteFailureAudit({
              request,
              projectId,
              chapterNumber: chapterNumberValue,
              operation: 're-revise',
              sourceSymbol: 'createCreationFlowRoutes > POST /projects/:projectId/chapters/:chapterNumber/re-revise',
              input,
              errorCode: 're_revise_request_failed',
              error: err,
              durationMs: Date.now() - startedAt,
              agentType: 'reviser',
              agentName: '再修订审计',
              displayAgentType: 'reviser',
              displayAgentName: '修订错误审计',
              phase: 'revising',
            })
          }
          emitter.error(err instanceof Error ? err.message : String(err))
        } finally {
          clearInterval(heartbeat)
          reply.raw.off('close', abortOnDisconnect)
          finishNovelChapterTask(creationLockKey, task)
          chapterCreationLocks.delete(creationLockKey)
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
        const isArrange = pending?.threadId.startsWith(`novel-arrange-${projectId}-`)
        if (!pending || (!isWorkflow && !isDiscussion && !isArrange)) {
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
            services.orchestrator.appendUserMessages(projectId, chapterNumber, userMessages)
          }
        }

        if (isDiscussion && userMessages && userMessages.length > 0) {
          appendCheckpointFeedback(checkpointId, userMessages)
        }

        if (isArrange) {
          const chapterText = pending.threadId.slice(`novel-arrange-${projectId}-`.length)
          const chapterNumber = Number(chapterText)
          const comment = userMessages?.filter((message) => message.trim()).join('\n').trim()
          if (comment) arrangeDecisionFeedback.set(checkpointId, comment)
          if (Number.isInteger(chapterNumber) && chapterNumber > 0 && comment) {
            try {
              services.chapterChatStore.add({
                projectId,
                chapterNumber,
                role: 'user',
                fromId: 'user',
                fromName: '用户',
                content: comment,
                phase: 'checkpoint',
                metadata: { flowMode: 'workflow', workflowMessageType: 'checkpoint', checkpointId, checkpointType: 'arrange_review' },
              })
            } catch (error) {
              request.log.warn({ error, projectId, chapterNumber }, 'AI 编排修改意见落库失败')
            }
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
        if (isDiscussion) clearCheckpointFeedback(checkpointId)
        if (!accepted) {
          reply.code(404).send({ ok: false, error: '检查点不存在或已处理' })
          return
        }
        if (isWorkflow && services.creationRunLifecycle) {
          const checkpointArgs = pending.args as {
            checkpoint?: { type?: CheckpointType }
            workflowRunId?: string
          }
          const workflowRunId = checkpointArgs.workflowRunId
          const checkpointType = checkpointArgs.checkpoint?.type
          if (workflowRunId) {
            const resumeStage = decision === 'approve'
              ? checkpointType === 'narrative_task'
                ? 'writing'
                : checkpointType === 'writer_pushback' ? 'planning' : undefined
              : checkpointType === 'writer_pushback' && (decision === 'revise' || decision === 'rewrite')
                ? 'writing'
                : undefined
            try {
              services.creationRunLifecycle.resolveCheckpoint(
                workflowRunId,
                checkpointId,
                decision as 'approve' | 'revise' | 'rewrite' | 'reject',
                {
                  resumeStage: resumeStage as CreationRunStage | undefined,
                  resumeWithoutRevision: checkpointType === 'writer_pushback' && decision === 'rewrite',
                  reason: `用户选择：${describeDecision(checkpointType, decision)}`,
                },
              )
            } catch (error) {
              request.log.warn({ error, workflowRunId, checkpointId, decision }, '统一运行内核决策投影失败')
            }
          }
        }
        return { ok: true, data: { accepted: true } }
      },
    })

    // ═══════════════════════════════════════════════════════════════
    // 插话（对话化交互形态 §3.1）：向运行中的 create-flow 注入用户中途反馈
    // ═══════════════════════════════════════════════════════════════

    // flowId 是 RUN_STARTED 发出的本次运行 ID；chapterNumber 仅用于定位章节任务。
    // 兼容旧客户端：数字 flowId 仍可作为 chapterNumber 解析，但只会命中同样以数字
    // 注册的测试/旧任务，不会被新 UUID 运行接受。
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
          ?? (/^\d+$/.test(flowId) ? Number(flowId) : undefined)
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

    // ═══════════════════════════════════════════════════════════════
    // 群聊共创模式（SSE + 检查点）
    // ═══════════════════════════════════════════════════════════════

    // 群聊创作流程启动端点（SSE）
    // 与 /create-flow 结构一致，把 orchestrator.createChapterWithFlow 换成 discussionRunner.run。
    // 每次运行时从 discussionSettingsStore 读取运行时限制，使 PUT /discussion-settings 的修改即时生效。
    routes.push({
      method: 'POST',
      path: '/projects/:projectId/chapters/:chapterNumber/create-discussion',
      handler: async (request: any, reply: any) => {
        const { projectId, chapterNumber } = request.params
        const discussionRunner = services.discussionRunner

        // 解析请求体中的 arrangedEntities（与 create-flow 端点一致，复用同一 schema）
        const input = validateBody(creationFlowBodySchema, request, reply)
        if (!input) return reply
        const chapterNumberValue = requireWritableChapter(projectId, chapterNumber)
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

        // T6：run 脱离 HTTP 生命周期。POST 只受理并返回 202 + runId，执行转入
        // 后台任务；断开连接/关闭面板不再 abort，只有显式 cancel 才停。
        // 进度与结果经事件流消费（GET .../discussion-runs/:runId/events）。
        const discussionRunId = randomUUID()
        const startedAt = Date.now()
        const task = registerNovelChapterTask(creationLockKey, 'discussion', discussionRunId)
        chapterCreationLocks.add(creationLockKey)
        // 插话回显通道：状态事件（queued/injected/dropped）经 emitter 进 mirror sink，
        // 与旧 SSE 同一条 novel:user-message 事件契约（T7）。
        const interjectFlowKey = `${projectId}|${chapterNumberValue}|${discussionRunId}`
        // T7：emit 通道整体镜像进事件流（type='agui'，payload 即原 AG-UI 事件）。
        // TEXT_MESSAGE_* 流式正文、novel:progress、novel:checkpoint、novel:user-message
        // 都经此通道——不镜像的话流式体验退化为"输出完成后一次性出现"。
        const emitter = createNovelAgUiEmitter(
          (event) => {
            services.discussionEventStore.append(discussionRunId, 'agui', event as unknown as Record<string, unknown>)
          },
          `novel:discussion:${projectId}:${chapterNumber}`,
          discussionRunId,
        )
        registerInterjectFlow(interjectFlowKey, (event) => {
          emitter.userMessage(event)
        })

        // run_started 同步入流：保证 202 返回时 events 端点已能定位该 run。
        // 事件流是 fold 状态与续跑重放的唯一事实源（T4）。
        services.discussionEventStore.append(discussionRunId, 'run_started', {
          projectId,
          chapterNumber: chapterNumberValue,
          startedAt,
        })

        const executeRun = async (): Promise<void> => {
          const checkpointFeedback: string[] = []
          try {
            // 运行时限制（maxRounds 等）由 runner 内部经 discussionSettingsStore 读取
            const projectModel = parseNovelModelRef(
              typeof store.getNovelModelId === 'function' ? store.getNovelModelId(projectId) : undefined,
            ) ?? null
            const result = await discussionRunner.run(
              projectId,
              chapterNumberValue,
              {
                emit: emitter.emit,
                onEvent: event => services.discussionEventStore.append(discussionRunId, event.type, event.payload),
                onCheckpoint: async (checkpoint) => {
                  // 后台 run 的检查点经 ConfirmationManager 挂起；用户重连后用
                  // discussion-checkpoint/:checkpointId/decision 端点决策。
                  // checkpoint_pending 事件携带 checkpointId，事件 tail 是决策入口的路由依据。
                  return waitForCheckpointDecision({
                    manager: services.confirmationManager,
                    threadId: `novel-discussion-${projectId}-${chapterNumber}`,
                    toolName: `discussion_${checkpoint.type}`,
                    checkpoint: withDiscussionCheckpointOptions(checkpoint),
                    reason: `等待用户确认群聊检查点：${checkpoint.question}`,
                    feedback: checkpointFeedback,
                    emit: emitter.checkpoint,
                  }) as Promise<'approve' | 'reject' | 'revise' | string>
                },
                checkpointFeedback,
                onProgress: (event) => emitter.progress(event),
                flowKey: interjectFlowKey,
                styleExpertIds: input.styleExpertIds,
                projectModel,
                // 插话生命周期：engine drain/收尾时回调，经注册表路由状态事件
                // （状态经 emitter 进 mirror sink，无需单独落库）。
                onInterjectInjected: ids => dispatchInterjectStatus('injected', ids),
                onInterjectDropped: ids => dispatchInterjectStatus('dropped', ids),
                signal: task.controller.signal,
              },
              arrangedEntities,
            )
            // T5：run 行停写三元组；failedPhase 只透传 canResume 判定，不落库。
            // run_finished 携带最终正文与演出诊断：前端经事件 tail 拿结果，无需独立状态端点。
            services.discussionEventStore.append(discussionRunId, 'run_finished', {
              status: result.status,
              error: result.error,
              content: result.content,
              discussionRunId,
              canResume: result.status === 'error' && result.failedPhase != null
                && DISCUSSION_RESUMABLE_PHASES.has(result.failedPhase),
              diagnostics: result.diagnostics,
            })
            services.discussionRunStore.save({
              id: discussionRunId,
              projectId,
              chapterNumber: chapterNumberValue,
              status: result.status,
              transcript: result.transcript,
              scenes: result.scenes,
              arrangedEntities,
              projectModel,
              styleExpertIds: input.styleExpertIds,
              content: result.content,
              error: result.error,
            })
            try {
              persistDiscussionHistory(
                services.chapterChatStore,
                projectId,
                chapterNumberValue,
                result,
                discussionRunId,
              )
            } catch (historyError) {
              request.log.error(
                { err: historyError, projectId, chapterNumber, discussionRunId },
                '群聊历史持久化失败',
              )
            }
            if (result.status === 'error') {
              persistRouteFailureAudit({
                request,
                projectId,
                chapterNumber: chapterNumberValue,
                operation: 'create-discussion',
                sourceSymbol: 'createCreationFlowRoutes > POST /projects/:projectId/chapters/:chapterNumber/create-discussion',
                input,
                errorCode: 'create_discussion_failed',
                error: new Error(result.error ?? '群聊创作失败'),
                durationMs: Date.now() - startedAt,
                result,
                phase: result.failedPhase ?? 'discussion',
              })
            }
          } catch (err) {
            // 引擎外层异常：补终态事件，避免事件流永远停在 running 让 fold 无法收口。
            services.discussionEventStore.append(discussionRunId, 'run_finished', {
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
            })
            if (!task.controller.signal.aborted) {
              persistRouteFailureAudit({
                request,
                projectId,
                chapterNumber: chapterNumberValue,
                operation: 'create-discussion',
                sourceSymbol: 'createCreationFlowRoutes > POST /projects/:projectId/chapters/:chapterNumber/create-discussion',
                input,
                errorCode: 'create_discussion_request_failed',
                error: err,
                durationMs: Date.now() - startedAt,
                phase: 'discussion',
              })
            }
          } finally {
            clearCheckpointFeedbackForRun(checkpointFeedback)
            finishNovelChapterTask(creationLockKey, task)
            chapterCreationLocks.delete(creationLockKey)
            // 注销插话注册表（含 runner 登记的 enqueue 闭包兜底）。
            unregisterInterjectFlow(interjectFlowKey)
          }
          }
        void executeRun()

        reply.code(202).send({
          ok: true,
          runId: discussionRunId,
          eventsPath: `/projects/${projectId}/discussion-runs/${discussionRunId}/events`,
          message: '群聊创作已受理，正在后台执行；通过 events 端点消费进度与结果',
        })
      },
    })

    // 群聊事件 tail（T6）：`?from=seq` 支持重放 + 实时续传。面板重开先全量补齐
    // （from=0）再接实时；断线重连传上次游标即可补增量。轮询事件库实现 tail，
    // 与后台执行完全解耦；run_finished 写出后结束流。
    routes.push({
      method: 'GET',
      path: '/projects/:projectId/discussion-runs/:runId/events',
      handler: async (request: any, reply: any) => {
        const { runId } = request.params as { runId: string }
        const eventStore = services.discussionEventStore
        const fromParam = Number((request.query as { from?: string }).from ?? '0')
        const fromSeq = Number.isFinite(fromParam) && fromParam >= 0 ? Math.floor(fromParam) : 0

        if (eventStore.lastSeq(runId) === 0) {
          reply.code(404).send({ ok: false, error: '未找到该群聊运行的事件流' })
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

        const write = (data: unknown) => {
          if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
        }
        let cursor = fromSeq
        let closed = false
        const cleanup = () => {
          if (closed) return
          closed = true
          clearInterval(heartbeat)
          clearInterval(poll)
          if (!reply.raw.writableEnded) reply.raw.end()
        }
        // 返回 true 表示已追到终态（run_finished 已写出）
        const pump = (): boolean => {
          if (closed) return true
          for (const event of eventStore.list(runId, cursor + 1)) {
            write({ type: event.type, seq: event.seq, payload: event.payload, createdAt: event.createdAt })
            cursor = event.seq
            if (event.type === 'run_finished') return true
          }
          return false
        }
        const heartbeat = setInterval(() => {
          if (!reply.raw.writableEnded) reply.raw.write(': keepalive\n\n')
        }, 15000)
        const poll = setInterval(() => {
          if (pump()) cleanup()
        }, 1000)
        reply.raw.once('close', cleanup)
        // 先补历史再接实时：重连面板靠 from=游标 补齐缺口后继续轮询
        if (pump()) cleanup()
      },
    })

    // 查找该章节仍在后台执行的群聊 run（T7）：面板重开后用户再点"开始群聊"
    // 会收到 409，前端据此取回 runId 转入事件 tail 观看，而不是报错阻断。
    routes.push({
      method: 'GET',
      path: '/projects/:projectId/chapters/:chapterNumber/active-discussion-run',
      handler: async (request: any, reply: any) => {
        const { projectId } = request.params as { projectId: string }
        const chapterNumber = Number((request.params as { chapterNumber: string }).chapterNumber)
        const active = services.discussionEventStore.findActiveRun(projectId, chapterNumber)
        if (!active) {
          reply.code(404).send({ ok: false, error: '该章节没有正在执行的群聊运行' })
          return
        }
        reply.send({
          ok: true,
          runId: active.runId,
          cursorSeq: active.cursorSeq,
          eventsPath: `/projects/${projectId}/discussion-runs/${active.runId}/events`,
        })
      },
    })

    // 群聊运行显式取消（T6）：run 不再随 HTTP 断开而停，取消是唯一停止途径。
    routes.push({
      method: 'POST',
      path: '/projects/:projectId/discussion-runs/:runId/cancel',
      handler: async (request: any, reply: any) => {
        const { runId } = request.params as { runId: string }
        const task = [...activeNovelChapterTasks.values()].find(t =>
          t.flowId === runId && (t.kind === 'discussion' || t.kind === 'discussion-resume'))
        if (!task) {
          const events = services.discussionEventStore.list(runId)
          const finished = events.at(-1)?.type === 'run_finished'
          reply.code(finished ? 409 : 404).send({
            ok: false,
            error: finished ? '该群聊运行已结束' : '未找到运行中的群聊任务',
          })
          return
        }
        task.controller.abort(new Error('用户显式取消群聊运行'))
        // 等待引擎冻结并落终态（与 cancel-active-flow 同语义），避免前端
        // 拿到 200 后立刻重开面板却看到 running。
        await task.donePromise
        reply.send({ ok: true, runId, cancelled: true })
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
        const chapter = requireWritableChapter(projectId, chapterNumber)
        const snapshot = services.discussionRunStore.get(runId)
        if (!snapshot || snapshot.projectId !== projectId || snapshot.chapterNumber !== chapter) {
          reply.code(404).send({ ok: false, error: '未找到该章节的群聊中断记录' })
          return
        }
        // T5：断点位置双来源。新 run 的 run 行已停写三元组，从事件流推导；
        // 旧快照（无事件）回落到 run 行列值（transcript 反推在引擎内兜底）。
        const resumeEvents = services.discussionEventStore.list(runId)
        const resumeInfo = resumeEvents.length > 0 ? deriveResumeInfo(resumeEvents) : undefined
        const resumePhase = resumeInfo?.phase ?? snapshot.failedPhase
        const resumeFailedSceneId = resumeInfo ? resumeInfo.failedSceneId : snapshot.failedSceneId
        const resumeFailedActionBeatId = resumeInfo ? resumeInfo.failedActionBeatId : snapshot.failedActionBeatId
        if (snapshot.status !== 'error' || resumePhase == null
            || !DISCUSSION_RESUMABLE_PHASES.has(resumePhase)) {
          reply.code(409).send({ ok: false, error: '该群聊记录不支持断点续跑' })
          return
        }

        const creationLockKey = `${projectId}:${chapterNumber}`
        if (chapterCreationLocks.has(creationLockKey) || aiArrangeLocks.has(creationLockKey) || activeNovelChapterTasks.has(creationLockKey)) {
          reply.code(409).send({ ok: false, error: '该章节正在创作中，请勿重复启动断点续跑' })
          return
        }

        const resumeRunId = randomUUID()
        const startedAt = Date.now()
        const eventsPath = `/projects/${projectId}/discussion-runs/${resumeRunId}/events`
        const emitter = createNovelAgUiEmitter(
          (event) => {
            services.discussionEventStore.append(resumeRunId, 'agui', event as unknown as Record<string, unknown>)
          },
          `novel:discussion-resume:${projectId}:${chapterNumber}`,
          resumeRunId,
        )
        const interjectFlowKey = `${projectId}|${chapter}|${resumeRunId}`
        registerInterjectFlow(interjectFlowKey, (event) => emitter.userMessage(event))
        const task = registerNovelChapterTask(creationLockKey, 'discussion-resume', resumeRunId)
        chapterCreationLocks.add(creationLockKey)
        services.discussionEventStore.append(resumeRunId, 'run_started', {
          projectId,
          chapterNumber: chapter,
          resumedFromRunId: runId,
          resumePhase,
          startedAt,
        })
        const checkpointFeedback: string[] = []

        const executeRun = async (): Promise<void> => {
          try {
          const projectModel = snapshot.projectModel === undefined
            ? parseNovelModelRef(
                typeof store.getNovelModelId === 'function' ? store.getNovelModelId(projectId) : undefined,
              ) ?? null
            : snapshot.projectModel
          const result = await services.discussionRunner.run(
            projectId,
            chapter,
            {
              checkpointFeedback,
              emit: emitter.emit,
              // 续跑 run 拥有独立事件流（runId=resumeRunId）；plan 之前的已完成节点
              // 经 completedActionBeatIds 显式传入引擎，不再靠 transcript 反推。
              onEvent: event => services.discussionEventStore.append(resumeRunId, event.type, event.payload),
              onCheckpoint: async (checkpoint) => {
                return waitForCheckpointDecision({
                  manager: services.confirmationManager,
                  threadId: `novel-discussion-${projectId}-${chapterNumber}`,
                  toolName: `discussion_${checkpoint.type}`,
                  checkpoint: withDiscussionCheckpointOptions(checkpoint),
                  reason: `等待用户确认群聊断点续跑检查点：${checkpoint.question}`,
                  feedback: checkpointFeedback,
                  emit: emitter.checkpoint,
                }) as Promise<'approve' | 'reject' | 'revise' | string>
              },
              onProgress: (event) => emitter.progress(event),
              projectModel,
              flowKey: interjectFlowKey,
              styleExpertIds: snapshot.styleExpertIds,
              onInterjectInjected: ids => dispatchInterjectStatus('injected', ids),
              onInterjectDropped: ids => dispatchInterjectStatus('dropped', ids),
              signal: task.controller.signal,
            },
            snapshot.arrangedEntities,
            {
              // 上面 409 守卫已用 DISCUSSION_RESUMABLE_PHASES 收窄到可续跑阶段
              phase: resumePhase as 'chapter_weaving' | 'reviewing' | 'acting' | 'scene_setup',
              transcript: snapshot.transcript,
              scenes: snapshot.scenes,
              content: snapshot.content,
               failedSceneId: resumeFailedSceneId,
               failedActionBeatId: resumeFailedActionBeatId,
              // 事件重放得出的完成集：跳过 transcript 反推（T5）
              ...(resumePhase === 'acting' && resumeFailedSceneId != null
                && resumeInfo?.completedByScene.get(resumeFailedSceneId)
                ? { completedActionBeatIds: resumeInfo.completedByScene.get(resumeFailedSceneId) }
                : {}),
            },
          )

          const finalResult = {
            ...result,
            discussionRunId: resumeRunId,
            resumedFromRunId: runId,
            canResume: result.status === 'error' && result.failedPhase != null
              && DISCUSSION_RESUMABLE_PHASES.has(result.failedPhase),
          }
          services.discussionEventStore.append(resumeRunId, 'run_finished', finalResult)
          services.discussionRunStore.save({
            id: resumeRunId,
            projectId,
            chapterNumber: chapter,
            status: result.status,
            transcript: result.transcript,
            scenes: result.scenes,
            arrangedEntities: snapshot.arrangedEntities,
            projectModel,
            styleExpertIds: snapshot.styleExpertIds,
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

          if (result.status === 'error') {
            persistRouteFailureAudit({
              request,
              projectId,
              chapterNumber: chapter,
              operation: 'create-discussion-resume',
              sourceSymbol: 'createCreationFlowRoutes > POST /projects/:projectId/chapters/:chapterNumber/create-discussion/:runId/resume',
              input: request.body ?? {},
              errorCode: 'create_discussion_resume_failed',
              error: new Error(result.error ?? '群聊断点续跑失败'),
              durationMs: Date.now() - startedAt,
              result,
              phase: result.failedPhase ?? snapshot.failedPhase,
            })
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err)
          services.discussionEventStore.append(resumeRunId, 'run_finished', {
            status: task.controller.signal.aborted ? 'cancelled' : 'error',
            error: errorMessage,
            discussionRunId: resumeRunId,
            resumedFromRunId: runId,
            canResume: false,
          })
          if (!task.controller.signal.aborted) {
            persistRouteFailureAudit({
              request,
              projectId,
              chapterNumber: chapter,
              operation: 'create-discussion-resume',
              sourceSymbol: 'createCreationFlowRoutes > POST /projects/:projectId/chapters/:chapterNumber/create-discussion/:runId/resume',
              input: request.body ?? {},
              errorCode: 'create_discussion_resume_request_failed',
              error: err,
              durationMs: Date.now() - startedAt,
              phase: snapshot.failedPhase,
            })
          }
        } finally {
          clearCheckpointFeedbackForRun(checkpointFeedback)
          finishNovelChapterTask(creationLockKey, task)
          chapterCreationLocks.delete(creationLockKey)
          unregisterInterjectFlow(interjectFlowKey)
        }
      }

      void executeRun()
      reply.code(202).send({
        ok: true,
        runId: resumeRunId,
        eventsPath,
        message: '群聊断点续跑已受理，正在后台执行；通过 events 端点消费进度与结果',
      })
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
      const { decision, userMessages } = request.body as { decision: string; userMessages?: string[] }
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
      if (userMessages && userMessages.length > 0) {
        appendCheckpointFeedback(checkpointId, userMessages)
      }
      // 委托 ConfirmationManager 响应决策（resolve 对应 pending Promise）
      const accepted = services.confirmationManager.respondDecision(checkpointId, decision)
      clearCheckpointFeedback(checkpointId)
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
      const chNum = requireDerivedStateWritableChapter(projectId, chapterNumber)
      const arrangeInput = validateBody(aiArrangeBodySchema, request, reply)
      if (!arrangeInput) return reply

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
      // arrange_review 决策无超时（timeout=0）：客户端断开或任务中止时必须主动
      // reject 唤醒等待中的路由，否则 finally 永不执行，锁残留导致该章 409 直到重启。
      // 与 cancel-active-flow 的显式取消互补；rollback 幂等，重复调用安全。
      const rejectArrangePendingOnAbort = () => {
        const arrangeThreadId = `novel-arrange-${projectId}-${chNum}`
        const pendingArrange = services.confirmationManager.listPending().find(
          (p) => p.threadId === arrangeThreadId,
        )
        if (!pendingArrange) return
        pendingArrangeDrafts.get(lockKey)?.handle.rollback()
        pendingArrangeDrafts.delete(lockKey)
        services.confirmationManager.respondDecision(pendingArrange.id, 'reject')
      }
      task.controller.signal.addEventListener('abort', rejectArrangePendingOnAbort, { once: true })

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
      const startedAt = Date.now()

      // 锁置入 try 块开头：确保 finally 必定执行 delete，避免 SSE 设置抛错导致锁残留
      try {
        aiArrangeLocks.set(lockKey, Promise.resolve())
        const chapter = store.getChapter(projectId, chNum)
        if (!chapter) throw new AppError(ErrorCode.NOT_FOUND, `章节不存在: ${chNum}`, 404)
        if (!chapter.outline?.trim()) throw new Error('章纲为空，无法 AI 编排')

        // 阶段1：AI 编排（生成实体草稿，但暂不提交事务）
        // 注意：本接口仅做矩阵编排，不衔接 create-flow 创作流程。
        // arrange 进度事件统一带 phase='arranging'，前端据此在对话时间线展示处理步骤。
        emitter.progress({ type: 'arrange_start', phase: 'arranging', message: '开始 AI 编排实体...' })
        let draft: ArrangeDraftHandle
        let feedback: string | undefined
        while (true) {
          const draftId = randomUUID()
          if (typeof (entityGenerator as any).generateArrangeDraft === 'function') {
            draft = await (entityGenerator as any).generateArrangeDraft(
              projectId,
              chNum,
              chapter.outline,
              // 注意：...evt 必须放在 phase 之前，否则 evt.phase 会覆盖 'arranging'。
              (evt: { phase: string; message: string; data?: unknown; detail?: Record<string, unknown> }) => emitter.progress({ type: 'arrange_progress', ...evt, phase: 'arranging' }),
               arrangeInput.modelId,
              feedback,
              task.controller.signal,
            )
          } else {
            // 仅兼容旧测试替身/第三方注入服务；正式 NovelEntityGenerator 始终走事务草稿。
            const arrangedEntities = await entityGenerator.generateAndArrange(
              projectId,
              chNum,
              chapter.outline,
              (evt: { phase: string; message: string; data?: unknown; detail?: Record<string, unknown> }) => emitter.progress({ type: 'arrange_progress', ...evt, phase: 'arranging' }),
              'outline',
              task.controller.signal,
               arrangeInput.modelId,
            )
            draft = { result: arrangedEntities, commit: () => undefined, rollback: () => undefined }
          }
          pendingArrangeDrafts.set(lockKey, { draftId, handle: draft, modelId: arrangeInput.modelId, feedback })
          const arrangedEntities = draft.result
          const entityDetails = buildArrangeReviewDetails(store, arrangedEntities, chNum)
          const totalCount = arrangedEntities.characterIds.length
            + arrangedEntities.conflictIds.length
            + arrangedEntities.foreshadowIds.length
            + (arrangedEntities.clueIds ?? []).length
            + arrangedEntities.factionIds.length
            + arrangedEntities.locationIds.length
            + (arrangedEntities.itemIds ?? []).length
            + (arrangedEntities.narrativeIds ?? []).length
          emitter.progress({
            type: 'arrange_done',
            phase: 'arranging',
            message: `编排完成：共生成 ${totalCount} 个实体，等待你确认是否落库`,
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
              items: (arrangedEntities.itemIds ?? []).length,
              narratives: (arrangedEntities.narrativeIds ?? []).length,
              entityDetails,
              reviewPending: true,
            },
          })
          const reviewData = {
            arrangedEntities,
            total: totalCount,
            model: entityGenerator.getArrangeModel(projectId, arrangeInput.modelId),
            entityDetails,
            reviewPending: true,
          }
          const decisionPromise = services.confirmationManager.requestDecision({
            threadId: `novel-arrange-${projectId}-${chNum}`,
            toolCallId: draftId,
            toolName: 'arrange_review',
            args: {
              checkpoint: {
                type: 'arrange_review',
                phase: 'checkpoint_review',
                data: reviewData,
                options: ['approve', 'revise', 'reject'],
              },
              draftId,
            },
            reason: '等待用户确认 AI 编排结果是否落库',
          }, 0)
          const pending = services.confirmationManager.listPending().find((item) => item.toolCallId === draftId)
          emitter.checkpoint({
            type: 'arrange_review',
            phase: 'checkpoint_review',
            checkpointId: pending?.id,
            data: reviewData,
            options: ['approve', 'revise', 'reject'],
          })
          const decision = await decisionPromise
          const decisionFeedback = pending?.id ? arrangeDecisionFeedback.get(pending.id) : undefined
          if (pending?.id) arrangeDecisionFeedback.delete(pending.id)
          if (decision === 'revise') {
            draft.rollback()
            pendingArrangeDrafts.delete(lockKey)
            feedback = decisionFeedback?.trim() || '请根据上一版结果重新调整本章实体编排。'
            emitter.progress({ type: 'arrange_revision', phase: 'arranging', message: '已收到意见，正在重新编排...' })
            continue
          }
          if (decision === 'reject') {
            draft.rollback()
            pendingArrangeDrafts.delete(lockKey)
            emitter.result({ status: 'cancelled' })
            break
          }
          draft.commit()
          pendingArrangeDrafts.delete(lockKey)
          emitter.progress({
            type: 'arrange_committed',
            phase: 'arranging',
            dataChanged: true,
            message: `已确认落库：${totalCount} 个实体已写入矩阵`,
          })
          emitter.result({
            status: 'completed',
            stateChanges: [{
              type: 'arrange',
              description: `AI 编排已确认，${totalCount} 个实体已落入第 ${chNum} 章矩阵`,
            }],
          })
          break
        }
      } catch (err) {
        pendingArrangeDrafts.get(lockKey)?.handle.rollback()
        pendingArrangeDrafts.delete(lockKey)
        if (!task.controller.signal.aborted) {
          persistRouteFailureAudit({
            request,
            projectId,
            chapterNumber: chNum,
            operation: 'ai-arrange',
            sourceSymbol: 'createCreationFlowRoutes > POST /projects/:projectId/chapters/:chapterNumber/ai-arrange',
            input: arrangeInput,
            errorCode: 'ai_arrange_request_failed',
            error: err,
            durationMs: Date.now() - startedAt,
            phase: 'arranging',
          })
        }
        emitter.error(String(err))
      } finally {
        clearInterval(heartbeat)
        reply.raw.off('close', abortOnDisconnect)
        task.controller.signal.removeEventListener('abort', rejectArrangePendingOnAbort)
        finishNovelChapterTask(lockKey, task)
        if (!reply.raw.writableEnded) reply.raw.end()
        aiArrangeLocks.delete(lockKey)
      }
    },
  })

  // 可续跑 run 列表：每章取最近一条中断快照（含草稿长度与失败信息）。
  // 供章节视图展示"本章有未完成的创作"，解决中断入口不可见导致的半成品堆积。
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/resumable-runs',
    handler: async (request: any) => {
      const { projectId } = request.params as { projectId: string }
      if (!store.getProject(projectId)) {
        throw new AppError(ErrorCode.NOT_FOUND, `项目不存在: ${projectId}`, 404)
      }
      const runs = services.workflowRunStore.listResumableByProject(projectId).map((run) => ({
        runId: run.id,
        chapterNumber: run.chapterNumber,
        status: run.status,
        phase: run.phase,
        failedPhase: run.failedPhase,
        writerDraftLength: run.writerDraft?.length ?? 0,
        finalContentLength: run.finalContent?.length ?? 0,
        error: run.error,
        updatedAt: run.updatedAt,
      }))
      return success(runs, request.traceId)
    },
  })

  // 弃用中断 run：标记为 cancelled，使其退出可续跑列表（用户明确放弃半成品时调用）。
  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters/:chapterNumber/create-flow/:runId/discard',
    handler: async (request: any, reply: any) => {
      const { projectId, runId } = request.params as { projectId: string; runId: string }
      const snapshot = services.workflowRunStore.get(runId)
      if (!snapshot || snapshot.projectId !== projectId) {
        reply.code(404).send({ ok: false, error: '未找到该工作流中断记录' })
        return
      }
      if (snapshot.status === 'completed' || snapshot.status === 'cancelled') {
        reply.code(409).send({ ok: false, error: '该记录无需弃用' })
        return
      }
      services.workflowRunStore.save({ ...snapshot, status: 'cancelled', error: snapshot.error })
      request.log.info(
        { projectId, chapterNumber: snapshot.chapterNumber, runId },
        '工作流中断快照已弃用',
      )
      return success({ discarded: true }, request.traceId)
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
      const chNum = requireDerivedStateWritableChapter(projectId, chapterNumber)
      const input = validateBody(reverseArrangeBodySchema, request, reply)
      if (!input) return reply

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
      const startedAt = Date.now()

      try {
        aiArrangeLocks.set(lockKey, Promise.resolve())
        const chapter = store.getChapter(projectId, chNum)
        if (!chapter) throw new AppError(ErrorCode.NOT_FOUND, `章节不存在: ${chNum}`, 404)
        if (!chapter.content?.trim()) throw new Error('章节正文为空，无法反推实体')

        emitter.progress({ type: 'arrange_start', phase: 'arranging', message: '开始从正文反推实体...' })
        const arrangedEntities = await entityGenerator.generateAndArrange(
          projectId,
          chNum,
          chapter.content,
          (evt) => emitter.progress({ type: 'arrange_progress', ...evt, phase: 'arranging' }),
          'content', // source='content' 表示从正文反推
          task.controller.signal,
          input.modelId,
        )
        const totalCount = arrangedEntities.characterIds.length
          + arrangedEntities.conflictIds.length
          + arrangedEntities.foreshadowIds.length
          + (arrangedEntities.clueIds ?? []).length
          + arrangedEntities.factionIds.length
          + arrangedEntities.locationIds.length
          + (arrangedEntities.itemIds ?? []).length
          + (arrangedEntities.narrativeIds ?? []).length
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
            items: (arrangedEntities.itemIds ?? []).length,
            narratives: (arrangedEntities.narrativeIds ?? []).length,
            reviewPending: false,
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
        if (!task.controller.signal.aborted) {
          persistRouteFailureAudit({
            request,
            projectId,
            chapterNumber: chNum,
            operation: 'reverse-arrange',
            sourceSymbol: 'createCreationFlowRoutes > POST /projects/:projectId/chapters/:chapterNumber/reverse-arrange',
            input,
            errorCode: 'reverse_arrange_request_failed',
            error: err,
            durationMs: Date.now() - startedAt,
            phase: 'arranging',
          })
        }
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
    modelId: modelSelectionSchema.optional(),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters/:chapterNumber/create-team',
    handler: async (request: any, reply: any) => {
      const { projectId, chapterNumber } = request.params as { projectId: string; chapterNumber: string }
      const input = validateBody(createTeamSchema, request, reply)
      if (!input) return reply

      const chapterNum = requireWritableChapter(projectId, chapterNumber)
      const chapter = store.getChapter(projectId, chapterNum)!
      const creationLockKey = `${projectId}:${chapterNumber}`
      if (chapterCreationLocks.has(creationLockKey) || aiArrangeLocks.has(creationLockKey) || activeNovelChapterTasks.has(creationLockKey)) {
        throw new AppError(ErrorCode.CONFLICT, '该章节正在创作中，请勿重复启动团队创作', 409)
      }

      services.orchestrator.setUserMessages(projectId, chapterNum, [
        input.narrativeTask,
        ...(input.rhythm ? [`节奏建议：${input.rhythm}`] : []),
      ])
      store.updateChapter(chapter.id, { narrativeTask: input.narrativeTask })
      const teamRunId = randomUUID()
      const task = registerNovelChapterTask(creationLockKey, 'workflow', teamRunId)
      chapterCreationLocks.add(creationLockKey)
      try {
        const result = await services.orchestrator.createChapterWithFlow(projectId, chapterNum, {
          emit: (() => {}) as any,
          onCheckpoint: async () => 'approve',
          onProgress: () => {},
          modelId: input.modelId,
          flowKey: `${projectId}|${chapterNum}|${teamRunId}`,
          signal: task.controller.signal,
        })
        return success(result, request.traceId)
      } finally {
        finishNovelChapterTask(creationLockKey, task)
        chapterCreationLocks.delete(creationLockKey)
      }
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
      const models = getAllNovelAgentModels(services.agentManager)
      const result = (Object.entries(temperatures) as Array<[NovelAgentType, number]>).map(([agentType, temperature]) => ({
        agentType,
        temperature,
        // P2-2：per-Agent 模型（null = 未配置，运行时回退项目主模型）
        model: models[agentType],
      }))
      return success(result, request.traceId)
    },
  })

  const updateAgentConfigSchema = z.object({
    items: z.array(z.object({
      agentType: z.enum(['director', 'writer', 'reviser', 'reviewer', 'memory']),
      temperature: z.number().min(0).max(2),
      // P2-2：可选模型覆盖（审稿异源：把 reviewer/reviser 切到与 writer 不同的模型档位）
      model: z.object({
        provider: z.string().min(1),
        modelId: z.string().min(1),
        thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']).nullable().optional(),
      }).nullable().optional(),
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
      for (const item of input.items) {
        if (item.model !== undefined) {
          updateNovelAgentModel(item.agentType, item.model, services.agentManager)
        }
      }
      const temperatures = getAllNovelAgentTemperatures(services.agentManager)
      const models = getAllNovelAgentModels(services.agentManager)
      const result = (Object.entries(temperatures) as Array<[NovelAgentType, number]>).map(([agentType, temperature]) => ({
        agentType,
        temperature,
        model: models[agentType],
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
      const chapterNum = requireChapter(projectId, chapterNumber)
      const messages = services.chapterChatStore.list(projectId, chapterNum)
      return success(messages, request.traceId)
    },
  })

  // DELETE /projects/:projectId/chapters/:chapterNumber/chat — 清空章节聊天历史
  routes.push({
    method: 'DELETE',
    path: '/projects/:projectId/chapters/:chapterNumber/chat',
    handler: async (request: any) => {
      const { projectId, chapterNumber } = request.params
      const chapterNum = requireChapter(projectId, chapterNumber)
      services.chapterChatStore.clear(projectId, chapterNum)
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
    /** per-call 模型覆盖（输入框旁选择器传入，本次回复临时切换模型） */
    modelId: z.object({
      provider: z.string(),
      modelId: z.string(),
      thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']).nullable().optional(),
    }).optional(),
    styleExpertIds: z.array(z.string().min(1).max(80)).max(8).optional(),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters/:chapterNumber/chat',
    handler: async (request: any, reply: any) => {
      const { projectId, chapterNumber } = request.params
      const input = validateBody(chatBodySchema, request, reply)
      if (!input) return reply

      // 必须在 SSE 响应头写出前校验，否则 404/400 会被伪装成 200 事件流。
      const chapterNum = requireChapter(projectId, chapterNumber)

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
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        persistRouteFailureAudit({
          request,
          projectId,
          chapterNumber: chapterNum,
          operation: 'chapter-chat',
          sourceSymbol: 'createCreationFlowRoutes > POST /projects/:projectId/chapters/:chapterNumber/chat',
          input,
          errorCode: 'chapter_chat_request_failed',
          error: err,
          durationMs: Date.now() - startedAt,
          phase: 'chat',
        })
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
      const chapterNum = requireChapter(projectId, chapterNumber)
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
