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
    // 小说项目表
    id: '013_create_novel_projects',
    sql: `CREATE TABLE IF NOT EXISTS novel_projects (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      genre           TEXT NOT NULL,
      synopsis        TEXT NOT NULL DEFAULT '',
      target_words    INTEGER NOT NULL DEFAULT 0,
      current_volume  INTEGER NOT NULL DEFAULT 1,
      current_chapter INTEGER NOT NULL DEFAULT 0,
      current_stage   TEXT NOT NULL DEFAULT 'setup',
      status          TEXT NOT NULL DEFAULT 'active',
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_novel_projects_status ON novel_projects(status);`,
  },
  {
    // 小说章节表
    id: '014_create_novel_chapters',
    sql: `CREATE TABLE IF NOT EXISTS novel_chapters (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      volume          INTEGER NOT NULL,
      chapter_number  INTEGER NOT NULL,
      title           TEXT NOT NULL DEFAULT '',
      content         TEXT NOT NULL DEFAULT '',
      word_count      INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'planned',
      narrative_task  TEXT NOT NULL DEFAULT '',
      acceptance_result TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_chapters_project ON novel_chapters(project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_chapters_project_chapter ON novel_chapters(project_id, chapter_number);`,
  },
  {
    // 小说角色表
    id: '015_create_novel_characters',
    sql: `CREATE TABLE IF NOT EXISTS novel_characters (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      name            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      identity        TEXT NOT NULL DEFAULT '',
      personality     TEXT NOT NULL DEFAULT '',
      appearance      TEXT NOT NULL DEFAULT '',
      current_state   TEXT NOT NULL DEFAULT '',
      current_goal    TEXT NOT NULL DEFAULT '',
      current_pressure TEXT NOT NULL DEFAULT '',
      secret          TEXT NOT NULL DEFAULT '',
      arc_stage      TEXT NOT NULL DEFAULT '',
      arc_history     TEXT NOT NULL DEFAULT '[]',
      speech_style    TEXT NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_characters_project ON novel_characters(project_id);`,
  },
  {
    // 角色关系表
    id: '016_create_novel_relationships',
    sql: `CREATE TABLE IF NOT EXISTS novel_relationships (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      character_a     TEXT NOT NULL,
      character_b     TEXT NOT NULL,
      relation_type   TEXT NOT NULL,
      current_stage   TEXT NOT NULL DEFAULT '',
      stage_history   TEXT NOT NULL DEFAULT '[]',
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_relationships_project ON novel_relationships(project_id);`,
  },
  {
    // 伏笔表
    id: '017_create_novel_foreshadowing',
    sql: `CREATE TABLE IF NOT EXISTS novel_foreshadowing (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      description     TEXT NOT NULL,
      category        TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'planned',
      first_chapter   INTEGER,
      last_chapter    INTEGER,
      recover_by_chapter INTEGER,
      linked_characters TEXT NOT NULL DEFAULT '[]',
      linked_clues     TEXT NOT NULL DEFAULT '[]',
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_foreshadowing_project ON novel_foreshadowing(project_id);
    CREATE INDEX IF NOT EXISTS idx_novel_foreshadowing_status ON novel_foreshadowing(status);`,
  },
  {
    // 线索表
    id: '018_create_novel_clues',
    sql: `CREATE TABLE IF NOT EXISTS novel_clues (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      description     TEXT NOT NULL,
      points_to       TEXT NOT NULL DEFAULT '',
      progress        INTEGER NOT NULL DEFAULT 0,
      current_step    TEXT NOT NULL DEFAULT '',
      next_step       TEXT NOT NULL DEFAULT '',
      is_misleading   INTEGER NOT NULL DEFAULT 0,
      linked_foreshadow TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_clues_project ON novel_clues(project_id);`,
  },
  {
    // 冲突表
    id: '019_create_novel_conflicts',
    sql: `CREATE TABLE IF NOT EXISTS novel_conflicts (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      description     TEXT NOT NULL,
      type            TEXT NOT NULL,
      intensity       INTEGER NOT NULL DEFAULT 5,
      stage           TEXT NOT NULL DEFAULT 'latent',
      participants    TEXT NOT NULL DEFAULT '[]',
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_conflicts_project ON novel_conflicts(project_id);`,
  },
  {
    // 世界规则表
    id: '020_create_novel_world_rules',
    sql: `CREATE TABLE IF NOT EXISTS novel_world_rules (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      category        TEXT NOT NULL,
      rule            TEXT NOT NULL,
      cost            TEXT,
      is_fixed        INTEGER NOT NULL DEFAULT 1,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_world_rules_project ON novel_world_rules(project_id);`,
  },
  {
    // 创作约束表
    id: '021_create_novel_constraints',
    sql: `CREATE TABLE IF NOT EXISTS novel_constraints (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      type            TEXT NOT NULL,
      scope           TEXT NOT NULL DEFAULT 'global',
      rule            TEXT NOT NULL,
      is_active       INTEGER NOT NULL DEFAULT 1,
      related_entity_id TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_constraints_project ON novel_constraints(project_id);`,
  },
  {
    // 信息差表
    id: '022_create_novel_information_layers',
    sql: `CREATE TABLE IF NOT EXISTS novel_information_layers (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      info_description TEXT NOT NULL,
      author_knows    INTEGER NOT NULL DEFAULT 1,
      reader_knows    INTEGER NOT NULL DEFAULT 0,
      character_knowledge TEXT NOT NULL DEFAULT '{}',
      reveal_stage    TEXT,
      reveal_chapter  INTEGER,
      is_revealed      INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_info_layers_project ON novel_information_layers(project_id);`,
  },
  {
    // 风格指南表
    id: '023_create_novel_style_guides',
    sql: `CREATE TABLE IF NOT EXISTS novel_style_guides (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      category        TEXT NOT NULL,
      rule            TEXT NOT NULL,
      example         TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_style_guides_project ON novel_style_guides(project_id);`,
  },
  {
    // 作者意图表
    id: '024_create_novel_author_intents',
    sql: `CREATE TABLE IF NOT EXISTS novel_author_intents (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      chapter_id      TEXT,
      intent_type     TEXT NOT NULL,
      description     TEXT NOT NULL,
      target_entity_id TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_intents_project ON novel_author_intents(project_id);`,
  },
  {
    // 章节验收表
    id: '025_create_novel_chapter_reviews',
    sql: `CREATE TABLE IF NOT EXISTS novel_chapter_reviews (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      chapter_id      TEXT NOT NULL,
      consistency_score REAL,
      character_score REAL,
      task_completion_score REAL,
      clue_progress_score REAL,
      foreshadow_status_score REAL,
      conflict_change_score REAL,
      pacing_score REAL,
      info_control_score REAL,
      reader_hook_score REAL,
      style_score REAL,
      overall_score REAL,
      verdict        TEXT,
      issues          TEXT,
      suggestions     TEXT,
      reviewed_by     TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE,
      FOREIGN KEY (chapter_id) REFERENCES novel_chapters(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_reviews_chapter ON novel_chapter_reviews(chapter_id);`,
  },
  {
    // 提示词模板表（PromptManager 运行时覆盖）
    id: '026_create_novel_prompt_templates',
    sql: `CREATE TABLE IF NOT EXISTS novel_prompt_templates (
      id              TEXT PRIMARY KEY,
      project_id      TEXT,
      name            TEXT NOT NULL,
      content         TEXT NOT NULL,
      description     TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_novel_prompt_templates_name ON novel_prompt_templates(name);
    CREATE INDEX IF NOT EXISTS idx_novel_prompt_templates_project ON novel_prompt_templates(project_id);`,
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
