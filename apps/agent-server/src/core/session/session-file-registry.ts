/**
 * SessionFileRegistry：会话文件注册表
 *
 * 参考 ARCHITECTURE.md §20。管理工具执行产出的文件：
 * - 生命周期管理（会话结束后清理 managed_cache 文件）
 * - 去重（同一内容文件多次引用共享存储）
 * - 恢复（重新打开会话时能找到文件）
 *
 * 存储布局：
 * - {dataDir}/session-files/{hash}/   — managed_cache 文件内容，按内容 hash 组织（文件系统）
 * - session_files 表                  — 文件元数据/索引（SQLite）
 * - file_refcount 表                  — 全局引用计数，用于去重清理（SQLite）
 *
 * storageKind 说明：
 * - managed_cache：由 Agent 管理的缓存文件，会话结束时可清理
 * - external：外部文件（如用户工作区中的文件），不清理
 * - install_source：安装来源文件（如模板），不清理
 */

import { existsSync, readFileSync, mkdirSync, copyFileSync, statSync, rmSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

/** 会话文件记录 */
export interface SessionFileRecord {
  /** 唯一 ID */
  fileId: string
  /** 文件绝对路径（managed_cache 下为 {dataDir}/session-files/{hash}/{原名}） */
  filePath: string
  /** 所属会话路径（会话目录） */
  sessionPath: string
  /** 显示名称 */
  label: string
  /** 来源：agent_output | stage_files | plugin_output | ... */
  origin: string
  /** 存储类型：managed_cache | external | install_source */
  storageKind: string
  /** 创建时间戳 ISO */
  createdAt: string
  /** 文件大小（字节） */
  sizeBytes?: number
  /** 内容 hash（仅 managed_cache 文件有值，用于去重） */
  contentHash?: string
}

/** session_files 表的行结构 */
interface SessionFileRow {
  file_id: string
  file_path: string
  session_path: string
  label: string
  origin: string
  storage_kind: string
  content_hash: string | null
  size_bytes: number | null
  created_at: string
}

/** 将数据库行转换为 SessionFileRecord 对象 */
function rowToRecord(row: SessionFileRow): SessionFileRecord {
  return {
    fileId: row.file_id,
    filePath: row.file_path,
    sessionPath: row.session_path,
    label: row.label,
    origin: row.origin,
    storageKind: row.storage_kind,
    createdAt: row.created_at,
    ...(row.size_bytes != null ? { sizeBytes: row.size_bytes } : {}),
    ...(row.content_hash != null ? { contentHash: row.content_hash } : {}),
  }
}

export class SessionFileRegistry {
  private readonly db: Database.Database
  private readonly managedCacheDir: string

  // 预编译语句 — session_files 表
  private readonly stmtInsertFile: Database.Statement
  private readonly stmtSelectBySession: Database.Statement
  private readonly stmtSelectByFileId: Database.Statement
  private readonly stmtDeleteBySession: Database.Statement

  // 预编译语句 — file_refcount 表
  private readonly stmtUpsertRefcount: Database.Statement
  private readonly stmtDecrementRefcount: Database.Statement
  private readonly stmtDeleteRefcount: Database.Statement

  constructor(db: Database.Database, dataDir: string) {
    this.db = db
    this.managedCacheDir = join(dataDir, 'session-files')

    // 预编译 session_files 表的语句
    this.stmtInsertFile = db.prepare(
      `INSERT INTO session_files (file_id, file_path, session_path, label, origin, storage_kind, content_hash, size_bytes, created_at)
       VALUES (@file_id, @file_path, @session_path, @label, @origin, @storage_kind, @content_hash, @size_bytes, @created_at)`,
    )
    this.stmtSelectBySession = db.prepare(
      `SELECT * FROM session_files WHERE session_path = ?`,
    )
    this.stmtSelectByFileId = db.prepare(
      `SELECT * FROM session_files WHERE file_id = ?`,
    )
    this.stmtDeleteBySession = db.prepare(
      `DELETE FROM session_files WHERE session_path = ?`,
    )

    // 预编译 file_refcount 表的语句
    // UPSERT：存在则递增，不存在则插入 1
    this.stmtUpsertRefcount = db.prepare(
      `INSERT INTO file_refcount (content_hash, refcount) VALUES (?, 1)
       ON CONFLICT(content_hash) DO UPDATE SET refcount = refcount + 1`,
    )
    // 递减并返回新值（RETURNING 需要 SQLite 3.35+）
    this.stmtDecrementRefcount = db.prepare(
      `UPDATE file_refcount SET refcount = MAX(0, refcount - 1) WHERE content_hash = ? RETURNING refcount`,
    )
    this.stmtDeleteRefcount = db.prepare(
      `DELETE FROM file_refcount WHERE content_hash = ?`,
    )
  }

  /**
   * 注册文件
   *
   * - managed_cache 文件：复制到 {dataDir}/session-files/{hash}/ 下，去重（同内容共享存储）
   * - external / install_source 文件：仅记录元数据，不复制
   *
   * @param record 不含 fileId 和 createdAt 的文件记录
   * @returns 完整的文件记录（含 fileId 和 createdAt）
   */
  registerFile(record: Omit<SessionFileRecord, 'fileId' | 'createdAt'>): SessionFileRecord {
    const fileId = randomUUID()
    const createdAt = new Date().toISOString()

    let filePath = record.filePath
    let contentHash: string | undefined

    if (record.storageKind === 'managed_cache') {
      // 计算内容 hash
      contentHash = this.hashFile(record.filePath)
      const targetDir = join(this.managedCacheDir, contentHash)

      // 去重：如果 hash 目录已存在，复用其中的文件；否则复制源文件
      if (existsSync(targetDir)) {
        const existing = this.findExistingFileInDir(targetDir)
        if (existing) {
          // 复用已有文件（内容相同）
          filePath = existing
        } else {
          // hash 目录存在但为空，复制源文件
          const targetPath = join(targetDir, basename(record.filePath))
          copyFileSync(record.filePath, targetPath)
          filePath = targetPath
        }
      } else {
        // 首次注册该 hash，复制到 managed_cache
        mkdirSync(targetDir, { recursive: true })
        const targetPath = join(targetDir, basename(record.filePath))
        copyFileSync(record.filePath, targetPath)
        filePath = targetPath
      }

      // 增加引用计数
      this.incrementRefcount(contentHash)
    }

    const sizeBytes = this.getFileSize(filePath)

    const full: SessionFileRecord = {
      ...record,
      fileId,
      createdAt,
      filePath,
      ...(contentHash !== undefined ? { contentHash } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    }

    // 写入 SQLite（会话索引和全局文件 ID 索引统一由 session_files 表承载）
    this.stmtInsertFile.run({
      file_id: full.fileId,
      file_path: full.filePath,
      session_path: full.sessionPath,
      label: full.label,
      origin: full.origin,
      storage_kind: full.storageKind,
      content_hash: full.contentHash ?? null,
      size_bytes: full.sizeBytes ?? null,
      created_at: full.createdAt,
    })

    return full
  }

  /** 获取会话的所有文件记录 */
  getFilesForSession(sessionPath: string): SessionFileRecord[] {
    const rows = this.stmtSelectBySession.all(sessionPath) as SessionFileRow[]
    return rows.map(rowToRecord)
  }

  /** 按 ID 获取文件记录（通过全局索引查找） */
  getFileById(fileId: string): SessionFileRecord | null {
    const row = this.stmtSelectByFileId.get(fileId) as SessionFileRow | undefined
    return row ? rowToRecord(row) : null
  }

  /**
   * 清理会话的所有 managed_cache 文件
   *
   * - 对每个 managed_cache 文件：减少引用计数，计数归零时删除物理文件
   * - external / install_source 文件不清理
   * - 从 SQLite 中删除该会话的所有记录
   *
   * @param sessionPath 会话目录路径
   * @returns 清理的文件数量
   */
  cleanupSession(sessionPath: string): number {
    const records = this.getFilesForSession(sessionPath)
    let cleaned = 0

    for (const record of records) {
      if (record.storageKind !== 'managed_cache') continue
      if (!record.contentHash) continue

      const remaining = this.decrementRefcount(record.contentHash)
      if (remaining <= 0) {
        // 引用计数归零，删除物理文件目录
        const hashDir = join(this.managedCacheDir, record.contentHash)
        if (existsSync(hashDir)) {
          rmSync(hashDir, { recursive: true, force: true })
        }
        this.removeRefcount(record.contentHash)
      }
      cleaned++
    }

    // 从 SQLite 中删除该会话的所有记录
    this.stmtDeleteBySession.run(sessionPath)

    return cleaned
  }

  // ===== 内部方法 =====

  /** 计算文件内容的 SHA-256 hash */
  private hashFile(filePath: string): string {
    const content = readFileSync(filePath)
    return createHash('sha256').update(content).digest('hex').slice(0, 32)
  }

  /** 获取文件大小（字节），文件不存在时返回 undefined */
  private getFileSize(filePath: string): number | undefined {
    try {
      return statSync(filePath).size
    } catch {
      return undefined
    }
  }

  /** 在目录中查找已有的文件（返回第一个文件的完整路径） */
  private findExistingFileInDir(dir: string): string | null {
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        const fullPath = join(dir, entry)
        try {
          if (statSync(fullPath).isFile()) {
            return fullPath
          }
        } catch {
          // 跳过无法访问的条目
        }
      }
    } catch {
      // 目录不存在或无法读取
    }
    return null
  }

  /** 增加引用计数 */
  private incrementRefcount(hash: string): void {
    this.stmtUpsertRefcount.run(hash)
  }

  /** 减少引用计数，返回剩余引用数 */
  private decrementRefcount(hash: string): number {
    const result = this.stmtDecrementRefcount.get(hash) as { refcount: number } | undefined
    return result?.refcount ?? 0
  }

  /** 从引用计数表中移除某 hash */
  private removeRefcount(hash: string): void {
    this.stmtDeleteRefcount.run(hash)
  }
}
