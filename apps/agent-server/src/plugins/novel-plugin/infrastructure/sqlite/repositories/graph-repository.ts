import { and, asc, eq, isNull, or } from 'drizzle-orm'
import type { NovelDrizzleDb } from '../client.js'
import {
  novelEdges,
  novelMarkers,
  novelNodePositions,
  type NovelEdgesInsert,
  type NovelEdgesRow,
  type NovelMarkersInsert,
  type NovelMarkersRow,
  type NovelNodePositionsInsert,
  type NovelNodePositionsRow,
} from '../schema/novel-graph.js'
import type { EdgeRow, MarkerRow, NodePositionRow } from '../../../core/stores/row-types.js'
import type { AuthorIntentRow, ChapterReviewRow } from '../../../core/stores/row-types.js'
import { asc as ascending, desc as descending } from 'drizzle-orm'
import { novelAuthorIntents, novelChapterReviews, novelContextSectionMetrics, type NovelAuthorIntentsInsert, type NovelChapterReviewsInsert, type NovelContextSectionMetricsInsert, type NovelContextSectionMetricsRow } from '../schema/novel-reviews.js'

/** GraphStore 基础 CRUD 的 ORM seam；派生边、图算法和跨实体清理仍属于领域层。 */
export class GraphRepository {
  constructor(private readonly db: NovelDrizzleDb) {}

  listMarkers(projectId: string): MarkerRow[] {
    return this.db.select().from(novelMarkers)
      .where(eq(novelMarkers.projectId, projectId))
      .orderBy(asc(novelMarkers.chapter), asc(novelMarkers.createdAt)).all().map(toMarkerRow)
  }

  getMarker(id: string): MarkerRow | undefined {
    const row = this.db.select().from(novelMarkers).where(eq(novelMarkers.id, id)).get()
    return row ? toMarkerRow(row) : undefined
  }

  insertMarker(row: MarkerRow): void {
    this.db.insert(novelMarkers).values(toMarkerInsert(row)).run()
  }

  updateMarker(id: string, row: MarkerRow): boolean {
    return this.db.update(novelMarkers).set({
      chapter: row.chapter, title: row.title, note: row.note, type: row.type, color: row.color,
      entityType: row.entity_type, entityId: row.entity_id, updatedAt: row.updated_at,
    }).where(eq(novelMarkers.id, id)).run().changes > 0
  }

  deleteMarker(id: string): boolean {
    return this.db.delete(novelMarkers).where(eq(novelMarkers.id, id)).run().changes > 0
  }

  listEdges(projectId: string): EdgeRow[] {
    return this.db.select().from(novelEdges).where(eq(novelEdges.projectId, projectId))
      .orderBy(asc(novelEdges.createdAt)).all().map(toEdgeRow)
  }

  insertEdge(row: EdgeRow): void {
    this.db.insert(novelEdges).values(toEdgeInsert(row)).run()
  }

  getEdge(id: string): EdgeRow | undefined {
    const row = this.db.select().from(novelEdges).where(eq(novelEdges.id, id)).get()
    return row ? toEdgeRow(row) : undefined
  }

  deleteEdge(id: string): boolean {
    return this.db.delete(novelEdges).where(eq(novelEdges.id, id)).run().changes > 0
  }

  deleteEdgesByEntity(entityId: string): number {
    return this.db.delete(novelEdges)
      .where(or(eq(novelEdges.sourceId, entityId), eq(novelEdges.targetId, entityId))).run().changes
  }

