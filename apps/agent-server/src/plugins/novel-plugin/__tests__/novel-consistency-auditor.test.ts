import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'
import { ConsistencyAuditor } from '../core/analysis/consistency-auditor.js'

let db: Database.Database
let store: NovelStore
let auditor: ConsistencyAuditor

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const m of novelMigrations) {
    db.exec(m.sql)
  }
  store = new NovelStore(db)
  auditor = new ConsistencyAuditor(store)
})

afterEach(() => {
  db.close()
})

function setupProject(projectId = 'p-1') {
  store.createProject({
    id: projectId,
    title: '测试小说',
    genre: '玄幻',
    synopsis: '',
    targetWords: 0,
    currentVolume: 1,
    currentChapter: 0,
    currentStage: 'setup',
    status: 'active',
  })
  return projectId
}

function setupCharacter(projectId: string, id: string, name: string) {
  return store.createCharacter({
    id, projectId, name,
    description: '', identity: '', personality: '', appearance: '',
    currentState: '', currentGoal: '', currentPressure: '', secret: '',
    arcStage: 'introduction', arcHistory: '[]', speechStyle: '',
    isProtagonist: false, longTermDesire: '', plotRole: 'supporting', removalImpact: '',
  })
}

function setupChapter(
  projectId: string,
  id: string,
  chapterNumber: number,
  content: string,
  timeOffset?: number | null,
) {
  return store.createChapter({
    id, projectId, volume: 1, chapterNumber,
    title: `第${chapterNumber}章`, content,
    wordCount: content.length, status: 'published',
    narrativeTask: '', acceptanceResult: null,
    ...(timeOffset !== undefined ? { timeOffset } : {}),
  })
}

describe('ConsistencyAuditor - 空项目', () => {
  it('空项目返回满分健康度', () => {
    const projectId = setupProject()
    const report = auditor.audit(projectId)
    expect(report.totalChapters).toBe(0)
    expect(report.writtenChapters).toBe(0)
    expect(report.foreshadow.total).toBe(0)
    expect(report.hooks.total).toBe(0)
    expect(report.foreshadow.recoveryRate).toBe(0)
    expect(report.timeline.monotonic).toBe(true)
    expect(report.healthScore).toBe(100)
    expect(report.summary).toContain('✅ 一致性检查全部通过')
  })
})

