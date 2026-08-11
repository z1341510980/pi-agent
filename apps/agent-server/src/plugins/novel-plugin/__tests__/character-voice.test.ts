import { describe, it, expect } from 'vitest'
import {
  buildVoiceProfiles,
  formatVoiceContrastTable,
  detectVoiceCollapse,
} from '../core/character-voice.js'
import type { NovelCharacter } from '../core/types.js'

function makeCharacter(patch: Partial<NovelCharacter> & { id: string; name: string }): NovelCharacter {
  return {
    projectId: 'p1',
    description: '',
    identity: '',
    personality: '',
    appearance: '',
    currentState: '',
    currentGoal: '',
    currentPressure: '',
    secret: '',
    arcStage: 'setup',
    arcHistory: '[]',
    speechStyle: '',
    isProtagonist: false,
    longTermDesire: '',
    plotRole: 'supporting',
    removalImpact: '',
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as NovelCharacter
}

describe('角色声音坐标分配', () => {
  it('档案声明的轴优先，不被系统分配覆盖', () => {
    const characters = [
      makeCharacter({
        id: 'c1',
        name: '叶明远',
        speechStyle: '{"基调":"技术理性，习惯用工程术语打比方","特点":"短句，惜字如金"}',
      }),
    ]
    const [profile] = buildVoiceProfiles(characters)
    expect(profile.register).toBe('technical')
    expect(profile.sentenceLength).toBe('clipped')
    expect(profile.fromProfile.register).toBe(true)
    expect(profile.fromProfile.sentenceLength).toBe(true)
  })

  it('同场角色的三轴组合互不相同（这是"读者能分辨谁在说话"的下限）', () => {
    const characters = ['c1', 'c2', 'c3', 'c4'].map((id, index) =>
      makeCharacter({ id, name: `角色${index}` }))
    const profiles = buildVoiceProfiles(characters)
    const combos = profiles.map((p) => `${p.sentenceLength}|${p.register}|${p.answerMode}`)
    expect(new Set(combos).size).toBe(combos.length)
  })

  it('同一角色在不同批次里得到同一把嗓子（分配是确定性的，不是随机的）', () => {
    const character = makeCharacter({ id: 'stable-id', name: '赵岩' })
    const first = buildVoiceProfiles([character])[0]
    const second = buildVoiceProfiles([character])[0]
    expect(second.sentenceLength).toBe(first.sentenceLength)
    expect(second.register).toBe(first.register)
    expect(second.answerMode).toBe(first.answerMode)
  })

  it('主角默认直答：主角长期回避会让读者跟不住动机', () => {
    const [profile] = buildVoiceProfiles([
      makeCharacter({ id: 'hero', name: '叶明远', isProtagonist: true, plotRole: 'protagonist' }),
    ])
    expect(profile.answerMode).toBe('direct')
  })

  it('同场角色的语域互不相同（语域决定选词与比喻来源，撞车等于同一个人）', () => {
    // 两份档案的关键词都会命中 technical：反推是启发式的，区分度优先于猜测结果
    const profiles = buildVoiceProfiles([
      makeCharacter({ id: 'c1', name: '甲', speechStyle: '{"基调":"用词精确，技术出身"}' }),
      makeCharacter({ id: 'c2', name: '乙', speechStyle: '{"基调":"引用数据，专业术语多"}' }),
      makeCharacter({ id: 'c3', name: '丙', speechStyle: '{"基调":"工程思维"}' }),
    ])
    const registers = profiles.map((profile) => profile.register)
    expect(new Set(registers).size).toBe(registers.length)
  })

  it('主角的语域优先保住，配角让位（主角声音贯穿全书）', () => {
    const profiles = buildVoiceProfiles([
      // 配角档案更详细（三轴全命中），但语域仍应让给主角
      makeCharacter({
        id: 'side',
        name: '沈维章',
        plotRole: 'function',
        speechStyle: '{"基调":"引用数据，专业术语多","特点":"短句，一针见血","回避":"保留"}',
      }),
      makeCharacter({
        id: 'hero',
        name: '叶明远',
        isProtagonist: true,
        plotRole: 'protagonist',
        speechStyle: '{"基调":"工程思维，用词精确"}',
      }),
    ])
    const hero = profiles.find((profile) => profile.name === '叶明远')!
    expect(hero.register).toBe('technical')
    expect(profiles.find((profile) => profile.name === '沈维章')!.register).not.toBe('technical')
  })

  it('禁用词来自同场其他角色的语域标记', () => {


    const profiles = buildVoiceProfiles([
      makeCharacter({ id: 'c1', name: '技术员', speechStyle: '{"基调":"技术术语，精确"}' }),
      makeCharacter({ id: 'c2', name: '老农', speechStyle: '{"基调":"乡土朴实，庄稼话"}' }),
    ])
    const farmer = profiles.find((p) => p.name === '老农')!
    expect(farmer.banned.length).toBeGreaterThan(0)
    // 老农不该说技术腔的词
    expect(farmer.banned.some((word) => ['参数', '模块'].includes(word))).toBe(true)
  })

  it('对照表给出可执行的字数区间与检验方式，而不是只给形容词', () => {
    const table = formatVoiceContrastTable(buildVoiceProfiles([
      makeCharacter({ id: 'c1', name: '甲', speechStyle: '{"基调":"简练"}' }),
      makeCharacter({ id: 'c2', name: '乙', speechStyle: '{"基调":"绕，喜欢铺陈"}' }),
    ]))
    expect(table).toContain('角色声音对照表')
    expect(table).toContain('12 字')
    expect(table).toContain('互换')
  })

  it('无角色时不产出空标题', () => {
    expect(formatVoiceContrastTable([])).toBe('')
  })
})

describe('对白趋同检测', () => {
  /** 问答接口形态：长度一致 + 全完整句 + 无反问回避 */
  const interfaceDialogue = Array.from({ length: 12 }, (_, index) =>
    `"这是第${index}条完整准确的回答，信息量适中。"他说。`).join('\n\n')

  it('识别问答接口形态：全完整句 + 无摩擦', () => {
    const report = detectVoiceCollapse(interfaceDialogue)
    const codes = report.issues.map((issue) => issue.code)
    expect(codes).toContain('voice_all_complete')
    expect(codes).toContain('voice_no_friction')
  })

  it('台词过少时不做判定（独处场景不应被误判）', () => {
    const report = detectVoiceCollapse('"走吧。"他说。\n\n"好。"')
    expect(report.issues).toEqual([])
    expect(report.dialogueCount).toBe(2)
  })

  it('有反问、半句和长短差异时不报趋同', () => {
    const lively = [
      '"你们一直守着？"',
      '"在。"',
      '"我说，你练了几个月的那套功法，它运行的路线图里有一部分，在我们这边的身体上找不到对应的结构，专家组现在也说不清"',
      '"什么？"',
      '"回头再说。"',
      '"那我身上的这些穴位，是怎么来的"',
      '"不知道。"',
      '"按规定我不便说明，你先等着。"',
      '"等到什么时候"',
      '"枪。"',
      '"什么型号？"',
      '"能用就行。"',
    ].map((line) => `${line}`).join('\n\n')
    const report = detectVoiceCollapse(lively)
    expect(report.dialogueCount).toBeGreaterThanOrEqual(8)
    expect(report.issues.map((issue) => issue.code)).not.toContain('voice_no_friction')
  })
})
