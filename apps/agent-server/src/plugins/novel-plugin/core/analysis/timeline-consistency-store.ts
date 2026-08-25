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
import type { NovelModelSelection } from '../domain/novel-model-ref.js'

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

export type TimelineRebuildJobStatus = 'queued' | 'running' | 'paused' | 'cancelling' | 'cancelled' | 'failed' | 'completed'
export type TimelineRebuildStepStatus = 'pending' | 'replaying' | 'ready_to_apply' | 'applied' | 'failed' | 'blocked'

export interface TimelineRebuildStep {
  jobId: string
  chapterId: string
  chapterNumber: number
  contentRevisionId: string
  status: TimelineRebuildStepStatus
  analysis: Record<string, unknown> | null
  error: string | null
  updatedAt: number
}

export interface TimelineRebuildJob {
  id: string
  invalidationId: string
  projectId: string
  startChapterNumber: number
  endChapterNumber: number
  status: TimelineRebuildJobStatus
  estimatedLlmCalls: number
  processedChapterNumber: number | null
  error: string | null
  createdAt: number
  startedAt: number | null
  updatedAt: number
  completedAt: number | null
  steps: TimelineRebuildStep[]
  completed: number
  failed: number
  skipped: number
  checkpoint: number | null
  blockedReason: string | null
  /** 创建任务时冻结的模型选择，避免恢复任务时改用另一模型。 */
  modelId: NovelModelSelection | null
}

export interface TimelineRebuildEvent {
  id: string
  sequence: number
  type: string
  chapterId: string | null
  chapterNumber: number | null
  payload: Record<string, unknown>
  createdAt: number
}

/** 章节应用时实际执行的恢复动作摘要，随 checkpoint 持久化供审计。 */
export interface TimelineRebuildArtifacts {
  restored: TimelineStaleCounts
  storyEventsInserted: string[]
  snapshotReplaced: boolean
}

export interface TimelineRebuildCheckpoint {
  id: string
  jobId: string
  chapterId: string
  chapterNumber: number
  contentRevisionId: string
  analysis: Record<string, unknown> | null
  artifacts: Record<string, unknown>
  createdAt: number
}

/** 隔离重放分析提出的剧情事件（写入 novel_story_events 的规范化结构）。 */
export interface ProposedStoryEvent {
  type: string
  title: string
  summary: string
  outcome?: string
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

interface RebuildJobRow {
  id: string
  invalidation_id: string
  project_id: string
  start_chapter_number: number
  end_chapter_number: number
  status: string
  estimated_llm_calls: number
  processed_chapter_number: number | null
  error: string | null
  created_at: number
  started_at: number | null
  updated_at: number
  completed_at: number | null
  model_id: string | null
}

interface RebuildStepRow {
  job_id: string
  chapter_id: string
  chapter_number: number
  content_revision_id: string
  status: string
  analysis_json: string | null
  error: string | null
  updated_at: number
}

interface RebuildEventRow {
  id: string
  sequence_no: number
  event_type: string
  chapter_id: string | null
  chapter_number: number | null
  payload: string
  created_at: number
}

interface RebuildCheckpointRow {
  id: string
  job_id: string
  chapter_id: string
  chapter_number: number
  content_revision_id: string
  analysis_json: string | null
  artifacts_json: string
  created_at: number
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

