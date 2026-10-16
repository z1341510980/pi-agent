import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Type } from 'typebox'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import type { NovelInformationLayer } from '../core/types.js'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { emptyQuerySchema, standardResponseSchema } from './route-contracts.js'

const projectParamsSchema = Type.Object({ projectId: Type.String({ minLength: 1 }) })
const entityParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) })
const linkQuerySchema = Type.Object({
  foreshadowId: Type.String({ minLength: 1 }),
  infoLayerId: Type.String({ minLength: 1 }),
})

const worldRuleBodySchema = Type.Object({
  category: Type.String({ minLength: 1 }),
  rule: Type.String({ minLength: 1 }),
  cost: Type.Optional(Type.Union([Type.String(), Type.Null()], { default: null })),
  isFixed: Type.Optional(Type.Boolean({ default: true })),
}, { additionalProperties: false })

const styleGuideBodySchema = Type.Object({
  category: Type.String({ minLength: 1 }),
  rule: Type.String({ minLength: 1 }),
  example: Type.Optional(Type.Union([Type.String(), Type.Null()], { default: null })),
}, { additionalProperties: false })

const constraintBodySchema = Type.Object({
  type: Type.Union([
    Type.Literal('fact'),
    Type.Literal('cognitive'),
    Type.Literal('stage'),
    Type.Literal('debt'),
    Type.Literal('arc'),
  ]),
  scope: Type.Optional(Type.Union([
    Type.Literal('global'),
    Type.Literal('volume'),
    Type.Literal('chapter'),
  ], { default: 'global' })),
  rule: Type.String({ minLength: 1 }),
  relatedEntityId: Type.Optional(Type.Union([Type.String(), Type.Null()], { default: null })),
}, { additionalProperties: false })

const infoLayerBodySchema = Type.Object({
  infoDescription: Type.String({ minLength: 1 }),
  authorKnows: Type.Optional(Type.Boolean({ default: true })),
  readerKnows: Type.Optional(Type.Boolean({ default: false })),
  revealStage: Type.Optional(Type.Union([Type.String(), Type.Null()], { default: null })),
  revealChapter: Type.Optional(Type.Union([Type.Integer(), Type.Null()], { default: null })),
  linkedForeshadows: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
}, { additionalProperties: false })

const infoLayerPatchBodySchema = Type.Object({
  infoDescription: Type.Optional(Type.String({ minLength: 1 })),
  authorKnows: Type.Optional(Type.Boolean()),
  readerKnows: Type.Optional(Type.Boolean()),
  revealStage: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  revealChapter: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  isRevealed: Type.Optional(Type.Boolean()),
  characterKnowledge: Type.Optional(Type.String()),
  linkedForeshadows: Type.Optional(Type.String()),
}, { additionalProperties: false })

const infoLayerLinkBodySchema = Type.Object({
  foreshadowId: Type.String({ minLength: 1 }),
  infoLayerId: Type.String({ minLength: 1 }),
}, { additionalProperties: false })

const projectRouteSchema = (options: { body?: object; params?: object; querystring?: object } = {}) => ({
  params: options.params ?? projectParamsSchema,
  querystring: options.querystring ?? emptyQuerySchema,
  ...(options.body ? { body: options.body } : {}),
  response: standardResponseSchema,
})

const createWorldRuleSchema = z.object({
  category: z.string().min(1),
  rule: z.string().min(1),
  cost: z.string().nullable().default(null),
  isFixed: z.boolean().default(true),
})

const createStyleGuideSchema = z.object({
  category: z.string().min(1),
  rule: z.string().min(1),
  example: z.string().nullable().default(null),
})

const createConstraintSchema = z.object({
  type: z.enum(['fact', 'cognitive', 'stage', 'debt', 'arc']),
  scope: z.enum(['global', 'volume', 'chapter']).default('global'),
  rule: z.string().min(1),
  relatedEntityId: z.string().nullable().default(null),
})

const createInfoLayerSchema = z.object({
  infoDescription: z.string().min(1),
  authorKnows: z.boolean().default(true),
  readerKnows: z.boolean().default(false),
  revealStage: z.string().nullable().default(null),
  revealChapter: z.number().int().nullable().default(null),
  // -- 关联字段（不再写入 DB，创建后生成 edges）--
  linkedForeshadows: z.array(z.string()).optional(),
})

const updateInfoLayerSchema = z.object({
  infoDescription: z.string().min(1).optional(),
  authorKnows: z.boolean().optional(),
  readerKnows: z.boolean().optional(),
  revealStage: z.string().nullable().optional(),
  revealChapter: z.number().int().nullable().optional(),
  isRevealed: z.boolean().optional(),
  characterKnowledge: z.string().optional(),
  linkedForeshadows: z.string().optional(),
})

const linkForeshadowInfoLayerSchema = z.object({
  foreshadowId: z.string().min(1),
  infoLayerId: z.string().min(1),
})

