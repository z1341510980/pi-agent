/**
 * Agent 持久化存储
 *
 * 基于 SQLite 的 Agent 配置持久化实现。
 * 表结构见 migrations.ts 的 002_create_agents。
 */

import type Database from 'better-sqlite3'
import type { AgentConfig } from './subagent-tool.js'

/** Agent 持久化接口 */
export interface AgentPersistenceStore {
  loadAll(): AgentConfig[]
  getById(agentId: string): AgentConfig | undefined
  save(agent: AgentConfig): void
  delete(agentId: string): void
  exists(agentId: string): boolean
  search(query: { name?: string }): AgentConfig[]
}

/** 基于 SQLite 的 Agent 存储 */
export class SqliteAgentStore implements AgentPersistenceStore {
  private stmtSelectAll: Database.Statement
  private stmtSelectById: Database.Statement
  private stmtUpsert: Database.Statement
  private stmtDelete: Database.Statement
  private stmtExists: Database.Statement
  private stmtSearchByName: Database.Statement

  constructor(db: Database.Database) {
    this.stmtSelectAll = db.prepare('SELECT * FROM agents ORDER BY created_at')
    this.stmtSelectById = db.prepare('SELECT * FROM agents WHERE id = ?')
    this.stmtUpsert = db.prepare(`
      INSERT INTO agents (id, name, description, model, system_prompt, tools, identity, personality, temperature)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        model = excluded.model,
        system_prompt = excluded.system_prompt,
        tools = excluded.tools,
        identity = excluded.identity,
        personality = excluded.personality,
        temperature = excluded.temperature,
        updated_at = unixepoch()
    `)
    this.stmtDelete = db.prepare('DELETE FROM agents WHERE id = ?')
    this.stmtExists = db.prepare('SELECT 1 FROM agents WHERE id = ?')
    this.stmtSearchByName = db.prepare('SELECT * FROM agents WHERE name LIKE ? ORDER BY created_at')
  }

  loadAll(): AgentConfig[] {
    return this.stmtSelectAll.all().map((row: any) => this.rowToConfig(row))
  }

  getById(agentId: string): AgentConfig | undefined {
    const row = this.stmtSelectById.get(agentId)
    return row ? this.rowToConfig(row) : undefined
  }

  save(agent: AgentConfig): void {
    this.stmtUpsert.run(
      agent.id,
      agent.name,
      agent.description ?? null,
      agent.model ? JSON.stringify(agent.model) : null,
      agent.systemPrompt ?? null,
      agent.tools ? JSON.stringify(agent.tools) : null,
      agent.identity ?? null,
      agent.personality ?? null,
      agent.temperature ?? null,
    )
  }

  delete(agentId: string): void {
    this.stmtDelete.run(agentId)
  }

  exists(agentId: string): boolean {
    return this.stmtExists.get(agentId) != null
  }

  search(query: { name?: string }): AgentConfig[] {
    if (query.name) {
      return this.stmtSearchByName.all(`%${query.name}%`).map((row: any) => this.rowToConfig(row))
    }
    return this.loadAll()
  }

  private rowToConfig(row: any): AgentConfig {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      model: row.model ? JSON.parse(row.model) : undefined,
      systemPrompt: row.system_prompt ?? undefined,
      tools: row.tools ? JSON.parse(row.tools) : undefined,
      identity: row.identity ?? undefined,
      personality: row.personality ?? undefined,
      temperature: row.temperature ?? undefined,
    }
  }
}