describe('ConsistencyAuditor - 伏笔回收率', () => {
  it('统计伏笔状态分布', () => {
    const projectId = setupProject()
    // 3 条已回收，2 条已埋设，1 条已废弃
    for (let i = 1; i <= 3; i++) {
      store.createForeshadow({
        id: `fs-${i}`, projectId, description: `伏笔${i}`,
        category: 'item', status: 'recovered',
        firstChapter: 1, lastChapter: 5, recoverByChapter: 5,
        chapterSpans: [],
      })
    }
    for (let i = 4; i <= 5; i++) {
      store.createForeshadow({
        id: `fs-${i}`, projectId, description: `伏笔${i}`,
        category: 'item', status: 'planted',
        firstChapter: 2, lastChapter: null, recoverByChapter: null,
        chapterSpans: [],
      })
    }
    store.createForeshadow({
      id: 'fs-6', projectId, description: '伏笔6',
      category: 'item', status: 'abandoned',
      firstChapter: 1, lastChapter: null, recoverByChapter: null,
      chapterSpans: [],
    })

    const report = auditor.audit(projectId)
    expect(report.foreshadow.total).toBe(6)
    expect(report.foreshadow.byStatus.recovered).toBe(3)
    expect(report.foreshadow.byStatus.planted).toBe(2)
    expect(report.foreshadow.byStatus.abandoned).toBe(1)
    expect(report.foreshadow.recoveryRate).toBeCloseTo(0.5, 5) // 3/6
  })

  it('标记急需回收的伏笔（gap ≥ 20）', () => {
    const projectId = setupProject()
    // 写到第 25 章
    for (let i = 1; i <= 25; i++) {
      setupChapter(projectId, `ch-${i}`, i, `第${i}章内容`)
    }
    // 第 1 章埋的伏笔，gap = 24
    store.createForeshadow({
      id: 'fs-1', projectId, description: '神秘吊坠',
      category: 'item', status: 'planted',
      firstChapter: 1, lastChapter: null, recoverByChapter: null,
      chapterSpans: [],
    })
    const report = auditor.audit(projectId)
    expect(report.foreshadow.urgent).toHaveLength(1)
    expect(report.foreshadow.urgent[0].gap).toBe(24)
    expect(report.summary.some((s) => s.includes('急需处理'))).toBe(true)
  })

  it('标记即将过期的伏笔（gap ≥ 50）', () => {
    const projectId = setupProject()
    for (let i = 1; i <= 55; i++) {
      setupChapter(projectId, `ch-${i}`, i, `第${i}章内容`)
    }
    store.createForeshadow({
      id: 'fs-1', projectId, description: '神秘吊坠',
      category: 'item', status: 'planted',
      firstChapter: 1, lastChapter: null, recoverByChapter: null,
      chapterSpans: [],
    })
    const report = auditor.audit(projectId)
    expect(report.foreshadow.expired).toHaveLength(1)
    expect(report.foreshadow.expired[0].gap).toBe(54)
    expect(report.summary.some((s) => s.includes('即将过期'))).toBe(true)
  })

  it('已回收/已废弃的伏笔不进入 urgent/expired', () => {
    const projectId = setupProject()
    for (let i = 1; i <= 55; i++) {
      setupChapter(projectId, `ch-${i}`, i, `第${i}章内容`)
    }
    store.createForeshadow({
      id: 'fs-1', projectId, description: '已回收',
      category: 'item', status: 'recovered',
      firstChapter: 1, lastChapter: 10, recoverByChapter: 10,
      chapterSpans: [],
    })
    store.createForeshadow({
      id: 'fs-2', projectId, description: '已废弃',
      category: 'item', status: 'abandoned',
      firstChapter: 1, lastChapter: null, recoverByChapter: null,
      chapterSpans: [],
    })
    const report = auditor.audit(projectId)
    expect(report.foreshadow.urgent).toHaveLength(0)
    expect(report.foreshadow.expired).toHaveLength(0)
  })

  it('从 beats 推断 firstChapter（firstChapter 为 null 时）', () => {
    const projectId = setupProject()
    for (let i = 1; i <= 25; i++) {
      setupChapter(projectId, `ch-${i}`, i, `第${i}章内容`)
    }
    store.createForeshadow({
      id: 'fs-1', projectId, description: '神秘吊坠',
      category: 'item', status: 'planted',
      firstChapter: null, lastChapter: null, recoverByChapter: null,
      chapterSpans: [],
      beats: [{ chapter: 1, type: 'plant' }],
    })
    const report = auditor.audit(projectId)
    expect(report.foreshadow.urgent).toHaveLength(1)
    expect(report.foreshadow.urgent[0].firstChapter).toBe(1)
  })
})

describe('ConsistencyAuditor - 钩子悬挂', () => {
  it('统计钩子状态和兑现率', () => {
    const projectId = setupProject()
    setupChapter(projectId, 'ch-1', 1, '内容1')
    // 2 个已兑现，1 个已废弃，1 个悬挂
    store.createHook({
      id: 'h-1', projectId, chapterNumber: 1,
      hookType: 'suspense', description: '钩子1',
      status: 'fulfilled', fulfilledAtChapter: 2, fulfilledDescription: '',
    })
    store.createHook({
      id: 'h-2', projectId, chapterNumber: 1,
      hookType: 'reversal', description: '钩子2',
      status: 'fulfilled', fulfilledAtChapter: 3, fulfilledDescription: '',
    })
    store.createHook({
      id: 'h-3', projectId, chapterNumber: 1,
      hookType: 'emotional', description: '钩子3',
      status: 'abandoned', fulfilledAtChapter: null, fulfilledDescription: null,
    })
    store.createHook({
      id: 'h-4', projectId, chapterNumber: 1,
      hookType: 'suspense', description: '悬挂钩子',
      status: 'thrown', fulfilledAtChapter: null, fulfilledDescription: null,
    })
    const report = auditor.audit(projectId)
    expect(report.hooks.total).toBe(4)
    expect(report.hooks.fulfilledRate).toBe(0.5) // 2/4
  })

  it('标记悬挂超过 3 章的钩子', () => {
    const projectId = setupProject()
    for (let i = 1; i <= 5; i++) {
      setupChapter(projectId, `ch-${i}`, i, `第${i}章内容`)
    }
    // 第 1 章抛出，当前第 5 章，gap = 4 ≥ 3
    store.createHook({
      id: 'h-1', projectId, chapterNumber: 1,
      hookType: 'suspense', description: '悬挂钩子',
      status: 'thrown', fulfilledAtChapter: null, fulfilledDescription: null,
    })
    const report = auditor.audit(projectId)
    expect(report.hooks.hanging).toHaveLength(1)
    expect(report.hooks.hanging[0].gap).toBe(4)
    expect(report.summary.some((s) => s.includes('钩子悬挂'))).toBe(true)
  })

  it('已兑现/已废弃的钩子不计入悬挂', () => {
    const projectId = setupProject()
    for (let i = 1; i <= 5; i++) {
      setupChapter(projectId, `ch-${i}`, i, `第${i}章内容`)
    }
    store.createHook({
      id: 'h-1', projectId, chapterNumber: 1,
      hookType: 'suspense', description: '已兑现',
      status: 'fulfilled', fulfilledAtChapter: 2, fulfilledDescription: '',
    })
    const report = auditor.audit(projectId)
    expect(report.hooks.hanging).toHaveLength(0)
  })
})

