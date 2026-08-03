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
  }
]
