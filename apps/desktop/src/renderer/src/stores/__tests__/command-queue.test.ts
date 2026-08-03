import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_QUEUE_ITEM_CHARS,
  MAX_QUEUE_LENGTH,
  useSessionStore,
} from '../session-store'

/**
 * 待发队列的行为契约。
 *
 * 队列存在的理由是：Agent 忙的时候用户想到的后续指令不该被吞掉。原来
 * `handleSend` 里 `if (isRunning) return` 直接丢弃，Enter 更是把生成杀掉。
 */

const THREAD = 'thread-1'
const OTHER = 'thread-2'

beforeEach(() => {
  useSessionStore.setState({ commandQueues: {} })
})

function queueOf(threadId: string): ReturnType<typeof useSessionStore.getState>['commandQueues'][string] {
  return useSessionStore.getState().commandQueues[threadId] ?? []
}

describe('commandQueue', () => {
  it('入队后可读到，文本已 trim', () => {
    const result = useSessionStore.getState().enqueueCommand(THREAD, '  跑一下测试  ')

    expect(result.ok).toBe(true)
    expect(queueOf(THREAD)).toHaveLength(1)
    expect(queueOf(THREAD)[0].text).toBe('跑一下测试')
  })

  it('空内容拒绝入队', () => {
    const result = useSessionStore.getState().enqueueCommand(THREAD, '   ')

    expect(result).toEqual({ ok: false, reason: 'empty' })
    expect(queueOf(THREAD)).toHaveLength(0)
  })

  it('只有附件没有文本时允许入队', () => {
    const result = useSessionStore.getState().enqueueCommand(THREAD, '', [
      { id: 'a1', name: 'x.txt', path: '/x.txt', size: 1, type: 'file' },
    ])

    expect(result.ok).toBe(true)
    expect(queueOf(THREAD)[0].attachments).toHaveLength(1)
  })

  it('超长文本拒绝入队', () => {
    const result = useSessionStore
      .getState()
      .enqueueCommand(THREAD, 'x'.repeat(MAX_QUEUE_ITEM_CHARS + 1))

    expect(result).toEqual({ ok: false, reason: 'too-long' })
  })

  it('达到长度上限后拒绝入队', () => {
    for (let i = 0; i < MAX_QUEUE_LENGTH; i++) {
      expect(useSessionStore.getState().enqueueCommand(THREAD, `第 ${i} 条`).ok).toBe(true)
    }
    const overflow = useSessionStore.getState().enqueueCommand(THREAD, '再来一条')

    expect(overflow).toEqual({ ok: false, reason: 'queue-full' })
    expect(queueOf(THREAD)).toHaveLength(MAX_QUEUE_LENGTH)
  })

  it('队列按会话隔离', () => {
    useSessionStore.getState().enqueueCommand(THREAD, 'A')
    useSessionStore.getState().enqueueCommand(OTHER, 'B')

    expect(queueOf(THREAD).map((c) => c.text)).toEqual(['A'])
    expect(queueOf(OTHER).map((c) => c.text)).toEqual(['B'])
  })

  it('shiftCommand 取队首并移除，FIFO', () => {
    useSessionStore.getState().enqueueCommand(THREAD, 'A')
    useSessionStore.getState().enqueueCommand(THREAD, 'B')

    expect(useSessionStore.getState().shiftCommand(THREAD)?.text).toBe('A')
    expect(queueOf(THREAD).map((c) => c.text)).toEqual(['B'])
  })

  it('空队列 shift 返回 undefined', () => {
    expect(useSessionStore.getState().shiftCommand(THREAD)).toBeUndefined()
  })

  it('removeCommand 按 id 移除', () => {
    const a = useSessionStore.getState().enqueueCommand(THREAD, 'A')
    useSessionStore.getState().enqueueCommand(THREAD, 'B')
    if (!a.ok) throw new Error('入队应成功')

    useSessionStore.getState().removeCommand(THREAD, a.id)
    expect(queueOf(THREAD).map((c) => c.text)).toEqual(['B'])
  })

  it('updateCommandText 改写内容', () => {
    const a = useSessionStore.getState().enqueueCommand(THREAD, 'A')
    if (!a.ok) throw new Error('入队应成功')

    useSessionStore.getState().updateCommandText(THREAD, a.id, 'A 改')
    expect(queueOf(THREAD)[0].text).toBe('A 改')
  })

  it('reorderQueue 按给定顺序重排', () => {
    useSessionStore.getState().enqueueCommand(THREAD, 'A')
    useSessionStore.getState().enqueueCommand(THREAD, 'B')
    useSessionStore.getState().enqueueCommand(THREAD, 'C')
    const ids = queueOf(THREAD).map((c) => c.id)

    useSessionStore.getState().reorderQueue(THREAD, [ids[2], ids[0], ids[1]])
    expect(queueOf(THREAD).map((c) => c.text)).toEqual(['C', 'A', 'B'])
  })

  it('reorderQueue 漏列的项保留在尾部而不是丢失', () => {
    useSessionStore.getState().enqueueCommand(THREAD, 'A')
    useSessionStore.getState().enqueueCommand(THREAD, 'B')
    useSessionStore.getState().enqueueCommand(THREAD, 'C')
    const ids = queueOf(THREAD).map((c) => c.id)

    useSessionStore.getState().reorderQueue(THREAD, [ids[1]])
    expect(queueOf(THREAD).map((c) => c.text)).toEqual(['B', 'A', 'C'])
  })

  it('reorderQueue 忽略不存在的 id', () => {
    useSessionStore.getState().enqueueCommand(THREAD, 'A')
    const ids = queueOf(THREAD).map((c) => c.id)

    useSessionStore.getState().reorderQueue(THREAD, ['ghost', ids[0]])
    expect(queueOf(THREAD).map((c) => c.text)).toEqual(['A'])
  })

  it('clearQueue 清空当前会话但不影响其他会话', () => {
    useSessionStore.getState().enqueueCommand(THREAD, 'A')
    useSessionStore.getState().enqueueCommand(OTHER, 'B')

    useSessionStore.getState().clearQueue(THREAD)
    expect(queueOf(THREAD)).toHaveLength(0)
    expect(queueOf(OTHER)).toHaveLength(1)
  })

  it('删除会话时连带清掉它的队列', () => {
    useSessionStore.setState({
      sessions: [
        { id: THREAD, title: 't', preview: '', createdAt: 0, updatedAt: 0 },
        { id: OTHER, title: 'o', preview: '', createdAt: 0, updatedAt: 0 },
      ],
    })
    useSessionStore.getState().enqueueCommand(THREAD, 'A')
    useSessionStore.getState().enqueueCommand(OTHER, 'B')

    useSessionStore.getState().removeSession(THREAD)
    expect(useSessionStore.getState().commandQueues[THREAD]).toBeUndefined()
    expect(queueOf(OTHER)).toHaveLength(1)
  })
})
