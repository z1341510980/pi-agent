/**
 * MediaPrefsStore：媒体偏好键值对存储（infinite_canvas_media_prefs 表，迁移 019）。
 *
 * 与 MediaProviderStore 同款模式：better-sqlite3 同步语句 + 预编译，
 * DB 由构造注入（插件 setup 用 context.db，与宿主同库）；表结构由插件迁移
 * 019_create_infinite_canvas_media_prefs 创建，本 store 只读写。
 * 目前仅承载反推提示词模型偏好（analyzeModel，值形如 'provider:model'）；
 * 读取缺失返回 null，写入 upsert，清除删除行。
 */

import type Database from 'better-sqlite3'

/** 媒体偏好 key：反推提示词使用的视觉理解模型（'provider:model' 格式）。 */
export const MEDIA_PREF_ANALYZE_MODEL = 'analyzeModel'

export class MediaPrefsStore {
  private readonly stmtGet: Database.Statement
  private readonly stmtUpsert: Database.Statement
  private readonly stmtDelete: Database.Statement

  constructor(db: Database.Database) {
    // 预编译 SQL，提升反复执行性能
    this.stmtGet = db.prepare('SELECT value FROM infinite_canvas_media_prefs WHERE key = ?')
    this.stmtUpsert = db.prepare(`
      INSERT INTO infinite_canvas_media_prefs (key, value) VALUES (@key, @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
    this.stmtDelete = db.prepare('DELETE FROM infinite_canvas_media_prefs WHERE key = ?')
  }

  /** 读取偏好；缺失返回 null。 */
  getPref(key: string): string | null {
    const row = this.stmtGet.get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  /** 写入偏好（upsert，同 key 覆盖）。 */
  setPref(key: string, value: string): void {
    this.stmtUpsert.run({ key, value })
  }

  /** 清除偏好（删除行；行不存在时静默）。 */
  removePref(key: string): void {
    this.stmtDelete.run(key)
  }
}
