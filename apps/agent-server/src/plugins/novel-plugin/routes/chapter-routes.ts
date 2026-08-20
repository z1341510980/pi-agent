/**
 * 章节相关路由
 *
 * 拆分自原 novel-routes.ts（PR-6），包含：
 * - 章节 CRUD（POST/GET/PATCH /projects/:projectId/chapters, /chapters/:id）
 * - 章节完成 / 发布（POST /chapters/:id/complete, /chapters/:id/publish）
 * - 章节版本历史（GET/POST /chapters/:id/versions, /versions/diff, /versions/:versionId/rollback）
 * - 节奏控制（GET /rhythm-models, /projects/:projectId/rhythm-suggestion）
 */

import { z } from 'zod'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import type { NovelChapter, ChapterVersion, ChapterVersionSummary, ChapterVersionDiff, RollbackResult, VersionSource } from '../core/types.js'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { RhythmController } from '../core/chapters/rhythm-controller.js'
import { diffChapterVersions } from '../core/chapters/chapter-version-diff.js'
import { canTransitionChapterStatus } from '@repo/shared/novel'
import { hashChapterOutline } from '../core/chapters/chapter-outline.js'
import { closeSse, sendSseComment, sendSseEvent, setupSse } from '../../../lib/sse.js'
import { modelSelectionSchema } from './model-selection-contract.js'
import { parseNovelModelRef } from '../core/domain/novel-model-ref.js'
import type { TimelineStaleCounts } from '../core/analysis/timeline-consistency-store.js'

function buildDerivedState(store: NovelServices['store'], projectId: string, contentChanged: boolean): {
  isMiddleRewrite: boolean
  invalidationId?: string
  startChapterNumber?: number
  staleMarked?: number
  staleCounts?: TimelineStaleCounts
  affectedChapters?: number[]
  rebuildAvailable?: boolean
  rebuildBlockedReasons?: string[]
  message?: string
} {
  if (!contentChanged) return { isMiddleRewrite: false }
  const invalidation = store.getActiveTimelineInvalidation(projectId)
  if (!invalidation) return { isMiddleRewrite: false }
  const preview = store.getTimelineRebuildPreview(projectId)
  return {
    isMiddleRewrite: true,
    invalidationId: invalidation.id,
    startChapterNumber: invalidation.startChapterNumber,
    staleMarked: Object.values(invalidation.staleCounts).reduce((sum, count) => sum + count, 0),
    staleCounts: invalidation.staleCounts,
    affectedChapters: invalidation.affectedChapters,
    rebuildAvailable: preview?.automaticRebuildAvailable ?? false,
    rebuildBlockedReasons: preview?.blockedReasons ?? [],
    message: `第 ${invalidation.startChapterNumber} 章起的派生状态已失效，请先查看影响范围再决定是否重建。`,
  }
}