describe('ConsistencyAuditor - 孤儿实体', () => {
  it('检测编排了但正文未出现名字的角色', () => {
    const projectId = setupProject()
    const c1 = setupCharacter(projectId, 'c-1', '林墨')
    // 第 1 章正文包含"林墨"
    setupChapter(projectId, 'ch-1', 1, '林墨登场')
    // 第 2 章正文不包含"林墨"
    setupChapter(projectId, 'ch-2', 2, '苏雪登场')
    // 角色在第 1、2 章都有 history
    store.createCharacterHistory({
      projectId, characterId: c1.id,
      chapterId: 'ch-1', chapterNumber: 1,
      fieldName: 'currentState', oldValue: null, newValue: '本章首次出场', reason: null,
    })
    store.createCharacterHistory({
      projectId, characterId: c1.id,
      chapterId: 'ch-2', chapterNumber: 2,
      fieldName: 'currentState', oldValue: '本章首次出场', newValue: '继续出场', reason: null,
    })
    const report = auditor.audit(projectId)
    expect(report.orphanEntities.characters).toHaveLength(1)
    expect(report.orphanEntities.characters[0].name).toBe('林墨')
    expect(report.orphanEntities.characters[0].missingChapters).toEqual([2])
  })

  it('检测编排了但正文未出现名字的势力', () => {
    const projectId = setupProject()
    setupChapter(projectId, 'ch-1', 1, '无关内容')
    store.createFaction({
      id: 'f-1', projectId, name: '青云门',
      description: '', type: 'sect', leaderId: null,
      ideology: '', strength: 'medium', resources: [],
      allies: [], enemies: [], status: 'active',
      chapterSpans: [[1, 1]], // 第 1 章编排
    })
    const report = auditor.audit(projectId)
    expect(report.orphanEntities.factions).toHaveLength(1)
    expect(report.orphanEntities.factions[0].name).toBe('青云门')
    expect(report.orphanEntities.factions[0].missingChapters).toEqual([1])
  })

  it('检测编排了但正文未出现名字的地点', () => {
    const projectId = setupProject()
    setupChapter(projectId, 'ch-1', 1, '无关内容')
    store.createLocation({
      id: 'loc-1', projectId, name: '青云山',
      description: '', type: 'region', parentId: null, factionId: null,
      significance: 'major', firstChapter: 1, status: 'normal',
      appearChapters: [1],
    })
    const report = auditor.audit(projectId)
    expect(report.orphanEntities.locations).toHaveLength(1)
    expect(report.orphanEntities.locations[0].name).toBe('青云山')
  })

  it('正文包含名字的不算孤儿', () => {
    const projectId = setupProject()
    const c1 = setupCharacter(projectId, 'c-1', '林墨')
    setupChapter(projectId, 'ch-1', 1, '林墨登场')
    store.createCharacterHistory({
      projectId, characterId: c1.id,
      chapterId: 'ch-1', chapterNumber: 1,
      fieldName: 'currentState', oldValue: null, newValue: '本章首次出场', reason: null,
    })
    const report = auditor.audit(projectId)
    expect(report.orphanEntities.characters).toHaveLength(0)
  })

  it('未编排的角色（无 history）不检查', () => {
    const projectId = setupProject()
    setupCharacter(projectId, 'c-1', '林墨')
    setupChapter(projectId, 'ch-1', 1, '无关内容')
    const report = auditor.audit(projectId)
    expect(report.orphanEntities.characters).toHaveLength(0)
  })
})

