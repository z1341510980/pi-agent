/**
 * Team 持久化存储
 *
 * 基于 SQLite 的 Team 配置持久化实现。
 * 表结构见 migrations.ts 的 003_create_teams（teams + team_members）。
 */

import type Database from 'better-sqlite3'
import type { TeamConfig, TeamMemberConfig } from '@repo/shared/agent'

/** Team 持久化接口 */
export interface TeamPersistenceStore {
  loadAll(): TeamConfig[]
  getById(teamId: string): TeamConfig | undefined
  save(team: TeamConfig): void
  delete(teamId: string): void
  exists(teamId: string): boolean
}

/** 基于 SQLite 的 Team 存储 */
export class SqliteTeamStore implements TeamPersistenceStore {
  private stmtSelectAll: Database.Statement
  private stmtSelectById: Database.Statement
  private stmtUpsertTeam: Database.Statement
  private stmtDeleteTeam: Database.Statement
  private stmtDeleteMembers: Database.Statement
  private stmtInsertMember: Database.Statement
  private stmtSelectMembers: Database.Statement
  private stmtExists: Database.Statement

  constructor(db: Database.Database) {
    this.stmtSelectAll = db.prepare('SELECT * FROM teams ORDER BY created_at')
    this.stmtSelectById = db.prepare('SELECT * FROM teams WHERE id = ?')
    this.stmtUpsertTeam = db.prepare(`
      INSERT INTO teams (id, name, description, lead_agent_id, default_strategy, max_parallel)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        lead_agent_id = excluded.lead_agent_id,
        default_strategy = excluded.default_strategy,
        max_parallel = excluded.max_parallel,
        updated_at = unixepoch()
    `)
    this.stmtDeleteTeam = db.prepare('DELETE FROM teams WHERE id = ?')
    this.stmtDeleteMembers = db.prepare('DELETE FROM team_members WHERE team_id = ?')
    this.stmtInsertMember = db.prepare(`
      INSERT INTO team_members (team_id, agent_id, role, role_description, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `)
    this.stmtSelectMembers = db.prepare('SELECT * FROM team_members WHERE team_id = ? ORDER BY sort_order')
    this.stmtExists = db.prepare('SELECT 1 FROM teams WHERE id = ?')
  }

  loadAll(): TeamConfig[] {
    return this.stmtSelectAll.all().map((row: any) => this.rowToConfig(row))
  }

  getById(teamId: string): TeamConfig | undefined {
    const row = this.stmtSelectById.get(teamId)
    return row ? this.rowToConfig(row) : undefined
  }

  save(team: TeamConfig): void {
    // 使用事务保证 teams + team_members 原子写入
    const tx = this.stmtUpsertTeam.database.transaction(() => {
      this.stmtUpsertTeam.run(
        team.id,
        team.name,
        team.description ?? null,
        team.leadAgentId,
        team.defaultStrategy,
        team.maxParallel,
      )
      // 先删除旧成员，再插入新成员
      this.stmtDeleteMembers.run(team.id)
      for (const member of team.members) {
        this.stmtInsertMember.run(
          team.id,
          member.agentId,
          member.role,
          member.roleDescription ?? null,
          member.sortOrder ?? 0,
        )
      }
    })
    tx()
  }

  delete(teamId: string): void {
    // team_members 表有 ON DELETE CASCADE，会自动删除关联成员
    this.stmtDeleteTeam.run(teamId)
  }

  exists(teamId: string): boolean {
    return this.stmtExists.get(teamId) != null
  }

  private rowToConfig(row: any): TeamConfig {
    const members = this.stmtSelectMembers
      .all(row.id)
      .map((m: any) => this.rowToMember(m))

    return {
      id: row.id,
      name: row.name,
      description: row.description ?? '',
      leadAgentId: row.lead_agent_id,
      members,
      defaultStrategy: row.default_strategy,
      maxParallel: row.max_parallel,
    }
  }

  private rowToMember(row: any): TeamMemberConfig {
    return {
      agentId: row.agent_id,
      role: row.role,
      roleDescription: row.role_description ?? undefined,
      sortOrder: row.sort_order,
    }
  }
}
