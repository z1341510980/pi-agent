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
import { RhythmController } from '../core/rhythm-controller.js'
import { diffChapterVersions } from '../core/chapter-version-diff.js'
import { canTransitionChapterStatus } from '@repo/shared/novel'

export function createChapterRoutes(services: NovelServices): RouteDefinition[] {
  const { store, engine } = services
  const routes: RouteDefinition[] = []

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
    volumeId: z.string().nullable().optional(),
    tension: z.number().int().min(1).max(10).nullable().optional(),
    positioning: z.enum(['high_pressure', 'advancement', 'cultivation', 'relationship', 'low_pressure', 'information']).nullable().optional(),
    timeOffset: z.number().int().nullable().optional(),
    chapterEndingHook: z.enum(['suspense', 'reversal', 'emotional', 'action', 'none']).nullable().optional(),
    recap: z.string().max(500).nullable().optional(),
  })

  routes.push({
    method: 'PATCH',
    path: '/chapters/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateChapterSchema, request, reply)
      if (!input) return reply
      const existing = store.getChapterById(request.params.id)
      if (!existing) throw new AppError(ErrorCode.NOT_FOUND, `章节不存在: ${request.params.id}`, 404)
      if (existing.status === 'published' && (input.content !== undefined || input.status !== undefined)) {
        throw new AppError(ErrorCode.CONFLICT, '已发布章节不能直接改正文或状态，请先进入修订流程', 409)
      }
      if (input.status !== undefined && !canTransitionChapterStatus(existing.status, input.status)) {
        throw new AppError(
          ErrorCode.CONFLICT,
          `章节状态不能从 ${existing.status} 变更为 ${input.status}`,
          409,
        )
      }
      if (input.volumeId) {
        const volume = store.getVolume(input.volumeId)
        if (!volume || volume.projectId !== existing.projectId) {
          throw new AppError(ErrorCode.BAD_REQUEST, '卷不存在或不属于该章节项目', 400)
        }
      }

      // 传 content 时自动重算 wordCount（与前端 chapter-live-view.tsx 的 countWords 一致），
      // 避免 spread patch 保留旧 wordCount 导致统计与正文不同步。
      let patch: Partial<NovelChapter> = input
      let versionSource: VersionSource = undefined
      if (input.content != null) {
        const cleaned = input.content.replace(/[#*`>\-\[\]()!]/g, '').replace(/\s+/g, '')
        patch = { ...input, wordCount: cleaned.length, status: 'drafting' }
        versionSource = { phase: 'manual_patch', trigger: '用户手动编辑' }
      }

      const updated = store.updateChapter(request.params.id, patch, versionSource)!

      // T04 决策 4：中间章重写 → 后续派生物标 stale，响应携带影响范围供前端提示重建
      let derivedState: Record<string, unknown> = { isMiddleRewrite: false }
      if (input.content != null) {
        const laterChapters = store.listChapters(updated.projectId)
          .filter((c) => c.chapterNumber > updated.chapterNumber && c.content?.trim().length)
        if (laterChapters.length > 0) {
          const staleMarked = store.markStaleFromChapter(updated.projectId, updated.id)
          derivedState = {
            isMiddleRewrite: true,
            staleMarked,
            affectedChapters: laterChapters.map((c) => c.chapterNumber),
            message: `检测到中间章节重写，后续 ${laterChapters.length} 章的推进记录已标记待重建；顺序重建功能尚未提供，请暂勿继续生成后续章节。`,
          }
        }
      }
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
        const rollbackResult: RollbackResult = {
          success: true,
          savedVersionId: result.savedVersionId,
          currentContent: result.currentContent,
          currentWordCount: result.currentWordCount,
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
      return success(result, request.traceId)
    },
  })

  return routes
}
