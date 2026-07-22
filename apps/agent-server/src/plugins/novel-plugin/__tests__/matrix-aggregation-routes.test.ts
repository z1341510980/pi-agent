import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { createStoryLedgerRoutes } from '../routes/story-ledger-routes.js'
import { novelMigrations } from '../novel-migrations.js'
import type { NovelServices } from '../novel-services.js'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  for (const m of novelMigrations) db.exec(m.sql)
  return db
}

function createTestServices(store: NovelStore, memoryStore: NovelMemoryStore): NovelServices {
  return { store, memoryStore } as unknown as NovelServices
}

async function buildApp(store: NovelStore, memoryStore: NovelMemoryStore): Promise<FastifyInstance> {
  const app = Fastify()
  for (const r of createStoryLedgerRoutes(createTestServices(store, memoryStore))) {
    app.route({ method: r.method as any, url: r.path, handler: r.handler as any })
  }
  await app.ready()
  return app
}

function seedProject(store: NovelStore): string {
  const id = randomUUID()
  store.createProject({
    id, title: '测试项目', genre: 'test', synopsis: '', outline: '',
    targetWords: 0, currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
  })
  return id
}

function seedChapter(store: NovelStore, projectId: string, chapterNumber: number): string {
  const id = randomUUID()
  store.createChapter({
    id, projectId, volume: 1, chapterNumber,
    title: `第${chapterNumber}章`, content: '', wordCount: 0,
    status: 'planned', narrativeTask: '', acceptanceResult: null,
  })
  return id
}

