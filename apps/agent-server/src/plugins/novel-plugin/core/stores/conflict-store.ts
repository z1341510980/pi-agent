/**
 * ConflictStore：冲突 CRUD 子 Store
 *
 * 从原 novel-store.ts 抽取（PR-5b 重构），负责 novel_conflicts 表的增删改查。
 * 关联关系（character↔conflict）已统一走 novel_edges 表，删除时通过 deleteEdgesByEntity 级联清理。
 *
 * 设计要点：
 * - 构造时预编译 stmtListConflicts
 * - delete 通过上层注入的 deleteEdgesByEntity 级联清理 edges
 */

import type Database from 'better-sqlite3'
import type { NovelConflict, ConflictTier } from '../types.js'
import type { ConflictRow } from './row-types.js'
import {
  now,
  parseIdListSafe,
  parseChapterSpans,
  normalizeConflictPlotFunction,
  normalizeConflictProgressionMode,
} from './store-utils.js'

export class ConflictStore {
  private readonly stmtListConflicts: Database.Statement

  constructor(
    private db: Database.Database,
    private deleteEdgesByEntity: (entityId: string) => number,
  ) {
    this.stmtListConflicts = db.prepare(
      'SELECT * FROM novel_conflicts WHERE project_id = ? ORDER BY created_at ASC',
    )
  }

  listConflicts(projectId: string): NovelConflict[] {
    return (this.stmtListConflicts.all(projectId) as ConflictRow[]).map((r) => this.rowToConflict(r))
  }

  getConflict(conflictId: string): NovelConflict | undefined {
    const row = this.db.prepare('SELECT * FROM novel_conflicts WHERE id = ?').get(conflictId) as
      | ConflictRow
      | undefined
    return row ? this.rowToConflict(row) : undefined
  }

  createConflict(conflict: Omit<NovelConflict, 'createdAt' | 'updatedAt'>): NovelConflict {
    const ts = now()
    const full: NovelConflict = { ...conflict, createdAt: ts, updatedAt: ts }
    this.db
      .prepare(
        `
      INSERT INTO novel_conflicts (id, project_id, description, type, intensity, stage, participants,
      first_chapter, last_chapter, chapter_spans, tier, plot_function, progression_mode,
      current_step, next_step, created_at, updated_at)
      VALUES (@id, @project_id, @description, @type, @intensity, @stage, @participants,
      @first_chapter, @last_chapter, @chapter_spans, @tier, @plot_function, @progression_mode,
      @current_step, @next_step, @created_at, @updated_at)
    `,
      )
      .run({
        id: full.id,
        project_id: full.projectId,
        description: full.description,
        type: full.type,
        intensity: full.intensity,
        stage: full.stage,
        participants: full.participants,
        first_chapter: full.chapterSpans[0]?.[0] ?? null,
        last_chapter: full.chapterSpans[0]?.[1] ?? null,
        chapter_spans: JSON.stringify(full.chapterSpans),
        tier: full.tier,
        // plot_function 可选（旧数据 NULL）；progression_mode 默认 'linear'（向后兼容）
        plot_function: full.plotFunction ?? null,
        progression_mode: full.progressionMode ?? 'linear',
        // 071: 推进粒度字段，未指定时为空串（NOT NULL DEFAULT ''）
        current_step: full.currentStep ?? '',
        next_step: full.nextStep ?? '',
        created_at: full.createdAt,
        updated_at: full.updatedAt,
      })
    return full
  }

  updateConflict(id: string, patch: Partial<NovelConflict>): NovelConflict | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_conflicts WHERE id = ?').get(id) as
      | ConflictRow
      | undefined
    if (!existing) return undefined
    const current = this.rowToConflict(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db
      .prepare(
        `
      UPDATE novel_conflicts SET description=@description, type=@type, intensity=@intensity,
      stage=@stage, participants=@participants, first_chapter=@first_chapter, last_chapter=@last_chapter,
      chapter_spans=@chapter_spans, tier=@tier, plot_function=@plot_function, progression_mode=@progression_mode,
      current_step=@current_step, next_step=@next_step,
      updated_at=@updated_at WHERE id=@id
    `,
      )
      .run({
        id,
        description: updated.description,
        type: updated.type,
        intensity: updated.intensity,
        stage: updated.stage,
        participants: updated.participants,
        first_chapter: updated.chapterSpans[0]?.[0] ?? null,
        last_chapter: updated.chapterSpans[0]?.[1] ?? null,
        chapter_spans: JSON.stringify(updated.chapterSpans),
        tier: updated.tier,
        plot_function: updated.plotFunction ?? null,
        progression_mode: updated.progressionMode ?? 'linear',
        current_step: updated.currentStep ?? '',
        next_step: updated.nextStep ?? '',
        updated_at: updated.updatedAt,
      })
    return updated
  }

  deleteConflict(id: string): boolean {
    this.deleteEdgesByEntity(id)
    const result = this.db.prepare('DELETE FROM novel_conflicts WHERE id = ?').run(id)
    return result.changes > 0
  }

  private rowToConflict(row: ConflictRow): NovelConflict {
    return {
      id: row.id,
      projectId: row.project_id,
      description: row.description,
      type: row.type as NovelConflict['type'],
      intensity: row.intensity,
      stage: row.stage as NovelConflict['stage'],
      participants: row.participants,
      chapterSpans: parseChapterSpans(row.chapter_spans),
      tier: (row.tier as ConflictTier) ?? 'secondary',
      // 四层逻辑③：功能层 + 推进模式（NULL/无效值回退到默认）
      plotFunction: normalizeConflictPlotFunction(row.plot_function),
      progressionMode: normalizeConflictProgressionMode(row.progression_mode),
      // 071: 推进粒度字段（旧数据 / 旧迁移 DB 可能没这两列，catch 后降级为空串）
      currentStep: row.current_step ?? '',
      nextStep: row.next_step ?? '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
