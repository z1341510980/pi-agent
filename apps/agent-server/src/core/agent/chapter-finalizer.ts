/**
 * ChapterFinalizer：章节收尾逻辑
 *
 * 从 NovelOrchestrator 抽取的收尾阶段逻辑，包含：
 * - Memory Agent 调用（状态变更提取）
 * - 实体状态捕获 + 记忆事件记录
 * - 启发式因果链连边
 * - 章节维度同步
 * - 章节快照保存
 * - 章节内容持久化（清洗思考前缀 + 标题/提要生成）
 *
 * workflow 模式（NovelOrchestrator）和群聊模式（NovelDiscussionRunner）
 * 共用同一套收尾逻辑，避免两处实现漂移。
 */

import type { NovelStore } from '../../plugins/novel-plugin/core/novel-store.js'
import type { NovelPromptBuilder } from '../../plugins/novel-plugin/core/prompt-builder.js'
import type { NovelEngine } from '../../plugins/novel-plugin/core/novel-engine.js'
import type { PluginContext } from '../plugin/plugin-types.js'
import { NovelMemoryStore, type MemoryEvent } from '../../plugins/novel-plugin/core/novel-memory-store.js'
import type { NovelMemoryGenerator, MemoryGenerationResult } from '../../plugins/novel-plugin/core/novel-memory-generator.js'
import {
  classifyLlmFailure,
  retryDelayMs,
} from '../../plugins/novel-plugin/core/llm-error-policy.js'

/**
 * 结构化记忆提取的重试次数。
 *
 * **刻意只重试 1 次，不用 llm-error-policy 的 LLM_MAX_RETRIES(3)。**
 * 因为回退路径（工具循环）本身走 orchestrator.runAgent，那里已经有一整套 3 次
 * 退避重试。在这里再排一个 1s→4s→12s 的阶梯，等于把同一次瞬时故障的等待时间
 * 翻倍（最坏 +17s）却没有新增成功概率。
 *
 * 一次 1 秒的重试足以吃掉常见的渠道抖动；真的持续不可用就交给回退路径，
 * 它比结构化调用贵，但有工具兜底。
 */
const MEMORY_STRUCTURED_RETRIES = 1
type MemoryMeasuredAttempt = {
  operation: 'memory' | 'retry' | 'calibration' | 'fallback'
  result: MemoryGenerationResult
  durationMs: number
}

type DeferredMemoryCommit = {
  summary: string
  apply: (() => MemoryGenerationResult) | null
}

function failedMemoryResult(summary: string, error: string): MemoryGenerationResult {
  return {
    status: 'error', summary, error,
    stats: {
      characterUpdatesApplied: 0, characterCreatesApplied: 0, characterCreatesDeduped: 0,
      foreshadowUpdatesApplied: 0, foreshadowCreatesApplied: 0,
      clueUpdatesApplied: 0, clueCreatesApplied: 0,
      conflictUpdatesApplied: 0, conflictCreatesApplied: 0,
      factionUpdatesApplied: 0, locationUpdatesApplied: 0,
      relationshipUpdatesApplied: 0, relationshipCreatesApplied: 0,
      itemUpdatesApplied: 0, itemCreatesApplied: 0,
      hookUpdatesApplied: 0, arcStageChangesApplied: 0, narrativeCreatesApplied: 0, narrativeUpdatesApplied: 0, storylineProgressesApplied: 0, candidateCreatesApplied: 0, total: 0,
    },
  }
}
import type { NarrativeTask, ArrangedEntity, NovelConflict, NovelForeshadow, NovelCharacterHistory, NovelFaction, NovelLocation, NovelItem, ChapterSpan, VersionSource } from '../../plugins/novel-plugin/core/types.js'
import type { NovelAgentType, CreationPhase, CreationFlowEvent } from '../../plugins/novel-plugin/core/novel-agents.js'
import type { CreationResult } from '@repo/shared/novel'
import type { AgUiEventSink } from '@repo/protocol/events'
import {
  hasLlmUsage,
  type LlmUsageSnapshot,
} from '../../plugins/novel-plugin/core/agent-run-utils.js'

/**
 * 合并章节号到跨度数组：连续则扩展尾段，否则追加新段；保持 spans 有序。
 * - 空数组 → [[chapter, chapter]]
 * - 尾段 end+1 === chapter → 扩展尾段 end 为 chapter
 * - chapter 已被尾段覆盖（chapter <= lastEnd）→ 不变（去重）
 * - 否则 → 追加 [chapter, chapter]
 * 返回新数组，不修改入参。
 */
function appendChapterToSpans(spans: ChapterSpan[], chapter: number): ChapterSpan[] {
  if (spans.length === 0) {
    return [[chapter, chapter]]
  }
  const next = spans.map((s) => [s[0], s[1]] as ChapterSpan)
  const last = next[next.length - 1]
  if (chapter <= last[1]) {
    return next
  }
  if (last[1] + 1 === chapter) {
    last[1] = chapter
    return next
  }
  next.push([chapter, chapter])
  return next
}

export interface CreationOptions {
  /** AG-UI 事件发射器（与 chat 共用同一类型），供 StreamEmitter 发射标准 AG-UI 事件 */
  emit: AgUiEventSink
  onCheckpoint: (checkpoint: import('../../plugins/novel-plugin/core/novel-agents.js').CheckpointData) => Promise<'approve' | 'reject' | 'revise' | 'rewrite'>
  onProgress: (event: CreationFlowEvent) => void
  /** 持久化创作流程中的可见消息；由路由层绑定 ChapterChatStore */
  onConversationMessage?: (message: {
    role: 'agent' | 'system'
    fromId: string
    fromName: string
    content: string
    phase: 'pre_creation' | 'checkpoint' | 'discussion' | 'review'
    metadata?: Record<string, unknown>
  }) => void
  signal?: AbortSignal
  /** 本章已编排实体约束（模式1手动编排 / 模式2 AI编排产出），注入 SEMI 层 */
  arrangedEntities?: ArrangedEntity
  /**
   * per-call 模型覆盖（输入框旁选择器传入）：优先级高于项目主模型与 AgentPage 配置。
   * 传入后本流程所有 Agent 统一使用该 provider+model（保证缓存命中），
   * 用于"本次创作临时切换模型"。
   */
  modelId?: { provider: string; modelId: string }
  /**
   * 本次 Agent 可使用的章节上下文 token 预算（不含动态任务、工具 schema 与输出预留）。
   * 未提供时保持既有行为；由调用方在已知模型窗口时显式传入。
   */
  contextBudgetTokens?: number
}

/** CreationResult 已迁入 @repo/shared/novel 共享包，此处通过顶部 import 引入 */
export type { CreationResult }

/**
 * finalize() 的入参，承载创作流程产出的上下文。
 *
 * - content：Writer/Reviser 产出的最终正文（清洗前）
 * - options：事件发射 + 检查点 + signal
 * - arrangedEntities：本章编排实体（用于 syncChapterDimensions）
 * - directorTask：Director 解析的结构化任务（用于持久化 timeOffset / chapterEndingHook）
 * - chapterId：章节记录 ID（null 时跳过 updateChapter / 标题 / 提要）
 */
export interface FinalizeParams {
  projectId: string
  chapterNumber: number
  content: string
  options: CreationOptions
  arrangedEntities?: ArrangedEntity
  directorTask?: NarrativeTask
  chapterId: string | null
  /** 版本来源元数据，由调用方传入，落库时透传给 store.updateChapter 拦截存档 */
  versionSource?: VersionSource
}

/**
 * runAgent 回调类型，供 runMemoryAgent 在 memoryGenerator 未注入时回退到工具循环模式。
 *
 * NovelOrchestrator 把自身的 runAgent 方法绑定后传入；
 * 群聊模式可传入自己的 runAgent 实现。
 */
export type RunAgentCallback = (
  agentType: NovelAgentType,
  projectId: string,
  chapterNumber: number,
  input: unknown,
  options: CreationOptions,
) => Promise<string>

export class ChapterFinalizer {
  /** 记忆 Agent 生成器（结构化 LLM 调用，替代原工具循环模式） */
  private readonly memoryGenerator?: NovelMemoryGenerator
  /** runAgent 回调（runMemoryAgent 在 memoryGenerator 未注入时回退使用） */
  private readonly runAgentFallback?: RunAgentCallback

  constructor(
    private store: NovelStore,
    private memoryStore: NovelMemoryStore,
    private promptBuilder: NovelPromptBuilder,
    private engine: NovelEngine,
    private context: PluginContext,
    memoryGenerator?: NovelMemoryGenerator,
    runAgentFallback?: RunAgentCallback,
  ) {
    this.memoryGenerator = memoryGenerator
    this.runAgentFallback = runAgentFallback
  }

