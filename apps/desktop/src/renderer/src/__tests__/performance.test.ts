import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { runtimePerformance, reloadPerformanceFromEnv } from '../config/performance'

describe('runtimePerformance 前端配置', () => {
  beforeEach(() => {
    reloadPerformanceFromEnv()
  })

  afterEach(() => {
    reloadPerformanceFromEnv()
  })

  it('默认 matrix onScroll 节流 16ms（60fps）', () => {
    expect(runtimePerformance.matrix.scrollThrottleMs).toBe(16)
  })

  it('默认 SSE rAF batch 开启', () => {
    expect(runtimePerformance.sse.useRafBatching).toBe(true)
  })

  it('默认 debounce 500ms', () => {
    expect(runtimePerformance.editor.debounceMs).toBe(500)
  })

  it('默认 undo 历史栈上限 200', () => {
    expect(runtimePerformance.undo.historyLimit).toBe(200)
  })

  it('env VITE_MATRIX_SCROLL_THROTTLE_MS 可覆盖', () => {
    vi.stubEnv('VITE_MATRIX_SCROLL_THROTTLE_MS', '32')
    reloadPerformanceFromEnv()
    expect(runtimePerformance.matrix.scrollThrottleMs).toBe(32)
    vi.unstubAllEnvs()
  })

  it('env 非法值回退默认', () => {
    vi.stubEnv('VITE_MATRIX_SCROLL_THROTTLE_MS', 'abc')
    reloadPerformanceFromEnv()
    expect(runtimePerformance.matrix.scrollThrottleMs).toBe(16)
    vi.unstubAllEnvs()
  })

  it('默认 matrix overscan 3 列', () => {
    expect(runtimePerformance.matrix.overscanColumns).toBe(3)
  })

  it('默认 SSE rAF flush 字符上限 256', () => {
    expect(runtimePerformance.sse.rafFlushCharLimit).toBe(256)
  })

  it('config 对象只读', () => {
    expect(() => {
      // @ts-expect-error 测试只读
      runtimePerformance.matrix.scrollThrottleMs = 100
    }).toThrow()
  })

  it('reload 后各字段反映新 env', () => {
    vi.stubEnv('VITE_UNDO_HISTORY_LIMIT', '500')
    reloadPerformanceFromEnv()
    expect(runtimePerformance.undo.historyLimit).toBe(500)
    vi.unstubAllEnvs()
  })
})
