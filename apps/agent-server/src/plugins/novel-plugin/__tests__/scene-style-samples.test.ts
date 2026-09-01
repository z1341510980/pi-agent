import { describe, it, expect } from 'vitest'
import {
  inferSceneType,
  buildSceneSampleSection,
  compileWritingStylePrompt,
} from '../core/prompting/writing-style-prompt-factory.js'
import type { NovelWritingStyleProfile } from '../core/types.js'

function makeProfile(overrides: Partial<NovelWritingStyleProfile> = {}): NovelWritingStyleProfile {
  return {
    id: 'p1',
    projectId: 'proj',
    name: '基线',
    preset: 'custom',
    narrativePerson: 'third',
    narrativeDistance: 'limited',
    sentenceRhythm: 'balanced',
    dialogueRatio: 40,
    emotionalTemperature: 5,
    imageryDensity: 3,
    vocabularyRegister: 'plain',
    hardRules: [],
    softRules: [],
    positiveExamples: [],
    negativeExamples: [],
    notes: '',
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as NovelWritingStyleProfile
}

describe('inferSceneType（P1-2 场景类型推断）', () => {
  it('对话关键词归入对话场', () => {
    expect(inferSceneType('主角与反派在审讯室对峙，逼问玉佩下落')).toBe('dialogue')
  })

  it('动作关键词归入动作场', () => {
    expect(inferSceneType('追杀在巷子里展开，主角突围')).toBe('action')
  })

  it('无关键词兜底为静场', () => {
    expect(inferSceneType('主角整理父亲遗物，发现一张旧船票')).toBe('quiet')
  })

  it('信息/关系/低压章不因单字或弱动作词误判为动作场', () => {
    // 实测误判：叙事任务里"不主动追逐连线"让信息章拿到动作场样本（95% 单句段）
    expect(inferSceneType('不沿线冲击，不主动追逐，不补力', 'information')).toBe('quiet')
    // Director 定位优先于文本关键词
    expect(inferSceneType('追杀在巷子里展开，主角突围', 'information')).toBe('quiet')
    expect(inferSceneType('他已无处可逃，只能硬拼', 'advancement')).toBe('quiet')
    // 高压/推进章保留动作判定
    expect(inferSceneType('追杀在巷子里展开，主角突围', 'high_pressure')).toBe('action')
    expect(inferSceneType('刀光落下，两人贴身搏斗', 'advancement')).toBe('action')
    // 对话判定不受定位压制
    expect(inferSceneType('审讯室对峙，逼问玉佩下落', 'information')).toBe('dialogue')
  })
})

describe('文风样本水印清洗（2026-09 实测修复）', () => {
  it('盗版站水印符号与域名式碎片在注入前被清掉', () => {
    const section = buildSceneSampleSection({
      positiveExamples: [
        `他低下头，看着掌心的旧照片。如.闻枉 冕￠废.越读 窗外的雨敲着屋檐。丸′ ! 鰰?占 耕?鑫′嶵筷, 他把照片收进口袋。齐盛.暁税·枉? 嶵新·漳结-哽新?哙· 门外的脚步声近了。￠x,i·nw,anb·en!.or·g? 他吹熄了灯。`,
      ],
      sceneType: 'quiet',
    })

    expect(section).not.toBe('')
    expect(section).not.toMatch(/[￠′·]/)
    expect(section).not.toContain('nw,anb')
    expect(section).not.toContain('?.')
    // 正文文字保留（水印字符清除不等于整句删除）
    expect(section).toContain('旧照片')
    expect(section).toContain('吹熄了灯')
  })

  it('半句结尾的样本退到最近句末，不再教模型"断句"', () => {
    const section = buildSceneSampleSection({
      positiveExamples: [
        `他把信折好放进抽屉，动作很慢。窗台上的猫翻了个身，继续晒太阳。一位杂役道出`,
      ],
      sceneType: 'quiet',
    })
    const body = section.split('【场景样本 1')[1] ?? ''
    const trimmedBody = body.replace(/^】?\n?/, '').trim()
    expect(trimmedBody).not.toContain('一位杂役道出')
    expect(trimmedBody.endsWith('。') || trimmedBody.endsWith('？') || trimmedBody.endsWith('！')).toBe(true)
  })
})

describe('buildSceneSampleSection（P1-2 分桶样本）', () => {
  const dialogueSample = `${'甲逼问他："你到底想怎样？"乙没有立刻回答。'.repeat(10)}他把手里的杯子放下了。`
  const actionSample = `${'刀光落下，他侧身避过还是被追兵砍中肩头。血很快浸透了衣料。'.repeat(8)}`

  it('优先选同桶样本并标注场景类型', () => {
    const section = buildSceneSampleSection({
      positiveExamples: [actionSample, dialogueSample],
      sceneType: 'dialogue',
    })

    expect(section).toContain('主导场景：对话场')
    expect(section).toContain('你到底想怎样')
    // 同桶（对话）样本排在其他桶（动作）之前
    const dialoguePos = section.indexOf('你到底想怎样')
    const actionPos = section.indexOf('刀光落下')
    expect(dialoguePos).toBeGreaterThan(-1)
    expect(actionPos).toBeGreaterThan(-1)
    expect(dialoguePos).toBeLessThan(actionPos)
  })

  it('自池摘段带章节来源标注，短摘段被过滤', () => {
    const section = buildSceneSampleSection({
      selfPoolExcerpts: [
        { chapterNumber: 5, score: 9, excerpt: actionSample },
        { chapterNumber: 6, score: null, excerpt: '太短' },
      ],
      sceneType: 'action',
    })

    expect(section).toContain('本书第 5 章结尾，审稿 9 分')
    expect(section).not.toContain('第 6 章')
  })

  it('无任何可用样本返回空串', () => {
    expect(buildSceneSampleSection({ sceneType: 'quiet' })).toBe('')
    expect(buildSceneSampleSection({ positiveExamples: ['   '], sceneType: 'quiet' })).toBe('')
  })
})

describe('P1-2 静态身份扩容', () => {
  it('静态正向样本只保留 1 条锚定样本，预算扩到 11999', async () => {
    const longSampleA = `他说。${'窗外的雨一直没停，屋檐下的水痕在青石上敲出细密的节奏。'.repeat(60)}`
    const profile = makeProfile({ positiveExamples: [longSampleA, longSampleA] })
    const compiled = compileWritingStylePrompt(profile, 'writer')

    // 只保留第一条锚定样本
    const sampleCount = compiled.content.split('【样本 ').length - 1
    expect(sampleCount).toBe(1)
    // 扩容后单样本可达 2400 字而不被整体预算裁掉
    expect(compiled.content).toContain(longSampleA.slice(100, 140))
    expect(compiled.content.length).toBeLessThan(12500)
  })
})
