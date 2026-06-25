/**
 * 小说创作系统数据库迁移
 *
 * 从 core/db/migrations.ts 提取的 013-026 迁移，
 * 由 novel-plugin 在 setup 时通过 context.registerMigration 注册。
 *
 * 所有迁移使用 IF NOT EXISTS 保证幂等，可安全重复执行。
 */

import type { MigrationDefinition } from '../../core/plugin/plugin-types.js'

export const novelMigrations: MigrationDefinition[] = [
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
  {
    // 节点位置表（前端画布节点坐标持久化）
    id: '027_create_novel_node_positions',
    sql: `CREATE TABLE IF NOT EXISTS novel_node_positions (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      node_type   TEXT NOT NULL,
      entity_id   TEXT NOT NULL,
      pos_x       REAL NOT NULL,
      pos_y       REAL NOT NULL,
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(project_id, node_type, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_node_positions_project ON novel_node_positions(project_id);`,
  },
  {
    // 角色状态变更历史表
    id: '028_create_novel_character_history',
    sql: `CREATE TABLE IF NOT EXISTS novel_character_history (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      character_id    TEXT NOT NULL,
      chapter_id      TEXT,
      chapter_number  INTEGER,
      field_name      TEXT NOT NULL,
      old_value       TEXT,
      new_value       TEXT,
      reason          TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_char_history_character ON novel_character_history(character_id);
    CREATE INDEX IF NOT EXISTS idx_char_history_project ON novel_character_history(project_id);`,
  },
]
