import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { z } from 'zod'
import { Type } from 'typebox'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { emptyQuerySchema, standardResponseSchema } from './route-contracts.js'

export function createNarrativeRoutes(services: NovelServices): RouteDefinition[] {
  const { store } = services
  const narrativeTypes = ['advance', 'turn', 'reversal', 'suspense', 'resolve', 'setup', 'reveal', 'misc'] as const
  const schema = z.object({ description: z.string().min(1), type: z.enum(narrativeTypes).default('advance'), status: z.enum(['active', 'resolved', 'dropped']).default('active'), chapterSpans: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])).default([]) })
  const patchSchema = z.object({
    description: z.string().min(1).optional(),
    type: z.enum(narrativeTypes).optional(),
    status: z.enum(['active', 'resolved', 'dropped']).optional(),
    chapterSpans: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])).optional(),
  })
  const projectParamsSchema = Type.Object({ projectId: Type.String({ minLength: 1 }) })
  const entityParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) })
  const bodySchema = Type.Object({
    description: Type.String({ minLength: 1 }),
    type: Type.Optional(Type.Union(narrativeTypes.map(value => Type.Literal(value)) as any, { default: 'advance' })),
    status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('resolved'), Type.Literal('dropped')], { default: 'active' })),
    chapterSpans: Type.Optional(Type.Array(Type.Tuple([Type.Integer({ minimum: 1 }), Type.Integer({ minimum: 1 })]), { default: [] })),
  }, { additionalProperties: false })
  const patchBodySchema = Type.Object({
    description: Type.Optional(Type.String({ minLength: 1 })),
    type: Type.Optional(Type.Union(narrativeTypes.map(value => Type.Literal(value)) as any)),
    status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('resolved'), Type.Literal('dropped')])),
    chapterSpans: Type.Optional(Type.Array(Type.Tuple([Type.Integer({ minimum: 1 }), Type.Integer({ minimum: 1 })]))),
  }, { additionalProperties: false })
  return [
    { method: 'GET', path: '/projects/:projectId/narratives', schema: { params: projectParamsSchema, querystring: emptyQuerySchema, response: standardResponseSchema }, handler: async (request: any) => success(store.listNarratives(request.params.projectId), request.traceId) },
    { method: 'POST', path: '/projects/:projectId/narratives', schema: { params: projectParamsSchema, querystring: emptyQuerySchema, body: bodySchema, response: standardResponseSchema }, handler: async (request: any, reply: any) => {
      const input = validateBody(schema, request, reply); if (!input) return reply
      return success(store.createNarrative({ projectId: request.params.projectId, ...input }), request.traceId)
    } },
    { method: 'PATCH', path: '/narratives/:id', schema: { params: entityParamsSchema, querystring: emptyQuerySchema, body: patchBodySchema, response: standardResponseSchema }, handler: async (request: any, reply: any) => {
      const input = validateBody(patchSchema, request, reply); if (!input) return reply
      const updated = store.updateNarrative(request.params.id, input as any)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `剧情不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    } },
    { method: 'DELETE', path: '/narratives/:id', schema: { params: entityParamsSchema, querystring: emptyQuerySchema, response: standardResponseSchema }, handler: async (request: any) => {
      if (!store.deleteNarrative(request.params.id)) throw new AppError(ErrorCode.NOT_FOUND, `剧情不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    } },
  ]
}
