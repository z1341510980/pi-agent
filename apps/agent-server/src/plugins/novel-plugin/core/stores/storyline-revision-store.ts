/**
 * StorylineRevisionStore：故事线人工 revision（M2，方案 §7）。
 *
 * novel_storylines 只存身份（name/kind/lifecycle/maturity），可变规范事实
 * （summary/goal/stakes/actor）由 novel_storyline_revisions 承载。
 * 状态机：draft → submitted → approved|rejected|superseded；仅 approved 成为当前规范事实。
 *
 * 审核角色/状态机与正文 content revision 的绑定关系属 §16 待确认项，这里采用
 * 文档 §7 写明的保守默认；每次写操作通过 expectedRevision 乐观锁防并发覆盖。
 */
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export type StorylineRevisionStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'superseded'

export interface StorylineRevision {
  id: string
  storylineId: string
  projectId: string
  supersedesId: string | null
  revision: number
  status: StorylineRevisionStatus
  summary: string
  goal: string
  stakes: string
  actor: string
  note: string
  decisionNote: string
  reviewer: string
  expectedVersion: number
  createdAt: number
  updatedAt: number
  supersededAt: number | null
}

export interface StorylineDraftInput {
  expectedRevision: number
  summary: string
  goal: string
  stakes: string
  actor: string
  note?: string
}

export interface StorylineReviewDecision {
  decision: 'approve' | 'reject'
  note?: string
  reviewer?: string
}

interface StorylineRevisionRow {
  id: string
  storyline_id: string
  project_id: string
  supersedes_id: string | null
  revision: number
  status: string
  summary: string
  goal: string
  stakes: string
  actor: string
  note: string
  decision_note: string
  reviewer: string
  expected_version: number
  created_at: number
  updated_at: number
  superseeded_at: number | null
}

export class StorylineRevisionStore {
  constructor(private readonly db: Database.Database) {}

