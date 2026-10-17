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
const chapterSpanSchema = Type.Tuple([Type.Integer(), Type.Integer()])
const positiveChapterSpanSchema = Type.Tuple([Type.Integer({ minimum: 1 }), Type.Integer({ minimum: 1 })])

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

const foreshadowBodySchema = Type.Object({
  description: Type.String({ minLength: 1 }),
  category: Type.Optional(Type.Union([
    Type.Literal('item'), Type.Literal('spoken'), Type.Literal('event'), Type.Literal('identity'),
    Type.Literal('secret'), Type.Literal('prophecy'), Type.Literal('promise'), Type.Literal('quote'),
  ])),
  status: Type.Optional(Type.Union([
    Type.Literal('planned'), Type.Literal('planted'), Type.Literal('reinforced'), Type.Literal('partially_revealed'),
    Type.Literal('recovering'), Type.Literal('recovered'), Type.Literal('abandoned'),
  ])),
  firstChapter: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  lastChapter: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  recoverByChapter: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  plantMethod: Type.Optional(Type.Union([Type.Literal('explicit'), Type.Literal('implicit'), Type.Literal('indirect')])),
  recoverMethod: Type.Optional(Type.Union([
    Type.Literal('explicit'), Type.Literal('implicit'), Type.Literal('reverse'), Type.Literal('progressive'),
  ])),
  chapterSpans: Type.Optional(Type.Array(chapterSpanSchema)),
  beats: Type.Optional(Type.Array(Type.Object({
    chapter: Type.Integer({ minimum: 1 }),
    type: Type.Union([Type.Literal('plant'), Type.Literal('reinforce'), Type.Literal('reveal'), Type.Literal('payoff')]),
    note: Type.Optional(Type.String()),
  }, { additionalProperties: false }))),
  linkedCharacters: Type.Optional(Type.Array(Type.String())),
  linkedClues: Type.Optional(Type.Array(Type.String())),
  linkedInfoLayers: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: false })

const conflictBodySchema = Type.Object({
  description: Type.String({ minLength: 1 }),
  type: Type.Union([
    Type.Literal('inner'), Type.Literal('relationship'), Type.Literal('faction'), Type.Literal('interest'),
    Type.Literal('moral'), Type.Literal('identity'), Type.Literal('emotional'), Type.Literal('world_rule'),
    Type.Literal('survival'),
  ]),
  intensity: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5 })),
  stage: Type.Optional(Type.Union([
    Type.Literal('latent'), Type.Literal('emerging'), Type.Literal('escalating'), Type.Literal('erupting'),
    Type.Literal('reversing'), Type.Literal('resolved'), Type.Literal('transformed'),
  ], { default: 'latent' })),
  chapterSpans: Type.Optional(Type.Array(chapterSpanSchema, { default: [] })),
  tier: Type.Optional(Type.Union([Type.Literal('main'), Type.Literal('secondary'), Type.Literal('goal')], { default: 'secondary' })),
  participants: Type.Optional(Type.Array(Type.String(), { default: [] })),
  plotFunction: Type.Optional(Type.Union([
    Type.Literal('provide_resource'), Type.Literal('create_obstacle'), Type.Literal('amplify_conflict'),
    Type.Literal('open_phase'), Type.Literal('change_judgment'), Type.Literal('advance_relationship'),
    Type.Literal('reveal_world_rule'),
  ])),
  progressionMode: Type.Optional(Type.Union([
    Type.Literal('linear'), Type.Literal('mutation'), Type.Literal('stagnation'), Type.Literal('regression'),
    Type.Literal('reversal'),
  ])),
  currentStep: Type.Optional(Type.String({ maxLength: 200 })),
  nextStep: Type.Optional(Type.String({ maxLength: 200 })),
}, { additionalProperties: false })

