import { describe, expect, it } from 'vitest'
import {
  createNovelSubmitNarrativeTaskTool,
  createNovelSubmitReviewTool,
  type NarrativeTaskDraftHolder,
  type ReviewDraftHolder,
} from '../core/novel-tools.js'

// ── Director 工具：novel_submit_narrative_task ──

describe('novel-tools - novel_submit_narrative_task tool', () => {
  it('提交完整叙事任务对象到 draft.task', async () => {
    // 工具化方案：Director 调用 novel_submit_narrative_task 工具提交结构化对象。
    // 工具内部把对象存入 draft.task，Director 结束后 orchestrator 直接读取。
    const draft: NarrativeTaskDraftHolder = {}
    const tool = createNovelSubmitNarrativeTaskTool(draft)

    const result = await tool.execute('test-call-id', {
      taskType: 'advance_mainline',
      priority: 'high',
      narrativeTask: '本章核心目标：叶明远通过夜间潜入工棚获取关键证据，同时避免被工头发现。上一章钩子（被盯梢）通过成功脱身回收。情节点：潜入→被发现→藏证据→脱身。冲突推进：怀疑→确认。情绪曲线：紧张→恐惧→侥幸→疲惫。POV：叶明远。章尾钩子：工头在远处盯着他。',
      secondaryTasks: ['change_relationship'],
      requiredReferences: ['character-1', '叶明远', 'character-1'],
      chapterEndingHook: {
        type: 'suspense',
        description: '工头提着油灯站在路口，盯着叶明远的背影',
      },
      povCharacters: ['叶明远'],
      sceneCount: 2,
      positioning: 'high_pressure',
      timelineOffset: {
        days: 3,
        description: '3 天后',
      },
    }, undefined, undefined, undefined as never)

    expect(draft.task).toBeDefined()
    expect(draft.task!.type).toBe('advance_mainline')
    expect(draft.task!.priority).toBe('high')
    expect(draft.task!.description).toContain('叶明远通过夜间潜入')
    expect(draft.task!.secondaryTasks).toEqual(['change_relationship'])
    expect(draft.task!.chapterEndingHook).toBe('suspense')
    expect(draft.task!.chapterEndingHookDescription).toContain('工头提着油灯')
    expect(draft.task!.povCharacters).toEqual(['叶明远'])
    expect(draft.task!.sceneCount).toBe(2)
    expect(draft.task!.positioning).toBe('high_pressure')
    expect(draft.task!.timeOffset).toBe(3)
    expect(draft.task!.requiredReferences).toEqual(['character-1', '叶明远'])
    expect(result.content[0]!.type).toBe('text')
    expect((result.content[0] as { text: string }).text).toContain('叙事任务已提交')
  })

  it('create_suspense 任务携带 suspenseDuration', async () => {
    const draft: NarrativeTaskDraftHolder = {}
    const tool = createNovelSubmitNarrativeTaskTool(draft)

    await tool.execute('test-call-id', {
      taskType: 'create_suspense',
      priority: 'medium',
      narrativeTask: '本章制造悬念：玉佩的来历成为读者疑问。',
      secondaryTasks: [],
      requiredReferences: [],
      chapterEndingHook: {
        type: 'suspense',
        description: '玉佩在月光下泛起微光',
      },
      povCharacters: ['叶明远'],
      sceneCount: 1,
      positioning: 'information',
      timelineOffset: {
        days: 0,
        description: '同日',
      },
      suspenseDuration: 5,
    }, undefined, undefined, undefined as never)

    expect(draft.task!.suspenseDuration).toBe(5)
  })

  it('escalate_conflict 任务携带 expectedIntensityDelta', async () => {
    const draft: NarrativeTaskDraftHolder = {}
    const tool = createNovelSubmitNarrativeTaskTool(draft)

    await tool.execute('test-call-id', {
      taskType: 'escalate_conflict',
      priority: 'high',
      narrativeTask: '本章升级冲突：叶明远与工头的对抗从暗转明。',
      secondaryTasks: [],
      requiredReferences: [],
      chapterEndingHook: {
        type: 'action',
        description: '工头抓住叶明远的衣领',
      },
      povCharacters: ['叶明远'],
      sceneCount: 2,
      positioning: 'high_pressure',
      timelineOffset: {
        days: 1,
        description: '次日',
      },
      intensityDelta: 5,
    }, undefined, undefined, undefined as never)

    expect(draft.task!.expectedIntensityDelta).toBe(5)
  })

  it('未调用工具时 draft.task 保持 undefined', () => {
    // Director 未调用工具：draft.task 为 undefined，orchestrator 据此触发重试或终止。
    const draft: NarrativeTaskDraftHolder = {}
    expect(draft.task).toBeUndefined()
  })

  it('narrativeTask 超过 800 字硬上限：拒绝写入 draft 并返回纠正提示', async () => {
    // 防御式字数闸：任务文本超限 = 一章塞了整条事件链，Writer 只能平均用力，
    // 导致主次不分 + 惯性超写（2026-09-01 实测 narrativeTask 600+ 字平铺、6 个必须事件）。
    const draft: NarrativeTaskDraftHolder = {}
    const tool = createNovelSubmitNarrativeTaskTool(draft)

    const result = await tool.execute('test-call-id', {
      taskType: 'advance_mainline',
      priority: 'high',
      narrativeTask: '核心事件'.repeat(500),
      secondaryTasks: [],
      requiredReferences: [],
      chapterEndingHook: { type: 'suspense', description: '钩子' },
      povCharacters: ['叶明远'],
      sceneCount: 3,
      positioning: 'high_pressure',
      timelineOffset: { days: 0, description: '同日' },
    }, undefined, undefined, undefined as never)

    expect(draft.task).toBeUndefined()
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('过长')
    expect(text).toContain('800 字')
    expect(text).toContain('核心事件')
  })
})

