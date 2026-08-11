/**
 * NarrativeStore：剧情（narrative）实体轨道存储。
 *
 * 剧情实体承接冲突/线索/伏笔装不下的"剧情相关"内容（推进/转折/悬念/收束/铺垫/揭示），
 * 是矩阵的独立轨道（与 character/conflict/clue/foreshadow/faction 并排）。
 * 与 ConflictStore 同模式：chapterSpans 表示剧情活跃的连续章节区间。
 */
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { NovelNarrative, NarrativeType, ChapterSpan } from '../types.js'
import { now } from './store-utils.js'

interface NarrativeRow {
  id: string
  project_id: string
  description: string
  type: string
  chapter_spans: string
  status: string
  created_at: number
  updated_at: number
}

function parseSpans(raw: string | null | undefined): ChapterSpan[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is ChapterSpan =>
        Array.isArray(item) && item.length === 2 && Number.isInteger(item[0]) && Number.isInteger(item[1]),
    )
  } catch {
    return []
  }
}

export class NarrativeStore {
  constructor(private db: Database.Database) {}

  listNarratives(projectId: string): NovelNarrative[] {
    const rows = this.db.prepare(
      'SELECT * FROM novel_narratives WHERE project_id = ? ORDER BY created_at ASC',
    ).all(projectId) as NarrativeRow[]
    return rows.map((r) => this.rowToNarrative(r))
  }

  getNarrative(id: string): NovelNarrative | undefined {
    const row = this.db.prepare('SELECT * FROM novel_narratives WHERE id = ?').get(id) as NarrativeRow | undefined
    return row ? this.rowToNarrative(row) : undefined
  }

  createNarrative(input: Omit<NovelNarrative, 'id' | 'createdAt' | 'updatedAt'>): NovelNarrative {
    const id = randomUUID()
    const ts = now()
    const full: NovelNarrative = { ...input, id, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_narratives (id, project_id, description, type, chapter_spans, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      full.id, full.projectId, full.description, full.type,
      JSON.stringify(full.chapterSpans ?? []), full.status, full.createdAt, full.updatedAt,
    )
    return full
  }

  updateNarrative(id: string, patch: Partial<NovelNarrative>): NovelNarrative | undefined {
    const current = this.getNarrative(id)
    if (!current) return undefined
    const updated: NovelNarrative = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_narratives SET description=@description, type=@type,
        chapter_spans=@chapter_spans, status=@status, updated_at=@updated_at WHERE id=@id
    `).run({
      id,
      description: updated.description,
      type: updated.type,
      chapter_spans: JSON.stringify(updated.chapterSpans ?? []),
      status: updated.status,
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteNarrative(id: string): boolean {
    return this.db.prepare('DELETE FROM novel_narratives WHERE id = ?').run(id).changes > 0
  }

  private rowToNarrative(row: NarrativeRow): NovelNarrative {
    return {
      id: row.id,
      projectId: row.project_id,
      description: row.description,
      type: row.type as NarrativeType,
      chapterSpans: parseSpans(row.chapter_spans),
      status: row.status as NovelNarrative['status'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
