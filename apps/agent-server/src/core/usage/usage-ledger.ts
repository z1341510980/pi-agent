/**
 * UsageLedger：用量账本
 *
 * 记录每次 LLM 调用的 token 用量和成本，支持查询、汇总和过期清理。
 * 使用 JSON 文件存储（${dataDir}/agent/usage.json），atomicWriteSync 持久化。
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteSync } from '@repo/shared/utils'
import { calculateCost } from './cost-rates.js'

export interface UsageRecord {
  /** UUID */
  id: string
  /** 时间戳 */
  timestamp: number
  /** 会话 ID */
  sessionId: string
  /** 线程 ID */
  threadId: string
  /** 模型名 */
  model: string
  /** Provider 名 */
  provider: string
  /** 输入 token 数 */
  inputTokens: number
  /** 输出 token 数 */
  outputTokens: number
  /** 缓存读取 token 数 */
  cacheReadTokens?: number
  /** 缓存写入 token 数 */
  cacheWriteTokens?: number
  /** 成本（USD） */
  costUsd: number
  /** 调用耗时（毫秒） */
  durationMs: number
  /** Agent ID */
  agentId: string
}

export interface UsageSummary {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalCostUsd: number
  totalCalls: number
  byModel: Record<string, { calls: number; costUsd: number; inputTokens: number; outputTokens: number }>
  byAgent: Record<string, { calls: number; costUsd: number }>
}

/** 四舍五入到 8 位小数（微美分精度），避免浮点漂移 */
const roundUsd = (n: number) => Math.round(n * 1e8) / 1e8

