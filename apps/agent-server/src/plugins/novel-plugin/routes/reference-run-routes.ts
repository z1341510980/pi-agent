/**
 * P4/P5 路由：远端分析 run 与参考档案审核（方案 §8）。
 *
 * P4：启动（费用确认 + estimateHash 校验）、详情、observations、SSE 事件重放、
 *     取消（保留 checkpoint）、重试（新 attempt）、恢复（同 run 续跑）。
 * P5：档案详情、findings 列表（分类计数）、证据偏移（原文删除返回 410）、
 *     单项/批量审核、安全报告、版本列表、版本比较。
 */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { closeSse, sendSseComment, sendSseEvent, setupSse } from '../../../lib/sse.js'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'

/** 在分段文本中定位证据引用（找不到返回 null，不猜测位置） */
function findQuoteInSection(sectionTexts: Record<string, string>, quote: string): { sectionId: string; start: number; end: number } | null {
  for (const [sectionId, text] of Object.entries(sectionTexts)) {
    const start = text.indexOf(quote)
    if (start >= 0) return { sectionId, start, end: start + quote.length }
  }
  return null
}

function hashShort(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

const startRunSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  includedSectionIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  estimateHash: z.string().length(64),
  highCostConfirmed: z.boolean(),
  semanticCoveragePolicy: z.record(z.string(), z.unknown()).optional(),
})

const cancelSchema = z.object({ reason: z.string().max(1000).optional().default('') })
const retrySchema = z.object({
  fromCheckpoint: z.boolean().optional().default(true),
  failedChunkIds: z.array(z.string().min(1)).optional().default([]),
  highCostConfirmed: z.boolean(),
})
const resumeSchema = z.object({
  checkpointId: z.string().max(200).optional(),
  highCostConfirmed: z.boolean(),
})

const reviewSchema = z.object({
  decision: z.enum(['accepted', 'rejected', 'edited']),
  editedObservation: z.string().max(2000).optional(),
  editedRule: z.string().max(2000).optional(),
  strength: z.enum(['hard', 'soft', 'reference']).optional(),
  promptEnabled: z.boolean().optional(),
  agentTargets: z.array(z.enum(['Director', 'Writer', 'Reviser', 'Reviewer'])).max(4).optional(),
  chapterScope: z.array(z.string().max(50)).max(50).optional(),
  note: z.string().max(1000).optional(),
  reviewer: z.string().max(100).optional(),
})

const batchReviewSchema = z.object({
  reviews: z.array(reviewSchema.extend({ findingKey: z.string().min(1).max(100) })).min(1).max(200),
  version: z.number().int().positive(),
  note: z.string().max(500).optional(),
})

