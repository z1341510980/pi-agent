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
import type { NovelChapter, NovelMarker } from './core/types.js'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { success } from '../../lib/api-response.js'
import { validateBody } from '../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { RhythmController } from './core/rhythm-controller.js'

/** 创建小说系统 REST API 路由 */
export function createNovelRoutes(services: NovelServices): RouteDefinition[] {
  const { store, memoryStore, promptManager, promptBuilder, engine } = services
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
    outline: z.string().max(20000).optional(),
    volumeId: z.string().nullable().optional(),
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

      const heartbeat = setInterval(() => {
        reply.raw.write(': keepalive\n\n')
      }, 15000)

      try {
        const generated = await services.characterGenerator.generate(
          request.params.projectId,
          input.coreStyle,
          (event) => {
            reply.raw.write(`data: ${JSON.stringify({ type: 'progress', data: event })}\n\n`)
          },
        )

        const character = store.createCharacter({
          id: randomUUID(),
          projectId: request.params.projectId,
          arcHistory: '[]',
          isProtagonist: false,
          ...generated,
        })

        reply.raw.write(`data: ${JSON.stringify({ type: 'result', data: character })}\n\n`)
      } catch (err) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: String(err) })}\n\n`)
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

      try {
        const generated = await services.entityGenerator.generate(
          request.params.projectId,
          input.entityType,
          input.coreStyle,
          (event) => {
            reply.raw.write(`data: ${JSON.stringify({ type: 'progress', data: event })}\n\n`)
          },
        )
        // 注意：此处不落库，返回字段供前端 review，前端确认后调 createXxx
        reply.raw.write(`data: ${JSON.stringify({ type: 'result', data: generated })}\n\n`)
      } catch (err) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: String(err) })}\n\n`)
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
    firstChapter: z.number().int().nullable().default(null),
    lastChapter: z.number().int().nullable().default(null),
    tier: z.enum(['main', 'secondary', 'goal']).default('secondary'),
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

  routes.push({
    method: 'PATCH',
    path: '/conflicts/:id',
    handler: async (request: any, reply: any) => {
      const input = validateBody(createConflictSchema.partial(), request, reply)
      if (!input) return reply

      const updated = store.updateConflict(request.params.id, input)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `冲突不存在: ${request.params.id}`, 404)
      return success(updated, request.traceId)
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
    firstChapter: z.number().int().nullable().default(null),
    lastChapter: z.number().int().nullable().default(null),
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

      const heartbeat = setInterval(() => {
        reply.raw.write(': keepalive\n\n')
      }, 15000)

      // 从 body 读取本章已编排实体约束（模式1手动编排 / 模式2 AI编排产出）
      // 缺省时为 undefined，orchestrator 不注入编排段，保持向后兼容
      const body = (request.body ?? {}) as {
        arrangedEntities?: { characterIds?: string[]; conflictIds?: string[]; foreshadowIds?: string[] }
      }
      const arrangedEntities = body.arrangedEntities
        ? {
            characterIds: body.arrangedEntities.characterIds ?? [],
            conflictIds: body.arrangedEntities.conflictIds ?? [],
            foreshadowIds: body.arrangedEntities.foreshadowIds ?? [],
          }
        : undefined

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
            arrangedEntities,
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
      const { decision, userMessages } = request.body as { decision: string; userMessages?: string[] }
      // 如果有用户消息，存到 orchestrator 供下一个 Agent 使用
      if (userMessages && userMessages.length > 0) {
        services.orchestrator.setUserMessages(userMessages)
      }
      services.orchestrator.emit(`checkpoint:${type}`, decision)
      return { ok: true, data: { accepted: true } }
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 模式2：AI 编排生成（SSE）——按章纲生成实体并编排，同一流内衔接 create-flow
  // ═══════════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters/:chapterNumber/ai-arrange',
    handler: async (request: any, reply: any) => {
      const { projectId, chapterNumber } = request.params
      const orchestrator = services.orchestrator
      const entityGenerator = services.entityGenerator

      // SSE 设置（与 create-flow 一致，绕过 Fastify CORS 中间件需手动附加 CORS 头）
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': request.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true',
      })
      const write = (obj: unknown) => reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`)
      const heartbeat = setInterval(() => reply.raw.write(': keepalive\n\n'), 15000)

      try {
        const chNum = parseInt(chapterNumber, 10)
        const chapter = store.getChapter(projectId, chNum)
        if (!chapter) throw new Error(`章节不存在: ${chNum}`)
        if (!chapter.outline?.trim()) throw new Error('章纲为空，无法 AI 编排')

        // 阶段1：AI 编排（生成实体并落库到本章列）
        write({ type: 'progress', data: { type: 'arrange_start', message: '开始 AI 编排实体...' } })
        const arrangedEntities = await entityGenerator.generateAndArrange(
          projectId,
          chNum,
          chapter.outline,
          (evt) => write({ type: 'progress', data: { type: 'arrange_progress', ...evt } }),
        )
        write({ type: 'progress', data: { type: 'arrange_done', data: arrangedEntities } })

        // 阶段2：同一 SSE 流内衔接 create-flow，注入编排结果
        const result = await orchestrator.createChapterWithFlow(
          projectId,
          chNum,
          {
            onCheckpoint: async (checkpoint) => {
              write({ type: 'checkpoint', data: checkpoint })
              return new Promise((resolve) => {
                orchestrator.once(`checkpoint:${checkpoint.type}`, (decision: string) => {
                  resolve(decision as any)
                })
              })
            },
            onProgress: (event) => write({ type: 'progress', data: event }),
            arrangedEntities,
          },
        )
        write({ type: 'result', data: result })
      } catch (err) {
        write({ type: 'error', error: String(err) })
      } finally {
        clearInterval(heartbeat)
        reply.raw.end()
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
    type: z.enum(['bookmark', 'turning-point', 'foreshadow', 'climax', 'note', 'in', 'out', 'clip-note']).optional(),
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

  return routes
}
