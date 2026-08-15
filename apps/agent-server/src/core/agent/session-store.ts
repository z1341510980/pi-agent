// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WenlangAgentSession = any
/**
 * 会话工厂上下文（方案 §9.4）：chat 线程在注册表命中历史路径时，
 * 通过 resumePath 恢复原会话（pi-session 用 SessionManager.open 打开既有 JSONL）。
 */
export interface PiSessionFactoryContext {
  resumePath?: string
}
type PiSessionFactory = (threadId: string, context?: PiSessionFactoryContext) => Promise<WenlangAgentSession>

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
  /** 会话身份注册表（可选）：threadId → sessionPath 持久化（方案 §9.4） */
  private identityRegistry?: import('./session-identity-registry.js').SessionIdentityRegistry

  constructor(options: PiSessionStoreOptions = {}) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
    this.startSweepTimer()
  }

  setSessionFactory(factory: PiSessionFactory): void {
    this.sessionFactory = factory
  }

  /**
   * 注入会话身份注册表（app.ts 在 SessionStore 创建后调用）。
   *
   * 注入后：
   * - 会话创建成功后异步持久化 threadId → sessionPath；
   * - getSessionFilePath 内存 miss 时回退查表；
   * - chat 线程（非 plugin:*）在内存 miss 时按表中路径恢复原会话。
   */
  setIdentityRegistry(registry: import('./session-identity-registry.js').SessionIdentityRegistry): void {
    this.identityRegistry = registry
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
            const session = await factory(threadId, this.restoreContext(threadId))
            existing.session = session
            existing.lastAccessedAt = Date.now()
            void this.persistSessionIdentity(existing)
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
        const session = await factory(threadId, this.restoreContext(threadId))
        const threadSession: PiThreadSession = {
          threadId,
          session,
          createdAt: Date.now(),
          lastAccessedAt: Date.now(),
          pendingToolCalls: new Map(),
        }
        this.sessions.set(threadId, threadSession)
        void this.persistSessionIdentity(threadSession)
        return threadSession
      } finally {
        this.pendingPromises.delete(threadId)
      }
    })()

    this.pendingPromises.set(threadId, promise)
    return promise
  }

  /**
   * 计算本次会话创建的恢复上下文（方案 §9.4）。
   *
   * 仅 chat 线程（非 plugin:*）在注册表命中历史路径时提供 resumePath：
   * - plugin:* 是一次性调用，每次强制新建 SessionManager，不做恢复；
   * - 未注入注册表 / 无历史路径时返回 undefined（新建会话，旧行为）。
   */
  private restoreContext(threadId: string): PiSessionFactoryContext | undefined {
    if (threadId.startsWith('plugin:')) return undefined
    const resumePath = this.identityRegistry?.get(threadId) ?? undefined
    return resumePath ? { resumePath } : undefined
  }

  /**
   * 持久化 threadId → sessionPath（fire-and-forget）。
   *
   * 会话创建成功即写注册表，使 getSessionFilePath 在 LRU 淘汰/重启后仍可查表；
   * 失败只静默忽略（注册表是增强项，不影响会话本体）。
   */
  private async persistSessionIdentity(threadSession: PiThreadSession): Promise<void> {
    if (!this.identityRegistry) return
    if (threadSession.threadId.startsWith('plugin:')) return
    try {
      const metadata = await threadSession.session.getMetadata()
      const path = (metadata as { path?: unknown } | undefined)?.path
      if (typeof path === 'string' && path.length > 0) {
        this.identityRegistry.put(threadSession.threadId, path)
      }
    } catch {
      // 存储实现没有 metadata / 读取失败：跳过本次持久化
    }
  }

  /**
   * 取 threadId 对应会话的 JSONL 文件路径。
   *
   * ## 为什么需要这个方法
   *
   * 会话文件名由 pi-agent-core 的 JsonlSessionRepo 生成，形如
   * `2026-06-17T07-59-31-525Z_019ed497-….jsonl`（时间戳 + session uuid），
   * **与 threadId 毫无关系**。`GET /api/sessions/:threadId/messages` 原来直接拼
   * `${threadId}.jsonl` 去读，永远找不到文件 —— 历史消息分页因此一直返回空。
   *
   * 真实路径在 session 的 metadata 里（`JsonlSessionMetadata.path`），优先从活跃
   * session 对象拿；内存 miss（LRU 淘汰或进程重启）时回退到持久化的会话身份
   * 注册表（方案 §9.4，见 SqliteSessionIdentityRegistry / 迁移 015）。
   *
   * @returns 文件路径；会话不在内存中且注册表无记录、或底层不是 JSONL 存储时返回 null
   */
  async getSessionFilePath(threadId: string): Promise<string | null> {
    const threadSession = this.sessions.get(threadId)
    if (threadSession?.session) {
      try {
        const metadata = await threadSession.session.getMetadata()
        const path = (metadata as { path?: unknown } | undefined)?.path
        if (typeof path === 'string' && path.length > 0) return path
      } catch {
        // 存储实现没有 metadata / 读取失败：继续尝试注册表
      }
    }
    // 方案 §9.4：内存 miss（LRU 淘汰/重启）时回退持久化注册表
    return this.identityRegistry?.get(threadId) ?? null
  }
  /**
   * 尝试占用 threadId 的活跃 run 槽位
   * @returns true 占用成功；false 已有活跃 run
   */
  tryAcquireRun(threadId: string, runId: string): boolean {    let session = this.sessions.get(threadId)
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