describe('ConsistencyAuditor - 时间线矛盾', () => {
  it('timeOffset 单调递增时 monotonic=true', () => {
    const projectId = setupProject()
    setupChapter(projectId, 'ch-1', 1, '内容1', 0)
    setupChapter(projectId, 'ch-2', 2, '内容2', 5)
    setupChapter(projectId, 'ch-3', 3, '内容3', 10)
    const report = auditor.audit(projectId)
    expect(report.timeline.monotonic).toBe(true)
    expect(report.timeline.violations).toHaveLength(0)
  })

  it('timeOffset 非单调时检测到违反', () => {
    const projectId = setupProject()
    setupChapter(projectId, 'ch-1', 1, '内容1', 0)
    setupChapter(projectId, 'ch-2', 2, '内容2', 10)
    setupChapter(projectId, 'ch-3', 3, '内容3', 5) // 回退
    const report = auditor.audit(projectId)
    expect(report.timeline.monotonic).toBe(false)
    expect(report.timeline.violations).toHaveLength(1)
    expect(report.timeline.violations[0].chapter).toBe(3)
    expect(report.timeline.violations[0].timeOffset).toBe(5)
    expect(report.timeline.violations[0].previousOffset).toBe(10)
  })

  it('未设置 timeOffset 的章节跳过', () => {
    const projectId = setupProject()
    setupChapter(projectId, 'ch-1', 1, '内容1', 0)
    setupChapter(projectId, 'ch-2', 2, '内容2') // null
    setupChapter(projectId, 'ch-3', 3, '内容3', 5)
    const report = auditor.audit(projectId)
    expect(report.timeline.monotonic).toBe(true)
  })
})

describe('ConsistencyAuditor - 健康度评分', () => {
  it('伏笔回收率高时健康度更高', () => {
    const projectId = setupProject()
    // 10 条伏笔全部回收
    for (let i = 1; i <= 10; i++) {
      store.createForeshadow({
        id: `fs-${i}`, projectId, description: `伏笔${i}`,
        category: 'item', status: 'recovered',
        firstChapter: 1, lastChapter: 5, recoverByChapter: 5,
        chapterSpans: [],
      })
    }
    const report = auditor.audit(projectId)
    expect(report.foreshadow.recoveryRate).toBe(1)
    expect(report.healthScore).toBeGreaterThanOrEqual(90)
  })

  it('有孤儿实体时健康度下降', () => {
    const projectId = setupProject()
    const c1 = setupCharacter(projectId, 'c-1', '林墨')
    setupChapter(projectId, 'ch-1', 1, '无关内容')
    store.createCharacterHistory({
      projectId, characterId: c1.id,
      chapterId: 'ch-1', chapterNumber: 1,
      fieldName: 'currentState', oldValue: null, newValue: '本章首次出场', reason: null,
    })
    const report = auditor.audit(projectId)
    expect(report.orphanEntities.characters.length).toBeGreaterThan(0)
    expect(report.healthScore).toBeLessThan(100)
  })

  it('时间线矛盾时健康度下降', () => {
    const projectId = setupProject()
    setupChapter(projectId, 'ch-1', 1, '内容1', 0)
    setupChapter(projectId, 'ch-2', 2, '内容2', 10)
    setupChapter(projectId, 'ch-3', 3, '内容3', 5) // 回退
    const report = auditor.audit(projectId)
    expect(report.timeline.monotonic).toBe(false)
    expect(report.healthScore).toBeLessThan(100)
    expect(report.summary.some((s) => s.includes('时间线'))).toBe(true)
  })
})
