import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'
import { parseBeatPlanDraft, VolumeBeatPlanner } from '../core/chapters/beat-plan-generator.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

function createStore(): { store: NovelStore; db: Database.Database } {
  const db = createDb()
  const store = new NovelStore(db)
  store.createProject({
    id: 'project-1',
    title: '测试项目',
    genre: '都市异能',
    synopsis: '简介',
    outline: '全书大纲：主角觉醒异能，卷一立足，卷二对抗组织。',
    targetWords: 100000,
    currentVolume: 1,
    currentChapter: 1,
    currentStage: 'rising',
    status: 'active'
  })
  for (let n = 1; n <= 4; n += 1) {
    store.createChapter({
      id: randomUUID(),
      projectId: 'project-1',
      volume: 1,
      chapterNumber: n,
      title: `第${n}章`,
      content: '',
      wordCount: 0,
      status: 'planned',
      narrativeTask: '',
      outline: `第${n}章章纲`,
      volumeId: null,
      acceptanceResult: null,
      tension: null,
      positioning: null,
      timeOffset: null,
      chapterEndingHook: null,
      recap: null
    })
  }
  return { store, db }
}

const VALID_DRAFT = JSON.stringify({
  beats: [
    {
      chapterNumber: 5,
      dramaticFunction: 'Escalation',
      emotionalDebt: '上一章钩子未解',
      payoff: '无回报，继续加压',
      arcPosition: '第二幕前段',
      summary: '主角申诉被堵死。'
    },
    {
      chapterNumber: 6,
      dramaticFunction: 'false_victory',
      emotionalDebt: '',
      payoff: '暂时扳回一城',
      arcPosition: '中点前',
      summary: '主角赢下一局但埋下祸根。'
    }
  ],
  notes: ''
})

describe('parseBeatPlanDraft', () => {
  it('解析合法草稿并归一化戏剧功能大小写', () => {
    const draft = parseBeatPlanDraft(VALID_DRAFT, { startChapter: 5, count: 6 })
    expect(draft.beats).toHaveLength(2)
    expect(draft.beats[0].dramaticFunction).toBe('escalation')
    expect(draft.beats[1].dramaticFunction).toBe('false_victory')
    expect(draft.notes).toBe('')
  })

  it('容忍 Markdown 代码块包裹', () => {
    const draft = parseBeatPlanDraft(`\`\`\`json\n${VALID_DRAFT}\n\`\`\``, {
      startChapter: 5,
      count: 6
    })
    expect(draft.beats).toHaveLength(2)
  })

  it('缺少 beats 数组时抛错', () => {
    expect(() => parseBeatPlanDraft('{"notes":""}', { startChapter: 5, count: 6 })).toThrow(/beats/)
  })

  it('章号不连续时抛错并指出期望值', () => {
    const draft = JSON.stringify({
      beats: [
        { chapterNumber: 5, dramaticFunction: 'setup' },
        { chapterNumber: 9, dramaticFunction: 'climax' }
      ]
    })
    expect(() => parseBeatPlanDraft(draft, { startChapter: 5, count: 6 })).toThrow(/期望 6/)
  })

  it('未知戏剧功能抛错并列出允许值', () => {
    const draft = JSON.stringify({
      beats: [{ chapterNumber: 5, dramaticFunction: 'twist_of_fate' }]
    })
    expect(() => parseBeatPlanDraft(draft, { startChapter: 5, count: 6 })).toThrow(/未知戏剧功能/)
  })

  it('超过规划上限时抛错', () => {
    const beats = Array.from({ length: 7 }, (_, i) => ({
      chapterNumber: 5 + i,
      dramaticFunction: 'setup'
    }))
    expect(() =>
      parseBeatPlanDraft(JSON.stringify({ beats }), { startChapter: 5, count: 6 })
    ).toThrow(/上限/)
  })
})

