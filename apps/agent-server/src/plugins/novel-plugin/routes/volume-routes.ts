import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

export function createVolumeRoutes(services: NovelServices): RouteDefinition[] {
  const { store } = services
  const createVolumeSchema = z.object({ volumeNumber: z.number().int().min(1), title: z.string().max(200).default(''), outline: z.string().max(20000).default(''), sortOrder: z.number().int().min(0).default(0) })
  const updateVolumeSchema = z.object({ title: z.string().max(200).optional(), outline: z.string().max(20000).optional(), sortOrder: z.number().int().min(0).optional(), volumeNumber: z.number().int().min(1).optional() })
  return [
    { method: 'GET', path: '/projects/:projectId/volumes', handler: async (request: any) => success(store.listVolumes(request.params.projectId), request.traceId) },
    { method: 'POST', path: '/projects/:projectId/volumes', handler: async (request: any, reply: any) => {
      const input = validateBody(createVolumeSchema, request, reply); if (!input) return reply
      const volume = store.createVolume({ id: randomUUID(), projectId: request.params.projectId, ...input })
      return success(volume, request.traceId)
    } },
    { method: 'PATCH', path: '/volumes/:id', handler: async (request: any, reply: any) => {
      const input = validateBody(updateVolumeSchema, request, reply); if (!input) return reply
      const updated = store.updateVolume(request.params.id, input)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `卷不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    } },
    { method: 'DELETE', path: '/volumes/:id', handler: async (request: any) => {
      if (!store.deleteVolume(request.params.id)) throw new AppError(ErrorCode.NOT_FOUND, `卷不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    } },
  ]
}
