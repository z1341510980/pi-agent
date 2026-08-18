/**
 * SceneRevisionReviewStore：场景人工 revision 审核（M2，方案 §7）。
 *
 * 复用 novel_scene_revisions 承载场景内容版本；迁移 114 新增的
 * review_status/review_note/reviewed_at/reviewer/positioning/rhythm/narrative_task_types
 * 列承载人工审核与补充叙事语义，不干扰既有自动状态机（planned→confirmed）。
 *
 * 人工编辑通过 POST /scenes/:sceneId/revisions 以「最新场景版本」为基线创建 draft；
 * expectedRevision 乐观锁用最新 scene_revision.id 作为版本指纹。
 */
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export type SceneReviewStatus = 'draft' | 'submitted' | 'approved' | 'rejected'

export interface SceneRevisionReviewView {
  id: string
  sceneId: string
  chapterId: string
  projectId: string
  planRevisionId: string
  order: number
  title: string
  summary: string
  pov: string
  positioning: string | null
  rhythm: string | null
  narrativeTaskTypes: string[]
  status: string
  reviewStatus: SceneReviewStatus | null
  reviewNote: string
  reviewer: string
  createdAt: number
  focus: string[]
  present: string[]
  cast: Array<{ characterId: string; function: string; prominence: string }>
}

export interface SceneRevisionDraftInput {
  expectedRevision: string
  summary: string
  pov: string
  positioning?: string
  rhythm?: string
  narrativeTaskTypes?: string[]
  focus?: string[]
  present?: string[]
  cast?: Array<{ characterId: string; function: string; prominence: string }>
}

interface SceneRevisionRow {
  id: string
  scene_id: string
  chapter_id: string
  project_id: string
  plan_revision_id: string
  content_revision_id: string | null
  supersedes_id: string | null
  order_no: number
  title: string
  goal: string
  summary: string
  location_text: string
  time_text: string
  pov_mode: string
  pov_character_id: string | null
  target_words: number
  status: string
  created_at: number
  positioning: string | null
  rhythm: string | null
  narrative_task_types: string
  review_status: string | null
  review_note: string
  reviewed_at: number | null
  reviewer: string
}

export class SceneRevisionReviewStore {
  constructor(private readonly db: Database.Database) {}

  private latestRevision(sceneId: string): SceneRevisionRow | undefined {
    return this.db.prepare(`
      SELECT * FROM novel_scene_revisions WHERE scene_id = ? ORDER BY created_at DESC, order_no DESC LIMIT 1
    `).get(sceneId) as SceneRevisionRow | undefined
  }

  listScenes(projectId: string): SceneRevisionReviewView[] {
    const scenes = this.db.prepare(`
      SELECT id FROM novel_scenes WHERE project_id = ? ORDER BY created_at
    `).all(projectId) as Array<{ id: string }>
    const views: SceneRevisionReviewView[] = []
    for (const scene of scenes) {
      const revision = this.latestRevision(scene.id)
      if (revision) views.push(this.rowToView(revision))
    }
    return views
  }

  getSceneDetail(sceneId: string): { sceneId: string; revision: SceneRevisionReviewView | null; revisions: SceneRevisionReviewView[] } | undefined {
    const scene = this.db.prepare('SELECT id FROM novel_scenes WHERE id = ?').get(sceneId) as { id: string } | undefined
    if (!scene) return undefined
    const revisions = this.db.prepare(`
      SELECT * FROM novel_scene_revisions WHERE scene_id = ? ORDER BY created_at ASC, order_no ASC
    `).all(sceneId) as SceneRevisionRow[]
    return {
      sceneId,
      revision: this.latestRevision(sceneId) ? this.rowToView(this.latestRevision(sceneId)!) : null,
      revisions: revisions.map((row) => this.rowToView(row)),
    }
  }

  getSceneRevision(id: string): SceneRevisionReviewView | undefined {
    const row = this.db.prepare('SELECT * FROM novel_scene_revisions WHERE id = ?').get(id) as SceneRevisionRow | undefined
    return row ? this.rowToView(row) : undefined
  }

  /**
   * 释放唯一索引 (plan_revision_id, order_no) 的槽位：把旧版本标 superseded，
   * 并将其 order_no 取负作为历史保留序号（不同场景的负序互不冲突）。
   */
  private supersedeLatest(sceneId: string): SceneRevisionRow {
    const base = this.latestRevision(sceneId)!
    // 分配一个比现有历史负序更小的唯一负值，释放 (plan_revision_id, order_no) 唯一槽位。
    // 不用 -created_at：毫秒内连续两次编辑会产生相同负值，撞唯一约束。
    this.db.prepare(`
      UPDATE novel_scene_revisions
      SET status = 'superseded',
          order_no = (SELECT COALESCE(MIN(order_no), 0) - 1
                      FROM novel_scene_revisions WHERE scene_id = ? AND order_no < 0)
      WHERE id = ? AND order_no > 0
    `).run(base.scene_id, base.id)
    return base
  }

