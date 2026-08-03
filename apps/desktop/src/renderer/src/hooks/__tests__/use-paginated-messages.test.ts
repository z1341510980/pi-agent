import { describe, expect, it } from 'vitest'
import { decodeEntries } from '../use-paginated-messages'
import { collectToolCalls } from '../../components/chat/types'
import type { SessionMessageEntry } from '../../api/http-client'

/**
 * 这些 fixture 抄自真实的会话 JSONL（`.pi-data/agent/sessions/*.jsonl`）。
 *
 * 回归目标：之前的实现假设条目是 `{id, role, content: string}`，导致每条历史消息
 * 都退化成空白的 assistant 气泡。用真实形状钉住解码契约。
 */

function userEntry(id: string, text: string, ts = 1781683191145): SessionMessageEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: ts,
    },
  }
}

describe('decodeEntries', () => {
  it('解出 user 消息的正文与时间戳', () => {
    const [msg] = decodeEntries([userEntry('5665a76e', '你好，请用一句话介绍你自己')])

    expect(msg.id).toBe('5665a76e')
    expect(msg.role).toBe('user')
    expect(msg.content).toBe('你好，请用一句话介绍你自己')
    expect(msg.createdAt).toBe(1781683191145)
    expect(msg.status).toBe('complete')
  })

  it('支持 user content 直接是字符串的形态', () => {
    const [msg] = decodeEntries([
      {
        type: 'message',
        id: 'a1',
        timestamp: '2026-06-17T07:59:51.148Z',
        message: { role: 'user', content: '纯字符串', timestamp: 1 },
      },
    ])

    expect(msg.content).toBe('纯字符串')
  })

  it('把 assistant 的多个 text 块拼成正文', () => {
    const [msg] = decodeEntries([
      {
        type: 'message',
        id: 'b1',
        timestamp: '2026-06-17T07:59:54.896Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '前半段' },
            { type: 'text', text: '后半段' },
          ],
          timestamp: 2,
        },
      },
    ])

    expect(msg.content).toBe('前半段后半段')
  })

  it('把 thinking 块解成思考块而不是混进正文', () => {
    const [msg] = decodeEntries([
      {
        type: 'message',
        id: 'c1',
        timestamp: '2026-06-17T08:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '先看看文件' },
            { type: 'text', text: '结论是这样' },
          ],
          timestamp: 3,
        },
      },
    ])

    expect(msg.content).toBe('结论是这样')
    // 顺序保真：JSONL 里 thinking 在 text 之前，分段顺序也应如此
    expect(msg.segments.map((s) => s.kind)).toEqual(['thinking', 'text'])
    const thinking = msg.segments[0]
    if (thinking.kind !== 'thinking') throw new Error('第一段应为 thinking')
    expect(thinking.content).toBe('先看看文件')
    expect(thinking.isStreaming).toBe(false)
  })

  it('把 toolCall 块解成工具分段', () => {
    const [msg] = decodeEntries([
      {
        type: 'message',
        id: 'd1',
        timestamp: '2026-06-17T08:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'text', text: '读完了' },
          ],
          timestamp: 4,
        },
      },
    ])

    const calls = collectToolCalls(msg)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'read',
      args: { path: 'a.ts' },
    })
    // 工具在前、文字在后 —— 这就是交错保真
    expect(msg.segments.map((s) => s.kind)).toEqual(['tool', 'text'])
  })

  it('保留「文本 → 工具 → 文本」的交错顺序', () => {
    const [msg] = decodeEntries([
      {
        type: 'message',
        id: 'x1',
        timestamp: '2026-06-17T08:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '我先看看。' },
            { type: 'toolCall', id: 'c1', name: 'read', arguments: {} },
            { type: 'text', text: '确实有问题，我改一下。' },
            { type: 'toolCall', id: 'c2', name: 'edit', arguments: {} },
            { type: 'text', text: '改好了。' },
          ],
          timestamp: 5,
        },
      },
    ])

    expect(msg.segments.map((s) => s.kind)).toEqual(['text', 'tool', 'text', 'tool', 'text'])
    // content 只拼文本分段
    expect(msg.content).toBe('我先看看。确实有问题，我改一下。改好了。')
  })

  it('toolResult 回填到对应工具调用上，且不单独成气泡', () => {
    const messages = decodeEntries([
      {
        type: 'message',
        id: 'e1',
        timestamp: '2026-06-17T08:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-9', name: 'read', arguments: {} }],
          timestamp: 5,
        },
      },
      {
        type: 'message',
        id: 'e2',
        timestamp: '2026-06-17T08:00:03.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call-9',
          toolName: 'read',
          content: [{ type: 'text', text: 'file body' }],
          isError: false,
          timestamp: 6,
        },
      },
    ])

    expect(messages).toHaveLength(1)
    expect(collectToolCalls(messages[0])[0]).toMatchObject({
      toolCallId: 'call-9',
      status: 'success',
      partialResult: 'file body',
      endedAt: 6,
    })
  })

  it('失败的 toolResult 把工具调用标成 error', () => {
    const messages = decodeEntries([
      {
        type: 'message',
        id: 'f1',
        timestamp: '2026-06-17T08:00:04.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-x', name: 'bash', arguments: {} }],
          timestamp: 7,
        },
      },
      {
        type: 'message',
        id: 'f2',
        timestamp: '2026-06-17T08:00:05.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call-x',
          content: [{ type: 'text', text: 'exit 1' }],
          isError: true,
          timestamp: 8,
        },
      },
    ])

    expect(collectToolCalls(messages[0])[0].status).toBe('error')
  })

  it('丢弃既无正文也无思考也无工具调用的空条目', () => {
    const messages = decodeEntries([
      {
        type: 'message',
        id: 'g1',
        timestamp: '2026-06-17T08:00:06.000Z',
        message: { role: 'assistant', content: [], timestamp: 9 },
      },
      userEntry('g2', '还有一条'),
    ])

    expect(messages.map((m) => m.id)).toEqual(['g2'])
  })

  it('缺少 message 字段的条目直接跳过', () => {
    expect(decodeEntries([{ type: 'message', id: 'h1' }])).toEqual([])
  })

  it('message.timestamp 缺失时回落到 entry 的 ISO 时间戳', () => {
    const [msg] = decodeEntries([
      {
        type: 'message',
        id: 'i1',
        timestamp: '2026-06-17T07:59:51.148Z',
        message: { role: 'user', content: [{ type: 'text', text: 'x' }] },
      },
    ])

    expect(msg.createdAt).toBe(Date.parse('2026-06-17T07:59:51.148Z'))
  })

  it('errorMessage 反映为 error 状态', () => {
    const [msg] = decodeEntries([
      {
        type: 'message',
        id: 'j1',
        timestamp: '2026-06-17T08:00:07.000Z',
        message: {
          role: 'assistant',
          content: [],
          errorMessage: 'provider 超时',
          timestamp: 10,
        },
      },
    ])

    expect(msg.status).toBe('error')
    expect(msg.error).toBe('provider 超时')
  })

  /**
   * `findToolCall` 直接 `for...of messages[i].segments`，没有 `readSegments` 兜底。
   *
   * 这是安全的，但依赖一条不显眼的不变量：`decodeEntries` 里 `segments` 一定是
   * 数组字面量，且 `result` 只装自己造的消息 —— 外部消息进不来。唯一能让
   * `segments` 为空数组入列的分支是「errorMessage 存在但内容块为空」，
   * 空数组照样可迭代。下面把这条路径显式走一遍，避免将来有人把
   * `segments` 改成条件赋值（`?:` 里漏一个分支就是 undefined）而无人察觉。
   */
  it('空 segments 的 error 消息在列表里时，后续 toolResult 回填不抛错', () => {
    const messages = decodeEntries([
      {
        type: 'message',
        id: 'k1',
        timestamp: '2026-06-17T08:00:08.000Z',
        message: { role: 'assistant', content: [], errorMessage: '中断', timestamp: 11 },
      },
      {
        type: 'message',
        id: 'k2',
        timestamp: '2026-06-17T08:00:09.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-k', name: 'read', arguments: {} }],
          timestamp: 12,
        },
      },
      {
        type: 'message',
        id: 'k3',
        timestamp: '2026-06-17T08:00:10.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call-k',
          content: [{ type: 'text', text: 'ok' }],
          timestamp: 13,
        },
      },
    ])

    // 倒序查找会先扫过那条空 segments 的 error 消息，再命中 call-k
    expect(messages).toHaveLength(2)
    expect(collectToolCalls(messages[1])[0]).toMatchObject({
      toolCallId: 'call-k',
      partialResult: 'ok',
    })
  })

  it('每条解码结果的 segments 都是真数组（findToolCall 无兜底的前提）', () => {
    const messages = decodeEntries([
      userEntry('m1', '你好'),
      {
        type: 'message',
        id: 'm2',
        timestamp: '2026-06-17T08:00:11.000Z',
        message: { role: 'assistant', content: [], errorMessage: '失败', timestamp: 14 },
      },
      {
        type: 'message',
        id: 'm3',
        timestamp: '2026-06-17T08:00:12.000Z',
        // content 既不是数组也不是字符串 —— 走 `: []` 那个分支
        message: { role: 'assistant', content: 42 as never, errorMessage: 'x', timestamp: 15 },
      },
    ])

    expect(messages.length).toBeGreaterThan(0)
    for (const msg of messages) {
      expect(Array.isArray(msg.segments)).toBe(true)
    }
  })

  it('toolResult 的 toolCallId 缺失或非字符串时安全跳过', () => {
    const messages = decodeEntries([
      {
        type: 'message',
        id: 'n1',
        timestamp: '2026-06-17T08:00:13.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-n', name: 'read', arguments: {} }],
          timestamp: 16,
        },
      },
      {
        type: 'message',
        id: 'n2',
        timestamp: '2026-06-17T08:00:14.000Z',
        message: { role: 'toolResult', content: [{ type: 'text', text: 'orphan' }], timestamp: 17 },
      },
    ])

    // 匹配不上就什么都不做，不该把结果乱挂到别的调用上
    expect(collectToolCalls(messages[0])[0].partialResult).toBeUndefined()
  })
})
