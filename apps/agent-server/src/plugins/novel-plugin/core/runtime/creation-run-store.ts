import type Database from 'better-sqlite3'
import {
  createCreationRun,
  transitionCreationRun,
  type CreateCreationRunInput,
  type CreationRunCommand,
  type CreationRunMode,
  type CreationRunStage,
  type CreationRunState,
  type CreationRunStatus,
} from './creation-run-state.js'

export interface CreationRunEvent {
  runId: string
  seq: number
  type: 'submitted' | CreationRunCommand['type']
  payload: Record<string, unknown>
  createdAt: number
}

interface CreationRunRow {
  run_id: string
  project_id: string
  chapter_number: number
  mode: string
  status: string
  stage: string
  revision: number
  checkpoint_id: string | null
  error: string | null
  created_at: number
  updated_at: number
}

interface CreationRunEventRow {
  run_id: string
  seq: number
  type: string
  payload: string
  created_at: number
}

/** Durable state and append-only events for the shared creation lifecycle. */
export class CreationRunStore {
  private readonly stmtGet: Database.Statement
  private readonly stmtGetActive: Database.Statement
  private readonly stmtListEvents: Database.Statement
  private readonly stmtNextSeq: Database.Statement
  private readonly stmtInsertEvent: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.stmtGet = db.prepare(`
      SELECT run_id, project_id, chapter_number, mode, status, stage, revision,
             checkpoint_id, error, created_at, updated_at
        FROM novel_creation_runs
       WHERE run_id = ?
    `)
    this.stmtGetActive = db.prepare(`
      SELECT run_id, project_id, chapter_number, mode, status, stage, revision,
             checkpoint_id, error, created_at, updated_at
        FROM novel_creation_runs
       WHERE project_id = ? AND chapter_number = ?
         AND status IN ('submitted', 'running', 'waiting_input', 'revising')
       ORDER BY created_at DESC
       LIMIT 1
    `)
    this.stmtListEvents = db.prepare(`
      SELECT run_id, seq, type, payload, created_at
        FROM novel_creation_run_events
       WHERE run_id = ? AND seq >= ?
       ORDER BY seq ASC
    `)
    this.stmtNextSeq = db.prepare(`
      SELECT COALESCE(MAX(seq), 0) + 1 AS seq
        FROM novel_creation_run_events
       WHERE run_id = ?
    `)
    this.stmtInsertEvent = db.prepare(`
      INSERT INTO novel_creation_run_events (run_id, seq, type, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
  }

  create(input: CreateCreationRunInput): CreationRunState {
    const transaction = this.db.transaction(() => {
      if (this.findActive(input.projectId, input.chapterNumber)) {
        throw new Error(`An active run already exists for chapter ${input.chapterNumber}`)
      }
      const state = createCreationRun(input)
      this.db.prepare(`
        INSERT INTO novel_creation_runs (
          run_id, project_id, chapter_number, mode, status, stage, revision,
          checkpoint_id, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        state.runId,
        state.projectId,
        state.chapterNumber,
        state.mode,
        state.status,
        state.stage,
        state.revision,
        null,
        null,
        state.createdAt,
        state.updatedAt,
      )
      this.appendEvent(state.runId, 'submitted', { state }, state.createdAt)
      return state
    })
    return transaction.immediate()
  }

  get(runId: string): CreationRunState | undefined {
    const row = this.stmtGet.get(runId) as CreationRunRow | undefined
    return row ? rowToState(row) : undefined
  }

  findActive(projectId: string, chapterNumber: number): CreationRunState | undefined {
    const row = this.stmtGetActive.get(projectId, chapterNumber) as CreationRunRow | undefined
    return row ? rowToState(row) : undefined
  }

  reconcileInterruptedRuns(reason: string, now: number = Date.now()): number {
    const rows = this.db.prepare(`
      SELECT run_id, project_id, chapter_number, mode, status, stage, revision,
             checkpoint_id, error, created_at, updated_at
        FROM novel_creation_runs
       WHERE status IN ('submitted', 'running', 'waiting_input', 'revising')
    `).all() as CreationRunRow[]
    for (const row of rows) {
      this.dispatch(row.run_id, { type: 'fail', reason }, now)
    }
    return rows.length
  }

  dispatch(
    runId: string,
    command: CreationRunCommand,
    now: number = Date.now(),
  ): CreationRunState {
    const transaction = this.db.transaction(() => {
      const current = this.get(runId)
      if (!current) throw new Error(`Creation run not found: ${runId}`)
      const transition = transitionCreationRun(current, command, now)
      const result = this.db.prepare(`
        UPDATE novel_creation_runs
           SET status = ?, stage = ?, revision = ?, checkpoint_id = ?, error = ?, updated_at = ?
         WHERE run_id = ?
      `).run(
        transition.state.status,
        transition.state.stage,
        transition.state.revision,
        transition.state.checkpointId ?? null,
        transition.state.error ?? null,
        transition.state.updatedAt,
        runId,
      )
      if (result.changes !== 1) throw new Error(`Creation run disappeared during transition: ${runId}`)
      this.appendEvent(runId, command.type, {
        ...transition.event,
        command,
        state: transition.state,
      }, now)
      return transition.state
    })
    return transaction.immediate()
  }

  events(runId: string, fromSeq = 1): CreationRunEvent[] {
    const rows = this.stmtListEvents.all(runId, fromSeq) as CreationRunEventRow[]
    return rows.map(row => ({
      runId: row.run_id,
      seq: row.seq,
      type: row.type as CreationRunEvent['type'],
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      createdAt: row.created_at,
    }))
  }

  private appendEvent(
    runId: string,
    type: CreationRunEvent['type'],
    payload: Record<string, unknown>,
    createdAt: number,
  ): void {
    const seq = (this.stmtNextSeq.get(runId) as { seq: number }).seq
    this.stmtInsertEvent.run(runId, seq, type, JSON.stringify(payload), createdAt)
  }
}

function rowToState(row: CreationRunRow): CreationRunState {
  return {
    runId: row.run_id,
    projectId: row.project_id,
    chapterNumber: row.chapter_number,
    mode: row.mode as CreationRunMode,
    status: row.status as CreationRunStatus,
    stage: row.stage as CreationRunStage,
    revision: row.revision,
    checkpointId: row.checkpoint_id ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
