import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const promptDir = fileURLToPath(new URL('../plugins/novel-plugin/core/prompts/', import.meta.url))

function readPrompt(name: string): string {
  return readFileSync(`${promptDir}${name}.md`, 'utf8')
}

describe('小说 Agent 身份预算与契约', () => {
  it('普通 create-flow 三个核心身份保持在精简预算内', () => {
    const director = readPrompt('role-director')
    const writer = readPrompt('role-writer')
    const reviewer = readPrompt('role-reviewer')

    expect(director.length).toBeLessThan(3500)
    expect(writer.length).toBeLessThan(2500)
    expect(reviewer.length).toBeLessThan(3500)
    expect(director.length + writer.length + reviewer.length).toBeLessThan(9000)
  })

  it('Director 保留解析器依赖的全部结构化字段', () => {
    const prompt = readPrompt('role-director')
    const requiredHeadings = [
      '## 本章核心叙事目标', '## 任务类型', '## 次要任务',
      '## 上一章钩子处理', '## 出场角色', '## 冲突推进计划',
      '## 情绪曲线', '## 伏笔处理计划', '## 悬念设计',
      '## 预期节奏和氛围', '## 字数预算', '## 创作要点',
      '## 章尾钩子设计', '## POV', '## 场景数与节奏速率',
      '## 时间线偏移', '## 验收标准',
    ]
    for (const heading of requiredHeadings) expect(prompt).toContain(heading)

    expect(prompt).toContain('high_pressure')
    expect(prompt).toContain('advance_mainline')
    expect(prompt).toContain('planting/sustaining/releasing')
    expect(prompt).toContain('emotional/fate/character/combat/theme/composite')
  })

  it('Writer 保留正文边界、矩阵、连续性和推回契约', () => {
    const prompt = readPrompt('role-writer')

    expect(prompt).toContain('只输出完整章节正文')
    expect(prompt).toContain('[DIRECTOR_PUSHBACK]')
    expect(prompt).toContain('矩阵中的角色、冲突、伏笔、势力和地点')
    expect(prompt).toContain('承接上一章结尾')
    expect(prompt).toContain('下一章锚点')
    expect(prompt).toContain('信息差')
    expect(prompt).toContain('不使用长横线破折号')
  })

  it('Reviewer 保留矩阵验收、Findings 和机器可解析结论', () => {
    const prompt = readPrompt('role-reviewer')

    expect(prompt).toContain('矩阵与任务兑现')
    expect(prompt).toContain('角色功能位')
    expect(prompt).toContain('【防 AI 腔扫描】')
    expect(prompt).toContain('`ai_tone`')
    expect(prompt).toContain('## Findings 汇总')
    expect(prompt).toContain('## 结论：accept / revise / reject')
    expect(prompt).toContain('存在 S1 必须 reject')
    expect(prompt).toContain('存在未解决 S2 必须 revise')
  })
})
