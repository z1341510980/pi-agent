import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const promptDir = fileURLToPath(new URL('../core/prompts/', import.meta.url))

function readPrompt(name: string): string {
  return readFileSync(`${promptDir}${name}.md`, 'utf8')
}

describe('小说 Agent 身份预算与契约', () => {
  it('普通 create-flow 三个核心身份保持在精简预算内', () => {
    const director = readPrompt('role-director')
    const writer = readPrompt('role-writer')
    const reviewer = readPrompt('role-reviewer')

    // 工具化方案后，Director/Reviewer 提示词需包含工具调用说明、字段说明和禁止事项，
    // 预算上限相应放宽。8 月 4-6 日去 AI 味优化后 Writer 增加写前四问/红线/声音对照，
    // 预算同步上调；scene-wise-writing T1 为 Director 新增结构化 scenes[] 契约
    //（主次笔墨/逐场预算分配/校验规则），Director 上限 8000→9000（已同步去重压缩）。
    expect(director.length).toBeLessThan(9000)
    expect(writer.length).toBeLessThan(5500)
    expect(reviewer.length).toBeLessThan(4500)
    expect(director.length + writer.length + reviewer.length).toBeLessThan(18000)
  })

  it('Director 保留工具化方案所需的全部结构化字段', () => {
    const prompt = readPrompt('role-director')
    // 工具化方案：Director 必须调用 novel_submit_narrative_task 工具提交结构化对象
    expect(prompt).toContain('novel_submit_narrative_task')
    // 工具参数 schema 中的关键字段
    const requiredFields = [
      'taskType', 'priority', 'narrativeTask', 'secondaryTasks',
      'chapterEndingHook', 'povCharacters', 'sceneCount', 'positioning',
      'timelineOffset', 'suspenseDuration', 'intensityDelta',
    ]
    for (const field of requiredFields) expect(prompt).toContain(field)

    // 14 种任务类型枚举
    expect(prompt).toContain('advance_mainline')
    expect(prompt).toContain('planting/sustaining/releasing')
    expect(prompt).toContain('emotional/fate/character/combat/theme/composite')
    // 6 种章节定位
    expect(prompt).toContain('high_pressure')
    expect(prompt).toContain('advancement')
    expect(prompt).toContain('cultivation')
    expect(prompt).toContain('relationship')
    expect(prompt).toContain('low_pressure')
    expect(prompt).toContain('information')
    // 禁止输出 Markdown 任务文档（工具化核心约束）
    expect(prompt).toContain('禁止输出 Markdown 格式的任务文档')
  })

  it('Writer 保留正文边界、矩阵、连续性和推回契约', () => {
    const prompt = readPrompt('role-writer')

    expect(prompt).toContain('只输出完整章节正文')
    expect(prompt).toContain('[DIRECTOR_PUSHBACK]')
    expect(prompt).toContain('矩阵中的角色、冲突、伏笔、线索、势力和地点')
    expect(prompt).toContain('承接上一章结尾')
    expect(prompt).toContain('下一章锚点')
    expect(prompt).toContain('信息差')
    expect(prompt).toContain('不使用长横线破折号')
  })

  it('Reviewer 保留矩阵验收、Findings 和工具化结论', () => {
    const prompt = readPrompt('role-reviewer')
    // 工具化方案：Reviewer 必须调用 novel_submit_review 工具提交结构化验收对象
    expect(prompt).toContain('novel_submit_review')
    // 矩阵与任务兑现审查项
    expect(prompt).toContain('矩阵与任务兑现')
    expect(prompt).toContain('角色功能位')
    expect(prompt).toContain('【防 AI 腔扫描】')
    // 分类枚举（issues[].category）
    expect(prompt).toContain('`ai_tone`')
    expect(prompt).toContain('`continuity`')
    expect(prompt).toContain('`model_degradation`')
    // 工具 schema 中的关键字段
    expect(prompt).toContain('verdict')
    expect(prompt).toContain('issues')
    expect(prompt).toContain('suggestions')
    expect(prompt).toContain('overallScore')
    // 严重度与 verdict 对应规则
    expect(prompt).toContain('存在 S1 必须 `reject`')
    expect(prompt).toContain('存在未解决 S2 必须 `revise`')
    // 禁止输出 Markdown 评分表（工具化核心约束）
    expect(prompt).toContain('禁止输出 Markdown 格式的评分表')
  })
})
