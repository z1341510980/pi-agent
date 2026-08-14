import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { NovelMemoryGenerator, type StorylineProgressItem } from '../core/generation/novel-memory-generator.js'
import { novelMigrations } from '../novel-migrations.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

function setup(store: NovelStore, flags?: Record<string, boolean>): { projectId: string; chapterId: string } {
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
  return { projectId, chapterId: chapter.id }
}

function makeGenerator(store: NovelStore): NovelMemoryGenerator {
  // 只用到 applyStorylineProgresses（不触发 LLM），其他依赖用最小 stub
  return new NovelMemoryGenerator(
    {} as any, {} as any,
    { logger: { warn: () => {}, info: () => {} } } as any,
    store,
    {} as any,
  )
}

function planForChapter(store: NovelStore, chapterId: string, projectId: string): void {
  const budget = { baseTarget: 3000, adjustmentPct: 0, resolvedTarget: 3000, min: 2550, max: 3450 }
  const plan = store.createPlanRevision({ chapterId, projectId, positioning: 'advancement', budget })
  // 剧情推进绑定到场景 revision，plan 必须带场景
  store.createSceneRevisions(plan, [{
    sceneKey: 's1', order: 1, title: '场景一', goal: 'g', locationText: 'l', timeText: 't',
    povMode: 'single', povCharacterId: null, focusCharacterIds: [], presentCharacterIds: [],
    functionalCast: [], targetWords: 3000, progresses: [],
  }])
  store.transitionPlan(plan.id, 'approved', 'draft')
}

describe('剧情推进轨道：Memory 提取落库（第一轮）', () => {
  it('flag 开 + 有生效 plan → storyline 与 progress 落库（confirmed）', () => {
    const store = new NovelStore(createDb())
    const { projectId, chapterId } = setup(store)
    planForChapter(store, chapterId, projectId)
    const generator = makeGenerator(store)

    const intents: StorylineProgressItem[] = [
      { storylineName: '矿区权力重组', type: 'advance', primary: true, beforeState: '旧主退场', afterState: '新势力露头', summary: '主角被迫站队' },
      { storylineName: '节点真相', type: 'reveal', beforeState: '未知', afterState: '确认六节点关联', summary: '发现节点联动' },
    ]

    const applied = (generator as any).applyStorylineProgresses(projectId, 1, intents)
    expect(applied).toBe(2)

    // storyline 自动创建（candidate）
    const storylines = store.listStorylines(projectId)
    expect(storylines.map((s) => s.name)).toEqual(['矿区权力重组', '节点真相'])
    expect(storylines[0].maturity).toBe('candidate')

    // progress 已确认（Memory 应用即确认）；同秒创建顺序不稳定，按字段断言
    const sceneRev = store.listSceneRevisionsByPlan(store.getCurrentPlan(chapterId)!.id)[0]
    const progress = store.listProgressByScene(sceneRev.id)
    expect(progress).toHaveLength(2)
    expect(progress.every((p) => p.status === 'confirmed')).toBe(true)
    expect(progress.find((p) => p.primary)?.type).toBe('advance')
    expect(progress.map((p) => p.type).sort()).toEqual(['advance', 'reveal'])
  })

  it('两个不同场景各推进同一条线 → maturity 晋升 established', () => {
    const store = new NovelStore(createDb())
    const { projectId, chapterId } = setup(store)
    planForChapter(store, chapterId, projectId)
    const generator = makeGenerator(store)

    // 第一章：场景 1 推进
    ;(generator as any).applyStorylineProgresses(projectId, 1, [
      { storylineName: '主线对抗', type: 'advance' },
    ])

    // 第二章：新计划 + 场景 2 推进
    store.createChapter({
      id: randomUUID(), projectId, volume: 1, chapterNumber: 2,
      title: '第二章', content: '', wordCount: 0,
      status: 'planned', narrativeTask: '', outline: '', volumeId: null,
      acceptanceResult: null, tension: null, positioning: null,
      timeOffset: null, chapterEndingHook: null, recap: null,
    })
    const chapter2 = store.getChapter(projectId, 2)!
    planForChapter(store, chapter2.id, projectId)
    ;(generator as any).applyStorylineProgresses(projectId, 2, [
      { storylineName: '主线对抗', type: 'turn' },
    ])

    const storyline = store.listStorylines(projectId)[0]
    expect(storyline.maturity).toBe('established')
    expect(store.listProgressByStoryline(storyline.id, ['confirmed'])).toHaveLength(2)
  })

  it('flag 关（V1）→ 跳过不落库、不抛错', () => {
    const store = new NovelStore(createDb())
    const { projectId } = setup(store)
    const generator = makeGenerator(store)

    const applied = (generator as any).applyStorylineProgresses(projectId, 1, [
      { storylineName: '主线', type: 'advance' },
    ])
    expect(applied).toBe(0)
    expect(store.listStorylines(projectId)).toHaveLength(0)
  })

  it('flag 开但无 plan → 跳过并告警，不抛错', () => {
    const store = new NovelStore(createDb())
    const { projectId } = setup(store)
    const generator = makeGenerator(store)

    const applied = (generator as any).applyStorylineProgresses(projectId, 1, [
      { storylineName: '主线', type: 'advance' },
    ])
    expect(applied).toBe(0)
    expect(store.listStorylines(projectId)).toHaveLength(0)
  })

  it('同 scene + 同 storyline 幂等：重复提取不重复插入', () => {
    const store = new NovelStore(createDb())
    const { projectId, chapterId } = setup(store)
    planForChapter(store, chapterId, projectId)
    const generator = makeGenerator(store)

    const intent: StorylineProgressItem[] = [{ storylineName: '主线', type: 'advance' }]
    expect((generator as any).applyStorylineProgresses(projectId, 1, intent)).toBe(1)
    expect((generator as any).applyStorylineProgresses(projectId, 1, intent)).toBe(0)

    const sceneRev = store.listSceneRevisionsByPlan(store.getCurrentPlan(chapterId)!.id)[0]
    expect(store.listProgressByScene(sceneRev.id)).toHaveLength(1)
  })
})
