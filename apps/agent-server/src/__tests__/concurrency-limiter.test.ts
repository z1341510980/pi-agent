import { describe, expect, it, vi } from 'vitest'
import { ConcurrencyLimiter, DEFAULT_LIMITS } from '../core/agent/concurrency-limiter.js'

describe('ConcurrencyLimiter', () => {
  it('默认配置使用 DEFAULT_LIMITS', () => {
    const limiter = new ConcurrencyLimiter()
    expect(limiter.getActiveCount()).toBe(0)
    expect(limiter.getTotalCount()).toBe(0)
    expect(limiter.getQueueLength()).toBe(0)
  })

  it('acquire 成功获取槽位并递增计数', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 2, maxDepth: 3, maxTotal: 10 })
    const release = await limiter.acquire(0)
    expect(limiter.getActiveCount()).toBe(1)
    expect(limiter.getTotalCount()).toBe(1)
    release()
    expect(limiter.getActiveCount()).toBe(0)
    expect(limiter.getTotalCount()).toBe(1) // totalCount 不因 release 递减
  })

  it('release 幂等：多次调用只生效一次', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxDepth: 3, maxTotal: 10 })
    const release = await limiter.acquire(0)
    release()
    release()
    release()
    expect(limiter.getActiveCount()).toBe(0)
  })

  it('深度超限时抛错', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 5, maxDepth: 2, maxTotal: 20 })
    await expect(limiter.acquire(3)).rejects.toThrow()
    expect(limiter.getActiveCount()).toBe(0)
    expect(limiter.getTotalCount()).toBe(0)
  })

  it('深度等于上限时不抛错（边界检查）', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 5, maxDepth: 2, maxTotal: 20 })
    const release = await limiter.acquire(2)
    expect(limiter.getActiveCount()).toBe(1)
    release()
  })

  it('总数超限时抛错', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 5, maxDepth: 3, maxTotal: 2 })
    const r1 = await limiter.acquire(0)
    const r2 = await limiter.acquire(0)
    await expect(limiter.acquire(0)).rejects.toThrow()
    r1()
    r2()
  })

  it('并发数超限且未设置超时时立即抛错', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxDepth: 3, maxTotal: 10 })
    const r1 = await limiter.acquire(0)
    // 并发已满，无超时 → 立即拒绝
    await expect(limiter.acquire(0)).rejects.toThrow()
    r1()
  })

  it('并发数超限时排队等待，release 后唤醒', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxDepth: 3, maxTotal: 10 })
    const r1 = await limiter.acquire(0)

    // 第二个 acquire 应排队等待
    const acquirePromise = limiter.acquire(0, { timeoutMs: 5000 })
    expect(limiter.getQueueLength()).toBe(1)

    // 释放第一个槽位
    r1()

    // 第二个应获取成功
    const r2 = await acquirePromise
    expect(limiter.getActiveCount()).toBe(1)
    expect(limiter.getQueueLength()).toBe(0)
    r2()
  })

  it('并发等待超时后抛错', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxDepth: 3, maxTotal: 10 })
    const r1 = await limiter.acquire(0)

    // 设置较短超时
    await expect(limiter.acquire(0, { timeoutMs: 50 })).rejects.toThrow()
    expect(limiter.getQueueLength()).toBe(0)

    r1()
  })

  it('并发场景：多任务排队按 FIFO 顺序获取', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxDepth: 3, maxTotal: 20 })
    const order: number[] = []

    // 占用唯一槽位
    const initialRelease = await limiter.acquire(0)

    // 3 个任务排队
    const tasks = [1, 2, 3].map(async (n) => {
      const release = await limiter.acquire(0, { timeoutMs: 5000 })
      order.push(n)
      // 短暂持有后释放，让下一个进入
      await new Promise((r) => setTimeout(r, 10))
      release()
    })

    // 释放初始槽位，触发队列消费
    initialRelease()

    await Promise.all(tasks)

    expect(order).toEqual([1, 2, 3])
  })

  it('并发场景：同时获取不超过 maxConcurrent', async () => {
    const maxConcurrent = 3
    const limiter = new ConcurrencyLimiter({
      maxConcurrent,
      maxDepth: 3,
      maxTotal: 20,
    })

    let currentActive = 0
    let maxObserved = 0

    const tasks = Array.from({ length: 10 }, async () => {
      const release = await limiter.acquire(0, { timeoutMs: 5000 })
      currentActive++
      maxObserved = Math.max(maxObserved, currentActive)
      await new Promise((r) => setTimeout(r, 10))
      currentActive--
      release()
    })

    await Promise.all(tasks)

    expect(maxObserved).toBeLessThanOrEqual(maxConcurrent)
    expect(limiter.getTotalCount()).toBe(10)
    expect(limiter.getActiveCount()).toBe(0)
  })

  it('reset 清零计数器并拒绝所有等待者', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxDepth: 3, maxTotal: 10 })
    const r1 = await limiter.acquire(0)

    // 排队等待
    const waitPromise = limiter.acquire(0, { timeoutMs: 5000 })
    expect(limiter.getQueueLength()).toBe(1)

    limiter.reset()

    await expect(waitPromise).rejects.toThrow()
    expect(limiter.getActiveCount()).toBe(0)
    expect(limiter.getTotalCount()).toBe(0)
    expect(limiter.getQueueLength()).toBe(0)

    r1() // reset 后 release 无副作用
  })

  it('reset 后可重新 acquire', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxDepth: 3, maxTotal: 2 })
    const r1 = await limiter.acquire(0)
    r1()
    const r2 = await limiter.acquire(0)
    r2()

    // 总数已达上限
    await expect(limiter.acquire(0)).rejects.toThrow()

    limiter.reset()

    // reset 后可重新获取
    const r3 = await limiter.acquire(0)
    expect(limiter.getTotalCount()).toBe(1)
    r3()
  })

  it('DEFAULT_LIMITS 包含正确的默认值', () => {
    expect(DEFAULT_LIMITS.maxConcurrent).toBe(5)
    expect(DEFAULT_LIMITS.maxDepth).toBe(3)
    expect(DEFAULT_LIMITS.maxTotal).toBe(20)
  })

  it('高并发场景：100 个任务受限流控制', async () => {
    const limiter = new ConcurrencyLimiter({
      maxConcurrent: 5,
      maxDepth: 3,
      maxTotal: 100,
    })

    let completed = 0
    let active = 0
    let maxActive = 0

    const tasks = Array.from({ length: 100 }, async () => {
      const release = await limiter.acquire(0, { timeoutMs: 10000 })
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 1))
      active--
      completed++
      release()
    })

    await Promise.all(tasks)

    expect(completed).toBe(100)
    expect(maxActive).toBeLessThanOrEqual(5)
    expect(limiter.getTotalCount()).toBe(100)
    expect(limiter.getActiveCount()).toBe(0)
  })
})
