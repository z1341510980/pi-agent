import type Database from 'better-sqlite3'
import type { MigrationDefinition } from '../../core/plugin/plugin-types.js'

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  )
}

/**
 * 媒体 Provider 体系随功能迁入本插件：把宿主 017 建的 media_providers 表
 * 整体搬成 infinite_canvas_media_providers（列结构一致，INSERT SELECT 平移），
 * 搬完 DROP 宿主表。
 *
 * 两态覆盖：
 * - 存量库：017 已建表（可能有数据）→ 搬数据 → 删宿主表；
 * - 全新库：017 先建空宿主表 → 本迁移建插件表、搬 0 行、删宿主表（干净收尾）。
 * 幂等：宿主表不存在时直接跳过；重复搬入由插件表主键去重守卫挡住。
 */
function migrateHostMediaProviders(db: Database.Database): void {
  if (!tableExists(db, 'media_providers')) return
  db.exec(`
    INSERT INTO infinite_canvas_media_providers (
      id, name, modality, adapter, base_url, api_key, model, params,
      enabled, is_default, created_at, updated_at
    )
    SELECT
      h.id, h.name, h.modality, h.adapter, h.base_url, h.api_key, h.model, h.params,
      h.enabled, h.is_default, h.created_at, h.updated_at
    FROM media_providers h
    WHERE NOT EXISTS (
      SELECT 1 FROM infinite_canvas_media_providers p WHERE p.id = h.id
    );
  `)
  db.exec('DROP TABLE media_providers;')
}

export const infiniteCanvasMigrations: MigrationDefinition[] = [
  {
    id: '116_create_infinite_canvas',
    sql: `
      CREATE TABLE IF NOT EXISTS infinite_canvas_projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        viewport_json TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS infinite_canvas_nodes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES infinite_canvas_projects(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        x REAL NOT NULL DEFAULT 0,
        y REAL NOT NULL DEFAULT 0,
        width REAL NOT NULL DEFAULT 280,
        height REAL NOT NULL DEFAULT 180,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_infinite_canvas_nodes_project ON infinite_canvas_nodes(project_id);
      CREATE TABLE IF NOT EXISTS infinite_canvas_connections (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES infinite_canvas_projects(id) ON DELETE CASCADE,
        from_node_id TEXT NOT NULL REFERENCES infinite_canvas_nodes(id) ON DELETE CASCADE,
        to_node_id TEXT NOT NULL REFERENCES infinite_canvas_nodes(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        UNIQUE(project_id, from_node_id, to_node_id)
      );
      CREATE INDEX IF NOT EXISTS idx_infinite_canvas_connections_project ON infinite_canvas_connections(project_id);
    `
  },
  {
    id: '117_add_infinite_canvas_project_settings',
    sql: `ALTER TABLE infinite_canvas_projects ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'`
  },
  {
    id: '118_create_infinite_canvas_prompt_cache',
    sql: `
      CREATE TABLE IF NOT EXISTS infinite_canvas_prompt_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        homepage TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_fetched_at INTEGER,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS infinite_canvas_prompt_items (
        id TEXT NOT NULL,
        source_id TEXT NOT NULL REFERENCES infinite_canvas_prompt_sources(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        cover_url TEXT NOT NULL DEFAULT '',
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_items_source ON infinite_canvas_prompt_items(source_id);
    `
  },
  {
    id: '119_create_infinite_canvas_media_settings',
    sql: `
      CREATE TABLE IF NOT EXISTS infinite_canvas_media_settings (
        id TEXT PRIMARY KEY DEFAULT 'default',
        image_base_url TEXT NOT NULL DEFAULT '',
        image_api_key TEXT NOT NULL DEFAULT '',
        image_model TEXT NOT NULL DEFAULT '',
        image_size TEXT NOT NULL DEFAULT '1024x1024',
        updated_at INTEGER
      )
    `
  },
  {
    id: '120_add_infinite_canvas_media_protocol',
    sql: `
      ALTER TABLE infinite_canvas_media_settings ADD COLUMN image_protocol TEXT NOT NULL DEFAULT 'openai-images';
      ALTER TABLE infinite_canvas_media_settings ADD COLUMN image_resolution TEXT NOT NULL DEFAULT '';
      ALTER TABLE infinite_canvas_media_settings ADD COLUMN image_language TEXT NOT NULL DEFAULT 'en';
    `
  },
  {
    id: '121_create_infinite_canvas_assets',
    sql: `
      CREATE TABLE IF NOT EXISTS infinite_canvas_assets (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES infinite_canvas_projects(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        mime TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        source_url TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_infinite_canvas_assets_project ON infinite_canvas_assets(project_id);
    `
  },
  {
    id: '122_add_infinite_canvas_assets_status',
    sql: `ALTER TABLE infinite_canvas_assets ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'`
  },
  {
    id: '123_create_infinite_canvas_media_logs',
    sql: `
      ALTER TABLE infinite_canvas_assets ADD COLUMN content_hash TEXT;
      CREATE INDEX IF NOT EXISTS idx_infinite_canvas_assets_hash ON infinite_canvas_assets(content_hash);
      CREATE TABLE IF NOT EXISTS infinite_canvas_media_logs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        project_id TEXT,
        endpoint TEXT NOT NULL,
        model TEXT,
        size TEXT,
        prompt TEXT NOT NULL DEFAULT '',
        references_json TEXT NOT NULL DEFAULT '[]',
        mask_path TEXT,
        response_json TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        trace_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_infinite_canvas_media_logs_created
        ON infinite_canvas_media_logs(created_at DESC);
    `
  },
  {
    // 媒体 Provider 表迁入插件（宿主 017 的接棒者）：结构与宿主表逐列一致，
    // store（./media/media-provider-store.ts）只认本表；存量数据由 afterApply 平移。
    id: '018_create_infinite_canvas_media_providers',
    sql: `
      CREATE TABLE IF NOT EXISTS infinite_canvas_media_providers (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        modality   TEXT NOT NULL,
        adapter    TEXT NOT NULL,
        base_url   TEXT NOT NULL DEFAULT '',
        api_key    TEXT NOT NULL DEFAULT '',
        model      TEXT NOT NULL DEFAULT '',
        params     TEXT NOT NULL DEFAULT '{}',
        enabled    INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_infinite_canvas_media_providers_modality
        ON infinite_canvas_media_providers(modality);
    `,
    afterApply: migrateHostMediaProviders
  },
  {
    // 媒体偏好键值对（settings 面板的跨会话 UI 偏好）：key 固定枚举
    // （如 analyzeModel = 反推提示词模型），value 文本；读写见 media/media-prefs-store.ts。
    id: '019_create_infinite_canvas_media_prefs',
    sql: `
      CREATE TABLE IF NOT EXISTS infinite_canvas_media_prefs (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `
  }
]
