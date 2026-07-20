/**
 * CharacterStore - PR-5b 重构
 *
 * 从原 novel-store.ts 抽取 Character / Relationship / CharacterHistory 相关的 CRUD。
 * deleteCharacter 调用上层传入的 deleteEdgesByEntity 完成边的级联清理。
 */

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  NovelCharacter, NovelRelationship, NovelCharacterHistory,
} from '../types.js'
import type {
  CharacterRow, RelationshipRow, CharacterHistoryRow,
} from './row-types.js'
import { now, bindString } from './store-utils.js'

export class CharacterStore {
  private readonly stmtListCharacters: Database.Statement
  private readonly stmtListRelationships: Database.Statement
  private readonly stmtListCharacterHistoryByProject: Database.Statement
  private readonly stmtListCharacterHistoryByCharacter: Database.Statement

  constructor(
    private db: Database.Database,
    private deleteEdgesByEntity: (entityId: string) => number,
  ) {
    this.stmtListCharacters = db.prepare('SELECT * FROM novel_characters WHERE project_id = ? ORDER BY created_at ASC')
    this.stmtListRelationships = db.prepare('SELECT * FROM novel_relationships WHERE project_id = ? ORDER BY created_at ASC')
    this.stmtListCharacterHistoryByProject = db.prepare('SELECT * FROM novel_character_history WHERE project_id = ? ORDER BY created_at DESC')
    this.stmtListCharacterHistoryByCharacter = db.prepare('SELECT * FROM novel_character_history WHERE project_id = ? AND character_id = ? ORDER BY created_at DESC')
  }

  listCharacters(projectId: string): NovelCharacter[] {
    return (this.stmtListCharacters.all(projectId) as CharacterRow[]).map((r) => this.rowToCharacter(r))
  }

  getCharacter(characterId: string): NovelCharacter | undefined {
    const row = this.db.prepare('SELECT * FROM novel_characters WHERE id = ?').get(characterId) as CharacterRow | undefined
    return row ? this.rowToCharacter(row) : undefined
  }

