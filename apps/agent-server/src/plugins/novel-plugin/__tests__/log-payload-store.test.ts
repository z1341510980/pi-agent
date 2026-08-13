import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'
import { gunzipBlob, hashPayloadFields, computeExpiresAt, PAYLOAD_RETENTION_DAYS, SECONDS_PER_DAY } from '../core/log-payload-service.js'
import type { NovelAgentLog } from '../core/types.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

function setupProject(store: NovelStore, flags?: Record<string, boolean>): string {
  const projectId = randomUUID()
  store.createProject({
    id: projectId, title: 't', genre: 'g', synopsis: '', outline: '',
    targetWords: 3000, currentVolume: 1, currentChapter: 1,
    currentStage: 'rising', status: 'active', flags,
  })
  return projectId
}

function makeInput(projectId: string, chapterNumber = 1, overrides: Partial<Omit<NovelAgentLog, 'id' | 'createdAt'>> = {}): Omit<NovelAgentLog, 'id' | 'createdAt'> {
  return {
    projectId,
    chapterNumber,
    agentType: 'director',
    agentName: '导演',
    displayAgentType: 'director',
    displayAgentName: '导演',
    phase: 'directing',
    systemPrompt: '系统提示词'.repeat(20),
    chapterContext: '章节上下文'.repeat(50),
    userMessage: '用户消息'.repeat(10),
    taskInput: '任务输入'.repeat(10),
    userInstructions: ['指令1'],
    tools: [{ name: 't1', description: 'd1' }],
    toolNames: ['t1'],
    result: '结果'.repeat(30),
    resultLength: 60,
    durationMs: 100,
    status: 'success',
    error: '',
    sessionId: 's',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 0,
    llmProvider: 'deepseek',
    llmModel: 'v4-flash',
    payloadMessagesChars: 100,
    payloadToolsChars: 10,
    payloadToolCount: 1,
    payloadTotalChars: 110,
    llmRoundTrips: 1,
    askStoryPolicy: 'legacy',
    askStoryEnabled: true,
    ...overrides,
  }
}

describe('Agent 日志冷热分离（P1-2）', () => {
  it('默认外置：主表写元数据 + payload_id，大文本 gzip 外置，详情可回读', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store)
    const log = store.insertAgentLog(makeInput(projectId, 1, { status: 'error', error: '失败原因' }))

    const dbRaw = (store as unknown as { db: Database.Database }).db
    const mainRow = dbRaw.prepare('SELECT system_prompt, chapter_context, user_message, task_input, result, error, payload_id FROM novel_agent_logs WHERE id = ?').get(log.id) as any
    // 主表瘦身：大文本列空串
    expect(mainRow.system_prompt).toBe('')
    expect(mainRow.chapter_context).toBe('')
    expect(mainRow.result).toBe('')
    expect(mainRow.payload_id).toBe(log.id)

    const payloadRow = dbRaw.prepare('SELECT * FROM novel_agent_log_payloads WHERE agent_log_id = ?').get(log.id) as any
    expect(payloadRow).toBeTruthy()
    expect(payloadRow.compression).toBe('gzip')
    expect(payloadRow.system_prompt_blob).toBeInstanceOf(Buffer)
    expect(gunzipBlob(payloadRow.system_prompt_blob)).toBe('系统提示词'.repeat(20))
    expect(payloadRow.content_hash).toMatch(/^[0-9a-f]{64}$/)
    // error 状态 → 90 天保留
    const createdAt = payloadRow.created_at
    expect(payloadRow.expires_at).toBe(createdAt + PAYLOAD_RETENTION_DAYS.error * SECONDS_PER_DAY)

    // 详情读取（默认 loadPayload=true）字段与迁移前一致
    const detail = store.getAgentLog(log.id)!
    expect(detail.systemPrompt).toBe('系统提示词'.repeat(20))
    expect(detail.chapterContext).toBe('章节上下文'.repeat(50))
    expect(detail.userMessage).toBe('用户消息'.repeat(10))
    expect(detail.result).toBe('结果'.repeat(30))
    expect(detail.error).toBe('失败原因')

    // loadPayload=false：大文本以主表旧列兜底（空串）
    const noPayload = store.getAgentLog(log.id, { loadPayload: false })!
    expect(noPayload.systemPrompt).toBe('')
  })

  it('列表查询不加载 payload（P1-2-2）', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store)
    store.insertAgentLog(makeInput(projectId))

    const summaries = store.listAgentLogs(projectId)
    expect(summaries).toHaveLength(1)
    // summary 不含 content 全文（类型契约），systemPromptLength 为 0（外置行）
    const s = summaries[0]
    expect((s as any).systemPrompt).toBeUndefined()
    expect(s.systemPromptLength).toBe(0)
  })

  it('content_hash 稳定可去重（P1-2-5）', () => {
    const fields = { systemPrompt: 'abc', result: 'def' }
    expect(hashPayloadFields(fields)).toBe(hashPayloadFields({ result: 'def', systemPrompt: 'abc' }))
    expect(hashPayloadFields(fields)).not.toBe(hashPayloadFields({ systemPrompt: 'abc', result: 'xyz' }))
  })

  it('cleanupExpiredPayloads：过期 payload 可清理，元数据不删（P1-2-4）', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store)

    // 插入一条"未来才过期"的日志（默认保留期内）
    const fresh = store.insertAgentLog(makeInput(projectId, 1))
    // 手工把 payload expires_at 改成过去
    const dbRaw = (store as unknown as { db: Database.Database }).db
    dbRaw.prepare('UPDATE novel_agent_log_payloads SET expires_at = ? WHERE agent_log_id = ?')
      .run(Math.floor(Date.now() / 1000) - 10, fresh.id)

    const result = store.cleanupExpiredPayloads(Date.now())
    expect(result.deleted).toBe(1)
    expect(result.scanned).toBe(1)
    // payload 行删除，但主表元数据仍在
    const mainRow = dbRaw.prepare('SELECT id FROM novel_agent_logs WHERE id = ?').get(fresh.id) as any
    expect(mainRow).toBeTruthy()
    const payloadRow = dbRaw.prepare('SELECT id FROM novel_agent_log_payloads WHERE agent_log_id = ?').get(fresh.id) as any
    expect(payloadRow).toBeUndefined()
  })

  it('computeExpiresAt：成功 30d / 失败 90d / 审计锁定 365d', () => {
    const now = 1_700_000_000
    expect(computeExpiresAt(now, 'success')).toBe(now + 30 * SECONDS_PER_DAY)
    expect(computeExpiresAt(now, 'error')).toBe(now + 90 * SECONDS_PER_DAY)
    expect(computeExpiresAt(now, 'success', true)).toBe(now + 365 * SECONDS_PER_DAY)
  })
})
