import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Type } from 'typebox'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { emptyQuerySchema, standardResponseSchema } from './route-contracts.js'

const projectParamsSchema = Type.Object({ projectId: Type.String({ minLength: 1 }) })
const entityParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) })
const ownerParamsSchema = Type.Object({
  projectId: Type.String({ minLength: 1 }),
  ownerId: Type.String({ minLength: 1 }),
})

const factionBodySchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String({ default: '' })),
  type: Type.Optional(Type.Union([
    Type.Literal('organization'), Type.Literal('sect'), Type.Literal('kingdom'),
    Type.Literal('family'), Type.Literal('guild'), Type.Literal('cult'),
  ], { default: 'organization' })),
  leaderId: Type.Optional(Type.Union([Type.String(), Type.Null()], { default: null })),
  ideology: Type.Optional(Type.String({ default: '' })),
  strength: Type.Optional(Type.Union([
    Type.Literal('weak'), Type.Literal('medium'), Type.Literal('strong'), Type.Literal('overwhelming'),
  ], { default: 'medium' })),
  resources: Type.Optional(Type.Array(Type.String(), { default: [] })),
  allies: Type.Optional(Type.Array(Type.String(), { default: [] })),
  enemies: Type.Optional(Type.Array(Type.String(), { default: [] })),
  status: Type.Optional(Type.Union([
    Type.Literal('active'), Type.Literal('declined'), Type.Literal('destroyed'), Type.Literal('hidden'),
  ], { default: 'active' })),
  chapterSpans: Type.Optional(Type.Array(Type.Tuple([Type.Integer(), Type.Integer()]), { default: [] })),
}, { additionalProperties: false })

const locationBodySchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String({ default: '' })),
  type: Type.Optional(Type.Union([
    Type.Literal('continent'), Type.Literal('country'), Type.Literal('city'),
    Type.Literal('building'), Type.Literal('dungeon'), Type.Literal('region'), Type.Literal('wilderness'),
  ], { default: 'city' })),
  parentId: Type.Optional(Type.Union([Type.String(), Type.Null()], { default: null })),
  factionId: Type.Optional(Type.Union([Type.String(), Type.Null()], { default: null })),
  significance: Type.Optional(Type.Union([
    Type.Literal('minor'), Type.Literal('moderate'), Type.Literal('major'), Type.Literal('critical'),
  ], { default: 'minor' })),
  firstChapter: Type.Optional(Type.Union([Type.Integer(), Type.Null()], { default: null })),
  status: Type.Optional(Type.Union([
    Type.Literal('normal'), Type.Literal('destroyed'), Type.Literal('changed'), Type.Literal('hidden'),
  ], { default: 'normal' })),
  appearChapters: Type.Optional(Type.Array(Type.Integer(), { default: [] })),
}, { additionalProperties: false })

const itemBodySchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String({ default: '' })),
  type: Type.Optional(Type.Union([
    Type.Literal('weapon'), Type.Literal('armor'), Type.Literal('artifact'), Type.Literal('consumable'),
    Type.Literal('key'), Type.Literal('material'), Type.Literal('info'), Type.Literal('misc'),
  ], { default: 'misc' })),
  ownerId: Type.Optional(Type.Union([Type.String(), Type.Null()], { default: null })),
  status: Type.Optional(Type.Union([
    Type.Literal('active'), Type.Literal('lost'), Type.Literal('destroyed'), Type.Literal('transformed'),
    Type.Literal('sealed'), Type.Literal('transferred'),
  ], { default: 'active' })),
  abilities: Type.Optional(Type.String({ default: '' })),
  origin: Type.Optional(Type.String({ default: '' })),
  firstChapter: Type.Optional(Type.Union([Type.Integer(), Type.Null()], { default: null })),
  chapterSpans: Type.Optional(Type.Array(Type.Tuple([Type.Integer(), Type.Integer()]), { default: [] })),
}, { additionalProperties: false })

const worldElementBodySchema = Type.Object({
  category: Type.Union([
    Type.Literal('power_system'), Type.Literal('history'), Type.Literal('culture'),
    Type.Literal('religion'), Type.Literal('technology'), Type.Literal('economy'), Type.Literal('geography'),
  ]),
  name: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String({ default: '' })),
  parentId: Type.Optional(Type.Union([Type.String(), Type.Null()], { default: null })),
  attributes: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { default: {} })),
}, { additionalProperties: false })

