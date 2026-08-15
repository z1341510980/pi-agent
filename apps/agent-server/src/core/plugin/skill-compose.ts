/**
 * 多 Skill 确定性组合编译器（方案 §9.1）
 *
 * 背景：
 * - Pi 原生一次只展开一个 `/skill:<name>`，单 Skill 路径继续用它（已验证）。
 * - 当一个 Agent 需要「群聊角色 + 工种方法」等多 Skill 组合时，编排层对每个授权
 *   SKILL.md 做确定性编译：剥离 frontmatter，按给定顺序把正文包进
 *   `<skill name="...">` 块，拼接后前置到任务消息。
 *
 * 确定性要求：
 * - 顺序即调用方传入顺序（主 Skill 在前），不做排序；
 * - frontmatter 一律剥离，只发正文，与 PromptManager.stripPromptFrontmatter 口径一致；
 * - 内容在每次 prompt() 时由文件重新读取（默认模板是静态文件，内容稳定，等价于缓存）。
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

export interface ComposedSkill {
  name: string
  path: string
}

const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---\r?\n/

/** 剥离 SKILL.md 的 YAML frontmatter，返回纯正文。 */
export function stripSkillFrontmatter(content: string): string {
  const stripped = FRONTMATTER_PATTERN.test(content)
    ? content.replace(FRONTMATTER_PATTERN, '')
    : content
  return stripped.trim()
}

/**
 * 把多个 Skill 正文编译为确定性 `<skill>` 块序列。
 *
 * @param skills 按「主 Skill → 附加 Skill」顺序排列；块顺序即此顺序
 * @param readFile 文件读取函数（默认 fs.readFileSync；测试可注入）
 */
export function composeSkillBlocks(
  skills: ComposedSkill[],
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf-8'),
): string {
  return skills
    .map((skill) => {
      const body = stripSkillFrontmatter(readFile(skill.path))
      return `<skill name="${skill.name}">\n${body}\n</skill>`
    })
    .join('\n\n')
}

/** Skill 正文内容指纹（SHA-256 前 16 位）：用于审计日志与规则漂移检测。 */
export function fingerprintSkillContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}
