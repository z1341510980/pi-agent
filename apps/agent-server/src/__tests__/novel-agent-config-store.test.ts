import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { NovelAgentConfigStore } from '../plugins/novel-plugin/core/novel-agent-config-store.js'
import { NOVEL_AGENT_CONFIGS } from '../plugins/novel-plugin/core/novel-agents.js'

function createConfigTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS novel_agent_config (
      agent_type    TEXT PRIMARY KEY,
      temperature   REAL,
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)
}

describe('NovelAgentConfigStore', () => {
  let db: Database.Database
  let store: NovelAgentConfigStore

  beforeEach(() => {
    db = new Database(':memory:')
    createConfigTable(db)
    store = new NovelAgentConfigStore(db)
  })

  it('无覆盖时 getAll 返回默认温度', () => {
    const all = store.getAll()
    expect(all.director).toBe(NOVEL_AGENT_CONFIGS.director.temperature)
    expect(all.writer).toBe(NOVEL_AGENT_CONFIGS.writer.temperature)
    expect(all.reviewer).toBe(NOVEL_AGENT_CONFIGS.reviewer.temperature)
    expect(all.memory).toBe(NOVEL_AGENT_CONFIGS.memory.temperature)
  })

  it('upsert 覆盖后 getAll 返回覆盖值', () => {
    store.upsert('writer', 1.1)
    const all = store.getAll()
    expect(all.writer).toBe(1.1)
    expect(all.director).toBe(NOVEL_AGENT_CONFIGS.director.temperature)
  })

  it('getByType 返回合并后温度（覆盖优先）', () => {
    store.upsert('director', 0.3)
    expect(store.getByType('director')).toBe(0.3)
    expect(store.getByType('writer')).toBe(NOVEL_AGENT_CONFIGS.writer.temperature)
  })

  it('upsertMany 批量覆盖', () => {
    store.upsertMany([
      { agentType: 'director', temperature: 0.6 },
      { agentType: 'writer', temperature: 1.0 },
    ])
    expect(store.getByType('director')).toBe(0.6)
    expect(store.getByType('writer')).toBe(1.0)
    expect(store.getByType('reviewer')).toBe(NOVEL_AGENT_CONFIGS.reviewer.temperature)
  })
})
