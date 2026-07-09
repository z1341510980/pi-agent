// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WenlangAgentSession = any
type PiSessionFactory = (threadId: string) => Promise<WenlangAgentSession>

export interface PiThreadSession {
  threadId: string
  session: WenlangAgentSession
  createdAt: number
  lastAccessedAt: number
  lastRunId?: string
  pendingToolCalls: Map<string, unknown>
  /** 当前活跃 run 的 runId（用于互斥控制）；undefined 表示无活跃 run */
  activeRunId?: string
}

export interface PiSessionStoreStats {
  threadCount: number
  pendingToolCalls: number
  activeRuns: number
  evictedCount: number
}

export interface PiSessionStoreOptions {
  /** 最大缓存会话数，超过后按 LRU 淘汰（默认 50） */
  maxSessions?: number
  /** 空闲会话超时毫秒数，超过后可被淘汰（默认 30 分钟） */
  idleTimeoutMs?: number
  /** 淘汰检查间隔毫秒数（默认 5 分钟） */
  sweepIntervalMs?: number
}

const DEFAULT_MAX_SESSIONS = 50
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000

/**
 * PiSessionStore：活跃会话管理
 *
 * 关键不变量：
 * 1. getOrCreate 对同一 threadId 并发调用只创建一个 session（通过 pendingPromises Map）
 * 2. tryAcquireRun/releaseRun 提供同线程 run 互斥
 * 3. LRU 淘汰不会清除活跃 run 的会话
 */
export class PiSessionStore {
  private readonly sessions = new Map<string, PiThreadSession>()
  /** 进行中的 session 创建 Promise，防止并发重复创建 */
  private readonly pendingPromises = new Map<string, Promise<PiThreadSession>>()
  private sessionFactory?: PiSessionFactory
  private readonly maxSessions: number
  private readonly idleTimeoutMs: number
  private readonly sweepIntervalMs: number
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private evictedCount = 0

