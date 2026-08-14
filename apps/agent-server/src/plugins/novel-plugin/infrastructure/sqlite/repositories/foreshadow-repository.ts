import { asc, eq } from 'drizzle-orm'
import type { NovelDrizzleDb } from '../client.js'
import {
  novelClues,
  novelForeshadowing,
  novelInformationLayers,
  type NovelCluesInsert,
  type NovelCluesRow,
  type NovelForeshadowingInsert,
  type NovelForeshadowingRow,
  type NovelInformationLayersInsert,
  type NovelInformationLayersRow,
} from '../schema/novel-foreshadowing.js'
import type { ClueRow, ForeshadowRow, InfoLayerRow } from '../../../core/stores/row-types.js'

export class ForeshadowRepository {
  constructor(private readonly db: NovelDrizzleDb) {}

  listForeshadowing(projectId: string): ForeshadowRow[] {
    return this.db.select().from(novelForeshadowing)
      .where(eq(novelForeshadowing.projectId, projectId))
      .orderBy(asc(novelForeshadowing.createdAt)).all().map(toForeshadowRow)
  }

  getForeshadowing(id: string): ForeshadowRow | undefined {
    const row = this.db.select().from(novelForeshadowing).where(eq(novelForeshadowing.id, id)).get()
    return row ? toForeshadowRow(row) : undefined
  }

  insertForeshadowing(row: ForeshadowRow): void {
    this.db.insert(novelForeshadowing).values(toForeshadowInsert(row)).run()
  }

  updateForeshadowing(id: string, row: ForeshadowRow): boolean {
    return this.db.update(novelForeshadowing).set({
      description: row.description,
      category: row.category,
      status: row.status,
      firstChapter: row.first_chapter,
      lastChapter: row.last_chapter,
      recoverByChapter: row.recover_by_chapter,
      plantMethod: row.plant_method,
      recoverMethod: row.recover_method,
      chapterSpans: row.chapter_spans,
      beats: row.beats,
      updatedAt: row.updated_at,
    }).where(eq(novelForeshadowing.id, id)).run().changes > 0
  }

  deleteForeshadowing(id: string): boolean {
    return this.db.delete(novelForeshadowing).where(eq(novelForeshadowing.id, id)).run().changes > 0
  }

  listClues(projectId: string): ClueRow[] {
    return this.db.select().from(novelClues)
      .where(eq(novelClues.projectId, projectId))
      .orderBy(asc(novelClues.createdAt)).all().map(toClueRow)
  }

  getClue(id: string): ClueRow | undefined {
    const row = this.db.select().from(novelClues).where(eq(novelClues.id, id)).get()
    return row ? toClueRow(row) : undefined
  }

  insertClue(row: ClueRow): void {
    this.db.insert(novelClues).values(toClueInsert(row)).run()
  }

  updateClue(id: string, row: ClueRow): boolean {
    return this.db.update(novelClues).set({
      description: row.description,
      pointsTo: row.points_to,
      progress: row.progress,
      currentStep: row.current_step,
      nextStep: row.next_step,
      isMisleading: row.is_misleading,
      chapterSpans: row.chapter_spans,
      updatedAt: row.updated_at,
    }).where(eq(novelClues.id, id)).run().changes > 0
  }

  deleteClue(id: string): boolean {
    return this.db.delete(novelClues).where(eq(novelClues.id, id)).run().changes > 0
  }

  listInformationLayers(projectId: string): InfoLayerRow[] {
    return this.db.select().from(novelInformationLayers)
      .where(eq(novelInformationLayers.projectId, projectId))
      .orderBy(asc(novelInformationLayers.createdAt)).all().map(toInfoLayerRow)
  }

  getInformationLayer(id: string): InfoLayerRow | undefined {
    const row = this.db.select().from(novelInformationLayers).where(eq(novelInformationLayers.id, id)).get()
    return row ? toInfoLayerRow(row) : undefined
  }

  insertInformationLayer(row: InfoLayerRow): void {
    this.db.insert(novelInformationLayers).values(toInfoLayerInsert(row)).run()
  }

  updateInformationLayer(id: string, row: InfoLayerRow): boolean {
    return this.db.update(novelInformationLayers).set({
      infoDescription: row.info_description,
      authorKnows: row.author_knows,
      readerKnows: row.reader_knows,
      characterKnowledge: row.character_knowledge,
      revealStage: row.reveal_stage,
      revealChapter: row.reveal_chapter,
      isRevealed: row.is_revealed,
      updatedAt: row.updated_at,
    }).where(eq(novelInformationLayers.id, id)).run().changes > 0
  }

  deleteInformationLayer(id: string): boolean {
    return this.db.delete(novelInformationLayers).where(eq(novelInformationLayers.id, id)).run().changes > 0
  }
}

function toForeshadowInsert(row: ForeshadowRow): NovelForeshadowingInsert {
  return {
    id: row.id, projectId: row.project_id, description: row.description, category: row.category,
    status: row.status, firstChapter: row.first_chapter, lastChapter: row.last_chapter,
    recoverByChapter: row.recover_by_chapter, plantMethod: row.plant_method, recoverMethod: row.recover_method,
    chapterSpans: row.chapter_spans, beats: row.beats, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function toForeshadowRow(row: NovelForeshadowingRow): ForeshadowRow {
  return {
    id: row.id, project_id: row.projectId, description: row.description, category: row.category,
    status: row.status, first_chapter: row.firstChapter, last_chapter: row.lastChapter,
    recover_by_chapter: row.recoverByChapter, plant_method: row.plantMethod, recover_method: row.recoverMethod,
    chapter_spans: row.chapterSpans, beats: row.beats, created_at: row.createdAt, updated_at: row.updatedAt,
  }
}

function toClueInsert(row: ClueRow): NovelCluesInsert {
  return {
    id: row.id, projectId: row.project_id, description: row.description, pointsTo: row.points_to,
    progress: row.progress, currentStep: row.current_step, nextStep: row.next_step,
    isMisleading: row.is_misleading, chapterSpans: row.chapter_spans,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function toClueRow(row: NovelCluesRow): ClueRow {
  return {
    id: row.id, project_id: row.projectId, description: row.description, points_to: row.pointsTo,
    progress: row.progress, current_step: row.currentStep, next_step: row.nextStep,
    is_misleading: row.isMisleading, chapter_spans: row.chapterSpans,
    created_at: row.createdAt, updated_at: row.updatedAt,
  }
}

function toInfoLayerInsert(row: InfoLayerRow): NovelInformationLayersInsert {
  return {
    id: row.id, projectId: row.project_id, infoDescription: row.info_description,
    authorKnows: row.author_knows, readerKnows: row.reader_knows,
    characterKnowledge: row.character_knowledge, revealStage: row.reveal_stage,
    revealChapter: row.reveal_chapter, isRevealed: row.is_revealed,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function toInfoLayerRow(row: NovelInformationLayersRow): InfoLayerRow {
  return {
    id: row.id, project_id: row.projectId, info_description: row.infoDescription,
    author_knows: row.authorKnows, reader_knows: row.readerKnows,
    character_knowledge: row.characterKnowledge, reveal_stage: row.revealStage,
    reveal_chapter: row.revealChapter, is_revealed: row.isRevealed,
    created_at: row.createdAt, updated_at: row.updatedAt,
  }
}
