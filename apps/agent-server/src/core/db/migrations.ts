/**
 * SQLite 数据库迁移
 *
 * 统一管理所有表的创建。每个迁移用 IF NOT EXISTS 保证幂等。
 * 迁移版本号记录在 schema_migrations 表中。
 */

import type Database from 'better-sqlite3'
import type { MigrationDefinition } from '../plugin/plugin-types.js'

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
  {
    // 通用 Agent 调用日志表（chat 底座能力，所有 Agent 调用统一记录）
    // 与 EvidenceLedger（工具调用维度）互补，本表记录 Agent 调用维度：
    // 系统提示词 / 用户消息 / 任务输入 / 工具 / 结果 / 耗时 / 状态。
    // 领域扩展字段（如 projectId / chapterNumber / agentType / phase）通过 metadata JSON 列存储。
    id: '012b_create_agent_call_logs',
    sql: `CREATE TABLE IF NOT EXISTS agent_call_logs (
      id            TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      agent_name    TEXT NOT NULL DEFAULT '',
      thread_id     TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      user_message  TEXT NOT NULL DEFAULT '',
      task_input    TEXT NOT NULL DEFAULT '',
      tools         TEXT NOT NULL DEFAULT '[]',
      tool_names    TEXT NOT NULL DEFAULT '[]',
      result        TEXT NOT NULL DEFAULT '',
      result_length INTEGER NOT NULL DEFAULT 0,
      duration_ms   INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'success',
      error         TEXT NOT NULL DEFAULT '',
      metadata      TEXT NOT NULL DEFAULT '{}',
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_agent_call_logs_agent ON agent_call_logs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_call_logs_thread ON agent_call_logs(thread_id);
    CREATE INDEX IF NOT EXISTS idx_agent_call_logs_created ON agent_call_logs(created_at DESC);`,
  },
  {
    // 通用应用设置表（key-value），用于存储默认 Provider 等全局偏好
    id: '013_create_app_settings',
    sql: `CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );`,
  },
  {
    // 每个 thread 的思考强度（thinking level）独立存储，
    // 切换时只清掉对应 thread 的 PiSession 缓存（不影响其他线程）
    id: '014_create_thread_thinking_levels',
    sql: `CREATE TABLE IF NOT EXISTS thread_thinking_levels (
      thread_id      TEXT PRIMARY KEY,
      thinking_level TEXT NOT NULL,
      updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
    );`,
  },
  {
    // 会话身份索引 P0（方案 §9.4）：threadId → Pi session JSONL 路径 的持久化映射。
    // PiSessionStore 在会话创建成功后异步写入；getSessionFilePath 内存 miss 时回退查表，
    // 聊天线程重启/LRU 淘汰后据此恢复原会话（SessionManager.open）。
    id: '015_create_pi_session_identity',
    sql: `CREATE TABLE IF NOT EXISTS pi_session_identity (
      thread_id    TEXT PRIMARY KEY,
      session_path TEXT NOT NULL,
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );`,
  },
  {
    // 图片 Provider 协议配置。默认保持 OpenAI Images 兼容协议；APIMart 等异步
    // 网关通过显式 media_protocol 选择自己的提交/轮询路径，避免按 URL 猜协议。
    id: '016_add_provider_media_protocol',
    sql: `ALTER TABLE providers ADD COLUMN media_protocol TEXT NOT NULL DEFAULT 'openai-images';
    ALTER TABLE providers ADD COLUMN media_model TEXT NOT NULL DEFAULT '';
    ALTER TABLE providers ADD COLUMN media_resolution TEXT NOT NULL DEFAULT '';
    ALTER TABLE providers ADD COLUMN media_language TEXT NOT NULL DEFAULT 'en';`,
  },
]

/** 执行所有待执行的迁移 */
export function runMigrations(db: Database.Database): void {
  // 确保 schema_migrations 表存在
  db.exec(MIGRATIONS[0].sql)

  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((r: any) => r.id as string),
  )

  applyMigrations(db, MIGRATIONS, applied)
}

/** Apply each migration's schema changes and ledger entry as one SQLite transaction. */
export function applyMigrations(
  db: Database.Database,
  migrations: readonly MigrationDefinition[],
  knownApplied?: ReadonlySet<string>,
): void {
  const applied = knownApplied ?? new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((r: any) => r.id as string),
  )
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue
    db.transaction(() => {
      migration.beforeApply?.(db)
      db.exec(migration.sql)
      migration.afterApply?.(db)
      db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(migration.id)
    })()
    if (applied instanceof Set) applied.add(migration.id)
  }
}
