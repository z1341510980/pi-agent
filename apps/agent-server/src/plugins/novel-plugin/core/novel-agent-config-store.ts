/**
 * 小说 Agent 角色温度配置存储
 *
 * 持久化用户对 4 个小说 Agent 角色（director/writer/reviewer/memory）的温度覆盖。
 * 全局配置，不按 project 区分。
 *
 * 合并优先级：持久化覆盖 > NOVEL_AGENT_CONFIGS 默认值
 */

import type Database from 'better-sqlite3'
import { NOVEL_AGENT_CONFIGS, type NovelAgentType } from './novel-agents.js'

/** 小说角色温度配置（合并后，含全部 4 角色） */
export type NovelAgentTemperatures = Record<NovelAgentType, number>

export class NovelAgentConfigStore {
  private stmtGetAll: Database.Statement
  private stmtGetByType: Database.Statement
  private stmtUpsert: Database.Statement

  constructor(private db: Database.Database) {
    this.stmtGetAll = db.prepare('SELECT agent_type, temperature FROM novel_agent_config')
    this.stmtGetByType = db.prepare('SELECT temperature FROM novel_agent_config WHERE agent_type = ?')
    this.stmtUpsert = db.prepare(`
      INSERT INTO novel_agent_config (agent_type, temperature)
      VALUES (?, ?)
      ON CONFLICT(agent_type) DO UPDATE SET
        temperature = excluded.temperature,
        updated_at = unixepoch()
    `)
  }

  /** 获取全部角色温度（合并默认值与持久化覆盖） */
  getAll(): NovelAgentTemperatures {
    const rows = this.stmtGetAll.all() as Array<{ agent_type: string; temperature: number | null }>
    const overrides = new Map<string, number>()
    for (const row of rows) {
      if (row.temperature !== null) {
        overrides.set(row.agent_type, row.temperature)
      }
    }
    return {
      director: overrides.get('director') ?? NOVEL_AGENT_CONFIGS.director.temperature,
      writer: overrides.get('writer') ?? NOVEL_AGENT_CONFIGS.writer.temperature,
      reviewer: overrides.get('reviewer') ?? NOVEL_AGENT_CONFIGS.reviewer.temperature,
      memory: overrides.get('memory') ?? NOVEL_AGENT_CONFIGS.memory.temperature,
    }
  }

  /** 获取单个角色温度（合并后） */
  getByType(agentType: NovelAgentType): number {
    const row = this.stmtGetByType.get(agentType) as { temperature: number | null } | undefined
    if (row && row.temperature !== null) {
      return row.temperature
    }
    return NOVEL_AGENT_CONFIGS[agentType].temperature
  }

  /** 覆盖单个角色温度 */
  upsert(agentType: NovelAgentType, temperature: number): void {
    this.stmtUpsert.run(agentType, temperature)
  }

  /** 批量覆盖 */
  upsertMany(items: Array<{ agentType: NovelAgentType; temperature: number }>): void {
    const tx = this.db.transaction(() => {
      for (const item of items) {
        this.upsert(item.agentType, item.temperature)
      }
    })
    tx()
  }
}
