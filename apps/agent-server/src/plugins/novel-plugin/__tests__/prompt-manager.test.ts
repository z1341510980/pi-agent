import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent'
import { novelMigrations } from '../novel-migrations.js'
import { PromptManager } from '../core/prompting/prompt-manager.js'

describe('PromptManager runtime overrides', () => {
  let db: Database.Database | undefined

  afterEach(() => db?.close())

  it('读取全局 SQLite 模板，并在更新后清除所有项目回退缓存', () => {
    db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    const manager = new PromptManager(db, process.cwd())

    manager.saveTemplate('runtime-only', 'global-v1', null)
    expect(manager.getTemplate('runtime-only')).toBe('global-v1')
    expect(manager.getTemplate('runtime-only', 'project-a')).toBe('global-v1')
    expect(manager.getTemplate('runtime-only', 'project-b')).toBe('global-v1')

    manager.saveTemplate('runtime-only', 'global-v2', null)
    expect(manager.getTemplate('runtime-only')).toBe('global-v2')
    expect(manager.getTemplate('runtime-only', 'project-a')).toBe('global-v2')
    expect(manager.getTemplate('runtime-only', 'project-b')).toBe('global-v2')
  })

  it('Skill 化的默认模板渲染时剥离 YAML，并保留可加载文件路径', () => {
    db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    const manager = new PromptManager(db, process.cwd())

    const reviewer = manager.getTemplate('role-reviewer')
    expect(reviewer).toContain('检查正文是否成立')
    expect(reviewer).not.toContain('name: novel-reviewer')
    expect(manager.getDefaultTemplatePath('role-reviewer')).toMatch(/role-reviewer\.md$/)

    manager.saveTemplate('role-reviewer', 'project override', 'project-a')
    expect(manager.getDefaultTemplatePath('role-reviewer', 'project-a')).toBeUndefined()
    expect(manager.getDefaultTemplatePath('role-reviewer', 'project-b')).toMatch(/role-reviewer\.md$/)
  })

  it('Director 模板同样支持 Skill 化：剥离 frontmatter、路径解析与覆盖回退', () => {
    db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    const manager = new PromptManager(db, process.cwd())

    const director = manager.getTemplate('role-director')
    expect(director).toContain('判断章节任务和剧情阶段')
    expect(director).toContain('novel_submit_narrative_task')
    expect(director).not.toContain('name: novel-director')
    expect(manager.getDefaultTemplatePath('role-director')).toMatch(/role-director\.md$/)

    manager.saveTemplate('role-director', 'project override', 'project-a')
    expect(manager.getDefaultTemplatePath('role-director', 'project-a')).toBeUndefined()
    expect(manager.getDefaultTemplatePath('role-director', 'project-b')).toMatch(/role-director\.md$/)
  })

  it('Writer / Reviser 模板剥离 frontmatter，路径解析与覆盖回退一致', () => {
    db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    const manager = new PromptManager(db, process.cwd())

    const writer = manager.getTemplate('role-writer')
    expect(writer).toContain('你是小说的执笔人')
    expect(writer).not.toContain('name: novel-writer')
    expect(manager.getDefaultTemplatePath('role-writer')).toMatch(/role-writer\.md$/)

    const reviser = manager.getTemplate('role-reviser')
    expect(reviser).toContain('负责局部修订')
    expect(reviser).toContain('novel_apply_revision')
    expect(reviser).not.toContain('name: novel-reviser')
    expect(manager.getDefaultTemplatePath('role-reviser')).toMatch(/role-reviser\.md$/)

    manager.saveTemplate('role-writer', 'project override', 'project-a')
    expect(manager.getDefaultTemplatePath('role-writer', 'project-a')).toBeUndefined()
    expect(manager.getDefaultTemplatePath('role-writer', 'project-b')).toMatch(/role-writer\.md$/)
  })

  it('noSkills 模式只加载显式授权的九角色 Skill', async () => {
    db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    const manager = new PromptManager(db, process.cwd())
    const rolePaths = {
      'novel-reviewer': manager.getDefaultTemplatePath('role-reviewer'),
      'novel-director': manager.getDefaultTemplatePath('role-director'),
      'novel-writer': manager.getDefaultTemplatePath('role-writer'),
      'novel-reviser': manager.getDefaultTemplatePath('role-reviser'),
      'novel-memory': manager.getDefaultTemplatePath('role-memory'),
      'novel-memory-generator': manager.getDefaultTemplatePath('role-memory-generator'),
      'novel-character-actor': manager.getDefaultTemplatePath('role-character-actor'),
      'novel-entity-extractor': manager.getDefaultTemplatePath('role-entity-extractor'),
      'novel-matrix-arranger': manager.getDefaultTemplatePath('role-matrix-arranger'),
    }
    for (const [name, path] of Object.entries(rolePaths)) {
      expect(path, name).toBeDefined()
    }

    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      noSkills: true,
      noExtensions: true,
      noPromptTemplates: true,
      noContextFiles: true,
      additionalSkillPaths: Object.values(rolePaths) as string[],
    })
    await loader.reload()

    const skills = loader.getSkills().skills
    expect(skills).toHaveLength(9)
    expect(skills.map(s => s.name).sort()).toEqual([
      'novel-character-actor',
      'novel-director',
      'novel-entity-extractor',
      'novel-matrix-arranger',
      'novel-memory',
      'novel-memory-generator',
      'novel-reviewer',
      'novel-reviser',
      'novel-writer',
    ])
    for (const [name, path] of Object.entries(rolePaths)) {
      expect(skills.find(s => s.name === name)!.filePath, name).toBe(path)
    }
  })

  it('群聊 discussion 模板同样支持 Skill 化（无 reviser discussion 模板则回退）', async () => {
    db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    const manager = new PromptManager(db, process.cwd())

    const directorPath = manager.getDefaultTemplatePath('role-director-discussion')
    const writerPath = manager.getDefaultTemplatePath('role-writer-discussion')
    const reviewerPath = manager.getDefaultTemplatePath('role-reviewer-discussion')
    expect(directorPath).toMatch(/role-director-discussion\.md$/)
    expect(writerPath).toMatch(/role-writer-discussion\.md$/)
    expect(reviewerPath).toMatch(/role-reviewer-discussion\.md$/)
    // reviser 无 discussion 模板：返回 undefined → 调用方回退旧身份路径
    expect(manager.getDefaultTemplatePath('role-reviser-discussion')).toBeUndefined()

    // frontmatter 剥离：旧模板渲染路径不含 YAML
    expect(manager.getTemplate('role-director-discussion')).not.toContain('name: novel-director-discussion')
    expect(manager.getTemplate('role-writer-discussion')).not.toContain('name: novel-writer-discussion')

    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      noSkills: true,
      noExtensions: true,
      noPromptTemplates: true,
      noContextFiles: true,
      additionalSkillPaths: [directorPath!, writerPath!, reviewerPath!],
    })
    await loader.reload()
    expect(loader.getSkills().skills.map(s => s.name).sort()).toEqual([
      'novel-director-discussion',
      'novel-reviewer-discussion',
      'novel-writer-discussion',
    ])
  })

  it('项目模板优先于全局模板，项目更新后其他项目仍回退全局模板', () => {
    db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    const manager = new PromptManager(db, process.cwd())

    manager.saveTemplate('runtime-scope', 'global', null)
    manager.saveTemplate('runtime-scope', 'project-a-v1', 'project-a')
    expect(manager.getTemplate('runtime-scope', 'project-a')).toBe('project-a-v1')
    expect(manager.getTemplate('runtime-scope', 'project-b')).toBe('global')

    manager.saveTemplate('runtime-scope', 'project-a-v2', 'project-a')
    expect(manager.getTemplate('runtime-scope', 'project-a')).toBe('project-a-v2')
    expect(manager.getTemplate('runtime-scope', 'project-b')).toBe('global')
  })
})
