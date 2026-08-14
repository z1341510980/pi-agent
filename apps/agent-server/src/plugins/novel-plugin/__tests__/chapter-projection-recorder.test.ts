/**
 * 章节投影 → 账本记录器（S4-1a）的行为测试。
 *
 * 收口点验证：**任何**改动实体章节维度字段的路径都会在账本留痕，
 * 而不只是编排器。S4-1 对账实测账本原本完全没有势力/地点记录，
 * 一旦切读会让这两条轨整体消失。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { NovelStore } from '../core/novel-store.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { novelMigrations } from '../novel-migrations.js'
import { createChapterProjectionRecorder } from '../core/chapters/chapter-projection-recorder.js'
import { reconcileMatrixProjection } from '../core/analysis/matrix-projection.js'

const PROJECT_ID = 'proj-recorder'

describe('章节投影账本记录器', () => {
  let db: Database.Database
  let store: NovelStore
  let memoryStore: NovelMemoryStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const m of novelMigrations) db.exec(m.sql)
    store = new NovelStore(db)
    memoryStore = new NovelMemoryStore(db)
    store.setChapterProjectionObserver(createChapterProjectionRecorder(memoryStore))
    store.createProject({
      id: PROJECT_ID, title: '记录器测试', genre: 't', synopsis: '', outline: '',
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

  function createFaction(id: string, spans: Array<[number, number]>): void {
    store.createFaction({
      id, projectId: PROJECT_ID, name: `势力${id}`, description: '', type: 'organization',
      leaderId: null, ideology: '', strength: 'medium', resources: [], allies: [], enemies: [],
      status: 'active', chapterSpans: spans,
    })
  }

  function dimensionsAt(chapterNumber: number): string[] {
    return memoryStore.listChangeRecords(PROJECT_ID, { chapterNumber }).map((c) => c.dimension).sort()
  }

  it('势力 chapterSpans 扩展会写入账本（此前完全无记录）', () => {
    // 新建时的初始跨度也入账（create 与 update 两侧都收口）
    createFaction('f1', [[1, 1]])
    expect(dimensionsAt(1)).toEqual(['faction.arranged'])
    expect(dimensionsAt(2)).toEqual([])

    store.updateFaction('f1', { chapterSpans: [[1, 2]] })
    expect(dimensionsAt(2)).toEqual(['faction.arranged'])
  })

  it('地点 appearChapters 追加会写入账本', () => {
    store.createLocation({
      id: 'l1', projectId: PROJECT_ID, name: '潼关', description: '', type: 'dungeon',
      parentId: null, factionId: null, significance: 'major',
      firstChapter: 1, status: 'normal', appearChapters: [1],
    })
    store.updateLocation('l1', { appearChapters: [1, 3] })
    expect(dimensionsAt(3)).toEqual(['location.arranged'])
  })

  it('角色出场记录（character_history）会写入账本', () => {
    store.createCharacter({
      id: 'c1', projectId: PROJECT_ID, name: '叶明远', description: '', identity: '',
      personality: '', appearance: '', currentState: '', currentGoal: '', currentPressure: '',
      secret: '', arcStage: '', arcHistory: '[]', speechStyle: '', isProtagonist: true,
      longTermDesire: '', plotRole: 'protagonist', removalImpact: '',
    })
    store.createCharacterHistory({
      projectId: PROJECT_ID, characterId: 'c1', chapterId: null, chapterNumber: 2,
      fieldName: 'currentState', oldValue: null, newValue: '本章出场', reason: '',
    })
    expect(dimensionsAt(2)).toEqual(['character.arranged'])
  })

  it('伏笔新增 beat 会写入账本，但计划回收章不会', () => {
    store.createForeshadow({
      id: 'f1', projectId: PROJECT_ID, description: '七处节点', category: 'secret',
      status: 'planted', firstChapter: 1, lastChapter: 1, recoverByChapter: null,
      plantMethod: 'implicit', recoverMethod: 'explicit', chapterSpans: [],
      beats: [{ chapter: 1, type: 'plant' }],
    })
    // 只改计划回收章：不是已发生节点，不产生投影，也不写账本
    store.updateForeshadow('f1', { recoverByChapter: 3 })
    expect(dimensionsAt(3)).toEqual([])

    // 真实追加一个 beat：写账本
    store.updateForeshadow('f1', {
      beats: [{ chapter: 1, type: 'plant' }, { chapter: 2, type: 'reinforce' }],
    })
    expect(dimensionsAt(2)).toEqual(['foreshadow.arranged'])
  })

  it('重复触发是幂等的，不产生重复记录', () => {
    createFaction('f1', [[1, 1]])
    store.updateFaction('f1', { chapterSpans: [[1, 2]] })
    // 再改回去又改回来，第 2 章的记录不应翻倍
    store.updateFaction('f1', { chapterSpans: [[1, 1]] })
    store.updateFaction('f1', { chapterSpans: [[1, 2]] })
    expect(memoryStore.listChangeRecords(PROJECT_ID, { chapterNumber: 2 })).toHaveLength(1)
  })

  it('同一章的多次投影变更聚合到同一个 story event 下', () => {
    createFaction('f1', [[1, 1]])
    createFaction('f2', [[1, 1]])
    store.updateFaction('f1', { chapterSpans: [[1, 2]] })
    store.updateFaction('f2', { chapterSpans: [[1, 2]] })

    const events = memoryStore.listStoryEvents(PROJECT_ID, { chapterNumber: 2 })
    expect(events).toHaveLength(1)
    expect(events[0].title).toBe('章节投影变更')
    const changes = memoryStore.listChangeRecords(PROJECT_ID, { chapterNumber: 2 })
    expect(changes).toHaveLength(2)
    expect(new Set(changes.map((c) => c.storyEventId))).toEqual(new Set([events[0].id]))
  })

  it('移除投影不写新账本记录（账本是追加式事件流）', () => {
    createFaction('f1', [[1, 1]])
    const before = memoryStore.listChangeRecords(PROJECT_ID, { chapterNumber: 2 }).length
    // 先扩到第 2 章再收回：收回这一步不产生新记录
    store.updateFaction('f1', { chapterSpans: [[1, 2]] })
    const afterExpand = memoryStore.listChangeRecords(PROJECT_ID, { chapterNumber: 2 }).length
    store.updateFaction('f1', { chapterSpans: [[1, 1]] })
    const afterShrink = memoryStore.listChangeRecords(PROJECT_ID, { chapterNumber: 2 }).length

    expect(before).toBe(0)
    expect(afterExpand).toBe(1)
    // 已写下的"曾编排进第 2 章"是历史事实，不会被撤销；但也不新增记录
    expect(afterShrink).toBe(1)
  })

  it('runWithoutChapterProjectionObserver 期间不写账本', () => {
    createFaction('f1', [[1, 1]])
    store.runWithoutChapterProjectionObserver(() => {
      store.updateFaction('f1', { chapterSpans: [[1, 2]] })
    })
    expect(dimensionsAt(2)).toEqual([])
    // 退出后恢复
    store.updateFaction('f1', { chapterSpans: [[1, 3]] })
    expect(dimensionsAt(3)).toEqual(['faction.arranged'])
  })

  it('接上记录器后，纯手工编辑路径的对账一致率为 100%', () => {
    createFaction('f1', [[1, 2]])
    store.createLocation({
      id: 'l1', projectId: PROJECT_ID, name: '潼关', description: '', type: 'dungeon',
      parentId: null, factionId: null, significance: 'major',
      firstChapter: 1, status: 'normal', appearChapters: [1],
    })
    // 经由 update 路径把投影推到第 2、3 章
    store.updateFaction('f1', { chapterSpans: [[1, 3]] })
    store.updateLocation('l1', { appearChapters: [1, 2] })

    const report = reconcileMatrixProjection(store, memoryStore, PROJECT_ID)
    // create 与 update 两条路径都收口后，纯手工编辑不再产生任何漂移
    expect(report.missingInLedger).toEqual([])
    expect(report.missingInEntityFields).toHaveLength(0)
    expect(report.danglingRefs).toHaveLength(0)
    // 势力第 1-3 章 + 地点第 1-2 章
    expect(report.matchedCount).toBe(5)
  })
})
