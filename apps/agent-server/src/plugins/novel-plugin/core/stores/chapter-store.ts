/**
 * ChapterStore - PR-5b 重构
 *
 * 从原 novel-store.ts 抽取 Chapter / Volume / Hook / CharacterArc / ChapterVersion 相关的 CRUD。
 * renumberChapterReferences 逻辑由独立的 ChapterRenumberService 处理，本文件不包含 renumber 逻辑；
 * deleteChapter 调用 ChapterRenumberService 完成重排。
 */

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import {
  createChapterRenumberSpec,
} from '../chapter-renumber.js'
import type { ChapterRenumberSpec } from '../chapter-renumber.js'
import type { ChapterRenumberService } from './chapter-renumber-service.js'
import type {
  NovelChapter, NovelVolume, NovelHook, NovelCharacterArc,
  ChapterVersion, ChapterVersionSummary, ChapterVersionPhase, VersionSource,
  ArcStageHistoryEntry,
} from '../types.js'
import type {
  ChapterRow, VolumeRow, HookRow, CharacterArcRow, ChapterVersionRow,
} from './row-types.js'
import { now } from './store-utils.js'

export class ChapterStore {
  private readonly stmtListChapters!: Database.Statement
  private readonly stmtGetChapter!: Database.Statement
  private readonly stmtListRecentChapters!: Database.Statement

  constructor(
    private db: Database.Database,
    private deleteEdgesByEntity: (entityId: string) => number,
    private renumberService: ChapterRenumberService,
  ) {
    this.stmtListChapters = db.prepare('SELECT * FROM novel_chapters WHERE project_id = ? ORDER BY chapter_number ASC')
    this.stmtGetChapter = db.prepare('SELECT * FROM novel_chapters WHERE project_id = ? AND chapter_number = ?')
    this.stmtListRecentChapters = db.prepare('SELECT * FROM novel_chapters WHERE project_id = ? AND content IS NOT NULL AND length(content) > 0 ORDER BY chapter_number DESC LIMIT ?')
  }

  listChapters(projectId: string): NovelChapter[] {
    return (this.stmtListChapters.all(projectId) as ChapterRow[]).map((r) => this.rowToChapter(r))
  }

  getChapter(projectId: string, chapterNumber: number): NovelChapter | undefined {
    const row = this.stmtGetChapter.get(projectId, chapterNumber) as ChapterRow | undefined
    return row ? this.rowToChapter(row) : undefined
  }

  getChapterById(chapterId: string): NovelChapter | undefined {
    const row = this.db.prepare('SELECT * FROM novel_chapters WHERE id = ?').get(chapterId) as ChapterRow | undefined
    return row ? this.rowToChapter(row) : undefined
  }

