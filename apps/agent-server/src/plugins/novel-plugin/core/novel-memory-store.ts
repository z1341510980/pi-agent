/**
 * NovelMemoryStore：小说系统长期记忆分层存储
 *
 * 在"当前状态"存储（novel_characters / novel_chapters / novel_conflicts 等）
 * 之上提供 3 层记忆能力：
 *
 * 1. 工作记忆（Working）：当前章节生成期间的临时上下文（已在 prompt-builder 中实现）
 * 2. 情景记忆（Episodic）：按章节存储的事件/状态快照（本 Store 实现）
 * 3. 语义记忆（Semantic）：跨章节的实体关系和因果链（本 Store 实现）
 *
 * 提供能力：
 * - 跨章节的伏笔状态追踪（从埋设到回收的完整生命周期）
 * - 冲突演化时间线（从潜伏到解决的阶段变化）
 * - 章节间因果关系（事件 A 导致事件 B）
 * - 时间线查询（"第 N 章时所有角色的状态快照"）
 *
 * 行映射遵循 snake_case（SQLite）→ camelCase（TypeScript）。
 */

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

/** 记忆事件类型 */
export type MemoryEventType =
  | 'character_change'
  | 'conflict_change'
  | 'foreshadow_change'
  | 'clue_change'
  | 'faction_change'
  | 'location_change'
  | 'relationship_change'
  | 'info_layer_change'
  | 'plot_event'
  | 'world_change'

/** 实体类型 */
export type MemoryEntityType =
  | 'character'
  | 'conflict'
  | 'foreshadow'
  | 'clue'
  | 'faction'
  | 'location'
  | 'relationship'
  | 'chapter'
  | 'world_rule'

/** 快照类型 */
export type MemorySnapshotType = 'character' | 'conflict' | 'foreshadow' | 'full'

/** 记忆事件 */
export interface MemoryEvent {
  id: string
  projectId: string
  chapterId: string | null
  chapterNumber: number
  eventType: MemoryEventType
  entityId: string
  entityType: MemoryEntityType
  description: string
  oldValue: string | null  // JSON
  newValue: string | null   // JSON
  cause: string | null      // 导致此事件的事件 ID 或描述
  effectIds: string[]       // 此事件导致的事件 ID 列表
  significance: number      // 1-10
  createdAt: number
}

/** 记忆快照 */
export interface MemorySnapshot {
  id: string
  projectId: string
  chapterNumber: number
  snapshotType: MemorySnapshotType
  entityId: string | null
  snapshotData: string  // JSON
  createdAt: number
}

/** listEvents 查询选项 */
export interface ListEventsOptions {
  chapterNumber?: number
  entityType?: MemoryEntityType
  entityId?: string
  eventType?: MemoryEventType
  minSignificance?: number
  limit?: number
}

/** listSnapshots 查询选项 */
export interface ListSnapshotsOptions {
  chapterNumber?: number
  snapshotType?: MemorySnapshotType
}

/** getSnapshot 查询选项 */
export interface GetSnapshotOptions {
  snapshotType?: MemorySnapshotType
  entityId?: string
}

// ── 行类型（SQLite snake_case → TypeScript camelCase 映射）──

interface MemoryEventRow {
  id: string
  project_id: string
  chapter_id: string | null
  chapter_number: number
  event_type: string
  entity_id: string
  entity_type: string
  description: string
  old_value: string | null
  new_value: string | null
  cause: string | null
  effect_ids: string | null
  significance: number
  created_at: number
}

interface MemorySnapshotRow {
  id: string
  project_id: string
  chapter_number: number
  snapshot_type: string
  entity_id: string | null
  snapshot_data: string
  created_at: number
}

// ── 工具函数 ──

function now(): number {
  return Math.floor(Date.now() / 1000)
}

