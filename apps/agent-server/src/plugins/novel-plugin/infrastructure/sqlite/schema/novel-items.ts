import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * 物品持久化映射。
 *
 * 列名必须与现有 SQLite schema 保持一致；领域层的 camelCase 映射位于
 * `repositories/item-repository.ts`，避免把数据库命名泄漏给调用方。
 */
export const novelItems = sqliteTable('novel_items', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  type: text('type').notNull(),
  ownerId: text('owner_id'),
  status: text('status').notNull(),
  abilities: text('abilities').notNull(),
  origin: text('origin').notNull(),
  firstChapter: integer('first_chapter'),
  chapterSpans: text('chapter_spans').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export type NovelItemsRow = typeof novelItems.$inferSelect
export type NovelItemsInsert = typeof novelItems.$inferInsert
