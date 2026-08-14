/**
 * memory-operation-ledger：Memory 操作审计（P2 T02-6；2026-08-12 逻辑统一：恒开启）
 *
 * 与 StoryEvent 语义账本（novel_memory_events）分工：
 * - 旧表记录"故事发生了什么"（title/summary/outcome/cause/significance/dimension），
 *   仍被矩阵与 story-context 消费；
 * - 本表记录"系统执行了什么"（create/update/link/unlink + before/after JSON + reason），
 *   供操作审计与补偿，不承载故事语义。
 *
 * 一致性：operation 与实体写入必须同事务。applyChanges 把操作收集进内存列表，
 * 提交时（同一 SQLite 事务）写 run + operations；失败时 run 标记 failed。
 */
import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'

export type MemoryOperationType = 'create' | 'update' | 'link' | 'unlink'

export interface MemoryOperationRecord {
  seq: number
  operation: MemoryOperationType
  targetType: string
  targetId: string
  relatedType?: string
  relatedId?: string
  beforeJson?: string | null
  afterJson?: string | null
  reason?: string
}

export interface MemoryOperationRunInput {
  projectId: string
  chapterId?: string | null
  source: string
  payloadHash: string
}

/** 事务内的审计写入器（run 与 operations 作为一个原子结果提交） */
export class MemoryOperationLedger {
  private runId: string | null = null

  constructor(
    private readonly db: Database,
    private readonly runInput: MemoryOperationRunInput,
    private readonly now = Date.now(),
  ) {}

  /** 追加一条操作（内存累积，不立即落库） */
  push(op: Omit<MemoryOperationRecord, 'seq'>): void {
    this.ops.push({ ...op, seq: this.ops.length + 1 })
  }

  get count(): number {
    return this.ops.length
  }

  private ops: MemoryOperationRecord[] = []

  /** 与实体写在调用方事务内调用：原子写入 run、operations 与 committed 状态。 */
  commit(): void {
    this.ensureRun()
    if (this.ops.length > 0) {
      const insertOp = this.db.prepare(`
        INSERT INTO novel_memory_operations
          (id, run_id, seq, operation, target_type, target_id, related_type, related_id,
           before_json, after_json, reason, created_at)
        VALUES
          (@id, @run_id, @seq, @operation, @target_type, @target_id, @related_type, @related_id,
           @before_json, @after_json, @reason, @created_at)
      `)
      for (const op of this.ops) {
        insertOp.run({
          id: randomUUID(),
          run_id: this.runId,
          seq: op.seq,
          operation: op.operation,
          target_type: op.targetType,
          target_id: op.targetId,
          related_type: op.relatedType ?? null,
          related_id: op.relatedId ?? null,
          before_json: op.beforeJson ?? null,
          after_json: op.afterJson ?? null,
          reason: op.reason ?? null,
          created_at: this.now,
        })
      }
    }
    this.db.prepare(`
      UPDATE novel_memory_operation_runs
      SET status = 'committed', committed_at = ?
      WHERE id = ?
    `).run(this.now, this.runId)
  }

  /** 实体或审计写入失败时由外层调用，在回滚后的新事务中持久化失败 run。 */
  markFailed(error: string): void {
    // The entity transaction may have rolled back the run created by commit().
    // Re-checking here makes failure durable instead of updating a stale id.
    this.ensureRun()
    this.db.prepare(`
      UPDATE novel_memory_operation_runs
      SET status = 'failed', error = ?, committed_at = NULL
      WHERE id = ?
    `).run(error.slice(0, 2000), this.runId)
  }

  private ensureRun(): void {
    if (this.runId) {
      const existing = this.db.prepare(
        'SELECT 1 FROM novel_memory_operation_runs WHERE id = ?',
      ).get(this.runId)
      if (existing) return
      this.runId = null
    }
    this.runId = randomUUID()
    this.db.prepare(`
      INSERT INTO novel_memory_operation_runs
        (id, project_id, chapter_id, source, payload_hash, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'applying', ?)
    `).run(
      this.runId,
      this.runInput.projectId,
      this.runInput.chapterId ?? null,
      this.runInput.source,
      this.runInput.payloadHash,
      this.now,
    )
  }
}
