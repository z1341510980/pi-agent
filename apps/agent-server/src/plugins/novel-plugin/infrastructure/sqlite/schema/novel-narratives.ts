import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const novelNarratives = sqliteTable('novel_narratives', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  description: text('description').notNull(),
  type: text('type').notNull(),
  chapterSpans: text('chapter_spans').notNull(),
  status: text('status').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export type NovelNarrativesRow = typeof novelNarratives.$inferSelect
export type NovelNarrativesInsert = typeof novelNarratives.$inferInsert