  createRebuildJob(
    projectId: string,
    confirmationToken: string,
    modelId?: NovelModelSelection | null,
  ): TimelineRebuildJob {
    const preview = this.verifyConfirmationToken(projectId, confirmationToken)
    if (!preview) throw new Error('影响范围已变化，请重新查看重建预览后确认')
    if (!preview.automaticRebuildAvailable) {
      throw new Error(preview.blockedReasons.join('；') || '当前项目不满足安全自动重建条件')
    }
    const active = this.db.prepare(`
      SELECT id FROM novel_timeline_rebuild_jobs
      WHERE project_id = ? AND status IN ('running', 'paused')
      ORDER BY created_at DESC LIMIT 1
    `).get(projectId) as { id: string } | undefined
    if (active) return this.getRebuildJob(projectId, active.id)!

    const affected = this.listAffectedChapters(projectId, preview.startChapterNumber)
    const now = Date.now()
    const jobId = randomUUID()
    const insert = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO novel_timeline_rebuild_jobs
          (id, invalidation_id, project_id, start_chapter_number, end_chapter_number, status,
            model_id, estimated_llm_calls, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
      `).run(jobId, preview.id, projectId, preview.startChapterNumber,
        affected.at(-1)?.chapter_number ?? preview.startChapterNumber,
        modelId ? JSON.stringify(modelId) : null,
        affected.length, now, now)
      const insertStep = this.db.prepare(`
        INSERT INTO novel_timeline_rebuild_steps
          (job_id, chapter_id, chapter_number, content_revision_id, status, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?)
      `)
      for (const chapter of affected) {
        if (!chapter.current_content_revision_id) throw new Error(`第 ${chapter.chapter_number} 章缺少正文版本`)
        insertStep.run(jobId, chapter.id, chapter.chapter_number, chapter.current_content_revision_id, now)
      }
      this.db.prepare(`
        UPDATE novel_timeline_invalidations SET status = 'rebuilding', updated_at = ? WHERE id = ?
      `).run(now, preview.id)
      this.appendEvent(jobId, 'job_queued', null, null, { startChapterNumber: preview.startChapterNumber, totalChapters: affected.length }, now)
    })
    insert()
    return this.getRebuildJob(projectId, jobId)!
  }

  getRebuildJob(projectId: string, jobId: string): TimelineRebuildJob | undefined {
    const job = this.db.prepare(`
      SELECT * FROM novel_timeline_rebuild_jobs WHERE id = ? AND project_id = ?
    `).get(jobId, projectId) as RebuildJobRow | undefined
    if (!job) return undefined
    const steps = this.db.prepare(`
      SELECT * FROM novel_timeline_rebuild_steps WHERE job_id = ? ORDER BY chapter_number ASC
    `).all(jobId) as RebuildStepRow[]
    const normalized = steps.map(rowToStep)
    const completed = normalized.filter(step => step.status === 'applied').length
    const failed = normalized.filter(step => step.status === 'failed').length
    const skipped = normalized.filter(step => step.status === 'blocked').length
    const checkpoint = [...normalized].reverse().find(step => step.status === 'applied')?.chapterNumber ?? null
    return {
      id: job.id,
      invalidationId: job.invalidation_id,
      projectId: job.project_id,
      startChapterNumber: job.start_chapter_number,
      endChapterNumber: job.end_chapter_number,
      status: normalizeJobStatus(job.status),
      estimatedLlmCalls: job.estimated_llm_calls,
      processedChapterNumber: job.processed_chapter_number,
      error: job.error,
      createdAt: job.created_at,
      startedAt: job.started_at,
      updatedAt: job.updated_at,
      completedAt: job.completed_at,
      steps: normalized,
      completed,
      failed,
      skipped,
      checkpoint,
      blockedReason: normalized.find(step => step.status === 'blocked')?.error ?? null,
      modelId: parseModelSelection(job.model_id),
    }
  }

  /** 获取当前 invalidation 最近一次任务，供页面恢复失败/取消任务的重试入口。 */
  getLatestRebuildJob(projectId: string, invalidationId: string): TimelineRebuildJob | undefined {
    const row = this.db.prepare(`
      SELECT id FROM novel_timeline_rebuild_jobs
      WHERE project_id = ? AND invalidation_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(projectId, invalidationId) as { id: string } | undefined
    return row ? this.getRebuildJob(projectId, row.id) : undefined
  }

  listRebuildEvents(projectId: string, jobId: string, afterSequence = 0): TimelineRebuildEvent[] {
    if (!this.getRebuildJob(projectId, jobId)) return []
    return (this.db.prepare(`
      SELECT * FROM novel_timeline_rebuild_events
      WHERE job_id = ? AND sequence_no > ? ORDER BY sequence_no ASC
    `).all(jobId, afterSequence) as RebuildEventRow[]).map(rowToEvent)
  }

  cancelRebuildJob(projectId: string, jobId: string): TimelineRebuildJob {
    const job = this.getRebuildJob(projectId, jobId)
    if (!job) throw new Error('重建任务不存在')
    if (!['queued', 'running', 'paused', 'cancelling'].includes(job.status)) return job
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare(`UPDATE novel_timeline_rebuild_jobs SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(now, jobId)
      this.appendEvent(jobId, 'job_cancelled', null, null, { checkpoint: job.checkpoint }, now)
    })()
    return this.getRebuildJob(projectId, jobId)!
  }

  resumeRebuildJob(projectId: string, jobId: string): TimelineRebuildJob {
    const job = this.getRebuildJob(projectId, jobId)
    if (!job) throw new Error('重建任务不存在')
    if (!['cancelled', 'failed', 'paused'].includes(job.status)) throw new Error('当前任务状态不能恢复')
    this.assertJobStillMatchesInvalidation(projectId, job)
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE novel_timeline_rebuild_jobs
        SET status = 'running', error = NULL, updated_at = ?, completed_at = NULL WHERE id = ?
      `).run(now, jobId)
      this.db.prepare(`
        UPDATE novel_timeline_rebuild_steps SET status = 'pending', error = NULL, updated_at = ?
        WHERE job_id = ? AND status IN ('failed', 'blocked', 'replaying')
      `).run(now, jobId)
      this.appendEvent(jobId, 'job_resumed', null, null, { checkpoint: job.checkpoint }, now)
    })()
    return this.getRebuildJob(projectId, jobId)!
  }

