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
} from '../chapters/chapter-renumber.js'
import type { ChapterRenumberSpec } from '../chapters/chapter-renumber.js'
import type { ChapterRenumberService } from './chapter-renumber-service.js'
import type {
  NovelChapter, NovelVolume, NovelHook, NovelCharacterArc,
  ChapterVersion, ChapterVersionSummary, ChapterVersionPhase, VersionSource,
  ContentRevision, ContentRevisionSummary, ContentRevisionStatus,
  ArcStageHistoryEntry,
} from '../types.js'
import type {
  ChapterRow, VolumeRow, HookRow, CharacterArcRow, ContentRevisionRow,
} from './row-types.js'
import { now } from './store-utils.js'
import type { VersionChainReconcileReport } from '../analysis/migration-acceptance.js'
import { ChapterRepository, createNovelDrizzleDb } from '../../infrastructure/sqlite/index.js'

/** 旧表 → V2 内容版本的规范化内容哈希（对账口径，与脚本一致） */
export function hashChapterContent(content: string): string {
  return createHash('sha256').update(content.replace(/\s+/g, ' ').trim()).digest('hex')
}

/**
 * 「当前生效」的内容版本状态集合。
 * rollback_applied 语义上是"回滚产生的 committed 变体"（见 ContentRevisionStatus 注释），
 * 它代表一次已确认的正文状态；凡查找 current/最新 committed 的地方都必须把它算进去，
 * 否则回滚之后再 append 会找不到 parent（断链）、getCurrent 兜底找不到行、
 * 二次回滚无法把上一条 rollback 行置为 superseded。
 */
export class ChapterStore {
  private readonly chapterRepository: ChapterRepository

  constructor(
    private db: Database.Database,
    private deleteEdgesByEntity: (entityId: string) => number,
    private renumberService: ChapterRenumberService,
    private removeChapterAppearances?: (projectId: string, chapterId: string) => number,
  ) {
    this.chapterRepository = new ChapterRepository(createNovelDrizzleDb(db))
  }

  listChapters(projectId: string): NovelChapter[] {
    return this.chapterRepository.listByProject(projectId).map((r) => this.rowToChapter(r))
  }

  getChapter(projectId: string, chapterNumber: number): NovelChapter | undefined {
    const row = this.chapterRepository.getByProjectAndNumber(projectId, chapterNumber)
    return row ? this.rowToChapter(row) : undefined
  }

  getChapterById(chapterId: string): NovelChapter | undefined {
    const row = this.chapterRepository.getById(chapterId)
    return row ? this.rowToChapter(row) : undefined
  }

  createChapter(chapter: Omit<NovelChapter, 'createdAt' | 'updatedAt'>): NovelChapter {
    const ts = now()
    const full: NovelChapter = { outline: '', volumeId: null, ...chapter, createdAt: ts, updatedAt: ts }
    return this.db.transaction(() => {
      this.chapterRepository.insert({
        id: full.id, project_id: full.projectId, volume: full.volume, chapter_number: full.chapterNumber,
        title: full.title, content: full.content, word_count: full.wordCount, status: full.status,
        narrative_task: full.narrativeTask, outline: full.outline ?? '', volume_id: full.volumeId ?? null,
        acceptance_result: full.acceptanceResult, tension: full.tension ?? null, positioning: full.positioning ?? null,
        time_offset: full.timeOffset ?? null, chapter_ending_hook: full.chapterEndingHook ?? null, recap: full.recap ?? null,
        created_at: full.createdAt, updated_at: full.updatedAt,
      })
      // 初始正文与 rev1 必须原子提交，避免章节存在但版本指针缺失。
      if (full.content && full.content.trim().length > 0) {
        this.appendContentRevision(full, null)
      }
      return full
    })()
  }

  updateChapter(id: string, patch: Partial<NovelChapter>, versionSource?: VersionSource): NovelChapter | undefined {
    return this.db.transaction(() => {
      const existing = this.chapterRepository.getById(id)
      if (!existing) return undefined
      const current = this.rowToChapter(existing)
      const updated = { ...current, ...patch, id, updatedAt: now() }
      this.chapterRepository.updateFields(id, {
        id: updated.id, project_id: updated.projectId, volume: updated.volume, chapter_number: updated.chapterNumber,
        title: updated.title, content: updated.content, word_count: updated.wordCount, status: updated.status,
        narrative_task: updated.narrativeTask, outline: updated.outline ?? '', volume_id: updated.volumeId ?? null,
        acceptance_result: updated.acceptanceResult, tension: updated.tension ?? null, positioning: updated.positioning ?? null,
        time_offset: updated.timeOffset ?? null, chapter_ending_hook: updated.chapterEndingHook ?? null, recap: updated.recap ?? null,
        created_at: updated.createdAt, updated_at: updated.updatedAt,
      })
      if (versionSource !== 'skip' && patch.content !== undefined && patch.content !== current.content) {
        this.appendContentRevision(updated, versionSource ?? null)
      }
      return updated
    })()
  }

