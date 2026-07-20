/**
 * ConflictStore：冲突 CRUD 子 Store
 *
 * 从原 novel-store.ts 抽取（PR-5b 重构），负责 novel_conflicts 表的增删改查，
 * 并维护 NovelCharacter.participatingConflicts 反向索引。
 *
 * 设计要点：
 * - 构造时预编译 stmtListConflicts
 * - create/update/delete 均通过 syncConflictParticipantsToCharacters 同步反向索引
 * - parseConflictParticipants 复用 store-utils.parseIdListSafe（行为一致）
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
    // 同步反向索引到角色（participating_conflicts）
    this.syncConflictParticipantsToCharacters(full.id, parseIdListSafe(full.participants), [])
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
    // 同步反向索引：旧参与者中不在新列表的移除，新参与者中不在旧列表的追加
    if (patch.participants !== undefined) {
      const oldIds = parseIdListSafe(current.participants)
      const newIds = parseIdListSafe(updated.participants)
      this.syncConflictParticipantsToCharacters(id, newIds, oldIds)
    }
    return updated
  }

  deleteConflict(id: string): boolean {
    // 先取出旧参与者，删除后从他们的反向索引里移除该冲突 ID
    const existing = this.db.prepare('SELECT * FROM novel_conflicts WHERE id = ?').get(id) as
      | ConflictRow
      | undefined
    const oldParticipantIds = existing ? parseIdListSafe(existing.participants) : []
    this.deleteEdgesByEntity(id)
    const result = this.db.prepare('DELETE FROM novel_conflicts WHERE id = ?').run(id)
    if (result.changes > 0) {
      this.syncConflictParticipantsToCharacters(id, [], oldParticipantIds)
    }
    return result.changes > 0
  }

  /**
   * 同步冲突反向索引到角色的 participating_conflicts 字段。
   *
   * - 对新增的 participantIds（newIds 中有，oldIds 中无）：把 conflictId 追加到他们的 participating_conflicts
   * - 对移除的 participantIds（oldIds 中有，newIds 中无）：把 conflictId 从他们的 participating_conflicts 移除
   * - 对不变的 participantIds：不动
   *
   * 该方法被 createConflict / updateConflict / deleteConflict 调用，
   * 让 NovelCharacter.participatingConflicts 始终是 conflict.participants 的反向镜像，
   * 回答四层逻辑第四句"删掉这个角色哪段冲突线会断"。
   */
  private syncConflictParticipantsToCharacters(
    conflictId: string,
    newParticipantIds: string[],
    oldParticipantIds: string[],
  ): void {
    const added = newParticipantIds.filter((id) => !oldParticipantIds.includes(id))
    const removed = oldParticipantIds.filter((id) => !newParticipantIds.includes(id))
    if (added.length === 0 && removed.length === 0) return

    const updateOne = (characterId: string, mode: 'add' | 'remove') => {
      const row = this.db
        .prepare('SELECT participating_conflicts FROM novel_characters WHERE id = ?')
        .get(characterId) as { participating_conflicts?: string } | undefined
      if (!row) return
      const current = parseIdListSafe(row.participating_conflicts)
      let next: string[]
      if (mode === 'add') {
        if (current.includes(conflictId)) return
        next = [...current, conflictId]
      } else {
        next = current.filter((id) => id !== conflictId)
      }
      this.db
        .prepare('UPDATE novel_characters SET participating_conflicts = ? WHERE id = ?')
        .run(JSON.stringify(next), characterId)
    }

    for (const id of added) updateOne(id, 'add')
    for (const id of removed) updateOne(id, 'remove')
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
