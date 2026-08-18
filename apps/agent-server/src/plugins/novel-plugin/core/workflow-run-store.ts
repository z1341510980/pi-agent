import type Database from 'better-sqlite3'
import type { CreationPhase } from '@repo/shared/novel'
import type { NarrativeTask, RhythmSuggestion, ArrangedEntity } from './types.js'
import type { PluginSessionOptions } from '../../../core/plugin/plugin-types.js'

/**
 * 工作流断点续跑快照的"推进阶段"。
 *
 * - writing：Director 叙事任务已批准，Writer 尚未产出可用草稿
 * - reviewing：Writer 草稿已成（writerDraft），尚未通过验收检查点
 * - memory：正文已定稿（finalContent），只差落库与记忆提取
 */
export type WorkflowRunPhase = 'writing' | 'reviewing' | 'memory'

/** 续跑入口与快照载荷（orchestrator 读取后跳过已完成阶段） */
export interface WorkflowResumeState {
  entry: WorkflowRunPhase
  directorTask?: NarrativeTask
  directorOutput?: string
  rhythmSuggestion?: RhythmSuggestion
  arrangedEntities?: ArrangedEntity
  writerDraft?: string
  finalContent?: string
}

export interface WorkflowRunSnapshot {
  id: string
  projectId: string
  chapterNumber: number
  /** running=阶段边界已落库但流程未终结（进程崩溃时残留，同样可续跑） */
  status: 'running' | 'completed' | 'cancelled' | 'error'
  /** 快照推进到的阶段（最后一次成功落库的阶段边界） */
  phase?: WorkflowRunPhase
  /** 失败时所在的流程阶段（status='error' 时标注） */
  failedPhase?: CreationPhase
  directorTask?: NarrativeTask
  directorOutput?: string
  rhythmSuggestion?: RhythmSuggestion
  arrangedEntities?: ArrangedEntity
  writerDraft?: string
  finalContent?: string
  /** 本次运行使用的 per-call 模型；续跑沿用，避免同一次创作换模型 */
  modelId?: PluginSessionOptions['modelId']
  styleExpertIds?: string[]
  error?: string
  resumedFromRunId?: string
  createdAt: number
  updatedAt: number
}

export type SaveWorkflowRunInput = Omit<WorkflowRunSnapshot, 'createdAt' | 'updatedAt'>

interface WorkflowRunRow {
  id: string
  project_id: string
  chapter_number: number
  status: string
  phase: string | null
  failed_phase: string | null
  director_task: string | null
  director_output: string | null
  rhythm_suggestion: string | null
  arranged_entities: string | null
  writer_draft: string | null
  final_content: string | null
  model_id: string | null
  style_expert_ids: string | null
  error: string | null
  resumed_from_run_id: string | null
  created_at: number
  updated_at: number
}

/**
 * 工作流运行快照存储（novel_workflow_runs）。
 *
 * 与 DiscussionRunStore 同构：create-flow 在阶段边界 upsert 快照，
 * 失败时标记 status='error' + failedPhase；续跑端点据此重建上下文，
 * 跳过已完成阶段（Director / Writer 是 token 大头，失败重烧代价最高）。
 */
