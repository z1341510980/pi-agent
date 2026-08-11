/**
 * ThreadSettingsStore：每个 thread 独立的轻量设置存储（当前仅 thinkingLevel）
 *
 * 设计动机：
 * - pi-coding-agent SDK 的 `defaultThinkingLevel` 是全局设置（SettingsManager），
 *   所有 thread 共享同一值，无法满足"不同 conversation 用不同思考强度"的需求。
 * - 此处引入 thread 级独立存储：每个 threadId 各自持久化一个 thinkingLevel，
 *   创建 PiSession 时按 thread 读取并透传给 createAgentSession。
 *
 * 持久化：SQLite `thread_thinking_levels` 表（迁移 014 创建）。
 * 写操作同步落库；读操作走内存 Map（启动时全量加载）。
 */
import type Database from 'better-sqlite3'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'

/** 允许持久化的 thinkingLevel 集合（与 SDK 的 ThinkingLevel 枚举一致） */
const VALID_LEVELS = new Set<ThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
])

export class ThreadSettingsStore {
  private readonly thinkingLevels = new Map<string, ThinkingLevel>()

  private readonly stmtSelectAll: Database.Statement
  private readonly stmtUpsert: Database.Statement
  private readonly stmtDelete: Database.Statement

  constructor(db: Database.Database) {
    this.stmtSelectAll = db.prepare('SELECT thread_id, thinking_level FROM thread_thinking_levels')
    this.stmtUpsert = db.prepare(`
      INSERT INTO thread_thinking_levels (thread_id, thinking_level, updated_at)
      VALUES (@thread_id, @thinking_level, unixepoch())
      ON CONFLICT(thread_id) DO UPDATE SET
        thinking_level = excluded.thinking_level,
        updated_at     = unixepoch()
    `)
    this.stmtDelete = db.prepare('DELETE FROM thread_thinking_levels WHERE thread_id = ?')

    // 启动时把已有记录加载到内存 Map
    const rows = this.stmtSelectAll.all() as Array<{
      thread_id: string
      thinking_level: string
    }>
    for (const row of rows) {
      if (VALID_LEVELS.has(row.thinking_level as ThinkingLevel)) {
        this.thinkingLevels.set(row.thread_id, row.thinking_level as ThinkingLevel)
      }
    }
  }

  /** 获取指定 thread 的 thinkingLevel；未设置时返回 undefined */
  getThinkingLevel(threadId: string): ThinkingLevel | undefined {
    return this.thinkingLevels.get(threadId)
  }

  /**
   * 设置指定 thread 的 thinkingLevel。level 必须属于 SDK ThinkingLevel 枚举，
   * 否则抛 Error（防止写入无效数据）。
   */
  setThinkingLevel(threadId: string, level: ThinkingLevel): void {
    if (!VALID_LEVELS.has(level)) {
      throw new Error(`无效的 thinkingLevel: ${level}`)
    }
    this.thinkingLevels.set(threadId, level)
    this.stmtUpsert.run({ thread_id: threadId, thinking_level: level })
  }

  /** 清除指定 thread 的 thinkingLevel（恢复为 SDK 全局默认） */
  clearThinkingLevel(threadId: string): boolean {
    const existed = this.thinkingLevels.delete(threadId)
    if (existed) {
      this.stmtDelete.run(threadId)
    }
    return existed
  }
}