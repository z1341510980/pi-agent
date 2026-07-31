import type Database from 'better-sqlite3'
import {
  shiftChapterSpans,
  shiftChapterList,
  shiftChapterEvents,
  CHAPTER_RENUMBER_FIELDS,
} from '../chapter-renumber.js'
import type { ChapterRenumberSpec } from '../chapter-renumber.js'
import {
  normalizeForeshadowBeats,
  deriveForeshadowStatus,
} from './store-utils.js'

export class ChapterRenumberService {
  constructor(private db: Database.Database) {}

  /**
   * 重排所有引用了 chapter_number 的字段
   * 按 CHAPTER_RENUMBER_FIELDS 常量遍历，逐表执行 UPDATE
   *
   * 注意：调用方（deleteChapter）已在外层开启事务，此处不再包裹。
   * JSON 解析失败会抛错，触发外层事务整体回滚（强一致优于静默跳过）。
   */
  renumberChapterReferences(projectId: string, spec: ChapterRenumberSpec): void {
    for (const field of CHAPTER_RENUMBER_FIELDS) {
      if (field.kind === 'scalar') {
        if (field.nullable) {
          this.db.prepare(
            `UPDATE ${field.table} SET ${field.column} = NULL WHERE ${field.column} = ? AND project_id = ?`,
          ).run(spec.deletedChapter, projectId)
        } else {
          this.db.prepare(
            `DELETE FROM ${field.table} WHERE project_id = ? AND ${field.column} = ?`,
          ).run(projectId, spec.deletedChapter)
        }
        this.db.prepare(
          `UPDATE ${field.table} SET ${field.column} = ${field.column} - 1 WHERE ${field.column} IS NOT NULL AND ${field.column} > ? AND project_id = ?`,
        ).run(spec.deletedChapter, projectId)
      } else if (field.kind === 'spans') {
        const rows = this.db.prepare(
          `SELECT id, ${field.column} AS spans FROM ${field.table} WHERE project_id = ?`,
        ).all(projectId) as Array<{ id: string; spans: string | null }>
        for (const row of rows) {
          if (!row.spans) continue
          const parsed = JSON.parse(row.spans)
          if (!Array.isArray(parsed)) {
            throw new Error(`非法 ${field.column} JSON: table=${field.table} id=${row.id}`)
          }
          if (!parsed.every((p) => Array.isArray(p) && p.length === 2
            && typeof p[0] === 'number' && typeof p[1] === 'number')) {
            throw new Error(`非法 ${field.column} 元素结构: table=${field.table} id=${row.id}`)
          }
          const shifted = shiftChapterSpans(parsed as Array<[number, number]>, spec)
          this.db.prepare(
            `UPDATE ${field.table} SET ${field.column} = ? WHERE id = ?`,
          ).run(JSON.stringify(shifted), row.id)
        }
      } else if (field.kind === 'list') {
        const rows = this.db.prepare(
          `SELECT id, ${field.column} AS list FROM ${field.table} WHERE project_id = ?`,
        ).all(projectId) as Array<{ id: string; list: string | null }>
        for (const row of rows) {
          if (!row.list) continue
          const parsed = JSON.parse(row.list)
          if (!Array.isArray(parsed)) {
            throw new Error(`非法 ${field.column} JSON: table=${field.table} id=${row.id}`)
          }
          if (!parsed.every((p) => typeof p === 'number')) {
            throw new Error(`非法 ${field.column} 元素结构: table=${field.table} id=${row.id}`)
          }
          const shifted = shiftChapterList(parsed as number[], spec)
          this.db.prepare(
            `UPDATE ${field.table} SET ${field.column} = ? WHERE id = ?`,
          ).run(JSON.stringify(shifted), row.id)
        }
      } else if (field.kind === 'events') {
        const rows = this.db.prepare(
          `SELECT id, ${field.column} AS events FROM ${field.table} WHERE project_id = ?`,
        ).all(projectId) as Array<{ id: string; events: string | null }>
        for (const row of rows) {
          if (!row.events) continue
          const parsed = JSON.parse(row.events)
          if (!Array.isArray(parsed) || !parsed.every((event) => event && typeof event === 'object' && typeof event.chapter === 'number')) {
            throw new Error(`非法 ${field.column} 事件结构: table=${field.table} id=${row.id}`)
          }
          const shifted = shiftChapterEvents(parsed as Array<{ chapter: number; [key: string]: unknown }>, spec)
          this.db.prepare(`UPDATE ${field.table} SET ${field.column} = ? WHERE id = ?`)
            .run(JSON.stringify(shifted), row.id)
        }
      }
    }

    const foreshadows = this.db.prepare(
      `SELECT id, beats, first_chapter
       FROM novel_foreshadowing WHERE project_id = ?`,
    ).all(projectId) as Array<{
      id: string
      beats: string | null
      first_chapter: number | null
    }>
    for (const row of foreshadows) {
      const parsed = row.beats ? JSON.parse(row.beats) : []
      const beats = normalizeForeshadowBeats(parsed, row.first_chapter)
      const firstChapter = beats.find((beat) => beat.type === 'plant')?.chapter ?? null
      const lastChapter = beats.at(-1)?.chapter ?? null
      // recover_by_chapter 是"计划回收章"，不由 beats 派生。
      // 它已经在上面的 scalar 字段循环里按重编号规则平移过（chapter-renumber.ts 的
      // { table: 'novel_foreshadowing', column: 'recover_by_chapter', kind: 'scalar' }），
      // 这里不能再用 payoff beat 覆盖它，否则"计划"会被"事实"抹掉。
      this.db.prepare(`
        UPDATE novel_foreshadowing
        SET beats = ?, first_chapter = ?, last_chapter = ?, status = ?
        WHERE id = ?
      `).run(
        JSON.stringify(beats), firstChapter, lastChapter,
        deriveForeshadowStatus(beats), row.id,
      )
    }
  }
}
