import { describe, expect, it } from 'vitest'
import {
  buildChapterOutlineDraftFromSubmit,
  createChapterOutlineSubmitTool,
  formatChapterOutlineSubmitAttempts,
  hashChapterOutline,
  parseChapterOutlineDraft,
  type ChapterOutlineSubmitDraftHolder
} from '../core/chapters/chapter-outline.js'

function validDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    outlineText: '主角进入旧城区追查线索，在误导中确认真正目标，最终发现新的威胁。',
    chapterGoal: '确认失踪案的真正目标',
    openingState: '主角只有一条不完整线索',
    progression: ['进入旧城区', '验证线索', '发现线索被人故意修改'],
    obstacles: ['时间有限', '证人不愿配合'],
    turningPoint: '证人的证词暴露了幕后操纵者',
    endingState: '主角锁定下一步调查方向',
    hook: '幕后操纵者已经注意到主角',
    sceneCountEstimate: 3,
    povSuggestions: [{ characterId: 'char-1', mode: 'single' }],
    storylines: [{ storylineId: 'line-1', intendedProgress: '确认案件并非偶发事件' }],
    continuityRisks: [],
    ...overrides
  }
}

describe('ChapterOutlineDraft 协议', () => {
  it('结构漂移归一：元信息包装 + 中文键别名 + 标量矫正都能解析', () => {
    const wrapped = JSON.stringify({
      元信息: { 模型: 'test', 时间: '2026-08-25' },
      章纲: {
        version: '1',
        正文: '主角进入旧城区追查线索，在误导中确认真正目标，最终发现新的威胁。',
        章节目标: '确认失踪案的真目标',
        开场状态: '车队只留下一名线人',
        推进: ['进入旧城区', '验证证词'],
        障碍: ['时间不够', '证人不愿开口'],
        转折点: '证人的证词指向新的幕后主使',
        结尾状态: '主角锁定新的调查方向',
        钩子: '花瓶的裂纹已经被注意到',
        场景数: '3',
        povSuggestions: [{ characterId: 'char-1', mode: 'single' }],
        storylines: [{ storylineId: 'line-1', intendedProgress: '确认包裹失踪的真事件' }],
        continuityRisks: []
      }
    })
    const draft = parseChapterOutlineDraft(wrapped, {
      characters: new Map([['char-1', '叶默']]),
      storylines: new Map([['line-1', '失踪案']])
    })
    expect(draft.version).toBe(1)
    expect(draft.outlineText).toContain('旧城区')
    expect(draft.sceneCountEstimate).toBe(3)
    expect(draft.povSuggestions[0].characterName).toBe('叶默')
  })

  it('协议版本标签归一化：字符串数字 / 自增版本 / 缺失都接受为当前版本', () => {
    const references = {
      characters: new Map([['char-1', '叶默']]),
      storylines: new Map([['line-1', '失踪案']])
    }
    for (const version of ['1', 7, undefined]) {
      const overrides = version === undefined
        ? { version: undefined }
        : { version }
      const draft = parseChapterOutlineDraft(
        JSON.stringify(validDraft(overrides)),
        references
      )
      expect(draft.version).toBe(1)
      expect(draft.outlineText.length).toBeGreaterThan(20)
    }
  })

  it('严格解析 JSON 并用可信实体名称补全展示字段', () => {
    const draft = parseChapterOutlineDraft(JSON.stringify(validDraft()), {
      characters: new Map([['char-1', '林默']]),
      storylines: new Map([['line-1', '失踪案主线']])
    })

    expect(draft.povSuggestions).toEqual([
      { characterId: 'char-1', characterName: '林默', mode: 'single' }
    ])
    expect(draft.storylines).toEqual([
      {
        storylineId: 'line-1',
        storylineName: '失踪案主线',
        intendedProgress: '确认案件并非偶发事件'
      }
    ])
  })

  it('过滤不存在的实体 ID，并把问题转成连续性风险', () => {
    const draft = parseChapterOutlineDraft(
      JSON.stringify(
        validDraft({
          povSuggestions: [{ characterId: 'missing-character', mode: 'single' }],
          storylines: [{ storylineId: 'missing-line', intendedProgress: '推进' }]
        })
      ),
      {
        characters: new Map(),
        storylines: new Map()
      }
    )

    expect(draft.povSuggestions).toEqual([])
    expect(draft.storylines).toEqual([])
    expect(draft.continuityRisks).toHaveLength(2)
    expect(draft.continuityRisks.every((risk) => risk.type === 'unknown_entity')).toBe(true)
  })

  it('全知和无固定视角不要求角色，并规范化旧返回中的角色 ID', () => {
    const draft = parseChapterOutlineDraft(
      JSON.stringify(
        validDraft({
          povSuggestions: [
            { mode: 'omniscient', characterId: 'legacy-character' },
            { mode: 'none' }
          ]
        })
      ),
      {
        characters: new Map(),
        storylines: new Map([['line-1', '失踪案主线']])
      }
    )

    expect(draft.povSuggestions).toEqual([
      { mode: 'omniscient', characterId: null, characterName: null },
      { mode: 'none', characterId: null, characterName: null }
    ])
    expect(draft.continuityRisks).toEqual([])
  })

  it('非法 JSON 或缺失字段时拒绝返回半成品草稿', () => {
    expect(() =>
      parseChapterOutlineDraft('{not-json}', {
        characters: new Map(),
        storylines: new Map()
      })
    ).toThrow('JSON 无法解析')
    expect(() =>
      parseChapterOutlineDraft(JSON.stringify({ version: 1 }), {
        characters: new Map(),
        storylines: new Map()
      })
    ).toThrow('不符合协议')
  })

  it('兼容代码块、未闭合代码块和 JSON 前后的说明文字', () => {
    const references = {
      characters: new Map([['char-1', '林默']]),
      storylines: new Map([['line-1', '失踪案主线']])
    }
    const json = JSON.stringify(validDraft())

    expect(parseChapterOutlineDraft(`\`\`\`json\n${json}\n\`\`\``, references).chapterGoal)
      .toBe('确认失踪案的真正目标')
    expect(parseChapterOutlineDraft(`\`\`\`json\n${json}`, references).chapterGoal)
      .toBe('确认失踪案的真正目标')
    expect(parseChapterOutlineDraft(`结果如下：\n${json}\n请审阅。`, references).chapterGoal)
      .toBe('确认失踪案的真正目标')
  })

  it('章纲 hash 对相同内容稳定，并区分不同内容', () => {
    expect(hashChapterOutline('章纲 A')).toBe(hashChapterOutline('章纲 A'))
    expect(hashChapterOutline('章纲 A')).not.toBe(hashChapterOutline('章纲 B'))
  })
})