describe('BeatPlanStore via NovelStore', () => {
  it('按卷替换节拍并按章号有序返回', () => {
    const { store } = createStore()
    const saved = store.replaceVolumeBeatPlan('project-1', 1, [
      {
        chapterNumber: 3,
        dramaticFunction: 'escalation',
        emotionalDebt: '债',
        payoff: '',
        arcPosition: '前段',
        summary: '走向A'
      },
      {
        chapterNumber: 4,
        dramaticFunction: 'payoff',
        emotionalDebt: '',
        payoff: '打脸',
        arcPosition: '中段',
        summary: '走向B'
      }
    ])
    expect(saved.map((beat) => beat.chapterNumber)).toEqual([3, 4])
    expect(saved[0].status).toBe('planned')

    // 重新规划覆盖旧行
    const replaced = store.replaceVolumeBeatPlan('project-1', 1, [
      { chapterNumber: 3, dramaticFunction: 'midpoint_turn' }
    ])
    expect(replaced).toHaveLength(1)
    expect(store.listBeatsByVolume('project-1', 1)).toHaveLength(1)
    expect(store.listBeatsByVolume('project-1', 1)[0].dramaticFunction).toBe('midpoint_turn')
  })

  it('published 章的 confirmed 节拍在重规划时保留', () => {
    const { store, db } = createStore()
    store.replaceVolumeBeatPlan('project-1', 1, [
      { chapterNumber: 2, dramaticFunction: 'setup' },
      { chapterNumber: 3, dramaticFunction: 'escalation' }
    ])
    // 第 2 章真实发布（绕过路由层发布保护，只验证 Store 的既成事实保护语义）
    db.prepare(
      "UPDATE novel_chapters SET status = 'published' WHERE project_id = 'project-1' AND chapter_number = 2"
    ).run()
    const confirmed = store.confirmBeatForChapter('project-1', 2)
    expect(confirmed?.status).toBe('confirmed')

    const replaced = store.replaceVolumeBeatPlan('project-1', 1, [
      { chapterNumber: 2, dramaticFunction: 'low_point' },
      { chapterNumber: 3, dramaticFunction: 'climax' }
    ])
    // published 章（第 2 章）的旧节拍保留，新计划落在其上的行被丢弃；
    // 返回值是重规划后的整卷节拍表（含保留项）
    const beat2 = store.getBeatByChapter('project-1', 2)
    expect(beat2?.dramaticFunction).toBe('setup')
    expect(beat2?.status).toBe('confirmed')
    expect(replaced.map((beat) => [beat.chapterNumber, beat.dramaticFunction])).toEqual([
      [2, 'setup'],
      [3, 'climax']
    ])
  })

  it('updateBeat 更新字段且 getBeatByChapter 忽略 superseded', () => {
    const { store } = createStore()
    const [saved] = store.replaceVolumeBeatPlan('project-1', 1, [
      { chapterNumber: 3, dramaticFunction: 'setup' }
    ])
    const updated = store.updateBeat(saved.id, { summary: '改后的走向' })
    expect(updated?.summary).toBe('改后的走向')
    expect(store.getBeatByChapter('project-1', 3)?.summary).toBe('改后的走向')

    store.updateBeat(saved.id, { status: 'superseded' })
    expect(store.getBeatByChapter('project-1', 3)).toBeUndefined()
  })
})

describe('VolumeBeatPlanner 卷纲质量门', () => {
  it('卷纲缺失或过薄时拒绝规划', async () => {
    const { store } = createStore()
    store.createVolume({
      id: randomUUID(),
      projectId: 'project-1',
      volumeNumber: 2,
      title: '第二卷',
      outline: '',
      sortOrder: 2
    })
    const planner = new VolumeBeatPlanner(
      store,
      { getTemplate: () => '', render: () => '' } as any,
      { logger: { warn: () => {} } } as any
    )
    await expect(planner.generate({ projectId: 'project-1', volumeNumber: 2 })).rejects.toThrow(
      /尚未填写卷纲/
    )

    store.createVolume({
      id: randomUUID(),
      projectId: 'project-1',
      volumeNumber: 3,
      title: '第三卷',
      outline: '太短',
      sortOrder: 3
    })
    await expect(planner.generate({ projectId: 'project-1', volumeNumber: 3 })).rejects.toThrow(
      /少于 50 字/
    )
  })
})
