import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { runtimePerformance, reloadPerformanceFromEnv } from '../config/performance'

describe('runtimePerformance 前端配置', () => {
  beforeEach(() => {
    // 清理可能残留的 stub env，再 reload 默认配置
    vi.unstubAllEnvs()
    reloadPerformanceFromEnv()
  })

  afterEach(() => {
    // 确保每个测试后清理 stub，避免污染后续测试
    vi.unstubAllEnvs()
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

  // ── env 覆盖测试 ──

  it('env VITE_MATRIX_SCROLL_THROTTLE_MS 可覆盖', () => {
    vi.stubEnv('VITE_MATRIX_SCROLL_THROTTLE_MS', '32')
    reloadPerformanceFromEnv()
    expect(runtimePerformance.matrix.scrollThrottleMs).toBe(32)
  })

  it('env VITE_MATRIX_OVERSCAN_COLUMNS 可覆盖', () => {
    vi.stubEnv('VITE_MATRIX_OVERSCAN_COLUMNS', '5')
    reloadPerformanceFromEnv()
    expect(runtimePerformance.matrix.overscanColumns).toBe(5)
  })

  it('env VITE_SSE_RAF_FLUSH_CHAR_LIMIT 可覆盖', () => {
    vi.stubEnv('VITE_SSE_RAF_FLUSH_CHAR_LIMIT', '512')
    reloadPerformanceFromEnv()
    expect(runtimePerformance.sse.rafFlushCharLimit).toBe(512)
  })

  it('env VITE_EDITOR_DEBOUNCE_MS 可覆盖', () => {
    vi.stubEnv('VITE_EDITOR_DEBOUNCE_MS', '1000')
    reloadPerformanceFromEnv()
    expect(runtimePerformance.editor.debounceMs).toBe(1000)
  })

  it('env VITE_UNDO_HISTORY_LIMIT 可覆盖', () => {
    vi.stubEnv('VITE_UNDO_HISTORY_LIMIT', '500')
    reloadPerformanceFromEnv()
    expect(runtimePerformance.undo.historyLimit).toBe(500)
  })

  // ── readEnvBool 覆盖测试 ──

  it('env VITE_SSE_USE_RAF_BATCHING=true 启用 rAF 批处理', () => {
    vi.stubEnv('VITE_SSE_USE_RAF_BATCHING', 'true')
    reloadPerformanceFromEnv()
    expect(runtimePerformance.sse.useRafBatching).toBe(true)
  })

  it('env VITE_SSE_USE_RAF_BATCHING=1 启用 rAF 批处理', () => {
    vi.stubEnv('VITE_SSE_USE_RAF_BATCHING', '1')
    reloadPerformanceFromEnv()
    expect(runtimePerformance.sse.useRafBatching).toBe(true)
  })

  it('env VITE_SSE_USE_RAF_BATCHING=false 禁用 rAF 批处理', () => {
    vi.stubEnv('VITE_SSE_USE_RAF_BATCHING', 'false')
    reloadPerformanceFromEnv()
    expect(runtimePerformance.sse.useRafBatching).toBe(false)
  })

  it('env VITE_SSE_USE_RAF_BATCHING=0 禁用 rAF 批处理', () => {
    vi.stubEnv('VITE_SSE_USE_RAF_BATCHING', '0')
    reloadPerformanceFromEnv()
    expect(runtimePerformance.sse.useRafBatching).toBe(false)
  })

  // ── 非法值回退 ──

  it('env 非法值回退默认', () => {
    vi.stubEnv('VITE_MATRIX_SCROLL_THROTTLE_MS', 'abc')
    reloadPerformanceFromEnv()
    expect(runtimePerformance.matrix.scrollThrottleMs).toBe(16)
  })

  it('env VITE_SSE_USE_RAF_BATCHING 非法值回退默认 true', () => {
    vi.stubEnv('VITE_SSE_USE_RAF_BATCHING', 'yes')
    reloadPerformanceFromEnv()
    expect(runtimePerformance.sse.useRafBatching).toBe(true)
  })

  // ── reload ──

  it('reload 后各字段反映新 env', () => {
    vi.stubEnv('VITE_UNDO_HISTORY_LIMIT', '500')
    reloadPerformanceFromEnv()
    expect(runtimePerformance.undo.historyLimit).toBe(500)
  })
})
