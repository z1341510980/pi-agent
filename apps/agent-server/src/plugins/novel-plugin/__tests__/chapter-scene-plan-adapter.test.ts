import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'
import {
  splitTargetWords,
  buildScenePlanFromNarrativeTask,
  buildScenePlanFromSceneDefinitions,
  type PlanBudget,
} from '../core/chapter-scene-plan-adapter.js'
import { validateChapterScenePlan } from '../core/chapter-scene-plan.js'
import type { NarrativeTask } from '../core/types.js'
import type { SceneDefinition } from '../../../core/agent/discussion-types.js'

const BUDGET: PlanBudget = { baseTarget: 3000, adjustmentPct: 0, resolvedTarget: 3000, min: 2550, max: 3450 }

function task(overrides: Partial<NarrativeTask> = {}): NarrativeTask {
  return {
    description: '主角被迫做出选择',
    type: 'advance_mainline',
    targetEntity: null,
    priority: 'medium',
    ...overrides,
  }
}

describe('splitTargetWords 字数拆分', () => {
  it('均分，余数给最后一份', () => {
    expect(splitTargetWords(3000, 3)).toEqual([1000, 1000, 1000])
    expect(splitTargetWords(3001, 3)).toEqual([1000, 1000, 1001])
    expect(splitTargetWords(3000, 1)).toEqual([3000])
  })
})

describe('buildScenePlanFromNarrativeTask', () => {
  const base = {
    planRevisionId: 'plan-1', chapterId: 'ch-1', projectId: 'p-1', budget: BUDGET,
  }

  it('sceneCount=3 拆三场，字数均分，预算校验通过', () => {
    const plan = buildScenePlanFromNarrativeTask({
      ...base, task: task({ sceneCount: 3, povCharacters: ['叶明远'] }),
      characterIdByName: new Map([['叶明远', 'c1']]),
    })
    expect(plan.scenes).toHaveLength(3)
    expect(plan.scenes.map((s) => s.targetWords)).toEqual([1000, 1000, 1000])
    expect(validateChapterScenePlan(plan)).toEqual([])
  })

  it('单 POV 且能解析为 id → single + povCharacterId', () => {
    const plan = buildScenePlanFromNarrativeTask({
      ...base, task: task({ sceneCount: 1, povCharacters: ['叶明远'] }),
      characterIdByName: new Map([['叶明远', 'c1']]),
    })
    expect(plan.scenes[0].povMode).toBe('single')
    expect(plan.scenes[0].povCharacterId).toBe('c1')
    expect(validateChapterScenePlan(plan)).toEqual([])
  })

  it('多 POV / 未指定 → omniscient，不猜测 POV id', () => {
    const multi = buildScenePlanFromNarrativeTask({
      ...base, task: task({ sceneCount: 2, povCharacters: ['叶明远', '沈维章'] }),
      characterIdByName: new Map([['叶明远', 'c1']]),
    })
    expect(multi.scenes.every((s) => s.povMode === 'omniscient')).toBe(true)
    expect(multi.scenes.every((s) => s.povCharacterId === null)).toBe(true)

    const none = buildScenePlanFromNarrativeTask({
      ...base, task: task({ sceneCount: 1 }),
      characterIdByName: new Map([['叶明远', 'c1']]),
    })
    expect(none.scenes[0].povMode).toBe('omniscient')
    expect(none.scenes[0].povCharacterId).toBeNull()
    expect(validateChapterScenePlan(none)).toEqual([])
  })

  it('arrangedEntities 提供 focus/present（前 5）', () => {
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']
    const plan = buildScenePlanFromNarrativeTask({
      ...base, task: task({ sceneCount: 1 }),
      arrangedEntities: { characterIds: ids, conflictIds: [], foreshadowIds: [], clueIds: [], factionIds: [], locationIds: [], itemIds: [], characterFunctions: [] },
    })
    expect(plan.scenes[0].presentCharacterIds).toEqual(ids)
    expect(plan.scenes[0].focusCharacterIds).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
  })
})

