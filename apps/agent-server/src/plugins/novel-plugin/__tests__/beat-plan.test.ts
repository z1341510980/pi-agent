import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'
import {
  parseBeatPlanDraft,
  parseSingleBeatDraft,
  createChapterBeatSubmitTool,
  type ChapterBeatSubmitDraftHolder,
  VolumeBeatPlanner
} from '../core/chapters/beat-plan-generator.js'

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

describe('parseSingleBeatDraft', () => {
  const VALID = JSON.stringify({
    beat: {
      chapterNumber: 7,
      dramaticFunction: 'Low_Point',
      emotionalDebt: '债',
      payoff: '',
      arcPosition: '中段',
      summary: '走向'
    }
  })

  it('解析合法草稿并归一化戏剧功能大小写', () => {
    const beat = parseSingleBeatDraft(VALID, { chapterNumber: 7 })
    expect(beat.dramaticFunction).toBe('low_point')
    expect(beat.chapterNumber).toBe(7)
    expect(beat.summary).toBe('走向')
  })

  it('容忍裸对象与 Markdown 代码块包裹', () => {
    const bare = JSON.stringify({ chapterNumber: 7, dramaticFunction: 'climax' })
    expect(parseSingleBeatDraft(bare, { chapterNumber: 7 }).dramaticFunction).toBe('climax')
    expect(parseSingleBeatDraft(`\`\`\`json\n${VALID}\n\`\`\``, { chapterNumber: 7 }).summary).toBe('走向')
  })

  it('章号不符时抛错并指出目标章号', () => {
    expect(() => parseSingleBeatDraft(VALID, { chapterNumber: 8 })).toThrow(/必须等于第 8 章/)
  })

  it('未知戏剧功能抛错并列出允许值', () => {
    const bad = JSON.stringify({ beat: { chapterNumber: 7, dramaticFunction: 'nope' } })
    expect(() => parseSingleBeatDraft(bad, { chapterNumber: 7 })).toThrow(/未知戏剧功能/)
  })

  it('缺少 beat 对象时抛错', () => {
    expect(() => parseSingleBeatDraft('{"notes":""}', { chapterNumber: 7 })).toThrow(/缺少 beat 对象/)
  })
})

describe('upsertChapterPlan 单章 upsert（T2）', () => {
  it('无行时插入，有行时更新并重置为 planned', () => {
    const { store } = createStore()
    const inserted = store.upsertChapterBeatPlan('project-1', 1, {
      chapterNumber: 3,
      dramaticFunction: 'setup',
      summary: '初版'
    })
    expect(inserted?.status).toBe('planned')

    const updated = store.upsertChapterBeatPlan('project-1', 1, {
      chapterNumber: 3,
      dramaticFunction: 'climax',
      summary: '改版'
    })
    expect(updated?.id).toBe(inserted?.id)
    expect(updated?.dramaticFunction).toBe('climax')
    // upsert 不产生重复行
    expect(store.listBeatsByProject('project-1')).toHaveLength(1)

    // 重生成把 confirmed 行重置为 planned（已发布保护在生成入口拦截）
    store.updateBeat(inserted!.id, { status: 'confirmed' })
    const revived = store.upsertChapterBeatPlan('project-1', 1, {
      chapterNumber: 3,
      dramaticFunction: 'breather',
      summary: '复活'
    })
    expect(revived?.status).toBe('planned')
  })
})

describe('VolumeBeatPlanner.generateForChapter 单章生成校验门', () => {
  const makePlanner = (store: NovelStore): VolumeBeatPlanner =>
    new VolumeBeatPlanner(
      store,
      { getTemplate: () => '', render: () => '' } as any,
      { logger: { warn: () => {} } } as any
    )

  it('已发布章节拒绝生成', async () => {
    const { store, db } = createStore()
    db.prepare(
      "UPDATE novel_chapters SET status = 'published' WHERE project_id = 'project-1' AND chapter_number = 2"
    ).run()
    await expect(
      makePlanner(store).generateForChapter({ projectId: 'project-1', chapterNumber: 2 })
    ).rejects.toThrow(/已发布/)
  })

  it('章节未归属任何卷时拒绝生成', async () => {
    const { store } = createStore()
    await expect(
      makePlanner(store).generateForChapter({ projectId: 'project-1', chapterNumber: 2 })
    ).rejects.toThrow(/未归属任何卷/)
  })

  it('卷纲过薄时拒绝生成', async () => {
    const { store } = createStore()
    store.createVolume({
      id: randomUUID(),
      projectId: 'project-1',
      volumeNumber: 1,
      title: '第一卷',
      outline: '太短',
      sortOrder: 1
    })
    await expect(
      makePlanner(store).generateForChapter({ projectId: 'project-1', chapterNumber: 2 })
    ).rejects.toThrow(/少于 50 字/)
  })
})

