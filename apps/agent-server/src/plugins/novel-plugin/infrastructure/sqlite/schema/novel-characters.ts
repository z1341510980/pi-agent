import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const novelCharacters = sqliteTable('novel_characters', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  gender: text('gender'),
  identity: text('identity').notNull(),
  personality: text('personality').notNull(),
  appearance: text('appearance').notNull(),
  currentState: text('current_state').notNull(),
  currentGoal: text('current_goal').notNull(),
  currentPressure: text('current_pressure').notNull(),
  secret: text('secret').notNull(),
  arcStage: text('arc_stage').notNull(),
  arcHistory: text('arc_history').notNull(),
  speechStyle: text('speech_style').notNull(),
  isProtagonist: integer('is_protagonist').notNull(),
  longTermDesire: text('long_term_desire').notNull(),
  plotRole: text('plot_role').notNull(),
  removalImpact: text('removal_impact').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const novelRelationships = sqliteTable('novel_relationships', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  characterA: text('character_a').notNull(),
  characterB: text('character_b').notNull(),
  relationType: text('relation_type').notNull(),
  currentStage: text('current_stage').notNull(),
  stageHistory: text('stage_history').notNull(),
  dynamicRole: text('dynamic_role').notNull(),
  alignment: text('alignment').notNull(),
  trend: text('trend').notNull(),
  chapterHint: text('chapter_hint').notNull(),
  lastUpdatedChapter: integer('last_updated_chapter'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export type NovelCharactersRow = typeof novelCharacters.$inferSelect
export type NovelCharactersInsert = typeof novelCharacters.$inferInsert
export type NovelRelationshipsRow = typeof novelRelationships.$inferSelect
export type NovelRelationshipsInsert = typeof novelRelationships.$inferInsert
