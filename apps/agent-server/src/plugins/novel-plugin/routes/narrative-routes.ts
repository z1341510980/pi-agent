import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { z } from 'zod'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

export function createNarrativeRoutes(services: NovelServices): RouteDefinition[] {
  const { store } = services
  const narrativeTypes = ['advance', 'turn', 'reversal', 'suspense', 'resolve', 'setup', 'reveal', 'misc'] as const
  const schema = z.object({ description: z.string().min(1), type: z.enum(narrativeTypes).default('advance'), status: z.enum(['active', 'resolved', 'dropped']).default('active'), chapterSpans: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])).default([]) })
  const patchSchema = schema.partial()
  return [
    { method: 'GET', path: '/projects/:projectId/narratives', handler: async (request: any) => success(store.listNarratives(request.params.projectId), request.traceId) },
    { method: 'POST', path: '/projects/:projectId/narratives', handler: async (request: any, reply: any) => {
      const input = validateBody(schema, request, reply); if (!input) return reply
      return success(store.createNarrative({ projectId: request.params.projectId, ...input }), request.traceId)
    } },
    { method: 'PATCH', path: '/narratives/:id', handler: async (request: any, reply: any) => {
      const input = validateBody(patchSchema, request, reply); if (!input) return reply
      const updated = store.updateNarrative(request.params.id, input as any)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `剧情不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    } },
    { method: 'DELETE', path: '/narratives/:id', handler: async (request: any) => {
      if (!store.deleteNarrative(request.params.id)) throw new AppError(ErrorCode.NOT_FOUND, `剧情不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    } },
  ]
}
