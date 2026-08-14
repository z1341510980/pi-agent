import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'
import { CostReportService } from '../core/analysis/cost-report-service.js'
import { SharedOverlapAnalyzer } from '../core/analysis/shared-overlap-analyzer.js'
import { ContextSectionCollector } from '../core/prompting/context-section-metrics.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

function setupProject(store: NovelStore): string {
  const projectId = randomUUID()
  store.createProject({
    id: projectId, title: 't', genre: 'g', synopsis: '', outline: '',
    targetWords: 3000, currentVolume: 1, currentChapter: 1,
    currentStage: 'rising', status: 'active',
  })
  return projectId
}

function insertLog(store: NovelStore, projectId: string, chapterNumber: number, agentType: string, tokens: Partial<{ input: number; cacheRead: number; roundTrips: number }> = {}): string {
  return store.insertAgentLog({
    projectId,
    chapterNumber,
    agentType,
    agentName: agentType,
    displayAgentType: agentType,
    displayAgentName: agentType,
    phase: 'writing',
    systemPrompt: 'sys',
    chapterContext: 'shared',
    userMessage: 'msg',
    taskInput: 'task',
    userInstructions: [],
    tools: [],
    toolNames: [],
    result: 'result',
    resultLength: 6,
    durationMs: 100,
    status: 'success',
    error: '',
    sessionId: 's',
    inputTokens: tokens.input ?? 1000,
    outputTokens: 500,
    cacheReadTokens: tokens.cacheRead ?? 0,
    cacheWriteTokens: 0,
    llmProvider: 'deepseek',
    llmModel: 'v4-flash',
    payloadMessagesChars: 100,
    payloadToolsChars: 10,
    payloadToolCount: 1,
    payloadTotalChars: 110,
    llmRoundTrips: tokens.roundTrips ?? 1,
    askStoryPolicy: 'legacy',
    askStoryEnabled: true,
  }).id
}

describe('CostReportService 报表六项指标（P0-2-1/2）', () => {
  it('按 project_id + chapter_number 输出六项指标，可下钻到 agentLogId', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store)

    const logId = insertLog(store, projectId, 1, 'director', { input: 2000, cacheRead: 500, roundTrips: 2 })
    insertLog(store, projectId, 1, 'writer', { input: 3000, cacheRead: 1500, roundTrips: 1 })

    // 埋点：system/shared/arranged-entities/identity/suffix/dynamic/tool_schema
    const collector = new ContextSectionCollector({ projectId, chapterNumber: 1, agentType: 'director' })
    collector.add('system', 'system-prompt', 's'.repeat(100), 'full')
    collector.add('shared', 'shared', 's'.repeat(1000), 'full')
    collector.add('shared', 'arranged-entities', 's'.repeat(300), 'full')
    collector.add('identity', 'identity', 's'.repeat(50), 'full')
    collector.add('suffix', 'suffix', 's'.repeat(50), 'full')
    collector.add('dynamic', 'user-message', 's'.repeat(20), 'full')
    collector.add('dynamic', 'task-input', 's'.repeat(20), 'full')
    collector.add('tool_schema', 'tools', 's'.repeat(40), 'full')
    store.insertContextSectionMetrics(collector.buildInputs(logId))

    const service = new CostReportService(db)
    const reports = service.chapterReport(projectId, 1)
    expect(reports).toHaveLength(1)
    const report = reports[0]
    expect(report.chapterNumber).toBe(1)
    expect(report.rows).toHaveLength(2)

    // 1) 每章首次调用 full-price input
    expect(report.firstCallInputTokens).toBe(2000)

    // 2) 每个 Agent 成本占比（input + cache-read）
    const directorShare = report.agentShares.find((a) => a.agentType === 'director')!
    const writerShare = report.agentShares.find((a) => a.agentType === 'writer')!
    expect(directorShare.costUnits).toBe(2500)
    expect(writerShare.costUnits).toBe(4500)
    expect(directorShare.sharePct + writerShare.sharePct).toBeCloseTo(1, 5)

    // 3) formatArrangedEntities 占 shared 比例
    expect(report.arrangedEntitiesShareOfSharedPct).toBeCloseTo(300 / 1000, 5)

    // 4) tool schema 占输入比例
    expect(report.toolSchemaShareOfInputPct).toBeCloseTo(40 / (100 + 1000 + 50 + 50 + 20 + 40), 5)

    // 5) round-trip 次数
    expect(report.roundTripTotal).toBe(3)

    // 6) cache-read / input 比例
    expect(report.cacheReadRatio).toBeCloseTo(2000 / 5000, 5)

    // 可下钻：报表行 agentLogId 与日志记录对应
    const row = report.rows.find((r) => r.agentType === 'director')!
    expect(row.agentLogId).toBe(logId)
    const log = store.getAgentLog(logId)
    expect(log?.id).toBe(logId)
  })

  it('agentCostShare 全项目聚合', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store)
    insertLog(store, projectId, 1, 'director', { input: 1000, cacheRead: 0 })
    insertLog(store, projectId, 2, 'writer', { input: 1000, cacheRead: 1000 })

    const service = new CostReportService(db)
    const shares = service.agentCostShare(projectId)
    const director = shares.find((s) => s.agentType === 'director')!
    const writer = shares.find((s) => s.agentType === 'writer')!
    expect(director.costUnits).toBe(1000)
    expect(writer.costUnits).toBe(2000)
    expect(writer.sharePct).toBeCloseTo(2 / 3, 5)
  })
})

