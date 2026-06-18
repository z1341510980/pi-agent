import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { EvidenceLedger, summarizeArgs, summarizeResult } from '../core/tool/evidence-ledger.js'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'pi-evidence-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('EvidenceLedger', () => {
  it('record 追加 JSONL 记录到文件', () => {
    const ledger = new EvidenceLedger({ threadId: 'thread-1', dataDir: tempDir })
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

    const logFile = join(tempDir, 'agent', 'evidence', 'thread-1.jsonl')
    expect(existsSync(logFile)).toBe(true)

    const content = readFileSync(logFile, 'utf8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.toolName).toBe('bash')
    expect(parsed.toolCallId).toBe('call-1')
  })

  it('多次 record 追加多行', () => {
    const ledger = new EvidenceLedger({ threadId: 'thread-1', dataDir: tempDir })

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

  it('readAll 空文件返回空数组', () => {
    const ledger = new EvidenceLedger({ threadId: 'empty-thread', dataDir: tempDir })
    expect(ledger.readAll()).toEqual([])
  })

  it('不同 threadId 写入不同文件', () => {
    const ledger1 = new EvidenceLedger({ threadId: 'thread-1', dataDir: tempDir })
    const ledger2 = new EvidenceLedger({ threadId: 'thread-2', dataDir: tempDir })

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
