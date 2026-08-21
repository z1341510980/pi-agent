// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WenlangAgentSession = any
/**
 * 会话工厂上下文（方案 §9.4）：chat 线程在注册表命中历史路径时，
 * 通过 resumePath 恢复原会话（pi-session 用 SessionManager.open 打开既有 JSONL）。
 */
export interface PiSessionFactoryContext {
  resumePath?: string
  /** Policy Hook Manager（由 plugin-loader 注入） */
  hookManager?: import('../policy/policy-hook-manager.js').PolicyHookManager
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
  /**
   * 配置已变更、该 session 需要在空闲后重建。
   *
   * 标记而不是立即删除：删除条目会连带丢掉 run lease，让同一 thread 的新 run
   * 与仍在跑的旧 run 重叠。stale session 在 run 结束（或本来就空闲）时才退休。
   */
  stale?: boolean
  /** 置为 stale 的原因，用于诊断"为什么这个会话被重建" */
  staleReason?: string
}

/** 会话失效的作用域 */
export type SessionInvalidationScope = 'all' | 'thread'

export interface SessionInvalidationOptions {
  /** all：全部会话；thread：仅指定 threadId */
  scope: SessionInvalidationScope
  /** scope='thread' 时必填 */
  threadId?: string
  /** 失效原因，写入 staleReason 供诊断 */
  reason: string
  /**
   * 是否中止仍在运行的 run。
   *
   * 默认 false：变更已保存，但当前 run 跑完后才重建（避免用户对话被配置改动打断）。
   * 只有 Provider 被删除、显式退出或应用关闭才应传 true。
   */
  abortActive?: boolean
}

export interface SessionInvalidationResult {
  /** 立即退休（dispose + 移除）的会话数 */
  retired: number
  /** 标记为 stale、等待 run 结束后重建的会话数 */
  markedStale: number
}

export interface PiSessionStoreStats {
  threadCount: number
  pendingToolCalls: number
  activeRuns: number
  evictedCount: number
  /** 已标记 stale、等待重建的会话数 */
  staleCount: number
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
  /** invalidate cache writes while an async session factory is still resolving */
  private cacheEpoch = 0

  private releaseSession(session: WenlangAgentSession, abort: boolean): void {
    try {
      if (abort) session.abort?.()
      session.dispose?.()
    } catch {
      // Disposal is best-effort; cache consistency must not depend on SDK cleanup.
    }
  }
  /** 会话身份注册表（可选）：threadId → sessionPath 持久化（方案 §9.4） */
  private identityRegistry?: import('./session-identity-registry.js').SessionIdentityRegistry
  /** Policy Hook Manager（由 plugin-loader 注入） */
  private hookManager?: import('../policy/policy-hook-manager.js').PolicyHookManager
  /**
   * 可选 EventBus：会话退休时发射产品级 `session:retired` 事件。
   *
   * 注意边界：这是本仓库自己的通知，不是 Pi SDK 的 `session_shutdown` ——
   * SDK 的 `dispose()` 不发任何 shutdown 回调。消费者据此清理自己持有的
   * 会话资源，不能假设 Extension 已收到 SDK 级生命周期通知。
   */
  private eventBus?: import('@repo/shared/events').EventBus

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

  /**
   * 注入 Policy Hook Manager
   */
  setHookManager(hookManager: import('../policy/policy-hook-manager.js').PolicyHookManager): void {
    this.hookManager = hookManager
  }

  /** 注入 EventBus（可选）：会话退休时发射 `session:retired` */
  setEventBus(eventBus: import('@repo/shared/events').EventBus): void {
    this.eventBus = eventBus
  }

