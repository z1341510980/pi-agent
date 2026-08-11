import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

function setup(store: NovelStore): { projectId: string } {
  const projectId = randomUUID()
  store.createProject({
    id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
    targetWords: 3000, currentVolume: 1, currentChapter: 1,
    currentStage: 'rising', status: 'active',
  })
  return { projectId }
}

function makeChapter(store: NovelStore, projectId: string, chapterNumber: number): string {
  const chapter = store.createChapter({
    id: randomUUID(), projectId, volume: 1, chapterNumber,
    title: `第${chapterNumber}章`, content: '', wordCount: 0,
    status: 'planned', narrativeTask: '', outline: '', volumeId: null,
    acceptanceResult: null, tension: null, positioning: null,
    timeOffset: null, chapterEndingHook: null, recap: null,
  })
  return chapter.id
}

function planWithScenes(store: NovelStore, chapterId: string, projectId: string, sceneCount: number): string {
  const budget = { baseTarget: 3000, adjustmentPct: 0, resolvedTarget: 3000, min: 2550, max: 3450 }
  const plan = store.createPlanRevision({ chapterId, projectId, positioning: 'advancement', budget })
  store.createSceneRevisions(plan, Array.from({ length: sceneCount }, (_, i) => ({
    sceneKey: `s${i + 1}`, order: i + 1, title: `场景${i + 1}`, goal: 'g', locationText: 'l', timeText: 't',
    povMode: 'single', povCharacterId: null, focusCharacterIds: [], presentCharacterIds: [],
    functionalCast: [], targetWords: Math.floor(3000 / sceneCount), progresses: [],
  })))
  store.transitionPlan(plan.id, 'approved', 'draft')
  return plan.id
}

describe('剧情推进轨道投影（narrative-matrix）', () => {
  it('空项目：rows/sceneNodes 为空、staleCount=0', () => {
    const store = new NovelStore(createDb())
    const { projectId } = setup(store)
    const report = store.narrativeMatrix(projectId)
    expect(report.source).toBe('v2-ledger')
    expect(report.rows).toEqual([])
    expect(report.sceneNodes).toEqual([])
    expect(report.staleCount).toBe(0)
    expect(report.sourceRevision).toMatch(/^[0-9a-f]{16}$/)
    expect(report.projectionLag).toBe(0)
    expect(report.stale).toBe(false)
  })

  it('两条故事线多章推进 → 行内 progress 按章序、sceneNodes 去重', () => {
    const store = new NovelStore(createDb())
    const { projectId } = setup(store)
    const ch1 = makeChapter(store, projectId, 1)
    const ch2 = makeChapter(store, projectId, 2)

    // 第 1 章计划（1 场景）+ 第 2 章计划（1 场景）
    const p1 = planWithScenes(store, ch1, projectId, 1)
    const p2 = planWithScenes(store, ch2, projectId, 1)
    const scene1 = store.listSceneRevisionsByPlan(p1)[0].id
    const scene2 = store.listSceneRevisionsByPlan(p2)[0].id

    // 线 A：第 1、2 章各推进一次；线 B：仅第 1 章
    // （与生产路径一致：planned 落库 → confirmProgress 触发成熟度晋升）
    const mk = (sceneRevisionId: string, intents: Array<{ storylineName: string; primary?: boolean; type: string; summary?: string }>) => {
      const recorded = store.recordProgressForScene(projectId, sceneRevisionId, intents as any, 'planned')
      for (const p of recorded) store.confirmProgress(p.id)
    }
    mk(scene1, [
      { storylineName: '主线对抗', primary: true, type: 'advance', summary: '第一次推进' },
      { storylineName: '感情线', primary: false, type: 'setup', summary: '铺垫' },
    ])
    mk(scene2, [
      { storylineName: '主线对抗', primary: true, type: 'turn', summary: '转向' },
    ])

    const report = store.narrativeMatrix(projectId)
    expect(report.rows).toHaveLength(2)

    const mainline = report.rows.find((r) => r.name === '主线对抗')!
    expect(mainline.maturity).toBe('established') // 两个不同场景 confirmed
    expect(mainline.progresses.map((p) => p.chapterNumber)).toEqual([1, 2])
    expect(mainline.progresses.map((p) => p.type)).toEqual(['advance', 'turn'])

    const romance = report.rows.find((r) => r.name === '感情线')!
    expect(romance.maturity).toBe('candidate')
    expect(romance.progresses).toHaveLength(1)

    // sceneNodes 去重：两个场景
    expect(report.sceneNodes).toHaveLength(2)
    expect(report.sceneNodes[0].chapterNumber).toBe(1)
    expect(report.sceneNodes[1].chapterNumber).toBe(2)
  })

  it('stale progress 被排除并计数（中间章重写场景）', () => {
    const store = new NovelStore(createDb())
    const { projectId } = setup(store)
    const ch1 = makeChapter(store, projectId, 1)
    const p1 = planWithScenes(store, ch1, projectId, 1)
    const scene1 = store.listSceneRevisionsByPlan(p1)[0].id

    const recorded = store.recordProgressForScene(projectId, scene1, [
      { storylineName: '主线对抗', primary: true, type: 'advance' },
    ], 'confirmed')

    const report1 = store.narrativeMatrix(projectId)
    expect(report1.rows[0].progresses).toHaveLength(1)
    expect(report1.staleCount).toBe(0)

    // 模拟中间章重写：progress 标 stale
    store.markStaleFromChapter(projectId, ch1)

    const report2 = store.narrativeMatrix(projectId)
    expect(report2.rows[0].progresses).toHaveLength(0)
    expect(report2.staleCount).toBe(1)
    expect(report2.stale).toBe(true)
    expect(store.narrativeMatrix(projectId, { asOfRevision: report1.sourceRevision }).stale).toBe(true)
    expect(store.narrativeMatrix(projectId, { asOfRevision: report2.sourceRevision }).stale).toBe(true)
    void recorded
  })
})
