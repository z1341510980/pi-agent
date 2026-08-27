/**
 * BeatPlanStore：卷级节拍规划（Beat Planner）。
 *
 * 承载「单章节拍」：每行回答"这一章在卷弧光里负责什么"。
 * - dramaticFunction 是本章的戏剧功能，Director 的任务类型必须由此推导
 * - emotionalDebt 是进入本章时前文欠读者的东西；payoff 是本章给读者的回报
 * - 重新规划按卷替换：published 章的 confirmed 节拍保留，其余行删除重建
 *
 * 与 RhythmController 分工：节奏模型输出"位置→标签"的建议；
 * 本表是消费卷纲与事件账本后的规划层事实，存在时以本表为准。
 */
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { BeatDramaticFunction, BeatPlanStatus, NovelBeatPlan } from '../types.js'

/** 新建/替换节拍时的输入（不含系统字段） */
export interface BeatPlanInput {
  chapterNumber: number
  dramaticFunction: BeatDramaticFunction
  emotionalDebt?: string
  payoff?: string
  arcPosition?: string
  summary?: string
}

export class BeatPlanStore {
  constructor(private db: Database.Database) {}

  /**
   * 按卷替换节拍表（事务）。
   * published 章不受影响：其旧节拍保留并保持 confirmed；新计划里落在
   * published 章上的行会被丢弃，避免用未经验证的新规划覆盖既成事实。
   */
  replaceVolumePlan(
    projectId: string,
    volumeNumber: number,
    beats: BeatPlanInput[]
  ): NovelBeatPlan[] {
    return this.db.transaction(() => {
      const published = new Set(
        (
          this.db
            .prepare(
              `SELECT chapter_number FROM novel_chapters
               WHERE project_id = ? AND status = 'published'`
            )
            .all(projectId) as Array<{ chapter_number: number }>
        ).map((row) => row.chapter_number)
      )

      const existing = this.listBeatsByVolume(projectId, volumeNumber, true)
      const keepIds = new Set(
        existing.filter((beat) => published.has(beat.chapterNumber)).map((beat) => beat.id)
      )

      const deleteStmt = this.db.prepare(
        `DELETE FROM novel_beat_plans
         WHERE project_id = ? AND volume_number = ? AND id NOT IN (${
           keepIds.size
             ? Array.from(keepIds)
                 .map(() => '?')
                 .join(',')
             : "''"
         })`
      )
      deleteStmt.run(...[projectId, volumeNumber, ...keepIds])

      const insertStmt = this.db.prepare(
        `INSERT INTO novel_beat_plans
           (id, project_id, volume_number, chapter_number, dramatic_function,
            emotional_debt, payoff, arc_position, summary, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', unixepoch(), unixepoch())`
      )
      const results: NovelBeatPlan[] = []
      for (const beat of beats) {
        if (published.has(beat.chapterNumber)) continue
        const id = randomUUID()
        insertStmt.run(
          id,
          projectId,
          volumeNumber,
          beat.chapterNumber,
          beat.dramaticFunction,
          beat.emotionalDebt ?? '',
          beat.payoff ?? '',
          beat.arcPosition ?? '',
          beat.summary ?? ''
        )
        const created = this.getBeat(id)
        if (created) results.push(created)
      }
      // 已保留的 published 节拍排在结果最前面，保持章号有序
      const kept = existing.filter((beat) => keepIds.has(beat.id))
      return [...kept, ...results].sort((a, b) => a.chapterNumber - b.chapterNumber)
    })()
  }

  getBeat(id: string): NovelBeatPlan | undefined {
    const row = this.db.prepare('SELECT * FROM novel_beat_plans WHERE id = ?').get(id) as
      | BeatRow
      | undefined
    return row ? this.rowToBeat(row) : undefined
  }

