/**
 * narrative-revision-routes：Storyline/Scene 人工 revision 与剧情矩阵重投影（M2，方案 §7）。
 *
 * 覆盖 storylines / scenes 的列表、详情、草稿、提交审核、批准/拒绝、版本比较、回滚，
 * 以及 narrative-matrix 的重投影 job 三元组（rebuild / job 详情 / SSE 事件）。
 * 所有写操作走 store 乐观锁（expectedRevision），并发覆盖返回 409。
 */
import { z } from 'zod'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { closeSse, sendSseComment, sendSseEvent, setupSse } from '../../../lib/sse.js'

// ── Storyline ──

function storylineDetail(services: NovelServices, storyline: { id: string; projectId: string; name: string; kind: string; lifecycle: unknown; maturity: unknown; description: string; createdAt: number; updatedAt: number }): Record<string, unknown> {
  const current = services.store.getStorylineCurrentRevision(storyline.id)
  return {
    id: storyline.id,
    projectId: storyline.projectId,
    name: storyline.name,
    kind: storyline.kind,
    lifecycle: storyline.lifecycle,
    maturity: storyline.maturity,
    description: storyline.description,
    createdAt: storyline.createdAt,
    updatedAt: storyline.updatedAt,
    currentRevisionId: current?.id ?? null,
    version: current?.revision ?? 0,
    status: current?.status ?? (current ? 'draft' : 'none'),
    summary: current?.summary ?? '',
    goal: current?.goal ?? '',
    stakes: current?.stakes ?? '',
    actor: current?.actor ?? '',
  }
}

// ── Scene ──

function sceneDetail(services: NovelServices, sceneId: string): Record<string, unknown> | null {
  const detail = services.store.getSceneReviewDetail(sceneId)
  if (!detail) return null
  return {
    sceneId: detail.sceneId,
    currentRevision: detail.revision,
    revisions: detail.revisions,
  }
}

const storylinesDraftSchema = z.object({
  expectedRevision: z.number().int().min(0),
  summary: z.string().max(10000).default(''),
  goal: z.string().max(10000).default(''),
  stakes: z.string().max(10000).default(''),
  actor: z.string().max(500).default(''),
  note: z.string().max(5000).optional(),
})

const storylineDecisionSchema = z.object({
  decision: z.literal('approve').or(z.literal('reject')),
  note: z.string().max(5000).optional().default(''),
  reviewer: z.string().max(100).optional(),
})

const storylineRollbackSchema = z.object({
  targetRevisionId: z.string().uuid(),
  note: z.string().max(5000).default(''),
})

const sceneDraftSchema = z.object({
  expectedRevision: z.string().uuid(),
  summary: z.string().max(10000).default(''),
  pov: z.string().max(50).default('single'),
  positioning: z.string().max(2000).optional(),
  rhythm: z.string().max(2000).optional(),
  narrativeTaskTypes: z.array(z.string().max(200)).max(100).optional().default([]),
  focus: z.array(z.string().max(200)).max(200).optional().default([]),
  present: z.array(z.string().max(200)).max(200).optional().default([]),
  cast: z.array(z.object({
    characterId: z.string().max(200),
    function: z.string().max(200),
    prominence: z.string().max(50).default('brief'),
  })).max(200).optional().default([]),
})

const sceneDecisionSchema = z.object({
  decision: z.literal('approve').or(z.literal('reject')),
  note: z.string().max(5000).optional().default(''),
  reviewer: z.string().max(100).optional(),
})

const sceneRollbackSchema = z.object({
  targetRevisionId: z.string().uuid(),
  note: z.string().max(5000).default(''),
})

const matrixRebuildSchema = z.object({
  revisionIds: z.array(z.string().uuid()).max(500).optional().default([]),
  idempotencyKey: z.string().max(200).optional(),
})