export class UsageLedger {
  private readonly filePath: string
  private records: UsageRecord[] = []
  private dirty = false

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'agent', 'usage.json')
    this.load()
  }

  /** 记录一次 LLM 调用（costUsd 由内部自动计算，调用方无需传入） */
  record(record: Omit<UsageRecord, 'id' | 'timestamp' | 'costUsd'>): string {
    const costUsd = calculateCost({
      model: record.model,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadTokens: record.cacheReadTokens,
      cacheWriteTokens: record.cacheWriteTokens,
    })

    const id = randomUUID()
    const full: UsageRecord = {
      ...record,
      id,
      timestamp: Date.now(),
      costUsd,
    }

    this.records.push(full)
    this.dirty = true
    this.persist()
    return id
  }

  /** 查询用量（支持时间范围、模型、Agent 过滤） */
  query(options?: {
    from?: number
    to?: number
    model?: string
    agentId?: string
    sessionId?: string
    limit?: number
    offset?: number
  }): { records: UsageRecord[]; total: number } {
    let filtered = this.records

    if (options?.from) {
      filtered = filtered.filter((r) => r.timestamp >= options.from!)
    }
    if (options?.to) {
      filtered = filtered.filter((r) => r.timestamp <= options.to!)
    }
    if (options?.model) {
      filtered = filtered.filter((r) => r.model === options.model)
    }
    if (options?.agentId) {
      filtered = filtered.filter((r) => r.agentId === options.agentId)
    }
    if (options?.sessionId) {
      filtered = filtered.filter((r) => r.sessionId === options.sessionId)
    }

    const total = filtered.length
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? 100
    const records = filtered.slice(offset, offset + limit)

    return { records, total }
  }

  /** 获取汇总统计 */
  getSummary(options?: {
    from?: number
    to?: number
    agentId?: string
  }): UsageSummary {
    let filtered = this.records

    if (options?.from) {
      filtered = filtered.filter((r) => r.timestamp >= options.from!)
    }
    if (options?.to) {
      filtered = filtered.filter((r) => r.timestamp <= options.to!)
    }
    if (options?.agentId) {
      filtered = filtered.filter((r) => r.agentId === options.agentId)
    }

    return this.computeSummary(filtered)
  }

  /** 获取当前会话用量 */
  getSessionUsage(sessionId: string): UsageSummary {
    const filtered = this.records.filter((r) => r.sessionId === sessionId)
    return this.computeSummary(filtered)
  }

  /** 清理过期记录（保留最近 N 天） */
  prune(keepDays = 90): number {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000
    const before = this.records.length
    this.records = this.records.filter((r) => r.timestamp >= cutoff)
    const removed = before - this.records.length
    if (removed > 0) {
      this.dirty = true
      this.persist()
    }
    return removed
  }

  /** 关闭存储，持久化脏数据。持久化失败时抛出异常让调用方感知 */
  close(): void {
    if (this.dirty) {
      this.persistOrThrow()
    }
  }

  /** 从文件加载记录 */
  private load(): void {
    if (!existsSync(this.filePath)) {
      this.records = []
      return
    }
    try {
      const content = readFileSync(this.filePath, 'utf8')
      const data = JSON.parse(content)
      if (!Array.isArray(data)) {
        this.records = []
        return
      }
      // 校验记录结构，剔除无效条目
      this.records = data.filter((r: unknown, i: number) => {
        if (r && typeof r === 'object' && typeof (r as Record<string, unknown>).model === 'string' && typeof (r as Record<string, unknown>).costUsd === 'number') return true
        console.warn(`[UsageLedger] 跳过无效记录 #${i}:`, r)
        return false
      }) as UsageRecord[]
    } catch (err) {
      console.error(`[UsageLedger] 加载 ${this.filePath} 失败，历史数据可能丢失:`, err)
      this.records = []
    }
  }

  /** 持久化到文件（静默失败，保留 dirty 标记以便重试） */
  private persist(): void {
    try {
      atomicWriteSync(this.filePath, JSON.stringify(this.records, null, 2))
      this.dirty = false
    } catch (err) {
      console.error(`[UsageLedger] persist 失败，数据仅存在于内存中:`, err)
      // 保留 dirty 标记，下次 record 时重试
    }
  }

  /** 持久化到文件（失败时抛出异常，用于 close 场景） */
  private persistOrThrow(): void {
    try {
      atomicWriteSync(this.filePath, JSON.stringify(this.records, null, 2))
      this.dirty = false
    } catch (err) {
      console.error(`[UsageLedger] close 时 persist 失败，数据可能丢失:`, err)
      throw err
    }
  }

  /** 计算汇总统计 */
  private computeSummary(records: UsageRecord[]): UsageSummary {
    const byModel: UsageSummary['byModel'] = {}
    const byAgent: UsageSummary['byAgent'] = {}
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCacheReadTokens = 0
    let totalCacheWriteTokens = 0
    let totalCostUsd = 0

    for (const r of records) {
      totalInputTokens += r.inputTokens
      totalOutputTokens += r.outputTokens
      totalCacheReadTokens += r.cacheReadTokens ?? 0
      totalCacheWriteTokens += r.cacheWriteTokens ?? 0
      totalCostUsd += r.costUsd

      if (!byModel[r.model]) {
        byModel[r.model] = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 }
      }
      byModel[r.model].calls++
      byModel[r.model].costUsd += r.costUsd
      byModel[r.model].inputTokens += r.inputTokens
      byModel[r.model].outputTokens += r.outputTokens

      if (!byAgent[r.agentId]) {
        byAgent[r.agentId] = { calls: 0, costUsd: 0 }
      }
      byAgent[r.agentId].calls++
      byAgent[r.agentId].costUsd += r.costUsd
    }

    return {
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheWriteTokens,
      totalCostUsd: roundUsd(totalCostUsd),
      totalCalls: records.length,
      byModel: Object.fromEntries(
        Object.entries(byModel).map(([k, v]) => [k, { ...v, costUsd: roundUsd(v.costUsd) }]),
      ),
      byAgent: Object.fromEntries(
        Object.entries(byAgent).map(([k, v]) => [k, { ...v, costUsd: roundUsd(v.costUsd) }]),
      ),
    }
  }
}
