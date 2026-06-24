import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { runMigrations } from '../core/db/migrations.js'
import { UsageLedger } from '../core/usage/usage-ledger.js'

let tempDir: string
let db: Database.Database

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'pi-usage-test-'))
  db = new Database(':memory:')
  runMigrations(db)
})

afterEach(() => {
  db.close()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('UsageLedger', () => {
  it('record 记录一次 LLM 调用并返回 ID', () => {
    const ledger = new UsageLedger(db)
    const id = ledger.record({
      sessionId: 'session-1',
      threadId: 'thread-1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 1000,
      outputTokens: 500,
      durationMs: 1200,
      agentId: 'default',
    })

    expect(id).toBeTruthy()
    ledger.close()
  })

  it('record 自动计算 costUsd', () => {
    const ledger = new UsageLedger(db)
    ledger.record({
      sessionId: 'session-1',
      threadId: 'thread-1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      durationMs: 1000,
      agentId: 'default',
    })

    const { records } = ledger.query({ limit: 10 })
    // deepseek-chat: inputPer1M=0.27, outputPer1M=1.10
    expect(records[0].costUsd).toBeCloseTo(0.27 + 1.10, 6)
    ledger.close()
  })

  it('query 支持时间范围过滤', () => {
    const ledger = new UsageLedger(db)
    const now = Date.now()

    ledger.record({
      sessionId: 's1',
      threadId: 't1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 100,
      agentId: 'default',
    })

    const { total: totalAll } = ledger.query({})
    expect(totalAll).toBe(1)

    // 过去范围：不应匹配
    const { total: totalPast } = ledger.query({ from: now + 10000 })
    expect(totalPast).toBe(0)

    ledger.close()
  })

  it('query 支持模型过滤', () => {
    const ledger = new UsageLedger(db)

    ledger.record({
      sessionId: 's1',
      threadId: 't1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 100,
      agentId: 'default',
    })
    ledger.record({
      sessionId: 's1',
      threadId: 't1',
      model: 'gpt-4o',
      provider: 'openai',
      inputTokens: 200,
      outputTokens: 100,
      durationMs: 200,
      agentId: 'default',
    })

    const { records, total } = ledger.query({ model: 'gpt-4o' })
    expect(total).toBe(1)
    expect(records[0].model).toBe('gpt-4o')

    ledger.close()
  })

  it('query 支持 agentId 过滤', () => {
    const ledger = new UsageLedger(db)

    ledger.record({
      sessionId: 's1',
      threadId: 't1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 100,
      agentId: 'agent-a',
    })
    ledger.record({
      sessionId: 's1',
      threadId: 't1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 200,
      outputTokens: 100,
      durationMs: 200,
      agentId: 'agent-b',
    })

    const { total } = ledger.query({ agentId: 'agent-a' })
    expect(total).toBe(1)

    ledger.close()
  })

  it('query 支持 sessionId 过滤', () => {
    const ledger = new UsageLedger(db)

    ledger.record({
      sessionId: 's1',
      threadId: 't1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 100,
      agentId: 'default',
    })
    ledger.record({
      sessionId: 's2',
      threadId: 't1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 200,
      outputTokens: 100,
      durationMs: 200,
      agentId: 'default',
    })

    const { total } = ledger.query({ sessionId: 's1' })
    expect(total).toBe(1)

    ledger.close()
  })

  it('query 支持分页', () => {
    const ledger = new UsageLedger(db)

    for (let i = 0; i < 5; i++) {
      ledger.record({
        sessionId: `s${i}`,
        threadId: 't1',
        model: 'deepseek-chat',
        provider: 'deepseek',
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 100,
        agentId: 'default',
      })
    }

    const { records, total } = ledger.query({ limit: 2, offset: 0 })
    expect(total).toBe(5)
    expect(records).toHaveLength(2)

    const { records: records2 } = ledger.query({ limit: 2, offset: 2 })
    expect(records2).toHaveLength(2)

    ledger.close()
  })

  it('getSummary 返回汇总统计', () => {
    const ledger = new UsageLedger(db)

    ledger.record({
      sessionId: 's1',
      threadId: 't1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 1000,
      outputTokens: 500,
      durationMs: 1000,
      agentId: 'agent-a',
    })
    ledger.record({
      sessionId: 's1',
      threadId: 't1',
      model: 'gpt-4o',
      provider: 'openai',
      inputTokens: 2000,
      outputTokens: 1000,
      durationMs: 2000,
      agentId: 'agent-b',
    })

    const summary = ledger.getSummary()
    expect(summary.totalCalls).toBe(2)
    expect(summary.totalInputTokens).toBe(3000)
    expect(summary.totalOutputTokens).toBe(1500)
    expect(summary.totalCostUsd).toBeGreaterThan(0)

    // byModel
    expect(summary.byModel['deepseek-chat']).toBeDefined()
    expect(summary.byModel['deepseek-chat'].calls).toBe(1)
    expect(summary.byModel['gpt-4o']).toBeDefined()
    expect(summary.byModel['gpt-4o'].calls).toBe(1)

    // byAgent
    expect(summary.byAgent['agent-a']).toBeDefined()
    expect(summary.byAgent['agent-b']).toBeDefined()

    ledger.close()
  })

  it('getSessionUsage 返回指定会话的汇总', () => {
    const ledger = new UsageLedger(db)

    ledger.record({
      sessionId: 's1',
      threadId: 't1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 1000,
      outputTokens: 500,
      durationMs: 1000,
      agentId: 'default',
    })
    ledger.record({
      sessionId: 's2',
      threadId: 't1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 2000,
      outputTokens: 1000,
      durationMs: 2000,
      agentId: 'default',
    })

    const summary = ledger.getSessionUsage('s1')
    expect(summary.totalCalls).toBe(1)
    expect(summary.totalInputTokens).toBe(1000)

    ledger.close()
  })

  it('prune 清理过期记录', async () => {
    const ledger = new UsageLedger(db)

    // 记录一条
    ledger.record({
      sessionId: 's1',
      threadId: 't1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 100,
      agentId: 'default',
    })

    // 等待确保 prune(0) 的 cutoff 严格大于记录的 timestamp
    // Windows 上 setTimeout 精度低，需循环等待 Date.now() 真正前进
    const recordTime = Date.now()
    while (Date.now() === recordTime) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }

    // 保留 0 天 = 清理所有记录
    const removed = ledger.prune(0)
    expect(removed).toBe(1)

    const { total } = ledger.query({})
    expect(total).toBe(0)

    ledger.close()
  })

  it('prune 保留最近 N 天的记录', () => {
    const ledger = new UsageLedger(db)

    ledger.record({
      sessionId: 's1',
      threadId: 't1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 100,
      agentId: 'default',
    })

    // 保留 90 天，刚写入的记录不应被清理
    const removed = ledger.prune(90)
    expect(removed).toBe(0)

    const { total } = ledger.query({})
    expect(total).toBe(1)

    ledger.close()
  })

  it('持久化到 SQLite 数据库', () => {
    const dbPath = join(tempDir, 'test.db')
    const fileDb = new Database(dbPath)
    runMigrations(fileDb)

    const ledger = new UsageLedger(fileDb)
    ledger.record({
      sessionId: 's1',
      threadId: 't1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 1000,
      outputTokens: 500,
      durationMs: 1000,
      agentId: 'default',
    })

    ledger.close()
    fileDb.close()

    // 重新打开数据库，验证记录已持久化
    const reopenDb = new Database(dbPath)
    const row = reopenDb.prepare('SELECT COUNT(*) as count FROM usage_records').get() as { count: number }
    expect(row.count).toBe(1)

    const record = reopenDb.prepare('SELECT * FROM usage_records WHERE session_id = ?').get('s1') as {
      model: string
      session_id: string
    }
    expect(record.model).toBe('deepseek-chat')
    expect(record.session_id).toBe('s1')

    reopenDb.close()
  })

  it('从数据库加载已有记录', () => {
    const dbPath = join(tempDir, 'test.db')
    const fileDb = new Database(dbPath)
    runMigrations(fileDb)

    // 先写入一条记录
    const ledger1 = new UsageLedger(fileDb)
    ledger1.record({
      sessionId: 's1',
      threadId: 't1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 1000,
      outputTokens: 500,
      durationMs: 1000,
      agentId: 'default',
    })
    ledger1.close()
    fileDb.close()

    // 重新打开数据库，创建新的 ledger，应能加载已有记录
    const reopenDb = new Database(dbPath)
    const ledger2 = new UsageLedger(reopenDb)
    const { total } = ledger2.query({})
    expect(total).toBe(1)

    ledger2.close()
    reopenDb.close()
  })

  it('空数据库初始化正常', () => {
    const ledger = new UsageLedger(db)
    const { total } = ledger.query({})
    expect(total).toBe(0)

    const summary = ledger.getSummary()
    expect(summary.totalCalls).toBe(0)

    ledger.close()
  })

  it('getDaily 默认返回最近 7 天（含空日填充）', () => {
    const ledger = new UsageLedger(db)

    ledger.record({
      sessionId: 's1',
      threadId: 't1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 1000,
      outputTokens: 500,
      durationMs: 1000,
      agentId: 'default',
    })

    const daily = ledger.getDaily()
    expect(daily).toHaveLength(7)
    // 最后一天是今天，应有数据
    const today = daily[6]
    expect(today.calls).toBe(1)
    expect(today.inputTokens).toBe(1000)
    expect(today.outputTokens).toBe(500)
    expect(today.costUsd).toBeGreaterThan(0)
    // 前面的天应为空
    expect(daily[0].calls).toBe(0)
    expect(daily[0].costUsd).toBe(0)
    // 日期格式应为 YYYY-MM-DD
    expect(today.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // 日期应升序排列
    for (let i = 1; i < daily.length; i++) {
      expect(daily[i].date > daily[i - 1].date).toBe(true)
    }

    ledger.close()
  })

  it('getDaily 支持自定义 days 参数', () => {
    const ledger = new UsageLedger(db)

    ledger.record({
      sessionId: 's1',
      threadId: 't1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 100,
      agentId: 'default',
    })

    const daily = ledger.getDaily({ days: 3 })
    expect(daily).toHaveLength(3)

    ledger.close()
  })

  it('getDaily 支持按日聚合多条记录', () => {
    const ledger = new UsageLedger(db)

    // 同一天写入 3 条记录
    for (let i = 0; i < 3; i++) {
      ledger.record({
        sessionId: `s${i}`,
        threadId: 't1',
        model: 'deepseek-chat',
        provider: 'deepseek',
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 100,
        agentId: 'default',
      })
    }

    const daily = ledger.getDaily({ days: 1 })
    expect(daily).toHaveLength(1)
    expect(daily[0].calls).toBe(3)
    expect(daily[0].inputTokens).toBe(300)
    expect(daily[0].outputTokens).toBe(150)

    ledger.close()
  })

  it('getDaily 支持 agentId 过滤', () => {
    const ledger = new UsageLedger(db)

    ledger.record({
      sessionId: 's1',
      threadId: 't1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 100,
      agentId: 'agent-a',
    })
    ledger.record({
      sessionId: 's2',
      threadId: 't1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 200,
      outputTokens: 100,
      durationMs: 200,
      agentId: 'agent-b',
    })

    const daily = ledger.getDaily({ days: 1, agentId: 'agent-a' })
    expect(daily).toHaveLength(1)
    expect(daily[0].calls).toBe(1)
    expect(daily[0].inputTokens).toBe(100)

    ledger.close()
  })

  it('getDaily days 参数被限制在 1-90 范围内', () => {
    const ledger = new UsageLedger(db)

    // days = 0 应被限制为 1
    const daily0 = ledger.getDaily({ days: 0 })
    expect(daily0).toHaveLength(1)

    // days = 200 应被限制为 90
    const daily200 = ledger.getDaily({ days: 200 })
    expect(daily200).toHaveLength(90)

    ledger.close()
  })

  it('getDaily 空数据返回全零的日期范围', () => {
    const ledger = new UsageLedger(db)

    const daily = ledger.getDaily({ days: 5 })
    expect(daily).toHaveLength(5)
    for (const d of daily) {
      expect(d.calls).toBe(0)
      expect(d.costUsd).toBe(0)
      expect(d.inputTokens).toBe(0)
      expect(d.outputTokens).toBe(0)
    }

    ledger.close()
  })
})