// ── Reviewer 工具：novel_submit_review ──

describe('novel-tools - novel_submit_review tool', () => {
  it('提交完整验收报告到 draft.review', async () => {
    // 工具化方案：Reviewer 调用 novel_submit_review 工具提交结构化对象。
    // 工具内部把对象存入 draft.review，Reviewer 结束后 orchestrator 直接读取，
    // 完全绕开正则解析 Markdown 报告。
    const draft: ReviewDraftHolder = {}
    const tool = createNovelSubmitReviewTool(draft)

    const result = await tool.execute('test-call-id', {
      consistencyScore: 8,
      characterScore: 7,
      taskCompletionScore: 9,
      clueProgressScore: 6,
      foreshadowStatusScore: 8,
      conflictChangeScore: 7,
      pacingScore: 6,
      infoControlScore: 9,
      readerHookScore: 8,
      styleScore: 7,
      overallScore: 7.5,
      verdict: 'revise',
      issues: [
        {
          severity: 'S2',
          category: 'continuity',
          description: '角色提前知道真相',
          location: '第12段',
        },
      ],
      suggestions: ['改为怀疑'],
    }, undefined, undefined, undefined as never)

    expect(draft.review).toBeDefined()
    expect(draft.review!.consistencyScore).toBe(8)
    expect(draft.review!.characterScore).toBe(7)
    expect(draft.review!.taskCompletionScore).toBe(9)
    expect(draft.review!.clueProgressScore).toBe(6)
    expect(draft.review!.foreshadowStatusScore).toBe(8)
    expect(draft.review!.conflictChangeScore).toBe(7)
    expect(draft.review!.pacingScore).toBe(6)
    expect(draft.review!.infoControlScore).toBe(9)
    expect(draft.review!.readerHookScore).toBe(8)
    expect(draft.review!.styleScore).toBe(7)
    expect(draft.review!.overallScore).toBe(7.5)
    expect(draft.review!.verdict).toBe('revise')
    // issues 和 suggestions 序列化为 JSON 字符串，符合 NovelChapterReview 字段类型
    expect(JSON.parse(draft.review!.issues!)).toEqual([
      {
        severity: 'S2',
        category: 'continuity',
        description: '角色提前知道真相',
        location: '第12段',
      },
    ])
    expect(JSON.parse(draft.review!.suggestions!)).toEqual(['改为怀疑'])
    expect(result.content[0]!.type).toBe('text')
    expect((result.content[0] as { text: string }).text).toContain('验收报告已提交')
    expect((result.content[0] as { text: string }).text).toContain('revise')
    expect((result.content[0] as { text: string }).text).toContain('7.5')
  })

  it('未提供的评分字段存为 null', async () => {
    // 评分字段全部可选：Reviewer 可只给部分维度评分，未给的存为 null，
    // saveReview 接受 null 字段，不会因缺失评分而失败。
    const draft: ReviewDraftHolder = {}
    const tool = createNovelSubmitReviewTool(draft)

    await tool.execute('test-call-id', {
      verdict: 'accept',
      issues: [],
      suggestions: [],
    }, undefined, undefined, undefined as never)

    expect(draft.review).toBeDefined()
    expect(draft.review!.consistencyScore).toBeNull()
    expect(draft.review!.characterScore).toBeNull()
    expect(draft.review!.overallScore).toBeNull()
    expect(draft.review!.verdict).toBe('accept')
    expect(JSON.parse(draft.review!.issues!)).toEqual([])
    expect(JSON.parse(draft.review!.suggestions!)).toEqual([])
  })

  it('未调用工具时 draft.review 保持 undefined', () => {
    // Reviewer 未调用工具：draft.review 为 undefined，orchestrator 据此记录警告。
    const draft: ReviewDraftHolder = {}
    expect(draft.review).toBeUndefined()
  })

  it('accept / revise / reject 三种 verdict 均可提交', async () => {
    for (const verdict of ['accept', 'revise', 'reject'] as const) {
      const draft: ReviewDraftHolder = {}
      const tool = createNovelSubmitReviewTool(draft)

      await tool.execute('test-call-id', {
        verdict,
        issues: [],
        suggestions: [],
      }, undefined, undefined, undefined as never)

      expect(draft.review!.verdict).toBe(verdict)
    }
  })
})
