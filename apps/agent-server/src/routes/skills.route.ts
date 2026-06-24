import type { FastifyPluginAsync } from 'fastify'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { success } from '../lib/api-response.js'

/** 技能信息 */
interface SkillInfo {
  /** 技能名称（目录名） */
  name: string
  /** 技能描述 */
  description: string
  /** SKILL.md 文件路径 */
  path: string
}

/** 从 SKILL.md 内容中提取 name 和 description */
function parseSkillMd(content: string): { name: string; description: string } {
  let name = ''
  let description = ''

  // 1. 优先从 YAML front matter 提取（--- 包裹）
  const frontMatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (frontMatterMatch) {
    const fm = frontMatterMatch[1]
    const nameMatch = fm.match(/^name:\s*(.+)/m)
    if (nameMatch) name = nameMatch[1].trim()
    const descMatch = fm.match(/^description:\s*(.+)/m)
    if (descMatch) description = descMatch[1].trim()
  }

  // 2. 兜底：从 Markdown 正文提取
  if (!name) {
    const titleMatch = content.match(/^#\s+(.+)/m)
    if (titleMatch) name = titleMatch[1].trim()
  }

  if (!description) {
    // 取第一个非空、非标题、非 front matter 的行
    const afterFm = content.replace(/^---[\s\S]*?---/, '')
    const lines = afterFm.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('**') && !l.startsWith('```'))
    if (lines.length > 0) {
      description = lines[0].trim().slice(0, 200)
    }
  }

  return { name, description }
}

export const skillsRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/skills
   * 扫描本机已安装的技能列表
   */
  app.get('/api/skills', async (request) => {
    // 技能目录：~/.trae-cn/skills/
    const skillsDir = join(homedir(), '.trae-cn', 'skills')

    if (!existsSync(skillsDir)) {
      return success([], request.traceId)
    }

    const skills: SkillInfo[] = []

    try {
      const entries = await readdir(skillsDir, { withFileTypes: true })

      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        const skillMdPath = join(skillsDir, entry.name, 'SKILL.md')
        if (!existsSync(skillMdPath)) continue

        try {
          const content = await readFile(skillMdPath, 'utf-8')
          const { name, description } = parseSkillMd(content)

          skills.push({
            name: name || entry.name,
            description: description || '无描述',
            path: skillMdPath,
          })
        } catch {
          // 跳过读取失败的技能
        }
      }
    } catch {
      // 目录读取失败
    }

    // 按名称排序
    skills.sort((a, b) => a.name.localeCompare(b.name))

    return success(skills, request.traceId)
  })
}