  /**
   * 章节收尾：Memory 阶段 → 实体同步 → 快照 → 持久化 → 标题/提要。
   *
   * 对应 NovelOrchestrator.createChapterWithFlow 中从 Memory 阶段开始到方法结束的代码块。
   * 行为与原实现完全一致：清洗思考前缀后落库、生成标题候选和前情提要、推送 data_changed 事件。
   */
  async finalize(params: FinalizeParams): Promise<CreationResult> {
    const { projectId, chapterNumber, content, options, arrangedEntities, directorTask, chapterId } = params
    options.signal?.throwIfAborted()
    if (!chapterId) {
      throw new Error(`章节不存在或未绑定持久化记录: ${projectId}#${chapterNumber}`)
    }

    const cleanedContent = this.stripThinkingPrelude(content)
    if (cleanedContent !== content) {
      this.context.logger.info(
        { projectId, chapterNumber, originalLen: content.length, cleanedLen: cleanedContent.length },
        '已清洗 Writer 输出开头的思考前缀',
      )
    }

    // Phase 5: Memory
    // 重写中间章节时，全局实体状态已经包含后续章节结果。直接让 Memory 写入会把
    // 第 N 章的变化叠加到未来状态上，污染第 N+1 章之后的时间线。因此历史重写
    // 只保存正文，不修改全局实体状态；后续状态需要从该章起显式重建。
    const historicalRewrite = this.hasLaterCompletedChapter(projectId, chapterNumber)
    this.emitProgress(options, 'memory', 'phase_change', {
      message: historicalRewrite
        ? '检测到中间章节重写：为保护后续时间线，本次跳过全局状态写入'
        : '记忆 Agent 正在提取状态变更...',
    })
    const beforeState = this.captureEntityState(projectId)
    const deferredMemory = historicalRewrite
      ? {
          summary: '中间章节正文已更新；为避免污染后续章节，全局实体状态未自动改写',
          apply: null,
        }
      : await this.analyzeMemoryForFinalization(projectId, chapterNumber, cleanedContent, options)
    let memoryResult = deferredMemory.summary
    let memoryEvents: MemoryEvent[] = []

    // 正文、不可变 revision、Memory 实体、事件、章节维度和快照共享一个短事务。
    // LLM 分析已在事务外完成，避免网络调用长时间占用 SQLite 写锁。
    this.store.withTransaction(() => {
      this.store.completeChapterForReview(chapterId, {
        content: cleanedContent,
        wordCount: cleanedContent.length,
        positioning: directorTask?.positioning
          ?? this.store.getChapter(projectId, chapterNumber)?.positioning
          ?? null,
        timeOffset: directorTask?.timeOffset ?? null,
        chapterEndingHook: directorTask?.chapterEndingHook ?? null,
      }, params.versionSource)

      if (!historicalRewrite) {
        const applied = deferredMemory.apply?.()
        if (applied) memoryResult = applied.summary
        memoryEvents = this.recordMemoryEvents(projectId, chapterNumber, chapterId, beforeState)
        this.syncChapterDimensions(
          projectId,
          chapterNumber,
          chapterId,
          arrangedEntities,
          beforeState,
        )
        this.saveChapterSnapshot(projectId, chapterNumber)
      }
    })

    // 定期全量校准：LLM 分析在事务外，状态变更、审计事件、章节维度和最终快照
    // 在独立补偿事务中提交。章节正文已经完成核心提交，校准失败不会回滚正文。
    if (!historicalRewrite && chapterNumber > 0 && chapterNumber % 10 === 0 && this.memoryGenerator) {
      this.emitProgress(options, 'memory', 'phase_change', { message: '触发全量状态校准（每 10 章一次）...' })
      const calibrationStartedAt = Date.now()
      try {
        const calibrationAnalysis = await this.memoryGenerator.analyzeFullCalibration(
          projectId, chapterNumber,
          (event) => {
            this.emitProgress(options, 'memory', 'phase_change', {
              message: event.message,
              phase: event.phase,
              data: event.data,
            })
          },
          options.signal,
          options.modelId,
        )
        let calibrationResult = calibrationAnalysis
        if (calibrationAnalysis.status === 'success') {
          const beforeCalibration = this.captureEntityState(projectId)
          this.store.withTransaction(() => {
            calibrationResult = this.memoryGenerator!.applyAnalysis(
              projectId,
              chapterNumber,
              calibrationAnalysis,
            )
            this.recordMemoryEvents(projectId, chapterNumber, chapterId, beforeCalibration)
            this.syncChapterDimensions(
              projectId,
              chapterNumber,
              chapterId,
              arrangedEntities,
              beforeCalibration,
            )
            this.saveChapterSnapshot(projectId, chapterNumber)
          })
        }
        this.persistMemoryLogs(projectId, chapterNumber, [{
          operation: 'calibration',
          result: calibrationResult,
          durationMs: Date.now() - calibrationStartedAt,
        }], 'calibration')
        if (calibrationResult.stats.total > 0) {
          this.emitProgress(options, 'memory', 'data_changed', {
            agentType: 'memory',
            agentName: '记忆',
            message: `全量校准完成：补充 ${calibrationResult.stats.total} 项遗漏变更`,
            dataChanged: true,
            detail: {
              kind: 'calibration_result',
              summary: calibrationResult.summary,
              stats: calibrationResult.stats,
            },
          })
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        this.persistMemoryLogs(projectId, chapterNumber, [{
          operation: 'calibration',
          result: failedMemoryResult('全量校准失败', error),
          durationMs: Date.now() - calibrationStartedAt,
        }], 'calibration')
        if (options.signal?.aborted) throw err
        this.context.logger.error(
          { projectId, chapterNumber, err },
          '全量校准失败，不影响主流程',
        )
      }
    }

    // 推送数据变更通知：Memory Agent 已写入实体状态、快照已保存，
    // 前端收到后刷新画布（替代轮询）。同时携带提取摘要和变更明细供气泡展示。
    this.emitProgress(options, 'memory', 'data_changed', {
      agentType: 'memory',
      agentName: '记忆',
      message: historicalRewrite ? '中间章节已保存，后续状态保持不变' : '记忆提取完成',
      dataChanged: !historicalRewrite,
      detail: {
        kind: historicalRewrite ? 'historical_rewrite_protected' : 'memory_result',
        summary: memoryResult,
        events: memoryEvents.map(e => ({ type: e.eventType, description: e.description })),
      },
    })

    // 生成候选章节标题（3 个，供用户选择）+ 前情提要
    try {
      const [titleCandidates, recap] = await Promise.all([
        this.generateChapterTitles(projectId, chapterNumber, cleanedContent, options.signal, options.modelId),
        this.generateChapterRecap(projectId, chapterNumber, cleanedContent, options.signal, options.modelId),
      ])
      if (titleCandidates.length > 0 || recap) {
        this.emitProgress(options, 'completed', 'data_changed', {
          agentType: 'writer',
          agentName: '写作',
          message: '已生成候选标题' + (recap ? '和前情提要' : ''),
          dataChanged: false,
          detail: {
            kind: 'title_candidates',
            titles: titleCandidates,
            recap: recap || undefined,
          },
        })
      }
      if (recap) this.store.updateChapter(chapterId, { recap })
    } catch (err) {
      if (options.signal?.aborted) throw err
      this.context.logger.warn({ projectId, chapterNumber, err }, '标题/提要生成失败，不影响主流程')
    }

    this.emitProgress(options, 'completed', 'completed', { message: '章节创作完成' })

    return {
      status: 'completed',
      // 前端把 CreationResult.content 当作权威全文；必须与事务中实际提交的
      // 清洗后正文一致，避免 SSE 完成后编辑器与数据库内容跳变。
      content: cleanedContent,
      stateChanges: [
        { type: historicalRewrite ? 'historical_rewrite' : 'memory', description: memoryResult.slice(0, 200) },
        ...memoryEvents.map((e) => ({
          type: e.eventType,
          description: e.description,
        })),
      ],
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 长期记忆：实体状态捕获 + 记忆事件记录
  // ═══════════════════════════════════════════════════════════════

  /** 当前章之后是否已有正文；用于识别会影响既有时间线的中间章节重写。 */
  private hasLaterCompletedChapter(projectId: string, chapterNumber: number): boolean {
    return this.store.listChapters(projectId)
      .some(chapter => chapter.chapterNumber > chapterNumber && chapter.content?.trim().length > 0)
  }

  /** 分析 Memory 变更但延迟到 Finalizer 的短事务内应用。 */
  private async analyzeMemoryForFinalization(
    projectId: string,
    chapterNumber: number,
    chapterContent: string,
    options: CreationOptions,
  ): Promise<DeferredMemoryCommit> {
    const generator = this.memoryGenerator
    if (!generator?.analyze || !generator.applyAnalysis) {
      this.context.logger.warn(
        { projectId, chapterNumber },
        'Memory Generator 不支持两阶段提交，本章跳过状态写入以保证正文原子性',
      )
      return { summary: '记忆提取跳过：当前 Memory Generator 不支持原子提交', apply: null }
    }

    const startedAt = Date.now()
    const attempts: MemoryMeasuredAttempt[] = []
    const analyzeOnce = async (operation: 'memory' | 'retry'): Promise<MemoryGenerationResult> => {
      const attemptStartedAt = Date.now()
      try {
        const result = await generator.analyze(
          projectId,
          chapterNumber,
          chapterContent,
          event => this.emitProgress(options, 'memory', 'phase_change', {
            message: event.message,
            phase: event.phase,
            data: event.data,
          }),
          options.arrangedEntities,
          options.signal,
          options.modelId,
        )
        attempts.push({ operation, result, durationMs: Date.now() - attemptStartedAt })
        return result
      } catch (error) {
        if (options.signal?.aborted) throw error
        const message = error instanceof Error ? error.message : String(error)
        const result = failedMemoryResult('记忆提取失败，未应用状态变更', message)
        attempts.push({ operation, result, durationMs: Date.now() - attemptStartedAt })
        return result
      }
    }

    let result = await analyzeOnce('memory')
    if (result.status === 'error') {
      const classification = classifyLlmFailure(result.error ?? result.summary, options.signal?.aborted)
      const delay = classification.kind === 'transient' ? retryDelayMs(1) : null
      if (delay !== null) {
        await this.sleep(delay, options.signal)
        options.signal?.throwIfAborted()
        result = await analyzeOnce('retry')
      }
    }
    this.persistMemoryLogs(projectId, chapterNumber, attempts, 'memory', chapterContent)
    try {
      this.context.agentCallLogger?.record({
        agentId: 'novel-memory',
        agentName: '记忆',
        threadId: '',
        systemPrompt: result.logContext?.systemPrompt ?? '(结构化 LLM 调用 - role-memory-generator)',
        userMessage: result.logContext?.userMessage ?? `请从第 ${chapterNumber} 章中提取状态变更。`,
        taskInput: chapterContent.slice(0, 500),
        tools: '[]',
        toolNames: '[]',
        result: result.summary,
        resultLength: result.summary.length,
        durationMs: Date.now() - startedAt,
        status: result.status,
        error: result.error ?? '',
        metadata: JSON.stringify({
          projectId,
          chapterNumber,
          agentType: 'memory',
          phase: 'memory',
          displayAgentType: 'memory',
          displayAgentName: '记忆',
          source: 'novel-memory-generator-analyze',
        }),
      })
    } catch {
      // 通用日志失败不影响章节提交。
    }
    if (result.status === 'error') {
      const error = result.error ?? result.summary
      this.context.logger.error({ projectId, chapterNumber, error }, 'Memory 分析失败，正文将不带状态变更提交')
      options.onConversationMessage?.({
        role: 'system',
        fromId: 'system',
        fromName: '系统',
        content: `记忆提取失败：${error}`,
        phase: 'review',
        metadata: { agentType: 'memory', workflowMessageType: 'memory', failed: true },
      })
      return { summary: `记忆提取失败：${error}`, apply: null }
    }
    options.onConversationMessage?.({
      role: 'agent',
      fromId: 'novel-memory',
      fromName: '记忆',
      content: result.summary,
      phase: 'review',
      metadata: { agentType: 'memory', workflowMessageType: 'memory' },
    })
    return {
      summary: result.summary,
      apply: () => generator.applyAnalysis(projectId, chapterNumber, result),
    }
  }

  /**
   * 运行 Memory Agent
   *
   * 优先使用 NovelMemoryGenerator（结构化 LLM 调用，单次完成，~30s），
   * 回退到原 runAgent('memory', ...)（LLM 工具循环，300s 超时）。
   *
   * 回退场景：memoryGenerator 未注入（旧版本兼容或测试环境）。
   * 回退时仍走原工具循环模式，记录日志并保持流程完整。
   */
  async runMemoryAgent(
    projectId: string,
    chapterNumber: number,
    chapterContent: string,
    options: CreationOptions,
  ): Promise<string> {
    // 优先使用结构化 LLM 调用模式
    if (this.memoryGenerator) {
      const startTime = Date.now()
      const attempts: MemoryMeasuredAttempt[] = []
      let status: 'success' | 'error' = 'success'
      let errorMsg: string | undefined
      let resultSummary = ''
      try {
        const result = await this.memoryGenerator.generate(
          projectId, chapterNumber, chapterContent,
          (event) => {
            this.emitProgress(options, 'memory', 'phase_change', {
              message: event.message,
              phase: event.phase,
              data: event.data,
            })
          },
          options.arrangedEntities,
          options.signal,
          options.modelId,
        )
        attempts.push({ operation: 'memory', result, durationMs: Date.now() - startTime })
        resultSummary = result.summary
        if (result.status === 'error') {
          status = 'error'
          errorMsg = result.error ?? result.summary
        }
      } catch (err) {
        status = 'error'
        errorMsg = err instanceof Error ? err.message : String(err)
        attempts.push({
          operation: 'memory',
          result: failedMemoryResult('记忆提取失败，未应用状态变更', errorMsg),
          durationMs: Date.now() - startTime,
        })
        this.context.logger.error(
          { projectId, chapterNumber, err },
          'Memory Generator 调用失败，回退到空结果',
        )
        resultSummary = '记忆提取失败，未应用状态变更'
      } finally {
        // 同步写入通用 agent_call_logs
        if (this.context.agentCallLogger) {
          try {
            this.context.agentCallLogger.record({
              agentId: 'novel-memory',
              agentName: '记忆',
              threadId: '',
              systemPrompt: '(结构化 LLM 调用 - role-memory-generator)',
              userMessage: `请从第 ${chapterNumber} 章中提取状态变更。`,
              taskInput: chapterContent.slice(0, 500),
              tools: '[]',
              toolNames: '[]',
              result: resultSummary,
              resultLength: resultSummary.length,
              durationMs: Date.now() - startTime,
              status: status === 'success' ? 'success' : 'error',
              error: errorMsg ?? '',
              metadata: JSON.stringify({
                projectId,
                chapterNumber,
                agentType: 'memory',
                phase: 'memory',
                displayAgentType: 'memory',
                displayAgentName: '记忆',
                source: 'novel-memory-generator',
              }),
            })
          } catch {
            // 通用日志写入失败不影响主流程
          }
        }
      }

      if (status === 'success') {
        this.persistMemoryLogs(projectId, chapterNumber, attempts, 'memory', chapterContent)
        options.onConversationMessage?.({
          role: 'agent',
          fromId: 'novel-memory',
          fromName: '记忆',
          content: resultSummary,
          phase: 'review',
          metadata: { agentType: 'memory', workflowMessageType: 'memory' },
        })
        return resultSummary
      }

      const structuredError = errorMsg ?? '未知错误'

      /**
       * 瞬时故障先重试结构化提取，不要立刻换成工具循环。
       *
       * 实测过一次：generator 撞上 `503 No available channel`，立刻回退到 18 个
       * 记忆工具的循环模式 —— 那条路一次要 4 轮往返、78k 字符的工具 schema，
       * 比结构化调用贵一个量级，而 503 本身重试一次很可能就过了。
       *
       * 分类与退避沿用 llm-error-policy（不另写一套阈值，避免两处漂移）：
       * 只有 transient 才重试，account / malformed_session / 用户取消都直接放弃。
       */
      const retried = await this.retryStructuredMemory(
        projectId, chapterNumber, chapterContent, options, structuredError, attempts,
      )
      if (retried !== null) {
        this.persistMemoryLogs(projectId, chapterNumber, attempts, 'memory', chapterContent)
        options.onConversationMessage?.({
          role: 'agent',
          fromId: 'novel-memory',
          fromName: '记忆',
          content: retried.summary,
          phase: 'review',
          metadata: { agentType: 'memory', workflowMessageType: 'memory', retried: true },
        })
        return retried.summary
      }

      this.emitProgress(options, 'memory', 'phase_change', {
        message: `结构化记忆提取失败：${structuredError}。正在切换工具模式重试...`,
        detail: { kind: 'memory_retry', reason: structuredError },
      })
      if (this.runAgentFallback) {
        try {
          const fallbackResult = await this.runAgentFallback('memory', projectId, chapterNumber, {
            // ⚠️ projectId 必须显式进入提示词。
            //
            // memory Agent 的 18 个写工具全部把 projectId 列为必填参数，而这条回退
            // 路径原来只传 { task, content } —— Agent 看不到 projectId，只能罢工，
            // 实测输出是「无法调用记忆工具：当前请求未提供 projectId」，白烧一次
            // 17k token 且一条状态变更都没写入。
            //
            // 这个缺陷平时藏着：只有结构化提取失败（如 503）才会走到这里。
            projectId,
            chapterNumber,
            task: `结构化记忆提取失败（${structuredError}）。请从第 ${chapterNumber} 章中提取状态变更，并调用记忆工具写入。所有工具的 projectId 参数请使用 "${projectId}"。`,
            content: chapterContent,
          }, options)
          attempts.push({
            operation: 'fallback',
            result: {
              ...failedMemoryResult(fallbackResult, ''),
              status: 'success',
              error: undefined,
            },
            // runAgentFallback already persists its measured tool-loop call.
            durationMs: 0,
          })
          this.persistMemoryLogs(projectId, chapterNumber, attempts, 'memory', chapterContent)
          options.onConversationMessage?.({
            role: 'agent',
            fromId: 'novel-memory',
            fromName: '记忆',
            content: fallbackResult,
            phase: 'review',
            metadata: { agentType: 'memory', workflowMessageType: 'memory', fallback: true },
          })
          return fallbackResult
        } catch (fallbackError) {
          if (options.signal?.aborted) throw fallbackError
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          resultSummary = `记忆提取失败：结构化模式 ${structuredError}；工具模式 ${fallbackMessage}`
          attempts.push({
            operation: 'fallback',
            result: failedMemoryResult(resultSummary, fallbackMessage),
            // runAgentFallback persists failed tool-loop measurements too.
            durationMs: 0,
          })
          this.context.logger.error(
            { projectId, chapterNumber, structuredError, fallbackError },
            'Memory Generator 与工具模式均失败',
          )
        }
      } else {
        resultSummary = `记忆提取失败：${structuredError}`
      }
      this.persistMemoryLogs(projectId, chapterNumber, attempts, 'memory', chapterContent)
      options.onConversationMessage?.({
        role: 'system',
        fromId: 'system',
        fromName: '系统',
        content: resultSummary,
        phase: 'review',
        metadata: { agentType: 'memory', workflowMessageType: 'memory', failed: true },
      })
      return resultSummary
    }

    // 回退：原 LLM 工具循环模式（仅当 memoryGenerator 未注入时）
    if (!this.runAgentFallback) {
      this.context.logger.warn(
        { projectId, chapterNumber },
        'memoryGenerator 和 runAgentFallback 均未注入，返回空记忆结果',
      )
      return '记忆提取跳过：未配置 memoryGenerator'
    }
    this.context.logger.warn(
      { projectId, chapterNumber },
      'memoryGenerator 未注入，回退到 LLM 工具循环模式（可能 300s 超时）',
    )
    return this.runAgentFallback('memory', projectId, chapterNumber, {
      // 同上：18 个记忆工具都要求 projectId 必填，不给它就调不动任何工具
      projectId,
      chapterNumber,
      task: `请从第 ${chapterNumber} 章中提取状态变更，并调用记忆工具写入。所有工具的 projectId 参数请使用 "${projectId}"。`,
      content: chapterContent,
    }, options)
  }

  /**
   * 结构化记忆提取的瞬时故障重试。
   *
   * 只在首次结构化提取失败后调用，成功返回摘要，放弃时返回 null（由调用方决定
   * 是否回退到工具循环）。
   *
   * 每次尝试保留完整 MemoryGenerationResult，由调用方统一写入父聚合日志和
   * session 级明细，避免重试成本从日志面板消失。
   */
  private async retryStructuredMemory(
    projectId: string,
    chapterNumber: number,
    chapterContent: string,
    options: CreationOptions,
    firstError: string,
    attempts: MemoryMeasuredAttempt[],
  ): Promise<MemoryGenerationResult | null> {
    if (!this.memoryGenerator) return null

    let lastError = firstError
    for (let attempt = 1; attempt <= MEMORY_STRUCTURED_RETRIES; attempt++) {
      if (options.signal?.aborted) return null

      const classification = classifyLlmFailure(lastError, options.signal?.aborted)
      if (classification.kind !== 'transient') {
        this.context.logger.info(
          { projectId, chapterNumber, kind: classification.kind, lastError },
          '结构化记忆提取失败且不可重试，交由调用方决定后续',
        )
        return null
      }

      const delay = retryDelayMs(attempt)
      if (delay === null) return null

      this.emitProgress(options, 'memory', 'phase_change', {
        message: `记忆提取遇到瞬时故障，${Math.round(delay / 1000)} 秒后重试（${attempt}/${MEMORY_STRUCTURED_RETRIES}）...`,
        detail: { kind: 'memory_retry_transient', attempt, reason: lastError },
      })
      await this.sleep(delay, options.signal)
      if (options.signal?.aborted) return null

      const attemptStartedAt = Date.now()
      try {
        const result = await this.memoryGenerator.generate(
          projectId, chapterNumber, chapterContent,
          (event) => {
            this.emitProgress(options, 'memory', 'phase_change', {
              message: event.message,
              phase: event.phase,
              data: event.data,
            })
          },
          options.arrangedEntities,
          options.signal,
          options.modelId,
        )
        attempts.push({ operation: 'retry', result, durationMs: Date.now() - attemptStartedAt })
        if (result.status !== 'error') {
          this.context.logger.info(
            { projectId, chapterNumber, attempt },
            '结构化记忆提取重试成功',
          )
          return result
        }
        lastError = result.error ?? result.summary
      } catch (err) {
        if (options.signal?.aborted) return null
        lastError = err instanceof Error ? err.message : String(err)
        attempts.push({
          operation: 'retry',
          result: failedMemoryResult('记忆提取重试失败', lastError),
          durationMs: Date.now() - attemptStartedAt,
        })
      }
    }

    this.context.logger.warn(
      { projectId, chapterNumber, lastError },
      `结构化记忆提取重试 ${MEMORY_STRUCTURED_RETRIES} 次仍失败，交回退路径处理`,
    )
    return null
  }

  private persistMemoryLogs(
    projectId: string,
    chapterNumber: number,
    attempts: MemoryMeasuredAttempt[],
    aggregateOperation: 'memory' | 'calibration',
    taskInput = '',
  ): void {
    if (attempts.length === 0) return
    try {
      const measured = attempts.map((attempt) => {
        const context = attempt.result.logContext
        const usage = this.readUsageForSession(context?.sessionId)
        return { attempt, context, usage }
      })
      const aggregatePayload = measured.reduce((sum, item) => {
        const stats = item.context?.payloadStats
        if (!stats) return sum
        sum.messagesChars += stats.messagesChars
        sum.toolsChars += stats.toolsChars
        sum.toolCount = Math.max(sum.toolCount, stats.toolCount)
        sum.totalChars += stats.totalChars
        sum.roundTrips += stats.roundTrips
        return sum
      }, { messagesChars: 0, toolsChars: 0, toolCount: 0, totalChars: 0, roundTrips: 0 })
      const aggregateUsage = measured.reduce((sum, item) => {
        const usage = item.usage
        if (!usage) return sum
        sum.inputTokens += usage.inputTokens
        sum.outputTokens += usage.outputTokens
        sum.cacheReadTokens += usage.cacheReadTokens
        sum.cacheWriteTokens += usage.cacheWriteTokens
        sum.llmProvider = usage.llmProvider || sum.llmProvider
        sum.llmModel = usage.llmModel || sum.llmModel
        return sum
      }, {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        llmProvider: '', llmModel: '',
      })
      const finalAttempt = attempts[attempts.length - 1]
      const firstContext = attempts[0].result.logContext
      const parent = this.store.insertAgentLog({
        projectId, chapterNumber,
        agentType: 'memory', agentName: '记忆', displayAgentType: 'memory', displayAgentName: '记忆',
        phase: 'memory', systemPrompt: firstContext?.systemPrompt ?? '', chapterContext: '',
        userMessage: firstContext?.userMessage ?? '', taskInput, userInstructions: [], tools: [], toolNames: [],
        result: finalAttempt.result.summary, resultLength: finalAttempt.result.summary.length,
        durationMs: attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0),
        status: finalAttempt.result.status, error: finalAttempt.result.error ?? '',
        sessionId: firstContext?.sessionId ?? '', parentLogId: null, operation: aggregateOperation,
        ...aggregateUsage,
        payloadMessagesChars: aggregatePayload.messagesChars,
        payloadToolsChars: aggregatePayload.toolsChars,
        payloadToolCount: aggregatePayload.toolCount,
        payloadTotalChars: aggregatePayload.totalChars,
        llmRoundTrips: aggregatePayload.roundTrips,
        askStoryPolicy: 'legacy', askStoryEnabled: false,
      })
      for (const { attempt, context, usage } of measured) {
        const stats = context?.payloadStats
        this.store.insertAgentLog({
          projectId, chapterNumber,
          agentType: 'memory-detail', agentName: '记忆明细',
          displayAgentType: 'memory', displayAgentName: '记忆', phase: 'memory',
          systemPrompt: context?.systemPrompt ?? '', chapterContext: '', userMessage: context?.userMessage ?? '',
          taskInput, userInstructions: [], tools: [], toolNames: [], result: attempt.result.summary,
          resultLength: attempt.result.summary.length, durationMs: attempt.durationMs,
          status: attempt.result.status, error: attempt.result.error ?? '', sessionId: context?.sessionId ?? '',
          parentLogId: parent.id, operation: attempt.operation,
          inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
          cacheReadTokens: usage?.cacheReadTokens ?? 0, cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
          llmProvider: usage?.llmProvider ?? '', llmModel: usage?.llmModel ?? '',
          payloadMessagesChars: stats?.messagesChars ?? 0, payloadToolsChars: stats?.toolsChars ?? 0,
          payloadToolCount: stats?.toolCount ?? 0, payloadTotalChars: stats?.totalChars ?? 0,
          llmRoundTrips: stats?.roundTrips ?? 0,
          askStoryPolicy: 'legacy', askStoryEnabled: false,
        })
      }
    } catch (err) {
      this.context.logger.warn({ projectId, chapterNumber, err }, 'Memory AgentLog 写入失败')
    }
  }

  /** 可被 abort 提前唤醒的等待（与 orchestrator 的实现保持一致） */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = (): void => {
        clearTimeout(timer)
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * 捕获项目当前实体状态（角色 / 冲突 / 伏笔 / 势力 / 地点 / 关系）
   * 返回按实体 ID 索引的 Map，用于 Memory Agent 执行前后差异比较
   *
   * 关系层（四层逻辑②）跟踪字段：
   * - currentStage / dynamicRole / alignment / trend / chapterHint / lastUpdatedChapter
   * - 任意字段变化都会触发 relationship_change 记忆事件
   *
   * 影响层（四层逻辑④）跟踪字段：
   * - character.participatingConflicts（由冲突 CRUD 自动同步的反向索引）
   * - 变化时记录"角色参与冲突变更"事件，让用户知道哪些冲突线被接入/切断
   */
  captureEntityState(projectId: string): {
    characters: Map<string, { name: string; currentState: string; currentGoal: string; currentPressure: string; secret: string; arcStage: string; longTermDesire: string; removalImpact: string; participatingConflicts: string[] }>
    conflicts: Map<string, { description: string; stage: string; intensity: number; plotFunction: string | undefined; progressionMode: string | undefined }>
    foreshadowing: Map<string, { description: string; status: string; firstChapter: number | null; lastChapter: number | null; plantMethod: string | undefined; recoverMethod: string | undefined; linkedInfoLayers: string[] }>
    clues: Map<string, { description: string; pointsTo: string; progress: number; currentStep: string; nextStep: string; isMisleading: boolean; chapterSpans: ChapterSpan[] }>
    factions: Map<string, { name: string; status: string; strength: string }>
    locations: Map<string, { name: string; status: string; appearChapters: number[] }>
    items: Map<string, { name: string; holder: string | null; status: string }>
    narratives: Map<string, { description: string; status: string; type: string }>
    worldElements: Map<string, { name: string; category: string }>
    relationships: Map<string, { characterA: string; characterB: string; relationType: string; currentStage: string; dynamicRole: string; alignment: string; trend: string; chapterHint: string; lastUpdatedChapter: number | null }>
    infoLayers: Map<string, { infoDescription: string; readerKnows: boolean; isRevealed: boolean; revealChapter: number | null; linkedForeshadows: string[] }>
  } {
    const characters = new Map(
      this.store.listCharacters(projectId).map((c) => [
        c.id,
        {
          name: c.name,
          currentState: c.currentState,
          currentGoal: c.currentGoal,
          currentPressure: c.currentPressure,
          secret: c.secret,
          arcStage: c.arcStage,
          longTermDesire: c.longTermDesire,
          removalImpact: c.removalImpact,
          // 关联关系走 novel_edges 表：character 作为 source 指向 conflict
          participatingConflicts: this.store.listEdgesByEntity(c.id, { edgeType: 'related' })
            .filter(e => e.sourceType === 'character' && e.targetType === 'conflict' && e.sourceId === c.id)
            .map(e => e.targetId),
        },
      ]),
    )
    const conflicts = new Map(
      this.store.listConflicts(projectId).map((c) => [
        c.id,
        {
          description: c.description,
          stage: c.stage,
          intensity: c.intensity,
          plotFunction: c.plotFunction,
          progressionMode: c.progressionMode,
        },
      ]),
    )
    const foreshadowing = new Map(
      this.store.listForeshadowing(projectId).map((f) => [
        f.id,
        {
          description: f.description,
          status: f.status,
          firstChapter: f.firstChapter,
          lastChapter: f.lastChapter,
          plantMethod: f.plantMethod,
          recoverMethod: f.recoverMethod,
          // P3-2：跟踪 linkedInfoLayers 变化（用于 Rule 4 关联 info_layer_change）
          // 关联关系走 novel_edges 表：foreshadow 作为 source 指向 info_layer
          linkedInfoLayers: this.store.listEdgesByEntity(f.id, { edgeType: 'related' })
            .filter(e => e.sourceType === 'foreshadow' && e.targetType === 'info_layer' && e.sourceId === f.id)
            .map(e => e.targetId),
        },
      ]),
    )
    const clues = new Map(
      this.store.listClues(projectId).map((clue) => [
        clue.id,
        {
          description: clue.description,
          pointsTo: clue.pointsTo,
          progress: clue.progress,
          currentStep: clue.currentStep,
          nextStep: clue.nextStep,
          isMisleading: clue.isMisleading,
          chapterSpans: clue.chapterSpans.map((span) => [...span] as ChapterSpan),
        },
      ]),
    )
    const factions = new Map(
      this.store.listFactions(projectId).map((f) => [
        f.id,
        { name: f.name, status: f.status, strength: f.strength },
      ]),
    )
    const locations = new Map(
      this.store.listLocations(projectId).map((l) => [
        l.id,
        { name: l.name, status: l.status, appearChapters: l.appearChapters ? [...l.appearChapters] : [] },
      ]),
    )
    const items = new Map(
      this.store.listItems(projectId).map((item) => [
        item.id,
        { name: item.name, holder: item.ownerId, status: item.status },
      ]),
    )
    const worldElements = new Map(
      this.store.listWorldElements(projectId).map((element) => [
        element.id,
        { name: element.name, category: element.category },
      ]),
    )
    const relationships = new Map(
      this.store.listRelationships(projectId).map((r) => [
        r.id,
        {
          characterA: r.characterA,
          characterB: r.characterB,
          relationType: r.relationType,
          currentStage: r.currentStage,
          dynamicRole: r.dynamicRole,
          alignment: r.alignment,
          trend: r.trend,
          chapterHint: r.chapterHint,
          lastUpdatedChapter: r.lastUpdatedChapter,
        },
      ]),
    )
    // P3-2：捕获信息差状态用于差异比较
    const infoLayers = new Map(
      this.store.listInformationLayers(projectId).map((l) => [
        l.id,
        {
          infoDescription: l.infoDescription,
          readerKnows: l.readerKnows,
          isRevealed: l.isRevealed,
          revealChapter: l.revealChapter,
          // 关联关系走 novel_edges 表：info_layer 作为 target，foreshadow 作为 source
          linkedForeshadows: this.store.listEdgesByEntity(l.id, { edgeType: 'related' })
            .filter(e => e.sourceType === 'foreshadow' && e.targetType === 'info_layer' && e.targetId === l.id)
            .map(e => e.sourceId),
        },
      ]),
    )
    // P3-2 续：narrative 是独立剧情线，Memory 创建后同样进 appearance 双写。
    const narratives = new Map(
      this.store.listNarratives(projectId).map((n) => [
        n.id,
        {
          description: n.description,
          status: n.status,
          type: n.type,
        },
      ]),
    )
    return { characters, conflicts, foreshadowing, clues, factions, locations, items, narratives, worldElements, relationships, infoLayers }
  }

  /** 容错解析 JSON: string[]，避免非 JSON / 旧数据格式导致 captureEntityState 抛错 */
  parseIdList(raw: string): string[] {
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }

  /**
   * 比较 Memory Agent 执行前后的实体状态，记录记忆事件
   * - 角色状态变更 → character_change 事件
   * - 冲突阶段变更 → conflict_change 事件
   * - 伏笔状态变更 → foreshadow_change 事件
   */
  recordMemoryEvents(
    projectId: string,
    chapterNumber: number,
    chapterId: string | null,
    before: ReturnType<ChapterFinalizer['captureEntityState']>,
  ): MemoryEvent[] {
    const events: MemoryEvent[] = []
    const after = this.captureEntityState(projectId)

    // ── 角色变更 ──
    const characterFields = ['currentState', 'currentGoal', 'currentPressure', 'secret', 'arcStage', 'longTermDesire', 'removalImpact'] as const
    for (const [id, afterChar] of after.characters) {
      const beforeChar = before.characters.get(id)
      if (!beforeChar) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'character_change',
          entityId: id, entityType: 'character',
          description: `角色创建: ${afterChar.name}`,
          oldValue: null,
          newValue: JSON.stringify({ name: afterChar.name, arcStage: afterChar.arcStage }),
          cause: null, effectIds: [], significance: 7,
        }))
        continue
      }
      for (const field of characterFields) {
        if (beforeChar[field] !== afterChar[field]) {
          events.push(this.memoryStore.recordEvent({
            projectId, chapterId, chapterNumber,
            eventType: 'character_change',
            entityId: id, entityType: 'character',
            description: `角色 ${afterChar.name} 的 ${field} 变更`,
            oldValue: JSON.stringify({ [field]: beforeChar[field] }),
            newValue: JSON.stringify({ [field]: afterChar[field] }),
            cause: null, effectIds: [], significance: 6,
          }))
        }
      }
      // ── 四层逻辑④：参与冲突线变更（角色端反向索引）──
      // 当 syncConflictParticipantsToCharacters 在 store 层自动同步时，
      // 这里捕获快照差异，让用户感知"角色接入了 X 冲突 / 切断了 Y 冲突"。
      const beforeConflicts = beforeChar.participatingConflicts
      const afterConflicts = afterChar.participatingConflicts
      const addedConflicts = afterConflicts.filter((cid) => !beforeConflicts.includes(cid))
      const removedConflicts = beforeConflicts.filter((cid) => !afterConflicts.includes(cid))
      if (addedConflicts.length > 0 || removedConflicts.length > 0) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'character_change',
          entityId: id, entityType: 'character',
          description: `角色 ${afterChar.name} 参与冲突变更（新增 ${addedConflicts.length} 条，切断 ${removedConflicts.length} 条）`,
          oldValue: JSON.stringify({ participatingConflicts: beforeConflicts }),
          newValue: JSON.stringify({ participatingConflicts: afterConflicts }),
          cause: null, effectIds: [], significance: 6,
        }))
      }
    }

    // ── 冲突变更 ──
    for (const [id, afterConflict] of after.conflicts) {
      const beforeConflict = before.conflicts.get(id)
      if (!beforeConflict) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'conflict_change',
          entityId: id, entityType: 'conflict',
          description: `冲突创建: ${afterConflict.description}`,
          oldValue: null,
          newValue: JSON.stringify({ stage: afterConflict.stage, intensity: afterConflict.intensity, plotFunction: afterConflict.plotFunction, progressionMode: afterConflict.progressionMode }),
          cause: null, effectIds: [], significance: 7,
        }))
        continue
      }
      if (beforeConflict.stage !== afterConflict.stage) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'conflict_change',
          entityId: id, entityType: 'conflict',
          description: `冲突阶段变更: ${afterConflict.description}（${beforeConflict.stage} → ${afterConflict.stage}）`,
          oldValue: JSON.stringify({ stage: beforeConflict.stage, intensity: beforeConflict.intensity }),
          newValue: JSON.stringify({ stage: afterConflict.stage, intensity: afterConflict.intensity }),
          cause: null, effectIds: [], significance: 7,
        }))
      } else if (beforeConflict.intensity !== afterConflict.intensity) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'conflict_change',
          entityId: id, entityType: 'conflict',
          description: `冲突强度变更: ${afterConflict.description}（${beforeConflict.intensity} → ${afterConflict.intensity}）`,
          oldValue: JSON.stringify({ intensity: beforeConflict.intensity }),
          newValue: JSON.stringify({ intensity: afterConflict.intensity }),
          cause: null, effectIds: [], significance: 5,
        }))
      }
      // ── P2-1：功能位变更事件 ──
      if (beforeConflict.plotFunction !== afterConflict.plotFunction) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'conflict_change',
          entityId: id, entityType: 'conflict',
          description: `冲突功能位变更: ${afterConflict.description}（${beforeConflict.plotFunction ?? '(未指定)'} → ${afterConflict.plotFunction ?? '(未指定)'}）`,
          oldValue: JSON.stringify({ plotFunction: beforeConflict.plotFunction }),
          newValue: JSON.stringify({ plotFunction: afterConflict.plotFunction }),
          cause: null, effectIds: [], significance: 6,
        }))
      }
      // ── P2-1：推进模式变更事件 ──
      if (beforeConflict.progressionMode !== afterConflict.progressionMode) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'conflict_change',
          entityId: id, entityType: 'conflict',
          description: `冲突推进模式变更: ${afterConflict.description}（${beforeConflict.progressionMode ?? 'linear'} → ${afterConflict.progressionMode ?? 'linear'}）`,
          oldValue: JSON.stringify({ progressionMode: beforeConflict.progressionMode }),
          newValue: JSON.stringify({ progressionMode: afterConflict.progressionMode }),
          cause: null, effectIds: [], significance: 6,
        }))
      }
    }

    // ── 伏笔变更 ──
    for (const [id, afterF] of after.foreshadowing) {
      const beforeF = before.foreshadowing.get(id)
      if (!beforeF) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'foreshadow_change',
          entityId: id, entityType: 'foreshadow',
          description: `伏笔创建: ${afterF.description}`,
          oldValue: null,
          newValue: JSON.stringify({ status: afterF.status, plantMethod: afterF.plantMethod, recoverMethod: afterF.recoverMethod }),
          cause: null, effectIds: [], significance: 7,
        }))
        continue
      }
      if (beforeF.status !== afterF.status) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'foreshadow_change',
          entityId: id, entityType: 'foreshadow',
          description: `伏笔状态变更: ${afterF.description}（${beforeF.status} → ${afterF.status}）`,
          oldValue: JSON.stringify({ status: beforeF.status }),
          newValue: JSON.stringify({ status: afterF.status }),
          cause: null, effectIds: [], significance: 6,
        }))
      }
      if (beforeF.lastChapter !== afterF.lastChapter) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'foreshadow_change',
          entityId: id, entityType: 'foreshadow',
          description: `伏笔回收章节更新: ${afterF.description}`,
          oldValue: JSON.stringify({ lastChapter: beforeF.lastChapter }),
          newValue: JSON.stringify({ lastChapter: afterF.lastChapter }),
          cause: null, effectIds: [], significance: 8,
        }))
      }
      // ── P2-2：埋设方式变更事件 ──
      if (beforeF.plantMethod !== afterF.plantMethod) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'foreshadow_change',
          entityId: id, entityType: 'foreshadow',
          description: `伏笔埋设方式变更: ${afterF.description}（${beforeF.plantMethod ?? '(未指定)'} → ${afterF.plantMethod ?? '(未指定)'}）`,
          oldValue: JSON.stringify({ plantMethod: beforeF.plantMethod }),
          newValue: JSON.stringify({ plantMethod: afterF.plantMethod }),
          cause: null, effectIds: [], significance: 5,
        }))
      }
      // ── P2-2：回收方式变更事件 ──
      if (beforeF.recoverMethod !== afterF.recoverMethod) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'foreshadow_change',
          entityId: id, entityType: 'foreshadow',
          description: `伏笔回收方式变更: ${afterF.description}（${beforeF.recoverMethod ?? '(未指定)'} → ${afterF.recoverMethod ?? '(未指定)'}）`,
          oldValue: JSON.stringify({ recoverMethod: beforeF.recoverMethod }),
          newValue: JSON.stringify({ recoverMethod: afterF.recoverMethod }),
          cause: null, effectIds: [], significance: 5,
        }))
      }
    }

    // ── 线索变更 ──
    for (const [id, afterClue] of after.clues) {
      const beforeClue = before.clues.get(id)
      if (!beforeClue) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'clue_change', entityId: id, entityType: 'clue',
          description: `线索创建: ${afterClue.description}`,
          oldValue: null, newValue: JSON.stringify(afterClue),
          cause: null, effectIds: [], significance: 6,
        }))
        continue
      }
      const trackedFields = ['pointsTo', 'progress', 'currentStep', 'nextStep', 'isMisleading'] as const
      const changed = trackedFields.filter((field) => beforeClue[field] !== afterClue[field])
      if (changed.length > 0) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'clue_change', entityId: id, entityType: 'clue',
          description: `线索推进: ${afterClue.description}（${changed.join('、')}）`,
          oldValue: JSON.stringify(beforeClue), newValue: JSON.stringify(afterClue),
          cause: null, effectIds: [], significance: 6,
        }))
      }
    }

    // ── 势力变更 ──
    for (const [id, afterFac] of after.factions) {
      const beforeFac = before.factions.get(id)
      if (!beforeFac) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'faction_change',
          entityId: id, entityType: 'faction',
          description: `势力创建: ${afterFac.name}`,
          oldValue: null,
          newValue: JSON.stringify({ name: afterFac.name, status: afterFac.status, strength: afterFac.strength }),
          cause: null, effectIds: [], significance: 7,
        }))
        continue
      }
      if (beforeFac.status !== afterFac.status) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'faction_change',
          entityId: id, entityType: 'faction',
          description: `势力状态变更: ${afterFac.name}（${beforeFac.status} → ${afterFac.status}）`,
          oldValue: JSON.stringify({ status: beforeFac.status }),
          newValue: JSON.stringify({ status: afterFac.status }),
          cause: null, effectIds: [], significance: 6,
        }))
      }
      if (beforeFac.strength !== afterFac.strength) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'faction_change',
          entityId: id, entityType: 'faction',
          description: `势力实力变更: ${afterFac.name}（${beforeFac.strength} → ${afterFac.strength}）`,
          oldValue: JSON.stringify({ strength: beforeFac.strength }),
          newValue: JSON.stringify({ strength: afterFac.strength }),
          cause: null, effectIds: [], significance: 6,
        }))
      }
    }

    // ── 地点变更 ──
    for (const [id, afterLoc] of after.locations) {
      const beforeLoc = before.locations.get(id)
      if (!beforeLoc) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'location_change',
          entityId: id, entityType: 'location',
          description: `地点创建: ${afterLoc.name}`,
          oldValue: null,
          newValue: JSON.stringify({ name: afterLoc.name, status: afterLoc.status }),
          cause: null, effectIds: [], significance: 6,
        }))
        continue
      }
      if (beforeLoc.status !== afterLoc.status) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'location_change',
          entityId: id, entityType: 'location',
          description: `地点状态变更: ${afterLoc.name}（${beforeLoc.status} → ${afterLoc.status}）`,
          oldValue: JSON.stringify({ status: beforeLoc.status }),
          newValue: JSON.stringify({ status: afterLoc.status }),
          cause: null, effectIds: [], significance: 5,
        }))
      }
      const beforeChs = beforeLoc.appearChapters
      const afterChs = afterLoc.appearChapters
      if (beforeChs.join(',') !== afterChs.join(',')) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'location_change',
          entityId: id, entityType: 'location',
          description: `地点出场章节更新: ${afterLoc.name}`,
          oldValue: JSON.stringify({ appearChapters: beforeChs }),
          newValue: JSON.stringify({ appearChapters: afterChs }),
          cause: null, effectIds: [], significance: 5,
        }))
      }
    }

    for (const [id, afterItem] of after.items) {
      const beforeItem = before.items.get(id)
      if (!beforeItem) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'item_change',
          entityId: id, entityType: 'item',
          description: `物品创建: ${afterItem.name}`,
          oldValue: null,
          newValue: JSON.stringify({ name: afterItem.name, holder: afterItem.holder, status: afterItem.status }),
          cause: null, effectIds: [], significance: 6,
        }))
        continue
      }
      if (beforeItem.holder !== afterItem.holder) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'item_change',
          entityId: id, entityType: 'item',
          description: `物品持有者变更: ${afterItem.name}`,
          oldValue: JSON.stringify({ holder: beforeItem.holder }),
          newValue: JSON.stringify({ holder: afterItem.holder }),
          cause: null, effectIds: [], significance: 6,
        }))
      }
      if (beforeItem.status !== afterItem.status) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'item_change',
          entityId: id, entityType: 'item',
          description: `物品状态变更: ${afterItem.name}（${beforeItem.status} → ${afterItem.status}）`,
          oldValue: JSON.stringify({ status: beforeItem.status }),
          newValue: JSON.stringify({ status: afterItem.status }),
          cause: null, effectIds: [], significance: 6,
        }))
      }
    }

    for (const [id, afterElement] of after.worldElements) {
      if (before.worldElements.has(id)) continue
      events.push(this.memoryStore.recordEvent({
        projectId, chapterId, chapterNumber,
        eventType: 'world_change',
        entityId: id, entityType: 'world_element',
        description: `世界要素创建: ${afterElement.name}`,
        oldValue: null,
        newValue: JSON.stringify({ name: afterElement.name, category: afterElement.category }),
        cause: null, effectIds: [], significance: 6,
      }))
    }

    // ── 关系变更（四层逻辑②关系层）──
    // currentStage / dynamicRole / alignment / trend / chapterHint / lastUpdatedChapter
    // 任一字段变化都生成 relationship_change 事件，让 Memory Agent 的关系更新可追溯。
    // 关系是小说动态骨架的核心，所以阶段/阵营/走向变更都用 significance 6+ 强提示。
    const relationshipFields = ['currentStage', 'dynamicRole', 'alignment', 'trend', 'chapterHint', 'lastUpdatedChapter'] as const
    for (const [id, afterRel] of after.relationships) {
      const beforeRel = before.relationships.get(id)
      if (!beforeRel) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'relationship_change',
          entityId: id, entityType: 'relationship',
          description: `关系创建: ${afterRel.characterA} ↔ ${afterRel.characterB}（${afterRel.relationType}）`,
          oldValue: null,
          newValue: JSON.stringify({
            relationType: afterRel.relationType,
            currentStage: afterRel.currentStage,
            alignment: afterRel.alignment,
            trend: afterRel.trend,
          }),
          cause: null, effectIds: [], significance: 7,
        }))
        continue
      }
      for (const field of relationshipFields) {
        if (beforeRel[field] !== afterRel[field]) {
          // 阶段变更最重要（剧情节点切换）；其他字段（功能位/阵营/走向）次之
          const significance = field === 'currentStage' ? 7 : 6
          events.push(this.memoryStore.recordEvent({
            projectId, chapterId, chapterNumber,
            eventType: 'relationship_change',
            entityId: id, entityType: 'relationship',
            description: `关系 ${afterRel.characterA} ↔ ${afterRel.characterB} 的 ${field} 变更`,
            oldValue: JSON.stringify({ [field]: beforeRel[field] }),
            newValue: JSON.stringify({ [field]: afterRel[field] }),
            cause: null, effectIds: [], significance,
          }))
        }
      }
    }

    // ── P3-2：信息差变更 ──
    // 监控 readerKnows / isRevealed / linkedForeshadows 三个关键维度：
    // - readerKnows: 读者认知翻转（从不知道到知道，是揭示性事件）
    // - isRevealed: 信息差正式揭露（与 revealChapter 配对）
    // - linkedForeshadows: 关联伏笔变化（手动 link/unlink 时触发）
    for (const [id, afterLayer] of after.infoLayers) {
      const beforeLayer = before.infoLayers.get(id)
      if (!beforeLayer) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'info_layer_change',
          entityId: id, entityType: 'info_layer',
          description: `信息差创建: ${afterLayer.infoDescription}`,
          oldValue: null,
          newValue: JSON.stringify({ readerKnows: afterLayer.readerKnows, isRevealed: afterLayer.isRevealed }),
          cause: null, effectIds: [], significance: 7,
        }))
        continue
      }
      if (beforeLayer.readerKnows !== afterLayer.readerKnows) {
        // 读者认知翻转是重大叙事节点（揭示性事件）
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'info_layer_change',
          entityId: id, entityType: 'info_layer',
          description: `信息差读者认知翻转: ${afterLayer.infoDescription}（读者未知 → 读者已知）`,
          oldValue: JSON.stringify({ readerKnows: beforeLayer.readerKnows }),
          newValue: JSON.stringify({ readerKnows: afterLayer.readerKnows }),
          cause: null, effectIds: [], significance: 8,
        }))
      }
      if (beforeLayer.isRevealed !== afterLayer.isRevealed) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'info_layer_change',
          entityId: id, entityType: 'info_layer',
          description: `信息差揭露状态变更: ${afterLayer.infoDescription}（${beforeLayer.isRevealed ? '已揭露' : '未揭露'} → ${afterLayer.isRevealed ? '已揭露' : '未揭露'}）`,
          oldValue: JSON.stringify({ isRevealed: beforeLayer.isRevealed }),
          newValue: JSON.stringify({ isRevealed: afterLayer.isRevealed }),
          cause: null, effectIds: [], significance: 7,
        }))
      }
      const beforeLinks = beforeLayer.linkedForeshadows
      const afterLinks = afterLayer.linkedForeshadows
      if (beforeLinks.join(',') !== afterLinks.join(',')) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'info_layer_change',
          entityId: id, entityType: 'info_layer',
          description: `信息差关联伏笔变更: ${afterLayer.infoDescription}（新增 ${afterLinks.filter(x => !beforeLinks.includes(x)).length} 条，解除 ${beforeLinks.filter(x => !afterLinks.includes(x)).length} 条）`,
          oldValue: JSON.stringify({ linkedForeshadows: beforeLinks }),
          newValue: JSON.stringify({ linkedForeshadows: afterLinks }),
          cause: null, effectIds: [], significance: 5,
        }))
      }
    }

    // ── P3-1：跨实体因果链启发式连边 ──
    // 在所有事件落库完成后，根据本章实体关联性自动建立 cause/effect 边。
    // 不依赖 LLM 主动推断，纯基于 events 数组内的实体引用关系回填。
    // linkCause 内部已处理"已有 cause 则跳过"，所以无需在外层去重。
    this.applyHeuristicCausalLinks(events, projectId)

    return events
  }

  /**
   * 启发式因果连边：根据本章 events 间的实体引用关系自动建立 cause/effect 边。
   *
   * 3 条规则（基于 docs/novel/character-conflict-foreshadow-analysis.md P3-1 定义）：
   *
   * 规则 1（角色→冲突）：
   *   角色 participatingConflicts 变更（参与冲突线接入或切断）
   *   → 该冲突在同章后续发生的 conflict_change 事件的 cause
   *   场景：角色被卷入冲突后，冲突立刻升级或爆发
   *
   * 规则 2（冲突→关系）：
   *   冲突 stage → erupting（爆发）
   *   → 同章涉及该冲突参与者的下一个 relationship_change 事件的 cause
   *   场景：冲突爆发导致参与者之间的关系失衡
   *
   * 规则 3（伏笔→角色）：
   *   伏笔 status → recovered（已回收）
   *   → 同章该伏笔 linkedCharacters 中角色的下一个 character_change 事件的 cause
   *   场景：伏笔回收揭示真相，改变角色认知/状态
   *
   * 每个 effect 事件只接受第一个匹配的 cause（首次写入后 linkCause 自动跳过后续）。
   */
  applyHeuristicCausalLinks(events: MemoryEvent[], projectId: string): void {
    if (events.length === 0) return

    // 预构建索引：按 entityId 分组本章事件，便于按实体查找后续事件
    const eventsByEntity = new Map<string, MemoryEvent[]>()
    for (const e of events) {
      const list = eventsByEntity.get(e.entityId)
      if (list) list.push(e)
      else eventsByEntity.set(e.entityId, [e])
    }

    // ── 规则 1：角色参与冲突变更 → 冲突的下一个 conflict_change 的 cause ──
    for (const e of events) {
      if (e.eventType !== 'character_change') continue
      if (!e.newValue) continue
      let parsed: { participatingConflicts?: unknown } = {}
      try { parsed = JSON.parse(e.newValue) } catch { continue }
      if (!Array.isArray(parsed.participatingConflicts) || parsed.participatingConflicts.length === 0) continue
      const conflictIds = parsed.participatingConflicts.filter((x): x is string => typeof x === 'string')
      if (conflictIds.length === 0) continue

      for (const conflictId of conflictIds) {
        // 找该冲突在同章后续发生的 conflict_change 事件（按 createdAt 升序）
        const conflictEvents = (eventsByEntity.get(conflictId) ?? [])
          .filter(ev => ev.eventType === 'conflict_change' && ev.createdAt >= e.createdAt)
          .sort((a, b) => a.createdAt - b.createdAt)
        if (conflictEvents.length === 0) continue
        // 只连第一个未带 cause 的 conflict_change
        this.memoryStore.linkCause(conflictEvents[0].id, e.id)
        break
      }
    }

    // ── 规则 2：冲突 stage=erupting → 涉及参与者的 relationship_change 的 cause ──
    for (const e of events) {
      if (e.eventType !== 'conflict_change') continue
      if (!e.newValue) continue
      let parsed: { stage?: unknown } = {}
      try { parsed = JSON.parse(e.newValue) } catch { continue }
      if (parsed.stage !== 'erupting') continue

      // 查询该冲突的 participants（captureEntityState 快照未含此字段，需查 store）
      const conflict = this.store.getConflict(e.entityId)
      if (!conflict) continue
      const participantIds = this.parseIdList(conflict.participants)
      if (participantIds.length === 0) continue

      // 找本章内涉及这些参与者的 relationship_change 事件（在冲突爆发之后发生）
      for (const relEvent of events) {
        if (relEvent.eventType !== 'relationship_change') continue
        if (relEvent.createdAt < e.createdAt) continue
        const rel = this.store.getRelationship(relEvent.entityId)
        if (!rel) continue
        // 关系涉及的角色是否是冲突的参与者（characterA/B 是角色 ID）
        const involves = participantIds.includes(rel.characterA) || participantIds.includes(rel.characterB)
        if (!involves) continue
        this.memoryStore.linkCause(relEvent.id, e.id)
        break // 该冲突只连第一个匹配的关系变更
      }
    }

    // ── 规则 3：伏笔 status=recovered → linkedCharacters 的 character_change 的 cause ──
    for (const e of events) {
      if (e.eventType !== 'foreshadow_change') continue
      if (!e.newValue) continue
      let parsed: { status?: unknown } = {}
      try { parsed = JSON.parse(e.newValue) } catch { continue }
      if (parsed.status !== 'recovered') continue

      // 关联关系走 novel_edges 表：foreshadow 作为 source 指向 character
      const linkedCharIds = this.store.listEdgesByEntity(e.entityId, { edgeType: 'related' })
        .filter(ed => ed.sourceType === 'foreshadow' && ed.targetType === 'character' && ed.sourceId === e.entityId)
        .map(ed => ed.targetId)
      if (linkedCharIds.length === 0) continue

      for (const charId of linkedCharIds) {
        // 找该角色在同章后续发生的 character_change 事件
        const charEvents = (eventsByEntity.get(charId) ?? [])
          .filter(ev => ev.eventType === 'character_change' && ev.createdAt >= e.createdAt)
          .sort((a, b) => a.createdAt - b.createdAt)
        if (charEvents.length === 0) continue
        this.memoryStore.linkCause(charEvents[0].id, e.id)
      }
    }

    // ── 规则 4（P3-2）：伏笔回收 → 关联信息差的 info_layer_change 的 cause ──
    // 场景：伏笔回收揭示真相，导致承载的信息差 readerKnows 翻转或 isRevealed=true
    // 实现：伏笔 status=recovered 时，找其 linkedInfoLayers 对应的 info_layer_change 事件
    for (const e of events) {
      if (e.eventType !== 'foreshadow_change') continue
      if (!e.newValue) continue
      let parsed: { status?: unknown } = {}
      try { parsed = JSON.parse(e.newValue) } catch { continue }
      if (parsed.status !== 'recovered') continue

      // 关联关系走 novel_edges 表：foreshadow 作为 source 指向 info_layer
      const linkedInfoLayerIds = this.store.listEdgesByEntity(e.entityId, { edgeType: 'related' })
        .filter(ed => ed.sourceType === 'foreshadow' && ed.targetType === 'info_layer' && ed.sourceId === e.entityId)
        .map(ed => ed.targetId)
      if (linkedInfoLayerIds.length === 0) continue

      for (const infoLayerId of linkedInfoLayerIds) {
        // 找该信息差在同章后续发生的 info_layer_change 事件（读者认知翻转或揭露状态变更）
        const infoEvents = (eventsByEntity.get(infoLayerId) ?? [])
          .filter(ev => ev.eventType === 'info_layer_change' && ev.createdAt >= e.createdAt)
          .sort((a, b) => a.createdAt - b.createdAt)
        if (infoEvents.length === 0) continue
        // 只连第一个匹配的 info_layer_change（最接近伏笔回收时刻的事件）
        this.memoryStore.linkCause(infoEvents[0].id, e.id)
      }
    }
  }

  /**
   * 同步本章涉及实体的章节维度字段（GAP A/B/C 统一修复）。
   *
   * 问题背景：
   * - Memory Agent 工具只改实体的「动态状态」（currentState/stage/intensity/status），
   *   不稳定写入「章节维度」字段（chapterSpans/firstChapter/lastChapter/characterHistory）。
   * - 矩阵视图依赖章节维度字段画跨度色带，导致 Memory 写完后矩阵图不变。
   *
   * 本方法在 Memory Agent 执行后统一补全，不依赖 LLM 是否传 chapterNumber：
   * - 角色：本章编排涉及角色 + Memory 新建角色，若无本章 character_history 记录则写入
   * - 冲突：本章编排涉及冲突 + Memory 新建冲突，合并本章号到 chapterSpans（连续扩展或新段追加）
   * - 伏笔：仅在尚未埋设时补一个 plant 事件；后续语义节点由 Memory Agent 明确记录
   * - 势力：同冲突（chapterSpans 合并）
   * - 地点：本章编排涉及地点 + Memory 新建地点，若 appearChapters 不含本章号则追加
   */
  syncChapterDimensions(
    projectId: string,
    chapterNumber: number,
    chapterId: string | null,
    arrangedEntities: ArrangedEntity | undefined,
    before: ReturnType<ChapterFinalizer['captureEntityState']>,
  ): void {
    // ── 角色：补全 character_history（本章出场记录）──
    // 涉及角色 = arrangedEntities.characterIds + Memory 新建角色（before.characters 没有的）
    const afterChars = this.store.listCharacters(projectId)
    const newCharacterIds = afterChars
      .filter((c) => !before.characters.has(c.id))
      .map((c) => c.id)
    const involvedCharacterIds = new Set<string>([
      ...(arrangedEntities?.characterIds ?? []),
      ...newCharacterIds,
    ])

    if (involvedCharacterIds.size > 0) {
      // 查询本章已有的 character_history，避免重复写入
      const existingHistory = this.store.listCharacterHistory(projectId)
      const existingInChapter = new Set(
        existingHistory
          .filter((h) => h.chapterNumber === chapterNumber)
          .map((h) => h.characterId),
      )
      const newEntries: Array<Omit<NovelCharacterHistory, 'id' | 'createdAt'>> = []
      for (const characterId of involvedCharacterIds) {
        if (existingInChapter.has(characterId)) continue
        const character = afterChars.find((c) => c.id === characterId)
        if (!character) continue
        newEntries.push({
          projectId,
          characterId,
          chapterId,
          chapterNumber,
          fieldName: 'currentState',
          oldValue: null,
          newValue: '本章出场',
          reason: 'orchestrator.syncChapterDimensions 自动补全',
        })
      }
      if (newEntries.length > 0) {
        this.store.batchCreateCharacterHistory(newEntries)
      }
    }

    // ── 冲突：补全 chapterSpans ──
    // 涉及冲突 = arrangedEntities.conflictIds + Memory 新建冲突
    const afterConflicts = this.store.listConflicts(projectId)
    const newConflictIds = afterConflicts
      .filter((c) => !before.conflicts.has(c.id))
      .map((c) => c.id)
    const involvedConflictIds = new Set<string>([
      ...(arrangedEntities?.conflictIds ?? []),
      ...newConflictIds,
    ])
    for (const conflictId of involvedConflictIds) {
      const conflict = afterConflicts.find((c) => c.id === conflictId)
      if (!conflict) continue
      const nextSpans = appendChapterToSpans(conflict.chapterSpans, chapterNumber)
      const patch: Partial<NovelConflict> = { chapterSpans: nextSpans }
      this.store.updateConflict(conflictId, patch)
    }

    // ── 伏笔：仅补全首次埋设，不把后续每章自动视为伏笔节点 ──
    // 涉及伏笔 = arrangedEntities.foreshadowIds + Memory 新建伏笔
    const afterForeshadows = this.store.listForeshadowing(projectId)
    const newForeshadowIds = afterForeshadows
      .filter((f) => !before.foreshadowing.has(f.id))
      .map((f) => f.id)
    const involvedForeshadowIds = new Set<string>([
      ...(arrangedEntities?.foreshadowIds ?? []),
      ...newForeshadowIds,
    ])
    for (const foreshadowId of involvedForeshadowIds) {
      const foreshadow = afterForeshadows.find((f) => f.id === foreshadowId)
      if (!foreshadow) continue
      const patch: Partial<NovelForeshadow> = { lastChapter: chapterNumber }
      const beats = foreshadow.beats ?? []
      if (!beats.some((beat) => beat.type === 'plant')) {
        patch.beats = [...beats, { chapter: chapterNumber, type: 'plant' }]
      }
      this.store.updateForeshadow(foreshadowId, patch)
    }

    // ── 线索：补全 chapterSpans ──
    const afterClues = this.store.listClues(projectId)
    const newClueIds = afterClues
      .filter((clue) => !before.clues.has(clue.id))
      .map((clue) => clue.id)
    const involvedClueIds = new Set<string>([
      ...(arrangedEntities?.clueIds ?? []),
      ...newClueIds,
    ])
    for (const clueId of involvedClueIds) {
      const clue = afterClues.find((item) => item.id === clueId)
      if (!clue) continue
      this.store.updateClue(clueId, {
        chapterSpans: appendChapterToSpans(clue.chapterSpans, chapterNumber),
      })
    }

    // ── 势力：补全 chapterSpans（同冲突逻辑）──
    // 涉及势力 = arrangedEntities.factionIds + Memory 新建势力
    const afterFactions = this.store.listFactions(projectId)
    const newFactionIds = afterFactions
      .filter((f) => !before.factions.has(f.id))
      .map((f) => f.id)
    const involvedFactionIds = new Set<string>([
      ...(arrangedEntities?.factionIds ?? []),
      ...newFactionIds,
    ])
    for (const factionId of involvedFactionIds) {
      const faction = afterFactions.find((f) => f.id === factionId)
      if (!faction) continue
      const nextSpans = appendChapterToSpans(faction.chapterSpans, chapterNumber)
      const patch: Partial<NovelFaction> = { chapterSpans: nextSpans }
      this.store.updateFaction(factionId, patch)
    }

    // ── 地点：补全 appearChapters（本章出场记录）──
    // 涉及地点 = arrangedEntities.locationIds + Memory 新建地点
    const afterLocations = this.store.listLocations(projectId)
    const newLocationIds = afterLocations
      .filter((l) => !before.locations.has(l.id))
      .map((l) => l.id)
    const involvedLocationIds = new Set<string>([
      ...(arrangedEntities?.locationIds ?? []),
      ...newLocationIds,
    ])
    for (const locationId of involvedLocationIds) {
      const location = afterLocations.find((l) => l.id === locationId)
      if (!location) continue
      const appears = location.appearChapters ?? []
      if (!appears.includes(chapterNumber)) {
        const next = Array.from(new Set([...appears, chapterNumber])).sort((a, b) => a - b)
        const patch: Partial<NovelLocation> = { appearChapters: next }
        if (location.firstChapter == null) {
          patch.firstChapter = chapterNumber
        }
        this.store.updateLocation(locationId, patch)
      }
    }

    // ── 物品：补全 chapterSpans（同势力逻辑）──
    // 涉及物品 = arrangedEntities.itemIds + Memory 新建物品
    // 此前 sync 漏 item，导致 AI 编排之外的 item 创建不写 appearance（对账 orphan）。
    const afterItems = this.store.listItems(projectId)
    const newItemIds = afterItems
      .filter((it) => !before.items.has(it.id))
      .map((it) => it.id)
    const involvedItemIds = new Set<string>([
      ...(arrangedEntities?.itemIds ?? []),
      ...newItemIds,
    ])
    for (const itemId of involvedItemIds) {
      const item = afterItems.find((it) => it.id === itemId)
      if (!item) continue
      const nextSpans = appendChapterToSpans(item.chapterSpans, chapterNumber)
      const patch: Partial<NovelItem> = { chapterSpans: nextSpans }
      this.store.updateItem(itemId, patch)
    }

    // ── 剧情线：补全 chapterSpans（同冲突逻辑）──
    // narrative 不在 AI 编排产出范围，但 Memory 创建/推进后会触发本章涉及。
    // 涉及 = before/after 差集（Memory 新建或 status/chapterSpans 变化的剧情线）。
    // 无 arrangedEntities.narrativeIds 字段——narrative 是宏观剧情轴，不由章节编排直接驱动。
    const afterNarratives = this.store.listNarratives(projectId)
    const newNarrativeIds = afterNarratives
      .filter((n) => !before.narratives.has(n.id))
      .map((n) => n.id)
    const involvedNarrativeIds = new Set<string>(newNarrativeIds)
    for (const narrativeId of involvedNarrativeIds) {
      const narrative = afterNarratives.find((n) => n.id === narrativeId)
      if (!narrative) continue
      const nextSpans = appendChapterToSpans(narrative.chapterSpans, chapterNumber)
      this.store.updateNarrative(narrativeId, { chapterSpans: nextSpans })
    }

    // ── P2：实体出场关系统一（appearanceV2Write 开启时双写，默认关 = 无副作用）──
    // 维度回填是出场关系的主收口：编排涉及 + Memory 新建 + 正文确认全部汇聚于此，
    // 在这里双写即可覆盖三入口。角色出场仍走 character_history，不重复记录。
    if (chapterId) {
      this.store.recordAppearancesIfEnabled({ projectId, chapterNumber, chapterId, entityType: 'conflict', entityIds: [...involvedConflictIds], source: 'sync' })
      this.store.recordAppearancesIfEnabled({ projectId, chapterNumber, chapterId, entityType: 'foreshadow', entityIds: [...involvedForeshadowIds], source: 'sync' })
      this.store.recordAppearancesIfEnabled({ projectId, chapterNumber, chapterId, entityType: 'clue', entityIds: [...involvedClueIds], source: 'sync' })
      this.store.recordAppearancesIfEnabled({ projectId, chapterNumber, chapterId, entityType: 'faction', entityIds: [...involvedFactionIds], source: 'sync' })
      this.store.recordAppearancesIfEnabled({ projectId, chapterNumber, chapterId, entityType: 'location', entityIds: [...involvedLocationIds], source: 'sync' })
      this.store.recordAppearancesIfEnabled({ projectId, chapterNumber, chapterId, entityType: 'item', entityIds: [...involvedItemIds], source: 'sync' })
      this.store.recordAppearancesIfEnabled({ projectId, chapterNumber, chapterId, entityType: 'narrative', entityIds: [...involvedNarrativeIds], source: 'sync' })
    }
  }

  /**
   * 保存章节完成时的全量状态快照（情景记忆）
   * 包含角色 / 冲突 / 伏笔 / 线索 / 势力 / 地点 / 关系的当前状态，供时间线查询
   */
  saveChapterSnapshot(projectId: string, chapterNumber: number): void {
    const data = {
      characters: this.store.listCharacters(projectId),
      conflicts: this.store.listConflicts(projectId),
      foreshadowing: this.store.listForeshadowing(projectId),
      clues: this.store.listClues(projectId),
      factions: this.store.listFactions(projectId),
      locations: this.store.listLocations(projectId),
      items: this.store.listItems(projectId),
      worldElements: this.store.listWorldElements(projectId),
      informationLayers: this.store.listInformationLayers(projectId),
      relationships: this.store.listRelationships(projectId),
      edges: this.store.listEdges(projectId),
    }
    this.memoryStore.replaceSnapshot({
      projectId,
      chapterNumber,
      snapshotType: 'full',
      entityId: null,
      snapshotData: JSON.stringify(data),
    })
  }

  /**
   * 清洗 LLM 输出开头的"思考前缀"。
   *
   * 问题：国内兼容网关背后的模型经常在正式输出前先输出一段思考旁白，
   * 例如 "看完了全部约束。第 2 章是一章突转……开始写作。\n---\n正式正文..."
   * 这段思考旁白会被原样存入 novel_chapters.content，污染最终章节正文。
   *
   * 清洗规则（保守，避免误伤合法正文）：
   * 1. 如果开头有 `智库...智库结束` 或 `思考...思考结束` 标签块，去掉整个块
   * 2. 如果开头 500 字符内有 "---" 或 "***" 分隔符（独占一行），取第一个分隔符之后的内容
   *    - 额外校验：分隔符之前内容不含至少 2 个句号结尾的句子，避免误伤合法用 --- 分段的正文
   * 3. 否则保持原样
   */
  stripThinkingPrelude(content: string): string {
    if (!content) return content
    const trimmed = content.trimStart()
    if (!trimmed) return content

    // 规则 1：智库块（兼容各种写法）
    const thinkBlockMatch = trimmed.match(/^智库[\s\S]*?智库结束\s*/)
    if (thinkBlockMatch) {
      const stripped = trimmed.slice(thinkBlockMatch[0].length)
      this.context.logger.debug(
        { originalLen: content.length, strippedLen: stripped.length },
        'stripThinkingPrelude: 移除智库块',
      )
      return stripped.trimStart()
    }

    // 规则 2：开头 500 字符内的 "---" 或 "***" 分隔符
    const head = trimmed.slice(0, 500)
    const separatorMatch = head.match(/^([\s\S]{0,400}?)\n\s*(?:---+|\*\*+)\s*\n/)
    if (separatorMatch) {
      const prelude = separatorMatch[1]
      // 启发式：前缀部分如果包含至少 2 个句号结尾的句子，可能是合法正文，不清洗
      const sentenceEndings = (prelude.match(/[。！？.!?]["'"）]?\s*$/gm) || []).length
      if (sentenceEndings < 2) {
        const stripped = trimmed.slice(separatorMatch[0].length)
        this.context.logger.debug(
          { originalLen: content.length, strippedLen: stripped.length, preludeLen: prelude.length },
          'stripThinkingPrelude: 移除 --- 分隔符前的思考前缀',
        )
        return stripped.trimStart()
      }
    }

    return content
  }

  /**
   * 生成候选章节标题（3 个，4-8 字，供用户选择）。
   *
   * 设计意图：网文章节标题是吸引读者点击的重要手段（"第3章 赵岩的烟杆" vs "第3章"）。
   * 章节创作完成后，用一次轻量 LLM 调用基于正文内容生成 3 个候选标题。
   */
  async generateChapterTitles(
    projectId: string,
    chapterNumber: number,
    content: string,
    signal?: AbortSignal,
    modelId?: { provider: string; modelId: string },
  ): Promise<string[]> {
    // 截取正文前 800 字 + 后 200 字（开头结尾最能代表章节特征）
    const excerpt = content.length > 1000
      ? content.slice(0, 800) + '\n...\n' + content.slice(-200)
      : content

    const systemPrompt = '你是一个网文编辑，擅长起吸引人的章节标题。'
    const userMessage = `请基于以下章节正文，生成 3 个候选章节标题。

要求：
- 每个标题 4-8 个字
- 标题应反映本章核心事件或情感
- 风格参考网文章节标题（如"赵岩的烟杆""玉佩的秘密""深夜搜查"）
- 绝不使用破折号"——"。转折用句号，补充用逗号，列举用顿号。
- 直接输出 3 个标题，每行一个，不要编号，不要解释

章节正文：
${excerpt}`

    const session = await this.context.createSession({
      systemPrompt,
      userMessage,
      timeoutMs: 15_000,
      signal,
      modelId,
    })

    try {
      const result = await session.prompt()
      const titles = result
        .split('\n')
        .map(t => t.trim())
        .filter(t => t.length >= 2 && t.length <= 12)
        // 去除可能的前缀编号
        .map(t => t.replace(/^[0-9]+[.、\s]+/, '').trim())
        .filter(t => t.length >= 2 && t.length <= 12)
        .slice(0, 3)
      return titles
    } finally {
      session.dispose()
    }
  }

  /**
   * 生成前情提要（50-100 字，供连载展示）。
   *
   * 设计意图：连载网文每章开头通常需要简短的前情提要帮助读者回忆。
   * 章节完成后自动生成，存入 chapter.recap 字段，用户可选择是否展示。
   */
  async generateChapterRecap(
    projectId: string,
    chapterNumber: number,
    content: string,
    signal?: AbortSignal,
    modelId?: { provider: string; modelId: string },
  ): Promise<string | null> {
    // 截取正文前 600 字 + 后 200 字（开头结尾最能代表章节特征）
    const excerpt = content.length > 800
      ? content.slice(0, 600) + '\n...\n' + content.slice(-200)
      : content

    const systemPrompt = '你是一个网文编辑，擅长写简短的前情提要。'
    const userMessage = `请基于以下章节正文，写一段 50-100 字的前情提要。

要求：
- 概括本章核心事件和关键转折
- 语言简洁有力，像"上回说到……"的风格
- 不要剧透下一章
- 绝不使用破折号"——"。转折用句号，补充用逗号，列举用顿号。
- 直接输出提要内容，不要加标题或解释

章节正文：
${excerpt}`

    const session = await this.context.createSession({
      systemPrompt,
      userMessage,
      timeoutMs: 15_000,
      signal,
      modelId,
    })

    try {
      const result = await session.prompt()
      const recap = result.trim()
      if (recap.length < 10 || recap.length > 200) return null
      return recap
    } finally {
      session.dispose()
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 私有辅助方法
  // ═══════════════════════════════════════════════════════════════

  /**
   * 发射编排事件。
   *
   * type 由调用方显式指定，与 data.type 保持一致，避免靠字段嗅探推断。
   * phase === 'completed' | 'error' | 'cancelled' 时 type 自动跟随 phase。
   */
  private emitProgress(
    options: CreationOptions | undefined,
    phase: CreationPhase,
    type: CreationFlowEvent['type'],
    data: unknown,
  ): void {
    const finalType = phase === 'completed' || phase === 'error' || phase === 'cancelled' ? phase : type
    const event: CreationFlowEvent = {
      type: finalType,
      phase,
      data: { ...((data as Record<string, unknown>) ?? {}), type: finalType },
      timestamp: Date.now(),
    }
    options?.onProgress(event)
  }

  /**
   * 从通用 usage_records 表回填本次 Agent 调用的 token 用量。
   *
   * 背景：部分 Pi SDK/Provider 事件在插件侧订阅不到 usage，但底座 usage-ledger
   * 已经通过同一个 message_end 事件写入 usage_records。AgentLog 需要真实 cache read
   * 数据用于诊断命中率，因此在订阅未采集到 usage 时按 session 精确回填。
   */
  private readUsageForSession(sessionId?: string): LlmUsageSnapshot | undefined {
    try {
      if (!sessionId) return undefined
      const rows = this.context.db.prepare(`
        SELECT provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, timestamp
        FROM usage_records
         WHERE session_id = ?
        ORDER BY timestamp ASC
      `).all(sessionId) as Array<{
        provider: string
        model: string
        input_tokens: number
        output_tokens: number
        cache_read_tokens: number | null
        cache_write_tokens: number | null
        timestamp: number
      }>
      if (rows.length === 0) return undefined

      const latest = rows[rows.length - 1]
      const usage = rows.reduce<LlmUsageSnapshot>((sum, row) => ({
        inputTokens: sum.inputTokens + (row.input_tokens ?? 0),
        outputTokens: sum.outputTokens + (row.output_tokens ?? 0),
        cacheReadTokens: sum.cacheReadTokens + (row.cache_read_tokens ?? 0),
        cacheWriteTokens: sum.cacheWriteTokens + (row.cache_write_tokens ?? 0),
        llmProvider: row.provider || sum.llmProvider,
        llmModel: row.model || sum.llmModel,
      }), {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        llmProvider: latest.provider ?? '',
        llmModel: latest.model ?? '',
      })

      return hasLlmUsage(usage) ? usage : undefined
    } catch (err) {
      this.context.logger.debug({ err }, 'AgentLog usage 回填失败')
      return undefined
    }
  }
}