export function createChapterRoutes(services: NovelServices): RouteDefinition[] {
  const { store, engine } = services
  const routes: RouteDefinition[] = []

  /** 触发隔离重放执行器（fire-and-forget）；失败只记日志，job 状态由 store 落库。 */
  const kickRebuildRunner = (projectId: string, jobId: string): void => {
    void services.timelineRebuildRunner.run(projectId, jobId).catch(error => {
      services.context.logger.error(
        { err: error, projectId, jobId },
        '时间线隔离重放执行器异常退出（可通过 resume 重新触发）',
      )
    })
  }

  // ═══════════════════════════════════════════════════════════════
  // 章节管理
  // ═══════════════════════════════════════════════════════════════

  const createChapterSchema = z.object({
    chapterNumber: z.number().int().min(1),
    narrativeTask: z.object({
      description: z.string().min(1),
      type: z.string(),
      targetEntity: z.string().nullable().optional(),
      priority: z.enum(['high', 'medium', 'low']).default('medium'),
      positioning: z.enum(['high_pressure', 'advancement', 'cultivation', 'relationship', 'low_pressure', 'information']).nullable().optional(),
    }),
    // 可选卷归属：传入则新建章节直接挂在该卷下，避免章节游离在所有卷之外
    volumeId: z.string().nullable().optional(),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createChapterSchema, request, reply)
      if (!input) return reply
      if (input.volumeId) {
        const volume = store.getVolume(input.volumeId)
        if (!volume || volume.projectId !== request.params.projectId) {
          throw new AppError(ErrorCode.BAD_REQUEST, '卷不存在或不属于当前项目', 400)
        }
      }

      const result = await engine.createChapter(
        request.params.projectId,
        input.chapterNumber,
        input.narrativeTask as any,
        input.volumeId ?? undefined,
      )
      return success(result, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/chapters',
    handler: async (request: any) => {
      return success(store.listChapters(request.params.projectId), request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/chapters/:id',
    handler: async (request: any) => {
      const chapter = store.getChapterById(request.params.id)
      if (!chapter) throw new AppError(ErrorCode.NOT_FOUND, `章节不存在: ${request.params.id}`, 404)
      return success(chapter, request.traceId)
    },
  })

  const updateChapterSchema = z.object({
    title: z.string().optional(),
    content: z.string().optional(),
    // published 只能通过 /publish 命令进入，确保正文与审稿前置条件被校验。
    status: z.enum(['planned', 'drafting', 'review', 'rejected']).optional(),
    outline: z.string().max(20000).optional(),
    rhythm: z.enum(['setup', 'rising', 'climax', 'falling', 'resolution', 'twist', 'breather', 'suspense']).optional(),
    volumeId: z.string().nullable().optional(),
    tension: z.number().int().min(1).max(10).nullable().optional(),
    positioning: z.enum(['high_pressure', 'advancement', 'cultivation', 'relationship', 'low_pressure', 'information']).nullable().optional(),
    timeOffset: z.number().int().nullable().optional(),
    chapterEndingHook: z.enum(['suspense', 'reversal', 'emotional', 'action', 'none']).nullable().optional(),
    recap: z.string().max(500).nullable().optional(),
    /** AI 章纲草稿采用时的乐观锁控制字段，不会写入 novel_chapters。 */
    expectedOutlineHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    expectedContentRevisionId: z.string().nullable().optional(),
    outlineGenerationId: z.string().uuid().optional(),
  })

  routes.push({
    method: 'PATCH',
    path: '/chapters/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateChapterSchema, request, reply)
      if (!input) return reply
      const existing = store.getChapterById(request.params.id)
      if (!existing) throw new AppError(ErrorCode.NOT_FOUND, `章节不存在: ${request.params.id}`, 404)
      const {
        expectedOutlineHash,
        expectedContentRevisionId,
        outlineGenerationId,
        ...chapterInput
      } = input
      const outlineControlFieldCount = [
        expectedOutlineHash,
        expectedContentRevisionId,
        outlineGenerationId,
      ].filter((value) => value !== undefined).length
      if (outlineControlFieldCount > 0
        && chapterInput.outline === undefined) {
        throw new AppError(ErrorCode.BAD_REQUEST, '章纲版本校验字段只能与 outline 一起提交', 400)
      }
      if (outlineControlFieldCount > 0 && outlineControlFieldCount < 3) {
        throw new AppError(
          ErrorCode.BAD_REQUEST,
          '采用 AI 章纲时必须同时提交章纲 hash、正文 revision 和生成记录 ID',
          400,
        )
      }
      if (expectedOutlineHash !== undefined
        && expectedOutlineHash !== hashChapterOutline(existing.outline)) {
        throw new AppError(ErrorCode.CONFLICT, '章纲已经发生变化，AI 草稿未覆盖当前内容', 409)
      }
      if (expectedContentRevisionId !== undefined) {
        const currentContentRevisionId = store.getCurrentContentRevision(existing.id)?.id ?? null
        if (currentContentRevisionId !== expectedContentRevisionId) {
          throw new AppError(ErrorCode.CONFLICT, '章节正文版本已经变化，请重新生成章纲', 409)
        }
      }
      if (existing.status === 'published' && (
        chapterInput.content !== undefined
        || chapterInput.status !== undefined
        || (chapterInput.outline !== undefined && chapterInput.outline !== (existing.outline ?? ''))
      )) {
        throw new AppError(ErrorCode.CONFLICT, '已发布章节不能直接改正文、状态或章纲，请先进入修订流程', 409)
      }
      if (chapterInput.status !== undefined && !canTransitionChapterStatus(existing.status, chapterInput.status)) {
        throw new AppError(
          ErrorCode.CONFLICT,
          `章节状态不能从 ${existing.status} 变更为 ${chapterInput.status}`,
          409,
        )
      }
      if (chapterInput.volumeId) {
        const volume = store.getVolume(chapterInput.volumeId)
        if (!volume || volume.projectId !== existing.projectId) {
          throw new AppError(ErrorCode.BAD_REQUEST, '卷不存在或不属于该章节项目', 400)
        }
      }

      // 传 content 时自动重算 wordCount（与前端 chapter-live-view.tsx 的 countWords 一致），
      // 避免 spread patch 保留旧 wordCount 导致统计与正文不同步。
      let patch: Partial<NovelChapter> = chapterInput
      let versionSource: VersionSource = undefined
      if (chapterInput.content != null) {
      const cleaned = chapterInput.content.replace(/[#*`>\-()[\]!]/g, '').replace(/\s+/g, '')
        patch = { ...chapterInput, wordCount: cleaned.length, status: 'drafting' }
        versionSource = { phase: 'manual_patch', trigger: '用户手动编辑' }
      }

      const updated = store.updateChapter(request.params.id, patch, versionSource)!

      // 记录观测日志（时间线数据）
      if (chapterInput.content != null && chapterInput.content !== existing.content) {
        try {
          const logEntry = {
            agentId: 'novel-editor',
            agentName: '编辑器',
            threadId: request.traceId ?? '',
            systemPrompt: '(用户手动编辑章节)',
            userMessage: `手动保存第 ${existing.chapterNumber} 章正文。`,
            taskInput: chapterInput.content,
            tools: '[]',
            toolNames: '[]',
            result: '手动保存章节内容',
            resultLength: chapterInput.content.length,
            durationMs: 0,
            status: 'success' as const,
            error: '',
            metadata: JSON.stringify({
              projectId: existing.projectId,
              chapterNumber: existing.chapterNumber,
              agentType: 'editor',
              phase: 'manual_save',
              source: 'chapter-routes',
              action: 'manual_patch',
            }),
          }
          if (services.context.agentCallLogger) {
            services.context.agentCallLogger.record(logEntry)
          }
        } catch (logErr) {
          services.context.logger.warn({ err: logErr }, '记录章节保存日志失败')
        }
      }

      if (outlineGenerationId && chapterInput.outline !== existing.outline) {
        services.context.logger.info(
          { projectId: existing.projectId, chapterNumber: existing.chapterNumber, outlineGenerationId },
          '用户采用并保存 AI 章纲草稿',
        )
      }

      const derivedState = buildDerivedState(
        store,
        updated.projectId,
        chapterInput.content != null && chapterInput.content !== existing.content,
      )
      return success({ ...updated, derivedState }, request.traceId)
    },
  })

  const completeChapterSchema = z.object({
    content: z.string().min(1),
    title: z.string().optional(),
  })

  routes.push({
    method: 'POST',
    path: '/chapters/:id/complete',
    handler: async (request: any, reply: any) => {
      const input = validateBody(completeChapterSchema, request, reply)
      if (!input) return reply

      const chapter = await engine.completeChapter(request.params.id, input.content, input.title)
      return success(chapter, request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/chapters/:id/publish',
    handler: async (request: any) => {
      const chapter = await engine.publishChapter(request.params.id)
      return success(chapter, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 章节正文版本历史
  // ═══════════════════════════════════════════════════════════════

  // GET /chapters/:id/versions — 列出章节所有版本摘要（按 sequence 倒序，不含 content 全文）
  routes.push({
    method: 'GET',
    path: '/chapters/:id/versions',
    handler: async (request: any) => {
      const chapter = store.getChapterById(request.params.id)
      if (!chapter) throw new AppError(ErrorCode.NOT_FOUND, `章节不存在: ${request.params.id}`, 404)
      const versions: ChapterVersionSummary[] = store.listChapterVersions(request.params.id)
      return success(versions, request.traceId)
    },
  })

  // GET /chapters/:id/versions/diff — 两个版本的段落级 diff
  // ⚠️ 必须在 /chapters/:id/versions/:versionId 之前注册，否则 'diff' 会被当成 versionId
  routes.push({
    method: 'GET',
    path: '/chapters/:id/versions/diff',
    handler: async (request: any) => {
      const { from, to } = request.query ?? {}
      if (!from || !to) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, '缺少 from 或 to 查询参数', 400)
      }
      const fromVersion = store.getChapterVersion(from)
      if (!fromVersion) throw new AppError(ErrorCode.NOT_FOUND, `版本不存在: ${from}`, 404)
      if (fromVersion.chapterId !== request.params.id) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'from 版本不属于该章节', 400)
      }
      const toVersion = store.getChapterVersion(to)
      if (!toVersion) throw new AppError(ErrorCode.NOT_FOUND, `版本不存在: ${to}`, 404)
      if (toVersion.chapterId !== request.params.id) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'to 版本不属于该章节', 400)
      }

      const diffResult = diffChapterVersions(fromVersion.content, toVersion.content)
      const result: ChapterVersionDiff = {
        fromVersionId: from,
        toVersionId: to,
        fromSequence: fromVersion.sequence,
        toSequence: toVersion.sequence,
        segments: diffResult.segments,
        stats: diffResult.stats,
      }
      return success(result, request.traceId)
    },
  })

  // GET /chapters/:id/versions/:versionId — 获取特定版本详情（含全文）
  routes.push({
    method: 'GET',
    path: '/chapters/:id/versions/:versionId',
    handler: async (request: any) => {
      const version: ChapterVersion | undefined = store.getChapterVersion(request.params.versionId)
      if (!version) throw new AppError(ErrorCode.NOT_FOUND, `版本不存在: ${request.params.versionId}`, 404)
      if (version.chapterId !== request.params.id) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, '版本不属于该章节', 400)
      }
      return success(version, request.traceId)
    },
  })

  // POST /chapters/:id/versions/:versionId/rollback — 安全回滚到指定版本
  routes.push({
    method: 'POST',
    path: '/chapters/:id/versions/:versionId/rollback',
    handler: async (request: any) => {
      const chapter = store.getChapterById(request.params.id)
      if (!chapter) throw new AppError(ErrorCode.NOT_FOUND, `章节不存在: ${request.params.id}`, 404)
      if (chapter.status === 'published') {
        throw new AppError(ErrorCode.CONFLICT, '已发布章节不能回滚正文，请先进入修订流程', 409)
      }
      try {
        const result = store.rollbackToVersion(request.params.id, request.params.versionId)
        const rollbackResult: RollbackResult & { derivedState?: ReturnType<typeof buildDerivedState> } = {
          success: true,
          savedVersionId: result.savedVersionId,
          currentContent: result.currentContent,
          currentWordCount: result.currentWordCount,
          derivedState: buildDerivedState(store, chapter.projectId, true),
        }
        return success(rollbackResult, request.traceId)
      } catch (err: any) {
        const msg = err?.message ?? ''
        if (msg.includes('不存在')) {
          throw new AppError(ErrorCode.NOT_FOUND, msg, 404)
        }
        if (msg.includes('不属于') || msg.includes('无需回滚')) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, msg, 400)
        }
        throw err
      }
    },
  })

  // POST /chapters/:id/versions — 手动创建快照
  const createSnapshotSchema = z.object({
    trigger: z.string().max(200).optional(),
  })

  routes.push({
    method: 'POST',
    path: '/chapters/:id/versions',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createSnapshotSchema, request, reply)
      if (!input) return reply

      const chapter = store.getChapterById(request.params.id)
      if (!chapter) throw new AppError(ErrorCode.NOT_FOUND, `章节不存在: ${request.params.id}`, 404)

      const version = store.createVersionSnapshot(request.params.id, {
        phase: 'manual_snapshot',
        trigger: input.trigger ?? '用户手动创建快照',
      })
      if (!version) {
        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, '创建快照失败', 500)
      }
      return success(version, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 节奏控制
  // ═══════════════════════════════════════════════════════════════

  // 列出所有可用节奏模型
  routes.push({
    method: 'GET',
    path: '/rhythm-models',
    handler: async (request: any) => {
      return success(RhythmController.MODELS, request.traceId)
    },
  })

  // 获取下一章节奏建议（query: ?chapterNumber=N）
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/rhythm-suggestion',
    handler: async (request: any) => {
      const { projectId } = request.params as { projectId: string }
      const { chapterNumber } = request.query as { chapterNumber?: string }

      const project = store.getProject(projectId)
      if (!project) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在', 404)

      const chapterNum = chapterNumber != null ? parseInt(chapterNumber, 10) : (project.currentChapter + 1)
      if (Number.isNaN(chapterNum) || chapterNum < 1) {
        throw new AppError(ErrorCode.BAD_REQUEST, `无效的 chapterNumber: ${chapterNumber}`, 400)
      }

      const controller = new RhythmController()
      const model = RhythmController.MODELS.find(m => m.id === project.rhythmModelId) ?? RhythmController.DEFAULT_MODEL

      // 从历史章节构建节奏历史
      const chapters = store.listChapters(projectId)
      const history = chapters
        .filter(c => c.rhythm)
        .map(c => ({
          chapterNumber: c.chapterNumber,
          rhythm: c.rhythm!,
          effectiveness: 'medium' as const,
        }))

      const suggestion = controller.suggestRhythm(
        chapterNum,
        project.currentStage,
        history,
        model,
      )
      return success(suggestion, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 不可变正文版本链（V2 content revision，T04）
  // ═══════════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/chapters/:id/content-revisions',
    handler: async (request: any) => {
      const chapter = store.getChapterById(request.params.id)
      if (!chapter) throw new AppError(ErrorCode.NOT_FOUND, `章节不存在: ${request.params.id}`, 404)
      return success(store.listContentRevisions(request.params.id), request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/chapters/:id/content-revisions/:revisionId/rollback',
    handler: async (request: any) => {
      const chapter = store.getChapterById(request.params.id)
      if (!chapter) throw new AppError(ErrorCode.NOT_FOUND, `章节不存在: ${request.params.id}`, 404)
      if (chapter.status === 'published') {
        throw new AppError(ErrorCode.CONFLICT, '已发布章节不能回滚正文，请先进入修订流程', 409)
      }
      const result = store.rollbackToContentRevision(request.params.id, request.params.revisionId)
      return success({
        ...result,
        derivedState: buildDerivedState(store, chapter.projectId, true),
      }, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/timeline-rebuild/preview',
    handler: async (request: any) => {
      const project = store.getProject(request.params.projectId)
      if (!project) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在', 404)
      const preview = store.getTimelineRebuildPreview(project.id)
      if (!preview) throw new AppError(ErrorCode.NOT_FOUND, '项目当前没有待重建的时间线', 404)
      const latestJob = store.getLatestTimelineRebuildJob(project.id, preview.id)
      return success({
        ...preview,
        latestJob: latestJob ?? null,
      }, request.traceId)
    },
  })

  const startTimelineRebuildSchema = z.object({
    confirmationToken: z.string().length(64),
    confirmed: z.literal(true),
    modelId: modelSelectionSchema.optional(),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/timeline-rebuild/start',
    handler: async (request: any, reply: any) => {
      const input = validateBody(startTimelineRebuildSchema, request, reply)
      if (!input) return reply
      const project = store.getProject(request.params.projectId)
      if (!project) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在', 404)
      const preview = store.verifyTimelineRebuildConfirmation(project.id, input.confirmationToken)
      if (!preview) {
        throw new AppError(ErrorCode.CONFLICT, '影响范围已变化，请重新查看重建预览后确认', 409)
      }
      if (!preview.automaticRebuildAvailable) {
        throw new AppError(
          ErrorCode.CONFLICT,
          preview.blockedReasons.join('；') || '当前项目不满足安全自动重建条件',
          409,
        )
      }
      // 任务创建时冻结模型：本次显式选择优先，其次使用项目级创作主模型。
      // 不把模型留到 runner 运行时再解析，避免用户改配置后恢复任务换模型。
      const modelId = input.modelId ?? parseNovelModelRef(project.novelModelId)
      const job = store.createTimelineRebuildJob(project.id, input.confirmationToken, modelId)
      kickRebuildRunner(project.id, job.id)
      return success({ ...job, eventsUrl: `/projects/${project.id}/timeline-rebuild/jobs/${job.id}/events` }, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/timeline-rebuild/jobs/:jobId',
    handler: async (request: any) => {
      const job = store.getTimelineRebuildJob(request.params.projectId, request.params.jobId)
      if (!job) throw new AppError(ErrorCode.NOT_FOUND, '重建任务不存在', 404)
      return success({
        ...job,
        replayRunning: services.timelineRebuildRunner.isRunning(job.id),
        checkpoint: store.getTimelineRebuildCheckpoint(request.params.projectId, job.id),
      }, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/timeline-rebuild/jobs/:jobId/events',
    handler: async (request: any, reply: any) => {
      const job = store.getTimelineRebuildJob(request.params.projectId, request.params.jobId)
      if (!job) throw new AppError(ErrorCode.NOT_FOUND, '重建任务不存在', 404)
      const header = request.headers['last-event-id']
      const afterSequence = typeof header === 'string' && /^\d+$/.test(header) ? Number(header) : 0
      const events = store.listTimelineRebuildEvents(request.params.projectId, request.params.jobId, afterSequence)
      setupSse(reply)
      for (const event of events) {
        reply.raw.write(`id: ${event.sequence}\n`)
        sendSseEvent(reply, { rebuildEvent: event })
      }
      sendSseComment(reply, 'end-of-buffer')
      closeSse(reply)
      return reply
    },
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/timeline-rebuild/jobs/:jobId/cancel',
    handler: async (request: any) => {
      try {
        services.timelineRebuildRunner.requestCancel(request.params.jobId)
        return success(store.cancelTimelineRebuildJob(request.params.projectId, request.params.jobId), request.traceId)
      } catch (error) {
        throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : '无法取消重建任务', 409)
      }
    },
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/timeline-rebuild/jobs/:jobId/resume',
    handler: async (request: any) => {
      try {
        const job = store.resumeTimelineRebuildJob(request.params.projectId, request.params.jobId)
        kickRebuildRunner(request.params.projectId, job.id)
        return success({
          ...job,
          eventsUrl: `/projects/${request.params.projectId}/timeline-rebuild/jobs/${job.id}/events`,
          checkpoint: store.getTimelineRebuildCheckpoint(request.params.projectId, job.id),
        }, request.traceId)
      } catch (error) {
        throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : '无法恢复重建任务', 409)
      }
    },
  })

  const applyTimelineStepSchema = z.object({
    expectedContentRevision: z.string().uuid(),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/timeline-rebuild/jobs/:jobId/chapters/:chapterId/ready',
    handler: async (request: any, reply: any) => {
      const input = validateBody(applyTimelineStepSchema, request, reply)
      if (!input) return reply
      try {
        return success(store.markTimelineRebuildStepReady(
          request.params.projectId, request.params.jobId, request.params.chapterId, input.expectedContentRevision,
        ), request.traceId)
      } catch (error) {
        throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : '无法准备章节重建结果', 409)
      }
    },
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/timeline-rebuild/jobs/:jobId/chapters/:chapterId/apply',
    handler: async (request: any, reply: any) => {
      const input = validateBody(applyTimelineStepSchema, request, reply)
      if (!input) return reply
      try {
        return success(store.applyTimelineRebuildStep(
          request.params.projectId, request.params.jobId, request.params.chapterId, input.expectedContentRevision,
        ), request.traceId)
      } catch (error) {
        throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : '无法应用章节重建结果', 409)
      }
    },
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/timeline-rebuild/jobs/:jobId/complete',
    handler: async (request: any) => {
      try {
        return success(store.completeTimelineRebuildJob(request.params.projectId, request.params.jobId), request.traceId)
      } catch (error) {
        throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : '无法完成重建任务', 409)
      }
    },
  })

  return routes
}
