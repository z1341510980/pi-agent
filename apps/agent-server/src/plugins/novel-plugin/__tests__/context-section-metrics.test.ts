import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import {
  ContextSectionCollector,
  estimateTokensFromChars,
  hashText,
  normalizeText,
  isPureAscii,
  CJK_TOKEN_RATIO,
  ASCII_TOKEN_RATIO,
} from '../core/context-section-metrics.js'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

describe('ContextSectionCollector 埋点结构', () => {
  it('六类 section 各产生至少 1 条度量记录，含 chars/tokens/hash/mode', () => {
    const collector = new ContextSectionCollector({ projectId: 'p1', chapterNumber: 1, agentType: 'writer' })
    collector.add('system', 'system-prompt', '你是小说家。', 'full')
    collector.add('shared', 'shared', '章节信息：第一章', 'full')
    collector.add('shared', 'arranged-entities', '角色：张三', 'full')
    collector.add('identity', 'identity', '你是 Writer。', 'full')
    collector.add('suffix', 'suffix', '结尾锚点', 'full')
    collector.add('dynamic', 'user-message', '请写正文', 'full')
    collector.add('dynamic', 'task-input', '原始任务', 'full')
    collector.add('tool_schema', 'tools', '{"name":"novel_ask_story","description":"查询"}', 'full')

    const rows = collector.buildInputs('log-1')
    const types = new Set(rows.map((r) => r.sectionType))
    expect(types).toEqual(new Set(['system', 'shared', 'identity', 'suffix', 'dynamic', 'tool_schema']))
    expect(rows.length).toBeGreaterThanOrEqual(6)
    for (const row of rows) {
      expect(row.chars).toBeGreaterThan(0)
      expect(row.estimatedTokens).toBeGreaterThan(0)
      expect(row.sourceHash).toMatch(/^[0-9a-f]{64}$/)
      expect(row.mode).toBe('full')
    }
  })

  it('sourceHash 同文本稳定、异文本可区分', () => {
    expect(hashText('  第一章  内容 ')).toBe(hashText('第一章 内容'))
    expect(hashText('第一章')).not.toBe(hashText('第二章'))
    // 规范化：空白折叠 + 去首尾
    expect(normalizeText('  a\n  b  ')).toBe('a b')
  })

  it('token 估算：中文 RATIO=0.8，纯 ASCII RATIO=0.25', () => {
    expect(estimateTokensFromChars(10)).toBe(Math.ceil(10 * CJK_TOKEN_RATIO))
    expect(estimateTokensFromChars(10, true)).toBe(Math.ceil(10 * ASCII_TOKEN_RATIO))
    expect(isPureAscii('hello world')).toBe(true)
    expect(isPureAscii('你好')).toBe(false)
  })

  it('disabled 时不采集（空行）', () => {
    const collector = new ContextSectionCollector({ projectId: 'p1', chapterNumber: 1, agentType: 'writer' }, false)
    collector.add('system', 'system-prompt', '内容', 'full')
    expect(collector.size).toBe(0)
  })

  it('空内容不采集', () => {
    const collector = new ContextSectionCollector({ projectId: 'p1', chapterNumber: 1, agentType: 'writer' })
    collector.add('system', 'system-prompt', '', 'full')
    collector.add('system', 'system-prompt', '   ', 'full')
    expect(collector.size).toBe(0)
  })

  it('开销可控：10k 字符采集 < 50ms（纯内存）', () => {
    const collector = new ContextSectionCollector({ projectId: 'p1', chapterNumber: 1, agentType: 'writer' })
    const content = '中文字符'.repeat(2500) // 10k chars
    const start = performance.now()
    for (let i = 0; i < 10; i += 1) collector.add('shared', `section-${i}`, content, 'full')
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(50)
    expect(collector.size).toBe(10)
  })
})

describe('度量表持久化（P0-1-1）', () => {
  it('insertContextSectionMetrics 落库，list 可读回', () => {
    const store = new NovelStore(createDb())
    const projectId = randomUUID()
    store.createProject({
      id: projectId, title: 't', genre: 'g', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 1,
      currentStage: 'rising', status: 'active',
    })

    // 先建一条真实 agent log（外键约束：agent_log_id 必须存在）
    const logId = store.insertAgentLog({
      projectId, chapterNumber: 2, agentType: 'director', agentName: 'd',
      displayAgentType: 'director', displayAgentName: 'd', phase: 'directing',
      systemPrompt: '', chapterContext: '', userMessage: '', taskInput: '',
      userInstructions: [], tools: [], toolNames: [], result: '', resultLength: 0,
      durationMs: 1, status: 'success', error: '', sessionId: 's',
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      llmProvider: '', llmModel: '', payloadMessagesChars: 0, payloadToolsChars: 0,
      payloadToolCount: 0, payloadTotalChars: 0, llmRoundTrips: 1,
      askStoryPolicy: 'legacy', askStoryEnabled: true,
    }).id

    const collector = new ContextSectionCollector({ projectId, chapterNumber: 2, agentType: 'director' })
    collector.add('system', 'system-prompt', '系统', 'full')
    collector.add('shared', 'shared', '共享', 'full')
    store.insertContextSectionMetrics(collector.buildInputs(logId))

    const rows = store.listContextSectionMetrics(projectId, 2)
    expect(rows).toHaveLength(2)
    expect(rows[0].agentLogId).toBe(logId)
    expect(rows[0].projectId).toBe(projectId)
    expect(rows[0].chapterNumber).toBe(2)

    const all = store.listContextSectionMetrics(projectId)
    expect(all).toHaveLength(2)
  })
})
