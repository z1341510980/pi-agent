import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { novelMigrations } from '../novel-migrations.js'
import { DiscussionRunStore } from '../core/discussion/discussion-run-store.js'

describe('DiscussionRunStore', () => {
  let db: Database.Database
  let store: DiscussionRunStore

  beforeEach(() => {
    db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    db.prepare(`
      INSERT INTO novel_projects (id, title, genre, synopsis, target_words, status)
      VALUES ('project-1', '测试', '玄幻', '', 100000, 'draft')
    `).run()
    store = new DiscussionRunStore(db)
  })

  afterEach(() => db.close())

  it('round-trips an error snapshot that can resume chapter weaving', () => {
    store.save({
      id: 'run-1',
      projectId: 'project-1',
      chapterNumber: 9,
      status: 'error',
      failedPhase: 'chapter_weaving',
      transcript: [{
        id: 'msg-1',
        fromId: 'char-1',
        fromName: '叶明远',
        content: '角色推演',
        timestamp: 1,
        type: 'member',
        sceneId: 1,
      }],
      scenes: [{
        sceneId: 1,
        title: '突破',
        location: '矿道',
        time: '夜',
        presentCharacters: ['char-1'],
        goal: '完成突破',
      }],
      arrangedEntities: {
        characterIds: ['1'],
        conflictIds: [],
        foreshadowIds: [],
        factionIds: [],
        locationIds: [],
      },
      memberModel: { provider: 'openai', modelId: 'gpt-test' },
      projectModel: { provider: 'anthropic', modelId: 'claude-project' },
      error: '502',
    })

    expect(store.get('run-1')).toMatchObject({
      projectId: 'project-1',
      chapterNumber: 9,
      status: 'error',
      failedPhase: 'chapter_weaving',
      transcript: [{ content: '角色推演' }],
      scenes: [{ sceneId: 1, title: '突破' }],
      arrangedEntities: { characterIds: ['1'] },
      memberModel: { provider: 'openai', modelId: 'gpt-test' },
      projectModel: { provider: 'anthropic', modelId: 'claude-project' },
      error: '502',
    })
  })
})
