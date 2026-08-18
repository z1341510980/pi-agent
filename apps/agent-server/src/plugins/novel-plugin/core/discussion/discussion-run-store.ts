import type Database from 'better-sqlite3'
import type {
  DiscussionMessage,
  DiscussionPhase,
  SceneDefinition,
} from './../../../../core/agent/discussion-types.js'
import type { ArrangedEntity } from '../types.js'

export interface DiscussionRunSnapshot {
  id: string
  projectId: string
  chapterNumber: number
  status: 'completed' | 'cancelled' | 'error'
  failedPhase?: DiscussionPhase
  /** failedPhase='acting'/'scene_setup' 时中断的场景 ID（断点续跑从此场景继续） */
  failedSceneId?: number
  transcript: DiscussionMessage[]
  scenes: SceneDefinition[]
  arrangedEntities?: ArrangedEntity
  /** 首次运行显式选择的成员模型；有选择时断点续跑必须沿用，避免同一次创作换模型。 */
  memberModel?: { provider: string; modelId: string }
  /** 首次运行冻结的项目主模型；断点续跑不得读取后来变更的项目设置。 */
  projectModel?: { provider: string; modelId: string } | null
  styleExpertIds?: string[]
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
  failed_scene_id: number | null
  transcript: string
  scenes: string
  arranged_entities: string | null
  member_model: string | null
  project_model: string | null
  style_expert_ids: string | null
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
        id, project_id, chapter_number, status, failed_phase, failed_scene_id,
        transcript, scenes, arranged_entities, member_model, project_model, style_expert_ids, content, error,
        resumed_from_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        failed_phase = excluded.failed_phase,
        failed_scene_id = excluded.failed_scene_id,
        transcript = excluded.transcript,
        scenes = excluded.scenes,
        arranged_entities = excluded.arranged_entities,
        member_model = excluded.member_model,
        project_model = excluded.project_model,
        style_expert_ids = excluded.style_expert_ids,
        content = excluded.content,
        error = excluded.error,
        resumed_from_run_id = excluded.resumed_from_run_id,
        updated_at = excluded.updated_at
    `)
    this.stmtGet = db.prepare(`
      SELECT id, project_id, chapter_number, status, failed_phase, failed_scene_id,
             transcript, scenes, arranged_entities, member_model, project_model, style_expert_ids, content, error,
             resumed_from_run_id, created_at, updated_at
      FROM novel_discussion_runs
      WHERE id = ?
    `)
  }

  save(input: SaveDiscussionRunInput): DiscussionRunSnapshot {
    const existing = this.get(input.id)
    const now = Date.now()
    const createdAt = existing?.createdAt ?? now
    // 这里保存的是某次运行的恢复输入，不是规范场景实体。V2 场景表保存稳定身份，
    // 无法替代失败运行当时的 SceneDefinition 和实体选择。
    this.stmtUpsert.run(
      input.id,
      input.projectId,
      input.chapterNumber,
      input.status,
      input.failedPhase ?? null,
      input.failedSceneId ?? null,
      JSON.stringify(input.transcript),
      JSON.stringify(input.scenes),
      input.arrangedEntities ? JSON.stringify(input.arrangedEntities) : null,
      input.memberModel ? JSON.stringify(input.memberModel) : null,
      input.projectModel === undefined ? null : JSON.stringify(input.projectModel),
      input.styleExpertIds ? JSON.stringify(input.styleExpertIds) : null,
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
      failedSceneId: row.failed_scene_id ?? undefined,
      transcript: JSON.parse(row.transcript) as DiscussionMessage[],
      scenes: JSON.parse(row.scenes) as SceneDefinition[],
      arrangedEntities: row.arranged_entities
        ? JSON.parse(row.arranged_entities) as ArrangedEntity
        : undefined,
      memberModel: row.member_model
        ? JSON.parse(row.member_model) as { provider: string; modelId: string }
        : undefined,
      projectModel: row.project_model
        ? JSON.parse(row.project_model) as { provider: string; modelId: string } | null
        : undefined,
      styleExpertIds: row.style_expert_ids ? JSON.parse(row.style_expert_ids) as string[] : undefined,
      content: row.content ?? undefined,
      error: row.error ?? undefined,
      resumedFromRunId: row.resumed_from_run_id ?? undefined,
      createdAt: row.created_at * 1000,
      updatedAt: row.updated_at * 1000,
    }
  }
}