export function createReferenceRunRoutes(services: NovelServices): RouteDefinition[] {
  const reference = services.referenceAnalysis
  if (!reference) return []
  const runStore = services.referenceAnalysisRuns
  const worker = services.referenceAnalysisWorker
  const profileStore = services.referenceProfiles

  const kick = (runId: string): void => {
    void worker.run(runId).catch((error: unknown) => {
      services.context.logger.error({ err: error, runId }, '参考分析执行器异常退出（可 retry/resume 重新触发）')
    })
  }

  const requireRun = (runId: string) => {
    const run = runStore.getRun(runId)
    if (!run) throw new AppError(ErrorCode.NOT_FOUND, '分析任务不存在', 404)
    return run
  }

  return [
    // ── P4 ──
    {
      method: 'POST',
      path: '/reference-sources/:sourceId/analysis-runs',
      handler: async (request: any, reply: any) => {
        const input = validateBody(startRunSchema, request, reply)
        if (!input) return reply
        const provider = request.server.providerConfigStore?.get(input.providerId)
        const model = provider?.models.find((candidate: any) => candidate.id === input.modelId)
        if (!provider || !model) throw new AppError(ErrorCode.BAD_REQUEST, '所选 provider 或模型不存在', 400)
        const sections = reference.listSections(request.params.sourceId)
        const effectiveSectionIds = input.includedSectionIds
          ?? sections.filter((section) => section.included).map((section) => section.id)
        if (effectiveSectionIds.length === 0) {
          throw new AppError(ErrorCode.BAD_REQUEST, '分析范围内没有可用的参考章节', 400)
        }
        const estimate = reference.estimateBudget(request.params.sourceId, {
          providerId: input.providerId, modelId: input.modelId, model,
          selectedSectionIds: effectiveSectionIds,
        })
        if (estimate.estimateHash !== input.estimateHash) {
          throw new AppError(ErrorCode.CONFLICT, '费用估算已变化，请重新获取估算后确认', 409)
        }
        if (!estimate.withinLimit) {
          throw new AppError(ErrorCode.CONFLICT, '输入超出模型有效上下文上限，不能启动分析', 409)
        }
        const needsConfirm = Boolean(estimate.estimatedCost && estimate.estimatedCost.max > 0)
        if (needsConfirm && !input.highCostConfirmed) {
          throw new AppError(ErrorCode.CONFLICT, '预计产生费用，需先确认 highCostConfirmed', 409)
        }
        const active = runStore.listRuns(request.params.sourceId).find((run: { status: string }) => ['queued', 'running'].includes(run.status))
        if (active && worker.isRunning(active.id)) {
          throw new AppError(ErrorCode.CONFLICT, '该参考源已有进行中的分析任务', 409)
        }
        const run = runStore.createRun({
          sourceId: request.params.sourceId,
          providerId: input.providerId,
          modelId: input.modelId,
          includedSectionIds: effectiveSectionIds,
          estimateSnapshot: estimate as unknown as Record<string, unknown>,
          highCostConfirmed: input.highCostConfirmed,
          semanticCoveragePolicy: input.semanticCoveragePolicy,
        })
        kick(run.id)
        return success({ ...run, eventsUrl: `/reference-analysis-runs/${run.id}/events` }, request.traceId)
      },
    },
    {
      method: 'GET',
      path: '/reference-analysis-runs/:runId',
      handler: async (request: any) => {
        const run = requireRun(request.params.runId)
        return success({ ...run, workerRunning: worker.isRunning(run.id) }, request.traceId)
      },
    },
    {
      method: 'GET',
      path: '/reference-analysis-runs/:runId/observations',
      handler: async (request: any) => {
        requireRun(request.params.runId)
        const query = (request.query ?? {}) as Record<string, string | undefined>
        const cursor = Math.max(0, Number.parseInt(query.cursor ?? '0', 10) || 0)
        const limit = Math.min(200, Math.max(1, Number.parseInt(query.limit ?? '100', 10) || 100))
        const all = runStore.listObservations(request.params.runId, query.level, query.metric)
        const page = all.slice(cursor, cursor + limit)
        return success({
          observations: page,
          nextCursor: cursor + page.length < all.length ? cursor + page.length : null,
          total: all.length,
        }, request.traceId)
      },
    },
    {
      method: 'GET',
      path: '/reference-analysis-runs/:runId/events',
      handler: async (request: any, reply: any) => {
        requireRun(request.params.runId)
        const header = request.headers['last-event-id']
        const afterSequence = typeof header === 'string' && /^\d+$/.test(header) ? Number(header) : 0
        const events = runStore.listEvents(request.params.runId, afterSequence)
        setupSse(reply)
        for (const event of events) {
          reply.raw.write(`id: ${event.sequence}\n`)
          sendSseEvent(reply, { referenceRunEvent: event })
        }
        sendSseComment(reply, 'end-of-buffer')
        closeSse(reply)
        return reply
      },
    },
    {
      method: 'POST',
      path: '/reference-analysis-runs/:runId/cancel',
      handler: async (request: any, reply: any) => {
        const input = validateBody(cancelSchema, request, reply)
        if (!input) return reply
        const run = requireRun(request.params.runId)
        worker.requestCancel(run.id)
        return success(runStore.cancel(run.id, input.reason || '用户取消'), request.traceId)
      },
    },
    {
      method: 'POST',
      path: '/reference-analysis-runs/:runId/retry',
      handler: async (request: any, reply: any) => {
        const input = validateBody(retrySchema, request, reply)
        if (!input) return reply
        const run = requireRun(request.params.runId)
        if (!['failed', 'cancelled'].includes(run.status)) {
          throw new AppError(ErrorCode.CONFLICT, '只有失败或已取消的任务可以重试', 409)
        }
        const estimateCostMax = Number((run.estimateSnapshot as { estimatedCost?: { max?: number } })?.estimatedCost?.max ?? 0)
        if (estimateCostMax > 0 && !input.highCostConfirmed) {
          throw new AppError(ErrorCode.CONFLICT, '重试将再次产生费用，需先确认 highCostConfirmed', 409)
        }
        const next = runStore.createRun({
          sourceId: run.sourceId,
          providerId: run.providerId ?? 'unknown',
          modelId: run.modelId ?? 'unknown',
          includedSectionIds: run.includedSectionIds,
          estimateSnapshot: run.estimateSnapshot,
          highCostConfirmed: input.highCostConfirmed,
          semanticCoveragePolicy: run.semanticCoveragePolicy,
          parentAttemptId: run.id,
          attempt: run.attempt + 1,
        })
        if (input.fromCheckpoint && run.checkpoint) {
          runStore.setCheckpoint(next.id, run.checkpoint, run.actualUsage)
        }
        kick(next.id)
        return success({ ...runStore.getRun(next.id)!, eventsUrl: `/reference-analysis-runs/${next.id}/events` }, request.traceId)
      },
    },
    {
      method: 'POST',
      path: '/reference-analysis-runs/:runId/resume',
      handler: async (request: any, reply: any) => {
        const input = validateBody(resumeSchema, request, reply)
        if (!input) return reply
        const run = requireRun(request.params.runId)
        if (!['failed', 'cancelled'].includes(run.status)) {
          throw new AppError(ErrorCode.CONFLICT, '只有失败或已取消的任务可以恢复', 409)
        }
        const estimateCostMax = Number((run.estimateSnapshot as { estimatedCost?: { max?: number } })?.estimatedCost?.max ?? 0)
        if (estimateCostMax > 0 && !input.highCostConfirmed) {
          throw new AppError(ErrorCode.CONFLICT, '恢复将继续产生费用，需先确认 highCostConfirmed', 409)
        }
        const resumed = runStore.createRun({
          sourceId: run.sourceId,
          providerId: run.providerId ?? 'unknown',
          modelId: run.modelId ?? 'unknown',
          includedSectionIds: run.includedSectionIds,
          estimateSnapshot: run.estimateSnapshot,
          highCostConfirmed: input.highCostConfirmed,
          semanticCoveragePolicy: run.semanticCoveragePolicy,
          parentAttemptId: run.id,
          attempt: run.attempt + 1,
        })
        // 恢复必须复用原 checkpoint（已完成 chunk 不重复计费）
        if (run.checkpoint) runStore.setCheckpoint(resumed.id, run.checkpoint, run.actualUsage)
        kick(resumed.id)
        return success({ ...runStore.getRun(resumed.id)!, eventsUrl: `/reference-analysis-runs/${resumed.id}/events` }, request.traceId)
      },
    },

    // ── P5 ──
    {
      method: 'GET',
      path: '/reference-profiles/:profileId',
      handler: async (request: any) => {
        const profile = profileStore.getProfile(request.params.profileId)
        if (!profile) throw new AppError(ErrorCode.NOT_FOUND, '参考档案不存在', 404)
        return success(profile, request.traceId)
      },
    },
    {
      method: 'GET',
      path: '/reference-profiles/:profileId/findings',
      handler: async (request: any) => {
        const profile = profileStore.getProfile(request.params.profileId)
        if (!profile) throw new AppError(ErrorCode.NOT_FOUND, '参考档案不存在', 404)
        const query = (request.query ?? {}) as Record<string, string | undefined>
        const cursor = Math.max(0, Number.parseInt(query.cursor ?? '0', 10) || 0)
        const limit = Math.min(200, Math.max(1, Number.parseInt(query.limit ?? '100', 10) || 100))
        let filtered = profile.findings
        if (query.category && ['spirit', 'technique', 'power', 'pacing'].includes(query.category)) {
          filtered = filtered.filter((finding) => finding.category === query.category)
        }
        if (query.decision && ['accepted', 'rejected', 'edited', 'pending'].includes(query.decision)) {
          filtered = filtered.filter((finding) => (query.decision === 'pending' ? !finding.review : finding.review?.decision === query.decision))
        }
        if (query.strength && ['hard', 'soft', 'reference'].includes(query.strength)) {
          filtered = filtered.filter((finding) => finding.strength === query.strength)
        }
        if (query.agent) {
          filtered = filtered.filter((finding) => finding.agentTargets.includes(query.agent as never))
        }
        const counts = {
          total: profile.findings.length,
          pending: profile.findings.filter((finding) => !finding.review).length,
          accepted: profile.findings.filter((finding) => finding.review?.decision === 'accepted').length,
          rejected: profile.findings.filter((finding) => finding.review?.decision === 'rejected').length,
          edited: profile.findings.filter((finding) => finding.review?.decision === 'edited').length,
          byCategory: {
            spirit: profile.findings.filter((finding) => finding.category === 'spirit').length,
            technique: profile.findings.filter((finding) => finding.category === 'technique').length,
            power: profile.findings.filter((finding) => finding.category === 'power').length,
            pacing: profile.findings.filter((finding) => finding.category === 'pacing').length,
          },
        }
        const page = filtered.slice(cursor, cursor + limit)
        return success({
          findings: page,
          counts,
          nextCursor: cursor + page.length < filtered.length ? cursor + page.length : null,
        }, request.traceId)
      },
    },
    {
      method: 'GET',
      path: '/reference-profiles/:profileId/findings/:findingKey/evidence',
      handler: async (request: any) => {
        const profile = profileStore.getProfile(request.params.profileId)
        if (!profile) throw new AppError(ErrorCode.NOT_FOUND, '参考档案不存在', 404)
        const finding = profile.findings.find((item) => item.key === request.params.findingKey)
        if (!finding) throw new AppError(ErrorCode.NOT_FOUND, 'finding 不存在', 404)
        const sourceId = typeof profile.coverage.sourceId === 'string' ? profile.coverage.sourceId : null
        if (!sourceId) throw new AppError(ErrorCode.NOT_FOUND, '档案未关联参考源', 404)
        // 原文可用性：参考文本被删除（保留策略执行后）时证据能力降级并返回 410
        let sectionTexts: Record<string, string>
        let sections: Array<{ id: string; title?: string }>
        try {
          const all = reference.listSections(sourceId)
          const includedIds = all.filter((section) => section.included).map((section) => section.id)
          const bundle = reference.getSectionsText(sourceId, includedIds.length > 0 ? includedIds : all.map((section) => section.id))
          sectionTexts = bundle.sectionTexts
          sections = bundle.sections
        } catch {
          throw new AppError(ErrorCode.NOT_FOUND, '参考原文已删除，证据不可用', 410)
        }
        const evidence = finding.evidence.map((quote) => {
          const hit = findQuoteInSection(sectionTexts, quote)
          return {
            quote,
            available: hit !== null,
            sectionId: hit?.sectionId ?? null,
            sectionTitle: hit ? sections.find((section) => section.id === hit.sectionId)?.title ?? null : null,
            start: hit?.start ?? null,
            end: hit?.end ?? null,
            contentHash: hashShort(quote),
          }
        })
        return success({
          findingKey: finding.key,
          evidence,
          counterexamples: [],
          degraded: evidence.some((item) => !item.available),
          note: '证据为 ≤30 字原文短引用；原文删除后本接口返回 410，证据能力随之降级。',
        }, request.traceId)
      },
    },
    {
      method: 'PATCH',
      path: '/reference-profiles/:profileId/findings/:findingKey/review',
      handler: async (request: any, reply: any) => {
        const input = validateBody(reviewSchema, request, reply)
        if (!input) return reply
        try {
          return success(profileStore.reviewFinding(request.params.profileId, {
            ...input, findingKey: request.params.findingKey,
          }), request.traceId)
        } catch (error) {
          throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : '审核失败', 409)
        }
      },
    },
    {
      method: 'POST',
      path: '/reference-profiles/:profileId/finding-reviews/batch',
      handler: async (request: any, reply: any) => {
        const input = validateBody(batchReviewSchema, request, reply)
        if (!input) return reply
        const profile = profileStore.getProfile(request.params.profileId)
        if (!profile) throw new AppError(ErrorCode.NOT_FOUND, '参考档案不存在', 404)
        if (profile.version !== input.version) {
          throw new AppError(ErrorCode.CONFLICT, `档案版本已变化（当前 v${profile.version}），请刷新后重试`, 409)
        }
        try {
          const next = profileStore.reviewBatch(request.params.profileId, input.reviews, input.note)
          return success({ profile: next, reviewed: input.reviews.length, newVersion: next.version }, request.traceId)
        } catch (error) {
          throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : '批量审核失败', 409)
        }
      },
    },
    {
      method: 'GET',
      path: '/reference-profiles/:profileId/safety-report',
      handler: async (request: any) => {
        const profile = profileStore.getProfile(request.params.profileId)
        if (!profile) throw new AppError(ErrorCode.NOT_FOUND, '参考档案不存在', 404)
        return success({
          ...profile.safetyReport,
          blocking: profile.safetyReport.blockers.length > 0,
          findingSafetyFlags: profile.findings.filter((finding) => finding.evidence.some((quote) => quote.length >= 12)).length,
        }, request.traceId)
      },
    },
    {
      method: 'GET',
      path: '/reference-profiles/:profileId/versions',
      handler: async (request: any) => {
        const profile = profileStore.getProfile(request.params.profileId)
        if (!profile) throw new AppError(ErrorCode.NOT_FOUND, '参考档案不存在', 404)
        const versions = profileStore.listVersions(profile.analysisRunId)
        return success(versions.map((version) => ({
          id: version.id, version: version.version, parentVersionId: version.parentVersionId,
          profileHash: version.profileHash, status: version.status, changeSummary: version.changeSummary,
          createdAt: version.createdAt, activatedAt: version.activatedAt,
          findingCounts: {
            total: version.findings.length,
            promptEnabled: version.findings.filter((finding) => finding.promptEnabled).length,
          },
        })), request.traceId)
      },
    },
    {
      method: 'GET',
      path: '/reference-profiles/:profileId/compare',
      handler: async (request: any) => {
        const query = (request.query ?? {}) as Record<string, string | undefined>
        if (!query.toVersionId || !query.fromVersionId) {
          throw new AppError(ErrorCode.BAD_REQUEST, 'fromVersionId 与 toVersionId 为必填', 400)
        }
        const current = profileStore.getProfile(request.params.profileId)
        if (!current) throw new AppError(ErrorCode.NOT_FOUND, '参考档案不存在', 404)
        const comparison = profileStore.compare(query.fromVersionId, query.toVersionId)
        if (!comparison.from || !comparison.to) {
          throw new AppError(ErrorCode.NOT_FOUND, '对比版本不存在', 404)
        }
        return success(comparison, request.traceId)
      },
    },
  ]
}
