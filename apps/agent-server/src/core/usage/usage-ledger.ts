/**
 * UsageLedger：用量账本
 *
 * 记录每次 LLM 调用的 token 用量和成本，支持查询、汇总和过期清理。
 * 使用 SQLite 持久化（usage_records / usage_budget 表），内存数组作为聚合计算缓存。
 */

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
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

/** usage_records 表行结构 */
interface UsageRow {
  id: string
  timestamp: number
  session_id: string
  thread_id: string
  model: string
  provider: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  cost_usd: number
  duration_ms: number
  agent_id: string
}

/** usage_budget 表行结构 */
interface BudgetRow {
  monthly_budget_usd: number
  alert_threshold: number
}

export class UsageLedger {
  private readonly db: Database.Database
  private records: UsageRecord[] = []
  private budget: UsageBudget = { ...DEFAULT_BUDGET }

  // 预编译 SQL
  private readonly stmtInsert: Database.Statement
  private readonly stmtDeleteOld: Database.Statement
  private readonly stmtSelectBudget: Database.Statement
  private readonly stmtUpsertBudget: Database.Statement

  constructor(db: Database.Database) {
    this.db = db

    // 预编译 SQL，提升反复执行性能
    this.stmtInsert = db.prepare(`
      INSERT INTO usage_records (
        id, timestamp, session_id, thread_id, model, provider,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cost_usd, duration_ms, agent_id
      ) VALUES (
        @id, @timestamp, @session_id, @thread_id, @model, @provider,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
        @cost_usd, @duration_ms, @agent_id
      )
    `)
    this.stmtDeleteOld = db.prepare('DELETE FROM usage_records WHERE timestamp < ?')
    this.stmtSelectBudget = db.prepare('SELECT monthly_budget_usd, alert_threshold FROM usage_budget WHERE id = 1')
    this.stmtUpsertBudget = db.prepare(`
      INSERT INTO usage_budget (id, monthly_budget_usd, alert_threshold)
      VALUES (1, @monthly_budget_usd, @alert_threshold)
      ON CONFLICT(id) DO UPDATE SET
        monthly_budget_usd = excluded.monthly_budget_usd,
        alert_threshold = excluded.alert_threshold
    `)

    // 加载所有记录到内存（用于聚合计算）
    this.records = this.loadAllRecords()
    // 加载预算
    this.budget = this.loadBudget()
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
    const timestamp = Date.now()
    const full: UsageRecord = {
      ...record,
      id,
      timestamp,
      costUsd,
    }

    // 写入 SQLite
    this.stmtInsert.run({
      id,
      timestamp,
      session_id: record.sessionId,
      thread_id: record.threadId,
      model: record.model,
      provider: record.provider,
      input_tokens: record.inputTokens,
      output_tokens: record.outputTokens,
      cache_read_tokens: record.cacheReadTokens ?? null,
      cache_write_tokens: record.cacheWriteTokens ?? null,
      cost_usd: costUsd,
      duration_ms: record.durationMs,
      agent_id: record.agentId,
    })

    // 同步到内存数组
    this.records.push(full)

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
    // 动态构建 WHERE 子句
    const conditions: string[] = []
    const params: Record<string, unknown> = {}

    if (options?.from) {
      conditions.push('timestamp >= @from')
      params.from = options.from
    }
    if (options?.to) {
      conditions.push('timestamp <= @to')
      params.to = options.to
    }
    if (options?.model) {
      conditions.push('model = @model')
      params.model = options.model
    }
    if (options?.provider) {
      conditions.push('provider = @provider')
      params.provider = options.provider
    }
    if (options?.agentId) {
      conditions.push('agent_id = @agentId')
      params.agentId = options.agentId
    }
    if (options?.sessionId) {
      conditions.push('session_id = @sessionId')
      params.sessionId = options.sessionId
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? 100

    // 先查总数
    const countRow = this.db.prepare(`SELECT COUNT(*) as total FROM usage_records ${whereClause}`).get(params) as { total: number }
    const total = countRow.total

    // 再查分页数据
    const rows = this.db.prepare(
      `SELECT * FROM usage_records ${whereClause} ORDER BY timestamp ASC LIMIT @limit OFFSET @offset`,
    ).all({ ...params, limit, offset }) as UsageRow[]
    const records = rows.map((row) => this.rowToRecord(row))

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

  /** 获取当前会话用量（按 sessionId） */
  getSessionUsage(sessionId: string): UsageSummary {
    const filtered = this.records.filter((r) => r.sessionId === sessionId)
    return this.computeSummary(filtered)
  }

  /** 获取线程用量（按 threadId） */
  getThreadUsage(threadId: string): UsageSummary {
    const filtered = this.records.filter((r) => r.threadId === threadId)
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
    // 写入 SQLite
    this.stmtUpsertBudget.run({
      monthly_budget_usd: this.budget.monthlyBudgetUsd,
      alert_threshold: this.budget.alertThreshold,
    })
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
    // 从 SQLite 删除
    const result = this.stmtDeleteOld.run(cutoff)
    const removed = result.changes
    // 同步内存数组
    this.records = this.records.filter((r) => r.timestamp >= cutoff)
    return removed
  }

  /** 关闭存储（SQLite 自动持久化，无需操作） */
  close(): void {
    // SQLite 自动持久化，无需手动 flush
  }

  /** 从 SQLite 加载所有记录到内存 */
  private loadAllRecords(): UsageRecord[] {
    const rows = this.db.prepare('SELECT * FROM usage_records ORDER BY timestamp ASC').all() as UsageRow[]
    return rows.map((row) => this.rowToRecord(row))
  }

  /** 从 SQLite 加载预算设置 */
  private loadBudget(): UsageBudget {
    const row = this.stmtSelectBudget.get() as BudgetRow | undefined
    if (!row) {
      return { ...DEFAULT_BUDGET }
    }
    return {
      monthlyBudgetUsd: row.monthly_budget_usd,
      alertThreshold: row.alert_threshold,
    }
  }

  /** 将数据库行转换为 UsageRecord */
  private rowToRecord(row: UsageRow): UsageRecord {
    return {
      id: row.id,
      timestamp: row.timestamp,
      sessionId: row.session_id,
      threadId: row.thread_id,
      model: row.model,
      provider: row.provider,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens ?? undefined,
      cacheWriteTokens: row.cache_write_tokens ?? undefined,
      costUsd: row.cost_usd,
      durationMs: row.duration_ms,
      agentId: row.agent_id,
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