  createChapter(chapter: Omit<NovelChapter, 'createdAt' | 'updatedAt'>): NovelChapter {
    const ts = now()
    const full: NovelChapter = { outline: '', volumeId: null, ...chapter, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_chapters (id, project_id, volume, chapter_number, title, content, word_count, status, narrative_task, outline, volume_id, acceptance_result, tension, positioning, time_offset, chapter_ending_hook, recap, created_at, updated_at)
      VALUES (@id, @project_id, @volume, @chapter_number, @title, @content, @word_count, @status, @narrative_task, @outline, @volume_id, @acceptance_result, @tension, @positioning, @time_offset, @chapter_ending_hook, @recap, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, volume: full.volume,
      chapter_number: full.chapterNumber, title: full.title, content: full.content,
      word_count: full.wordCount, status: full.status, narrative_task: full.narrativeTask,
      outline: full.outline ?? '', volume_id: full.volumeId ?? null,
      acceptance_result: full.acceptanceResult, tension: full.tension ?? null,
      positioning: full.positioning ?? null,
      time_offset: full.timeOffset ?? null,
      chapter_ending_hook: full.chapterEndingHook ?? null,
      recap: full.recap ?? null,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateChapter(id: string, patch: Partial<NovelChapter>, versionSource?: VersionSource): NovelChapter | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_chapters WHERE id = ?').get(id) as ChapterRow | undefined
    if (!existing) return undefined
    const current = this.rowToChapter(existing)
    if (versionSource !== 'skip' && patch.content !== undefined && patch.content !== current.content) {
      this.saveChapterVersionInternal(current, versionSource ?? null)
    }
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_chapters SET title=@title, content=@content, word_count=@word_count,
      status=@status, narrative_task=@narrative_task, outline=@outline, volume_id=@volume_id,
      acceptance_result=@acceptance_result, tension=@tension,
      positioning=@positioning, time_offset=@time_offset, chapter_ending_hook=@chapter_ending_hook, recap=@recap,
      updated_at=@updated_at
      WHERE id=@id
    `).run({
      id, title: updated.title, content: updated.content, word_count: updated.wordCount,
      status: updated.status, narrative_task: updated.narrativeTask,
      outline: updated.outline ?? '', volume_id: updated.volumeId ?? null,
      acceptance_result: updated.acceptanceResult, tension: updated.tension ?? null,
      positioning: updated.positioning ?? null,
      time_offset: updated.timeOffset ?? null,
      chapter_ending_hook: updated.chapterEndingHook ?? null,
      recap: updated.recap ?? null,
      updated_at: updated.updatedAt,
    })
    return updated
  }

  updateChapterContent(id: string, content: string, wordCount: number, versionSource?: VersionSource): NovelChapter | undefined {
    const current = this.getChapterById(id)
    if (current && versionSource !== 'skip' && content !== current.content) {
      this.saveChapterVersionInternal(current, versionSource ?? null)
    }
    this.db.prepare('UPDATE novel_chapters SET content = ?, word_count = ?, updated_at = unixepoch() WHERE id = ?').run(content, wordCount, id)
    return this.getChapterById(id) ?? undefined
  }

  private saveChapterVersionInternal(chapter: NovelChapter, source: VersionSource | null): void {
    const maxSeq = (this.db.prepare(
      'SELECT MAX(sequence) as maxSeq FROM novel_chapter_versions WHERE chapter_id = ?'
    ).get(chapter.id) as { maxSeq: number | null } | undefined)?.maxSeq ?? 0

    const phase = source && source !== 'skip' ? source.phase : null
    const agentType = source && source !== 'skip' ? (source.agentType ?? null) : null
    const trigger = source && source !== 'skip' ? (source.trigger ?? null) : null

    this.db.prepare(`
      INSERT INTO novel_chapter_versions
        (id, chapter_id, project_id, content, word_count, phase, agent_type, trigger, sequence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      chapter.id,
      chapter.projectId,
      chapter.content,
      chapter.wordCount,
      phase,
      agentType,
      trigger,
      maxSeq + 1,
      now(),
    )
  }

  listChapterVersions(chapterId: string): ChapterVersionSummary[] {
    const rows = this.db.prepare(
      `SELECT id, chapter_id, project_id, word_count, phase, agent_type, trigger,
              sequence, created_at
       FROM novel_chapter_versions WHERE chapter_id = ? ORDER BY sequence ASC`
    ).all(chapterId) as Omit<ChapterVersionRow, 'content'>[]

    if (rows.length === 0) return []

    const summaries: ChapterVersionSummary[] = rows.map((row, idx) => {
      const prevWordCount = idx > 0 ? rows[idx - 1].word_count : row.word_count
      return {
        id: row.id,
        sequence: row.sequence,
        phase: (row.phase as ChapterVersionPhase | null) ?? null,
        agentType: row.agent_type,
        trigger: row.trigger,
        wordCount: row.word_count,
        wordCountDelta: idx > 0 ? row.word_count - prevWordCount : 0,
        createdAt: row.created_at,
        isCurrent: idx === rows.length - 1,
      }
    })

    return summaries.reverse()
  }

  getChapterVersion(versionId: string): ChapterVersion | undefined {
    const row = this.db.prepare(
      'SELECT * FROM novel_chapter_versions WHERE id = ?'
    ).get(versionId) as ChapterVersionRow | undefined
    return row ? this.rowToChapterVersion(row) : undefined
  }

  createVersionSnapshot(chapterId: string, source: VersionSource): ChapterVersion | undefined {
    if (source === 'skip' || source === undefined) return undefined
    const chapter = this.getChapterById(chapterId)
    if (!chapter) return undefined
    this.saveChapterVersionInternal(chapter, source)
    return this.getLatestVersion(chapterId)
  }

  getLatestVersion(chapterId: string): ChapterVersion | undefined {
    const row = this.db.prepare(
      'SELECT * FROM novel_chapter_versions WHERE chapter_id = ? ORDER BY sequence DESC LIMIT 1'
    ).get(chapterId) as ChapterVersionRow | undefined
    return row ? this.rowToChapterVersion(row) : undefined
  }

  private rowToChapterVersion(row: ChapterVersionRow): ChapterVersion {
    return {
      id: row.id,
      chapterId: row.chapter_id,
      projectId: row.project_id,
      content: row.content,
      wordCount: row.word_count,
      phase: (row.phase as ChapterVersionPhase | null) ?? null,
      agentType: row.agent_type,
      trigger: row.trigger,
      sequence: row.sequence,
      createdAt: row.created_at,
    }
  }

  rollbackToVersion(chapterId: string, targetVersionId: string): {
    savedVersionId: string
    currentContent: string
    currentWordCount: number
  } {
    const target = this.getChapterVersion(targetVersionId)
    if (!target) throw new Error(`版本不存在: ${targetVersionId}`)
    if (target.chapterId !== chapterId) throw new Error('版本不属于该章节')

    const current = this.getChapterById(chapterId)
    if (!current) throw new Error(`章节不存在: ${chapterId}`)
    if (current.content === target.content) throw new Error('当前正文已是该版本内容，无需回滚')

    return this.db.transaction(() => {
      const saved = this.createVersionSnapshot(chapterId, {
        phase: 'rollback_pre',
        trigger: `回滚到版本 ${targetVersionId}（seq ${target.sequence}）`,
      })
      this.updateChapterContent(chapterId, target.content, target.wordCount, 'skip')
      this.createVersionSnapshot(chapterId, {
        phase: 'rollback_applied',
        trigger: `回滚自版本 ${targetVersionId}`,
      })
      const updated = this.getChapterById(chapterId)
      return {
        savedVersionId: saved?.id ?? '',
        currentContent: updated?.content ?? target.content,
        currentWordCount: updated?.wordCount ?? target.wordCount,
      }
    })()
  }

  deleteChapter(id: string): boolean {
    return this.db.transaction(() => {
      const chapter = this.getChapterById(id)
      if (!chapter) return false
      this.deleteEdgesByEntity(id)
      const result = this.db.prepare('DELETE FROM novel_chapters WHERE id = ?').run(id)
      if (result.changes === 0) return false
      const spec = createChapterRenumberSpec(chapter.chapterNumber)
      this.renumberService.renumberChapterReferences(chapter.projectId, spec)
      return true
    })()
  }

  listVolumes(projectId: string): NovelVolume[] {
    const rows = this.db.prepare('SELECT * FROM novel_volumes WHERE project_id = ? ORDER BY sort_order ASC, volume_number ASC').all(projectId) as VolumeRow[]
    return rows.map((r) => this.rowToVolume(r))
  }

  getVolume(id: string): NovelVolume | undefined {
    const row = this.db.prepare('SELECT * FROM novel_volumes WHERE id = ?').get(id) as VolumeRow | undefined
    return row ? this.rowToVolume(row) : undefined
  }

  createVolume(volume: Omit<NovelVolume, 'createdAt' | 'updatedAt'>): NovelVolume {
    const ts = now()
    const full: NovelVolume = { ...volume, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_volumes (id, project_id, volume_number, title, outline, sort_order, created_at, updated_at)
      VALUES (@id, @project_id, @volume_number, @title, @outline, @sort_order, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, volume_number: full.volumeNumber,
      title: full.title, outline: full.outline, sort_order: full.sortOrder,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateVolume(id: string, patch: Partial<NovelVolume>): NovelVolume | undefined {
    const existing = this.getVolume(id)
    if (!existing) return undefined
    const updated = { ...existing, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_volumes SET title=@title, outline=@outline, sort_order=@sort_order,
      volume_number=@volume_number, updated_at=@updated_at WHERE id=@id
    `).run({
      id, title: updated.title, outline: updated.outline, sort_order: updated.sortOrder,
      volume_number: updated.volumeNumber, updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteVolume(id: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare('UPDATE novel_chapters SET volume_id = NULL WHERE volume_id = ?').run(id)
      const result = this.db.prepare('DELETE FROM novel_volumes WHERE id = ?').run(id)
      return result.changes > 0
    })()
  }

  private rowToVolume(row: VolumeRow): NovelVolume {
    return {
      id: row.id, projectId: row.project_id, volumeNumber: row.volume_number,
      title: row.title, outline: row.outline, sortOrder: row.sort_order,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  listHooks(projectId: string): NovelHook[] {
    const rows = this.db.prepare('SELECT * FROM novel_hooks WHERE project_id = ? ORDER BY chapter_number ASC, created_at ASC').all(projectId) as HookRow[]
    return rows.map(r => this.rowToHook(r))
  }

  listHooksByChapter(projectId: string, chapterNumber: number): NovelHook[] {
    const rows = this.db.prepare('SELECT * FROM novel_hooks WHERE project_id = ? AND chapter_number = ? ORDER BY created_at ASC').all(projectId, chapterNumber) as HookRow[]
    return rows.map(r => this.rowToHook(r))
  }

  listUnfulfilledHooksBefore(projectId: string, beforeChapter: number): NovelHook[] {
    const rows = this.db.prepare(
      'SELECT * FROM novel_hooks WHERE project_id = ? AND chapter_number < ? AND status = ? ORDER BY chapter_number DESC, created_at ASC'
    ).all(projectId, beforeChapter, 'thrown') as HookRow[]
    return rows.map(r => this.rowToHook(r))
  }

  getHook(id: string): NovelHook | undefined {
    const row = this.db.prepare('SELECT * FROM novel_hooks WHERE id = ?').get(id) as HookRow | undefined
    return row ? this.rowToHook(row) : undefined
  }

  createHook(hook: Omit<NovelHook, 'createdAt' | 'updatedAt'>): NovelHook {
    const ts = now()
    const full: NovelHook = { ...hook, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_hooks (id, project_id, chapter_number, hook_type, description, status,
      fulfilled_at_chapter, fulfilled_description,
      created_at, updated_at)
      VALUES (@id, @project_id, @chapter_number, @hook_type, @description, @status,
      @fulfilled_at_chapter, @fulfilled_description,
      @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, chapter_number: full.chapterNumber,
      hook_type: full.hookType, description: full.description, status: full.status,
      fulfilled_at_chapter: full.fulfilledAtChapter,
      fulfilled_description: full.fulfilledDescription,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateHook(id: string, patch: Partial<NovelHook>): NovelHook | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_hooks WHERE id = ?').get(id) as HookRow | undefined
    if (!existing) return undefined
    const current = this.rowToHook(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_hooks SET hook_type=@hook_type, description=@description, status=@status,
      fulfilled_at_chapter=@fulfilled_at_chapter, fulfilled_description=@fulfilled_description,
      updated_at=@updated_at WHERE id=@id
    `).run({
      id, hook_type: updated.hookType, description: updated.description, status: updated.status,
      fulfilled_at_chapter: updated.fulfilledAtChapter,
      fulfilled_description: updated.fulfilledDescription,
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteHook(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_hooks WHERE id = ?').run(id)
    return result.changes > 0
  }

  private rowToHook(row: HookRow): NovelHook {
    return {
      id: row.id,
      projectId: row.project_id,
      chapterNumber: row.chapter_number,
      hookType: row.hook_type as NovelHook['hookType'],
      description: row.description,
      status: row.status as NovelHook['status'],
      fulfilledAtChapter: row.fulfilled_at_chapter,
      fulfilledDescription: row.fulfilled_description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  listCharacterArcs(projectId: string): NovelCharacterArc[] {
    const rows = this.db.prepare('SELECT * FROM novel_character_arcs WHERE project_id = ? ORDER BY created_at ASC').all(projectId) as CharacterArcRow[]
    return rows.map(r => this.rowToArc(r))
  }

  getCharacterArc(id: string): NovelCharacterArc | undefined {
    const row = this.db.prepare('SELECT * FROM novel_character_arcs WHERE id = ?').get(id) as CharacterArcRow | undefined
    return row ? this.rowToArc(row) : undefined
  }

  getCharacterArcByCharacter(projectId: string, characterId: string): NovelCharacterArc | undefined {
    const row = this.db.prepare('SELECT * FROM novel_character_arcs WHERE project_id = ? AND character_id = ?').get(projectId, characterId) as CharacterArcRow | undefined
    return row ? this.rowToArc(row) : undefined
  }

  createCharacterArc(arc: Omit<NovelCharacterArc, 'createdAt' | 'updatedAt'>): NovelCharacterArc {
    const ts = now()
    const full: NovelCharacterArc = { ...arc, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_character_arcs (id, project_id, character_id, arc_type, current_stage,
      stage_history, description, created_at, updated_at)
      VALUES (@id, @project_id, @character_id, @arc_type, @current_stage,
      @stage_history, @description, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, character_id: full.characterId,
      arc_type: full.arcType, current_stage: full.currentStage,
      stage_history: JSON.stringify(full.stageHistory),
      description: full.description, created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateCharacterArc(id: string, patch: Partial<NovelCharacterArc>): NovelCharacterArc | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_character_arcs WHERE id = ?').get(id) as CharacterArcRow | undefined
    if (!existing) return undefined
    const current = this.rowToArc(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_character_arcs SET arc_type=@arc_type, current_stage=@current_stage,
      stage_history=@stage_history, description=@description, updated_at=@updated_at WHERE id=@id
    `).run({
      id, arc_type: updated.arcType, current_stage: updated.currentStage,
      stage_history: JSON.stringify(updated.stageHistory),
      description: updated.description, updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteCharacterArc(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_character_arcs WHERE id = ?').run(id)
    return result.changes > 0
  }

  private rowToArc(row: CharacterArcRow): NovelCharacterArc {
    let stageHistory: ArcStageHistoryEntry[] = []
    try { stageHistory = JSON.parse(row.stage_history) } catch { stageHistory = [] }
    return {
      id: row.id,
      projectId: row.project_id,
      characterId: row.character_id,
      arcType: row.arc_type as NovelCharacterArc['arcType'],
      currentStage: row.current_stage,
      stageHistory,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  listRecentChapters(projectId: string, limit: number): NovelChapter[] {
    const rows = this.stmtListRecentChapters.all(projectId, limit) as ChapterRow[]
    return rows.map((r) => this.rowToChapter(r)).reverse()
  }

  private rowToChapter(row: ChapterRow): NovelChapter {
    return {
      id: row.id, projectId: row.project_id, volume: row.volume,
      chapterNumber: row.chapter_number, title: row.title, content: row.content,
      wordCount: row.word_count, status: row.status as NovelChapter['status'],
      narrativeTask: row.narrative_task, outline: row.outline, volumeId: row.volume_id,
      acceptanceResult: row.acceptance_result,
      tension: row.tension ?? null,
      positioning: (row.positioning as NovelChapter['positioning']) ?? null,
      timeOffset: row.time_offset ?? null,
      chapterEndingHook: (row.chapter_ending_hook as NovelChapter['chapterEndingHook']) ?? null,
      recap: row.recap ?? null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }
}
