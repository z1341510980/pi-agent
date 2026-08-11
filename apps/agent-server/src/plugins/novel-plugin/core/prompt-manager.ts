/**
 * PromptManager：可配置的提示词模板管理器
 *
 * 设计目标：
 * 1. 提示词不写死在代码中，通过文件 + SQLite 双层配置
 * 2. 支持三级覆盖：默认文件 → 项目级文件 → SQLite 运行时覆盖
 * 3. 模板支持 {{variable}} 占位符替换
 * 4. 内存缓存，避免重复 IO
 *
 * 模板文件位置：
 * - 默认模板：apps/agent-server/src/plugins/novel-plugin/core/prompts/*.md
 * - 项目覆盖：${cwd}/.pi/novel/prompts/*.md
 * - 运行时覆盖：SQLite novel_prompt_templates 表
 *
 * 优先级：SQLite 运行时 > 项目文件 > 默认文件
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'

const DEFAULT_PROMPTS_DIR = resolve(
  typeof __dirname !== 'undefined'
    ? __dirname
    : fileURLToPath(new URL('.', import.meta.url)),
  'prompts',
)

export class PromptManager {
  private cache = new Map<string, string>()
  private readonly stmtGetTemplate: Database.Statement
  private readonly projectPromptsDir: string

  constructor(
    private db: Database.Database,
    private cwd: string,
  ) {
    this.projectPromptsDir = join(cwd, '.pi', 'novel', 'prompts')
    this.stmtGetTemplate = db.prepare(
      'SELECT content FROM novel_prompt_templates WHERE name = ? AND (project_id = ? OR project_id IS NULL) ORDER BY project_id DESC LIMIT 1',
    )
    this.loadDefaultTemplates()
  }

  /**
   * 启动时加载所有默认模板到内存缓存
   *
   * 只加载 prompts/ 顶层 .md 文件；子目录（如 _legacy/）不注册为模板，
   * 避免归档文件出现在模板列表中或被子目录名污染模板名。
   */
  private loadDefaultTemplates(): void {
    if (!existsSync(DEFAULT_PROMPTS_DIR)) return
    const files = readdirSync(DEFAULT_PROMPTS_DIR, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith('.md'))
    for (const f of files) {
      const name = f.name.replace(/\.md$/, '')
      const content = readFileSync(join(DEFAULT_PROMPTS_DIR, f.name), 'utf-8')
      this.cache.set(`default:${name}`, content)
    }
  }

  /**
   * 获取模板内容（三级覆盖）
   *
   * 优先级：SQLite 运行时 > 项目文件 > 默认文件
   */
  getTemplate(name: string, projectId?: string): string {
    const cacheKey = `resolved:${name}:${projectId ?? '*'}`

    // 1. 检查已解析缓存
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined) return cached

    // 2. 检查 SQLite 运行时覆盖
    if (projectId) {
      const row = this.stmtGetTemplate.get(name, projectId) as { content: string } | undefined
      if (row) {
        this.cache.set(cacheKey, row.content)
        return row.content
      }
    }

    // 3. 检查项目级文件覆盖
    const projectFile = join(this.projectPromptsDir, `${name}.md`)
    if (existsSync(projectFile)) {
      const content = readFileSync(projectFile, 'utf-8')
      this.cache.set(cacheKey, content)
      return content
    }

    // 4. 回退到默认模板
    const defaultContent = this.cache.get(`default:${name}`)
    if (defaultContent !== undefined) {
      this.cache.set(cacheKey, defaultContent)
      return defaultContent
    }

    throw new Error(`提示词模板不存在: ${name}`)
  }

  /**
   * 渲染模板：替换 {{variable}} 占位符
   */
  render(name: string, variables: Record<string, string>, projectId?: string): string {
    let template = this.getTemplate(name, projectId)

    // 替换所有 {{variable}} 占位符
    for (const [key, value] of Object.entries(variables)) {
      // 同时支持 {{key}} 和 {{ key }} 两种格式
      template = template.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), value)
    }

    return template
  }

  /**
   * 保存/更新运行时模板（写入 SQLite）
   */
  saveTemplate(name: string, content: string, projectId: string | null, description?: string): void {
    const id = projectId ? `${projectId}:${name}` : `global:${name}`
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO novel_prompt_templates (id, project_id, name, content, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET content = ?, description = ?, updated_at = ?
    `).run(id, projectId, name, content, description ?? null, now, now, content, description ?? null, now)

    // 清除缓存
    this.cache.delete(`resolved:${name}:${projectId ?? '*'}`)
  }

  /**
   * 列出所有模板名称
   */
  listTemplateNames(): string[] {
    const names = new Set<string>()
    // 默认模板
    for (const key of this.cache.keys()) {
      if (key.startsWith('default:')) {
        names.add(key.slice(8))
      }
    }
    // 项目文件
    if (existsSync(this.projectPromptsDir)) {
      for (const file of readdirSync(this.projectPromptsDir)) {
        if (file.endsWith('.md')) {
          names.add(file.replace(/\.md$/, ''))
        }
      }
    }
    // SQLite
    const rows = this.db.prepare('SELECT DISTINCT name FROM novel_prompt_templates').all() as { name: string }[]
    for (const row of rows) {
      names.add(row.name)
    }
    return Array.from(names).sort()
  }

  /**
   * 清除缓存（模板更新后调用）
   */
  clearCache(): void {
    // 保留 default: 前缀的缓存
    const defaults = new Map<string, string>()
    for (const [key, value] of this.cache) {
      if (key.startsWith('default:')) {
        defaults.set(key, value)
      }
    }
    this.cache.clear()
    for (const [key, value] of defaults) {
      this.cache.set(key, value)
    }
  }
}
