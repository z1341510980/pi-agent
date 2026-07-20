/**
 * ForeshadowStore - PR-5b 重构
 *
 * 从原 novel-store.ts 抽取 Foreshadow + Clue + InfoLayer 相关的 CRUD。
 * 含 P3-2 双向关联维护：linkForeshadowToInfoLayer / unlinkForeshadowFromInfoLayer
 * 以及删除时的 pruneForeshadowFromInfoLayers / pruneInfoLayerFromForeshadows 清理。
 */

import type Database from 'better-sqlite3'
import type { NovelForeshadow, NovelClue, NovelInformationLayer } from '../types.js'
import type { ForeshadowRow, ClueRow, InfoLayerRow } from './row-types.js'
import {
  now, parseIdListSafe,
  normalizeForeshadowBeats, deriveForeshadowStatus,
  parseChapterSpans,
  normalizeForeshadowCategory,
  normalizeForeshadowPlantMethod,
  normalizeForeshadowRecoverMethod,
  parseJSON,
} from './store-utils.js'

export class ForeshadowStore {
  // 字段
  private readonly stmtListForeshadowing: Database.Statement
  private readonly stmtListClues: Database.Statement
  private readonly stmtListInfoLayers: Database.Statement

  constructor(
    private db: Database.Database,
    private deleteEdgesByEntity: (entityId: string) => number,
  ) {
    this.stmtListForeshadowing = db.prepare('SELECT * FROM novel_foreshadowing WHERE project_id = ? ORDER BY created_at ASC')
    this.stmtListClues = db.prepare('SELECT * FROM novel_clues WHERE project_id = ? ORDER BY created_at ASC')
    this.stmtListInfoLayers = db.prepare('SELECT * FROM novel_information_layers WHERE project_id = ? ORDER BY created_at ASC')
  }

  listForeshadowing(projectId: string): NovelForeshadow[] {
    return (this.stmtListForeshadowing.all(projectId) as ForeshadowRow[]).map((r) => this.rowToForeshadow(r))
  }

  getForeshadow(foreshadowId: string): NovelForeshadow | undefined {
    const row = this.db.prepare('SELECT * FROM novel_foreshadowing WHERE id = ?').get(foreshadowId) as ForeshadowRow | undefined
    return row ? this.rowToForeshadow(row) : undefined
  }

