import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { novelMigrations } from '../novel-migrations.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'

describe('Story ledger store', () => {
  let db: Database.Database
  let store: NovelMemoryStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const migration of novelMigrations) db.exec(migration.sql)
    db.prepare(`
      INSERT INTO novel_projects
        (id, title, genre, synopsis, target_words, current_volume, current_chapter, current_stage, status)
      VALUES ('p1', '测试小说', '悬疑', '', 0, 1, 0, 'setup', 'active')
    `).run()
    store = new NovelMemoryStore(db)
  })

  afterEach(() => {
    db.close()
  })

  it('atomically records a scene event with multiple entity changes', () => {
    const result = store.createStoryEventWithChanges({
      event: {
        projectId: 'p1',
        chapterNumber: 9,
        sceneId: 'scene-9-1',
        sceneOrder: 1,
        type: 'discovery',
        title: '发现染血收据',
        summary: 'A 在 B 的书房发现收据',
        outcome: 'A 开始秘密调查 B',
        status: 'confirmed',
        parentEventId: null,
        source: 'manual',
      },
      entityRefs: [
        { entityType: 'character', entityId: 'A', role: 'actor', note: '' },
        { entityType: 'character', entityId: 'B', role: 'target', note: '' },
        { entityType: 'clue', entityId: 'receipt', role: 'evidence', note: '染血收据' },
      ],
      changes: [
        {
          subjectType: 'character', subjectId: 'A',
          dimension: 'relationship.suspicion',
          targetType: 'character', targetId: 'B',
          valueType: 'level', beforeValue: 20, afterValue: 70,
          reason: '发现染血收据', significance: 8, source: 'manual',
        },
        {
          subjectType: 'clue', subjectId: 'receipt',
          dimension: 'clue.status', targetType: null, targetId: null,
          valueType: 'enum', beforeValue: 'unknown', afterValue: 'discovered',
          reason: 'A 找到收据', significance: 7, source: 'manual',
        },
      ],
    })

    expect(result.event.id).toBeTruthy()
    expect(result.entityRefs).toHaveLength(3)
    expect(result.changes).toHaveLength(2)
    expect(result.changes.every((change) => change.storyEventId === result.event.id)).toBe(true)
    expect(store.listStoryEvents('p1', { chapterNumber: 9 })).toHaveLength(1)
    expect(store.listChangeRecords('p1', { storyEventId: result.event.id })).toHaveLength(2)
  })

  it('builds chapter 10 context from prior changes without copying state into every chapter', () => {
    store.createStoryEventWithChanges({
      event: {
        projectId: 'p1', chapterNumber: 8, sceneId: null, sceneOrder: 1,
        type: 'transfer', title: '钥匙转移', summary: '', outcome: '',
        status: 'confirmed', parentEventId: null, source: 'manual',
      },
      entityRefs: [],
      changes: [{
        subjectType: 'item', subjectId: 'key', dimension: 'item.owner',
        targetType: null, targetId: null, valueType: 'reference',
        beforeValue: 'B', afterValue: 'A', reason: 'A 从 B 手中取得钥匙',
        significance: 7, source: 'manual',
      }],
    })
    store.createStoryEventWithChanges({
      event: {
        projectId: 'p1', chapterNumber: 9, sceneId: null, sceneOrder: 2,
        type: 'discovery', title: '发现收据', summary: '', outcome: '',
        status: 'confirmed', parentEventId: null, source: 'manual',
      },
      entityRefs: [],
      changes: [{
        subjectType: 'character', subjectId: 'A', dimension: 'relationship.suspicion',
        targetType: 'character', targetId: 'B', valueType: 'level',
        beforeValue: 20, afterValue: 70, reason: '发现染血收据',
        significance: 8, source: 'manual',
      }],
    })
    store.createStoryEventWithChanges({
      event: {
        projectId: 'p1', chapterNumber: 12, sceneId: null, sceneOrder: 1,
        type: 'conflict', title: '身份冲突爆发', summary: '', outcome: '',
        status: 'planned', parentEventId: null, source: 'manual',
      },
      entityRefs: [],
      changes: [{
        subjectType: 'conflict', subjectId: 'identity-conflict', dimension: 'conflict.stage',
        targetType: null, targetId: null, valueType: 'enum',
        beforeValue: 'escalating', afterValue: 'erupting', reason: '身份公开',
        significance: 10, source: 'manual',
      }],
    })

    const context = store.getChapterStoryContext('p1', 10)
    const owner = context.stateBeforeChapter.find((state) => state.dimension === 'item.owner')
    const suspicion = context.stateBeforeChapter.find((state) => state.dimension === 'relationship.suspicion')

    expect(owner?.value).toBe('A')
    expect(suspicion?.value).toBe(70)
    expect(context.plannedEvents).toHaveLength(0)
    expect(context.futureCommitments.map((commitment) => commitment.event.chapterNumber)).toContain(12)
    expect(context.promptDimensions).toContainEqual(expect.objectContaining({
      dimension: 'relationship.suspicion',
      numericValue: 70,
      levelLabel: '强烈',
      trend: 'rising',
    }))
  })

  it('anchors annotations to a cross-chapter span without changing story state', () => {
    const annotation = store.createAnnotation({
      projectId: 'p1', scopeType: 'span', scopeId: null,
      entityType: 'conflict', entityId: 'identity-conflict',
      chapterStart: 8, chapterEnd: 12,
      kind: 'intent', content: '第10章只能强化，不能解决', color: 'amber',
      includeInPrompt: true, resolved: false,
    })

    expect(annotation.id).toBeTruthy()
    expect(store.listAnnotations('p1', { chapterNumber: 10 })).toEqual([annotation])
    expect(store.getChapterStoryContext('p1', 10).annotations).toEqual([annotation])
    expect(store.listChangeRecords('p1')).toHaveLength(0)
  })
})
