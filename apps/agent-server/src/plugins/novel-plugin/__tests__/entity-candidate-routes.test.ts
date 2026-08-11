import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { createEntityCandidateRoutes } from '../routes/entity-candidate-routes.js'
import { createChapterRoutes } from '../routes/chapter-routes.js'
import { novelMigrations } from '../novel-migrations.js'
import type { NovelServices } from '../novel-services.js'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  for (const m of novelMigrations) db.exec(m.sql)
  return db
}

function seedProject(store: NovelStore): string {
  const id = randomUUID()
  store.createProject({
    id, title: '测试项目', genre: 'test', synopsis: '', outline: '',
    targetWords: 3000, currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
  })
  return id
}

async function buildApp(store: NovelStore): Promise<FastifyInstance> {
  const app = Fastify()
  const services = { store, memoryStore: new NovelMemoryStore(store as any) } as unknown as NovelServices
  for (const r of [...createEntityCandidateRoutes(services), ...createChapterRoutes(services)]) {
    app.route({ method: r.method as any, url: r.path, handler: r.handler as any })
  }
  await app.ready()
  return app
}

describe('实体候选审核 API', () => {
  let db: Database.Database
  let store: NovelStore
  let app: FastifyInstance
  let projectId: string

  beforeEach(async () => {
    db = createTestDb()
    store = new NovelStore(db)
    app = await buildApp(store)
    projectId = seedProject(store)
  })

  it('GET /projects/:id/entity-candidates 返回候选与 pendingCount', async () => {
    store.createEntityCandidate({ projectId, entityType: 'conflict', payload: { description: '新冲突' } })
    const res = await app.inject({ method: 'GET', url: `/projects/${projectId}/entity-candidates` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data.candidates).toHaveLength(1)
    expect(body.data.pendingCount).toBe(1)
  })

  it('GET 支持 status 过滤', async () => {
    store.createEntityCandidate({ projectId, entityType: 'clue', payload: { description: '线索' } })
    const res = await app.inject({ method: 'GET', url: `/projects/${projectId}/entity-candidates?status=needs_review` })
    expect(res.json().data.candidates).toHaveLength(1)
    const none = await app.inject({ method: 'GET', url: `/projects/${projectId}/entity-candidates?status=confirmed` })
    expect(none.json().data.candidates).toHaveLength(0)
  })

  it('POST confirm 晋升正式冲突实体（participants 名字→id）', async () => {
    store.createCharacter({
      id: 'c1', projectId, name: '叶明远', description: '', identity: '', personality: '',
      appearance: '', currentState: '', currentGoal: '', currentPressure: '', secret: '', arcStage: '',
      plotRole: 'protagonist', longTermDesire: '', speechStyle: '', arcHistory: '[]',
      isProtagonist: true, removalImpact: '',
    })
    const c = store.createEntityCandidate({
      projectId, chapterNumber: 1, entityType: 'conflict',
      payload: { description: '矿区势力试探', participants: ['叶明远'], type: 'interest' },
    })

    const res = await app.inject({ method: 'POST', url: `/entity-candidates/${c.id}/confirm` })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.candidate.status).toBe('confirmed')
    expect(data.entityId).toBeTruthy()

    // 正式冲突已创建且 participants 解析为 id
    const conflict = store.getConflict(data.entityId)
    expect(conflict?.description).toBe('矿区势力试探')
    expect(JSON.parse(conflict?.participants ?? '[]')).toEqual(['c1'])
    expect(db.prepare(
      'SELECT entity_id FROM novel_entity_candidate_promotions WHERE candidate_id = ?',
    ).get(c.id)).toEqual({ entity_id: data.entityId })
    expect(db.prepare(
      "SELECT status FROM novel_projection_outbox WHERE topic = 'entity-candidate.confirmed' AND aggregate_id = ?",
    ).get(c.id)).toEqual({ status: 'pending' })
  })

  it('POST reject 带 reason 记录审计；空 reason 400', async () => {
    const c = store.createEntityCandidate({ projectId, entityType: 'clue', payload: { description: '伪线索' } })

    const bad = await app.inject({ method: 'POST', url: `/entity-candidates/${c.id}/reject`, payload: { reason: '' } })
    expect(bad.statusCode).toBe(400)

    const ok = await app.inject({ method: 'POST', url: `/entity-candidates/${c.id}/reject`, payload: { reason: '重复线索' } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().data.status).toBe('rejected')
    expect(store.listEntityCandidateReviews(c.id)[0].reason).toBe('重复线索')
  })

  it('已确认候选不可重复确认（400）', async () => {
    const c = store.createEntityCandidate({ projectId, entityType: 'conflict', payload: { description: 'x' } })
    await app.inject({ method: 'POST', url: `/entity-candidates/${c.id}/confirm` })
    const again = await app.inject({ method: 'POST', url: `/entity-candidates/${c.id}/confirm` })
    expect(again.statusCode).toBe(400)
  })

  it('正式实体晋升失败时确认状态和审核记录一起回滚', async () => {
    const c = store.createEntityCandidate({
      projectId,
      entityType: 'conflict',
      payload: { description: '事务回滚冲突' },
    })
    vi.spyOn(store, 'createConflict').mockImplementation(() => {
      throw new Error('模拟晋升失败')
    })

    const res = await app.inject({ method: 'POST', url: `/entity-candidates/${c.id}/confirm` })

    expect(res.statusCode).toBe(500)
    expect(store.getEntityCandidate(c.id)?.status).toBe('needs_review')
    expect(store.listEntityCandidateReviews(c.id)).toHaveLength(0)
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM novel_entity_candidate_promotions WHERE candidate_id = ?',
    ).get(c.id)).toEqual({ count: 0 })
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM novel_projection_outbox WHERE aggregate_id = ?",
    ).get(c.id)).toEqual({ count: 0 })
  })
})

