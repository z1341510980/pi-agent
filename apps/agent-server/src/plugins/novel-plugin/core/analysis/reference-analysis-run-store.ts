import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export type ReferenceAnalysisRunStatus = 'queued' | 'running' | 'awaiting_review' | 'completed' | 'failed' | 'cancelled'
export type ReferenceAnalysisStage = 'validating_source' | 'parsing_text' | 'deterministic_analysis' | 'scene_analysis' | 'chapter_aggregation' | 'book_aggregation' | 'safety_scan' | 'awaiting_review' | 'completed' | 'failed' | 'cancelled'

export interface ReferenceAnalysisRun {
  id: string
  sourceId: string
  status: ReferenceAnalysisRunStatus
  currentStage: ReferenceAnalysisStage | null
  coverage: Record<string, unknown>
  providerId: string | null
  modelId: string | null
  extractorVersion: string | null
  promptVersion: string | null
  includedSectionIds: string[]
  semanticCoveragePolicy: Record<string, unknown>
  estimateSnapshot: Record<string, unknown>
  estimatedUsage: Record<string, unknown>
  actualUsage: Record<string, unknown>
  highCostConfirmed: boolean
  checkpoint: Record<string, unknown> | null
  error: string | null
  profileId: string | null
  attempt: number
  parentAttemptId: string | null
  createdAt: number
  updatedAt: number
  startedAt: number | null
  completedAt: number | null
  cancelledAt: number | null
}

export interface ReferenceObservation {
  id: string
  analysisRunId: string
  sectionId: string | null
  level: 'measurement' | 'scene' | 'chapter' | 'book'
  metric: string
  value: unknown
  measurementMethod: string | null
  confidence: number | null
  evidenceOffsets: unknown[]
  counterexampleOffsets: unknown[]
  safetyFlags: unknown[]
  createdAt: number
}

export interface ReferenceRunEvent {
  id: string
  runId: string
  runKind: 'analysis' | 'validation'
  sequence: number
  type: string
  stage: string | null
  summary: string
  cursor: string | null
  payload: Record<string, unknown>
  createdAt: number
}

interface RunRow {
  id: string; source_id: string; status: string; current_stage: string | null; coverage: string
  provider_id: string | null; model_id: string | null; extractor_version: string | null; prompt_version: string | null
  included_section_ids: string; semantic_coverage_policy: string; estimate_snapshot: string; estimated_usage: string
  actual_usage: string; high_cost_confirmed: number; checkpoint: string | null; error: string | null; profile_id: string | null
  attempt: number; parent_attempt_id: string | null; created_at: number; updated_at: number; started_at: number | null
  completed_at: number | null; cancelled_at: number | null
}

interface ObservationRow {
  id: string; analysis_run_id: string; section_id: string | null; level: string; metric: string; value: string
  measurement_method: string | null; confidence: number | null; evidence_offsets: string; counterexample_offsets: string
  safety_flags: string; created_at: number
}

export class ReferenceAnalysisRunStore {
  constructor(private readonly db: Database.Database) {}

  createRun(input: {
    sourceId: string
    providerId: string
    modelId: string
    includedSectionIds: string[]
    estimateSnapshot: Record<string, unknown>
    highCostConfirmed: boolean
    semanticCoveragePolicy?: Record<string, unknown>
    parentAttemptId?: string | null
    attempt?: number
  }): ReferenceAnalysisRun {
    const now = Date.now()
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO novel_reference_analysis_runs
        (id, source_id, status, current_stage, included_section_ids, semantic_coverage_policy,
         provider_id, model_id, estimate_snapshot, high_cost_confirmed, attempt, parent_attempt_id,
         created_at, updated_at)
      VALUES (?, ?, 'queued', 'validating_source', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.sourceId, JSON.stringify(input.includedSectionIds), JSON.stringify(input.semanticCoveragePolicy ?? {}),
      input.providerId, input.modelId, JSON.stringify(input.estimateSnapshot), input.highCostConfirmed ? 1 : 0,
      input.attempt ?? 1, input.parentAttemptId ?? null, now, now,
    )
    this.appendEvent(id, 'analysis', 'run_queued', 'validating_source', '远端分析已排队', { attempt: input.attempt ?? 1 }, now)
    return this.getRun(id)!
  }

