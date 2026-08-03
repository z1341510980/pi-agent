import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { applyMigrations } from '../core/db/migrations.js'

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
})