describe('不可变正文版本链 API', () => {
  let db: Database.Database
  let store: NovelStore
  let app: FastifyInstance
  let projectId: string

  beforeEach(async () => {
    db = createTestDb()
    store = new NovelStore(db)
    app = await buildApp(store)
    projectId = seedProject(store)
  })

  it('GET /chapters/:id/content-revisions 返回版本链（isCurrent 按指针）', async () => {
    const chapter = store.createChapter({
      id: randomUUID(), projectId, volume: 1, chapterNumber: 1,
      title: '第一章', content: 'v1', wordCount: 2,
      status: 'planned', narrativeTask: '', outline: '', volumeId: null,
      acceptanceResult: null, tension: null, positioning: null,
      timeOffset: null, chapterEndingHook: null, recap: null,
    })
    store.updateChapterContent(chapter.id, 'v2', 2, undefined)

    const res = await app.inject({ method: 'GET', url: `/chapters/${chapter.id}/content-revisions` })
    expect(res.statusCode).toBe(200)
    const revisions = res.json().data
    expect(revisions).toHaveLength(2)
    expect(revisions[0].status).toBe('committed')
    expect(revisions[0].isCurrent).toBe(true)
    expect(revisions[1].isCurrent).toBe(false)
  })

  it('POST rollback 生成新 rollback_applied 版本', async () => {
    const chapter = store.createChapter({
      id: randomUUID(), projectId, volume: 1, chapterNumber: 1,
      title: '第一章', content: 'v1', wordCount: 2,
      status: 'planned', narrativeTask: '', outline: '', volumeId: null,
      acceptanceResult: null, tension: null, positioning: null,
      timeOffset: null, chapterEndingHook: null, recap: null,
    })
    store.updateChapterContent(chapter.id, 'v2', 2, undefined)
    const target = store.listContentRevisions(chapter.id).find((r) => r.revision === 1)!

    const res = await app.inject({
      method: 'POST',
      url: `/chapters/${chapter.id}/content-revisions/${target.id}/rollback`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.content).toBe('v1')
    const current = store.getCurrentContentRevision(chapter.id)!
    expect(current.status).toBe('rollback_applied')
    expect(current.content).toBe('v1')
  })
})