  createCharacter(character: Omit<NovelCharacter, 'createdAt' | 'updatedAt' | 'participatingConflicts'> & { participatingConflicts?: string }): NovelCharacter {
    const ts = now()
    const full: NovelCharacter = { participatingConflicts: '[]', ...character, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_characters (id, project_id, name, description, identity, personality, appearance,
      current_state, current_goal, current_pressure, secret, arc_stage, arc_history, speech_style, is_protagonist,
      long_term_desire, plot_role, removal_impact, participating_conflicts, created_at, updated_at)
      VALUES (@id, @project_id, @name, @description, @identity, @personality, @appearance,
      @current_state, @current_goal, @current_pressure, @secret, @arc_stage, @arc_history, @speech_style, @is_protagonist,
      @long_term_desire, @plot_role, @removal_impact, @participating_conflicts, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId,
      name: bindString(full.name, '未命名'), description: bindString(full.description),
      identity: bindString(full.identity), personality: bindString(full.personality), appearance: bindString(full.appearance),
      current_state: bindString(full.currentState), current_goal: bindString(full.currentGoal), current_pressure: bindString(full.currentPressure),
      secret: bindString(full.secret), arc_stage: bindString(full.arcStage, 'introduction'), arc_history: bindString(full.arcHistory, '[]'),
      speech_style: bindString(full.speechStyle), is_protagonist: full.isProtagonist ? 1 : 0,
      long_term_desire: bindString(full.longTermDesire),
      plot_role: bindString(full.plotRole, 'supporting'),
      removal_impact: bindString(full.removalImpact),
      participating_conflicts: bindString(full.participatingConflicts ?? '[]', '[]'),
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateCharacter(id: string, patch: Partial<NovelCharacter>): NovelCharacter | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_characters WHERE id = ?').get(id) as CharacterRow | undefined
    if (!existing) return undefined
    const current = this.rowToCharacter(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_characters SET name=@name, description=@description, identity=@identity, personality=@personality,
      appearance=@appearance, current_state=@current_state, current_goal=@current_goal, current_pressure=@current_pressure,
      secret=@secret, arc_stage=@arc_stage, arc_history=@arc_history, speech_style=@speech_style, is_protagonist=@is_protagonist,
      long_term_desire=@long_term_desire, plot_role=@plot_role, removal_impact=@removal_impact,
      participating_conflicts=@participating_conflicts,
      updated_at=@updated_at
      WHERE id=@id
    `).run({
      id, name: bindString(updated.name, '未命名'), description: bindString(updated.description),
      identity: bindString(updated.identity), personality: bindString(updated.personality), appearance: bindString(updated.appearance),
      current_state: bindString(updated.currentState), current_goal: bindString(updated.currentGoal),
      current_pressure: bindString(updated.currentPressure), secret: bindString(updated.secret),
      arc_stage: bindString(updated.arcStage, 'introduction'), arc_history: bindString(updated.arcHistory, '[]'),
      speech_style: bindString(updated.speechStyle), is_protagonist: updated.isProtagonist ? 1 : 0,
      long_term_desire: bindString(updated.longTermDesire),
      plot_role: bindString(updated.plotRole, 'supporting'),
      removal_impact: bindString(updated.removalImpact),
      participating_conflicts: bindString(updated.participatingConflicts ?? '[]', '[]'),
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteCharacter(id: string): boolean {
    this.deleteEdgesByEntity(id)
    const result = this.db.prepare('DELETE FROM novel_characters WHERE id = ?').run(id)
    return result.changes > 0
  }

  deleteCharacterHistoryByCharacter(characterId: string): number {
    const result = this.db
      .prepare('DELETE FROM novel_character_history WHERE character_id = ?')
      .run(characterId)
    return result.changes
  }

  deleteCharacterHistory(historyId: string, projectId?: string): boolean {
    const result = projectId != null
      ? this.db.prepare('DELETE FROM novel_character_history WHERE id = ? AND project_id = ?').run(historyId, projectId)
      : this.db.prepare('DELETE FROM novel_character_history WHERE id = ?').run(historyId)
    return result.changes > 0
  }

  createCharacterHistory(
    entry: Omit<NovelCharacterHistory, 'id' | 'createdAt'>,
  ): NovelCharacterHistory {
    const id = randomUUID()
    const ts = now()
    const full: NovelCharacterHistory = { ...entry, id, createdAt: ts }
    this.db.prepare(`
      INSERT INTO novel_character_history (id, project_id, character_id, chapter_id, chapter_number,
      field_name, old_value, new_value, reason, created_at)
      VALUES (@id, @project_id, @character_id, @chapter_id, @chapter_number,
      @field_name, @old_value, @new_value, @reason, @created_at)
    `).run({
      id, project_id: full.projectId, character_id: full.characterId,
      chapter_id: full.chapterId, chapter_number: full.chapterNumber,
      field_name: full.fieldName, old_value: full.oldValue,
      new_value: full.newValue, reason: full.reason, created_at: full.createdAt,
    })
    return full
  }

  batchCreateCharacterHistory(
    entries: Array<Omit<NovelCharacterHistory, 'id' | 'createdAt'>>,
  ): NovelCharacterHistory[] {
    const ts = now()
    const stmt = this.db.prepare(`
      INSERT INTO novel_character_history (id, project_id, character_id, chapter_id, chapter_number,
      field_name, old_value, new_value, reason, created_at)
      VALUES (@id, @project_id, @character_id, @chapter_id, @chapter_number,
      @field_name, @old_value, @new_value, @reason, @created_at)
    `)
    const results: NovelCharacterHistory[] = []
    const tx = this.db.transaction((items: typeof entries) => {
      for (const entry of items) {
        const id = randomUUID()
        const full: NovelCharacterHistory = { ...entry, id, createdAt: ts }
        stmt.run({
          id, project_id: full.projectId, character_id: full.characterId,
          chapter_id: full.chapterId, chapter_number: full.chapterNumber,
          field_name: full.fieldName, old_value: full.oldValue,
          new_value: full.newValue, reason: full.reason, created_at: full.createdAt,
        })
        results.push(full)
      }
    })
    tx(entries)
    return results
  }

  listCharacterHistory(projectId: string, characterId?: string): NovelCharacterHistory[] {
    const rows = characterId
      ? this.stmtListCharacterHistoryByCharacter.all(projectId, characterId) as CharacterHistoryRow[]
      : this.stmtListCharacterHistoryByProject.all(projectId) as CharacterHistoryRow[]
    return rows.map((r) => this.rowToCharacterHistory(r))
  }

  listRelationships(projectId: string): NovelRelationship[] {
    return (this.stmtListRelationships.all(projectId) as RelationshipRow[]).map((r) => this.rowToRelationship(r))
  }

  createRelationship(rel: Omit<NovelRelationship, 'createdAt' | 'updatedAt'>): NovelRelationship {
    const ts = now()
    const full: NovelRelationship = { ...rel, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_relationships (id, project_id, character_a, character_b, relation_type, current_stage, stage_history,
      dynamic_role, alignment, trend, chapter_hint, last_updated_chapter, created_at, updated_at)
      VALUES (@id, @project_id, @character_a, @character_b, @relation_type, @current_stage, @stage_history,
      @dynamic_role, @alignment, @trend, @chapter_hint, @last_updated_chapter, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, character_a: full.characterA,
      character_b: full.characterB, relation_type: full.relationType,
      current_stage: full.currentStage, stage_history: full.stageHistory,
      dynamic_role: full.dynamicRole ?? '',
      alignment: full.alignment ?? 'neutral',
      trend: full.trend ?? 'stable',
      chapter_hint: full.chapterHint ?? '',
      last_updated_chapter: full.lastUpdatedChapter ?? null,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateRelationship(id: string, patch: Partial<NovelRelationship>): NovelRelationship | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_relationships WHERE id = ?').get(id) as RelationshipRow | undefined
    if (!existing) return undefined
    const current = this.rowToRelationship(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_relationships SET character_a=@character_a, character_b=@character_b,
      relation_type=@relation_type, current_stage=@current_stage, stage_history=@stage_history,
      dynamic_role=@dynamic_role, alignment=@alignment, trend=@trend,
      chapter_hint=@chapter_hint, last_updated_chapter=@last_updated_chapter,
      updated_at=@updated_at WHERE id=@id
    `).run({
      id, character_a: updated.characterA, character_b: updated.characterB,
      relation_type: updated.relationType, current_stage: updated.currentStage,
      stage_history: updated.stageHistory,
      dynamic_role: updated.dynamicRole ?? '',
      alignment: updated.alignment ?? 'neutral',
      trend: updated.trend ?? 'stable',
      chapter_hint: updated.chapterHint ?? '',
      last_updated_chapter: updated.lastUpdatedChapter ?? null,
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteRelationship(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_relationships WHERE id = ?').run(id)
    return result.changes > 0
  }

  getRelationship(relationshipId: string): NovelRelationship | undefined {
    const row = this.db.prepare('SELECT * FROM novel_relationships WHERE id = ?').get(relationshipId) as RelationshipRow | undefined
    return row ? this.rowToRelationship(row) : undefined
  }

  private rowToCharacter(row: CharacterRow): NovelCharacter {
    const validPlotRoles = ['protagonist', 'main_opponent', 'supporting', 'function', 'background']
    return {
      id: row.id, projectId: row.project_id, name: row.name, description: row.description,
      identity: row.identity, personality: row.personality, appearance: row.appearance,
      currentState: row.current_state, currentGoal: row.current_goal,
      currentPressure: row.current_pressure, secret: row.secret,
      arcStage: row.arc_stage, arcHistory: row.arc_history, speechStyle: row.speech_style,
      isProtagonist: row.is_protagonist === 1,
      longTermDesire: row.long_term_desire,
      plotRole: (validPlotRoles.includes(row.plot_role) ? row.plot_role : 'supporting') as NovelCharacter['plotRole'],
      removalImpact: row.removal_impact,
      participatingConflicts: row.participating_conflicts ?? '[]',
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToRelationship(row: RelationshipRow): NovelRelationship {
    const validAlignments = ['ally', 'temporary_ally', 'opponent', 'temporary_opponent', 'neutral', 'pending_shift']
    const validTrends = ['stable', 'warming', 'cooling', 'breaking', 'reconciling']
    return {
      id: row.id, projectId: row.project_id, characterA: row.character_a,
      characterB: row.character_b, relationType: row.relation_type,
      currentStage: row.current_stage, stageHistory: row.stage_history,
      dynamicRole: row.dynamic_role ?? '',
      alignment: (validAlignments.includes(row.alignment) ? row.alignment : 'neutral') as NovelRelationship['alignment'],
      trend: (validTrends.includes(row.trend) ? row.trend : 'stable') as NovelRelationship['trend'],
      chapterHint: row.chapter_hint ?? '',
      lastUpdatedChapter: row.last_updated_chapter ?? null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToCharacterHistory(row: CharacterHistoryRow): NovelCharacterHistory {
    return {
      id: row.id, projectId: row.project_id, characterId: row.character_id,
      chapterId: row.chapter_id, chapterNumber: row.chapter_number,
      fieldName: row.field_name as NovelCharacterHistory['fieldName'],
      oldValue: row.old_value, newValue: row.new_value,
      reason: row.reason, createdAt: row.created_at,
    }
  }
}