const conflictPatchBodySchema = Type.Object({
  description: Type.Optional(Type.String({ minLength: 1 })),
  type: Type.Optional(Type.Union([
    Type.Literal('inner'), Type.Literal('relationship'), Type.Literal('faction'), Type.Literal('interest'),
    Type.Literal('moral'), Type.Literal('identity'), Type.Literal('emotional'), Type.Literal('world_rule'),
    Type.Literal('survival'),
  ])),
  intensity: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  stage: Type.Optional(Type.Union([
    Type.Literal('latent'), Type.Literal('emerging'), Type.Literal('escalating'), Type.Literal('erupting'),
    Type.Literal('reversing'), Type.Literal('resolved'), Type.Literal('transformed'),
  ])),
  chapterSpans: Type.Optional(Type.Array(chapterSpanSchema)),
  tier: Type.Optional(Type.Union([Type.Literal('main'), Type.Literal('secondary'), Type.Literal('goal')])),
  participants: Type.Optional(Type.Array(Type.String())),
  plotFunction: Type.Optional(Type.Union([
    Type.Literal('provide_resource'), Type.Literal('create_obstacle'), Type.Literal('amplify_conflict'),
    Type.Literal('open_phase'), Type.Literal('change_judgment'), Type.Literal('advance_relationship'),
    Type.Literal('reveal_world_rule'),
  ])),
  progressionMode: Type.Optional(Type.Union([
    Type.Literal('linear'), Type.Literal('mutation'), Type.Literal('stagnation'), Type.Literal('regression'),
    Type.Literal('reversal'),
  ])),
  currentStep: Type.Optional(Type.String({ maxLength: 200 })),
  nextStep: Type.Optional(Type.String({ maxLength: 200 })),
}, { additionalProperties: false })

const hookBodySchema = Type.Object({
  chapterNumber: Type.Integer({ minimum: 1 }),
  hookType: Type.Union([Type.Literal('suspense'), Type.Literal('reversal'), Type.Literal('emotional'), Type.Literal('action')]),
  description: Type.String({ minLength: 1 }),
  status: Type.Optional(Type.Union([Type.Literal('thrown'), Type.Literal('fulfilled'), Type.Literal('abandoned')], { default: 'thrown' })),
  fulfilledAtChapter: Type.Optional(Type.Union([Type.Integer(), Type.Null()], { default: null })),
  fulfilledDescription: Type.Optional(Type.Union([Type.String(), Type.Null()], { default: null })),
  linkedForeshadowId: Type.Optional(Type.Union([Type.String(), Type.Null()], { default: null })),
  linkedConflictId: Type.Optional(Type.Union([Type.String(), Type.Null()], { default: null })),
}, { additionalProperties: false })

const hookPatchBodySchema = Type.Object({
  chapterNumber: Type.Optional(Type.Integer({ minimum: 1 })),
  hookType: Type.Optional(Type.Union([Type.Literal('suspense'), Type.Literal('reversal'), Type.Literal('emotional'), Type.Literal('action')])),
  description: Type.Optional(Type.String({ minLength: 1 })),
  status: Type.Optional(Type.Union([Type.Literal('thrown'), Type.Literal('fulfilled'), Type.Literal('abandoned')])),
  fulfilledAtChapter: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  fulfilledDescription: Type.Optional(Type.Union([Type.String(), Type.Null()])),
}, { additionalProperties: false })

const clueBodySchema = Type.Object({
  description: Type.String({ minLength: 1 }),
  pointsTo: Type.Optional(Type.String({ default: '' })),
  progress: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, default: 0 })),
  currentStep: Type.Optional(Type.String({ default: '' })),
  nextStep: Type.Optional(Type.String({ default: '' })),
  isMisleading: Type.Optional(Type.Boolean({ default: false })),
  linkedForeshadow: Type.Optional(Type.Union([Type.String(), Type.Null()], { default: null })),
  chapterSpans: Type.Optional(Type.Array(positiveChapterSpanSchema, { default: [] })),
}, { additionalProperties: false })

