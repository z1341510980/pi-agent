import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const novelFactions = sqliteTable('novel_factions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  type: text('type').notNull(),
  leaderId: text('leader_id'),
  ideology: text('ideology').notNull(),
  strength: text('strength').notNull(),
  resources: text('resources').notNull(),
  allies: text('allies').notNull(),
  enemies: text('enemies').notNull(),
  status: text('status').notNull(),
  chapterSpans: text('chapter_spans'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const novelLocations = sqliteTable('novel_locations', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  type: text('type').notNull(),
  parentId: text('parent_id'),
  factionId: text('faction_id'),
  significance: text('significance').notNull(),
  firstChapter: integer('first_chapter'),
  status: text('status').notNull(),
  appearChapters: text('appear_chapters').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export type NovelFactionsRow = typeof novelFactions.$inferSelect
export type NovelFactionsInsert = typeof novelFactions.$inferInsert
export type NovelLocationsRow = typeof novelLocations.$inferSelect
export type NovelLocationsInsert = typeof novelLocations.$inferInsert
