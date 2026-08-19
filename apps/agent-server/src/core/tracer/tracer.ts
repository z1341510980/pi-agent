/**
 * 追踪器 - 核心追踪实现
 *
 * 对标 DSH 的 tracing.ts：
 * - 事件溯源：每个事件有 seq 和 sourceEventSeqs
 * - 表面折叠：通过 foldSurface 计算当前可见事件
 * - 追踪查询：traceEvent / traceSession
 */

import { randomUUID } from 'node:crypto'
import type { TraceStore, Trace, TraceEvent, TraceEventType, EventStatus, TraceId, EventSeq, Timestamp } from './types.js'

/**
 * 折叠表面结果
 * 对标 DSH 的 foldSurface 返回值
 */
export interface FoldSurfaceResult {
  /** 当前表面事件序号列表（折叠后） */
  nodes: EventSeq[]
  /** 替换关系：被替换的序号的替换者 */
  replacements: Array<{ seq: EventSeq; shadowedSeqs: EventSeq[] }>
}

/**
 * 追踪器配置
 */
export interface TracerOptions {
  /** 最大事件数（默认 10000） */
  maxEvents?: number
  /** 是否自动记录 payload 详情 */
  recordPayloadDetails?: boolean
}

/**
 * 追踪器
 *
 * 使用方式：
 * ```typescript
 * const tracer = new Tracer(store)
 * const trace = tracer.startTrace({ sessionId, runId })
 *
 * tracer.addEvent(trace.id, {
 *   type: 'user_message',
 *   data: { content: 'Hello' }
 * })
 *
 * tracer.addEvent(trace.id, {
 *   type: 'assistant_message',
 *   data: { content: 'Hi!' },
 *   sourceEventSeqs: [1]  // 引用用户消息
 * })
 *
 * const folded = tracer.foldSurface(trace.id)
 * const result = tracer.traceEvent(trace.id, 2)
 * ```
 */
export class Tracer {
  private readonly traces = new Map<TraceId, Trace>()
  private readonly stores: TraceStore
  private readonly options: TracerOptions

  constructor(store: TraceStore, options: TracerOptions = {}) {
    this.stores = store
    this.options = {
      maxEvents: 10000,
      recordPayloadDetails: true,
      ...options,
    }
  }

  /**
   * 开始新的追踪
   */
  startTrace(params: {
    sessionId: string
    runId: string
    metadata?: Record<string, unknown>
  }): Trace {
    const id = randomUUID()
    const now = Date.now()

    const trace: Trace = {
      id,
      sessionId: params.sessionId,
      runId: params.runId,
      startedAt: now,
      status: 'running',
      events: [],
      metadata: params.metadata,
    }

    this.traces.set(id, trace)

    // 添加根事件
    this.addEvent(id, {
      type: 'run_started',
      data: { sessionId: params.sessionId, runId: params.runId },
      status: 'completed',
      metadata: params.metadata,
    })

    return trace
  }

  /**
   * 添加事件到追踪
   */
  addEvent(
    traceId: TraceId,
    params: {
      type: TraceEventType
      data: Record<string, unknown>
      status?: EventStatus
      parentSeq?: EventSeq
      sourceEventSeqs?: EventSeq[]
      spanId?: string
      metadata?: Record<string, unknown>
    },
  ): TraceEvent {
    const trace = this.traces.get(traceId)
    if (!trace) {
      throw new Error(`Trace ${traceId} not found`)
    }

    if (trace.events.length >= (this.options.maxEvents ?? 10000)) {
      throw new Error(`Trace ${traceId} exceeded max events limit`)
    }

    const seq = trace.events.length + 1
    const now = Date.now()

    const event: TraceEvent = {
      id: randomUUID(),
      traceId,
      seq,
      type: params.type,
      time: now,
      status: params.status ?? 'completed',
      data: this.options.recordPayloadDetails ? params.data : { _truncated: true },
      parentSeq: params.parentSeq,
      sourceEventSeqs: params.sourceEventSeqs,
      spanId: params.spanId,
      metadata: params.metadata,
    }

    trace.events.push(event)

    // 异步持久化
    void this.stores.appendEvents(traceId, [event]).catch((err) => {
      console.error(`Failed to persist event ${event.id}:`, err)
    })

    return event
  }

  /**
   * 结束追踪
   */
  finishTrace(traceId: TraceId, status: 'completed' | 'failed' | 'aborted' = 'completed'): void {
    const trace = this.traces.get(traceId)
    if (!trace) {
      throw new Error(`Trace ${traceId} not found`)
    }

    trace.status = status
    trace.endedAt = Date.now()

    this.addEvent(traceId, {
      type: status === 'completed' ? 'run_finished' : 'run_error',
      data: { status },
      status: 'completed',
    })

    // 异步持久化
    void this.stores.updateTraceStatus(traceId, status).catch((err) => {
      console.error(`Failed to update trace ${traceId} status:`, err)
    })
  }

  /**
   * 获取追踪
   */
  getTrace(traceId: TraceId): Trace | undefined {
    return this.traces.get(traceId)
  }

