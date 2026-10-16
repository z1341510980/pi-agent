import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import type { NovelMarker } from '../core/types.js'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

const markerTypeSchema = z.enum([
  'bookmark',
  'turning-point',
  'foreshadow',
  'climax',
  'note',
  'clip-note',
  'in',
  'out',
])

const markerColorSchema = z.enum(['blue', 'yellow', 'green', 'red', 'purple'])

const createMarkerSchema = z.object({
  chapter: z.number().int().min(1),
  title: z.string().default(''),
  note: z.string().default(''),
  type: markerTypeSchema.default('bookmark'),
  color: markerColorSchema.default('blue'),
  entityType: z.string().nullable().default(null),
  entityId: z.string().nullable().default(null),
})

const updateMarkerSchema = z.object({
  chapter: z.number().int().min(1).optional(),
  title: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  type: markerTypeSchema.optional(),
  color: markerColorSchema.optional(),
  entityType: z.string().nullable().optional(),
  entityId: z.string().nullable().optional(),
})

/** Timeline marker CRUD endpoints. */
export function createMarkerRoutes(services: Pick<NovelServices, 'store'>): RouteDefinition[] {
  const { store } = services
  return [
    {
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
    },
    {
      method: 'GET',
      path: '/projects/:projectId/markers',
      handler: async (request: any) => success(store.listMarkers(request.params.projectId), request.traceId),
    },
    {
      method: 'PATCH',
      path: '/markers/:id',
      handler: async (request: any, reply: any) => {
        const input = validateBody(updateMarkerSchema, request, reply)
        if (!input) return reply

        const updated = store.updateMarker(request.params.id, input as Partial<NovelMarker>)
        if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `标记不存在: ${request.params.id}`, 404)
        return success(updated, request.traceId)
      },
    },
    {
      method: 'DELETE',
      path: '/markers/:id',
      handler: async (request: any) => {
        const deleted = store.deleteMarker(request.params.id)
        if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `标记不存在: ${request.params.id}`, 404)
        return success({ id: request.params.id, deleted: true }, request.traceId)
      },
    },
  ]
}
