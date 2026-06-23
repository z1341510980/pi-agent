/**
 * SessionFileRegistry：会话文件注册表
 *
 * 参考 ARCHITECTURE.md §20。管理工具执行产出的文件：
 * - 生命周期管理（会话结束后清理 managed_cache 文件）
 * - 去重（同一内容文件多次引用共享存储）
 * - 恢复（重新打开会话时能找到文件）
 *
 * 存储布局：
 * - {dataDir}/session-files/{hash}/   — managed_cache 文件，按内容 hash 组织
 * - {dataDir}/session-files/.refcount.json — 全局引用计数，用于去重清理
 * - {dataDir}/session-files/.file-index.json — 全局文件 ID 索引，用于 getFileById
 * - {sessionPath}/.files.json         — 会话文件索引 sidecar
 *
 * storageKind 说明：
 * - managed_cache：由 Agent 管理的缓存文件，会话结束时可清理
 * - external：外部文件（如用户工作区中的文件），不清理
 * - install_source：安装来源文件（如模板），不清理
 */

import { existsSync, readFileSync, mkdirSync, copyFileSync, statSync, rmSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { atomicWriteSync } from '@repo/shared/utils'

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

/** 引用计数表：hash → 引用数 */
type RefcountMap = Record<string, number>
/** 全局文件 ID 索引：fileId → SessionFileRecord */
type FileIndexMap = Record<string, SessionFileRecord>

export class SessionFileRegistry {
  private readonly dataDir: string
  private readonly managedCacheDir: string
  private readonly refcountFile: string
  private readonly fileIndexFile: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.managedCacheDir = join(dataDir, 'session-files')
    this.refcountFile = join(this.managedCacheDir, '.refcount.json')
    this.fileIndexFile = join(this.managedCacheDir, '.file-index.json')
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

    const full: SessionFileRecord = {
      ...record,
      fileId,
      createdAt,
      filePath,
      ...(contentHash !== undefined ? { contentHash } : {}),
      ...(this.getFileSize(filePath) !== undefined ? { sizeBytes: this.getFileSize(filePath) } : {}),
    }

    // 写入会话 sidecar
    this.appendToSessionIndex(record.sessionPath, full)

    // 写入全局文件 ID 索引
    this.addToGlobalIndex(full)

    return full
  }

  /** 获取会话的所有文件记录 */
  getFilesForSession(sessionPath: string): SessionFileRecord[] {
    return this.loadSessionIndex(sessionPath)
  }

  /** 按 ID 获取文件记录（通过全局索引查找） */
  getFileById(fileId: string): SessionFileRecord | null {
    const index = this.loadGlobalIndex()
    return index[fileId] ?? null
  }

  /**
   * 清理会话的所有 managed_cache 文件
   *
   * - 对每个 managed_cache 文件：减少引用计数，计数归零时删除物理文件
   * - external / install_source 文件不清理
   * - 删除会话的 .files.json sidecar
   * - 从全局索引中移除该会话的所有记录
   *
   * @param sessionPath 会话目录路径
   * @returns 清理的文件数量
   */
  cleanupSession(sessionPath: string): number {
    const records = this.loadSessionIndex(sessionPath)
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

    // 从全局索引中移除该会话的所有记录
    this.removeFromGlobalBySession(sessionPath)

    // 删除会话 sidecar
    const sidecar = this.getSidecarPath(sessionPath)
    if (existsSync(sidecar)) {
      rmSync(sidecar, { force: true })
    }

    return cleaned
  }

  // ===== 内部方法 =====

  /** 获取会话 sidecar 文件路径 */
  private getSidecarPath(sessionPath: string): string {
    return join(sessionPath, '.files.json')
  }

  /** 加载会话的文件索引 */
  private loadSessionIndex(sessionPath: string): SessionFileRecord[] {
    const sidecar = this.getSidecarPath(sessionPath)
    if (!existsSync(sidecar)) return []
    try {
      const content = readFileSync(sidecar, 'utf-8')
      const data = JSON.parse(content) as SessionFileRecord[]
      return Array.isArray(data) ? data : []
    } catch (err) {
      console.error(`[SessionFileRegistry] 加载 sidecar ${sidecar} 失败:`, err)
      return []
    }
  }

  /** 追加文件记录到会话 sidecar */
  private appendToSessionIndex(sessionPath: string, record: SessionFileRecord): void {
    const records = this.loadSessionIndex(sessionPath)
    records.push(record)
    const sidecar = this.getSidecarPath(sessionPath)
    mkdirSync(sessionPath, { recursive: true })
    atomicWriteSync(sidecar, JSON.stringify(records, null, 2))
  }

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

  /** 加载全局引用计数表 */
  private loadRefcount(): RefcountMap {
    if (!existsSync(this.refcountFile)) return {}
    try {
      const content = readFileSync(this.refcountFile, 'utf-8')
      const data = JSON.parse(content) as RefcountMap
      return data && typeof data === 'object' ? data : {}
    } catch {
      return {}
    }
  }

  /** 保存全局引用计数表 */
  private saveRefcount(map: RefcountMap): void {
    mkdirSync(this.managedCacheDir, { recursive: true })
    atomicWriteSync(this.refcountFile, JSON.stringify(map, null, 2))
  }

  /** 增加引用计数 */
  private incrementRefcount(hash: string): void {
    const map = this.loadRefcount()
    map[hash] = (map[hash] ?? 0) + 1
    this.saveRefcount(map)
  }

  /** 减少引用计数，返回剩余引用数 */
  private decrementRefcount(hash: string): number {
    const map = this.loadRefcount()
    const current = map[hash] ?? 0
    const next = Math.max(0, current - 1)
    if (next > 0) {
      map[hash] = next
      this.saveRefcount(map)
    }
    return next
  }

  /** 从引用计数表中移除某 hash */
  private removeRefcount(hash: string): void {
    const map = this.loadRefcount()
    delete map[hash]
    this.saveRefcount(map)
  }

  /** 加载全局文件 ID 索引 */
  private loadGlobalIndex(): FileIndexMap {
    if (!existsSync(this.fileIndexFile)) return {}
    try {
      const content = readFileSync(this.fileIndexFile, 'utf-8')
      const data = JSON.parse(content) as FileIndexMap
      return data && typeof data === 'object' ? data : {}
    } catch {
      return {}
    }
  }

  /** 保存全局文件 ID 索引 */
  private saveGlobalIndex(map: FileIndexMap): void {
    mkdirSync(this.managedCacheDir, { recursive: true })
    atomicWriteSync(this.fileIndexFile, JSON.stringify(map, null, 2))
  }

  /** 添加记录到全局索引 */
  private addToGlobalIndex(record: SessionFileRecord): void {
    const map = this.loadGlobalIndex()
    map[record.fileId] = record
    this.saveGlobalIndex(map)
  }

  /** 从全局索引中移除指定会话的所有记录 */
  private removeFromGlobalBySession(sessionPath: string): void {
    const map = this.loadGlobalIndex()
    let changed = false
    for (const fileId of Object.keys(map)) {
      if (map[fileId].sessionPath === sessionPath) {
        delete map[fileId]
        changed = true
      }
    }
    if (changed) {
      this.saveGlobalIndex(map)
    }
  }
}
