import { desc, eq, isNotNull, isNull, and } from 'drizzle-orm'
import type { NovelDrizzleDb } from '../client.js'
import { novelProjects, type NovelProjectsInsert, type NovelProjectsRow } from '../schema/novel-projects.js'
import type { ProjectRow } from '../../../core/stores/row-types.js'

export class ProjectRepository {
  constructor(private readonly db: NovelDrizzleDb) {}

  getActive(id: string): ProjectRow | undefined {
    const row = this.db.select().from(novelProjects).where(eq(novelProjects.id, id)).get()
    return row && row.deletedAt == null ? toRow(row) : undefined
  }

  listActive(): ProjectRow[] {
    return this.db.select().from(novelProjects).where(isNull(novelProjects.deletedAt))
      .orderBy(desc(novelProjects.updatedAt)).all().map(toRow)
  }

  listTrashed(): ProjectRow[] {
    return this.db.select().from(novelProjects).where(isNotNull(novelProjects.deletedAt))
      .orderBy(desc(novelProjects.deletedAt)).all().map(toRow)
  }

  insert(row: ProjectRow): void {
    this.db.insert(novelProjects).values(toInsert(row)).run()
  }

  update(id: string, row: ProjectRow): boolean {
    const result = this.db.update(novelProjects).set({
      title: row.title, genre: row.genre, synopsis: row.synopsis, outline: row.outline,
      targetWords: row.target_words, currentVolume: row.current_volume, currentChapter: row.current_chapter,
      currentStage: row.current_stage, status: row.status, updatedAt: row.updated_at,
      targetPlatform: row.target_platform, novelAskStoryPolicy: row.novel_ask_story_policy,
      featureFlags: row.feature_flags, novelModelId: row.novel_model_id,
    }).where(eq(novelProjects.id, id)).run()
    return result.changes > 0
  }

  softDelete(id: string, timestamp: number): boolean {
    const result = this.db.update(novelProjects).set({ deletedAt: timestamp, updatedAt: timestamp })
      .where(and(eq(novelProjects.id, id), isNull(novelProjects.deletedAt))).run()
    return result.changes > 0
  }

  restore(id: string, timestamp: number): boolean {
    const result = this.db.update(novelProjects).set({ deletedAt: null, updatedAt: timestamp })
      .where(and(eq(novelProjects.id, id), isNotNull(novelProjects.deletedAt))).run()
    return result.changes > 0
  }

  updateNovelModelId(id: string, modelId: string | null, timestamp: number): boolean {
    const result = this.db.update(novelProjects)
      .set({ novelModelId: modelId, updatedAt: timestamp })
      .where(and(eq(novelProjects.id, id), isNull(novelProjects.deletedAt))).run()
    return result.changes > 0
  }
}

function toInsert(row: ProjectRow): NovelProjectsInsert {
  return {
    id: row.id, title: row.title, genre: row.genre, synopsis: row.synopsis, outline: row.outline,
    targetWords: row.target_words, currentVolume: row.current_volume, currentChapter: row.current_chapter,
    currentStage: row.current_stage, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    targetPlatform: row.target_platform, novelAskStoryPolicy: row.novel_ask_story_policy,
    featureFlags: row.feature_flags, novelModelId: row.novel_model_id, deletedAt: row.deleted_at,
  }
}

function toRow(row: NovelProjectsRow): ProjectRow {
  return {
    id: row.id, title: row.title, genre: row.genre, synopsis: row.synopsis, outline: row.outline,
    target_words: row.targetWords, current_volume: row.currentVolume, current_chapter: row.currentChapter,
    current_stage: row.currentStage, status: row.status, created_at: row.createdAt, updated_at: row.updatedAt,
    deleted_at: row.deletedAt, target_platform: row.targetPlatform, novel_ask_story_policy: row.novelAskStoryPolicy,
    feature_flags: row.featureFlags, novel_model_id: row.novelModelId,
  }
}
