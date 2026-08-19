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
import { success } from '../../lib/api-response.js'
import { validateBody } from '../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { evaluateProseQuality } from './core/quality/prose-quality-evaluator.js'
import { createChapterRoutes } from './routes/chapter-routes.js'
import { createChapterOutlineRoutes } from './routes/chapter-outline-routes.js'
import { createCharacterRoutes } from './routes/character-routes.js'
import { createEntityCandidateRoutes } from './routes/entity-candidate-routes.js'
import { createCreationFlowRoutes } from './routes/creation-flow-routes.js'
import { createStoryLedgerRoutes } from './routes/story-ledger-routes.js'
import { createNarrativeRevisionRoutes } from './routes/narrative-revision-routes.js'
import { createReferenceAnalysisRoutes } from './routes/reference-analysis-routes.js'
import { createReferenceRunRoutes } from './routes/reference-run-routes.js'
import { createReferenceTemplateRoutes } from './routes/reference-template-routes.js'
import { createContextPreviewRoutes } from './routes/context-preview-routes.js'
import { createProjectRoutes } from './routes/project-routes.js'
import { createVolumeRoutes } from './routes/volume-routes.js'
import { createPromptRoutes } from './routes/prompt-routes.js'
import { createNarrativeRoutes } from './routes/narrative-routes.js'
import { createObservabilityRoutes } from './routes/observability-routes.js'
import { createGraphRoutes } from './routes/graph-routes.js'
import { createMemoryRoutes } from './routes/memory-routes.js'
import { createEntityDeleteRoutes } from './routes/entity-delete-routes.js'
import { createCacheRoutes } from './routes/cache-routes.js'
import { createEntityMaintenanceRoutes } from './routes/entity-maintenance-routes.js'
import { distillStyleExpert } from './core/prompting/style-expert-distiller.js'

/**
 * 创建小说系统 REST API 路由
 *
 * PR-6 路由聚合入口：高密度模块已拆分到 routes/ 子目录，
 * 此处保留信息差关联、伏笔/冲突/线索/关系、世界观实体等尚未形成独立领域包的路由。
 *
 * 拆分清单（按路由注册顺序）：
 * - 章节 CRUD + 版本历史 + 节奏控制 → ./routes/chapter-routes.ts
 * - 角色 CRUD + AI 生成 + 历史 + 弧光 → ./routes/character-routes.ts
 * - 创作流程 SSE + 检查点 + 群聊 + ai-arrange + markers + agent-config + chat
 *   → ./routes/creation-flow-routes.ts
 * - 项目/卷/提示词/剧情/图谱/记忆/可观测性/缓存/实体维护/删除
 *   → ./routes/*-routes.ts
 *
 * 模块级单例状态（aiArrangeLocks / chapterCreationLocks / activeNovelChapterTasks）
 * 与 SSE 工具（createNovelAgUiEmitter / createSseEmitterSink）已迁至 ./utils/，
 * 由各子路由文件共享同一实例。
 */
