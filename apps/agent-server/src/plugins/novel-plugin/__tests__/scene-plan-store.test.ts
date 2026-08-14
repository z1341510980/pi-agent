import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'
import type { NovelChapter } from '../core/types.js'
import type { ChapterScenePlanScene } from '../core/chapters/chapter-scene-plan.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

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

const BUDGET = { baseTarget: 3000, adjustmentPct: 0, resolvedTarget: 3000, min: 2550, max: 3450 }

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
    progresses: [{ storylineId: 'sl1', primary: true, type: 'advance', expectedChange: '局势变化' }],
    ...overrides,
  }
}

describe('场景计划存储（ScenePlanStore）', () => {
  it('createPlanRevision 创建 draft，revision 递增，getCurrentPlan 忽略 draft', () => {
    const store = new NovelStore(createDb())
    const { projectId, chapter } = setupChapter(store)

    const p1 = store.createPlanRevision({ chapterId: chapter.id, projectId, budget: BUDGET })
    const p2 = store.createPlanRevision({ chapterId: chapter.id, projectId, budget: BUDGET })

    expect(p1.status).toBe('draft')
    expect(p1.revision).toBe(1)
    expect(p2.revision).toBe(2)
    // draft 不算生效计划
    expect(store.getCurrentPlan(chapter.id)).toBeUndefined()
  })

  it('transitionPlan 状态机 + expectedStatus 乐观锁', () => {
    const store = new NovelStore(createDb())
    const { projectId, chapter } = setupChapter(store)
    const plan = store.createPlanRevision({ chapterId: chapter.id, projectId, budget: BUDGET })

    store.transitionPlan(plan.id, 'approved', 'draft')
    store.transitionPlan(plan.id, 'consumed', 'approved')
    store.transitionPlan(plan.id, 'confirmed', 'consumed')
    expect(store.getPlanRevision(plan.id)!.status).toBe('confirmed')

    // 乐观锁冲突抛错
    expect(() => store.transitionPlan(plan.id, 'superseded', 'draft')).toThrow(/状态冲突/)
    // 合法 supersede
    store.transitionPlan(plan.id, 'superseded', 'confirmed')
    expect(store.getPlanRevision(plan.id)!.status).toBe('superseded')
  })

  it('supersedeActivePlans 只废弃 draft/approved，不碰 consumed/confirmed', () => {
    const store = new NovelStore(createDb())
    const { projectId, chapter } = setupChapter(store)
    const draft = store.createPlanRevision({ chapterId: chapter.id, projectId, budget: BUDGET })
    const approved = store.createPlanRevision({ chapterId: chapter.id, projectId, budget: BUDGET })
    store.transitionPlan(approved.id, 'approved', 'draft')
    const consumed = store.createPlanRevision({ chapterId: chapter.id, projectId, budget: BUDGET })
    store.transitionPlan(consumed.id, 'consumed', 'draft')

    store.supersedeActivePlans(chapter.id)

    expect(store.getPlanRevision(draft.id)!.status).toBe('superseded')
    expect(store.getPlanRevision(approved.id)!.status).toBe('superseded')
    expect(store.getPlanRevision(consumed.id)!.status).toBe('consumed')
  })

  it('幂等键：同 key 重复提交返回既有 plan', () => {
    const store = new NovelStore(createDb())
    const { projectId, chapter } = setupChapter(store)
    const key = `p:${projectId}:ch1:submit:req-1`
    const a = store.createPlanRevision({ chapterId: chapter.id, projectId, budget: BUDGET, idempotencyKey: key })
    const b = store.createPlanRevision({ chapterId: chapter.id, projectId, budget: BUDGET, idempotencyKey: key })
    expect(a.id).toBe(b.id)
  })

  it('submitPlanWithScenes：plan + scenes + cast 落库，重复提交旧 planned 标 superseded', () => {
    const store = new NovelStore(createDb())
    const { projectId, chapter } = setupChapter(store)

    const first = store.submitPlanWithScenes({
      chapterId: chapter.id, projectId, budget: BUDGET,
      scenes: [scene(), scene({ sceneKey: 's2', order: 2, targetWords: 0 })],
    })
    expect(first.plan.status).toBe('draft')
    expect(first.scenes).toHaveLength(2)

    // cast 落库（单链读取：focus 优先，present 排除 focus 角色）
    const cast = store.getSceneRevisionCast(first.scenes[0].id)
    expect(cast.focus).toEqual(['c1'])
    expect(cast.present).toEqual(['c2']) // c1 已在 focus，从 present 排除
    expect(cast.functions).toEqual([
      { characterId: 'c3', function: '传递情报', prominence: 'brief', note: '' },
    ])

    // 同一计划重复提交：旧 planned 场景版本 superseded，不堆积
    const second = store.submitPlanWithScenes({
      chapterId: chapter.id, projectId, budget: BUDGET,
      scenes: [scene()],
    })
    expect(second.plan.id).not.toBe(first.plan.id)
    const all = store.listSceneRevisionsByPlan(first.plan.id)
    expect(all.every((r) => r.status === 'superseded')).toBe(true)
    const latest = store.listSceneRevisionsByPlan(second.plan.id)
    expect(latest.every((r) => r.status === 'planned')).toBe(true)
  })

  it('confirmSceneRevision：planned → confirmed 并绑定 content revision', () => {
    const store = new NovelStore(createDb())
    const { projectId, chapter } = setupChapter(store)
    store.updateChapterContent(chapter.id, '正文 v2', 5, { phase: 'writer_initial', trigger: 't' })
    const currentContent = store.getCurrentContentRevision(chapter.id)!

    const { plan, scenes } = store.submitPlanWithScenes({
      chapterId: chapter.id, projectId, budget: BUDGET, scenes: [scene()],
    })
    store.transitionPlan(plan.id, 'approved', 'draft')
    store.transitionPlan(plan.id, 'consumed', 'approved')

    const confirmed = store.confirmSceneRevision(scenes[0].id, currentContent.id)
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.contentRevisionId).toBe(currentContent.id)
  })
})
