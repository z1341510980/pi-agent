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

interface StorylineRow {
  id: string
  project_id: string
  name: string
  kind: string
  lifecycle: string
  maturity: string
  description: string
  created_at: number
  updated_at: number
}

interface ProgressRow {
  id: string
  project_id: string
  storyline_id: string
  scene_revision_id: string
  primary_flag: number
  type: string
  before_state: string
  after_state: string
  summary: string
  status: string
  created_at: number
}

export interface ProgressIntent {
  storylineName: string
  primary?: boolean
  type?: 'setup' | 'advance' | 'turn' | 'reveal' | 'resolve' | 'pause'
  beforeState?: string
  afterState?: string
  summary?: string
}

export class NarrativeLedgerStore {
  constructor(private db: Database.Database) {}

  // ═══════════════════════════════════════════════════════════════
  // Storyline
  // ═══════════════════════════════════════════════════════════════

  /** 按 (project_id, name) 幂等取/建故事线（kind 仅首次生效） */
  ensureStoryline(projectId: string, name: string, kind = 'main', description = ''): NovelStoryline {
    const existing = this.db.prepare(
      'SELECT * FROM novel_storylines WHERE project_id = ? AND name = ?',
    ).get(projectId, name) as StorylineRow | undefined
    if (existing) return this.rowToStoryline(existing)
    const id = randomUUID()
    const ts = Math.floor(Date.now() / 1000)
    this.db.prepare(`
      INSERT INTO novel_storylines (id, project_id, name, kind, lifecycle, maturity, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', 'candidate', ?, ?, ?)
    `).run(id, projectId, name, kind, description, ts, ts)
    return this.db.prepare('SELECT * FROM novel_storylines WHERE id = ?').get(id) as NovelStoryline
  }

  getStoryline(id: string): NovelStoryline | undefined {
    const row = this.db.prepare('SELECT * FROM novel_storylines WHERE id = ?').get(id) as StorylineRow | undefined
    return row ? this.rowToStoryline(row) : undefined
  }

  listStorylines(projectId: string): NovelStoryline[] {
    const rows = this.db.prepare(
      'SELECT * FROM novel_storylines WHERE project_id = ? ORDER BY created_at ASC',
    ).all(projectId) as StorylineRow[]
    return rows.map((r) => this.rowToStoryline(r))
  }

  updateStoryline(id: string, patch: { lifecycle?: StorylineLifecycle; maturity?: StorylineMaturity; description?: string }): NovelStoryline | undefined {
    const current = this.getStoryline(id)
    if (!current) return undefined
    this.db.prepare(
      'UPDATE novel_storylines SET lifecycle = ?, maturity = ?, description = ?, updated_at = ? WHERE id = ?',
    ).run(
      patch.lifecycle ?? current.lifecycle,
      patch.maturity ?? current.maturity,
      patch.description ?? current.description,
      Math.floor(Date.now() / 1000),
      id,
    )
    return this.getStoryline(id)
  }

  /**
   * 成熟度晋升规则：candidate 在至少两个不同 scene_revision 上有 confirmed progress，
   * 或人工确认后 established。
   */
  maybePromoteMaturity(storylineId: string): NovelStoryline {
    const confirmed = this.db.prepare(
      `SELECT COUNT(DISTINCT scene_revision_id) as cnt
       FROM novel_storyline_progress
       WHERE storyline_id = ? AND status = 'confirmed'`,
    ).get(storylineId) as { cnt: number }
    if (confirmed.cnt >= 2) {
      this.db.prepare(
        'UPDATE novel_storylines SET maturity = ?, updated_at = ? WHERE id = ?',
      ).run('established', Math.floor(Date.now() / 1000), storylineId)
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
        const existing = this.db.prepare(
          'SELECT * FROM novel_storyline_progress WHERE scene_revision_id = ? AND storyline_id = ?',
        ).get(sceneRevisionId, storyline.id) as ProgressRow | undefined
        if (existing) {
          results.push(this.rowToProgress(existing))
          continue
        }
        const id = randomUUID()
        this.db.prepare(`
          INSERT INTO novel_storyline_progress
            (id, project_id, storyline_id, scene_revision_id, primary_flag, type,
             before_state, after_state, summary, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, projectId, storyline.id, sceneRevisionId, intent.primary ? 1 : 0,
          intent.type ?? 'advance', intent.beforeState ?? '', intent.afterState ?? '',
          intent.summary ?? '', status, Math.floor(Date.now() / 1000),
        )
        results.push(this.rowToProgress(
          this.db.prepare('SELECT * FROM novel_storyline_progress WHERE id = ?').get(id) as ProgressRow,
        ))
      }
      return results
    })()
  }

  listProgressByStoryline(storylineId: string, statuses?: ProgressStatus[]): NovelStorylineProgress[] {
    const rows = statuses && statuses.length > 0
      ? this.db.prepare(
        `SELECT * FROM novel_storyline_progress WHERE storyline_id = ? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at ASC`,
      ).all(storylineId, ...statuses) as ProgressRow[]
      : this.db.prepare(
        'SELECT * FROM novel_storyline_progress WHERE storyline_id = ? ORDER BY created_at ASC',
      ).all(storylineId) as ProgressRow[]
    return rows.map((r) => this.rowToProgress(r))
  }

  listProgressByScene(sceneRevisionId: string): NovelStorylineProgress[] {
    const rows = this.db.prepare(
      'SELECT * FROM novel_storyline_progress WHERE scene_revision_id = ? ORDER BY created_at ASC',
    ).all(sceneRevisionId) as ProgressRow[]
    return rows.map((r) => this.rowToProgress(r))
  }

  getProgress(id: string): NovelStorylineProgress | undefined {
    const row = this.db.prepare('SELECT * FROM novel_storyline_progress WHERE id = ?').get(id) as ProgressRow | undefined
    return row ? this.rowToProgress(row) : undefined
  }

  /** Memory 确认正文后：planned → confirmed，并尝试晋升故事线成熟度 */
  confirmProgress(id: string): NovelStorylineProgress {
    const current = this.getProgress(id)
    if (!current) throw new Error(`推进记录不存在: ${id}`)
    this.db.prepare('UPDATE novel_storyline_progress SET status = ? WHERE id = ?').run('confirmed', id)
    this.maybePromoteMaturity(current.storylineId)
    return this.getProgress(id)!
  }

  /** 中间章重写后：把起始章及其后所有已确认推进标 stale。 */
  markStaleFromChapter(projectId: string, chapterId: string): number {
    const affectedSceneRevisions = `
      SELECT sr.id FROM novel_scene_revisions sr
      JOIN novel_scenes s ON s.id = sr.scene_id
      JOIN novel_chapters c ON c.id = s.chapter_id
      WHERE c.project_id = ?
        AND c.chapter_number >= (
          SELECT start.chapter_number FROM novel_chapters start
          WHERE start.id = ? AND start.project_id = ?
        )
    `
    this.db.prepare(`
      UPDATE novel_storyline_progress SET status = 'stale'
      WHERE project_id = ? AND status = 'confirmed'
        AND scene_revision_id IN (${affectedSceneRevisions})
    `).run(projectId, projectId, chapterId, projectId)
    // 返回整个受影响范围，重复调用仍可向路由准确报告待重建数量。
    return (this.db.prepare(`
      SELECT COUNT(*) AS count FROM novel_storyline_progress
      WHERE project_id = ? AND status = 'stale'
        AND scene_revision_id IN (${affectedSceneRevisions})
    `).get(projectId, projectId, chapterId, projectId) as { count: number }).count
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