describe('SharedOverlapAnalyzer 相邻章重复率（P0-3-1/2）', () => {
  it('输出分布 p50/p75/max + top 高频重复 section', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store)

    // 两章日志，chapter_context 相同 → 重复率高
    insertLog(store, projectId, 1, 'director')
    insertLog(store, projectId, 2, 'director')

    // 度量表：top 高频 section（agent_log_id 必须存在）
    for (const chapter of [1, 2]) {
      const logId = insertLog(store, projectId, chapter, 'director')
      const c = new ContextSectionCollector({ projectId, chapterNumber: chapter, agentType: 'director' })
      c.add('shared', 'chapter-info', 'info', 'full')
      c.add('shared', 'story-ledger', 'ledger', 'full')
      c.add('shared', 'arranged-entities', 'entities', 'full')
      store.insertContextSectionMetrics(c.buildInputs(logId))
    }

    const analyzer = new SharedOverlapAnalyzer(db)
    const report = analyzer.analyze(projectId, { chapterNumbers: [1, 2] })
    expect(report.pairs).toHaveLength(1)
    expect(report.pairs[0].fromChapter).toBe(1)
    expect(report.pairs[0].toChapter).toBe(2)
    // chapter_context 相同 → overlap 接近 1
    expect(report.pairs[0].overlapRatio).toBeGreaterThan(0.9)
    expect(report.distribution.p50).toBeGreaterThanOrEqual(0)
    expect(report.distribution.p75).toBeGreaterThanOrEqual(report.distribution.p50)
    expect(report.distribution.max).toBeGreaterThanOrEqual(report.distribution.p75)
    const topIds = report.topSections.map((s) => s.sectionId)
    expect(topIds).toContain('chapter-info')
    expect(topIds).toContain('story-ledger')
    expect(topIds).toContain('arranged-entities')
  })

  it('相邻章 shared 不同 → 重复率低', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store)
    // chapter_context 不同：改 chapterContext 字段
    store.insertAgentLog({
      projectId, chapterNumber: 1, agentType: 'director', agentName: 'd',
      displayAgentType: 'director', displayAgentName: 'd', phase: 'directing',
      systemPrompt: '', chapterContext: '第一章：主角进入森林，寻找失踪的同伴。',
      userMessage: '', taskInput: '', userInstructions: [], tools: [], toolNames: [],
      result: '', resultLength: 0, durationMs: 1, status: 'success', error: '',
      sessionId: 's1', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0,
      cacheWriteTokens: 0, llmProvider: '', llmModel: '',
      payloadMessagesChars: 0, payloadToolsChars: 0, payloadToolCount: 0,
      payloadTotalChars: 0, llmRoundTrips: 1, askStoryPolicy: 'legacy', askStoryEnabled: true,
    })
    store.insertAgentLog({
      projectId, chapterNumber: 2, agentType: 'director', agentName: 'd',
      displayAgentType: 'director', displayAgentName: 'd', phase: 'directing',
      systemPrompt: '', chapterContext: '第二章：主角在都市写字楼里开会，讨论季度预算。',
      userMessage: '', taskInput: '', userInstructions: [], tools: [], toolNames: [],
      result: '', resultLength: 0, durationMs: 1, status: 'success', error: '',
      sessionId: 's2', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0,
      cacheWriteTokens: 0, llmProvider: '', llmModel: '',
      payloadMessagesChars: 0, payloadToolsChars: 0, payloadToolCount: 0,
      payloadTotalChars: 0, llmRoundTrips: 1, askStoryPolicy: 'legacy', askStoryEnabled: true,
    })
    const analyzer = new SharedOverlapAnalyzer(db)
    const report = analyzer.analyze(projectId, { chapterNumbers: [1, 2] })
    expect(report.pairs).toHaveLength(1)
    expect(report.pairs[0].overlapRatio).toBeLessThan(0.5)
  })
})
