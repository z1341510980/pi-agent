/**
 * 角色相关路由
 *
 * 拆分自原 novel-routes.ts（PR-6），包含：
 * - 角色 CRUD（POST/GET/PATCH /projects/:projectId/characters, /characters/:id）
 * - AI 角色生成（POST /projects/:projectId/characters/ai-generate，SSE 流）
 * - 角色历史（GET/POST/DELETE /projects/:projectId/characters/:characterId/history 等）
 * - 角色弧光（POST/GET/PUT/DELETE /projects/:projectId/character-arcs）
 *
 * 注：AI 通用实体生成（/projects/:projectId/entities/ai-generate）留在 novel-routes.ts，
 * 待后续 entity-routes 拆分时迁出。
 */

import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { z } from 'zod'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { createNovelAgUiEmitter, createSseEmitterSink } from '../utils/sse-emitter.js'

export function createCharacterRoutes(services: NovelServices): RouteDefinition[] {
  const { store } = services
  const routes: RouteDefinition[] = []

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
    modelId: z.object({
      provider: z.string().min(1),
      modelId: z.string().min(1),
      thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']).nullable().optional(),
    }).optional(),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/characters/ai-generate',
    handler: async (request: any, reply: any) => {
      const input = validateBody(aiGenerateCharacterSchema, request, reply)
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
      // 禁用 Nagle 算法，确保 SSE 事件立即 flush 到客户端
      request.raw.socket?.setNoDelay?.(true)

      const heartbeat = setInterval(() => {
        stream.write(': keepalive\n\n')
      }, 15000)

      const emitter = createNovelAgUiEmitter(
        createSseEmitterSink((data) => stream.write(data)),
        `novel:character:${request.params.projectId}`,
        randomUUID(),
      )

      reply.send(stream)
      try {
        const generated = await services.characterGenerator.generate(
          request.params.projectId,
          input.coreStyle,
          (event) => emitter.progress(event),
          undefined,
          input.modelId,
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
        stream.end()
      }
      return reply
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

      const character = store.getCharacter(request.params.characterId)
      if (!character || character.projectId !== request.params.projectId) {
        throw new AppError(ErrorCode.NOT_FOUND, `角色不存在: ${request.params.characterId}`, 404)
      }

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

      const invalidCharacter = input.records.find((record: { characterId: string }) => {
        const character = store.getCharacter(record.characterId)
        return !character || character.projectId !== request.params.projectId
      })
      if (invalidCharacter) {
        throw new AppError(ErrorCode.NOT_FOUND, `角色不存在: ${invalidCharacter.characterId}`, 404)
      }

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

      const projectId = request.params.projectId
      const character = store.getCharacter(input.characterId)
      if (!character || character.projectId !== projectId) {
        throw new AppError(ErrorCode.NOT_FOUND, `角色不存在: ${input.characterId}`, 404)
      }
      if (store.getCharacterArcByCharacter(projectId, input.characterId)) {
        throw new AppError(ErrorCode.CONFLICT, `角色已有弧光: ${input.characterId}`, 409)
      }

      const arc = store.createCharacterArc({
        id: randomUUID(),
        projectId,
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

      const arc = store.getCharacterArc(request.params.id)
      if (!arc) {
        throw new AppError(ErrorCode.NOT_FOUND, `角色弧光不存在: ${request.params.id}`, 404)
      }
      if (input.characterId !== undefined && input.characterId !== arc.characterId) {
        const character = store.getCharacter(input.characterId)
        if (!character || character.projectId !== arc.projectId) {
          throw new AppError(ErrorCode.NOT_FOUND, `角色不存在: ${input.characterId}`, 404)
        }
        throw new AppError(ErrorCode.BAD_REQUEST, '角色弧光不支持更换所属角色', 400)
      }

      const updated = store.updateCharacterArc(request.params.id, input)
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

  return routes
}
