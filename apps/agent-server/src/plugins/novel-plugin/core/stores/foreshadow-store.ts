/**
 * ForeshadowStore - PR-5b 重构
 *
 * 从原 novel-store.ts 抽取 Foreshadow + Clue + InfoLayer 相关的 CRUD。
 */

import type { NovelForeshadow, NovelClue, NovelInformationLayer } from '../types.js'
import type { ForeshadowRow, ClueRow, InfoLayerRow } from './row-types.js'
import {
  now,
  normalizeForeshadowBeats, deriveForeshadowStatus,
  parseChapterSpans,
  normalizeForeshadowCategory,
  normalizeForeshadowPlantMethod,
  normalizeForeshadowRecoverMethod,
  parseJSON,
} from './store-utils.js'
import { createNovelDrizzleDb } from '../../infrastructure/sqlite/client.js'
import { ForeshadowRepository } from '../../infrastructure/sqlite/repositories/foreshadow-repository.js'

export class ForeshadowStore {
  private readonly repository: ForeshadowRepository

  constructor(
    db: import('better-sqlite3').Database,
    private deleteEdgesByEntity: (entityId: string) => number,
  ) {
    this.repository = new ForeshadowRepository(createNovelDrizzleDb(db))
  }

  listForeshadowing(projectId: string): NovelForeshadow[] {
    return this.repository.listForeshadowing(projectId).map((r) => this.rowToForeshadow(r))
  }

  getForeshadow(foreshadowId: string): NovelForeshadow | undefined {
    const row = this.repository.getForeshadowing(foreshadowId)
    return row ? this.rowToForeshadow(row) : undefined
  }

