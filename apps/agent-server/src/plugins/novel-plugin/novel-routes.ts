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
import type { NovelChapter, NovelMarker, NovelInformationLayer } from './core/types.js'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { success } from '../../lib/api-response.js'
import { validateBody } from '../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { RhythmController } from './core/rhythm-controller.js'
import { EventType } from '@ag-ui/core'
import type { AgUiEventSink } from '@repo/protocol/events'

/** 同一章节 ai-arrange 并发锁，key 为 `${projectId}:${chapterNumber}` */
const aiArrangeLocks = new Map<string, Promise<void>>()

/**
 * 创建 ag-ui 兼容的 SSE 事件发射器
 *
 * 与 chat 的 ag-ui 协议统一技术栈：
 * - 使用 EventType 枚举（非字符串字面量）
 * - 使用 AgUiEventSink 类型签名（非 writeRaw 原始字符串）
 * - LLM token 流不走 CUSTOM 事件，改由 StreamEmitter 发射标准
 *   TEXT_MESSAGE_* / TOOL_CALL_* / STEP_* 事件（在 orchestrator 中实现）
 * - CUSTOM 事件只用于小说专属语义：阶段切换 / 检查点 / 编排进度
 *
 * 返回对象包含 emit 字段（AgUiEventSink），供 StreamEmitter 直接使用。
 */
function createNovelAgUiEmitter(
  emit: AgUiEventSink,
  threadId: string,
  runId: string,
) {
  emit({ type: EventType.RUN_STARTED, threadId, runId })

  return {
    emit,
    threadId,
    runId,
    // 统一注入 timestamp: Date.now()，避免每个调用点手工塞
    // 前端 AgentOutput.timestamp / CreationFlowEvent.timestamp 依赖此字段
    progress: (data: unknown) => emit({
      type: EventType.CUSTOM,
      name: 'novel:progress',
      value: typeof data === 'object' && data !== null
        ? { timestamp: Date.now(), ...(data as Record<string, unknown>) }
        : data,
    }),
    checkpoint: (data: unknown) => emit({
      type: EventType.CUSTOM,
      name: 'novel:checkpoint',
      value: typeof data === 'object' && data !== null
        ? { timestamp: Date.now(), ...(data as Record<string, unknown>) }
        : data,
    }),
    result: (data: unknown) => {
      emit({
        type: EventType.CUSTOM,
        name: 'novel:result',
        value: typeof data === 'object' && data !== null
          ? { timestamp: Date.now(), ...(data as Record<string, unknown>) }
          : data,
      })
      emit({ type: EventType.RUN_FINISHED, threadId, runId })
    },
    // AG-UI 协议：错误流也必须以 RUN_FINISHED 结束，否则客户端无法判定流结束
    error: (message: string) => {
      emit({ type: EventType.RUN_ERROR, message })
      emit({ type: EventType.RUN_FINISHED, threadId, runId })
    },
  }
}

/**
 * 创建 SSE 写入适配器：把 AG-UI 事件序列化为 SSE data 行。
 *
 * 与 chat 的 /ag-ui/agent/{id}/run 端点使用相同的序列化格式，
 * 前端用共享的 parseSseStream 解析。
 */
function createSseEmitterSink(writeRaw: (data: string) => void): AgUiEventSink {
  return (event) => {
    writeRaw(`data: ${JSON.stringify(event)}\n\n`)
  }
}

const arrangedEntitiesSchema = z.object({
  characterIds: z.array(z.string()).max(200).optional().default([]),
  conflictIds: z.array(z.string()).max(200).optional().default([]),
  foreshadowIds: z.array(z.string()).max(200).optional().default([]),
  factionIds: z.array(z.string()).max(200).optional().default([]),
  locationIds: z.array(z.string()).max(200).optional().default([]),
})

const createFlowBodySchema = z.object({
  arrangedEntities: arrangedEntitiesSchema.optional(),
}).optional().default({})

