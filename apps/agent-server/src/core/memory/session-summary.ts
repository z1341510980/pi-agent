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
          this.summaries.set(s.sessionId, s)
        }
      } catch {
        // 文件损坏时忽略，从空状态开始
      }
    }
  }

  /** 持久化到文件 */
  private persist(): void {
    const data = Array.from(this.summaries.values())
    atomicWriteSync(this.filePath, JSON.stringify(data, null, 2))
  }

  /** 保存会话摘要 */
  async saveSummary(summary: SessionSummary): Promise<void> {
    this.ensureLoaded()
    this.summaries.set(summary.sessionId, summary)
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
    this.persist()
  }
}
