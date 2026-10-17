/**
 * 小说创作系统数据库迁移
 *
 * 从 core/db/migrations.ts 提取的 013-026 迁移，
 * 由 novel-plugin 在 setup 时通过 context.registerMigration 注册。
 *
 * 所有迁移使用 IF NOT EXISTS 保证幂等，可安全重复执行。
 */

import type { MigrationDefinition } from '../../core/plugin/plugin-types.js'
import type Database from 'better-sqlite3'

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>)
      .map((row) => row.name),
  )
}

/**
 * 084 之前的版本已经使用过 novel_scenes / novel_storylines，但列模型不同。
 * 084 因索引命中旧列而回滚时，schema_migrations 不会留下 084；后续迁移仍会继续，
 * 最终形成“099 已执行但 V2 计划表不存在”的半升级库。先把旧表改名保留，再创建 V2 表。
 */
function archiveLegacyScenePlanTables(db: Database.Database): void {
  if (tableExists(db, 'novel_scenes') && !tableColumns(db, 'novel_scenes').has('chapter_id')) {
    db.exec('ALTER TABLE novel_scenes RENAME TO novel_scenes_legacy_v1')
  }
  if (tableExists(db, 'novel_storylines') && !tableColumns(db, 'novel_storylines').has('lifecycle')) {
    db.exec('ALTER TABLE novel_storylines RENAME TO novel_storylines_legacy_v1')
  }
}

