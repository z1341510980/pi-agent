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
}

export interface PiSessionStoreStats {
  threadCount: number
  pendingToolCalls: number
}

/**
 * PiSessionStore：活跃会话管理
 */
export class PiSessionStore {
  private readonly sessions = new Map<string, PiThreadSession>()
  private sessionFactory?: PiSessionFactory

  setSessionFactory(factory: PiSessionFactory): void {
    this.sessionFactory = factory
  }

  async getOrCreate(threadId: string): Promise<PiThreadSession> {
    const existing = this.sessions.get(threadId)
    if (existing) {
      existing.lastAccessedAt = Date.now()
      return existing
    }

    if (!this.sessionFactory) {
      throw new Error('SessionFactory 未设置，请先调用 setSessionFactory')
    }

    const session = await this.sessionFactory(threadId)
    const threadSession: PiThreadSession = {
      threadId,
      session,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      pendingToolCalls: new Map(),
    }
    this.sessions.set(threadId, threadSession)
    return threadSession
  }

  getActiveThreadSessions(): PiThreadSession[] {
    return Array.from(this.sessions.values())
  }

  getStats(): PiSessionStoreStats {
    let pendingToolCalls = 0
    for (const session of this.sessions.values()) {
      pendingToolCalls += session.pendingToolCalls.size
    }
    return {
      threadCount: this.sessions.size,
      pendingToolCalls,
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
