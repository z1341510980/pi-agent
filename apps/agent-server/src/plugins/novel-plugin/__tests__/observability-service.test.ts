import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'
import { ObservabilityService } from '../core/analysis/observability-service.js'

/** 与 novel-orchestrator 写入 chapter_context 时的拼接分隔符一致 */
const CONTEXT_SEPARATOR = '\n\n---\n\n'

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

/** 拼出 [shared, identity, suffix] 三段式 chapter_context，供 diagnoseChapterCache 计算可缓存前缀 */
function buildContext(sharedLen: number, identityLen: number, suffixLen: number): string {
  return ['A'.repeat(sharedLen), 'B'.repeat(identityLen), 'C'.repeat(suffixLen)].join(CONTEXT_SEPARATOR)
}

interface Fixture {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  status?: 'success' | 'error' | 'cancelled'
  durationMs?: number
  error?: string
  systemPrompt?: string
  chapterContext?: string
  userMessage?: string
  phase?: string
  createdAt?: number
  cacheKey?: string | null
  cacheProtocol?: string | null
  requestFingerprint?: string | null
  cacheablePrefixChars?: number | null
  dataQuality?: string | null
  errorCode?: string | null
}

function insertLog(
  db: Database.Database,
  store: NovelStore,
  projectId: string,
  chapterNumber: number,
  agentType: string,
  o: Fixture = {},
): string {
  const log = store.insertAgentLog({
    projectId,
    chapterNumber,
    agentType,
    agentName: agentType,
    displayAgentType: agentType,
    displayAgentName: agentType,
    phase: o.phase ?? 'writing',
    systemPrompt: o.systemPrompt ?? '',
    chapterContext: o.chapterContext ?? '',
    userMessage: o.userMessage ?? '',
    taskInput: '',
    userInstructions: [],
    tools: [],
    toolNames: [],
    result: '',
    resultLength: 0,
    durationMs: o.durationMs ?? 0,
    status: o.status ?? 'success',
    error: o.error ?? '',
    sessionId: 's',
    inputTokens: o.input ?? 0,
    outputTokens: o.output ?? 0,
    cacheReadTokens: o.cacheRead ?? 0,
    cacheWriteTokens: o.cacheWrite ?? 0,
    llmProvider: 'deepseek',
    llmModel: 'v4-flash',
    payloadMessagesChars: 0,
    payloadToolsChars: 0,
    payloadToolCount: 0,
    payloadTotalChars: 0,
    llmRoundTrips: 1,
    askStoryPolicy: 'legacy',
    askStoryEnabled: true,
    cacheKey: o.cacheKey ?? null,
    cacheProtocol: o.cacheProtocol ?? null,
    requestFingerprint: o.requestFingerprint ?? null,
    cacheablePrefixChars: o.cacheablePrefixChars ?? null,
    dataQuality: o.dataQuality ?? null,
    errorCode: o.errorCode ?? null,
  })
  // 迁移 087a 后 insertAgentLog 把大文本外置到 payload 表、主表写空串。
  // 观测服务只读主表列（不读 payload），这里直接回填主表列，
  // 模拟"迁移前旧行仍在主表 / 部分行仍有值"的真实形态。
  db.prepare(
    'UPDATE novel_agent_logs SET system_prompt = ?, chapter_context = ?, user_message = ?, error = ?, created_at = ? WHERE id = ?',
  ).run(
    o.systemPrompt ?? '',
    o.chapterContext ?? '',
    o.userMessage ?? '',
    o.error ?? '',
    o.createdAt ?? 0,
    log.id,
  )
  return log.id
}