export class WorkflowRunStore {
  private readonly stmtUpsert: Database.Statement
  private readonly stmtGet: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.stmtUpsert = db.prepare(`
      INSERT INTO novel_workflow_runs (
        id, project_id, chapter_number, status, phase, failed_phase,
        director_task, director_output, rhythm_suggestion, arranged_entities,
        writer_draft, final_content, model_id, style_expert_ids, error, resumed_from_run_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        phase = excluded.phase,
        failed_phase = excluded.failed_phase,
        director_task = excluded.director_task,
        director_output = excluded.director_output,
        rhythm_suggestion = excluded.rhythm_suggestion,
        arranged_entities = excluded.arranged_entities,
        writer_draft = excluded.writer_draft,
        final_content = excluded.final_content,
        model_id = excluded.model_id,
        style_expert_ids = excluded.style_expert_ids,
        error = excluded.error,
        resumed_from_run_id = excluded.resumed_from_run_id,
        updated_at = excluded.updated_at
    `)
    this.stmtGet = db.prepare(`
      SELECT id, project_id, chapter_number, status, phase, failed_phase,
             director_task, director_output, rhythm_suggestion, arranged_entities,
             writer_draft, final_content, model_id, style_expert_ids, error, resumed_from_run_id,
             created_at, updated_at
      FROM novel_workflow_runs
      WHERE id = ?
    `)
  }

  save(input: SaveWorkflowRunInput): WorkflowRunSnapshot {
    const existing = this.get(input.id)
    const now = Date.now()
    const createdAt = existing?.createdAt ?? now
    this.stmtUpsert.run(
      input.id,
      input.projectId,
      input.chapterNumber,
      input.status,
      input.phase ?? null,
      input.failedPhase ?? null,
      input.directorTask ? JSON.stringify(input.directorTask) : null,
      input.directorOutput ?? null,
      input.rhythmSuggestion ? JSON.stringify(input.rhythmSuggestion) : null,
      input.arrangedEntities ? JSON.stringify(input.arrangedEntities) : null,
      input.writerDraft ?? null,
      input.finalContent ?? null,
      input.modelId ? JSON.stringify(input.modelId) : null,
      input.styleExpertIds ? JSON.stringify(input.styleExpertIds) : null,
      input.error ?? null,
      input.resumedFromRunId ?? null,
      Math.floor(createdAt / 1000),
      Math.floor(now / 1000),
    )
    return { ...input, createdAt, updatedAt: now }
  }

  get(id: string): WorkflowRunSnapshot | undefined {
    const row = this.stmtGet.get(id) as WorkflowRunRow | undefined
    return row ? this.rowToSnapshot(row) : undefined
  }

  /**
   * 最近一条可续跑快照（status='error' 或崩溃残留的 'running'，且有阶段产物）。
   * 供前端「/继续」与错误恢复入口在无 runId 时定位（应用重启后 result 丢失）。
   */
  getLatestResumable(projectId: string, chapterNumber: number): WorkflowRunSnapshot | undefined {
    const row = this.db.prepare(`
      SELECT id, project_id, chapter_number, status, phase, failed_phase,
             director_task, director_output, rhythm_suggestion, arranged_entities,
             writer_draft, final_content, model_id, style_expert_ids, error, resumed_from_run_id,
             created_at, updated_at
      FROM novel_workflow_runs
      WHERE project_id = ? AND chapter_number = ? AND phase IS NOT NULL
        AND status IN ('error', 'running')
      ORDER BY rowid DESC
      LIMIT 1
    `).get(projectId, chapterNumber) as WorkflowRunRow | undefined
    return row ? this.rowToSnapshot(row) : undefined
  }

  private rowToSnapshot(row: WorkflowRunRow): WorkflowRunSnapshot {
    return {
      id: row.id,
      projectId: row.project_id,
      chapterNumber: row.chapter_number,
      status: row.status as WorkflowRunSnapshot['status'],
      phase: row.phase as WorkflowRunPhase | undefined,
      failedPhase: row.failed_phase as CreationPhase | undefined,
      directorTask: row.director_task ? JSON.parse(row.director_task) as NarrativeTask : undefined,
      directorOutput: row.director_output ?? undefined,
      rhythmSuggestion: row.rhythm_suggestion ? JSON.parse(row.rhythm_suggestion) : undefined,
      arrangedEntities: row.arranged_entities
        ? JSON.parse(row.arranged_entities) as ArrangedEntity
        : undefined,
      writerDraft: row.writer_draft ?? undefined,
      finalContent: row.final_content ?? undefined,
       modelId: row.model_id ? JSON.parse(row.model_id) as PluginSessionOptions['modelId'] : undefined,
      styleExpertIds: row.style_expert_ids ? JSON.parse(row.style_expert_ids) as string[] : undefined,
      error: row.error ?? undefined,
      resumedFromRunId: row.resumed_from_run_id ?? undefined,
      createdAt: row.created_at * 1000,
      updatedAt: row.updated_at * 1000,
    }
  }
}