export function createNovelRoutes(services: NovelServices): RouteDefinition[] {
  const { store, promptBuilder } = services
  const routes: RouteDefinition[] = [
    ...createProjectRoutes(services),
    ...createVolumeRoutes(services),
    ...createStoryLedgerRoutes(services),
    ...createNarrativeRevisionRoutes(services),
    ...createReferenceAnalysisRoutes(services),
    ...createReferenceRunRoutes(services),
    ...createReferenceTemplateRoutes(services),
    ...createPromptRoutes(services),
    ...createNarrativeRoutes(services),
    ...createObservabilityRoutes(services),
    ...createGraphRoutes(services),
    ...createMemoryRoutes(services),
    ...createEntityDeleteRoutes(services),
    ...createCacheRoutes(services),
    ...createEntityMaintenanceRoutes(services),
  ]

  // P1 可观测性：context-preview 端点，预览 prompt-builder 注入的上下文结构
  // T03-8：p3/context-report 端点（灰度看板聚合，engine 用于真实构建 constraints）
  routes.push(...createContextPreviewRoutes(promptBuilder, store, services.engine))

  // ═══════════════════════════════════════════════════════════════
  // 项目管理
  // ═══════════════════════════════════════════════════════════════

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

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/writing-style-experts/:expertId/versions',
    handler: async (request: any) => success(store.listStyleExpertVersions(request.params.projectId, request.params.expertId), request.traceId),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/writing-style-experts/:expertId/rollback',
    handler: async (request: any, reply: any) => {
      const input = z.object({ version: z.number().int().positive() }).parse(request.body ?? {})
      const expert = store.rollbackStyleExpert(request.params.projectId, request.params.expertId, input.version)
      if (!expert) return reply.code(404).send({ ok: false, error: '文风专家版本不存在' })
      return success(expert, request.traceId)
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

  // ═══════════════════════════════════════════════════════════════
  // 章节管理（章节 CRUD + 版本历史 + 节奏控制）
  // 已迁移至 ./routes/chapter-routes.ts（PR-6）
  // ═══════════════════════════════════════════════════════════════
  routes.push(...createChapterRoutes(services))
  routes.push(...createChapterOutlineRoutes(services))

  // ═══════════════════════════════════════════════════════════════
  // 角色（CRUD + AI 生成 + 历史 + 弧光）
  // 已迁移至 ./routes/character-routes.ts（PR-6）
  // ═══════════════════════════════════════════════════════════════
  routes.push(...createCharacterRoutes(services))
  routes.push(...createEntityCandidateRoutes(services))

  // 通用实体维护路由已迁移至 ./routes/entity-maintenance-routes.ts。

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

  const distillStyleExpertSchema = z.object({
    sourceTitle: z.string().trim().min(1).max(160),
    sourceAuthor: z.string().trim().max(100).optional(),
    sample: z.string().trim().min(80).max(30000),
    notes: z.string().trim().max(2000).optional(),
    modelId: z.object({ provider: z.string(), modelId: z.string() }).optional(),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/writing-style-experts/distill',
    handler: async (request: any, reply: any) => {
      const input = validateBody(distillStyleExpertSchema, request, reply)
      if (!input) return reply
      const draft = await distillStyleExpert(services.context, input, input.modelId)
      return success(draft, request.traceId)
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
    styleExperts: z.array(z.object({
      id: z.string().trim().min(1).max(80),
      name: z.string().trim().min(1).max(40),
      sourceTitle: z.string().trim().min(1).max(160),
      sourceAuthor: z.string().trim().max(100).optional(),
      description: z.string().trim().min(1).max(400),
      distilledPrompt: z.string().trim().min(1).max(3000).optional(),
      prompt: z.string().trim().min(1).max(3000).optional(),
      customPrompt: z.string().trim().max(3000).nullable().optional(),
      metrics: z.record(z.string(), z.unknown()).optional(),
      techniques: z.array(z.unknown()).optional(),
      exclusions: z.array(z.string()).optional(),
      exemplarPassages: z.array(z.unknown()).optional(),
      distillMeta: z.record(z.string(), z.unknown()).optional(),
      enabled: z.boolean().default(true),
    }).refine((expert) => Boolean(expert.distilledPrompt ?? expert.prompt), {
      message: '文风专家必须提供 distilledPrompt 或 prompt',
      path: ['distilledPrompt'],
    })).max(8).default([]),
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/writing-style-profile',
    handler: async (request: any) => {
      return success(store.getWritingStyleProfile(request.params.projectId) ?? null, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/writing-style-experts',
    handler: async (request: any) => success(store.listStyleExperts(request.params.projectId), request.traceId),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/writing-style-experts',
    handler: async (request: any, reply: any) => {
      const input = z.object({
        name: z.string().trim().min(1).max(80), sourceTitle: z.string().trim().min(1).max(160),
        sourceAuthor: z.string().trim().max(100).optional(), description: z.string().trim().min(1).max(400),
        distilledPrompt: z.string().trim().min(1).max(3000), customPrompt: z.string().trim().max(3000).optional(),
        enabled: z.boolean().default(true), sortOrder: z.number().int().min(0).max(1000).default(0),
        distillMeta: z.record(z.string(), z.unknown()).optional(),
        metrics: z.record(z.string(), z.unknown()).optional(),
        techniques: z.array(z.unknown()).optional(),
        exclusions: z.array(z.string()).optional(),
        exemplarPassages: z.array(z.unknown()).optional(),
      }).parse(request.body ?? {})
      const expert = store.createStyleExpert({
        id: randomUUID(), projectId: request.params.projectId, ...input, version: 1,
        createdAt: Date.now(), updatedAt: Date.now(),
      })
      return success(expert, request.traceId)
    },
  })

  routes.push({
    method: 'PATCH',
    path: '/projects/:projectId/writing-style-experts/:expertId',
    handler: async (request: any, reply: any) => {
      const input = z.object({
        name: z.string().trim().min(1).max(80).optional(),
        sourceTitle: z.string().trim().min(1).max(160).optional(),
        sourceAuthor: z.string().trim().max(100).optional(),
        description: z.string().trim().min(1).max(400).optional(),
        customPrompt: z.string().trim().min(1).max(3000).nullable().optional(),
        enabled: z.boolean().optional(),
        sortOrder: z.number().int().min(0).max(1000).optional(),
      }).parse(request.body ?? {})
      const expert = store.updateStyleExpert(request.params.projectId, request.params.expertId, input)
      if (!expert) return reply.code(404).send({ ok: false, error: '文风专家不存在' })
      return success(expert, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/projects/:projectId/writing-style-experts/:expertId',
    handler: async (request: any, reply: any) => {
      const deleted = store.deleteStyleExpert(request.params.projectId, request.params.expertId)
      if (!deleted) return reply.code(404).send({ ok: false, error: '文风专家不存在' })
      return success({ id: request.params.expertId, deleted: true }, request.traceId)
    },
  })

  routes.push({
    method: 'PUT',
    path: '/projects/:projectId/writing-style-profile',
    handler: async (request: any, reply: any) => {
      const input = validateBody(writingStyleProfileSchema, request, reply)
      if (!input) return reply
      const normalizedStyleExperts = input.styleExperts?.map((expert: any, index: number) => ({
        id: expert.id,
        projectId: request.params.projectId,
        name: expert.name,
        sourceTitle: expert.sourceTitle,
        sourceAuthor: expert.sourceAuthor,
        description: expert.description,
        distilledPrompt: expert.distilledPrompt ?? expert.prompt,
        customPrompt: expert.customPrompt,
        metrics: expert.metrics,
        techniques: expert.techniques,
        exclusions: expert.exclusions,
        exemplarPassages: expert.exemplarPassages,
        distillMeta: expert.distillMeta,
        enabled: expert.enabled,
        sortOrder: expert.sortOrder ?? index,
        version: expert.version ?? 1,
        createdAt: expert.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      }))
      const { styleExperts: _rawStyleExperts, ...profileInput } = input
      const profile = store.upsertWritingStyleProfile(request.params.projectId, {
        ...profileInput,
        ...(normalizedStyleExperts ? { styleExperts: normalizedStyleExperts } : {}),
      } as any)
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
  // 多 Agent 创作流程 / 群聊 / ai-arrange / 反推 / create-team /
  // agent-logs / markers / agent-config / 章节聊天
  // 已迁移至 ./routes/creation-flow-routes.ts（PR-6）
  // ═══════════════════════════════════════════════════════════════
  routes.push(...createCreationFlowRoutes(services))

  return routes
}
