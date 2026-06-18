/**
 * SessionSummaryStore：会话摘要存储
 *
 * 使用 JSON 文件存储会话摘要，支持 CRUD 操作。
 * 文件路径：${dataDir}/agent/summaries.json
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteSync } from '@repo/shared/utils'

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

export class SessionSummaryStore {
  private readonly filePath: string
  private summaries: Map<string, SessionSummary> = new Map()
  private loaded = false

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'agent', 'summaries.json')
  }

  /** 延迟加载：首次访问时从文件读取 */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    if (existsSync(this.filePath)) {
      try {
        const content = readFileSync(this.filePath, 'utf-8')
        const data = JSON.parse(content) as SessionSummary[]
        for (const s of data) {
          if (s && typeof s.sessionId === 'string') {
            this.summaries.set(s.sessionId, s)
          }
        }
      } catch (err) {
        console.error(`[SessionSummaryStore] 加载 ${this.filePath} 失败，历史数据可能丢失:`, err)
      }
    }
  }

  /** 持久化到文件（静默失败，保留 dirty 标记以便重试） */
  private dirty = false

  private persist(): void {
    try {
      const data = Array.from(this.summaries.values())
      atomicWriteSync(this.filePath, JSON.stringify(data, null, 2))
      this.dirty = false
    } catch (err) {
      console.error(`[SessionSummaryStore] persist 失败，数据仅存在于内存中:`, err)
    }
  }

  /** 持久化到文件（失败时抛出异常，用于 close 场景） */
  private persistOrThrow(): void {
    try {
      const data = Array.from(this.summaries.values())
      atomicWriteSync(this.filePath, JSON.stringify(data, null, 2))
      this.dirty = false
    } catch (err) {
      console.error(`[SessionSummaryStore] close 时 persist 失败，数据可能丢失:`, err)
      throw err
    }
  }

  /** 保存会话摘要 */
  async saveSummary(summary: SessionSummary): Promise<void> {
    this.ensureLoaded()
    this.summaries.set(summary.sessionId, summary)
    this.dirty = true
    this.persist()
  }

  /** 获取会话摘要 */
  async getSummary(sessionId: string): Promise<SessionSummary | null> {
    this.ensureLoaded()
    return this.summaries.get(sessionId) ?? null
  }

  /** 列出所有摘要 */
  async listSummaries(): Promise<SessionSummary[]> {
    this.ensureLoaded()
    return Array.from(this.summaries.values())
  }

  /** 删除摘要 */
  async deleteSummary(sessionId: string): Promise<void> {
    this.ensureLoaded()
    this.summaries.delete(sessionId)
    this.dirty = true
    this.persist()
  }

  /** 关闭存储，持久化脏数据。持久化失败时抛出异常让调用方感知 */
  async close(): Promise<void> {
    if (this.dirty) {
      this.persistOrThrow()
    }
  }
}