  listEdgesByEntity(entityId: string, opts?: { direction?: 'source' | 'target' | 'both'; edgeType?: string }): EdgeRow[] {
    const direction = opts?.direction ?? 'both'
    const edgeType = opts?.edgeType
    const rows: NovelEdgesRow[] = []
    if (direction === 'source' || direction === 'both') {
      const where = edgeType
        ? and(eq(novelEdges.sourceId, entityId), eq(novelEdges.edgeType, edgeType))
        : eq(novelEdges.sourceId, entityId)
      rows.push(...this.db.select().from(novelEdges).where(where)
        .orderBy(asc(novelEdges.createdAt)).all())
    }
    if (direction === 'target' || direction === 'both') {
      const where = edgeType
        ? and(eq(novelEdges.targetId, entityId), eq(novelEdges.edgeType, edgeType))
        : eq(novelEdges.targetId, entityId)
      rows.push(...this.db.select().from(novelEdges).where(where)
        .orderBy(asc(novelEdges.createdAt)).all())
    }
    const seen = new Set<string>()
    return rows.filter((row) => !seen.has(row.id) && (seen.add(row.id), true)).map(toEdgeRow)
  }

  updateEdgeLabel(id: string, label: string, updatedAt: number): EdgeRow | undefined {
    const existing = this.getEdge(id)
    if (!existing) return undefined
    const changed = this.db.update(novelEdges).set({ label, updatedAt })
      .where(eq(novelEdges.id, id)).run().changes > 0
    return changed ? { ...existing, label, updated_at: updatedAt } : undefined
  }

  listNodePositions(projectId: string): NodePositionRow[] {
    return this.db.select().from(novelNodePositions).where(eq(novelNodePositions.projectId, projectId))
      .orderBy(asc(novelNodePositions.updatedAt)).all().map(toNodePositionRow)
  }

  upsertNodePosition(row: NodePositionRow): void {
    this.db.insert(novelNodePositions).values(toNodePositionInsert(row)).onConflictDoUpdate({
      target: [novelNodePositions.projectId, novelNodePositions.nodeType, novelNodePositions.entityId],
      set: { id: row.id, posX: row.pos_x, posY: row.pos_y, updatedAt: row.updated_at },
    }).run()
  }

  deleteNodePosition(projectId: string, nodeType: string, entityId: string): boolean {
    return this.db.delete(novelNodePositions).where(and(
      eq(novelNodePositions.projectId, projectId),
      eq(novelNodePositions.nodeType, nodeType),
      eq(novelNodePositions.entityId, entityId),
    )).run().changes > 0
  }

  insertContextMetrics(rows: NovelContextSectionMetricsInsert[]): void { if (rows.length) this.db.insert(novelContextSectionMetrics).values(rows).run() }
  listContextMetrics(projectId: string, chapterNumber?: number): NovelContextSectionMetricsRow[] { const where = chapterNumber == null ? eq(novelContextSectionMetrics.projectId, projectId) : and(eq(novelContextSectionMetrics.projectId, projectId), eq(novelContextSectionMetrics.chapterNumber, chapterNumber)); return this.db.select().from(novelContextSectionMetrics).where(where).orderBy(ascending(novelContextSectionMetrics.createdAt)).all() }
  insertAuthorIntent(row: AuthorIntentRow): void { const value: NovelAuthorIntentsInsert = { id: row.id, projectId: row.project_id, chapterId: row.chapter_id, intentType: row.intent_type, description: row.description, targetEntityId: row.target_entity_id, createdAt: row.created_at }; this.db.insert(novelAuthorIntents).values(value).run() }
  insertChapterReview(row: ChapterReviewRow): void { const value: NovelChapterReviewsInsert = { id: row.id, projectId: row.project_id, chapterId: row.chapter_id, contentRevisionId: row.content_revision_id, contentHash: row.content_hash, consistencyScore: row.consistency_score, characterScore: row.character_score, taskCompletionScore: row.task_completion_score, clueProgressScore: row.clue_progress_score, foreshadowStatusScore: row.foreshadow_status_score, conflictChangeScore: row.conflict_change_score, pacingScore: row.pacing_score, infoControlScore: row.info_control_score, readerHookScore: row.reader_hook_score, styleScore: row.style_score, overallScore: row.overall_score, verdict: row.verdict, issues: row.issues, suggestions: row.suggestions, reviewedBy: row.reviewed_by, createdAt: row.created_at }; this.db.insert(novelChapterReviews).values(value).run() }
  getLatestChapterReview(chapterId: string): ChapterReviewRow | undefined { const row = this.db.select().from(novelChapterReviews).where(eq(novelChapterReviews.chapterId, chapterId)).orderBy(descending(novelChapterReviews.createdAt), descending(novelChapterReviews.id)).limit(1).get(); return row ? toReviewRow(row) : undefined }
  getAcceptedChapterReview(chapterId: string, contentHash: string): ChapterReviewRow | undefined { const row = this.db.select().from(novelChapterReviews).where(and(eq(novelChapterReviews.chapterId, chapterId), eq(novelChapterReviews.contentHash, contentHash), eq(novelChapterReviews.verdict, 'accept'))).orderBy(descending(novelChapterReviews.createdAt), descending(novelChapterReviews.id)).limit(1).get(); return row ? toReviewRow(row) : undefined }
  bindChapterReviews(chapterId: string, contentHash: string, revisionId: string): number { return this.db.update(novelChapterReviews).set({ contentRevisionId: revisionId }).where(and(eq(novelChapterReviews.chapterId, chapterId), eq(novelChapterReviews.contentHash, contentHash), isNull(novelChapterReviews.contentRevisionId))).run().changes }
}

