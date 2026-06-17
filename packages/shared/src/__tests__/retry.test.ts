import { describe, expect, it, vi } from 'vitest'
import { retryWithJitter } from '../utils/retry.js'

describe('retryWithJitter', () => {
  it('首次成功直接返回', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await retryWithJitter(fn, { maxRetries: 3, baseDelayMs: 10 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('重试后成功', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce('ok')
    const result = await retryWithJitter(fn, { maxRetries: 3, baseDelayMs: 10 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('超过最大重试次数后抛出', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fail'))
    await expect(retryWithJitter(fn, { maxRetries: 2, baseDelayMs: 10 })).rejects.toThrow(
      'always fail'
    )
    expect(fn).toHaveBeenCalledTimes(3) // 1 + 2 次重试
  })
})
