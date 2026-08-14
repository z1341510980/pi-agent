import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { z } from 'zod'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import type { NovelNodeType, NovelEdgeType } from '@repo/shared/novel'

/** Canvas persistence and derived relationship graph queries. */
export function createGraphRoutes(services: NovelServices): RouteDefinition[] {
  const { store, relationshipGraph, consistencyAuditor } = services
  const nodePositionSchema = z.object({
    positions: z.array(z.object({
      nodeType: z.enum(['project', 'character', 'chapter', 'conflict', 'foreshadow', 'group', 'faction', 'location', 'world_element']),
      entityId: z.string().min(1), posX: z.number(), posY: z.number(),
    })).min(1),
  })
  const edgeSchema = z.object({
    sourceId: z.string().min(1),
    sourceType: z.enum(['project', 'character', 'chapter', 'conflict', 'foreshadow', 'group', 'faction', 'location', 'world_element', 'clue', 'item', 'info_layer', 'hook']),
    targetId: z.string().min(1),
    targetType: z.enum(['project', 'character', 'chapter', 'conflict', 'foreshadow', 'group', 'faction', 'location', 'world_element', 'clue', 'item', 'info_layer', 'hook']),
    edgeType: z.enum(['appearance', 'relationship', 'involvement', 'foreshadow', 'base', 'member', 'hierarchy', 'association', 'related', 'mentor', 'kinship', 'rivalry', 'alliance', 'subordinate', 'trigger', 'causality']),
    label: z.string().default(''), auto: z.boolean().default(false),
  })
  return [
    { method: 'GET', path: '/projects/:projectId/node-positions', handler: async (request: any) => success(store.listNodePositions(request.params.projectId), request.traceId) },
    { method: 'PUT', path: '/projects/:projectId/node-positions', handler: async (request: any, reply: any) => {
      const input = validateBody(nodePositionSchema, request, reply); if (!input) return reply
      const positions = input.positions.map((position) => store.upsertNodePosition(request.params.projectId, position.nodeType as NovelNodeType, position.entityId, position.posX, position.posY))
      return success({ upserted: positions.length, positions }, request.traceId)
    } },
    { method: 'DELETE', path: '/projects/:projectId/node-positions/:nodeType/:entityId', handler: async (request: any) => {
      const { projectId, nodeType, entityId } = request.params as { projectId: string; nodeType: string; entityId: string }
      if (!store.deleteNodePosition(projectId, nodeType as NovelNodeType, entityId)) throw new AppError(ErrorCode.NOT_FOUND, `节点位置不存在: ${nodeType}:${entityId}`, 404)
      return success({ projectId, nodeType, entityId, deleted: true }, request.traceId)
    } },
    { method: 'GET', path: '/projects/:projectId/edges', handler: async (request: any) => {
      const projectId = request.params.projectId; const entityId = (request.query ?? {}).entityId as string | undefined
      return success(entityId ? store.listEdgesByEntity(entityId) : store.listEdges(projectId), request.traceId)
    } },
    { method: 'POST', path: '/projects/:projectId/edges', handler: async (request: any, reply: any) => {
      const input = validateBody(edgeSchema, request, reply); if (!input) return reply
      return success(store.createEdge(request.params.projectId, input), request.traceId)
    } },
    { method: 'DELETE', path: '/edges/:id', handler: async (request: any) => {
      if (!store.deleteEdge(request.params.id)) throw new AppError(ErrorCode.NOT_FOUND, `连线不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    } },
    { method: 'PATCH', path: '/edges/:id', handler: async (request: any, reply: any) => {
      const body = validateBody(z.object({ label: z.string() }), request, reply); if (!body) return reply
      const updated = store.updateEdgeLabel(request.params.id, body.label)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `连线不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    } },
    { method: 'GET', path: '/projects/:projectId/graph/nodes', handler: async (request: any) => success(relationshipGraph.getAllGraphNodes(request.params.projectId), request.traceId) },
    { method: 'GET', path: '/projects/:projectId/graph/edges', handler: async (request: any) => success(relationshipGraph.getAllGraphEdges(request.params.projectId), request.traceId) },
    { method: 'GET', path: '/graph/neighbors/:entityId', handler: async (request: any) => {
      const query = (request.query ?? {}) as { edgeTypes?: string }; const edgeTypes = query.edgeTypes ? query.edgeTypes.split(',').filter(Boolean) as NovelEdgeType[] : undefined
      return success(relationshipGraph.findNeighbors(request.params.entityId, edgeTypes), request.traceId)
    } },
    { method: 'GET', path: '/graph/path/:fromId/:toId', handler: async (request: any) => {
      const maxDepth = (request.query ?? {}).maxDepth ? parseInt(String(request.query.maxDepth), 10) : 4
      return success(relationshipGraph.findPath(request.params.fromId, request.params.toId, maxDepth), request.traceId)
    } },
    { method: 'GET', path: '/graph/entity-chapters/:entityId', handler: async (request: any) => {
      const entityType = ((request.query ?? {}).entityType ?? 'character') as NovelNodeType
      const result = relationshipGraph.findEntityChapters(request.params.entityId, entityType)
      if (!result) throw new AppError(ErrorCode.NOT_FOUND, `实体不存在: ${request.params.entityId}`, 404)
      return success(result, request.traceId)
    } },
    { method: 'GET', path: '/projects/:projectId/consistency-report', handler: async (request: any) => success(consistencyAuditor.audit(request.params.projectId), request.traceId) },
  ]
}
