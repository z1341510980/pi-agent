export interface RetryOptions {
  /** 最大重试次数（默认 3） */
  maxRetries?: number
  /** 基础延迟毫秒数（默认 1000） */
  baseDelayMs?: number
  /** 最大延迟毫秒数（默认 30000） */
  maxDelayMs?: number
}

/**
 * Decorrelated Jitter 重试策略
 * 参考 AWS 架构博客：https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 */
export async function retryWithJitter<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3
  const baseDelayMs = options.baseDelayMs ?? 1000
  const maxDelayMs = options.maxDelayMs ?? 30000

  let lastDelay = baseDelayMs

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= maxRetries) {
        throw error
      }
      // Decorrelated Jitter: delay = min(cap, base + rand(0, delay * 3))
      const jitter = Math.random() * lastDelay * 3
      lastDelay = Math.min(maxDelayMs, baseDelayMs + jitter)
      await sleep(lastDelay)
    }
  }

  // 不可达，但 TypeScript 需要
  throw new Error('retryWithJitter: 不应到达此处')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
