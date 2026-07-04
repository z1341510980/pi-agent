import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runtimePerformance, reloadPerformanceFromEnv } from '../config/performance.js'

describe('runtimePerformance 后端配置', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    // 清除可能的环境变量
    delete process.env.PI_LLM_TIMEOUT_MS
    delete process.env.PI_LLM_CIRCUIT_FAILURE_THRESHOLD
    delete process.env.PI_LLM_CIRCUIT_RESET_TIMEOUT_MS
    delete process.env.PI_SSE_THROTTLE_MS
    delete process.env.PI_SSE_MAX_QUEUE_SIZE
    delete process.env.PI_SQLITE_WRITE_RETRY_COUNT
    delete process.env.PI_SQLITE_WRITE_BACKOFF_MS
    reloadPerformanceFromEnv()
  })

  afterEach(() => {
    // 恢复环境变量
    for (const [k, v] of Object.entries(originalEnv)) process.env[k] = v
    reloadPerformanceFromEnv()
  })

  it('默认 LLM 超时 300s', () => {
    expect(runtimePerformance.llm.timeoutMs).toBe(300_000)
  })

  it('env PI_LLM_TIMEOUT_MS 可覆盖', () => {
    process.env.PI_LLM_TIMEOUT_MS = '600000'
    reloadPerformanceFromEnv()
    expect(runtimePerformance.llm.timeoutMs).toBe(600_000)
  })

  it('env 非法值回退到默认', () => {
    process.env.PI_LLM_TIMEOUT_MS = 'not-a-number'
    reloadPerformanceFromEnv()
    expect(runtimePerformance.llm.timeoutMs).toBe(300_000)
  })

  it('默认熔断阈值 5 次', () => {
    expect(runtimePerformance.llm.circuitBreaker.failureThreshold).toBe(5)
  })

  it('env PI_LLM_CIRCUIT_FAILURE_THRESHOLD 可覆盖', () => {
    process.env.PI_LLM_CIRCUIT_FAILURE_THRESHOLD = '10'
    reloadPerformanceFromEnv()
    expect(runtimePerformance.llm.circuitBreaker.failureThreshold).toBe(10)
  })

  it('默认熔断重置超时 120s', () => {
    expect(runtimePerformance.llm.circuitBreaker.resetTimeoutMs).toBe(120_000)
  })

  it('默认 SSE 节流 100ms', () => {
    expect(runtimePerformance.sse.throttleMs).toBe(100)
  })

  it('默认 SSE 队列上限 50', () => {
    expect(runtimePerformance.sse.maxQueueSize).toBe(50)
  })

  it('默认 SQLite 写入重试次数 3', () => {
    expect(runtimePerformance.persistence.writeRetryCount).toBe(3)
  })

  it('默认 SQLite 写入退避基数 50ms', () => {
    expect(runtimePerformance.persistence.writeRetryBackoffMs).toBe(50)
  })

  it('config 对象只读（运行时不允许直接赋值）', () => {
    expect(() => {
      // @ts-expect-error 测试只读
      runtimePerformance.llm.timeoutMs = 1000
    }).toThrow()
  })

  it('reload 后各字段反映新 env', () => {
    process.env.PI_SSE_THROTTLE_MS = '50'
    process.env.PI_SSE_MAX_QUEUE_SIZE = '100'
    reloadPerformanceFromEnv()
    expect(runtimePerformance.sse.throttleMs).toBe(50)
    expect(runtimePerformance.sse.maxQueueSize).toBe(100)
  })
})
