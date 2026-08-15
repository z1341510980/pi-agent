/**
 * 多 Skill 组合编译器（§9.1）与受限 skill_read 工具（§9.2）单元测试。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { buildPluginSessionPrompt } from '../core/plugin/plugin-manager.js'
import {
  composeSkillBlocks,
  fingerprintSkillContent,
  stripSkillFrontmatter,
} from '../core/plugin/skill-compose.js'
import {
  createSkillReadTool,
  resolveSkillReadPath,
  type SkillReadToolOptions,
} from '../core/plugin/skill-read-tool.js'

/** 从 AgentToolResult 提取全部文本内容（TextContent 联合 ImageContent 需收窄）。 */
function textOf(result: { content?: unknown }): string {
  const items = (result.content as Array<{ type?: string; text?: string }> | undefined) ?? []
  return items.filter(item => item.type === 'text').map(item => item.text ?? '').join('\n')
}

const fakeCtx = {} as ExtensionContext

describe('skill-compose：多 Skill 确定性组合编译器', () => {
  const files = new Map<string, string>()
  const readFile = (path: string): string => {
    const content = files.get(resolve(path))
    if (content === undefined) throw new Error(`文件不存在: ${path}`)
    return content
  }

  it('剥离 frontmatter 只保留正文', () => {
    const content = '---\nname: novel-director\ndisable-model-invocation: true\n---\n\n判断章节任务和剧情阶段。\n'
    expect(stripSkillFrontmatter(content)).toBe('判断章节任务和剧情阶段。')
    expect(stripSkillFrontmatter('无 frontmatter 的正文\n')).toBe('无 frontmatter 的正文')
  })

  it('按给定顺序编译 <skill> 块，frontmatter 不进入输出', () => {
    files.set(resolve('/skills/role.md'), '---\nname: novel-director\n---\n\n导演正文。\n')
    files.set(resolve('/skills/discussion.md'), '---\nname: novel-director-discussion\n---\n\n群聊职责正文。\n')

    const composed = composeSkillBlocks(
      [
        { name: 'novel-director', path: '/skills/role.md' },
        { name: 'novel-director-discussion', path: '/skills/discussion.md' },
      ],
      readFile,
    )

    expect(composed).toBe(
      '<skill name="novel-director">\n导演正文。\n</skill>\n\n' +
      '<skill name="novel-director-discussion">\n群聊职责正文。\n</skill>',
    )
    expect(composed).not.toContain('disable-model-invocation')
    // 顺序确定性：主 Skill 在前
    expect(composed.indexOf('novel-director">')).toBeLessThan(composed.indexOf('novel-director-discussion">'))
  })

  it('buildPluginSessionPrompt：单 Skill 走原生 /skill:，多 Skill 走组合编译，无 Skill 原样返回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-compose-prompt-'))
    try {
      const rolePath = join(dir, 'role.md')
      const discussionPath = join(dir, 'discussion.md')
      writeFileSync(rolePath, '---\nname: novel-director\n---\n\n导演正文。\n')
      writeFileSync(discussionPath, '---\nname: novel-director-discussion\n---\n\n群聊职责正文。\n')

      const single = buildPluginSessionPrompt('请规划第 3 章', { name: 'novel-director', path: rolePath })
      expect(single).toBe('/skill:novel-director 请规划第 3 章')

      const multi = buildPluginSessionPrompt(
        '请规划第 3 章',
        { name: 'novel-director', path: rolePath },
        [{ name: 'novel-director-discussion', path: discussionPath }],
      )
      expect(multi).toContain('<skill name="novel-director">\n导演正文。\n</skill>')
      expect(multi).toContain('<skill name="novel-director-discussion">\n群聊职责正文。\n</skill>')
      expect(multi).toContain('\n\n请规划第 3 章')
      expect(multi).not.toContain('/skill:')

      expect(buildPluginSessionPrompt('普通任务')).toBe('普通任务')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('内容指纹：稳定且对内容变化敏感', () => {
    expect(fingerprintSkillContent('正文A')).toHaveLength(16)
    expect(fingerprintSkillContent('正文A')).toBe(fingerprintSkillContent('正文A'))
    expect(fingerprintSkillContent('正文A')).not.toBe(fingerprintSkillContent('正文B'))
  })
})

describe('skill-read：受限读取工具', () => {
  let rootDir: string
  let outsideDir: string
  let options: SkillReadToolOptions

  beforeAll(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'skill-read-root-'))
    outsideDir = mkdtempSync(join(tmpdir(), 'skill-read-outside-'))
    mkdirSync(join(rootDir, 'references'), { recursive: true })
    writeFileSync(join(rootDir, 'references', 'rubric.md'), '# 评分细则\n正文内容')
    writeFileSync(join(rootDir, 'SKILL.md'), '---\nname: demo\n---\n正文')
    writeFileSync(join(rootDir, 'big.txt'), 'x'.repeat(100))
    writeFileSync(join(outsideDir, 'secret.md'), '机密内容')
    options = { roots: [rootDir] }
  })

  afterAll(() => {
    rmSync(rootDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })

  it('路径解析：授权目录内 ok；穿越与目录外拒绝', () => {
    expect(resolveSkillReadPath(join(rootDir, 'references/rubric.md'), options).ok).toBe(true)
    // 相对路径按 cwd 解析：写授权目录的相对路径需调用方自行拼接，工具只认 resolve 后的绝对路径
    expect(resolveSkillReadPath(join(rootDir, 'SKILL.md'), options).ok).toBe(true)

    const traversal = resolveSkillReadPath(join(rootDir, '..', 'secret.md'), options)
    expect(traversal.ok).toBe(false)
    expect(traversal.error).toContain('不在授权')

    const outside = resolveSkillReadPath(join(outsideDir, 'secret.md'), options)
    expect(outside.ok).toBe(false)

    expect(resolveSkillReadPath('', options).ok).toBe(false)
  })

  it('execute：读取授权文件成功，扩展名/大小/越界被拒', async () => {
    const tool = createSkillReadTool(options)

    const okResult = await tool.execute('id-1', { path: join(rootDir, 'references/rubric.md') }, undefined, undefined, fakeCtx)
    expect(textOf(okResult)).toContain('# 评分细则')

    // 小上限触发大小校验
    const smallTool = createSkillReadTool({ roots: [rootDir], maxBytes: 50 })
    const tooBig = await smallTool.execute('id-3', { path: join(rootDir, 'big.txt') }, undefined, undefined, fakeCtx)
    expect(textOf(tooBig)).toContain('超过上限')

    const outside = await tool.execute('id-4', { path: join(outsideDir, 'secret.md') }, undefined, undefined, fakeCtx)
    expect(textOf(outside)).toContain('skill_read 拒绝')

    const missing = await tool.execute('id-5', { path: join(rootDir, 'nope.md') }, undefined, undefined, fakeCtx)
    expect(textOf(missing)).toContain('ENOENT')
  })

  it('扩展名白名单可配置', async () => {
    const tool = createSkillReadTool({ roots: [rootDir], extensions: ['.md'] })
    const result = await tool.execute('id-6', { path: join(rootDir, 'big.txt') }, undefined, undefined, fakeCtx)
    expect(textOf(result)).toContain('不在白名单内')
  })
})