describe('submit_chapter_beat 工具（方案 D）', () => {
  const runTool = async (
    expectedChapterNumber: number,
    args: Record<string, unknown>
  ): Promise<{ draft: ChapterBeatSubmitDraftHolder; text: string }> => {
    const draft: ChapterBeatSubmitDraftHolder = {}
    const tool = createChapterBeatSubmitTool(draft, expectedChapterNumber)
    const execute = (tool as unknown as {
      execute: (id: string, toolArgs: unknown) => Promise<unknown>
    }).execute
    const result = (await execute('fake-call', args)) as {
      content: Array<{ type: string; text: string }>
    }
    return { draft, text: result.content[0]?.text ?? '' }
  }

  it('合法参数（含大小写归一化与缺省字段）写入 payload', async () => {
    const { draft, text } = await runTool(7, {
      chapterNumber: 7,
      dramaticFunction: 'Low_Point',
      emotionalDebt: '债',
      summary: '走向'
    })
    expect(draft.payload).toMatchObject({
      chapterNumber: 7,
      dramaticFunction: 'low_point',
      emotionalDebt: '债',
      payoff: '',
      summary: '走向'
    })
    expect(text).toContain('low_point')
  })

  it('章号不符时不写 payload 并返回纠正提示', async () => {
    const { draft, text } = await runTool(7, {
      chapterNumber: 8,
      dramaticFunction: 'climax'
    })
    expect(draft.payload).toBeUndefined()
    expect(text).toContain('第 7 章')
  })

  it('未知戏剧功能时不写 payload 并返回纠正提示', async () => {
    const { draft, text } = await runTool(7, {
      chapterNumber: 7,
      dramaticFunction: 'nope'
    })
    expect(draft.payload).toBeUndefined()
    expect(text).toContain('十选一')
  })
})

describe('generateForChapter 工具化提交链路', () => {
  /** 建一个带合格卷纲（≥50 字）的 store，章节 1-4 归属第 1 卷 */
  function createStoreWithVolume(): { store: NovelStore; db: import('better-sqlite3').Database } {
    const fixture = createStore()
    fixture.store.createVolume({
      id: randomUUID(),
      projectId: 'project-1',
      volumeNumber: 1,
      title: '第一卷',
      outline: '卷纲：主角在旧城区连续遭遇失踪案，先立足再反击，卷尾扳倒区域保护伞，留下更大组织的线索伏笔，为下一卷对抗总部做铺垫。',
      sortOrder: 1
    })
    return fixture
  }

  const BEAT_ARGS = {
    chapterNumber: 2,
    dramaticFunction: 'Escalation',
    emotionalDebt: '上一章钩子未解',
    payoff: '小胜一局',
    arcPosition: '第二幕前段',
    summary: '主角申诉被堵死。'
  }

  function createPlannerWithFakeSession(
    store: NovelStore,
    options: {
      /** 模拟 provider 是否支持工具调用 */
      disableToolExecution?: boolean
      /** 首轮模型返回的文本（工具路径下作为工具参数） */
      modelResult: string
      /** 修复轮模型返回的文本 */
      repairedResult?: string
    }
  ): {
    planner: VolumeBeatPlanner
    getCapturedOptions: () => Record<string, unknown> | undefined
    promptCalls: Array<unknown[]>
  } {
    let capturedOptions: Record<string, unknown> | undefined
    const promptCalls: Array<unknown[]> = []
    let subscriber: ((event: Record<string, unknown>) => void) | undefined
    const context = {
      logger: { warn: vi.fn() },
      createSession: vi.fn(async (sessionOptions: Record<string, unknown>) => {
        capturedOptions = sessionOptions
        return {
          sessionId: 'beat-session',
          prompt: async (...args: unknown[]) => {
            promptCalls.push(args)
            subscriber?.({
              type: 'message_end',
              message: {
                role: 'assistant',
                provider: 'provider-a',
                model: 'model-beat',
                usage: { inputTokens: 100, outputTokens: 50 }
              }
            })
            const isRepair = args.length > 0
            const text = isRepair ? options.repairedResult ?? options.modelResult : options.modelResult
            if (!isRepair && !options.disableToolExecution && Array.isArray(sessionOptions.tools) && sessionOptions.tools.length > 0) {
              const submitTool = sessionOptions.tools[0] as unknown as {
                execute: (id: string, toolArgs: unknown) => Promise<unknown>
              }
              await submitTool.execute('fake-tool-call', JSON.parse(options.modelResult))
              return '本章节拍已通过结构化提交工具入库。'
            }
            return text
          },
          promptStream: vi.fn(),
          subscribe: (handler: (event: Record<string, unknown>) => void) => {
            subscriber = handler
            return () => {
              subscriber = undefined
            }
          },
          abort: vi.fn(),
          dispose: vi.fn()
        }
      })
    } as never
    const planner = new VolumeBeatPlanner(
      store,
      { getTemplate: () => '', render: () => '' } as never,
      context
    )
    return {
      planner,
      getCapturedOptions: () => capturedOptions,
      promptCalls
    }
  }

  it('主路径：模型调用工具提交，校验 tools 配置且 responseFormat 不再声明', async () => {
    const { store } = createStoreWithVolume()
    const runner = createPlannerWithFakeSession(store, {
      modelResult: JSON.stringify(BEAT_ARGS)
    })
    const result = await runner.planner.generateForChapter({ projectId: 'project-1', chapterNumber: 2 })

    const capturedOptions = runner.getCapturedOptions() as
      | { tools?: Array<{ name?: string }>; responseFormat?: unknown }
      | undefined
    expect(capturedOptions?.tools).toHaveLength(1)
    expect(capturedOptions?.tools?.[0]?.name).toBe('submit_chapter_beat')
    expect(capturedOptions?.responseFormat).toBeUndefined()

    // 大小写归一化落库
    expect(result.beat.dramaticFunction).toBe('escalation')
    expect(store.getBeatByChapter('project-1', 2)?.summary).toBe('主角申诉被堵死。')
  })

  it('兜底：provider 不支持工具时解析文本 JSON（含大小写归一化）', async () => {
    const { store } = createStoreWithVolume()
    const { planner } = createPlannerWithFakeSession(store, {
      disableToolExecution: true,
      modelResult: JSON.stringify({ beat: BEAT_ARGS })
    })
    const result = await planner.generateForChapter({ projectId: 'project-1', chapterNumber: 2 })
    expect(result.beat.dramaticFunction).toBe('escalation')
  })

  it('修复轮：首轮文本协议漂移（dramaticFunction 缺失）后同会话重试成功', async () => {
    const { store } = createStoreWithVolume()
    const { planner, promptCalls } = createPlannerWithFakeSession(store, {
      disableToolExecution: true,
      // 复现线上漂移：beat 对象存在但键缺失 → 旧实现抛"未知戏剧功能: undefined"
      modelResult: JSON.stringify({ beat: { chapterNumber: 2, summary: '走向' } }),
      repairedResult: JSON.stringify({ beat: { ...BEAT_ARGS } })
    })
    const result = await planner.generateForChapter({ projectId: 'project-1', chapterNumber: 2 })
    expect(result.beat.dramaticFunction).toBe('escalation')
    expect(promptCalls).toHaveLength(2)
  })

  it('修复轮仍失败时抛出协议错误', async () => {
    const { store } = createStoreWithVolume()
    const { planner } = createPlannerWithFakeSession(store, {
      disableToolExecution: true,
      modelResult: JSON.stringify({ beat: { chapterNumber: 2 } }),
      repairedResult: JSON.stringify({ beat: { chapterNumber: 2 } })
    })
    await expect(
      planner.generateForChapter({ projectId: 'project-1', chapterNumber: 2 })
    ).rejects.toThrow(/未知戏剧功能|缺少/)
  })
})