describe('submit_chapter_outline 工具提交路径', () => {
  const references = {
    characters: new Map([['char-1', '林默']]),
    storylines: new Map([['line-1', '失踪案主线']])
  }

  /** 直连调用工具 execute（绕过 SDK 的 signal / onUpdate / ctx 形参） */
  function invokeSubmit(
    holder: ChapterOutlineSubmitDraftHolder,
    payload: Record<string, unknown>,
    toolCallId = 'call-1'
  ): Promise<{ content: unknown }> {
    const tool = createChapterOutlineSubmitTool(holder) as unknown as {
      execute: (id: string, params: unknown) => Promise<{ content: unknown }>
    }
    return tool.execute(toolCallId, payload)
  }

  it('mode=single 但 characterId 为空串时降级为风险，不再打穿整次章纲', () => {
    const draft = buildChapterOutlineDraftFromSubmit(
      validDraft({ povSuggestions: [{ characterId: '', mode: 'single' }] }),
      references
    )

    expect(draft.povSuggestions).toEqual([])
    expect(draft.continuityRisks).toEqual([
      expect.objectContaining({
        type: 'unknown_entity',
        description: expect.stringContaining('没有给出角色 ID')
      })
    ])
    // 其余字段照常入库，作者仍拿到可编辑草稿
    expect(draft.chapterGoal).toBe('确认失踪案的真正目标')
  })

  it('空白 characterId / 缺 storylineId / 大写 mode 都被归一', () => {
    const draft = buildChapterOutlineDraftFromSubmit(
      validDraft({
        povSuggestions: [
          { characterId: '   ', mode: 'OMNISCIENT' },
          { characterId: ' char-1 ', mode: 'single' }
        ],
        storylines: [{ storylineId: '  ', intendedProgress: '推进' }]
      }),
      references
    )

    expect(draft.povSuggestions).toEqual([
      { mode: 'omniscient', characterId: null, characterName: null },
      { mode: 'single', characterId: 'char-1', characterName: '林默' }
    ])
    expect(draft.storylines).toEqual([])
  })

  it('协议校验失败时错误信息带上实际值', () => {
    expect(() =>
      buildChapterOutlineDraftFromSubmit(validDraft({ sceneCountEstimate: 99 }), references)
    ).toThrow(/sceneCountEstimate.*（实际值 99）/)
  })

  it('工具 execute 拒绝非法提交、返回纠正提示，并记录每次原始入参', async () => {
    const holder: ChapterOutlineSubmitDraftHolder = {}

    const rejected = await invokeSubmit(holder, validDraft({ progression: [] }), 'call-1')
    expect(holder.payload).toBeUndefined()
    expect(JSON.stringify(rejected.content)).toContain('progression')
    expect(JSON.stringify(rejected.content)).toContain('重新调用')

    const accepted = await invokeSubmit(holder, validDraft(), 'call-2')
    expect(JSON.stringify(accepted.content)).toContain('章纲已提交')
    expect(holder.payload).toBeDefined()
    expect(holder.attempts).toHaveLength(2)
    expect(holder.attempts?.[0]).toMatchObject({ accepted: false })
    expect(holder.attempts?.[0].payload).toMatchObject({ progression: [] })
    expect(holder.attempts?.[1]).toMatchObject({ accepted: true })
  })

  it('提交审计文本包含被拒绝的原始入参，便于日志排查', () => {
    const text = formatChapterOutlineSubmitAttempts([
      { payload: { povSuggestions: [{ characterId: '', mode: 'single' }] }, accepted: false, reason: '空 ID' },
      { payload: { chapterGoal: '确认' }, accepted: true }
    ])

    expect(text).toContain('attempt="1"')
    expect(text).toContain('accepted="false"')
    expect(text).toContain('"characterId": ""')
    expect(text).toContain('attempt="2"')
    expect(text).toContain('accepted="true"')
  })

  it('工具 execute 与 build 的判定一致：execute 放过的提交 build 不会再打回', async () => {
    const holder: ChapterOutlineSubmitDraftHolder = {}
    await invokeSubmit(holder, validDraft({ povSuggestions: [{ characterId: '', mode: 'single' }] }))
    expect(holder.payload).toBeDefined()
    expect(() => buildChapterOutlineDraftFromSubmit(holder.payload!, references)).not.toThrow()
  })
})
