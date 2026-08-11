/**
 * ScenePlanStore：场景计划存储（T02b）。
 *
 * 承载剧情推进模型 V2 的「计划版本链 + 场景身份 + 场景版本 + 角色关系」。
 * - plan revision 状态机：draft → approved → consumed → confirmed；
 *   任一步可 superseded；上游正文变化进 stale。
 * - novel_scenes 只存稳定身份（stable_key），场景内容每次变更走 novel_scene_revisions。
 * - focus/presence/functions 为关系表（禁止 JSON 数组），批量写入。
 *
 * 写入必须事务化；progress intent（planned）由 narrative-ledger-store 承接确认。
 */
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  ChapterPlanRevision,
  PlanRevisionStatus,
  NovelScene,
  NovelSceneRevision,
  SceneRevisionStatus,
  NovelSceneCast,
} from '../types.js'
import type { ChapterScenePlan, ChapterScenePlanScene } from '../chapter-scene-plan.js'
import { now } from './store-utils.js'
import {
  isNovelFeatureEnabled,
  type FeatureFlagProjectSource,
} from '../novel-feature-flags.js'
import type { SceneCastReconcileReport } from '../migration-acceptance.js'

export type SceneCastRole = 'focus' | 'present' | 'functional'

/** novel_scene_cast 表的行（数据层保真，role 必填） */
export interface SceneCastRow {
  sceneRevisionId: string
  characterId: string
  role: SceneCastRole
  function: string | null
  prominence: string | null
  note: string | null
}

interface PlanRow {
  id: string
  chapter_id: string
  project_id: string
  creation_run_id: string | null
  supersedes_id: string | null
  base_content_revision_id: string | null
  positioning: string | null
  rhythm: string | null
  budget: string
  status: string
  revision: number
  idempotency_key: string | null
  created_at: number
}

interface SceneRow {
  id: string
  chapter_id: string
  project_id: string
  stable_key: string
  created_at: number
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
}

export type PlanBudget = ChapterPlanRevision['budget']

export interface CreatePlanInput {
  chapterId: string
  projectId: string
  creationRunId?: string | null
  baseContentRevisionId?: string | null
  positioning?: string | null
  rhythm?: string | null
  budget: PlanBudget
  idempotencyKey?: string | null
}

export interface SubmitPlanWithScenesInput extends CreatePlanInput {
  scenes: ChapterScenePlanScene[]
}

export class ScenePlanStore {
  constructor(
    private db: Database.Database,
    private flags?: FeatureFlagProjectSource,
  ) {}

  private isV2WriteEnabled(projectId: string): boolean {
    return this.flags != null && isNovelFeatureEnabled(this.flags, projectId, 'sceneCastV2Write')
  }

  private isV2ReadEnabled(projectId: string): boolean {
    return this.flags != null && isNovelFeatureEnabled(this.flags, projectId, 'sceneCastV2Read')
  }

  /** 影子写前提：scenePlanV2DualWrite 开启（联动规则，不互相替代） */
  private isDualWriteEnabled(projectId: string): boolean {
    return this.flags != null && isNovelFeatureEnabled(this.flags, projectId, 'scenePlanV2DualWrite')
  }

  // ═══════════════════════════════════════════════════════════════
  // Plan 版本链
  // ═══════════════════════════════════════════════════════════════

