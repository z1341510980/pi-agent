import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

export const novelChapterPlanRevisions = sqliteTable('novel_chapter_plan_revisions', {
  id: text('id').primaryKey(), chapterId: text('chapter_id').notNull(), projectId: text('project_id').notNull(),
  creationRunId: text('creation_run_id'), supersedesId: text('supersedes_id'), baseContentRevisionId: text('base_content_revision_id'),
  positioning: text('positioning'), rhythm: text('rhythm'), budget: text('budget').notNull(), status: text('status').notNull(),
  revision: integer('revision').notNull(), idempotencyKey: text('idempotency_key'), createdAt: integer('created_at').notNull(),
})

export const novelScenes = sqliteTable('novel_scenes', {
  id: text('id').primaryKey(), chapterId: text('chapter_id').notNull(), projectId: text('project_id').notNull(), stableKey: text('stable_key').notNull(), createdAt: integer('created_at').notNull(),
}, (table) => ({ chapterStableKeyUnique: unique('novel_scenes_chapter_stable_key').on(table.chapterId, table.stableKey) }))

export const novelSceneRevisions = sqliteTable('novel_scene_revisions', {
  id: text('id').primaryKey(), sceneId: text('scene_id').notNull(), chapterId: text('chapter_id').notNull(), projectId: text('project_id').notNull(), planRevisionId: text('plan_revision_id').notNull(), contentRevisionId: text('content_revision_id'), supersedesId: text('supersedes_id'), orderNo: integer('order_no').notNull(), title: text('title').notNull(), goal: text('goal').notNull(), summary: text('summary').notNull(), locationText: text('location_text').notNull(), timeText: text('time_text').notNull(), povMode: text('pov_mode').notNull(), povCharacterId: text('pov_character_id'), targetWords: integer('target_words').notNull(), status: text('status').notNull(), createdAt: integer('created_at').notNull(),
})

export const novelSceneCast = sqliteTable('novel_scene_cast', {
  sceneRevisionId: text('scene_revision_id').notNull(), characterId: text('character_id').notNull(), role: text('role').notNull(), function: text('function'), prominence: text('prominence'), note: text('note'),
}, (table) => ({ castUnique: unique('novel_scene_cast_revision_character_role').on(table.sceneRevisionId, table.characterId, table.role) }))

export type NovelChapterPlanRevisionsRow = typeof novelChapterPlanRevisions.$inferSelect
export type NovelChapterPlanRevisionsInsert = typeof novelChapterPlanRevisions.$inferInsert
export type NovelScenesRow = typeof novelScenes.$inferSelect
export type NovelScenesInsert = typeof novelScenes.$inferInsert
export type NovelSceneRevisionsRow = typeof novelSceneRevisions.$inferSelect
export type NovelSceneRevisionsInsert = typeof novelSceneRevisions.$inferInsert
export type NovelSceneCastRow = typeof novelSceneCast.$inferSelect
export type NovelSceneCastInsert = typeof novelSceneCast.$inferInsert
