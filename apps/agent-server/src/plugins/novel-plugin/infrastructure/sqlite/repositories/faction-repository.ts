import { asc, eq } from 'drizzle-orm'
import type { NovelDrizzleDb } from '../client.js'
import {
  novelFactions,
  novelLocations,
  type NovelFactionsInsert,
  type NovelFactionsRow,
  type NovelLocationsInsert,
  type NovelLocationsRow,
} from '../schema/novel-factions.js'
import type { FactionRow, LocationRow } from '../../../core/stores/row-types.js'

/** SQLite repository for factions and locations. Domain side effects stay in FactionStore. */
export class FactionRepository {
  constructor(private readonly db: NovelDrizzleDb) {}

  listFactions(projectId: string): FactionRow[] {
    return this.db.select().from(novelFactions)
      .where(eq(novelFactions.projectId, projectId))
      .orderBy(asc(novelFactions.createdAt)).all().map(toFactionRow)
  }

  getFaction(id: string): FactionRow | undefined {
    const row = this.db.select().from(novelFactions).where(eq(novelFactions.id, id)).get()
    return row ? toFactionRow(row) : undefined
  }

  insertFaction(row: FactionRow): void {
    this.db.insert(novelFactions).values(toFactionInsert(row)).run()
  }

  updateFaction(id: string, row: FactionRow): boolean {
    return this.db.update(novelFactions).set({
      name: row.name,
      description: row.description,
      type: row.type,
      leaderId: row.leader_id,
      ideology: row.ideology,
      strength: row.strength,
      resources: row.resources,
      allies: row.allies,
      enemies: row.enemies,
      status: row.status,
      chapterSpans: row.chapter_spans,
      updatedAt: row.updated_at,
    }).where(eq(novelFactions.id, id)).run().changes > 0
  }

  deleteFaction(id: string): boolean {
    return this.db.delete(novelFactions).where(eq(novelFactions.id, id)).run().changes > 0
  }

  listLocations(projectId: string): LocationRow[] {
    return this.db.select().from(novelLocations)
      .where(eq(novelLocations.projectId, projectId))
      .orderBy(asc(novelLocations.createdAt)).all().map(toLocationRow)
  }

  getLocation(id: string): LocationRow | undefined {
    const row = this.db.select().from(novelLocations).where(eq(novelLocations.id, id)).get()
    return row ? toLocationRow(row) : undefined
  }

  insertLocation(row: LocationRow): void {
    this.db.insert(novelLocations).values(toLocationInsert(row)).run()
  }

  updateLocation(id: string, row: LocationRow): boolean {
    return this.db.update(novelLocations).set({
      name: row.name,
      description: row.description,
      type: row.type,
      parentId: row.parent_id,
      factionId: row.faction_id,
      significance: row.significance,
      firstChapter: row.first_chapter,
      status: row.status,
      appearChapters: row.appear_chapters,
      updatedAt: row.updated_at,
    }).where(eq(novelLocations.id, id)).run().changes > 0
  }

  deleteLocation(id: string): boolean {
    return this.db.delete(novelLocations).where(eq(novelLocations.id, id)).run().changes > 0
  }
}

function toFactionInsert(row: FactionRow): NovelFactionsInsert {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    type: row.type,
    leaderId: row.leader_id,
    ideology: row.ideology,
    strength: row.strength,
    resources: row.resources,
    allies: row.allies,
    enemies: row.enemies,
    status: row.status,
    chapterSpans: row.chapter_spans,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toFactionRow(row: NovelFactionsRow): FactionRow {
  return {
    id: row.id,
    project_id: row.projectId,
    name: row.name,
    description: row.description,
    type: row.type,
    leader_id: row.leaderId,
    ideology: row.ideology,
    strength: row.strength,
    resources: row.resources,
    allies: row.allies,
    enemies: row.enemies,
    status: row.status,
    chapter_spans: row.chapterSpans,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function toLocationInsert(row: LocationRow): NovelLocationsInsert {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    type: row.type,
    parentId: row.parent_id,
    factionId: row.faction_id,
    significance: row.significance,
    firstChapter: row.first_chapter,
    status: row.status,
    appearChapters: row.appear_chapters,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toLocationRow(row: NovelLocationsRow): LocationRow {
  return {
    id: row.id,
    project_id: row.projectId,
    name: row.name,
    description: row.description,
    type: row.type,
    parent_id: row.parentId,
    faction_id: row.factionId,
    significance: row.significance,
    first_chapter: row.firstChapter,
    status: row.status,
    appear_chapters: row.appearChapters,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}
