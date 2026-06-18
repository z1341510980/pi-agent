// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PiAgentSession = any
type PiSessionFactory = (threadId: string) => Promise<PiAgentSession>

export interface PiThreadSession {
  threadId: string
  session: PiAgentSession
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
}

/**
 * PiSessionStore：活跃会话管理
 *
 * 关键不变量：
 * 1. getOrCreate 对同一 threadId 并发调用只创建一个 session（通过 pendingPromises Map）
 * 2. tryAcquireRun/releaseRun 提供同线程 run 互斥
 */
export class PiSessionStore {
  private readonly sessions = new Map<string, PiThreadSession>()
  /** 进行中的 session 创建 Promise，防止并发重复创建 */
  private readonly pendingPromises = new Map<string, Promise<PiThreadSession>>()
  private sessionFactory?: PiSessionFactory

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
}
