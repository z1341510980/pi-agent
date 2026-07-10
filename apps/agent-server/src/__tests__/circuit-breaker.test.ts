import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CircuitBreaker, type CircuitBreakerOptions } from '../core/agent/circuit-breaker.js'

describe('CircuitBreaker 三态熔断器', () => {
  it('初始状态为 CLOSED', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 })
    expect(cb.state).toBe('closed')
    expect(cb.canExecute()).toBe(true)
  })

  it('失败次数未达阈值时保持 CLOSED', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 })
    const fail = vi.fn().mockRejectedValue(new Error('LLM 失败'))
    await expect(cb.execute(fail)).rejects.toThrow('LLM 失败')
    await expect(cb.execute(fail)).rejects.toThrow('LLM 失败')
    expect(cb.state).toBe('closed')
    expect(cb.stats.failures).toBe(2)
  })

  it('失败达阈值后切换为 OPEN，拒绝后续调用', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 })
    const fail = vi.fn().mockRejectedValue(new Error('LLM 失败'))
    // 失败 3 次
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(fail)).rejects.toThrow()
    }
    expect(cb.state).toBe('open')
    // 第 4 次调用应被熔断器拒绝（不实际调用 fn）
    const fn = vi.fn().mockResolvedValue('ok')
    await expect(cb.execute(fn)).rejects.toThrow(/熔断器开路|circuit breaker is open/i)
    expect(fn).not.toHaveBeenCalled()
  })

  it('reset_timeout 后切换为 HALF_OPEN，允许一次试探调用', async () => {
    vi.useFakeTimers()
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 })
    const fail = vi.fn().mockRejectedValue(new Error('失败'))
    for (let i = 0; i < 2; i++) {
      await expect(cb.execute(fail)).rejects.toThrow()
    }
    expect(cb.state).toBe('open')

    // 推进时间 1s
    vi.advanceTimersByTime(1000)
    expect(cb.state).toBe('half_open')
    expect(cb.canExecute()).toBe(true)

    vi.useRealTimers()
  })

  it('HALF_OPEN 时试探成功 → CLOSED，重置失败计数', async () => {
    vi.useFakeTimers()
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 })
    const fail = vi.fn().mockRejectedValue(new Error('失败'))
    for (let i = 0; i < 2; i++) {
      await expect(cb.execute(fail)).rejects.toThrow()
    }
    vi.advanceTimersByTime(1000)
    expect(cb.state).toBe('half_open')

    const success = vi.fn().mockResolvedValue('ok')
    const result = await cb.execute(success)
    expect(result).toBe('ok')
    expect(cb.state).toBe('closed')
    expect(cb.stats.failures).toBe(0)

    vi.useRealTimers()
  })

  it('HALF_OPEN 时试探失败 → 回到 OPEN，重置计时', async () => {
    vi.useFakeTimers()
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 })
    const fail = vi.fn().mockRejectedValue(new Error('失败'))
    for (let i = 0; i < 2; i++) {
      await expect(cb.execute(fail)).rejects.toThrow()
    }
    vi.advanceTimersByTime(1000)
    expect(cb.state).toBe('half_open')

    // 试探再次失败
    await expect(cb.execute(fail)).rejects.toThrow()
    expect(cb.state).toBe('open')
    // 计时重置，需要再等 1s
    vi.advanceTimersByTime(999)
    expect(cb.state).toBe('open')
    vi.advanceTimersByTime(1)
    expect(cb.state).toBe('half_open')

    vi.useRealTimers()
  })

  it('成功调用重置失败计数（不累积历史失败）', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 })
    const fail = vi.fn().mockRejectedValue(new Error('失败'))
    const ok = vi.fn().mockResolvedValue('ok')

    await expect(cb.execute(fail)).rejects.toThrow()
    await expect(cb.execute(fail)).rejects.toThrow()
    expect(cb.stats.failures).toBe(2)
    await cb.execute(ok)
    expect(cb.stats.failures).toBe(0)
  })

  it('manualReset 手动重置为 CLOSED', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 })
    const fail = vi.fn().mockRejectedValue(new Error('失败'))
    for (let i = 0; i < 2; i++) {
      await expect(cb.execute(fail)).rejects.toThrow()
    }
    expect(cb.state).toBe('open')
    cb.manualReset()
    expect(cb.state).toBe('closed')
    expect(cb.stats.failures).toBe(0)
  })

  it('stats 返回当前失败/成功/拒绝次数', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 })
    const fail = vi.fn().mockRejectedValue(new Error('失败'))
    const ok = vi.fn().mockResolvedValue('ok')

    await cb.execute(ok)
    await expect(cb.execute(fail)).rejects.toThrow()
    await expect(cb.execute(fail)).rejects.toThrow()
    // 第 3 次应被拒绝
    await expect(cb.execute(fail)).rejects.toThrow(/熔断器开路/i)

    expect(cb.stats).toEqual({
      successes: 1,
      failures: 2,
      rejections: 1,
      state: 'open',
    })
  })

  it('从 runtimePerformance 读取默认配置（与配置模块联动）', () => {
    const cb = new CircuitBreaker()
    expect(cb.options.failureThreshold).toBe(5)
    expect(cb.options.resetTimeoutMs).toBe(120_000)
  })
})