  getRun(id: string): ReferenceAnalysisRun | undefined {
    const row = this.db.prepare('SELECT * FROM novel_reference_analysis_runs WHERE id = ?').get(id) as RunRow | undefined
    return row ? toRun(row) : undefined
  }

  listRuns(sourceId: string): ReferenceAnalysisRun[] {
    return (this.db.prepare('SELECT * FROM novel_reference_analysis_runs WHERE source_id = ? ORDER BY created_at DESC').all(sourceId) as RunRow[]).map(toRun)
  }

  setStage(id: string, stage: ReferenceAnalysisStage, summary: string, payload: Record<string, unknown> = {}): void {
    const now = Date.now()
    this.db.prepare(`UPDATE novel_reference_analysis_runs SET status = ?, current_stage = ?, updated_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ?`)
      .run(stage === 'awaiting_review' ? 'awaiting_review' : stage === 'completed' ? 'completed' : stage === 'failed' ? 'failed' : stage === 'cancelled' ? 'cancelled' : 'running', stage, now, now, id)
    this.appendEvent(id, 'analysis', 'stage_changed', stage, summary, payload, now)
  }

  setCheckpoint(id: string, checkpoint: Record<string, unknown>, actualUsage?: Record<string, unknown>): void {
    const now = Date.now()
    this.db.prepare(`UPDATE novel_reference_analysis_runs SET checkpoint = ?, actual_usage = COALESCE(?, actual_usage), updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(checkpoint), actualUsage ? JSON.stringify(actualUsage) : null, now, id)
    this.appendEvent(id, 'analysis', 'checkpoint_saved', null, '分析断点已保存', { checkpoint }, now)
  }

  addObservation(input: Omit<ReferenceObservation, 'id' | 'createdAt'>): ReferenceObservation {
    const id = randomUUID(); const now = Date.now()
    this.db.prepare(`
      INSERT INTO novel_reference_observations
        (id, analysis_run_id, section_id, level, metric, value, measurement_method, confidence, evidence_offsets, counterexample_offsets, safety_flags, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.analysisRunId, input.sectionId, input.level, input.metric, JSON.stringify(input.value), input.measurementMethod, input.confidence, JSON.stringify(input.evidenceOffsets), JSON.stringify(input.counterexampleOffsets), JSON.stringify(input.safetyFlags), now)
    return this.listObservations(input.analysisRunId).find((item) => item.id === id)!
  }

  listObservations(runId: string, level?: string, metric?: string): ReferenceObservation[] {
    const conditions = ['analysis_run_id = ?']; const params: Array<string> = [runId]
    if (level) { conditions.push('level = ?'); params.push(level) }
    if (metric) { conditions.push('metric = ?'); params.push(metric) }
    const rows = this.db.prepare(`SELECT * FROM novel_reference_observations WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`).all(...params) as ObservationRow[]
    return rows.map(toObservation)
  }

  cancel(id: string, reason: string): ReferenceAnalysisRun {
    const now = Date.now()
    this.db.prepare(`UPDATE novel_reference_analysis_runs SET status = 'cancelled', current_stage = 'cancelled', error = ?, cancelled_at = ?, updated_at = ? WHERE id = ?`).run(reason.slice(0, 2000), now, now, id)
    this.appendEvent(id, 'analysis', 'cancelled', 'cancelled', '分析已取消', { reason: reason.slice(0, 500) }, now)
    return this.getRun(id)!
  }

  complete(id: string, profileId?: string): ReferenceAnalysisRun {
    const now = Date.now()
    this.db.prepare(`UPDATE novel_reference_analysis_runs SET status = 'awaiting_review', current_stage = 'awaiting_review', profile_id = ?, completed_at = ?, updated_at = ? WHERE id = ?`).run(profileId ?? null, now, now, id)
    this.appendEvent(id, 'analysis', 'result_ready', 'awaiting_review', '分析结果已生成，等待审核', { profileId: profileId ?? null }, now)
    return this.getRun(id)!
  }

  fail(id: string, error: string): ReferenceAnalysisRun {
    const now = Date.now()
    this.db.prepare(`UPDATE novel_reference_analysis_runs SET status = 'failed', current_stage = 'failed', error = ?, updated_at = ? WHERE id = ?`).run(error.slice(0, 2000), now, id)
    this.appendEvent(id, 'analysis', 'failed', 'failed', '分析失败', { error: error.slice(0, 500) }, now)
    return this.getRun(id)!
  }

  listEvents(runId: string, afterSequence = 0): ReferenceRunEvent[] {
    const rows = this.db.prepare(`SELECT * FROM novel_reference_run_events WHERE run_id = ? AND sequence_no > ? ORDER BY sequence_no ASC`).all(runId, afterSequence) as Array<{ id: string; run_id: string; run_kind: 'analysis' | 'validation'; sequence_no: number; event_type: string; stage: string | null; summary: string; cursor: string | null; payload: string; created_at: number }>
    return rows.map((row) => ({ id: row.id, runId: row.run_id, runKind: row.run_kind, sequence: row.sequence_no, type: row.event_type, stage: row.stage, summary: row.summary, cursor: row.cursor, payload: parseObject(row.payload), createdAt: row.created_at }))
  }

  private appendEvent(runId: string, runKind: 'analysis' | 'validation', type: string, stage: string | null, summary: string, payload: Record<string, unknown>, createdAt: number): void {
    const row = this.db.prepare(`SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next FROM novel_reference_run_events WHERE run_id = ?`).get(runId) as { next: number }
    this.db.prepare(`INSERT INTO novel_reference_run_events (id, run_id, run_kind, sequence_no, event_type, stage, summary, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), runId, runKind, row.next, type, stage, summary, JSON.stringify(payload), createdAt)
  }
}

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {}
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {} } catch { return {} }
}
function parseArray(value: string): unknown[] { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [] } catch { return [] } }
function toRun(row: RunRow): ReferenceAnalysisRun {
  return { id: row.id, sourceId: row.source_id, status: row.status as ReferenceAnalysisRunStatus, currentStage: row.current_stage as ReferenceAnalysisStage | null, coverage: parseObject(row.coverage), providerId: row.provider_id, modelId: row.model_id, extractorVersion: row.extractor_version, promptVersion: row.prompt_version, includedSectionIds: parseArray(row.included_section_ids).filter((item): item is string => typeof item === 'string'), semanticCoveragePolicy: parseObject(row.semantic_coverage_policy), estimateSnapshot: parseObject(row.estimate_snapshot), estimatedUsage: parseObject(row.estimated_usage), actualUsage: parseObject(row.actual_usage), highCostConfirmed: row.high_cost_confirmed === 1, checkpoint: row.checkpoint ? parseObject(row.checkpoint) : null, error: row.error, profileId: row.profile_id, attempt: row.attempt, parentAttemptId: row.parent_attempt_id, createdAt: row.created_at, updatedAt: row.updated_at, startedAt: row.started_at, completedAt: row.completed_at, cancelledAt: row.cancelled_at }
}
function toObservation(row: ObservationRow): ReferenceObservation {
  return { id: row.id, analysisRunId: row.analysis_run_id, sectionId: row.section_id, level: row.level as ReferenceObservation['level'], metric: row.metric, value: parseObject(row.value), measurementMethod: row.measurement_method, confidence: row.confidence, evidenceOffsets: parseArray(row.evidence_offsets), counterexampleOffsets: parseArray(row.counterexample_offsets), safetyFlags: parseArray(row.safety_flags), createdAt: row.created_at }
}
