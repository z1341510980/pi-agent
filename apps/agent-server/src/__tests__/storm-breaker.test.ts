import { describe, expect, it } from 'vitest'
import { StormBreaker } from '../core/tool/storm-breaker.js'

describe('StormBreaker', () => {
  it('正常调用不中断（不同工具交替）', () => {
    const breaker = new StormBreaker({ maxConsecutiveCalls: 3 })
    expect(breaker.recordAndCheck('read', { path: '/a' })).toBe(false)
    expect(breaker.recordAndCheck('write', { path: '/b' })).toBe(false)
    expect(breaker.recordAndCheck('read', { path: '/c' })).toBe(false)
  })

  it('连续相同调用触发中断', () => {
    const breaker = new StormBreaker({ maxConsecutiveCalls: 3, similarityThreshold: 0.8 })
    // 前两次不触发
    expect(breaker.recordAndCheck('bash', { command: 'ls' })).toBe(false)
    expect(breaker.recordAndCheck('bash', { command: 'ls' })).toBe(false)
    // 第三次相同调用触发
    expect(breaker.recordAndCheck('bash', { command: 'ls' })).toBe(true)
  })

  it('不同工具不累计', () => {
    const breaker = new StormBreaker({ maxConsecutiveCalls: 3 })
    expect(breaker.recordAndCheck('read', { path: '/a' })).toBe(false)
    expect(breaker.recordAndCheck('write', { path: '/a' })).toBe(false)
    expect(breaker.recordAndCheck('read', { path: '/a' })).toBe(false)
    // 即使 read 调用了 2 次，但中间穿插了 write，不连续，不触发
    expect(breaker.recordAndCheck('read', { path: '/a' })).toBe(false)
  })

  it('参数相似度低于阈值不触发', () => {
    const breaker = new StormBreaker({ maxConsecutiveCalls: 2, similarityThreshold: 0.9 })
    expect(breaker.recordAndCheck('bash', { command: 'ls -la /tmp' })).toBe(false)
    // 参数完全不同，相似度低，不触发
    expect(
      breaker.recordAndCheck('bash', { command: 'rm -rf /etc/nginx/conf.d/default.conf' })
    ).toBe(false)
  })

  it('reset 清除记录', () => {
    const breaker = new StormBreaker({ maxConsecutiveCalls: 2 })
    expect(breaker.recordAndCheck('bash', { command: 'ls' })).toBe(false)
    // 第二次会触发
    expect(breaker.recordAndCheck('bash', { command: 'ls' })).toBe(true)

    breaker.reset('thread-1')

    // reset 后重新开始，第一次不触发
    expect(breaker.recordAndCheck('bash', { command: 'ls' })).toBe(false)
  })

  it('getStats 返回当前统计', () => {
    const breaker = new StormBreaker()
    expect(breaker.getStats('thread-1')).toBeNull()

    breaker.recordAndCheck('read', { path: '/a' })
    breaker.recordAndCheck('read', { path: '/a' })

    const stats = breaker.getStats('thread-1')
    expect(stats).not.toBeNull()
    expect(stats?.toolName).toBe('read')
    expect(stats?.count).toBe(2)
    expect(stats?.lastArgs).toEqual({ path: '/a' })
  })

  it('滑动窗口淘汰旧记录', () => {
    const breaker = new StormBreaker({ maxConsecutiveCalls: 3, windowSize: 3 })
    // 填满窗口
    breaker.recordAndCheck('read', { path: '/a' })
    breaker.recordAndCheck('read', { path: '/a' })
    breaker.recordAndCheck('read', { path: '/a' })
    // 窗口已满，第一条被淘汰，现在窗口里只有 2 条 read
    // 切换工具再切回，连续计数应从 1 开始
    breaker.recordAndCheck('write', { path: '/b' })
    expect(breaker.recordAndCheck('read', { path: '/a' })).toBe(false)
  })

  it('使用默认配置', () => {
    const breaker = new StormBreaker()
    // 默认 maxConsecutiveCalls=10，调用 9 次不触发
    for (let i = 0; i < 9; i++) {
      expect(breaker.recordAndCheck('bash', { command: 'ls' })).toBe(false)
    }
    // 第 10 次触发
    expect(breaker.recordAndCheck('bash', { command: 'ls' })).toBe(true)
  })
})
