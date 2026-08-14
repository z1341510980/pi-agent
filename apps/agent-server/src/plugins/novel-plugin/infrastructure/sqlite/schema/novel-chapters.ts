import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const novelChapters = sqliteTable('novel_chapters', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull(), volume: integer('volume').notNull(), chapterNumber: integer('chapter_number').notNull(), title: text('title').notNull(), content: text('content').notNull(), wordCount: integer('word_count').notNull(), status: text('status').notNull(), narrativeTask: text('narrative_task').notNull(), acceptanceResult: text('acceptance_result'), outline: text('outline').notNull(), volumeId: text('volume_id'), tension: integer('tension'), positioning: text('positioning'), timeOffset: integer('time_offset'), chapterEndingHook: text('chapter_ending_hook'), recap: text('recap'), currentContentRevisionId: text('current_content_revision_id'), createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
})

export const novelChapterContentRevisions = sqliteTable('novel_chapter_content_revisions', {
  id: text('id').primaryKey(), chapterId: text('chapter_id').notNull(), projectId: text('project_id').notNull(), parentRevisionId: text('parent_revision_id'), revision: integer('revision').notNull(), content: text('content').notNull(), wordCount: integer('word_count').notNull(), phase: text('phase'), agentType: text('agent_type'), trigger: text('trigger'), status: text('status').notNull(), createdAt: integer('created_at').notNull(),
})

export type NovelChaptersRow = typeof novelChapters.$inferSelect
export type NovelChaptersInsert = typeof novelChapters.$inferInsert
export type NovelChapterContentRevisionsRow = typeof novelChapterContentRevisions.$inferSelect
export type NovelChapterContentRevisionsInsert = typeof novelChapterContentRevisions.$inferInsert

/** Chapter bounded-context support tables: volumes, hooks and character arcs. */
export const novelVolumes = sqliteTable('novel_volumes', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull(),
  volumeNumber: integer('volume_number').notNull(), title: text('title').notNull(),
  outline: text('outline').notNull(), sortOrder: integer('sort_order').notNull(),
  createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
})

export const novelHooks = sqliteTable('novel_hooks', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull(),
  chapterNumber: integer('chapter_number').notNull(), hookType: text('hook_type').notNull(),
  description: text('description').notNull(), status: text('status').notNull(),
  fulfilledAtChapter: integer('fulfilled_at_chapter'), fulfilledDescription: text('fulfilled_description'),
  createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
})

export const novelCharacterArcs = sqliteTable('novel_character_arcs', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull(),
  characterId: text('character_id').notNull(), arcType: text('arc_type').notNull(),
  currentStage: text('current_stage').notNull(), stageHistory: text('stage_history').notNull(),
  description: text('description'), createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
})

export type NovelVolumesRow = typeof novelVolumes.$inferSelect
export type NovelVolumesInsert = typeof novelVolumes.$inferInsert
export type NovelHooksRow = typeof novelHooks.$inferSelect
export type NovelHooksInsert = typeof novelHooks.$inferInsert
export type NovelCharacterArcsRow = typeof novelCharacterArcs.$inferSelect
export type NovelCharacterArcsInsert = typeof novelCharacterArcs.$inferInsert
