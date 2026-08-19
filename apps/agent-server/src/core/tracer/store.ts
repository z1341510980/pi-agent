/**
 * SQLite 追踪存储实现
 *
 * 对标 DSH 的 session-query-sqlite 存储层
 */

import type Database from 'better-sqlite3'
import type {
  Trace,
  TraceEvent,
  TraceStore,
  EventRecord,
  EventQueryFilter,
  EventTraceResult,
  LineageTrace,
  SessionRecord,
  LineageNode,
  TraceId,
  EventSeq,
  Timestamp,
} from './types.js'

/**
 * 创建追踪相关的数据库表
 */
export function createTraceTables(db: Database.Database): void {
  // 追踪表
  db.exec(`
    CREATE TABLE IF NOT EXISTS traces (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id);
    CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status);
  `)

  // 事件表
  db.exec(`
    CREATE TABLE IF NOT EXISTS trace_events (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      time INTEGER NOT NULL,
      status TEXT NOT NULL,
      data TEXT,
      parent_seq INTEGER,
      source_event_seqs TEXT,
      span_id TEXT,
      metadata TEXT,
      FOREIGN KEY (trace_id) REFERENCES traces(id) ON DELETE CASCADE,
      UNIQUE(trace_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_events_trace ON trace_events(trace_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON trace_events(type);
    CREATE INDEX IF NOT EXISTS idx_events_time ON trace_events(time);
    CREATE INDEX IF NOT EXISTS idx_events_span ON trace_events(span_id);
  `)

  // 会话谱系表
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_lineage (
      session_id TEXT PRIMARY KEY,
      parent_id TEXT,
      thread_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER,
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_lineage_parent ON session_lineage(parent_id);
    CREATE INDEX IF NOT EXISTS idx_lineage_thread ON session_lineage(thread_id);
  `)
}

/**
 * SQLite 追踪存储实现
 */
export class SqliteTraceStore implements TraceStore {
  constructor(private readonly db: Database.Database) {}

  async saveTrace(trace: Trace): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO traces (id, session_id, run_id, started_at, ended_at, status, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    stmt.run(
      trace.id,
      trace.sessionId,
      trace.runId,
      trace.startedAt,
      trace.endedAt ?? null,
      trace.status,
      JSON.stringify(trace.metadata ?? {}),
    )

    // 保存事件
    for (const event of trace.events) {
      await this.appendEvents(trace.id, [event])
    }

    // 更新会话谱系
    this.upsertSessionLineage(trace.sessionId, trace.runId, trace.startedAt)
  }

  async appendEvents(traceId: TraceId, events: TraceEvent[]): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO trace_events
      (id, trace_id, seq, type, time, status, data, parent_seq, source_event_seqs, span_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insertMany = this.db.transaction((evts: TraceEvent[]) => {
      for (const event of evts) {
        stmt.run(
          event.id,
          traceId,
          event.seq,
          event.type,
          event.time,
          event.status,
          JSON.stringify(event.data ?? {}),
          event.parentSeq ?? null,
          event.sourceEventSeqs ? JSON.stringify(event.sourceEventSeqs) : null,
          event.spanId ?? null,
          JSON.stringify(event.metadata ?? {}),
        )
      }
    })

    insertMany(events)
  }

  async updateTraceStatus(traceId: TraceId, status: Trace['status']): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE traces SET status = ?, ended_at = unixepoch() * 1000 WHERE id = ?
    `)
    stmt.run(status, traceId)
  }

  async getTrace(traceId: TraceId): Promise<Trace | null> {
    const traceStmt = this.db.prepare(`
      SELECT * FROM traces WHERE id = ?
    `)
    const traceRow = traceStmt.get(traceId) as
      | { id: string; session_id: string; run_id: string; started_at: number; ended_at: number | null; status: string; metadata: string }
      | undefined

    if (!traceRow) return null

    const events = await this.getTraceEvents(traceId)

    return {
      id: traceRow.id,
      sessionId: traceRow.session_id,
      runId: traceRow.run_id,
      startedAt: traceRow.started_at,
      endedAt: traceRow.ended_at ?? undefined,
      status: traceRow.status as Trace['status'],
      events,
      rootEvent: events.length > 0 ? events[0] : undefined,
      metadata: JSON.parse(traceRow.metadata || '{}'),
    }
  }

  async getTraceEvents(traceId: TraceId): Promise<TraceEvent[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM trace_events WHERE trace_id = ? ORDER BY seq ASC
    `)
    const rows = stmt.all(traceId) as Array<{
      id: string
      trace_id: string
      seq: number
      type: string
      time: number
      status: string
      data: string
      parent_seq: number | null
      source_event_seqs: string | null
      span_id: string | null
      metadata: string
    }>

    return rows.map((row) => ({
      id: row.id,
      traceId: row.trace_id,
      seq: row.seq,
      type: row.type as TraceEvent['type'],
      time: row.time,
      status: row.status as TraceEvent['status'],
      data: JSON.parse(row.data || '{}'),
      parentSeq: row.parent_seq ?? undefined,
      sourceEventSeqs: row.source_event_seqs ? JSON.parse(row.source_event_seqs) : undefined,
      spanId: row.span_id ?? undefined,
      metadata: JSON.parse(row.metadata || '{}'),
    }))
  }

  async getSessionTraces(sessionId: string): Promise<Trace[]> {
    const stmt = this.db.prepare(`
      SELECT id FROM traces WHERE session_id = ? ORDER BY started_at DESC
    `)
    const rows = stmt.all(sessionId) as Array<{ id: string }>

    const traces: Trace[] = []
    for (const row of rows) {
      const trace = await this.getTrace(row.id)
      if (trace) traces.push(trace)
    }
    return traces
  }

  async queryEvents(filter: EventQueryFilter): Promise<EventRecord[]> {
    let sql = `
      SELECT
        e.trace_id as traceId,
        e.seq as seq,
        e.type as type,
        e.time as time,
        e.status as status,
        CASE
          WHEN s.seq IS NOT NULL THEN 'current'
          WHEN r.replaced_by IS NOT NULL THEN 'shadowed'
          ELSE 'log-only'
        END as surface
      FROM trace_events e
      LEFT JOIN (
        SELECT trace_id, seq, 1 as is_current
        FROM trace_events
        WHERE (trace_id, seq) IN (
          SELECT trace_id, MAX(seq) FROM trace_events GROUP BY trace_id
        )
      ) s ON e.trace_id = s.trace_id AND e.seq = s.seq
      LEFT JOIN (
        SELECT trace_id, replaced_seq, seq as replaced_by
        FROM trace_events
        WHERE source_event_seqs IS NOT NULL
      ) r ON e.trace_id = r.trace_id AND e.seq = r.replaced_seq
      WHERE 1=1
    `

    const params: (string | number)[] = []

    if (filter.traceId) {
      sql += ` AND e.trace_id = ?`
      params.push(filter.traceId)
    }
    if (filter.sessionId) {
      sql += ` AND e.trace_id IN (SELECT id FROM traces WHERE session_id = ?)`
      params.push(filter.sessionId)
    }
    if (filter.type) {
      sql += ` AND e.type = ?`
      params.push(filter.type)
    }
    if (filter.status) {
      sql += ` AND e.status = ?`
      params.push(filter.status)
    }
    if (filter.startTime) {
      sql += ` AND e.time >= ?`
      params.push(filter.startTime)
    }
    if (filter.endTime) {
      sql += ` AND e.time <= ?`
      params.push(filter.endTime)
    }

    sql += ` ORDER BY e.time DESC`

    if (filter.limit !== undefined) {
      sql += ` LIMIT ?`
      params.push(filter.limit)
    }
    if (filter.offset !== undefined) {
      sql += ` OFFSET ?`
      params.push(filter.offset)
    }

    const stmt = this.db.prepare(sql)
    return stmt.all(...params) as EventRecord[]
  }

  async traceEvent(traceId: TraceId, seq: EventSeq): Promise<EventTraceResult> {
    // 获取目标事件
    const eventStmt = this.db.prepare(`
      SELECT * FROM trace_events WHERE trace_id = ? AND seq = ?
    `)
    const targetRow = eventStmt.get(traceId, seq) as
      | { id: string; type: string; time: number; status: string }
      | undefined

    if (!targetRow) {
      throw new Error(`Event ${seq} not found in trace ${traceId}`)
    }

    // 获取所有事件（用于构建关系图）
    const allEvents = await this.getTraceEvents(traceId)

    // 构建替换链
    const replacementChain: EventSeq[] = []
    let currentSeq: EventSeq | undefined = seq
    const visited = new Set<EventSeq>()

    while (currentSeq !== undefined && !visited.has(currentSeq)) {
      visited.add(currentSeq)
      // 查找引用此事件的事件
      const replacer = allEvents.find(
        (e) => e.sourceEventSeqs?.includes(currentSeq as EventSeq),
      )
      if (replacer) {
        replacementChain.push(replacer.seq)
        currentSeq = replacer.seq
      } else {
        currentSeq = undefined
      }
    }

    // 获取被此事件替换的事件
    const replacedEventSeqs = allEvents
      .filter((e) => e.seq === seq && e.sourceEventSeqs)
      .flatMap((e) => e.sourceEventSeqs ?? [])

    // 获取源事件
    const targetEvent = allEvents.find((e) => e.seq === seq)
    const sourceEventSeqs = targetEvent?.sourceEventSeqs ?? []

    // 获取派生事件（引用此事件的事件）
    const derivedEventSeqs = allEvents
      .filter((e) => e.sourceEventSeqs?.includes(seq))
      .map((e) => e.seq)

    // 判断表面状态
    const maxSeq = allEvents.reduce((max, e) => Math.max(max, e.seq), 0)
    const isCurrent = seq === maxSeq
    const isShadowed = allEvents.some((e) => e.sourceEventSeqs?.includes(seq))

    return {
      target: {
        traceId,
        seq,
        type: targetRow.type as TraceEvent['type'],
        time: targetRow.time,
        status: targetRow.status as TraceEvent['status'],
        surface: isCurrent ? 'current' : isShadowed ? 'shadowed' : 'log-only',
      },
      replacementChain,
      replacedEventSeqs,
      sourceEventSeqs,
      derivedEventSeqs,
    }
  }

  async traceSession(sessionId: string): Promise<LineageTrace> {
    // 获取会话记录
    const sessionStmt = this.db.prepare(`
      SELECT * FROM session_lineage WHERE session_id = ?
    `)
    const sessionRow = sessionStmt.get(sessionId) as
      | { session_id: string; parent_id: string | null; thread_id: string; created_at: number; last_accessed_at: number | null; metadata: string }
      | undefined

    if (!sessionRow) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const target: SessionRecord = {
      id: sessionRow.session_id,
      parentId: sessionRow.parent_id ?? undefined,
      threadId: sessionRow.thread_id,
      createdAt: sessionRow.created_at,
      lastAccessedAt: sessionRow.last_accessed_at ?? sessionRow.created_at,
      metadata: JSON.parse(sessionRow.metadata || '{}'),
    }

    // 构建祖先链
    const ancestors: SessionRecord[] = []
    const ancestrySeen = new Set<string>([sessionId])
    let unresolvedParentId: string | undefined
    let parentId = target.parentId

    while (parentId) {
      if (ancestrySeen.has(parentId)) {
        throw new Error(`Cycle detected in session lineage: ${parentId}`)
      }
      ancestrySeen.add(parentId)

      const parentStmt = this.db.prepare(`
        SELECT * FROM session_lineage WHERE session_id = ?
      `)
      const parentRow = parentStmt.get(parentId) as
        | { session_id: string; parent_id: string | null; thread_id: string; created_at: number; last_accessed_at: number | null; metadata: string }
        | undefined

      if (!parentRow) {
        unresolvedParentId = parentId
        break
      }

      ancestors.push({
        id: parentRow.session_id,
        parentId: parentRow.parent_id ?? undefined,
        threadId: parentRow.thread_id,
        createdAt: parentRow.created_at,
        lastAccessedAt: parentRow.last_accessed_at ?? parentRow.created_at,
        metadata: JSON.parse(parentRow.metadata || '{}'),
      })

      parentId = parentRow.parent_id ?? undefined
    }

    // 构建后代树
    const childrenStmt = this.db.prepare(`
      SELECT * FROM session_lineage WHERE parent_id = ?
    `)
    const buildDescendants = (id: string): LineageNode[] => {
      const rows = childrenStmt.all(id) as Array<{
        session_id: string
        parent_id: string | null
        thread_id: string
        created_at: number
        last_accessed_at: number | null
        metadata: string
      }>

      return rows.map((row) => ({
        session: {
          id: row.session_id,
          parentId: row.parent_id ?? undefined,
          threadId: row.thread_id,
          createdAt: row.created_at,
          lastAccessedAt: row.last_accessed_at ?? row.created_at,
          metadata: JSON.parse(row.metadata || '{}'),
        },
        descendants: buildDescendants(row.session_id),
      }))
    }

    const descendants = buildDescendants(sessionId)

    const result: LineageTrace = {
      target,
      ancestors,
      descendants,
      complete: !unresolvedParentId,
    }

    if (unresolvedParentId) {
      result.unresolvedParentId = unresolvedParentId
    }

    if (ancestors.length > 0) {
      result.root = ancestors[ancestors.length - 1]
    } else {
      result.root = target
    }

    return result
  }

  private upsertSessionLineage(sessionId: string, threadId: string, createdAt: Timestamp): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO session_lineage (session_id, thread_id, created_at, last_accessed_at)
      VALUES (?, ?, ?, ?)
    `)
    stmt.run(sessionId, threadId, createdAt, Date.now())
  }
}