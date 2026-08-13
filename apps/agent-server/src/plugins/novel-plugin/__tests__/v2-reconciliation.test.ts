import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { DiscussionRunStore } from '../core/discussion-run-store.js'
import { novelMigrations } from '../novel-migrations.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

function setupProject(store: NovelStore, flags?: Record<string, boolean>): string {
  const projectId = randomUUID()
  store.createProject({
    id: projectId, title: '对账项目', genre: 'test', synopsis: '', outline: '',
    targetWords: 3000, currentVolume: 1, currentChapter: 1,
    currentStage: 'rising', status: 'active', flags,
  })
  return projectId
}

function setupChapter(store: NovelStore, projectId: string, chapterNumber: number, positioning: string | null): string {
  const chapter = store.createChapter({
    id: randomUUID(), projectId, volume: 1, chapterNumber,
    title: `第${chapterNumber}章`, content: '正文', wordCount: 2,
    status: 'planned', narrativeTask: '', outline: '', volumeId: null,
    acceptanceResult: null, tension: null, positioning: positioning as any,
    timeOffset: null, chapterEndingHook: null, recap: null,
  })
  return chapter.id
}

describe('V2 双写对账', () => {
  it('字数对账：无 plan 章不参与对比；有 plan 且定位为 advancement 时匹配', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store)
    const ch1 = setupChapter(store, projectId, 1, 'advancement')

    // 无 plan → 字数项 v2Target null，不计入匹配统计
    const empty = store.reconcileV2(projectId)
    expect(empty.wordBudget.items).toHaveLength(1)
    expect(empty.wordBudget.items[0].v2Target).toBeNull()
    expect(empty.wordBudget.matched).toBe(0)
    expect(empty.wordBudget.mismatched).toBe(0)

    // V2 plan：advancement 定位 → resolver 3000（V1 也是 3000）→ 匹配
    const budget = { baseTarget: 3000, adjustmentPct: 0, resolvedTarget: 3000, min: 2550, max: 3450 }
    const plan = store.createPlanRevision({ chapterId: ch1, projectId, positioning: 'advancement', budget })
    store.transitionPlan(plan.id, 'approved', 'draft')

    const report = store.reconcileV2(projectId)
    expect(report.wordBudget.matched).toBe(1)
    expect(report.wordBudget.items[0].matched).toBe(true)
    expect(report.wordBudget.items[0].v1Target).toBe(3000)
  })

  it('字数对账：V1 定位倍率与 V2 resolver 不一致时标 mismatch（high_pressure 默认 0%）', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store)
    const ch1 = setupChapter(store, projectId, 1, 'high_pressure')

    const budget = { baseTarget: 3000, adjustmentPct: 0, resolvedTarget: 3000, min: 2550, max: 3450 }
    const plan = store.createPlanRevision({ chapterId: ch1, projectId, positioning: 'high_pressure', budget })
    store.transitionPlan(plan.id, 'approved', 'draft')

    const report = store.reconcileV2(projectId)
    // V1=3000*1.3=3900，V2=3000 → mismatch（这正是迁移期需要人工确认的差异）
    expect(report.wordBudget.mismatched).toBe(1)
    expect(report.wordBudget.items[0]).toMatchObject({ v1Target: 3900, v2Target: 3000, matched: false })
    expect(report.overallMatched).toBe(false)
  })

  it('场景数对账：群聊恢复快照不作为 V1 主数据，V2 plan 是唯一规范来源', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store)
    const ch1 = setupChapter(store, projectId, 1, null)

    // V1：群聊 run 的 scenes 已停旧写（存 '[]'）
    const runStore = new DiscussionRunStore(db)
    runStore.save({
      id: randomUUID(), projectId, chapterNumber: 1, status: 'completed',
      transcript: [], scenes: [
        { sceneId: 1, title: 'a', location: '', time: '', presentCharacters: [], goal: 'g' },
        { sceneId: 2, title: 'b', location: '', time: '', presentCharacters: [], goal: 'g' },
      ],
    })

    // V2：plan 落 2 场
    const budget = { baseTarget: 3000, adjustmentPct: 0, resolvedTarget: 3000, min: 2550, max: 3450 }
    const { plan } = store.submitPlanWithScenes({
      chapterId: ch1, projectId, budget,
      scenes: [
        { sceneKey: 's1', order: 1, title: 'a', goal: 'g', locationText: '', timeText: '', povMode: 'single', povCharacterId: null, focusCharacterIds: [], presentCharacterIds: [], functionalCast: [], targetWords: 1500, progresses: [] },
        { sceneKey: 's2', order: 2, title: 'b', goal: 'g', locationText: '', timeText: '', povMode: 'single', povCharacterId: null, focusCharacterIds: [], presentCharacterIds: [], functionalCast: [], targetWords: 1500, progresses: [] },
      ],
    })
    store.transitionPlan(plan.id, 'approved', 'draft')

    const report = store.reconcileV2(projectId)
    expect(report.sceneCount.items[0]).toMatchObject({ v1Scenes: null, v2Scenes: 2, matched: false })
  })

  it('事件 scene 字段残留统计（停旧写后残留恒为 0）', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const memoryStore = new NovelMemoryStore(db)
    const projectId = setupProject(store)

    memoryStore.createStoryEvent({
      projectId, chapterNumber: 1, sceneId: 'legacy-scene', sceneOrder: 1,
      type: 'conflict', title: '事件A', summary: '', outcome: "", status: 'confirmed', source: 'manual',
    } as any)
    memoryStore.createStoryEvent({
      projectId, chapterNumber: 1, sceneId: null, sceneOrder: 0,
      type: 'discovery', title: '事件B', summary: '', outcome: "", status: 'confirmed', source: 'manual',
    } as any)

    const report = store.reconcileV2(projectId)
    expect(report.eventSceneFields.totalEvents).toBe(2)
    // 停旧写后：sceneId 恒 null → 无残留
    expect(report.eventSceneFields.eventsWithSceneId).toBe(0)
  })
})

