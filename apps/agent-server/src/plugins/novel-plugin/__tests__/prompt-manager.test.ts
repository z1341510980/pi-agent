import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
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
