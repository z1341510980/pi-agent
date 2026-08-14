import { and, asc, count, countDistinct, desc, eq, gte, inArray, ne } from 'drizzle-orm'
import type { NovelDrizzleDb } from '../client.js'
import { novelStorylineProgress, novelStorylines, type NovelStorylineProgressInsert, type NovelStorylineProgressRow, type NovelStorylinesInsert, type NovelStorylinesRow } from '../schema/novel-ledger.js'
import { novelChapters } from '../schema/novel-chapters.js'
import { novelSceneRevisions, novelScenes } from '../schema/novel-scene-plan.js'

export interface StorylineRow { id: string; project_id: string; name: string; kind: string; lifecycle: string; maturity: string; description: string; created_at: number; updated_at: number }
export interface ProgressRow { id: string; project_id: string; storyline_id: string; scene_revision_id: string; primary_flag: number; type: string; before_state: string; after_state: string; summary: string; status: string; created_at: number }

/** 叙事账本的单表读写；成熟度规则和场景重写范围仍由领域 Store 编排。 */
export class LedgerRepository {
  constructor(private readonly db: NovelDrizzleDb) {}
  getStorylineByName(projectId: string, name: string): StorylineRow | undefined { const row = this.db.select().from(novelStorylines).where(and(eq(novelStorylines.projectId, projectId), eq(novelStorylines.name, name))).get(); return row ? toStorylineRow(row) : undefined }
  getStoryline(id: string): StorylineRow | undefined { const row = this.db.select().from(novelStorylines).where(eq(novelStorylines.id, id)).get(); return row ? toStorylineRow(row) : undefined }
  listStorylines(projectId: string): StorylineRow[] { return this.db.select().from(novelStorylines).where(eq(novelStorylines.projectId, projectId)).orderBy(asc(novelStorylines.createdAt)).all().map(toStorylineRow) }
  insertStoryline(row: StorylineRow): void { this.db.insert(novelStorylines).values(toStorylineInsert(row)).run() }
  updateStoryline(id: string, row: StorylineRow): boolean { return this.db.update(novelStorylines).set({ lifecycle: row.lifecycle, maturity: row.maturity, description: row.description, updatedAt: row.updated_at }).where(eq(novelStorylines.id, id)).run().changes > 0 }
  countConfirmedScenes(storylineId: string): number { return this.db.select({ count: countDistinct(novelStorylineProgress.sceneRevisionId) }).from(novelStorylineProgress).where(and(eq(novelStorylineProgress.storylineId, storylineId), eq(novelStorylineProgress.status, 'confirmed'))).get()?.count ?? 0 }
  listProgressByStoryline(storylineId: string, statuses?: string[]): ProgressRow[] { const where = statuses?.length ? and(eq(novelStorylineProgress.storylineId, storylineId), inArray(novelStorylineProgress.status, statuses)) : eq(novelStorylineProgress.storylineId, storylineId); return this.db.select().from(novelStorylineProgress).where(where).orderBy(asc(novelStorylineProgress.createdAt)).all().map(toProgressRow) }
  listProgressByScene(sceneRevisionId: string, includeStale: boolean): ProgressRow[] { const where = includeStale ? eq(novelStorylineProgress.sceneRevisionId, sceneRevisionId) : and(eq(novelStorylineProgress.sceneRevisionId, sceneRevisionId), ne(novelStorylineProgress.status, 'stale')); return this.db.select().from(novelStorylineProgress).where(where).orderBy(asc(novelStorylineProgress.createdAt)).all().map(toProgressRow) }
  getProgress(id: string): ProgressRow | undefined { const row = this.db.select().from(novelStorylineProgress).where(eq(novelStorylineProgress.id, id)).get(); return row ? toProgressRow(row) : undefined }
  getProgressBySceneAndStoryline(sceneRevisionId: string, storylineId: string): ProgressRow | undefined { const row = this.db.select().from(novelStorylineProgress).where(and(eq(novelStorylineProgress.sceneRevisionId, sceneRevisionId), eq(novelStorylineProgress.storylineId, storylineId))).get(); return row ? toProgressRow(row) : undefined }
  insertProgress(row: ProgressRow): void { this.db.insert(novelStorylineProgress).values(toProgressInsert(row)).run() }
  updateProgressStatus(id: string, status: string): boolean { return this.db.update(novelStorylineProgress).set({ status }).where(eq(novelStorylineProgress.id, id)).run().changes > 0 }
  markStaleFromChapter(projectId: string, chapterId: string): number {
    const chapter = this.db.select({ chapterNumber: novelChapters.chapterNumber }).from(novelChapters)
      .where(and(eq(novelChapters.id, chapterId), eq(novelChapters.projectId, projectId))).get()
    if (!chapter) return 0
    const revisions = this.db.select({ id: novelSceneRevisions.id }).from(novelSceneRevisions)
      .innerJoin(novelScenes, eq(novelSceneRevisions.sceneId, novelScenes.id))
      .innerJoin(novelChapters, eq(novelScenes.chapterId, novelChapters.id))
      .where(and(eq(novelChapters.projectId, projectId), gte(novelChapters.chapterNumber, chapter.chapterNumber))).all()
      .map((row) => row.id)
    if (revisions.length === 0) return 0
    this.db.update(novelStorylineProgress).set({ status: 'stale' }).where(and(
      eq(novelStorylineProgress.projectId, projectId), eq(novelStorylineProgress.status, 'confirmed'), inArray(novelStorylineProgress.sceneRevisionId, revisions),
    )).run()
    return this.db.select({ count: count() }).from(novelStorylineProgress).where(and(
      eq(novelStorylineProgress.projectId, projectId), eq(novelStorylineProgress.status, 'stale'), inArray(novelStorylineProgress.sceneRevisionId, revisions),
    )).get()?.count ?? 0
  }
}
function toStorylineInsert(row: StorylineRow): NovelStorylinesInsert { return { id: row.id, projectId: row.project_id, name: row.name, kind: row.kind, lifecycle: row.lifecycle, maturity: row.maturity, description: row.description, createdAt: row.created_at, updatedAt: row.updated_at } }
function toStorylineRow(row: NovelStorylinesRow): StorylineRow { return { id: row.id, project_id: row.projectId, name: row.name, kind: row.kind, lifecycle: row.lifecycle, maturity: row.maturity, description: row.description, created_at: row.createdAt, updated_at: row.updatedAt } }
function toProgressInsert(row: ProgressRow): NovelStorylineProgressInsert { return { id: row.id, projectId: row.project_id, storylineId: row.storyline_id, sceneRevisionId: row.scene_revision_id, primaryFlag: row.primary_flag, type: row.type, beforeState: row.before_state, afterState: row.after_state, summary: row.summary, status: row.status, createdAt: row.created_at } }
function toProgressRow(row: NovelStorylineProgressRow): ProgressRow { return { id: row.id, project_id: row.projectId, storyline_id: row.storylineId, scene_revision_id: row.sceneRevisionId, primary_flag: row.primaryFlag, type: row.type, before_state: row.beforeState, after_state: row.afterState, summary: row.summary, status: row.status, created_at: row.createdAt } }
