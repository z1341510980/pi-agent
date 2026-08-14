import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

export const novelStorylines = sqliteTable('novel_storylines', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull(), name: text('name').notNull(),
  kind: text('kind').notNull(), lifecycle: text('lifecycle').notNull(), maturity: text('maturity').notNull(),
  description: text('description').notNull(), createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
}, (table) => ({ projectNameUnique: unique('novel_storylines_project_name').on(table.projectId, table.name) }))

export const novelStorylineProgress = sqliteTable('novel_storyline_progress', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull(), storylineId: text('storyline_id').notNull(),
  sceneRevisionId: text('scene_revision_id').notNull(), primaryFlag: integer('primary_flag').notNull(),
  type: text('type').notNull(), beforeState: text('before_state').notNull(), afterState: text('after_state').notNull(),
  summary: text('summary').notNull(), status: text('status').notNull(), createdAt: integer('created_at').notNull(),
}, (table) => ({ sceneStorylineUnique: unique('novel_storyline_progress_scene_storyline').on(table.sceneRevisionId, table.storylineId) }))

export type NovelStorylinesRow = typeof novelStorylines.$inferSelect
export type NovelStorylinesInsert = typeof novelStorylines.$inferInsert
export type NovelStorylineProgressRow = typeof novelStorylineProgress.$inferSelect
export type NovelStorylineProgressInsert = typeof novelStorylineProgress.$inferInsert