/** 创建小说系统 REST API 路由 */
export function createNovelRoutes(services: NovelServices): RouteDefinition[] {
  const { store, memoryStore, promptManager, promptBuilder, engine, agentConfigStore } = services
  const routes: RouteDefinition[] = []

  // ═══════════════════════════════════════════════════════════════
  // 项目管理
  // ═══════════════════════════════════════════════════════════════

  const createProjectSchema = z.object({
    title: z.string().min(1).max(200),
    genre: z.string().min(1).max(50),
    synopsis: z.string().max(5000).default(''),
    targetWords: z.number().int().min(0).default(0),
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
      const deleted = store.deleteChapter(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `章节不存在: ${request.params.id}`, 404)
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
      store.linkForeshadowToInfoLayer(input.foreshadowId, input.infoLayerId)
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
      store.unlinkForeshadowFromInfoLayer(foreshadowId, infoLayerId)
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
      request.raw.socket?.setNoDelay(true)

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
  // 章节管理
  // ═══════════════════════════════════════════════════════════════

  const createChapterSchema = z.object({
    chapterNumber: z.number().int().min(1),
    narrativeTask: z.object({
      description: z.string().min(1),
      type: z.string(),
      targetEntity: z.string().nullable().optional(),
      priority: z.enum(['high', 'medium', 'low']).default('medium'),
    }),
    // 可选卷归属：传入则新建章节直接挂在该卷下，避免章节游离在所有卷之外
    volumeId: z.string().nullable().optional(),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createChapterSchema, request, reply)
      if (!input) return reply

      const result = await engine.createChapter(
        request.params.projectId,
        input.chapterNumber,
        input.narrativeTask as any,
        input.volumeId ?? undefined,
      )
      return success(result, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/chapters',
    handler: async (request: any) => {
      return success(store.listChapters(request.params.projectId), request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/chapters/:id',
    handler: async (request: any) => {
      const chapter = store.getChapterById(request.params.id)
      if (!chapter) throw new AppError(ErrorCode.NOT_FOUND, `章节不存在: ${request.params.id}`, 404)
      return success(chapter, request.traceId)
    },
  })

  const updateChapterSchema = z.object({
    title: z.string().optional(),
    content: z.string().optional(),
    status: z.enum(['planned', 'drafting', 'review', 'published', 'rejected']).optional(),
    outline: z.string().max(20000).optional(),
    volumeId: z.string().nullable().optional(),
    tension: z.number().int().min(1).max(10).nullable().optional(),
    timeOffset: z.number().int().nullable().optional(),
    chapterEndingHook: z.enum(['suspense', 'reversal', 'emotional', 'action', 'none']).nullable().optional(),
    recap: z.string().max(500).nullable().optional(),
  })

  routes.push({
    method: 'PATCH',
    path: '/chapters/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateChapterSchema, request, reply)
      if (!input) return reply

      // 传 content 时自动重算 wordCount（与前端 chapter-live-view.tsx 的 countWords 一致），
      // 避免 spread patch 保留旧 wordCount 导致统计与正文不同步。
      let patch: Partial<NovelChapter> = input
      if (input.content != null) {
        const cleaned = input.content.replace(/[#*`>\-\[\]()!]/g, '').replace(/\s+/g, '')
        patch = { ...input, wordCount: cleaned.length }
      }

      const updated = store.updateChapter(request.params.id, patch)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `章节不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  const completeChapterSchema = z.object({
    content: z.string().min(1),
    title: z.string().optional(),
  })

  routes.push({
    method: 'POST',
    path: '/chapters/:id/complete',
    handler: async (request: any, reply: any) => {
      const input = validateBody(completeChapterSchema, request, reply)
      if (!input) return reply

      const chapter = await engine.completeChapter(request.params.id, input.content, input.title)
      return success(chapter, request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/chapters/:id/publish',
    handler: async (request: any) => {
      const chapter = await engine.publishChapter(request.params.id)
      return success(chapter, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 节奏控制
  // ═══════════════════════════════════════════════════════════════

  // 列出所有可用节奏模型
  routes.push({
    method: 'GET',
    path: '/rhythm-models',
    handler: async (request: any) => {
      return success(RhythmController.MODELS, request.traceId)
    },
  })

  // 获取下一章节奏建议（query: ?chapterNumber=N）
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/rhythm-suggestion',
    handler: async (request: any) => {
      const { projectId } = request.params as { projectId: string }
      const { chapterNumber } = request.query as { chapterNumber?: string }

      const project = store.getProject(projectId)
      if (!project) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在', 404)

      const chapterNum = chapterNumber != null ? parseInt(chapterNumber, 10) : (project.currentChapter + 1)
      if (Number.isNaN(chapterNum) || chapterNum < 1) {
        throw new AppError(ErrorCode.BAD_REQUEST, `无效的 chapterNumber: ${chapterNumber}`, 400)
      }

      const controller = new RhythmController()
      const model = RhythmController.MODELS.find(m => m.id === project.rhythmModelId) ?? RhythmController.DEFAULT_MODEL

      // 从历史章节构建节奏历史
      const chapters = store.listChapters(projectId)
      const history = chapters
        .filter(c => c.rhythm)
        .map(c => ({
          chapterNumber: c.chapterNumber,
          rhythm: c.rhythm!,
          effectiveness: 'medium' as const,
        }))

      const suggestion = controller.suggestRhythm(
        chapterNum,
        project.currentStage,
        history,
        model,
      )
      return success(suggestion, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 角色
  // ═══════════════════════════════════════════════════════════════

  const createCharacterSchema = z.object({
    name: z.string().min(1),
    description: z.string().default(''),
    identity: z.string().default(''),
    personality: z.string().default(''),
    appearance: z.string().default(''),
    currentState: z.string().default(''),
    currentGoal: z.string().default(''),
    currentPressure: z.string().default(''),
    secret: z.string().default(''),
    arcStage: z.string().default(''),
    speechStyle: z.string().default(''),
    isProtagonist: z.boolean().default(false),
    // 四层逻辑补全字段
    longTermDesire: z.string().default(''),
    plotRole: z.enum(['protagonist', 'main_opponent', 'supporting', 'function', 'background']).default('supporting'),
    removalImpact: z.string().default(''),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/characters',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createCharacterSchema, request, reply)
      if (!input) return reply

      const character = store.createCharacter({
        id: randomUUID(),
        projectId: request.params.projectId,
        arcHistory: '[]',
        ...input,
      })
      return success(character, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/characters',
    handler: async (request: any) => {
      return success(store.listCharacters(request.params.projectId), request.traceId)
    },
  })

  routes.push({
    method: 'PATCH',
    path: '/characters/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createCharacterSchema.partial(), request, reply)
      if (!input) return reply

      const updated = store.updateCharacter(request.params.id, input)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `角色不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  // ── AI 角色生成 ──

  const aiGenerateCharacterSchema = z.object({
    coreStyle: z.string().min(1).max(500),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/characters/ai-generate',
    handler: async (request: any, reply: any) => {
      const input = validateBody(aiGenerateCharacterSchema, request, reply)
      if (!input) return reply

      // SSE 设置
      // 注意：reply.raw.writeHead 绕过 Fastify 的 CORS 中间件，需手动附加 CORS 头，
      // 否则浏览器会以 CORS 策略拦截跨域 SSE 请求（参考 create-flow 实现）。
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': request.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true',
      })
      // 禁用 Nagle 算法，确保 SSE 事件立即 flush 到客户端
      request.raw.socket?.setNoDelay(true)

      const heartbeat = setInterval(() => {
        reply.raw.write(': keepalive\n\n')
      }, 15000)

      const emitter = createNovelAgUiEmitter(
        createSseEmitterSink((data) => reply.raw.write(data)),
        `novel:character:${request.params.projectId}`,
        randomUUID(),
      )

      try {
        const generated = await services.characterGenerator.generate(
          request.params.projectId,
          input.coreStyle,
          (event) => emitter.progress(event),
        )

        const character = store.createCharacter({
          id: randomUUID(),
          projectId: request.params.projectId,
          arcHistory: '[]',
          isProtagonist: false,
          ...generated,
        })

        emitter.result(character)
      } catch (err) {
        emitter.error(String(err))
      } finally {
        clearInterval(heartbeat)
        reply.raw.end()
      }
    },
  })

  // ── AI 通用实体生成（不落库，前端 review 后调 createXxx） ──

  const aiGenerateEntitySchema = z.object({
    entityType: z.enum(['character', 'conflict', 'foreshadow', 'faction', 'location', 'world_element']),
    coreStyle: z.string().min(1).max(500),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/entities/ai-generate',
    handler: async (request: any, reply: any) => {
      const input = validateBody(aiGenerateEntitySchema, request, reply)
      if (!input) return reply

      // SSE 设置
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': request.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true',
      })

      const heartbeat = setInterval(() => {
        reply.raw.write(': keepalive\n\n')
      }, 15000)

      const emitter = createNovelAgUiEmitter(
        createSseEmitterSink((data) => reply.raw.write(data)),
        `novel:entity:${request.params.projectId}`,
        randomUUID(),
      )

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
        reply.raw.end()
      }
    },
  })

  // ── 角色状态变更历史 ──

  const createCharacterHistorySchema = z.object({
    fieldName: z.enum(['currentState', 'currentGoal', 'currentPressure', 'secret', 'arcStage']),
    oldValue: z.string().nullable().default(null),
    newValue: z.string().nullable().default(null),
    reason: z.string().nullable().default(null),
    chapterNumber: z.number().int().nullable().optional(),
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/characters/:characterId/history',
    handler: async (request: any) => {
      const history = store.listCharacterHistory(
        request.params.projectId,
        request.params.characterId,
      )
      return success(history, request.traceId)
    },
  })

  // 项目级角色历史：用于 data_changed SSE 事件后全量刷新（不传 characterId 返回项目全部）
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/character-history',
    handler: async (request: any) => {
      const history = store.listCharacterHistory(request.params.projectId)
      return success(history, request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/characters/:characterId/history',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createCharacterHistorySchema, request, reply)
      if (!input) return reply

      const entry = store.createCharacterHistory({
        projectId: request.params.projectId,
        characterId: request.params.characterId,
        chapterId: null,
        chapterNumber: input.chapterNumber ?? null,
        fieldName: input.fieldName,
        oldValue: input.oldValue,
        newValue: input.newValue,
        reason: input.reason,
      })
      return success(entry, request.traceId)
    },
  })

  // 批量创建角色历史（用于时间轴补全功能）
  const batchCharacterHistorySchema = z.object({
    records: z.array(z.object({
      characterId: z.string(),
      chapterNumber: z.number().int(),
    })),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/character-history/batch',
    handler: async (request: any, reply: any) => {
      const input = validateBody(batchCharacterHistorySchema, request, reply)
      if (!input) return reply

      const entries = input.records.map((r: { characterId: string; chapterNumber: number }) => ({
        projectId: request.params.projectId,
        characterId: r.characterId,
        chapterId: null,
        chapterNumber: r.chapterNumber,
        fieldName: 'currentState' as const,
        oldValue: null,
        newValue: null,
        reason: '批量补全角色出场章节',
      }))
      const results = store.batchCreateCharacterHistory(entries)
      return success(results, request.traceId)
    },
  })

  // 删除单条角色历史记录（矩阵视图取消角色出场）
  routes.push({
    method: 'DELETE',
    path: '/projects/:projectId/character-history/:id',
    handler: async (request: any) => {
      const deleted = store.deleteCharacterHistory(request.params.id, request.params.projectId)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `角色历史记录不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
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
    status: z.enum(['planned', 'planted', 'reinforced', 'partially_revealed', 'recovering', 'recovered', 'abandoned']).default('planned'),
    firstChapter: z.number().int().nullable().default(null),
    lastChapter: z.number().int().nullable().default(null),
    recoverByChapter: z.number().int().nullable().default(null),
    // ── P2-2：埋设/回收方式（可选，不设默认值以兼容 PATCH .partial()）──
    plantMethod: z.enum(['explicit', 'implicit', 'indirect']).optional(),
    recoverMethod: z.enum(['explicit', 'implicit', 'reverse', 'progressive']).optional(),
    // ── 迁移 055：多段章节跨度（可选，未传时 store 层兜底为 []）
    // 用 .optional() 而非 .default([]) 以兼容 PATCH .partial()
    chapterSpans: z.array(z.tuple([z.number().int(), z.number().int()])).optional(),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/foreshadowing',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createForeshadowSchema, request, reply)
      if (!input) return reply

      const foreshadow = store.createForeshadow({
        id: randomUUID(),
        projectId: request.params.projectId,
        linkedCharacters: '[]',
        linkedClues: '[]',
        linkedInfoLayers: '[]',
        // category 未传时兜底 'event'（与原 .default('event') 行为一致）
        category: 'event',
        // chapterSpans 未传时兜底 []（进元素池，矩阵不渲染行）
        chapterSpans: [],
        ...input,
      })
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

      const updated = store.updateForeshadow(request.params.id, input)
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

      const hook = store.createHook({
        id: randomUUID(),
        projectId: request.params.projectId,
        ...input,
      })
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
  const updateHookSchema = z.object({
    chapterNumber: z.number().int().min(1).optional(),
    hookType: z.enum(['suspense', 'reversal', 'emotional', 'action']).optional(),
    description: z.string().min(1).optional(),
    status: z.enum(['thrown', 'fulfilled', 'abandoned']).optional(),
    fulfilledAtChapter: z.number().int().nullable().optional(),
    fulfilledDescription: z.string().nullable().optional(),
    linkedForeshadowId: z.string().nullable().optional(),
    linkedConflictId: z.string().nullable().optional(),
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
  // 角色弧光（v0.2：角色内心阶段演进）
  // ═══════════════════════════════════════════════════════════════

  const createCharacterArcSchema = z.object({
    characterId: z.string().min(1),
    arcType: z.enum(['growth', 'fall', 'redemption', 'shift']),
    currentStage: z.string().min(1),
    stageHistory: z.array(z.object({
      stage: z.string(),
      triggerEvent: z.string(),
      description: z.string(),
      chapterNumber: z.number().int(),
      changedAt: z.number(),
    })).default([]),
    description: z.string().nullable().default(null),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/character-arcs',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createCharacterArcSchema, request, reply)
      if (!input) return reply

      const arc = store.createCharacterArc({
        id: randomUUID(),
        projectId: request.params.projectId,
        ...input,
      })
      return success(arc, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/character-arcs',
    handler: async (request: any) => {
      return success(store.listCharacterArcs(request.params.projectId), request.traceId)
    },
  })

  // PUT 角色弧光：所有字段 .optional() 无 .default()，避免覆盖未传字段
  const updateCharacterArcSchema = z.object({
    characterId: z.string().min(1).optional(),
    arcType: z.enum(['growth', 'fall', 'redemption', 'shift']).optional(),
    currentStage: z.string().min(1).optional(),
    stageHistory: z.array(z.object({
      stage: z.string(),
      triggerEvent: z.string(),
      description: z.string(),
      chapterNumber: z.number().int(),
      changedAt: z.number(),
    })).optional(),
    description: z.string().nullable().optional(),
  })

  routes.push({
    method: 'PUT',
    path: '/character-arcs/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateCharacterArcSchema, request, reply)
      if (!input) return reply

      const updated = store.updateCharacterArc(request.params.id, input)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `角色弧光不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/character-arcs/:id',
    handler: async (request: any) => {
      const deleted = store.deleteCharacterArc(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `角色弧光不存在: ${request.params.id}`, 404)
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
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/clues',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createClueSchema, request, reply)
      if (!input) return reply

      const clue = store.createClue({
        id: randomUUID(),
        projectId: request.params.projectId,
        ...input,
      })
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

      const rel = store.createRelationship({
        id: randomUUID(),
        projectId: request.params.projectId,
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

      const updated = store.updateRelationship(request.params.id, input)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `关系不存在: ${request.params.id}`, 404)
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

      const layer = store.createInformationLayer({
        id: randomUUID(),
        projectId: request.params.projectId,
        characterKnowledge: '{}',
        isRevealed: false,
        linkedForeshadows: '[]',
        ...input,
      })
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
      return success(store.listEdges(request.params.projectId), request.traceId)
    },
  })

  const createEdgeSchema = z.object({
    sourceId: z.string().min(1),
    sourceType: z.enum(['project', 'character', 'chapter', 'conflict', 'foreshadow', 'group', 'faction', 'location', 'world_element']),
    targetId: z.string().min(1),
    targetType: z.enum(['project', 'character', 'chapter', 'conflict', 'foreshadow', 'group', 'faction', 'location', 'world_element']),
    edgeType: z.enum(['appearance', 'relationship', 'involvement', 'foreshadow', 'base', 'member', 'hierarchy', 'association']),
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
  // 多 Agent 创作流程（SSE + 检查点）
  // ═══════════════════════════════════════════════════════════════

  // 创作流程启动端点（SSE）
  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters/:chapterNumber/create-flow',
    handler: async (request: any, reply: any) => {
      const { projectId, chapterNumber } = request.params
      const orchestrator = services.orchestrator
      const input = validateBody(createFlowBodySchema, request, reply)
      if (!input) return reply
      const arrangedEntities = input.arrangedEntities
        ? {
            characterIds: input.arrangedEntities.characterIds,
            conflictIds: input.arrangedEntities.conflictIds,
            foreshadowIds: input.arrangedEntities.foreshadowIds,
            factionIds: input.arrangedEntities.factionIds,
            locationIds: input.arrangedEntities.locationIds,
          }
        : undefined

      if (arrangedEntities) {
        const invalid: string[] = []
        for (const id of arrangedEntities.characterIds) {
          if (store.getCharacter(id)?.projectId !== projectId) invalid.push(`character:${id}`)
        }
        for (const id of arrangedEntities.conflictIds) {
          if (store.getConflict(id)?.projectId !== projectId) invalid.push(`conflict:${id}`)
        }
        for (const id of arrangedEntities.foreshadowIds) {
          if (store.getForeshadow(id)?.projectId !== projectId) invalid.push(`foreshadow:${id}`)
        }
        for (const id of arrangedEntities.factionIds) {
          if (store.getFaction(id)?.projectId !== projectId) invalid.push(`faction:${id}`)
        }
        for (const id of arrangedEntities.locationIds) {
          if (store.getLocation(id)?.projectId !== projectId) invalid.push(`location:${id}`)
        }
        if (invalid.length > 0) {
          reply.code(400).send({ ok: false, error: `编排实体不属于当前项目或不存在: ${invalid.join(', ')}` })
          return
        }
      }

      // 设置 SSE
      // 注意：reply.raw.writeHead 绕过 Fastify 的 CORS 中间件，需手动附加 CORS 头，
      // 否则浏览器会以 CORS 策略拦截跨域 SSE 请求（如 localhost:5173 → 127.0.0.1:3900）。
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': request.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true',
      })
      // 禁用 Nagle 算法，确保 SSE 事件立即 flush 到客户端
      request.raw.socket?.setNoDelay(true)

      const heartbeat = setInterval(() => {
        reply.raw.write(': keepalive\n\n')
      }, 15000)

      const emitter = createNovelAgUiEmitter(
        createSseEmitterSink((data) => reply.raw.write(data)),
        `novel:chapter:${projectId}:${chapterNumber}`,
        randomUUID(),
      )

      try {
        const result = await orchestrator.createChapterWithFlow(
          projectId,
          parseInt(chapterNumber, 10),
          {
            emit: emitter.emit,
            onCheckpoint: async (checkpoint) => {
              // 通过 ConfirmationManager 发起决策请求
              // timeoutMs=0 表示无超时：用户可能需要长时间阅读/checkpoint 内容并思考，
              // 不应因超时自动 reject 导致弹框消失、创作被取消
              const toolCallId = randomUUID()
              const decisionPromise = services.confirmationManager.requestDecision({
                threadId: `novel-checkpoint-${projectId}-${chapterNumber}`,
                toolCallId,
                toolName: `checkpoint_${checkpoint.type}`,
                args: { checkpoint } as Record<string, unknown>,
                reason: `等待用户确认 ${checkpoint.type} 检查点`,
              }, 0)
              // requestDecision 内部已同步把 pending 加入 Map，listPending 立即可见
              // 通过 toolCallId 反查拿到 ConfirmationRequest.id，推给前端用于决策路由
              const pending = services.confirmationManager.listPending().find((r) => r.toolCallId === toolCallId)
              emitter.checkpoint({ ...checkpoint, checkpointId: pending?.id })
              return decisionPromise as Promise<'approve' | 'reject' | 'revise' | 'rewrite'>
            },
            onProgress: (event) => emitter.progress(event),
            arrangedEntities,
          },
        )
        emitter.result(result)
      } catch (err) {
        emitter.error(String(err))
      } finally {
        clearInterval(heartbeat)
        reply.raw.end()
      }
    },
  })

  // 检查点决策端点
  // 路径参数 :checkpointId 对应 ConfirmationManager 内部生成的 ConfirmationRequest.id
  // （由 onCheckpoint 在创建决策请求后通过 SSE 推送给前端，前端在用户点决策时回传）
  // type 仍在 body 中传递，便于日志/校验（不再作为路由参数）
  routes.push({
    method: 'POST',
    path: '/projects/:projectId/checkpoint/:checkpointId/decision',
    handler: async (request: any, reply: any) => {
      const { projectId, checkpointId } = request.params as { projectId: string; checkpointId: string }
      const { decision, userMessages } = request.body as { decision: string; userMessages?: string[] }
      const pending = services.confirmationManager.listPending().find((r) => r.id === checkpointId)
      if (!pending || !pending.threadId.startsWith(`novel-checkpoint-${projectId}-`)) {
        reply.code(404).send({ ok: false, error: '检查点不存在或已处理' })
        return
      }
      // 委托 ConfirmationManager 响应决策（resolve 对应 pending Promise）
      const accepted = services.confirmationManager.respondDecision(checkpointId, decision)
      if (!accepted) {
        reply.code(404).send({ ok: false, error: '检查点不存在或已处理' })
        return
      }
      // 确认 checkpoint 有效后再写用户消息，避免过期/跨项目请求污染下一轮 Agent。
      if (userMessages && userMessages.length > 0) {
        services.orchestrator.setUserMessages(userMessages)
      }
      return { ok: true, data: { accepted: true } }
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 群聊共创模式（SSE + 检查点）
  // ═══════════════════════════════════════════════════════════════

  // 群聊创作流程启动端点（SSE）
  // 与 /create-flow 结构一致，把 orchestrator.createChapterWithFlow 换成 discussionRunner.run。
  // 每次运行时从 discussionSettingsStore 读取最新 moderatorModel，使 PUT /discussion-settings 的修改即时生效。
  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters/:chapterNumber/create-discussion',
    handler: async (request: any, reply: any) => {
      const { projectId, chapterNumber } = request.params
      const discussionRunner = services.discussionRunner

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
      request.raw.socket?.setNoDelay(true)

      const heartbeat = setInterval(() => {
        reply.raw.write(': keepalive\n\n')
      }, 15000)

      const emitter = createNovelAgUiEmitter(
        createSseEmitterSink((data) => reply.raw.write(data)),
        `novel:discussion:${projectId}:${chapterNumber}`,
        randomUUID(),
      )

      try {
        // 运行时读取最新设置，让 moderatorModel / 其他参数的修改即时生效
        const settings = services.discussionSettingsStore.get()
        const result = await discussionRunner.run(
          projectId,
          parseInt(chapterNumber, 10),
          {
            emit: emitter.emit,
            onCheckpoint: async (checkpoint) => {
              // 通过 ConfirmationManager 发起决策请求（与 create-flow 的 onCheckpoint 一致）
              // timeoutMs=0 表示无超时：用户可能需要长时间阅读检查点内容并思考
              const toolCallId = randomUUID()
              const decisionPromise = services.confirmationManager.requestDecision({
                threadId: `novel-discussion-${projectId}-${chapterNumber}`,
                toolCallId,
                toolName: `discussion_${checkpoint.type}`,
                args: { checkpoint } as Record<string, unknown>,
                reason: `等待用户确认群聊检查点：${checkpoint.question}`,
              }, 0)
              // requestDecision 内部已同步把 pending 加入 Map，listPending 立即可见
              const pending = services.confirmationManager.listPending().find((r) => r.toolCallId === toolCallId)
              emitter.checkpoint({ ...checkpoint, checkpointId: pending?.id })
              return decisionPromise as Promise<'approve' | 'reject' | 'revise' | string>
            },
            onProgress: (event) => emitter.progress(event),
            moderatorModel: settings.moderatorModel,
          },
        )
        emitter.result(result)
      } catch (err) {
        emitter.error(String(err))
      } finally {
        clearInterval(heartbeat)
        reply.raw.end()
      }
    },
  })

  // 群聊检查点决策端点
  // 与 create-flow 的 checkpoint decision 端点对应，threadId 前缀为 novel-discussion-。
  // 不调用 orchestrator.setUserMessages（群聊流程的用户消息机制独立于 orchestrator）。
  routes.push({
    method: 'POST',
    path: '/projects/:projectId/discussion-checkpoint/:checkpointId/decision',
    handler: async (request: any, reply: any) => {
      const { projectId, checkpointId } = request.params as { projectId: string; checkpointId: string }
      const { decision } = request.body as { decision: string }
      const pending = services.confirmationManager.listPending().find((r) => r.id === checkpointId)
      if (!pending || !pending.threadId.startsWith(`novel-discussion-${projectId}-`)) {
        reply.code(404).send({ ok: false, error: '群聊检查点不存在或已处理' })
        return
      }
      // 委托 ConfirmationManager 响应决策（resolve 对应 pending Promise）
      const accepted = services.confirmationManager.respondDecision(checkpointId, decision)
      if (!accepted) {
        reply.code(404).send({ ok: false, error: '群聊检查点不存在或已处理' })
        return
      }
      return { ok: true, data: { accepted: true } }
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 群聊模式设置
  // ═══════════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/discussion-settings',
    handler: async (request: any) => {
      return success(services.discussionSettingsStore.get(), request.traceId)
    },
  })

  const updateDiscussionSettingsSchema = z.object({
    moderatorModel: z.object({
      provider: z.string().min(1),
      modelId: z.string().min(1),
    }).optional(),
    maxRounds: z.number().int().min(1).optional(),
    maxRoundsPerScene: z.number().int().min(1).optional(),
    characterTemperature: z.number().min(0).max(2).optional(),
  })

  routes.push({
    method: 'PUT',
    path: '/discussion-settings',
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateDiscussionSettingsSchema, request, reply)
      if (!input) return reply
      services.discussionSettingsStore.update(input)
      return success(services.discussionSettingsStore.get(), request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 模式2：AI 编排（SSE）——按章纲生成实体并编排到矩阵，不生成正文
  // ═══════════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters/:chapterNumber/ai-arrange',
    handler: async (request: any, reply: any) => {
      const { projectId, chapterNumber } = request.params
      const entityGenerator = services.entityGenerator

      // 并发锁：同一章节不允许并发 ai-arrange，避免重复生成实体
      const lockKey = `${projectId}:${chapterNumber}`
      if (aiArrangeLocks.has(lockKey)) {
        reply.code(409).send({ error: '该章节正在编排中，请稍后' })
        return
      }

      // 客户端断开感知：必须监听 reply.raw（response）的 close 事件，
      // 而非 request.raw（IncomingMessage）的 close。
      // 原因：request.raw 的 close 事件在 POST 请求体读取完成后立即触发（非客户端断开），
      // 会导致 clientDisconnected 被误判为 true，之后所有 SSE 事件被 writeRaw 静默丢弃。
      // reply.raw 的 close 事件在 response 流关闭时触发，
      // 配合 writableEnded 检查可区分"正常结束"与"客户端中途断开"。
      let clientDisconnected = false
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) clientDisconnected = true
      })

      // SSE 设置（与 create-flow 一致，绕过 Fastify CORS 中间件需手动附加 CORS 头）
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': request.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true',
      })
      // 禁用 Nagle 算法，确保 SSE 事件立即 flush 到客户端
      request.raw.socket?.setNoDelay(true)
      const writeRaw = (data: string) => {
        if (clientDisconnected || reply.raw.writableEnded) return
        reply.raw.write(data)
      }
      const emitter = createNovelAgUiEmitter(
        createSseEmitterSink(writeRaw),
        `novel:arrange:${projectId}:${chapterNumber}`,
        randomUUID(),
      )
      const heartbeat = setInterval(() => {
        if (clientDisconnected || reply.raw.writableEnded) return
        reply.raw.write(': keepalive\n\n')
      }, 15000)

      // 锁置入 try 块开头：确保 finally 必定执行 delete，避免 SSE 设置抛错导致锁残留
      try {
        aiArrangeLocks.set(lockKey, Promise.resolve())
        const chNum = parseInt(chapterNumber, 10)
        const chapter = store.getChapter(projectId, chNum)
        if (!chapter) throw new Error(`章节不存在: ${chNum}`)
        if (!chapter.outline?.trim()) throw new Error('章纲为空，无法 AI 编排')

        // 阶段1：AI 编排（生成实体并落库到本章列）
        // 注意：本接口仅做矩阵编排，不衔接 create-flow 创作流程。
        // arrange 进度事件统一带 phase='arranging'，前端据此在对话时间线展示处理步骤。
        emitter.progress({ type: 'arrange_start', phase: 'arranging', message: '开始 AI 编排实体...' })
        const arrangedEntities = await entityGenerator.generateAndArrange(
          projectId,
          chNum,
          chapter.outline,
          // 注意：...evt 必须放在 phase 之前，否则 evt.phase 会覆盖 'arranging'，
          // 导致前端无法识别为编排阶段（前端以 phase='arranging' 作为对话气泡判定条件）。
          (evt) => emitter.progress({ type: 'arrange_progress', ...evt, phase: 'arranging' }),
        )
        const totalCount = arrangedEntities.characterIds.length
          + arrangedEntities.conflictIds.length
          + arrangedEntities.foreshadowIds.length
          + arrangedEntities.factionIds.length
          + arrangedEntities.locationIds.length
        emitter.progress({
          type: 'arrange_done',
          phase: 'arranging',
          message: `编排完成：共生成 ${totalCount} 个实体已落入矩阵`,
          data: arrangedEntities,
          // 携带 detail 用于前端展示编排结果汇总气泡（与 arranged 阶段事件互补）
          detail: {
            kind: 'arrange_summary',
            total: totalCount,
            characters: arrangedEntities.characterIds.length,
            conflicts: arrangedEntities.conflictIds.length,
            foreshadows: arrangedEntities.foreshadowIds.length,
            factions: arrangedEntities.factionIds.length,
            locations: arrangedEntities.locationIds.length,
          },
        })
        // 编排结束：发 result（status=completed，不带 content），前端据此显示"编排完成"并关闭面板
        emitter.result({
          status: 'completed',
          stateChanges: [{
            type: 'arrange',
            description: `AI 编排完成，已生成 ${totalCount} 个实体落入第 ${chNum} 章矩阵`,
          }],
        })
      } catch (err) {
        emitter.error(String(err))
      } finally {
        clearInterval(heartbeat)
        if (!reply.raw.writableEnded) reply.raw.end()
        aiArrangeLocks.delete(lockKey)
      }
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 模式3：从已写好的正文反推实体到矩阵（SSE）
  // 用户手写了章节正文，调用此接口从正文提取实体（角色/冲突/伏笔/势力/地点）并落库到矩阵
  // ═══════════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters/:chapterNumber/reverse-arrange',
    handler: async (request: any, reply: any) => {
      const { projectId, chapterNumber } = request.params
      const entityGenerator = services.entityGenerator

      // 并发锁：与 ai-arrange 共用锁池，同一章节不允许并发编排
      const lockKey = `${projectId}:${chapterNumber}`
      if (aiArrangeLocks.has(lockKey)) {
        reply.code(409).send({ error: '该章节正在编排中，请稍后' })
        return
      }

      let clientDisconnected = false
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) clientDisconnected = true
      })

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': request.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true',
      })
      request.raw.socket?.setNoDelay(true)
      const writeRaw = (data: string) => {
        if (clientDisconnected || reply.raw.writableEnded) return
        reply.raw.write(data)
      }
      const emitter = createNovelAgUiEmitter(
        createSseEmitterSink(writeRaw),
        `novel:reverse-arrange:${projectId}:${chapterNumber}`,
        randomUUID(),
      )
      const heartbeat = setInterval(() => {
        if (clientDisconnected || reply.raw.writableEnded) return
        reply.raw.write(': keepalive\n\n')
      }, 15000)

      try {
        aiArrangeLocks.set(lockKey, Promise.resolve())
        const chNum = parseInt(chapterNumber, 10)
        const chapter = store.getChapter(projectId, chNum)
        if (!chapter) throw new Error(`章节不存在: ${chNum}`)
        if (!chapter.content?.trim()) throw new Error('章节正文为空，无法反推实体')

        emitter.progress({ type: 'arrange_start', phase: 'arranging', message: '开始从正文反推实体...' })
        const arrangedEntities = await entityGenerator.generateAndArrange(
          projectId,
          chNum,
          chapter.content,
          (evt) => emitter.progress({ type: 'arrange_progress', ...evt, phase: 'arranging' }),
          'content', // source='content' 表示从正文反推
        )
        const totalCount = arrangedEntities.characterIds.length
          + arrangedEntities.conflictIds.length
          + arrangedEntities.foreshadowIds.length
          + arrangedEntities.factionIds.length
          + arrangedEntities.locationIds.length
        emitter.progress({
          type: 'arrange_done',
          phase: 'arranging',
          message: `反推完成：共提取 ${totalCount} 个实体已落入矩阵`,
          data: arrangedEntities,
          detail: {
            kind: 'arrange_summary',
            total: totalCount,
            characters: arrangedEntities.characterIds.length,
            conflicts: arrangedEntities.conflictIds.length,
            foreshadows: arrangedEntities.foreshadowIds.length,
            factions: arrangedEntities.factionIds.length,
            locations: arrangedEntities.locationIds.length,
          },
        })
        emitter.result({
          status: 'completed',
          stateChanges: [{
            type: 'reverse-arrange',
            description: `从正文反推完成，已提取 ${totalCount} 个实体落入第 ${chNum} 章矩阵`,
          }],
        })
      } catch (err) {
        emitter.error(String(err))
      } finally {
        clearInterval(heartbeat)
        if (!reply.raw.writableEnded) reply.raw.end()
        aiArrangeLocks.delete(lockKey)
      }
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // TeamManager 统一触发（pipeline 策略：Director → Writer → Reviewer → Reviser → Memory）
  // ═══════════════════════════════════════════════════════════════

  const createTeamSchema = z.object({
    narrativeTask: z.string().min(1).describe('本章叙事任务描述'),
    rhythm: z.string().optional().describe('节奏建议（可选）'),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters/:chapterNumber/create-team',
    handler: async (request: any, reply: any) => {
      const { projectId, chapterNumber } = request.params as { projectId: string; chapterNumber: string }
      const input = validateBody(createTeamSchema, request, reply)
      if (!input) return reply

      const teamManager = services.teamManager
      if (!teamManager) {
        throw new AppError(
          ErrorCode.CONFIG_ERROR,
          'TeamManager 不可用（teamPlugin 未注册或 plugin-loader 未注入），无法触发团队创作',
          503,
        )
      }

      const team = teamManager.getTeam('novel-team')
      if (!team) {
        throw new AppError(
          ErrorCode.CONFIG_ERROR,
          'Novel Team 未注册，请检查 novel-plugin 初始化日志',
          503,
        )
      }

      const project = store.getProject(projectId)
      if (!project) {
        throw new AppError(ErrorCode.NOT_FOUND, `项目不存在: ${projectId}`, 404)
      }

      const chapterNum = parseInt(chapterNumber, 10)
      if (Number.isNaN(chapterNum) || chapterNum < 1) {
        throw new AppError(ErrorCode.BAD_REQUEST, `无效的 chapterNumber: ${chapterNumber}`, 400)
      }

      // 构建团队任务描述（pipeline 下作为首个 Agent 的输入，后续 Agent 接收前一阶段输出）
      const task = [
        `为项目《${project.title}》创作第 ${chapterNum} 章。`,
        `叙事任务：${input.narrativeTask}`,
        input.rhythm ? `节奏建议：${input.rhythm}` : '',
      ].filter(Boolean).join('\n')

      const result = await teamManager.execute('novel-team', task, {
        strategy: 'pipeline',
      })

      return success(result, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // Agent 调用日志（记录每次 Agent 调用的完整上下文：系统提示词/章节上下文/任务指令/工具/结果）
  // ═══════════════════════════════════════════════════════════════

  // 列出日志（精简字段，支持按章节/Agent 类型过滤）
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/agent-logs',
    handler: async (request: any) => {
      const { projectId } = request.params as { projectId: string }
      const query = request.query as {
        chapterNumber?: string
        agentType?: string
        limit?: string
      }
      const limit = query.limit ? parseInt(query.limit, 10) : 100
      const filter: { chapterNumber?: number; agentType?: string } = {}
      if (query.chapterNumber != null) {
        const n = parseInt(query.chapterNumber, 10)
        if (!Number.isNaN(n)) filter.chapterNumber = n
      }
      if (query.agentType) filter.agentType = query.agentType

      const logs = store.listAgentLogs(projectId, Object.keys(filter).length > 0 ? filter : undefined, limit)
      return success(logs, request.traceId)
    },
  })

  // 获取单条日志详情（含完整 systemPrompt / userMessage / result 全文）
  routes.push({
    method: 'GET',
    path: '/agent-logs/:id',
    handler: async (request: any) => {
      const log = store.getAgentLog(request.params.id)
      if (!log) throw new AppError(ErrorCode.NOT_FOUND, `日志不存在: ${request.params.id}`, 404)
      return success(log, request.traceId)
    },
  })

  // 删除项目下所有日志
  routes.push({
    method: 'DELETE',
    path: '/projects/:projectId/agent-logs',
    handler: async (request: any) => {
      const deleted = store.deleteAgentLogsByProject(request.params.projectId)
      return success({ projectId: request.params.projectId, deleted }, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 时间轴标记
  // ═══════════════════════════════════════════════════════════════

  const createMarkerSchema = z.object({
    chapter: z.number().int().min(1),
    title: z.string().default(''),
    note: z.string().default(''),
    type: z.enum(['bookmark', 'turning-point', 'foreshadow', 'climax', 'note', 'clip-note']).default('bookmark'),
    color: z.enum(['blue', 'yellow', 'green', 'red', 'purple']).default('blue'),
    entityType: z.string().nullable().default(null),
    entityId: z.string().nullable().default(null),
  })

  const updateMarkerSchema = z.object({
    chapter: z.number().int().min(1).optional(),
    title: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    type: z.enum(['bookmark', 'turning-point', 'foreshadow', 'climax', 'note', 'clip-note']).optional(),
    color: z.enum(['blue', 'yellow', 'green', 'red', 'purple']).optional(),
    entityType: z.string().nullable().optional(),
    entityId: z.string().nullable().optional(),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/markers',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createMarkerSchema, request, reply)
      if (!input) return reply

      const marker = store.createMarker({
        id: randomUUID(),
        projectId: request.params.projectId,
        ...input,
      })
      return success(marker, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/markers',
    handler: async (request: any) => {
      return success(store.listMarkers(request.params.projectId), request.traceId)
    },
  })

  routes.push({
    method: 'PATCH',
    path: '/markers/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateMarkerSchema, request, reply)
      if (!input) return reply

      const updated = store.updateMarker(request.params.id, input as Partial<NovelMarker>)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `标记不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/markers/:id',
    handler: async (request: any) => {
      const deleted = store.deleteMarker(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `标记不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 小说 Agent 角色温度配置（全局，不按 project 区分）
  // ═══════════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/agent-config',
    handler: async (request: any) => {
      const temperatures = agentConfigStore.getAll()
      const result = (Object.entries(temperatures) as Array<[string, number]>).map(([agentType, temperature]) => ({
        agentType,
        temperature,
      }))
      return success(result, request.traceId)
    },
  })

  const updateAgentConfigSchema = z.object({
    items: z.array(z.object({
      agentType: z.enum(['director', 'writer', 'reviewer', 'memory']),
      temperature: z.number().min(0).max(2),
    })),
  })

  routes.push({
    method: 'PUT',
    path: '/agent-config',
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateAgentConfigSchema, request, reply)
      if (!input) return reply
      agentConfigStore.upsertMany(input.items)
      // NovelAgentConfigStore 内部已通过 agentManager.updateAgent 同步温度，
      // subagent / team_execute 路径立即可见，无需手动同步
      const temperatures = agentConfigStore.getAll()
      const result = (Object.entries(temperatures) as Array<[string, number]>).map(([agentType, temperature]) => ({
        agentType,
        temperature,
      }))
      return success(result, request.traceId)
    },
  })

  return routes
}
