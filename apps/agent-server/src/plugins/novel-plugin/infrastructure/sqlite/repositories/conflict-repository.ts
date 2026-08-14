import { asc, eq } from 'drizzle-orm'
import type { NovelDrizzleDb } from '../client.js'
import { novelConflicts, type NovelConflictsInsert, type NovelConflictsRow } from '../schema/novel-conflicts.js'
import type { ConflictRow } from '../../../core/stores/row-types.js'

export class ConflictRepository {
  constructor(private readonly db: NovelDrizzleDb) {}

  listByProject(projectId: string): ConflictRow[] {
    return this.db.select().from(novelConflicts).where(eq(novelConflicts.projectId, projectId))
      .orderBy(asc(novelConflicts.createdAt)).all().map(toRow)
  }

  getById(id: string): ConflictRow | undefined {
    const row = this.db.select().from(novelConflicts).where(eq(novelConflicts.id, id)).get()
    return row ? toRow(row) : undefined
  }

  insert(row: ConflictRow): void {
    this.db.insert(novelConflicts).values(toInsert(row)).run()
  }

  update(id: string, row: ConflictRow): boolean {
    const result = this.db.update(novelConflicts).set({
      description: row.description, type: row.type, intensity: row.intensity, stage: row.stage,
      participants: row.participants, tier: row.tier, chapterSpans: row.chapter_spans,
      plotFunction: row.plot_function, progressionMode: row.progression_mode,
      currentStep: row.current_step, nextStep: row.next_step, updatedAt: row.updated_at,
    }).where(eq(novelConflicts.id, id)).run()
    return result.changes > 0
  }

  delete(id: string): boolean {
    return this.db.delete(novelConflicts).where(eq(novelConflicts.id, id)).run().changes > 0
  }
}

function toInsert(row: ConflictRow): NovelConflictsInsert {
  return {
    id: row.id, projectId: row.project_id, description: row.description, type: row.type,
    intensity: row.intensity, stage: row.stage, participants: row.participants, tier: row.tier,
    chapterSpans: row.chapter_spans, plotFunction: row.plot_function, progressionMode: row.progression_mode,
    currentStep: row.current_step, nextStep: row.next_step, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function toRow(row: NovelConflictsRow): ConflictRow {
  return {
    id: row.id, project_id: row.projectId, description: row.description, type: row.type,
    intensity: row.intensity, stage: row.stage, participants: row.participants, tier: row.tier,
    chapter_spans: row.chapterSpans, plot_function: row.plotFunction, progression_mode: row.progressionMode,
    current_step: row.currentStep, next_step: row.nextStep, created_at: row.createdAt, updated_at: row.updatedAt,
  }
}
