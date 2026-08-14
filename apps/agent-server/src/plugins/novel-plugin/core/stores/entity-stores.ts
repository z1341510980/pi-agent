/**
 * Small entity Store facades grouped by one bounded-context module.
 *
 * These classes remain separate because their domain fields and invariants
 * differ; the file grouping keeps the shallow CRUD implementations local
 * without introducing a generic repository that would erase those rules.
 */
import { randomUUID } from 'node:crypto'
import type { NovelConflict, ConflictTier, NovelItem, NovelNarrative, NarrativeType } from '../types.js'
import type { ConflictRow, ItemRow } from './row-types.js'
import { now, parseChapterSpans, normalizeConflictPlotFunction, normalizeConflictProgressionMode } from './store-utils.js'
import { createNovelDrizzleDb } from '../../infrastructure/sqlite/client.js'
import { ConflictRepository } from '../../infrastructure/sqlite/repositories/conflict-repository.js'
import { ItemRepository } from '../../infrastructure/sqlite/repositories/item-repository.js'
import { NarrativeRepository, type NarrativeRow } from '../../infrastructure/sqlite/repositories/narrative-repository.js'

export class ConflictStore {
  private readonly repository: ConflictRepository
  constructor(db: import('better-sqlite3').Database, private readonly deleteEdgesByEntity: (entityId: string) => number) {
    this.repository = new ConflictRepository(createNovelDrizzleDb(db))
  }
  listConflicts(projectId: string): NovelConflict[] { return this.repository.listByProject(projectId).map((row) => this.rowToConflict(row)) }
  getConflict(conflictId: string): NovelConflict | undefined { const row = this.repository.getById(conflictId); return row ? this.rowToConflict(row) : undefined }
  createConflict(conflict: Omit<NovelConflict, 'createdAt' | 'updatedAt'>): NovelConflict {
    const ts = now(); const full: NovelConflict = { ...conflict, createdAt: ts, updatedAt: ts }
    this.repository.insert({ id: full.id, project_id: full.projectId, description: full.description, type: full.type, intensity: full.intensity, stage: full.stage, participants: full.participants, chapter_spans: JSON.stringify(full.chapterSpans), tier: full.tier, plot_function: full.plotFunction ?? null, progression_mode: full.progressionMode ?? 'linear', current_step: full.currentStep ?? '', next_step: full.nextStep ?? '', created_at: full.createdAt, updated_at: full.updatedAt })
    return full
  }
  updateConflict(id: string, patch: Partial<NovelConflict>): NovelConflict | undefined {
    const existing = this.repository.getById(id); if (!existing) return undefined
    const current = this.rowToConflict(existing); const updated = { ...current, ...patch, id, updatedAt: now() }
    this.repository.update(id, { id, description: updated.description, type: updated.type, intensity: updated.intensity, stage: updated.stage, participants: updated.participants, chapter_spans: JSON.stringify(updated.chapterSpans), tier: updated.tier, plot_function: updated.plotFunction ?? null, progression_mode: updated.progressionMode ?? 'linear', current_step: updated.currentStep ?? '', next_step: updated.nextStep ?? '', project_id: current.projectId, created_at: current.createdAt, updated_at: updated.updatedAt })
    return updated
  }
  deleteConflict(id: string): boolean { this.deleteEdgesByEntity(id); return this.repository.delete(id) }
  private rowToConflict(row: ConflictRow): NovelConflict {
    return { id: row.id, projectId: row.project_id, description: row.description, type: row.type as NovelConflict['type'], intensity: row.intensity, stage: row.stage as NovelConflict['stage'], participants: row.participants, chapterSpans: parseChapterSpans(row.chapter_spans), tier: (row.tier as ConflictTier) ?? 'secondary', plotFunction: normalizeConflictPlotFunction(row.plot_function), progressionMode: normalizeConflictProgressionMode(row.progression_mode), currentStep: row.current_step ?? '', nextStep: row.next_step ?? '', createdAt: row.created_at, updatedAt: row.updated_at }
  }
}

