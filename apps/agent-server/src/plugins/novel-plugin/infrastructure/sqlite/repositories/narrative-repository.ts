import { asc, eq } from 'drizzle-orm'
import type { NovelDrizzleDb } from '../client.js'
import {
  novelNarratives,
  type NovelNarrativesInsert,
  type NovelNarrativesRow,
} from '../schema/novel-narratives.js'

export interface NarrativeRow {
  id: string
  project_id: string
  description: string
  type: string
  chapter_spans: string
  status: string
  created_at: number
  updated_at: number
}

export class NarrativeRepository {
  constructor(private readonly db: NovelDrizzleDb) {}

  listByProject(projectId: string): NarrativeRow[] {
    return this.db.select().from(novelNarratives)
      .where(eq(novelNarratives.projectId, projectId))
      .orderBy(asc(novelNarratives.createdAt)).all().map(toRow)
  }

  getById(id: string): NarrativeRow | undefined {
    const row = this.db.select().from(novelNarratives).where(eq(novelNarratives.id, id)).get()
    return row ? toRow(row) : undefined
  }

  insert(row: NarrativeRow): void {
    this.db.insert(novelNarratives).values(toInsert(row)).run()
  }

  update(id: string, row: NarrativeRow): boolean {
    return this.db.update(novelNarratives).set({
      description: row.description,
      type: row.type,
      chapterSpans: row.chapter_spans,
      status: row.status,
      updatedAt: row.updated_at,
    }).where(eq(novelNarratives.id, id)).run().changes > 0
  }

  delete(id: string): boolean {
    return this.db.delete(novelNarratives).where(eq(novelNarratives.id, id)).run().changes > 0
  }
}

function toInsert(row: NarrativeRow): NovelNarrativesInsert {
  return {
    id: row.id,
    projectId: row.project_id,
    description: row.description,
    type: row.type,
    chapterSpans: row.chapter_spans,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toRow(row: NovelNarrativesRow): NarrativeRow {
  return {
    id: row.id,
    project_id: row.projectId,
    description: row.description,
    type: row.type,
    chapter_spans: row.chapterSpans,
    status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}
