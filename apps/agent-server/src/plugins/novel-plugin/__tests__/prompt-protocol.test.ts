import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SCENE_DRIVE_CAUSAL_CHAIN,
  DIRECTOR_NO_RHETORIC,
  WRITER_PREFLIGHT,
  WRITER_CONSEQUENCE_RULE,
  WRITER_NO_DIRECTOR_CONSENSUS,
  WRITER_METAPHOR_SENSORY,
  WRITER_NO_PROFESSIONAL_METAPHOR,
  WRITER_METAPHOR_FROM_SCENE,
  REVIEWER_CAUSAL_CHECK,
  REVIEWER_DIALOGUE_PATTERN,
  REVISER_SILENT_PROTECTION,
  REVISER_NO_NEW_METAPHOR,
  DISCUSSION_LINES_MUST_LAND,
  DISCUSSION_NO_ROBOTIC_SCRIPT,
  BASE_RULES_NO_FIRST_LINE_TEMPLATE,
  BASE_RULES_HUMAN_SAMPLE_PRIORITY,
  WRITER_STYLE_PRIORITY,
} from '../core/prompting/prompts-protocol-constants.js'

const promptsDir = join(process.cwd(), 'src/plugins/novel-plugin/core/prompts')

async function prompt(name: string): Promise<string> {
  return readFile(join(promptsDir, `${name}.md`), 'utf8')
}

describe('小说提示词协议', () => {
  it('Director 交付场景动力（5 元素因果链），而不是只有任务字段', async () => {
    const text = await prompt('role-director')
    expect(text).toContain(SCENE_DRIVE_CAUSAL_CHAIN)
    expect(text).toContain('场景入口')
    expect(text).toContain('不可逆后果')
    expect(text).toContain('如果删掉本章任意一个重要角色')
  })

  it('Writer 在生成前只确认场景的四件事和一条修辞红线，避免背长检查单', async () => {
    const text = await prompt('role-writer')
    expect(text).toContain(WRITER_PREFLIGHT)
    expect(text).toContain(SCENE_DRIVE_CAUSAL_CHAIN)
    expect(text).toContain('这个选择会让什么发生变化')
    expect(text).toContain('POV 此刻看见、听见、误解了什么')
    expect(text).toContain('现实阻力协议')
    expect(text).toContain('章末完成指定钩子后立即停笔')
  })

  it('Writer 的规则要求行为后果，不允许只写作者结论', async () => {
    const text = await prompt('role-writer')
    expect(text).toContain(WRITER_NO_DIRECTOR_CONSENSUS)
    expect(text).toContain(WRITER_CONSEQUENCE_RULE)
    expect(text).toContain('同一个判断不要在相邻段落里复述第二遍')
  })

  it('chapter-instruction 将写作协议注入实际 Writer 任务', async () => {
    const text = await prompt('chapter-instruction')
    expect(text).toContain('写作前在脑中完成场景动力推演')
    expect(text).toContain(SCENE_DRIVE_CAUSAL_CHAIN)
    expect(text).toContain('角色的缺点、长期欲望和信息边界必须影响行动')
  })

  it('Reviewer 使用与 Writer 相同的因果链验收', async () => {
    const text = await prompt('role-reviewer')
    expect(text).toContain(REVIEWER_CAUSAL_CHECK)
    expect(text).toContain(SCENE_DRIVE_CAUSAL_CHAIN)
    expect(text).toContain('遮住说话人')
    expect(text).toContain(REVIEWER_DIALOGUE_PATTERN)
  })

  it('Reviser 在修改前保护剧情事实、信息差和角色声音', async () => {
    const text = await prompt('role-reviser')
    expect(text).toContain(REVISER_SILENT_PROTECTION)
    expect(text).toContain('剧情事实、人物声音、信息差、节奏形态')
    expect(text).toContain('修改后的台词能否放回对应角色的声音坐标')
  })

  it('群聊 Writer 负有台词留存义务，机械感风格约束不构成豁免', async () => {
    const text = await prompt('role-writer-discussion')
    expect(text).toContain(SCENE_DRIVE_CAUSAL_CHAIN)
    // P1-1 义务反转：关键台词语义必须落地（正向硬约束）
    expect(text).toContain(DISCUSSION_LINES_MUST_LAND)
    expect(text).toContain('每个场景至少把该场推演中的两处台词或动作写入正文')
    // 风格约束保留，但明确"不是丢弃理由"
    expect(text).toContain(DISCUSSION_NO_ROBOTIC_SCRIPT)
    expect(text).toContain('不是丢弃台词的理由')
  })

  it('通用铁律是正文底线，不再强迫统一的第一句模板', async () => {
    const text = await prompt('system-base-rules')
    expect(text).toContain(BASE_RULES_NO_FIRST_LINE_TEMPLATE)
    expect(text).toContain(BASE_RULES_HUMAN_SAMPLE_PRIORITY)
    expect(text).not.toContain('违反任意一条视为创作失败')
  })

  it('Writer 明确人工样本优先于通用反 AI 规则', async () => {
    const text = await prompt('role-writer')
    expect(text).toContain(WRITER_STYLE_PRIORITY)
    expect(text).toContain('场景自然、人物成立时，优先保留自然节奏')
  })

  it('比喻约束：Writer/Reviser 禁职业比喻系统，Director 契约不指定修辞', async () => {
    const writer = await prompt('role-writer')
    expect(writer).toContain(WRITER_METAPHOR_SENSORY)
    expect(writer).toContain(WRITER_NO_PROFESSIONAL_METAPHOR)
    expect(writer).toContain(WRITER_METAPHOR_FROM_SCENE)

    const reviser = await prompt('role-reviser')
    expect(reviser).toContain(REVISER_NO_NEW_METAPHOR)

    const director = await prompt('role-director')
    expect(director).toContain(DIRECTOR_NO_RHETORIC)
  })
})