  async getOrCreate(threadId: string): Promise<PiThreadSession> {
    const epoch = this.cacheEpoch
    const existing = this.sessions.get(threadId)
    if (existing) {
      // stale 且已无活跃 run/pending tool：此刻重建，让配置变更真正生效。
      // 仍在运行时保持旧 session，避免中途换掉正在使用的会话。
      if (existing.stale && this.canRetire(existing)) {
        this.retireSession(threadId, existing, {
          abort: false,
          reason: existing.staleReason ?? 'stale-rebuild'
        })
        return this.createAndCache(threadId, epoch)
      }
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
            if (epoch !== this.cacheEpoch) {
              this.releaseSession(session, true)
              throw new Error('Session 创建在缓存清理期间完成，已丢弃')
            }
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

    return this.createAndCache(threadId, epoch)
  }

  /**
   * 新建 session 并写入缓存。
   *
   * epoch 用于拒绝在失效期间完成的异步 factory：过期结果立即释放，绝不回写缓存。
   */
  private createAndCache(threadId: string, epoch: number): Promise<PiThreadSession> {
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
        if (epoch !== this.cacheEpoch) {
          this.releaseSession(session, true)
          throw new Error('Session 创建在缓存清理期间完成，已丢弃')
        }
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
    let staleCount = 0
    for (const session of this.sessions.values()) {
      pendingToolCalls += session.pendingToolCalls.size
      if (session.activeRunId) activeRuns++
      if (session.stale) staleCount++
    }
    return {
      threadCount: this.sessions.size,
      pendingToolCalls,
      activeRuns,
      evictedCount: this.evictedCount,
      staleCount,
    }
  }

  /** 该会话是否已可安全退休（无活跃 run、无 pending tool call） */
  private canRetire(session: PiThreadSession): boolean {
    return !session.activeRunId && session.pendingToolCalls.size === 0
  }

  /**
   * 退休一个会话：dispose 后从索引移除，并发射产品级 `session:retired`。
   *
   * 与直接 `Map.delete()` 的差别是显式释放 Pi session（abort 订阅、失效
   * Extension context、回收资源），不把清理责任留给 GC。
   *
   * 事件在 dispose 完成后发射，payload 不携带 session 对象引用 ——
   * 消费者拿到已退休对象的引用只会诱发 use-after-dispose。
   */
  private retireSession(
    threadId: string,
    session: PiThreadSession,
    options: { abort: boolean; reason: string }
  ): void {
    this.releaseSession(session.session, options.abort)
    this.sessions.delete(threadId)
    this.eventBus?.emit('session:retired', {
      threadId,
      reason: options.reason,
      aborted: options.abort,
      hadActiveRun: Boolean(session.activeRunId)
    })
  }

  /**
   * 按作用域使会话失效（方案 §10.12-2）。
   *
   * 语义与旧的全局 `clear()` 不同：
   * - 空闲会话立即 dispose 并移除；
   * - 仍在运行的会话默认只标记 stale，run 结束后由下次 getOrCreate 重建。
   *   删除仍有 lease 的条目会让同一 thread 的新 run 与旧 run 重叠，
   *   旧 run 的 finally 只能看到新条目，互斥不变量就此失效。
   *
   * @returns 立即退休数与标记 stale 数
   */
  invalidate(options: SessionInvalidationOptions): SessionInvalidationResult {
    if (options.scope === 'thread' && !options.threadId) {
      throw new Error("invalidate({ scope: 'thread' }) 必须提供 threadId")
    }

    const targets: Array<[string, PiThreadSession]> =
      options.scope === 'thread'
        ? (() => {
            const found = this.sessions.get(options.threadId!)
            return found ? [[options.threadId!, found]] : []
          })()
        : Array.from(this.sessions.entries())

    // 全量失效才推进 epoch：thread 级失效不能丢弃其他线程正在创建的 session。
    if (options.scope === 'all') {
      this.cacheEpoch += 1
      this.pendingPromises.clear()
    } else {
      this.pendingPromises.delete(options.threadId!)
    }

    let retired = 0
    let markedStale = 0
    for (const [threadId, session] of targets) {
      const canRetireNow = this.canRetire(session) || options.abortActive === true
      if (canRetireNow) {
        this.retireSession(threadId, session, {
          abort: !!session.activeRunId,
          reason: options.reason
        })
        retired++
        continue
      }
      session.stale = true
      session.staleReason = options.reason
      markedStale++
    }
    return { retired, markedStale }
  }

  /** 停止 sweep 定时器（用于优雅关闭） */
  dispose(): void {
    this.stopSweepTimer()
    // 应用关闭：显式 abort 并 dispose 每个会话，不留下运行中的 run。
    this.invalidate({ scope: 'all', reason: 'store dispose', abortActive: true })
    this.sessions.clear()
    this.pendingPromises.clear()
  }

  /** 手动触发一次淘汰扫描，返回被淘汰的会话数 */
  sweepIdle(): number {
    const now = Date.now()
    let evicted = 0
    for (const [threadId, session] of this.sessions) {
      if (!this.canRetire(session)) continue
      // stale 会话不必等 idleTimeout：配置已经变了，留着只会被下次 getOrCreate 丢弃。
      if (session.stale || now - session.lastAccessedAt > this.idleTimeoutMs) {
        this.retireSession(threadId, session, {
          abort: false,
          reason: session.stale ? (session.staleReason ?? 'stale') : 'idle-timeout'
        })
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
        if (!this.canRetire(session)) continue
        if (session.lastAccessedAt < oldestTime) {
          oldestTime = session.lastAccessedAt
          oldestId = threadId
        }
      }
      if (oldestId === null) break
      const evicted = this.sessions.get(oldestId)
      if (evicted) this.retireSession(oldestId, evicted, { abort: false, reason: 'lru' })
      else this.sessions.delete(oldestId)
      this.evictedCount++
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
