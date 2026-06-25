import { describe, expect, it } from 'vitest'
import { RhythmController } from '../plugins/novel-plugin/core/rhythm-controller.js'
import type { ChapterRhythm, RhythmHistoryEntry, RhythmModel } from '../plugins/novel-plugin/core/types.js'

describe('RhythmController - 静态模型', () => {
  it('DEFAULT_MODEL 包含 14 个节奏点', () => {
    expect(RhythmController.DEFAULT_MODEL.sequence).toHaveLength(14)
  })

  it('DEFAULT_MODEL 第 6 章为小高潮 climax', () => {
    expect(RhythmController.DEFAULT_MODEL.sequence[5]).toBe('climax')
  })

  it('DEFAULT_MODEL 第 12 章为大高潮 climax', () => {
    expect(RhythmController.DEFAULT_MODEL.sequence[11]).toBe('climax')
  })

  it('WEBNOVEL_MODEL 第 3 章为 climax', () => {
    expect(RhythmController.WEBNOVEL_MODEL.sequence[2]).toBe('climax')
  })

  it('WEBNOVEL_MODEL 第 8 章为 twist 转折', () => {
    expect(RhythmController.WEBNOVEL_MODEL.sequence[7]).toBe('twist')
  })

  it('MODELS 包含两个模型', () => {
    expect(RhythmController.MODELS).toHaveLength(2)
    const ids = RhythmController.MODELS.map((m) => m.id)
    expect(ids).toContain('standard-three-act')
    expect(ids).toContain('webnovel-fast')
  })
})

describe('RhythmController - suggestRhythm 基础行为', () => {
  it('第 1 章使用默认模型返回 setup', () => {
    const controller = new RhythmController()
    const suggestion = controller.suggestRhythm(1, 'setup', [])
    expect(suggestion.rhythm).toBe('setup')
    expect(suggestion.arcPosition).toBeCloseTo(1 / 14, 5)
    expect(suggestion.description).toBeTruthy()
    expect(suggestion.reason).toBeTruthy()
  })

  it('第 6 章使用默认模型返回 climax', () => {
    const controller = new RhythmController()
    const suggestion = controller.suggestRhythm(6, 'rising', [])
    expect(suggestion.rhythm).toBe('climax')
  })

  it('第 14 章使用默认模型返回 resolution', () => {
    const controller = new RhythmController()
    const suggestion = controller.suggestRhythm(14, 'resolution', [])
    expect(suggestion.rhythm).toBe('resolution')
  })

  it('章节超过序列长度时按取模循环', () => {
    const controller = new RhythmController()
    // 第 15 章 = (15-1) % 14 = 0 → setup
    const suggestion = controller.suggestRhythm(15, 'setup', [])
    expect(suggestion.rhythm).toBe('setup')
  })

  it('返回的 description 非空字符串', () => {
    const controller = new RhythmController()
    const suggestion = controller.suggestRhythm(1, 'setup', [])
    expect(typeof suggestion.description).toBe('string')
    expect(suggestion.description.length).toBeGreaterThan(0)
  })
})

describe('RhythmController - 连续高潮检测', () => {
  it('连续 2 个 climax 后强制 breather', () => {
    const controller = new RhythmController()
    const history: RhythmHistoryEntry[] = [
      { chapterNumber: 4, rhythm: 'climax', effectiveness: 'high' },
      { chapterNumber: 5, rhythm: 'climax', effectiveness: 'high' },
    ]
    // 第 6 章原本应为 climax，但因连续高潮被改为 breather
    const suggestion = controller.suggestRhythm(6, 'rising', history)
    expect(suggestion.rhythm).toBe('breather')
  })

  it('连续 2 个 twist 后强制 breather', () => {
    const controller = new RhythmController()
    const history: RhythmHistoryEntry[] = [
      { chapterNumber: 4, rhythm: 'twist', effectiveness: 'medium' },
      { chapterNumber: 5, rhythm: 'twist', effectiveness: 'medium' },
    ]
    const suggestion = controller.suggestRhythm(6, 'rising', history)
    expect(suggestion.rhythm).toBe('breather')
  })

  it('climax + twist 混合 2 个也触发 breather', () => {
    const controller = new RhythmController()
    const history: RhythmHistoryEntry[] = [
      { chapterNumber: 4, rhythm: 'climax', effectiveness: 'medium' },
      { chapterNumber: 5, rhythm: 'twist', effectiveness: 'medium' },
    ]
    const suggestion = controller.suggestRhythm(6, 'rising', history)
    expect(suggestion.rhythm).toBe('breather')
  })

  it('只有 1 个 climax 不触发 breather', () => {
    const controller = new RhythmController()
    const history: RhythmHistoryEntry[] = [
      { chapterNumber: 5, rhythm: 'climax', effectiveness: 'high' },
      { chapterNumber: 4, rhythm: 'rising', effectiveness: 'medium' },
    ]
    // 第 6 章本应为 climax，未触发连续高潮规则
    const suggestion = controller.suggestRhythm(6, 'rising', history)
    expect(suggestion.rhythm).toBe('climax')
  })

  it('连续 2 个 climax 后若模型原本就是 breather 保持 breather', () => {
    const controller = new RhythmController()
    // 默认模型第 4 章为 breather（index 3）
    const history: RhythmHistoryEntry[] = [
      { chapterNumber: 2, rhythm: 'climax', effectiveness: 'high' },
      { chapterNumber: 3, rhythm: 'climax', effectiveness: 'high' },
    ]
    const suggestion = controller.suggestRhythm(4, 'rising', history)
    expect(suggestion.rhythm).toBe('breather')
  })

  it('原因描述包含"连续高潮"提示', () => {
    const controller = new RhythmController()
    const history: RhythmHistoryEntry[] = [
      { chapterNumber: 4, rhythm: 'climax', effectiveness: 'high' },
      { chapterNumber: 5, rhythm: 'climax', effectiveness: 'high' },
    ]
    const suggestion = controller.suggestRhythm(6, 'rising', history)
    expect(suggestion.reason).toContain('连续')
    expect(suggestion.reason).toContain('高潮')
  })
})