  constructor(options: PiSessionStoreOptions = {}) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
    this.startSweepTimer()
  }

  setSessionFactory(factory: PiSessionFactory): void {
    this.sessionFactory = factory
  }

  async getOrCreate(threadId: string): Promise<PiThreadSession> {
    const existing = this.sessions.get(threadId)
    if (existing) {
      // 如果是占位条目（session 为 null），需要填充真实 session
      if (existing.session === null) {
        // 检查是否有进行中的创建 Promise
        const pending = this.pendingPromises.get(threadId)
        if (pending) {
          return pending
        }

        if (!this.sessionFactory) {
          throw new Error('SessionFactory 未设置，请先调用 setSessionFactory')
        }

        const promise = (async () => {
          try {
            const factory = this.sessionFactory
            if (!factory) {
              throw new Error('SessionFactory 未设置，请先调用 setSessionFactory')
            }
            const session = await factory(threadId)
            existing.session = session
            existing.lastAccessedAt = Date.now()
            return existing
          } finally {
            this.pendingPromises.delete(threadId)
          }
        })()

        this.pendingPromises.set(threadId, promise)
        return promise
      }

      existing.lastAccessedAt = Date.now()
      return existing
    }

    // 检查是否有进行中的创建 Promise，复用以避免竞态
    const pending = this.pendingPromises.get(threadId)
    if (pending) {
      return pending
    }

    if (!this.sessionFactory) {
      throw new Error('SessionFactory 未设置，请先调用 setSessionFactory')
    }

    const promise = (async () => {
      try {
        const factory = this.sessionFactory
        if (!factory) {
          throw new Error('SessionFactory 未设置，请先调用 setSessionFactory')
        }
        const session = await factory(threadId)
        const threadSession: PiThreadSession = {
          threadId,
          session,
          createdAt: Date.now(),
          lastAccessedAt: Date.now(),
          pendingToolCalls: new Map(),
        }
        this.sessions.set(threadId, threadSession)
        return threadSession
      } finally {
        this.pendingPromises.delete(threadId)
      }
    })()

    this.pendingPromises.set(threadId, promise)
    return promise
  }

  /**
   * 尝试占用 threadId 的活跃 run 槽位
   * @returns true 占用成功；false 已有活跃 run
   */
  tryAcquireRun(threadId: string, runId: string): boolean {
    let session = this.sessions.get(threadId)
    if (!session) {
      // session 尚未创建，创建占位条目记录 activeRunId
      // 真正的 session 会在后续 getOrCreate 中填充
      session = {
        threadId,
        session: null as any,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        pendingToolCalls: new Map(),
        activeRunId: runId,
      }
      this.sessions.set(threadId, session)
      return true
    }
    if (session.activeRunId) {
      return false
    }
    session.activeRunId = runId
    return true
  }

  /**
   * 释放 threadId 的活跃 run 槽位
   * 仅当 runId 匹配时才释放，防止误释放后续 run
   */
  releaseRun(threadId: string, runId: string): void {
    const session = this.sessions.get(threadId)
    if (session && session.activeRunId === runId) {
      session.activeRunId = undefined
    }
  }

  /** 检查 threadId 是否有活跃 run */
  hasActiveRun(threadId: string): boolean {
    const session = this.sessions.get(threadId)
    return !!session?.activeRunId
  }

  getActiveThreadSessions(): PiThreadSession[] {
    return Array.from(this.sessions.values())
  }

  getStats(): PiSessionStoreStats {
    let pendingToolCalls = 0
    let activeRuns = 0
    for (const session of this.sessions.values()) {
      pendingToolCalls += session.pendingToolCalls.size
      if (session.activeRunId) activeRuns++
    }
    return {
      threadCount: this.sessions.size,
      pendingToolCalls,
      activeRuns,
      evictedCount: this.evictedCount,
    }
  }

  rememberToolCall(threadId: string, toolCallId: string, call: unknown): void {
    const session = this.sessions.get(threadId)
    if (session) {
      session.pendingToolCalls.set(toolCallId, call)
    }
  }

  consumeToolCall(threadId: string, toolCallId: string): unknown | undefined {
    const session = this.sessions.get(threadId)
    if (session) {
      const call = session.pendingToolCalls.get(toolCallId)
      session.pendingToolCalls.delete(toolCallId)
      return call
    }
    return undefined
  }

  /**
   * 清除所有缓存的 Session（不影响持久化的会话历史）。
   * Provider 配置更新后调用，使下次请求创建新的 Session（使用新配置）。
   * 正在执行的 run 不会被强制中断，但下次 getOrCreate 会重建 Session。
   */
  clear(): void {
    this.sessions.clear()
    this.pendingPromises.clear()
  }

  /** 停止 sweep 定时器（用于优雅关闭） */
  dispose(): void {
    this.stopSweepTimer()
    this.clear()
  }

  /** 手动触发一次淘汰扫描，返回被淘汰的会话数 */
  sweepIdle(): number {
    const now = Date.now()
    let evicted = 0
    for (const [threadId, session] of this.sessions) {
      if (session.activeRunId) continue
      if (session.pendingToolCalls.size > 0) continue
      if (now - session.lastAccessedAt > this.idleTimeoutMs) {
        this.sessions.delete(threadId)
        evicted++
      }
    }
    this.evictedCount += evicted
    return evicted
  }

  /** LRU 淘汰：当缓存超过 maxSessions 时淘汰最久未访问的会话 */
  private evictLRU(): void {
    while (this.sessions.size > this.maxSessions) {
      let oldestId: string | null = null
      let oldestTime = Infinity
      for (const [threadId, session] of this.sessions) {
        if (session.activeRunId) continue
        if (session.pendingToolCalls.size > 0) continue
        if (session.lastAccessedAt < oldestTime) {
          oldestTime = session.lastAccessedAt
          oldestId = threadId
        }
      }
      if (oldestId === null) break
      this.sessions.delete(oldestId)
      this.evictedCount++
    }
  }

  private startSweepTimer(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => {
      try {
        this.sweepIdle()
        this.evictLRU()
      } catch {
        // 定时器异常不影响主流程
      }
    }, this.sweepIntervalMs)
    if (this.sweepTimer.unref) {
      this.sweepTimer.unref()
    }
  }

  private stopSweepTimer(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }
}
