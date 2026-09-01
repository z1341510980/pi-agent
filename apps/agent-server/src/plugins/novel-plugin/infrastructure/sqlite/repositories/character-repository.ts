import { asc, eq } from 'drizzle-orm'
import type { NovelDrizzleDb } from '../client.js'
import {
  novelCharacters,
  novelRelationships,
  type NovelCharactersInsert,
  type NovelCharactersRow,
  type NovelRelationshipsInsert,
  type NovelRelationshipsRow,
} from '../schema/novel-characters.js'
import type { CharacterRow, RelationshipRow } from '../../../core/stores/row-types.js'

export class CharacterRepository {
  constructor(private readonly db: NovelDrizzleDb) {}

  listCharacters(projectId: string): CharacterRow[] {
    return this.db.select().from(novelCharacters)
      .where(eq(novelCharacters.projectId, projectId))
      .orderBy(asc(novelCharacters.createdAt)).all().map(toCharacterRow)
  }

  getCharacter(id: string): CharacterRow | undefined {
    const row = this.db.select().from(novelCharacters).where(eq(novelCharacters.id, id)).get()
    return row ? toCharacterRow(row) : undefined
  }

  insertCharacter(row: CharacterRow): void {
    this.db.insert(novelCharacters).values(toCharacterInsert(row)).run()
  }

  updateCharacter(id: string, row: CharacterRow): boolean {
    return this.db.update(novelCharacters).set({
      name: row.name,
      description: row.description,
      gender: row.gender,
      identity: row.identity,
      personality: row.personality,
      appearance: row.appearance,
      currentState: row.current_state,
      currentGoal: row.current_goal,
      currentPressure: row.current_pressure,
      secret: row.secret,
      arcStage: row.arc_stage,
      arcHistory: row.arc_history,
      speechStyle: row.speech_style,
      isProtagonist: row.is_protagonist,
      longTermDesire: row.long_term_desire,
      plotRole: row.plot_role,
      removalImpact: row.removal_impact,
      updatedAt: row.updated_at,
    }).where(eq(novelCharacters.id, id)).run().changes > 0
  }

  deleteCharacter(id: string): boolean {
    return this.db.delete(novelCharacters).where(eq(novelCharacters.id, id)).run().changes > 0
  }

  listRelationships(projectId: string): RelationshipRow[] {
    return this.db.select().from(novelRelationships)
      .where(eq(novelRelationships.projectId, projectId))
      .orderBy(asc(novelRelationships.createdAt)).all().map(toRelationshipRow)
  }

  getRelationship(id: string): RelationshipRow | undefined {
    const row = this.db.select().from(novelRelationships).where(eq(novelRelationships.id, id)).get()
    return row ? toRelationshipRow(row) : undefined
  }

  insertRelationship(row: RelationshipRow): void {
    this.db.insert(novelRelationships).values(toRelationshipInsert(row)).run()
  }

  updateRelationship(id: string, row: RelationshipRow): boolean {
    return this.db.update(novelRelationships).set({
      characterA: row.character_a,
      characterB: row.character_b,
      relationType: row.relation_type,
      currentStage: row.current_stage,
      stageHistory: row.stage_history,
      dynamicRole: row.dynamic_role,
      alignment: row.alignment,
      trend: row.trend,
      chapterHint: row.chapter_hint,
      lastUpdatedChapter: row.last_updated_chapter,
      updatedAt: row.updated_at,
    }).where(eq(novelRelationships.id, id)).run().changes > 0
  }

  deleteRelationship(id: string): boolean {
    return this.db.delete(novelRelationships).where(eq(novelRelationships.id, id)).run().changes > 0
  }
}

function toCharacterInsert(row: CharacterRow): NovelCharactersInsert {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    gender: row.gender,
    identity: row.identity,
    personality: row.personality,
    appearance: row.appearance,
    currentState: row.current_state,
    currentGoal: row.current_goal,
    currentPressure: row.current_pressure,
    secret: row.secret,
    arcStage: row.arc_stage,
    arcHistory: row.arc_history,
    speechStyle: row.speech_style,
    isProtagonist: row.is_protagonist,
    longTermDesire: row.long_term_desire,
    plotRole: row.plot_role,
    removalImpact: row.removal_impact,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toCharacterRow(row: NovelCharactersRow): CharacterRow {
  return {
    id: row.id,
    project_id: row.projectId,
    name: row.name,
    description: row.description,
    gender: row.gender ?? null,
    identity: row.identity,
    personality: row.personality,
    appearance: row.appearance,
    current_state: row.currentState,
    current_goal: row.currentGoal,
    current_pressure: row.currentPressure,
    secret: row.secret,
    arc_stage: row.arcStage,
    arc_history: row.arcHistory,
    speech_style: row.speechStyle,
    is_protagonist: row.isProtagonist,
    long_term_desire: row.longTermDesire,
    plot_role: row.plotRole,
    removal_impact: row.removalImpact,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function toRelationshipInsert(row: RelationshipRow): NovelRelationshipsInsert {
  return {
    id: row.id,
    projectId: row.project_id,
    characterA: row.character_a,
    characterB: row.character_b,
    relationType: row.relation_type,
    currentStage: row.current_stage,
    stageHistory: row.stage_history,
    dynamicRole: row.dynamic_role,
    alignment: row.alignment,
    trend: row.trend,
    chapterHint: row.chapter_hint,
    lastUpdatedChapter: row.last_updated_chapter,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toRelationshipRow(row: NovelRelationshipsRow): RelationshipRow {
  return {
    id: row.id,
    project_id: row.projectId,
    character_a: row.characterA,
    character_b: row.characterB,
    relation_type: row.relationType,
    current_stage: row.currentStage,
    stage_history: row.stageHistory,
    dynamic_role: row.dynamicRole,
    alignment: row.alignment,
    trend: row.trend,
    chapter_hint: row.chapterHint,
    last_updated_chapter: row.lastUpdatedChapter,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}
