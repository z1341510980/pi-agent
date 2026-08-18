/**
 * NarrativeMatrixRebuildStore：剧情矩阵重投影 job（M2，方案 §7）。
 *
 * 当前矩阵投影是同步纯函数（buildNarrativeMatrix，无异步积压），因此 rebuild
 * 落一条可追踪 job + 完成事件即满足「可追踪 projection job」契约；projectionLag
 * 恒为 0，stale 由 sourceRevision/账本 stale 事实兜底。idempotencyKey 幂等去重。
 */
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export type NarrativeMatrixRebuildStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface NarrativeMatrixRebuild {
  id: string
  projectId: string
  status: NarrativeMatrixRebuildStatus
  revisionIds: string[]
  idempotencyKey: string | null
  sourceRevision: string | null
  projectionLag: number
  stale: boolean
  failedNodes: string[]
  error: string | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
}

export interface NarrativeMatrixRebuildEvent {
  id: string
  sequence: number
  type: string
  payload: Record<string, unknown>
  createdAt: number
}

interface RebuildRow {
  id: string
  project_id: string
  status: string
  revision_ids: string
  idempotency_key: string | null
  source_revision: string | null
  projection_lag: number
  stale: number
  failed_nodes: string
  error: string | null
  created_at: number
  started_at: number | null
  completed_at: number | null
}

export class NarrativeMatrixRebuildStore {
  constructor(private readonly db: Database.Database) {}

  createRebuild(projectId: string, revisionIds: string[], idempotencyKey?: string): NarrativeMatrixRebuild {
    if (idempotencyKey) {
      const existing = this.db.prepare(`
        SELECT * FROM novel_narrative_matrix_rebuilds WHERE project_id = ? AND idempotency_key = ?
      `).get(projectId, idempotencyKey) as RebuildRow | undefined
      if (existing) return this.rowToRebuild(existing)
    }
    const now = Date.now()
    const id = randomUUID()
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO novel_narrative_matrix_rebuilds
          (id, project_id, status, revision_ids, idempotency_key, created_at)
        VALUES (?, ?, 'queued', ?, ?, ?)
      `).run(id, projectId, JSON.stringify(revisionIds), idempotencyKey ?? null, now)
      this.appendEvent(id, 'rebuild_queued', { revisionIds }, now)
    })()
    return this.getRebuild(projectId, id)!
  }

  getRebuild(projectId: string, rebuildId: string): NarrativeMatrixRebuild | undefined {
    const row = this.db.prepare('SELECT * FROM novel_narrative_matrix_rebuilds WHERE id = ? AND project_id = ?').get(rebuildId, projectId) as RebuildRow | undefined
    return row ? this.rowToRebuild(row) : undefined
  }

  listEvents(projectId: string, rebuildId: string, afterSequence = 0): NarrativeMatrixRebuildEvent[] {
    if (!this.getRebuild(projectId, rebuildId)) return []
    const rows = this.db.prepare(`
      SELECT * FROM novel_narrative_matrix_rebuild_events
      WHERE rebuild_id = ? AND sequence_no > ? ORDER BY sequence_no ASC
    `).all(rebuildId, afterSequence) as Array<{ id: string; sequence_no: number; event_type: string; payload: string; created_at: number }>
    return rows.map((row) => ({
      id: row.id,
      sequence: row.sequence_no,
      type: row.event_type,
      payload: parseObject(row.payload),
      createdAt: row.created_at,
    }))
  }

  markRunning(projectId: string, rebuildId: string): void {
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare(`UPDATE novel_narrative_matrix_rebuilds SET status = 'running', started_at = ? WHERE id = ?`).run(now, rebuildId)
      this.appendEvent(rebuildId, 'rebuild_started', {}, now)
    })()
  }

  markCompleted(projectId: string, rebuildId: string, result: { sourceRevision: string; stale: boolean; failedNodes: string[] }): NarrativeMatrixRebuild {
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE novel_narrative_matrix_rebuilds
        SET status = 'completed', source_revision = ?, stale = ?, failed_nodes = ?, completed_at = ?
        WHERE id = ?
      `).run(result.sourceRevision, result.stale ? 1 : 0, JSON.stringify(result.failedNodes), now, rebuildId)
      this.appendEvent(rebuildId, 'rebuild_completed', { sourceRevision: result.sourceRevision, stale: result.stale }, now)
    })()
    return this.getRebuild(projectId, rebuildId)!
  }

  markFailed(projectId: string, rebuildId: string, error: string): NarrativeMatrixRebuild {
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare(`UPDATE novel_narrative_matrix_rebuilds SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`).run(error.slice(0, 2000), now, rebuildId)
      this.appendEvent(rebuildId, 'rebuild_failed', { error: error.slice(0, 2000) }, now)
    })()
    return this.getRebuild(projectId, rebuildId)!
  }

  private appendEvent(rebuildId: string, eventType: string, payload: Record<string, unknown>, createdAt: number): void {
    const next = this.db.prepare(`
      SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next FROM novel_narrative_matrix_rebuild_events WHERE rebuild_id = ?
    `).get(rebuildId) as { next: number }
    this.db.prepare(`
      INSERT INTO novel_narrative_matrix_rebuild_events (id, rebuild_id, sequence_no, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), rebuildId, next.next, eventType, JSON.stringify(payload), createdAt)
  }

  private rowToRebuild(row: RebuildRow): NarrativeMatrixRebuild {
    return {
      id: row.id,
      projectId: row.project_id,
      status: row.status as NarrativeMatrixRebuildStatus,
      revisionIds: parseStringArray(row.revision_ids),
      idempotencyKey: row.idempotency_key,
      sourceRevision: row.source_revision,
      projectionLag: row.projection_lag,
      stale: row.stale === 1,
      failedNodes: parseStringArray(row.failed_nodes),
      error: row.error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    }
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}