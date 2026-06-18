/**
 * Storm Breaker：工具调用死循环防护
 *
 * 检测并中断工具调用死循环（同一工具+相似参数连续调用 N 次）。
 *
 * 算法：
 * - 滑动窗口记录最近 N 次工具调用
 * - 如果同一工具名连续调用次数 >= maxConsecutiveCalls，且参数相似度 >= similarityThreshold，则触发中断
 * - 参数相似度：JSON.stringify 后的 Jaccard 相似度（基于 token 集合）
 */

export interface StormBreakerConfig {
  /** 最大连续调用次数，默认 10 */
  maxConsecutiveCalls: number
  /** 参数相似度阈值，默认 0.8 */
  similarityThreshold: number
  /** 滑动窗口大小，默认 20 */
  windowSize: number
}

const DEFAULT_CONFIG: StormBreakerConfig = {
  maxConsecutiveCalls: 10,
  similarityThreshold: 0.8,
  windowSize: 20
}

interface CallRecord {
  toolName: string
  args: Record<string, unknown>
  argsJson: string
}

export interface StormBreakerStats {
  toolName: string
  count: number
  lastArgs: unknown
}

/**
 * StormBreaker：每个 PiSession 实例持有一个，跟踪单线程的工具调用。
 *
 * reset(threadId) 和 getStats(threadId) 接受 threadId 参数用于 API 一致性，
 * 由于实例本身是 per-session 的，threadId 仅用于日志/标识，不影响行为。
 */
export class StormBreaker {
  private readonly config: StormBreakerConfig
  private readonly window: CallRecord[] = []

  constructor(config?: Partial<StormBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 记录工具调用，返回是否应中断
   *
   * 算法：从窗口末尾向前遍历，统计连续同名且参数相似度达标的调用次数。
   * 一旦遇到不同工具名或相似度不足的记录，立即停止计数。
   */
  recordAndCheck(toolName: string, args: Record<string, unknown>): boolean {
    const argsJson = JSON.stringify(args)
    const record: CallRecord = { toolName, args, argsJson }
    this.window.push(record)

    // 维护滑动窗口大小
    if (this.window.length > this.config.windowSize) {
      this.window.shift()
    }

    // 从最新记录向前统计连续相似调用
    let consecutiveCount = 1 // 当前调用计入
    for (let i = this.window.length - 2; i >= 0; i--) {
      const entry = this.window[i]
      if (entry.toolName !== toolName) break

      const similarity = jaccardSimilarity(argsJson, entry.argsJson)
      if (similarity >= this.config.similarityThreshold) {
        consecutiveCount++
      } else {
        break
      }
    }

    return consecutiveCount >= this.config.maxConsecutiveCalls
  }

  /**
   * 重置记录
   * threadId 参数用于标识，由于实例 per-session，直接清空窗口即可。
   */
  reset(threadId: string): void {
    void threadId // per-session 实例，threadId 仅用于日志标识
    this.window.length = 0
  }

  /**
   * 获取当前统计
   * 返回最近一次调用的工具名、连续调用次数、最后参数。
   */
  getStats(threadId: string): StormBreakerStats | null {
    void threadId // per-session 实例，threadId 仅用于日志标识
    if (this.window.length === 0) return null

    const last = this.window[this.window.length - 1]
    // 统计当前工具的连续调用次数
    let count = 0
    for (let i = this.window.length - 1; i >= 0; i--) {
      if (this.window[i].toolName !== last.toolName) break
      count++
    }

    return {
      toolName: last.toolName,
      count,
      lastArgs: last.args
    }
  }
}

/**
 * 计算 Jaccard 相似度（基于 token 集合）
 *
 * 将 JSON 字符串按非字母数字字符分词，计算两个 token 集合的交集/并集比。
 */
function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a)
  const setB = tokenize(b)

  if (setA.size === 0 && setB.size === 0) return 1.0

  let intersection = 0
  for (const token of setA) {
    if (setB.has(token)) intersection++
  }

  const union = setA.size + setB.size - intersection
  if (union === 0) return 1.0

  return intersection / union
}

/** 将字符串分词为 token 集合（小写化） */
function tokenize(s: string): Set<string> {
  const tokens = s
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((t) => t.length > 0)
  return new Set(tokens)
}
