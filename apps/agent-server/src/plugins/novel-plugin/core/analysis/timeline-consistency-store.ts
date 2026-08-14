/**
 * TimelineConsistencyStore：中间章改写后的时间线一致性模块。
 *
 * 该模块把「识别影响范围、保留历史并标 stale、建立项目级闸门、生成重建预览」
 * 收口在一个接口后面。调用方只需声明正文已改写，不需要了解各派生表的状态字段。
 *
 * 重要约束：
 * - 调用 invalidateFromRewrite() 时必须位于正文提交事务内；
 * - 只改状态，不删除历史派生记录；
 * - 保存正文不会隐式启动重建；
 * - 没有可证明的第 N-1 章基线时，不允许创建自动重建任务。
 */
import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export type TimelineInvalidationStatus = 'pending' | 'rebuilding' | 'resolved'

export interface TimelineStaleCounts {
  chapterPlans: number
  sceneRevisions: number
  storylineProgresses: number
  storyEvents: number
  memoryEvents: number
  memorySnapshots: number
  characterHistory: number
  entityAppearances: number
  entityCandidates: number
}

export interface TimelineInvalidation {
  id: string
  projectId: string
  startChapterId: string
  startChapterNumber: number
  sourceContentRevisionId: string | null
  status: TimelineInvalidationStatus
  reason: 'chapter_rewrite'
  affectedChapters: number[]
  staleCounts: TimelineStaleCounts
  createdAt: number
  updatedAt: number
  resolvedAt: number | null
}

export interface TimelineRebuildPreview extends TimelineInvalidation {
  estimatedLlmCalls: number
  automaticRebuildAvailable: boolean
  blockedReasons: string[]
  confirmationToken: string
}

export interface TimelineBlock {
  invalidationId: string
  startChapterNumber: number
  status: Exclude<TimelineInvalidationStatus, 'resolved'>
  message: string
}

interface InvalidationRow {
  id: string
  project_id: string
  start_chapter_id: string
  start_chapter_number: number
  source_content_revision_id: string | null
  status: string
  reason: string
  affected_chapters: string
  stale_counts: string
  created_at: number
  updated_at: number
  resolved_at: number | null
}

interface ChapterRef {
  id: string
  chapter_number: number
  current_content_revision_id: string | null
}

const EMPTY_STALE_COUNTS: TimelineStaleCounts = {
  chapterPlans: 0,
  sceneRevisions: 0,
  storylineProgresses: 0,
  storyEvents: 0,
  memoryEvents: 0,
  memorySnapshots: 0,
  characterHistory: 0,
  entityAppearances: 0,
  entityCandidates: 0,
}

