/**
 * 伏笔的「计划」与「事实」语义边界。
 *
 * 背景：`recoverByChapter` 长期同时承担两种互斥语义 ——
 *   - 计划：engine / prompt / tools / UI 全都按"应在第 N 章前回收"理解
 *   - 事实：store 从它合成一个 payoff beat，于是 deriveForeshadowStatus 判成 `recovered`
 *
 * 后果是一条用户可触发的严重 bug：在 UI 里填一个"回收章节"，或让 Memory Agent 传
 * `recoverByChapter`，这条伏笔立刻变成 `recovered`，而 generateAndArrange 会用
 * `status !== 'recovered'` 把它永久排除出后续所有章节的编排 ——
 * 即"我计划第 15 章回收它"导致"它再也不会出现在任何一章"。
 *
 * 这些测试把边界钉死：写计划不改变事实，写事实不改变计划。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'

const PROJECT_ID = 'foreshadow-plan-vs-fact'

describe('伏笔：计划回收章 vs 已回收事实', () => {
  let db: Database.Database
  let store: NovelStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const m of novelMigrations) db.exec(m.sql)
    store = new NovelStore(db)
    store.createProject({
      id: PROJECT_ID, title: 't', genre: 't', synopsis: '', outline: '',
      targetWords: 0, currentVolume: 1, currentChapter: 4,
      currentStage: 'setup', status: 'active',
    })
  })

  afterEach(() => db.close())

  function createPlanted(overrides: Partial<Parameters<NovelStore['createForeshadow']>[0]> = {}) {
    return store.createForeshadow({
      id: 'f1',
      projectId: PROJECT_ID,
      description: '主角体内第七处节点',
      category: 'secret',
      status: 'planted',
      firstChapter: 3,
      lastChapter: 3,
      recoverByChapter: null,
      plantMethod: 'implicit',
      recoverMethod: 'progressive',
      chapterSpans: [],
      beats: [{ chapter: 3, type: 'plant' }],
      ...overrides,
    })
  }

  it('设置计划回收章不会把伏笔标记为已回收', () => {
    const created = createPlanted({ recoverByChapter: 15 })
    expect(created.status).toBe('planted')
    expect(created.recoverByChapter).toBe(15)
    // 计划不产生 payoff 节点
    expect(created.beats).toEqual([{ chapter: 3, type: 'plant' }])
    expect(created.lastChapter).toBe(3)

    const read = store.getForeshadow('f1')!
    expect(read.status).toBe('planted')
    expect(read.recoverByChapter).toBe(15)
    expect(read.beats).toEqual([{ chapter: 3, type: 'plant' }])
  })

  it('设置了计划回收章的伏笔仍会进入后续编排候选', () => {
    createPlanted({ recoverByChapter: 15 })
    // generateAndArrange 的候选筛选条件
    const candidates = store.listForeshadowing(PROJECT_ID)
      .filter((f) => f.status !== 'recovered' && f.status !== 'abandoned')
    expect(candidates.map((f) => f.id)).toEqual(['f1'])
  })

  it('通过 updateForeshadow 改计划回收章同样不动 beats 与 status', () => {
    createPlanted()
    const updated = store.updateForeshadow('f1', { recoverByChapter: 20 })!
    expect(updated.recoverByChapter).toBe(20)
    expect(updated.status).toBe('planted')
    expect(updated.beats).toEqual([{ chapter: 3, type: 'plant' }])
    expect(updated.lastChapter).toBe(3)
  })

  it('真实回收由 payoff beat 表达，且不覆盖计划回收章', () => {
    createPlanted({ recoverByChapter: 15 })
    const recovered = store.updateForeshadow('f1', {
      beats: [{ chapter: 3, type: 'plant' }, { chapter: 12, type: 'payoff' }],
    })!
    expect(recovered.status).toBe('recovered')
    expect(recovered.lastChapter).toBe(12)
    // 计划仍是 15（"本来打算 15 章前收，实际 12 章收了"是有意义的信息）
    expect(recovered.recoverByChapter).toBe(15)
  })

  it('beats 为空的旧数据仍从 firstChapter 补出埋设点，但不补回收点', () => {
    const legacy = store.createForeshadow({
      id: 'f-legacy',
      projectId: PROJECT_ID,
      description: '迁移前的旧伏笔',
      category: 'secret',
      status: 'planned',
      firstChapter: 2,
      lastChapter: null,
      recoverByChapter: 9,
      plantMethod: 'implicit',
      recoverMethod: 'explicit',
      chapterSpans: [],
      beats: [],
    })
    expect(legacy.beats).toEqual([{ chapter: 2, type: 'plant' }])
    expect(legacy.status).toBe('planted')
    expect(legacy.recoverByChapter).toBe(9)
  })
})
