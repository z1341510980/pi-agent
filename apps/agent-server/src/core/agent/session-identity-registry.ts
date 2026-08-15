/**
 * 会话身份注册表（方案 §9.4 会话身份索引 P0）
 *
 * 持久化 threadId → Pi session 文件路径 的映射，解决：
 * - 会话被 LRU 淘汰或进程重启后，getSessionFilePath 拿不到 JSONL 路径，
 *   历史消息分页返回空；
 * - 重启后聊天线程拿不到原会话，历史丢失。
 *
 * 数据流：
 * - PiSessionStore 在会话创建成功后异步写入（fire-and-forget，失败不影响会话）；
 * - getSessionFilePath 内存 miss 时回退查表；
 * - getOrCreate 内存 miss 且非 plugin:* 线程时，用表中路径恢复原会话
 *   （pi-session 通过 SessionManager.open 打开既有 JSONL）。
 */

import type Database from 'better-sqlite3'

export interface SessionIdentityRegistry {
  get(threadId: string): string | null
  put(threadId: string, sessionPath: string): void
}

/** SQLite 实现：表 pi_session_identity（迁移 015）。 */
export class SqliteSessionIdentityRegistry implements SessionIdentityRegistry {
  private readonly stmtGet: Database.Statement
  private readonly stmtPut: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.stmtGet = db.prepare(
      'SELECT session_path FROM pi_session_identity WHERE thread_id = ?',
    )
    this.stmtPut = db.prepare(`
      INSERT INTO pi_session_identity (thread_id, session_path, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        session_path = excluded.session_path,
        updated_at   = excluded.updated_at
    `)
  }

  get(threadId: string): string | null {
    const row = this.stmtGet.get(threadId) as { session_path: string } | undefined
    return row?.session_path ?? null
  }

  put(threadId: string, sessionPath: string): void {
    this.stmtPut.run(threadId, sessionPath, Date.now())
  }
}
