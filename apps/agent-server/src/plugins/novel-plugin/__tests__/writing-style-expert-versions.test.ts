import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { novelMigrations } from '../novel-migrations.js'
import { NovelStore } from '../core/novel-store.js'

describe('writing style expert versions', () => {
  it('creates a new version when rolling an expert back', () => {
    const db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    db.prepare(`INSERT INTO novel_projects (id, title, genre) VALUES ('p', '测试', '悬疑')`).run()
    const store = new NovelStore(db)
    const expert = store.createStyleExpert({
      id: 'e1', projectId: 'p', name: '冷峻', sourceTitle: '样本', description: '留白',
      distilledPrompt: '原始提示词', customPrompt: undefined, enabled: true, sortOrder: 0,
      distillMeta: undefined, version: 1,
    })
    const updated = store.updateStyleExpert('p', expert.id, {
      sourceTitle: '新来源', customPrompt: '修改后的提示词', sortOrder: 5,
    })!
    const restored = store.rollbackStyleExpert('p', expert.id, 1)!
    expect(updated.version).toBe(2)
    expect(restored.version).toBe(3)
    expect(restored.sourceTitle).toBe('样本')
    expect(restored.customPrompt).toBeUndefined()
    expect(restored.sortOrder).toBe(0)
    expect(store.listStyleExpertVersions('p', expert.id).map((item) => item.version)).toEqual([1, 2, 3])
  })
})
