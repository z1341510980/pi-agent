/**
 * MemoryTicker：记忆编译触发器
 *
 * 根据对话轮数和空闲时间决定是否触发记忆编译。
 * - 每 N 轮对话触发一次编译
 * - 启动时检查是否需要编译
 * - 空闲超时后检查是否需要编译
 */

export interface MemoryTickerConfig {
  /** 每 N 轮对话触发编译，默认 10 */
  turnsPerCompile: number
  /** 启动时检查是否需要编译，默认 true */
  startupCompile: boolean
  /** 空闲超时（毫秒），默认 300000（5 分钟） */
  maxIdleMs: number
}

const DEFAULT_CONFIG: MemoryTickerConfig = {
  turnsPerCompile: 10,
  startupCompile: true,
  maxIdleMs: 300000,
}

export class MemoryTicker {
  private readonly config: MemoryTickerConfig
  private turnCount = 0
  private _lastCompileAt: number | null = null

  constructor(config?: Partial<MemoryTickerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** 记录一轮对话，返回是否应触发编译 */
  recordTurn(): boolean {
    this.turnCount++
    if (this.turnCount >= this.config.turnsPerCompile) {
      return true
    }
    return false
  }

  /** 检查是否需要编译（启动时/空闲后） */
  shouldCompile(lastCompileAt: number | null): boolean {
    if (lastCompileAt === null) {
      return this.config.startupCompile
    }
    return Date.now() - lastCompileAt >= this.config.maxIdleMs
  }

  /** 标记编译完成 */
  markCompiled(): void {
    this._lastCompileAt = Date.now()
    this.turnCount = 0
  }

  /** 重置计数 */
  reset(): void {
    this.turnCount = 0
    this._lastCompileAt = null
  }

  /** 获取当前状态 */
  getStats(): { turnCount: number; lastCompileAt: number | null; nextCompileAt: number } {
    return {
      turnCount: this.turnCount,
      lastCompileAt: this._lastCompileAt,
      nextCompileAt: this.config.turnsPerCompile,
    }
  }
}
