import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'

/**
 * Evidence Ledger：工具调用证据记录
 *
 * 参考 ARCHITECTURE.md §22.8。使用 SQLite 持久化（evidence 表）：
 * - 每次工具调用后插入一条记录
 * - 记录工具名、参数摘要、结果摘要、是否出错、时间戳
 * - 完整的 Final Readiness Check 验证留到后续阶段
 */

export interface EvidenceEntry {
  /** 记录 ID（hash） */
  id: string
  /** 线程 ID */
  threadId: string
  /** 工具调用 ID */
  toolCallId: string
  /** 工具名 */
  toolName: string
  /** 参数摘要（前 500 字符） */
  argsSummary: string
  /** 结果摘要（前 1000 字符） */
  resultSummary: string
  /** 是否出错 */
  isError: boolean
  /** 时间戳 ISO */
  timestamp: string
}

export interface EvidenceRecordOptions {
  threadId: string
  db: Database.Database
}

/** evidence 表行结构 */
interface EvidenceRow {
  id: string
  thread_id: string
  tool_call_id: string
  tool_name: string
  args_summary: string | null
  result_summary: string | null
  is_error: number
  timestamp: string
}

export class EvidenceLedger {
  private readonly threadId: string
  private readonly db: Database.Database
  // 预编译 SQL
  private readonly stmtInsert: Database.Statement
  private readonly stmtSelectByThread: Database.Statement

  constructor(options: EvidenceRecordOptions) {
    this.threadId = options.threadId
    this.db = options.db

    // 预编译 SQL，提升反复执行性能
    this.stmtInsert = this.db.prepare(`
      INSERT INTO evidence (id, thread_id, tool_call_id, tool_name, args_summary, result_summary, is_error, timestamp)
      VALUES (@id, @thread_id, @tool_call_id, @tool_name, @args_summary, @result_summary, @is_error, @timestamp)
    `)
    this.stmtSelectByThread = this.db.prepare('SELECT * FROM evidence WHERE thread_id = ? ORDER BY timestamp ASC')
  }

  /**
   * 记录一次工具调用的证据
   * 在 afterToolCall 钩子中调用
   */
  record(entry: Omit<EvidenceEntry, 'id' | 'threadId' | 'timestamp'>): EvidenceEntry {
    const full: EvidenceEntry = {
      ...entry,
      id: this.hash(entry.toolCallId, entry.toolName, Date.now()),
      threadId: this.threadId,
      timestamp: new Date().toISOString(),
    }

    // 写入 SQLite
    this.stmtInsert.run({
      id: full.id,
      thread_id: full.threadId,
      tool_call_id: full.toolCallId,
      tool_name: full.toolName,
      args_summary: full.argsSummary,
      result_summary: full.resultSummary,
      is_error: full.isError ? 1 : 0,
      timestamp: full.timestamp,
    })

    return full
  }

  /** 读取当前线程的所有证据记录 */
  readAll(): EvidenceEntry[] {
    const rows = this.stmtSelectByThread.all(this.threadId) as EvidenceRow[]
    return rows.map((row) => this.rowToEntry(row))
  }

  /** 将数据库行转换为 EvidenceEntry */
  private rowToEntry(row: EvidenceRow): EvidenceEntry {
    return {
      id: row.id,
      threadId: row.thread_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      argsSummary: row.args_summary ?? '',
      resultSummary: row.result_summary ?? '',
      isError: row.is_error === 1,
      timestamp: row.timestamp,
    }
  }

  private hash(...parts: unknown[]): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
  }
}

/** 工具参数摘要：截断长字符串，保留结构 */
export function summarizeArgs(args: Record<string, unknown>): string {
  const json = JSON.stringify(args)
  return json.length > 500 ? json.slice(0, 500) + '...' : json
}

/** 工具结果摘要：截断长输出 */
export function summarizeResult(result: unknown): string {
  if (typeof result === 'string') {
    return result.length > 1000 ? result.slice(0, 1000) + '...' : result
  }
  const json = JSON.stringify(result)
  return json.length > 1000 ? json.slice(0, 1000) + '...' : json
}
