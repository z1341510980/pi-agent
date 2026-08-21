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
    // 方案 §9.4：工厂第二参数为恢复上下文；未注入注册表时为 undefined
    expect(factory).toHaveBeenCalledWith('thread-1', undefined)
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

  it('dispose 会 abort/dispose 活跃和空闲 session，且幂等', async () => {
    const store = new PiSessionStore()
    const active = { abort: vi.fn(), dispose: vi.fn() }
    const idle = { abort: vi.fn(), dispose: vi.fn() }
    store.setSessionFactory(vi.fn()
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(idle))
    await store.getOrCreate('active')
    await store.getOrCreate('idle')
    store.tryAcquireRun('active', 'run-1')

    store.dispose()
    store.dispose()

    expect(active.abort).toHaveBeenCalledTimes(1)
    expect(active.dispose).toHaveBeenCalledTimes(1)
    expect(idle.abort).not.toHaveBeenCalled()
    expect(idle.dispose).toHaveBeenCalledTimes(1)
    expect(store.getStats().threadCount).toBe(0)
  })

  it('invalidate 后异步 factory 完成的 session 会被释放且不会回写', async () => {
    const store = new PiSessionStore()
    let resolveFactory: ((session: unknown) => void) | undefined
    const created = { abort: vi.fn(), dispose: vi.fn() }
    store.setSessionFactory(() => new Promise((resolve) => { resolveFactory = resolve }))
    const pending = store.getOrCreate('race')
    store.invalidate({ scope: 'all', reason: 'test invalidation' })
    resolveFactory?.(created)

    await expect(pending).rejects.toThrow('已丢弃')
    expect(created.abort).toHaveBeenCalledTimes(1)
    expect(created.dispose).toHaveBeenCalledTimes(1)
    expect(store.getStats().threadCount).toBe(0)
  })

  it('idle 淘汰会 dispose session', async () => {
    const idle = { dispose: vi.fn() }
    const store = new PiSessionStore({ idleTimeoutMs: -1 })
    store.setSessionFactory(() => Promise.resolve(idle))
    await store.getOrCreate('idle')
    expect(store.sweepIdle()).toBe(1)
    expect(idle.dispose).toHaveBeenCalledTimes(1)
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

describe('PiSessionStore.invalidate（方案 §10.12-2）', () => {
  it('空闲会话立即 dispose 并移除', async () => {
    const store = new PiSessionStore()
    const idle = { abort: vi.fn(), dispose: vi.fn() }
    store.setSessionFactory(async () => idle)
    await store.getOrCreate('idle')

    const result = store.invalidate({ scope: 'all', reason: 'provider upsert' })

    expect(result).toEqual({ retired: 1, markedStale: 0 })
    expect(idle.dispose).toHaveBeenCalledTimes(1)
    expect(idle.abort).not.toHaveBeenCalled()
    expect(store.getStats().threadCount).toBe(0)
  })

  it('活跃 run 默认只标 stale，不删条目也不丢 lease', async () => {
    const store = new PiSessionStore()
    const active = { abort: vi.fn(), dispose: vi.fn() }
    store.setSessionFactory(async () => active)
    await store.getOrCreate('busy')
    store.tryAcquireRun('busy', 'run-1')

    const result = store.invalidate({ scope: 'all', reason: 'default provider' })

    expect(result).toEqual({ retired: 0, markedStale: 1 })
    expect(active.dispose).not.toHaveBeenCalled()
    // lease 仍在：并发的第二个 run 依然被拒绝，互斥不变量不被配置变更破坏
    expect(store.tryAcquireRun('busy', 'run-2')).toBe(false)
    expect(store.getStats()).toMatchObject({ threadCount: 1, activeRuns: 1, staleCount: 1 })
  })

  it('stale 会话在 run 结束后由下次 getOrCreate 重建', async () => {
    const store = new PiSessionStore()
    const first = { id: 'first', abort: vi.fn(), dispose: vi.fn() }
    const second = { id: 'second', abort: vi.fn(), dispose: vi.fn() }
    store.setSessionFactory(vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second))

    const before = await store.getOrCreate('thread-1')
    store.tryAcquireRun('thread-1', 'run-1')
    store.invalidate({ scope: 'all', reason: 'config change' })

    // run 仍在进行：拿到的还是旧 session，避免中途换掉正在使用的会话
    expect((await store.getOrCreate('thread-1')).session).toBe(first)

    store.releaseRun('thread-1', 'run-1')
    const after = await store.getOrCreate('thread-1')

    expect(after.session).toBe(second)
    expect(after).not.toBe(before)
    expect(first.dispose).toHaveBeenCalledTimes(1)
  })

  it('pending tool call 期间不重建，清空后才重建', async () => {
    const store = new PiSessionStore()
    const first = { id: 'first', dispose: vi.fn() }
    const second = { id: 'second', dispose: vi.fn() }
    store.setSessionFactory(vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second))

    await store.getOrCreate('thread-1')
    store.rememberToolCall('thread-1', 'call-1', {})
    store.invalidate({ scope: 'all', reason: 'config change' })
    expect((await store.getOrCreate('thread-1')).session).toBe(first)

    store.consumeToolCall('thread-1', 'call-1')
    expect((await store.getOrCreate('thread-1')).session).toBe(second)
  })

  it('abortActive 时中止并立即退休活跃会话', async () => {
    const store = new PiSessionStore()
    const active = { abort: vi.fn(), dispose: vi.fn() }
    store.setSessionFactory(async () => active)
    await store.getOrCreate('busy')
    store.tryAcquireRun('busy', 'run-1')

    const result = store.invalidate({
      scope: 'all',
      reason: 'provider deleted',
      abortActive: true,
    })

    expect(result).toEqual({ retired: 1, markedStale: 0 })
    expect(active.abort).toHaveBeenCalledTimes(1)
    expect(active.dispose).toHaveBeenCalledTimes(1)
    expect(store.getStats().threadCount).toBe(0)
  })

  it("scope='thread' 只影响目标线程", async () => {
    const store = new PiSessionStore()
    const a = { id: 'a', dispose: vi.fn() }
    const b = { id: 'b', dispose: vi.fn() }
    store.setSessionFactory(vi.fn(async (threadId: string) => (threadId === 'a' ? a : b)))
    await store.getOrCreate('a')
    await store.getOrCreate('b')

    const result = store.invalidate({ scope: 'thread', threadId: 'a', reason: 'thinkingLevel' })

    expect(result).toEqual({ retired: 1, markedStale: 0 })
    expect(a.dispose).toHaveBeenCalledTimes(1)
    expect(b.dispose).not.toHaveBeenCalled()
    expect(store.getStats().threadCount).toBe(1)
  })

  it("scope='thread' 缺少 threadId 时明确报错", () => {
    const store = new PiSessionStore()
    expect(() => store.invalidate({ scope: 'thread', reason: 'x' })).toThrow('threadId')
  })

  it("scope='thread' 不影响其他线程正在进行的异步创建", async () => {
    const store = new PiSessionStore()
    const created = { id: 'created', dispose: vi.fn() }
    let resolveFactory: ((session: unknown) => void) | undefined
    store.setSessionFactory(
      (threadId: string) =>
        threadId === 'slow'
          ? new Promise((resolve) => {
              resolveFactory = resolve
            })
          : Promise.resolve({ id: threadId, dispose: vi.fn() } as never)
    )

    const pending = store.getOrCreate('slow')
    await store.getOrCreate('other')
    store.invalidate({ scope: 'thread', threadId: 'other', reason: 'thinkingLevel' })
    resolveFactory?.(created)

    // 未推进全局 epoch，因此 slow 线程的创建结果仍然有效
    await expect(pending).resolves.toMatchObject({ threadId: 'slow' })
    expect(created.dispose).not.toHaveBeenCalled()
  })

  it('stale 会话在 sweepIdle 中不等 idleTimeout 就被回收', async () => {
    const store = new PiSessionStore({ idleTimeoutMs: 60_000 })
    const idle = { dispose: vi.fn() }
    store.setSessionFactory(async () => idle)
    await store.getOrCreate('thread-1')
    store.tryAcquireRun('thread-1', 'run-1')
    store.invalidate({ scope: 'all', reason: 'config change' })

    // 仍有 lease：不回收
    expect(store.sweepIdle()).toBe(0)
    store.releaseRun('thread-1', 'run-1')
    expect(store.sweepIdle()).toBe(1)
    expect(idle.dispose).toHaveBeenCalledTimes(1)
  })

  it('dispose 会 abort 并 dispose 每个会话', async () => {
    const store = new PiSessionStore()
    const active = { abort: vi.fn(), dispose: vi.fn() }
    store.setSessionFactory(async () => active)
    await store.getOrCreate('busy')
    store.tryAcquireRun('busy', 'run-1')

    store.dispose()

    expect(active.abort).toHaveBeenCalledTimes(1)
    expect(active.dispose).toHaveBeenCalledTimes(1)
    expect(store.getStats().threadCount).toBe(0)
  })
})

