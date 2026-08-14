import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

/** Project lifecycle routes: creation, editing and recycle-bin operations. */
export function createProjectRoutes(services: NovelServices): RouteDefinition[] {
  const { store, orchestrator } = services
  const routes: RouteDefinition[] = []
  const createProjectSchema = z.object({
    title: z.string().min(1).max(200),
    genre: z.string().min(1).max(50),
    synopsis: z.string().max(5000).default(''),
    targetWords: z.number().int().min(0).default(0),
    targetPlatform: z.enum(['fanqie', 'qidian', 'zhihu_yanyan', 'general']).optional(),
    novelAskStoryPolicy: z.enum(['legacy', 'directorReviewerOff', 'allOffWithReferences']).nullable().optional(),
  })
  routes.push({ method: 'POST', path: '/projects', handler: async (request: any, reply: any) => {
    const input = validateBody(createProjectSchema, request, reply); if (!input) return reply
    const project = store.createProject({ id: randomUUID(), ...input, currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active' })
    return success(project, request.traceId)
  } })
  routes.push({ method: 'GET', path: '/projects', handler: async (request: any) => success(store.listProjects(), request.traceId) })
  routes.push({ method: 'GET', path: '/projects/:id', handler: async (request: any) => {
    const project = store.getProject(request.params.id)
    if (!project) throw new AppError(ErrorCode.NOT_FOUND, `项目不存在: ${request.params.id}`, 404)
    return success(project, request.traceId)
  } })
  const updateProjectSchema = createProjectSchema.partial().extend({
    currentVolume: z.number().int().min(1).optional(), currentChapter: z.number().int().min(0).optional(),
    currentStage: z.enum(['setup', 'rising', 'climax', 'falling', 'resolution']).optional(),
    status: z.enum(['active', 'paused', 'completed']).optional(), outline: z.string().max(20000).optional(),
    targetPlatform: z.enum(['fanqie', 'qidian', 'zhihu_yanyan', 'general']).nullable().optional(),
    novelAskStoryPolicy: z.enum(['legacy', 'directorReviewerOff', 'allOffWithReferences']).nullable().optional(),
  })
  routes.push({ method: 'PATCH', path: '/projects/:id', handler: async (request: any, reply: any) => {
    const input = validateBody(updateProjectSchema, request, reply); if (!input) return reply
    const updated = store.updateProject(request.params.id, input)
    if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `项目不存在: ${request.params.id}`, 404)
    return success(updated, request.traceId)
  } })
  routes.push({ method: 'DELETE', path: '/projects/:id', handler: async (request: any) => {
    const deleted = store.deleteProject(request.params.id)
    if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `项目不存在或已在回收站: ${request.params.id}`, 404)
    orchestrator.chunkCache.clearProject(request.params.id)
    return success({ id: request.params.id, trashed: true }, request.traceId)
  } })
  routes.push({ method: 'GET', path: '/projects/trash', handler: async (request: any) => success({ projects: store.listTrashedProjects() }, request.traceId) })
  routes.push({ method: 'POST', path: '/projects/:id/restore', handler: async (request: any) => {
    if (!store.restoreProject(request.params.id)) throw new AppError(ErrorCode.NOT_FOUND, `项目不在回收站: ${request.params.id}`, 404)
    return success({ id: request.params.id, restored: true }, request.traceId)
  } })
  routes.push({ method: 'DELETE', path: '/projects/:id/purge', handler: async (request: any) => {
    if (!store.purgeProject(request.params.id)) throw new AppError(ErrorCode.NOT_FOUND, `项目不在回收站: ${request.params.id}`, 404)
    return success({ id: request.params.id, purged: true }, request.traceId)
  } })
  routes.push({ method: 'DELETE', path: '/projects/trash/empty', handler: async (request: any) => success({ emptied: true, count: store.emptyTrash() }, request.traceId) })
  return routes
}
