import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type Database from 'better-sqlite3'
import { novelSchema } from './schema/index.js'

export type NovelDrizzleDb = BetterSQLite3Database<typeof novelSchema>

/** 为现有 better-sqlite3 连接创建 ORM 适配器。连接生命周期仍由 database 插件管理。 */
export function createNovelDrizzleDb(sqlite: Database.Database): NovelDrizzleDb {
  return drizzle(sqlite, { schema: novelSchema })
}