const parseRevisionQuery = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function createNarrativeRevisionRoutes(services: NovelServices): RouteDefinition[] {
  const { store } = services
  const routes: RouteDefinition[] = []

  // ═══════════════════════════════════════════════════════════════
  // Storyline
  // ═══════════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/storylines',
    handler: async (request: any) => {
      const storylines = store.listStorylines(request.params.projectId)
      return success(storylines.map((item) => storylineDetail(services, item)), request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/storylines/:storylineId',
    handler: async (request: any) => {
      const storyline = store.getStoryline(request.params.storylineId)
      if (!storyline) throw new AppError(ErrorCode.NOT_FOUND, '故事线不存在', 404)
      return success({
        ...storylineDetail(services, storyline),
        revisions: store.listStorylineRevisions(storyline.id),
      }, request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/storylines/:storylineId/revisions',
    handler: async (request: any, reply: any) => {
      const input = validateBody(storylinesDraftSchema, request, reply)
      if (!input) return reply
      const storyline = store.getStoryline(request.params.storylineId)
      if (!storyline) throw new AppError(ErrorCode.NOT_FOUND, '故事线不存在', 404)
      try {
        return success(store.createStorylineRevisionDraft(storyline.id, storyline.projectId, input), request.traceId)
      } catch (error) {
        throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : '无法创建故事线修订', 409)
      }
    },
  })

  const submitStoryline = async (request: any): Promise<unknown> => {
    try {
      return success(store.submitStorylineRevision(request.params.revisionId), request.traceId)
    } catch (error) {
      throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : '无法提交故事线修订', 409)
    }
  }
  routes.push({ method: 'POST', path: '/storyline-revisions/:revisionId/submit', handler: submitStoryline })

  routes.push({
    method: 'POST',
    path: '/storyline-revisions/:revisionId/approve',
    handler: async (request: any, reply: any) => {
      const input = validateBody(storylineDecisionSchema, request, reply)
      if (!input) return reply
      try {
        return success(store.approveStorylineRevision(request.params.revisionId, {
          decision: 'approve', note: input.note, reviewer: input.reviewer,
        }), request.traceId)
      } catch (error) {
        throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : '无法批准故事线修订', 409)
      }
    },
  })

  routes.push({
    method: 'POST',
    path: '/storyline-revisions/:revisionId/reject',
    handler: async (request: any, reply: any) => {
      const input = validateBody(storylineDecisionSchema, request, reply)
      if (!input) return reply
      try {
        return success(store.rejectStorylineRevision(request.params.revisionId, {
          decision: 'reject', note: input.note, reviewer: input.reviewer,
        }), request.traceId)
      } catch (error) {
        throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : '无法拒绝故事线修订', 409)
      }
    },
  })

  routes.push({
    method: 'GET',
    path: '/storylines/:storylineId/revisions/compare',
    handler: async (request: any) => {
      const fromRevision = parseRevisionQuery(request.query?.fromRevision)
      const toRevision = parseRevisionQuery(request.query?.toRevision)
      if (fromRevision === undefined || toRevision === undefined) {
        throw new AppError(ErrorCode.BAD_REQUEST, 'fromRevision 与 toRevision 为必填数字', 400)
      }
      return success(store.compareStorylineRevisions(request.params.storylineId, fromRevision, toRevision), request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/storylines/:storylineId/revisions/rollback',
    handler: async (request: any, reply: any) => {
      const input = validateBody(storylineRollbackSchema, request, reply)
      if (!input) return reply
      const storyline = store.getStoryline(request.params.storylineId)
      if (!storyline) throw new AppError(ErrorCode.NOT_FOUND, '故事线不存在', 404)
      try {
        return success(store.rollbackStorylineRevision(storyline.id, storyline.projectId, input.targetRevisionId, input.note), request.traceId)
      } catch (error) {
        throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : '无法回滚故事线', 409)
      }
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // Scene
  // ═══════════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/scenes',
    handler: async (request: any) => {
      return success(store.listSceneRevisionReviews(request.params.projectId), request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/scenes/:sceneId',
    handler: async (request: any) => {
      const detail = sceneDetail(services, request.params.sceneId)
      if (!detail) throw new AppError(ErrorCode.NOT_FOUND, '场景不存在', 404)
      return success(detail, request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/scenes/:sceneId/revisions',
    handler: async (request: any, reply: any) => {
      const input = validateBody(sceneDraftSchema, request, reply)
      if (!input) return reply
      try {
        return success(store.createSceneReviewDraft(request.params.sceneId, input), request.traceId)
      } catch (error) {
        throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : '无法创建场景修订', 409)
      }
    },
  })

  routes.push({
    method: 'POST',
    path: '/scene-revisions/:revisionId/submit',
    handler: async (request: any) => {
      try {
        return success(store.submitSceneReviewRevision(request.params.revisionId), request.traceId)
      } catch (error) {
        throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : '无法提交场景修订', 409)
      }
    },
  })

  const sceneDecide = async (decision: 'approve' | 'reject', request: any, reply: any): Promise<unknown> => {
    const input = validateBody(sceneDecisionSchema, request, reply)
    if (!input) return reply
    try {
      return success(store.decideSceneReviewRevision(request.params.revisionId, decision, input.note, input.reviewer), request.traceId)
    } catch (error) {
      throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : '无法审核场景修订', 409)
    }
  }

  routes.push({
    method: 'POST',
    path: '/scene-revisions/:revisionId/approve',
    handler: async (request: any, reply: any) => sceneDecide('approve', request, reply),
  })
  routes.push({
    method: 'POST',
    path: '/scene-revisions/:revisionId/reject',
    handler: async (request: any, reply: any) => sceneDecide('reject', request, reply),
  })

  routes.push({
    method: 'GET',
    path: '/scenes/:sceneId/revisions/compare',
    handler: async (request: any) => {
      const fromRevisionId = typeof request.query?.fromRevisionId === 'string' ? request.query.fromRevisionId : undefined
      const toRevisionId = typeof request.query?.toRevisionId === 'string' ? request.query.toRevisionId : undefined
      if (!fromRevisionId || !toRevisionId) {
        throw new AppError(ErrorCode.BAD_REQUEST, 'fromRevisionId 与 toRevisionId 为必填', 400)
      }
      return success(store.compareSceneReviewRevisions(request.params.sceneId, fromRevisionId, toRevisionId), request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/scenes/:sceneId/revisions/rollback',
    handler: async (request: any, reply: any) => {
      const input = validateBody(sceneRollbackSchema, request, reply)
      if (!input) return reply
      try {
        return success(store.rollbackSceneReviewRevision(request.params.sceneId, input.targetRevisionId, input.note), request.traceId)
      } catch (error) {
        throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : '无法回滚场景', 409)
      }
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 剧情矩阵重投影 job
  // ═══════════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/narrative-matrix/rebuild',
    handler: async (request: any, reply: any) => {
      const input = validateBody(matrixRebuildSchema, request, reply)
      if (!input) return reply
      const project = store.getProject(request.params.projectId)
      if (!project) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在', 404)
      const rebuild = store.createMatrixRebuild(project.id, input.revisionIds, input.idempotencyKey)
      if (rebuild.status !== 'completed') {
        // 同步重投影：立即执行 buildNarrativeMatrix 并落完成事件。
        try {
          const report = store.narrativeMatrix(project.id)
          store.markMatrixRebuildCompleted(project.id, rebuild.id, {
            sourceRevision: report.sourceRevision,
            stale: report.stale,
            failedNodes: [],
          })
        } catch (error) {
          store.markMatrixRebuildFailed(project.id, rebuild.id, error instanceof Error ? error.message : '矩阵重投影失败')
        }
      }
      const updated = store.getMatrixRebuild(project.id, rebuild.id)!
      return success({
        ...updated,
        eventsUrl: `/projects/${project.id}/narrative-matrix/rebuild/${updated.id}/events`,
      }, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/narrative-matrix/rebuild/:jobId',
    handler: async (request: any) => {
      const rebuild = store.getMatrixRebuild(request.params.projectId, request.params.jobId)
      if (!rebuild) throw new AppError(ErrorCode.NOT_FOUND, '矩阵重投影任务不存在', 404)
      return success(rebuild, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/narrative-matrix/rebuild/:jobId/events',
    handler: async (request: any, reply: any) => {
      const rebuild = store.getMatrixRebuild(request.params.projectId, request.params.jobId)
      if (!rebuild) throw new AppError(ErrorCode.NOT_FOUND, '矩阵重投影任务不存在', 404)
      const header = request.headers['last-event-id']
      const afterSequence = typeof header === 'string' && /^\d+$/.test(header) ? Number(header) : 0
      const events = store.listMatrixRebuildEvents(request.params.projectId, request.params.jobId, afterSequence)
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

  return routes
}