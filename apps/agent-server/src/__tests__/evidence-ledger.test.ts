import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../core/db/migrations.js'
import { EvidenceLedger, summarizeArgs, summarizeResult } from '../core/tool/evidence-ledger.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db)
})

afterEach(() => {
  db.close()
})

describe('EvidenceLedger', () => {
  it('record 插入记录到 SQLite', () => {
    const ledger = new EvidenceLedger({ threadId: 'thread-1', db })
    const entry = ledger.record({
      toolCallId: 'call-1',
      toolName: 'bash',
      argsSummary: '{"command":"ls"}',
      resultSummary: 'file1\nfile2',
      isError: false,
    })

    expect(entry.id).toBeTruthy()
    expect(entry.threadId).toBe('thread-1')
    expect(entry.timestamp).toBeTruthy()

    // 验证数据库中已写入
    const row = db.prepare('SELECT * FROM evidence WHERE thread_id = ?').get('thread-1') as {
      tool_name: string
      tool_call_id: string
    }
    expect(row.tool_name).toBe('bash')
    expect(row.tool_call_id).toBe('call-1')
  })

  it('多次 record 追加多条', () => {
    const ledger = new EvidenceLedger({ threadId: 'thread-1', db })

    ledger.record({
      toolCallId: 'call-1',
      toolName: 'read',
      argsSummary: '{}',
      resultSummary: 'content',
      isError: false,
    })
    ledger.record({
      toolCallId: 'call-2',
      toolName: 'write',
      argsSummary: '{}',
      resultSummary: 'ok',
      isError: false,
    })

    const all = ledger.readAll()
    expect(all).toHaveLength(2)
    expect(all[0].toolCallId).toBe('call-1')
    expect(all[1].toolCallId).toBe('call-2')
  })

  it('readAll 空线程返回空数组', () => {
    const ledger = new EvidenceLedger({ threadId: 'empty-thread', db })
    expect(ledger.readAll()).toEqual([])
  })

  it('不同 threadId 隔离读取', () => {
    const ledger1 = new EvidenceLedger({ threadId: 'thread-1', db })
    const ledger2 = new EvidenceLedger({ threadId: 'thread-2', db })

    ledger1.record({
      toolCallId: 'call-1',
      toolName: 'bash',
      argsSummary: '{}',
      resultSummary: 'ok',
      isError: false,
    })
    ledger2.record({
      toolCallId: 'call-2',
      toolName: 'read',
      argsSummary: '{}',
      resultSummary: 'ok',
      isError: false,
    })

    expect(ledger1.readAll()).toHaveLength(1)
    expect(ledger2.readAll()).toHaveLength(1)
    expect(ledger1.readAll()[0].toolCallId).toBe('call-1')
    expect(ledger2.readAll()[0].toolCallId).toBe('call-2')
  })

  it('isError 正确存储为整数并还原为布尔', () => {
    const ledger = new EvidenceLedger({ threadId: 'thread-1', db })

    ledger.record({
      toolCallId: 'call-1',
      toolName: 'bash',
      argsSummary: '{}',
      resultSummary: 'error output',
      isError: true,
    })

    const all = ledger.readAll()
    expect(all[0].isError).toBe(true)
  })
})

describe('summarizeArgs', () => {
  it('短参数完整返回', () => {
    const result = summarizeArgs({ path: '/tmp/test.txt' })
    expect(result).toBe('{"path":"/tmp/test.txt"}')
  })

  it('长参数截断到 500 字符', () => {
    const longValue = 'x'.repeat(600)
    const result = summarizeArgs({ content: longValue })
    expect(result.length).toBeLessThanOrEqual(503) // 500 + '...'
    expect(result.endsWith('...')).toBe(true)
  })
})

describe('summarizeResult', () => {
  it('字符串结果完整返回', () => {
    expect(summarizeResult('hello')).toBe('hello')
  })

  it('长字符串截断到 1000 字符', () => {
    const long = 'x'.repeat(1200)
    const result = summarizeResult(long)
    expect(result.length).toBeLessThanOrEqual(1003)
    expect(result.endsWith('...')).toBe(true)
  })

  it('对象结果转 JSON', () => {
    const result = summarizeResult({ ok: true })
    expect(result).toBe('{"ok":true}')
  })
})