describe('buildScenePlanFromSceneDefinitions', () => {
  const base = {
    planRevisionId: 'plan-1', chapterId: 'ch-1', projectId: 'p-1', budget: BUDGET,
  }
  const defs: SceneDefinition[] = [
    { sceneId: 1, title: '雨夜', location: '巷口', time: '夜', presentCharacters: ['c1', 'c2'], goal: '追上信使' },
    { sceneId: 2, title: '对峙', location: '仓库', time: '次日', presentCharacters: ['c3'], goal: '摊牌' },
  ]

  it('逐场映射：omniscient、present 直通、字数均分', () => {
    const plan = buildScenePlanFromSceneDefinitions({ ...base, sceneDefinitions: defs })
    expect(plan.scenes).toHaveLength(2)
    expect(plan.scenes[0].povMode).toBe('omniscient')
    expect(plan.scenes[0].presentCharacterIds).toEqual(['c1', 'c2'])
    expect(plan.scenes[0].locationText).toBe('巷口')
    expect(plan.scenes[0].goal).toBe('追上信使')
    expect(plan.scenes.map((s) => s.targetWords)).toEqual([1500, 1500])
    expect(validateChapterScenePlan(plan)).toEqual([])
  })

  it('空场景列表 → 空 plan（调用方负责跳过）', () => {
    const plan = buildScenePlanFromSceneDefinitions({ ...base, sceneDefinitions: [] })
    expect(plan.scenes).toHaveLength(0)
  })
})

describe('T03 影子写集成（flag 开启的 store 链路）', () => {
  function createDb(): Database.Database {
    const db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    return db
  }

  it('NarrativeTask → 落库 plan(approved) + scenes，重跑 supersede 旧计划', () => {
    const store = new NovelStore(createDb())
    const projectId = randomUUID()
    store.createProject({
      id: projectId, title: 'test', genre: 'g', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 1,
      currentStage: 'rising', status: 'active', flags: { scenePlanV2Write: true },
    })
    const chapter = store.createChapter({
      id: randomUUID(), projectId, volume: 1, chapterNumber: 1,
      title: '第一章', content: '', wordCount: 0,
      status: 'planned', narrativeTask: '', outline: '', volumeId: null,
      acceptanceResult: null, tension: null, positioning: null,
      timeOffset: null, chapterEndingHook: null, recap: null,
    })

    // 模拟 orchestrator.shadowWriteDirectorPlan 的完整链路
    const shadowWrite = (t: NarrativeTask) => {
      const budget = { baseTarget: 3000, adjustmentPct: 0, resolvedTarget: 3000, min: 2550, max: 3450 }
      store.supersedeActivePlans(chapter.id)
      const plan = store.createPlanRevision({ chapterId: chapter.id, projectId, budget })
      const scenePlan = buildScenePlanFromNarrativeTask({
        planRevisionId: plan.id, chapterId: chapter.id, projectId, task: t, budget,
        characterIdByName: new Map([['叶明远', 'c1']]),
      })
      store.createSceneRevisions(plan, scenePlan.scenes)
      store.transitionPlan(plan.id, 'approved', 'draft')
      return plan
    }

    const p1 = shadowWrite(task({ sceneCount: 2, povCharacters: ['叶明远'] }))
    // createPlanRevision 返回的是创建时 draft 快照；状态以库为准
    expect(store.getPlanRevision(p1.id)!.status).toBe('approved')
    expect(store.listSceneRevisionsByPlan(p1.id)).toHaveLength(2)
    expect(store.getCurrentPlan(chapter.id)!.id).toBe(p1.id)

    // Director 重跑 → 旧 approved 变 superseded，新计划接管
    const p2 = shadowWrite(task({ sceneCount: 3, povCharacters: ['叶明远'] }))
    expect(store.getPlanRevision(p1.id)!.status).toBe('superseded')
    expect(store.getCurrentPlan(chapter.id)!.id).toBe(p2.id)
    // 旧计划场景全部 superseded，新计划场景 planned
    expect(store.listSceneRevisionsByPlan(p1.id).every((s) => s.status === 'superseded')).toBe(true)
    expect(store.listSceneRevisionsByPlan(p2.id).every((s) => s.status === 'planned')).toBe(true)
    expect(store.listSceneRevisionsByPlan(p2.id)).toHaveLength(3)
  })
})
