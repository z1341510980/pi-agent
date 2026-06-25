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
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { success } from '../../lib/api-response.js'
import { validateBody } from '../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

/** 创建小说系统 REST API 路由 */
export function createNovelRoutes(services: NovelServices): RouteDefinition[] {
  const { store, promptManager, promptBuilder, engine } = services
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

  routes.push({
    method: 'DELETE',
    path: '/projects/:id',
    handler: async (request: any) => {
      const deleted = store.deleteProject(request.params.id)
      if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `项目不存在: ${request.params.id}`, 404)
      return success({ id: request.params.id, deleted: true }, request.traceId)
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
  })

  routes.push({
    method: 'PATCH',
    path: '/chapters/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(updateChapterSchema, request, reply)
      if (!input) return reply

      const updated = store.updateChapter(request.params.id, input)
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

      const generated = await services.characterGenerator.generate(
        request.params.projectId,
        input.coreStyle,
      )

      const character = store.createCharacter({
        id: randomUUID(),
        projectId: request.params.projectId,
        arcHistory: '[]',
        ...generated,
      })
      return success(character, request.traceId)
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

  // ═══════════════════════════════════════════════════════════════
  // 伏笔
  // ═══════════════════════════════════════════════════════════════

  const createForeshadowSchema = z.object({
    description: z.string().min(1),
    category: z.string().default(''),
    status: z.enum(['planned', 'planted', 'reinforced', 'partially_revealed', 'recovering', 'recovered', 'abandoned']).default('planned'),
    firstChapter: z.number().int().nullable().default(null),
    lastChapter: z.number().int().nullable().default(null),
    recoverByChapter: z.number().int().nullable().default(null),
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

  // ═══════════════════════════════════════════════════════════════
  // 冲突
  // ═══════════════════════════════════════════════════════════════

  const createConflictSchema = z.object({
    description: z.string().min(1),
    type: z.enum(['inner', 'relationship', 'faction', 'interest', 'moral', 'identity', 'emotional', 'world_rule', 'survival']),
    intensity: z.number().int().min(1).max(10).default(5),
    stage: z.enum(['latent', 'emerging', 'escalating', 'erupting', 'reversing', 'resolved', 'transformed']).default('latent'),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/conflicts',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createConflictSchema, request, reply)
      if (!input) return reply

      const conflict = store.createConflict({
        id: randomUUID(),
        projectId: request.params.projectId,
        participants: '[]',
        ...input,
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
        ...input,
      })
      return success(rel, request.traceId)
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
      nodeType: z.enum(['project', 'character', 'chapter', 'conflict', 'foreshadow', 'group']),
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
      const agentTypes = ['director', 'writer', 'reviewer', 'reviser', 'memory']
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
      if (chapterNumber != null && !Number.isNaN(chapterNumber)) {
        try {
          // 使用默认叙事任务与约束计算哈希（诊断用途）
          chapterContextHash = promptBuilder.getChapterContextHash(
            projectId,
            chapterNumber,
            {
              description: '诊断请求',
              type: 'advance_mainline',
              targetEntity: null,
              priority: 'medium',
            },
            {
              facts: store.listConstraints(projectId).filter((c: any) => c.type === 'fact'),
              cognitive: store.listConstraints(projectId).filter((c: any) => c.type === 'cognitive'),
              stage: store.listConstraints(projectId).filter((c: any) => c.type === 'stage'),
              narrativeDebts: store.listForeshadowing(projectId),
              characterArcs: store.listCharacters(projectId).map((c: any) => ({
                character: c,
                allowedNextStage: null,
              })),
            },
          )
        } catch {
          chapterContextHash = 'error'
        }
      }

      return success(
        {
          systemPromptHashes,
          chapterContextHash,
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

      // 设置 SSE
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })

      const heartbeat = setInterval(() => {
        reply.raw.write(': keepalive\n\n')
      }, 15000)

      try {
        const result = await orchestrator.createChapterWithFlow(
          projectId,
          parseInt(chapterNumber, 10),
          {
            onCheckpoint: async (checkpoint) => {
              reply.raw.write(`data: ${JSON.stringify({ type: 'checkpoint', data: checkpoint })}\n\n`)
              return new Promise((resolve) => {
                orchestrator.once(`checkpoint:${checkpoint.type}`, (decision: string) => {
                  resolve(decision as any)
                })
              })
            },
            onProgress: (event) => {
              reply.raw.write(`data: ${JSON.stringify({ type: 'progress', data: event })}\n\n`)
            },
          },
        )
        reply.raw.write(`data: ${JSON.stringify({ type: 'result', data: result })}\n\n`)
      } catch (err) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: String(err) })}\n\n`)
      } finally {
        clearInterval(heartbeat)
        reply.raw.end()
      }
    },
  })

  // 检查点决策端点
  routes.push({
    method: 'POST',
    path: '/projects/:projectId/checkpoint/:type/decision',
    handler: async (request: any, reply: any) => {
      const { projectId, type } = request.params
      const { decision } = request.body
      services.orchestrator.emit(`checkpoint:${type}`, decision)
      return { ok: true, data: { accepted: true } }
    },
  })

  return routes
}