  /** 当前最新 revision 号（乐观锁基线）；无 revision 时为 0。 */
  private currentRevisionNumber(storylineId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(revision), 0) AS revision FROM novel_storyline_revisions WHERE storyline_id = ?
    `).get(storylineId) as { revision: number }
    return row.revision
  }

  getCurrentRevision(storylineId: string): StorylineRevision | undefined {
    const row = this.db.prepare(`
      SELECT r.* FROM novel_storyline_revisions r
      JOIN novel_storylines s ON s.id = r.storyline_id AND s.current_revision_id = r.id
      WHERE r.storyline_id = ?
    `).get(storylineId) as StorylineRevisionRow | undefined
    return row ? rowToRevision(row) : undefined
  }

  getRevision(id: string): StorylineRevision | undefined {
    const row = this.db.prepare('SELECT * FROM novel_storyline_revisions WHERE id = ?').get(id) as StorylineRevisionRow | undefined
    return row ? rowToRevision(row) : undefined
  }

  listRevisions(storylineId: string): StorylineRevision[] {
    const rows = this.db.prepare(`
      SELECT * FROM novel_storyline_revisions WHERE storyline_id = ? ORDER BY revision ASC
    `).all(storylineId) as StorylineRevisionRow[]
    return rows.map(rowToRevision)
  }

  /** 创建草稿 revision；expectedRevision 必须等于当前最新 revision 号，否则抛错（乐观锁）。 */
  createDraft(storylineId: string, projectId: string, input: StorylineDraftInput): StorylineRevision {
    const latest = this.currentRevisionNumber(storylineId)
    if (input.expectedRevision !== latest) {
      throw new Error(`故事线版本已变化，预期 revision=${input.expectedRevision}，实际=${latest}`)
    }
    const now = Date.now()
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO novel_storyline_revisions
        (id, storyline_id, project_id, revision, status, summary, goal, stakes, actor, note,
         decision_note, reviewer, expected_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, '', 'user', ?, ?, ?)
    `).run(id, storylineId, projectId, latest + 1, input.summary, input.goal, input.stakes, input.actor, input.note ?? '', latest + 1, now, now)
    return this.getRevision(id)!
  }

  submit(revisionId: string): StorylineRevision {
    const current = this.getRevision(revisionId)
    if (!current) throw new Error('故事线修订不存在')
    if (current.status !== 'draft') throw new Error('只有草稿可提交审核')
    this.db.prepare(`UPDATE novel_storyline_revisions SET status = 'submitted', updated_at = ? WHERE id = ?`).run(Date.now(), revisionId)
    return this.getRevision(revisionId)!
  }

  approve(revisionId: string, decision: StorylineReviewDecision): StorylineRevision {
    if (decision.decision !== 'approve') throw new Error('请调用 reject 处理拒绝')
    const current = this.getRevision(revisionId)
    if (!current) throw new Error('故事线修订不存在')
    if (current.status !== 'submitted') throw new Error('只有已提交的修订可批准')
    const now = Date.now()
    this.db.transaction(() => {
      // 旧的 approved 修订全部 superseded，仅保留最新为当前规范事实。
      this.db.prepare(`
        UPDATE novel_storyline_revisions SET status = 'superseded', superseeded_at = ?
        WHERE storyline_id = ? AND status = 'approved'
      `).run(now, current.storylineId)
      this.db.prepare(`
        UPDATE novel_storyline_revisions SET status = 'approved', decision_note = ?, reviewer = ?, updated_at = ?
        WHERE id = ?
      `).run(decision.note ?? '', decision.reviewer ?? 'user', now, revisionId)
      this.db.prepare(`UPDATE novel_storylines SET current_revision_id = ?, updated_at = ? WHERE id = ?`).run(revisionId, now, current.storylineId)
    })()
    return this.getRevision(revisionId)!
  }

  reject(revisionId: string, decision: StorylineReviewDecision): StorylineRevision {
    if (decision.decision !== 'reject') throw new Error('请调用 approve 处理批准')
    const current = this.getRevision(revisionId)
    if (!current) throw new Error('故事线修订不存在')
    if (current.status !== 'submitted') throw new Error('只有已提交的修订可拒绝')
    this.db.prepare(`
      UPDATE novel_storyline_revisions SET status = 'rejected', decision_note = ?, reviewer = ?, updated_at = ?
      WHERE id = ?
    `).run(decision.note ?? '', decision.reviewer ?? 'user', Date.now(), revisionId)
    return this.getRevision(revisionId)!
  }

  /**
   * 版本回滚：以目标版本的可变事实为内容创建新 draft revision（supersedes 指向目标）。
   * 回滚不直接改当前态，仍需 submit → approve 走审核链路。
   */
  rollback(storylineId: string, projectId: string, targetRevisionId: string, note: string): StorylineRevision {
    const target = this.getRevision(targetRevisionId)
    if (!target || target.storylineId !== storylineId) throw new Error('目标修订不存在或不属于该故事线')
    const latest = this.currentRevisionNumber(storylineId)
    const now = Date.now()
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO novel_storyline_revisions
        (id, storyline_id, project_id, supersedes_id, revision, status, summary, goal, stakes, actor,
         note, decision_note, reviewer, expected_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, '', 'user', ?, ?, ?)
    `).run(id, storylineId, projectId, targetRevisionId, latest + 1, target.summary, target.goal, target.stakes, target.actor, note, latest + 1, now, now)
    return this.getRevision(id)!
  }

  /** 版本比较：返回前后 revision 的可变事实字段差异。 */
  compare(storylineId: string, fromRevision: number, toRevision: number): {
    from: StorylineRevision | null
    to: StorylineRevision | null
    fields: Array<{ field: string; before: string; after: string }>
  } {
    const from = this.getByNumber(storylineId, fromRevision) ?? null
    const to = this.getByNumber(storylineId, toRevision) ?? null
    const fields: Array<{ field: string; before: string; after: string }> = []
    if (from && to) {
      for (const field of ['summary', 'goal', 'stakes', 'actor'] as const) {
        if (from[field] !== to[field]) fields.push({ field, before: from[field], after: to[field] })
      }
    }
    return { from, to, fields }
  }

  private getByNumber(storylineId: string, revision: number): StorylineRevision | undefined {
    const row = this.db.prepare(`
      SELECT * FROM novel_storyline_revisions WHERE storyline_id = ? AND revision = ?
    `).get(storylineId, revision) as StorylineRevisionRow | undefined
    return row ? rowToRevision(row) : undefined
  }
}

function rowToRevision(row: StorylineRevisionRow): StorylineRevision {
  return {
    id: row.id,
    storylineId: row.storyline_id,
    projectId: row.project_id,
    supersedesId: row.supersedes_id,
    revision: row.revision,
    status: row.status as StorylineRevisionStatus,
    summary: row.summary,
    goal: row.goal,
    stakes: row.stakes,
    actor: row.actor,
    note: row.note,
    decisionNote: row.decision_note,
    reviewer: row.reviewer,
    expectedVersion: row.expected_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    supersededAt: row.superseeded_at,
  }
}