describe('ObservabilityService overview 总览聚合', () => {
  it('多行聚合：成功率/错误率/token 汇总/命中率/平均时长/数据质量四桶', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store)
    const svc = new ObservabilityService(db)

    insertLog(db, store, projectId, 1, 'director', {
      input: 1000, output: 200, durationMs: 1000, status: 'success',
      dataQuality: 'complete', createdAt: 1000,
    })
    insertLog(db, store, projectId, 1, 'writer', {
      input: 3000, output: 400, cacheRead: 1000, cacheWrite: 500, durationMs: 2000, status: 'success',
      dataQuality: 'partial', createdAt: 2000,
    })
    insertLog(db, store, projectId, 2, 'writer', {
      input: 500, durationMs: 3000, status: 'error', error: 'LLM 超时',
      dataQuality: 'no_data', errorCode: 'llm_timeout', createdAt: 3000,
    })
    insertLog(db, store, projectId, 2, 'reviewer', {
      durationMs: 0, status: 'cancelled', dataQuality: null, createdAt: 4000,
    })

    const ov = svc.overview(projectId)
    expect(ov.totalCalls).toBe(4)
    expect(ov.successRate).toBeCloseTo(0.5, 5)
    expect(ov.errorRate).toBeCloseTo(0.25, 5)
    // 本项目状态只有 success/error/cancelled，恒 0
    expect(ov.timeoutRate).toBe(0)
    expect(ov.inputTokens).toBe(4500)
    expect(ov.outputTokens).toBe(600)
    expect(ov.cacheReadTokens).toBe(1000)
    expect(ov.cacheWriteTokens).toBe(500)
    // 总 cacheRead / (总 cacheRead + 总 input) = 1000/5500
    expect(ov.cacheHitRate).toBeCloseTo(1000 / 5500, 5)
    // AVG(duration_ms) 仅统计成功样本
    expect(ov.avgDurationMs).toBe(1500)
    expect(ov.totalCostUsd).toBe(0)
    expect(ov.dataQuality).toEqual({ completeCalls: 1, partialCalls: 1, noDataCalls: 1, unknownCalls: 1 })
    expect(ov.timestamp).toBeGreaterThan(0)
  })

  it('时间/章节/Agent 过滤：from/to 均为含端点的 unixepoch 秒', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store)
    const svc = new ObservabilityService(db)

    insertLog(db, store, projectId, 1, 'director', { input: 1000, durationMs: 1000, createdAt: 1000 })
    insertLog(db, store, projectId, 1, 'writer', { input: 3000, cacheRead: 1000, durationMs: 2000, createdAt: 2000 })
    insertLog(db, store, projectId, 2, 'writer', { input: 500, durationMs: 3000, status: 'error', createdAt: 3000 })
    insertLog(db, store, projectId, 2, 'reviewer', { createdAt: 4000 })

    // from/to 含端点：只命中 createdAt=3000 的 error 行
    const byTime = svc.overview(projectId, { from: 2500, to: 3500 })
    expect(byTime.totalCalls).toBe(1)
    expect(byTime.successRate).toBe(0)
    expect(byTime.errorRate).toBe(1)
    expect(byTime.avgDurationMs).toBeNull() // 无成功样本
    expect(byTime.cacheHitRate).toBe(0) // cacheRead=0, input=500 → 0 而非 null

    const byChapter = svc.overview(projectId, { chapterNumber: 1 })
    expect(byChapter.totalCalls).toBe(2)
    expect(byChapter.successRate).toBe(1)
    expect(byChapter.inputTokens).toBe(4000)

    const byAgent = svc.overview(projectId, { agentType: 'writer' })
    expect(byAgent.totalCalls).toBe(2)
    expect(byAgent.successRate).toBeCloseTo(0.5, 5)
  })

  it('cacheHitRate 分母为 0（input 与 cacheRead 全 0）时返回 null', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store)
    const svc = new ObservabilityService(db)

    insertLog(db, store, projectId, 1, 'reviewer', { createdAt: 1000 })
    const ov = svc.overview(projectId)
    expect(ov.totalCalls).toBe(1)
    expect(ov.cacheHitRate).toBeNull()
  })
})

