/**
 * 章节投影读接口（S4-2）的行为测试。
 *
 * 这个接口把"本章有哪些实体出场"收敬为唯一的服务端实现。
 * 此前有三份副本（前端矩阵派生、前端 collectArrangedEntities、后端对账），
 * 字段增删就会漂移 —— itemIds / characterFunctions 长期丢失即由此而来。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { NovelStore } from '../core/novel-store.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { novelMigrations } from '../novel-migrations.js'
import { createChapterProjectionRecorder } from '../core/chapter-projection-recorder.js'
import { buildArrangedEntitiesForChapter, DEFAULT_PROJECTION_SOURCE } from '../core/matrix-projection.js'

const PROJECT_ID = 'proj-read-switch'

describe('章节投影读切换', () => {
  let db: Database.Database
  let store: NovelStore
  let memoryStore: NovelMemoryStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const m of novelMigrations) db.exec(m.sql)
    store = new NovelStore(db)
    memoryStore = new NovelMemoryStore(db)
    store.createProject({
      id: PROJECT_ID, title: '切读测试', genre: 't', synopsis: '', outline: '',
      targetWords: 0, currentVolume: 1, currentChapter: 2,
      currentStage: 'setup', status: 'active',
    })
    for (const n of [1, 2]) {
      store.createChapter({
        id: `ch-${n}`, projectId: PROJECT_ID, volume: 1, chapterNumber: n,
        title: '', content: '', wordCount: 0, status: 'planned',
        narrativeTask: '', outline: '', volumeId: null, acceptanceResult: null,
      })
    }
  })

  afterEach(() => db.close())

  function seedWithRecorder(): void {
    store.setChapterProjectionObserver(createChapterProjectionRecorder(memoryStore))
    store.createFaction({
      id: 'f1', projectId: PROJECT_ID, name: '国安总局', description: '', type: 'organization',
      leaderId: null, ideology: '', strength: 'strong', resources: [], allies: [], enemies: [],
      status: 'active', chapterSpans: [[1, 1]],
    })
    store.createItem({
      id: 'i1', projectId: PROJECT_ID, name: '玉佩', description: '', type: 'artifact',
      ownerId: null, status: 'active', abilities: '', origin: '',
      firstChapter: 1, chapterSpans: [[1, 1]],
    })
  }

  it('默认事实源是 entity-fields（切读需显式开启）', () => {
    expect(DEFAULT_PROJECTION_SOURCE).toBe('entity-fields')
  })

  it('账本完整时两种事实源结果一致', () => {
    seedWithRecorder()
    const fromFields = buildArrangedEntitiesForChapter(store, memoryStore, PROJECT_ID, 1, 'entity-fields')
    const fromLedger = buildArrangedEntitiesForChapter(store, memoryStore, PROJECT_ID, 1, 'ledger')
    expect(fromLedger).toEqual(fromFields)
    expect(fromFields.factionIds).toEqual(['f1'])
    // itemIds 是曾经全链路丢失的字段，必须在两种来源下都出现
    expect(fromFields.itemIds).toEqual(['i1'])
  })

  it('只返回指定章节的实体', () => {
    seedWithRecorder()
    store.updateFaction('f1', { chapterSpans: [[1, 2]] })
    expect(buildArrangedEntitiesForChapter(store, memoryStore, PROJECT_ID, 2).factionIds).toEqual(['f1'])
    expect(buildArrangedEntitiesForChapter(store, memoryStore, PROJECT_ID, 2).itemIds).toEqual([])
  })

  it('账本缺记录时，ledger 源会比 entity-fields 少 —— 这正是切读前必须对账的原因', () => {
    // 不注册观察者：模拟账本不完整的存量项目
    store.createFaction({
      id: 'f2', projectId: PROJECT_ID, name: '青池宗', description: '', type: 'sect',
      leaderId: null, ideology: '', strength: 'medium', resources: [], allies: [], enemies: [],
      status: 'active', chapterSpans: [[1, 1]],
    })
    expect(buildArrangedEntitiesForChapter(store, memoryStore, PROJECT_ID, 1, 'entity-fields').factionIds).toEqual(['f2'])
    expect(buildArrangedEntitiesForChapter(store, memoryStore, PROJECT_ID, 1, 'ledger').factionIds).toEqual([])
  })

  it('悬空引用不会进 arrangedEntities（否则下游反查不到实体，只会污染 prompt）', () => {
    store.setChapterProjectionObserver(createChapterProjectionRecorder(memoryStore))
    store.createConflict({
      id: 'c1', projectId: PROJECT_ID, description: '冲突', type: 'survival',
      intensity: 5, stage: 'emerging', participants: '[]', chapterSpans: [[1, 1]],
      tier: 'main', climaxChapter: null, climaxType: null, stakes: '',
      twistPotential: 5, plotFunction: 'amplify_conflict', progressionMode: 'linear',
    })
    // 绕过 store 直接删实体，留下悬空的账本记录
    db.prepare('DELETE FROM novel_conflicts WHERE id = ?').run('c1')

    expect(buildArrangedEntitiesForChapter(store, memoryStore, PROJECT_ID, 1, 'ledger').conflictIds).toEqual([])
    expect(buildArrangedEntitiesForChapter(store, memoryStore, PROJECT_ID, 1, 'entity-fields').conflictIds).toEqual([])
  })

  it('返回的字段集与 ArrangedEntity 契约一致（含 itemIds / clueIds）', () => {
    const result = buildArrangedEntitiesForChapter(store, memoryStore, PROJECT_ID, 1)
    expect(Object.keys(result).sort()).toEqual([
      'characterIds', 'clueIds', 'conflictIds', 'factionIds', 'foreshadowIds', 'itemIds', 'locationIds',
    ])
  })
})
