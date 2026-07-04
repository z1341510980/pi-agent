/**
 * 三态熔断器（借鉴 PlotPilot CircuitBreaker）
 *
 * 状态机：
 *   CLOSED → 失败累计达阈值 → OPEN
 *   OPEN → reset_timeout → HALF_OPEN
 *   HALF_OPEN → 试探成功 → CLOSED（重置计数）
 *   HALF_OPEN → 试探失败 → OPEN（重置计时）
 *
 * CLOSED：正常放行所有请求，记录成功/失败
 * OPEN：拒绝所有请求（直接抛错，不实际调用 fn）
 * HALF_OPEN：仅允许一次试探调用，结果决定回到 CLOSED 还是 OPEN
 *
 * 默认配置从 runtimePerformance 读取，支持运行时通过 env 调整。
 */

import { runtimePerformance } from '../../config/performance.js'

export type CircuitBreakerState = 'closed' | 'open' | 'half_open'

export interface CircuitBreakerOptions {
  /** 失败多少次后开路（默认从 runtimePerformance 读取） */
  failureThreshold?: number
  /** 开路后多久尝试半开（毫秒，默认从 runtimePerformance 读取） */
  resetTimeoutMs?: number
  /** 判定异常是否算失败（默认所有 rejected 都算） */
  shouldTrip?: (err: unknown) => boolean
}

export interface CircuitBreakerStats {
  successes: number
  failures: number
  rejections: number
  state: CircuitBreakerState
}

export class CircuitBreaker {
  readonly options: Required<Omit<CircuitBreakerOptions, 'shouldTrip'>>
  private _state: CircuitBreakerState = 'closed'
  private failureCount = 0
  private successCount = 0
  private rejectionCount = 0
  private lastFailureAt = 0
  private readonly shouldTrip: (err: unknown) => boolean

  constructor(options: CircuitBreakerOptions = {}) {
    this.options = {
      failureThreshold:
        options.failureThreshold ?? runtimePerformance.llm.circuitBreaker.failureThreshold,
      resetTimeoutMs:
        options.resetTimeoutMs ?? runtimePerformance.llm.circuitBreaker.resetTimeoutMs,
    }
    this.shouldTrip = options.shouldTrip ?? (() => true)
  }

  get state(): CircuitBreakerState {
    this.maybeTransitionToHalfOpen()
    return this._state
  }

  get stats(): CircuitBreakerStats {
    return {
      successes: this.successCount,
      failures: this.failureCount,
      rejections: this.rejectionCount,
      state: this.state,
    }
  }

  /** 当前是否允许调用 fn（CLOSED 或 HALF_OPEN 时为 true） */
  canExecute(): boolean {
    return this.state !== 'open'
  }

  /**
   * 执行 fn，根据结果更新状态
   * - CLOSED：执行 fn，成功重置失败计数，失败累计
   * - OPEN：直接 reject（不调用 fn），rejectionCount++
   * - HALF_OPEN：执行 fn，成功 → CLOSED，失败 → OPEN
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      this.rejectionCount++
      throw new Error('熔断器开路：拒绝调用（circuit breaker is open）')
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (err) {
      if (this.shouldTrip(err)) {
        this.onFailure()
      }
      throw err
    }
  }

  private onSuccess(): void {
    this.successCount++
    if (this._state === 'half_open') {
      // 试探成功 → CLOSED，重置计数
      this._state = 'closed'
      this.failureCount = 0
    } else if (this._state === 'closed') {
      // CLOSED 状态下成功重置失败计数（不累积历史失败）
      this.failureCount = 0
    }
  }

  private onFailure(): void {
    this.lastFailureAt = Date.now()
    this.failureCount++
    if (this._state === 'half_open') {
      // 试探失败 → 回到 OPEN
      this._state = 'open'
    } else if (this._state === 'closed' && this.failureCount >= this.options.failureThreshold) {
      this._state = 'open'
    }
  }

  /** 检查是否到了从 OPEN 转 HALF_OPEN 的时间 */
  private maybeTransitionToHalfOpen(): void {
    if (this._state !== 'open') return
    const elapsed = Date.now() - this.lastFailureAt
    if (elapsed >= this.options.resetTimeoutMs) {
      this._state = 'half_open'
    }
  }

  /** 手动重置为 CLOSED（管理员/调试用） */
  manualReset(): void {
    this._state = 'closed'
    this.failureCount = 0
    this.lastFailureAt = 0
  }
}