describe('RhythmController - 弧位置计算', () => {
  it('第 1 章弧位置接近 0', () => {
    const controller = new RhythmController()
    const suggestion = controller.suggestRhythm(1, 'setup', [])
    expect(suggestion.arcPosition).toBeCloseTo(1 / 14, 5)
    expect(suggestion.arcPosition).toBeLessThan(0.2)
  })

  it('第 14 章弧位置为 1', () => {
    const controller = new RhythmController()
    const suggestion = controller.suggestRhythm(14, 'resolution', [])
    expect(suggestion.arcPosition).toBe(1)
  })

  it('超过序列长度的章节弧位置为 1（min 截断）', () => {
    const controller = new RhythmController()
    const suggestion = controller.suggestRhythm(100, 'resolution', [])
    expect(suggestion.arcPosition).toBe(1)
  })

  it('中间章节弧位置在 0-1 之间', () => {
    const controller = new RhythmController()
    const suggestion = controller.suggestRhythm(7, 'rising', [])
    expect(suggestion.arcPosition).toBeGreaterThan(0)
    expect(suggestion.arcPosition).toBeLessThan(1)
  })
})

describe('RhythmController - 默认模型 vs 网文模型', () => {
  it('第 2 章默认模型为 setup，网文模型为 rising', () => {
    const controller = new RhythmController()
    const defaultSuggestion = controller.suggestRhythm(2, 'setup', [], RhythmController.DEFAULT_MODEL)
    const webnovelSuggestion = controller.suggestRhythm(2, 'setup', [], RhythmController.WEBNOVEL_MODEL)
    expect(defaultSuggestion.rhythm).toBe('setup')
    expect(webnovelSuggestion.rhythm).toBe('rising')
  })

  it('第 3 章默认模型为 rising，网文模型为 climax', () => {
    const controller = new RhythmController()
    const defaultSuggestion = controller.suggestRhythm(3, 'rising', [], RhythmController.DEFAULT_MODEL)
    const webnovelSuggestion = controller.suggestRhythm(3, 'rising', [], RhythmController.WEBNOVEL_MODEL)
    expect(defaultSuggestion.rhythm).toBe('rising')
    expect(webnovelSuggestion.rhythm).toBe('climax')
  })

  it('使用自定义模型返回模型对应的节奏', () => {
    const controller = new RhythmController()
    const customModel: RhythmModel = {
      id: 'custom-test',
      name: '自定义',
      description: '测试模型',
      sequence: ['setup', 'climax', 'resolution'] as ChapterRhythm[],
    }
    const s1 = controller.suggestRhythm(1, 'setup', [], customModel)
    const s2 = controller.suggestRhythm(2, 'rising', [], customModel)
    const s3 = controller.suggestRhythm(3, 'resolution', [], customModel)
    expect(s1.rhythm).toBe('setup')
    expect(s2.rhythm).toBe('climax')
    expect(s3.rhythm).toBe('resolution')
  })

  it('弧位置根据模型长度计算', () => {
    const controller = new RhythmController()
    const customModel: RhythmModel = {
      id: 'custom-test',
      name: '自定义',
      description: '测试模型',
      sequence: ['setup', 'climax'] as ChapterRhythm[],
    }
    // 第 1 章 / 2 长度 = 0.5
    const suggestion = controller.suggestRhythm(1, 'setup', [], customModel)
    expect(suggestion.arcPosition).toBe(0.5)
  })
})

describe('RhythmController - 原因描述生成', () => {
  it('开篇阶段（arcPosition < 0.2）原因包含"开篇"', () => {
    const controller = new RhythmController()
    const suggestion = controller.suggestRhythm(1, 'setup', [])
    expect(suggestion.reason).toContain('开篇')
  })

  it('结尾阶段（arcPosition > 0.8）原因包含"尾声"', () => {
    const controller = new RhythmController()
    const suggestion = controller.suggestRhythm(13, 'falling', [])
    // 13 / 14 ≈ 0.928 > 0.8
    expect(suggestion.reason).toContain('尾声')
  })

  it('中间阶段原因包含阶段名', () => {
    const controller = new RhythmController()
    // 第 4 章 / 14 ≈ 0.286，处于中间阶段
    const suggestion = controller.suggestRhythm(4, 'rising', [])
    expect(suggestion.reason).toContain('rising')
  })

  it('连续高潮 breather 原因优先于其他规则', () => {
    const controller = new RhythmController()
    const history: RhythmHistoryEntry[] = [
      { chapterNumber: 1, rhythm: 'climax', effectiveness: 'high' },
      { chapterNumber: 2, rhythm: 'climax', effectiveness: 'high' },
    ]
    // 第 1 章本应触发"开篇"原因，但因连续高潮，应触发"连续高潮"原因
    const suggestion = controller.suggestRhythm(3, 'rising', history, {
      id: 'custom',
      name: 'c',
      description: '',
      sequence: ['climax', 'climax', 'setup'] as ChapterRhythm[],
    })
    expect(suggestion.reason).toContain('连续')
    // 不应同时包含"开篇"（互斥分支）
    expect(suggestion.reason).not.toContain('开篇')
  })
})
