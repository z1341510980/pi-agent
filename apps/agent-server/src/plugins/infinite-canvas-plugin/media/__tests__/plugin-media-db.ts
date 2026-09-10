import type Database from 'better-sqlite3'
import { applyMigrations } from '../../../../core/db/migrations.js'
import { infiniteCanvasMigrations } from '../../migrations.js'

export const PLUGIN_MEDIA_MIGRATION_ID = '018_create_infinite_canvas_media_providers'

/**
 * 建插件媒体 Provider 表：真实执行 018 迁移（SQL + afterApply + ledger 记录），
 * 与插件加载期 applyMigrations(app.db, [migration]) 的行为一致。
 * 宿主 017 已由 018 接棒（搬数据后 DROP），测试不再依赖宿主 media_providers 表。
 */
export function applyPluginMediaMigration(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY);')
  const migration = infiniteCanvasMigrations.find(
    (item) => item.id === PLUGIN_MEDIA_MIGRATION_ID
  )
  if (!migration) throw new Error(`插件迁移 ${PLUGIN_MEDIA_MIGRATION_ID} 未定义`)
  applyMigrations(db, [migration])
}
