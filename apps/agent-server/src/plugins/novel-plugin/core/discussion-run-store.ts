import type Database from 'better-sqlite3'
import type {
  DiscussionMessage,
  DiscussionPhase,
  SceneDefinition,
} from '../../../core/agent/discussion-types.js'
import type { ArrangedEntity } from './types.js'

export interface DiscussionRunSnapshot {
  id: string
  projectId: string
  chapterNumber: number
  status: 'completed' | 'cancelled' | 'error'
  failedPhase?: DiscussionPhase
  transcript: DiscussionMessage[]
  scenes: SceneDefinition[]
  arrangedEntities?: ArrangedEntity
  content?: string
  error?: string
  resumedFromRunId?: string
  createdAt: number
  updatedAt: number
}

export type SaveDiscussionRunInput = Omit<DiscussionRunSnapshot, 'createdAt' | 'updatedAt'>

interface DiscussionRunRow {
  id: string
  project_id: string
  chapter_number: number
  status: string
  failed_phase: string | null
  transcript: string
  scenes: string
  arranged_entities: string | null
  content: string | null
  error: string | null
  resumed_from_run_id: string | null
  created_at: number
  updated_at: number
}

export class DiscussionRunStore {
  private readonly stmtUpsert: Database.Statement
  private readonly stmtGet: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.stmtUpsert = db.prepare(`
      INSERT INTO novel_discussion_runs (
        id, project_id, chapter_number, status, failed_phase,
        transcript, scenes, arranged_entities, content, error,
        resumed_from_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        failed_phase = excluded.failed_phase,
        transcript = excluded.transcript,
        scenes = excluded.scenes,
        arranged_entities = excluded.arranged_entities,
        content = excluded.content,
        error = excluded.error,
        resumed_from_run_id = excluded.resumed_from_run_id,
        updated_at = excluded.updated_at
    `)
    this.stmtGet = db.prepare(`
      SELECT id, project_id, chapter_number, status, failed_phase,
             transcript, scenes, arranged_entities, content, error,
             resumed_from_run_id, created_at, updated_at
      FROM novel_discussion_runs
      WHERE id = ?
    `)
  }

  save(input: SaveDiscussionRunInput): DiscussionRunSnapshot {
    const existing = this.get(input.id)
    const now = Date.now()
    const createdAt = existing?.createdAt ?? now
    this.stmtUpsert.run(
      input.id,
      input.projectId,
      input.chapterNumber,
      input.status,
      input.failedPhase ?? null,
      JSON.stringify(input.transcript),
      JSON.stringify(input.scenes),
      input.arrangedEntities ? JSON.stringify(input.arrangedEntities) : null,
      input.content ?? null,
      input.error ?? null,
      input.resumedFromRunId ?? null,
      Math.floor(createdAt / 1000),
      Math.floor(now / 1000),
    )
    return {
      ...input,
      createdAt,
      updatedAt: now,
    }
  }

  get(id: string): DiscussionRunSnapshot | undefined {
    const row = this.stmtGet.get(id) as DiscussionRunRow | undefined
    return row ? this.rowToSnapshot(row) : undefined
  }

  private rowToSnapshot(row: DiscussionRunRow): DiscussionRunSnapshot {
    return {
      id: row.id,
      projectId: row.project_id,
      chapterNumber: row.chapter_number,
      status: row.status as DiscussionRunSnapshot['status'],
      failedPhase: row.failed_phase as DiscussionPhase | undefined,
      transcript: JSON.parse(row.transcript) as DiscussionMessage[],
      scenes: JSON.parse(row.scenes) as SceneDefinition[],
      arrangedEntities: row.arranged_entities
        ? JSON.parse(row.arranged_entities) as ArrangedEntity
        : undefined,
      content: row.content ?? undefined,
      error: row.error ?? undefined,
      resumedFromRunId: row.resumed_from_run_id ?? undefined,
      createdAt: row.created_at * 1000,
      updatedAt: row.updated_at * 1000,
    }
  }
}
