import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const novelConflicts = sqliteTable('novel_conflicts', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  description: text('description').notNull(),
  type: text('type').notNull(),
  intensity: integer('intensity').notNull(),
  stage: text('stage').notNull(),
  participants: text('participants').notNull(),
  tier: text('tier').notNull(),
  chapterSpans: text('chapter_spans'),
  plotFunction: text('plot_function'),
  progressionMode: text('progression_mode'),
  currentStep: text('current_step').notNull(),
  nextStep: text('next_step').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export type NovelConflictsRow = typeof novelConflicts.$inferSelect
export type NovelConflictsInsert = typeof novelConflicts.$inferInsert
