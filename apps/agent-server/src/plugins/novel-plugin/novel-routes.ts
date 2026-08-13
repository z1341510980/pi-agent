/**
 * 小说创作系统 REST API 路由
 *
 * 从 routes/novel.route.ts 迁移而来，改为通过 RouteDefinition[] 数组注册。
 *
 * 路径变化（插件路由自动加 /api/plugins/novel 前缀）：
 * - /api/novel/projects → /projects
 * - /api/novel/projects/:projectId/chapters → /projects/:projectId/chapters
 * - /api/novel/chapters/:id → /chapters/:id
 * - /api/novel/prompts → /prompts
 *
 * handler 通过 services 闭包访问 store / promptManager / engine，
 * 不再依赖 app.novelStore 等 Fastify 装饰器。
 */

import type { RouteDefinition } from '../../core/plugin/plugin-types.js'
import type { NovelServices } from './novel-services.js'
import type { NovelInformationLayer } from './core/types.js'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { success } from '../../lib/api-response.js'
import { validateBody } from '../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import type { NovelNodeType, NovelEdgeType } from '@repo/shared/novel'
import { evaluateProseQuality } from './core/prose-quality-evaluator.js'
import { buildCacheLayerReport, diagnoseChapterCache } from './core/cache-layer-diagnostics.js'
import { createNovelAgUiEmitter, createSseEmitterSink } from './utils/sse-emitter.js'
import { createChapterRoutes } from './routes/chapter-routes.js'
import { createCharacterRoutes } from './routes/character-routes.js'
import { createEntityCandidateRoutes } from './routes/entity-candidate-routes.js'
import { createCreationFlowRoutes } from './routes/creation-flow-routes.js'
import { createStoryLedgerRoutes } from './routes/story-ledger-routes.js'
import { createReferenceAnalysisRoutes } from './routes/reference-analysis-routes.js'
import { createContextPreviewRoutes } from './routes/context-preview-routes.js'

/**
 * 创建小说系统 REST API 路由
 *
 * PR-6 路由聚合入口：高密度模块已拆分到 routes/ 子目录，
 * 此处保留项目管理、通用实体、伏笔/冲突/线索/关系、图谱、记忆事件等剩余路由。
 *
 * 拆分清单（按路由注册顺序）：
 * - 章节 CRUD + 版本历史 + 节奏控制 → ./routes/chapter-routes.ts
 * - 角色 CRUD + AI 生成 + 历史 + 弧光 → ./routes/character-routes.ts
 * - 创作流程 SSE + 检查点 + 群聊 + ai-arrange + markers + agent-config + chat
 *   → ./routes/creation-flow-routes.ts
 *
 * 模块级单例状态（aiArrangeLocks / chapterCreationLocks / activeNovelChapterTasks）
 * 与 SSE 工具（createNovelAgUiEmitter / createSseEmitterSink）已迁至 ./utils/，
 * 由各子路由文件共享同一实例。
 */
