/**
 * 悬空账本引用清理（S4-1c）的行为测试。
 *
 * 两个层面各测一遍：
 * - 此后：删实体时观察者自动清理（含 character_history）
 * - 存量：一次性清理脚本的核心逻辑
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { NovelStore } from '../core/novel-store.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { novelMigrations } from '../novel-migrations.js'
import { planDanglingCleanup, applyDanglingCleanup } from '../core/memory/ledger-cleanup.js'
import { reconcileMatrixProjection } from '../core/analysis/matrix-projection.js'

const PROJECT_ID = 'proj-cleanup'

describe('悬空账本引用清理', () => {
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
      id: PROJECT_ID, title: '清理测试', genre: 't', synopsis: '', outline: '',
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

  function createConflictWithLedger(id: string): void {
    store.createConflict({
      id, projectId: PROJECT_ID, description: `冲突 ${id}`, type: 'survival',
      intensity: 5, stage: 'emerging', participants: '[]', chapterSpans: [[1, 1]],
      tier: 'main', climaxChapter: null, climaxType: null, stakes: '',
      twistPotential: 5, plotFunction: 'amplify_conflict', progressionMode: 'linear',
    })
    memoryStore.createStoryEventWithChanges({
      event: {
        projectId: PROJECT_ID, chapterNumber: 1, sceneId: null, sceneOrder: 0,
        type: 'conflict', title: `事件 ${id}`, summary: '', outcome: '',
        status: 'confirmed', parentEventId: null, source: 'manual',
      },
      entityRefs: [{ entityType: 'conflict', entityId: id, role: 'participant', note: '' }],
      changes: [{
        subjectType: 'conflict', subjectId: id, dimension: 'conflict.stage',
        targetType: null, targetId: null, valueType: 'enum',
        beforeValue: null, afterValue: 'escalating', reason: '', significance: 5, source: 'manual',
      }],
    })
  }

  it('删除实体时观察者自动清理账本引用', () => {
    store.setEntityDeletedObserver((projectId, event) => {
      memoryStore.deleteLedgerReferencesByEntity(projectId, event.entityId)
      memoryStore.pruneEmptyStoryEvents(projectId)
    })
    createConflictWithLedger('c1')
    expect(memoryStore.listChangeRecords(PROJECT_ID)).toHaveLength(1)

    store.deleteConflict('c1')

    expect(memoryStore.listChangeRecords(PROJECT_ID)).toHaveLength(0)
    expect(memoryStore.listStoryEvents(PROJECT_ID)).toHaveLength(0)
    expect(reconcileMatrixProjection(store, memoryStore, PROJECT_ID).danglingRefs).toEqual([])
  })

  it('删除角色时同时清掉 character_history（否则留下无名出场记录）', () => {
    store.createCharacter({
      id: 'ch1', projectId: PROJECT_ID, name: '叶明远', description: '', identity: '',
      personality: '', appearance: '', currentState: '', currentGoal: '', currentPressure: '',
      secret: '', arcStage: '', arcHistory: '[]', speechStyle: '', isProtagonist: true,
      longTermDesire: '', plotRole: 'protagonist', removalImpact: '',
    })
    store.createCharacterHistory({
      projectId: PROJECT_ID, characterId: 'ch1', chapterId: null, chapterNumber: 1,
      fieldName: 'currentState', oldValue: null, newValue: '本章出场', reason: '',
    })
    expect(store.listCharacterHistory(PROJECT_ID)).toHaveLength(1)

    store.deleteCharacter('ch1')

    expect(store.listCharacterHistory(PROJECT_ID)).toHaveLength(0)
    expect(reconcileMatrixProjection(store, memoryStore, PROJECT_ID).danglingRefs).toEqual([])
  })

  it('存量清理：dry-run 只出清单', () => {
    // 不注册观察者 → 模拟 S4-1c 之前删除留下的悬空引用
    createConflictWithLedger('c1')
    store.deleteConflict('c1')

    const plan = planDanglingCleanup(store, memoryStore, PROJECT_ID)
    expect(plan.itemCount).toBe(1)
    expect(plan.entities).toEqual([
      { entityType: 'conflict', entityId: 'c1', chapters: [1], sides: ['ledger'] },
    ])
    // 未清理
    expect(memoryStore.listChangeRecords(PROJECT_ID)).toHaveLength(1)
  })

  it('存量清理：apply 后悬空归零，且不碰仍存在的实体', () => {
    createConflictWithLedger('c1')
    createConflictWithLedger('c2')
    store.deleteConflict('c1')

    const result = applyDanglingCleanup(store, memoryStore, PROJECT_ID)

    expect(result.deletedEntityRefs).toBe(1)
    expect(result.deletedChangeRecords).toBe(1)
    expect(result.prunedEmptyEvents).toBe(1)

    const after = reconcileMatrixProjection(store, memoryStore, PROJECT_ID)
    expect(after.danglingRefs).toEqual([])
    // c2 的账本记录完好
    expect(memoryStore.listChangeRecords(PROJECT_ID).map((c) => c.subjectId)).toEqual(['c2'])
    expect(store.getConflict('c2')).toBeDefined()
  })

  it('存量清理同时处理实体字段侧的悬空 character_history', () => {
    store.createCharacter({
      id: 'ch1', projectId: PROJECT_ID, name: '孙疤', description: '', identity: '',
      personality: '', appearance: '', currentState: '', currentGoal: '', currentPressure: '',
      secret: '', arcStage: '', arcHistory: '[]', speechStyle: '', isProtagonist: false,
      longTermDesire: '', plotRole: 'function', removalImpact: '',
    })
    store.createCharacterHistory({
      projectId: PROJECT_ID, characterId: 'ch1', chapterId: null, chapterNumber: 2,
      fieldName: 'currentState', oldValue: null, newValue: '本章出场', reason: '',
    })
    // 绕过 store 直接删角色，模拟旧版本留下的孤立 history
    db.prepare('DELETE FROM novel_characters WHERE id = ?').run('ch1')
    // 2026-08-12 逻辑统一：对账基准切 appearance 表（不再含 character_history），
    // 但清理工具仍处理 character_history 悬空（防御性清理）。
    expect(reconcileMatrixProjection(store, memoryStore, PROJECT_ID).danglingRefs).toHaveLength(0)

    const result = applyDanglingCleanup(store, memoryStore, PROJECT_ID)
    expect(result.deletedCharacterHistory).toBe(1)
    expect(reconcileMatrixProjection(store, memoryStore, PROJECT_ID).danglingRefs).toEqual([])
  })

  it('无悬空引用时清理是空操作', () => {
    createConflictWithLedger('c1')
    const result = applyDanglingCleanup(store, memoryStore, PROJECT_ID)
    expect(result.itemCount).toBe(0)
    expect(result.deletedChangeRecords).toBe(0)
    expect(memoryStore.listChangeRecords(PROJECT_ID)).toHaveLength(1)
  })
})