  /** 创建人工草稿：以最新场景版本为基线，覆盖输入的叙事语义字段。 */
  createRevisionDraft(sceneId: string, input: SceneRevisionDraftInput): SceneRevisionReviewView {
    const base = this.latestRevision(sceneId)
    if (!base) throw new Error('场景不存在或没有可用版本')
    if (input.expectedRevision !== base.id) throw new Error('场景版本已变化，请刷新后重试')
    const now = Date.now()
    const id = randomUUID()
    this.db.transaction(() => {
      this.supersedeLatest(sceneId)
      this.db.prepare(`
        INSERT INTO novel_scene_revisions
          (id, scene_id, chapter_id, project_id, plan_revision_id, content_revision_id, supersedes_id,
           order_no, title, goal, summary, location_text, time_text, pov_mode, pov_character_id,
           target_words, status, created_at, positioning, rhythm, narrative_task_types, review_status, reviewer)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, 'draft', 'user')
      `).run(
        id, base.scene_id, base.chapter_id, base.project_id, base.plan_revision_id, base.content_revision_id,
        base.id, base.order_no, base.title, base.goal, input.summary, base.location_text, base.time_text,
        input.pov, base.pov_character_id, base.target_words, now,
        input.positioning ?? null, input.rhythm ?? null, JSON.stringify(input.narrativeTaskTypes ?? []),
      )
      this.replaceCast(id, input.focus ?? [], input.present ?? [], input.cast ?? [])
    })()
    return this.getSceneRevision(id)!
  }

  private replaceCast(
    sceneRevisionId: string,
    focus: string[],
    present: string[],
    cast: Array<{ characterId: string; function: string; prominence: string }>,
  ): void {
    const insert = this.db.prepare(`
      INSERT INTO novel_scene_cast (scene_revision_id, character_id, role, function, prominence, note)
      VALUES (?, ?, ?, ?, ?, '')
    `)
    for (const characterId of focus) insert.run(sceneRevisionId, characterId, 'focus', null, null)
    for (const characterId of present) insert.run(sceneRevisionId, characterId, 'present', null, null)
    for (const entry of cast) insert.run(sceneRevisionId, entry.characterId, 'functional', entry.function, entry.prominence)
  }

  submit(revisionId: string): SceneRevisionReviewView {
    const current = this.db.prepare('SELECT review_status FROM novel_scene_revisions WHERE id = ?').get(revisionId) as { review_status: string | null } | undefined
    if (!current) throw new Error('场景修订不存在')
    if (current.review_status !== 'draft') throw new Error('只有草稿可提交审核')
    this.db.prepare(`UPDATE novel_scene_revisions SET review_status = 'submitted' WHERE id = ?`).run(revisionId)
    return this.getSceneRevision(revisionId)!
  }

  decide(revisionId: string, decision: 'approve' | 'reject', note: string, reviewer = 'user'): SceneRevisionReviewView {
    const current = this.db.prepare('SELECT review_status FROM novel_scene_revisions WHERE id = ?').get(revisionId) as { review_status: string | null } | undefined
    if (!current) throw new Error('场景修订不存在')
    if (current.review_status !== 'submitted') throw new Error('只有已提交的修订可审核')
    const status: SceneReviewStatus = decision === 'approve' ? 'approved' : 'rejected'
    this.db.prepare(`
      UPDATE novel_scene_revisions SET review_status = ?, review_note = ?, reviewer = ?, reviewed_at = ? WHERE id = ?
    `).run(status, note, reviewer, Date.now(), revisionId)
    return this.getSceneRevision(revisionId)!
  }

