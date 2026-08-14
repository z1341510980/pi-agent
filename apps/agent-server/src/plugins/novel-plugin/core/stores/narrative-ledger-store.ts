/**
 * NarrativeLedgerStore：叙事账本（T02b）。
 *
 * 承载「跨场景持续的叙事方向」Storyline 与其推进记录 StorylineProgress。
 * - storyline：active/paused/resolved/abandoned + 成熟度 candidate/established
 *   （candidate 在至少两个不同 Scene 有 confirmed Progress 或人工确认后 established）。
 * - progress 绑定 scene_revision_id；状态 planned → confirmed（Memory 确认正文）
 *   / superseded / stale（中间章重写后上游失效）。
 *
 * 与 story ledger（novel_story_events / memory_events）分工：本表记录"故事线怎样推进"，
 * 事件表记录"发生了什么"；两表通过 scene_revision_id 间接关联。
 */
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  NovelStoryline,
  StorylineLifecycle,
  StorylineMaturity,
  NovelStorylineProgress,
  ProgressStatus,
} from '../types.js'
import { createNovelDrizzleDb, LedgerRepository } from '../../infrastructure/sqlite/index.js'
import type { ProgressRow, StorylineRow } from '../../infrastructure/sqlite/repositories/ledger-repository.js'

export interface ProgressIntent {
  storylineName: string
  primary?: boolean
  type?: 'setup' | 'advance' | 'turn' | 'reveal' | 'resolve' | 'pause'
  beforeState?: string
  afterState?: string
  summary?: string
}

export class NarrativeLedgerStore {
  private readonly repository: LedgerRepository

  constructor(private db: Database.Database) {
    this.repository = new LedgerRepository(createNovelDrizzleDb(db))
  }

  // ═══════════════════════════════════════════════════════════════
  // Storyline
  // ═══════════════════════════════════════════════════════════════

  /** 按 (project_id, name) 幂等取/建故事线（kind 仅首次生效） */
  ensureStoryline(projectId: string, name: string, kind = 'main', description = ''): NovelStoryline {
    const existing = this.repository.getStorylineByName(projectId, name)
    if (existing) return this.rowToStoryline(existing)
    const id = randomUUID()
    const ts = Math.floor(Date.now() / 1000)
    this.repository.insertStoryline({ id, project_id: projectId, name, kind, lifecycle: 'active', maturity: 'candidate', description, created_at: ts, updated_at: ts })
    return this.rowToStoryline(this.repository.getStoryline(id)!)
  }

  getStoryline(id: string): NovelStoryline | undefined {
    const row = this.repository.getStoryline(id)
    return row ? this.rowToStoryline(row) : undefined
  }

  listStorylines(projectId: string): NovelStoryline[] {
    const rows = this.repository.listStorylines(projectId)
    return rows.map((r) => this.rowToStoryline(r))
  }

  updateStoryline(id: string, patch: { lifecycle?: StorylineLifecycle; maturity?: StorylineMaturity; description?: string }): NovelStoryline | undefined {
    const current = this.getStoryline(id)
    if (!current) return undefined
    this.repository.updateStoryline(id, {
      id: current.id, project_id: current.projectId, name: current.name, kind: current.kind,
      lifecycle: patch.lifecycle ?? current.lifecycle, maturity: patch.maturity ?? current.maturity,
      description: patch.description ?? current.description, created_at: current.createdAt, updated_at: Math.floor(Date.now() / 1000),
    })
    return this.getStoryline(id)
  }

  /**
   * 成熟度晋升规则：candidate 在至少两个不同 scene_revision 上有 confirmed progress，
   * 或人工确认后 established。
   */
  maybePromoteMaturity(storylineId: string): NovelStoryline {
    const confirmed = this.repository.countConfirmedScenes(storylineId)
    if (confirmed >= 2) {
      const current = this.getStoryline(storylineId)
      if (current) this.repository.updateStoryline(storylineId, {
        id: current.id, project_id: current.projectId, name: current.name, kind: current.kind,
        lifecycle: current.lifecycle, maturity: 'established', description: current.description,
        created_at: current.createdAt, updated_at: Math.floor(Date.now() / 1000),
      })
    }
    return this.getStoryline(storylineId)!
  }