describe('ObservabilityService cache 缓存分层报告', () => {
  it('healthy 场景：首调用写缓存 + 后续调用命中 → verdict/coverage/节省上限', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store)
    const svc = new ObservabilityService(db)

    // 总提示词 4014 字符（system 1000 + context 2814 + user 200），
    // inputTokens=4014 → charsPerToken=1，可缓存前缀 3500 字符 → 期望命中 3500 token
    const systemPrompt = 'S'.repeat(1000)
    const chapterContext = buildContext(2000, 500, 300)
    const userMessage = 'U'.repeat(200)
    const common = { systemPrompt, chapterContext, userMessage }

    // 首次调用（director）负责写入：cache_read=0，cache_write=3500
    insertLog(db, store, projectId, 1, 'director', {
      ...common, input: 4014, cacheRead: 0, cacheWrite: 3500, createdAt: 1000,
      cacheKey: 'novel:p1:1', cacheProtocol: 'anthropic-cache-control',
      requestFingerprint: 'fp-1', dataQuality: 'complete',
    })
    // 后续调用（writer）命中 3465/3500 = 99% ≥ 85% → healthy
    insertLog(db, store, projectId, 1, 'writer', {
      ...common, input: 4014, cacheRead: 3465, cacheWrite: 0, createdAt: 2000,
      cacheKey: 'novel:p1:1', cacheProtocol: 'anthropic-cache-control',
      requestFingerprint: 'fp-2', dataQuality: 'complete',
    })
    // 第二章：单次调用 + 主表大文本为空（已外置）→ 诊断降级 no_data；协议 NULL 计入 unknown
    insertLog(db, store, projectId, 2, 'director', {
      input: 100, createdAt: 3000, cacheProtocol: null, requestFingerprint: null,
      dataQuality: 'complete',
    })

    const report = svc.cache(projectId)
    expect(report.verdict).toBe('healthy')
    expect(report.overallCoverage).toBeCloseTo(3465 / 3500, 5)
    // 上界估算：3500 期望 - 3465 实测 = 35
    expect(report.potentialSavedTokens).toBe(35)
    expect(Array.isArray(report.notes)).toBe(true)

    expect(report.chapters).toHaveLength(2)
    const ch1 = report.chapters.find((c) => c.chapterNumber === 1)!
    expect(ch1.verdict).toBe('healthy')
    expect(ch1.followUpCoverage).toBeCloseTo(3465 / 3500, 5)
    const ch2 = report.chapters.find((c) => c.chapterNumber === 2)!
    // 主表列取不到内容 → 该章诊断降级 no_data
    expect(ch2.verdict).toBe('no_data')
    expect(ch2.followUpCoverage).toBeNull()

    // 协议分布：NULL 计入 unknown
    expect(report.protocolDistribution).toEqual({
      'anthropic-cache-control': 2,
      unknown: 1,
    })

    // 指纹稳定性：仅统计 fingerprint 非空的行
    expect(report.fingerprintStability).toEqual({ totalCalls: 2, distinctFingerprints: 2 })

    // byAgent 命中率：cacheHitRate(总 cacheRead, 总 input)
    const director = report.byAgent.find((a) => a.agentType === 'director')!
    expect(director.calls).toBe(2)
    expect(director.hitRate).toBeCloseTo(0 / (0 + 4114), 5)
    const writer = report.byAgent.find((a) => a.agentType === 'writer')!
    expect(writer.calls).toBe(1)
    expect(writer.hitRate).toBeCloseTo(3465 / (3465 + 4014), 5)

    expect(report.sampledLogs).toBe(3)
    expect(report.timestamp).toBeGreaterThan(0)
  })

  it('过滤条件生效：chapterNumber 限定诊断采样范围', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store)
    const svc = new ObservabilityService(db)

    const systemPrompt = 'S'.repeat(1000)
    const chapterContext = buildContext(2000, 500, 300)
    insertLog(db, store, projectId, 1, 'director', {
      systemPrompt, chapterContext, userMessage: 'U'.repeat(200),
      input: 4014, cacheWrite: 3500, createdAt: 1000, cacheProtocol: 'anthropic-cache-control',
    })
    insertLog(db, store, projectId, 1, 'writer', {
      systemPrompt, chapterContext, userMessage: 'U'.repeat(200),
      input: 4014, cacheRead: 3465, createdAt: 2000, cacheProtocol: 'anthropic-cache-control',
    })
    insertLog(db, store, projectId, 2, 'writer', { input: 100, createdAt: 3000 })

    const report = svc.cache(projectId, { chapterNumber: 1 })
    expect(report.sampledLogs).toBe(2)
    expect(report.chapters).toHaveLength(1)
    expect(report.chapters[0].chapterNumber).toBe(1)
  })
})

describe('ObservabilityService agents 按 Agent 聚合', () => {
  it('分组统计 + lastError 截断到 200 字符', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store)
    const svc = new ObservabilityService(db)

    insertLog(db, store, projectId, 1, 'director', {
      input: 1000, output: 200, durationMs: 100, createdAt: 1000,
    })
    insertLog(db, store, projectId, 1, 'writer', {
      input: 2000, output: 100, cacheRead: 1000, durationMs: 200, createdAt: 2000,
    })
    insertLog(db, store, projectId, 2, 'writer', {
      input: 500, durationMs: 9999, status: 'error', error: 'E'.repeat(300), createdAt: 3000,
    })

    const rows = svc.agents(projectId)
    expect(rows).toHaveLength(2)

    const director = rows.find((r) => r.agentType === 'director')!
    expect(director.calls).toBe(1)
    expect(director.successRate).toBe(1)
    expect(director.inputTokens).toBe(1000)
    expect(director.outputTokens).toBe(200)
    expect(director.cacheHitRate).toBeCloseTo(0 / 1000, 5)
    expect(director.avgDurationMs).toBe(100)
    expect(director.costUsd).toBe(0)
    expect(director.lastError).toBeNull() // 无失败调用

    const writer = rows.find((r) => r.agentType === 'writer')!
    expect(writer.calls).toBe(2)
    expect(writer.successRate).toBeCloseTo(0.5, 5)
    expect(writer.inputTokens).toBe(2500)
    expect(writer.cacheHitRate).toBeCloseTo(1000 / 3500, 5)
    // 平均时长仅统计成功样本（9999 的失败行不计入）
    expect(writer.avgDurationMs).toBe(200)
    // 最近一条非成功调用的 error 截断到前 200 字符
    expect(writer.lastError).toBe('E'.repeat(200))
    expect(writer.lastError!.length).toBe(200)
  })

  it('error 列为空串但 error_code 非空时，lastError 兜底返回 error_code', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store)
    const svc = new ObservabilityService(db)

    // 087a 迁移后的新失败行形态：error 文本外置 payload、主表留空串，仅 error_code 有值
    insertLog(db, store, projectId, 1, 'writer', {
      input: 500, status: 'error', error: '', errorCode: 'llm_timeout', createdAt: 1000,
    })

    const rows = svc.agents(projectId)
    expect(rows).toHaveLength(1)
    expect(rows[0].lastError).toBe('llm_timeout')
  })
})

