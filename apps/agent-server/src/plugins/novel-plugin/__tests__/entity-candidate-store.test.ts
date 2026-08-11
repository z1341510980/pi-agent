import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

function setupProject(store: NovelStore): string {
  const projectId = randomUUID()
  store.createProject({
    id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
    targetWords: 3000, currentVolume: 1, currentChapter: 1,
    currentStage: 'rising', status: 'active',
  })
  return projectId
}

describe('实体候选存储（needs_review 决策 3）', () => {
  it('createEntityCandidate：默认 needs_review，payload 完整保留', () => {
    const store = new NovelStore(createDb())
    const projectId = setupProject(store)
    const payload = { description: '矿区势力开始试探主角底线', type: 'interest', participants: ['叶明远'] }

    const c = store.createEntityCandidate({ projectId, chapterNumber: 2, entityType: 'conflict', payload })

    expect(c.status).toBe('needs_review')
    expect(c.entityType).toBe('conflict')
    expect(c.chapterNumber).toBe(2)
    expect(c.payload).toEqual(payload)
    expect(store.countPendingEntityCandidates(projectId)).toBe(1)
  })

  it('listEntityCandidates 按状态过滤，降序', () => {
    const store = new NovelStore(createDb())
    const projectId = setupProject(store)
    const a = store.createEntityCandidate({ projectId, entityType: 'clue', payload: { description: '纸条' } })
    const b = store.createEntityCandidate({ projectId, entityType: 'conflict', payload: { description: '对峙' } })

    expect(store.listEntityCandidates(projectId, 'needs_review').map((c) => c.id)).toEqual([b.id, a.id])
    expect(store.listEntityCandidates(projectId, 'confirmed')).toHaveLength(0)
  })

  it('confirmCandidate：写审核记录，调用方用 payload 晋升正式实体', () => {
    const store = new NovelStore(createDb())
    const projectId = setupProject(store)
    const payload = { description: '新冲突', participants: ['叶明远'], type: 'interest' }
    const c = store.createEntityCandidate({ projectId, entityType: 'conflict', payload })

    const confirmed = store.confirmEntityCandidate(c.id, 'user')
    expect(confirmed.status).toBe('confirmed')

    // 审核记录（append-only）
    const reviews = store.listEntityCandidateReviews(c.id)
    expect(reviews).toHaveLength(1)
    expect(reviews[0].decision).toBe('confirmed')
    expect(reviews[0].auditContext).toMatchObject({ before: 'needs_review', after: 'confirmed' })

    // 已确认候选不可重复确认
    expect(() => store.confirmEntityCandidate(c.id)).toThrow(/不可确认/)
  })

  it('rejectCandidate：reason 必填；拒绝带审计，reasonCode 保留', () => {
    const store = new NovelStore(createDb())
    const projectId = setupProject(store)
    const c = store.createEntityCandidate({ projectId, entityType: 'clue', payload: { description: '伪线索' }, reasonCode: 'new_clue' })

    expect(() => store.rejectEntityCandidate(c.id, '')).toThrow(/reason/)
    const rejected = store.rejectEntityCandidate(c.id, '该线索已在第 5 章回收，误报', 'user')
    expect(rejected.status).toBe('rejected')

    const reviews = store.listEntityCandidateReviews(c.id)
    expect(reviews[0].decision).toBe('rejected')
    expect(reviews[0].reason).toBe('该线索已在第 5 章回收，误报')
  })

  it('countPendingEntityCandidates 只数 needs_review', () => {
    const store = new NovelStore(createDb())
    const projectId = setupProject(store)
    store.createEntityCandidate({ projectId, entityType: 'conflict', payload: {} })
    const c2 = store.createEntityCandidate({ projectId, entityType: 'clue', payload: {} })
    store.confirmEntityCandidate(c2.id)
    expect(store.countPendingEntityCandidates(projectId)).toBe(1)
  })
})