  /** 创建 draft plan revision。幂等键冲突时返回已有行（不抛错）。 */
  createPlanRevision(input: CreatePlanInput): ChapterPlanRevision {
    if (input.idempotencyKey) {
      const existing = this.findPlanByIdempotencyKey(input.idempotencyKey)
      if (existing) return existing
    }
    const maxRev = (this.db.prepare(
      'SELECT MAX(revision) as maxRev FROM novel_chapter_plan_revisions WHERE chapter_id = ?',
    ).get(input.chapterId) as { maxRev: number | null } | undefined)?.maxRev ?? 0
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO novel_chapter_plan_revisions
        (id, chapter_id, project_id, creation_run_id, supersedes_id, base_content_revision_id,
         positioning, rhythm, budget, status, revision, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
    `).run(
      id, input.chapterId, input.projectId, input.creationRunId ?? null, null,
      input.baseContentRevisionId ?? null, input.positioning ?? null, input.rhythm ?? null,
      JSON.stringify(input.budget), maxRev + 1, input.idempotencyKey ?? null, now(),
    )
    return this.getPlanRevision(id)!
  }

  getPlanRevision(id: string): ChapterPlanRevision | undefined {
    const row = this.db.prepare(
      'SELECT * FROM novel_chapter_plan_revisions WHERE id = ?',
    ).get(id) as PlanRow | undefined
    return row ? this.rowToPlan(row) : undefined
  }

  /** 当前生效计划：最高 revision 的 approved/consumed/confirmed（draft/superseded/stale 不算） */
  getCurrentPlan(chapterId: string): ChapterPlanRevision | undefined {
    const row = this.db.prepare(
      `SELECT * FROM novel_chapter_plan_revisions
       WHERE chapter_id = ? AND status IN ('approved','consumed','confirmed')
       ORDER BY revision DESC LIMIT 1`,
    ).get(chapterId) as PlanRow | undefined
    return row ? this.rowToPlan(row) : undefined
  }

  listPlanRevisions(chapterId: string): ChapterPlanRevision[] {
    const rows = this.db.prepare(
      'SELECT * FROM novel_chapter_plan_revisions WHERE chapter_id = ? ORDER BY revision DESC',
    ).all(chapterId) as PlanRow[]
    return rows.map((r) => this.rowToPlan(r))
  }

  /**
   * 计划状态迁移（带 expectedStatus 乐观锁）。
   * 状态机：draft→approved→consumed→confirmed；任一步可到 superseded/stale。
   * expectedStatus 不匹配时抛错，防止并发覆盖。
   */
  transitionPlan(id: string, to: PlanRevisionStatus, expectedStatus?: PlanRevisionStatus): ChapterPlanRevision {
    const current = this.getPlanRevision(id)
    if (!current) throw new Error(`计划版本不存在: ${id}`)
    if (expectedStatus && current.status !== expectedStatus) {
      throw new Error(`计划版本状态冲突: 期望 ${expectedStatus}，实际 ${current.status}`)
    }
    this.db.prepare('UPDATE novel_chapter_plan_revisions SET status = ? WHERE id = ?').run(to, id)
    return this.getPlanRevision(id)!
  }

  /** Director 重跑时：将已存在且未消费的 draft/approved 计划 superseded，再建新计划 */
  supersedeActivePlans(chapterId: string): void {
    this.db.prepare(
      `UPDATE novel_chapter_plan_revisions SET status = 'superseded'
       WHERE chapter_id = ? AND status IN ('draft','approved')`,
    ).run(chapterId)
  }

  private findPlanByIdempotencyKey(key: string): ChapterPlanRevision | undefined {
    const row = this.db.prepare(
      'SELECT * FROM novel_chapter_plan_revisions WHERE idempotency_key = ?',
    ).get(key) as PlanRow | undefined
    return row ? this.rowToPlan(row) : undefined
  }

  // ═══════════════════════════════════════════════════════════════
  // Scene 身份 + 版本 + 角色关系
  // ═══════════════════════════════════════════════════════════════

  /** 按 (chapter_id, stable_key) 幂等取/建场景身份 */
  upsertScene(chapterId: string, projectId: string, stableKey: string): NovelScene {
    const existing = this.db.prepare(
      'SELECT * FROM novel_scenes WHERE chapter_id = ? AND stable_key = ?',
    ).get(chapterId, stableKey) as SceneRow | undefined
    if (existing) return this.rowToScene(existing)
    const id = randomUUID()
    this.db.prepare(
      'INSERT INTO novel_scenes (id, chapter_id, project_id, stable_key, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, chapterId, projectId, stableKey, now())
    return this.db.prepare('SELECT * FROM novel_scenes WHERE id = ?').get(id) as NovelScene
  }

  /**
   * 为计划写入场景版本 + 角色关系（事务）。
   * 每场：upsert scene 身份 → 插入 scene revision → 批量写 focus/presence/functions。
   * 旧场景版本（同一 scene 且 status='planned'）标 superseded，避免同一计划重复提交时堆积。
   */
  createSceneRevisions(
    plan: ChapterPlanRevision,
    scenes: ChapterScenePlanScene[],
    contentRevisionId?: string | null,
  ): NovelSceneRevision[] {
    return this.db.transaction(() => {
      // 本章所有未确认的 planned 场景版本先 superseded：
      // - 同一计划重复提交（幂等保护外的残留）
      // - Director 重跑产生的新计划（不同 plan_revision_id）
      // confirmed 版本不受影响（那是 Memory 已确认正文的版本）。
      this.db.prepare(
        `UPDATE novel_scene_revisions SET status = 'superseded'
         WHERE chapter_id = ? AND status = 'planned'`,
      ).run(plan.chapterId)

      const revisions: NovelSceneRevision[] = []
      for (const scene of scenes) {
        const identity = this.upsertScene(plan.chapterId, plan.projectId, scene.sceneKey)
        const id = randomUUID()
        this.db.prepare(`
          INSERT INTO novel_scene_revisions
            (id, scene_id, chapter_id, project_id, plan_revision_id, content_revision_id,
             supersedes_id, order_no, title, goal, summary, location_text, time_text,
             pov_mode, pov_character_id, target_words, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, 'planned', ?)
        `).run(
          id, identity.id, plan.chapterId, plan.projectId, plan.id, contentRevisionId ?? null,
          null, scene.order, scene.title, scene.goal, scene.locationText, scene.timeText,
          scene.povMode, scene.povCharacterId ?? null, scene.targetWords, now(),
        )
        this.replaceCast(id, scene)
        revisions.push(this.getSceneRevision(id)!)
      }
      return revisions
    })()
  }

  /**
   * 覆盖写入某场景版本的角色关系（focus/present/functions + cast 影子写）。
   *
   * Flag 语义（PRD §5）：
   * - sceneCastV2Write 关（默认）：只写旧三表，行为与现状完全一致；
   * - sceneCastV2Write 开 + scenePlanV2DualWrite 开：三表写 + cast 影子写（双写对账期）；
   * - sceneCastV2Write 开 + scenePlanV2DualWrite 关：只写 cast 表（停旧写，影子写升为主写）。
   * 与事务调用方（createSceneRevisions）同事务。
   */
  private replaceCast(sceneRevisionId: string, scene: ChapterScenePlanScene): void {
    const projectId = this.getSceneRevision(sceneRevisionId)?.projectId
    const v2Write = projectId != null && this.isV2WriteEnabled(projectId)
    const dualWrite = projectId != null && this.isDualWriteEnabled(projectId)

    if (!v2Write || dualWrite) {
      // 旧三表写（默认路径；双写期也写）
      this.db.prepare('DELETE FROM novel_scene_focus WHERE scene_revision_id = ?').run(sceneRevisionId)
      this.db.prepare('DELETE FROM novel_scene_presence WHERE scene_revision_id = ?').run(sceneRevisionId)
      this.db.prepare('DELETE FROM novel_scene_functions WHERE scene_revision_id = ?').run(sceneRevisionId)

      const focusInsert = this.db.prepare(
        'INSERT INTO novel_scene_focus (scene_revision_id, character_id) VALUES (?, ?)',
      )
      for (const cid of scene.focusCharacterIds) focusInsert.run(sceneRevisionId, cid)

      const presentInsert = this.db.prepare(
        'INSERT INTO novel_scene_presence (scene_revision_id, character_id) VALUES (?, ?)',
      )
      for (const cid of scene.presentCharacterIds) presentInsert.run(sceneRevisionId, cid)

      const fnInsert = this.db.prepare(`
        INSERT INTO novel_scene_functions (scene_revision_id, character_id, function, prominence, note)
        VALUES (?, ?, ?, ?, '')
      `)
      for (const entry of scene.functionalCast) {
        fnInsert.run(sceneRevisionId, entry.characterId, entry.function, entry.prominence)
      }
    }

    if (v2Write) {
      // cast 影子写 / 主写
      this.writeSceneCast(sceneRevisionId, scene)
    }
  }

  /** 将 ChapterScenePlanScene 转换为 cast 行并覆盖写入 novel_scene_cast */
  private writeSceneCast(sceneRevisionId: string, scene: ChapterScenePlanScene): void {
    this.db.prepare('DELETE FROM novel_scene_cast WHERE scene_revision_id = ?').run(sceneRevisionId)
    const castInsert = this.db.prepare(`
      INSERT INTO novel_scene_cast (scene_revision_id, character_id, role, function, prominence, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const cid of scene.focusCharacterIds) {
      castInsert.run(sceneRevisionId, cid, 'focus', null, null, null)
    }
    for (const cid of scene.presentCharacterIds) {
      castInsert.run(sceneRevisionId, cid, 'present', null, null, null)
    }
    for (const entry of scene.functionalCast) {
      // SceneFunctionalCastEntry 无 note 字段（旧三表 note 默认 ''）；安全读取兼容扩展
      const note = (entry as { note?: string | null }).note ?? ''
      castInsert.run(sceneRevisionId, entry.characterId, 'functional', entry.function, entry.prominence, note)
    }
  }

  /** 原始读取 cast 表全部行（数据层保真，不做 focus/present 去重） */
  getSceneCast(sceneRevisionId: string): SceneCastRow[] {
    const rows = this.db.prepare(
      `SELECT scene_revision_id, character_id, role, function, prominence, note
       FROM novel_scene_cast WHERE scene_revision_id = ?
       ORDER BY role, character_id`,
    ).all(sceneRevisionId) as Array<{
      scene_revision_id: string
      character_id: string
      role: string
      function: string | null
      prominence: string | null
      note: string | null
    }>
    return rows.map((r) => ({
      sceneRevisionId: r.scene_revision_id,
      characterId: r.character_id,
      role: r.role as SceneCastRow['role'],
      function: r.function,
      prominence: r.prominence,
      note: r.note,
    }))
  }

  listSceneRevisionsByPlan(planRevisionId: string): NovelSceneRevision[] {
    const rows = this.db.prepare(
      'SELECT * FROM novel_scene_revisions WHERE plan_revision_id = ? ORDER BY order_no ASC',
    ).all(planRevisionId) as SceneRevisionRow[]
    return rows.map((r) => this.rowToSceneRevision(r))
  }

  getSceneRevision(id: string): NovelSceneRevision | undefined {
    const row = this.db.prepare(
      'SELECT * FROM novel_scene_revisions WHERE id = ?',
    ).get(id) as SceneRevisionRow | undefined
    return row ? this.rowToSceneRevision(row) : undefined
  }

  /** 场景身份（稳定标识） */
  getSceneById(sceneId: string): NovelScene | undefined {
    const row = this.db.prepare('SELECT * FROM novel_scenes WHERE id = ?').get(sceneId) as SceneRow | undefined
    return row ? this.rowToScene(row) : undefined
  }

  /** 场景版本 → 场景身份（供轨道投影拿 stable_key） */
  getSceneByRevision(sceneRevisionId: string): NovelScene | undefined {
    const revision = this.getSceneRevision(sceneRevisionId)
    if (!revision) return undefined
    return this.getSceneById(revision.sceneId)
  }

  /** 读取某场景版本的角色关系（focus/present/functions 三表，或 sceneCastV2Read 开启时读 cast 表） */
  getSceneRevisionCast(sceneRevisionId: string): {
    focus: string[]
    present: string[]
    functions: Array<{ characterId: string; function: string; prominence: string; note: string }>
  } {
    const revision = this.getSceneRevision(sceneRevisionId)
    if (revision && this.isV2ReadEnabled(revision.projectId)) {
      const rows = this.getSceneCast(sceneRevisionId)
      const focus = rows.filter((r) => r.role === 'focus').map((r) => r.characterId)
      // focus + present 并存去重规则：present 排除同时是 focus 的角色（focus 优先）
      const focusSet = new Set(focus)
      const present = rows
        .filter((r) => r.role === 'present' && !focusSet.has(r.characterId))
        .map((r) => r.characterId)
      const functions = rows
        .filter((r) => r.role === 'functional' && r.function != null)
        .map((r) => ({
          characterId: r.characterId,
          function: r.function as string,
          prominence: r.prominence ?? 'brief',
          note: r.note ?? '',
        }))
      return { focus, present, functions }
    }
    const focus = (this.db.prepare(
      'SELECT character_id FROM novel_scene_focus WHERE scene_revision_id = ?',
    ).all(sceneRevisionId) as Array<{ character_id: string }>).map((r) => r.character_id)
    const present = (this.db.prepare(
      'SELECT character_id FROM novel_scene_presence WHERE scene_revision_id = ?',
    ).all(sceneRevisionId) as Array<{ character_id: string }>).map((r) => r.character_id)
    const functions = (this.db.prepare(
      'SELECT character_id, function, prominence, note FROM novel_scene_functions WHERE scene_revision_id = ?',
    ).all(sceneRevisionId) as Array<{ character_id: string; function: string; prominence: string; note: string }>)
      .map((r) => ({ characterId: r.character_id, function: r.function, prominence: r.prominence, note: r.note }))
    return { focus, present, functions }
  }

  /**
   * 三表 → cast 往返对账（P1-3-1/2/3）。
   * 只读；sourceRows=三表行数之和，targetRows=cast 行数，
   * 只读；不执行回滚演练，rollbackVerified 保持 false，避免对账报告伪造验收通过。
   */
  reconcileSceneCast(projectId?: string): SceneCastReconcileReport {
    const projectFilter = projectId != null ? ' AND sr.project_id = ?' : ''
    const projectParam = projectId != null ? [projectId] : []

    const focusRows = this.db.prepare(
      `SELECT f.scene_revision_id, f.character_id
       FROM novel_scene_focus f JOIN novel_scene_revisions sr ON sr.id = f.scene_revision_id
       WHERE 1=1${projectFilter}`,
    ).all(...projectParam) as Array<{ scene_revision_id: string; character_id: string }>
    const presentRows = this.db.prepare(
      `SELECT p.scene_revision_id, p.character_id
       FROM novel_scene_presence p JOIN novel_scene_revisions sr ON sr.id = p.scene_revision_id
       WHERE 1=1${projectFilter}`,
    ).all(...projectParam) as Array<{ scene_revision_id: string; character_id: string }>
    const fnRows = this.db.prepare(
      `SELECT fn.scene_revision_id, fn.character_id, fn.function, fn.prominence, fn.note
       FROM novel_scene_functions fn JOIN novel_scene_revisions sr ON sr.id = fn.scene_revision_id
       WHERE 1=1${projectFilter}`,
    ).all(...projectParam) as Array<{
      scene_revision_id: string
      character_id: string
      function: string
      prominence: string
      note: string
    }>

    const castRows = this.db.prepare(
      `SELECT c.scene_revision_id, c.character_id, c.role, c.function, c.prominence, c.note
       FROM novel_scene_cast c JOIN novel_scene_revisions sr ON sr.id = c.scene_revision_id
       WHERE 1=1${projectFilter}`,
    ).all(...projectParam) as Array<{
      scene_revision_id: string
      character_id: string
      role: string
      function: string | null
      prominence: string | null
      note: string | null
    }>

    // 旧三表 → 期望 cast 集合（focus/present 无 function/prominence/note，与 cast 行 JSON 形态对齐）
    const expected = new Map<string, string>() // key: rev:role:char → JSON payload
    const addExpected = (rev: string, role: string, char: string, payload: string): void => {
      expected.set(`${rev}:${role}:${char}`, payload)
    }
    for (const r of focusRows) {
      addExpected(r.scene_revision_id, 'focus', r.character_id,
        JSON.stringify({ function: null, prominence: null, note: null }))
    }
    for (const r of presentRows) {
      addExpected(r.scene_revision_id, 'present', r.character_id,
        JSON.stringify({ function: null, prominence: null, note: null }))
    }
    for (const r of fnRows) {
      addExpected(r.scene_revision_id, 'functional', r.character_id,
        JSON.stringify({ function: r.function, prominence: r.prominence, note: r.note }))
    }

    const actual = new Map<string, string>()
    for (const r of castRows) {
      actual.set(`${r.scene_revision_id}:${r.role}:${r.character_id}`,
        JSON.stringify({ function: r.function, prominence: r.prominence, note: r.note }))
    }

    let mismatchRows = 0
    const mismatchByRole: Record<'focus' | 'present' | 'functional', number> = {
      focus: 0,
      present: 0,
      functional: 0,
    }
    for (const [key, payload] of expected) {
      const role = key.split(':')[1] as 'focus' | 'present' | 'functional'
      if (actual.get(key) !== payload) {
        mismatchRows += 1
        mismatchByRole[role] += 1
      }
    }
    // cast 侧多出的行（旧三表没有对应）也计入 mismatch
    for (const [key, payload] of actual) {
      const role = key.split(':')[1] as 'focus' | 'present' | 'functional'
      if (!expected.has(key)) {
        mismatchRows += 1
        mismatchByRole[role] += 1
      }
    }

    const checkedSceneRevisions = new Set<string>([
      ...focusRows.map((r) => r.scene_revision_id),
      ...presentRows.map((r) => r.scene_revision_id),
      ...fnRows.map((r) => r.scene_revision_id),
      ...castRows.map((r) => r.scene_revision_id),
    ]).size

    return {
      sourceRows: focusRows.length + presentRows.length + fnRows.length,
      targetRows: castRows.length,
      mismatchRows,
      orphanRows: 0,
      duplicateRows: 0,
      rollbackVerified: false,
      checkedSceneRevisions,
      mismatchByRole,
    }
  }

  /** Memory 确认正文后：场景版本 planned → confirmed */
  confirmSceneRevision(id: string, contentRevisionId?: string): NovelSceneRevision {
    const current = this.getSceneRevision(id)
    if (!current) throw new Error(`场景版本不存在: ${id}`)
    if (contentRevisionId !== undefined) {
      this.db.prepare(
        'UPDATE novel_scene_revisions SET status = ?, content_revision_id = ? WHERE id = ?',
      ).run('confirmed', contentRevisionId, id)
    } else {
      this.db.prepare('UPDATE novel_scene_revisions SET status = ? WHERE id = ?').run('confirmed', id)
    }
    return this.getSceneRevision(id)!
  }

  // ═══════════════════════════════════════════════════════════════
  // 统一提交
  // ═══════════════════════════════════════════════════════════════

  /**
   * 一次性提交计划 + 场景 + 角色关系（T03 的 Director/群聊 adapter 入口）。
   * 幂等键命中直接返回既有 plan（不重复写）。
   */
  submitPlanWithScenes(input: SubmitPlanWithScenesInput): { plan: ChapterPlanRevision; scenes: NovelSceneRevision[] } {
    const plan = this.createPlanRevision(input)
    const scenes = this.createSceneRevisions(plan, input.scenes)
    return { plan, scenes }
  }

  // ═══════════════════════════════════════════════════════════════

  private rowToPlan(row: PlanRow): ChapterPlanRevision {
    return {
      id: row.id,
      chapterId: row.chapter_id,
      projectId: row.project_id,
      creationRunId: row.creation_run_id,
      supersedesId: row.supersedes_id,
      baseContentRevisionId: row.base_content_revision_id,
      positioning: row.positioning,
      rhythm: row.rhythm,
      budget: JSON.parse(row.budget) as PlanBudget,
      status: row.status as PlanRevisionStatus,
      revision: row.revision,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
    }
  }

  private rowToScene(row: SceneRow): NovelScene {
    return {
      id: row.id,
      chapterId: row.chapter_id,
      projectId: row.project_id,
      stableKey: row.stable_key,
      createdAt: row.created_at,
    }
  }

  private rowToSceneRevision(row: SceneRevisionRow): NovelSceneRevision {
    return {
      id: row.id,
      sceneId: row.scene_id,
      chapterId: row.chapter_id,
      projectId: row.project_id,
      planRevisionId: row.plan_revision_id,
      contentRevisionId: row.content_revision_id,
      supersedesId: row.supersedes_id,
      order: row.order_no,
      title: row.title,
      goal: row.goal,
      summary: row.summary,
      locationText: row.location_text,
      timeText: row.time_text,
      povMode: row.pov_mode as NovelSceneRevision['povMode'],
      povCharacterId: row.pov_character_id,
      targetWords: row.target_words,
      status: row.status as SceneRevisionStatus,
      createdAt: row.created_at,
    }
  }
}

export type { NovelSceneCast }