  createForeshadow(foreshadow: Omit<NovelForeshadow, 'createdAt' | 'updatedAt'>): NovelForeshadow {
    const ts = now()
    const beats = normalizeForeshadowBeats(foreshadow.beats, foreshadow.firstChapter)
    const beatsAreAuthoritative = foreshadow.beats !== undefined
    const full: NovelForeshadow = {
      ...foreshadow,
      beats,
      // beats 是"已发生节点"的唯一事实源，firstChapter/lastChapter/status 全部由它派生。
      // recoverByChapter 不在派生列表里：它是**计划回收章**（意图），由调用方原样保留。
      ...(beatsAreAuthoritative
        ? {
            firstChapter: beats.find((beat) => beat.type === 'plant')?.chapter ?? null,
            lastChapter: beats.at(-1)?.chapter ?? null,
            status: deriveForeshadowStatus(beats),
          }
        : {}),
      createdAt: ts,
      updatedAt: ts,
    }
    this.repository.insertForeshadowing({
      id: full.id, project_id: full.projectId, description: full.description,
      category: full.category, status: full.status, first_chapter: full.firstChapter,
      last_chapter: full.lastChapter, recover_by_chapter: full.recoverByChapter,
      plant_method: full.plantMethod ?? null,
      recover_method: full.recoverMethod ?? null,
      chapter_spans: JSON.stringify(full.chapterSpans ?? []),
      beats: JSON.stringify(full.beats ?? []),
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateForeshadow(id: string, patch: Partial<NovelForeshadow>): NovelForeshadow | undefined {
    const existing = this.repository.getForeshadowing(id)
    if (!existing) return undefined
    const current = this.rowToForeshadow(existing)
    const updated: NovelForeshadow = { ...current, ...patch, id, updatedAt: now() }
    let beats = patch.beats !== undefined
      ? normalizeForeshadowBeats(patch.beats, null)
      : normalizeForeshadowBeats(updated.beats, updated.firstChapter)
    if (patch.firstChapter !== undefined) {
      beats = beats.filter((beat) => beat.type !== 'plant')
      if (patch.firstChapter != null) beats.push({ chapter: patch.firstChapter, type: 'plant' })
    }
    // 注意：patch.recoverByChapter 不再改动 beats。
    // recoverByChapter 是"计划回收章"，写它只表达意图；真正的回收必须通过
    // patch.beats 显式追加一个 payoff beat（由 Memory Agent 根据正文写入）。
    beats = normalizeForeshadowBeats(beats, null)
    if (patch.beats !== undefined || patch.firstChapter !== undefined) {
      updated.firstChapter = beats.find((beat) => beat.type === 'plant')?.chapter ?? null
      updated.lastChapter = beats.length > 0 ? beats[beats.length - 1].chapter : null
      updated.status = deriveForeshadowStatus(beats)
    }
    updated.beats = beats
    this.repository.updateForeshadowing(id, {
      id, description: updated.description, category: updated.category, status: updated.status,
      first_chapter: updated.firstChapter, last_chapter: updated.lastChapter,
      recover_by_chapter: updated.recoverByChapter,
      plant_method: updated.plantMethod ?? null,
      recover_method: updated.recoverMethod ?? null,
      chapter_spans: JSON.stringify(updated.chapterSpans ?? []),
      beats: JSON.stringify(updated.beats ?? []),
      project_id: current.projectId,
      created_at: current.createdAt,
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteForeshadow(id: string): boolean {
    this.deleteEdgesByEntity(id)
    return this.repository.deleteForeshadowing(id)
  }

  createClue(clue: Omit<NovelClue, 'createdAt' | 'updatedAt'>): NovelClue {
    const ts = now()
    const full: NovelClue = { ...clue, createdAt: ts, updatedAt: ts }
    this.repository.insertClue({
      id: full.id, project_id: full.projectId, description: full.description,
      points_to: full.pointsTo, progress: full.progress, current_step: full.currentStep,
      next_step: full.nextStep, is_misleading: full.isMisleading ? 1 : 0,
      chapter_spans: JSON.stringify(full.chapterSpans ?? []),
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateClue(id: string, patch: Partial<NovelClue>): NovelClue | undefined {
    const existing = this.repository.getClue(id)
    if (!existing) return undefined
    const current = this.rowToClue(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.repository.updateClue(id, {
      id, description: updated.description, points_to: updated.pointsTo, progress: updated.progress,
      current_step: updated.currentStep, next_step: updated.nextStep,
      is_misleading: updated.isMisleading ? 1 : 0,
      chapter_spans: JSON.stringify(updated.chapterSpans ?? []),
      project_id: current.projectId,
      created_at: current.createdAt,
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteClue(id: string): boolean {
    return this.repository.deleteClue(id)
  }

  createInformationLayer(layer: Omit<NovelInformationLayer, 'createdAt' | 'updatedAt'>): NovelInformationLayer {
    const ts = now()
    const full: NovelInformationLayer = { ...layer, createdAt: ts, updatedAt: ts }
    this.repository.insertInformationLayer({
      id: full.id, project_id: full.projectId, info_description: full.infoDescription,
      author_knows: full.authorKnows ? 1 : 0, reader_knows: full.readerKnows ? 1 : 0,
      character_knowledge: full.characterKnowledge, reveal_stage: full.revealStage,
      reveal_chapter: full.revealChapter, is_revealed: full.isRevealed ? 1 : 0,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateInfoLayer(id: string, updates: Partial<Omit<NovelInformationLayer, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>): NovelInformationLayer | undefined {
    if (Object.keys(updates).length === 0) {
      const row = this.repository.getInformationLayer(id)
      return row ? this.rowToInfoLayer(row) : undefined
    }
    const current = this.repository.getInformationLayer(id)
    if (!current) return undefined
    const currentEntity = this.rowToInfoLayer(current)
    const updated = { ...currentEntity, ...updates, id, updatedAt: now() }
    this.repository.updateInformationLayer(id, {
      id,
      project_id: currentEntity.projectId,
      info_description: updated.infoDescription,
      author_knows: updated.authorKnows ? 1 : 0,
      reader_knows: updated.readerKnows ? 1 : 0,
      character_knowledge: updated.characterKnowledge,
      reveal_stage: updated.revealStage,
      reveal_chapter: updated.revealChapter,
      is_revealed: updated.isRevealed ? 1 : 0,
      created_at: currentEntity.createdAt,
      updated_at: updated.updatedAt,
    })
    const row = this.repository.getInformationLayer(id)
    return row ? this.rowToInfoLayer(row) : undefined
  }

  deleteInfoLayer(id: string): boolean {
    this.deleteEdgesByEntity(id)
    return this.repository.deleteInformationLayer(id)
  }

  listClues(projectId: string): NovelClue[] {
    return this.repository.listClues(projectId).map((r) => this.rowToClue(r))
  }

  getClue(clueId: string): NovelClue | undefined {
    const row = this.repository.getClue(clueId)
    return row ? this.rowToClue(row) : undefined
  }

  listInformationLayers(projectId: string): NovelInformationLayer[] {
    return this.repository.listInformationLayers(projectId).map((r) => this.rowToInfoLayer(r))
  }

  getInformationLayer(id: string): NovelInformationLayer | undefined {
    const row = this.repository.getInformationLayer(id)
    return row ? this.rowToInfoLayer(row) : undefined
  }

  private rowToForeshadow(row: ForeshadowRow): NovelForeshadow {
    return {
      id: row.id, projectId: row.project_id, description: row.description,
      category: normalizeForeshadowCategory(row.category),
      status: row.status as NovelForeshadow['status'],
      firstChapter: row.first_chapter, lastChapter: row.last_chapter,
      recoverByChapter: row.recover_by_chapter,
      plantMethod: normalizeForeshadowPlantMethod(row.plant_method),
      recoverMethod: normalizeForeshadowRecoverMethod(row.recover_method),
      chapterSpans: parseChapterSpans(row.chapter_spans),
      beats: normalizeForeshadowBeats(parseJSON<unknown[]>(row.beats ?? '[]', []), row.first_chapter),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToClue(row: ClueRow): NovelClue {
    return {
      id: row.id, projectId: row.project_id, description: row.description,
      pointsTo: row.points_to, progress: row.progress, currentStep: row.current_step,
      nextStep: row.next_step, isMisleading: row.is_misleading === 1,
      chapterSpans: parseChapterSpans(row.chapter_spans),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToInfoLayer(row: InfoLayerRow): NovelInformationLayer {
    return {
      id: row.id, projectId: row.project_id, infoDescription: row.info_description,
      authorKnows: row.author_knows === 1, readerKnows: row.reader_knows === 1,
      characterKnowledge: row.character_knowledge, revealStage: row.reveal_stage,
      revealChapter: row.reveal_chapter, isRevealed: row.is_revealed === 1,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }
}
