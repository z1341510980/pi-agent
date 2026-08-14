/**
 * EntityCandidateStore：Memory 新实体候选与审核（T04）。
 *
 * 用户已确认决策 3：Memory 无法匹配已有实体的新 Conflict/Clue 必须落为
 * `needs_review` 持久化候选并在前端展示，不得静默创建、不得自动晋升。
 * 用户确认后才晋升正式实体（confirm 由调用方执行晋升动作），拒绝必须带 reason。
 * 审核记录追加写、不可修改。
 */
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  NovelEntityCandidate,
  EntityCandidateStatus,
  EntityCandidateType,
  NovelEntityCandidateReview,
} from '../types.js'
import { createNovelDrizzleDb, WorkflowRepository } from '../../infrastructure/sqlite/index.js'
import type { EntityCandidateReviewRow, EntityCandidateRow } from '../../infrastructure/sqlite/repositories/workflow-repository.js'

export interface CreateCandidateInput {
  projectId: string
  chapterNumber?: number | null
  contentRevisionId?: string | null
  entityType: EntityCandidateType
  payload: unknown
  reasonCode?: string | null
}

export class EntityCandidateStore {
  private readonly repository: WorkflowRepository

  constructor(private db: Database.Database) {
    this.repository = new WorkflowRepository(createNovelDrizzleDb(db))
  }

  createCandidate(input: CreateCandidateInput): NovelEntityCandidate {
    const id = randomUUID()
    this.repository.insertCandidate({
      id, project_id: input.projectId, chapter_number: input.chapterNumber ?? null,
      content_revision_id: input.contentRevisionId ?? null, entity_type: input.entityType,
      payload: JSON.stringify(input.payload), status: 'needs_review', reason_code: input.reasonCode ?? null,
      created_at: Math.floor(Date.now() / 1000),
    })
    return this.getCandidate(id)!
  }

  getCandidate(id: string): NovelEntityCandidate | undefined {
    const row = this.repository.getCandidate(id)
    return row ? this.rowToCandidate(row) : undefined
  }

  /** 按项目 + 状态列出候选（降序，新的在前；同秒按 rowid 稳定） */
  listCandidates(projectId: string, status?: EntityCandidateStatus): NovelEntityCandidate[] {
    const rows = this.repository.listCandidates(projectId, status)
    return rows.map((r) => this.rowToCandidate(r))
  }

  /** 待审核候选数（供前端角标/提示） */
  countPending(projectId: string): number {
    return this.repository.countPending(projectId)
  }

  /**
   * 确认候选：needs_review → confirmed，追加审核记录。
   * 注意：晋升正式实体（createConflict/createClue）由调用方基于 payload 执行。
   */
  confirmCandidate(id: string, actorId = 'user'): NovelEntityCandidate {
    return this.confirmCandidateWithPromotion(id, actorId, () => null).candidate
  }

  /**
   * 确认候选并在同一事务内执行正式实体晋升。
   * 晋升回调抛错时，候选状态和审核记录都会随事务回滚。
   */
  confirmCandidateWithPromotion(
    id: string,
    actorId: string,
    promote: (candidate: NovelEntityCandidate) => string | null,
  ): { candidate: NovelEntityCandidate; entityId: string | null } {
    let confirmed: NovelEntityCandidate | undefined
    let entityId: string | null = null
    this.db.transaction(() => {
      const current = this.getCandidate(id)
      if (!current) throw new Error(`实体候选不存在: ${id}`)
      if (current.status !== 'needs_review') throw new Error(`候选状态 ${current.status} 不可确认`)
      entityId = promote(current)
      this.repository.updateCandidateStatus(id, 'confirmed')
      this.appendReview(id, 'confirmed', '', actorId, {
        before: 'needs_review',
        after: 'confirmed',
        chapterNumber: current.chapterNumber,
        sourceRevision: current.contentRevisionId,
      })
      if (entityId) {
        const createdAt = Math.floor(Date.now() / 1000)
        this.repository.insertPromotion(id, current.entityType, entityId, createdAt)
        this.repository.insertOutbox({
          id: randomUUID(), projectId: current.projectId, topic: 'entity-candidate.confirmed', aggregateId: id,
          payload: JSON.stringify({ candidateId: id, entityType: current.entityType, entityId, contentRevisionId: current.contentRevisionId }),
          status: 'pending', attempts: 0, createdAt,
        })
      }
      confirmed = this.getCandidate(id)
    })()
    return { candidate: confirmed!, entityId }
  }

  /** 拒绝候选：needs_review → rejected；reason 必填非空，带审计上下文 */
  rejectCandidate(id: string, reason: string, actorId = 'user'): NovelEntityCandidate {
    if (!reason || reason.trim() === '') throw new Error('拒绝候选必须提供非空 reason')
    const current = this.getCandidate(id)
    if (!current) throw new Error(`实体候选不存在: ${id}`)
    if (current.status !== 'needs_review') throw new Error(`候选状态 ${current.status} 不可拒绝`)
    this.db.transaction(() => {
      this.repository.updateCandidateStatus(id, 'rejected')
      this.appendReview(id, 'rejected', reason.trim(), actorId, {
        before: 'needs_review',
        after: 'rejected',
        chapterNumber: current.chapterNumber,
        sourceRevision: current.contentRevisionId,
      })
    })()
    return this.getCandidate(id)!
  }

  listReviews(candidateId: string): NovelEntityCandidateReview[] {
    const rows = this.repository.listReviews(candidateId)
    return rows.map((r) => this.rowToReview(r))
  }

  private appendReview(
    candidateId: string,
    decision: 'confirmed' | 'rejected',
    reason: string,
    actorId: string,
    auditContext: Record<string, unknown>,
  ): void {
    this.repository.insertReview({
      id: randomUUID(), candidate_id: candidateId, decision, reason, actor_id: actorId,
      audit_context: JSON.stringify(auditContext), created_at: Math.floor(Date.now() / 1000),
    })
  }

  private rowToCandidate(row: EntityCandidateRow): NovelEntityCandidate {
    return {
      id: row.id,
      projectId: row.project_id,
      chapterNumber: row.chapter_number,
      contentRevisionId: row.content_revision_id,
      entityType: row.entity_type as EntityCandidateType,
      payload: JSON.parse(row.payload) as unknown,
      status: row.status as EntityCandidateStatus,
      reasonCode: row.reason_code,
      createdAt: row.created_at,
    }
  }

  private rowToReview(row: EntityCandidateReviewRow): NovelEntityCandidateReview {
    return {
      id: row.id,
      candidateId: row.candidate_id,
      decision: row.decision as NovelEntityCandidateReview['decision'],
      reason: row.reason,
      actorId: row.actor_id,
      auditContext: JSON.parse(row.audit_context) as Record<string, unknown>,
      createdAt: row.created_at,
    }
  }
}
