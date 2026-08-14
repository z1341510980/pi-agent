import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { success } from '../../../lib/api-response.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

/** Read-only memory event, timeline, causal-chain and snapshot routes. */
export function createMemoryRoutes(services: NovelServices): RouteDefinition[] {
  const { memoryStore } = services
  return [
    { method: 'GET', path: '/projects/:projectId/memory-events', handler: async (request: any) => {
      const query = (request.query ?? {}) as Record<string, string | undefined>
      const number = (value: string | undefined) => value == null ? undefined : parseInt(value, 10)
      const chapterNumber = number(query.chapterNumber); const minSignificance = number(query.minSignificance); const limit = number(query.limit)
      return success(memoryStore.listEvents(request.params.projectId, { chapterNumber: Number.isNaN(chapterNumber) ? undefined : chapterNumber, entityType: query.entityType as any, entityId: query.entityId, eventType: query.eventType as any, minSignificance: Number.isNaN(minSignificance) ? undefined : minSignificance, limit: Number.isNaN(limit) ? undefined : limit }), request.traceId)
    } },
    { method: 'GET', path: '/projects/:projectId/memory-events/timeline/:entityId', handler: async (request: any) => success(memoryStore.getEntityTimeline(request.params.projectId, request.params.entityId), request.traceId) },
    { method: 'GET', path: '/projects/:projectId/memory-events/causal/:eventId', handler: async (request: any) => success(memoryStore.getCausalChain(request.params.eventId), request.traceId) },
    { method: 'GET', path: '/projects/:projectId/memory-snapshots', handler: async (request: any) => {
      const query = (request.query ?? {}) as Record<string, string | undefined>; const chapterNumber = query.chapterNumber == null ? undefined : parseInt(query.chapterNumber, 10)
      return success(memoryStore.listSnapshots(request.params.projectId, { chapterNumber: Number.isNaN(chapterNumber) ? undefined : chapterNumber, snapshotType: query.snapshotType as any }), request.traceId)
    } },
    { method: 'GET', path: '/projects/:projectId/memory-snapshots/:chapterNumber', handler: async (request: any) => {
      const chapterNumber = parseInt(request.params.chapterNumber, 10); if (Number.isNaN(chapterNumber) || chapterNumber < 0) throw new AppError(ErrorCode.BAD_REQUEST, `无效的 chapterNumber: ${request.params.chapterNumber}`, 400)
      const query = (request.query ?? {}) as Record<string, string | undefined>; const snapshot = memoryStore.getSnapshot(request.params.projectId, chapterNumber, { snapshotType: query.snapshotType as any, entityId: query.entityId })
      if (!snapshot) throw new AppError(ErrorCode.NOT_FOUND, `章节 ${chapterNumber} 的快照不存在`, 404)
      return success(snapshot, request.traceId)
    } },
  ]
}