  updateChapterContent(id: string, content: string, wordCount: number, versionSource?: VersionSource): NovelChapter | undefined {
    return this.db.transaction(() => {
      const current = this.getChapterById(id)
      if (!current) return undefined
      this.chapterRepository.updateContent(id, content, wordCount, now())
      const updated = this.getChapterById(id)
      if (updated && versionSource !== 'skip' && content !== current.content) {
        this.appendContentRevision(updated, versionSource ?? null)
      }
      return updated
    })()
  }

  /** ContentRevisionSummary → ChapterVersionSummary 包装（V2 读源对外保持旧接口形状） */  private revisionSummaryToVersionSummary(rows: ContentRevisionSummary[]): ChapterVersionSummary[] {
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
    return this.revisionSummaryToVersionSummary(this.listContentRevisions(chapterId))
  }

  getChapterVersion(versionId: string): ChapterVersion | undefined {
    const v2 = this.getContentRevision(versionId)
    if (v2) return this.revisionToVersion(v2)
    return undefined
  }

  createVersionSnapshot(chapterId: string, source: VersionSource): ChapterVersion | undefined {
    if (source === 'skip' || source === undefined) return undefined
    const chapter = this.getChapterById(chapterId)
    if (!chapter) return undefined
    // 手工快照走 V2 不可变链（P1-1-3）
    this.appendContentRevision(chapter, source)
    return this.getLatestVersion(chapterId)
  }

  getLatestVersion(chapterId: string): ChapterVersion | undefined {
    const current = this.getCurrentContentRevision(chapterId)
    return current ? this.revisionToVersion(current) : undefined
  }

