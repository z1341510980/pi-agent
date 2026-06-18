import { describe, expect, it } from 'vitest'
import { MemoryTicker } from '../core/memory/memory-ticker.js'

describe('MemoryTicker', () => {
  it('默认配置下 recordTurn 返回 false 直到达到阈值', () => {
    const ticker = new MemoryTicker({ turnsPerCompile: 3 })
    expect(ticker.recordTurn()).toBe(false)
    expect(ticker.recordTurn()).toBe(false)
    expect(ticker.recordTurn()).toBe(true)
  })

  it('markCompiled 后计数重置', () => {
    const ticker = new MemoryTicker({ turnsPerCompile: 2 })
    expect(ticker.recordTurn()).toBe(false)
    expect(ticker.recordTurn()).toBe(true)
    ticker.markCompiled()
    // 重新计数
    expect(ticker.recordTurn()).toBe(false)
    expect(ticker.recordTurn()).toBe(true)
  })

  it('shouldCompile 在空闲超时后返回 true', () => {
    const ticker = new MemoryTicker({ maxIdleMs: 1000 })
    const now = Date.now()
    // 1 秒前编译过，已超时
    expect(ticker.shouldCompile(now - 2000)).toBe(true)
  })

  it('shouldCompile 在未超时时返回 false', () => {
    const ticker = new MemoryTicker({ maxIdleMs: 300000 })
    const now = Date.now()
    // 刚编译过，未超时
    expect(ticker.shouldCompile(now - 1000)).toBe(false)
  })

  it('shouldCompile 在 lastCompileAt 为 null 时返回 true（启动时检查）', () => {
    const ticker = new MemoryTicker({ startupCompile: true })
    expect(ticker.shouldCompile(null)).toBe(true)
  })

  it('startupCompile 为 false 时不触发启动编译', () => {
    const ticker = new MemoryTicker({ startupCompile: false })
    expect(ticker.shouldCompile(null)).toBe(false)
  })

  it('reset 清除所有状态', () => {
    const ticker = new MemoryTicker({ turnsPerCompile: 2 })
    ticker.recordTurn()
    ticker.recordTurn()
    ticker.markCompiled()
    ticker.reset()
    const stats = ticker.getStats()
    expect(stats.turnCount).toBe(0)
    expect(stats.lastCompileAt).toBeNull()
  })

  it('getStats 返回正确状态', () => {
    const ticker = new MemoryTicker({ turnsPerCompile: 5 })
    ticker.recordTurn()
    ticker.recordTurn()
    const stats = ticker.getStats()
    expect(stats.turnCount).toBe(2)
    expect(stats.lastCompileAt).toBeNull()
    expect(stats.nextCompileAt).toBe(5)
  })

  it('getStats 在 markCompiled 后更新 lastCompileAt', () => {
    const ticker = new MemoryTicker({ turnsPerCompile: 2 })
    ticker.recordTurn()
    ticker.recordTurn()
    ticker.markCompiled()
    const stats = ticker.getStats()
    expect(stats.lastCompileAt).not.toBeNull()
    expect(stats.turnCount).toBe(0)
  })
})