describe('T05 规范主数据收敛（2026-08-12 逻辑统一：恒生效）', () => {
  it('story events：sceneId/sceneOrder 不再写入（默认即停旧写）', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const memoryStore = new NovelMemoryStore(db)
    const projectId = setupProject(store)

    const event = memoryStore.createStoryEvent({
      projectId, chapterNumber: 1, sceneId: 's-1', sceneOrder: 2,
      type: 'conflict', title: '事件', summary: '', outcome: "", status: 'confirmed', source: 'manual',
    } as any)

    // 读取：sceneId 被丢弃（null），sceneOrder 归 0
    expect(event.sceneId).toBeNull()
    expect(event.sceneOrder).toBe(0)
    const reread = memoryStore.getStoryEvent(event.id)
    expect(reread?.sceneId).toBeNull()
    expect(reread?.sceneOrder).toBe(0)
  })

  it('discussion runs：保留续跑所需 scenes/arranged_entities，但不作为规范场景主数据', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store)
    const runStore = new DiscussionRunStore(db)

    runStore.save({
      id: 'run-1', projectId, chapterNumber: 1, status: 'completed',
      transcript: [{ id: 'm1', fromId: 'system', fromName: '主持人', content: '开场', timestamp: 1, type: 'system' }],
      scenes: [{ sceneId: 1, title: 'a', location: '', time: '', presentCharacters: ['c1'], goal: 'g' }],
      arrangedEntities: { characterIds: ['c1'], conflictIds: [], foreshadowIds: [], clueIds: [], factionIds: [], locationIds: [], itemIds: [], characterFunctions: [] },
    })

    const saved = runStore.get('run-1')!
    expect(saved.scenes).toHaveLength(1)
    expect(saved.arrangedEntities?.characterIds).toEqual(['c1'])
    expect(saved.transcript).toHaveLength(1) // 审计/续跑数据保留
  })
})