  createForeshadow(foreshadow: Omit<NovelForeshadow, 'createdAt' | 'updatedAt'>): NovelForeshadow {
    const ts = now()
    const beats = normalizeForeshadowBeats(foreshadow.beats, foreshadow.firstChapter, foreshadow.recoverByChapter)
    const beatsAreAuthoritative = foreshadow.beats !== undefined
    const full: NovelForeshadow = {
      ...foreshadow,
      beats,
      ...(beatsAreAuthoritative
        ? {
            firstChapter: beats.find((beat) => beat.type === 'plant')?.chapter ?? null,
            recoverByChapter: beats.find((beat) => beat.type === 'payoff')?.chapter ?? null,
            lastChapter: beats.at(-1)?.chapter ?? null,
            status: deriveForeshadowStatus(beats),
          }
        : {}),
      createdAt: ts,
      updatedAt: ts,
    }
    this.db.prepare(`
      INSERT INTO novel_foreshadowing (id, project_id, description, category, status, first_chapter, last_chapter,
      recover_by_chapter, linked_characters, linked_clues, plant_method, recover_method, linked_info_layers,
      chapter_spans, beats, created_at, updated_at)
      VALUES (@id, @project_id, @description, @category, @status, @first_chapter, @last_chapter,
      @recover_by_chapter, @linked_characters, @linked_clues, @plant_method, @recover_method, @linked_info_layers,
      @chapter_spans, @beats, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, description: full.description,
      category: full.category, status: full.status, first_chapter: full.firstChapter,
      last_chapter: full.lastChapter, recover_by_chapter: full.recoverByChapter,
      linked_characters: full.linkedCharacters, linked_clues: full.linkedClues,
      plant_method: full.plantMethod ?? null,
      recover_method: full.recoverMethod ?? null,
      linked_info_layers: full.linkedInfoLayers ?? '[]',
      chapter_spans: JSON.stringify(full.chapterSpans ?? []),
      beats: JSON.stringify(full.beats ?? []),
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateForeshadow(id: string, patch: Partial<NovelForeshadow>): NovelForeshadow | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_foreshadowing WHERE id = ?').get(id) as ForeshadowRow | undefined
    if (!existing) return undefined
    const current = this.rowToForeshadow(existing)
    const updated: NovelForeshadow = { ...current, ...patch, id, updatedAt: now() }
    let beats = patch.beats !== undefined
      ? normalizeForeshadowBeats(patch.beats, null, null)
      : normalizeForeshadowBeats(updated.beats, updated.firstChapter, updated.recoverByChapter)
    if (patch.firstChapter !== undefined) {
      beats = beats.filter((beat) => beat.type !== 'plant')
      if (patch.firstChapter != null) beats.push({ chapter: patch.firstChapter, type: 'plant' })
    }
    if (patch.recoverByChapter !== undefined) {
      beats = beats.filter((beat) => beat.type !== 'payoff')
      if (patch.recoverByChapter != null) beats.push({ chapter: patch.recoverByChapter, type: 'payoff' })
    }
    beats = normalizeForeshadowBeats(beats, null, null)
    if (patch.beats !== undefined || patch.firstChapter !== undefined || patch.recoverByChapter !== undefined) {
      updated.firstChapter = beats.find((beat) => beat.type === 'plant')?.chapter ?? null
      updated.recoverByChapter = beats.find((beat) => beat.type === 'payoff')?.chapter ?? null
      updated.lastChapter = beats.length > 0 ? beats[beats.length - 1].chapter : null
      updated.status = deriveForeshadowStatus(beats)
    }
    updated.beats = beats
    this.db.prepare(`
      UPDATE novel_foreshadowing SET description=@description, category=@category, status=@status,
      first_chapter=@first_chapter, last_chapter=@last_chapter, recover_by_chapter=@recover_by_chapter,
      linked_characters=@linked_characters, linked_clues=@linked_clues,
      plant_method=@plant_method, recover_method=@recover_method,
      linked_info_layers=@linked_info_layers,
      chapter_spans=@chapter_spans, beats=@beats,
      updated_at=@updated_at WHERE id=@id
    `).run({
      id, description: updated.description, category: updated.category, status: updated.status,
      first_chapter: updated.firstChapter, last_chapter: updated.lastChapter,
      recover_by_chapter: updated.recoverByChapter, linked_characters: updated.linkedCharacters,
      linked_clues: updated.linkedClues,
      plant_method: updated.plantMethod ?? null,
      recover_method: updated.recoverMethod ?? null,
      linked_info_layers: updated.linkedInfoLayers ?? '[]',
      chapter_spans: JSON.stringify(updated.chapterSpans ?? []),
      beats: JSON.stringify(updated.beats ?? []),
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteForeshadow(id: string): boolean {
    this.deleteEdgesByEntity(id)
    this.pruneForeshadowFromInfoLayers(id)
    const result = this.db.prepare('DELETE FROM novel_foreshadowing WHERE id = ?').run(id)
    return result.changes > 0
  }

  createClue(clue: Omit<NovelClue, 'createdAt' | 'updatedAt'>): NovelClue {
    const ts = now()
    const full: NovelClue = { ...clue, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_clues (id, project_id, description, points_to, progress, current_step, next_step, is_misleading, linked_foreshadow, chapter_spans, created_at, updated_at)
      VALUES (@id, @project_id, @description, @points_to, @progress, @current_step, @next_step, @is_misleading, @linked_foreshadow, @chapter_spans, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, description: full.description,
      points_to: full.pointsTo, progress: full.progress, current_step: full.currentStep,
      next_step: full.nextStep, is_misleading: full.isMisleading ? 1 : 0,
      linked_foreshadow: full.linkedForeshadow, chapter_spans: JSON.stringify(full.chapterSpans ?? []),
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateClue(id: string, patch: Partial<NovelClue>): NovelClue | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_clues WHERE id = ?').get(id) as ClueRow | undefined
    if (!existing) return undefined
    const current = this.rowToClue(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_clues SET description=@description, points_to=@points_to, progress=@progress,
      current_step=@current_step, next_step=@next_step, is_misleading=@is_misleading,
      linked_foreshadow=@linked_foreshadow, chapter_spans=@chapter_spans, updated_at=@updated_at WHERE id=@id
    `).run({
      id, description: updated.description, points_to: updated.pointsTo, progress: updated.progress,
      current_step: updated.currentStep, next_step: updated.nextStep,
      is_misleading: updated.isMisleading ? 1 : 0, linked_foreshadow: updated.linkedForeshadow,
      chapter_spans: JSON.stringify(updated.chapterSpans ?? []),
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteClue(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_clues WHERE id = ?').run(id)
    return result.changes > 0
  }

  createInformationLayer(layer: Omit<NovelInformationLayer, 'createdAt' | 'updatedAt'>): NovelInformationLayer {
    const ts = now()
    const full: NovelInformationLayer = { ...layer, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_information_layers (id, project_id, info_description, author_knows, reader_knows, character_knowledge, reveal_stage, reveal_chapter, is_revealed, linked_foreshadows, created_at, updated_at)
      VALUES (@id, @project_id, @info_description, @author_knows, @reader_knows, @character_knowledge, @reveal_stage, @reveal_chapter, @is_revealed, @linked_foreshadows, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, info_description: full.infoDescription,
      author_knows: full.authorKnows ? 1 : 0, reader_knows: full.readerKnows ? 1 : 0,
      character_knowledge: full.characterKnowledge, reveal_stage: full.revealStage,
      reveal_chapter: full.revealChapter, is_revealed: full.isRevealed ? 1 : 0,
      linked_foreshadows: full.linkedForeshadows ?? '[]',
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateInfoLayer(id: string, updates: Partial<Omit<NovelInformationLayer, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>): NovelInformationLayer | undefined {
    const fields: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(updates)) {
      const dbKey = this.camelToSnake(key)
      fields.push(`${dbKey} = ?`)
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
    }
    if (fields.length === 0) {
      const row = this.db.prepare('SELECT * FROM novel_information_layers WHERE id = ?').get(id) as InfoLayerRow | undefined
      return row ? this.rowToInfoLayer(row) : undefined
    }
    fields.push('updated_at = unixepoch()')
    values.push(id)
    this.db.prepare(`UPDATE novel_information_layers SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    const row = this.db.prepare('SELECT * FROM novel_information_layers WHERE id = ?').get(id) as InfoLayerRow | undefined
    return row ? this.rowToInfoLayer(row) : undefined
  }

  deleteInfoLayer(id: string): boolean {
    this.deleteEdgesByEntity(id)
    this.pruneInfoLayerFromForeshadows(id)
    const result = this.db.prepare('DELETE FROM novel_information_layers WHERE id = ?').run(id)
    return result.changes > 0
  }

  linkForeshadowToInfoLayer(foreshadowId: string, infoLayerId: string): void {
    const fRow = this.db.prepare('SELECT linked_info_layers FROM novel_foreshadowing WHERE id = ?').get(foreshadowId) as { linked_info_layers: string } | undefined
    if (fRow) {
      const ids = parseIdListSafe(fRow.linked_info_layers)
      if (!ids.includes(infoLayerId)) {
        ids.push(infoLayerId)
        this.db.prepare('UPDATE novel_foreshadowing SET linked_info_layers = ?, updated_at = unixepoch() WHERE id = ?').run(JSON.stringify(ids), foreshadowId)
      }
    }
    const iRow = this.db.prepare('SELECT linked_foreshadows FROM novel_information_layers WHERE id = ?').get(infoLayerId) as { linked_foreshadows: string } | undefined
    if (iRow) {
      const ids = parseIdListSafe(iRow.linked_foreshadows)
      if (!ids.includes(foreshadowId)) {
        ids.push(foreshadowId)
        this.db.prepare('UPDATE novel_information_layers SET linked_foreshadows = ?, updated_at = unixepoch() WHERE id = ?').run(JSON.stringify(ids), infoLayerId)
      }
    }
  }

  unlinkForeshadowFromInfoLayer(foreshadowId: string, infoLayerId: string): void {
    const fRow = this.db.prepare('SELECT linked_info_layers FROM novel_foreshadowing WHERE id = ?').get(foreshadowId) as { linked_info_layers: string } | undefined
    if (fRow) {
      const ids = parseIdListSafe(fRow.linked_info_layers).filter(id => id !== infoLayerId)
      this.db.prepare('UPDATE novel_foreshadowing SET linked_info_layers = ?, updated_at = unixepoch() WHERE id = ?').run(JSON.stringify(ids), foreshadowId)
    }
    const iRow = this.db.prepare('SELECT linked_foreshadows FROM novel_information_layers WHERE id = ?').get(infoLayerId) as { linked_foreshadows: string } | undefined
    if (iRow) {
      const ids = parseIdListSafe(iRow.linked_foreshadows).filter(id => id !== foreshadowId)
      this.db.prepare('UPDATE novel_information_layers SET linked_foreshadows = ?, updated_at = unixepoch() WHERE id = ?').run(JSON.stringify(ids), infoLayerId)
    }
  }

  private pruneForeshadowFromInfoLayers(foreshadowId: string): void {
    const rows = this.db.prepare("SELECT id, linked_foreshadows FROM novel_information_layers WHERE linked_foreshadows LIKE ?").all(`%${foreshadowId}%`) as Array<{ id: string; linked_foreshadows: string }>
    for (const row of rows) {
      const ids = parseIdListSafe(row.linked_foreshadows).filter(id => id !== foreshadowId)
      this.db.prepare('UPDATE novel_information_layers SET linked_foreshadows = ?, updated_at = unixepoch() WHERE id = ?').run(JSON.stringify(ids), row.id)
    }
  }

  private pruneInfoLayerFromForeshadows(infoLayerId: string): void {
    const rows = this.db.prepare("SELECT id, linked_info_layers FROM novel_foreshadowing WHERE linked_info_layers LIKE ?").all(`%${infoLayerId}%`) as Array<{ id: string; linked_info_layers: string }>
    for (const row of rows) {
      const ids = parseIdListSafe(row.linked_info_layers).filter(id => id !== infoLayerId)
      this.db.prepare('UPDATE novel_foreshadowing SET linked_info_layers = ?, updated_at = unixepoch() WHERE id = ?').run(JSON.stringify(ids), row.id)
    }
  }

  listClues(projectId: string): NovelClue[] {
    return (this.stmtListClues.all(projectId) as ClueRow[]).map((r) => this.rowToClue(r))
  }

  getClue(clueId: string): NovelClue | undefined {
    const row = this.db.prepare('SELECT * FROM novel_clues WHERE id = ?').get(clueId) as ClueRow | undefined
    return row ? this.rowToClue(row) : undefined
  }

  listInformationLayers(projectId: string): NovelInformationLayer[] {
    return (this.stmtListInfoLayers.all(projectId) as InfoLayerRow[]).map((r) => this.rowToInfoLayer(r))
  }

  getInformationLayer(id: string): NovelInformationLayer | undefined {
    const row = this.db.prepare('SELECT * FROM novel_information_layers WHERE id = ?').get(id) as InfoLayerRow | undefined
    return row ? this.rowToInfoLayer(row) : undefined
  }

  private camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
  }

  private rowToForeshadow(row: ForeshadowRow): NovelForeshadow {
    return {
      id: row.id, projectId: row.project_id, description: row.description,
      category: normalizeForeshadowCategory(row.category),
      status: row.status as NovelForeshadow['status'],
      firstChapter: row.first_chapter, lastChapter: row.last_chapter,
      recoverByChapter: row.recover_by_chapter, linkedCharacters: row.linked_characters,
      linkedClues: row.linked_clues,
      plantMethod: normalizeForeshadowPlantMethod(row.plant_method),
      recoverMethod: normalizeForeshadowRecoverMethod(row.recover_method),
      linkedInfoLayers: row.linked_info_layers ?? '[]',
      chapterSpans: parseChapterSpans(row.chapter_spans),
      beats: normalizeForeshadowBeats(parseJSON<unknown[]>(row.beats ?? '[]', []), row.first_chapter, row.recover_by_chapter),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToClue(row: ClueRow): NovelClue {
    return {
      id: row.id, projectId: row.project_id, description: row.description,
      pointsTo: row.points_to, progress: row.progress, currentStep: row.current_step,
      nextStep: row.next_step, isMisleading: row.is_misleading === 1,
      linkedForeshadow: row.linked_foreshadow, chapterSpans: parseChapterSpans(row.chapter_spans),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToInfoLayer(row: InfoLayerRow): NovelInformationLayer {
    return {
      id: row.id, projectId: row.project_id, infoDescription: row.info_description,
      authorKnows: row.author_knows === 1, readerKnows: row.reader_knows === 1,
      characterKnowledge: row.character_knowledge, revealStage: row.reveal_stage,
      revealChapter: row.reveal_chapter, isRevealed: row.is_revealed === 1,
      linkedForeshadows: row.linked_foreshadows ?? '[]',
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }
}