describe('PiSessionStore session:retired 事件（产品级，非 SDK session_shutdown）', () => {
  function createBus() {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = []
    return {
      events,
      bus: {
        emit: (name: string, payload: Record<string, unknown>) => {
          events.push({ name, payload })
        },
      } as never,
    }
  }

  it('idle 淘汰发射 retired，reason=idle-timeout，payload 不含 session 引用', async () => {
    const { bus, events } = createBus()
    const store = new PiSessionStore({ idleTimeoutMs: -1 })
    store.setEventBus(bus)
    store.setSessionFactory(async () => ({ id: 's', dispose: vi.fn() }))
    await store.getOrCreate('thread-1')

    expect(store.sweepIdle()).toBe(1)

    expect(events).toEqual([
      {
        name: 'session:retired',
        payload: {
          threadId: 'thread-1',
          reason: 'idle-timeout',
          aborted: false,
          hadActiveRun: false,
        },
      },
    ])
  })

  it('invalidate 退休时携带失效原因；abort 时如实标记', async () => {
    const { bus, events } = createBus()
    const store = new PiSessionStore()
    store.setEventBus(bus)
    const active = { abort: vi.fn(), dispose: vi.fn() }
    store.setSessionFactory(async () => active)
    await store.getOrCreate('busy')
    store.tryAcquireRun('busy', 'run-1')

    store.invalidate({ scope: 'all', reason: 'provider deleted: x', abortActive: true })

    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({
      threadId: 'busy',
      reason: 'provider deleted: x',
      aborted: true,
      hadActiveRun: true,
    })
  })

  it('stale 会话在重建退休时携带配置变更原因', async () => {
    const { bus, events } = createBus()
    const store = new PiSessionStore()
    store.setEventBus(bus)
    const first = { id: 'first', dispose: vi.fn() }
    const second = { id: 'second', dispose: vi.fn() }
    store.setSessionFactory(vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second))

    await store.getOrCreate('thread-1')
    store.tryAcquireRun('thread-1', 'run-1')
    // 活跃 run：只标 stale，不发射事件
    store.invalidate({ scope: 'all', reason: 'thinkingLevel=high' })
    expect(events).toEqual([])

    store.releaseRun('thread-1', 'run-1')
    await store.getOrCreate('thread-1')

    expect(events).toEqual([
      {
        name: 'session:retired',
        payload: {
          threadId: 'thread-1',
          reason: 'thinkingLevel=high',
          aborted: false,
          hadActiveRun: false,
        },
      },
    ])
  })

  it('LRU 淘汰与应用关闭各自发射带原因的事件', async () => {
    const { bus, events } = createBus()
    // LRU 由 sweep 定时器执行：用短间隔真实等待
    const store = new PiSessionStore({ maxSessions: 1, sweepIntervalMs: 5 })
    store.setEventBus(bus)
    store.setSessionFactory(async () => ({ id: 's', dispose: vi.fn() }))
    await store.getOrCreate('a')
    await store.getOrCreate('b')

    await vi.waitFor(() => {
      expect(events.map((event) => event.payload.reason)).toContain('lru')
    })

    store.dispose()
    expect(events.map((event) => event.payload.reason)).toContain('store dispose')
  })

  it('未注入 EventBus 时一切照常（可选依赖）', async () => {
    const store = new PiSessionStore({ idleTimeoutMs: -1 })
    store.setSessionFactory(async () => ({ id: 's', dispose: vi.fn() }))
    await store.getOrCreate('thread-1')
    expect(() => store.sweepIdle()).not.toThrow()
    expect(store.sweepIdle()).toBe(0) // 上一次调用已淘汰
  })
})