  /**
   * 单章节拍 upsert（外科手术式）：按 (project_id, chapter_number) 定位。
   * 已有行（含 superseded）→ 更新五字段并重置为 planned；无则插入。
   * 只影响该章一行，不触碰其他章节的节拍。
   */
  upsertChapterPlan(
    projectId: string,
    volumeNumber: number,
    input: BeatPlanInput
  ): NovelBeatPlan | undefined {
    const existing = this.db
      .prepare('SELECT id FROM novel_beat_plans WHERE project_id = ? AND chapter_number = ?')
      .get(projectId, input.chapterNumber) as { id: string } | undefined
    if (existing) {
      this.db
        .prepare(
          `UPDATE novel_beat_plans SET
             volume_number = ?, dramatic_function = ?, emotional_debt = ?, payoff = ?,
             arc_position = ?, summary = ?, status = 'planned', updated_at = unixepoch()
           WHERE id = ?`
        )
        .run(
          volumeNumber,
          input.dramaticFunction,
          input.emotionalDebt ?? '',
          input.payoff ?? '',
          input.arcPosition ?? '',
          input.summary ?? '',
          existing.id
        )
      return this.getBeat(existing.id)
    }
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO novel_beat_plans
           (id, project_id, volume_number, chapter_number, dramatic_function,
            emotional_debt, payoff, arc_position, summary, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', unixepoch(), unixepoch())`
      )
      .run(
        id,
        projectId,
        volumeNumber,
        input.chapterNumber,
        input.dramaticFunction,
        input.emotionalDebt ?? '',
        input.payoff ?? '',
        input.arcPosition ?? '',
        input.summary ?? ''
      )
    return this.getBeat(id)
  }

  getBeatByChapter(projectId: string, chapterNumber: number): NovelBeatPlan | undefined {
    const row = this.db
      .prepare('SELECT * FROM novel_beat_plans WHERE project_id = ? AND chapter_number = ?')
      .get(projectId, chapterNumber) as BeatRow | undefined
    return row && row.status !== 'superseded' ? this.rowToBeat(row) : undefined
  }

  listBeatsByVolume(
    projectId: string,
    volumeNumber: number,
    includeSuperseded = false
  ): NovelBeatPlan[] {
    const rows = (
      includeSuperseded
        ? this.db
            .prepare(
              'SELECT * FROM novel_beat_plans WHERE project_id = ? AND volume_number = ? ORDER BY chapter_number'
            )
            .all(projectId, volumeNumber)
        : this.db
            .prepare(
              `SELECT * FROM novel_beat_plans
               WHERE project_id = ? AND volume_number = ? AND status != 'superseded'
               ORDER BY chapter_number`
            )
            .all(projectId, volumeNumber)
    ) as BeatRow[]
    return rows.map((row) => this.rowToBeat(row))
  }

  listBeatsByProject(projectId: string): NovelBeatPlan[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM novel_beat_plans
         WHERE project_id = ? AND status != 'superseded' ORDER BY chapter_number`
      )
      .all(projectId) as BeatRow[]
    return rows.map((row) => this.rowToBeat(row))
  }

  updateBeat(
    id: string,
    patch: Partial<
      Pick<
        NovelBeatPlan,
        'dramaticFunction' | 'emotionalDebt' | 'payoff' | 'arcPosition' | 'summary' | 'status'
      >
    >
  ): NovelBeatPlan | undefined {
    const current = this.getBeat(id)
    if (!current) return undefined
    this.db
      .prepare(
        `UPDATE novel_beat_plans SET
           dramatic_function = ?, emotional_debt = ?, payoff = ?,
           arc_position = ?, summary = ?, status = ?, updated_at = unixepoch()
         WHERE id = ?`
      )
      .run(
        patch.dramaticFunction ?? current.dramaticFunction,
        patch.emotionalDebt ?? current.emotionalDebt,
        patch.payoff ?? current.payoff,
        patch.arcPosition ?? current.arcPosition,
        patch.summary ?? current.summary,
        patch.status ?? current.status,
        id
      )
    return this.getBeat(id)
  }

  /** 章节发布后把对应节拍标记为 confirmed（幂等）。 */
  confirmBeatForChapter(projectId: string, chapterNumber: number): NovelBeatPlan | undefined {
    const current = this.getBeatByChapter(projectId, chapterNumber)
    if (!current || current.status === 'confirmed') return current
    return this.updateBeat(current.id, { status: 'confirmed' })
  }

  private rowToBeat(row: BeatRow): NovelBeatPlan {
    return {
      id: row.id,
      projectId: row.project_id,
      volumeNumber: row.volume_number,
      chapterNumber: row.chapter_number,
      dramaticFunction: row.dramatic_function as BeatDramaticFunction,
      emotionalDebt: row.emotional_debt,
      payoff: row.payoff,
      arcPosition: row.arc_position,
      summary: row.summary,
      status: row.status as BeatPlanStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }
}

interface BeatRow {
  id: string
  project_id: string
  volume_number: number
  chapter_number: number
  dramatic_function: string
  emotional_debt: string
  payoff: string
  arc_position: string
  summary: string
  status: string
  created_at: number
  updated_at: number
}
