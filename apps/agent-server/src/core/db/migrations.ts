/**
 * SQLite 数据库迁移
 *
 * 统一管理所有表的创建。每个迁移用 IF NOT EXISTS 保证幂等。
 * 迁移版本号记录在 schema_migrations 表中。
 */

import type Database from 'better-sqlite3'

/** 所有迁移定义 */
const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_create_schema_migrations',
    sql: `CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      applied_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );`,
  },
  {
    id: '002_create_agents',
    sql: `CREATE TABLE IF NOT EXISTS agents (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT,
      model         TEXT,
      system_prompt TEXT,
      tools         TEXT,
      identity      TEXT,
      personality   TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);`,
  },
  {
    // 为 agents 表补 temperature 列（兼容新旧库）
    id: '002b_add_agents_temperature',
    sql: `ALTER TABLE agents ADD COLUMN temperature REAL;`,
  },
  {
    id: '003_create_teams',
    sql: `CREATE TABLE IF NOT EXISTS teams (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      description       TEXT,
      lead_agent_id     TEXT NOT NULL,
      default_strategy  TEXT NOT NULL DEFAULT 'parallel',
      max_parallel      INTEGER NOT NULL DEFAULT 2,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (lead_agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id          TEXT NOT NULL,
      agent_id         TEXT NOT NULL,
      role             TEXT NOT NULL,
      role_description TEXT,
      sort_order       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (team_id, agent_id),
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );`,
  },
  {
    id: '004_create_facts',
    sql: `CREATE TABLE IF NOT EXISTS facts (
      id              TEXT PRIMARY KEY,
      content         TEXT NOT NULL,
      tags            TEXT NOT NULL DEFAULT '[]',
      source          TEXT,
      confidence      REAL NOT NULL DEFAULT 0.5,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      access_count    INTEGER NOT NULL DEFAULT 0,
      last_accessed_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_facts_last_accessed ON facts(last_accessed_at);`,
  },
  {
    id: '005_create_session_summaries',
    sql: `CREATE TABLE IF NOT EXISTS session_summaries (
      session_id    TEXT PRIMARY KEY,
      summary       TEXT NOT NULL,
      key_decisions TEXT NOT NULL DEFAULT '[]',
      topics        TEXT NOT NULL DEFAULT '[]',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );`,
  },
  {
    id: '006_create_usage_records',
    sql: `CREATE TABLE IF NOT EXISTS usage_records (
      id                  TEXT PRIMARY KEY,
      timestamp           INTEGER NOT NULL,
      session_id          TEXT NOT NULL,
      thread_id           TEXT NOT NULL,
      model               TEXT NOT NULL,
      provider            TEXT NOT NULL,
      input_tokens        INTEGER NOT NULL,
      output_tokens       INTEGER NOT NULL,
      cache_read_tokens   INTEGER,
      cache_write_tokens  INTEGER,
      cost_usd            REAL NOT NULL,
      duration_ms         INTEGER NOT NULL,
      agent_id            TEXT NOT NULL DEFAULT 'default'
    );
    CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_records(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_records(session_id);
    CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage_records(agent_id);

    CREATE TABLE IF NOT EXISTS usage_budget (
      id                  INTEGER PRIMARY KEY DEFAULT 1,
      monthly_budget_usd  REAL NOT NULL DEFAULT 0,
      alert_threshold     REAL NOT NULL DEFAULT 80
    );
    INSERT OR IGNORE INTO usage_budget (id, monthly_budget_usd, alert_threshold) VALUES (1, 0, 80);`,
  },
  {
    id: '007_create_providers',
    sql: `CREATE TABLE IF NOT EXISTS providers (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      base_url    TEXT NOT NULL,
      api_key     TEXT NOT NULL,
      api         TEXT NOT NULL,
      auth_header INTEGER NOT NULL DEFAULT 1,
      models      TEXT NOT NULL DEFAULT '[]',
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );`,
  },
  {
    id: '008_create_proxy_config',
    sql: `CREATE TABLE IF NOT EXISTS proxy_config (
      id        INTEGER PRIMARY KEY DEFAULT 1,
      mode      TEXT NOT NULL DEFAULT 'system',
      host      TEXT NOT NULL DEFAULT '',
      port      TEXT NOT NULL DEFAULT '',
      username  TEXT NOT NULL DEFAULT '',
      password  TEXT NOT NULL DEFAULT ''
    );
    INSERT OR IGNORE INTO proxy_config (id, mode) VALUES (1, 'system');`,
  },
  {
    id: '009_create_cron_jobs',
    sql: `CREATE TABLE IF NOT EXISTS cron_jobs (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      schedule    TEXT NOT NULL,
      prompt      TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      next_run_at INTEGER,
      run_count   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );`,
  },
  {
    id: '010_create_evidence',
    sql: `CREATE TABLE IF NOT EXISTS evidence (
      id            TEXT PRIMARY KEY,
      thread_id     TEXT NOT NULL,
      tool_call_id  TEXT NOT NULL,
      tool_name     TEXT NOT NULL,
      args_summary  TEXT,
      result_summary TEXT,
      is_error      INTEGER NOT NULL DEFAULT 0,
      timestamp     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_thread ON evidence(thread_id);`,
  },
  {
    id: '011_create_session_files',
    sql: `CREATE TABLE IF NOT EXISTS session_files (
      file_id      TEXT PRIMARY KEY,
      file_path    TEXT NOT NULL,
      session_path TEXT NOT NULL,
      label        TEXT NOT NULL,
      origin       TEXT NOT NULL,
      storage_kind TEXT NOT NULL DEFAULT 'external',
      content_hash TEXT,
      size_bytes   INTEGER,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_files_path ON session_files(session_path);
    CREATE INDEX IF NOT EXISTS idx_session_files_hash ON session_files(content_hash);

    CREATE TABLE IF NOT EXISTS file_refcount (
      content_hash TEXT PRIMARY KEY,
      refcount     INTEGER NOT NULL DEFAULT 0
    );`,
  },
  {
    // 补充 cron_jobs 表缺失的字段，对齐 CronJob 接口
    id: '012_alter_cron_jobs_add_columns',
    sql: `ALTER TABLE cron_jobs ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE cron_jobs ADD COLUMN last_result TEXT;
    ALTER TABLE cron_jobs ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 300000;
    ALTER TABLE cron_jobs ADD COLUMN last_error TEXT;`,
  },
]

/** 执行所有待执行的迁移 */
export function runMigrations(db: Database.Database): void {
  // 确保 schema_migrations 表存在
  db.exec(MIGRATIONS[0].sql)

  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((r: any) => r.id as string),
  )

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue
    db.exec(migration.sql)
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(migration.id)
  }
}
