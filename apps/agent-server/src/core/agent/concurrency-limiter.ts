/**
 * ConcurrencyLimiter：多 Agent 协作并发限流器
 *
 * 参考 ARCHITECTURE.md §9.5，为 subagent 派遣提供硬性 backstop 限制：
 * - maxConcurrent：同时运行的 subagent 上限
 * - maxDepth：subagent 嵌套深度上限（防止无限递归）
 * - maxTotal：单次主任务的总 subagent 上限
 *
 * acquire 在超过并发数时会排队等待（支持超时），
 * 超过深度或总数上限时立即抛错。
 */

import { AppError, ErrorCode } from '@repo/shared/errors'

/** 并发限制配置 */
export interface ConcurrencyLimits {
  /** 同时运行的 subagent 上限（默认 5） */
  maxConcurrent: number
  /** subagent 嵌套深度上限（默认 3） */
  maxDepth: number
  /** 单次主任务的总 subagent 上限（默认 20） */
  maxTotal: number
}

/** acquire 选项 */
export interface AcquireOptions {
  /** 等待获取槽位的超时毫秒数（默认 0，即不等待直接超时） */
  timeoutMs?: number
}

/** 释放函数：调用后归还一个并发槽位 */
export type ReleaseFunction = () => void

/** 默认限制配置 */
export const DEFAULT_LIMITS: ConcurrencyLimits = {
  maxConcurrent: 5,
  maxDepth: 3,
  maxTotal: 20,
}

/**
 * 并发限流器
 *
 * 关键不变量：
 * 1. activeCount 永远 <= maxConcurrent
 * 2. totalCount 单调递增，直到 reset 调用
 * 3. release 幂等：多次调用同一 ReleaseFunction 只生效一次
 * 4. 队列按 FIFO 顺序唤醒
 */
export class ConcurrencyLimiter {
  private activeCount = 0
  private totalCount = 0
  private readonly queue: Array<{
    resolve: () => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout> | null
  }> = []

  constructor(private readonly limits: ConcurrencyLimits = DEFAULT_LIMITS) {}

  /**
   * 获取一个并发槽位
   *
   * @param depth 当前 subagent 嵌套深度（主 Agent 调用时传 0）
   * @param options 超时等选项
   * @returns 释放函数，调用后归还槽位
   * @throws AppError 深度或总数超限
   * @throws Error 超时等待
   */
  async acquire(depth: number, options: AcquireOptions = {}): Promise<ReleaseFunction> {
    // 深度检查：立即拒绝，防止无限递归
    if (depth > this.limits.maxDepth) {
      throw new AppError(
        ErrorCode.INTERNAL_SERVER_ERROR,
        `subagent 嵌套深度 ${depth} 超过上限 ${this.limits.maxDepth}`,
        429,
      )
    }

    // 总数检查：立即拒绝，防止资源耗尽
    if (this.totalCount >= this.limits.maxTotal) {
      throw new AppError(
        ErrorCode.INTERNAL_SERVER_ERROR,
        `subagent 总数 ${this.totalCount} 已达上限 ${this.limits.maxTotal}`,
        429,
      )
    }

    // 并发数检查：超过上限时排队等待
    if (this.activeCount >= this.limits.maxConcurrent) {
      const timeoutMs = options.timeoutMs ?? 0
      if (timeoutMs <= 0) {
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          `并发 subagent 数 ${this.activeCount} 已达上限 ${this.limits.maxConcurrent}，且未设置等待超时`,
          429,
        )
      }

      await new Promise<void>((resolve, reject) => {
        const entry: {
          resolve: () => void
          reject: (error: Error) => void
          timer: ReturnType<typeof setTimeout> | null
        } = {
          resolve,
          reject,
          timer: null,
        }
        entry.timer = setTimeout(() => {
          // 超时：从队列中移除并拒绝
          const idx = this.queue.indexOf(entry)
          if (idx >= 0) {
            this.queue.splice(idx, 1)
          }
          reject(
            new AppError(
              ErrorCode.INTERNAL_SERVER_ERROR,
              `等待并发槽位超时（${timeoutMs}ms）`,
              429,
            ),
          )
        }, timeoutMs)
        this.queue.push(entry)
      })
    }

    // 成功获取槽位
    this.activeCount++
    this.totalCount++

    let released = false
    return () => {
      if (released) return
      released = true
      this.activeCount--

      // 唤醒队列中下一个等待者
      const next = this.queue.shift()
      if (next) {
        if (next.timer) {
          clearTimeout(next.timer)
        }
        next.resolve()
      }
    }
  }

  /** 当前活跃 subagent 数 */
  getActiveCount(): number {
    return this.activeCount
  }

  /** 累计 subagent 数 */
  getTotalCount(): number {
    return this.totalCount
  }

  /** 当前排队等待数 */
  getQueueLength(): number {
    return this.queue.length
  }

  /** 重置计数器（用于新一轮主任务开始时） */
  reset(): void {
    this.activeCount = 0
    this.totalCount = 0
    // 拒绝所有排队等待者
    for (const entry of this.queue) {
      if (entry.timer) {
        clearTimeout(entry.timer)
      }
      entry.reject(
        new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          '限流器已重置，等待已取消',
          429,
        ),
      )
    }
    this.queue.length = 0
  }
}
