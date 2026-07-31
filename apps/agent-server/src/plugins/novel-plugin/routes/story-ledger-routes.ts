import { z } from 'zod'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import type { NovelServices } from '../novel-services.js'
import type { NovelStoryEntityType, StoryEventStatus } from '@repo/shared/novel'
import {
  buildArrangedEntitiesForChapter,
  DEFAULT_PROJECTION_SOURCE,
  type ProjectionSource,
} from '../core/matrix-projection.js'

const storyEntityTypes = [
  'character', 'relationship', 'conflict', 'foreshadow', 'clue', 'faction', 'location',
  'world_element', 'world_rule', 'info_layer', 'item', 'chapter',
] as const
const eventTypes = ['encounter', 'conflict', 'discovery', 'transfer', 'reveal', 'decision', 'transition', 'resolution', 'custom'] as const
const eventStatuses = ['planned', 'confirmed', 'generated', 'superseded'] as const
const eventSources = ['manual', 'ai-extracted', 'ai-planned', 'migration'] as const
const eventRoles = ['actor', 'target', 'participant', 'trigger', 'evidence', 'resource', 'location', 'affected', 'outcome'] as const
const valueTypes = ['enum', 'level', 'number', 'set', 'reference', 'text'] as const
const annotationScopes = ['entity', 'event', 'change', 'relation', 'matrix-cell', 'span'] as const
const annotationKinds = ['note', 'intent', 'todo', 'warning', 'question'] as const

const storyEntityTypeSchema = z.enum(storyEntityTypes)
const eventTypeSchema = z.enum(eventTypes)
const eventStatusSchema = z.enum(eventStatuses)
const eventSourceSchema = z.enum(eventSources)
const valueTypeSchema = z.enum(valueTypes)

const storyEventSchema = z.object({
  chapterNumber: z.number().int().min(0),
  sceneId: z.string().max(200).nullable().optional().default(null),
  sceneOrder: z.number().int().min(0).default(0),
  type: eventTypeSchema,
  title: z.string().max(500).default(''),
  summary: z.string().max(10000).default(''),
  outcome: z.string().max(10000).default(''),
  status: eventStatusSchema.default('planned'),
  parentEventId: z.string().max(100).nullable().optional().default(null),
  source: eventSourceSchema.default('manual'),
})

const entityRefSchema = z.object({
  entityType: storyEntityTypeSchema,
  entityId: z.string().min(1).max(200),
  role: z.enum(eventRoles),
  note: z.string().max(2000).default(''),
})

const changeSchema = z.object({
  subjectType: storyEntityTypeSchema,
  subjectId: z.string().min(1).max(200),
  dimension: z.string().min(1).max(200),
  targetType: storyEntityTypeSchema.nullable().optional().default(null),
  targetId: z.string().max(200).nullable().optional().default(null),
  valueType: valueTypeSchema,
  beforeValue: z.unknown().optional().default(null),
  afterValue: z.unknown().optional().default(null),
  reason: z.string().max(5000).default(''),
  significance: z.number().int().min(1).max(10).default(5),
  source: eventSourceSchema.default('manual'),
  cause: z.string().max(100).nullable().optional().default(null),
  effectIds: z.array(z.string().max(100)).max(200).optional().default([]),
})

const annotationSchema = z.object({
  scopeType: z.enum(annotationScopes),
  scopeId: z.string().max(200).nullable().optional().default(null),
  entityType: storyEntityTypeSchema.nullable().optional().default(null),
  entityId: z.string().max(200).nullable().optional().default(null),
  chapterStart: z.number().int().min(0).nullable().optional().default(null),
  chapterEnd: z.number().int().min(0).nullable().optional().default(null),
  kind: z.enum(annotationKinds).default('note'),
  content: z.string().min(1).max(20000),
  color: z.string().max(32).default('blue'),
  includeInPrompt: z.boolean().default(false),
  resolved: z.boolean().default(false),
})

const parseIntQuery = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function ensureEventProject(eventProjectId: string, projectId: string): void {
  if (eventProjectId !== projectId) {
    throw new AppError(ErrorCode.FORBIDDEN, '事件不属于当前项目', 403)
  }
}

