/**
 * ChapterStore - PR-5b 重构
 *
 * 从原 novel-store.ts 抽取 Chapter / Volume / Hook / CharacterArc / ChapterVersion 相关的 CRUD。
 * renumberChapterReferences 逻辑由独立的 ChapterRenumberService 处理，本文件不包含 renumber 逻辑；
 * deleteChapter 调用 ChapterRenumberService 完成重排。
 */

import type Database from 'better-sqlite3'
import { randomUUID, createHash } from 'node:crypto'
import {
  createChapterRenumberSpec,
} from '../chapter-renumber.js'
import type { ChapterRenumberSpec } from '../chapter-renumber.js'
import type { ChapterRenumberService } from './chapter-renumber-service.js'
import type {
  NovelChapter, NovelVolume, NovelHook, NovelCharacterArc,
  ChapterVersion, ChapterVersionSummary, ChapterVersionPhase, VersionSource,
  ContentRevision, ContentRevisionSummary, ContentRevisionStatus,
  ArcStageHistoryEntry,
} from '../types.js'
import type {
  ChapterRow, VolumeRow, HookRow, CharacterArcRow, ChapterVersionRow, ContentRevisionRow,
} from './row-types.js'
import { now } from './store-utils.js'
import {
  isNovelFeatureEnabled,
  type FeatureFlagProjectSource,
} from '../novel-feature-flags.js'
import type { VersionChainReconcileReport } from '../migration-acceptance.js'

/** 旧表 → V2 内容版本的规范化内容哈希（对账口径，与脚本一致） */
export function hashChapterContent(content: string): string {
  return createHash('sha256').update(content.replace(/\s+/g, ' ').trim()).digest('hex')
}

export class ChapterStore {
  private readonly stmtListChapters!: Database.Statement
  private readonly stmtGetChapter!: Database.Statement
  private readonly stmtListRecentChapters!: Database.Statement

  constructor(
    private db: Database.Database,
    private deleteEdgesByEntity: (entityId: string) => number,
    private renumberService: ChapterRenumberService,
    private flags?: FeatureFlagProjectSource,
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
    // V2 不可变正文链：初始内容非空时建立 rev1 锚点，
    // 保证初始状态也有版本记录、回滚可达；空内容（planned 占位）不建。
    if (full.content && full.content.trim().length > 0) {
      this.appendContentRevision(full, null)
    }
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
    // V2 不可变正文链：正文变更后追加一条 committed revision 并推进 current 指针
    if (versionSource !== 'skip' && patch.content !== undefined && patch.content !== current.content) {
      this.appendContentRevision(updated, versionSource ?? null)
    }
    return updated
  }

  updateChapterContent(id: string, content: string, wordCount: number, versionSource?: VersionSource): NovelChapter | undefined {
    const current = this.getChapterById(id)
    if (current && versionSource !== 'skip' && content !== current.content) {
      this.saveChapterVersionInternal(current, versionSource ?? null)
    }
    this.db.prepare('UPDATE novel_chapters SET content = ?, word_count = ?, updated_at = unixepoch() WHERE id = ?').run(content, wordCount, id)
    const updated = this.getChapterById(id) ?? undefined
    // V2 不可变正文链：正文变更后追加一条 committed revision 并推进 current 指针
    if (updated && versionSource !== 'skip' && content !== (current?.content ?? '')) {
      this.appendContentRevision(updated, versionSource ?? null)
    }
    return updated
  }

