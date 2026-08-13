import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { applyMigrations } from '../core/db/migrations.js'
import { novelMigrations } from '../plugins/novel-plugin/novel-migrations.js'

describe('transactional migration application', () => {
  it('rolls back DDL when recording schema_migrations fails', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY);
      CREATE TRIGGER reject_migration BEFORE INSERT ON schema_migrations
      BEGIN SELECT RAISE(ABORT, 'simulated crash before ledger write'); END;
    `)

    expect(() => applyMigrations(db, [{
      id: 'test_atomic',
      sql: 'CREATE TABLE should_roll_back (id TEXT PRIMARY KEY);',
    }])).toThrow('simulated crash')
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_roll_back'").get())
      .toBeUndefined()
    expect(db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get('test_atomic')).toBeUndefined()
    db.close()
  })

  it('deduplicates historical character arcs before adding the 1:1 constraint', () => {
    const db = new Database(':memory:')
    const migration = novelMigrations.find((item) => item.id === '095_enforce_novel_character_arc_uniqueness')
    expect(migration).toBeDefined()
    for (const item of novelMigrations) {
      if (item.id === migration!.id) break
      db.exec(item.sql)
    }
    db.exec(`
      INSERT INTO novel_projects (id, title, genre, synopsis, target_words, current_volume, current_chapter, current_stage, status)
      VALUES ('p-1', 'test', 'test', '', 0, 1, 0, 'setup', 'active');
      INSERT INTO novel_characters (
        id, project_id, name, description, identity, personality, appearance,
        current_state, current_goal, current_pressure, secret, arc_stage, arc_history, speech_style
      ) VALUES ('c-1', 'p-1', 'character', '', '', '', '', '', '', '', '', 'stale', '[]', '');
      INSERT INTO novel_character_arcs (
        id, project_id, character_id, arc_type, current_stage, stage_history, description, created_at, updated_at
      ) VALUES
        ('arc-old', 'p-1', 'c-1', 'growth', 'denial', '[]', NULL, 1, 1),
        ('arc-new', 'p-1', 'c-1', 'growth', 'acceptance', '[]', NULL, 2, 2);
    `)

    db.exec(migration!.sql)

    expect(db.prepare('SELECT id FROM novel_character_arcs').all()).toEqual([{ id: 'arc-new' }])
    expect(db.prepare('SELECT arc_stage FROM novel_characters WHERE id = ?').get('c-1'))
      .toEqual({ arc_stage: 'acceptance' })
    expect(() => db.prepare(`
      INSERT INTO novel_character_arcs (
        id, project_id, character_id, arc_type, current_stage, stage_history, description, created_at, updated_at
      ) VALUES ('arc-duplicate', 'p-1', 'c-1', 'growth', 'transformation', '[]', NULL, 3, 3)
    `).run()).toThrow(/UNIQUE constraint failed/)
    db.close()
  })
})
