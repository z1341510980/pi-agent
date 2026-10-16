import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

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

/** Routes for factions, locations, items, and world-building elements. */
export function createWorldEntityRoutes(services: NovelServices): RouteDefinition[] {
  const { store } = services
  const routes: RouteDefinition[] = []

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/factions',
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
    handler: async (request: any) => success(store.listFactions(request.params.projectId), request.traceId),
  })
  routes.push({
    method: 'PATCH',
    path: '/factions/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createFactionSchema.partial(), request, reply)
      if (!input) return reply
      const updated = store.updateFaction(request.params.id, input)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `势力不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/locations',
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
    handler: async (request: any) => success(store.listLocations(request.params.projectId), request.traceId),
  })
  routes.push({
    method: 'PATCH',
    path: '/locations/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createLocationSchema.partial(), request, reply)
      if (!input) return reply
      const updated = store.updateLocation(request.params.id, input)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `地点不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/items',
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
    handler: async (request: any) => success(store.listItems(request.params.projectId), request.traceId),
  })
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/items/by-owner/:ownerId',
    handler: async (request: any) => success(store.listItemsByOwner(request.params.ownerId), request.traceId),
  })
  routes.push({
    method: 'PATCH',
    path: '/items/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createItemSchema.partial(), request, reply)
      if (!input) return reply
      const updated = store.updateItem(request.params.id, input)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `物品不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/world-elements',
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
    handler: async (request: any) => success(store.listWorldElements(request.params.projectId), request.traceId),
  })
  routes.push({
    method: 'PATCH',
    path: '/world-elements/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createWorldElementSchema.partial(), request, reply)
      if (!input) return reply
      const updated = store.updateWorldElement(request.params.id, input)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `世界观要素不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  return routes
}
