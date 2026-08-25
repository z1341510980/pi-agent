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

describe('提示词协议常量与提示词文件一致性守卫（P1-5-2 防再漂移）', () => {
  it('场景动力因果链为 5 元素协议，出现在全部相关角色提示词', async () => {
    const director = await prompt('role-director')
    const writer = await prompt('role-writer')
    const reviewer = await prompt('role-reviewer')
    const instruction = await prompt('chapter-instruction')
    const discussion = await prompt('role-writer-discussion')
    for (const text of [director, writer, reviewer, instruction, discussion]) {
      expect(text).toContain(SCENE_DRIVE_CAUSAL_CHAIN)
    }
    // 协议意图优先：5 元素链是产品既定协议，不退化回 4 元素
    expect(SCENE_DRIVE_CAUSAL_CHAIN).toBe('欲望 → 具体阻力 → 选择 → 后果 → 新问题')
  })

  it('Writer 写前确认项：四件事 + 一条修辞红线', async () => {
    const writer = await prompt('role-writer')
    expect(writer).toContain(WRITER_PREFLIGHT)
  })

  it('Director 契约不指定修辞', async () => {
    const director = await prompt('role-director')
    expect(director).toContain(DIRECTOR_NO_RHETORIC)
  })

  it('Writer 行为后果铁律 / 禁止角色共识', async () => {
    const writer = await prompt('role-writer')
    expect(writer).toContain(WRITER_CONSEQUENCE_RULE)
    expect(writer).toContain(WRITER_NO_DIRECTOR_CONSENSUS)
  })

  it('比喻约束：Writer 三件套 + Reviser 不新增比喻', async () => {
    const writer = await prompt('role-writer')
    expect(writer).toContain(WRITER_METAPHOR_SENSORY)
    expect(writer).toContain(WRITER_NO_PROFESSIONAL_METAPHOR)
    expect(writer).toContain(WRITER_METAPHOR_FROM_SCENE)
    const reviser = await prompt('role-reviser')
    expect(reviser).toContain(REVISER_NO_NEW_METAPHOR)
  })

  it('Reviewer 因果链 / 对话形态检查', async () => {
    const reviewer = await prompt('role-reviewer')
    expect(reviewer).toContain(REVIEWER_CAUSAL_CHECK)
    expect(reviewer).toContain(REVIEWER_DIALOGUE_PATTERN)
  })

  it('Reviser 修订前保护检查', async () => {
    const reviser = await prompt('role-reviser')
    expect(reviser).toContain(REVISER_SILENT_PROTECTION)
  })

  it('群聊 Writer：台词留存义务 + 非机械整理风格约束', async () => {
    const discussion = await prompt('role-writer-discussion')
    expect(discussion).toContain(DISCUSSION_LINES_MUST_LAND)
    expect(discussion).toContain(DISCUSSION_NO_ROBOTIC_SCRIPT)
  })

  it('通用铁律：第一句不强制动作开头 + 人工样本优先', async () => {
    const rules = await prompt('system-base-rules')
    expect(rules).toContain(BASE_RULES_NO_FIRST_LINE_TEMPLATE)
    expect(rules).toContain(BASE_RULES_HUMAN_SAMPLE_PRIORITY)
  })

  it('Writer 文风优先级引用人工样本', async () => {
    const writer = await prompt('role-writer')
    expect(writer).toContain(WRITER_STYLE_PRIORITY)
  })
})
