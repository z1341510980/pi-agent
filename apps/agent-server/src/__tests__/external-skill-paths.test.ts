/**
 * 第三方 Pi 包 Skills 接入试点（§9.3）：
 * - resolveExternalSkillPaths 解析已安装包（@llblab/pi-actors）的 skills/ 目录；
 * - 白名单通道（noSkills=true + additionalSkillPaths）可定向加载第三方 SKILL.md；
 * - skill_read（§9.2）以该 Skill 目录为授权根目录，可读取其 references/*.md，
 *   同时拒绝越界读取 —— 完整复现「第三方 Skill + 受限参考读取」的组合场景。
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent'
import {
  resolveExternalSkillPaths,
  skillRootOf,
} from '../core/plugin/external-skill-paths.js'
import { createSkillReadTool } from '../core/plugin/skill-read-tool.js'

const PI_ACTORS = '@llblab/pi-actors'

describe('resolveExternalSkillPaths', () => {
  it('解析已安装 Pi 包的 skills/ 目录（@llblab/pi-actors 六技能）', () => {
    const paths = resolveExternalSkillPaths(PI_ACTORS)
    expect(paths.length).toBeGreaterThanOrEqual(1)
    expect(paths.every(p => p.endsWith('SKILL.md'))).toBe(true)
    expect(paths.every(p => existsSync(p))).toBe(true)
    // 六技能确定性顺序（路径排序）
    const names = paths.map(p => p.split(/[\\/]/).slice(-2, -1)[0])
    expect(names).toContain('actors')
    expect(new Set(names).size).toBe(names.length)
  })

  it('未安装的包返回空数组', () => {
    expect(resolveExternalSkillPaths('@nonexistent/pi-package-xyz')).toEqual([])
  })
})

describe('第三方 Skill 白名单加载 + skill_read（@llblab/pi-actors 试点）', () => {
  it('noSkills=true + additionalSkillPaths 定向加载 actors Skill', async () => {
    const actorsPath = resolveExternalSkillPaths(PI_ACTORS)
      .find(p => p.includes(`${join('skills', 'actors')}`))
    expect(actorsPath).toBeDefined()

    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      noSkills: true,
      noExtensions: true,
      noPromptTemplates: true,
      noContextFiles: true,
      additionalSkillPaths: [actorsPath!],
    })
    await loader.reload()

    const skills = loader.getSkills().skills
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('actors')
    expect(skills[0].filePath).toBe(actorsPath)
  })

  it('skill_read 以 actors Skill 目录为根：可读 references，拒绝越界', async () => {
    const actorsPath = resolveExternalSkillPaths(PI_ACTORS)
      .find(p => p.includes(`${join('skills', 'actors')}`))!
    const root = skillRootOf(actorsPath)

    const tool = createSkillReadTool({ roots: [root] })
    const readOk = await tool.execute(
      'ext-1',
      { path: join(root, 'references', 'diagnostics.md') },
      undefined,
      undefined,
      {} as never,
    )
    const text = (readOk.content as Array<{ type?: string; text?: string }>)
      .filter(item => item.type === 'text')
      .map(item => item.text ?? '')
      .join('\n')
    expect(text.length).toBeGreaterThan(0)

    const escaped = await tool.execute(
      'ext-2',
      { path: join(root, '..', 'swarm', 'SKILL.md') },
      undefined,
      undefined,
      {} as never,
    )
    const escapedText = (escaped.content as Array<{ type?: string; text?: string }>)
      .filter(item => item.type === 'text')
      .map(item => item.text ?? '')
      .join('\n')
    expect(escapedText).toContain('不在授权')
  })
})
