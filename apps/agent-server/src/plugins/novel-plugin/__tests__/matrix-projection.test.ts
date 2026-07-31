/**
 * 矩阵投影对账（S4-1）的行为测试。
 *
 * 对账是 S4 切读前的量化前提：必须先能准确说出"账本与实体字段差在哪"，
 * 才谈得上把矩阵读路径切到账本。这里覆盖四类结论各自的判定条件。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { NovelStore } from '../core/novel-store.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { novelMigrations } from '../novel-migrations.js'
import {
  projectFromEntityFields,
  projectFromLedger,
  reconcileMatrixProjection,
  formatReconcileReport,
} from '../core/matrix-projection.js'

const PROJECT_ID = 'proj-reconcile'

describe('矩阵投影对账', () => {
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
      id: PROJECT_ID, title: '对账测试', genre: 't', synopsis: '', outline: '',
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

  function createConflict(id: string, spans: Array<[number, number]>): void {
    store.createConflict({
      id, projectId: PROJECT_ID, description: `冲突 ${id}`, type: 'survival',
      intensity: 5, stage: 'emerging', participants: '[]',
      chapterSpans: spans, tier: 'main', climaxChapter: null, climaxType: null,
      stakes: '', twistPotential: 5, plotFunction: 'amplify_conflict', progressionMode: 'linear',
    })
  }

  /** 给某实体在某章写一条账本变化记录 */
  function writeLedgerChange(subjectId: string, chapterNumber: number, dimension: string): void {
    memoryStore.createStoryEventWithChanges({
      event: {
        projectId: PROJECT_ID, chapterNumber, sceneId: null, sceneOrder: 0,
        type: 'discovery', title: `事件 ${dimension} @${chapterNumber}`, summary: '', outcome: '',
        status: 'confirmed', parentEventId: null, source: 'manual',
      },
      entityRefs: [],
      changes: [{
        subjectType: dimension.split('.')[0] as never,
        subjectId,
        dimension,
        targetType: null, targetId: null, valueType: 'enum',
        beforeValue: null, afterValue: 'x', reason: '', significance: 5, source: 'manual',
      }],
    })
  }

  it('两侧都有记录时判为一致', () => {
    createConflict('c1', [[1, 1]])
    writeLedgerChange('c1', 1, 'conflict.stage')

    const report = reconcileMatrixProjection(store, memoryStore, PROJECT_ID)
    expect(report.matchedCount).toBe(1)
    expect(report.missingInLedger).toHaveLength(0)
    expect(report.missingInEntityFields).toHaveLength(0)
    expect(report.danglingRefs).toHaveLength(0)
  })

  it('实体字段有、账本无 → 账本缺记录', () => {
    createConflict('c1', [[1, 2]])
    writeLedgerChange('c1', 1, 'conflict.stage')

    const report = reconcileMatrixProjection(store, memoryStore, PROJECT_ID)
    expect(report.matchedCount).toBe(1)
    expect(report.missingInLedger).toHaveLength(1)
    expect(report.missingInLedger[0]).toMatchObject({
      chapterNumber: 2, entityType: 'conflict', side: 'entity-fields',
    })
  })

  it('账本有、实体字段无 → 投影缺记录', () => {
    createConflict('c1', [[1, 1]])
    writeLedgerChange('c1', 1, 'conflict.stage')
    writeLedgerChange('c1', 2, 'conflict.intensity')

    const report = reconcileMatrixProjection(store, memoryStore, PROJECT_ID)
    expect(report.missingInEntityFields).toHaveLength(1)
    expect(report.missingInEntityFields[0]).toMatchObject({
      chapterNumber: 2, entityType: 'conflict', side: 'ledger',
    })
  })

  it('两侧的悬空引用都归入 danglingRefs，不参与一致性判定', () => {
    // 账本侧：change record 指向不存在的冲突
    writeLedgerChange('conflict-gone', 1, 'conflict.stage')
    // 实体字段侧：character_history 指向不存在的角色
    db.prepare(`
      INSERT INTO novel_character_history (id, project_id, character_id, chapter_id, chapter_number,
        field_name, old_value, new_value, reason, created_at)
      VALUES ('h1', ?, 'char-gone', NULL, 1, 'currentState', NULL, '本章出场', '', 0)
    `).run(PROJECT_ID)

    const report = reconcileMatrixProjection(store, memoryStore, PROJECT_ID)
    expect(report.matchedCount).toBe(0)
    expect(report.missingInLedger).toHaveLength(0)
    expect(report.missingInEntityFields).toHaveLength(0)
    expect(report.danglingRefs).toHaveLength(2)
    expect(report.danglingRefs.map((r) => r.entityType).sort()).toEqual(['character', 'conflict'])
    expect(report.byEntityType.conflict.danglingRefs).toBe(1)
    expect(report.byEntityType.character.danglingRefs).toBe(1)
  })

  it('伏笔按 beats 离散判定，不把埋设到回收之间的章节算作出场', () => {
    store.createForeshadow({
      id: 'f1', projectId: PROJECT_ID, description: '离散事件链', category: 'secret',
      status: 'planted', firstChapter: 1, lastChapter: 1, recoverByChapter: null,
      plantMethod: 'implicit', recoverMethod: 'explicit', chapterSpans: [],
      beats: [{ chapter: 1, type: 'plant' }],
    })

    const fields = projectFromEntityFields(store, PROJECT_ID)
    expect([...fields.keys]).toEqual(['foreshadow:f1:1'])
    // 计划回收章不产生出场（它不是 beat）
    store.updateForeshadow('f1', { recoverByChapter: 2 })
    expect([...projectFromEntityFields(store, PROJECT_ID).keys]).toEqual(['foreshadow:f1:1'])
  })

  it('账本侧同时采集 change records 与 story event 的参与实体', () => {
    createConflict('c1', [[1, 1]])
    memoryStore.createStoryEventWithChanges({
      event: {
        projectId: PROJECT_ID, chapterNumber: 2, sceneId: null, sceneOrder: 0,
        type: 'encounter', title: '仅有 entityRef 的事件', summary: '', outcome: '',
        status: 'confirmed', parentEventId: null, source: 'manual',
      },
      entityRefs: [{ entityType: 'conflict', entityId: 'c1', role: 'participant', note: '' }],
      changes: [],
    })

    const ledger = projectFromLedger(store, memoryStore, PROJECT_ID)
    expect([...ledger.keys]).toEqual(['conflict:c1:2'])
    expect(ledger.byKey.get('conflict:c1:2')?.source).toContain('story_event')
  })

  it('报告能渲染成可读文本并标出一致率', () => {
    createConflict('c1', [[1, 2]])
    writeLedgerChange('c1', 1, 'conflict.stage')

    const text = formatReconcileReport(reconcileMatrixProjection(store, memoryStore, PROJECT_ID))
    expect(text).toContain('## 对账测试')
    expect(text).toContain('章节范围：第 1-2 章')
    expect(text).toContain('一致率：50%')
    expect(text).toContain('### 账本缺记录（1 条）')
  })
})