function toMarkerInsert(row: MarkerRow): NovelMarkersInsert {
  return {
    id: row.id, projectId: row.project_id, chapter: row.chapter, title: row.title, note: row.note,
    type: row.type, color: row.color, entityType: row.entity_type, entityId: row.entity_id,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function toMarkerRow(row: NovelMarkersRow): MarkerRow {
  return {
    id: row.id, project_id: row.projectId, chapter: row.chapter, title: row.title, note: row.note,
    type: row.type, color: row.color, entity_type: row.entityType, entity_id: row.entityId,
    created_at: row.createdAt, updated_at: row.updatedAt,
  }
}

function toEdgeInsert(row: EdgeRow): NovelEdgesInsert {
  return {
    id: row.id, projectId: row.project_id, sourceId: row.source_id, sourceType: row.source_type,
    targetId: row.target_id, targetType: row.target_type, edgeType: row.edge_type, label: row.label,
    auto: row.auto, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function toEdgeRow(row: NovelEdgesRow): EdgeRow {
  return {
    id: row.id, project_id: row.projectId, source_id: row.sourceId, source_type: row.sourceType,
    target_id: row.targetId, target_type: row.targetType, edge_type: row.edgeType, label: row.label,
    auto: row.auto, created_at: row.createdAt, updated_at: row.updatedAt,
  }
}

function toNodePositionInsert(row: NodePositionRow): NovelNodePositionsInsert {
  return {
    id: row.id, projectId: row.project_id, nodeType: row.node_type, entityId: row.entity_id,
    posX: row.pos_x, posY: row.pos_y, updatedAt: row.updated_at,
  }
}

function toNodePositionRow(row: NovelNodePositionsRow): NodePositionRow {
  return {
    id: row.id, project_id: row.projectId, node_type: row.nodeType, entity_id: row.entityId,
    pos_x: row.posX, pos_y: row.posY, updated_at: row.updatedAt,
  }
}

function toReviewRow(row: typeof novelChapterReviews.$inferSelect): ChapterReviewRow { return { id: row.id, project_id: row.projectId, chapter_id: row.chapterId, content_revision_id: row.contentRevisionId, content_hash: row.contentHash, consistency_score: row.consistencyScore, character_score: row.characterScore, task_completion_score: row.taskCompletionScore, clue_progress_score: row.clueProgressScore, foreshadow_status_score: row.foreshadowStatusScore, conflict_change_score: row.conflictChangeScore, pacing_score: row.pacingScore, info_control_score: row.infoControlScore, reader_hook_score: row.readerHookScore, style_score: row.styleScore, overall_score: row.overallScore, verdict: row.verdict, issues: row.issues, suggestions: row.suggestions, reviewed_by: row.reviewedBy, created_at: row.createdAt } }
