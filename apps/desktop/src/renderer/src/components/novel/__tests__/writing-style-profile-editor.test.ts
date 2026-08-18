import { describe, expect, it } from 'vitest'
import { markdownToRules, rulesToMarkdown, withoutStyleExperts } from '../writing-style-profile-editor'

describe('writing style Markdown rules', () => {
  it('serializes rules as a Markdown list', () => {
    expect(rulesToMarkdown(['保持 POV 边界', '避免总结式收尾'])).toBe(
      '- 保持 POV 边界\n- 避免总结式收尾'
    )
  })

  it('accepts bullets, checkboxes, numbered items, and headings', () => {
    expect(
      markdownToRules(
        [
          '## 核心规则',
          '- 保持 POV 边界',
          '* [x] 避免总结式收尾',
          '1. 用动作展示情绪',
          '',
          '补充规则'
        ].join('\n')
      )
    ).toEqual(['核心规则', '保持 POV 边界', '避免总结式收尾', '用动作展示情绪', '补充规则'])
  })

  it('does not send a stale expert snapshot when saving the baseline', () => {
    const baseline = withoutStyleExperts({
      name: '基线', preset: 'custom', narrativePerson: 'third', narrativeDistance: 'limited',
      sentenceRhythm: 'balanced', dialogueRatio: 45, emotionalTemperature: 5, imageryDensity: 3,
      vocabularyRegister: 'plain', hardRules: [], softRules: [], positiveExamples: [], negativeExamples: [], notes: '',
      styleExperts: [{
        id: 'e1', projectId: 'p', name: '旧副本', sourceTitle: '样本', description: '旧描述',
        distilledPrompt: '旧提示词', enabled: true, sortOrder: 0, version: 1, createdAt: 0, updatedAt: 0,
      }],
    })

    expect(baseline).not.toHaveProperty('styleExperts')
  })
})