/** Routes for project world rules, style guides, constraints, and information layers. */
export function createWorldSettingRoutes(services: NovelServices): RouteDefinition[] {
  const { store } = services
  const routes: RouteDefinition[] = []

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/world-rules',
    schema: projectRouteSchema({ body: worldRuleBodySchema }),
    handler: async (request: any, reply: any) => {
      const input = validateBody(createWorldRuleSchema, request, reply)
      if (!input) return reply

      const rule = store.createWorldRule({
        id: randomUUID(),
        projectId: request.params.projectId,
        ...input,
      })
      return success(rule, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/world-rules',
    schema: projectRouteSchema(),
    handler: async (request: any) => {
      return success(store.listWorldRules(request.params.projectId), request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/style-guides',
    schema: projectRouteSchema({ body: styleGuideBodySchema }),
    handler: async (request: any, reply: any) => {
      const input = validateBody(createStyleGuideSchema, request, reply)
      if (!input) return reply

      const style = store.createStyleGuide({
        id: randomUUID(),
        projectId: request.params.projectId,
        ...input,
      })
      return success(style, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/style-guides',
    schema: projectRouteSchema(),
    handler: async (request: any) => {
      return success(store.listStyleGuide(request.params.projectId), request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/constraints',
    schema: projectRouteSchema({ body: constraintBodySchema }),
    handler: async (request: any, reply: any) => {
      const input = validateBody(createConstraintSchema, request, reply)
      if (!input) return reply

      const constraint = store.createConstraint({
        id: randomUUID(),
        projectId: request.params.projectId,
        isActive: true,
        ...input,
      })
      return success(constraint, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/constraints',
    schema: projectRouteSchema(),
    handler: async (request: any) => {
      return success(store.listConstraints(request.params.projectId), request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/info-layers',
    schema: projectRouteSchema({ body: infoLayerBodySchema }),
    handler: async (request: any, reply: any) => {
      const input = validateBody(createInfoLayerSchema, request, reply)
      if (!input) return reply

      const { linkedForeshadows, ...rest } = input
      const layer = store.createInformationLayer({
        id: randomUUID(),
        projectId: request.params.projectId,
        characterKnowledge: '{}',
        isRevealed: false,
        ...rest,
      } as any)
      // -- 关联字段改为创建 edges（不再写入 DB）--
      if (linkedForeshadows) {
        for (const fsId of linkedForeshadows) {
          store.createEdge(request.params.projectId, { sourceId: fsId, sourceType: 'foreshadow', targetId: layer.id, targetType: 'info_layer', edgeType: 'related', label: '承载信息差' } as any)
        }
      }
      return success(layer, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/info-layers',
    schema: projectRouteSchema(),
    handler: async (request: any) => {
      return success(store.listInformationLayers(request.params.projectId), request.traceId)
    },
  })

  routes.push({
    method: 'PATCH',
    path: '/info-layers/:id',
    schema: projectRouteSchema({ params: entityParamsSchema, body: infoLayerPatchBodySchema }),
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateInfoLayerSchema, request, reply)
      if (!input) return reply
      const updated = store.updateInfoLayer(request.params.id, input as Partial<NovelInformationLayer>)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `信息差不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/foreshadow-info-layer-links',
    schema: projectRouteSchema({ body: infoLayerLinkBodySchema }),
    handler: async (request: any, reply: any) => {
      const input = validateBody(linkForeshadowInfoLayerSchema, request, reply)
      if (!input) return reply
      if (!store.getForeshadow(input.foreshadowId)) {
        throw new AppError(ErrorCode.NOT_FOUND, `伏笔不存在: ${input.foreshadowId}`, 404)
      }
      if (!store.listInformationLayers(request.params.projectId).some((layer) => layer.id === input.infoLayerId)) {
        throw new AppError(ErrorCode.NOT_FOUND, `信息差不存在: ${input.infoLayerId}`, 404)
      }
      store.createEdge(request.params.projectId, {
        sourceId: input.foreshadowId,
        sourceType: 'foreshadow',
        targetId: input.infoLayerId,
        targetType: 'info_layer',
        edgeType: 'related',
        label: '关联信息差',
      } as any)
      return success({ foreshadowId: input.foreshadowId, infoLayerId: input.infoLayerId, linked: true }, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/projects/:projectId/foreshadow-info-layer-links',
    schema: projectRouteSchema({ querystring: linkQuerySchema }),
    handler: async (request: any) => {
      const query = (request.query ?? {}) as Record<string, string | undefined>
      const foreshadowId = query.foreshadowId
      const infoLayerId = query.infoLayerId
      if (!foreshadowId || !infoLayerId) {
        throw new AppError(ErrorCode.BAD_REQUEST, '需要提供 foreshadowId 和 infoLayerId 查询参数', 400)
      }
      const edges = store.listEdgesByEntity(foreshadowId, { edgeType: 'related' })
        .filter((edge) =>
          (edge.sourceId === foreshadowId && edge.targetId === infoLayerId)
          || (edge.sourceId === infoLayerId && edge.targetId === foreshadowId),
        )
      for (const edge of edges) store.deleteEdge(edge.id)
      return success({ foreshadowId, infoLayerId, linked: false }, request.traceId)
    },
  })

  return routes
}
