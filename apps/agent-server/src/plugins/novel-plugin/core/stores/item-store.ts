/**
 * ItemStore - 物品实体的 CRUD 操作
 *
 * 追踪角色拥有的关键物品（玉佩、冲击钻、法器、钥匙等），
 * 用于跨章节一致性（物品在哪章获得、哪章使用、当前在谁手里）和
 * 提示词注入（让 Agent 知道本章出场角色拥有什么物品）。
 *
 * 设计参考：FactionStore（同样的 Row → Entity 转换模式 + deleteEdgesByEntity 清理）
 */
import type Database from 'better-sqlite3'
import type { NovelItem } from '../types.js'
import type { ItemRow } from './row-types.js'
import { now, parseChapterSpans } from './store-utils.js'

export class ItemStore {
  private readonly stmtListItems: Database.Statement

  constructor(
    private db: Database.Database,
    private deleteEdgesByEntity: (entityId: string) => number,
  ) {
    this.stmtListItems = db.prepare('SELECT * FROM novel_items WHERE project_id = ? ORDER BY created_at ASC')
  }

  listItems(projectId: string): NovelItem[] {
    return (this.stmtListItems.all(projectId) as ItemRow[]).map((r) => this.rowToItem(r))
  }

  getItem(itemId: string): NovelItem | undefined {
    const row = this.db.prepare('SELECT * FROM novel_items WHERE id = ?').get(itemId) as ItemRow | undefined
    return row ? this.rowToItem(row) : undefined
  }

  /**
   * 查询指定角色拥有的所有物品
   * 用于提示词注入"主角拥有什么物品"
   */
  listItemsByOwner(ownerId: string): NovelItem[] {
    const rows = this.db.prepare('SELECT * FROM novel_items WHERE owner_id = ? ORDER BY created_at ASC').all(ownerId) as ItemRow[]
    return rows.map((r) => this.rowToItem(r))
  }

  createItem(item: Omit<NovelItem, 'createdAt' | 'updatedAt'>): NovelItem {
    const ts = now()
    const full: NovelItem = { ...item, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_items (id, project_id, name, description, type, owner_id, status,
      abilities, origin, first_chapter, chapter_spans, created_at, updated_at)
      VALUES (@id, @project_id, @name, @description, @type, @owner_id, @status,
      @abilities, @origin, @first_chapter, @chapter_spans, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, name: full.name, description: full.description,
      type: full.type, owner_id: full.ownerId, status: full.status,
      abilities: full.abilities, origin: full.origin, first_chapter: full.firstChapter,
      chapter_spans: JSON.stringify(full.chapterSpans),
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateItem(id: string, patch: Partial<NovelItem>): NovelItem | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_items WHERE id = ?').get(id) as ItemRow | undefined
    if (!existing) return undefined
    const current = this.rowToItem(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_items SET name=@name, description=@description, type=@type, owner_id=@owner_id,
      status=@status, abilities=@abilities, origin=@origin, first_chapter=@first_chapter,
      chapter_spans=@chapter_spans, updated_at=@updated_at WHERE id=@id
    `).run({
      id, name: updated.name, description: updated.description, type: updated.type,
      owner_id: updated.ownerId, status: updated.status, abilities: updated.abilities,
      origin: updated.origin, first_chapter: updated.firstChapter,
      chapter_spans: JSON.stringify(updated.chapterSpans),
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteItem(id: string): boolean {
    this.deleteEdgesByEntity(id)
    const result = this.db.prepare('DELETE FROM novel_items WHERE id = ?').run(id)
    return result.changes > 0
  }

  private rowToItem(row: ItemRow): NovelItem {
    return {
      id: row.id, projectId: row.project_id, name: row.name, description: row.description,
      type: row.type as NovelItem['type'], ownerId: row.owner_id,
      status: row.status as NovelItem['status'],
      abilities: row.abilities, origin: row.origin, firstChapter: row.first_chapter,
      chapterSpans: parseChapterSpans(row.chapter_spans),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }
}
