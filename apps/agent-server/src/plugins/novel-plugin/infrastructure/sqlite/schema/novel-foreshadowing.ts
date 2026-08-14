import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const novelForeshadowing = sqliteTable('novel_foreshadowing', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  description: text('description').notNull(),
  category: text('category').notNull(),
  status: text('status').notNull(),
  firstChapter: integer('first_chapter'),
  lastChapter: integer('last_chapter'),
  recoverByChapter: integer('recover_by_chapter'),
  plantMethod: text('plant_method'),
  recoverMethod: text('recover_method'),
  chapterSpans: text('chapter_spans'),
  beats: text('beats'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const novelClues = sqliteTable('novel_clues', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  description: text('description').notNull(),
  pointsTo: text('points_to').notNull(),
  progress: integer('progress').notNull(),
  currentStep: text('current_step').notNull(),
  nextStep: text('next_step').notNull(),
  isMisleading: integer('is_misleading').notNull(),
  chapterSpans: text('chapter_spans'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const novelInformationLayers = sqliteTable('novel_information_layers', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  infoDescription: text('info_description').notNull(),
  authorKnows: integer('author_knows').notNull(),
  readerKnows: integer('reader_knows').notNull(),
  characterKnowledge: text('character_knowledge').notNull(),
  revealStage: text('reveal_stage'),
  revealChapter: integer('reveal_chapter'),
  isRevealed: integer('is_revealed').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export type NovelForeshadowingRow = typeof novelForeshadowing.$inferSelect
export type NovelForeshadowingInsert = typeof novelForeshadowing.$inferInsert
export type NovelCluesRow = typeof novelClues.$inferSelect
export type NovelCluesInsert = typeof novelClues.$inferInsert
export type NovelInformationLayersRow = typeof novelInformationLayers.$inferSelect
export type NovelInformationLayersInsert = typeof novelInformationLayers.$inferInsert
