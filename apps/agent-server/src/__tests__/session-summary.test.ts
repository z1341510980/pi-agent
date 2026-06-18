import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { SessionSummaryStore } from '../core/memory/session-summary.js'
import type { SessionSummary } from '../core/memory/session-summary.js'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'pi-summary-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('SessionSummaryStore', () => {
  it('saveSummary 保存摘要到文件', async () => {
    const store = new SessionSummaryStore(tempDir)
    const summary: SessionSummary = {
      sessionId: 'session-1',
      summary: '用户讨论了项目架构',
      keyDecisions: ['采用微服务架构'],
      topics: ['architecture', 'microservice'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await store.saveSummary(summary)

    const file = join(tempDir, 'agent', 'summaries.json')
    expect(existsSync(file)).toBe(true)
  })

  it('getSummary 返回已保存的摘要', async () => {
    const store = new SessionSummaryStore(tempDir)
    const summary: SessionSummary = {
      sessionId: 'session-1',
      summary: '用户讨论了项目架构',
      keyDecisions: ['采用微服务架构'],
      topics: ['architecture'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await store.saveSummary(summary)

    const result = await store.getSummary('session-1')
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe('session-1')
    expect(result!.summary).toBe('用户讨论了项目架构')
    expect(result!.keyDecisions).toEqual(['采用微服务架构'])
  })

  it('getSummary 不存在时返回 null', async () => {
    const store = new SessionSummaryStore(tempDir)
    const result = await store.getSummary('nonexistent')
    expect(result).toBeNull()
  })

  it('listSummaries 返回所有摘要', async () => {
    const store = new SessionSummaryStore(tempDir)
    await store.saveSummary({
      sessionId: 's1',
      summary: '摘要1',
      keyDecisions: [],
      topics: [],
      createdAt: 1000,
      updatedAt: 1000,
    })
    await store.saveSummary({
      sessionId: 's2',
      summary: '摘要2',
      keyDecisions: [],
      topics: [],
      createdAt: 2000,
      updatedAt: 2000,
    })

    const list = await store.listSummaries()
    expect(list).toHaveLength(2)
    expect(list.map((s) => s.sessionId).sort()).toEqual(['s1', 's2'])
  })

  it('deleteSummary 删除摘要', async () => {
    const store = new SessionSummaryStore(tempDir)
    await store.saveSummary({
      sessionId: 's1',
      summary: '摘要1',
      keyDecisions: [],
      topics: [],
      createdAt: 1000,
      updatedAt: 1000,
    })

    await store.deleteSummary('s1')
    const result = await store.getSummary('s1')
    expect(result).toBeNull()
  })

  it('deleteSummary 不存在时不报错', async () => {
    const store = new SessionSummaryStore(tempDir)
    await expect(store.deleteSummary('nonexistent')).resolves.toBeUndefined()
  })

  it('saveSummary 覆盖更新已有摘要', async () => {
    const store = new SessionSummaryStore(tempDir)
    await store.saveSummary({
      sessionId: 's1',
      summary: '旧摘要',
      keyDecisions: [],
      topics: [],
      createdAt: 1000,
      updatedAt: 1000,
    })
    await store.saveSummary({
      sessionId: 's1',
      summary: '新摘要',
      keyDecisions: ['新决策'],
      topics: ['new'],
      createdAt: 1000,
      updatedAt: 2000,
    })

    const result = await store.getSummary('s1')
    expect(result!.summary).toBe('新摘要')
    expect(result!.keyDecisions).toEqual(['新决策'])
  })

  it('持久化：重新加载后数据仍在', async () => {
    const store1 = new SessionSummaryStore(tempDir)
    await store1.saveSummary({
      sessionId: 's1',
      summary: '持久化测试',
      keyDecisions: [],
      topics: [],
      createdAt: 1000,
      updatedAt: 1000,
    })

    // 新实例读取同一目录
    const store2 = new SessionSummaryStore(tempDir)
    const result = await store2.getSummary('s1')
    expect(result!.summary).toBe('持久化测试')
  })
})