function removeSchemaDefaults(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(removeSchemaDefaults)
    return
  }
  if (!value || typeof value !== 'object') return
  const schema = value as Record<string, unknown>
  delete schema.default
  Object.values(schema).forEach(removeSchemaDefaults)
}

function createPatchBodySchema(schema: object): Record<string, unknown> {
  const patchSchema = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>
  delete patchSchema.required
  removeSchemaDefaults(patchSchema)
  return patchSchema
}

const factionPatchBodySchema = createPatchBodySchema(factionBodySchema)
const locationPatchBodySchema = createPatchBodySchema(locationBodySchema)
const itemPatchBodySchema = createPatchBodySchema(itemBodySchema)
const worldElementPatchBodySchema = createPatchBodySchema(worldElementBodySchema)

const projectRouteSchema = (body?: object) => ({
  params: projectParamsSchema,
  querystring: emptyQuerySchema,
  ...(body ? { body } : {}),
  response: standardResponseSchema,
})

const entityRouteSchema = (body: object) => ({
  params: entityParamsSchema,
  querystring: emptyQuerySchema,
  body,
  response: standardResponseSchema,
})

const createFactionSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  type: z.enum(['organization', 'sect', 'kingdom', 'family', 'guild', 'cult']).default('organization'),
  leaderId: z.string().nullable().default(null),
  ideology: z.string().default(''),
  strength: z.enum(['weak', 'medium', 'strong', 'overwhelming']).default('medium'),
  resources: z.array(z.string()).default([]),
  allies: z.array(z.string()).default([]),
  enemies: z.array(z.string()).default([]),
  status: z.enum(['active', 'declined', 'destroyed', 'hidden']).default('active'),
  chapterSpans: z.array(z.tuple([z.number().int(), z.number().int()])).default([]),
})

const createLocationSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  type: z.enum(['continent', 'country', 'city', 'building', 'dungeon', 'region', 'wilderness']).default('city'),
  parentId: z.string().nullable().default(null),
  factionId: z.string().nullable().default(null),
  significance: z.enum(['minor', 'moderate', 'major', 'critical']).default('minor'),
  firstChapter: z.number().int().nullable().default(null),
  status: z.enum(['normal', 'destroyed', 'changed', 'hidden']).default('normal'),
  appearChapters: z.array(z.number().int()).default([]),
})

const createItemSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  type: z.enum(['weapon', 'armor', 'artifact', 'consumable', 'key', 'material', 'info', 'misc']).default('misc'),
  ownerId: z.string().nullable().default(null),
  status: z.enum(['active', 'lost', 'destroyed', 'transformed', 'sealed', 'transferred']).default('active'),
  abilities: z.string().default(''),
  origin: z.string().default(''),
  firstChapter: z.number().int().nullable().default(null),
  chapterSpans: z.array(z.tuple([z.number().int(), z.number().int()])).default([]),
})

const createWorldElementSchema = z.object({
  category: z.enum(['power_system', 'history', 'culture', 'religion', 'technology', 'economy', 'geography']),
  name: z.string().min(1),
  description: z.string().default(''),
  parentId: z.string().nullable().default(null),
  attributes: z.record(z.string(), z.unknown()).default({}),
})

const updateFactionSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  type: z.enum(['organization', 'sect', 'kingdom', 'family', 'guild', 'cult']).optional(),
  leaderId: z.string().nullable().optional(),
  ideology: z.string().optional(),
  strength: z.enum(['weak', 'medium', 'strong', 'overwhelming']).optional(),
  resources: z.array(z.string()).optional(),
  allies: z.array(z.string()).optional(),
  enemies: z.array(z.string()).optional(),
  status: z.enum(['active', 'declined', 'destroyed', 'hidden']).optional(),
  chapterSpans: z.array(z.tuple([z.number().int(), z.number().int()])).optional(),
})

const updateLocationSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  type: z.enum(['continent', 'country', 'city', 'building', 'dungeon', 'region', 'wilderness']).optional(),
  parentId: z.string().nullable().optional(),
  factionId: z.string().nullable().optional(),
  significance: z.enum(['minor', 'moderate', 'major', 'critical']).optional(),
  firstChapter: z.number().int().nullable().optional(),
  status: z.enum(['normal', 'destroyed', 'changed', 'hidden']).optional(),
  appearChapters: z.array(z.number().int()).optional(),
})

const updateItemSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  type: z.enum(['weapon', 'armor', 'artifact', 'consumable', 'key', 'material', 'info', 'misc']).optional(),
  ownerId: z.string().nullable().optional(),
  status: z.enum(['active', 'lost', 'destroyed', 'transformed', 'sealed', 'transferred']).optional(),
  abilities: z.string().optional(),
  origin: z.string().optional(),
  firstChapter: z.number().int().nullable().optional(),
  chapterSpans: z.array(z.tuple([z.number().int(), z.number().int()])).optional(),
})

const updateWorldElementSchema = z.object({
  category: z.enum(['power_system', 'history', 'culture', 'religion', 'technology', 'economy', 'geography']).optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  parentId: z.string().nullable().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
})

/** Routes for factions, locations, items, and world-building elements. */
export function createWorldEntityRoutes(services: NovelServices): RouteDefinition[] {
  const { store } = services
  const routes: RouteDefinition[] = []

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/factions',
    schema: projectRouteSchema(factionBodySchema),
    handler: async (request: any, reply: any) => {
      const input = validateBody(createFactionSchema, request, reply)
      if (!input) return reply
      const faction = store.createFaction({ id: randomUUID(), projectId: request.params.projectId, ...input })
      return success(faction, request.traceId)
    },
  })
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/factions',
    schema: projectRouteSchema(),
    handler: async (request: any) => success(store.listFactions(request.params.projectId), request.traceId),
  })
  routes.push({
    method: 'PATCH',
    path: '/factions/:id',
    schema: entityRouteSchema(factionPatchBodySchema),
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateFactionSchema, request, reply)
      if (!input) return reply
      const updated = store.updateFaction(request.params.id, input)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `势力不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/locations',
    schema: projectRouteSchema(locationBodySchema),
    handler: async (request: any, reply: any) => {
      const input = validateBody(createLocationSchema, request, reply)
      if (!input) return reply
      const location = store.createLocation({ id: randomUUID(), projectId: request.params.projectId, ...input })
      return success(location, request.traceId)
    },
  })
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/locations',
    schema: projectRouteSchema(),
    handler: async (request: any) => success(store.listLocations(request.params.projectId), request.traceId),
  })
  routes.push({
    method: 'PATCH',
    path: '/locations/:id',
    schema: entityRouteSchema(locationPatchBodySchema),
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateLocationSchema, request, reply)
      if (!input) return reply
      const updated = store.updateLocation(request.params.id, input)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `地点不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/items',
    schema: projectRouteSchema(itemBodySchema),
    handler: async (request: any, reply: any) => {
      const input = validateBody(createItemSchema, request, reply)
      if (!input) return reply
      const item = store.createItem({ id: randomUUID(), projectId: request.params.projectId, ...input })
      return success(item, request.traceId)
    },
  })
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/items',
    schema: projectRouteSchema(),
    handler: async (request: any) => success(store.listItems(request.params.projectId), request.traceId),
  })
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/items/by-owner/:ownerId',
    schema: { params: ownerParamsSchema, querystring: emptyQuerySchema, response: standardResponseSchema },
    handler: async (request: any) => success(store.listItemsByOwner(request.params.ownerId), request.traceId),
  })
  routes.push({
    method: 'PATCH',
    path: '/items/:id',
    schema: entityRouteSchema(itemPatchBodySchema),
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateItemSchema, request, reply)
      if (!input) return reply
      const updated = store.updateItem(request.params.id, input)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `物品不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/world-elements',
    schema: projectRouteSchema(worldElementBodySchema),
    handler: async (request: any, reply: any) => {
      const input = validateBody(createWorldElementSchema, request, reply)
      if (!input) return reply
      const element = store.createWorldElement({ id: randomUUID(), projectId: request.params.projectId, ...input })
      return success(element, request.traceId)
    },
  })
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/world-elements',
    schema: projectRouteSchema(),
    handler: async (request: any) => success(store.listWorldElements(request.params.projectId), request.traceId),
  })
  routes.push({
    method: 'PATCH',
    path: '/world-elements/:id',
    schema: entityRouteSchema(worldElementPatchBodySchema),
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateWorldElementSchema, request, reply)
      if (!input) return reply
      const updated = store.updateWorldElement(request.params.id, input)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `世界观要素不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  return routes
}
