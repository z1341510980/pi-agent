/**
 * SessionSummaryStore：会话摘要存储
 *
 * 使用 SQLite 存储会话摘要（session_summaries 表），支持 CRUD 操作。
 * 写操作同步落库以保证一致性，读操作走内存 Map 缓存。
 * key_decisions 和 topics 字段在 SQLite 中以 JSON 字符串存储。
 */

import type Database from 'better-sqlite3'

export interface SessionSummary {
  sessionId: string
  /** LLM 生成的摘要 */
  summary: string
  /** 关键决策 */
  keyDecisions: string[]
  /** 主题标签 */
  topics: string[]
  createdAt: number
  updatedAt: number
}

/** session_summaries 表行结构 */
interface SessionSummaryRow {
  session_id: string
  summary: string
  key_decisions: string
  topics: string
  created_at: number
  updated_at: number
}

export class SessionSummaryStore {
  private summaries: Map<string, SessionSummary> = new Map()

  /** 预编译 SQL，提升反复执行性能 */
  private readonly stmtUpsert: Database.Statement
  private readonly stmtDelete: Database.Statement
  private readonly stmtGetAll: Database.Statement

  constructor(db: Database.Database) {
    // 预编译语句
    this.stmtUpsert = db.prepare(`
      INSERT INTO session_summaries (session_id, summary, key_decisions, topics, created_at, updated_at)
      VALUES (@session_id, @summary, @key_decisions, @topics, @created_at, @updated_at)
      ON CONFLICT(session_id) DO UPDATE SET
        summary      = excluded.summary,
        key_decisions = excluded.key_decisions,
        topics       = excluded.topics,
        created_at   = excluded.created_at,
        updated_at   = excluded.updated_at
    `)
    this.stmtDelete = db.prepare('DELETE FROM session_summaries WHERE session_id = ?')
    this.stmtGetAll = db.prepare('SELECT * FROM session_summaries')

    // 启动时把所有摘要加载到内存 Map 作为读缓存
    try {
      const rows = this.stmtGetAll.all() as SessionSummaryRow[]
      for (const row of rows) {
        const summary = this.rowToSummary(row)
        this.summaries.set(summary.sessionId, summary)
      }
    } catch (err) {
      console.error('[SessionSummaryStore] 从 SQLite 加载失败，历史数据可能丢失:', err)
    }
  }

  /** 将数据库行转换为 SessionSummary */
  private rowToSummary(row: SessionSummaryRow): SessionSummary {
    let keyDecisions: string[] = []
    let topics: string[] = []
    try {
      const parsed = JSON.parse(row.key_decisions)
      if (Array.isArray(parsed)) keyDecisions = parsed
    } catch {
      // key_decisions 字段损坏时回退为空数组
    }
    try {
      const parsed = JSON.parse(row.topics)
      if (Array.isArray(parsed)) topics = parsed
    } catch {
      // topics 字段损坏时回退为空数组
    }
    return {
      sessionId: row.session_id,
      summary: row.summary,
      keyDecisions,
      topics,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /** 持久化单条摘要到 SQLite（UPSERT，静默失败） */
  private persist(summary: SessionSummary): void {
    try {
      this.stmtUpsert.run({
        session_id: summary.sessionId,
        summary: summary.summary,
        key_decisions: JSON.stringify(summary.keyDecisions),
        topics: JSON.stringify(summary.topics),
        created_at: summary.createdAt,
        updated_at: summary.updatedAt,
      })
    } catch (err) {
      console.error('[SessionSummaryStore] persist 失败，数据仅存在于内存中:', err)
    }
  }

  /** 保存会话摘要 */
  async saveSummary(summary: SessionSummary): Promise<void> {
    this.summaries.set(summary.sessionId, summary)
    this.persist(summary)
  }

  /** 获取会话摘要 */
  async getSummary(sessionId: string): Promise<SessionSummary | null> {
    return this.summaries.get(sessionId) ?? null
  }

  /** 列出所有摘要 */
  async listSummaries(): Promise<SessionSummary[]> {
    return Array.from(this.summaries.values())
  }

  /** 删除摘要 */
  async deleteSummary(sessionId: string): Promise<void> {
    this.summaries.delete(sessionId)
    try {
      this.stmtDelete.run(sessionId)
    } catch (err) {
      console.error('[SessionSummaryStore] deleteSummary 失败:', err)
    }
  }

  /** 关闭存储。写操作已即时落库，无需额外持久化 */
  async close(): Promise<void> {
    // 数据已在每次写操作时同步写入 SQLite，此处无需额外处理
  }
}
