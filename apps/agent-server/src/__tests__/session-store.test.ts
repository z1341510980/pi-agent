import { describe, expect, it, vi } from 'vitest'
import { PiSessionStore } from '../core/agent/session-store.js'

describe('PiSessionStore', () => {
  it('getOrCreate 返回会话并记录', async () => {
    const store = new PiSessionStore()
    const mockSession = { id: 'session-1' } as any
    const factory = vi.fn(() => Promise.resolve(mockSession))
    store.setSessionFactory(factory)

    const threadSession = await store.getOrCreate('thread-1')
    expect(threadSession.threadId).toBe('thread-1')
    expect(threadSession.session).toBe(mockSession)
    expect(factory).toHaveBeenCalledWith('thread-1')
  })

  it('getOrCreate 相同 threadId 返回同一会话', async () => {
    const store = new PiSessionStore()
    const mockSession = { id: 'session-1' } as any
    store.setSessionFactory(() => Promise.resolve(mockSession))

    const s1 = await store.getOrCreate('thread-1')
    const s2 = await store.getOrCreate('thread-1')
    expect(s1).toBe(s2)
  })

  it('getStats 返回活跃会话数', async () => {
    const store = new PiSessionStore()
    const mockSession = { id: 'session-1' } as any
    store.setSessionFactory(() => Promise.resolve(mockSession))

    await store.getOrCreate('thread-1')
    await store.getOrCreate('thread-2')

    const stats = store.getStats()
    expect(stats.threadCount).toBe(2)
  })

  it('并发 getOrCreate 同 threadId 只创建一个 session', async () => {
    const store = new PiSessionStore()
    let createCount = 0
    store.setSessionFactory(async () => {
      createCount++
      await new Promise((r) => setTimeout(r, 10))
      return { id: 'session-1' } as any
    })

    const [s1, s2, s3] = await Promise.all([
      store.getOrCreate('thread-1'),
      store.getOrCreate('thread-1'),
      store.getOrCreate('thread-1'),
    ])

    expect(createCount).toBe(1)
    expect(s1).toBe(s2)
    expect(s2).toBe(s3)
  })

  it('tryAcquireRun/releaseRun 提供同线程 run 互斥', async () => {
    const store = new PiSessionStore()
    store.setSessionFactory(async () => ({ id: 'session-1' } as any))

    // 先创建 session
    await store.getOrCreate('thread-1')

    // 第一次 acquire 应成功
    expect(store.tryAcquireRun('thread-1', 'run-1')).toBe(true)
    expect(store.hasActiveRun('thread-1')).toBe(true)

    // 第二次 acquire 不同 runId 应失败
    expect(store.tryAcquireRun('thread-1', 'run-2')).toBe(false)

    // 释放错误的 runId 不应释放
    store.releaseRun('thread-1', 'run-2')
    expect(store.hasActiveRun('thread-1')).toBe(true)

    // 释放正确的 runId 应成功
    store.releaseRun('thread-1', 'run-1')
    expect(store.hasActiveRun('thread-1')).toBe(false)

    // 释放后可再次 acquire
    expect(store.tryAcquireRun('thread-1', 'run-3')).toBe(true)
  })

  it('getStats 包含 activeRuns 计数', async () => {
    const store = new PiSessionStore()
    store.setSessionFactory(async () => ({ id: 'session-1' } as any))

    await store.getOrCreate('thread-1')
    await store.getOrCreate('thread-2')

    store.tryAcquireRun('thread-1', 'run-1')

    const stats = store.getStats()
    expect(stats.activeRuns).toBe(1)
  })
})
