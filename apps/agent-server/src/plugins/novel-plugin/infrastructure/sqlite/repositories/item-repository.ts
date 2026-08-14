import { asc, eq } from 'drizzle-orm'
import type { NovelDrizzleDb } from '../client.js'
import { novelItems, type NovelItemsInsert, type NovelItemsRow } from '../schema/novel-items.js'
import type { ItemRow } from '../../../core/stores/row-types.js'

/**
 * ItemStore 使用的持久化 seam。
 * Repository 只负责查询、写入和 snake_case 行映射，不承担边清理等领域规则。
 */
export class ItemRepository {
  constructor(private readonly db: NovelDrizzleDb) {}

  listByProject(projectId: string): ItemRow[] {
    return this.db
      .select()
      .from(novelItems)
      .where(eq(novelItems.projectId, projectId))
      .orderBy(asc(novelItems.createdAt))
      .all()
      .map(toRow)
  }

  getById(itemId: string): ItemRow | undefined {
    const row = this.db.select().from(novelItems).where(eq(novelItems.id, itemId)).get()
    return row ? toRow(row) : undefined
  }

  listByOwner(ownerId: string): ItemRow[] {
    return this.db
      .select()
      .from(novelItems)
      .where(eq(novelItems.ownerId, ownerId))
      .orderBy(asc(novelItems.createdAt))
      .all()
      .map(toRow)
  }

  insert(row: ItemRow): void {
    this.db.insert(novelItems).values(toInsert(row)).run()
  }

  update(id: string, row: ItemRow): boolean {
    const result = this.db
      .update(novelItems)
      .set({
        name: row.name,
        description: row.description,
        type: row.type,
        ownerId: row.owner_id,
        status: row.status,
        abilities: row.abilities,
        origin: row.origin,
        firstChapter: row.first_chapter,
        chapterSpans: row.chapter_spans,
        updatedAt: row.updated_at,
      })
      .where(eq(novelItems.id, id))
      .run()
    return result.changes > 0
  }

  delete(id: string): boolean {
    const result = this.db.delete(novelItems).where(eq(novelItems.id, id)).run()
    return result.changes > 0
  }
}

function toInsert(row: ItemRow): NovelItemsInsert {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    type: row.type,
    ownerId: row.owner_id,
    status: row.status,
    abilities: row.abilities,
    origin: row.origin,
    firstChapter: row.first_chapter,
    chapterSpans: row.chapter_spans,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toRow(row: NovelItemsRow): ItemRow {
  return {
    id: row.id,
    project_id: row.projectId,
    name: row.name,
    description: row.description,
    type: row.type,
    owner_id: row.ownerId,
    status: row.status,
    abilities: row.abilities,
    origin: row.origin,
    first_chapter: row.firstChapter,
    chapter_spans: row.chapterSpans,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}