export class TimelineConsistencyStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * 正文改写后的唯一失效入口。
   *
   * 只有存在已写正文的后续章节时才建立 invalidation；末章改写不会制造无意义闸门。
   * 同一项目已有 pending/rebuilding invalidation 时合并到更早的起始章。
   */
  invalidateFromRewrite(input: {
    projectId: string
    chapterId: string
    chapterNumber: number
    sourceContentRevisionId?: string | null
  }): TimelineInvalidation | null {
    const later = this.db.prepare(`
      SELECT 1 FROM novel_chapters
      WHERE project_id = ? AND chapter_number > ? AND length(trim(content)) > 0
      LIMIT 1
    `).get(input.projectId, input.chapterNumber)
    if (!later) return null

    const existing = this.getActiveInvalidation(input.projectId)
    const startsEarlier = !existing || input.chapterNumber <= existing.startChapterNumber
    const startChapterNumber = startsEarlier ? input.chapterNumber : existing.startChapterNumber
    const startChapterId = startsEarlier ? input.chapterId : existing.startChapterId
    const sourceContentRevisionId = startsEarlier
      ? (input.sourceContentRevisionId ?? null)
      : existing.sourceContentRevisionId
    const affected = this.listAffectedChapters(input.projectId, startChapterNumber)
    const staleCounts = this.markAffectedStateStale(input.projectId, startChapterNumber)
    const mergedCounts = existing
      ? mergeCounts(existing.staleCounts, staleCounts)
      : staleCounts
    const timestamp = Date.now()

    if (existing) {
      this.db.prepare(`
        UPDATE novel_timeline_invalidations
        SET start_chapter_id = ?, start_chapter_number = ?, source_content_revision_id = ?,
            status = 'pending', affected_chapters = ?, stale_counts = ?, updated_at = ?, resolved_at = NULL
        WHERE id = ?
      `).run(
        startChapterId,
        startChapterNumber,
        sourceContentRevisionId,
        JSON.stringify(affected.map(chapter => chapter.chapter_number)),
        JSON.stringify(mergedCounts),
        timestamp,
        existing.id,
      )
      return this.getInvalidation(existing.id)!
    }

    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO novel_timeline_invalidations
        (id, project_id, start_chapter_id, start_chapter_number, source_content_revision_id,
         status, reason, affected_chapters, stale_counts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 'chapter_rewrite', ?, ?, ?, ?)
    `).run(
      id,
      input.projectId,
      startChapterId,
      startChapterNumber,
      sourceContentRevisionId,
      JSON.stringify(affected.map(chapter => chapter.chapter_number)),
      JSON.stringify(mergedCounts),
      timestamp,
      timestamp,
    )
    return this.getInvalidation(id)!
  }

  getInvalidation(id: string): TimelineInvalidation | undefined {
    const row = this.db.prepare(
      'SELECT * FROM novel_timeline_invalidations WHERE id = ?',
    ).get(id) as InvalidationRow | undefined
    return row ? this.rowToInvalidation(row) : undefined
  }

  getActiveInvalidation(projectId: string): TimelineInvalidation | undefined {
    const row = this.db.prepare(`
      SELECT * FROM novel_timeline_invalidations
      WHERE project_id = ? AND status IN ('pending', 'rebuilding')
      ORDER BY start_chapter_number ASC, created_at ASC
      LIMIT 1
    `).get(projectId) as InvalidationRow | undefined
    return row ? this.rowToInvalidation(row) : undefined
  }

  /**
   * LLM 创作闸门。失效起始章也必须阻塞：普通 Prompt 会读取含未来章节结果的实体当前态，
   * 只有隔离重建副本才能安全地从第 N 章重新分析。人工正文编辑不经过此闸门。
   */
  getGenerationBlock(projectId: string, chapterNumber: number): TimelineBlock | null {
    const invalidation = this.getActiveInvalidation(projectId)
    if (!invalidation || chapterNumber < invalidation.startChapterNumber) return null
    return {
      invalidationId: invalidation.id,
      startChapterNumber: invalidation.startChapterNumber,
      status: invalidation.status as TimelineBlock['status'],
      message: `第 ${invalidation.startChapterNumber} 章改写后的时间线尚未重建，不能继续生成第 ${chapterNumber} 章`,
    }
  }

  /** 发布比创作更严格：起始章及其后所有章节都处于 stale 范围。 */
  getPublishBlock(projectId: string, chapterNumber: number): TimelineBlock | null {
    const invalidation = this.getActiveInvalidation(projectId)
    if (!invalidation || chapterNumber < invalidation.startChapterNumber) return null
    return {
      invalidationId: invalidation.id,
      startChapterNumber: invalidation.startChapterNumber,
      status: invalidation.status as TimelineBlock['status'],
      message: `第 ${invalidation.startChapterNumber} 章起的派生状态尚未重建，不能发布第 ${chapterNumber} 章`,
    }
  }

  /**
   * 返回可审计的重建范围和确认 token。
   *
   * 当前历史操作账本未绑定 content revision，且尚无隔离副本应用器，无法证明能恢复
   * 第 N-1 章完整基线；因此首版安全策略是明确阻塞自动重建，而不是创建永不完成的 job。
   */
  getRebuildPreview(projectId: string): TimelineRebuildPreview | null {
    const invalidation = this.getActiveInvalidation(projectId)
    if (!invalidation) return null
    const affected = this.listAffectedChapters(projectId, invalidation.startChapterNumber)
    const missingContentRevisions = affected
      .filter(chapter => !chapter.current_content_revision_id)
      .map(chapter => chapter.chapter_number)
    const missingCommittedRuns = affected
      .filter(chapter => !this.hasCommittedMemoryRun(projectId, chapter.id))
      .map(chapter => chapter.chapter_number)
    const blockedReasons: string[] = []
    if (missingContentRevisions.length > 0) {
      blockedReasons.push(`以下章节缺少不可变正文版本：${missingContentRevisions.join('、')}`)
    }
    if (missingCommittedRuns.length > 0) {
      blockedReasons.push(`以下章节缺少已提交的 Memory 操作账本：${missingCommittedRuns.join('、')}`)
    }
    blockedReasons.push('隔离副本顺序应用器尚未达到可验证状态，自动重建已安全禁用')

    const confirmationToken = this.createConfirmationToken(invalidation)
    return {
      ...invalidation,
      estimatedLlmCalls: affected.length,
      automaticRebuildAvailable: false,
      blockedReasons,
      confirmationToken,
    }
  }

  verifyConfirmationToken(projectId: string, token: string): TimelineRebuildPreview | null {
    const preview = this.getRebuildPreview(projectId)
    if (!preview || preview.confirmationToken !== token) return null
    return preview
  }

  private markAffectedStateStale(projectId: string, startChapterNumber: number): TimelineStaleCounts {
    const counts: TimelineStaleCounts = { ...EMPTY_STALE_COUNTS }
    counts.chapterPlans = this.db.prepare(`
      UPDATE novel_chapter_plan_revisions SET status = 'stale'
      WHERE project_id = ? AND status IN ('draft', 'approved', 'consumed', 'confirmed')
        AND chapter_id IN (
          SELECT id FROM novel_chapters WHERE project_id = ? AND chapter_number >= ?
        )
    `).run(projectId, projectId, startChapterNumber).changes
    counts.sceneRevisions = this.db.prepare(`
      UPDATE novel_scene_revisions SET status = 'stale'
      WHERE project_id = ? AND status IN ('planned', 'confirmed')
        AND chapter_id IN (
          SELECT id FROM novel_chapters WHERE project_id = ? AND chapter_number >= ?
        )
    `).run(projectId, projectId, startChapterNumber).changes
    counts.storylineProgresses = this.db.prepare(`
      UPDATE novel_storyline_progress SET status = 'stale'
      WHERE project_id = ? AND status IN ('planned', 'confirmed')
        AND scene_revision_id IN (
          SELECT id FROM novel_scene_revisions
          WHERE project_id = ? AND chapter_id IN (
            SELECT id FROM novel_chapters WHERE project_id = ? AND chapter_number >= ?
          )
        )
    `).run(projectId, projectId, projectId, startChapterNumber).changes
    counts.storyEvents = this.db.prepare(`
      UPDATE novel_story_events SET status = 'stale', updated_at = ?
      WHERE project_id = ? AND chapter_number >= ?
        AND status IN ('planned', 'confirmed', 'generated')
    `).run(Date.now(), projectId, startChapterNumber).changes
    counts.memoryEvents = this.db.prepare(`
      UPDATE novel_memory_events SET status = 'stale'
      WHERE project_id = ? AND chapter_number >= ? AND status IN ('pending', 'confirmed')
    `).run(projectId, startChapterNumber).changes
    counts.memorySnapshots = this.db.prepare(`
      UPDATE novel_memory_snapshots SET status = 'stale'
      WHERE project_id = ? AND chapter_number >= ? AND status = 'active'
    `).run(projectId, startChapterNumber).changes
    counts.characterHistory = this.db.prepare(`
      UPDATE novel_character_history SET status = 'stale'
      WHERE project_id = ? AND chapter_number >= ? AND status = 'active'
    `).run(projectId, startChapterNumber).changes
    counts.entityAppearances = this.db.prepare(`
      UPDATE novel_entity_appearances SET status = 'stale'
      WHERE project_id = ? AND status = 'active' AND chapter_id IN (
        SELECT id FROM novel_chapters WHERE project_id = ? AND chapter_number >= ?
      )
    `).run(projectId, projectId, startChapterNumber).changes
    counts.entityCandidates = this.db.prepare(`
      UPDATE novel_entity_candidates SET status = 'stale'
      WHERE project_id = ? AND chapter_number >= ? AND status = 'needs_review'
    `).run(projectId, startChapterNumber).changes
    return counts
  }

  private listAffectedChapters(projectId: string, startChapterNumber: number): ChapterRef[] {
    return this.db.prepare(`
      SELECT id, chapter_number, current_content_revision_id
      FROM novel_chapters
      WHERE project_id = ? AND chapter_number >= ? AND length(trim(content)) > 0
      ORDER BY chapter_number ASC
    `).all(projectId, startChapterNumber) as ChapterRef[]
  }

  private hasCommittedMemoryRun(projectId: string, chapterId: string): boolean {
    return !!this.db.prepare(`
      SELECT 1 FROM novel_memory_operation_runs
      WHERE project_id = ? AND chapter_id = ? AND status = 'committed'
      LIMIT 1
    `).get(projectId, chapterId)
  }

  private createConfirmationToken(invalidation: TimelineInvalidation): string {
    return createHash('sha256').update(JSON.stringify({
      id: invalidation.id,
      updatedAt: invalidation.updatedAt,
      affectedChapters: invalidation.affectedChapters,
      staleCounts: invalidation.staleCounts,
    })).digest('hex')
  }

  private rowToInvalidation(row: InvalidationRow): TimelineInvalidation {
    return {
      id: row.id,
      projectId: row.project_id,
      startChapterId: row.start_chapter_id,
      startChapterNumber: row.start_chapter_number,
      sourceContentRevisionId: row.source_content_revision_id,
      status: row.status as TimelineInvalidationStatus,
      reason: 'chapter_rewrite',
      affectedChapters: parseNumberArray(row.affected_chapters),
      staleCounts: { ...EMPTY_STALE_COUNTS, ...parseObject(row.stale_counts) },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
    }
  }
}

function mergeCounts(left: TimelineStaleCounts, right: TimelineStaleCounts): TimelineStaleCounts {
  return Object.fromEntries(
    Object.keys(EMPTY_STALE_COUNTS).map(key => [
      key,
      left[key as keyof TimelineStaleCounts] + right[key as keyof TimelineStaleCounts],
    ]),
  ) as unknown as TimelineStaleCounts
}

function parseNumberArray(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is number => Number.isInteger(item))
      : []
  } catch {
    return []
  }
}

function parseObject(value: string): Partial<TimelineStaleCounts> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Partial<TimelineStaleCounts>
      : {}
  } catch {
    return {}
  }
}