describe('矩阵级聚合接口 GET /projects/:projectId/matrix-aggregation', () => {
  let db: Database.Database
  let store: NovelStore
  let memoryStore: NovelMemoryStore
  let app: FastifyInstance
  let projectId: string

  beforeEach(async () => {
    db = createTestDb()
    store = new NovelStore(db)
    memoryStore = new NovelMemoryStore(db)
    projectId = seedProject(store)
    app = await buildApp(store, memoryStore)
  })

  it('空项目：返回 chapterRange {0,0}，changes []', async () => {
    const res = await app.inject({ method: 'GET', url: `/projects/${projectId}/matrix-aggregation` })
    expect(res.statusCode).toBe(200)
    const body = res.json().data
    expect(body.projectId).toBe(projectId)
    expect(body.chapterRange).toEqual({ start: 0, end: 0 })
    expect(body.changes).toEqual([])
  })

  it('有章节但无 ChangeRecord：返回正确章节范围，changes []', async () => {
    seedChapter(store, projectId, 1)
    seedChapter(store, projectId, 3)
    seedChapter(store, projectId, 5)

    const res = await app.inject({ method: 'GET', url: `/projects/${projectId}/matrix-aggregation` })
    expect(res.statusCode).toBe(200)
    const body = res.json().data
    expect(body.chapterRange).toEqual({ start: 1, end: 5 })
    expect(body.changes).toEqual([])
  })

  it('有 ChangeRecord：返回正确的变化记录（已按章节排序）', async () => {
    seedChapter(store, projectId, 1)
    seedChapter(store, projectId, 2)
    seedChapter(store, projectId, 3)

    // 写入 3 条 ChangeRecord（通过 recordEvent 自动推断 dimension）
    memoryStore.recordEvent({
      projectId, chapterId: null, chapterNumber: 3,
      eventType: 'conflict_change',
      entityId: 'cf-1', entityType: 'conflict',
      description: '冲突阶段变更',
      oldValue: JSON.stringify({ stage: '潜伏' }),
      newValue: JSON.stringify({ stage: '高潮' }),
      cause: null, effectIds: [], significance: 7,
    })
    memoryStore.recordEvent({
      projectId, chapterId: null, chapterNumber: 1,
      eventType: 'character_change',
      entityId: 'c-1', entityType: 'character',
      description: '角色弧光变更',
      oldValue: JSON.stringify({ arcStage: '起点' }),
      newValue: JSON.stringify({ arcStage: '成长' }),
      cause: null, effectIds: [], significance: 6,
    })
    memoryStore.recordEvent({
      projectId, chapterId: null, chapterNumber: 2,
      eventType: 'foreshadow_change',
      entityId: 'f-1', entityType: 'foreshadow',
      description: '伏笔回收',
      oldValue: JSON.stringify({ status: 'planted' }),
      newValue: JSON.stringify({ status: 'payoff' }),
      cause: null, effectIds: [], significance: 8,
    })

    const res = await app.inject({ method: 'GET', url: `/projects/${projectId}/matrix-aggregation` })
    expect(res.statusCode).toBe(200)
    const body = res.json().data
    expect(body.chapterRange).toEqual({ start: 1, end: 3 })
    expect(body.changes).toHaveLength(3)
    // 已按章节排序
    expect(body.changes[0].chapterNumber).toBe(1)
    expect(body.changes[1].chapterNumber).toBe(2)
    expect(body.changes[2].chapterNumber).toBe(3)
    // dimension 已推断
    expect(body.changes[0].dimension).toBe('character.arc_stage')
    expect(body.changes[1].dimension).toBe('foreshadow.beat')
    expect(body.changes[2].dimension).toBe('conflict.stage')
  })

  it('chapterStart/chapterEnd 裁剪：只返回区间内的 ChangeRecord', async () => {
    seedChapter(store, projectId, 1)
    seedChapter(store, projectId, 2)
    seedChapter(store, projectId, 3)
    seedChapter(store, projectId, 4)
    seedChapter(store, projectId, 5)

    // 每章都写一条 conflict_change
    for (let n = 1; n <= 5; n++) {
      memoryStore.recordEvent({
        projectId, chapterId: null, chapterNumber: n,
        eventType: 'conflict_change',
        entityId: 'cf-1', entityType: 'conflict',
        description: `第${n}章冲突变更`,
        oldValue: JSON.stringify({ stage: '潜伏' }),
        newValue: JSON.stringify({ stage: '高潮' }),
        cause: null, effectIds: [], significance: 5,
      })
    }

    // 裁剪 [2, 4]
    const res = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}/matrix-aggregation?chapterStart=2&chapterEnd=4`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json().data
    // chapterRange 仍是全量章节范围（不受裁剪影响）
    expect(body.chapterRange).toEqual({ start: 1, end: 5 })
    // changes 只包含 [2, 4] 区间
    expect(body.changes).toHaveLength(3)
    expect(body.changes.map((c: any) => c.chapterNumber)).toEqual([2, 3, 4])
  })

  it('只传 chapterStart：返回 >= chapterStart 的 ChangeRecord', async () => {
    seedChapter(store, projectId, 1)
    seedChapter(store, projectId, 2)
    seedChapter(store, projectId, 3)

    for (let n = 1; n <= 3; n++) {
      memoryStore.recordEvent({
        projectId, chapterId: null, chapterNumber: n,
        eventType: 'conflict_change',
        entityId: 'cf-1', entityType: 'conflict',
        description: `第${n}章冲突变更`,
        oldValue: JSON.stringify({ stage: '潜伏' }),
        newValue: JSON.stringify({ stage: '高潮' }),
        cause: null, effectIds: [], significance: 5,
      })
    }

    const res = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}/matrix-aggregation?chapterStart=2`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json().data
    expect(body.changes).toHaveLength(2)
    expect(body.changes.map((c: any) => c.chapterNumber)).toEqual([2, 3])
  })

  it('无 dimension 的事件被过滤（plot_event 不在结果中）', async () => {
    seedChapter(store, projectId, 1)

    // 写入一条可推断的 conflict_change
    memoryStore.recordEvent({
      projectId, chapterId: null, chapterNumber: 1,
      eventType: 'conflict_change',
      entityId: 'cf-1', entityType: 'conflict',
      description: '冲突变更',
      oldValue: JSON.stringify({ stage: '潜伏' }),
      newValue: JSON.stringify({ stage: '高潮' }),
      cause: null, effectIds: [], significance: 5,
    })
    // 写入一条无法推断的 plot_event（dimension 保持 NULL）
    memoryStore.recordEvent({
      projectId, chapterId: null, chapterNumber: 1,
      eventType: 'plot_event',
      entityId: 'ch-1', entityType: 'chapter',
      description: '剧情事件',
      oldValue: null,
      newValue: JSON.stringify({ title: '高潮' }),
      cause: null, effectIds: [], significance: 5,
    })

    const res = await app.inject({ method: 'GET', url: `/projects/${projectId}/matrix-aggregation` })
    expect(res.statusCode).toBe(200)
    const body = res.json().data
    // 只返回 conflict_change，plot_event 被过滤
    expect(body.changes).toHaveLength(1)
    expect(body.changes[0].dimension).toBe('conflict.stage')
  })

  it('多实体混合：返回全部实体的 ChangeRecord', async () => {
    seedChapter(store, projectId, 1)
    seedChapter(store, projectId, 2)

    memoryStore.recordEvent({
      projectId, chapterId: null, chapterNumber: 1,
      eventType: 'character_change',
      entityId: 'c-1', entityType: 'character',
      description: '角色1弧光',
      oldValue: JSON.stringify({ arcStage: '起点' }),
      newValue: JSON.stringify({ arcStage: '成长' }),
      cause: null, effectIds: [], significance: 5,
    })
    memoryStore.recordEvent({
      projectId, chapterId: null, chapterNumber: 1,
      eventType: 'character_change',
      entityId: 'c-2', entityType: 'character',
      description: '角色2弧光',
      oldValue: JSON.stringify({ arcStage: '起点' }),
      newValue: JSON.stringify({ arcStage: '成长' }),
      cause: null, effectIds: [], significance: 5,
    })
    memoryStore.recordEvent({
      projectId, chapterId: null, chapterNumber: 2,
      eventType: 'conflict_change',
      entityId: 'cf-1', entityType: 'conflict',
      description: '冲突变更',
      oldValue: JSON.stringify({ stage: '潜伏' }),
      newValue: JSON.stringify({ stage: '高潮' }),
      cause: null, effectIds: [], significance: 7,
    })
    memoryStore.recordEvent({
      projectId, chapterId: null, chapterNumber: 2,
      eventType: 'relationship_change',
      entityId: 'r-1', entityType: 'relationship',
      description: '关系变更',
      oldValue: JSON.stringify({ currentStage: '盟友' }),
      newValue: JSON.stringify({ currentStage: '决裂' }),
      cause: null, effectIds: [], significance: 6,
    })

    const res = await app.inject({ method: 'GET', url: `/projects/${projectId}/matrix-aggregation` })
    expect(res.statusCode).toBe(200)
    const body = res.json().data
    expect(body.changes).toHaveLength(4)
    // 验证多实体多维度都返回
    const dims = body.changes.map((c: any) => c.dimension).sort()
    expect(dims).toEqual(['character.arc_stage', 'character.arc_stage', 'conflict.stage', 'relationship.stage'])
  })

  it('历史回填后的数据也能被聚合接口查到', async () => {
    seedChapter(store, projectId, 1)

    // 模拟历史数据：直接用 SQL 插入 dimension IS NULL 的行
    db.prepare(`
      INSERT INTO novel_memory_events
        (id, project_id, chapter_id, chapter_number, event_type, entity_id, entity_type,
         description, old_value, new_value, cause, effect_ids, significance,
         dimension, value_type, source, created_at)
      VALUES
        (?, ?, NULL, 1, 'conflict_change', 'cf-legacy', 'conflict',
         'legacy event', ?, ?, NULL, '[]', 5,
         NULL, NULL, 'migration', ?)
    `).run(
      randomUUID(), projectId,
      JSON.stringify({ stage: '潜伏' }),
      JSON.stringify({ stage: '高潮' }),
      Math.floor(Date.now() / 1000),
    )

    // 回填前：聚合接口查不到
    const resBefore = await app.inject({ method: 'GET', url: `/projects/${projectId}/matrix-aggregation` })
    expect(resBefore.json().data.changes).toHaveLength(0)

    // 执行回填
    const stats = memoryStore.backfillMissingDimensions({ backup: false })
    expect(stats.updated).toBe(1)

    // 回填后：聚合接口能查到
    const resAfter = await app.inject({ method: 'GET', url: `/projects/${projectId}/matrix-aggregation` })
    expect(resAfter.json().data.changes).toHaveLength(1)
    expect(resAfter.json().data.changes[0].dimension).toBe('conflict.stage')
    expect(resAfter.json().data.changes[0].subjectId).toBe('cf-legacy')
  })
})
