import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'
import type { NovelChapter } from '../core/types.js'
import type { ChapterScenePlanScene } from '../core/chapter-scene-plan.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

const BUDGET = { baseTarget: 3000, adjustmentPct: 0, resolvedTarget: 3000, min: 2550, max: 3450 }

function setupChapter(store: NovelStore): { projectId: string; chapter: NovelChapter } {
  const projectId = randomUUID()
  store.createProject({
    id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
    targetWords: 3000, currentVolume: 1, currentChapter: 1,
    currentStage: 'rising', status: 'active',
  })
  const chapter = store.createChapter({
    id: randomUUID(), projectId, volume: 1, chapterNumber: 1,
    title: '第一章', content: '正文', wordCount: 2,
    status: 'planned', narrativeTask: '', outline: '', volumeId: null,
    acceptanceResult: null, tension: null, positioning: null,
    timeOffset: null, chapterEndingHook: null, recap: null,
  })
  return { projectId, chapter }
}

function scene(overrides: Partial<ChapterScenePlanScene> = {}): ChapterScenePlanScene {
  return {
    sceneKey: 's1',
    order: 1,
    title: '场景一',
    goal: '推进目标',
    locationText: '测试地点',
    timeText: '当日',
    povMode: 'single',
    povCharacterId: 'c1',
    focusCharacterIds: ['c1'],
    presentCharacterIds: ['c1', 'c2'],
    functionalCast: [{ characterId: 'c3', function: '传递情报', prominence: 'brief' }],
    targetWords: 3000,
    progresses: [],
    ...overrides,
  }
}

describe('Scene Cast 单链（P1-3，V2 唯一写面）', () => {
  it('默认只写 cast 表，旧三表为空（单链）', () => {
    const store = new NovelStore(createDb())
    const { projectId, chapter } = setupChapter(store)
    store.submitPlanWithScenes({ chapterId: chapter.id, projectId, budget: BUDGET, scenes: [scene()] })

    const dbRaw = (store as unknown as { db: Database.Database }).db
    const castCount = (dbRaw.prepare('SELECT COUNT(*) AS n FROM novel_scene_cast').get() as { n: number }).n
    expect(castCount).toBeGreaterThan(0)
    const focusCount = (dbRaw.prepare('SELECT COUNT(*) AS n FROM novel_scene_focus').get() as { n: number }).n
    expect(focusCount).toBe(0)
    const presentCount = (dbRaw.prepare('SELECT COUNT(*) AS n FROM novel_scene_presence').get() as { n: number }).n
    expect(presentCount).toBe(0)
    const fnCount = (dbRaw.prepare('SELECT COUNT(*) AS n FROM novel_scene_functions').get() as { n: number }).n
    expect(fnCount).toBe(0)
  })

  it('多场景往返一致：cast 行数与场景声明角色数一致，功能位不丢', () => {
    const store = new NovelStore(createDb())
    const { projectId, chapter } = setupChapter(store)
    const { scenes } = store.submitPlanWithScenes({
      chapterId: chapter.id, projectId, budget: BUDGET,
      scenes: [scene(), scene({ sceneKey: 's2', order: 2, focusCharacterIds: ['c9'], presentCharacterIds: ['c9'], functionalCast: [{ characterId: 'c10', function: '守门', prominence: 'lead' }] })],
    })

    const dbRaw = (store as unknown as { db: Database.Database }).db
    const castCount = (dbRaw.prepare('SELECT COUNT(*) AS n FROM novel_scene_cast').get() as { n: number }).n
    // s1: c1(focus) + c1/c2(present) + c3(functional) = 4；s2: c9(focus) + c9(present) + c10(functional) = 3
    expect(castCount).toBe(7)

    // 功能位不丢：functional 的 function/prominence/note 字段级
    const scene2 = scenes[1]
    const cast = store.getSceneCast(scene2.id)
    const fn = cast.find((c) => c.role === 'functional')
    expect(fn?.function).toBe('守门')
    expect(fn?.prominence).toBe('lead')
    expect(fn?.note).toBe('')
  })

  it('getSceneRevisionCast 读 cast 表；focus+present 并存去重（P1-3-5）', () => {
    const store = new NovelStore(createDb())
    const { projectId, chapter } = setupChapter(store)
    // focus 与 present 并存 c1：读取侧 present 应排除 c1
    const { scenes } = store.submitPlanWithScenes({
      chapterId: chapter.id, projectId, budget: BUDGET,
      scenes: [scene()],
    })
    const cast = store.getSceneRevisionCast(scenes[0].id)
    expect(cast.focus).toEqual(['c1'])
    expect(cast.present).toEqual(['c2']) // c1 已在 focus，从 present 排除
    expect(cast.functions).toEqual([
      { characterId: 'c3', function: '传递情报', prominence: 'brief', note: '' },
    ])

    // getSceneCast 数据层保真：原样返回全部行（含 focus+present 并存）
    const raw = store.getSceneCast(scenes[0].id)
    const c1Roles = raw.filter((r) => r.characterId === 'c1').map((r) => r.role)
    expect(c1Roles).toContain('focus')
    expect(c1Roles).toContain('present')
  })

  it('reconcileSceneCast：单链下旧三表停写 → sourceRows=0、cast 行存在', () => {
    const store = new NovelStore(createDb())
    const { projectId, chapter } = setupChapter(store)
    store.submitPlanWithScenes({
      chapterId: chapter.id, projectId, budget: BUDGET,
      scenes: [scene(), scene({ sceneKey: 's2', order: 2 })],
    })
    const report = store.reconcileSceneCast(projectId)
    // 单链：旧三表已停写（source=0），cast 表承载全部角色关系
    expect(report.sourceRows).toBe(0)
    expect(report.targetRows).toBeGreaterThan(0)
    expect(report.duplicateRows).toBe(0)
    expect(report.rollbackVerified).toBe(false)
    expect(report.checkedSceneRevisions).toBeGreaterThanOrEqual(2)
  })
})
