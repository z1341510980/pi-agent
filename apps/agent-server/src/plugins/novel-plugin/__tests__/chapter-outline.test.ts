import { describe, expect, it } from 'vitest'
import { hashChapterOutline, parseChapterOutlineDraft } from '../core/chapters/chapter-outline.js'

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