export class ItemStore {
  private readonly repository: ItemRepository
  constructor(db: import('better-sqlite3').Database, private readonly deleteEdgesByEntity: (entityId: string) => number) {
    this.repository = new ItemRepository(createNovelDrizzleDb(db))
  }
  listItems(projectId: string): NovelItem[] { return this.repository.listByProject(projectId).map((row) => this.rowToItem(row)) }
  getItem(itemId: string): NovelItem | undefined { const row = this.repository.getById(itemId); return row ? this.rowToItem(row) : undefined }
  listItemsByOwner(ownerId: string): NovelItem[] { return this.repository.listByOwner(ownerId).map((row) => this.rowToItem(row)) }
  createItem(item: Omit<NovelItem, 'createdAt' | 'updatedAt'>): NovelItem {
    const ts = now(); const full: NovelItem = { ...item, createdAt: ts, updatedAt: ts }
    this.repository.insert({ id: full.id, project_id: full.projectId, name: full.name, description: full.description, type: full.type, owner_id: full.ownerId, status: full.status, abilities: full.abilities, origin: full.origin, first_chapter: full.firstChapter, chapter_spans: JSON.stringify(full.chapterSpans), created_at: full.createdAt, updated_at: full.updatedAt })
    return full
  }
  updateItem(id: string, patch: Partial<NovelItem>): NovelItem | undefined {
    const existing = this.repository.getById(id); if (!existing) return undefined
    const current = this.rowToItem(existing); const updated = { ...current, ...patch, id, updatedAt: now() }
    this.repository.update(id, { id: updated.id, project_id: updated.projectId, name: updated.name, description: updated.description, type: updated.type, owner_id: updated.ownerId, status: updated.status, abilities: updated.abilities, origin: updated.origin, first_chapter: updated.firstChapter, chapter_spans: JSON.stringify(updated.chapterSpans), created_at: updated.createdAt, updated_at: updated.updatedAt })
    return updated
  }
  deleteItem(id: string): boolean { this.deleteEdgesByEntity(id); return this.repository.delete(id) }
  private rowToItem(row: ItemRow): NovelItem {
    return { id: row.id, projectId: row.project_id, name: row.name, description: row.description, type: row.type as NovelItem['type'], ownerId: row.owner_id, status: row.status as NovelItem['status'], abilities: row.abilities, origin: row.origin, firstChapter: row.first_chapter, chapterSpans: parseChapterSpans(row.chapter_spans), createdAt: row.created_at, updatedAt: row.updated_at }
  }
}

export class NarrativeStore {
  private readonly repository: NarrativeRepository
  constructor(db: import('better-sqlite3').Database) { this.repository = new NarrativeRepository(createNovelDrizzleDb(db)) }
  listNarratives(projectId: string): NovelNarrative[] { return this.repository.listByProject(projectId).map((row) => this.rowToNarrative(row)) }
  getNarrative(id: string): NovelNarrative | undefined { const row = this.repository.getById(id); return row ? this.rowToNarrative(row) : undefined }
  createNarrative(input: Omit<NovelNarrative, 'id' | 'createdAt' | 'updatedAt'>): NovelNarrative {
    const ts = now(); const full: NovelNarrative = { ...input, id: randomUUID(), createdAt: ts, updatedAt: ts }
    this.repository.insert({ id: full.id, project_id: full.projectId, description: full.description, type: full.type, chapter_spans: JSON.stringify(full.chapterSpans ?? []), status: full.status, created_at: full.createdAt, updated_at: full.updatedAt })
    return full
  }
  updateNarrative(id: string, patch: Partial<NovelNarrative>): NovelNarrative | undefined {
    const existing = this.repository.getById(id); if (!existing) return undefined
    const current = this.rowToNarrative(existing); const updated: NovelNarrative = { ...current, ...patch, id, updatedAt: now() }
    this.repository.update(id, { id: updated.id, project_id: current.projectId, description: updated.description, type: updated.type, chapter_spans: JSON.stringify(updated.chapterSpans ?? []), status: updated.status, created_at: current.createdAt, updated_at: updated.updatedAt })
    return updated
  }
  deleteNarrative(id: string): boolean { return this.repository.delete(id) }
  private rowToNarrative(row: NarrativeRow): NovelNarrative {
    return { id: row.id, projectId: row.project_id, description: row.description, type: row.type as NarrativeType, chapterSpans: parseChapterSpans(row.chapter_spans), status: row.status as NovelNarrative['status'], createdAt: row.created_at, updatedAt: row.updated_at }
  }
}
