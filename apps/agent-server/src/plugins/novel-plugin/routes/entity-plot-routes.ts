import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

export function createEntityPlotRoutes(services: NovelServices): RouteDefinition[] {
  const { store } = services
  const routes: RouteDefinition[] = []
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
      const { linkedCharacters: _lc, linkedClues: _lcl, linkedInfoLayers: _lil, ...patch } = input
      const updated = store.updateForeshadow(request.params.id, patch)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, '伏笔不存在: ' + request.params.id, 404)
      return success(updated, request.traceId)
    },
  })

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
  return routes
}
