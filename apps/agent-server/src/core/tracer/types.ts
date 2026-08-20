/**
 * 追踪系统类型定义
 *
 * 对标 DeepSeek Harness 的 session-query 追踪能力：
 * - 事件溯源模型
 * - 有向图关系
 * - 表面状态查询
 */

/** 追踪 ID（对应一次 Agent 运行） */
export type TraceId = string

/** 事件序号（单调递增，每个 Trace 独立） */
export type EventSeq = number

/** 时间戳（毫秒） */
export type Timestamp = number

/** 事件类型 */
export type TraceEventType =
  | 'run_started'
  | 'run_finished'
  | 'run_error'
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'llm_request'
  | 'llm_response'
  | 'reasoning'
  | 'subagent_start'
  | 'subagent_finish'
  | 'compaction'

/** 事件状态 */
export type EventStatus = 'pending' | 'completed' | 'failed' | 'cancelled'

/**
 * 追踪事件 - 最小粒度单元
 *
 * 对标 DSH 的 SessionEvent：
 * - seq: 事件序号
 * - sourceEventSeqs: 引用来源事件（用于构建有向图）
 */
export interface TraceEvent<T = Record<string, unknown>> {
  /** 唯一 ID */
  id: string
  /** 所属追踪 */
  traceId: TraceId
  /** 事件序号（单调递增） */
  seq: EventSeq
  /** 事件类型 */
  type: TraceEventType
  /** 时间戳 */
  time: Timestamp
  /** 状态 */
  status: EventStatus
  /** 事件数据（类型相关） */
  data: T
  /** 父事件序号（用于构建树） */
  parentSeq?: EventSeq
  /** 引用的源事件序号（构建有向图） */
  sourceEventSeqs?: EventSeq[]
  /** 关联的 spanId（用于关联到根 span） */
  spanId?: string
  /** 元数据（额外标签） */
  metadata?: Record<string, unknown>
}

/**
 * 追踪记录 - 包含一次 Agent 运行的所有事件
 */
export interface Trace {
  /** 追踪 ID */
  id: TraceId
  /** 会话 ID */
  sessionId: string
  /** 运行 ID */
  runId: string
  /** 开始时间 */
  startedAt: Timestamp
  /** 结束时间 */
  endedAt?: Timestamp
  /** 状态 */
  status: 'running' | 'completed' | 'failed' | 'aborted'
  /** 事件列表（按 seq 排序） */
  events: TraceEvent[]
  /** 根事件（第一个事件） */
  rootEvent?: TraceEvent
  /** 当前表面状态（折叠后的事件列表） */
  surfaceEvents?: TraceEvent[]
  /** 元数据 */
  metadata?: Record<string, unknown>
}

/**
 * 事件记录 - 轻量级查询结果
 */
export interface EventRecord {
  traceId: TraceId
  seq: EventSeq
  type: TraceEventType
  time: Timestamp
  status: EventStatus
  surface: 'current' | 'shadowed' | 'log-only'
}

/**
 * 事件追踪结果（对标 DSH traceEvent）
 */
export interface EventTraceResult {
  target: EventRecord
  replacedBy?: EventSeq
  replacementChain: EventSeq[]
  replacedEventSeqs: EventSeq[]
  sourceEventSeqs: EventSeq[]
  derivedEventSeqs: EventSeq[]
}

/**
 * 会话谱系节点（对标 DSH SessionLineageNode）
 */
export interface LineageNode {
  session: SessionRecord
  descendants: LineageNode[]
}

/**
 * 会话谱系追踪结果（对标 DSH SessionLineageTrace）
 */
export interface LineageTrace {
  target: SessionRecord
  ancestors: SessionRecord[]
  descendants: LineageNode[]
  complete: boolean
  unresolvedParentId?: string
  root?: SessionRecord
}

/**
 * 会话记录（轻量级）
 */
export interface SessionRecord {
  id: string
  parentId?: string
  threadId: string
  createdAt: Timestamp
  lastAccessedAt: Timestamp
  metadata?: Record<string, unknown>
}

/**
 * 追踪存储接口
 */
export interface TraceStore {
  /** 保存追踪 */
  saveTrace(trace: Trace): Promise<void>
  /** 追加事件到追踪 */
  appendEvents(traceId: TraceId, events: TraceEvent[]): Promise<void>
  /** 更新追踪状态 */
  updateTraceStatus(traceId: TraceId, status: Trace['status'], endedAt?: Timestamp): Promise<void>
  /** 获取完整追踪 */
  getTrace(traceId: TraceId): Promise<Trace | null>
  /** 获取追踪的事件列表 */
  getTraceEvents(traceId: TraceId): Promise<TraceEvent[]>
  /** 获取会话的所有追踪 */
  getSessionTraces(sessionId: string): Promise<Trace[]>
  /** 查询事件（按类型/时间过滤） */
  queryEvents(filter: EventQueryFilter): Promise<EventRecord[]>
  /** 追踪事件关系 */
  traceEvent(traceId: TraceId, seq: EventSeq): Promise<EventTraceResult>
  /** 追踪会话谱系 */
  traceSession(sessionId: string): Promise<LineageTrace>
}

/**
 * 事件查询过滤器
 */
export interface EventQueryFilter {
  traceId?: TraceId
  sessionId?: string
  type?: TraceEventType
  status?: EventStatus
  startTime?: Timestamp
  endTime?: Timestamp
  limit?: number
  offset?: number
}

/**
 * Tracer 配置
 */
export interface TracerConfig {
  /** 是否启用追踪（默认 true） */
  enabled?: boolean
  /** 最大事件数（防止 OOM） */
  maxEventsPerTrace?: number
  /** 存储后端（默认 sqlite） */
  store?: 'sqlite' | 'memory'
  /** 数据目录（用于 SQLite） */
  dataDir?: string
  /** 是否记录 payload 详情（默认 true） */
  recordPayloadDetails?: boolean
}