function parseEffectIds(s: string | null): string[] {
  if (!s) return []
  try {
    const parsed = JSON.parse(s)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export class NovelMemoryStore {
  constructor(private db: Database.Database) {}

  // ═══════════════════════════════════════════════════════════════
  // 事件记录（情景记忆 + 因果链）
  // ═══════════════════════════════════════════════════════════════

  /** 记录记忆事件 */
  recordEvent(event: Omit<MemoryEvent, 'id' | 'createdAt'>): MemoryEvent {
    const full: MemoryEvent = {
      ...event,
      id: randomUUID(),
      createdAt: now(),
    }
    this.db.prepare(`
      INSERT INTO novel_memory_events
      (id, project_id, chapter_id, chapter_number, event_type, entity_id, entity_type,
       description, old_value, new_value, cause, effect_ids, significance, created_at)
      VALUES (@id, @project_id, @chapter_id, @chapter_number, @event_type, @entity_id, @entity_type,
              @description, @old_value, @new_value, @cause, @effect_ids, @significance, @created_at)
    `).run({
      id: full.id,
      project_id: full.projectId,
      chapter_id: full.chapterId,
      chapter_number: full.chapterNumber,
      event_type: full.eventType,
      entity_id: full.entityId,
      entity_type: full.entityType,
      description: full.description,
      old_value: full.oldValue,
      new_value: full.newValue,
      cause: full.cause,
      effect_ids: JSON.stringify(full.effectIds),
      significance: full.significance,
      created_at: full.createdAt,
    })
    return full
  }

  /** 查询项目所有记忆事件 */
  listEvents(projectId: string, options?: ListEventsOptions): MemoryEvent[] {
    // 构建 WHERE 子句
    const conditions = ['project_id = ?']
    const params: unknown[] = [projectId]
    if (options?.chapterNumber !== undefined) {
      conditions.push('chapter_number = ?')
      params.push(options.chapterNumber)
    }
    if (options?.entityType) {
      conditions.push('entity_type = ?')
      params.push(options.entityType)
    }
    if (options?.entityId) {
      conditions.push('entity_id = ?')
      params.push(options.entityId)
    }
    if (options?.eventType) {
      conditions.push('event_type = ?')
      params.push(options.eventType)
    }
    if (options?.minSignificance !== undefined) {
      conditions.push('significance >= ?')
      params.push(options.minSignificance)
    }
    const limit = options?.limit ?? 100
    const sql = `SELECT * FROM novel_memory_events WHERE ${conditions.join(' AND ')} ORDER BY chapter_number ASC, created_at ASC LIMIT ?`
    const rows = this.db.prepare(sql).all(...params, limit) as MemoryEventRow[]
    return rows.map((r) => this.rowToEvent(r))
  }

  /** 获取实体的事件历史（时间线） */
  getEntityTimeline(projectId: string, entityId: string): MemoryEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM novel_memory_events WHERE project_id = ? AND entity_id = ? ORDER BY chapter_number ASC, created_at ASC')
      .all(projectId, entityId) as MemoryEventRow[]
    return rows.map((r) => this.rowToEvent(r))
  }

  /** 获取因果关系链（向上追溯原因 + 向下追溯影响） */
  getCausalChain(eventId: string): { causes: MemoryEvent[]; effects: MemoryEvent[] } {
    const event = this.db
      .prepare('SELECT * FROM novel_memory_events WHERE id = ?')
      .get(eventId) as MemoryEventRow | undefined
    if (!event) return { causes: [], effects: [] }

    // 向上追溯原因（链式，防止循环引用导致死循环）
    const causes: MemoryEvent[] = []
    const visited = new Set<string>([event.id])
    let currentCauseId = event.cause
    while (currentCauseId) {
      if (visited.has(currentCauseId)) break
      visited.add(currentCauseId)
      const causeRow = this.db
        .prepare('SELECT * FROM novel_memory_events WHERE id = ?')
        .get(currentCauseId) as MemoryEventRow | undefined
      if (!causeRow) break
      causes.push(this.rowToEvent(causeRow))
      currentCauseId = causeRow.cause
    }

    // 向下追溯影响（BFS 递归，遍历所有 effect_ids 子树）
    const effects: MemoryEvent[] = []
    const queue: string[] = parseEffectIds(event.effect_ids)
    while (queue.length > 0) {
      const effectId = queue.shift()!
      if (visited.has(effectId)) continue
      visited.add(effectId)
      const effectRow = this.db
        .prepare('SELECT * FROM novel_memory_events WHERE id = ?')
        .get(effectId) as MemoryEventRow | undefined
      if (!effectRow) continue
      effects.push(this.rowToEvent(effectRow))
      // 把当前事件的下游继续入队，实现递归展开
      const childEffectIds = parseEffectIds(effectRow.effect_ids)
      for (const childId of childEffectIds) {
        if (!visited.has(childId)) queue.push(childId)
      }
    }

    return { causes: causes.reverse(), effects }
  }

  /**
   * 事后追加因果关系边：把 causeId 标记为 eventId 的上游原因
   * 同时在 causeId 的 effect_ids 数组里追加 eventId（双向维护）
   */
  linkCause(eventId: string, causeId: string): void {
    const event = this.db
      .prepare('SELECT * FROM novel_memory_events WHERE id = ?')
      .get(eventId) as MemoryEventRow | undefined
    if (!event) return
    // 已有 cause 则不覆盖（保留首次写入的因果）
    if (event.cause) return
    this.db.prepare('UPDATE novel_memory_events SET cause = ? WHERE id = ?').run(causeId, eventId)
    // 反向维护 causeId 的 effect_ids
    const causeEvent = this.db
      .prepare('SELECT * FROM novel_memory_events WHERE id = ?')
      .get(causeId) as MemoryEventRow | undefined
    if (causeEvent) {
      const existing = parseEffectIds(causeEvent.effect_ids)
      if (!existing.includes(eventId)) {
        existing.push(eventId)
        this.db
          .prepare('UPDATE novel_memory_events SET effect_ids = ? WHERE id = ?')
          .run(JSON.stringify(existing), causeId)
      }
    }
  }

  /**
   * 事后追加因果关系边：把 effectId 标记为 eventId 的下游影响
   * 同时在 effectId 的 cause 字段回填 eventId（双向维护）
   */
  linkEffect(eventId: string, effectId: string): void {
    const event = this.db
      .prepare('SELECT * FROM novel_memory_events WHERE id = ?')
      .get(eventId) as MemoryEventRow | undefined
    if (!event) return
    const existing = parseEffectIds(event.effect_ids)
    if (!existing.includes(effectId)) {
      existing.push(effectId)
      this.db
        .prepare('UPDATE novel_memory_events SET effect_ids = ? WHERE id = ?')
        .run(JSON.stringify(existing), eventId)
    }
    // 反向维护 effectId 的 cause（不覆盖已有值）
    const effectEvent = this.db
      .prepare('SELECT * FROM novel_memory_events WHERE id = ?')
      .get(effectId) as MemoryEventRow | undefined
    if (effectEvent && !effectEvent.cause) {
      this.db.prepare('UPDATE novel_memory_events SET cause = ? WHERE id = ?').run(eventId, effectId)
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 快照（情景记忆：章节状态快照）
  // ═══════════════════════════════════════════════════════════════

  /** 保存章节快照 */
  saveSnapshot(snapshot: Omit<MemorySnapshot, 'id' | 'createdAt'>): MemorySnapshot {
    const full: MemorySnapshot = {
      ...snapshot,
      id: randomUUID(),
      createdAt: now(),
    }
    this.db.prepare(`
      INSERT INTO novel_memory_snapshots
      (id, project_id, chapter_number, snapshot_type, entity_id, snapshot_data, created_at)
      VALUES (@id, @project_id, @chapter_number, @snapshot_type, @entity_id, @snapshot_data, @created_at)
    `).run({
      id: full.id,
      project_id: full.projectId,
      chapter_number: full.chapterNumber,
      snapshot_type: full.snapshotType,
      entity_id: full.entityId,
      snapshot_data: full.snapshotData,
      created_at: full.createdAt,
    })
    return full
  }

  /** 获取某章的状态快照（按类型/实体过滤，返回最新一条） */
  getSnapshot(
    projectId: string,
    chapterNumber: number,
    options?: GetSnapshotOptions,
  ): MemorySnapshot | undefined {
    const conditions = ['project_id = ?', 'chapter_number = ?']
    const params: unknown[] = [projectId, chapterNumber]
    if (options?.snapshotType) {
      conditions.push('snapshot_type = ?')
      params.push(options.snapshotType)
    }
    if (options?.entityId) {
      conditions.push('entity_id = ?')
      params.push(options.entityId)
    }
    const sql = `SELECT * FROM novel_memory_snapshots WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 1`
    const row = this.db.prepare(sql).get(...params) as MemorySnapshotRow | undefined
    return row ? this.rowToSnapshot(row) : undefined
  }

  /** 获取所有快照 */
  listSnapshots(projectId: string, options?: ListSnapshotsOptions): MemorySnapshot[] {
    const conditions = ['project_id = ?']
    const params: unknown[] = [projectId]
    if (options?.chapterNumber !== undefined) {
      conditions.push('chapter_number = ?')
      params.push(options.chapterNumber)
    }
    if (options?.snapshotType) {
      conditions.push('snapshot_type = ?')
      params.push(options.snapshotType)
    }
    const sql = `SELECT * FROM novel_memory_snapshots WHERE ${conditions.join(' AND ')} ORDER BY chapter_number ASC`
    const rows = this.db.prepare(sql).all(...params) as MemorySnapshotRow[]
    return rows.map((r) => this.rowToSnapshot(r))
  }

  // ═══════════════════════════════════════════════════════════════
  // 行 → 对象 转换方法
  // ═══════════════════════════════════════════════════════════════

  private rowToEvent(row: MemoryEventRow): MemoryEvent {
    return {
      id: row.id,
      projectId: row.project_id,
      chapterId: row.chapter_id,
      chapterNumber: row.chapter_number,
      eventType: row.event_type as MemoryEventType,
      entityId: row.entity_id,
      entityType: row.entity_type as MemoryEntityType,
      description: row.description,
      oldValue: row.old_value,
      newValue: row.new_value,
      cause: row.cause,
      effectIds: parseEffectIds(row.effect_ids),
      significance: row.significance,
      createdAt: row.created_at,
    }
  }

  private rowToSnapshot(row: MemorySnapshotRow): MemorySnapshot {
    return {
      id: row.id,
      projectId: row.project_id,
      chapterNumber: row.chapter_number,
      snapshotType: row.snapshot_type as MemorySnapshotType,
      entityId: row.entity_id,
      snapshotData: row.snapshot_data,
      createdAt: row.created_at,
    }
  }
}
