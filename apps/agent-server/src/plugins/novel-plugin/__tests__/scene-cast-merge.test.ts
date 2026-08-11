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

function setupChapter(store: NovelStore, flags?: Record<string, boolean>): { projectId: string; chapter: NovelChapter } {
  const projectId = randomUUID()
  store.createProject({
    id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
    targetWords: 3000, currentVolume: 1, currentChapter: 1,
    currentStage: 'rising', status: 'active', flags,
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

describe('Scene Cast 合并（P1-3，Flag 控制）', () => {
  it('Flag 关闭：只写三表，cast 表为空（行为与现状一致）', () => {
    const store = new NovelStore(createDb())
    const { projectId, chapter } = setupChapter(store)
    store.submitPlanWithScenes({ chapterId: chapter.id, projectId, budget: BUDGET, scenes: [scene()] })

    const dbRaw = (store as unknown as { db: Database.Database }).db
    const castCount = (dbRaw.prepare('SELECT COUNT(*) AS n FROM novel_scene_cast').get() as { n: number }).n
    expect(castCount).toBe(0)
    const focusCount = (dbRaw.prepare('SELECT COUNT(*) AS n FROM novel_scene_focus').get() as { n: number }).n
    expect(focusCount).toBe(1)
  })

  it('sceneCastV2Write + scenePlanV2DualWrite：三表 + cast 影子写，往返一致', () => {
    const store = new NovelStore(createDb())
    const { projectId, chapter } = setupChapter(store, {
      sceneCastV2Write: true,
      scenePlanV2DualWrite: true,
    })
    const { scenes } = store.submitPlanWithScenes({
      chapterId: chapter.id, projectId, budget: BUDGET,
      scenes: [scene(), scene({ sceneKey: 's2', order: 2, focusCharacterIds: ['c9'], presentCharacterIds: ['c9'], functionalCast: [{ characterId: 'c10', function: '守门', prominence: 'lead' }] })],
    })

    const dbRaw = (store as unknown as { db: Database.Database }).db
    const castCount = (dbRaw.prepare('SELECT COUNT(*) AS n FROM novel_scene_cast').get() as { n: number }).n
    expect(castCount).toBeGreaterThan(0)

    // 往返数量一致：三表 vs cast
    const report = store.reconcileSceneCast(projectId)
    expect(report.sourceRows).toBe(report.targetRows)
    expect(report.mismatchRows).toBe(0)
    expect(report.mismatchByRole).toEqual({ focus: 0, present: 0, functional: 0 })
    expect(report.checkedSceneRevisions).toBe(2)

    // 功能位不丢：functional 的 function/prominence/note 字段级（note 对齐旧表默认 ''）
    const scene2 = scenes[1]
    const cast = store.getSceneCast(scene2.id)
    const fn = cast.find((c) => c.role === 'functional')
    expect(fn?.function).toBe('守门')
    expect(fn?.prominence).toBe('lead')
    expect(fn?.note).toBe('')
  })

  it('sceneCastV2Write（无 dualWrite）：停旧写，只写 cast（P1-3-4）', () => {
    const store = new NovelStore(createDb())
    const { projectId, chapter } = setupChapter(store, { sceneCastV2Write: true })
    store.submitPlanWithScenes({ chapterId: chapter.id, projectId, budget: BUDGET, scenes: [scene()] })

    const dbRaw = (store as unknown as { db: Database.Database }).db
    const focusCount = (dbRaw.prepare('SELECT COUNT(*) AS n FROM novel_scene_focus').get() as { n: number }).n
    const presentCount = (dbRaw.prepare('SELECT COUNT(*) AS n FROM novel_scene_presence').get() as { n: number }).n
    const fnCount = (dbRaw.prepare('SELECT COUNT(*) AS n FROM novel_scene_functions').get() as { n: number }).n
    expect(focusCount).toBe(0)
    expect(presentCount).toBe(0)
    expect(fnCount).toBe(0)
    const castCount = (dbRaw.prepare('SELECT COUNT(*) AS n FROM novel_scene_cast').get() as { n: number }).n
    expect(castCount).toBeGreaterThan(0)
  })

  it('sceneCastV2Read：getSceneRevisionCast 读 cast 表；focus+present 并存去重（P1-3-5）', () => {
    const store = new NovelStore(createDb())
    const { projectId, chapter } = setupChapter(store, {
      sceneCastV2Write: true,
      sceneCastV2Read: true,
    })
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

  it('reconcileSceneCast：影子写后对账 mismatch=0（P1-3-3）', () => {
    const store = new NovelStore(createDb())
    const { projectId, chapter } = setupChapter(store, {
      sceneCastV2Write: true,
      scenePlanV2DualWrite: true,
    })
    store.submitPlanWithScenes({
      chapterId: chapter.id, projectId, budget: BUDGET,
      scenes: [scene(), scene({ sceneKey: 's2', order: 2 })],
    })
    const report = store.reconcileSceneCast(projectId)
    expect(report.mismatchRows).toBe(0)
    expect(report.orphanRows).toBe(0)
    expect(report.duplicateRows).toBe(0)
    expect(report.rollbackVerified).toBe(false)
  })
})
