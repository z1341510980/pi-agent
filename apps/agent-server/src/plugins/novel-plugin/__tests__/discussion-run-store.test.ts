import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { novelMigrations } from '../novel-migrations.js'
import { DiscussionRunStore } from '../core/discussion/discussion-run-store.js'

function createStore(): DiscussionRunStore {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const migration of novelMigrations) db.exec(migration.sql)
  db.prepare(`INSERT INTO novel_projects (id, title, genre) VALUES ('p-1', '测试', 'fantasy')`).run()
  return new DiscussionRunStore(db)
}

describe('DiscussionRunStore', () => {
  it('updates the frozen style expert selection when a snapshot is overwritten', () => {
    const store = createStore()
    const base = {
      id: 'run-1',
      projectId: 'p-1',
      chapterNumber: 3,
      status: 'error' as const,
      failedPhase: 'chapter_weaving' as const,
      transcript: [],
      scenes: [],
    }

    store.save({ ...base, styleExpertIds: ['expert-a'] })
    store.save({ ...base, styleExpertIds: [] })

    expect(store.get('run-1')?.styleExpertIds).toEqual([])
  })
})
