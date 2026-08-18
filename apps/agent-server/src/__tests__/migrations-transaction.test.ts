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

  it('repairs legacy scene/storyline tables before creating the V2 plan schema', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY);
      CREATE TABLE novel_projects (id TEXT PRIMARY KEY);
      CREATE TABLE novel_chapters (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        chapter_number INTEGER NOT NULL
      );
      INSERT INTO novel_projects (id) VALUES ('project-1');
      INSERT INTO novel_chapters (id, project_id, chapter_number)
      VALUES ('chapter-2', 'project-1', 2);
      CREATE TABLE novel_scenes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        chapter_number INTEGER NOT NULL,
        scene_order INTEGER NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        pov_mode TEXT NOT NULL,
        pov_character_ids TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO novel_scenes (
        id, project_id, chapter_number, scene_order, title, summary,
        pov_mode, pov_character_ids, status, source, created_at, updated_at
      ) VALUES ('legacy-scene', 'project-1', 2, 1, '旧场景', '', 'none', '[]', 'planned', 'manual', 1, 1);
      CREATE TABLE novel_storylines (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        maturity TEXT NOT NULL,
        current_state TEXT NOT NULL,
        next_direction TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO novel_storylines (
        id, project_id, name, description, kind, status, maturity,
        current_state, next_direction, created_at, updated_at
      ) VALUES ('legacy-line', 'project-1', '旧主线', '', 'main', 'active', 'candidate', '', '', 1, 1);
    `)

    const migration = novelMigrations.find((item) => item.id === '109_repair_scene_plan_schema')
    expect(migration).toBeDefined()
    applyMigrations(db, [migration!])

    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'novel_chapter_plan_revisions'").get()).toBeDefined()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'novel_scene_revisions'").get()).toBeDefined()
    expect(db.prepare('SELECT chapter_id, stable_key FROM novel_scenes WHERE id = ?').get('legacy-scene'))
      .toEqual({ chapter_id: 'chapter-2', stable_key: 'legacy-2-1' })
    expect(db.prepare('SELECT id, lifecycle FROM novel_storylines WHERE id = ?').get('legacy-line'))
      .toEqual({ id: 'legacy-line', lifecycle: 'active' })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'novel_scenes_legacy_v1'").get()).toBeDefined()
    db.close()
  })
})