  beginRebuildStep(projectId: string, jobId: string, chapterId: string, expectedContentRevisionId: string): void {
    const job = this.getRebuildJob(projectId, jobId)
    if (!job) throw new Error('重建任务不存在')
    if (job.status !== 'running') throw new Error('当前任务未处于可执行状态')
    const step = job.steps.find(item => item.chapterId === chapterId)
    if (!step) throw new Error('章节不属于此重建任务')
    if (step.status !== 'pending') throw new Error('章节不处于待分析状态')
    if (step.contentRevisionId !== expectedContentRevisionId) throw new Error('章节正文版本已变化，请重新创建重建任务')
    const preceding = job.steps.filter(item => item.chapterNumber < step.chapterNumber)
    if (preceding.some(item => !['ready_to_apply', 'applied'].includes(item.status))) {
      throw new Error('必须按章节顺序完成隔离分析')
    }
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE novel_timeline_rebuild_steps SET status = 'replaying', updated_at = ?
        WHERE job_id = ? AND chapter_id = ?
      `).run(now, jobId, chapterId)
      this.db.prepare(`
        UPDATE novel_timeline_rebuild_jobs
        SET started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?
      `).run(now, now, jobId)
      this.appendEvent(jobId, 'chapter_replay_started', chapterId, step.chapterNumber, { contentRevisionId: expectedContentRevisionId }, now)
    })()
  }

  recordRebuildStepAnalysis(
    projectId: string,
    jobId: string,
    chapterId: string,
    expectedContentRevisionId: string,
    analysis: Record<string, unknown>,
  ): void {
    const job = this.getRebuildJob(projectId, jobId)
    if (!job) throw new Error('重建任务不存在')
    if (job.status !== 'running') throw new Error('当前任务未处于可执行状态')
    const step = job.steps.find(item => item.chapterId === chapterId)
    if (!step) throw new Error('章节不属于此重建任务')
    if (!['pending', 'replaying'].includes(step.status)) throw new Error('章节不处于待分析状态')
    if (step.contentRevisionId !== expectedContentRevisionId) throw new Error('章节正文版本已变化，请重新创建重建任务')
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE novel_timeline_rebuild_steps
        SET status = 'ready_to_apply', analysis_json = ?, error = NULL, updated_at = ?
        WHERE job_id = ? AND chapter_id = ?
      `).run(JSON.stringify(analysis), now, jobId, chapterId)
      this.db.prepare(`
        UPDATE novel_timeline_rebuild_jobs
        SET processed_chapter_number = ?, updated_at = ? WHERE id = ?
      `).run(step.chapterNumber, now, jobId)
      this.appendEvent(jobId, 'chapter_analysis_ready', chapterId, step.chapterNumber, {
        contentRevisionId: expectedContentRevisionId,
        inputHash: analysis.inputHash ?? null,
      }, now)
    })()
  }

  failRebuildStep(projectId: string, jobId: string, chapterId: string, error: string): void {
    const job = this.getRebuildJob(projectId, jobId)
    if (!job) throw new Error('重建任务不存在')
    const step = job.steps.find(item => item.chapterId === chapterId)
    if (!step) throw new Error('章节不属于此重建任务')
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE novel_timeline_rebuild_steps SET status = 'failed', error = ?, updated_at = ?
        WHERE job_id = ? AND chapter_id = ?
      `).run(error.slice(0, 2000), now, jobId, chapterId)
      this.db.prepare(`
        UPDATE novel_timeline_rebuild_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?
      `).run(error.slice(0, 2000), now, jobId)
      this.appendEvent(jobId, 'chapter_replay_failed', chapterId, step.chapterNumber, { error: error.slice(0, 2000) }, now)
    })()
  }

  markRebuildStepReady(projectId: string, jobId: string, chapterId: string, expectedContentRevisionId: string): TimelineRebuildJob {
    const job = this.getRebuildJob(projectId, jobId)
    if (!job) throw new Error('重建任务不存在')
    if (!['queued', 'running'].includes(job.status)) throw new Error('当前任务未处于可执行状态')
    const step = job.steps.find(item => item.chapterId === chapterId)
    if (!step) throw new Error('章节不属于此重建任务')
    if (step.contentRevisionId !== expectedContentRevisionId) throw new Error('章节正文版本已变化，请重新创建重建任务')
    const preceding = job.steps.filter(item => item.chapterNumber < step.chapterNumber)
    if (preceding.some(item => item.status !== 'applied')) throw new Error('必须按章节顺序应用重建结果')
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare(`UPDATE novel_timeline_rebuild_jobs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`).run(now, now, jobId)
      this.db.prepare(`UPDATE novel_timeline_rebuild_steps SET status = 'ready_to_apply', updated_at = ? WHERE job_id = ? AND chapter_id = ?`).run(now, jobId, chapterId)
      this.appendEvent(jobId, 'chapter_ready_to_apply', chapterId, step.chapterNumber, { contentRevisionId: expectedContentRevisionId }, now)
    })()
    return this.getRebuildJob(projectId, jobId)!
  }

  applyRebuildStep(projectId: string, jobId: string, chapterId: string, expectedContentRevisionId: string): TimelineRebuildJob {
    const job = this.getRebuildJob(projectId, jobId)
    if (!job) throw new Error('重建任务不存在')
    const step = job.steps.find(item => item.chapterId === chapterId)
    if (!step) throw new Error('章节不属于此重建任务')
    if (step.contentRevisionId !== expectedContentRevisionId) throw new Error('章节正文版本已变化，请重新创建重建任务')
    if (step.status !== 'ready_to_apply') throw new Error('章节尚未通过隔离重放校验，不能应用')
    const preceding = job.steps.filter(item => item.chapterNumber < step.chapterNumber)
    if (preceding.some(item => item.status !== 'applied')) throw new Error('必须按章节顺序应用重建结果')
    const now = Date.now()
    let artifacts: TimelineRebuildArtifacts
    this.db.transaction(() => {
      artifacts = this.restoreChapterDerivedState(projectId, step, expectedContentRevisionId, now)
      this.db.prepare(`
        UPDATE novel_timeline_rebuild_steps SET status = 'applied', updated_at = ? WHERE job_id = ? AND chapter_id = ?
      `).run(now, jobId, chapterId)
      this.db.prepare(`
        UPDATE novel_timeline_rebuild_jobs SET processed_chapter_number = ?, updated_at = ? WHERE id = ?
      `).run(step.chapterNumber, now, jobId)
      this.db.prepare(`
        INSERT INTO novel_timeline_rebuild_checkpoints
          (id, job_id, chapter_id, chapter_number, content_revision_id, analysis_json, artifacts_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (job_id, chapter_number) DO UPDATE SET
          analysis_json = excluded.analysis_json,
          artifacts_json = excluded.artifacts_json,
          created_at = excluded.created_at
      `).run(
        randomUUID(), jobId, chapterId, step.chapterNumber, expectedContentRevisionId,
        step.analysis ? JSON.stringify(step.analysis) : null,
        JSON.stringify(artifacts), now,
      )
      this.appendEvent(jobId, 'chapter_applied', chapterId, step.chapterNumber, {
        contentRevisionId: expectedContentRevisionId,
        restored: artifacts.restored,
        storyEventsInserted: artifacts.storyEventsInserted.length,
        snapshotReplaced: artifacts.snapshotReplaced,
      }, now)
    })()
    return this.getRebuildJob(projectId, jobId)!
  }

  /**
   * 应用章节重建结果：把该章派生状态从 stale 恢复为当前态。
   *
   * 恢复依据是隔离重放分析——每章已针对锁定正文 + 新前序状态重新分析，
   * 分析产物（summary/proposedChanges/hash）持久化在 step 与 checkpoint 中供审计。
   * - 分析给出了重放剧情事件时：旧 stale 事件保留为被取代的历史，插入新的 confirmed 事件；
   * - 分析未提出新事件时：旧事件按 stale_from 还原（重放校验通过）；
   * - 项目级 full 快照以「先取代后写入」方式刷新为重放摘要，实体级快照按 stale_from 还原。
   */
  private restoreChapterDerivedState(
    projectId: string,
    step: TimelineRebuildStep,
    expectedContentRevisionId: string,
    now: number,
  ): TimelineRebuildArtifacts {
    // 本模块内部表（jobs/steps/invalidations/events）自洽使用毫秒；但 story_events /
    // memory_snapshots 等跨模块表的 created_at/updated_at 惯例是秒（见 novel-memory-store
    // 的 now()）。混用会让毫秒行在 ORDER BY created_at DESC 中永远排最前，污染"最新"判定。
    const nowSec = Math.floor(now / 1000)
    const proposedEvents = extractProposedStoryEvents(step.analysis)
    const restored: TimelineStaleCounts = { ...EMPTY_STALE_COUNTS }
    const unstore = (sql: string, ...params: Array<string | number>): number =>
      this.db.prepare(sql).run(...params).changes

    restored.chapterPlans = unstore(`
      UPDATE novel_chapter_plan_revisions
      SET status = COALESCE(stale_from, 'approved'), stale_from = NULL
      WHERE project_id = ? AND status = 'stale' AND chapter_id = ?
    `, projectId, step.chapterId)
    restored.sceneRevisions = unstore(`
      UPDATE novel_scene_revisions
      SET status = COALESCE(stale_from, 'confirmed'), stale_from = NULL
      WHERE project_id = ? AND status = 'stale' AND chapter_id = ?
    `, projectId, step.chapterId)
    restored.storylineProgresses = unstore(`
      UPDATE novel_storyline_progress
      SET status = COALESCE(stale_from, 'confirmed'), stale_from = NULL
      WHERE project_id = ? AND status = 'stale' AND scene_revision_id IN (
        SELECT id FROM novel_scene_revisions WHERE chapter_id = ?
      )
    `, projectId, step.chapterId)
    if (proposedEvents.length > 0) {
      for (const event of proposedEvents) {
        this.db.prepare(`
          INSERT INTO novel_story_events
            (id, project_id, chapter_number, scene_id, scene_order, type, title, summary,
             outcome, status, parent_event_id, source, created_at, updated_at)
          VALUES (?, ?, ?, NULL, 0, ?, ?, ?, ?, 'confirmed', NULL, 'timeline_rebuild', ?, ?)
        `).run(
          randomUUID(), projectId, step.chapterNumber,
          event.type, event.title, event.summary, event.outcome ?? '', nowSec, nowSec,
        )
      }
    } else {
      restored.storyEvents = unstore(`
        UPDATE novel_story_events
        SET status = COALESCE(stale_from, 'confirmed'), stale_from = NULL, updated_at = ?
        WHERE project_id = ? AND status = 'stale' AND chapter_number = ?
      `, nowSec, projectId, step.chapterNumber)
    }
    restored.memoryEvents = unstore(`
      UPDATE novel_memory_events
      SET status = COALESCE(stale_from, 'confirmed'), stale_from = NULL
      WHERE project_id = ? AND status = 'stale' AND chapter_number = ?
    `, projectId, step.chapterNumber)
    // 实体级快照按 stale_from 还原；项目级 full 快照单独以重放摘要刷新。
    unstore(`
      UPDATE novel_memory_snapshots
      SET status = COALESCE(stale_from, 'active'), stale_from = NULL
      WHERE project_id = ? AND status = 'stale' AND chapter_number = ? AND snapshot_type != 'full'
    `, projectId, step.chapterNumber)
    this.db.prepare(`
      UPDATE novel_memory_snapshots SET status = 'superseded'
      WHERE project_id = ? AND chapter_number = ? AND snapshot_type = 'full'
        AND entity_id IS NULL AND status = 'active'
    `).run(projectId, step.chapterNumber)
    const snapshotData = JSON.stringify({
      kind: 'timeline_rebuild',
      jobId: step.jobId,
      contentRevisionId: expectedContentRevisionId,
      summary: step.analysis && typeof step.analysis.summary === 'string' ? step.analysis.summary : '',
      proposedChanges: step.analysis?.proposedChanges ?? {},
    })
    this.db.prepare(`
      INSERT INTO novel_memory_snapshots
        (id, project_id, chapter_number, snapshot_type, entity_id, snapshot_data, status, created_at)
        VALUES (?, ?, ?, 'full', NULL, ?, 'active', ?)
    `).run(randomUUID(), projectId, step.chapterNumber, snapshotData, nowSec)
    restored.memorySnapshots = 1
    restored.characterHistory = unstore(`
      UPDATE novel_character_history
      SET status = COALESCE(stale_from, 'active'), stale_from = NULL
      WHERE project_id = ? AND status = 'stale' AND chapter_number = ?
    `, projectId, step.chapterNumber)
    restored.entityAppearances = unstore(`
      UPDATE novel_entity_appearances
      SET status = COALESCE(stale_from, 'active'), stale_from = NULL
      WHERE project_id = ? AND status = 'stale' AND chapter_id = ?
    `, projectId, step.chapterId)
    // 候选恢复为 needs_review：候选晋升仍需用户确认，重放不能替代审核。
    restored.entityCandidates = unstore(`
      UPDATE novel_entity_candidates
      SET status = 'needs_review', stale_from = NULL
      WHERE project_id = ? AND status = 'stale' AND chapter_number = ?
    `, projectId, step.chapterNumber)
    return {
      restored,
      storyEventsInserted: proposedEvents.map(event => event.title),
      snapshotReplaced: true,
    }
  }

  completeRebuildJob(projectId: string, jobId: string): TimelineRebuildJob {
    const job = this.getRebuildJob(projectId, jobId)
    if (!job) throw new Error('重建任务不存在')
    if (job.steps.some(step => step.status !== 'applied')) throw new Error('所有章节均成功应用后才能完成重建')
    if (this.hasStaleDerivedState(projectId, job.startChapterNumber)) {
      throw new Error('派生状态仍处于 stale，必须由隔离重放执行器完成实际恢复后才能切换当前态')
    }
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare(`UPDATE novel_timeline_rebuild_jobs SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`).run(now, now, jobId)
      this.db.prepare(`UPDATE novel_timeline_invalidations SET status = 'resolved', updated_at = ?, resolved_at = ? WHERE id = ?`).run(now, now, job.invalidationId)
      this.appendEvent(jobId, 'job_completed', null, null, { completed: job.steps.length }, now)
    })()
    return this.getRebuildJob(projectId, jobId)!
  }

  /**
   * 隔离重放执行器完成全部章节分析后调用：确认所有步骤已就绪并落一条阶段事件。
   * job 保持 running（等待用户逐章应用），前端据此把 UI 从「重放中」切到「待应用」。
   */
  completeReplayAnalysisPhase(projectId: string, jobId: string): TimelineRebuildJob {
    const job = this.getRebuildJob(projectId, jobId)
    if (!job) throw new Error('重建任务不存在')
    const pendingStep = job.steps.find(step => !['ready_to_apply', 'applied'].includes(step.status))
    if (pendingStep) {
      throw new Error(`第 ${pendingStep.chapterNumber} 章尚未完成隔离重放分析`)
    }
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare(`UPDATE novel_timeline_rebuild_jobs SET updated_at = ? WHERE id = ?`).run(now, jobId)
      this.appendEvent(jobId, 'analysis_phase_completed', null, null, {
        readyToApply: job.steps.filter(step => step.status === 'ready_to_apply').length,
        applied: job.steps.filter(step => step.status === 'applied').length,
      }, now)
    })()
    return this.getRebuildJob(projectId, jobId)!
  }

  /** 读取最近一次成功应用的 checkpoint（恢复与审计入口）。 */
  getRebuildCheckpoint(projectId: string, jobId: string): TimelineRebuildCheckpoint | null {
    if (!this.getRebuildJob(projectId, jobId)) return null
    const row = this.db.prepare(`
      SELECT * FROM novel_timeline_rebuild_checkpoints
      WHERE job_id = ? ORDER BY chapter_number DESC LIMIT 1
    `).get(jobId) as RebuildCheckpointRow | undefined
    if (!row) return null
    return {
      id: row.id,
      jobId: row.job_id,
      chapterId: row.chapter_id,
      chapterNumber: row.chapter_number,
      contentRevisionId: row.content_revision_id,
      analysis: row.analysis_json ? parseObject(row.analysis_json) : null,
      artifacts: parseObject(row.artifacts_json),
      createdAt: row.created_at,
    }
  }

  /**
   * 供隔离重放分析 Prompt 使用的章节派生状态摘要（仅含标题/摘要类字段，不含正文）。
   * 让分析器看到该章当前标记 stale 的派生事实，才能提出有依据的重放结论。
   */
  getChapterStaleDerivedSummary(projectId: string, chapterId: string, chapterNumber: number): string {
    const lines: string[] = []
    const plans = this.db.prepare(`
      SELECT positioning FROM novel_chapter_plan_revisions
      WHERE project_id = ? AND chapter_id = ? AND status = 'stale' LIMIT 5
    `).all(projectId, chapterId) as Array<{ positioning: string | null }>
    for (const plan of plans) {
      if (plan.positioning) lines.push(`- 章纲定位（stale）：${plan.positioning}`)
    }
    const scenes = this.db.prepare(`
      SELECT title FROM novel_scene_revisions
      WHERE project_id = ? AND chapter_id = ? AND status = 'stale' ORDER BY order_no LIMIT 10
    `).all(projectId, chapterId) as Array<{ title: string | null }>
    for (const scene of scenes) {
      if (scene.title) lines.push(`- 场景（stale）：${scene.title}`)
    }
    const events = this.db.prepare(`
      SELECT title, summary, outcome FROM novel_story_events
      WHERE project_id = ? AND chapter_number = ? AND status = 'stale' ORDER BY scene_order LIMIT 10
    `).all(projectId, chapterNumber) as Array<{ title: string; summary: string; outcome: string }>
    for (const event of events) {
      lines.push(`- 剧情事件（stale）：${event.title}${event.summary ? `——${event.summary}` : ''}${event.outcome ? `（结果：${event.outcome}）` : ''}`)
    }
    const memoryEvents = this.db.prepare(`
      SELECT description FROM novel_memory_events
      WHERE project_id = ? AND chapter_number = ? AND status = 'stale' LIMIT 10
    `).all(projectId, chapterNumber) as Array<{ description: string }>
    for (const event of memoryEvents) {
      lines.push(`- 记忆事件（stale）：${event.description}`)
    }
    const history = this.db.prepare(`
      SELECT field_name, old_value, new_value FROM novel_character_history
      WHERE project_id = ? AND chapter_number = ? AND status = 'stale' LIMIT 10
    `).all(projectId, chapterNumber) as Array<{ field_name: string; old_value: string; new_value: string }>
    for (const item of history) {
      lines.push(`- 角色变更（stale）：${item.field_name} ${item.old_value} → ${item.new_value}`)
    }
    return lines.length > 0 ? lines.join('\n') : '（本章无标记 stale 的派生状态）'
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
   * 缺少不可变正文版本或已提交 Memory 操作账本的章节无法证明能恢复基线，
   * 预览会给出阻塞原因并拒绝自动重建；隔离重放执行器（TimelineRebuildRunner）
   * 负责逐章分析，应用与完成由用户逐章确认。
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
  // 账本缺失改为警告，不阻塞重建。
  if (missingCommittedRuns.length > 0) {
    console.warn(`[TimelineRebuild] 以下章节尚无账本记录（新章节可忽略）：${missingCommittedRuns.join('、')}`)
  }
    // 项目级全量快照，否则隔离重放第一步就会失败——必须在预览阶段拦下，
    // 而不是等用户确认启动后让任务秒败。
    const startChapterNumber = affected[0]?.chapter_number ?? invalidation.startChapterNumber
    if (startChapterNumber > 1 && !this.hasActiveFullSnapshot(projectId, startChapterNumber - 1)) {
      blockedReasons.push(`缺少第 ${startChapterNumber - 1} 章的全量状态快照作为重建基线，无法安全自动重建`)
    }

    const confirmationToken = this.createConfirmationToken(invalidation)
    return {
      ...invalidation,
      estimatedLlmCalls: affected.length,
      automaticRebuildAvailable: blockedReasons.length === 0,
      blockedReasons,
      confirmationToken,
    }
  }

  verifyConfirmationToken(projectId: string, token: string): TimelineRebuildPreview | null {
    const preview = this.getRebuildPreview(projectId)
    if (!preview || preview.confirmationToken !== token) return null
    return preview
  }

  /**
   * 完成闸门：还有未恢复的 stale 派生状态时禁止切换当前态。
   *
   * 两类残留属于设计内历史，仅当重放确实产出了替代事实时才可接受：
   * - 重放提出新剧情事件后，被取代的旧事件保留 stale（该章存在 timeline_rebuild 来源的 confirmed 事件）；
   * - 项目级 full 快照被重放摘要取代后，旧快照保留 stale（该章存在新的 active full 快照）。
   * 其余任何 >= 起始章的 stale 一律阻塞完成。
   */
  private hasStaleDerivedState(projectId: string, startChapterNumber: number): boolean {
    const checks: Array<{ sql: string; params: Array<string | number> }> = [
      {
        sql: `SELECT 1 FROM novel_chapter_plan_revisions WHERE project_id = ? AND status = 'stale' AND chapter_id IN (SELECT id FROM novel_chapters WHERE project_id = ? AND chapter_number >= ?) LIMIT 1`,
        params: [projectId, projectId, startChapterNumber],
      },
      {
        sql: `SELECT 1 FROM novel_scene_revisions WHERE project_id = ? AND status = 'stale' AND chapter_id IN (SELECT id FROM novel_chapters WHERE project_id = ? AND chapter_number >= ?) LIMIT 1`,
        params: [projectId, projectId, startChapterNumber],
      },
      {
        sql: `SELECT 1 FROM novel_storyline_progress WHERE project_id = ? AND status = 'stale' AND scene_revision_id IN (SELECT id FROM novel_scene_revisions WHERE chapter_id IN (SELECT id FROM novel_chapters WHERE project_id = ? AND chapter_number >= ?)) LIMIT 1`,
        params: [projectId, projectId, startChapterNumber],
      },
      {
        sql: `SELECT 1 FROM novel_story_events e
              WHERE e.project_id = ? AND e.status = 'stale' AND e.chapter_number >= ?
                AND NOT EXISTS (
                  SELECT 1 FROM novel_story_events r
                  WHERE r.project_id = e.project_id AND r.chapter_number = e.chapter_number
                    AND r.status = 'confirmed' AND r.source = 'timeline_rebuild'
                ) LIMIT 1`,
        params: [projectId, startChapterNumber],
      },
      { sql: `SELECT 1 FROM novel_memory_events WHERE project_id = ? AND status = 'stale' AND chapter_number >= ? LIMIT 1`, params: [projectId, startChapterNumber] },
      {
        sql: `SELECT 1 FROM novel_memory_snapshots s
              WHERE s.project_id = ? AND s.status = 'stale' AND s.snapshot_type = 'full' AND s.chapter_number >= ?
                AND NOT EXISTS (
                  SELECT 1 FROM novel_memory_snapshots a
                  WHERE a.project_id = s.project_id AND a.chapter_number = s.chapter_number
                    AND a.snapshot_type = 'full' AND a.status = 'active'
                ) LIMIT 1`,
        params: [projectId, startChapterNumber],
      },
      { sql: `SELECT 1 FROM novel_memory_snapshots WHERE project_id = ? AND status = 'stale' AND chapter_number >= ? AND snapshot_type != 'full' LIMIT 1`, params: [projectId, startChapterNumber] },
      { sql: `SELECT 1 FROM novel_character_history WHERE project_id = ? AND status = 'stale' AND chapter_number >= ? LIMIT 1`, params: [projectId, startChapterNumber] },
      {
        sql: `SELECT 1 FROM novel_entity_appearances WHERE project_id = ? AND status = 'stale' AND chapter_id IN (SELECT id FROM novel_chapters WHERE project_id = ? AND chapter_number >= ?) LIMIT 1`,
        params: [projectId, projectId, startChapterNumber],
      },
      { sql: `SELECT 1 FROM novel_entity_candidates WHERE project_id = ? AND status = 'stale' AND chapter_number >= ? LIMIT 1`, params: [projectId, startChapterNumber] },
    ]
    return checks.some(({ sql, params }) => !!this.db.prepare(sql).get(...params))
  }

  private appendEvent(
    jobId: string,
    eventType: string,
    chapterId: string | null,
    chapterNumber: number | null,
    payload: Record<string, unknown>,
    createdAt: number,
  ): void {
    const next = this.db.prepare(`
      SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_sequence
      FROM novel_timeline_rebuild_events WHERE job_id = ?
    `).get(jobId) as { next_sequence: number }
    this.db.prepare(`
      INSERT INTO novel_timeline_rebuild_events
        (id, job_id, sequence_no, event_type, chapter_id, chapter_number, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), jobId, next.next_sequence, eventType, chapterId, chapterNumber, JSON.stringify(payload), createdAt)
  }

  private markAffectedStateStale(projectId: string, startChapterNumber: number): TimelineStaleCounts {
    const counts: TimelineStaleCounts = { ...EMPTY_STALE_COUNTS }
    // stale_from 记录标记前的原状态（SQL UPDATE 右侧读的是行内旧值），
    // 供 applyRebuildStep 恢复当前态时精确还原，而不是猜测默认状态。
    counts.chapterPlans = this.db.prepare(`
      UPDATE novel_chapter_plan_revisions SET status = 'stale', stale_from = status
      WHERE project_id = ? AND status IN ('draft', 'approved', 'consumed', 'confirmed')
        AND chapter_id IN (
          SELECT id FROM novel_chapters WHERE project_id = ? AND chapter_number >= ?
        )
    `).run(projectId, projectId, startChapterNumber).changes
    counts.sceneRevisions = this.db.prepare(`
      UPDATE novel_scene_revisions SET status = 'stale', stale_from = status
      WHERE project_id = ? AND status IN ('planned', 'confirmed')
        AND chapter_id IN (
          SELECT id FROM novel_chapters WHERE project_id = ? AND chapter_number >= ?
        )
    `).run(projectId, projectId, startChapterNumber).changes
    counts.storylineProgresses = this.db.prepare(`
      UPDATE novel_storyline_progress SET status = 'stale', stale_from = status
      WHERE project_id = ? AND status IN ('planned', 'confirmed')
        AND scene_revision_id IN (
          SELECT id FROM novel_scene_revisions
          WHERE project_id = ? AND chapter_id IN (
            SELECT id FROM novel_chapters WHERE project_id = ? AND chapter_number >= ?
          )
        )
    `).run(projectId, projectId, projectId, startChapterNumber).changes
    counts.storyEvents = this.db.prepare(`
      UPDATE novel_story_events SET status = 'stale', stale_from = status, updated_at = ?
      WHERE project_id = ? AND chapter_number >= ?
        AND status IN ('planned', 'confirmed', 'generated')
    `).run(Math.floor(Date.now() / 1000), projectId, startChapterNumber).changes
    counts.memoryEvents = this.db.prepare(`
      UPDATE novel_memory_events SET status = 'stale', stale_from = status
      WHERE project_id = ? AND chapter_number >= ? AND status IN ('pending', 'confirmed')
    `).run(projectId, startChapterNumber).changes
    counts.memorySnapshots = this.db.prepare(`
      UPDATE novel_memory_snapshots SET status = 'stale', stale_from = status
      WHERE project_id = ? AND chapter_number >= ? AND status = 'active'
    `).run(projectId, startChapterNumber).changes
    counts.characterHistory = this.db.prepare(`
      UPDATE novel_character_history SET status = 'stale', stale_from = status
      WHERE project_id = ? AND chapter_number >= ? AND status = 'active'
    `).run(projectId, startChapterNumber).changes
    counts.entityAppearances = this.db.prepare(`
      UPDATE novel_entity_appearances SET status = 'stale', stale_from = status
      WHERE project_id = ? AND status = 'active' AND chapter_id IN (
        SELECT id FROM novel_chapters WHERE project_id = ? AND chapter_number >= ?
      )
    `).run(projectId, projectId, startChapterNumber).changes
    counts.entityCandidates = this.db.prepare(`
      UPDATE novel_entity_candidates SET status = 'stale', stale_from = status
      WHERE project_id = ? AND chapter_number >= ? AND status = 'needs_review'
    `).run(projectId, startChapterNumber).changes
    return counts
  }

  private listAffectedChapters(projectId: string, startChapterNumber: number): ChapterRef[] {
    return (this.db.prepare(`
      SELECT id, chapter_number, current_content_revision_id
      FROM novel_chapters
      WHERE project_id = ? AND chapter_number >= ? AND length(trim(content)) > 0
      ORDER BY chapter_number ASC
    `).all(projectId, startChapterNumber) as ChapterRef[])
      // 手动新建、尚未生成过的章节没有任何派生状态可失效/恢复，
      // 不进入重建范围：既不要求 Memory 账本，也不浪费隔离分析调用。
      .filter(chapter =>
        this.hasCommittedMemoryRun(projectId, chapter.id)
        || this.hasAnyDerivedState(projectId, chapter.id, chapter.chapter_number),
      )
  }

  /** 章节是否拥有任何派生投影数据（章纲/场景/事件/记忆/出场等）。 */
  private hasAnyDerivedState(projectId: string, chapterId: string, chapterNumber: number): boolean {
    const byChapterId = [
      `SELECT 1 FROM novel_chapter_plan_revisions WHERE project_id = ? AND chapter_id = ? LIMIT 1`,
      `SELECT 1 FROM novel_scene_revisions WHERE project_id = ? AND chapter_id = ? LIMIT 1`,
      `SELECT 1 FROM novel_entity_appearances WHERE project_id = ? AND chapter_id = ? LIMIT 1`,
    ]
    const byChapterNumber = [
      `SELECT 1 FROM novel_story_events WHERE project_id = ? AND chapter_number = ? LIMIT 1`,
      `SELECT 1 FROM novel_memory_events WHERE project_id = ? AND chapter_number = ? LIMIT 1`,
      `SELECT 1 FROM novel_memory_snapshots WHERE project_id = ? AND chapter_number = ? LIMIT 1`,
      `SELECT 1 FROM novel_character_history WHERE project_id = ? AND chapter_number = ? LIMIT 1`,
      `SELECT 1 FROM novel_entity_candidates WHERE project_id = ? AND chapter_number = ? LIMIT 1`,
    ]
    return byChapterId.some(sql => !!this.db.prepare(sql).get(projectId, chapterId))
      || byChapterNumber.some(sql => !!this.db.prepare(sql).get(projectId, chapterNumber))
  }

  private hasCommittedMemoryRun(projectId: string, chapterId: string): boolean {
    return !!this.db.prepare(`
      SELECT 1 FROM novel_memory_operation_runs
      WHERE project_id = ? AND chapter_id = ? AND status = 'committed'
      LIMIT 1
    `).get(projectId, chapterId)
  }

  private hasActiveFullSnapshot(projectId: string, chapterNumber: number): boolean {
    return !!this.db.prepare(`
      SELECT 1 FROM novel_memory_snapshots
      WHERE project_id = ? AND chapter_number = ? AND snapshot_type = 'full'
        AND entity_id IS NULL AND status = 'active'
      LIMIT 1
    `).get(projectId, chapterNumber)
  }

  /**
   * 恢复前的漂移校验：任务创建后如果正文又被改写/回滚（invalidation 合并前移、
   * 章节当前 revision 变化），旧任务的步骤范围与锁定版本均已过期，
   * 恢复它会用旧正文做隔离分析且永远无法完成——必须拒绝并要求重新创建。
   */
  private assertJobStillMatchesInvalidation(projectId: string, job: TimelineRebuildJob): void {
    const invalidation = this.getActiveInvalidation(projectId)
    if (!invalidation || invalidation.id !== job.invalidationId || invalidation.startChapterNumber !== job.startChapterNumber) {
      throw new Error('影响范围已变化，请重新查看重建预览后创建新的重建任务')
    }
    const drifted = job.steps.find((step) => {
      const row = this.db.prepare(
        'SELECT current_content_revision_id FROM novel_chapters WHERE id = ?',
      ).get(step.chapterId) as { current_content_revision_id: string | null } | undefined
      return !row || row.current_content_revision_id !== step.contentRevisionId
    })
    if (drifted) {
      throw new Error(`第 ${drifted.chapterNumber} 章正文版本已变化，请重新查看重建预览后创建新的重建任务`)
    }
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

function normalizeJobStatus(value: string): TimelineRebuildJobStatus {
  return ['queued', 'running', 'paused', 'cancelling', 'cancelled', 'failed', 'completed'].includes(value) ? value as TimelineRebuildJobStatus : 'failed'
}
function normalizeStepStatus(value: string): TimelineRebuildStepStatus {
  if (value === 'analyzed') return 'ready_to_apply'
  return ['pending', 'replaying', 'ready_to_apply', 'applied', 'failed', 'blocked'].includes(value) ? value as TimelineRebuildStepStatus : 'failed'
}
function rowToStep(row: RebuildStepRow): TimelineRebuildStep { return { jobId: row.job_id, chapterId: row.chapter_id, chapterNumber: row.chapter_number, contentRevisionId: row.content_revision_id, status: normalizeStepStatus(row.status), analysis: row.analysis_json ? parseObject(row.analysis_json) : null, error: row.error, updatedAt: row.updated_at } }
function rowToEvent(row: RebuildEventRow): TimelineRebuildEvent { return { id: row.id, sequence: row.sequence_no, type: row.event_type, chapterId: row.chapter_id, chapterNumber: row.chapter_number, payload: parseObject(row.payload), createdAt: row.created_at } }
function extractProposedStoryEvents(analysis: Record<string, unknown> | null): ProposedStoryEvent[] { const changes = analysis?.proposedChanges; if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return []; const raw = (changes as Record<string, unknown>).storyEvents; if (!Array.isArray(raw)) return []; return raw.flatMap(item => { if (!item || typeof item !== 'object') return []; const x=item as Record<string,unknown>; const title=typeof x.title==='string'?x.title.trim().slice(0,200):''; const summary=typeof x.summary==='string'?x.summary.trim().slice(0,2000):''; if(!title&&!summary)return []; return [{type: typeof x.type==='string'&&/^[a-z_]+$/.test(x.type)?x.type:'custom',title:title||summary.slice(0,80),summary,outcome:typeof x.outcome==='string'?x.outcome.trim().slice(0,1000):undefined} as ProposedStoryEvent] }).slice(0,20) }
function parseNumberArray(value: string): number[] { try { const parsed=JSON.parse(value) as unknown; return Array.isArray(parsed)?parsed.filter((x):x is number=>Number.isInteger(x)):[] } catch { return [] } }
function parseObject(value: string): Partial<TimelineStaleCounts> { try { const parsed=JSON.parse(value) as unknown; return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Partial<TimelineStaleCounts>:{} } catch{return {}} }
function parseModelSelection(value: string | null): NovelModelSelection | null { if(!value)return null; try{const p=JSON.parse(value) as Partial<NovelModelSelection>; if(typeof p.provider!=='string'||typeof p.modelId!=='string')return null; return {provider:p.provider,modelId:p.modelId,...(p.thinkingLevel!==undefined?{thinkingLevel:p.thinkingLevel}:{})}}catch{return null} }
