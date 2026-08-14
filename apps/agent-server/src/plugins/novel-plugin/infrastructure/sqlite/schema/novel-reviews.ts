import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const novelContextSectionMetrics = sqliteTable('novel_context_section_metrics', {
  id: text('id').primaryKey(), agentLogId: text('agent_log_id').notNull(), projectId: text('project_id').notNull(), chapterNumber: integer('chapter_number').notNull(), agentType: text('agent_type').notNull(), sectionType: text('section_type').notNull(), sectionId: text('section_id').notNull(), chars: integer('chars').notNull(), estimatedTokens: integer('estimated_tokens').notNull(), sourceHash: text('source_hash').notNull(), mode: text('mode').notNull(), createdAt: integer('created_at').notNull(),
})

export const novelAuthorIntents = sqliteTable('novel_author_intents', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull(), chapterId: text('chapter_id'), intentType: text('intent_type').notNull(), description: text('description').notNull(), targetEntityId: text('target_entity_id'), createdAt: integer('created_at').notNull(),
})

export const novelChapterReviews = sqliteTable('novel_chapter_reviews', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull(), chapterId: text('chapter_id').notNull(), contentRevisionId: text('content_revision_id'), contentHash: text('content_hash').notNull(), consistencyScore: real('consistency_score'), characterScore: real('character_score'), taskCompletionScore: real('task_completion_score'), clueProgressScore: real('clue_progress_score'), foreshadowStatusScore: real('foreshadow_status_score'), conflictChangeScore: real('conflict_change_score'), pacingScore: real('pacing_score'), infoControlScore: real('info_control_score'), readerHookScore: real('reader_hook_score'), styleScore: real('style_score'), overallScore: real('overall_score'), verdict: text('verdict'), issues: text('issues'), suggestions: text('suggestions'), reviewedBy: text('reviewed_by'), createdAt: integer('created_at').notNull(),
})

export type NovelContextSectionMetricsRow = typeof novelContextSectionMetrics.$inferSelect
export type NovelContextSectionMetricsInsert = typeof novelContextSectionMetrics.$inferInsert
export type NovelAuthorIntentsInsert = typeof novelAuthorIntents.$inferInsert
export type NovelChapterReviewsRow = typeof novelChapterReviews.$inferSelect
export type NovelChapterReviewsInsert = typeof novelChapterReviews.$inferInsert
