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
  /** 最近一次 LLM 调用的输入 token 数（代表当前上下文窗口实际占用） */
  lastInputTokens: number
  byModel: Record<string, { calls: number; costUsd: number; inputTokens: number; outputTokens: number }>
  byAgent: Record<string, { calls: number; costUsd: number }>
}

/** 按 Provider 聚合的统计项 */
export interface ProviderUsageStat {
  calls: number
  costUsd: number
  inputTokens: number
  outputTokens: number
}

/** 按模型聚合的统计项 */
export interface ModelUsageStat {
  calls: number
  costUsd: number
  inputTokens: number
  outputTokens: number
}

/** 预算设置 */
export interface UsageBudget {
  /** 月度预算（USD） */
  monthlyBudgetUsd: number
  /** 告警阈值（百分比，0-100） */
  alertThreshold: number
}

/** 默认预算设置 */
const DEFAULT_BUDGET: UsageBudget = {
  monthlyBudgetUsd: 0,
  alertThreshold: 80,
}

/** 四舍五入到 8 位小数（微美分精度），避免浮点漂移 */
const roundUsd = (n: number) => Math.round(n * 1e8) / 1e8

/** 格式化日期为 YYYY-MM-DD（本地时区） */
function formatDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export class UsageLedger {
  private readonly filePath: string
  private readonly budgetFilePath: string
  private records: UsageRecord[] = []
  private budget: UsageBudget = { ...DEFAULT_BUDGET }
  private dirty = false
  private budgetDirty = false

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'agent', 'usage.json')
    this.budgetFilePath = join(dataDir, 'agent', 'usage-budget.json')
    this.load()
    this.loadBudget()
  }

  /** 记录一次 LLM 调用（costUsd 由内部自动计算，调用方无需传入） */
  record(record: Omit<UsageRecord, 'id' | 'timestamp' | 'costUsd'>): { id: string; costUsd: number } {
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
    return { id, costUsd }
  }

  /** 查询用量（支持时间范围、模型、Agent 过滤） */
  query(options?: {
    from?: number
    to?: number
    model?: string
    provider?: string
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
    if (options?.provider) {
      filtered = filtered.filter((r) => r.provider === options.provider)
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

  /** 按 Provider 聚合统计 */
  getByProvider(options?: {
    from?: number
    to?: number
    agentId?: string
  }): Record<string, ProviderUsageStat> {
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

    const result: Record<string, ProviderUsageStat> = {}
    for (const r of filtered) {
      if (!result[r.provider]) {
        result[r.provider] = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 }
      }
      result[r.provider].calls++
      result[r.provider].costUsd += r.costUsd
      result[r.provider].inputTokens += r.inputTokens
      result[r.provider].outputTokens += r.outputTokens
    }

    // 四舍五入成本
    for (const key of Object.keys(result)) {
      result[key].costUsd = roundUsd(result[key].costUsd)
    }
    return result
  }

  /** 按模型聚合统计 */
  getByModel(options?: {
    from?: number
    to?: number
    agentId?: string
    provider?: string
  }): Record<string, ModelUsageStat> {
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
    if (options?.provider) {
      filtered = filtered.filter((r) => r.provider === options.provider)
    }

    const result: Record<string, ModelUsageStat> = {}
    for (const r of filtered) {
      if (!result[r.model]) {
        result[r.model] = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 }
      }
      result[r.model].calls++
      result[r.model].costUsd += r.costUsd
      result[r.model].inputTokens += r.inputTokens
      result[r.model].outputTokens += r.outputTokens
    }

    for (const key of Object.keys(result)) {
      result[key].costUsd = roundUsd(result[key].costUsd)
    }
    return result
  }

  /** 获取按日聚合的用量数据（最近 N 天，含空日填充） */
  getDaily(options?: {
    days?: number
    agentId?: string
  }): Array<{
    date: string
    costUsd: number
    inputTokens: number
    outputTokens: number
    calls: number
  }> {
    const days = Math.min(Math.max(options?.days ?? 7, 1), 90)
    const agentId = options?.agentId

    // 计算日期范围（本地时区，按自然日对齐）
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const fromMs = todayStart.getTime() - (days - 1) * 24 * 60 * 60 * 1000

    // 过滤记录
    let filtered = this.records.filter((r) => r.timestamp >= fromMs)
    if (agentId) {
      filtered = filtered.filter((r) => r.agentId === agentId)
    }

    // 按日聚合
    const byDate = new Map<
      string,
      { costUsd: number; inputTokens: number; outputTokens: number; calls: number }
    >()
    for (const r of filtered) {
      const d = new Date(r.timestamp)
      const dateKey = formatDateKey(d)
      const entry = byDate.get(dateKey) ?? {
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        calls: 0,
      }
      entry.costUsd += r.costUsd
      entry.inputTokens += r.inputTokens
      entry.outputTokens += r.outputTokens
      entry.calls++
      byDate.set(dateKey, entry)
    }

    // 填充日期范围（含空日），按日期升序返回
    const result: Array<{
      date: string
      costUsd: number
      inputTokens: number
      outputTokens: number
      calls: number
    }> = []
    for (let i = 0; i < days; i++) {
      const d = new Date(fromMs + i * 24 * 60 * 60 * 1000)
      const dateKey = formatDateKey(d)
      const entry = byDate.get(dateKey)
      result.push({
        date: dateKey,
        costUsd: entry ? roundUsd(entry.costUsd) : 0,
        inputTokens: entry?.inputTokens ?? 0,
        outputTokens: entry?.outputTokens ?? 0,
        calls: entry?.calls ?? 0,
      })
    }

    return result
  }

  /** 导出 CSV 格式的用量数据 */
  exportCsv(options?: {
    from?: number
    to?: number
    agentId?: string
  }): string {
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

    // 按时间升序排列
    filtered = [...filtered].sort((a, b) => a.timestamp - b.timestamp)

    const header = [
      'id',
      'timestamp',
      'datetime',
      'sessionId',
      'threadId',
      'agentId',
      'provider',
      'model',
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'costUsd',
      'durationMs',
    ].join(',')

    const rows = filtered.map((r) => {
      const dt = new Date(r.timestamp).toISOString()
      return [
        r.id,
        r.timestamp,
        dt,
        r.sessionId,
        r.threadId,
        r.agentId,
        r.provider,
        r.model,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadTokens ?? 0,
        r.cacheWriteTokens ?? 0,
        r.costUsd.toFixed(8),
        r.durationMs,
      ].join(',')
    })

    return [header, ...rows].join('\n')
  }

  /** 获取预算设置 */
  getBudget(): UsageBudget {
    return { ...this.budget }
  }

  /** 设置预算 */
  setBudget(budget: Partial<UsageBudget>): UsageBudget {
    if (budget.monthlyBudgetUsd !== undefined) {
      this.budget.monthlyBudgetUsd = Math.max(0, budget.monthlyBudgetUsd)
    }
    if (budget.alertThreshold !== undefined) {
      this.budget.alertThreshold = Math.min(100, Math.max(0, budget.alertThreshold))
    }
    this.budgetDirty = true
    this.persistBudget()
    return { ...this.budget }
  }

  /** 获取当月用量统计（用于预算告警） */
  getMonthlyUsage(): { costUsd: number; budgetUsd: number; threshold: number; percentage: number; exceeded: boolean; warning: boolean } {
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    const summary = this.getSummary({ from: monthStart })
    const budgetUsd = this.budget.monthlyBudgetUsd
    const threshold = this.budget.alertThreshold
    const percentage = budgetUsd > 0 ? (summary.totalCostUsd / budgetUsd) * 100 : 0
    return {
      costUsd: summary.totalCostUsd,
      budgetUsd,
      threshold,
      percentage: Math.round(percentage * 100) / 100,
      exceeded: budgetUsd > 0 && summary.totalCostUsd >= budgetUsd,
      warning: budgetUsd > 0 && percentage >= threshold,
    }
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
    if (this.budgetDirty) {
      this.persistBudgetOrThrow()
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

  /** 加载预算设置 */
  private loadBudget(): void {
    if (!existsSync(this.budgetFilePath)) {
      this.budget = { ...DEFAULT_BUDGET }
      return
    }
    try {
      const content = readFileSync(this.budgetFilePath, 'utf8')
      const data = JSON.parse(content) as Partial<UsageBudget>
      this.budget = {
        monthlyBudgetUsd: typeof data.monthlyBudgetUsd === 'number' ? data.monthlyBudgetUsd : DEFAULT_BUDGET.monthlyBudgetUsd,
        alertThreshold: typeof data.alertThreshold === 'number' ? data.alertThreshold : DEFAULT_BUDGET.alertThreshold,
      }
    } catch (err) {
      console.error(`[UsageLedger] 加载预算文件 ${this.budgetFilePath} 失败:`, err)
      this.budget = { ...DEFAULT_BUDGET }
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

  /** 持久化预算设置（静默失败） */
  private persistBudget(): void {
    try {
      atomicWriteSync(this.budgetFilePath, JSON.stringify(this.budget, null, 2))
      this.budgetDirty = false
    } catch (err) {
      console.error(`[UsageLedger] persist 预算失败:`, err)
    }
  }

  /** 持久化预算设置（失败时抛出异常） */
  private persistBudgetOrThrow(): void {
    atomicWriteSync(this.budgetFilePath, JSON.stringify(this.budget, null, 2))
    this.budgetDirty = false
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
    let lastInputTokens = 0
    let lastTimestamp = 0

    for (const r of records) {
      totalInputTokens += r.inputTokens
      totalOutputTokens += r.outputTokens
      totalCacheReadTokens += r.cacheReadTokens ?? 0
      totalCacheWriteTokens += r.cacheWriteTokens ?? 0
      totalCostUsd += r.costUsd

      // 跟踪最近一次调用的 inputTokens（代表当前上下文窗口占用）
      if (r.timestamp >= lastTimestamp) {
        lastTimestamp = r.timestamp
        lastInputTokens = r.inputTokens
      }

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
      lastInputTokens,
      byModel: Object.fromEntries(
        Object.entries(byModel).map(([k, v]) => [k, { ...v, costUsd: roundUsd(v.costUsd) }]),
      ),
      byAgent: Object.fromEntries(
        Object.entries(byAgent).map(([k, v]) => [k, { ...v, costUsd: roundUsd(v.costUsd) }]),
      ),
    }
  }
}
