import { describe, expect, it } from 'vitest'
import { markdownToRules, rulesToMarkdown } from '../writing-style-profile-editor'

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
})
