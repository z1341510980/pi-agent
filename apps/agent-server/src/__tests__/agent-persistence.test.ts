import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { SqliteAgentStore } from '../core/agent/agent-persistence.js'

// 内联 agents 表建表（含 temperature 列），独立于主迁移系统
function createAgentsTableWithTemperature(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT,
      model         TEXT,
      system_prompt TEXT,
      tools         TEXT,
      identity      TEXT,
      personality   TEXT,
      temperature   REAL,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)
}

describe('SqliteAgentStore temperature', () => {
  let db: Database.Database
  let store: SqliteAgentStore

  beforeEach(() => {
    db = new Database(':memory:')
    createAgentsTableWithTemperature(db)
    store = new SqliteAgentStore(db)
  })

  it('save 带 temperature 后 getById 能读回', () => {
    store.save({
      id: 'test-agent',
      name: 'Test',
      temperature: 0.9,
    })
    const loaded = store.getById('test-agent')
    expect(loaded?.temperature).toBe(0.9)
  })

  it('save 不带 temperature 时 getById 返回 undefined', () => {
    store.save({ id: 'no-temp', name: 'NoTemp' })
    const loaded = store.getById('no-temp')
    expect(loaded?.temperature).toBeUndefined()
  })

  it('update 覆盖 temperature 生效', () => {
    store.save({ id: 'up-agent', name: 'Up', temperature: 0.5 })
    store.save({ id: 'up-agent', name: 'Up', temperature: 1.2 })
    const loaded = store.getById('up-agent')
    expect(loaded?.temperature).toBe(1.2)
  })
})
