import { and, asc, count, desc, eq, ne, sql } from 'drizzle-orm'
import type { NovelDrizzleDb } from '../client.js'
import {
  novelEntityAppearances,
  novelEntityCandidatePromotions,
  novelEntityCandidateReviews,
  novelEntityCandidates,
  novelProjectionOutbox,
  type NovelEntityAppearancesInsert,
  type NovelEntityAppearancesRow,
  type NovelEntityCandidateReviewsInsert,
  type NovelEntityCandidatesInsert,
  type NovelEntityCandidatesRow,
  type NovelProjectionOutboxInsert,
} from '../schema/novel-workflows.js'

export interface EntityAppearanceRow {
  id: string
  project_id: string
  chapter_id: string
  entity_type: string
  entity_id: string
  appearance_role: string
  source: string
  created_at: number
  status: string
}

export interface EntityCandidateRow {
  id: string
  project_id: string
  chapter_number: number | null
  content_revision_id: string | null
  entity_type: string
  payload: string
  status: string
  reason_code: string | null
  created_at: number
}

export interface EntityCandidateReviewRow {
  id: string
  candidate_id: string
  decision: string
  reason: string
  actor_id: string
  audit_context: string
  created_at: number
}

/** 出场记录、候选审核和晋升 outbox 的基础持久化 seam。 */
export class WorkflowRepository {
  constructor(private readonly db: NovelDrizzleDb) {}

  addAppearance(row: EntityAppearanceRow): number {
    return this.db.insert(novelEntityAppearances).values(toAppearanceInsert(row)).onConflictDoUpdate({
      target: [novelEntityAppearances.chapterId, novelEntityAppearances.entityType, novelEntityAppearances.entityId, novelEntityAppearances.appearanceRole],
      set: { status: 'active', source: row.source, createdAt: row.created_at },
    }).run().changes
  }

  listAppearancesByChapter(projectId: string, chapterId: string): Array<{ entityType: string; entityId: string; role: string }> {
    return this.db.select({ entityType: novelEntityAppearances.entityType, entityId: novelEntityAppearances.entityId, role: novelEntityAppearances.appearanceRole })
      .from(novelEntityAppearances)
      .where(and(eq(novelEntityAppearances.projectId, projectId), eq(novelEntityAppearances.chapterId, chapterId), eq(novelEntityAppearances.status, 'active')))
      .all()
  }

  listAppearancesByEntity(projectId: string, entityType: string, entityId: string): string[] {
    return this.db.select({ chapterId: novelEntityAppearances.chapterId }).from(novelEntityAppearances)
      .where(and(eq(novelEntityAppearances.projectId, projectId), eq(novelEntityAppearances.entityType, entityType), eq(novelEntityAppearances.entityId, entityId), eq(novelEntityAppearances.status, 'active')))
      .all().map((row) => row.chapterId)
  }

  removeChapterAppearances(projectId: string, chapterId: string): number {
    return this.db.delete(novelEntityAppearances).where(and(eq(novelEntityAppearances.projectId, projectId), eq(novelEntityAppearances.chapterId, chapterId))).run().changes
  }

  removeEntityAppearances(projectId: string, entityType: string, entityId: string): number {
    return this.db.delete(novelEntityAppearances).where(and(eq(novelEntityAppearances.projectId, projectId), eq(novelEntityAppearances.entityType, entityType), eq(novelEntityAppearances.entityId, entityId))).run().changes
  }

  removeChapterEntityAppearances(projectId: string, chapterId: string, entityType: string, entityId: string): number {
    return this.db.delete(novelEntityAppearances).where(and(eq(novelEntityAppearances.projectId, projectId), eq(novelEntityAppearances.chapterId, chapterId), eq(novelEntityAppearances.entityType, entityType), eq(novelEntityAppearances.entityId, entityId))).run().changes
  }