  /**
   * 折叠表面：计算当前可见的事件列表
   *
   * 对标 DSH 的 foldSurface：
   * - 遍历事件，构建替换图
   * - 被 sourceEventSeqs 引用的事件被标记为 shadowed
   * - 返回当前表面节点
   */
  foldSurface(traceId: TraceId): FoldSurfaceResult {
    const trace = this.traces.get(traceId)
    if (!trace) {
      throw new Error(`Trace ${traceId} not found`)
    }

    const events = trace.events
    if (events.length === 0) {
      return { nodes: [], replacements: [] }
    }

    // 构建替换图
    const replacedBy = new Map<EventSeq, EventSeq>()
    const shadowedSeqs = new Map<EventSeq, EventSeq[]>()

    for (const event of events) {
      const sources = event.sourceEventSeqs ?? []
      if (sources.length > 0) {
        for (const sourceSeq of sources) {
          replacedBy.set(sourceSeq, event.seq)
          const list = shadowedSeqs.get(event.seq) ?? []
          list.push(sourceSeq)
          shadowedSeqs.set(event.seq, list)
        }
      }
    }

    // 确定表面节点：未被替换的事件
    const nodes: EventSeq[] = []
    for (const event of events) {
      if (!replacedBy.has(event.seq)) {
        nodes.push(event.seq)
      }
    }

    // 构建替换列表
    const replacements: Array<{ seq: EventSeq; shadowedSeqs: EventSeq[] }> = []
    for (const [seq, sources] of shadowedSeqs) {
      replacements.push({ seq, shadowedSeqs: sources })
    }

    return { nodes, replacements }
  }

  /**
   * 获取当前表面事件
   */
  currentSurface(traceId: TraceId): TraceEvent[] {
    const trace = this.traces.get(traceId)
    if (!trace) {
      throw new Error(`Trace ${traceId} not found`)
    }

    const folded = this.foldSurface(traceId)
    const seqSet = new Set(folded.nodes)

    return trace.events.filter((e) => seqSet.has(e.seq))
  }

  /**
   * 追踪单个事件的关系
   * 对标 DSH 的 traceEvent
   */
  traceEvent(traceId: TraceId, seq: EventSeq): {
    target: TraceEvent
    replacedBy?: EventSeq
    replacementChain: EventSeq[]
    replacedEventSeqs: EventSeq[]
    sourceEventSeqs: EventSeq[]
    derivedEventSeqs: EventSeq[]
  } {
    const trace = this.traces.get(traceId)
    if (!trace) {
      throw new Error(`Trace ${traceId} not found`)
    }

    const target = trace.events.find((e) => e.seq === seq)
    if (!target) {
      throw new Error(`Event ${seq} not found in trace ${traceId}`)
    }

    // 构建替换链
    const replacementChain: EventSeq[] = []
    let currentSeq: EventSeq | undefined = seq
    const visited = new Set<EventSeq>()

    while (currentSeq !== undefined && !visited.has(currentSeq)) {
      visited.add(currentSeq)
      const replacer = trace.events.find((e) => e.sourceEventSeqs?.includes(currentSeq as EventSeq))
      if (replacer) {
        replacementChain.push(replacer.seq)
        currentSeq = replacer.seq
      } else {
        currentSeq = undefined
      }
    }

    // 被此事件替换的事件
    const replacedEventSeqs = trace.events
      .filter((e) => e.seq === seq && e.sourceEventSeqs)
      .flatMap((e) => e.sourceEventSeqs ?? [])

    // 源事件
    const sourceEventSeqs = target.sourceEventSeqs ?? []

    // 派生事件（引用此事件的事件）
    const derivedEventSeqs = trace.events
      .filter((e) => e.sourceEventSeqs?.includes(seq))
      .map((e) => e.seq)

    // 是否被替换
    const replacedBy = trace.events.find((e) => e.sourceEventSeqs?.includes(seq))?.seq

    return {
      target,
      replacedBy,
      replacementChain,
      replacedEventSeqs,
      sourceEventSeqs,
      derivedEventSeqs,
    }
  }

  /**
   * 获取会话的所有追踪
   */
  async getSessionTraces(sessionId: string): Promise<Trace[]> {
    // 先从内存中找
    const memoryTraces = Array.from(this.traces.values()).filter(
      (t) => t.sessionId === sessionId,
    )

    // 再从存储中找
    const storedTraces = await this.stores.getSessionTraces(sessionId)

    // 合并去重
    const ids = new Set(memoryTraces.map((t) => t.id))
    for (const trace of storedTraces) {
      if (!ids.has(trace.id)) {
        memoryTraces.push(trace)
        ids.add(trace.id)
      }
    }

    return memoryTraces.sort((a, b) => a.startedAt - b.startedAt)
  }

  /**
   * 查询事件
   */
  async queryEvents(filter: {
    sessionId?: string
    type?: TraceEventType
    status?: EventStatus
    startTime?: Timestamp
    endTime?: Timestamp
    limit?: number
    offset?: number
  }): Promise<TraceEvent[]> {
    // 先尝试从存储查询
    const records = await this.stores.queryEvents({
      sessionId: filter.sessionId,
      type: filter.type,
      status: filter.status,
      startTime: filter.startTime,
      endTime: filter.endTime,
      limit: filter.limit,
      offset: filter.offset,
    })

    // 获取完整事件
    const events: TraceEvent[] = []
    for (const record of records) {
      const trace = this.traces.get(record.traceId) ?? (await this.stores.getTrace(record.traceId))
      if (trace) {
        const event = trace.events.find((e) => e.seq === record.seq)
        if (event) events.push(event)
      }
    }

    return events
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    traceCount: number
    eventCount: number
    maxEvents: number
  } {
    let eventCount = 0
    for (const trace of this.traces.values()) {
      eventCount += trace.events.length
    }

    return {
      traceCount: this.traces.size,
      eventCount,
      maxEvents: this.options.maxEvents ?? 10000,
    }
  }

  /**
   * 清理已完成的追踪（超过保留期）
   */
  async cleanup(retentionHours: number = 24): Promise<number> {
    const now = Date.now()
    const threshold = now - retentionHours * 60 * 60 * 1000

    let removed = 0
    for (const [id, trace] of this.traces) {
      if (trace.status !== 'running' && trace.endedAt && trace.endedAt < threshold) {
        this.traces.delete(id)
        removed++
      }
    }

    return removed
  }
}