function backfillLegacyScenePlanTables(db: Database.Database): void {
  if (tableExists(db, 'novel_scenes_legacy_v1')) {
    db.exec(`
      INSERT OR IGNORE INTO novel_scenes (id, chapter_id, project_id, stable_key, created_at)
      SELECT legacy.id,
             chapter.id,
             legacy.project_id,
             'legacy-' || CAST(legacy.chapter_number AS TEXT) || '-' || CAST(legacy.scene_order AS TEXT),
             legacy.created_at
      FROM novel_scenes_legacy_v1 legacy
      JOIN novel_chapters chapter
        ON chapter.project_id = legacy.project_id
       AND chapter.chapter_number = legacy.chapter_number
    `)
  }
  if (tableExists(db, 'novel_storylines_legacy_v1')) {
    db.exec(`
      INSERT OR IGNORE INTO novel_storylines (
        id, project_id, name, kind, lifecycle, maturity, description, created_at, updated_at
      )
      SELECT id,
             project_id,
             name,
             COALESCE(kind, 'subplot'),
             CASE status
               WHEN 'active' THEN 'active'
               WHEN 'resolved' THEN 'resolved'
               WHEN 'abandoned' THEN 'abandoned'
               ELSE 'paused'
             END,
             CASE maturity WHEN 'established' THEN 'established' ELSE 'candidate' END,
             COALESCE(description, ''),
             created_at,
             updated_at
      FROM novel_storylines_legacy_v1
    `)
  }
}

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
    CREATE INDEX IF NOT EXISTS idx_novel_projects_status ON novel_projects(status);`
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_chapters_project_chapter ON novel_chapters(project_id, chapter_number);`
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
    CREATE INDEX IF NOT EXISTS idx_novel_characters_project ON novel_characters(project_id);`
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
    CREATE INDEX IF NOT EXISTS idx_novel_relationships_project ON novel_relationships(project_id);`
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
    CREATE INDEX IF NOT EXISTS idx_novel_foreshadowing_status ON novel_foreshadowing(status);`
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
    CREATE INDEX IF NOT EXISTS idx_novel_clues_project ON novel_clues(project_id);`
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
    CREATE INDEX IF NOT EXISTS idx_novel_conflicts_project ON novel_conflicts(project_id);`
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
    CREATE INDEX IF NOT EXISTS idx_novel_world_rules_project ON novel_world_rules(project_id);`
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
    CREATE INDEX IF NOT EXISTS idx_novel_constraints_project ON novel_constraints(project_id);`
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
    CREATE INDEX IF NOT EXISTS idx_novel_info_layers_project ON novel_information_layers(project_id);`
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
    CREATE INDEX IF NOT EXISTS idx_novel_style_guides_project ON novel_style_guides(project_id);`
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
    CREATE INDEX IF NOT EXISTS idx_novel_intents_project ON novel_author_intents(project_id);`
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
    CREATE INDEX IF NOT EXISTS idx_novel_reviews_chapter ON novel_chapter_reviews(chapter_id);`
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
    CREATE INDEX IF NOT EXISTS idx_novel_prompt_templates_project ON novel_prompt_templates(project_id);`
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
    CREATE INDEX IF NOT EXISTS idx_node_positions_project ON novel_node_positions(project_id);`
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
    CREATE INDEX IF NOT EXISTS idx_char_history_project ON novel_character_history(project_id);`
  },
  {
    // 长期记忆事件表（情景记忆：跨章节的事件/状态变更时间线 + 因果链）
    id: '029_create_novel_memory',
    sql: `CREATE TABLE IF NOT EXISTS novel_memory_events (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      chapter_id      TEXT,
      chapter_number  INTEGER NOT NULL,
      event_type      TEXT NOT NULL,
      entity_id       TEXT NOT NULL,
      entity_type     TEXT NOT NULL,
      description     TEXT NOT NULL,
      old_value       TEXT,
      new_value       TEXT,
      cause           TEXT,
      effect_ids      TEXT,
      significance    INTEGER DEFAULT 5,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_memory_events_project ON novel_memory_events(project_id);
    CREATE INDEX IF NOT EXISTS idx_memory_events_chapter ON novel_memory_events(chapter_number);
    CREATE INDEX IF NOT EXISTS idx_memory_events_entity ON novel_memory_events(entity_id);
    CREATE INDEX IF NOT EXISTS idx_memory_events_type ON novel_memory_events(event_type);

    CREATE TABLE IF NOT EXISTS novel_memory_snapshots (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      chapter_number  INTEGER NOT NULL,
      snapshot_type   TEXT NOT NULL,
      entity_id       TEXT,
      snapshot_data   TEXT NOT NULL,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_memory_snapshots_project ON novel_memory_snapshots(project_id);
    CREATE INDEX IF NOT EXISTS idx_memory_snapshots_chapter ON novel_memory_snapshots(chapter_number);`
  },
  {
    // 势力表（组织/门派/王国/家族/公会/邪教）
    id: '030_create_novel_factions',
    sql: `CREATE TABLE IF NOT EXISTS novel_factions (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      name            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      type            TEXT NOT NULL DEFAULT 'organization',
      leader_id       TEXT,
      ideology        TEXT NOT NULL DEFAULT '',
      strength        TEXT NOT NULL DEFAULT 'medium',
      resources       TEXT NOT NULL DEFAULT '[]',
      allies          TEXT NOT NULL DEFAULT '[]',
      enemies         TEXT NOT NULL DEFAULT '[]',
      status          TEXT NOT NULL DEFAULT 'active',
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_factions_project ON novel_factions(project_id);`
  },
  {
    // 地点表（大陆/国家/城市/建筑/地下城/区域/荒野），自引用构建层级树
    id: '031_create_novel_locations',
    sql: `CREATE TABLE IF NOT EXISTS novel_locations (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      name            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      type            TEXT NOT NULL DEFAULT 'city',
      parent_id       TEXT,
      faction_id      TEXT,
      significance    TEXT NOT NULL DEFAULT 'minor',
      first_chapter   INTEGER,
      status          TEXT NOT NULL DEFAULT 'normal',
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_locations_project ON novel_locations(project_id);
    CREATE INDEX IF NOT EXISTS idx_novel_locations_parent ON novel_locations(parent_id);`
  },
  {
    // 世界观结构化要素表（力量体系/历史/文化/宗教/科技/经济/地理）
    id: '032_create_novel_world_elements',
    sql: `CREATE TABLE IF NOT EXISTS novel_world_elements (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      category        TEXT NOT NULL,
      name            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      parent_id       TEXT,
      attributes      TEXT NOT NULL DEFAULT '{}',
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_world_elements_project ON novel_world_elements(project_id);
    CREATE INDEX IF NOT EXISTS idx_novel_world_elements_category ON novel_world_elements(category);`
  },
  {
    // 画布连线表（手动连线的持久化 + 自动边存储）
    // source_type/target_type: character/chapter/conflict/foreshadow/faction/location/world_element/group
    // edge_type: appearance/relationship/involvement/foreshadow/base/member/hierarchy/association
    // auto: 0=手动创建, 1=自动生成
    id: '033_create_novel_edges',
    sql: `CREATE TABLE IF NOT EXISTS novel_edges (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      source_id       TEXT NOT NULL,
      source_type     TEXT NOT NULL,
      target_id       TEXT NOT NULL,
      target_type     TEXT NOT NULL,
      edge_type       TEXT NOT NULL,
      label           TEXT NOT NULL DEFAULT '',
      auto            INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_edges_project ON novel_edges(project_id);
    CREATE INDEX IF NOT EXISTS idx_novel_edges_source ON novel_edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_novel_edges_target ON novel_edges(target_id);`
  },
  {
    // Agent 调用日志表（记录每次 Agent 调用的完整上下文：系统提示词/章节上下文/任务指令/工具/结果）
    // 用于调试提示词构建、排查 Agent 行为、审计创作流程
    id: '034_create_novel_agent_logs',
    sql: `CREATE TABLE IF NOT EXISTS novel_agent_logs (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      chapter_number  INTEGER NOT NULL,
      agent_type      TEXT NOT NULL,
      agent_name      TEXT NOT NULL DEFAULT '',
      display_agent_type TEXT NOT NULL DEFAULT '',
      display_agent_name TEXT NOT NULL DEFAULT '',
      phase           TEXT NOT NULL DEFAULT '',
      system_prompt   TEXT NOT NULL DEFAULT '',
      chapter_context TEXT NOT NULL DEFAULT '',
      user_message    TEXT NOT NULL DEFAULT '',
      task_input      TEXT NOT NULL DEFAULT '',
      user_instructions TEXT NOT NULL DEFAULT '[]',
      tools           TEXT NOT NULL DEFAULT '[]',
      tool_names      TEXT NOT NULL DEFAULT '[]',
      result          TEXT NOT NULL DEFAULT '',
      result_length   INTEGER NOT NULL DEFAULT 0,
      duration_ms     INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'success',
      error           TEXT NOT NULL DEFAULT '',
      session_id      TEXT NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_novel_agent_logs_project ON novel_agent_logs(project_id);
    CREATE INDEX IF NOT EXISTS idx_novel_agent_logs_chapter ON novel_agent_logs(project_id, chapter_number);
    CREATE INDEX IF NOT EXISTS idx_novel_agent_logs_agent ON novel_agent_logs(project_id, agent_type);
    CREATE INDEX IF NOT EXISTS idx_novel_agent_logs_created ON novel_agent_logs(created_at DESC);`
  },
  {
    // 035: 扩展冲突表，支持章节区间 + 层级分类
    id: '035_extend_novel_conflicts',
    sql: `ALTER TABLE novel_conflicts ADD COLUMN first_chapter INTEGER;
          ALTER TABLE novel_conflicts ADD COLUMN last_chapter INTEGER;
          ALTER TABLE novel_conflicts ADD COLUMN tier TEXT NOT NULL DEFAULT 'secondary';`
  },
  {
    // 036: 扩展势力表，支持章节区间
    id: '036_extend_novel_factions',
    sql: `ALTER TABLE novel_factions ADD COLUMN first_chapter INTEGER;
          ALTER TABLE novel_factions ADD COLUMN last_chapter INTEGER;`
  },
  {
    // 037: 扩展地点表，支持多次出现
    id: '037_extend_novel_locations',
    sql: `ALTER TABLE novel_locations ADD COLUMN appear_chapters TEXT NOT NULL DEFAULT '[]';`
  },
  {
    // 038: 扩展角色表，标记主角
    id: '038_extend_novel_characters',
    sql: `ALTER TABLE novel_characters ADD COLUMN is_protagonist INTEGER NOT NULL DEFAULT 0;`
  },
  {
    // 时间轴标记表
    id: '039_create_novel_markers',
    sql: `CREATE TABLE IF NOT EXISTS novel_markers (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      chapter         INTEGER NOT NULL,
      title           TEXT NOT NULL DEFAULT '',
      note            TEXT NOT NULL DEFAULT '',
      type            TEXT NOT NULL DEFAULT 'bookmark',
      color           TEXT NOT NULL DEFAULT 'blue',
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_markers_project ON novel_markers(project_id);`
  },
  {
    // 040: 扩展标记表，支持片段批注关联实体
    id: '040_extend_novel_markers_clip_note',
    sql: `ALTER TABLE novel_markers ADD COLUMN entity_type TEXT;
          ALTER TABLE novel_markers ADD COLUMN entity_id TEXT;`
  },
  {
    // 041: 全书大纲字段 + 卷表
    id: '041_create_novel_volumes_and_outline',
    sql: `ALTER TABLE novel_projects ADD COLUMN outline TEXT NOT NULL DEFAULT '';
          CREATE TABLE IF NOT EXISTS novel_volumes (
            id              TEXT PRIMARY KEY,
            project_id      TEXT NOT NULL,
            volume_number   INTEGER NOT NULL,
            title           TEXT NOT NULL DEFAULT '',
            outline         TEXT NOT NULL DEFAULT '',
            sort_order      INTEGER NOT NULL DEFAULT 0,
            created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
            FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_novel_volumes_project ON novel_volumes(project_id);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_volumes_project_number ON novel_volumes(project_id, volume_number);`
  },
  {
    // 042: 章节加 outline + volume_id
    id: '042_extend_novel_chapters_outline',
    sql: `ALTER TABLE novel_chapters ADD COLUMN outline TEXT NOT NULL DEFAULT '';
          ALTER TABLE novel_chapters ADD COLUMN volume_id TEXT;`
  },
  {
    // 043: 数据回填——按 project 的 distinct chapter.volume 建 volume 记录并回填 volume_id
    id: '043_backfill_novel_volumes',
    sql: `INSERT OR IGNORE INTO novel_volumes (id, project_id, volume_number, title, outline, sort_order, created_at, updated_at)
          SELECT lower(hex(randomblob(16))), project_id, volume, '第' || volume || '卷', '', volume, unixepoch(), unixepoch()
          FROM (SELECT DISTINCT project_id, volume FROM novel_chapters WHERE volume_id IS NULL)
          WHERE volume IS NOT NULL;
          UPDATE novel_chapters
          SET volume_id = (SELECT v.id FROM novel_volumes v
                           WHERE v.project_id = novel_chapters.project_id
                             AND v.volume_number = novel_chapters.volume)
          WHERE volume_id IS NULL AND volume IS NOT NULL;`
  },
  {
    // 小说 Agent 角色温度运行时覆盖表（全局配置，不按 project）
    id: '044_create_novel_agent_config',
    sql: `CREATE TABLE IF NOT EXISTS novel_agent_config (
      agent_type    TEXT PRIMARY KEY,
      temperature   REAL,
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );`
  },
  {
    // 045: conflicts/factions 新增 chapter_spans（JSON 数组 [[start,end],...]）支持非连续跨度
    // first_chapter/last_chapter 保留为兼容字段（不再读写，但保留列避免破坏旧代码）
    id: '045_add_chapter_spans_to_conflicts_factions',
    sql: `ALTER TABLE novel_conflicts ADD COLUMN chapter_spans TEXT;
          ALTER TABLE novel_factions ADD COLUMN chapter_spans TEXT;
          UPDATE novel_conflicts SET chapter_spans =
            CASE WHEN first_chapter IS NULL THEN '[]'
                 ELSE json_array(json_array(first_chapter, COALESCE(last_chapter, first_chapter)))
            END;
          UPDATE novel_factions SET chapter_spans =
            CASE WHEN first_chapter IS NULL THEN '[]'
                 ELSE json_array(json_array(first_chapter, COALESCE(last_chapter, first_chapter)))
            END;`
  },
  {
    // 046: 项目回收站——软删除字段
    // deleted_at 为 NULL 表示正常项目，非 NULL 表示已移入回收站（值为移入时间戳）
    id: '046_add_deleted_at_to_novel_projects',
    sql: `ALTER TABLE novel_projects ADD COLUMN deleted_at INTEGER;`
  },
  {
    // 047: 章节张力曲线（1-10，NULL 表示未设定）
    // 借鉴 PlotPilot TensionLevel：LOW=1 → EXTREME=10 非线性标度
    id: '047_add_tension_to_novel_chapters',
    sql: `ALTER TABLE novel_chapters ADD COLUMN tension INTEGER;`
  },
  {
    // 048: 角色四层逻辑补全（目标层 / 功能层 / 影响层）
    // - long_term_desire: 长期欲望（跨章节稳定的发动机，区别于 current_goal 短期目标）
    // - plot_role: 角色层级（protagonist 主角 / main_opponent 主要对手 / supporting 重要配角 / function 功能配角 / background 背景）
    // - removal_impact: 删掉影响（一句话描述"删掉这个角色哪段剧情会受影响"，回答四层逻辑第四句）
    id: '048_add_character_plot_fields',
    sql: `ALTER TABLE novel_characters ADD COLUMN long_term_desire TEXT NOT NULL DEFAULT '';
          ALTER TABLE novel_characters ADD COLUMN plot_role TEXT NOT NULL DEFAULT 'supporting';
          ALTER TABLE novel_characters ADD COLUMN removal_impact TEXT NOT NULL DEFAULT '';`
  },
  {
    // 049: 关系四层逻辑②动态化（关系层补全）
    // - dynamic_role: 动态功能位（在帮主角什么 / 拦主角什么，一句话描述本关系对剧情的推动作用）
    // - alignment: 阵营关系（ally/temporary_ally/opponent/temporary_opponent/neutral/pending_shift）
    // - trend: 走向（stable/warming/cooling/breaking/reconciling）
    // - chapter_hint: 本章关系约束提示（一句话说明本章关系应如何变化）
    // - last_updated_chapter: 最后一次更新的章节号
    id: '049_add_relationship_dynamic_fields',
    sql: `ALTER TABLE novel_relationships ADD COLUMN dynamic_role TEXT NOT NULL DEFAULT '';
          ALTER TABLE novel_relationships ADD COLUMN alignment TEXT NOT NULL DEFAULT 'neutral';
          ALTER TABLE novel_relationships ADD COLUMN trend TEXT NOT NULL DEFAULT 'stable';
          ALTER TABLE novel_relationships ADD COLUMN chapter_hint TEXT NOT NULL DEFAULT '';
          ALTER TABLE novel_relationships ADD COLUMN last_updated_chapter INTEGER;`
  },
  {
    // 050: 角色反向索引到冲突（四层逻辑④：影响层）
    // - participating_conflicts: JSON: string[]，由冲突 CRUD 时自动同步
    //   回答"删掉这个角色哪段冲突线会断"，与 removal_impact 互补
    id: '050_add_character_participating_conflicts',
    sql: `ALTER TABLE novel_characters ADD COLUMN participating_conflicts TEXT NOT NULL DEFAULT '[]';`
  },
  {
    // 051: 冲突四层逻辑③：功能层 + 推进模式
    // - plot_function: 剧情功能位（复用 PlotFunction 七值枚举，常用 4 值：
    //   amplify_conflict 放大冲突 / open_phase 打开新阶段 /
    //   reveal_world_rule 暴露世界规则 / change_judgment 改变主角判断）
    // - progression_mode: 推进模式（linear/mutation/stagnation/regression/reversal）
    //   默认 'linear'（向后兼容旧数据的线性推进），由 engine.computeConflictTargetStage 分支处理
    id: '051_add_conflict_plot_function_and_progression',
    sql: `ALTER TABLE novel_conflicts ADD COLUMN plot_function TEXT;
          ALTER TABLE novel_conflicts ADD COLUMN progression_mode TEXT NOT NULL DEFAULT 'linear';`
  },
  {
    // 052: 伏笔四层逻辑③：埋设/回收方式结构化
    // - plant_method: 埋设方式（explicit 明写/implicit 暗写/indirect 侧写）
    // - recover_method: 回收方式（explicit 明回收/implicit 暗回收/reverse 反向/progressive 递进）
    // 注意：category 列保持原样（自由字符串），由代码层做容错转换为新枚举 NovelForeshadowCategory，
    // 这样旧数据不会因迁移失败，未匹配的旧 category 在 rowToForeshadow 里回退到 'item'
    id: '052_add_foreshadow_plant_recover_methods',
    sql: `ALTER TABLE novel_foreshadowing ADD COLUMN plant_method TEXT;
          ALTER TABLE novel_foreshadowing ADD COLUMN recover_method TEXT;`
  },
  {
    // 053: 跨实体因果链 — 为 cause 字段建索引，加速 getCausalChain 向上追溯
    // cause 字段存储上游事件 ID，未建索引时反向查询需全表扫描
    id: '053_add_cause_index_to_memory_events',
    sql: `CREATE INDEX IF NOT EXISTS idx_memory_events_cause ON novel_memory_events(cause) WHERE cause IS NOT NULL;`
  },
  {
    // 054: P3-2 打通伏笔↔信息差 — 双向关联字段
    // - novel_foreshadowing 加 linked_info_layers (JSON: string[])：本伏笔承载哪些信息差
    // - novel_information_layers 加 linked_foreshadows (JSON: string[])：本信息差被哪些伏笔承载
    // 双向同步由 NovelStore.linkForeshadowToInfoLayer 维护，删除时由 store 层清理对端
    id: '054_add_foreshadow_infolayer_link_columns',
    sql: `
      ALTER TABLE novel_foreshadowing ADD COLUMN linked_info_layers TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE novel_information_layers ADD COLUMN linked_foreshadows TEXT NOT NULL DEFAULT '[]';
    `
  },
  {
    // 055: 伏笔支持多段章节跨度（与 conflicts/factions 迁移 045 同模式）
    // - novel_foreshadowing 加 chapter_spans (JSON 数组 [[start,end],...])，支持非连续活跃区间
    // - first_chapter 仍作为埋设点语义标记（plant），recover_by_chapter 作为回收点语义标记（payoff）
    // - chapter_spans 描述伏笔"活跃"区间（可多段），矩阵按色带样式渲染（参照 conflict）
    // - first_chapter/last_chapter/recover_by_chapter 保留为兼容字段，store 层读写时与 chapterSpans 同步
    // 旧数据回填：用 [first_chapter, COALESCE(recover_by_chapter, first_chapter)] 单段跨度；
    // 无 first_chapter 的伏笔回填 '[]'（未放置，进元素池）
    id: '055_add_chapter_spans_to_foreshadowing',
    sql: `ALTER TABLE novel_foreshadowing ADD COLUMN chapter_spans TEXT;
          UPDATE novel_foreshadowing SET chapter_spans =
            CASE WHEN first_chapter IS NULL THEN '[]'
                 ELSE json_array(json_array(first_chapter, COALESCE(recover_by_chapter, first_chapter)))
            END;`
  },
  {
    // 056: 章节增加时间线偏移、章尾钩子、前情提要字段
    // - time_offset：相对第1章的天数，用于时间线管理
    // - chapter_ending_hook：章尾钩子类型（suspense/reversal/emotional/action/none）
    // - recap：前情提要（章节完成后自动生成，50-100 字）
    id: '056_add_novel_chapters_timeline_hook_recap',
    sql: `ALTER TABLE novel_chapters ADD COLUMN time_offset INTEGER;
          ALTER TABLE novel_chapters ADD COLUMN chapter_ending_hook TEXT;
          ALTER TABLE novel_chapters ADD COLUMN recap TEXT;`
  },
  {
    // 057: AgentLog 表增加 LLM usage 字段（cache token 诊断）
    // 记录 LLM provider 真实返回的 input/output/cache_read/cache_write tokens，
    // 供 AgentLog 面板展示真实缓存命中率。SQLite 的 ALTER TABLE ADD COLUMN
    // 不支持 IF NOT EXISTS，用 catch 容错（旧库已存在则跳过）。
    id: '057_add_usage_to_novel_agent_logs',
    sql: `ALTER TABLE novel_agent_logs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE novel_agent_logs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE novel_agent_logs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE novel_agent_logs ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE novel_agent_logs ADD COLUMN llm_provider TEXT NOT NULL DEFAULT '';
          ALTER TABLE novel_agent_logs ADD COLUMN llm_model TEXT NOT NULL DEFAULT '';`
  },
  {
    // v0.2：钩子实体表（章末悬念驱动，追踪 thrown→fulfilled 闭环）
    id: '058_create_novel_hooks',
    sql: `CREATE TABLE IF NOT EXISTS novel_hooks (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      chapter_number  INTEGER NOT NULL,
      hook_type       TEXT NOT NULL,
      description     TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'thrown',
      fulfilled_at_chapter INTEGER,
      fulfilled_description TEXT,
      linked_foreshadow_id TEXT,
      linked_conflict_id   TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_hooks_project ON novel_hooks(project_id);
    CREATE INDEX IF NOT EXISTS idx_novel_hooks_status ON novel_hooks(status);
    CREATE INDEX IF NOT EXISTS idx_novel_hooks_chapter ON novel_hooks(chapter_number);`
  },
  {
    // v0.2：角色弧光表（角色内心阶段演进，1:1 关联角色）
    id: '059_create_novel_character_arcs',
    sql: `CREATE TABLE IF NOT EXISTS novel_character_arcs (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      character_id    TEXT NOT NULL,
      arc_type        TEXT NOT NULL,
      current_stage   TEXT NOT NULL,
      stage_history   TEXT NOT NULL DEFAULT '[]',
      description     TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE,
      FOREIGN KEY (character_id) REFERENCES novel_characters(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_arcs_project ON novel_character_arcs(project_id);
    CREATE INDEX IF NOT EXISTS idx_novel_arcs_character ON novel_character_arcs(character_id);`
  },
  {
    // 群聊模式设置（单行表，key-value 式存储）
    id: '060_create_novel_discussion_settings',
    sql: `CREATE TABLE IF NOT EXISTS novel_discussion_settings (
      key           TEXT PRIMARY KEY,
      value         TEXT NOT NULL,
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );`
  },
  {
    id: '061_add_target_platform_to_novel_projects',
    sql: `ALTER TABLE novel_projects ADD COLUMN target_platform TEXT;`
  },
  {
    // 章节聊天消息表（按章节持久化用户输入与 Agent 回复）
    id: '062_create_novel_chapter_chat_messages',
    sql: `CREATE TABLE IF NOT EXISTS novel_chapter_chat_messages (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      chapter_number  INTEGER NOT NULL,
      role            TEXT NOT NULL,
      from_id         TEXT NOT NULL,
      from_name       TEXT NOT NULL,
      content         TEXT NOT NULL,
      phase           TEXT NOT NULL DEFAULT 'free_chat',
      metadata        TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_chapter_chat_project_chapter
      ON novel_chapter_chat_messages(project_id, chapter_number, created_at);`
  },
  {
    // 项目级叙事文风档案（结构化配置 + 正向样本）
    id: '063_create_novel_writing_style_profiles',
    sql: `CREATE TABLE IF NOT EXISTS novel_writing_style_profiles (
      id                    TEXT PRIMARY KEY,
      project_id            TEXT NOT NULL UNIQUE,
      name                  TEXT NOT NULL DEFAULT '默认文风',
      preset                TEXT NOT NULL DEFAULT 'custom',
      narrative_person      TEXT NOT NULL DEFAULT 'third',
      narrative_distance    TEXT NOT NULL DEFAULT 'limited',
      sentence_rhythm       TEXT NOT NULL DEFAULT 'balanced',
      dialogue_ratio        REAL NOT NULL DEFAULT 45,
      emotional_temperature REAL NOT NULL DEFAULT 5,
      imagery_density      REAL NOT NULL DEFAULT 3,
      vocabulary_register   TEXT NOT NULL DEFAULT 'plain',
      hard_rules            TEXT NOT NULL DEFAULT '[]',
      soft_rules            TEXT NOT NULL DEFAULT '[]',
      positive_examples     TEXT NOT NULL DEFAULT '[]',
      notes                 TEXT NOT NULL DEFAULT '',
      version               INTEGER NOT NULL DEFAULT 1,
      created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at            INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_writing_style_profiles_project
      ON novel_writing_style_profiles(project_id);`
  },
  {
    // 群聊运行快照：支持 Writer 阶段失败后从 chapter_weaving 断点续跑
    id: '064_create_novel_discussion_runs',
    sql: `CREATE TABLE IF NOT EXISTS novel_discussion_runs (
      id                    TEXT PRIMARY KEY,
      project_id            TEXT NOT NULL,
      chapter_number        INTEGER NOT NULL,
      status                TEXT NOT NULL,
      failed_phase          TEXT,
      transcript            TEXT NOT NULL DEFAULT '[]',
      scenes                TEXT NOT NULL DEFAULT '[]',
      arranged_entities     TEXT,
      content               TEXT,
      error                 TEXT,
      resumed_from_run_id   TEXT,
      created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at            INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_discussion_runs_chapter
      ON novel_discussion_runs(project_id, chapter_number, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_novel_discussion_runs_resumed_from
      ON novel_discussion_runs(resumed_from_run_id);`
  },
  {
    // 伏笔事件链：只保存实际发生的埋设/强化/揭示/回收节点，不再用连续跨度表达伏笔生命周期
    id: '065_add_foreshadow_beats',
    sql: `ALTER TABLE novel_foreshadowing ADD COLUMN beats TEXT NOT NULL DEFAULT '[]';`
  },
  {
    // 章节正文版本历史：每次正文覆盖前自动存档，支持版本列表、diff、回滚。
    // 章节删除时版本通过 ON DELETE CASCADE 自动清理。
    id: '066_create_novel_chapter_versions',
    sql: `CREATE TABLE IF NOT EXISTS novel_chapter_versions (
      id          TEXT PRIMARY KEY,
      chapter_id  TEXT NOT NULL,
      project_id  TEXT NOT NULL,
      content     TEXT NOT NULL,
      word_count  INTEGER NOT NULL,
      phase       TEXT,
      agent_type  TEXT,
      trigger     TEXT,
      sequence    INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      FOREIGN KEY (chapter_id) REFERENCES novel_chapters(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chapter_versions_chapter ON novel_chapter_versions(chapter_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_chapter_versions_project ON novel_chapter_versions(project_id, created_at);`
  },
  {
    // 章节六型定位。此前共享类型和 Director 提示词已有 positioning，
    // 但数据库未落列，导致矩阵/Director 规划无法传到 Writer 约束。
    id: '067_add_novel_chapter_positioning',
    sql: `ALTER TABLE novel_chapters ADD COLUMN positioning TEXT;`
  },
  {
    // 线索在矩阵中的章节节点。与冲突/势力保持同一数据形式，
    // 但语义是“本章发现或推进过该线索”，而非线索全生命周期。
    id: '068_add_clue_chapter_spans',
    sql: `ALTER TABLE novel_clues ADD COLUMN chapter_spans TEXT NOT NULL DEFAULT '[]';`
  },
  {
    // 文风反例：与正向样本一起形成可回归的项目级质量基线。
    id: '069_add_writing_style_negative_examples',
    sql: `ALTER TABLE novel_writing_style_profiles ADD COLUMN negative_examples TEXT NOT NULL DEFAULT '[]';`
  },
  {
    // 物品表：追踪角色拥有的关键物品（玉佩/法器/武器/钥匙等），
    // 用于跨章节一致性（物品在哪章获得/使用/转手）和提示词注入。
    id: '070_create_novel_items',
    sql: `CREATE TABLE IF NOT EXISTS novel_items (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      name            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      type            TEXT NOT NULL DEFAULT 'misc',
      owner_id        TEXT,
      status          TEXT NOT NULL DEFAULT 'active',
      abilities       TEXT NOT NULL DEFAULT '',
      origin          TEXT NOT NULL DEFAULT '',
      first_chapter   INTEGER,
      chapter_spans   TEXT NOT NULL DEFAULT '[]',
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_items_project ON novel_items(project_id);
    CREATE INDEX IF NOT EXISTS idx_novel_items_owner ON novel_items(owner_id);`
  },
  {
    // 071: 冲突推进粒度字段
    // stage 只有 7 个粗粒度值（latent/emerging/.../transformed），无法承载
    // "已出现图案"vs"已验证图案"这类细粒度推进点。每次 memory-generator 即使
    // 推进了剧情，updateConflict 也只能写 stage（粗状态不变），下一章上下文仍
    // 输出同一个粗状态，导致 Writer/Director 反复"验证穴位是否存在"。
    // current_step / next_step 类比 novel_clues.current_step/next_step：
    // - current_step: 当前进展（一句话描述本章推进到哪一步）
    // - next_step: 下一步（一句话描述下章应推进的方向）
    id: '071_add_conflict_current_next_step',
    sql: `ALTER TABLE novel_conflicts ADD COLUMN current_step TEXT NOT NULL DEFAULT '';
          ALTER TABLE novel_conflicts ADD COLUMN next_step TEXT NOT NULL DEFAULT '';`
  },
  {
    // 072: 故事事件账本、变化记录扩展和统一批注。
    // 现有实体表继续保存当前快照；memory_events 增加结构化维度，
    // 新事件表负责把同一场景中的多条变化聚合起来。
    id: '072_create_story_ledger',
    sql: `CREATE TABLE IF NOT EXISTS novel_story_events (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      chapter_number  INTEGER NOT NULL,
      scene_id        TEXT,
      scene_order     INTEGER NOT NULL DEFAULT 0,
      type            TEXT NOT NULL,
      title           TEXT NOT NULL DEFAULT '',
      summary         TEXT NOT NULL DEFAULT '',
      outcome         TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'planned',
      parent_event_id TEXT,
      source          TEXT NOT NULL DEFAULT 'manual',
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_event_id) REFERENCES novel_story_events(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_story_events_project_chapter
      ON novel_story_events(project_id, chapter_number, scene_order);
    CREATE INDEX IF NOT EXISTS idx_story_events_parent
      ON novel_story_events(parent_event_id);

    CREATE TABLE IF NOT EXISTS novel_story_event_entities (
      id              TEXT PRIMARY KEY,
      event_id        TEXT NOT NULL,
      entity_type     TEXT NOT NULL,
      entity_id       TEXT NOT NULL,
      role            TEXT NOT NULL,
      note            TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (event_id) REFERENCES novel_story_events(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_story_event_entities_event
      ON novel_story_event_entities(event_id);
    CREATE INDEX IF NOT EXISTS idx_story_event_entities_entity
      ON novel_story_event_entities(entity_type, entity_id);

    ALTER TABLE novel_memory_events ADD COLUMN story_event_id TEXT;
    ALTER TABLE novel_memory_events ADD COLUMN scene_order INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE novel_memory_events ADD COLUMN dimension TEXT;
    ALTER TABLE novel_memory_events ADD COLUMN target_entity_type TEXT;
    ALTER TABLE novel_memory_events ADD COLUMN target_entity_id TEXT;
    ALTER TABLE novel_memory_events ADD COLUMN value_type TEXT;
    ALTER TABLE novel_memory_events ADD COLUMN source TEXT NOT NULL DEFAULT 'migration';
    CREATE INDEX IF NOT EXISTS idx_memory_events_story_event
      ON novel_memory_events(story_event_id);
    CREATE INDEX IF NOT EXISTS idx_memory_events_dimension
      ON novel_memory_events(project_id, entity_id, dimension, chapter_number, scene_order);

    CREATE TABLE IF NOT EXISTS novel_annotations (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      scope_type      TEXT NOT NULL,
      scope_id        TEXT,
      entity_type     TEXT,
      entity_id       TEXT,
      chapter_start   INTEGER,
      chapter_end     INTEGER,
      kind            TEXT NOT NULL DEFAULT 'note',
      content         TEXT NOT NULL,
      color           TEXT NOT NULL DEFAULT 'blue',
      include_in_prompt INTEGER NOT NULL DEFAULT 0,
      resolved        INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_annotations_project_chapter
      ON novel_annotations(project_id, chapter_start, chapter_end);
    CREATE INDEX IF NOT EXISTS idx_novel_annotations_scope
      ON novel_annotations(scope_type, scope_id);
    CREATE INDEX IF NOT EXISTS idx_novel_annotations_entity
      ON novel_annotations(entity_type, entity_id);`
  },
  {
    id: '073_add_style_note_to_memory_events',
    sql: `ALTER TABLE novel_memory_events ADD COLUMN style_note TEXT;`
  },
  {
    // 074: 数据搬运——把 7 类旧关联字段（JSON 数组 / 单 ID）拆解为 novel_edges 行
    // 用 json_each 展开 JSON 数组，单 ID 直接 SELECT，INSERT OR IGNORE 保证幂等
    id: '074_migrate_relations_to_edges',
    sql: `-- 1. foreshadow → character（linked_characters JSON 数组）
INSERT OR IGNORE INTO novel_edges (id, project_id, source_id, source_type, target_id, target_type, edge_type, label, auto)
SELECT lower(hex(randomblob(16))), f.project_id, f.id, 'foreshadow', je.value, 'character', 'related', '关联角色', 1
FROM novel_foreshadowing f, json_each(f.linked_characters) je
WHERE f.linked_characters IS NOT NULL AND f.linked_characters != '[]';

-- 2. foreshadow → clue（linked_clues JSON 数组）
INSERT OR IGNORE INTO novel_edges (id, project_id, source_id, source_type, target_id, target_type, edge_type, label, auto)
SELECT lower(hex(randomblob(16))), f.project_id, f.id, 'foreshadow', je.value, 'clue', 'related', '关联线索', 1
FROM novel_foreshadowing f, json_each(f.linked_clues) je
WHERE f.linked_clues IS NOT NULL AND f.linked_clues != '[]';

-- 3. foreshadow → info_layer（linked_info_layers JSON 数组）
INSERT OR IGNORE INTO novel_edges (id, project_id, source_id, source_type, target_id, target_type, edge_type, label, auto)
SELECT lower(hex(randomblob(16))), f.project_id, f.id, 'foreshadow', je.value, 'info_layer', 'related', '承载信息差', 1
FROM novel_foreshadowing f, json_each(f.linked_info_layers) je
WHERE f.linked_info_layers IS NOT NULL AND f.linked_info_layers != '[]';

-- 4. character → conflict（participating_conflicts JSON 数组）
INSERT OR IGNORE INTO novel_edges (id, project_id, source_id, source_type, target_id, target_type, edge_type, label, auto)
SELECT lower(hex(randomblob(16))), c.project_id, c.id, 'character', je.value, 'conflict', 'related', '参与冲突', 1
FROM novel_characters c, json_each(c.participating_conflicts) je
WHERE c.participating_conflicts IS NOT NULL AND c.participating_conflicts != '[]';

-- 5. clue → foreshadow（linked_foreshadow 单 ID）
INSERT OR IGNORE INTO novel_edges (id, project_id, source_id, source_type, target_id, target_type, edge_type, label, auto)
SELECT lower(hex(randomblob(16))), cl.project_id, cl.id, 'clue', cl.linked_foreshadow, 'foreshadow', 'related', '关联伏笔', 1
FROM novel_clues cl
WHERE cl.linked_foreshadow IS NOT NULL AND cl.linked_foreshadow != '';

-- 6. hook → foreshadow（linked_foreshadow_id 单 ID）
INSERT OR IGNORE INTO novel_edges (id, project_id, source_id, source_type, target_id, target_type, edge_type, label, auto)
SELECT lower(hex(randomblob(16))), h.project_id, h.id, 'hook', h.linked_foreshadow_id, 'foreshadow', 'related', '关联伏笔', 1
FROM novel_hooks h
WHERE h.linked_foreshadow_id IS NOT NULL AND h.linked_foreshadow_id != '';

-- 7. hook → conflict（linked_conflict_id 单 ID）
INSERT OR IGNORE INTO novel_edges (id, project_id, source_id, source_type, target_id, target_type, edge_type, label, auto)
SELECT lower(hex(randomblob(16))), h.project_id, h.id, 'hook', h.linked_conflict_id, 'conflict', 'related', '关联冲突', 1
FROM novel_hooks h
WHERE h.linked_conflict_id IS NOT NULL AND h.linked_conflict_id != '';`
  },
  {
    // 075: 删除已迁移到 novel_edges 的关联字段，并加 UNIQUE 索引防止重复边
    // 必须在 074 搬运完成后执行，否则旧字段数据会丢失
    id: '075_drop_relation_fields_add_unique',
    sql: `ALTER TABLE novel_foreshadowing DROP COLUMN linked_characters;
ALTER TABLE novel_foreshadowing DROP COLUMN linked_clues;
ALTER TABLE novel_foreshadowing DROP COLUMN linked_info_layers;
ALTER TABLE novel_information_layers DROP COLUMN linked_foreshadows;
ALTER TABLE novel_characters DROP COLUMN participating_conflicts;
ALTER TABLE novel_clues DROP COLUMN linked_foreshadow;
ALTER TABLE novel_hooks DROP COLUMN linked_foreshadow_id;
ALTER TABLE novel_hooks DROP COLUMN linked_conflict_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_edges_unique
  ON novel_edges(project_id, source_id, target_id, edge_type);`
  },
  {
    // 076: target_words 从全书目标改为默认每章字数。
    // 迁移按旧逻辑计算实际生效的单章目标，避免已有项目的生成长度突变。
    id: '076_project_target_words_to_chapter_words',
    sql: `UPDATE novel_projects
SET target_words = MIN(5000, MAX(2500, CAST(ROUND(target_words / 1000.0) AS INTEGER)))
WHERE target_words > 0;`
  },
  {
    // 077: agent 日志补 payload 体积计量。
    //
    // 动因：日志原来只记 systemPrompt / chapterContext / userMessage 的字符数，
    // 三者相加约 1 万字符，而同次调用的 inputTokens 是 2~4 万。中文 1 字符通常
    // ≤ 1 token，这个倍数说明有一份体量相当甚至更大的内容被送进去却没有记录。
    // 这几列记录**真正发往 provider 的 payload**：messages / tools 分开计，
    // 并数出一次「Agent 调用」内部实际发生了几次 LLM 往返（工具调用会导致多次，
    // 每次都要重发完整历史）。
    id: '077_agent_logs_payload_metrics',
    sql: `ALTER TABLE novel_agent_logs ADD COLUMN payload_messages_chars INTEGER NOT NULL DEFAULT 0;
ALTER TABLE novel_agent_logs ADD COLUMN payload_tools_chars INTEGER NOT NULL DEFAULT 0;
ALTER TABLE novel_agent_logs ADD COLUMN payload_tool_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE novel_agent_logs ADD COLUMN payload_total_chars INTEGER NOT NULL DEFAULT 0;
ALTER TABLE novel_agent_logs ADD COLUMN llm_round_trips INTEGER NOT NULL DEFAULT 0;`
  },
  {
    // 078: 将 novel_ask_story 的运行快照写入领域日志，支持历史灰度审计。
    // 旧行以 legacy/true 回填，保持 077 payload 字段与既有读写语义不变。
    id: '078_add_ask_story_audit_to_novel_agent_logs',
    sql: `ALTER TABLE novel_agent_logs ADD COLUMN ask_story_policy TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE novel_agent_logs ADD COLUMN ask_story_enabled INTEGER NOT NULL DEFAULT 1;`
  },
  {
    // 079: arranger/memory 聚合日志与单次 provider session 明细建立父子关联。
    id: '079_add_agent_log_operation_parent',
    sql: `ALTER TABLE novel_agent_logs ADD COLUMN parent_log_id TEXT;
ALTER TABLE novel_agent_logs ADD COLUMN operation TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_novel_agent_logs_parent ON novel_agent_logs(parent_log_id);`
  },
  {
    // 080: ask_story rollout is an explicit project setting, not process-global state.
    id: '080_add_project_ask_story_policy',
    sql: `ALTER TABLE novel_projects ADD COLUMN novel_ask_story_policy TEXT;`
  },
  {
    // 081: 参考小说阶段 1 本地分析。原文与创作实体完全隔离，不进入 Prompt/账本。
    id: '081_create_reference_analysis_mvp',
    sql: `CREATE TABLE IF NOT EXISTS novel_reference_sources (
      id                    TEXT PRIMARY KEY,
      project_id            TEXT NOT NULL,
      input_kind            TEXT NOT NULL,
      display_name          TEXT NOT NULL,
      file_format           TEXT NOT NULL,
      file_size             INTEGER NOT NULL,
      original_bytes        BLOB NOT NULL,
      normalized_text       TEXT NOT NULL DEFAULT '',
      original_hash         TEXT NOT NULL,
      normalized_hash       TEXT NOT NULL DEFAULT '',
      encoding              TEXT NOT NULL,
      encoding_confidence   REAL NOT NULL,
      language              TEXT NOT NULL DEFAULT 'zh-CN',
      rights_confirmed      INTEGER NOT NULL DEFAULT 0,
      rights_statement      TEXT,
      rights_confirmed_at   TEXT,
      retention_policy      TEXT NOT NULL DEFAULT 'manual_delete',
      source_text_state     TEXT NOT NULL DEFAULT 'draft',
      parse_status          TEXT NOT NULL DEFAULT 'draft',
      parser_version        TEXT NOT NULL DEFAULT 'reference-parser-v1',
      character_count       INTEGER NOT NULL DEFAULT 0,
      estimated_tokens      INTEGER NOT NULL DEFAULT 0,
      chapter_count         INTEGER NOT NULL DEFAULT 0,
      scene_count           INTEGER NOT NULL DEFAULT 0,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      deleted_at            TEXT,
      purged_at             TEXT,
      version               INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_reference_sources_project_updated
      ON novel_reference_sources(project_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS novel_reference_sections (
      id                    TEXT PRIMARY KEY,
      source_id             TEXT NOT NULL,
      parent_id             TEXT,
      type                  TEXT NOT NULL,
      sort_order            INTEGER NOT NULL,
      title                 TEXT,
      start_offset          INTEGER NOT NULL,
      end_offset            INTEGER NOT NULL,
      character_count       INTEGER NOT NULL,
      estimated_tokens      INTEGER NOT NULL,
      boundary_confidence   REAL NOT NULL,
      content_hash          TEXT NOT NULL,
      included              INTEGER NOT NULL DEFAULT 1,
      exclusion_reason      TEXT,
      warnings_json         TEXT NOT NULL DEFAULT '[]',
      version               INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (source_id) REFERENCES novel_reference_sources(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES novel_reference_sections(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_reference_sections_source_order
      ON novel_reference_sections(source_id, sort_order);

    CREATE TABLE IF NOT EXISTS novel_reference_quality_reports (
      id                    TEXT PRIMARY KEY,
      source_id             TEXT NOT NULL UNIQUE,
      report_json           TEXT NOT NULL,
      generated_at          TEXT NOT NULL,
      FOREIGN KEY (source_id) REFERENCES novel_reference_sources(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS novel_reference_local_reports (
      id                    TEXT PRIMARY KEY,
      source_id             TEXT NOT NULL UNIQUE,
      source_version        INTEGER NOT NULL,
      normalized_hash       TEXT NOT NULL,
      analyzer_version      TEXT NOT NULL,
      report_json           TEXT NOT NULL,
      generated_at          TEXT NOT NULL,
      FOREIGN KEY (source_id) REFERENCES novel_reference_sources(id) ON DELETE CASCADE
    );`
  },
  {
    // 082: 项目级 feature flags（剧情推进模型 V2 灰度开关，JSON 文本列）。
    // 未配置时默认 '{}'；isNovelFeatureEnabled 读取失败安全返回 false，不抛错。
    id: '082_add_novel_projects_feature_flags',
    sql: `ALTER TABLE novel_projects ADD COLUMN feature_flags TEXT NOT NULL DEFAULT '{}';`
  },
  {
    // 083: 不可变正文版本链（剧情推进模型 V2 的 content revision）。
    // 与 novel_chapter_versions（覆盖前快照）语义不同：
    // - 本表记录「每次落库后的完整正文状态」，每次变更追加一条 committed，
    //   旧 committed 标 superseded，novel_chapters.current_content_revision_id 指向当前；
    // - 回滚以目标版本为 parent 创建 rollback_applied 新 committed revision，
    //   不把旧行设为 current，历史不可更新。
    // 迁移期与旧表双写，T05 停旧写后再归档旧表。
    id: '083_create_novel_chapter_content_revisions',
    sql: `
      CREATE TABLE IF NOT EXISTS novel_chapter_content_revisions (
        id                  TEXT PRIMARY KEY,
        chapter_id          TEXT NOT NULL,
        project_id          TEXT NOT NULL,
        parent_revision_id  TEXT,
        revision            INTEGER NOT NULL,
        content             TEXT NOT NULL,
        word_count          INTEGER NOT NULL,
        phase               TEXT,
        agent_type          TEXT,
        trigger             TEXT,
        status              TEXT NOT NULL DEFAULT 'committed',
        created_at          INTEGER NOT NULL,
        FOREIGN KEY (chapter_id) REFERENCES novel_chapters(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_content_revisions_chapter
        ON novel_chapter_content_revisions(chapter_id, revision);
      ALTER TABLE novel_chapters ADD COLUMN current_content_revision_id TEXT;
    `
  },
  {
    // 084: 场景计划与叙事账本（剧情推进模型 V2 的 plan/scene/storyline）。
    // - novel_chapter_plan_revisions：计划的不可变版本链（draft→approved→consumed→confirmed，
    //   任一步可 superseded；上游变化进 stale），带预算解析字段与幂等键。
    // - novel_scenes：场景稳定身份（只存 identity），novel_scene_revisions 存每次版本。
    // - scene focus/presence/functions：多对多关系表（禁止 JSON 数组）。
    // - novel_storylines + novel_storyline_progress：跨场景叙事方向与推进记录。
    // T02b 只建表 + store 层，工作流接入在 T03/T04。
    id: '084_create_scene_plan_and_storyline',
    sql: `
      CREATE TABLE IF NOT EXISTS novel_chapter_plan_revisions (
        id                    TEXT PRIMARY KEY,
        chapter_id            TEXT NOT NULL,
        project_id            TEXT NOT NULL,
        creation_run_id       TEXT,
        supersedes_id         TEXT,
        base_content_revision_id TEXT,
        positioning           TEXT,
        rhythm                TEXT,
        budget                TEXT NOT NULL DEFAULT '{}',
        status                TEXT NOT NULL DEFAULT 'draft',
        revision              INTEGER NOT NULL,
        idempotency_key       TEXT,
        created_at            INTEGER NOT NULL,
        FOREIGN KEY (chapter_id) REFERENCES novel_chapters(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_revisions_chapter_rev
        ON novel_chapter_plan_revisions(chapter_id, revision);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_revisions_idempotency
        ON novel_chapter_plan_revisions(idempotency_key) WHERE idempotency_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS novel_scenes (
        id            TEXT PRIMARY KEY,
        chapter_id    TEXT NOT NULL,
        project_id    TEXT NOT NULL,
        stable_key    TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        FOREIGN KEY (chapter_id) REFERENCES novel_chapters(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_scenes_chapter_key
        ON novel_scenes(chapter_id, stable_key);

      CREATE TABLE IF NOT EXISTS novel_scene_revisions (
        id                    TEXT PRIMARY KEY,
        scene_id              TEXT NOT NULL,
        chapter_id            TEXT NOT NULL,
        project_id            TEXT NOT NULL,
        plan_revision_id      TEXT NOT NULL,
        content_revision_id   TEXT,
        supersedes_id         TEXT,
        order_no              INTEGER NOT NULL,
        title                 TEXT NOT NULL DEFAULT '',
        goal                  TEXT NOT NULL DEFAULT '',
        summary               TEXT NOT NULL DEFAULT '',
        location_text         TEXT NOT NULL DEFAULT '',
        time_text             TEXT NOT NULL DEFAULT '',
        pov_mode              TEXT NOT NULL DEFAULT 'single',
        pov_character_id      TEXT,
        target_words          INTEGER NOT NULL DEFAULT 0,
        status                TEXT NOT NULL DEFAULT 'planned',
        created_at            INTEGER NOT NULL,
        FOREIGN KEY (scene_id) REFERENCES novel_scenes(id) ON DELETE CASCADE,
        FOREIGN KEY (plan_revision_id) REFERENCES novel_chapter_plan_revisions(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_scene_revisions_plan_order
        ON novel_scene_revisions(plan_revision_id, order_no);
      CREATE INDEX IF NOT EXISTS idx_scene_revisions_scene
        ON novel_scene_revisions(scene_id, created_at);

      CREATE TABLE IF NOT EXISTS novel_scene_focus (
        scene_revision_id TEXT NOT NULL,
        character_id      TEXT NOT NULL,
        PRIMARY KEY (scene_revision_id, character_id),
        FOREIGN KEY (scene_revision_id) REFERENCES novel_scene_revisions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS novel_scene_presence (
        scene_revision_id TEXT NOT NULL,
        character_id      TEXT NOT NULL,
        PRIMARY KEY (scene_revision_id, character_id),
        FOREIGN KEY (scene_revision_id) REFERENCES novel_scene_revisions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS novel_scene_functions (
        scene_revision_id TEXT NOT NULL,
        character_id      TEXT NOT NULL,
        function          TEXT NOT NULL,
        prominence        TEXT NOT NULL DEFAULT 'brief',
        note              TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (scene_revision_id, character_id, function),
        FOREIGN KEY (scene_revision_id) REFERENCES novel_scene_revisions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS novel_storylines (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL,
        name          TEXT NOT NULL,
        kind          TEXT NOT NULL DEFAULT 'main',
        lifecycle     TEXT NOT NULL DEFAULT 'active',
        maturity      TEXT NOT NULL DEFAULT 'candidate',
        description   TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_storylines_project_name
        ON novel_storylines(project_id, name);

      CREATE TABLE IF NOT EXISTS novel_storyline_progress (
        id                  TEXT PRIMARY KEY,
        project_id          TEXT NOT NULL,
        storyline_id        TEXT NOT NULL,
        scene_revision_id   TEXT NOT NULL,
        primary_flag        INTEGER NOT NULL DEFAULT 0,
        type                TEXT NOT NULL DEFAULT 'advance',
        before_state        TEXT NOT NULL DEFAULT '',
        after_state         TEXT NOT NULL DEFAULT '',
        summary             TEXT NOT NULL DEFAULT '',
        status              TEXT NOT NULL DEFAULT 'confirmed',
        created_at          INTEGER NOT NULL,
        FOREIGN KEY (storyline_id) REFERENCES novel_storylines(id) ON DELETE CASCADE,
        FOREIGN KEY (scene_revision_id) REFERENCES novel_scene_revisions(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_progress_scene_storyline
        ON novel_storyline_progress(scene_revision_id, storyline_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_progress_scene_primary
        ON novel_storyline_progress(scene_revision_id) WHERE primary_flag = 1;
    `
  },
  {
    // 085: Memory 新实体候选与审核（用户已确认决策：新 Conflict/Clue 一律 needs_review，
    // 前端提示确认后才晋升正式实体；拒绝必须记录非空 reason 与审计上下文）。
    id: '085_create_entity_candidates',
    sql: `
      CREATE TABLE IF NOT EXISTS novel_entity_candidates (
        id                  TEXT PRIMARY KEY,
        project_id          TEXT NOT NULL,
        chapter_number      INTEGER,
        content_revision_id TEXT,
        entity_type         TEXT NOT NULL,
        payload             TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'needs_review',
        reason_code         TEXT,
        created_at          INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_entity_candidates_project_status
        ON novel_entity_candidates(project_id, status);

      CREATE TABLE IF NOT EXISTS novel_entity_candidate_reviews (
        id             TEXT PRIMARY KEY,
        candidate_id   TEXT NOT NULL,
        decision       TEXT NOT NULL,
        reason         TEXT NOT NULL DEFAULT '',
        actor_id       TEXT NOT NULL DEFAULT 'user',
        audit_context  TEXT NOT NULL DEFAULT '{}',
        created_at     INTEGER NOT NULL,
        FOREIGN KEY (candidate_id) REFERENCES novel_entity_candidates(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_candidate_reviews_candidate
        ON novel_entity_candidate_reviews(candidate_id, created_at);
    `
  },
  {
    // 086: 剧情（narrative）实体轨道。承接冲突/线索/伏笔装不下的"剧情相关"内容
    // （推进/转折/悬念/收束/铺垫/揭示等），Memory 分流后不再把剧情硬塞进冲突/线索/伏笔。
    // 与 conflict 同模式的 chapter_spans 跨度，参与矩阵投影作为独立轨道。
    id: '086_create_novel_narratives',
    sql: `
      CREATE TABLE IF NOT EXISTS novel_narratives (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        type          TEXT NOT NULL DEFAULT 'advance',
        chapter_spans TEXT NOT NULL DEFAULT '[]',
        status        TEXT NOT NULL DEFAULT 'active',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_novel_narratives_project
        ON novel_narratives(project_id);
    `
  },
  {
    // 087a: Agent 日志冷热分离（P1-2，PRD §4.2 P1-2 / 统一方案 §4.5）。
    // novel_agent_logs 只留元数据；大文本（system_prompt/chapter_context/user_message/
    // task_input/result/error 等）gzip 外置到 payload 表。
    // - payload_id 关联主表（主键即 payload.id，与 agent_log_id 一致，简化反查）
    // - content_hash = 非空字段 JSON 规范化后 sha256，可去重/校验解压完整性
    // - expires_at = created_at + 保留策略天数（成功 30d / 失败 90d / 审计锁定 365d，NULL=长期）
    // 2026-08-12 逻辑统一：冷热分离成为唯一路径（不再有 flag，全量外置）。
    id: '087_create_agent_log_payloads',
    sql: `
      CREATE TABLE IF NOT EXISTS novel_agent_log_payloads (
        id                    TEXT PRIMARY KEY,
        agent_log_id          TEXT NOT NULL UNIQUE,
        compression           TEXT NOT NULL DEFAULT 'gzip',
        system_prompt_blob    BLOB,
        chapter_context_blob  BLOB,
        user_message_blob     BLOB,
        task_input_blob       BLOB,
        user_instructions_blob BLOB,
        tools_blob            BLOB,
        result_blob           BLOB,
        error_blob            BLOB,
        content_hash          TEXT NOT NULL,
        expires_at            INTEGER,
        created_at            INTEGER NOT NULL,
        FOREIGN KEY (agent_log_id) REFERENCES novel_agent_logs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_log_payloads_expires ON novel_agent_log_payloads(expires_at);
      CREATE INDEX IF NOT EXISTS idx_agent_log_payloads_log ON novel_agent_log_payloads(agent_log_id);
      ALTER TABLE novel_agent_logs ADD COLUMN payload_id TEXT;
    `
  },
  {
    // 087b: P0 Context section 成本埋点（P0-1，PRD §4.1 P0-1 / 统一方案 §5.1）。
    // 独立度量表：按 section_type 聚合报表，与 payload 表（专职大文本冷存储）职责分离（架构 Q-1）。
    // 六类 section：system | shared | identity | suffix | dynamic | tool_schema。
    // source_hash = sha256(规范化文本)，同文本稳定、异文本可区分。
    id: '087_create_context_section_metrics',
    sql: `
      CREATE TABLE IF NOT EXISTS novel_context_section_metrics (
        id               TEXT PRIMARY KEY,
        agent_log_id     TEXT NOT NULL,
        project_id       TEXT NOT NULL,
        chapter_number   INTEGER NOT NULL,
        agent_type       TEXT NOT NULL,
        section_type     TEXT NOT NULL,
        section_id       TEXT NOT NULL,
        chars            INTEGER NOT NULL,
        estimated_tokens INTEGER NOT NULL,
        source_hash      TEXT NOT NULL,
        mode             TEXT NOT NULL DEFAULT 'full',
        created_at       INTEGER NOT NULL,
        FOREIGN KEY (agent_log_id) REFERENCES novel_agent_logs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_context_section_metrics_log ON novel_context_section_metrics(agent_log_id);
      CREATE INDEX IF NOT EXISTS idx_context_section_metrics_project ON novel_context_section_metrics(project_id, chapter_number);
    `
  },
  {
    // 088: Scene Cast 三表合并（P1-3，PRD §4.2 P1-3 / 统一方案 §4.3）。
    // novel_scene_focus / novel_scene_presence / novel_scene_functions → novel_scene_cast
    // （role 区分 focus/present/functional）。
    // ⚠️ prominence 采用 TEXT（lead/support/brief），对齐现有 CastProminence，保证字段级对比差异 = 0。
    // Flag sceneCastV2Write/Read 默认关：关闭时三表行为与现状完全一致。
    id: '088_create_novel_scene_cast',
    sql: `
      CREATE TABLE IF NOT EXISTS novel_scene_cast (
        scene_revision_id TEXT NOT NULL,
        character_id      TEXT NOT NULL,
        role              TEXT NOT NULL,
        function          TEXT,
        prominence        TEXT,
        note              TEXT,
        PRIMARY KEY (scene_revision_id, character_id, role),
        FOREIGN KEY (scene_revision_id) REFERENCES novel_scene_revisions(id) ON DELETE CASCADE,
        CHECK (role IN ('focus', 'present', 'functional')),
        CHECK (role != 'functional' OR function IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS idx_scene_cast_revision ON novel_scene_cast(scene_revision_id);
    `
  },
  {
    // 089: 废弃列清理（P1-4，PRD §4.2 P1-4）。
    // 删除 novel_conflicts / novel_factions 的 first_chapter / last_chapter。
    // 前置：045 已把旧值回填 chapter_spans；删除前由 scan-deprecated-columns.mjs 保证业务引用 = 0；
    // 两列无索引/无约束依赖，SQLite 3.35+（better-sqlite3@^12）可安全 DROP COLUMN。
    // foreshadowing / locations / items 的 first_chapter 不在本次范围。
    id: '089_drop_conflicts_factions_deprecated_columns',
    sql: `
      ALTER TABLE novel_conflicts DROP COLUMN first_chapter;
      ALTER TABLE novel_conflicts DROP COLUMN last_chapter;
      ALTER TABLE novel_factions DROP COLUMN first_chapter;
      ALTER TABLE novel_factions DROP COLUMN last_chapter;
    `
  },
  {
    // 项目级「创作主模型」：统一本项目 Director/Writer/Reviewer/Reviser 使用的 modelId。
    // 目的：①避免多模型混用导致 promptCacheScope 缓存反复失效（实测 cache/in 仅 31-46%）；
    // ②消除"404 model not supported / 401"这类配置类失败（实测 Director 失败中 5/27 属此类）。
    // NULL = 未设置，各 Agent 使用 AgentPage 各自配置或默认 Provider。
    id: '090_add_novel_projects_novel_model_id',
    sql: `
      ALTER TABLE novel_projects ADD COLUMN novel_model_id TEXT;
    `
  },
  {
    // P2：实体出场关系统一。把散落在各实体表 chapter_spans 的"章节出场"横切面
    // 抽成独立关联表（可索引、可按章/实体查询、可独立追踪版本）。
    // appearanceV2Write/Read 开启后：写入/读取走本表；chapter_spans 保留为兼容。
    id: '091_create_novel_entity_appearances',
    sql: `
      CREATE TABLE IF NOT EXISTS novel_entity_appearances (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL,
        chapter_id      TEXT NOT NULL,
        entity_type     TEXT NOT NULL,
        entity_id       TEXT NOT NULL,
        appearance_role TEXT NOT NULL DEFAULT 'present',
        source          TEXT NOT NULL DEFAULT 'sync',
        created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE (chapter_id, entity_type, entity_id, appearance_role)
      );
      CREATE INDEX IF NOT EXISTS idx_entity_appearances_chapter
        ON novel_entity_appearances(project_id, chapter_id, entity_type);
      CREATE INDEX IF NOT EXISTS idx_entity_appearances_entity
        ON novel_entity_appearances(project_id, entity_type, entity_id);
    `
  },
  {
    // T02-6 AI 确认队列：change record（memory_events）加确认状态。
    // status: 'confirmed'（默认，存量已生效）/ 'pending' / 'rejected'（驳回，消费查询排除）
    // confirmed_at: 确认/驳回时间戳
    id: '092_add_memory_events_confirm_status',
    sql: `
      ALTER TABLE novel_memory_events ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed';
      ALTER TABLE novel_memory_events ADD COLUMN confirmed_at INTEGER;
    `
  },
  {
    // T04：候选确认 TX3 的正式实体映射与同库 outbox。
    // 候选审核、正式实体晋升、映射和 outbox 必须在同一事务内提交；
    // (topic, aggregate_id) 唯一，重试不会重复投递同一候选确认事件。
    id: '093_create_entity_candidate_promotion_outbox',
    sql: `
      CREATE TABLE IF NOT EXISTS novel_entity_candidate_promotions (
        candidate_id TEXT PRIMARY KEY,
        entity_type  TEXT NOT NULL,
        entity_id    TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        FOREIGN KEY (candidate_id) REFERENCES novel_entity_candidates(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS novel_projection_outbox (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL,
        topic        TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        payload      TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        attempts     INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        delivered_at INTEGER,
        UNIQUE (topic, aggregate_id),
        FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE,
        CHECK (status IN ('pending', 'processing', 'delivered', 'failed'))
      );
      CREATE INDEX IF NOT EXISTS idx_projection_outbox_pending
        ON novel_projection_outbox(status, created_at);
    `
  },
  {
    // T02-6：Memory 操作审计（2026-08-12 逻辑统一：恒开启）。
    //
    // 与旧 novel_memory_events（StoryEvent 语义账本）并存：旧表记录"故事发生了什么"，
    // 本表记录"系统执行了什么"（create/update/link/unlink + before/after JSON）。
    // 消费者全部迁走后，旧表才可停写——审计恒开启，每次 Memory applyChanges 都留痕。
    id: '094_create_memory_operation_ledger',
    sql: `
      CREATE TABLE IF NOT EXISTS novel_memory_operation_runs (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL,
        chapter_id   TEXT,
        source       TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'applying',
        error        TEXT,
        created_at   INTEGER NOT NULL,
        committed_at INTEGER,
        FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_memory_op_runs_project
        ON novel_memory_operation_runs(project_id, created_at);

      CREATE TABLE IF NOT EXISTS novel_memory_operations (
        id            TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL,
        seq           INTEGER NOT NULL,
        operation     TEXT NOT NULL,
        target_type   TEXT NOT NULL,
        target_id     TEXT NOT NULL,
        related_type  TEXT,
        related_id    TEXT,
        before_json   TEXT,
        after_json    TEXT,
        reason        TEXT,
        created_at    INTEGER NOT NULL,
        UNIQUE (run_id, seq),
        FOREIGN KEY (run_id) REFERENCES novel_memory_operation_runs(id) ON DELETE CASCADE,
        CHECK (operation IN ('create', 'update', 'link', 'unlink'))
      );
      CREATE INDEX IF NOT EXISTS idx_memory_operations_target
        ON novel_memory_operations(target_type, target_id);
    `
  },
  {
    // 角色弧光在领域模型中是 1:1。历史库可能存在重复行：保留最近更新的一条，
    // 再以该条同步 character.arc_stage 投影，最后建立唯一索引防止后续漂移。
    id: '095_enforce_novel_character_arc_uniqueness',
    sql: `
      DELETE FROM novel_character_arcs
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY project_id, character_id
              ORDER BY updated_at DESC, created_at DESC, id DESC
            ) AS row_number
          FROM novel_character_arcs
        ) WHERE row_number > 1
      );
      UPDATE novel_characters
      SET arc_stage = (
        SELECT current_stage
        FROM novel_character_arcs
        WHERE character_id = novel_characters.id
          AND project_id = novel_characters.project_id
      )
      WHERE EXISTS (
        SELECT 1
        FROM novel_character_arcs
        WHERE character_id = novel_characters.id
          AND project_id = novel_characters.project_id
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_arcs_project_character_unique
        ON novel_character_arcs(project_id, character_id);
    `
  },
  {
    // Review 必须绑定被审正文；volume_id 必须属于章节所在项目。
    id: '096_bind_reviews_and_enforce_chapter_volume',
    sql: `
      ALTER TABLE novel_chapter_reviews ADD COLUMN content_revision_id TEXT;
      ALTER TABLE novel_chapter_reviews ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_novel_reviews_content_revision
        ON novel_chapter_reviews(content_revision_id);
      CREATE INDEX IF NOT EXISTS idx_novel_reviews_chapter_hash
        ON novel_chapter_reviews(chapter_id, content_hash, created_at DESC);

      UPDATE novel_chapters
      SET volume_id = NULL
      WHERE volume_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM novel_volumes v
          WHERE v.id = novel_chapters.volume_id
            AND v.project_id = novel_chapters.project_id
        );

      CREATE TRIGGER IF NOT EXISTS trg_novel_chapter_volume_insert
      BEFORE INSERT ON novel_chapters
      WHEN NEW.volume_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM novel_volumes v
          WHERE v.id = NEW.volume_id AND v.project_id = NEW.project_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'chapter volume must belong to the same project');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_novel_chapter_volume_update
      BEFORE UPDATE OF volume_id, project_id ON novel_chapters
      WHEN NEW.volume_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM novel_volumes v
          WHERE v.id = NEW.volume_id AND v.project_id = NEW.project_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'chapter volume must belong to the same project');
      END;
    `
  },
  {
    // 群聊断点恢复必须沿用首次运行的成员模型，防止同一次创作在恢复后切换模型。
    id: '097_add_discussion_run_member_model',
    sql: `
      ALTER TABLE novel_discussion_runs ADD COLUMN member_model TEXT;
    `
  },
  {
    // 群聊断点恢复必须沿用首次运行时解析出的项目主模型，防止项目设置变更后换模型。
    id: '098_add_discussion_run_project_model',
    sql: `
      ALTER TABLE novel_discussion_runs ADD COLUMN project_model TEXT;
    `
  },
  {
    // 章节正文被改写后，所有基于旧正文推导出的当前态必须显式失效。
    // invalidation 是项目级时间线闸门；rebuild job/step 为后续顺序重放提供可恢复状态。
    id: '099_create_timeline_rebuild',
    sql: `
      ALTER TABLE novel_memory_snapshots ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE novel_entity_appearances ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE novel_character_history ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

      CREATE INDEX IF NOT EXISTS idx_memory_snapshots_project_status
        ON novel_memory_snapshots(project_id, status, chapter_number);
      CREATE INDEX IF NOT EXISTS idx_entity_appearances_project_status
        ON novel_entity_appearances(project_id, status, chapter_id);
      CREATE INDEX IF NOT EXISTS idx_character_history_project_status
        ON novel_character_history(project_id, status, chapter_number);
      CREATE INDEX IF NOT EXISTS idx_entity_candidates_project_chapter_status
        ON novel_entity_candidates(project_id, chapter_number, status);

      CREATE TABLE IF NOT EXISTS novel_timeline_invalidations (
        id                         TEXT PRIMARY KEY,
        project_id                 TEXT NOT NULL,
        start_chapter_id           TEXT NOT NULL,
        start_chapter_number       INTEGER NOT NULL,
        source_content_revision_id TEXT,
        status                     TEXT NOT NULL DEFAULT 'pending',
        reason                     TEXT NOT NULL DEFAULT 'chapter_rewrite',
        affected_chapters          TEXT NOT NULL DEFAULT '[]',
        stale_counts               TEXT NOT NULL DEFAULT '{}',
        created_at                 INTEGER NOT NULL,
        updated_at                 INTEGER NOT NULL,
        resolved_at                INTEGER,
        FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE,
        FOREIGN KEY (start_chapter_id) REFERENCES novel_chapters(id) ON DELETE RESTRICT,
        FOREIGN KEY (source_content_revision_id) REFERENCES novel_chapter_content_revisions(id) ON DELETE SET NULL,
        CHECK (status IN ('pending', 'rebuilding', 'resolved'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_invalidations_project_active
        ON novel_timeline_invalidations(project_id)
        WHERE status IN ('pending', 'rebuilding');

      CREATE TABLE IF NOT EXISTS novel_timeline_rebuild_jobs (
        id                       TEXT PRIMARY KEY,
        invalidation_id          TEXT NOT NULL,
        project_id               TEXT NOT NULL,
        start_chapter_number     INTEGER NOT NULL,
        end_chapter_number       INTEGER NOT NULL,
        status                   TEXT NOT NULL DEFAULT 'running',
        model_id                 TEXT,
        estimated_llm_calls      INTEGER NOT NULL DEFAULT 0,
        processed_chapter_number INTEGER,
        error                    TEXT,
        created_at               INTEGER NOT NULL,
        started_at               INTEGER,
        updated_at               INTEGER NOT NULL,
        completed_at             INTEGER,
        FOREIGN KEY (invalidation_id) REFERENCES novel_timeline_invalidations(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE,
        CHECK (status IN ('running', 'paused', 'failed', 'completed', 'cancelled'))
      );
      CREATE INDEX IF NOT EXISTS idx_timeline_rebuild_jobs_project
        ON novel_timeline_rebuild_jobs(project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS novel_timeline_rebuild_steps (
        job_id              TEXT NOT NULL,
        chapter_id          TEXT NOT NULL,
        chapter_number      INTEGER NOT NULL,
        content_revision_id TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'pending',
        analysis_json       TEXT,
        error               TEXT,
        updated_at          INTEGER NOT NULL,
        PRIMARY KEY (job_id, chapter_id),
        FOREIGN KEY (job_id) REFERENCES novel_timeline_rebuild_jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (chapter_id) REFERENCES novel_chapters(id) ON DELETE CASCADE,
        FOREIGN KEY (content_revision_id) REFERENCES novel_chapter_content_revisions(id) ON DELETE RESTRICT,
        CHECK (status IN ('pending', 'analyzed', 'applied', 'failed'))
      );
      CREATE INDEX IF NOT EXISTS idx_timeline_rebuild_steps_order
        ON novel_timeline_rebuild_steps(job_id, chapter_number);
    `
  },
  {
    // 100: 模型调用遥测（缓存与监控一体化）。
    // cache_key: 稳定缓存域（如 novel:proj-1:10），OpenAI 路由用作 prompt_cache_key
    // cache_protocol: anthropic-cache-control | openai-prompt-cache-key | automatic-prefix | unknown
    // request_fingerprint: 分层内容 sha256 摘要（16 hex），诊断前缀漂移，不存原文
    // cacheable_prefix_chars: system+shared+identity 字符数（覆盖率先行条件）
    // data_quality: complete | partial | no_data（区分未命中与未上报）
    // error_code: llm-error-policy 归一化错误码
    id: '100_add_model_call_telemetry',
    sql: `
      ALTER TABLE novel_agent_logs ADD COLUMN cache_key TEXT;
      ALTER TABLE novel_agent_logs ADD COLUMN cache_protocol TEXT;
      ALTER TABLE novel_agent_logs ADD COLUMN request_fingerprint TEXT;
      ALTER TABLE novel_agent_logs ADD COLUMN cacheable_prefix_chars INTEGER;
      ALTER TABLE novel_agent_logs ADD COLUMN data_quality TEXT;
      ALTER TABLE novel_agent_logs ADD COLUMN error_code TEXT;
      CREATE INDEX IF NOT EXISTS idx_novel_agent_logs_fingerprint
        ON novel_agent_logs(project_id, request_fingerprint);
    `
  },
  {
    // 103: 文风专家团配置。存于既有文风档案，避免创建第二套生效源。
    id: '103_add_style_experts',
    sql: `ALTER TABLE novel_writing_style_profiles ADD COLUMN style_experts TEXT NOT NULL DEFAULT '[]';`
  },
  {
    // 101: 工作流运行快照：create-flow 阶段产物（已批准叙事任务 / Writer 草稿 / 最终正文）
    // 落库，失败后可从断点续跑，不重烧 Director+Writer。
    // phase 字段记录"快照推进到的阶段"：writing=Director 已批准，reviewing=草稿已成，
    // memory=正文已定稿待落库。status='error' 且 phase 可续跑时前端展示「从中断处继续」。
    id: '101_create_novel_workflow_runs',
    sql: `CREATE TABLE IF NOT EXISTS novel_workflow_runs (
      id                    TEXT PRIMARY KEY,
      project_id            TEXT NOT NULL,
      chapter_number        INTEGER NOT NULL,
      status                TEXT NOT NULL,
      phase                 TEXT,
      failed_phase          TEXT,
      director_task         TEXT,
      director_output       TEXT,
      rhythm_suggestion     TEXT,
      arranged_entities     TEXT,
      writer_draft          TEXT,
      final_content         TEXT,
      model_id              TEXT,
      error                 TEXT,
      resumed_from_run_id   TEXT,
      created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at            INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_workflow_runs_chapter
      ON novel_workflow_runs(project_id, chapter_number, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_novel_workflow_runs_resumed_from
      ON novel_workflow_runs(resumed_from_run_id);`
  },
  {
    // 102: 群聊快照补充中断场景 ID：acting/scene_setup 阶段失败时记录推演到哪个场景，
    // 断点续跑从该场景继续（此前只支持 chapter_weaving 整段续跑）。
    id: '102_add_discussion_run_failed_scene',
    sql: `ALTER TABLE novel_discussion_runs ADD COLUMN failed_scene_id INTEGER;`
  },
  {
    // 107: 文风专家版本历史，用于查看和回滚用户编辑过的提示词。
    id: '107_create_novel_style_expert_versions',
    sql: `
      CREATE TABLE IF NOT EXISTS novel_style_expert_versions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        expert_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        custom_prompt TEXT,
        enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_style_expert_versions_unique
        ON novel_style_expert_versions(project_id, expert_id, version);
      CREATE INDEX IF NOT EXISTS idx_style_expert_versions_expert
        ON novel_style_expert_versions(project_id, expert_id, version DESC);
    `
  },
  {
    // 104: 独立文风专家库。旧 profile JSON 暂时保留，供过渡期兼容。
    id: '104_create_novel_style_experts',
    sql: `
      CREATE TABLE IF NOT EXISTS novel_style_experts (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        source_title TEXT NOT NULL,
        source_author TEXT,
        description TEXT NOT NULL,
        distilled_prompt TEXT NOT NULL,
        custom_prompt TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        distill_meta TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, id),
        FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_novel_style_experts_project_order
        ON novel_style_experts(project_id, sort_order, id);
    `
  },
  {
    // 105: 将旧 profile JSON 中的专家迁入独立表。重复执行安全，非法/空 JSON 跳过。
    id: '105_backfill_novel_style_experts',
    sql: `
      INSERT OR IGNORE INTO novel_style_experts (
        id, project_id, name, source_title, source_author, description,
        distilled_prompt, custom_prompt, enabled, sort_order, version, created_at, updated_at
      )
      SELECT
        json_extract(item.value, '$.id'),
        p.project_id,
        json_extract(item.value, '$.name'),
        COALESCE(json_extract(item.value, '$.sourceTitle'), '历史文风样本'),
        json_extract(item.value, '$.sourceAuthor'),
        COALESCE(json_extract(item.value, '$.description'), ''),
        COALESCE(json_extract(item.value, '$.distilledPrompt'), json_extract(item.value, '$.prompt'), ''),
        json_extract(item.value, '$.customPrompt'),
        CASE WHEN json_extract(item.value, '$.enabled') = 0 THEN 0 ELSE 1 END,
        CAST(item.key AS INTEGER),
        COALESCE(json_extract(item.value, '$.version'), 1),
        p.created_at,
        p.updated_at
      FROM novel_writing_style_profiles p, json_each(p.style_experts) item
      WHERE json_valid(p.style_experts)
        AND json_type(p.style_experts) = 'array'
        AND json_extract(item.value, '$.id') IS NOT NULL
        AND json_extract(item.value, '$.name') IS NOT NULL
        AND COALESCE(json_extract(item.value, '$.distilledPrompt'), json_extract(item.value, '$.prompt'), '') <> '';
    `
  }
  ,{
    // 106: 冻结工作流/群聊断点续跑时使用的本轮文风专家选择。
    id: '106_add_style_expert_ids_to_runs',
    sql: `
      ALTER TABLE novel_workflow_runs ADD COLUMN style_expert_ids TEXT;
      ALTER TABLE novel_discussion_runs ADD COLUMN style_expert_ids TEXT;
    `
  },
  {
    // 108: 保存文风专家的 L1 指标、L2 手法卡、L3 排除清单和证据样本。
    id: '108_add_style_expert_profile_artifacts',
    sql: `
      ALTER TABLE novel_style_experts ADD COLUMN metrics_json TEXT;
      ALTER TABLE novel_style_experts ADD COLUMN techniques_json TEXT;
      ALTER TABLE novel_style_experts ADD COLUMN exclusions_json TEXT;
      ALTER TABLE novel_style_experts ADD COLUMN exemplars_json TEXT;
    `
  },
  {
    // 109: 修复旧库中 084 因 legacy novel_scenes/novel_storylines 列冲突而回滚的问题。
    // 旧表改名保留，V2 表按 084 的正式模型补建；旧场景身份和故事线尽量回填。
    id: '109_repair_scene_plan_schema',
    beforeApply: archiveLegacyScenePlanTables,
    afterApply: backfillLegacyScenePlanTables,
    sql: `
      CREATE TABLE IF NOT EXISTS novel_chapter_plan_revisions (
        id                    TEXT PRIMARY KEY,
        chapter_id            TEXT NOT NULL,
        project_id            TEXT NOT NULL,
        creation_run_id       TEXT,
        supersedes_id         TEXT,
        base_content_revision_id TEXT,
        positioning           TEXT,
        rhythm                TEXT,
        budget                TEXT NOT NULL DEFAULT '{}',
        status                TEXT NOT NULL DEFAULT 'draft',
        revision              INTEGER NOT NULL,
        idempotency_key       TEXT,
        created_at            INTEGER NOT NULL,
        FOREIGN KEY (chapter_id) REFERENCES novel_chapters(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_revisions_chapter_rev
        ON novel_chapter_plan_revisions(chapter_id, revision);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_revisions_idempotency
        ON novel_chapter_plan_revisions(idempotency_key) WHERE idempotency_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS novel_scenes (
        id            TEXT PRIMARY KEY,
        chapter_id    TEXT NOT NULL,
        project_id    TEXT NOT NULL,
        stable_key    TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        FOREIGN KEY (chapter_id) REFERENCES novel_chapters(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_scenes_chapter_key
        ON novel_scenes(chapter_id, stable_key);

      CREATE TABLE IF NOT EXISTS novel_scene_revisions (
        id                    TEXT PRIMARY KEY,
        scene_id              TEXT NOT NULL,
        chapter_id            TEXT NOT NULL,
        project_id            TEXT NOT NULL,
        plan_revision_id      TEXT NOT NULL,
        content_revision_id   TEXT,
        supersedes_id         TEXT,
        order_no              INTEGER NOT NULL,
        title                 TEXT NOT NULL DEFAULT '',
        goal                  TEXT NOT NULL DEFAULT '',
        summary               TEXT NOT NULL DEFAULT '',
        location_text         TEXT NOT NULL DEFAULT '',
        time_text             TEXT NOT NULL DEFAULT '',
        pov_mode              TEXT NOT NULL DEFAULT 'single',
        pov_character_id      TEXT,
        target_words          INTEGER NOT NULL DEFAULT 0,
        status                TEXT NOT NULL DEFAULT 'planned',
        created_at            INTEGER NOT NULL,
        FOREIGN KEY (scene_id) REFERENCES novel_scenes(id) ON DELETE CASCADE,
        FOREIGN KEY (plan_revision_id) REFERENCES novel_chapter_plan_revisions(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_scene_revisions_plan_order
        ON novel_scene_revisions(plan_revision_id, order_no);
      CREATE INDEX IF NOT EXISTS idx_scene_revisions_scene
        ON novel_scene_revisions(scene_id, created_at);

      CREATE TABLE IF NOT EXISTS novel_scene_focus (
        scene_revision_id TEXT NOT NULL,
        character_id      TEXT NOT NULL,
        PRIMARY KEY (scene_revision_id, character_id),
        FOREIGN KEY (scene_revision_id) REFERENCES novel_scene_revisions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS novel_scene_presence (
        scene_revision_id TEXT NOT NULL,
        character_id      TEXT NOT NULL,
        PRIMARY KEY (scene_revision_id, character_id),
        FOREIGN KEY (scene_revision_id) REFERENCES novel_scene_revisions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS novel_scene_functions (
        scene_revision_id TEXT NOT NULL,
        character_id      TEXT NOT NULL,
        function          TEXT NOT NULL,
        prominence        TEXT NOT NULL DEFAULT 'brief',
        note              TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (scene_revision_id, character_id, function),
        FOREIGN KEY (scene_revision_id) REFERENCES novel_scene_revisions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS novel_storylines (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL,
        name          TEXT NOT NULL,
        kind          TEXT NOT NULL DEFAULT 'main',
        lifecycle     TEXT NOT NULL DEFAULT 'active',
        maturity      TEXT NOT NULL DEFAULT 'candidate',
        description   TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_storylines_project_name
        ON novel_storylines(project_id, name);

      CREATE TABLE IF NOT EXISTS novel_storyline_progress (
        id                  TEXT PRIMARY KEY,
        project_id          TEXT NOT NULL,
        storyline_id        TEXT NOT NULL,
        scene_revision_id   TEXT NOT NULL,
        primary_flag        INTEGER NOT NULL DEFAULT 0,
        type                TEXT NOT NULL DEFAULT 'advance',
        before_state        TEXT NOT NULL DEFAULT '',
        after_state         TEXT NOT NULL DEFAULT '',
        summary             TEXT NOT NULL DEFAULT '',
        status              TEXT NOT NULL DEFAULT 'confirmed',
        created_at          INTEGER NOT NULL,
        FOREIGN KEY (storyline_id) REFERENCES novel_storylines(id) ON DELETE CASCADE,
        FOREIGN KEY (scene_revision_id) REFERENCES novel_scene_revisions(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_progress_scene_storyline
        ON novel_storyline_progress(scene_revision_id, storyline_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_progress_scene_primary
        ON novel_storyline_progress(scene_revision_id) WHERE primary_flag = 1;
    `
  },
  {
    // 110: 专家版本补齐所有可编辑的来源和排序字段，确保回滚不是部分恢复。
    id: '110_expand_style_expert_versions',
    sql: `
      ALTER TABLE novel_style_expert_versions ADD COLUMN source_title TEXT;
      ALTER TABLE novel_style_expert_versions ADD COLUMN source_author TEXT;
      ALTER TABLE novel_style_expert_versions ADD COLUMN sort_order INTEGER;
    `
  },
  {
    // 111: 时间线重建任务事件流。事件只保存阶段与摘要，不保存正文、完整 Prompt 或模型原始结果。
    id: '111_add_timeline_rebuild_events',
    sql: `
      CREATE TABLE IF NOT EXISTS novel_timeline_rebuild_events (
        id              TEXT PRIMARY KEY,
        job_id          TEXT NOT NULL,
        sequence_no     INTEGER NOT NULL,
        event_type      TEXT NOT NULL,
        chapter_id      TEXT,
        chapter_number  INTEGER,
        payload         TEXT NOT NULL DEFAULT '{}',
        created_at      INTEGER NOT NULL,
        FOREIGN KEY (job_id) REFERENCES novel_timeline_rebuild_jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (chapter_id) REFERENCES novel_chapters(id) ON DELETE SET NULL,
        UNIQUE(job_id, sequence_no)
      );
      CREATE INDEX IF NOT EXISTS idx_timeline_rebuild_events_job_sequence
        ON novel_timeline_rebuild_events(job_id, sequence_no);
    `
  },
  {
    // 112: 时间线重建 M0 收尾（2026-08-18 未交付功能实施方案 §5/§6）：
    // 1) steps 表状态机补全为方案规定的 6 态：pending → replaying → ready_to_apply → applied|failed|blocked。
    //    099 的 CHECK 只有 4 态，'ready_to_apply' 靠读取时把 'analyzed' 归一化的 hack 支持，
    //    'replaying'/'blocked' 根本写不进去；此处重建表并把存量 'analyzed' 迁移为 'ready_to_apply'。
    // 2) 派生表增加 stale_from 列：标记 stale 时记录原状态，apply 恢复当前态时精确还原，
    //    不再靠猜默认值。历史无 stale_from 的行回退到各表规范状态。
    // 3) 新增 checkpoints 表：每章成功应用后持久化分析产物与恢复摘要，
    //    失败只允许从最近安全 checkpoint 恢复（方案 §6 数据与状态）。
    id: '112_complete_timeline_rebuild_state_machine',
    sql: `
      ALTER TABLE novel_chapter_plan_revisions ADD COLUMN stale_from TEXT;
      ALTER TABLE novel_scene_revisions ADD COLUMN stale_from TEXT;
      ALTER TABLE novel_storyline_progress ADD COLUMN stale_from TEXT;
      ALTER TABLE novel_story_events ADD COLUMN stale_from TEXT;
      ALTER TABLE novel_memory_events ADD COLUMN stale_from TEXT;
      ALTER TABLE novel_memory_snapshots ADD COLUMN stale_from TEXT;
      ALTER TABLE novel_character_history ADD COLUMN stale_from TEXT;
      ALTER TABLE novel_entity_appearances ADD COLUMN stale_from TEXT;
      ALTER TABLE novel_entity_candidates ADD COLUMN stale_from TEXT;

      CREATE TABLE novel_timeline_rebuild_steps_v2 (
        job_id              TEXT NOT NULL,
        chapter_id          TEXT NOT NULL,
        chapter_number      INTEGER NOT NULL,
        content_revision_id TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'pending',
        analysis_json       TEXT,
        error               TEXT,
        updated_at          INTEGER NOT NULL,
        PRIMARY KEY (job_id, chapter_id),
        FOREIGN KEY (job_id) REFERENCES novel_timeline_rebuild_jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (chapter_id) REFERENCES novel_chapters(id) ON DELETE CASCADE,
        FOREIGN KEY (content_revision_id) REFERENCES novel_chapter_content_revisions(id) ON DELETE RESTRICT,
        CHECK (status IN ('pending', 'replaying', 'ready_to_apply', 'applied', 'failed', 'blocked'))
      );
      INSERT INTO novel_timeline_rebuild_steps_v2
        (job_id, chapter_id, chapter_number, content_revision_id, status, analysis_json, error, updated_at)
      SELECT job_id, chapter_id, chapter_number, content_revision_id,
        CASE status WHEN 'analyzed' THEN 'ready_to_apply' ELSE status END,
        analysis_json, error, updated_at
      FROM novel_timeline_rebuild_steps;
      DROP TABLE novel_timeline_rebuild_steps;
      ALTER TABLE novel_timeline_rebuild_steps_v2 RENAME TO novel_timeline_rebuild_steps;
      CREATE INDEX IF NOT EXISTS idx_timeline_rebuild_steps_order
        ON novel_timeline_rebuild_steps(job_id, chapter_number);

      CREATE TABLE IF NOT EXISTS novel_timeline_rebuild_checkpoints (
        id                  TEXT PRIMARY KEY,
        job_id              TEXT NOT NULL,
        chapter_id          TEXT NOT NULL,
        chapter_number      INTEGER NOT NULL,
        content_revision_id TEXT NOT NULL,
        analysis_json       TEXT,
        artifacts_json      TEXT NOT NULL DEFAULT '{}',
        created_at          INTEGER NOT NULL,
        UNIQUE (job_id, chapter_number),
        FOREIGN KEY (job_id) REFERENCES novel_timeline_rebuild_jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (chapter_id) REFERENCES novel_chapters(id) ON DELETE CASCADE,
        FOREIGN KEY (content_revision_id) REFERENCES novel_chapter_content_revisions(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_timeline_rebuild_checkpoints_job
        ON novel_timeline_rebuild_checkpoints(job_id, chapter_number DESC);
    `
  },
  {
    // 113: 参考链路持久化表（方案 §8-§11，P4-P9 数据基线）。
    // 表结构与 §11.1 一一对应；模板版本链拆为 templates（元数据）+ template_versions（不可变规则），
    // 与 /reference-templates/:templateId 与 /reference-template-versions/:versionId 两组资源对齐。
    // 事件表只存阶段、摘要与游标，不保存原文、完整 Prompt 或完整生成正文（§11.1 末行约束）。
    id: '113_create_reference_chain_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS novel_reference_analysis_runs (
        id                        TEXT PRIMARY KEY,
        source_id                 TEXT NOT NULL,
        status                    TEXT NOT NULL DEFAULT 'queued'
                                  CHECK (status IN ('queued', 'running', 'awaiting_review', 'completed', 'failed', 'cancelled')),
        current_stage             TEXT CHECK (current_stage IN (
                                  'validating_source', 'parsing_text', 'deterministic_analysis', 'scene_analysis',
                                  'chapter_aggregation', 'book_aggregation', 'safety_scan', 'awaiting_review',
                                  'completed', 'failed', 'cancelled')),
        coverage                  TEXT NOT NULL DEFAULT '{}',
        provider_id               TEXT,
        model_id                  TEXT,
        extractor_version         TEXT,
        prompt_version            TEXT,
        included_section_ids      TEXT NOT NULL DEFAULT '[]',
        semantic_coverage_policy  TEXT NOT NULL DEFAULT '{}',
        estimate_snapshot         TEXT NOT NULL DEFAULT '{}',
        estimated_usage           TEXT NOT NULL DEFAULT '{}',
        actual_usage              TEXT NOT NULL DEFAULT '{}',
        high_cost_confirmed       INTEGER NOT NULL DEFAULT 0,
        checkpoint                TEXT,
        error                     TEXT,
        profile_id                TEXT,
        attempt                   INTEGER NOT NULL DEFAULT 1,
        parent_attempt_id         TEXT,
        created_at                INTEGER NOT NULL,
        updated_at                INTEGER NOT NULL,
        started_at                INTEGER,
        completed_at              INTEGER,
        cancelled_at              INTEGER,
        FOREIGN KEY (source_id) REFERENCES novel_reference_sources(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_reference_analysis_runs_source
        ON novel_reference_analysis_runs(source_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_reference_analysis_runs_status
        ON novel_reference_analysis_runs(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS novel_reference_observations (
        id                      TEXT PRIMARY KEY,
        analysis_run_id         TEXT NOT NULL,
        section_id              TEXT,
        level                   TEXT NOT NULL CHECK (level IN ('measurement', 'scene', 'chapter', 'book')),
        metric                  TEXT NOT NULL,
        value                   TEXT NOT NULL,
        measurement_method      TEXT,
        confidence              REAL,
        evidence_offsets        TEXT NOT NULL DEFAULT '[]',
        counterexample_offsets  TEXT NOT NULL DEFAULT '[]',
        safety_flags            TEXT NOT NULL DEFAULT '[]',
        created_at              INTEGER NOT NULL,
        FOREIGN KEY (analysis_run_id) REFERENCES novel_reference_analysis_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (section_id) REFERENCES novel_reference_sections(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reference_observations_run
        ON novel_reference_observations(analysis_run_id, level, metric);

      CREATE TABLE IF NOT EXISTS novel_reference_profiles (
        id                TEXT PRIMARY KEY,
        analysis_run_id   TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'in_review', 'active', 'superseded', 'archived')),
        version           INTEGER NOT NULL DEFAULT 1,
        parent_version_id TEXT,
        profile_hash      TEXT NOT NULL,
        spirit_profile    TEXT NOT NULL DEFAULT '{}',
        technique_profile TEXT NOT NULL DEFAULT '{}',
        power_profile     TEXT NOT NULL DEFAULT '{}',
        pacing_profile    TEXT NOT NULL DEFAULT '{}',
        story_elements    TEXT NOT NULL DEFAULT '{}',
        chapter_patterns  TEXT NOT NULL DEFAULT '[]',
        findings          TEXT NOT NULL DEFAULT '[]',
        safety_report     TEXT NOT NULL DEFAULT '{}',
        coverage          TEXT NOT NULL DEFAULT '{}',
        change_summary    TEXT,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        activated_at      INTEGER,
        FOREIGN KEY (analysis_run_id) REFERENCES novel_reference_analysis_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_reference_profiles_run
        ON novel_reference_profiles(analysis_run_id, version DESC);

      CREATE TABLE IF NOT EXISTS novel_reference_finding_reviews (
        id                TEXT PRIMARY KEY,
        profile_id        TEXT NOT NULL,
        finding_key       TEXT NOT NULL,
        decision          TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected', 'edited')),
        edited_observation TEXT,
        edited_rule       TEXT,
        strength          TEXT CHECK (strength IN ('hard', 'soft', 'reference')),
        prompt_enabled    INTEGER NOT NULL DEFAULT 1,
        agent_targets     TEXT NOT NULL DEFAULT '[]',
        chapter_scope     TEXT NOT NULL DEFAULT '[]',
        review_note       TEXT,
        reviewer          TEXT NOT NULL DEFAULT 'user',
        batch_id          TEXT,
        created_at        INTEGER NOT NULL,
        FOREIGN KEY (profile_id) REFERENCES novel_reference_profiles(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_reference_finding_reviews_profile
        ON novel_reference_finding_reviews(profile_id, finding_key, created_at DESC);

      CREATE TABLE IF NOT EXISTS novel_reference_templates (
        id                 TEXT PRIMARY KEY,
        owner_project_id   TEXT,
        name               TEXT NOT NULL,
        description        TEXT NOT NULL DEFAULT '',
        visibility         TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
        status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
        current_version_id TEXT,
        source_profile_id  TEXT,
        source_text_state  TEXT NOT NULL DEFAULT 'available' CHECK (source_text_state IN ('available', 'deleted')),
        binding_count      INTEGER NOT NULL DEFAULT 0,
        version_count      INTEGER NOT NULL DEFAULT 0,
        preview_hash       TEXT,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        archived_at        INTEGER,
        deleted_at         INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_reference_templates_status
        ON novel_reference_templates(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS novel_reference_template_versions (
        id                 TEXT PRIMARY KEY,
        template_id        TEXT NOT NULL,
        version            INTEGER NOT NULL,
        status             TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'in_review', 'published', 'superseded', 'rolled_back')),
        parent_version_id  TEXT,
        template_hash      TEXT NOT NULL,
        profile_hash       TEXT,
        spirit_rules       TEXT NOT NULL DEFAULT '{}',
        technique_rules    TEXT NOT NULL DEFAULT '{}',
        power_rules        TEXT NOT NULL DEFAULT '{}',
        pacing_rules       TEXT NOT NULL DEFAULT '{}',
        chapter_rule_sets  TEXT NOT NULL DEFAULT '[]',
        default_agent_scopes TEXT NOT NULL DEFAULT '[]',
        project_overrides  TEXT NOT NULL DEFAULT '{}',
        validation_run_id  TEXT,
        safety_result      TEXT NOT NULL DEFAULT '{}',
        change_summary     TEXT,
        created_at         INTEGER NOT NULL,
        published_at       INTEGER,
        FOREIGN KEY (template_id) REFERENCES novel_reference_templates(id) ON DELETE CASCADE,
        UNIQUE (template_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_reference_template_versions_template
        ON novel_reference_template_versions(template_id, version DESC);

      CREATE TABLE IF NOT EXISTS novel_project_reference_templates (
        id                   TEXT PRIMARY KEY,
        project_id           TEXT NOT NULL,
        template_id          TEXT NOT NULL,
        template_version_id  TEXT NOT NULL,
        bound                INTEGER NOT NULL DEFAULT 1,
        default_enabled      INTEGER NOT NULL DEFAULT 0,
        agent_scopes         TEXT NOT NULL DEFAULT '[]',
        chapter_scopes       TEXT NOT NULL DEFAULT '[]',
        project_overrides    TEXT NOT NULL DEFAULT '{}',
        lock_version         INTEGER NOT NULL DEFAULT 1,
        last_used_at         INTEGER,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE,
        FOREIGN KEY (template_id) REFERENCES novel_reference_templates(id) ON DELETE CASCADE,
        FOREIGN KEY (template_version_id) REFERENCES novel_reference_template_versions(id) ON DELETE RESTRICT,
        UNIQUE (project_id, template_id)
      );
      CREATE INDEX IF NOT EXISTS idx_project_reference_templates_project
        ON novel_project_reference_templates(project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS novel_reference_validation_runs (
        id                    TEXT PRIMARY KEY,
        template_version_id   TEXT NOT NULL,
        scenario_source       TEXT NOT NULL
                              CHECK (scenario_source IN ('system_original', 'user_input', 'project_facts')),
        scenario_type         TEXT,
        fixed_scenario_version TEXT NOT NULL,
        fixed_facts_hash      TEXT NOT NULL,
        baseline_config       TEXT NOT NULL DEFAULT '{}',
        template_config       TEXT NOT NULL DEFAULT '{}',
        baseline_output       TEXT,
        template_output       TEXT,
        rule_hits             TEXT NOT NULL DEFAULT '{}',
        feedback              TEXT,
        decision              TEXT CHECK (decision IN ('accepted', 'rejected')),
        decision_note         TEXT,
        decision_hash         TEXT,
        status                TEXT NOT NULL DEFAULT 'queued'
                              CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        provider_id           TEXT,
        model_id              TEXT,
        estimate              TEXT NOT NULL DEFAULT '{}',
        usage                 TEXT NOT NULL DEFAULT '{}',
        cost                  TEXT NOT NULL DEFAULT '{}',
        safety_report         TEXT NOT NULL DEFAULT '{}',
        error                 TEXT,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL,
        completed_at          INTEGER,
        FOREIGN KEY (template_version_id) REFERENCES novel_reference_template_versions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_reference_validation_runs_version
        ON novel_reference_validation_runs(template_version_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS novel_reference_template_usages (
        id                     TEXT PRIMARY KEY,
        project_id             TEXT NOT NULL,
        chapter_id             TEXT NOT NULL,
        chapter_number         INTEGER NOT NULL,
        template_version_id    TEXT NOT NULL,
        enabled                INTEGER NOT NULL,
        profile_hash           TEXT,
        template_hash          TEXT,
        chapter_classification  TEXT,
        agent_scopes           TEXT NOT NULL DEFAULT '[]',
        prompt_hashes          TEXT NOT NULL DEFAULT '{}',
        similarity_summary     TEXT NOT NULL DEFAULT '{}',
        created_at             INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE,
        FOREIGN KEY (chapter_id) REFERENCES novel_chapters(id) ON DELETE CASCADE,
        FOREIGN KEY (template_version_id) REFERENCES novel_reference_template_versions(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_reference_template_usages_chapter
        ON novel_reference_template_usages(project_id, chapter_number, created_at DESC);

      CREATE TABLE IF NOT EXISTS novel_reference_run_events (
        id           TEXT PRIMARY KEY,
        run_id       TEXT NOT NULL,
        run_kind     TEXT NOT NULL CHECK (run_kind IN ('analysis', 'validation')),
        sequence_no  INTEGER NOT NULL,
        event_type   TEXT NOT NULL,
        stage        TEXT,
        summary      TEXT NOT NULL DEFAULT '',
        cursor       TEXT,
        payload      TEXT NOT NULL DEFAULT '{}',
        created_at   INTEGER NOT NULL,
        UNIQUE (run_id, sequence_no)
      );
      CREATE INDEX IF NOT EXISTS idx_reference_run_events_run
        ON novel_reference_run_events(run_id, sequence_no);
    `
  },
  {
    // 114: Storyline/Scene 人工 revision 与矩阵重投影（方案 §7，M2）。
    //
    // 保守默认（§16 第 8 项待确认，此处采用文档 §7 已写明的状态机与字段）：
    // - Storyline 原表（novel_storylines）只存身份 name/kind/lifecycle/maturity，不承载可变事实；
    //   新增 novel_storyline_revisions 持有 summary/goal/stakes/actor 等规范事实，
    //   状态机 draft → submitted → approved|rejected|superseded；仅 approved 成为当前规范事实。
    // - Scene 人工审核不干扰现有 SceneRevisionStatus 自动流程（planned→confirmed），
    //   新增独立的 review_status/review_note 等列承载人工审核状态；人工编辑复用 plan_revision_id。
    // - 矩阵重投影当前是同步纯函数（无异步积压），rebuild 落一条 job 记录 + 完成事件，
    //   满足「可追踪 projection job」契约；投影落后时 sourceRevision 校验仍可兜底。
    id: '114_add_storyline_scene_revision_and_matrix_rebuild',
    sql: `
      ALTER TABLE novel_storylines ADD COLUMN current_revision_id TEXT;

      CREATE TABLE IF NOT EXISTS novel_storyline_revisions (
        id                TEXT PRIMARY KEY,
        storyline_id      TEXT NOT NULL,
        project_id        TEXT NOT NULL,
        supersedes_id     TEXT,
        revision          INTEGER NOT NULL,
        status            TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'superseded')),
        summary           TEXT NOT NULL DEFAULT '',
        goal              TEXT NOT NULL DEFAULT '',
        stakes            TEXT NOT NULL DEFAULT '',
        actor             TEXT NOT NULL DEFAULT '',
        note              TEXT NOT NULL DEFAULT '',
        decision_note     TEXT NOT NULL DEFAULT '',
        reviewer          TEXT NOT NULL DEFAULT 'user',
        expected_version  INTEGER NOT NULL DEFAULT 1,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        superseeded_at    INTEGER,
        FOREIGN KEY (storyline_id) REFERENCES novel_storylines(id) ON DELETE CASCADE,
        FOREIGN KEY (supersedes_id) REFERENCES novel_storyline_revisions(id) ON DELETE SET NULL,
        UNIQUE (storyline_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_storyline_revisions_storyline
        ON novel_storyline_revisions(storyline_id, revision DESC);

      ALTER TABLE novel_scene_revisions ADD COLUMN positioning TEXT;
      ALTER TABLE novel_scene_revisions ADD COLUMN rhythm TEXT;
      ALTER TABLE novel_scene_revisions ADD COLUMN narrative_task_types TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE novel_scene_revisions ADD COLUMN review_status TEXT
        CHECK (review_status IS NULL OR review_status IN ('draft', 'submitted', 'approved', 'rejected'));
      ALTER TABLE novel_scene_revisions ADD COLUMN review_note TEXT NOT NULL DEFAULT '';
      ALTER TABLE novel_scene_revisions ADD COLUMN reviewed_at INTEGER;
      ALTER TABLE novel_scene_revisions ADD COLUMN reviewer TEXT NOT NULL DEFAULT 'user';
      CREATE INDEX IF NOT EXISTS idx_scene_revisions_review_status
        ON novel_scene_revisions(review_status);

      CREATE TABLE IF NOT EXISTS novel_narrative_matrix_rebuilds (
        id                TEXT PRIMARY KEY,
        project_id        TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        revision_ids      TEXT NOT NULL DEFAULT '[]',
        idempotency_key   TEXT,
        source_revision   TEXT,
        projection_lag    INTEGER NOT NULL DEFAULT 0,
        stale             INTEGER NOT NULL DEFAULT 0,
        failed_nodes      TEXT NOT NULL DEFAULT '[]',
        error             TEXT,
        created_at        INTEGER NOT NULL,
        started_at        INTEGER,
        completed_at      INTEGER,
        FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_narrative_matrix_rebuilds_project
        ON novel_narrative_matrix_rebuilds(project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS novel_narrative_matrix_rebuild_events (
        id            TEXT PRIMARY KEY,
        rebuild_id    TEXT NOT NULL,
        sequence_no   INTEGER NOT NULL,
        event_type    TEXT NOT NULL,
        payload       TEXT NOT NULL DEFAULT '{}',
        created_at    INTEGER NOT NULL,
        FOREIGN KEY (rebuild_id) REFERENCES novel_narrative_matrix_rebuilds(id) ON DELETE CASCADE,
        UNIQUE (rebuild_id, sequence_no)
      );
      CREATE INDEX IF NOT EXISTS idx_narrative_matrix_rebuild_events_rebuild
        ON novel_narrative_matrix_rebuild_events(rebuild_id, sequence_no);
    `
  },
  {
    // 115: P7 验收记录保存固定输入（方案 §9：验收记录必须保存固定输入）。
    // 此前只存 fixed_facts_hash，regenerate 无法复用场景事实文本，
    // 执行器会拿到空场景生成，破坏“regenerate 必须复用同一 facts hash”的不变量。
    id: '115_add_validation_scenario_facts',
    sql: `ALTER TABLE novel_reference_validation_runs ADD COLUMN scenario_facts TEXT NOT NULL DEFAULT '';`
  },
  {
    // 116: 卷级节拍规划表（Beat Planner）。
    // 一行 = 单章节拍，回答"这一章在卷弧光里负责什么"。
    // (project_id, chapter_number) 唯一：一章只属于一个节拍；重新规划按卷替换
    // planned/superseded 行，published 章的 confirmed 节拍保留（由 Store 层过滤）。
    id: '116_create_novel_beat_plans',
    sql: `CREATE TABLE IF NOT EXISTS novel_beat_plans (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL,
      volume_number     INTEGER NOT NULL,
      chapter_number    INTEGER NOT NULL,
      dramatic_function TEXT NOT NULL,
      emotional_debt    TEXT NOT NULL DEFAULT '',
      payoff            TEXT NOT NULL DEFAULT '',
      arc_position      TEXT NOT NULL DEFAULT '',
      summary           TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL DEFAULT 'planned'
                        CHECK (status IN ('planned', 'confirmed', 'superseded')),
      created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_beat_plans_project_volume
      ON novel_beat_plans(project_id, volume_number, chapter_number);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_beat_plans_project_chapter
      ON novel_beat_plans(project_id, chapter_number);`
  },
  {
    // 117: 【已停用】章节级 lengdu 读感质量报告列。
    //
    // lengdu 读感链路已整体移除（实测无效果）：读写该列的 store 方法、
    // publish 门与质量门信号均已删除，没有任何代码再访问 lengdu_quality。
    // 迁移本身保留：删掉会让新库无此列、旧库残留孤儿列，schema 分叉；
    // 保留则新旧库一致，代价只是一个不再写入的空列。
    id: '117_add_chapter_lengdu_quality',
    sql: `ALTER TABLE novel_chapters ADD COLUMN lengdu_quality TEXT;`
  },
  {
    // 118: 文风专家蒸馏契约 v2。
    //
    // 只有"正向手法清单"的专家会把正文推成模板腔：Writer 拿到十条规则就想样样做到。
    // v2 增补四类字段（参考 nuwa-skill 的心智模型方法论）：
    //   - expression_dna_json：句式/词汇/节奏/幽默/确定性/叙述距离六项语言指纹
    //   - tensions_json：文风自身拉扯的两股力量 + 取舍原则（不做取舍就会变成"全都要"）
    //   - anti_patterns_json：该文风明确避免的写法（区别于 exclusions 的"不可搬运内容"）
    //   - boundaries_json：这套能力覆盖不到的场景，防止被当万能风格套用
    // 手法卡自身的 failureMode 与三重验证记录仍存在 techniques_json 内（无需新列）。
    id: '118_add_style_expert_dna_and_tensions',
    sql: `
      ALTER TABLE novel_style_experts ADD COLUMN expression_dna_json TEXT;
      ALTER TABLE novel_style_experts ADD COLUMN tensions_json TEXT;
      ALTER TABLE novel_style_experts ADD COLUMN anti_patterns_json TEXT;
      ALTER TABLE novel_style_experts ADD COLUMN boundaries_json TEXT;
    `
  },
  {
    // 119: 参考小说专家团（一维一专家）。
    //
    // 分析完成后自动按维度生成专家团：场景/人物/对话/打斗/情感/冲突/叙事各一张卡，
    // 同一次生成共享 team_key（= referenceSourceId）便于分组展示与整团队召集。
    // review_status='draft' + enabled=0 的草稿态等待人工审核，历史行默认 approved。
    id: '119_add_style_expert_team_fields',
    sql: `
      ALTER TABLE novel_style_experts ADD COLUMN dimension TEXT;
      ALTER TABLE novel_style_experts ADD COLUMN team_key TEXT;
      ALTER TABLE novel_style_experts ADD COLUMN review_status TEXT NOT NULL DEFAULT 'approved';
      CREATE INDEX IF NOT EXISTS idx_novel_style_experts_team
        ON novel_style_experts(project_id, team_key);
    `
  }
  ,{
    // 120: 群聊动作图断点：acting 中断时精确恢复到失败节点之后。
    id: '120_add_discussion_run_failed_action_beat',
    sql: `ALTER TABLE novel_discussion_runs ADD COLUMN failed_action_beat_id TEXT;`
  }
  ,{
    // 121: 群聊事件溯源（2026-08-28 控制平面重排 T4）：append-only 事件日志。
    //
    // 状态 = fold(events)，续跑 = 重放，取代 failedPhase 三元组 + transcript 反推。
    // 首迭代与 novel_discussion_runs 快照并存：新 run 逐条追加事件，快照行仍按
    // 旧路径写（只读兼容），下迭代再退化 run 行为索引 + 游标并停写三元组列。
    id: '121_create_discussion_events',
    sql: `
      CREATE TABLE IF NOT EXISTS novel_discussion_events (
        run_id     TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        type       TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_novel_discussion_events_run
        ON novel_discussion_events(run_id, seq);
    `
  },
  {
    id: '122_add_gender_to_novel_characters',
    sql: `ALTER TABLE novel_characters ADD COLUMN gender TEXT;`
  },
  {
    // 123: Writer 分场断点续跑快照。
    // 保存已完成场次正文及其有效预算/重试次数，续跑从下一个未完成场次继续。
    id: '123_add_workflow_writer_scenes',
    sql: `ALTER TABLE novel_workflow_runs ADD COLUMN writer_scenes TEXT;`
  },
  {
    // 124: 章节工作流事件溯源：create-flow 脱离 HTTP 生命周期。
    //
    // 与 novel_discussion_events（121）同构：append-only，seq 在 run 内单调，
    // 前端以 seq 为游标做 tail 重连。表结构完全一致，仅领域不同，
    // 因此两边共用 RunEventStore 实现。
    id: '124_create_workflow_events',
    sql: `
      CREATE TABLE IF NOT EXISTS novel_workflow_events (
        run_id     TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        type       TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_novel_workflow_events_run
        ON novel_workflow_events(run_id, seq);
    `
  },
  {
    // 125: 共用的持久化创作运行内核；旧 workflow/discussion snapshots 暂留作兼容投影。
    id: '125_create_creation_run_runtime',
    sql: `
      CREATE TABLE IF NOT EXISTS novel_creation_runs (
        run_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        chapter_number INTEGER NOT NULL CHECK (chapter_number > 0),
        mode TEXT NOT NULL CHECK (mode IN ('workflow', 'discussion', 'arrange', 'reverse')),
        status TEXT NOT NULL CHECK (status IN ('submitted', 'running', 'waiting_input', 'revising', 'completed', 'failed', 'cancelled')),
        stage TEXT NOT NULL CHECK (stage IN ('planning', 'writing', 'acting', 'arranging', 'reviewing', 'revising', 'finalizing')),
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        checkpoint_id TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_creation_runs_active_chapter
        ON novel_creation_runs(project_id, chapter_number)
        WHERE status IN ('submitted', 'running', 'waiting_input', 'revising');
      CREATE INDEX IF NOT EXISTS idx_novel_creation_runs_project_updated
        ON novel_creation_runs(project_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS novel_creation_run_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq),
        FOREIGN KEY (run_id) REFERENCES novel_creation_runs(run_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_novel_creation_run_events_run
        ON novel_creation_run_events(run_id, seq);
    `
  }
  ,{
    // 126: 创作运行可报表指标。状态机保存生命周期，指标表保存可聚合的字数、修订、
    // 质量门、恢复、终态延迟和 token 维度，避免把分析字段塞进事件 payload。
    id: '126_create_creation_run_metrics',
    sql: `
      CREATE TABLE IF NOT EXISTS novel_creation_run_metrics (
        run_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        chapter_number INTEGER NOT NULL CHECK (chapter_number > 0),
        word_target INTEGER,
        word_actual INTEGER,
        word_deviation INTEGER,
        revision_rounds INTEGER NOT NULL DEFAULT 0,
        revision_patches INTEGER NOT NULL DEFAULT 0,
        quality_gate_failures INTEGER NOT NULL DEFAULT 0,
        recovery_result TEXT,
        terminal_latency_ms INTEGER,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        recorded_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES novel_creation_runs(run_id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_creation_run_metrics_project
        ON novel_creation_run_metrics(project_id, chapter_number, recorded_at DESC);
    `
  },
  {
    // 127: 记忆事实证据关联。事实本身继续由 novel_memory_events 承载，
    // 这里记录它被哪个创作 run 接受、对应哪个正文 revision，以及正文证据片段。
    id: '127_create_memory_fact_links',
    sql: `
      CREATE TABLE IF NOT EXISTS novel_memory_fact_links (
        id TEXT PRIMARY KEY,
        memory_event_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        chapter_number INTEGER NOT NULL,
        chapter_revision_id TEXT,
        body_evidence TEXT NOT NULL,
        fact_status TEXT NOT NULL DEFAULT 'pending',
        accepted_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (memory_event_id, run_id),
        FOREIGN KEY (memory_event_id) REFERENCES novel_memory_events(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES novel_creation_runs(run_id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_memory_fact_links_run
        ON novel_memory_fact_links(run_id, chapter_number);
      CREATE INDEX IF NOT EXISTS idx_memory_fact_links_event
        ON novel_memory_fact_links(memory_event_id);
    `
  }
]
