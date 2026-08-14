import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { novelMigrations } from '../novel-migrations.js'
import { NovelStore } from '../core/novel-store.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

function createProject(store: NovelStore): string {
  return store.createProject({
    id: randomUUID(), title: '时间线测试', genre: 'test', synopsis: '', targetWords: 3000,
    currentVolume: 1, currentChapter: 3, currentStage: 'setup', status: 'active',
  }).id
}

function createChapter(store: NovelStore, projectId: string, chapterNumber: number) {
  const chapter = store.createChapter({
    id: randomUUID(), projectId, volume: 1, chapterNumber, title: `第${chapterNumber}章`,
    content: '', wordCount: 0, status: 'planned', narrativeTask: '', acceptanceResult: null,
  })
  store.updateChapterContent(chapter.id, `正文 ${chapterNumber}`, 4)
  return store.getChapterById(chapter.id)!
}

describe('TimelineConsistencyStore', () => {
  it('正文改写在同一事务内使所有派生投影 stale，并创建可审计预览', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const memory = new NovelMemoryStore(db)
    const projectId = createProject(store)
    const first = createChapter(store, projectId, 1)
    const second = createChapter(store, projectId, 2)
    createChapter(store, projectId, 3)

    const character = store.createCharacter({
      id: randomUUID(), projectId, name: '角色', description: '', identity: '', personality: '',
      appearance: '', currentState: '', currentGoal: '', currentPressure: '', secret: '',
      arcStage: 'introduction', arcHistory: '[]', speechStyle: '', isProtagonist: false,
      longTermDesire: '', plotRole: 'supporting', removalImpact: '',
    })
    store.createCharacterHistory({
      projectId, characterId: character.id, chapterId: second.id, chapterNumber: 2,
      fieldName: 'currentState', oldValue: '旧', newValue: '新', reason: '正文',
    })
    memory.saveSnapshot({
      projectId, chapterNumber: 2, snapshotType: 'full', entityId: null, snapshotData: '{}',
    })
    memory.recordEvent({
      projectId, chapterId: second.id, chapterNumber: 2, eventType: 'character_change',
      entityId: character.id, entityType: 'character', description: '状态变化',
      significance: 8, source: 'manual', cause: null, effectIds: [], oldValue: '旧', newValue: '新',
    })
    memory.createStoryEvent({
      projectId, chapterNumber: 2, sceneId: null, sceneOrder: 0, type: 'custom',
      title: '事件', summary: '摘要', outcome: '', status: 'confirmed',
      parentEventId: null, source: 'manual',
    })
    store.createEntityCandidate({ projectId, chapterNumber: 2, entityType: 'clue', payload: { description: '候选' } })
    store.addChapterAppearances({ projectId, chapterId: second.id, entityType: 'character', entityIds: [character.id] })

    store.updateChapterContent(second.id, '改写后的正文', 6)

    const invalidation = store.getActiveTimelineInvalidation(projectId)
    expect(invalidation).toMatchObject({ startChapterNumber: 2, status: 'pending', affectedChapters: [2, 3] })
    expect(invalidation!.staleCounts.memoryEvents).toBeGreaterThanOrEqual(1)
    expect(invalidation!.staleCounts.memorySnapshots).toBe(1)
    expect(invalidation!.staleCounts.characterHistory).toBe(1)
    expect(invalidation!.staleCounts.entityCandidates).toBe(1)
    expect(invalidation!.staleCounts.entityAppearances).toBe(1)
    expect(memory.listEvents(projectId)).toHaveLength(0)
    expect(memory.listEvents(projectId, { includeStale: true })).toHaveLength(1)
    expect(memory.listSnapshots(projectId)).toHaveLength(0)
    expect(store.listCharacterHistory(projectId)).toHaveLength(0)
    expect(store.listEntityCandidates(projectId)).toHaveLength(0)
    expect(store.listAppearancesByChapter(projectId, second.id)).toHaveLength(0)

    const preview = store.getTimelineRebuildPreview(projectId)!
    expect(preview.automaticRebuildAvailable).toBe(false)
    expect(preview.confirmationToken).toHaveLength(64)
    expect(preview.blockedReasons.length).toBeGreaterThan(0)
    expect(() => store.assertTimelineAllowsGeneration(projectId, 2)).toThrow('时间线尚未重建')
    expect(() => store.assertTimelineAllowsGeneration(projectId, 3)).toThrow('时间线尚未重建')
    expect(() => store.assertTimelineAllowsGeneration(projectId, 1)).not.toThrow()
    expect(first.content).toContain('正文 1')
    db.close()
  })

  it('重建确认 token 在影响范围变化后失效，启动不会伪造 job', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = createProject(store)
    createChapter(store, projectId, 1)
    const second = createChapter(store, projectId, 2)
    createChapter(store, projectId, 3)
    store.updateChapterContent(second.id, '改写', 2)
    const preview = store.getTimelineRebuildPreview(projectId)!
    expect(store.verifyTimelineRebuildConfirmation(projectId, preview.confirmationToken)).not.toBeNull()
    store.updateChapterContent(second.id, '再次改写', 4)
    expect(store.verifyTimelineRebuildConfirmation(projectId, preview.confirmationToken)).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS count FROM novel_timeline_rebuild_jobs').get()).toEqual({ count: 0 })
    db.close()
  })
})
