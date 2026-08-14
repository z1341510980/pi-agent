/**
 * FactionStore - PR-5b 重构
 *
 * 从原 novel-store.ts 抽取 Faction + Location 相关的 CRUD 操作。
 * 负责势力（Faction）与地点（Location）两类实体的持久化，
 * 并在删除时通过 deleteEdgesByEntity 清理关联的 edges。
 */
import type { NovelFaction, NovelLocation } from '../types.js'
import type { FactionRow, LocationRow } from './row-types.js'
import { now, parseJSON, parseChapterSpans } from './store-utils.js'
import { createNovelDrizzleDb } from '../../infrastructure/sqlite/client.js'
import { FactionRepository } from '../../infrastructure/sqlite/repositories/faction-repository.js'

export class FactionStore {
  private readonly repository: FactionRepository

  constructor(
    db: import('better-sqlite3').Database,
    private deleteEdgesByEntity: (entityId: string) => number,
  ) {
    this.repository = new FactionRepository(createNovelDrizzleDb(db))
  }

  listFactions(projectId: string): NovelFaction[] {
    return this.repository.listFactions(projectId).map((r) => this.rowToFaction(r))
  }

  getFaction(factionId: string): NovelFaction | undefined {
    const row = this.repository.getFaction(factionId)
    return row ? this.rowToFaction(row) : undefined
  }

  createFaction(faction: Omit<NovelFaction, 'createdAt' | 'updatedAt'>): NovelFaction {
    const ts = now()
    const full: NovelFaction = { ...faction, createdAt: ts, updatedAt: ts }
    this.repository.insertFaction({
      id: full.id, project_id: full.projectId, name: full.name, description: full.description,
      type: full.type, leader_id: full.leaderId, ideology: full.ideology,
      strength: full.strength, resources: JSON.stringify(full.resources),
      allies: JSON.stringify(full.allies), enemies: JSON.stringify(full.enemies),
      status: full.status,
      chapter_spans: JSON.stringify(full.chapterSpans),
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateFaction(id: string, patch: Partial<NovelFaction>): NovelFaction | undefined {
    const existing = this.repository.getFaction(id)
    if (!existing) return undefined
    const current = this.rowToFaction(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.repository.updateFaction(id, {
      id, name: updated.name, description: updated.description, type: updated.type,
      leader_id: updated.leaderId, ideology: updated.ideology, strength: updated.strength,
      resources: JSON.stringify(updated.resources), allies: JSON.stringify(updated.allies),
      enemies: JSON.stringify(updated.enemies), status: updated.status,
      chapter_spans: JSON.stringify(updated.chapterSpans),
      project_id: current.projectId,
      created_at: current.createdAt,
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteFaction(id: string): boolean {
    this.deleteEdgesByEntity(id)
    return this.repository.deleteFaction(id)
  }

  listLocations(projectId: string): NovelLocation[] {
    return this.repository.listLocations(projectId).map((r) => this.rowToLocation(r))
  }

  getLocation(locationId: string): NovelLocation | undefined {
    const row = this.repository.getLocation(locationId)
    return row ? this.rowToLocation(row) : undefined
  }

  createLocation(location: Omit<NovelLocation, 'createdAt' | 'updatedAt'>): NovelLocation {
    const ts = now()
    const full: NovelLocation = { ...location, createdAt: ts, updatedAt: ts }
    this.repository.insertLocation({
      id: full.id, project_id: full.projectId, name: full.name, description: full.description,
      type: full.type, parent_id: full.parentId, faction_id: full.factionId,
      significance: full.significance, first_chapter: full.firstChapter, status: full.status,
      appear_chapters: JSON.stringify(full.appearChapters),
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateLocation(id: string, patch: Partial<NovelLocation>): NovelLocation | undefined {
    const existing = this.repository.getLocation(id)
    if (!existing) return undefined
    const current = this.rowToLocation(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.repository.updateLocation(id, {
      id, project_id: current.projectId, name: updated.name, description: updated.description, type: updated.type,
      parent_id: updated.parentId, faction_id: updated.factionId, significance: updated.significance,
      first_chapter: updated.firstChapter, status: updated.status,
      appear_chapters: JSON.stringify(updated.appearChapters), created_at: current.createdAt, updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteLocation(id: string): boolean {
    this.deleteEdgesByEntity(id)
    return this.repository.deleteLocation(id)
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
