/**
 * ScenePlanStore：场景计划存储（T02b）。
 *
 * 承载剧情推进模型 V2 的「计划版本链 + 场景身份 + 场景版本 + 角色关系」。
 * - plan revision 状态机：draft → approved → consumed → confirmed；
 *   任一步可 superseded；上游正文变化进 stale。
 * - novel_scenes 只存稳定身份（stable_key），场景内容每次变更走 novel_scene_revisions。
 * - 角色关系（focus/presence/functional）落 novel_scene_cast 单表（2026-08-12 逻辑统一，
 *   旧三表 novel_scene_focus/presence/functions 已停写，仅 reconcileSceneCast 只读对账保留）。
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
import type { ChapterScenePlan, ChapterScenePlanScene } from '../chapters/chapter-scene-plan.js'
import { now } from './store-utils.js'
import type { SceneCastReconcileReport } from '../analysis/migration-acceptance.js'
import { createNovelDrizzleDb, ScenePlanRepository } from '../../infrastructure/sqlite/index.js'
import type { PlanRow, SceneCastRow as RepositorySceneCastRow, SceneRevisionRow, SceneRow } from '../../infrastructure/sqlite/repositories/scene-plan-repository.js'

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
  private readonly repository: ScenePlanRepository

  constructor(
    private db: Database.Database,
  ) {
    this.repository = new ScenePlanRepository(createNovelDrizzleDb(db))
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
    const maxRev = this.repository.maxRevision(input.chapterId)
    const id = randomUUID()
    this.repository.insertPlan({ id, chapter_id: input.chapterId, project_id: input.projectId, creation_run_id: input.creationRunId ?? null, supersedes_id: null, base_content_revision_id: input.baseContentRevisionId ?? null, positioning: input.positioning ?? null, rhythm: input.rhythm ?? null, budget: JSON.stringify(input.budget), status: 'draft', revision: maxRev + 1, idempotency_key: input.idempotencyKey ?? null, created_at: now() })
    return this.getPlanRevision(id)!
  }

  getPlanRevision(id: string): ChapterPlanRevision | undefined {
    const row = this.repository.getPlan(id)
    return row ? this.rowToPlan(row) : undefined
  }

  /** 当前生效计划：最高 revision 的 approved/consumed/confirmed（draft/superseded/stale 不算） */
  getCurrentPlan(chapterId: string): ChapterPlanRevision | undefined {
    const row = this.repository.getCurrentPlan(chapterId)
    return row ? this.rowToPlan(row) : undefined
  }

  listPlanRevisions(chapterId: string): ChapterPlanRevision[] {
    const rows = this.repository.listPlans(chapterId)
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
    this.repository.updatePlanStatus(id, to)
    return this.getPlanRevision(id)!
  }

  /** Director 重跑时：将已存在且未消费的 draft/approved 计划 superseded，再建新计划 */
  supersedeActivePlans(chapterId: string): void {
    this.repository.supersedeActivePlans(chapterId)
  }

  private findPlanByIdempotencyKey(key: string): ChapterPlanRevision | undefined {
    const row = this.repository.findPlanByIdempotencyKey(key)
    return row ? this.rowToPlan(row) : undefined
  }

  // ═══════════════════════════════════════════════════════════════
  // Scene 身份 + 版本 + 角色关系
  // ═══════════════════════════════════════════════════════════════

  /** 按 (chapter_id, stable_key) 幂等取/建场景身份 */
  upsertScene(chapterId: string, projectId: string, stableKey: string): NovelScene {
    const existing = this.repository.getSceneByKey(chapterId, stableKey)
    if (existing) return this.rowToScene(existing)
    const id = randomUUID()
    this.repository.insertScene({ id, chapter_id: chapterId, project_id: projectId, stable_key: stableKey, created_at: now() })
    return this.rowToScene(this.repository.getScene(id)!)
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
      this.repository.supersedePlannedScenes(plan.chapterId)

      const revisions: NovelSceneRevision[] = []
      for (const scene of scenes) {
        const identity = this.upsertScene(plan.chapterId, plan.projectId, scene.sceneKey)
        const id = randomUUID()
        this.repository.insertSceneRevision({
          id, scene_id: identity.id, chapter_id: plan.chapterId, project_id: plan.projectId,
          plan_revision_id: plan.id, content_revision_id: contentRevisionId ?? null, supersedes_id: null,
          order_no: scene.order, title: scene.title, goal: scene.goal, summary: '',
          location_text: scene.locationText, time_text: scene.timeText, pov_mode: scene.povMode,
          pov_character_id: scene.povCharacterId ?? null, target_words: scene.targetWords,
          status: 'planned', created_at: now(),
        })
        this.replaceCast(id, scene)
        revisions.push(this.getSceneRevision(id)!)
      }
      return revisions
    })()
  }

  /**
   * 覆盖写入某场景版本的角色关系（focus/present/functions → novel_scene_cast 单表）。
   * 2026-08-12 逻辑统一：旧三表（focus/presence/functions）已停写，cast 表为唯一写面。
   * 与事务调用方（createSceneRevisions）同事务。
   */
  private replaceCast(sceneRevisionId: string, scene: ChapterScenePlanScene): void {
    this.writeSceneCast(sceneRevisionId, scene)
  }

  /** 将 ChapterScenePlanScene 转换为 cast 行并覆盖写入 novel_scene_cast */
  private writeSceneCast(sceneRevisionId: string, scene: ChapterScenePlanScene): void {
    const rows: RepositorySceneCastRow[] = []
    for (const cid of scene.focusCharacterIds) {
      rows.push({ scene_revision_id: sceneRevisionId, character_id: cid, role: 'focus', function: null, prominence: null, note: null })
    }
    for (const cid of scene.presentCharacterIds) {
      rows.push({ scene_revision_id: sceneRevisionId, character_id: cid, role: 'present', function: null, prominence: null, note: null })
    }
    for (const entry of scene.functionalCast) {
      // SceneFunctionalCastEntry 无 note 字段（旧三表 note 默认 ''）；安全读取兼容扩展
      const note = (entry as { note?: string | null }).note ?? ''
      rows.push({ scene_revision_id: sceneRevisionId, character_id: entry.characterId, role: 'functional', function: entry.function, prominence: entry.prominence, note })
    }
    this.repository.replaceSceneCast(sceneRevisionId, rows)
  }

  /** 原始读取 cast 表全部行（数据层保真，不做 focus/present 去重） */
  getSceneCast(sceneRevisionId: string): SceneCastRow[] {
    const rows = this.repository.listSceneCast(sceneRevisionId)
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
    const rows = this.repository.listSceneRevisionsByPlan(planRevisionId)
    return rows.map((r) => this.rowToSceneRevision(r))
  }

  getSceneRevision(id: string): NovelSceneRevision | undefined {
    const row = this.repository.getSceneRevision(id)
    return row ? this.rowToSceneRevision(row) : undefined
  }

  /** 场景身份（稳定标识） */
  getSceneById(sceneId: string): NovelScene | undefined {
    const row = this.repository.getScene(sceneId)
    return row ? this.rowToScene(row) : undefined
  }

  /** 场景版本 → 场景身份（供轨道投影拿 stable_key） */
  getSceneByRevision(sceneRevisionId: string): NovelScene | undefined {
    const revision = this.getSceneRevision(sceneRevisionId)
    if (!revision) return undefined
    return this.getSceneById(revision.sceneId)
  }

  /** 读取某场景版本的角色关系（novel_scene_cast 单表，focus 优先去重） */
  getSceneRevisionCast(sceneRevisionId: string): {
    focus: string[]
    present: string[]
    functions: Array<{ characterId: string; function: string; prominence: string; note: string }>
  } {
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
      this.repository.confirmSceneRevision(id, contentRevisionId)
    } else {
      this.repository.confirmSceneRevision(id)
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