const relationshipBodySchema = Type.Object({
  characterA: Type.String({ minLength: 1 }),
  characterB: Type.String({ minLength: 1 }),
  relationType: Type.String({ minLength: 1 }),
  currentStage: Type.Optional(Type.String({ default: '' })),
  dynamicRole: Type.Optional(Type.String({ default: '' })),
  alignment: Type.Optional(Type.Union([
    Type.Literal('ally'), Type.Literal('temporary_ally'), Type.Literal('opponent'),
    Type.Literal('temporary_opponent'), Type.Literal('neutral'), Type.Literal('pending_shift'),
  ], { default: 'neutral' })),
  trend: Type.Optional(Type.Union([
    Type.Literal('stable'), Type.Literal('warming'), Type.Literal('cooling'), Type.Literal('breaking'),
    Type.Literal('reconciling'),
  ], { default: 'stable' })),
  chapterHint: Type.Optional(Type.String({ default: '' })),
}, { additionalProperties: false })

const relationshipPatchBodySchema = Type.Object({
  characterA: Type.Optional(Type.String({ minLength: 1 })),
  characterB: Type.Optional(Type.String({ minLength: 1 })),
  relationType: Type.Optional(Type.String({ minLength: 1 })),
  currentStage: Type.Optional(Type.String()),
  stageHistory: Type.Optional(Type.String()),
  dynamicRole: Type.Optional(Type.String()),
  alignment: Type.Optional(Type.Union([
    Type.Literal('ally'), Type.Literal('temporary_ally'), Type.Literal('opponent'),
    Type.Literal('temporary_opponent'), Type.Literal('neutral'), Type.Literal('pending_shift'),
  ])),
  trend: Type.Optional(Type.Union([
    Type.Literal('stable'), Type.Literal('warming'), Type.Literal('cooling'), Type.Literal('breaking'),
    Type.Literal('reconciling'),
  ])),
  chapterHint: Type.Optional(Type.String()),
  lastUpdatedChapter: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
}, { additionalProperties: false })

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
    schema: projectRouteSchema(foreshadowBodySchema),
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
    schema: projectRouteSchema(),
    handler: async (request: any) => {
      return success(store.listForeshadowing(request.params.projectId), request.traceId)
    },
  })

  routes.push({
    method: 'PATCH',
    path: '/foreshadowing/:id',
    schema: entityRouteSchema(createPatchBodySchema(foreshadowBodySchema)),
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
    schema: projectRouteSchema(conflictBodySchema),
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
    schema: projectRouteSchema(),
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
    schema: entityRouteSchema(conflictPatchBodySchema),
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
    schema: projectRouteSchema(hookBodySchema),
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
    schema: projectRouteSchema(),
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
    schema: entityRouteSchema(hookPatchBodySchema),
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
    schema: { params: entityParamsSchema, querystring: emptyQuerySchema, response: standardResponseSchema },
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

  const updateClueSchema = z.object({
    description: z.string().min(1).optional(),
    pointsTo: z.string().optional(),
    progress: z.number().int().min(0).max(100).optional(),
    currentStep: z.string().optional(),
    nextStep: z.string().optional(),
    isMisleading: z.boolean().optional(),
    linkedForeshadow: z.string().nullable().optional(),
    chapterSpans: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])).optional(),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/clues',
    schema: projectRouteSchema(clueBodySchema),
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
    schema: projectRouteSchema(),
    handler: async (request: any) => {
      return success(store.listClues(request.params.projectId), request.traceId)
    },
  })

  routes.push({
    method: 'PATCH',
    path: '/clues/:id',
    schema: entityRouteSchema(createPatchBodySchema(clueBodySchema)),
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateClueSchema, request, reply)
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
    schema: projectRouteSchema(relationshipBodySchema),
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
    schema: entityRouteSchema(relationshipPatchBodySchema),
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
    schema: projectRouteSchema(),
    handler: async (request: any) => {
      return success(store.listRelationships(request.params.projectId), request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  return routes
}
