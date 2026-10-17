import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { novelMigrations } from '../novel-migrations.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const migration of novelMigrations) db.exec(migration.sql)
  db.prepare("INSERT INTO novel_projects (id, title, genre) VALUES ('p-1', '测试', 'fantasy')").run()
  db.prepare(`
    INSERT INTO novel_creation_runs (
      run_id, project_id, chapter_number, mode, status, stage, revision,
      created_at, updated_at
    ) VALUES ('run-1', 'p-1', 3, 'workflow', 'completed', 'finalizing', 0, 1, 1)
  `).run()
  db.prepare(`
    INSERT INTO novel_creation_runs (
      run_id, project_id, chapter_number, mode, status, stage, revision,
      created_at, updated_at
    ) VALUES ('run-2', 'p-1', 3, 'workflow', 'completed', 'finalizing', 0, 1, 1)
  `).run()
  db.prepare(`
    INSERT INTO novel_story_events (id, project_id, chapter_number, type, status)
    VALUES ('story-event-1', 'p-1', 3, 'plot', 'planned')
  `).run()
  return db
}

describe('memory fact evidence links', () => {
  it('links a confirmed memory fact to run, chapter revision, and body evidence', () => {
    const db = createDb()
    const store = new NovelMemoryStore(db)
    const event = store.recordEvent({
      projectId: 'p-1',
      chapterId: 'chapter-1',
      chapterNumber: 3,
      eventType: 'character_change',
      entityId: 'character-1',
      entityType: 'character',
      description: '角色状态发生变化',
      oldValue: null,
      newValue: JSON.stringify({ currentState: '受伤' }),
      cause: null,
      effectIds: [],
      significance: 7,
      source: 'manual',
    })
    store.linkFactsToRun([event], {
      runId: 'run-1',
      chapterRevisionId: 'revision-1',
      bodyEvidence: '他捂住伤口，仍然向前走。',
    })

    expect(store.listFactLinks('run-1')).toMatchObject([{
      memoryEventId: event.id,
      runId: 'run-1',
      chapterRevisionId: 'revision-1',
      bodyEvidence: '他捂住伤口，仍然向前走。',
      factStatus: 'confirmed',
    }])
    db.close()
  })

  it('updates linked fact acceptance when a pending story event is confirmed or rejected', () => {
    const db = createDb()
    const store = new NovelMemoryStore(db)
    const event = store.recordEvent({
      projectId: 'p-1',
      chapterId: 'chapter-1',
      chapterNumber: 3,
      eventType: 'character_change',
      entityId: 'character-1',
      entityType: 'character',
      description: 'AI 提取变化',
      oldValue: null,
      newValue: JSON.stringify({ currentState: '受伤' }),
      cause: null,
      effectIds: [],
      significance: 7,
      source: 'ai-extracted',
      storyEventId: 'story-event-1',
    })
    store.linkFactsToRun([event], {
      runId: 'run-2',
      chapterRevisionId: 'revision-2',
      bodyEvidence: '证据',
    })
    store.confirmEvent('story-event-1')
    expect(store.listFactLinks('run-2')[0].factStatus).toBe('confirmed')
    db.close()
  })
})
