/**
 * 小说创作系统 API 路由
 *
 * 端点分组：
 * - 项目管理：/api/novel/projects
 * - 章节管理：/api/novel/projects/:projectId/chapters, /api/novel/chapters/:id
 * - 故事元素：/api/novel/projects/:projectId/{characters,relationships,...}
 * - 提示词模板：/api/novel/prompts
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { success } from '../lib/api-response.js'
import { validateBody } from '../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

export const novelRoute: FastifyPluginAsync = async (app) => {
  const store = app.novelStore
  const promptManager = app.promptManager
  const engine = app.novelEngine

  // ═══════════════════════════════════════════════════════════════
  // 项目管理
  // ═══════════════════════════════════════════════════════════════

  const createProjectSchema = z.object({
    title: z.string().min(1).max(200),
    genre: z.string().min(1).max(50),
    synopsis: z.string().max(5000).default(''),
    targetWords: z.number().int().min(0).default(0),
  })

  app.post('/api/novel/projects', async (req, reply) => {
    const input = validateBody(createProjectSchema, req, reply)
    if (!input) return reply

    const project = store.createProject({
      id: randomUUID(),
      ...input,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    })
    return success(project, req.traceId)
  })

  app.get('/api/novel/projects', async (req) => {
    return success(store.listProjects(), req.traceId)
  })

  app.get<{ Params: { id: string } }>('/api/novel/projects/:id', async (req) => {
    const project = store.getProject(req.params.id)
    if (!project) throw new AppError(ErrorCode.NOT_FOUND, `项目不存在: ${req.params.id}`, 404)
    return success(project, req.traceId)
  })

  const updateProjectSchema = createProjectSchema.partial().extend({
    currentVolume: z.number().int().min(1).optional(),
    currentChapter: z.number().int().min(0).optional(),
    currentStage: z.enum(['setup', 'rising', 'climax', 'falling', 'resolution']).optional(),
    status: z.enum(['active', 'paused', 'completed']).optional(),
  })

  app.patch<{ Params: { id: string } }>('/api/novel/projects/:id', async (req, reply) => {
    const input = validateBody(updateProjectSchema, req, reply)
    if (!input) return reply

    const updated = store.updateProject(req.params.id, input)
    if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `项目不存在: ${req.params.id}`, 404)
    return success(updated, req.traceId)
  })

  app.delete<{ Params: { id: string } }>('/api/novel/projects/:id', async (req) => {
    const deleted = store.deleteProject(req.params.id)
    if (!deleted) throw new AppError(ErrorCode.NOT_FOUND, `项目不存在: ${req.params.id}`, 404)
    return success({ id: req.params.id, deleted: true }, req.traceId)
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

  app.post<{ Params: { projectId: string } }>(
    '/api/novel/projects/:projectId/chapters',
    async (req, reply) => {
      const input = validateBody(createChapterSchema, req, reply)
      if (!input) return reply

      const result = await engine.createChapter(
        req.params.projectId,
        input.chapterNumber,
        input.narrativeTask as any,
      )
      return success(result, req.traceId)
    },
  )

  app.get<{ Params: { projectId: string } }>(
    '/api/novel/projects/:projectId/chapters',
    async (req) => {
      return success(store.listChapters(req.params.projectId), req.traceId)
    },
  )

  app.get<{ Params: { id: string } }>('/api/novel/chapters/:id', async (req) => {
    const chapter = store.getChapterById(req.params.id)
    if (!chapter) throw new AppError(ErrorCode.NOT_FOUND, `章节不存在: ${req.params.id}`, 404)
    return success(chapter, req.traceId)
  })

  const updateChapterSchema = z.object({
    title: z.string().optional(),
    content: z.string().optional(),
    status: z.enum(['planned', 'drafting', 'review', 'published', 'rejected']).optional(),
  })

  app.patch<{ Params: { id: string } }>('/api/novel/chapters/:id', async (req, reply) => {
    const input = validateBody(updateChapterSchema, req, reply)
    if (!input) return reply

    const updated = store.updateChapter(req.params.id, input)
    if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `章节不存在: ${req.params.id}`, 404)
    return success(updated, req.traceId)
  })

  const completeChapterSchema = z.object({
    content: z.string().min(1),
    title: z.string().optional(),
  })

  app.post<{ Params: { id: string } }>('/api/novel/chapters/:id/complete', async (req, reply) => {
    const input = validateBody(completeChapterSchema, req, reply)
    if (!input) return reply

    const chapter = await engine.completeChapter(req.params.id, input.content, input.title)
    return success(chapter, req.traceId)
  })

  app.post<{ Params: { id: string } }>('/api/novel/chapters/:id/publish', async (req) => {
    const chapter = await engine.publishChapter(req.params.id)
    return success(chapter, req.traceId)
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

  app.post<{ Params: { projectId: string } }>(
    '/api/novel/projects/:projectId/characters',
    async (req, reply) => {
      const input = validateBody(createCharacterSchema, req, reply)
      if (!input) return reply

      const character = store.createCharacter({
        id: randomUUID(),
        projectId: req.params.projectId,
        arcHistory: '[]',
        ...input,
      })
      return success(character, req.traceId)
    },
  )

  app.get<{ Params: { projectId: string } }>(
    '/api/novel/projects/:projectId/characters',
    async (req) => {
      return success(store.listCharacters(req.params.projectId), req.traceId)
    },
  )

  app.patch<{ Params: { id: string } }>('/api/novel/characters/:id', async (req, reply) => {
    const input = validateBody(createCharacterSchema.partial(), req, reply)
    if (!input) return reply

    const updated = store.updateCharacter(req.params.id, input)
    if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `角色不存在: ${req.params.id}`, 404)
    return success(updated, req.traceId)
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

  app.post<{ Params: { projectId: string } }>(
    '/api/novel/projects/:projectId/foreshadowing',
    async (req, reply) => {
      const input = validateBody(createForeshadowSchema, req, reply)
      if (!input) return reply

      const foreshadow = store.createForeshadow({
        id: randomUUID(),
        projectId: req.params.projectId,
        linkedCharacters: '[]',
        linkedClues: '[]',
        ...input,
      })
      return success(foreshadow, req.traceId)
    },
  )

  app.get<{ Params: { projectId: string } }>(
    '/api/novel/projects/:projectId/foreshadowing',
    async (req) => {
      return success(store.listForeshadowing(req.params.projectId), req.traceId)
    },
  )

  // ═══════════════════════════════════════════════════════════════
  // 冲突
  // ═══════════════════════════════════════════════════════════════

  const createConflictSchema = z.object({
    description: z.string().min(1),
    type: z.enum(['inner', 'relationship', 'faction', 'interest', 'moral', 'identity', 'emotional', 'world_rule', 'survival']),
    intensity: z.number().int().min(1).max(10).default(5),
    stage: z.enum(['latent', 'emerging', 'escalating', 'erupting', 'reversing', 'resolved', 'transformed']).default('latent'),
  })

  app.post<{ Params: { projectId: string } }>(
    '/api/novel/projects/:projectId/conflicts',
    async (req, reply) => {
      const input = validateBody(createConflictSchema, req, reply)
      if (!input) return reply

      const conflict = store.createConflict({
        id: randomUUID(),
        projectId: req.params.projectId,
        participants: '[]',
        ...input,
      })
      return success(conflict, req.traceId)
    },
  )

  app.get<{ Params: { projectId: string } }>(
    '/api/novel/projects/:projectId/conflicts',
    async (req) => {
      return success(store.listConflicts(req.params.projectId), req.traceId)
    },
  )

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

  app.post<{ Params: { projectId: string } }>(
    '/api/novel/projects/:projectId/clues',
    async (req, reply) => {
      const input = validateBody(createClueSchema, req, reply)
      if (!input) return reply

      const clue = store.createClue({
        id: randomUUID(),
        projectId: req.params.projectId,
        ...input,
      })
      return success(clue, req.traceId)
    },
  )

  app.get<{ Params: { projectId: string } }>(
    '/api/novel/projects/:projectId/clues',
    async (req) => {
      return success(store.listClues(req.params.projectId), req.traceId)
    },
  )

  // ═══════════════════════════════════════════════════════════════
  // 关系
  // ═══════════════════════════════════════════════════════════════

  const createRelationshipSchema = z.object({
    characterA: z.string().min(1),
    characterB: z.string().min(1),
    relationType: z.string().min(1),
    currentStage: z.string().default(''),
  })

  app.post<{ Params: { projectId: string } }>(
    '/api/novel/projects/:projectId/relationships',
    async (req, reply) => {
      const input = validateBody(createRelationshipSchema, req, reply)
      if (!input) return reply

      const rel = store.createRelationship({
        id: randomUUID(),
        projectId: req.params.projectId,
        stageHistory: '[]',
        ...input,
      })
      return success(rel, req.traceId)
    },
  )

  app.get<{ Params: { projectId: string } }>(
    '/api/novel/projects/:projectId/relationships',
    async (req) => {
      return success(store.listRelationships(req.params.projectId), req.traceId)
    },
  )

  // ═══════════════════════════════════════════════════════════════
  // 世界规则
  // ═══════════════════════════════════════════════════════════════

  const createWorldRuleSchema = z.object({
    category: z.string().min(1),
    rule: z.string().min(1),
    cost: z.string().nullable().default(null),
    isFixed: z.boolean().default(true),
  })

  app.post<{ Params: { projectId: string } }>(
    '/api/novel/projects/:projectId/world-rules',
    async (req, reply) => {
      const input = validateBody(createWorldRuleSchema, req, reply)
      if (!input) return reply

      const rule = store.createWorldRule({
        id: randomUUID(),
        projectId: req.params.projectId,
        ...input,
      })
      return success(rule, req.traceId)
    },
  )

  app.get<{ Params: { projectId: string } }>(
    '/api/novel/projects/:projectId/world-rules',
    async (req) => {
      return success(store.listWorldRules(req.params.projectId), req.traceId)
    },
  )

  // ═══════════════════════════════════════════════════════════════
  // 风格指南
  // ═══════════════════════════════════════════════════════════════

  const createStyleGuideSchema = z.object({
    category: z.string().min(1),
    rule: z.string().min(1),
    example: z.string().nullable().default(null),
  })

  app.post<{ Params: { projectId: string } }>(
    '/api/novel/projects/:projectId/style-guides',
    async (req, reply) => {
      const input = validateBody(createStyleGuideSchema, req, reply)
      if (!input) return reply

      const style = store.createStyleGuide({
        id: randomUUID(),
        projectId: req.params.projectId,
        ...input,
      })
      return success(style, req.traceId)
    },
  )

  app.get<{ Params: { projectId: string } }>(
    '/api/novel/projects/:projectId/style-guides',
    async (req) => {
      return success(store.listStyleGuide(req.params.projectId), req.traceId)
    },
  )

  // ═══════════════════════════════════════════════════════════════
  // 创作约束
  // ═══════════════════════════════════════════════════════════════

  const createConstraintSchema = z.object({
    type: z.enum(['fact', 'cognitive', 'stage', 'debt', 'arc']),
    scope: z.enum(['global', 'volume', 'chapter']).default('global'),
    rule: z.string().min(1),
    relatedEntityId: z.string().nullable().default(null),
  })

  app.post<{ Params: { projectId: string } }>(
    '/api/novel/projects/:projectId/constraints',
    async (req, reply) => {
      const input = validateBody(createConstraintSchema, req, reply)
      if (!input) return reply

      const constraint = store.createConstraint({
        id: randomUUID(),
        projectId: req.params.projectId,
        isActive: true,
        ...input,
      })
      return success(constraint, req.traceId)
    },
  )

  app.get<{ Params: { projectId: string } }>(
    '/api/novel/projects/:projectId/constraints',
    async (req) => {
      return success(store.listConstraints(req.params.projectId), req.traceId)
    },
  )

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

  app.post<{ Params: { projectId: string } }>(
    '/api/novel/projects/:projectId/info-layers',
    async (req, reply) => {
      const input = validateBody(createInfoLayerSchema, req, reply)
      if (!input) return reply

      const layer = store.createInformationLayer({
        id: randomUUID(),
        projectId: req.params.projectId,
        characterKnowledge: '{}',
        isRevealed: false,
        ...input,
      })
      return success(layer, req.traceId)
    },
  )

  app.get<{ Params: { projectId: string } }>(
    '/api/novel/projects/:projectId/info-layers',
    async (req) => {
      return success(store.listInformationLayers(req.params.projectId), req.traceId)
    },
  )

  // ═══════════════════════════════════════════════════════════════
  // 提示词模板
  // ═══════════════════════════════════════════════════════════════

  app.get('/api/novel/prompts', async (req) => {
    return success(promptManager.listTemplateNames(), req.traceId)
  })

  app.get<{ Params: { name: string }; Querystring: { projectId?: string } }>(
    '/api/novel/prompts/:name',
    async (req) => {
      const content = promptManager.getTemplate(req.params.name, req.query.projectId)
      return success({ name: req.params.name, content }, req.traceId)
    },
  )

  const savePromptSchema = z.object({
    content: z.string().min(1),
    projectId: z.string().nullable(),
    description: z.string().optional(),
  })

  app.put<{ Params: { name: string } }>('/api/novel/prompts/:name', async (req, reply) => {
    const input = validateBody(savePromptSchema, req, reply)
    if (!input) return reply

    promptManager.saveTemplate(req.params.name, input.content, input.projectId, input.description)
    promptManager.clearCache()
    return success({ name: req.params.name, saved: true }, req.traceId)
  })
}
