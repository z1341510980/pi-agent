/**
 * 存量投影回填（S4-1b）的行为测试。
 *
 * 回填要写用户的真实库，所以每条性质都必须先在测试里钉死：
 * 幂等、只补缺口、不动实体字段、不碰悬空引用、不处理反向漂移。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { NovelStore } from '../core/novel-store.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { novelMigrations } from '../novel-migrations.js'
import { planLedgerBackfill, applyLedgerBackfill } from '../core/memory/ledger-backfill.js'
import { reconcileMatrixProjection } from '../core/analysis/matrix-projection.js'
import { CHAPTER_PROJECTION_BACKFILL_EVENT_TITLE } from '../core/chapters/chapter-projection-recorder.js'

const PROJECT_ID = 'proj-backfill'

describe('存量投影回填', () => {
  let db: Database.Database
  let store: NovelStore
  let memoryStore: NovelMemoryStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const m of novelMigrations) db.exec(m.sql)
    store = new NovelStore(db)
    memoryStore = new NovelMemoryStore(db)
    // 关键：不注册观察者 —— 模拟 S4-1a 之前写入的存量数据
    store.createProject({
      id: PROJECT_ID, title: '回填测试', genre: 't', synopsis: '', outline: '',
      targetWords: 0, currentVolume: 1, currentChapter: 3,
      currentStage: 'setup', status: 'active',
    })
    for (const n of [1, 2, 3]) {
      store.createChapter({
        id: `ch-${n}`, projectId: PROJECT_ID, volume: 1, chapterNumber: n,
        title: '', content: '', wordCount: 0, status: 'planned',
        narrativeTask: '', outline: '', volumeId: null, acceptanceResult: null,
      })
    }
  })

  afterEach(() => db.close())

  function seedLegacyEntities(): void {
    store.createFaction({
      id: 'f1', projectId: PROJECT_ID, name: '国安总局', description: '', type: 'organization',
      leaderId: null, ideology: '', strength: 'strong', resources: [], allies: [], enemies: [],
      status: 'active', chapterSpans: [[1, 2]],
    })
    store.createLocation({
      id: 'l1', projectId: PROJECT_ID, name: '潼关', description: '', type: 'dungeon',
      parentId: null, factionId: null, significance: 'major',
      firstChapter: 1, status: 'normal', appearChapters: [1, 3],
    })
  }

  it('dry-run 只出清单，不写任何账本记录', () => {
    seedLegacyEntities()
    const plan = planLedgerBackfill(store, memoryStore, PROJECT_ID)

    expect(plan.items).toHaveLength(4) // 势力第 1-2 章 + 地点第 1、3 章
    expect(plan.byEntityType).toEqual({ faction: 2, location: 2 })
    expect(memoryStore.listChangeRecords(PROJECT_ID)).toHaveLength(0)
    expect(memoryStore.listStoryEvents(PROJECT_ID)).toHaveLength(0)
  })

  it('apply 后账本缺口归零，一致率 100%', () => {
    seedLegacyEntities()
    const result = applyLedgerBackfill(store, memoryStore, PROJECT_ID)

    expect(result.written).toBe(4)
    const after = reconcileMatrixProjection(store, memoryStore, PROJECT_ID)
    expect(after.missingInLedger).toEqual([])
    expect(after.matchedCount).toBe(4)
    expect(after.missingInEntityFields).toEqual([])
  })

  it('回填记录挂在「存量投影回填」事件下，与实时写入可区分', () => {
    seedLegacyEntities()
    applyLedgerBackfill(store, memoryStore, PROJECT_ID)

    const titles = new Set(memoryStore.listStoryEvents(PROJECT_ID).map((e) => e.title))
    expect(titles).toEqual(new Set([CHAPTER_PROJECTION_BACKFILL_EVENT_TITLE]))
    for (const change of memoryStore.listChangeRecords(PROJECT_ID)) {
      expect(change.reason).toContain('backfill')
    }
  })

  it('重复 apply 是幂等的', () => {
    seedLegacyEntities()
    applyLedgerBackfill(store, memoryStore, PROJECT_ID)
    const firstPass = memoryStore.listChangeRecords(PROJECT_ID).length

    const second = applyLedgerBackfill(store, memoryStore, PROJECT_ID)
    expect(second.items).toHaveLength(0)
    expect(second.written).toBe(0)
    expect(memoryStore.listChangeRecords(PROJECT_ID)).toHaveLength(firstPass)
  })

  it('不修改任何实体字段', () => {
    seedLegacyEntities()
    const beforeFaction = store.getFaction('f1')!
    const beforeLocation = store.getLocation('l1')!

    applyLedgerBackfill(store, memoryStore, PROJECT_ID)

    expect(store.getFaction('f1')!.chapterSpans).toEqual(beforeFaction.chapterSpans)
    expect(store.getLocation('l1')!.appearChapters).toEqual(beforeLocation.appearChapters)
    expect(store.getFaction('f1')!.updatedAt).toBe(beforeFaction.updatedAt)
  })

  it('不碰悬空引用，也不处理反向漂移', () => {
    seedLegacyEntities()
    // 悬空引用：change record 指向不存在的冲突
    memoryStore.createStoryEventWithChanges({
      event: {
        projectId: PROJECT_ID, chapterNumber: 1, sceneId: null, sceneOrder: 0,
        type: 'discovery', title: '历史事件', summary: '', outcome: '',
        status: 'confirmed', parentEventId: null, source: 'manual',
      },
      entityRefs: [],
      changes: [
        // 悬空：冲突已删
        {
          subjectType: 'conflict', subjectId: 'conflict-gone', dimension: 'conflict.stage',
          targetType: null, targetId: null, valueType: 'enum',
          beforeValue: null, afterValue: 'x', reason: '', significance: 5, source: 'manual',
        },
        // 反向漂移：账本说地点在第 2 章动过，但 appearChapters 里没有第 2 章
        {
          subjectType: 'location', subjectId: 'l1', dimension: 'location.status',
          targetType: null, targetId: null, valueType: 'enum',
          beforeValue: null, afterValue: 'y', reason: '', significance: 5, source: 'manual',
        },
      ],
    })

    const plan = planLedgerBackfill(store, memoryStore, PROJECT_ID)
    expect(plan.danglingRefs).toBe(1)
    expect(plan.missingInEntityFields).toBe(0) // location@1 已被实体字段覆盖

    applyLedgerBackfill(store, memoryStore, PROJECT_ID)
    const after = reconcileMatrixProjection(store, memoryStore, PROJECT_ID)
    // 悬空引用原样保留，等 S4-1c 处理
    expect(after.danglingRefs).toHaveLength(1)
    expect(after.missingInLedger).toEqual([])
  })

  it('已完整入账的项目回填为空操作', () => {
    // 注册观察者后再建实体：实时收口已经把账本写全
    store.setChapterProjectionObserver((projectId, change) => {
      void projectId
      void change
    })
    const plan = planLedgerBackfill(store, memoryStore, PROJECT_ID)
    expect(plan.items).toEqual([])
    expect(applyLedgerBackfill(store, memoryStore, PROJECT_ID).written).toBe(0)
  })
})