  // ═══════════════════════════════════════════════════════════════
  // StorylineProgress
  // ═══════════════════════════════════════════════════════════════

  /**
   * 为某场景版本记录一条或多条推进（事务）。
   * 幂等：同 (scene_revision_id, storyline_id) 已存在则不重复插入。
   * 同场景最多一条 primary（partial unique 兜底）。
   */
  recordProgressForScene(
    projectId: string,
    sceneRevisionId: string,
    intents: ProgressIntent[],
    status: ProgressStatus = 'planned',
  ): NovelStorylineProgress[] {
    if (intents.length === 0) return []
    return this.db.transaction(() => {
      const results: NovelStorylineProgress[] = []
      for (const intent of intents) {
        const storyline = this.ensureStoryline(projectId, intent.storylineName)
        const existing = this.repository.getProgressBySceneAndStoryline(sceneRevisionId, storyline.id)
        if (existing) {
          results.push(this.rowToProgress(existing))
          continue
        }
        const id = randomUUID()
        this.repository.insertProgress({ id, project_id: projectId, storyline_id: storyline.id, scene_revision_id: sceneRevisionId, primary_flag: intent.primary ? 1 : 0, type: intent.type ?? 'advance', before_state: intent.beforeState ?? '', after_state: intent.afterState ?? '', summary: intent.summary ?? '', status, created_at: Math.floor(Date.now() / 1000) })
        results.push(this.rowToProgress(this.repository.getProgress(id)!))
      }
      return results
    })()
  }

  listProgressByStoryline(storylineId: string, statuses?: ProgressStatus[]): NovelStorylineProgress[] {
    const rows = this.repository.listProgressByStoryline(storylineId, statuses)
    return rows.map((r) => this.rowToProgress(r))
  }

  listProgressByScene(sceneRevisionId: string, includeStale = false): NovelStorylineProgress[] {
    const rows = this.repository.listProgressByScene(sceneRevisionId, includeStale)
    return rows.map((r) => this.rowToProgress(r))
  }

  getProgress(id: string): NovelStorylineProgress | undefined {
    const row = this.repository.getProgress(id)
    return row ? this.rowToProgress(row) : undefined
  }

  /** Memory 确认正文后：planned → confirmed，并尝试晋升故事线成熟度 */
  confirmProgress(id: string): NovelStorylineProgress {
    const current = this.getProgress(id)
    if (!current) throw new Error(`推进记录不存在: ${id}`)
    this.repository.updateProgressStatus(id, 'confirmed')
    this.maybePromoteMaturity(current.storylineId)
    return this.getProgress(id)!
  }

  /** 中间章重写后：把起始章及其后所有已确认推进标 stale。 */
  markStaleFromChapter(projectId: string, chapterId: string): number {
    return this.repository.markStaleFromChapter(projectId, chapterId)
  }

  private rowToStoryline(row: StorylineRow): NovelStoryline {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      kind: row.kind,
      lifecycle: row.lifecycle as StorylineLifecycle,
      maturity: row.maturity as StorylineMaturity,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private rowToProgress(row: ProgressRow): NovelStorylineProgress {
    return {
      id: row.id,
      projectId: row.project_id,
      storylineId: row.storyline_id,
      sceneRevisionId: row.scene_revision_id,
      primary: row.primary_flag === 1,
      type: row.type as NovelStorylineProgress['type'],
      beforeState: row.before_state,
      afterState: row.after_state,
      summary: row.summary,
      status: row.status as ProgressStatus,
      createdAt: row.created_at,
    }
  }
}