describe('ObservabilityService timeline 时间线', () => {
  it('按 created_at 倒序 + limit 生效 + 每行 cacheHitRate', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store)
    const svc = new ObservabilityService(db)

    const id1 = insertLog(db, store, projectId, 1, 'director', {
      input: 1000, cacheRead: 0, phase: 'directing', durationMs: 100,
      createdAt: 1000, cacheProtocol: 'anthropic-cache-control',
    })
    const id2 = insertLog(db, store, projectId, 1, 'writer', {
      input: 1000, cacheRead: 1000, phase: 'writing', durationMs: 200, createdAt: 2000,
    })
    const id3 = insertLog(db, store, projectId, 2, 'reviewer', {
      input: 0, cacheRead: 0, phase: 'reviewing', durationMs: 300, status: 'error', createdAt: 3000,
    })

    const rows = svc.timeline(projectId)
    expect(rows.map((r) => r.id)).toEqual([id3, id2, id1])
    expect(rows[0].chapterNumber).toBe(2)
    expect(rows[0].agentType).toBe('reviewer')
    expect(rows[0].phase).toBe('reviewing')
    expect(rows[0].status).toBe('error')
    expect(rows[0].durationMs).toBe(300)
    expect(rows[0].createdAt).toBe(3000)
    // 每行 cacheHitRate：input+cacheRead=0 → null；1000/(1000+1000)=0.5；0/1000=0
    expect(rows[0].cacheHitRate).toBeNull()
    expect(rows[1].cacheHitRate).toBeCloseTo(0.5, 5)
    expect(rows[1].cacheProtocol).toBeNull()
    expect(rows[2].cacheHitRate).toBe(0)
    expect(rows[2].cacheProtocol).toBe('anthropic-cache-control')

    // limit 生效
    expect(svc.timeline(projectId, { limit: 2 })).toHaveLength(2)
    // 章节 + Agent 过滤
    const filtered = svc.timeline(projectId, { chapterNumber: 1, agentType: 'writer' })
    expect(filtered.map((r) => r.id)).toEqual([id2])
  })
})

describe('ObservabilityService 空库不抛错', () => {
  it('所有方法返回空态', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store)
    const svc = new ObservabilityService(db)

    const ov = svc.overview(projectId)
    expect(ov.totalCalls).toBe(0)
    expect(ov.successRate).toBeNull()
    expect(ov.errorRate).toBe(0)
    expect(ov.timeoutRate).toBe(0)
    expect(ov.inputTokens).toBe(0)
    expect(ov.outputTokens).toBe(0)
    expect(ov.cacheReadTokens).toBe(0)
    expect(ov.cacheWriteTokens).toBe(0)
    expect(ov.cacheHitRate).toBeNull()
    expect(ov.avgDurationMs).toBeNull()
    expect(ov.totalCostUsd).toBe(0)
    expect(ov.dataQuality).toEqual({ completeCalls: 0, partialCalls: 0, noDataCalls: 0, unknownCalls: 0 })

    const report = svc.cache(projectId)
    expect(report.verdict).toBe('no_data')
    expect(report.overallCoverage).toBeNull()
    expect(report.potentialSavedTokens).toBe(0)
    expect(report.chapters).toEqual([])
    expect(report.byAgent).toEqual([])
    expect(report.protocolDistribution).toEqual({})
    expect(report.fingerprintStability).toEqual({ totalCalls: 0, distinctFingerprints: 0 })
    expect(report.sampledLogs).toBe(0)

    expect(svc.agents(projectId)).toEqual([])
    expect(svc.timeline(projectId)).toEqual([])
  })
})
