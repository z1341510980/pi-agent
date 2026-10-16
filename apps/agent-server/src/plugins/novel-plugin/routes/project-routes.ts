import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { randomUUID } from 'node:crypto'
import { success } from '../../../lib/api-response.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { parseNovelModelRef } from '../core/domain/novel-model-ref.js'
import { emptyQuerySchema, standardResponseSchema } from './route-contracts.js'
import { createProjectBodySchema, projectIdParamsSchema, updateProjectBodySchema } from './project-route-schemas.js'

/** Project lifecycle routes: creation, editing and recycle-bin operations. */
export function createProjectRoutes(services: NovelServices): RouteDefinition[] {
  const { store, orchestrator } = services
  const routes: RouteDefinition[] = []
  routes.push({ method: 'POST', path: '/projects', schema: { querystring: emptyQuerySchema, body: createProjectBodySchema, response: standardResponseSchema }, handler: async (request: any) => {
    const input = request.body
    const project = store.createProject({ id: randomUUID(), ...input, currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active' })
    return success(project, request.traceId)
  } })
  routes.push({ method: 'GET', path: '/projects', schema: { querystring: emptyQuerySchema, response: standardResponseSchema }, handler: async (request: any) => success(store.listProjects(), request.traceId) })
  routes.push({ method: 'GET', path: '/projects/:id', schema: { params: projectIdParamsSchema, querystring: emptyQuerySchema, response: standardResponseSchema }, handler: async (request: any) => {
    const project = store.getProject(request.params.id)
    if (!project) throw new AppError(ErrorCode.NOT_FOUND, `项目不存在: ${request.params.id}`, 404)
    return success(project, request.traceId)
  } })
  routes.push({ method: 'PATCH', path: '/projects/:id', schema: { params: projectIdParamsSchema, querystring: emptyQuerySchema, body: updateProjectBodySchema, response: standardResponseSchema }, handler: async (request: any) => {
    const input = request.body
    if (input.novelModelId !== undefined && input.novelModelId !== null && !parseNovelModelRef(input.novelModelId)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '需为 "provider:modelId" 复合串', 400)
    }
    const updated = store.updateProject(request.params.id, input)
    if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `项目不存在: ${request.params.id}`, 404)
    return success(updated, request.traceId)
  } })
  routes.push({ method: 'DELETE', path: '/projects/:id', schema: { params: projectIdParamsSchema, querystring: emptyQuerySchema, response: standardResponseSchema }, handler: async (request: any) => {
    const deleted = store.deleteProject(request.params.id)
    if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `项目不存在或已在回收站: ${request.params.id}`, 404)
    orchestrator.chunkCache.clearProject(request.params.id)
    return success({ id: request.params.id, trashed: true }, request.traceId)
  } })
  routes.push({ method: 'GET', path: '/projects/trash', schema: { querystring: emptyQuerySchema, response: standardResponseSchema }, handler: async (request: any) => success({ projects: store.listTrashedProjects() }, request.traceId) })
  routes.push({ method: 'POST', path: '/projects/:id/restore', schema: { params: projectIdParamsSchema, querystring: emptyQuerySchema, response: standardResponseSchema }, handler: async (request: any) => {
    if (!store.restoreProject(request.params.id)) throw new AppError(ErrorCode.NOT_FOUND, `项目不在回收站: ${request.params.id}`, 404)
    return success({ id: request.params.id, restored: true }, request.traceId)
  } })
  routes.push({ method: 'DELETE', path: '/projects/:id/purge', schema: { params: projectIdParamsSchema, querystring: emptyQuerySchema, response: standardResponseSchema }, handler: async (request: any) => {
    if (!store.purgeProject(request.params.id)) throw new AppError(ErrorCode.NOT_FOUND, `项目不在回收站: ${request.params.id}`, 404)
    return success({ id: request.params.id, purged: true }, request.traceId)
  } })
  routes.push({ method: 'DELETE', path: '/projects/trash/empty', schema: { querystring: emptyQuerySchema, response: standardResponseSchema }, handler: async (request: any) => success({ emptied: true, count: store.emptyTrash() }, request.traceId) })
  return routes
}