export function createStoryLedgerRoutes(services: NovelServices): RouteDefinition[] {
  const { memoryStore, store } = services
  const routes: RouteDefinition[] = []

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/story-events',
    handler: async (request: any) => {
      const query = (request.query ?? {}) as Record<string, string | undefined>
      return success(memoryStore.listStoryEvents(request.params.projectId, {
        chapterNumber: parseIntQuery(query.chapterNumber),
        chapterStart: parseIntQuery(query.chapterStart),
        chapterEnd: parseIntQuery(query.chapterEnd),
        status: query.status as StoryEventStatus | undefined,
        entityType: query.entityType as NovelStoryEntityType | undefined,
        entityId: query.entityId,
      }), request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/story-events/:eventId',
    handler: async (request: any) => {
      const event = memoryStore.getStoryEvent(request.params.eventId)
      if (!event) throw new AppError(ErrorCode.NOT_FOUND, '故事事件不存在', 404)
      ensureEventProject(event.projectId, request.params.projectId)
      return success({ event, entityRefs: memoryStore.listStoryEventEntityRefs(event.id), changes: memoryStore.listChangeRecords(event.projectId, { storyEventId: event.id }) }, request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/story-events',
    handler: async (request: any, reply: any) => {
      const schema = z.object({ event: storyEventSchema, entityRefs: z.array(entityRefSchema).max(200).default([]), changes: z.array(changeSchema).max(500).default([]) })
      const input = validateBody(schema, request, reply)
      if (!input) return reply
      const result = memoryStore.createStoryEventWithChanges({
        event: { ...input.event, projectId: request.params.projectId },
        entityRefs: input.entityRefs,
        changes: input.changes,
      })
      return success(result, request.traceId)
    },
  })

  routes.push({
    method: 'PATCH',
    path: '/story-events/:eventId',
    handler: async (request: any, reply: any) => {
      const input = validateBody(storyEventSchema.partial(), request, reply)
      if (!input) return reply
      const existing = memoryStore.getStoryEvent(request.params.eventId)
      if (!existing) throw new AppError(ErrorCode.NOT_FOUND, '故事事件不存在', 404)
      const updated = memoryStore.updateStoryEvent(request.params.eventId, input)
      return success(updated, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/story-events/:eventId',
    handler: async (request: any) => {
      const existing = memoryStore.getStoryEvent(request.params.eventId)
      if (!existing) throw new AppError(ErrorCode.NOT_FOUND, '故事事件不存在', 404)
      memoryStore.deleteStoryEvent(existing.id)
      return success({ id: existing.id, deleted: true }, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/change-records',
    handler: async (request: any) => {
      const query = (request.query ?? {}) as Record<string, string | undefined>
      return success(memoryStore.listChangeRecords(request.params.projectId, {
        storyEventId: query.storyEventId,
        chapterNumber: parseIntQuery(query.chapterNumber),
        beforeChapter: parseIntQuery(query.beforeChapter),
        afterChapter: parseIntQuery(query.afterChapter),
        subjectType: query.subjectType as NovelStoryEntityType | undefined,
        subjectId: query.subjectId,
        dimension: query.dimension,
      }), request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/change-records',
    handler: async (request: any, reply: any) => {
      const schema = changeSchema.extend({ chapterNumber: z.number().int().min(0), sceneOrder: z.number().int().min(0).default(0), storyEventId: z.string().max(100).nullable().optional().default(null) })
      const input = validateBody(schema, request, reply)
      if (!input) return reply
      const record = memoryStore.createChangeRecord({ ...input, projectId: request.params.projectId })
      return success(record, request.traceId)
    },
  })

  routes.push({
    method: 'PATCH',
    path: '/change-records/:changeId',
    handler: async (request: any, reply: any) => {
      const input = validateBody(changeSchema.partial(), request, reply)
      if (!input) return reply
      const updated = memoryStore.updateChangeRecord(request.params.changeId, input)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, '变化记录不存在', 404)
      return success(updated, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/change-records/:changeId',
    handler: async (request: any) => {
      if (!memoryStore.getChangeRecord(request.params.changeId)) throw new AppError(ErrorCode.NOT_FOUND, '变化记录不存在', 404)
      memoryStore.deleteChangeRecord(request.params.changeId)
      return success({ id: request.params.changeId, deleted: true }, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/entities/:entityType/:entityId/timeline',
    handler: async (request: any) => {
      const entityType = request.params.entityType as NovelStoryEntityType
      const events = memoryStore.listStoryEvents(request.params.projectId, { entityType, entityId: request.params.entityId })
      const changesById = new Map(
        memoryStore
          .listChangeRecords(request.params.projectId, { subjectType: entityType, subjectId: request.params.entityId })
          .map((change) => [change.id, change]),
      )
      for (const event of events) {
        for (const change of memoryStore.listChangeRecords(request.params.projectId, { storyEventId: event.id })) {
          changesById.set(change.id, change)
        }
      }
      const changes = [...changesById.values()].sort(
        (a, b) => a.chapterNumber - b.chapterNumber || a.sceneOrder - b.sceneOrder || a.createdAt - b.createdAt,
      )
      const annotations = memoryStore.listAnnotations(request.params.projectId, { entityType, entityId: request.params.entityId })
      return success({ entityType, entityId: request.params.entityId, changes, events, annotations }, request.traceId)
    },
  })

  // 矩阵级聚合接口：一次返回全实体 × 全章节的账本投影。
  // 设计文档第 6 节"统一数据源"：折叠态总览废弃实体快照字段，改用账本投影。
  // 组合 store.listChapters（章节范围）+ memoryStore.listChangeRecords（带 dimension 的变化记录）。
  // 支持 chapterStart/chapterEnd 裁剪，防止百章 × 数十实体聚合爆炸（第 9 节风险）。
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/matrix-aggregation',
    handler: async (request: any) => {
      const projectId = request.params.projectId
      const query = (request.query ?? {}) as Record<string, string | undefined>
      const chapterStart = parseIntQuery(query.chapterStart)
      const chapterEnd = parseIntQuery(query.chapterEnd)

      // 章节范围：从 chapters 表推导（min/max chapter_number）
      const chapters = store.listChapters(projectId)
      const chapterNumbers = chapters.map((c) => c.chapterNumber).filter((n) => Number.isFinite(n))
      const chapterRange = chapterNumbers.length > 0
        ? { start: Math.min(...chapterNumbers), end: Math.max(...chapterNumbers) }
        : { start: 0, end: 0 }

      // 变化记录：带 dimension 的全量 ChangeRecord，按章节排序
      // listChangeRecords 的 afterChapter/beforeChapter 是开区间（> / <），这里用闭区间裁剪
      const changes = memoryStore.listChangeRecords(projectId, {
        afterChapter: chapterStart !== undefined ? chapterStart - 1 : undefined,
        beforeChapter: chapterEnd !== undefined ? chapterEnd + 1 : undefined,
      })

      return success({ projectId, chapterRange, changes }, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/chapters/:chapterNumber/story-context',
    handler: async (request: any) => {
      const chapterNumber = Number.parseInt(request.params.chapterNumber, 10)
      if (!Number.isInteger(chapterNumber) || chapterNumber < 0) throw new AppError(ErrorCode.BAD_REQUEST, '章节号无效', 400)
      return success(memoryStore.getChapterStoryContext(request.params.projectId, chapterNumber), request.traceId)
    },
  })

  // ── S4-2：章节投影的唯一服务端读接口 ──
  //
  // "本章有哪些实体出场"此前有三份实现（前端矩阵派生、前端 collectArrangedEntities、
  // 后端对账），字段一旦增删就会漂移 —— itemIds / characterFunctions 长期丢失就是这么来的。
  // 本接口把它收敬为一处，并用 source 参数支持在两种事实源之间切换：
  //   - entity-fields（默认）：实体章节维度字段，历史行为
  //   - ledger：事件账本，S4 目标
  //
  // 返回体同时带上另一种来源的结果与差异，便于切读前后对比、也便于前端在
  // 差异不为空时给出提示，而不是静默采用某一边。
  routes.push({
    method: 'GET',
    path: '/projects/:projectId/chapters/:chapterNumber/arranged-entities',
    handler: async (request: any) => {
      const projectId = request.params.projectId
      const chapterNumber = Number.parseInt(request.params.chapterNumber, 10)
      if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
        throw new AppError(ErrorCode.BAD_REQUEST, '章节号无效', 400)
      }
      const query = (request.query ?? {}) as Record<string, string | undefined>
      const requested = query.source
      if (requested !== undefined && requested !== 'ledger' && requested !== 'entity-fields') {
        throw new AppError(ErrorCode.BAD_REQUEST, "source 只能是 'ledger' 或 'entity-fields'", 400)
      }
      const source: ProjectionSource = requested ?? DEFAULT_PROJECTION_SOURCE
      const other: ProjectionSource = source === 'ledger' ? 'entity-fields' : 'ledger'

      const arrangedEntities = buildArrangedEntitiesForChapter(store, memoryStore, projectId, chapterNumber, source)
      const alternative = buildArrangedEntitiesForChapter(store, memoryStore, projectId, chapterNumber, other)

      // 差异按实体类型给出，便于定位是哪一类在漂移
      const divergence: Record<string, { onlyInSelected: string[]; onlyInAlternative: string[] }> = {}
      for (const key of Object.keys(arrangedEntities) as Array<keyof typeof arrangedEntities>) {
        const selected = new Set((arrangedEntities[key] ?? []) as string[])
        const fallback = new Set((alternative[key] ?? []) as string[])
        const onlyInSelected = [...selected].filter((id) => !fallback.has(id))
        const onlyInAlternative = [...fallback].filter((id) => !selected.has(id))
        if (onlyInSelected.length > 0 || onlyInAlternative.length > 0) {
          divergence[key] = { onlyInSelected, onlyInAlternative }
        }
      }

      return success({
        projectId,
        chapterNumber,
        source,
        arrangedEntities,
        /** 另一种事实源的结果，仅用于对比展示，不参与创作 */
        alternativeSource: other,
        alternative,
        divergence,
      }, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/annotations',
    handler: async (request: any) => {
      const query = (request.query ?? {}) as Record<string, string | undefined>
      return success(memoryStore.listAnnotations(request.params.projectId, {
        chapterNumber: parseIntQuery(query.chapterNumber),
        scopeType: query.scopeType as any,
        scopeId: query.scopeId,
        entityType: query.entityType as NovelStoryEntityType | undefined,
        entityId: query.entityId,
        kind: query.kind as any,
        resolved: query.resolved === undefined ? undefined : query.resolved === 'true',
        includeInPrompt: query.includeInPrompt === undefined ? undefined : query.includeInPrompt === 'true',
      }), request.traceId)
    },
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/annotations',
    handler: async (request: any, reply: any) => {
      const input = validateBody(annotationSchema, request, reply)
      if (!input) return reply
      if (input.chapterStart != null && input.chapterEnd != null && input.chapterEnd < input.chapterStart) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, '批注结束章节不能早于开始章节', 400)
      }
      return success(memoryStore.createAnnotation({ ...input, projectId: request.params.projectId }), request.traceId)
    },
  })

  routes.push({
    method: 'PATCH',
    path: '/annotations/:annotationId',
    handler: async (request: any, reply: any) => {
      const input = validateBody(annotationSchema.partial(), request, reply)
      if (!input) return reply
      const updated = memoryStore.updateAnnotation(request.params.annotationId, input)
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, '批注不存在', 404)
      return success(updated, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/annotations/:annotationId',
    handler: async (request: any) => {
      if (!memoryStore.getAnnotation(request.params.annotationId)) throw new AppError(ErrorCode.NOT_FOUND, '批注不存在', 404)
      memoryStore.deleteAnnotation(request.params.annotationId)
      return success({ id: request.params.annotationId, deleted: true }, request.traceId)
    },
  })

  return routes
}
