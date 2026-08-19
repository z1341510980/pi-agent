import { createHash } from 'node:crypto'
import type { PluginContext } from '../../../../core/plugin/plugin-types.js'
import type { NovelStore } from '../novel-store.js'
import type { NovelMemoryStore } from '../novel-memory-store.js'

export type TimelineRebuildAnalysisResult = {
  summary: string
  proposedChanges: unknown
  inputHash: string
  baseSnapshotHash: string
}

export interface TimelineRebuildRunnerStore {
  getTimelineRebuildJob(projectId: string, jobId: string): ReturnType<NovelStore['getTimelineRebuildJob']>
  getContentRevision(revisionId: string): ReturnType<NovelStore['getContentRevision']>
  beginTimelineRebuildStep(projectId: string, jobId: string, chapterId: string, expectedContentRevisionId: string): void
  recordTimelineRebuildStepAnalysis(
    projectId: string,
    jobId: string,
    chapterId: string,
    expectedContentRevisionId: string,
    analysis: Record<string, unknown>,
  ): void
  failTimelineRebuildStep(projectId: string, jobId: string, chapterId: string, error: string): void
  getChapterTimelineStaleSummary(projectId: string, chapterId: string, chapterNumber: number): string
  completeTimelineRebuildAnalysisPhase(projectId: string, jobId: string): ReturnType<NovelStore['getTimelineRebuildJob']>
}

export interface TimelineRebuildRunnerMemoryStore {
  getSnapshot: NovelMemoryStore['getSnapshot']
}

/**
 * 在主库之外运行的时间线重建分析器（隔离重放执行器）。
 *
 * 逐章执行：锁定正文 revision → begin（pending→replaying）→ LLM 隔离分析 →
 * 记录分析产物（→ready_to_apply）。分析只产生候选结论，不调用任何主库写接口；
 * 即使 LLM 失败、取消或输出不合格，也不会污染项目当前事实。
 * 全部分析完成后追加 analysis_phase_completed 事件，等待用户逐章 ready/apply/complete。
 */
export class TimelineRebuildRunner {
  private readonly running = new Map<string, AbortController>()

  constructor(
    private readonly context: PluginContext,
    private readonly store: TimelineRebuildRunnerStore,
    private readonly memoryStore: TimelineRebuildRunnerMemoryStore,
  ) {}

  isRunning(jobId: string): boolean {
    return this.running.has(jobId)
  }

  requestCancel(jobId: string): void {
    this.running.get(jobId)?.abort()
  }

  async run(projectId: string, jobId: string): Promise<void> {
    if (this.running.has(jobId)) return
    const controller = new AbortController()
    this.running.set(jobId, controller)
    try {
      await this.runSequentially(projectId, jobId, controller.signal)
    } finally {
      this.running.delete(jobId)
    }
  }

  private async runSequentially(projectId: string, jobId: string, signal: AbortSignal): Promise<void> {
    let job = this.store.getTimelineRebuildJob(projectId, jobId)
    if (!job || !['queued', 'running'].includes(job.status)) return

    const firstChapter = job.steps[0]?.chapterNumber ?? job.startChapterNumber
    const baseSnapshot = firstChapter <= 1
      ? { snapshotData: JSON.stringify({ note: '从第 1 章开始重建，无章前快照' }), chapterNumber: 0 }
      : this.memoryStore.getSnapshot(projectId, firstChapter - 1, { snapshotType: 'full' })
      if (!baseSnapshot) {
        const firstStep = job.steps[0]
      if (firstStep) this.store.failTimelineRebuildStep(projectId, jobId, firstStep.chapterId, '缺少重建起始章前的全量状态快照')
      return
    }

    const baseSnapshotHash = hash(baseSnapshot.snapshotData)
    const priorAnalyses: Array<{ chapterNumber: number; summary: string }> = []

    // 过滤掉无正文的步骤（刚创建尚未生成内容的章节）
    const validSteps = job.steps.filter((step) => {
      const rev = this.store.getContentRevision(step.contentRevisionId)
      return rev && rev.content.trim().length > 0
    })
    if (validSteps.length === 0) {
      this.context.logger.info({ jobId, projectId }, '无有效正文章节可重建，自动完成')
      this.store.completeTimelineRebuildAnalysisPhase(projectId, jobId)
      return
    }
    for (const initialStep of validSteps) {
      signal.throwIfAborted()
      job = this.store.getTimelineRebuildJob(projectId, jobId)
      if (!job || !['queued', 'running'].includes(job.status)) return
      const step = job.steps.find(item => item.chapterId === initialStep.chapterId)
      if (!step) return
      if (step.status === 'applied' || step.status === 'ready_to_apply') {
        if (step.analysis && typeof step.analysis.summary === 'string') {
          priorAnalyses.push({ chapterNumber: step.chapterNumber, summary: step.analysis.summary })
        }
        continue
      }
      if (step.status !== 'pending') return

      const revision = this.store.getContentRevision(step.contentRevisionId)
      if (!revision || revision.content.trim().length === 0) {
        this.store.failTimelineRebuildStep(projectId, jobId, step.chapterId, '锁定的正文 revision 不存在或为空')
        return
      }

      try {
        this.store.beginTimelineRebuildStep(projectId, jobId, step.chapterId, step.contentRevisionId)
        const staleSummary = this.store.getChapterTimelineStaleSummary(projectId, step.chapterId, step.chapterNumber)
        const result = await this.analyzeChapter({
          projectId,
          chapterNumber: step.chapterNumber,
          content: revision.content,
          contentRevisionId: step.contentRevisionId,
          baseSnapshotData: baseSnapshot.snapshotData,
          baseSnapshotHash,
          staleDerivedSummary: staleSummary,
          priorAnalyses,
          modelId: job.modelId,
          signal,
        })
        this.store.recordTimelineRebuildStepAnalysis(projectId, jobId, step.chapterId, step.contentRevisionId, result)
        priorAnalyses.push({ chapterNumber: step.chapterNumber, summary: result.summary })
      } catch (error) {
        if (signal.aborted) return
        this.store.failTimelineRebuildStep(
          projectId,
          jobId,
          step.chapterId,
          error instanceof Error ? error.message : '隔离重放分析失败',
        )
        return
      }
    }

    try {
      this.store.completeTimelineRebuildAnalysisPhase(projectId, jobId)
    } catch (error) {
      this.context.logger.warn(
        { err: error, projectId, jobId },
        '时间线重放分析阶段完成事件写入失败（分析产物已持久化，不影响逐章应用）',
      )
    }
  }