export function createNovelRoutes(services: NovelServices): RouteDefinition[] {
  const { store, memoryStore, promptManager, promptBuilder, relationshipGraph, consistencyAuditor, orchestrator } = services
  const routes: RouteDefinition[] = [
    ...createStoryLedgerRoutes(services),
    ...createReferenceAnalysisRoutes(services),
  ]

  // P1 可观测性：context-preview 端点，预览 prompt-builder 注入的上下文结构
  // T03-8：p3/context-report 端点（灰度看板聚合，engine 用于真实构建 constraints）
  routes.push(...createContextPreviewRoutes(promptBuilder, store, services.engine))

  // C3：统一关系图查询层 + 跨章节一致性审计器已提升到 services 层
  // 与 NovelPromptBuilder 共享同一实例，避免重复实例化和缓存浪费
  void promptBuilder
  void relationshipGraph
  void consistencyAuditor

  // ═══════════════════════════════════════════════════════════════
  // 项目管理
  // ═══════════════════════════════════════════════════════════════

  const createProjectSchema = z.object({
    title: z.string().min(1).max(200),
    genre: z.string().min(1).max(50),
    synopsis: z.string().max(5000).default(''),
    targetWords: z.number().int().min(0).default(0),
    targetPlatform: z.enum(['fanqie', 'qidian', 'zhihu_yanyan', 'general']).optional(),
    novelAskStoryPolicy: z.enum(['legacy', 'directorReviewerOff', 'allOffWithReferences']).nullable().optional(),
  })

  routes.push({
    method: 'POST',
    path: '/projects',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createProjectSchema, request, reply)
      if (!input) return reply

      const project = store.createProject({
        id: randomUUID(),
        ...input,
        currentVolume: 1,
        currentChapter: 0,
        currentStage: 'setup',
        status: 'active',
      })
      return success(project, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects',
    handler: async (request: any) => {
      return success(store.listProjects(), request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:id',
    handler: async (request: any) => {
      const project = store.getProject(request.params.id)
      if (!project) throw new AppError(ErrorCode.NOT_FOUND, `项目不存在: ${request.params.id}`, 404)
      return success(project, request.traceId)
    },
  })

  const updateProjectSchema = createProjectSchema.partial().extend({
    currentVolume: z.number().int().min(1).optional(),
    currentChapter: z.number().int().min(0).optional(),
    currentStage: z.enum(['setup', 'rising', 'climax', 'falling', 'resolution']).optional(),
    status: z.enum(['active', 'paused', 'completed']).optional(),
    outline: z.string().max(20000).optional(),
    targetPlatform: z.enum(['fanqie', 'qidian', 'zhihu_yanyan', 'general']).nullable().optional(),
    novelAskStoryPolicy: z.enum(['legacy', 'directorReviewerOff', 'allOffWithReferences']).nullable().optional(),
  })

  routes.push({
    method: 'PATCH',
    path: '/projects/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateProjectSchema, request, reply)
      if (!input) return reply

      const updated = store.updateProject(request.params.id, input)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `项目不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  // 项目删除：软删除（移入回收站），可恢复
  // DELETE 保留为"移入回收站"语义（用户习惯），purge 用独立端点
  routes.push({
    method: 'DELETE',
    path: '/projects/:id',
    handler: async (request: any) => {
      const deleted = store.deleteProject(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `项目不存在或已在回收站: ${request.params.id}`, 404)
      // P4 §5.6：项目进回收站后其 chunk 缓存不再有效，立刻清掉（否则恢复项目
      // 时可能命中删除前的 chunk，且长跑进程白占内存）。
      orchestrator.chunkCache.clearProject(request.params.id)
      return success({ id: request.params.id, trashed: true }, request.traceId)
    },
  })

  // 回收站：列出已删除项目
  routes.push({
    method: 'GET',
    path: '/projects/trash',
    handler: async (request: any) => {
      const projects = store.listTrashedProjects()
      return success({ projects }, request.traceId)
    },
  })

  // 回收站：恢复项目
  routes.push({
    method: 'POST',
    path: '/projects/:id/restore',
    handler: async (request: any) => {
      const restored = store.restoreProject(request.params.id)
      if (!restored) throw new AppError(ErrorCode.NOT_FOUND, `项目不在回收站: ${request.params.id}`, 404)
      return success({ id: request.params.id, restored: true }, request.traceId)
    },
  })

  // 回收站：永久删除单个项目（不可恢复）
  routes.push({
    method: 'DELETE',
    path: '/projects/:id/purge',
    handler: async (request: any) => {
      const purged = store.purgeProject(request.params.id)
      if (!purged) throw new AppError(ErrorCode.NOT_FOUND, `项目不在回收站: ${request.params.id}`, 404)
      return success({ id: request.params.id, purged: true }, request.traceId)
    },
  })

  // 回收站：清空所有已删除项目
  routes.push({
    method: 'DELETE',
    path: '/projects/trash/empty',
    handler: async (request: any) => {
      const count = store.emptyTrash()
      return success({ emptied: true, count }, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 通用实体删除路由（章节/角色/伏笔/冲突/线索/关系/世界规则/风格指南/约束/信息差）
  // ═══════════════════════════════════════════════════════════════

  routes.push({
    method: 'DELETE',
    path: '/chapters/:id',
    handler: async (request: any) => {
      const chapter = store.getChapterById(request.params.id)
      if (!chapter) throw new AppError(ErrorCode.NOT_FOUND, `章节不存在: ${request.params.id}`, 404)
      if (chapter.status === 'published') {
        throw new AppError(ErrorCode.CONFLICT, '已发布章节不能删除，请先进入修订或撤回流程', 409)
      }
      const deleted = store.deleteChapter(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, '删除章节失败', 500)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/characters/:id',
    handler: async (request: any) => {
      const deleted = store.deleteCharacter(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `角色不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/foreshadowing/:id',
    handler: async (request: any) => {
      const deleted = store.deleteForeshadow(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `伏笔不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/conflicts/:id',
    handler: async (request: any) => {
      const deleted = store.deleteConflict(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `冲突不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/clues/:id',
    handler: async (request: any) => {
      const deleted = store.deleteClue(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `线索不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/relationships/:id',
    handler: async (request: any) => {
      const deleted = store.deleteRelationship(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `关系不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/world-rules/:id',
    handler: async (request: any) => {
      const deleted = store.deleteWorldRule(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `世界规则不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/style-guides/:id',
    handler: async (request: any) => {
      const deleted = store.deleteStyleGuide(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `风格指南不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/constraints/:id',
    handler: async (request: any) => {
      const deleted = store.deleteConstraint(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `创作约束不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/info-layers/:id',
    handler: async (request: any) => {
      const deleted = store.deleteInfoLayer(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `信息差不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  })

  // P3-2：信息差 PATCH（更新字段，不传的字段保持不变）
  routes.push({
    method: 'PATCH',
    path: '/info-layers/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateInfoLayerSchema, request, reply)
      if (!input) return reply
      const updated = store.updateInfoLayer(request.params.id, input as Partial<NovelInformationLayer>)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `信息差不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  // P3-2：建立伏笔↔信息差双向关联
  // 请求体：{ foreshadowId, infoLayerId }
  // 幂等：已关联时返回成功不重复写入
  routes.push({
    method: 'POST',
    path: '/projects/:projectId/foreshadow-info-layer-links',
    handler: async (request: any, reply: any) => {
      const input = validateBody(linkForeshadowInfoLayerSchema, request, reply)
      if (!input) return reply
      // 校验伏笔和信息差都存在
      if (!store.getForeshadow(input.foreshadowId)) {
        throw new AppError(ErrorCode.NOT_FOUND, `伏笔不存在: ${input.foreshadowId}`, 404)
      }
      if (!store.listInformationLayers(request.params.projectId).some(l => l.id === input.infoLayerId)) {
        throw new AppError(ErrorCode.NOT_FOUND, `信息差不存在: ${input.infoLayerId}`, 404)
      }
      store.createEdge(request.params.projectId, { sourceId: input.foreshadowId, sourceType: 'foreshadow', targetId: input.infoLayerId, targetType: 'info_layer', edgeType: 'related', label: '关联信息差' } as any)
      return success({ foreshadowId: input.foreshadowId, infoLayerId: input.infoLayerId, linked: true }, request.traceId)
    },
  })

  // P3-2：解除伏笔↔信息差双向关联
  routes.push({
    method: 'DELETE',
    path: '/projects/:projectId/foreshadow-info-layer-links',
    handler: async (request: any) => {
      const foreshadowId = (request.query as Record<string, string | undefined>)?.foreshadowId
      const infoLayerId = (request.query as Record<string, string | undefined>)?.infoLayerId
      if (!foreshadowId || !infoLayerId) {
        throw new AppError(ErrorCode.BAD_REQUEST, '需要提供 foreshadowId 和 infoLayerId 查询参数', 400)
      }
      // 关联关系已迁移至 novel_edges 表：查找并删除匹配的边
      const edges = store.listEdgesByEntity(foreshadowId, { edgeType: 'related' })
        .filter(e => (e.sourceId === foreshadowId && e.targetId === infoLayerId)
                   || (e.sourceId === infoLayerId && e.targetId === foreshadowId))
      for (const edge of edges) {
        store.deleteEdge(edge.id)
      }
      return success({ foreshadowId, infoLayerId, linked: false }, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/factions/:id',
    handler: async (request: any) => {
      const deleted = store.deleteFaction(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `势力不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/locations/:id',
    handler: async (request: any) => {
      const deleted = store.deleteLocation(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `地点不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/world-elements/:id',
    handler: async (request: any) => {
      const deleted = store.deleteWorldElement(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `世界观要素不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/items/:id',
    handler: async (request: any) => {
      const deleted = store.deleteItem(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `物品不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 实体去重（整理功能）
  // ═══════════════════════════════════════════════════════════════

  const deduplicateSchema = z.object({
    /** dryRun=true 只扫描返回报告，不实际合并；默认 false 实际执行 */
    dryRun: z.boolean().optional().default(false),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/entities/deduplicate',
    handler: async (request: any, reply: any) => {
      const input = validateBody(deduplicateSchema, request, reply)
      if (!input) return reply
      const report = store.deduplicateEntities(request.params.projectId, { dryRun: input.dryRun })
      return success(report, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // LLM 相似度扫描 + 字段级合并（SSE + 检查点）
  // ═══════════════════════════════════════════════════════════════
  //
  // 与 /entities/deduplicate 互补：
  // - deduplicate：基于完全匹配 name/description 的快速去重（同步、无 LLM）
  // - similarity-scan：LLM 驱动的语义相似扫描（SSE 流式推送扫描进度 + 最终报告）
  // - merge-similarity：根据用户在弹框中勾选的组执行字段级合并（独立 REST POST）
  //
  // 拆分两步的原因：
  // 用户在弹框中需要逐组勾选（多选框），决定哪些组合并、哪些跳过。
  // checkpoint 模式只能 approve/reject 全部，无法承载"选中的子集"，
  // 因此 SSE 扫描完直接推送 report 后结束，合并决策改为独立 REST 调用，
  // 前端把勾选的 groups 通过 POST body 传回。
  //
  // 流程：
  // 1. SSE: scanner.scan 推送 preparing/generating/parsing/completed 进度
  // 2. SSE: 推送 result（含完整 report），流结束
  // 3. 前端弹框显示 report，每组带 checkbox，用户勾选
  // 4. REST: POST /entities/merge-similarity { groups: 选中的组 }
  //         后端调用 store.mergeWithPlan 执行字段级合并 + 关联迁移 + 删除
  routes.push({
    method: 'POST',
    path: '/projects/:projectId/entities/similarity-scan',
    handler: async (request: any, reply: any) => {
      const { projectId } = request.params

      // 设置 SSE（与 create-flow 一致，绕过 Fastify CORS 中间件需手动附加 CORS 头）
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': request.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true',
      })
      // 禁用 Nagle 算法，确保 SSE 事件立即 flush 到客户端
      request.raw.socket?.setNoDelay?.(true)

      const heartbeat = setInterval(() => {
        reply.raw.write(': keepalive\n\n')
      }, 15000)

      const emitter = createNovelAgUiEmitter(
        createSseEmitterSink((data) => reply.raw.write(data)),
        `novel:similarity:${projectId}`,
        randomUUID(),
      )

      try {
        // 1. 调用 scanner.scan 推送扫描进度
        const report = await services.similarityScanner.scan(projectId, (evt) => {
          emitter.progress({ type: 'phase_change', data: evt })
        })

        // 2. 推送扫描结果（含完整 report），前端据此弹框让用户多选
        emitter.result({ status: 'completed', report })
      } catch (err) {
        emitter.error(String(err))
      } finally {
        clearInterval(heartbeat)
        reply.raw.end()
      }
    },
  })

  // 执行相似实体合并（用户在弹框中勾选的组）
  // body: { groups: SimilarityGroup[] } —— 仅合并用户选中的组，未勾选的跳过
  const mergeSimilaritySchema = z.object({
    groups: z.array(z.object({
      kind: z.enum(['character', 'conflict', 'foreshadow', 'faction', 'location', 'world_element']),
      reason: z.string().default(''),
      similarity: z.number().min(0).max(1).default(0),
      keptId: z.string(),
      removed: z.array(z.object({
        id: z.string(),
        name: z.string().default(''),
      })),
      fieldMerges: z.array(z.object({
        field: z.string(),
        fromId: z.string(),
        fromName: z.string().default(''),
        reason: z.string().default(''),
      })).optional().default([]),
    })),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/entities/merge-similarity',
    handler: async (request: any, reply: any) => {
      const { projectId } = request.params as { projectId: string }
      const input = validateBody(mergeSimilaritySchema, request, reply)
      if (!input) return reply
      const result = store.mergeWithPlan(projectId, input.groups)
      return success({ totalMerged: result.totalMerged }, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 卷管理
  // ═══════════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/volumes',
    handler: async (request: any) => {
      return success(store.listVolumes(request.params.projectId), request.traceId)
    },
  })

  const createVolumeSchema = z.object({
    volumeNumber: z.number().int().min(1),
    title: z.string().max(200).default(''),
    outline: z.string().max(20000).default(''),
    sortOrder: z.number().int().min(0).default(0),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/volumes',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createVolumeSchema, request, reply)
      if (!input) return reply
      const volume = store.createVolume({
        id: randomUUID(),
        projectId: request.params.projectId,
        ...input,
      })
      return success(volume, request.traceId)
    },
  })

  const updateVolumeSchema = z.object({
    title: z.string().max(200).optional(),
    outline: z.string().max(20000).optional(),
    sortOrder: z.number().int().min(0).optional(),
    volumeNumber: z.number().int().min(1).optional(),
  })

  routes.push({
    method: 'PATCH',
    path: '/volumes/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateVolumeSchema, request, reply)
      if (!input) return reply
      const updated = store.updateVolume(request.params.id, input)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `卷不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/volumes/:id',
    handler: async (request: any) => {
      const deleted = store.deleteVolume(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `卷不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 章节管理（章节 CRUD + 版本历史 + 节奏控制）
  // 已迁移至 ./routes/chapter-routes.ts（PR-6）
  // ═══════════════════════════════════════════════════════════════
  routes.push(...createChapterRoutes(services))

  // ═══════════════════════════════════════════════════════════════
  // 角色（CRUD + AI 生成 + 历史 + 弧光）
  // 已迁移至 ./routes/character-routes.ts（PR-6）
  // ═══════════════════════════════════════════════════════════════
  routes.push(...createCharacterRoutes(services))
  routes.push(...createEntityCandidateRoutes(services))

  // ── AI 通用实体生成（不落库，前端 review 后调 createXxx） ──

  const aiGenerateEntitySchema = z.object({
    entityType: z.enum(['character', 'conflict', 'foreshadow', 'faction', 'location', 'item', 'world_element']),
    coreStyle: z.string().min(1).max(500),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/entities/ai-generate',
    handler: async (request: any, reply: any) => {
      const input = validateBody(aiGenerateEntitySchema, request, reply)
      if (!input) return reply

      const stream = new PassThrough()
      reply.headers({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': request.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true',
      })

      const heartbeat = setInterval(() => {
        stream.write(': keepalive\n\n')
      }, 15000)

      const emitter = createNovelAgUiEmitter(
        createSseEmitterSink((data) => stream.write(data)),
        `novel:entity:${request.params.projectId}`,
        randomUUID(),
      )

      reply.send(stream)
      try {
        const generated = await services.entityGenerator.generate(
          request.params.projectId,
          input.entityType,
          input.coreStyle,
          (event) => emitter.progress(event),
        )
        // 注意：此处不落库，返回字段供前端 review，前端确认后调 createXxx
        emitter.result(generated)
      } catch (err) {
        emitter.error(String(err))
      } finally {
        clearInterval(heartbeat)
        stream.end()
      }
      return reply
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 伏笔
  // ═══════════════════════════════════════════════════════════════

  const createForeshadowSchema = z.object({
    description: z.string().min(1),
    // ── P2-2：category 改为枚举（旧自由字符串由 store 层 normalize 兜底）──
    // 用 .optional() 而非 .default()，避免 PATCH .partial() 在 Zod v4 下保留默认值覆盖现有数据
    category: z.enum(['item', 'spoken', 'event', 'identity', 'secret', 'prophecy', 'promise', 'quote']).optional(),
    // 创建默认值统一在 POST 处理器补齐。这里不能使用 .default()：Zod v4 的
    // object.partial() 仍会应用字段默认值，导致只 PATCH beats 时把现有章节清空。
    status: z.enum(['planned', 'planted', 'reinforced', 'partially_revealed', 'recovering', 'recovered', 'abandoned']).optional(),
    firstChapter: z.number().int().nullable().optional(),
    lastChapter: z.number().int().nullable().optional(),
    recoverByChapter: z.number().int().nullable().optional(),
    // ── P2-2：埋设/回收方式（可选，不设默认值以兼容 PATCH .partial()）──
    plantMethod: z.enum(['explicit', 'implicit', 'indirect']).optional(),
    recoverMethod: z.enum(['explicit', 'implicit', 'reverse', 'progressive']).optional(),
    // ── 迁移 055：多段章节跨度（可选，未传时 store 层兜底为 []）
    // 用 .optional() 而非 .default([]) 以兼容 PATCH .partial()
    chapterSpans: z.array(z.tuple([z.number().int(), z.number().int()])).optional(),
    beats: z.array(z.object({
      chapter: z.number().int().positive(),
      type: z.enum(['plant', 'reinforce', 'reveal', 'payoff']),
      note: z.string().optional(),
    })).optional(),
    // ── 关联字段（不再写入 DB，创建后生成 edges）──
    linkedCharacters: z.array(z.string()).optional(),
    linkedClues: z.array(z.string()).optional(),
    linkedInfoLayers: z.array(z.string()).optional(),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/foreshadowing',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createForeshadowSchema, request, reply)
      if (!input) return reply

      const { linkedCharacters, linkedClues, linkedInfoLayers, ...rest } = input
      const foreshadow = store.createForeshadow({
        id: randomUUID(),
        projectId: request.params.projectId,
        // category 未传时兜底 'event'（与原 .default('event') 行为一致）
        category: 'event',
        status: 'planned',
        firstChapter: null,
        lastChapter: null,
        recoverByChapter: null,
        // chapterSpans 未传时兜底 []（进元素池，矩阵不渲染行）
        chapterSpans: [],
        ...rest,
      } as any)
      // ── 关联字段改为创建 edges（不再写入 DB）──
      if (linkedCharacters) {
        for (const charId of linkedCharacters) {
          store.createEdge(request.params.projectId, { sourceId: foreshadow.id, sourceType: 'foreshadow', targetId: charId, targetType: 'character', edgeType: 'related', label: '关联角色' } as any)
        }
      }
      if (linkedClues) {
        for (const clueId of linkedClues) {
          store.createEdge(request.params.projectId, { sourceId: foreshadow.id, sourceType: 'foreshadow', targetId: clueId, targetType: 'clue', edgeType: 'related', label: '关联线索' } as any)
        }
      }
      if (linkedInfoLayers) {
        for (const layerId of linkedInfoLayers) {
          store.createEdge(request.params.projectId, { sourceId: foreshadow.id, sourceType: 'foreshadow', targetId: layerId, targetType: 'info_layer', edgeType: 'related', label: '承载信息差' } as any)
        }
      }
      return success(foreshadow, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/foreshadowing',
    handler: async (request: any) => {
      return success(store.listForeshadowing(request.params.projectId), request.traceId)
    },
  })

  routes.push({
    method: 'PATCH',
    path: '/foreshadowing/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createForeshadowSchema.partial(), request, reply)
      if (!input) return reply

      // 关联字段不再写入 DB，PATCH 时剥离（如需更新关联请使用 edges 接口）
      const { linkedCharacters: _lc, linkedClues: _lcl, linkedInfoLayers: _lil, ...patch } = input
      const updated = store.updateForeshadow(request.params.id, patch)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `伏笔不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 冲突
  // ═══════════════════════════════════════════════════════════════

  const createConflictSchema = z.object({
    description: z.string().min(1),
    type: z.enum(['inner', 'relationship', 'faction', 'interest', 'moral', 'identity', 'emotional', 'world_rule', 'survival']),
    intensity: z.number().int().min(1).max(10).default(5),
    stage: z.enum(['latent', 'emerging', 'escalating', 'erupting', 'reversing', 'resolved', 'transformed']).default('latent'),
    chapterSpans: z.array(z.tuple([z.number().int(), z.number().int()])).default([]),
    tier: z.enum(['main', 'secondary', 'goal']).default('secondary'),
    // ── 四层逻辑④：双向关联 ──
    participants: z.array(z.string()).default([]),
    // ── P2-1：冲突功能位 + 非线性推进（可选，不设默认值）──
    plotFunction: z.enum(['provide_resource', 'create_obstacle', 'amplify_conflict', 'open_phase', 'change_judgment', 'advance_relationship', 'reveal_world_rule']).optional(),
    progressionMode: z.enum(['linear', 'mutation', 'stagnation', 'regression', 'reversal']).optional(),
    // ── 071：推进粒度（可选，新建时可初始化本章已到达的进展点）──
    currentStep: z.string().max(200).optional(),
    nextStep: z.string().max(200).optional(),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/conflicts',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createConflictSchema, request, reply)
      if (!input) return reply

      // participants 在 schema 层是 string[]，落库前 JSON.stringify 为 string
      const { participants, ...rest } = input
      const conflict = store.createConflict({
        id: randomUUID(),
        projectId: request.params.projectId,
        participants: JSON.stringify(participants ?? []),
        ...rest,
      })
      return success(conflict, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/conflicts',
    handler: async (request: any) => {
      return success(store.listConflicts(request.params.projectId), request.traceId)
    },
  })

  // PATCH 冲突：注意 participants 在 schema 层是 string[]，落库前需要 JSON.stringify
  const updateConflictSchema = z.object({
    description: z.string().min(1).optional(),
    type: z.enum(['inner', 'relationship', 'faction', 'interest', 'moral', 'identity', 'emotional', 'world_rule', 'survival']).optional(),
    intensity: z.number().int().min(1).max(10).optional(),
    stage: z.enum(['latent', 'emerging', 'escalating', 'erupting', 'reversing', 'resolved', 'transformed']).optional(),
    chapterSpans: z.array(z.tuple([z.number().int(), z.number().int()])).optional(),
    tier: z.enum(['main', 'secondary', 'goal']).optional(),
    participants: z.array(z.string()).optional(),
    // ── P2-1：冲突功能位 + 非线性推进（.optional() 无 .default() 避免覆盖未传字段）──
    plotFunction: z.enum(['provide_resource', 'create_obstacle', 'amplify_conflict', 'open_phase', 'change_judgment', 'advance_relationship', 'reveal_world_rule']).optional(),
    progressionMode: z.enum(['linear', 'mutation', 'stagnation', 'regression', 'reversal']).optional(),
    // ── 071：推进粒度（前端 / 用户可手动编辑；空串表示清空）──
    currentStep: z.string().max(200).optional(),
    nextStep: z.string().max(200).optional(),
  })

  routes.push({
    method: 'PATCH',
    path: '/conflicts/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateConflictSchema, request, reply)
      if (!input) return reply

      // participants 单独 JSON.stringify
      const { participants, ...rest } = input
      const patch: Record<string, unknown> = { ...rest }
      if (participants !== undefined) {
        patch.participants = JSON.stringify(participants)
      }

      const updated = store.updateConflict(request.params.id, patch as any)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `冲突不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 钩子（v0.2：章末悬念驱动实体）
  // ═══════════════════════════════════════════════════════════════

  const createHookSchema = z.object({
    chapterNumber: z.number().int().min(1),
    hookType: z.enum(['suspense', 'reversal', 'emotional', 'action']),
    description: z.string().min(1),
    status: z.enum(['thrown', 'fulfilled', 'abandoned']).default('thrown'),
    fulfilledAtChapter: z.number().int().nullable().default(null),
    fulfilledDescription: z.string().nullable().default(null),
    linkedForeshadowId: z.string().nullable().default(null),
    linkedConflictId: z.string().nullable().default(null),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/hooks',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createHookSchema, request, reply)
      if (!input) return reply

      const { linkedForeshadowId, linkedConflictId, ...rest } = input
      const hook = store.createHook({
        id: randomUUID(),
        projectId: request.params.projectId,
        ...rest,
      } as any)
      // ── 关联字段改为创建 edges（不再写入 DB）──
      if (linkedForeshadowId) {
        store.createEdge(request.params.projectId, { sourceId: hook.id, sourceType: 'hook', targetId: linkedForeshadowId, targetType: 'foreshadow', edgeType: 'related', label: '关联伏笔' } as any)
      }
      if (linkedConflictId) {
        store.createEdge(request.params.projectId, { sourceId: hook.id, sourceType: 'hook', targetId: linkedConflictId, targetType: 'conflict', edgeType: 'related', label: '关联冲突' } as any)
      }
      return success(hook, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/hooks',
    handler: async (request: any) => {
      return success(store.listHooks(request.params.projectId), request.traceId)
    },
  })

  // PUT 钩子：所有字段 .optional() 无 .default()，避免覆盖未传字段（与 updateMarkerSchema 同原则）
  // linkedForeshadowId/linkedConflictId 已迁移至 novel_edges，通过专门的关联路由管理
  const updateHookSchema = z.object({
    chapterNumber: z.number().int().min(1).optional(),
    hookType: z.enum(['suspense', 'reversal', 'emotional', 'action']).optional(),
    description: z.string().min(1).optional(),
    status: z.enum(['thrown', 'fulfilled', 'abandoned']).optional(),
    fulfilledAtChapter: z.number().int().nullable().optional(),
    fulfilledDescription: z.string().nullable().optional(),
  })

  routes.push({
    method: 'PUT',
    path: '/hooks/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateHookSchema, request, reply)
      if (!input) return reply

      const updated = store.updateHook(request.params.id, input)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `钩子不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/hooks/:id',
    handler: async (request: any) => {
      const deleted = store.deleteHook(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `钩子不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 线索
  // ═══════════════════════════════════════════════════════════════

  const createClueSchema = z.object({
    description: z.string().min(1),
    pointsTo: z.string().default(''),
    progress: z.number().int().min(0).max(100).default(0),
    currentStep: z.string().default(''),
    nextStep: z.string().default(''),
    isMisleading: z.boolean().default(false),
    linkedForeshadow: z.string().nullable().default(null),
    chapterSpans: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])).default([]),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/clues',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createClueSchema, request, reply)
      if (!input) return reply

      const { linkedForeshadow, ...rest } = input
      const clue = store.createClue({
        id: randomUUID(),
        projectId: request.params.projectId,
        ...rest,
      } as any)
      // ── 关联字段改为创建 edges（不再写入 DB）──
      if (linkedForeshadow) {
        store.createEdge(request.params.projectId, { sourceId: clue.id, sourceType: 'clue', targetId: linkedForeshadow, targetType: 'foreshadow', edgeType: 'related', label: '关联伏笔' } as any)
      }
      return success(clue, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/clues',
    handler: async (request: any) => {
      return success(store.listClues(request.params.projectId), request.traceId)
    },
  })

  routes.push({
    method: 'PATCH',
    path: '/clues/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createClueSchema.partial(), request, reply)
      if (!input) return reply
      const clue = store.updateClue(request.params.id, input)
      if (!clue) throw new AppError(ErrorCode.NOT_FOUND, `线索不存在: ${request.params.id}`, 404)
      return success(clue, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 关系
  // ═══════════════════════════════════════════════════════════════

  const createRelationshipSchema = z.object({
    characterA: z.string().min(1),
    characterB: z.string().min(1),
    relationType: z.string().min(1),
    currentStage: z.string().default(''),
    // ── 四层逻辑②：动态关系补全字段 ──
    dynamicRole: z.string().default(''),
    alignment: z.enum(['ally', 'temporary_ally', 'opponent', 'temporary_opponent', 'neutral', 'pending_shift']).default('neutral'),
    trend: z.enum(['stable', 'warming', 'cooling', 'breaking', 'reconciling']).default('stable'),
    chapterHint: z.string().default(''),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/relationships',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createRelationshipSchema, request, reply)
      if (!input) return reply

      const projectId = request.params.projectId
      for (const characterId of [input.characterA, input.characterB]) {
        const character = store.getCharacter(characterId)
        if (!character || character.projectId !== projectId) {
          throw new AppError(ErrorCode.NOT_FOUND, `角色不存在: ${characterId}`, 404)
        }
      }

      const rel = store.createRelationship({
        id: randomUUID(),
        projectId,
        stageHistory: '[]',
        lastUpdatedChapter: null,
        ...input,
      })
      return success(rel, request.traceId)
    },
  })

  // PATCH 关系：支持全部动态字段（与工具 novel_update_relationship 对齐）
  // 注意：所有字段 .optional() 无 .default()，避免覆盖未传字段（与 updateMarkerSchema 同原则）
  const updateRelationshipSchema = z.object({
    characterA: z.string().min(1).optional(),
    characterB: z.string().min(1).optional(),
    relationType: z.string().min(1).optional(),
    currentStage: z.string().optional(),
    stageHistory: z.string().optional(),
    dynamicRole: z.string().optional(),
    alignment: z.enum(['ally', 'temporary_ally', 'opponent', 'temporary_opponent', 'neutral', 'pending_shift']).optional(),
    trend: z.enum(['stable', 'warming', 'cooling', 'breaking', 'reconciling']).optional(),
    chapterHint: z.string().optional(),
    lastUpdatedChapter: z.number().int().min(0).nullable().optional(),
  })

  routes.push({
    method: 'PATCH',
    path: '/relationships/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateRelationshipSchema, request, reply)
      if (!input) return reply

      const relationship = store.getRelationship(request.params.id)
      if (!relationship) throw new AppError(ErrorCode.NOT_FOUND, `关系不存在: ${request.params.id}`, 404)
      for (const characterId of [input.characterA, input.characterB]) {
        if (characterId === undefined) continue
        const character = store.getCharacter(characterId)
        if (!character || character.projectId !== relationship.projectId) {
          throw new AppError(ErrorCode.NOT_FOUND, `角色不存在: ${characterId}`, 404)
        }
      }

      const updated = store.updateRelationship(request.params.id, input)
      return success(updated, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/relationships',
    handler: async (request: any) => {
      return success(store.listRelationships(request.params.projectId), request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 世界规则
  // ═══════════════════════════════════════════════════════════════

  const createWorldRuleSchema = z.object({
    category: z.string().min(1),
    rule: z.string().min(1),
    cost: z.string().nullable().default(null),
    isFixed: z.boolean().default(true),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/world-rules',
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
    handler: async (request: any) => {
      return success(store.listWorldRules(request.params.projectId), request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 风格指南
  // ═══════════════════════════════════════════════════════════════

  const createStyleGuideSchema = z.object({
    category: z.string().min(1),
    rule: z.string().min(1),
    example: z.string().nullable().default(null),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/style-guides',
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
    handler: async (request: any) => {
      return success(store.listStyleGuide(request.params.projectId), request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 项目级叙事文风档案
  // ═══════════════════════════════════════════════════════════════

  const writingStyleProfileSchema = z.object({
    name: z.string().trim().min(1).max(80),
    preset: z.string().trim().min(1).max(40).default('custom'),
    narrativePerson: z.enum(['first', 'third', 'mixed']).default('third'),
    narrativeDistance: z.enum(['intimate', 'limited', 'omniscient']).default('limited'),
    sentenceRhythm: z.enum(['short', 'balanced', 'long']).default('balanced'),
    dialogueRatio: z.number().min(10).max(90).default(45),
    emotionalTemperature: z.number().min(0).max(10).default(5),
    imageryDensity: z.number().min(0).max(10).default(3),
    vocabularyRegister: z.enum(['colloquial', 'plain', 'literary', 'classical']).default('plain'),
    hardRules: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
    softRules: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
    positiveExamples: z.array(z.string().trim().min(20).max(3000)).max(5).default([]),
    negativeExamples: z.array(z.string().trim().min(20).max(3000)).max(5).default([]),
    notes: z.string().max(2000).default(''),
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/writing-style-profile',
    handler: async (request: any) => {
      return success(store.getWritingStyleProfile(request.params.projectId) ?? null, request.traceId)
    },
  })

  routes.push({
    method: 'PUT',
    path: '/projects/:projectId/writing-style-profile',
    handler: async (request: any, reply: any) => {
      const input = validateBody(writingStyleProfileSchema, request, reply)
      if (!input) return reply
      const profile = store.upsertWritingStyleProfile(request.params.projectId, input)
      return success(profile, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/writing-style-profile/preview',
    handler: async (request: any) => {
      const target = request.query?.target
      const normalizedTarget = target === 'reviser' || target === 'reviewer' ? target : 'writer'
      return success(services.promptBuilder.buildWritingStylePrompt(request.params.projectId, normalizedTarget) ?? null, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/chapters/:chapterNumber/prose-quality',
    handler: async (request: any) => {
      const chapterNumber = Number(request.params.chapterNumber)
      const chapter = Number.isInteger(chapterNumber)
        ? store.getChapter(request.params.projectId, chapterNumber)
        : undefined
      if (!chapter) {
        throw new AppError(ErrorCode.NOT_FOUND, `章节不存在: ${request.params.chapterNumber}`, 404)
      }
      return success(evaluateProseQuality(chapter.content ?? ''), request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 创作约束
  // ═══════════════════════════════════════════════════════════════

  const createConstraintSchema = z.object({
    type: z.enum(['fact', 'cognitive', 'stage', 'debt', 'arc']),
    scope: z.enum(['global', 'volume', 'chapter']).default('global'),
    rule: z.string().min(1),
    relatedEntityId: z.string().nullable().default(null),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/constraints',
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
    handler: async (request: any) => {
      return success(store.listConstraints(request.params.projectId), request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 信息差
  // ═══════════════════════════════════════════════════════════════

  const createInfoLayerSchema = z.object({
    infoDescription: z.string().min(1),
    authorKnows: z.boolean().default(true),
    readerKnows: z.boolean().default(false),
    revealStage: z.string().nullable().default(null),
    revealChapter: z.number().int().nullable().default(null),
    // ── 关联字段（不再写入 DB，创建后生成 edges）──
    linkedForeshadows: z.array(z.string()).optional(),
  })

  // P3-2：信息差 PATCH schema（与 updateMarkerSchema 同原则：所有字段 .optional() 无 .default()，避免覆盖未传字段）
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

  // P3-2：建立伏笔↔信息差关联的请求 schema
  const linkForeshadowInfoLayerSchema = z.object({
    foreshadowId: z.string().min(1),
    infoLayerId: z.string().min(1),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/info-layers',
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
      // ── 关联字段改为创建 edges（不再写入 DB）──
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
    handler: async (request: any) => {
      return success(store.listInformationLayers(request.params.projectId), request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 势力
  // ═══════════════════════════════════════════════════════════════

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

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/factions',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createFactionSchema, request, reply)
      if (!input) return reply

      const faction = store.createFaction({
        id: randomUUID(),
        projectId: request.params.projectId,
        ...input,
      })
      return success(faction, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/factions',
    handler: async (request: any) => {
      return success(store.listFactions(request.params.projectId), request.traceId)
    },
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

  // ═══════════════════════════════════════════════════════════════
  // 地点
  // ═══════════════════════════════════════════════════════════════

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

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/locations',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createLocationSchema, request, reply)
      if (!input) return reply

      const location = store.createLocation({
        id: randomUUID(),
        projectId: request.params.projectId,
        ...input,
      })
      return success(location, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/locations',
    handler: async (request: any) => {
      return success(store.listLocations(request.params.projectId), request.traceId)
    },
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

  // ═══════════════════════════════════════════════════════════════
  // 物品
  // ═══════════════════════════════════════════════════════════════

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

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/items',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createItemSchema, request, reply)
      if (!input) return reply

      const item = store.createItem({
        id: randomUUID(),
        projectId: request.params.projectId,
        ...input,
      })
      return success(item, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/items',
    handler: async (request: any) => {
      return success(store.listItems(request.params.projectId), request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/items/by-owner/:ownerId',
    handler: async (request: any) => {
      return success(store.listItemsByOwner(request.params.ownerId), request.traceId)
    },
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

  // ═══════════════════════════════════════════════════════════════
  // 世界观要素
  // ═══════════════════════════════════════════════════════════════

  const createWorldElementSchema = z.object({
    category: z.enum(['power_system', 'history', 'culture', 'religion', 'technology', 'economy', 'geography']),
    name: z.string().min(1),
    description: z.string().default(''),
    parentId: z.string().nullable().default(null),
    attributes: z.record(z.string(), z.unknown()).default({}),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/world-elements',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createWorldElementSchema, request, reply)
      if (!input) return reply

      const element = store.createWorldElement({
        id: randomUUID(),
        projectId: request.params.projectId,
        ...input,
      })
      return success(element, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/world-elements',
    handler: async (request: any) => {
      return success(store.listWorldElements(request.params.projectId), request.traceId)
    },
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

  // ═══════════════════════════════════════════════════════════════
  // 节点位置（前端画布节点坐标持久化）
  // ═══════════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/node-positions',
    handler: async (request: any) => {
      return success(store.listNodePositions(request.params.projectId), request.traceId)
    },
  })

  const upsertNodePositionsSchema = z.object({
    positions: z.array(z.object({
      nodeType: z.enum(['project', 'character', 'chapter', 'conflict', 'foreshadow', 'group', 'faction', 'location', 'world_element']),
      entityId: z.string().min(1),
      posX: z.number(),
      posY: z.number(),
    })).min(1),
  })

  routes.push({
    method: 'PUT',
    path: '/projects/:projectId/node-positions',
    handler: async (request: any, reply: any) => {
      const input = validateBody(upsertNodePositionsSchema, request, reply)
      if (!input) return reply

      const upserted = input.positions.map((p) =>
        store.upsertNodePosition(
          request.params.projectId,
          p.nodeType,
          p.entityId,
          p.posX,
          p.posY,
        ),
      )
      return success({ upserted: upserted.length, positions: upserted }, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/projects/:projectId/node-positions/:nodeType/:entityId',
    handler: async (request: any) => {
      const deleted = store.deleteNodePosition(
        request.params.projectId,
        request.params.nodeType,
        request.params.entityId,
      )
      if (!deleted) {
        throw new AppError(
          ErrorCode.NOT_FOUND,
          `节点位置不存在: ${request.params.nodeType}:${request.params.entityId}`,
          404,
        )
      }
      return success(
        { projectId: request.params.projectId, nodeType: request.params.nodeType, entityId: request.params.entityId, deleted: true },
        request.traceId,
      )
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 画布连线（手动连线持久化 + 自动边存储）
  // ═══════════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/edges',
    handler: async (request: any) => {
      const projectId = request.params.projectId
      const query = (request.query ?? {}) as { entityId?: string }
      if (query.entityId) {
        return success(store.listEdgesByEntity(query.entityId), request.traceId)
      }
      return success(store.listEdges(projectId), request.traceId)
    },
  })

  const createEdgeSchema = z.object({
    sourceId: z.string().min(1),
    sourceType: z.enum(['project', 'character', 'chapter', 'conflict', 'foreshadow', 'group', 'faction', 'location', 'world_element', 'clue', 'item', 'info_layer', 'hook']),
    targetId: z.string().min(1),
    targetType: z.enum(['project', 'character', 'chapter', 'conflict', 'foreshadow', 'group', 'faction', 'location', 'world_element', 'clue', 'item', 'info_layer', 'hook']),
    edgeType: z.enum(['appearance', 'relationship', 'involvement', 'foreshadow', 'base', 'member', 'hierarchy', 'association', 'related', 'mentor', 'kinship', 'rivalry', 'alliance', 'subordinate', 'trigger', 'causality']),
    label: z.string().default(''),
    auto: z.boolean().default(false),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/edges',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createEdgeSchema, request, reply)
      if (!input) return reply

      const edge = store.createEdge(request.params.projectId, input)
      return success(edge, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/edges/:id',
    handler: async (request: any) => {
      const deleted = store.deleteEdge(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `连线不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  })

  routes.push({
    method: 'PATCH',
    path: '/edges/:id',
    handler: async (request: any, reply: any) => {
      const body = validateBody(z.object({ label: z.string() }), request, reply)
      if (!body) return reply
      const updated = store.updateEdgeLabel(request.params.id, body.label)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `连线不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 统一关系图查询（聚合 edges + JSON 派生 + relationships）
  // ═══════════════════════════════════════════════════════════════

  // 获取项目所有图节点（轻量视图，用于前端关系图可视化）
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/graph/nodes',
    handler: async (request: any) => {
      return success(relationshipGraph.getAllGraphNodes(request.params.projectId), request.traceId)
    },
  })

  // 获取项目所有图边（聚合三个数据源：持久化边 + 派生边 + 角色关系）
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/graph/edges',
    handler: async (request: any) => {
      return success(relationshipGraph.getAllGraphEdges(request.params.projectId), request.traceId)
    },
  })

  // 查找实体的所有邻居（双向）
  // query: edgeTypes（逗号分隔，可选）
  routes.push({
    method: 'GET',
    path: '/graph/neighbors/:entityId',
    handler: async (request: any) => {
      const { entityId } = request.params as { entityId: string }
      const query = (request.query ?? {}) as { edgeTypes?: string }
      const edgeTypes = query.edgeTypes
        ? (query.edgeTypes.split(',').filter(Boolean) as NovelEdgeType[])
        : undefined
      return success(relationshipGraph.findNeighbors(entityId, edgeTypes), request.traceId)
    },
  })

  // 查找两个实体之间的最短路径（BFS）
  // query: maxDepth（默认 4）
  routes.push({
    method: 'GET',
    path: '/graph/path/:fromId/:toId',
    handler: async (request: any) => {
      const { fromId, toId } = request.params as { fromId: string; toId: string }
      const query = (request.query ?? {}) as { maxDepth?: string }
      const maxDepth = query.maxDepth ? parseInt(query.maxDepth, 10) : 4
      return success(relationshipGraph.findPath(fromId, toId, maxDepth), request.traceId)
    },
  })

  // 查找实体在哪些章节出现
  // query: entityType（character/conflict/foreshadow/faction/location/world_element）
  routes.push({
    method: 'GET',
    path: '/graph/entity-chapters/:entityId',
    handler: async (request: any) => {
      const { entityId } = request.params as { entityId: string }
      const query = (request.query ?? {}) as { entityType?: string }
      const entityType = (query.entityType ?? 'character') as NovelNodeType
      const result = relationshipGraph.findEntityChapters(entityId, entityType)
      if (!result) throw new AppError(ErrorCode.NOT_FOUND, `实体不存在: ${entityId}`, 404)
      return success(result, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 跨章节一致性审计
  // ═══════════════════════════════════════════════════════════════

  // 执行完整一致性审计（伏笔回收率/钩子悬挂/孤儿实体/时间线矛盾）
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/consistency-report',
    handler: async (request: any) => {
      const report = consistencyAuditor.audit(request.params.projectId)
      return success(report, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 长期记忆（记忆事件 + 章节快照 + 因果链）
  // ═══════════════════════════════════════════════════════════════

  // 查询记忆事件（支持 query: chapterNumber, entityType, entityId, eventType, minSignificance, limit）
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/memory-events',
    handler: async (request: any) => {
      const { projectId } = request.params as { projectId: string }
      const query = (request.query ?? {}) as Record<string, string | undefined>

      const chapterNumber = query.chapterNumber != null ? parseInt(query.chapterNumber, 10) : undefined
      const minSignificance = query.minSignificance != null ? parseInt(query.minSignificance, 10) : undefined
      const limit = query.limit != null ? parseInt(query.limit, 10) : undefined

      const events = memoryStore.listEvents(projectId, {
        chapterNumber: chapterNumber != null && !Number.isNaN(chapterNumber) ? chapterNumber : undefined,
        entityType: query.entityType as any,
        entityId: query.entityId,
        eventType: query.eventType as any,
        minSignificance: minSignificance != null && !Number.isNaN(minSignificance) ? minSignificance : undefined,
        limit: limit != null && !Number.isNaN(limit) ? limit : undefined,
      })
      return success(events, request.traceId)
    },
  })

  // 获取实体事件时间线
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/memory-events/timeline/:entityId',
    handler: async (request: any) => {
      const { projectId, entityId } = request.params as { projectId: string; entityId: string }
      const timeline = memoryStore.getEntityTimeline(projectId, entityId)
      return success(timeline, request.traceId)
    },
  })

  // 获取因果关系链（向上追溯原因 + 向下追溯影响）
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/memory-events/causal/:eventId',
    handler: async (request: any) => {
      const { eventId } = request.params as { eventId: string }
      const chain = memoryStore.getCausalChain(eventId)
      return success(chain, request.traceId)
    },
  })

  // 查询记忆快照（支持 query: chapterNumber, snapshotType）
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/memory-snapshots',
    handler: async (request: any) => {
      const { projectId } = request.params as { projectId: string }
      const query = (request.query ?? {}) as Record<string, string | undefined>

      const chapterNumber = query.chapterNumber != null ? parseInt(query.chapterNumber, 10) : undefined
      const snapshots = memoryStore.listSnapshots(projectId, {
        chapterNumber: chapterNumber != null && !Number.isNaN(chapterNumber) ? chapterNumber : undefined,
        snapshotType: query.snapshotType as any,
      })
      return success(snapshots, request.traceId)
    },
  })

  // 获取某章的状态快照（支持 query: snapshotType, entityId）
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/memory-snapshots/:chapterNumber',
    handler: async (request: any) => {
      const { projectId, chapterNumber } = request.params as { projectId: string; chapterNumber: string }
      const query = (request.query ?? {}) as Record<string, string | undefined>

      const chapterNum = parseInt(chapterNumber, 10)
      if (Number.isNaN(chapterNum) || chapterNum < 0) {
        throw new AppError(ErrorCode.BAD_REQUEST, `无效的 chapterNumber: ${chapterNumber}`, 400)
      }

      const snapshot = memoryStore.getSnapshot(projectId, chapterNum, {
        snapshotType: query.snapshotType as any,
        entityId: query.entityId,
      })
      if (!snapshot) {
        throw new AppError(ErrorCode.NOT_FOUND, `章节 ${chapterNum} 的快照不存在`, 404)
      }
      return success(snapshot, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 缓存诊断
  // ═══════════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/cache-diagnostics',
    handler: async (request: any) => {
      const projectId = request.params.projectId
      const chapterNumber = request.query?.chapterNumber != null
        ? parseInt(request.query.chapterNumber, 10)
        : undefined

      // 系统提示词哈希（STATIC 层）- 跨章节缓存命中指标
      const agentTypes = ['director', 'writer', 'reviewer', 'memory']
      const systemPromptHashes: Record<string, string> = {}
      for (const agentType of agentTypes) {
        try {
          systemPromptHashes[agentType] = promptBuilder.getSystemPromptHash(projectId, agentType)
        } catch {
          systemPromptHashes[agentType] = 'error'
        }
      }

      // 章节上下文哈希（SEMI 层）- 单章内缓存命中指标
      let chapterContextHash: string | undefined
      const chapterContextHashes: Record<string, string> = {}
      if (chapterNumber != null && !Number.isNaN(chapterNumber)) {
        const diagnosticTask = {
          description: '诊断请求',
          type: 'advance_mainline' as const,
          targetEntity: null,
          priority: 'medium' as const,
        }
        const diagnosticConstraints = {
          facts: store.listConstraints(projectId).filter((c: any) => c.type === 'fact'),
          cognitive: store.listConstraints(projectId).filter((c: any) => c.type === 'cognitive'),
          stage: store.listConstraints(projectId).filter((c: any) => c.type === 'stage'),
          narrativeDebts: store.listForeshadowing(projectId),
          characterArcs: store.listCharacters(projectId).map((c: any) => ({
            character: c,
            allowedNextStage: null,
          })),
          conflictTargets: [],
          suspenseHooks: [],
        }
        for (const agentType of agentTypes) {
          try {
            chapterContextHashes[agentType] = promptBuilder.getChapterContextHash(
              projectId,
              chapterNumber,
              diagnosticTask,
              diagnosticConstraints,
              undefined,
              agentType,
            )
          } catch {
            chapterContextHashes[agentType] = 'error'
          }
        }
        chapterContextHash = chapterContextHashes.director
      }

      return success(
        {
          systemPromptHashes,
          chapterContextHash,
          chapterContextHashes,
          agentTypes,
          timestamp: Date.now(),
        },
        request.traceId,
      )
    },
  })

  // 缓存分层命中诊断（实测 cache_read vs 可缓存前缀的期望值）
  //
  // 与上面的 cache-diagnostics 是两件事：那个比对提示词**哈希是否稳定**（前提条件），
  // 这个量**缓存是否真的被命中**（实际效果）。哈希稳定但 cache_read 为 0
  // 说明断点没生效 —— 只看哈希看不出来这一层。
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/cache-layer-report',
    handler: async (request: any) => {
      const projectId = request.params.projectId
      const chapterNumber = request.query?.chapterNumber != null
        ? parseInt(request.query.chapterNumber, 10)
        : undefined
      // 默认覆盖最近 200 条调用：足够涵盖数章，又不至于把整个项目历史读进内存
      const limit = request.query?.limit != null
        ? Math.min(Math.max(parseInt(request.query.limit, 10) || 200, 1), 500)
        : 200

      const logs = store.listAgentLogsByProject(projectId, limit)
      const scoped = chapterNumber != null && !Number.isNaN(chapterNumber)
        ? logs.filter((l: any) => l.chapterNumber === chapterNumber)
        : logs

      // 按章分组后逐章诊断：缓存复用发生在单章内部（shared 段按章构建），
      // 跨章比对没有意义。
      const byChapter = new Map<number, any[]>()
      for (const log of scoped) {
        const list = byChapter.get(log.chapterNumber) ?? []
        list.push(log)
        byChapter.set(log.chapterNumber, list)
      }

      const diagnoses = Array.from(byChapter.entries())
        .sort(([a], [b]) => a - b)
        .map(([ch, chapterLogs]) => diagnoseChapterCache(ch, chapterLogs))

      const report = buildCacheLayerReport(diagnoses)
      return success({ ...report, sampledLogs: scoped.length, timestamp: Date.now() }, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 提示词模板
  // ═══════════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/prompts',
    handler: async (request: any) => {
      return success(promptManager.listTemplateNames(), request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/prompts/:name',
    handler: async (request: any) => {
      const content = promptManager.getTemplate(request.params.name, request.query.projectId)
      return success({ name: request.params.name, content }, request.traceId)
    },
  })

  const savePromptSchema = z.object({
    content: z.string().min(1),
    projectId: z.string().nullable(),
    description: z.string().optional(),
  })

  routes.push({
    method: 'PUT',
    path: '/prompts/:name',
    handler: async (request: any, reply: any) => {
      const input = validateBody(savePromptSchema, request, reply)
      if (!input) return reply

      promptManager.saveTemplate(request.params.name, input.content, input.projectId, input.description)
      promptManager.clearCache()
      return success({ name: request.params.name, saved: true }, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 多 Agent 创作流程 / 群聊 / ai-arrange / 反推 / create-team /
  // agent-logs / markers / agent-config / 章节聊天
  // 已迁移至 ./routes/creation-flow-routes.ts（PR-6）
  // ═══════════════════════════════════════════════════════════════
  routes.push(...createCreationFlowRoutes(services))

  // ═══════════════════════════════════════════════════════════════
  // 剧情（narrative）实体轨道 CRUD
  // 承接冲突/线索/伏笔装不下的剧情相关内容，矩阵独立轨道
  // ═══════════════════════════════════════════════════════════════

  const narrativeTypes = ['advance', 'turn', 'reversal', 'suspense', 'resolve', 'setup', 'reveal', 'misc'] as const
  const createNarrativeSchema = z.object({
    description: z.string().min(1),
    type: z.enum(narrativeTypes).default('advance'),
    status: z.enum(['active', 'resolved', 'dropped']).default('active'),
    chapterSpans: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])).default([]),
  })
  const updateNarrativeSchema = createNarrativeSchema.partial()

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/narratives',
    handler: async (request: any) => {
      return success(store.listNarratives(request.params.projectId), request.traceId)
    },
  })
  routes.push({
    method: 'POST',
    path: '/projects/:projectId/narratives',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createNarrativeSchema, request, reply)
      if (!input) return reply
      const narrative = store.createNarrative({ projectId: request.params.projectId, ...input })
      return success(narrative, request.traceId)
    },
  })
  routes.push({
    method: 'PATCH',
    path: '/narratives/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateNarrativeSchema, request, reply)
      if (!input) return reply
      const updated = store.updateNarrative(request.params.id, input as any)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `剧情不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })
  routes.push({
    method: 'DELETE',
    path: '/narratives/:id',
    handler: async (request: any) => {
      const deleted = store.deleteNarrative(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `剧情不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // P0 成本测量报表（只读聚合 novel_agent_logs + novel_context_section_metrics）
  // ═══════════════════════════════════════════════════════════════

  // GET /projects/:projectId/cost-report?chapterNumber=N — 章成本报表（六项指标）
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/cost-report',
    handler: async (request: any) => {
      const { projectId } = request.params as { projectId: string }
      const project = store.getProject(projectId)
      if (!project) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在', 404)
      const chapterNumber = request.query?.chapterNumber != null
        ? parseInt(String(request.query.chapterNumber), 10)
        : undefined
      const reports = services.costReportService.chapterReport(projectId, chapterNumber)
      return success({ projectId, reports }, request.traceId)
    },
  })

  // GET /projects/:projectId/agent-cost-share — 每个 Agent 成本占比（input + cache-read 口径）
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/agent-cost-share',
    handler: async (request: any) => {
      const { projectId } = request.params as { projectId: string }
      const project = store.getProject(projectId)
      if (!project) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在', 404)
      const shares = services.costReportService.agentCostShare(projectId)
      return success({ projectId, shares }, request.traceId)
    },
  })

  // GET /projects/:projectId/shared-overlap — 相邻章 shared 重复率（p50/p75/max + top section）
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/shared-overlap',
    handler: async (request: any) => {
      const { projectId } = request.params as { projectId: string }
      const project = store.getProject(projectId)
      if (!project) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在', 404)
      const report = services.sharedOverlapAnalyzer.analyze(projectId)
      return success(report, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // P1-2 日志 payload 清理（手动触发；定时调度由部署侧 cron/env 决定）
  // ═══════════════════════════════════════════════════════════════

  // POST /admin/agent-log-payloads/cleanup — 按保留策略清理过期 payload（元数据不删）
  routes.push({
    method: 'POST',
    path: '/admin/agent-log-payloads/cleanup',
    handler: async (request: any) => {
      const result = store.cleanupExpiredPayloads()
      return success(result, request.traceId)
    },
  })

  return routes
}