  /** 版本比较：同一场景的两个 revision 的内容差异。 */
  compare(sceneId: string, fromRevisionId: string, toRevisionId: string): {
    from: SceneRevisionReviewView | null
    to: SceneRevisionReviewView | null
    fields: Array<{ field: string; before: string; after: string }>
  } {
    const from = this.getSceneRevision(fromRevisionId) ?? null
    const to = this.getSceneRevision(toRevisionId) ?? null
    const fields: Array<{ field: string; before: string; after: string }> = []
    if (from && to && from.sceneId === sceneId && to.sceneId === sceneId) {
      for (const field of ['summary', 'pov', 'positioning', 'rhythm'] as const) {
        const before = String(from[field] ?? '')
        const after = String(to[field] ?? '')
        if (before !== after) fields.push({ field, before, after })
      }
      const beforeTasks = JSON.stringify(from.narrativeTaskTypes)
      const afterTasks = JSON.stringify(to.narrativeTaskTypes)
      if (beforeTasks !== afterTasks) fields.push({ field: 'narrativeTaskTypes', before: beforeTasks, after: afterTasks })
    }
    return { from, to, fields }
  }

  /** 版本回滚：以目标场景版本内容为基线创建新 draft（supersedes 指向目标）。 */
  rollback(sceneId: string, targetRevisionId: string, note: string): SceneRevisionReviewView {
    const target = this.db.prepare('SELECT * FROM novel_scene_revisions WHERE id = ? AND scene_id = ?').get(targetRevisionId, sceneId) as SceneRevisionRow | undefined
    if (!target) throw new Error('目标修订不存在或不属于该场景')
    const base = this.latestRevision(sceneId)
    if (!base) throw new Error('场景不存在或没有可用版本')
    const now = Date.now()
    const id = randomUUID()
    this.db.transaction(() => {
      this.supersedeLatest(sceneId)
      this.db.prepare(`
        INSERT INTO novel_scene_revisions
          (id, scene_id, chapter_id, project_id, plan_revision_id, content_revision_id, supersedes_id,
           order_no, title, goal, summary, location_text, time_text, pov_mode, pov_character_id,
           target_words, status, created_at, positioning, rhythm, narrative_task_types, review_status, review_note, reviewer)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, 'draft', ?, 'user')
      `).run(
        id, base.scene_id, base.chapter_id, base.project_id, base.plan_revision_id, base.content_revision_id,
        target.id, base.order_no, target.title, target.goal, target.summary, target.location_text, target.time_text,
        target.pov_mode, target.pov_character_id, target.target_words, now,
        target.positioning, target.rhythm, target.narrative_task_types, note,
      )
      this.copyCast(target.id, id)
    })()
    return this.getSceneRevision(id)!
  }

  private copyCast(fromRevisionId: string, toRevisionId: string): void {
    const rows = this.db.prepare(`
      SELECT character_id, role, function, prominence, note FROM novel_scene_cast WHERE scene_revision_id = ?
    `).all(fromRevisionId) as Array<{ character_id: string; role: string; function: string | null; prominence: string | null; note: string | null }>
    const insert = this.db.prepare(`
      INSERT INTO novel_scene_cast (scene_revision_id, character_id, role, function, prominence, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const row of rows) insert.run(toRevisionId, row.character_id, row.role, row.function, row.prominence, row.note ?? '')
  }

  private rowToView(row: SceneRevisionRow): SceneRevisionReviewView {
    let narrativeTaskTypes: string[] = []
    try {
      const parsed = JSON.parse(row.narrative_task_types)
      if (Array.isArray(parsed)) narrativeTaskTypes = parsed.filter((item): item is string => typeof item === 'string')
    } catch {
      narrativeTaskTypes = []
    }
    const castRows = this.db.prepare(
      'SELECT character_id, role, function, prominence FROM novel_scene_cast WHERE scene_revision_id = ?',
    ).all(row.id) as Array<{ character_id: string; role: string; function: string | null; prominence: string | null }>
    const focus = castRows.filter((c) => c.role === 'focus').map((c) => c.character_id)
    const focusSet = new Set(focus)
    const present = castRows.filter((c) => c.role === 'present' && !focusSet.has(c.character_id)).map((c) => c.character_id)
    const cast = castRows
      .filter((c) => c.role === 'functional' && c.function != null)
      .map((c) => ({ characterId: c.character_id, function: c.function as string, prominence: c.prominence ?? 'brief' }))
    return {
      id: row.id,
      sceneId: row.scene_id,
      chapterId: row.chapter_id,
      projectId: row.project_id,
      planRevisionId: row.plan_revision_id,
      order: row.order_no,
      title: row.title,
      summary: row.summary,
      pov: row.pov_mode,
      positioning: row.positioning,
      rhythm: row.rhythm,
      narrativeTaskTypes,
      status: row.status,
      reviewStatus: row.review_status as SceneReviewStatus | null,
      reviewNote: row.review_note,
      reviewer: row.reviewer,
      createdAt: row.created_at,
      focus,
      present,
      cast,
    }
  }
}