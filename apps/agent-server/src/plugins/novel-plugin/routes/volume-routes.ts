import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { Type } from 'typebox'
import { randomUUID } from 'node:crypto'
import { success } from '../../../lib/api-response.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { emptyQuerySchema, standardResponseSchema } from './route-contracts.js'

export function createVolumeRoutes(services: NovelServices): RouteDefinition[] {
  const { store } = services
  const projectParamsSchema = Type.Object({ projectId: Type.String({ format: 'uuid' }) })
  const volumeParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }) })
  const createVolumeRouteSchema = Type.Object({
    volumeNumber: Type.Integer({ minimum: 1 }),
    title: Type.Optional(Type.String({ maxLength: 200, default: '' })),
    outline: Type.Optional(Type.String({ maxLength: 20_000, default: '' })),
    sortOrder: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  }, { additionalProperties: false })
  const updateVolumeRouteSchema = Type.Object({
    title: Type.Optional(Type.String({ maxLength: 200 })),
    outline: Type.Optional(Type.String({ maxLength: 20_000 })),
    sortOrder: Type.Optional(Type.Integer({ minimum: 0 })),
    volumeNumber: Type.Optional(Type.Integer({ minimum: 1 })),
  }, { additionalProperties: false })
  return [
    { method: 'GET', path: '/projects/:projectId/volumes', schema: { params: projectParamsSchema, querystring: emptyQuerySchema, response: standardResponseSchema }, handler: async (request: any) => success(store.listVolumes(request.params.projectId), request.traceId) },
    { method: 'POST', path: '/projects/:projectId/volumes', schema: { params: projectParamsSchema, querystring: emptyQuerySchema, body: createVolumeRouteSchema, response: standardResponseSchema }, handler: async (request: any) => {
      const input = {
        title: '',
        outline: '',
        sortOrder: 0,
        ...request.body,
      }
      const volume = store.createVolume({ id: randomUUID(), projectId: request.params.projectId, ...input })
      return success(volume, request.traceId)
    } },
    { method: 'PATCH', path: '/volumes/:id', schema: { params: volumeParamsSchema, querystring: emptyQuerySchema, body: updateVolumeRouteSchema, response: standardResponseSchema }, handler: async (request: any) => {
      const input = request.body
      const updated = store.updateVolume(request.params.id, input)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `卷不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    } },
    { method: 'DELETE', path: '/volumes/:id', schema: { params: volumeParamsSchema, querystring: emptyQuerySchema, response: standardResponseSchema }, handler: async (request: any) => {
      if (!store.deleteVolume(request.params.id)) throw new AppError(ErrorCode.NOT_FOUND, `卷不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    } },
  ]
}
