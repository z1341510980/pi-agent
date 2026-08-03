import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessionMessages } from '../core/session/session-reader.js'

/**
 * session JSONL 是 pi-agent-core 的**会话事件日志**，除消息还混着 session 头、
 * model_change、thinking_level_change 等条目。分页必须只对消息条目计数，
 * 否则 `limit: 30` 拿到的是 30 行而不是 30 条消息。
 */

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'session-reader-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 构造一条消息条目 */
function messageLine(id: string, role: string, text: string): string {
  return JSON.stringify({
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-06-17T07:59:51.148Z',
    message: { role, content: [{ type: 'text', text }], timestamp: 1781683191145 },
  })
}

async function write(name: string, lines: string[]): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
  return path
}

describe('readSessionMessages', () => {
  it('文件不存在时返回空结果', async () => {
    const result = await readSessionMessages(join(dir, 'missing.jsonl'))
    expect(result).toEqual({ messages: [], nextCursor: null, hasMore: false })
  })

  it('过滤掉非 message 条目', async () => {
    const path = await write('mixed.jsonl', [
      JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: 'x', cwd: '/tmp' }),
      JSON.stringify({ type: 'model_change', id: 'm1', provider: 'deepseek', modelId: 'chat' }),
      JSON.stringify({ type: 'thinking_level_change', id: 't1', thinkingLevel: 'off' }),
      messageLine('msg-1', 'user', '你好'),
      messageLine('msg-2', 'assistant', '你好呀'),
    ])

    const result = await readSessionMessages(path)

    expect(result.messages.map((m) => m.id)).toEqual(['msg-2', 'msg-1'])
    expect(result.hasMore).toBe(false)
    expect(result.nextCursor).toBeNull()
  })

  it('limit 按消息条数生效，不受夹杂的事件条目影响', async () => {
    const lines: string[] = [
      JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: 'x', cwd: '/tmp' }),
    ]
    for (let i = 0; i < 5; i++) {
      lines.push(JSON.stringify({ type: 'model_change', id: `mc-${i}`, provider: 'p', modelId: 'm' }))
      lines.push(messageLine(`msg-${i}`, 'user', `第 ${i} 条`))
    }
    const path = await write('paged.jsonl', lines)

    const first = await readSessionMessages(path, { limit: 2 })

    // 最新在前
    expect(first.messages.map((m) => m.id)).toEqual(['msg-4', 'msg-3'])
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).not.toBeNull()

    const second = await readSessionMessages(path, { limit: 2, before: first.nextCursor! })
    expect(second.messages.map((m) => m.id)).toEqual(['msg-2', 'msg-1'])

    const third = await readSessionMessages(path, { limit: 2, before: second.nextCursor! })
    expect(third.messages.map((m) => m.id)).toEqual(['msg-0'])
    expect(third.hasMore).toBe(false)
    expect(third.nextCursor).toBeNull()
  })

  it('跳过损坏行但保留其余消息', async () => {
    const path = await write('broken.jsonl', [
      messageLine('ok-1', 'user', 'a'),
      '{ not json',
      messageLine('ok-2', 'assistant', 'b'),
    ])

    const result = await readSessionMessages(path)
    expect(result.messages.map((m) => m.id)).toEqual(['ok-2', 'ok-1'])
  })

  it('type 为 message 但缺 message 字段的条目也过滤掉', async () => {
    const path = await write('halfbaked.jsonl', [
      JSON.stringify({ type: 'message', id: 'no-payload', timestamp: 'x' }),
      messageLine('ok', 'user', 'a'),
    ])

    const result = await readSessionMessages(path)
    expect(result.messages.map((m) => m.id)).toEqual(['ok'])
  })

  it('limit 上限为 100', async () => {
    const lines = Array.from({ length: 150 }, (_, i) => messageLine(`m-${i}`, 'user', `${i}`))
    const path = await write('big.jsonl', lines)

    const result = await readSessionMessages(path, { limit: 999 })
    expect(result.messages).toHaveLength(100)
    expect(result.hasMore).toBe(true)
  })
})
