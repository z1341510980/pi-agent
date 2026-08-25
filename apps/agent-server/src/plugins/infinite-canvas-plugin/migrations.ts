import type { MigrationDefinition } from '../../core/plugin/plugin-types.js'

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
  }
]
