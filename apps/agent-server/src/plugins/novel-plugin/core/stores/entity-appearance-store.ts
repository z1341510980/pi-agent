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
import type { AppearanceReconcileReport } from '../migration-acceptance.js'

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

  /** 删除某实体在某章的出场（手工编辑 spans 收窄时的双写同步） */
  removeChapterEntityAppearances(projectId: string, chapterId: string, entityType: string, entityId: string): number {
    return this.db.prepare(
      'DELETE FROM novel_entity_appearances WHERE project_id = ? AND chapter_id = ? AND entity_type = ? AND entity_id = ?',
    ).run(projectId, chapterId, entityType, entityId).changes
  }

  /**
   * P2 对账（store 层）：实体表 spans 展开 vs appearance 表记录。
   *
   * 口径与 scripts/novel-migration-tools/reconcile-entity-appearances.mjs 一致，
   * 供迁移任务在进程内产出 MigrationAcceptance 形态验收报告；CLI 脚本仍保留
   * 用于真实库的独立复核。只读，不修改任何数据；rollbackVerified 恒为 false。
   */
  reconcileAppearances(projectId: string): AppearanceReconcileReport {
    const entityTables = [
      { type: 'conflict', table: 'novel_conflicts', spanCol: 'chapter_spans' },
      { type: 'foreshadow', table: 'novel_foreshadowing', spanCol: 'chapter_spans' },
      { type: 'clue', table: 'novel_clues', spanCol: 'chapter_spans' },
      { type: 'faction', table: 'novel_factions', spanCol: 'chapter_spans' },
      { type: 'location', table: 'novel_locations', spanCol: 'appear_chapters' },
      { type: 'item', table: 'novel_items', spanCol: 'chapter_spans' },
      { type: 'narrative', table: 'novel_narratives', spanCol: 'chapter_spans' },
    ] as const

    // 章节号映射 + 已落库章节号集合
    const chapterRows = this.db.prepare(
      'SELECT id, chapter_number FROM novel_chapters WHERE project_id = ?',
    ).all(projectId) as Array<{ id: string; chapter_number: number }>
    const numberById = new Map(chapterRows.map((c) => [c.id, c.chapter_number]))
    const persistedNumbers = new Set(chapterRows.map((c) => c.chapter_number))

    let sourceRows = 0
    let checkedEntities = 0
    let unpersistedRefs = 0
    let mismatchRows = 0
    const details: AppearanceReconcileReport['details'] = []

    for (const { type, table, spanCol } of entityTables) {
      const rows = this.db.prepare(
        `SELECT id, ${spanCol} AS spans FROM ${table} WHERE project_id = ?`,
      ).all(projectId) as Array<{ id: string; spans: string | null }>
      for (const row of rows) {
        const spanChapters = expandAppearanceSpans(row.spans)
        if (spanChapters.size === 0) continue
        checkedEntities += 1

        // 未落库章节（规划超前）单独统计，不算 mismatch
        const persisted = new Set<number>()
        for (const ch of spanChapters) {
          if (persistedNumbers.has(ch)) persisted.add(ch)
          else unpersistedRefs += 1
        }
        if (persisted.size === 0) continue
        sourceRows += persisted.size

        // appearance 侧：该实体已记录的章节号
        const appRows = this.db.prepare(
          'SELECT chapter_id FROM novel_entity_appearances WHERE project_id = ? AND entity_type = ? AND entity_id = ?',
        ).all(projectId, type, row.id) as Array<{ chapter_id: string }>
        const appChapters = new Set(
          appRows.map((a) => numberById.get(a.chapter_id)).filter((n): n is number => n !== undefined),
        )

        const missing = [...persisted].filter((ch) => !appChapters.has(ch)).sort((a, b) => a - b)
        const extra = [...appChapters].filter((ch) => !persisted.has(ch)).sort((a, b) => a - b)
        if (missing.length > 0 || extra.length > 0) {
          mismatchRows += 1
          if (details.length < 100) {
            details.push({ entityType: type, entityId: row.id, missingChapters: missing, extraChapters: extra })
          }
        }
      }
    }

    const scopedTypes = entityTables.map((t) => t.type)

    // 目标侧行数（限定 7 类实体；character 出场走 character_history，不在此口径）
    const targetRows = (this.db.prepare(`
      SELECT COUNT(*) AS c FROM novel_entity_appearances
      WHERE project_id = ? AND entity_type IN (${scopedTypes.map(() => '?').join(', ')})
    `).get(projectId, ...scopedTypes) as { c: number }).c

    // 孤儿出场：指向已不存在的实体
    const orphanRows = (this.db.prepare(`
      SELECT COUNT(*) AS c FROM novel_entity_appearances a
      WHERE a.project_id = ? AND NOT EXISTS (
        SELECT 1 FROM novel_conflicts x WHERE x.id = a.entity_id AND a.entity_type = 'conflict'
      ) AND NOT EXISTS (
        SELECT 1 FROM novel_foreshadowing x WHERE x.id = a.entity_id AND a.entity_type = 'foreshadow'
      ) AND NOT EXISTS (
        SELECT 1 FROM novel_clues x WHERE x.id = a.entity_id AND a.entity_type = 'clue'
      ) AND NOT EXISTS (
        SELECT 1 FROM novel_factions x WHERE x.id = a.entity_id AND a.entity_type = 'faction'
      ) AND NOT EXISTS (
        SELECT 1 FROM novel_locations x WHERE x.id = a.entity_id AND a.entity_type = 'location'
      ) AND NOT EXISTS (
        SELECT 1 FROM novel_items x WHERE x.id = a.entity_id AND a.entity_type = 'item'
      ) AND NOT EXISTS (
        SELECT 1 FROM novel_narratives x WHERE x.id = a.entity_id AND a.entity_type = 'narrative'
      )
    `).get(projectId) as { c: number }).c

    // 重复出场（UNIQUE 约束下应为 0；冗余行数 = Σ(count-1)）
    const dupRows = this.db.prepare(`
      SELECT COUNT(*) - 1 AS redundant FROM novel_entity_appearances
      WHERE project_id = ?
      GROUP BY entity_type, entity_id, chapter_id
      HAVING COUNT(*) > 1
    `).all(projectId) as Array<{ redundant: number }>
    const duplicateRows = dupRows.reduce((sum, r) => sum + r.redundant, 0)

    return {
      sourceRows,
      targetRows,
      mismatchRows,
      orphanRows,
      duplicateRows,
      rollbackVerified: false,
      checkedEntities,
      unpersistedRefs,
      details,
    }
  }
}

/**
 * 展开实体表 spans JSON 为章节号集合。
 * 兼容两种形态：区间数组 [[start,end],...]（conflict/foreshadow/clue/faction/item/narrative）
 * 与扁平章节号数组 [n,...]（location.appear_chapters）。
 */
function expandAppearanceSpans(spansJson: string | null): Set<number> {
  const out = new Set<number>()
  if (!spansJson) return out
  try {
    const parsed: unknown = JSON.parse(spansJson)
    if (!Array.isArray(parsed)) return out
    for (const item of parsed) {
      if (typeof item === 'number') {
        if (Number.isInteger(item) && item >= 1) out.add(item)
      } else if (Array.isArray(item)) {
        const [start, end] = item
        if (!Number.isInteger(start) || !Number.isInteger(end)) continue
        for (let ch = start; ch <= end; ch += 1) out.add(ch)
      }
    }
    return out
  } catch {
    return out
  }
}
