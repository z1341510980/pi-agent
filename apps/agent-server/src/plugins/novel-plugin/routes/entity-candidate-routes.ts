/**
 * 实体候选审核路由（T04，V2 决策 3）
 *
 * - GET /projects/:projectId/entity-candidates?status=needs_review — 列出候选（前端提示）
 * - POST /entity-candidates/:id/confirm — 确认候选并晋升正式实体（conflict/clue）
 * - POST /entity-candidates/:id/reject — 拒绝（必须带 reason）
 *
 * 确认晋升由后端基于候选 payload 执行（与 Memory 原创建逻辑一致），
 * 前端只做决策，不传实体字段（防伪造）。
 */
import { z } from 'zod'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { randomUUID } from 'node:crypto'
import type { NovelConflict } from '../core/types.js'

const rejectSchema = z.object({
  reason: z.string().min(1, '拒绝必须提供原因'),
})

export function createEntityCandidateRoutes(services: NovelServices): RouteDefinition[] {
  const { store } = services
  const routes: RouteDefinition[] = []

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/entity-candidates',
    handler: async (request: any) => {
      const status = request.query?.status as string | undefined
      const candidates = status
        ? store.listEntityCandidates(request.params.projectId, status as any)
        : store.listEntityCandidates(request.params.projectId)
      return success({
        candidates,
        pendingCount: store.countPendingEntityCandidates(request.params.projectId),
      }, request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/entity-candidates/:id/confirm',
    handler: async (request: any) => {
      const candidate = store.getEntityCandidate(request.params.id)
      if (!candidate) throw new AppError(ErrorCode.NOT_FOUND, `候选不存在: ${request.params.id}`, 404)
      if (candidate.status !== 'needs_review') {
        throw new AppError(ErrorCode.BAD_REQUEST, `候选状态 ${candidate.status} 不可确认`, 400)
      }
      const result = store.confirmEntityCandidateWithPromotion(candidate.id, 'user', (confirmedCandidate) => {
        // 晋升正式实体与候选确认共用一个 SQLite 事务。
        const payload = confirmedCandidate.payload as Record<string, any>
        if (confirmedCandidate.entityType === 'conflict') {
          const participantIds = Array.isArray(payload.participants)
            ? payload.participants
                .map((name: string) => store.listCharacters(confirmedCandidate.projectId).find((c) => c.name === name)?.id)
                .filter((id: string | undefined): id is string => !!id)
            : []
          return store.createConflict({
            id: randomUUID(),
            projectId: confirmedCandidate.projectId,
            description: typeof payload.description === 'string' ? payload.description : '',
            type: (payload.type as NovelConflict['type']) || 'interest',
            intensity: Math.max(1, Math.min(10, Number(payload.intensity) || 5)),
            stage: (payload.stage as NovelConflict['stage']) || 'emerging',
            participants: JSON.stringify(participantIds),
            chapterSpans: confirmedCandidate.chapterNumber != null ? [[confirmedCandidate.chapterNumber, confirmedCandidate.chapterNumber]] : [],
            tier: 'secondary',
            plotFunction: payload.plotFunction as any,
            progressionMode: payload.progressionMode as any,
            currentStep: typeof payload.currentStep === 'string' ? payload.currentStep : '',
            nextStep: typeof payload.nextStep === 'string' ? payload.nextStep : '',
          }).id
        }
        if (confirmedCandidate.entityType === 'clue') {
          return store.createClue({
            id: randomUUID(),
            projectId: confirmedCandidate.projectId,
            description: typeof payload.description === 'string' ? payload.description : '',
            pointsTo: typeof payload.pointsTo === 'string' ? payload.pointsTo : '',
            progress: Math.max(0, Math.min(100, Number(payload.progress) || 10)),
            currentStep: typeof payload.currentStep === 'string' ? payload.currentStep : '本章首次发现',
            nextStep: typeof payload.nextStep === 'string' ? payload.nextStep : '',
            isMisleading: payload.isMisleading === true,
            chapterSpans: confirmedCandidate.chapterNumber != null ? [[confirmedCandidate.chapterNumber, confirmedCandidate.chapterNumber]] : [],
          }).id
        }
        return null
      })
      return success(result, request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/entity-candidates/:id/reject',
    handler: async (request: any, reply: any) => {
      const input = validateBody(rejectSchema, request, reply)
      if (!input) return reply
      const candidate = store.getEntityCandidate(request.params.id)
      if (!candidate) throw new AppError(ErrorCode.NOT_FOUND, `候选不存在: ${request.params.id}`, 404)
      if (candidate.status !== 'needs_review') {
        throw new AppError(ErrorCode.BAD_REQUEST, `候选状态 ${candidate.status} 不可拒绝`, 400)
      }
      const rejected = store.rejectEntityCandidate(candidate.id, input.reason, 'user')
      return success(rejected, request.traceId)
    },
  })

  return routes
}
