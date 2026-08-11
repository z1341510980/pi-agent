/**
 * EntityAppearanceStore：实体出场关系统一（P2）
 *
 * 把散落在各实体表 chapter_spans 的"章节出场"横切面抽成独立关联表
 * novel_entity_appearances：可索引、可按章/实体查询、可独立追踪。
 *
 * 写入仅在 appearanceV2Write 开启时由三入口双写（ai-arrange 落库 /
 * Memory applyChanges / syncChapterDimensions）；读取由 appearanceV2Read
 * 控制。默认全部关闭 = 完全保持旧 chapter_spans 行为。
 */
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export type AppearanceRole = 'present' | 'advance' | 'mention' | 'plant' | 'reinforce' | 'recover'
export type AppearanceSource = 'ai-arrange' | 'memory' | 'sync' | 'manual' | 'frozen-redirect'

export interface EntityAppearanceRow {
  id: string
  project_id: string
  chapter_id: string
  entity_type: string
  entity_id: string
  appearance_role: string
  source: string
  created_at: number
}

export class EntityAppearanceStore {
  constructor(private db: Database.Database) {}

  /**
   * 记录一批实体在本章的出场（幂等：UNIQUE 约束防重）。
   * 只写不删——出场是累积事实；如需回滚用 removeChapterAppearances。
   */
  addChapterAppearances(input: {
    projectId: string
    chapterId: string
    entityType: string
    entityIds: string[]
    role?: AppearanceRole
    source?: AppearanceSource
  }): number {
    const { projectId, chapterId, entityType, entityIds, role = 'present', source = 'sync' } = input
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO novel_entity_appearances
        (id, project_id, chapter_id, entity_type, entity_id, appearance_role, source, created_at)
      VALUES (@id, @project_id, @chapter_id, @entity_type, @entity_id, @appearance_role, @source, @created_at)
    `)
    const ts = Date.now()
    let count = 0
    for (const entityId of entityIds) {
      const result = insert.run({
        id: randomUUID(),
        project_id: projectId,
        chapter_id: chapterId,
        entity_type: entityType,
        entity_id: entityId,
        appearance_role: role,
        source,
        created_at: ts,
      })
      count += result.changes
    }
    return count
  }

  /** 某章的所有出场实体（按类型分组键） */
  listByChapter(projectId: string, chapterId: string): Array<{
    entityType: string
    entityId: string
    role: string
  }> {
    const rows = this.db.prepare(
      'SELECT entity_type, entity_id, appearance_role FROM novel_entity_appearances WHERE project_id = ? AND chapter_id = ?',
    ).all(projectId, chapterId) as Array<{ entity_type: string; entity_id: string; appearance_role: string }>
    return rows.map((r) => ({ entityType: r.entity_type, entityId: r.entity_id, role: r.appearance_role }))
  }

  /** 某实体的出场章节列表 */
  listByEntity(projectId: string, entityType: string, entityId: string): string[] {
    const rows = this.db.prepare(
      'SELECT chapter_id FROM novel_entity_appearances WHERE project_id = ? AND entity_type = ? AND entity_id = ?',
    ).all(projectId, entityType, entityId) as Array<{ chapter_id: string }>
    return rows.map((r) => r.chapter_id)
  }

  /** 删除某章的全部出场（用于对账后清理或重写回滚） */
  removeChapterAppearances(projectId: string, chapterId: string): number {
    return this.db.prepare(
      'DELETE FROM novel_entity_appearances WHERE project_id = ? AND chapter_id = ?',
    ).run(projectId, chapterId).changes
  }

  /** 删除某实体的全部出场（实体删除时级联清理） */
  removeEntityAppearances(projectId: string, entityType: string, entityId: string): number {
    return this.db.prepare(
      'DELETE FROM novel_entity_appearances WHERE project_id = ? AND entity_type = ? AND entity_id = ?',
    ).run(projectId, entityType, entityId).changes
  }
}