describe('节拍↔章节数据正确性', () => {
  it('删除中间章后节拍随章节左移，被删章的节拍行移除', () => {
    const { store } = createStore()
    store.replaceVolumeBeatPlan('project-1', 1, [
      { chapterNumber: 1, dramaticFunction: 'setup' },
      { chapterNumber: 2, dramaticFunction: 'escalation' },
      { chapterNumber: 3, dramaticFunction: 'false_victory' },
      { chapterNumber: 4, dramaticFunction: 'climax' }
    ])
    const chapter2 = store.getChapter('project-1', 2)
    expect(chapter2).toBeDefined()
    // 连续多行节拍同时左移，覆盖 UNIQUE(project_id, chapter_number) 的批量平移路径
    expect(store.deleteChapter(chapter2!.id)).toBe(true)

    expect(
      store.listBeatsByProject('project-1').map((beat) => [
        beat.chapterNumber,
        beat.dramaticFunction
      ])
    ).toEqual([
      [1, 'setup'],
      [2, 'false_victory'],
      [3, 'climax']
    ])
  })

  it('publishReviewedChapter 发布后同事务确认该章节拍', () => {
    const { store, db } = createStore()
    store.replaceVolumeBeatPlan('project-1', 1, [
      { chapterNumber: 2, dramaticFunction: 'setup' },
      { chapterNumber: 3, dramaticFunction: 'escalation' }
    ])
    const chapter2 = store.getChapter('project-1', 2)!
    db.prepare("UPDATE novel_chapters SET status = 'review' WHERE id = ?").run(chapter2.id)

    const published = store.publishReviewedChapter(chapter2.id)
    expect(published?.status).toBe('published')
    expect(store.getBeatByChapter('project-1', 2)?.status).toBe('confirmed')
    // 其余章的节拍状态不受影响
    expect(store.getBeatByChapter('project-1', 3)?.status).toBe('planned')
  })
})
