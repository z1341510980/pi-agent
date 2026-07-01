import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { z } from 'zod'
import { SqliteAgentStore } from '../core/agent/agent-persistence.js'
import { AgentManager } from '../core/agent/subagent-tool.js'
import { AgentChannel } from '../core/agent/agent-channel.js'

// 验证 Zod schema 边界校验（与 agents.route.ts 中 createAgentSchema 同款约束）
// route 中 schema 未导出，这里内联同款 schema 验证 temperature 边界行为
const createAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
})

describe('agents route temperature schema 校验', () => {
  it('temperature=0.7 通过校验', () => {
    const result = createAgentSchema.safeParse({ id: 't1', name: 'T1', temperature: 0.7 })
    expect(result.success).toBe(true)
  })

  it('temperature=2.5 被拒绝（超出上界）', () => {
    const result = createAgentSchema.safeParse({ id: 't2', name: 'T2', temperature: 2.5 })
    expect(result.success).toBe(false)
  })

  it('temperature=-0.1 被拒绝（低于下界）', () => {
    const result = createAgentSchema.safeParse({ id: 't3', name: 'T3', temperature: -0.1 })
    expect(result.success).toBe(false)
  })

  it('temperature 缺省通过校验', () => {
    const result = createAgentSchema.safeParse({ id: 't4', name: 'T4' })
    expect(result.success).toBe(true)
  })

  it('temperature=0 通过校验（边界值）', () => {
    const result = createAgentSchema.safeParse({ id: 't5', name: 'T5', temperature: 0 })
    expect(result.success).toBe(true)
  })

  it('temperature=2 通过校验（边界值）', () => {
    const result = createAgentSchema.safeParse({ id: 't6', name: 'T6', temperature: 2 })
    expect(result.success).toBe(true)
  })
})

// 验证 AgentManager.createAgent / updateAgent 透传 temperature 到持久化 store
// 这对应 POST /api/agents 与 PUT /api/agents/:id handler 的透传行为
describe('AgentManager temperature 透传到 store', () => {
  let db: Database.Database
  let store: SqliteAgentStore
  let manager: AgentManager

  beforeEach(() => {
    db = new Database(':memory:')
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
    store = new SqliteAgentStore(db)
    manager = new AgentManager({ channel: new AgentChannel(), store })
  })

  it('createAgent 带 temperature 后 store 能读回', async () => {
    await manager.createAgent({ id: 'm1', name: 'M1', temperature: 0.8 })
    const agent = manager.getAgent('m1')
    expect(agent?.temperature).toBe(0.8)
    // 验证已持久化到 store
    const persisted = store.getById('m1')
    expect(persisted?.temperature).toBe(0.8)
  })

  it('createAgent 不带 temperature 时 store 读回 undefined', async () => {
    await manager.createAgent({ id: 'm2', name: 'M2' })
    const persisted = store.getById('m2')
    expect(persisted?.temperature).toBeUndefined()
  })

  it('updateAgent 带 temperature 覆盖后 store 能读回新值', async () => {
    await manager.createAgent({ id: 'm3', name: 'M3', temperature: 0.5 })
    await manager.updateAgent('m3', { temperature: 1.3 })
    const agent = manager.getAgent('m3')
    expect(agent?.temperature).toBe(1.3)
    const persisted = store.getById('m3')
    expect(persisted?.temperature).toBe(1.3)
  })

  it('updateAgent 不带 temperature 时保留原值', async () => {
    await manager.createAgent({ id: 'm4', name: 'M4', temperature: 0.6 })
    await manager.updateAgent('m4', { name: 'M4-updated' })
    const persisted = store.getById('m4')
    expect(persisted?.name).toBe('M4-updated')
    expect(persisted?.temperature).toBe(0.6)
  })
})
