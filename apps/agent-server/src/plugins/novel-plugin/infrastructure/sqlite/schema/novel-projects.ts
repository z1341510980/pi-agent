import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const novelProjects = sqliteTable('novel_projects', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  genre: text('genre').notNull(),
  synopsis: text('synopsis').notNull(),
  outline: text('outline').notNull(),
  targetWords: integer('target_words').notNull(),
  currentVolume: integer('current_volume').notNull(),
  currentChapter: integer('current_chapter').notNull(),
  currentStage: text('current_stage').notNull(),
  status: text('status').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  targetPlatform: text('target_platform'),
  novelAskStoryPolicy: text('novel_ask_story_policy'),
  featureFlags: text('feature_flags').notNull(),
  novelModelId: text('novel_model_id'),
  deletedAt: integer('deleted_at'),
})

export type NovelProjectsRow = typeof novelProjects.$inferSelect
export type NovelProjectsInsert = typeof novelProjects.$inferInsert
