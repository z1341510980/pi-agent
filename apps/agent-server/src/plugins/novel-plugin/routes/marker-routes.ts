import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Type } from 'typebox'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import type { NovelMarker } from '../core/types.js'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { emptyQuerySchema, standardResponseSchema } from './route-contracts.js'

const projectParamsSchema = Type.Object({ projectId: Type.String({ minLength: 1 }) })
const entityParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) })
const markerTypeRouteSchema = Type.Union([
  Type.Literal('bookmark'), Type.Literal('turning-point'), Type.Literal('foreshadow'), Type.Literal('climax'),
  Type.Literal('note'), Type.Literal('clip-note'), Type.Literal('in'), Type.Literal('out'),
])
const markerColorRouteSchema = Type.Union([
  Type.Literal('blue'), Type.Literal('yellow'), Type.Literal('green'), Type.Literal('red'), Type.Literal('purple'),
])
const markerBodySchema = Type.Object({
  chapter: Type.Integer({ minimum: 1 }),
  title: Type.Optional(Type.String({ default: '' })),
  note: Type.Optional(Type.String({ default: '' })),
  type: Type.Optional(Type.Union(markerTypeRouteSchema.anyOf, { default: 'bookmark' })),
  color: Type.Optional(Type.Union(markerColorRouteSchema.anyOf, { default: 'blue' })),
  entityType: Type.Optional(Type.Union([Type.String(), Type.Null()], { default: null })),
  entityId: Type.Optional(Type.Union([Type.String(), Type.Null()], { default: null })),
}, { additionalProperties: false })
const markerPatchBodySchema = Type.Object({
  chapter: Type.Optional(Type.Integer({ minimum: 1 })),
  title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  note: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  type: Type.Optional(Type.Union(markerTypeRouteSchema.anyOf)),
  color: Type.Optional(Type.Union(markerColorRouteSchema.anyOf)),
  entityType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  entityId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
}, { additionalProperties: false })

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
      schema: { params: projectParamsSchema, querystring: emptyQuerySchema, body: markerBodySchema, response: standardResponseSchema },
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
      schema: { params: projectParamsSchema, querystring: emptyQuerySchema, response: standardResponseSchema },
      handler: async (request: any) => success(store.listMarkers(request.params.projectId), request.traceId),
    },
    {
      method: 'PATCH',
      path: '/markers/:id',
      schema: { params: entityParamsSchema, querystring: emptyQuerySchema, body: markerPatchBodySchema, response: standardResponseSchema },
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
      schema: { params: entityParamsSchema, querystring: emptyQuerySchema, response: standardResponseSchema },
      handler: async (request: any) => {
        const deleted = store.deleteMarker(request.params.id)
        if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `标记不存在: ${request.params.id}`, 404)
        return success({ id: request.params.id, deleted: true }, request.traceId)
      },
    },
  ]
}
