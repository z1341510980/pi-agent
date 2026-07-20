/**
 * FactionStore - PR-5b 重构
 *
 * 从原 novel-store.ts 抽取 Faction + Location 相关的 CRUD 操作。
 * 负责势力（Faction）与地点（Location）两类实体的持久化，
 * 并在删除时通过 deleteEdgesByEntity 清理关联的 edges。
 */
import type Database from 'better-sqlite3'
import type { NovelFaction, NovelLocation } from '../types.js'
import type { FactionRow, LocationRow } from './row-types.js'
import { now, parseJSON, parseChapterSpans } from './store-utils.js'

export class FactionStore {
  private readonly stmtListFactions: Database.Statement
  private readonly stmtListLocations: Database.Statement

  constructor(
    private db: Database.Database,
    private deleteEdgesByEntity: (entityId: string) => number,
  ) {
    this.stmtListFactions = db.prepare('SELECT * FROM novel_factions WHERE project_id = ? ORDER BY created_at ASC')
    this.stmtListLocations = db.prepare('SELECT * FROM novel_locations WHERE project_id = ? ORDER BY created_at ASC')
  }

  listFactions(projectId: string): NovelFaction[] {
    return (this.stmtListFactions.all(projectId) as FactionRow[]).map((r) => this.rowToFaction(r))
  }

  getFaction(factionId: string): NovelFaction | undefined {
    const row = this.db.prepare('SELECT * FROM novel_factions WHERE id = ?').get(factionId) as FactionRow | undefined
    return row ? this.rowToFaction(row) : undefined
  }

  createFaction(faction: Omit<NovelFaction, 'createdAt' | 'updatedAt'>): NovelFaction {
    const ts = now()
    const full: NovelFaction = { ...faction, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_factions (id, project_id, name, description, type, leader_id, ideology,
      strength, resources, allies, enemies, status, first_chapter, last_chapter, chapter_spans, created_at, updated_at)
      VALUES (@id, @project_id, @name, @description, @type, @leader_id, @ideology,
      @strength, @resources, @allies, @enemies, @status, @first_chapter, @last_chapter, @chapter_spans, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, name: full.name, description: full.description,
      type: full.type, leader_id: full.leaderId, ideology: full.ideology,
      strength: full.strength, resources: JSON.stringify(full.resources),
      allies: JSON.stringify(full.allies), enemies: JSON.stringify(full.enemies),
      status: full.status,
      first_chapter: full.chapterSpans[0]?.[0] ?? null,
      last_chapter: full.chapterSpans[0]?.[1] ?? null,
      chapter_spans: JSON.stringify(full.chapterSpans),
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateFaction(id: string, patch: Partial<NovelFaction>): NovelFaction | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_factions WHERE id = ?').get(id) as FactionRow | undefined
    if (!existing) return undefined
    const current = this.rowToFaction(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_factions SET name=@name, description=@description, type=@type, leader_id=@leader_id,
      ideology=@ideology, strength=@strength, resources=@resources, allies=@allies, enemies=@enemies,
      status=@status, first_chapter=@first_chapter, last_chapter=@last_chapter, chapter_spans=@chapter_spans, updated_at=@updated_at WHERE id=@id
    `).run({
      id, name: updated.name, description: updated.description, type: updated.type,
      leader_id: updated.leaderId, ideology: updated.ideology, strength: updated.strength,
      resources: JSON.stringify(updated.resources), allies: JSON.stringify(updated.allies),
      enemies: JSON.stringify(updated.enemies), status: updated.status,
      first_chapter: updated.chapterSpans[0]?.[0] ?? null,
      last_chapter: updated.chapterSpans[0]?.[1] ?? null,
      chapter_spans: JSON.stringify(updated.chapterSpans),
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteFaction(id: string): boolean {
    this.deleteEdgesByEntity(id)
    const result = this.db.prepare('DELETE FROM novel_factions WHERE id = ?').run(id)
    return result.changes > 0
  }

  listLocations(projectId: string): NovelLocation[] {
    return (this.stmtListLocations.all(projectId) as LocationRow[]).map((r) => this.rowToLocation(r))
  }

  getLocation(locationId: string): NovelLocation | undefined {
    const row = this.db.prepare('SELECT * FROM novel_locations WHERE id = ?').get(locationId) as LocationRow | undefined
    return row ? this.rowToLocation(row) : undefined
  }

  createLocation(location: Omit<NovelLocation, 'createdAt' | 'updatedAt'>): NovelLocation {
    const ts = now()
    const full: NovelLocation = { ...location, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_locations (id, project_id, name, description, type, parent_id, faction_id,
      significance, first_chapter, status, appear_chapters, created_at, updated_at)
      VALUES (@id, @project_id, @name, @description, @type, @parent_id, @faction_id,
      @significance, @first_chapter, @status, @appear_chapters, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, name: full.name, description: full.description,
      type: full.type, parent_id: full.parentId, faction_id: full.factionId,
      significance: full.significance, first_chapter: full.firstChapter, status: full.status,
      appear_chapters: JSON.stringify(full.appearChapters),
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateLocation(id: string, patch: Partial<NovelLocation>): NovelLocation | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_locations WHERE id = ?').get(id) as LocationRow | undefined
    if (!existing) return undefined
    const current = this.rowToLocation(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_locations SET name=@name, description=@description, type=@type, parent_id=@parent_id,
      faction_id=@faction_id, significance=@significance, first_chapter=@first_chapter, status=@status,
      appear_chapters=@appear_chapters, updated_at=@updated_at WHERE id=@id
    `).run({
      id, name: updated.name, description: updated.description, type: updated.type,
      parent_id: updated.parentId, faction_id: updated.factionId, significance: updated.significance,
      first_chapter: updated.firstChapter, status: updated.status,
      appear_chapters: JSON.stringify(updated.appearChapters), updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteLocation(id: string): boolean {
    this.deleteEdgesByEntity(id)
    const result = this.db.prepare('DELETE FROM novel_locations WHERE id = ?').run(id)
    return result.changes > 0
  }

  private rowToFaction(row: FactionRow): NovelFaction {
    return {
      id: row.id, projectId: row.project_id, name: row.name, description: row.description,
      type: row.type as NovelFaction['type'], leaderId: row.leader_id, ideology: row.ideology,
      strength: row.strength as NovelFaction['strength'],
      resources: parseJSON<string[]>(row.resources, []),
      allies: parseJSON<string[]>(row.allies, []),
      enemies: parseJSON<string[]>(row.enemies, []),
      status: row.status as NovelFaction['status'],
      chapterSpans: parseChapterSpans(row.chapter_spans),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToLocation(row: LocationRow): NovelLocation {
    return {
      id: row.id, projectId: row.project_id, name: row.name, description: row.description,
      type: row.type as NovelLocation['type'], parentId: row.parent_id, factionId: row.faction_id,
      significance: row.significance as NovelLocation['significance'],
      firstChapter: row.first_chapter, status: row.status as NovelLocation['status'],
      appearChapters: parseJSON<number[]>(row.appear_chapters, []),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }
}
