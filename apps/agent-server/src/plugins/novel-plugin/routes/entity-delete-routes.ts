import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import { Type } from 'typebox'
import type { NovelServices } from '../novel-services.js'
import { success } from '../../../lib/api-response.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { activeNovelChapterTasks, chapterCreationLocks } from '../utils/chapter-task-registry.js'
import { emptyQuerySchema, standardResponseSchema } from './route-contracts.js'

const entityParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) })
const chapterParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) })

type DeleteEntity = (id: string) => boolean

function deleteRoute(path: string, label: string, remove: DeleteEntity): RouteDefinition {
  return {
    method: 'DELETE',
    path,
    schema: { params: entityParamsSchema, querystring: emptyQuerySchema, response: standardResponseSchema },
    handler: async (request: any) => {
      if (!remove(request.params.id)) throw new AppError(ErrorCode.NOT_FOUND, `${label}不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  }
}

/** Shared deletion endpoints for entities whose Store owns the cascade rules. */
export function createEntityDeleteRoutes(services: NovelServices): RouteDefinition[] {
  const { store } = services
  return [
    {
      method: 'DELETE',
      path: '/chapters/:id',
      schema: { params: chapterParamsSchema, querystring: emptyQuerySchema, response: standardResponseSchema },
      handler: async (request: any) => {
        const chapter = store.getChapterById(request.params.id)
        if (!chapter) throw new AppError(ErrorCode.NOT_FOUND, `章节不存在: ${request.params.id}`, 404)
        if (chapter.status === 'published') throw new AppError(ErrorCode.CONFLICT, '已发布章节不能删除，请先进入修订或撤回流程', 409)
        // 运行互斥：该章有创作流程/讨论/AI 编排正在跑时禁止删除，
        // 否则流程后续阶段（Memory/Finalizer 写 chapter_id NOT NULL 的表）会炸进 error 终态
        const lockKey = `${chapter.projectId}:${chapter.chapterNumber}`
        if (chapterCreationLocks.has(lockKey) || activeNovelChapterTasks.has(lockKey)) {
          throw new AppError(ErrorCode.CONFLICT, '该章节正在创作流程中运行，请先停止流程后再删除', 409)
        }
        if (!store.deleteChapter(request.params.id)) throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, '删除章节失败', 500)
        // 进程内清理：重排后其余章号左移，残留的检查点指令（key 无 runId 维度）
        // 会被左移后的新章误注入；chunk 缓存按项目清空重建（旧章的上下文 chunk 不再按章可寻址）
        services.orchestrator.clearStalePendingUserMessages(chapter.projectId, chapter.chapterNumber)
        services.orchestrator.chunkCache.clearProject(chapter.projectId)
        return success({ id: request.params.id, deleted: true }, request.traceId)
      },
    },
    deleteRoute('/characters/:id', '角色', (id) => store.deleteCharacter(id)),
    deleteRoute('/foreshadowing/:id', '伏笔', (id) => store.deleteForeshadow(id)),
    deleteRoute('/conflicts/:id', '冲突', (id) => store.deleteConflict(id)),
    deleteRoute('/clues/:id', '线索', (id) => store.deleteClue(id)),
    deleteRoute('/relationships/:id', '关系', (id) => store.deleteRelationship(id)),
    deleteRoute('/world-rules/:id', '世界规则', (id) => store.deleteWorldRule(id)),
    deleteRoute('/style-guides/:id', '风格指南', (id) => store.deleteStyleGuide(id)),
    deleteRoute('/constraints/:id', '创作约束', (id) => store.deleteConstraint(id)),
    deleteRoute('/info-layers/:id', '信息差', (id) => store.deleteInfoLayer(id)),
    deleteRoute('/factions/:id', '势力', (id) => store.deleteFaction(id)),
    deleteRoute('/locations/:id', '地点', (id) => store.deleteLocation(id)),
    deleteRoute('/world-elements/:id', '世界观要素', (id) => store.deleteWorldElement(id)),
    deleteRoute('/items/:id', '物品', (id) => store.deleteItem(id)),
  ]
}