  insertCandidate(row: EntityCandidateRow): void { this.db.insert(novelEntityCandidates).values(toCandidateInsert(row)).run() }
  getCandidate(id: string): EntityCandidateRow | undefined { const row = this.db.select().from(novelEntityCandidates).where(eq(novelEntityCandidates.id, id)).get(); return row ? toCandidateRow(row) : undefined }
  listCandidates(projectId: string, status?: string): EntityCandidateRow[] {
    const where = status ? and(eq(novelEntityCandidates.projectId, projectId), eq(novelEntityCandidates.status, status)) : and(eq(novelEntityCandidates.projectId, projectId), ne(novelEntityCandidates.status, 'stale'))
    // created_at is second precision for compatibility with the legacy store;
    // use SQLite's insertion rowid as the deterministic tie-breaker.
    return this.db.select().from(novelEntityCandidates).where(where).orderBy(desc(novelEntityCandidates.createdAt), sql`rowid DESC`).all().map(toCandidateRow)
  }
  countPending(projectId: string): number { return this.db.select({ count: count() }).from(novelEntityCandidates).where(and(eq(novelEntityCandidates.projectId, projectId), eq(novelEntityCandidates.status, 'needs_review'))).get()?.count ?? 0 }
  updateCandidateStatus(id: string, status: string): boolean { return this.db.update(novelEntityCandidates).set({ status }).where(eq(novelEntityCandidates.id, id)).run().changes > 0 }
  insertReview(row: EntityCandidateReviewRow): void { this.db.insert(novelEntityCandidateReviews).values(toReviewInsert(row)).run() }
  listReviews(candidateId: string): EntityCandidateReviewRow[] { return this.db.select().from(novelEntityCandidateReviews).where(eq(novelEntityCandidateReviews.candidateId, candidateId)).orderBy(asc(novelEntityCandidateReviews.createdAt), asc(novelEntityCandidateReviews.id)).all().map(toReviewRow) }
  insertPromotion(candidateId: string, entityType: string, entityId: string, createdAt: number): void { this.db.insert(novelEntityCandidatePromotions).values({ candidateId, entityType, entityId, createdAt }).run() }
  insertOutbox(row: NovelProjectionOutboxInsert): void { this.db.insert(novelProjectionOutbox).values(row).onConflictDoNothing().run() }
}

function toAppearanceInsert(row: EntityAppearanceRow): NovelEntityAppearancesInsert { return { id: row.id, projectId: row.project_id, chapterId: row.chapter_id, entityType: row.entity_type, entityId: row.entity_id, appearanceRole: row.appearance_role, source: row.source, createdAt: row.created_at, status: row.status } }
function toCandidateInsert(row: EntityCandidateRow): NovelEntityCandidatesInsert { return { id: row.id, projectId: row.project_id, chapterNumber: row.chapter_number, contentRevisionId: row.content_revision_id, entityType: row.entity_type, payload: row.payload, status: row.status, reasonCode: row.reason_code, createdAt: row.created_at } }
function toCandidateRow(row: NovelEntityCandidatesRow): EntityCandidateRow { return { id: row.id, project_id: row.projectId, chapter_number: row.chapterNumber, content_revision_id: row.contentRevisionId, entity_type: row.entityType, payload: row.payload, status: row.status, reason_code: row.reasonCode, created_at: row.createdAt } }
function toReviewInsert(row: EntityCandidateReviewRow): NovelEntityCandidateReviewsInsert { return { id: row.id, candidateId: row.candidate_id, decision: row.decision, reason: row.reason, actorId: row.actor_id, auditContext: row.audit_context, createdAt: row.created_at } }
function toReviewRow(row: typeof novelEntityCandidateReviews.$inferSelect): EntityCandidateReviewRow { return { id: row.id, candidate_id: row.candidateId, decision: row.decision, reason: row.reason, actor_id: row.actorId, audit_context: row.auditContext, created_at: row.createdAt } }
