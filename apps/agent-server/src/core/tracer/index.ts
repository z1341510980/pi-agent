/**
 * 追踪系统统一导出
 *
 * 对标 DeepSeek Harness 的 session-query 追踪能力
 *
 * 使用示例：
 * ```typescript
 * import { Tracer, SqliteTraceStore, createTraceTables } from './tracer/index.js'
 *
 * // 初始化存储
 * const store = new SqliteTraceStore(db)
 * createTraceTables(db)
 *
 * // 创建追踪器
 * const tracer = new Tracer(store)
 *
 * // 开始追踪
 * const trace = tracer.startTrace({ sessionId, runId })
 *
 * // 添加事件
 * tracer.addEvent(trace.id, {
 *   type: 'user_message',
 *   data: { content: 'Hello' }
 * })
 *
 * // 追踪关系
 * const result = tracer.traceEvent(trace.id, 2)
 * const surface = tracer.currentSurface(trace.id)
 *
 * // 完成追踪
 * tracer.finishTrace(trace.id, 'completed')
 * ```
 */

export { Tracer, type TracerOptions } from './tracer.js'
export { SqliteTraceStore, createTraceTables } from './store.js'
export type {
  Trace,
  TraceEvent,
  TraceEventType,
  EventStatus,
  EventSeq,
  TraceId,
  Timestamp,
  EventRecord,
  EventTraceResult,
  LineageTrace,
  LineageNode,
  SessionRecord,
  TraceStore,
  EventQueryFilter,
  TracerConfig,
} from './types.js'