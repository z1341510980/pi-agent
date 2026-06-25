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
  const { store, promptManager, engine } = services
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

  return routes
}