  rollbackToVersion(chapterId: string, targetVersionId: string): {
    savedVersionId: string
    currentContent: string
    currentWordCount: number
  } {
    // V2 读源：回滚委托不可变版本链（rollback_applied 新版本）
    const result = this.rollbackToContentRevision(chapterId, targetVersionId)
    return {
      savedVersionId: result.appliedRevisionId,
      currentContent: result.content,
      currentWordCount: result.wordCount,
    }
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
  // 不可变正文版本链（V2 content revision，唯一版本链）
  // 语义：每次正文落库追加一条 committed；旧 committed → superseded；
  // novel_chapters.current_content_revision_id 为当前指针；回滚创建新 revision，
  // 不把旧行设为 current。2026-08-12 逻辑统一：旧表 novel_chapter_versions 停写，
  // 仅保留 reconcileVersionChains 只读对账工具。
  // ═══════════════════════════════════════════════════════════════

  /**
   * 追加一条 committed 内容版本（正文落库后调用）。
   * 入参 chapter 必须是**更新后**的章节（含新 content/wordCount）。
   * 事务内完成：旧 committed → superseded → 插入新行 → 推进 current 指针。
   */
  appendContentRevision(chapter: NovelChapter, source: VersionSource | null): ContentRevision | undefined {
  // 防止空内容被保存为版本
  if (!chapter.content || chapter.content.trim() === '') {
    return undefined;
  }
    return this.db.transaction(() => {
      const currentId = this.chapterRepository.getLatestCommittedId(chapter.id)
      if (currentId) {
        this.chapterRepository.markSuperseded(currentId)
      }
      const maxRev = this.chapterRepository.getMaxRevision(chapter.id)
      const phase = source && source !== 'skip' ? source.phase : null
      const agentType = source && source !== 'skip' ? (source.agentType ?? null) : null
      const trigger = source && source !== 'skip' ? (source.trigger ?? null) : null
      const id = randomUUID()
      this.chapterRepository.insertRevision({ id, chapter_id: chapter.id, project_id: chapter.projectId, parent_revision_id: currentId ?? null, revision: maxRev + 1, content: chapter.content, word_count: chapter.wordCount, phase, agent_type: agentType, trigger, status: 'committed', created_at: now() })
      this.chapterRepository.updateCurrentRevision(chapter.id, id)
      return this.getContentRevision(id)
    })()
  }

  listContentRevisions(chapterId: string): ContentRevisionSummary[] {
    const currentRev = this.chapterRepository.getCurrentRevisionId(chapterId)
    const rows = this.chapterRepository.listRevisionSummaries(chapterId)

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
    const row = this.chapterRepository.getRevision(revisionId)
    return row ? this.rowToContentRevision(row) : undefined
  }

  getCurrentContentRevision(chapterId: string): ContentRevision | undefined {
    const pointer = this.chapterRepository.getCurrentRevisionId(chapterId)
    if (pointer) {
      const byPointer = this.getContentRevision(pointer)
      if (byPointer) return byPointer
    }
    // 指针缺失（旧数据/损坏）时回退到最新 committed（rollback_applied 同为生效变体）
    const row = this.chapterRepository.getCurrentRevision(chapterId)
    return row ? this.rowToContentRevision(row) : undefined
  }

  /**
   * 按不可变链回滚：以目标 revision 为 parent 创建 rollback_applied 新 committed，
   * 原 current → superseded，推进指针并落正文。不把旧行设为 current。
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
      // 新链：原 current → superseded（rollback_applied 同为生效变体，二次回滚也要收编）
      const currentId = this.chapterRepository.getLatestCommittedId(chapterId)
      if (currentId) {
        this.chapterRepository.markSuperseded(currentId)
      }
      const maxRev = this.chapterRepository.getMaxRevision(chapterId)
      const appliedId = randomUUID()
      this.chapterRepository.insertRevision({ id: appliedId, chapter_id: chapterId, project_id: current.projectId, parent_revision_id: target.id, revision: maxRev + 1, content: target.content, word_count: target.wordCount, phase: 'rollback_applied', agent_type: null, trigger: `回滚自内容版本 ${revisionId}`, status: 'rollback_applied', created_at: now() })
      this.chapterRepository.updateCurrentRevision(chapterId, appliedId, target.content, target.wordCount, now())
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
      // novel_entity_appearances 对 chapter_id 无外键，删章必须手动清出场行，
      // 否则出现指向已删章节的 appearance（对账 orphan 行）。
      this.removeChapterAppearances?.(chapter.projectId, id)
      // novel_author_intents.chapter_id 无外键 → 手动清理，防孤儿引用
      this.db.prepare('DELETE FROM novel_author_intents WHERE chapter_id = ?').run(id)
      // 画布上章节节点的坐标（deleteEdgesByEntity 只清边，节点本体在这里清）
      this.db.prepare(
        "DELETE FROM novel_node_positions WHERE node_type = 'chapter' AND entity_id = ?",
      ).run(id)
      // timeline_invalidations.start_chapter_id 是 RESTRICT 外键：不清掉锚定在
      // 被删章的失效记录，DELETE 章节会直接 FK 报错、整个事务回滚。
      // 失效标记随重排失去意义（被标 stale 的派生行已按章号删除/平移），删除即可。
      this.db.prepare(
        'DELETE FROM novel_timeline_invalidations WHERE start_chapter_id = ?',
      ).run(id)
      const result = this.db.prepare('DELETE FROM novel_chapters WHERE id = ?').run(id)
      if (result.changes === 0) return false
      const spec = createChapterRenumberSpec(chapter.chapterNumber)
      this.renumberService.renumberChapterReferences(chapter.projectId, spec)
      const progress = this.db.prepare(`
        SELECT COALESCE(MAX(chapter_number), 0) AS currentChapter
        FROM novel_chapters WHERE project_id = ? AND status = 'published'
      `).get(chapter.projectId) as { currentChapter: number }
      this.db.prepare(`
        UPDATE novel_projects SET current_chapter = ?, updated_at = unixepoch() WHERE id = ?
      `).run(progress.currentChapter, chapter.projectId)
      return true
    })()
  }

  listVolumes(projectId: string): NovelVolume[] {
    const rows = this.chapterRepository.listVolumes(projectId)
    return rows.map((r) => this.rowToVolume(r))
  }

  getVolume(id: string): NovelVolume | undefined {
    const row = this.chapterRepository.getVolume(id)
    return row ? this.rowToVolume(row) : undefined
  }

  createVolume(volume: Omit<NovelVolume, 'createdAt' | 'updatedAt'>): NovelVolume {
    const ts = now()
    const full: NovelVolume = { ...volume, createdAt: ts, updatedAt: ts }
    this.chapterRepository.insertVolume({
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
    this.chapterRepository.updateVolume(id, {
      id, project_id: updated.projectId, volume_number: updated.volumeNumber, title: updated.title,
      outline: updated.outline, sort_order: updated.sortOrder, created_at: updated.createdAt, updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteVolume(id: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare('UPDATE novel_chapters SET volume_id = NULL WHERE volume_id = ?').run(id)
      return this.chapterRepository.deleteVolume(id)
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
    const rows = this.chapterRepository.listHooks(projectId)
    return rows.map(r => this.rowToHook(r))
  }

  listHooksByChapter(projectId: string, chapterNumber: number): NovelHook[] {
    const rows = this.chapterRepository.listHooksByChapter(projectId, chapterNumber)
    return rows.map(r => this.rowToHook(r))
  }

  listUnfulfilledHooksBefore(projectId: string, beforeChapter: number): NovelHook[] {
    const rows = this.chapterRepository.listUnfulfilledHooksBefore(projectId, beforeChapter)
    return rows.map(r => this.rowToHook(r))
  }

  getHook(id: string): NovelHook | undefined {
    const row = this.chapterRepository.getHook(id)
    return row ? this.rowToHook(row) : undefined
  }

  createHook(hook: Omit<NovelHook, 'createdAt' | 'updatedAt'>): NovelHook {
    const ts = now()
    const full: NovelHook = { ...hook, createdAt: ts, updatedAt: ts }
    this.chapterRepository.insertHook({
      id: full.id, project_id: full.projectId, chapter_number: full.chapterNumber,
      hook_type: full.hookType, description: full.description, status: full.status,
      fulfilled_at_chapter: full.fulfilledAtChapter,
      fulfilled_description: full.fulfilledDescription,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateHook(id: string, patch: Partial<NovelHook>): NovelHook | undefined {
    const existing = this.chapterRepository.getHook(id)
    if (!existing) return undefined
    const current = this.rowToHook(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.chapterRepository.updateHook(id, {
      id, project_id: updated.projectId, chapter_number: updated.chapterNumber, hook_type: updated.hookType,
      description: updated.description, status: updated.status, fulfilled_at_chapter: updated.fulfilledAtChapter,
      fulfilled_description: updated.fulfilledDescription, created_at: updated.createdAt, updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteHook(id: string): boolean {
    return this.chapterRepository.deleteHook(id)
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
    const rows = this.chapterRepository.listCharacterArcs(projectId)
    return rows.map(r => this.rowToArc(r))
  }

  getCharacterArc(id: string): NovelCharacterArc | undefined {
    const row = this.chapterRepository.getCharacterArc(id)
    return row ? this.rowToArc(row) : undefined
  }

  getCharacterArcByCharacter(projectId: string, characterId: string): NovelCharacterArc | undefined {
    const row = this.chapterRepository.getCharacterArcByCharacter(projectId, characterId)
    return row ? this.rowToArc(row) : undefined
  }

  createCharacterArc(arc: Omit<NovelCharacterArc, 'createdAt' | 'updatedAt'>): NovelCharacterArc {
    const ts = now()
    const full: NovelCharacterArc = { ...arc, createdAt: ts, updatedAt: ts }
    this.chapterRepository.insertCharacterArc({
      id: full.id, project_id: full.projectId, character_id: full.characterId,
      arc_type: full.arcType, current_stage: full.currentStage,
      stage_history: JSON.stringify(full.stageHistory),
      description: full.description, created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateCharacterArc(id: string, patch: Partial<NovelCharacterArc>): NovelCharacterArc | undefined {
    const existing = this.chapterRepository.getCharacterArc(id)
    if (!existing) return undefined
    const current = this.rowToArc(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.chapterRepository.updateCharacterArc(id, {
      id, project_id: updated.projectId, character_id: updated.characterId, arc_type: updated.arcType,
      current_stage: updated.currentStage, stage_history: JSON.stringify(updated.stageHistory),
      description: updated.description, created_at: updated.createdAt, updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteCharacterArc(id: string): boolean {
    return this.chapterRepository.deleteCharacterArc(id)
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
      const rows = this.chapterRepository.listRecent(projectId, limit)
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