  private async analyzeChapter(input: {
    projectId: string
    chapterNumber: number
    content: string
    contentRevisionId: string
    baseSnapshotData: string
    baseSnapshotHash: string
    staleDerivedSummary: string
    priorAnalyses: Array<{ chapterNumber: number; summary: string }>
    modelId: TimelineRebuildAnalysisModel | null
    signal: AbortSignal
  }): Promise<TimelineRebuildAnalysisResult> {
    const userMessage = buildTimelineRebuildAnalysisPrompt(input)
    const session = await this.context.createSession({
      systemPrompt: [
        '你是小说时间线重建分析器。',
        '仅从提供的正文、章前快照、已完成步骤摘要和本章标记 stale 的派生状态推断本章状态变化。',
        '不要创作正文，不要使用未提供的后续章节事实，不要输出参考文本或完整提示词。',
        '若旧的派生事实与新正文矛盾，必须在 proposedChanges.storyEvents 中给出重放后的剧情事件。',
        '输出严格 JSON：{"summary":"...","proposedChanges":{"storyEvents":[{"type":"custom","title":"...","summary":"...","outcome":"..."}]}}。',
      ].join('\n'),
      userMessage,
      tools: [],
      responseFormat: 'json',
      timeoutMs: 300_000,
      ...(input.modelId ? { modelId: input.modelId } : {}),
      signal: input.signal,
    })
    try {
      const raw = await session.promptStream(() => {})
      const parsed = parseAnalysis(raw)
      return {
        summary: parsed.summary,
        proposedChanges: parsed.proposedChanges,
        inputHash: hash(userMessage),
        baseSnapshotHash: input.baseSnapshotHash,
      }
    } finally {
      session.dispose()
    }
  }
}

type TimelineRebuildAnalysisModel = NonNullable<Parameters<PluginContext['createSession']>[0]['modelId']>

export function buildTimelineRebuildAnalysisPrompt(input: {
  chapterNumber: number
  content: string
  contentRevisionId: string
  baseSnapshotData: string
  staleDerivedSummary: string
  priorAnalyses: Array<{ chapterNumber: number; summary: string }>
}): string {
  const prior = input.priorAnalyses.length === 0
    ? '无。'
    : input.priorAnalyses.map(item => `- 第 ${item.chapterNumber} 章：${item.summary}`).join('\n')
  return [
    `重建第 ${input.chapterNumber} 章，锁定正文版本：${input.contentRevisionId}。`,
    '## 重建起始章前的全量状态快照',
    input.baseSnapshotData,
    '## 本次重建中已完成章节的摘要',
    prior,
    '## 本章当前派生状态（已标记 stale，等待重放校验）',
    input.staleDerivedSummary,
    '## 当前章节正文',
    input.content,
  ].join('\n\n')
}

function parseAnalysis(raw: string): { summary: string; proposedChanges: unknown } {
  const parsed = JSON.parse(raw) as { summary?: unknown; proposedChanges?: unknown }
  const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
    ? parsed.summary.trim().slice(0, 2000)
    : '隔离重放分析完成，等待审核应用'
  const proposedChanges = parsed.proposedChanges && typeof parsed.proposedChanges === 'object' && !Array.isArray(parsed.proposedChanges)
    ? parsed.proposedChanges
    : {}
  return { summary, proposedChanges }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