  /**
   * 旧版本表写入点（P1-1 停旧写）。
   *
   * `versionChainV2Write` 开启时直接 return（旧表停止 INSERT，观察期内只读保留）；
   * 关闭时保持现状（双写兼容路径）。
   */
  private saveChapterVersionInternal(chapter: NovelChapter, source: VersionSource | null): void {
    if (this.isV2WriteEnabled(chapter.projectId)) return
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

  private isV2ReadEnabled(projectId: string): boolean {
    return this.flags != null && isNovelFeatureEnabled(this.flags, projectId, 'versionChainV2Read')
  }

  private isV2WriteEnabled(projectId: string): boolean {
    return this.flags != null && isNovelFeatureEnabled(this.flags, projectId, 'versionChainV2Write')
  }

  /** ContentRevisionSummary → ChapterVersionSummary 包装（V2 读源对外保持旧接口形状） */
  private revisionSummaryToVersionSummary(rows: ContentRevisionSummary[]): ChapterVersionSummary[] {
    // rows 已是 revision 降序（最新在前），与旧 listChapterVersions 的返回顺序一致
    const byId = new Map(rows.map((r) => [r.id, r]))
    return rows.map((row, idx) => {
      // wordCountDelta：与更旧一条（revision 更小）比较
      const older = rows[idx + 1] ? byId.get(rows[idx + 1].id) : undefined
      return {
        id: row.id,
        sequence: row.revision,
        phase: row.phase,
        agentType: row.agentType,
        trigger: row.trigger,
        wordCount: row.wordCount,
        wordCountDelta: older != null ? row.wordCount - older.wordCount : 0,
        createdAt: row.createdAt,
        isCurrent: row.isCurrent,
      }
    })
  }

  /** ContentRevision → ChapterVersion 包装 */
  private revisionToVersion(revision: ContentRevision): ChapterVersion {
    return {
      id: revision.id,
      chapterId: revision.chapterId,
      projectId: revision.projectId,
      content: revision.content,
      wordCount: revision.wordCount,
      phase: revision.phase,
      agentType: revision.agentType,
      trigger: revision.trigger,
      sequence: revision.revision,
      createdAt: revision.createdAt,
    }
  }

  listChapterVersions(chapterId: string): ChapterVersionSummary[] {
    const chapter = this.getChapterById(chapterId)
    if (chapter && this.isV2ReadEnabled(chapter.projectId)) {
      return this.revisionSummaryToVersionSummary(this.listContentRevisions(chapterId))
    }
    const rows = this.db.prepare(
      `SELECT id, chapter_id, project_id, content, word_count, phase, agent_type, trigger,
              sequence, created_at
       FROM novel_chapter_versions WHERE chapter_id = ? ORDER BY sequence ASC`
    ).all(chapterId) as Omit<ChapterVersionRow, never>[]

    if (rows.length === 0) return []

    // ⚠️ isCurrent 修复：旧实现把版本表最后一行（覆盖前快照）标为当前，
    // 但版本表只存"覆盖前快照"，真正的当前正文在 novel_chapters.content。
    // 正确语义：只有 content 与当前正文完全一致的版本才是当前版；
    // 若当前正文尚未被存成版本（如用户刚 PATCH），则没有任何版本是 current。
    const currentChapter = this.getChapterById(chapterId)

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
        isCurrent: currentChapter != null && row.content === currentChapter.content,
      }
    })

    return summaries.reverse()
  }

  getChapterVersion(versionId: string): ChapterVersion | undefined {
    const v2 = this.getContentRevision(versionId)
    if (v2 && this.isV2ReadEnabled(v2.projectId)) {
      return this.revisionToVersion(v2)
    }
    const row = this.db.prepare(
      'SELECT * FROM novel_chapter_versions WHERE id = ?'
    ).get(versionId) as ChapterVersionRow | undefined
    return row ? this.rowToChapterVersion(row) : undefined
  }

  createVersionSnapshot(chapterId: string, source: VersionSource): ChapterVersion | undefined {
    if (source === 'skip' || source === undefined) return undefined
    const chapter = this.getChapterById(chapterId)
    if (!chapter) return undefined
    if (this.isV2WriteEnabled(chapter.projectId)) {
      // 停旧写：手工快照改走 V2 链，保证"手工保存产生正确 VersionSource"（P1-1-3）
      this.appendContentRevision(chapter, source)
      return this.getLatestVersion(chapterId)
    }
    this.saveChapterVersionInternal(chapter, source)
    return this.getLatestVersion(chapterId)
  }

  getLatestVersion(chapterId: string): ChapterVersion | undefined {
    const chapter = this.getChapterById(chapterId)
    if (chapter && this.isV2ReadEnabled(chapter.projectId)) {
      const current = this.getCurrentContentRevision(chapterId)
      return current ? this.revisionToVersion(current) : undefined
    }
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
    const current = this.getChapterById(chapterId)
    if (current && this.isV2ReadEnabled(current.projectId)) {
      // V2 读源：回滚委托不可变版本链（rollback_applied 新版本）
      const result = this.rollbackToContentRevision(chapterId, targetVersionId)
      return {
        savedVersionId: result.appliedRevisionId,
        currentContent: result.content,
        currentWordCount: result.wordCount,
      }
    }
    const target = this.getChapterVersion(targetVersionId)
    if (!target) throw new Error(`版本不存在: ${targetVersionId}`)
    if (target.chapterId !== chapterId) throw new Error('版本不属于该章节')

    const chapter = this.getChapterById(chapterId)
    if (!chapter) throw new Error(`章节不存在: ${chapterId}`)
    if (chapter.content === target.content) throw new Error('当前正文已是该版本内容，无需回滚')

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

  /**
   * 新旧版本链对账（P1-1-5）：按 (chapter_id, content sha256) 对比旧表全部行与 V2 链。
   * 只读；不执行回滚演练，rollbackVerified 保持 false，避免对账报告伪造验收通过。
   */
  reconcileVersionChains(projectId: string): VersionChainReconcileReport {
    const oldRows = this.db.prepare(
      `SELECT cv.chapter_id, cv.content
       FROM novel_chapter_versions cv
       JOIN novel_chapters c ON c.id = cv.chapter_id
       WHERE c.project_id = ?`,
    ).all(projectId) as Array<{ chapter_id: string; content: string }>

    const v2Rows = this.db.prepare(
      `SELECT r.chapter_id, r.content
       FROM novel_chapter_content_revisions r
       JOIN novel_chapters c ON c.id = r.chapter_id
       WHERE c.project_id = ?`,
    ).all(projectId) as Array<{ chapter_id: string; content: string }>

    const keyOf = (chapterId: string, content: string): string =>
      `${chapterId}:${hashChapterContent(content)}`

    const oldSet = new Set<string>()
    const oldByChapter = new Map<string, Set<string>>()
    const seenOldKeys = new Set<string>()
    let duplicateRows = 0
    for (const row of oldRows) {
      const key = keyOf(row.chapter_id, row.content)
      oldSet.add(key)
      let set = oldByChapter.get(row.chapter_id)
      if (!set) {
        set = new Set<string>()
        oldByChapter.set(row.chapter_id, set)
      }
      set.add(key)
      if (seenOldKeys.has(key)) duplicateRows += 1
      seenOldKeys.add(key)
    }

    const v2Set = new Set<string>()
    const v2ByChapter = new Map<string, Set<string>>()
    for (const row of v2Rows) {
      const key = keyOf(row.chapter_id, row.content)
      v2Set.add(key)
      let set = v2ByChapter.get(row.chapter_id)
      if (!set) {
        set = new Set<string>()
        v2ByChapter.set(row.chapter_id, set)
      }
      set.add(key)
    }

    let mismatchRows = 0
    for (const key of oldSet) {
      if (!v2Set.has(key)) mismatchRows += 1
    }
    // orphan 判定：V2 链中「非当前版本」却没有旧表对应行的行。
    // 旧表只存"覆盖前快照"，当前正文版本天然无旧表对应行（待下次覆盖才落快照），
    // 因此排除每章 current_content_revision_id 指向的版本后再判 orphan，否则永远 ≥ 1。
    const currentRevisionKeys = new Set<string>()
    const currentPointers = this.db.prepare(
      `SELECT c.id AS chapter_id, r.content AS revision_content
       FROM novel_chapters c
       JOIN novel_chapter_content_revisions r ON r.id = c.current_content_revision_id
       WHERE c.project_id = ?`,
    ).all(projectId) as Array<{ chapter_id: string; revision_content: string }>
    for (const row of currentPointers) {
      currentRevisionKeys.add(keyOf(row.chapter_id, row.revision_content))
    }
    let orphanRows = 0
    for (const key of v2Set) {
      if (currentRevisionKeys.has(key)) continue
      if (!oldSet.has(key)) orphanRows += 1
    }

    const allChapterIds = new Set<string>([...oldByChapter.keys(), ...v2ByChapter.keys()])

    // current_content_revision_id 指向正文与 novel_chapters.content 一致性
    const currentRows = this.db.prepare(
      `SELECT c.id AS chapter_id, c.content AS chapter_content,
              r.content AS revision_content, r.id AS revision_id
       FROM novel_chapters c
       LEFT JOIN novel_chapter_content_revisions r ON r.id = c.current_content_revision_id
       WHERE c.project_id = ?`,
    ).all(projectId) as Array<{
      chapter_id: string
      chapter_content: string
      revision_content: string | null
      revision_id: string | null
    }>

    const mismatchedChapters: VersionChainReconcileReport['mismatchedChapters'] = []
    for (const row of currentRows) {
      if (row.revision_id != null && row.revision_content !== row.chapter_content) {
        mismatchedChapters.push({
          chapterId: row.chapter_id,
          oldHash: hashChapterContent(row.chapter_content),
          newHash: hashChapterContent(row.revision_content ?? ''),
        })
      }
    }

    return {
      sourceRows: oldRows.length,
      targetRows: v2Rows.length,
      mismatchRows,
      orphanRows,
      duplicateRows,
      rollbackVerified: false,
      checkedChapters: allChapterIds.size,
      mismatchedChapters,
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 不可变正文版本链（V2 content revision）
  // 语义：每次正文落库追加一条 committed；旧 committed → superseded；
  // novel_chapters.current_content_revision_id 为当前指针；回滚创建新 revision，
  // 不把旧行设为 current。迁移期与 novel_chapter_versions 双写，T05 停旧写。
  // ═══════════════════════════════════════════════════════════════

  /**
   * 追加一条 committed 内容版本（正文落库后调用）。
   * 入参 chapter 必须是**更新后**的章节（含新 content/wordCount）。
   * 事务内完成：旧 committed → superseded → 插入新行 → 推进 current 指针。
   */
  appendContentRevision(chapter: NovelChapter, source: VersionSource | null): ContentRevision | undefined {
    return this.db.transaction(() => {
      const currentRow = this.db.prepare(
        `SELECT id FROM novel_chapter_content_revisions
         WHERE chapter_id = ? AND status = 'committed' ORDER BY revision DESC LIMIT 1`,
      ).get(chapter.id) as { id: string } | undefined
      if (currentRow) {
        this.db.prepare(
          `UPDATE novel_chapter_content_revisions SET status = 'superseded' WHERE id = ?`,
        ).run(currentRow.id)
      }
      const maxRev = (this.db.prepare(
        'SELECT MAX(revision) as maxRev FROM novel_chapter_content_revisions WHERE chapter_id = ?',
      ).get(chapter.id) as { maxRev: number | null } | undefined)?.maxRev ?? 0
      const phase = source && source !== 'skip' ? source.phase : null
      const agentType = source && source !== 'skip' ? (source.agentType ?? null) : null
      const trigger = source && source !== 'skip' ? (source.trigger ?? null) : null
      const id = randomUUID()
      this.db.prepare(`
        INSERT INTO novel_chapter_content_revisions
          (id, chapter_id, project_id, parent_revision_id, revision, content, word_count,
           phase, agent_type, trigger, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?)
      `).run(id, chapter.id, chapter.projectId, currentRow?.id ?? null, maxRev + 1,
        chapter.content, chapter.wordCount, phase, agentType, trigger, now())
      this.db.prepare(
        'UPDATE novel_chapters SET current_content_revision_id = ? WHERE id = ?',
      ).run(id, chapter.id)
      return this.getContentRevision(id)
    })()
  }

  listContentRevisions(chapterId: string): ContentRevisionSummary[] {
    const currentRev = (this.db.prepare(
      'SELECT current_content_revision_id FROM novel_chapters WHERE id = ?',
    ).get(chapterId) as { current_content_revision_id: string | null } | undefined)
      ?.current_content_revision_id ?? null
    const rows = this.db.prepare(
      `SELECT id, revision, word_count, phase, agent_type, trigger, status, created_at
       FROM novel_chapter_content_revisions WHERE chapter_id = ? ORDER BY revision ASC`,
    ).all(chapterId) as Array<Pick<ContentRevisionRow, 'id' | 'revision' | 'word_count' | 'phase' | 'agent_type' | 'trigger' | 'status' | 'created_at'>>

    return rows.map((row) => ({
      id: row.id,
      revision: row.revision,
      phase: (row.phase as ChapterVersionPhase | null) ?? null,
      agentType: row.agent_type,
      trigger: row.trigger,
      wordCount: row.word_count,
      status: row.status as ContentRevisionStatus,
      createdAt: row.created_at,
      isCurrent: row.id === currentRev,
    })).reverse()
  }

  getContentRevision(revisionId: string): ContentRevision | undefined {
    const row = this.db.prepare(
      'SELECT * FROM novel_chapter_content_revisions WHERE id = ?',
    ).get(revisionId) as ContentRevisionRow | undefined
    return row ? this.rowToContentRevision(row) : undefined
  }

  getCurrentContentRevision(chapterId: string): ContentRevision | undefined {
    const pointer = (this.db.prepare(
      'SELECT current_content_revision_id FROM novel_chapters WHERE id = ?',
    ).get(chapterId) as { current_content_revision_id: string | null } | undefined)
      ?.current_content_revision_id
    if (pointer) {
      const byPointer = this.getContentRevision(pointer)
      if (byPointer) return byPointer
    }
    // 指针缺失（旧数据/损坏）时回退到最新 committed
    const row = this.db.prepare(
      `SELECT * FROM novel_chapter_content_revisions
       WHERE chapter_id = ? AND status = 'committed' ORDER BY revision DESC LIMIT 1`,
    ).get(chapterId) as ContentRevisionRow | undefined
    return row ? this.rowToContentRevision(row) : undefined
  }

  /**
   * 按不可变链回滚：以目标 revision 为 parent 创建 rollback_applied 新 committed，
   * 原 current → superseded，推进指针并落正文。不把旧行设为 current。
   * 旧表（novel_chapter_versions）同步 rollback_pre / rollback_applied 快照保持兼容。
   */
  rollbackToContentRevision(chapterId: string, revisionId: string): {
    appliedRevisionId: string
    content: string
    wordCount: number
  } {
    const target = this.getContentRevision(revisionId)
    if (!target) throw new Error(`内容版本不存在: ${revisionId}`)
    if (target.chapterId !== chapterId) throw new Error('内容版本不属于该章节')
    const current = this.getChapterById(chapterId)
    if (!current) throw new Error(`章节不存在: ${chapterId}`)
    if (current.content === target.content) throw new Error('当前正文已是该版本内容，无需回滚')

    return this.db.transaction(() => {
      // 旧表兼容：回滚前快照
      this.createVersionSnapshot(chapterId, {
        phase: 'rollback_pre',
        trigger: `回滚到内容版本 ${revisionId}（rev ${target.revision}）`,
      })
      // 新链：原 current → superseded
      const currentRow = this.db.prepare(
        `SELECT id FROM novel_chapter_content_revisions
         WHERE chapter_id = ? AND status = 'committed' ORDER BY revision DESC LIMIT 1`,
      ).get(chapterId) as { id: string } | undefined
      if (currentRow) {
        this.db.prepare(
          `UPDATE novel_chapter_content_revisions SET status = 'superseded' WHERE id = ?`,
        ).run(currentRow.id)
      }
      const maxRev = (this.db.prepare(
        'SELECT MAX(revision) as maxRev FROM novel_chapter_content_revisions WHERE chapter_id = ?',
      ).get(chapterId) as { maxRev: number | null } | undefined)?.maxRev ?? 0
      const appliedId = randomUUID()
      this.db.prepare(`
        INSERT INTO novel_chapter_content_revisions
          (id, chapter_id, project_id, parent_revision_id, revision, content, word_count,
           phase, agent_type, trigger, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'rollback_applied', NULL, ?, 'rollback_applied', ?)
      `).run(appliedId, chapterId, current.projectId, target.id, maxRev + 1,
        target.content, target.wordCount, `回滚自内容版本 ${revisionId}`, now())
      this.db.prepare(
        `UPDATE novel_chapters SET current_content_revision_id = ?, content = ?, word_count = ?, updated_at = unixepoch() WHERE id = ?`,
      ).run(appliedId, target.content, target.wordCount, chapterId)
      // 旧表兼容：回滚落库快照（存回滚后的正文）
      const applied = this.getChapterById(chapterId)
      if (applied) {
        this.saveChapterVersionInternal(applied, {
          phase: 'rollback_applied',
          trigger: `回滚自内容版本 ${revisionId}`,
        })
      }
      return { appliedRevisionId: appliedId, content: target.content, wordCount: target.wordCount }
    })()
  }

  private rowToContentRevision(row: ContentRevisionRow): ContentRevision {
    return {
      id: row.id,
      chapterId: row.chapter_id,
      projectId: row.project_id,
      parentRevisionId: row.parent_revision_id,
      revision: row.revision,
      content: row.content,
      wordCount: row.word_count,
      phase: (row.phase as ChapterVersionPhase | null) ?? null,
      agentType: row.agent_type,
      trigger: row.trigger,
      status: row.status as ContentRevisionStatus,
      createdAt: row.created_at,
    }
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
