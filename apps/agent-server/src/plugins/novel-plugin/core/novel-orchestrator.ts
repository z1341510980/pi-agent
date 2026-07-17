/**
 * NovelOrchestrator：多 Agent 编排引擎
 *
 * 编排完整的章节创作流程，包含 2 个检查点：
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  Director ──→ [检查点1: 叙事任务] ──→ Writer ──→ Reviewer  │
 * │                                              ↓             │
 * │                            [检查点2: 验收报告]               │
 * │                                  ↓                         │
 * │              ┌──────────────────┼──────────────────┐        │
 * │              ↓                  ↓                  ↓        │
 * │           revise             rewrite           approve     │
 * │              ↓                  ↓                  ↓        │
 * │        Writer 修订         (重新开始)           Memory     │
 * │              ↓                                     ↓        │
 * │           Memory                                 完成       │
 * └─────────────────────────────────────────────────────────────┘
 *
 * ── 检查点设计 ──
 *
 * 检查点 1（narrative_task）：在 Director 生成叙事任务后，等待用户确认。
 *   - approve：继续 Writer 阶段
 *   - reject：取消整个创作流程
 *   - revise/rewrite：根据用户意见重新调用 Director
 *
 * 检查点 2（review）：在 Reviewer 生成验收报告后，等待用户确认。
 *   - approve：跳过修订，直接进入 Memory 阶段
 *   - revise：调用 Writer 根据审稿意见修订局部内容
 *   - rewrite：重新开始整个创作流程（递归调用）
 *
 * ── 事件流 ──
 *
 * 通过 onProgress 回调向外推送 CreationFlowEvent，
 * 上层（如 SSE 路由）通过该回调实现实时进度推送。
 * 检查点决策由上层通过 onCheckpoint 回调委托 ConfirmationManager 完成
 * （统一超时机制 + pending 列表 + 'confirmation:*' 事件）。
 */

import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

import type { NovelStore } from './novel-store.js'
import type { NovelSessionFactory } from './novel-session.js'
import type { NovelPromptBuilder } from './prompt-builder.js'
import type { NovelEngine } from './novel-engine.js'
import type { PluginContext } from '../../../core/plugin/plugin-types.js'
import { runtimePerformance } from '../../../config/performance.js'
import { NOVEL_AGENT_CONFIGS, type NovelAgentType, type CreationPhase, type CreationFlowEvent } from './novel-agents.js'
import type { NarrativeTask, NarrativeTaskType, ChapterConstraints, ArrangedEntity, RhythmSuggestion, VersionSource } from './types.js'
import { RhythmController } from './rhythm-controller.js'
import { scanCliches, formatClicheReport } from './cliche-scanner.js'
import type { NovelMemoryStore } from './novel-memory-store.js'
import type { NovelMemoryGenerator } from './novel-memory-generator.js'
import type { NovelAgentConfigStore } from './novel-agent-config-store.js'
import type { NovelAgentLogStatus } from './types.js'
import {
  addLlmUsage,
  applySafeRevision,
  extractLlmUsageFromMessage,
  hasLlmUsage,
  sanitizeNovelProse,
  type LlmUsageSnapshot,
} from './agent-run-utils.js'
import { ChapterFinalizer, type CreationOptions, type CreationResult } from '../../../core/agent/chapter-finalizer.js'
import { parseChapterReviewReport } from './chapter-review-parser.js'
import { evaluateProseQuality, formatProseQualityReport } from './prose-quality-evaluator.js'
export type { CreationOptions, CreationResult } from '../../../core/agent/chapter-finalizer.js'

interface CreationRunContext {
  arrangedEntities?: ArrangedEntity
  directorOutput?: string
  directorTask?: NarrativeTask
  rhythmSuggestion?: RhythmSuggestion
  semiLayerSharedCache: { key: string; value: string } | null
}

interface PostWriteGuardResult {
  shouldRewrite: boolean
  reason: string
  details?: string
  /** 非致命偏差：不重写整章，交给 Reviewer 做语义和质量判断。 */
  advisory?: boolean
}

export class NovelOrchestrator {
  /** PostWriteGuard 自动重写上限：超过则降级交给 Reviewer 人工判断，避免无限递归 */
  private static readonly MAX_GUARD_REWRITE = 2
  /** 每次 create-flow 独立的异步运行上下文，防止并发章节互相覆盖状态。 */
  private readonly runStorage = new AsyncLocalStorage<CreationRunContext>()
  /** 检查点请求来自另一条 HTTP 请求，按项目和章节暂存用户指令。 */
  private readonly pendingUserMessages = new Map<string, string[]>()
  /** 小说角色温度配置存储（runAgent 中按角色合并温度） */
  private readonly agentConfigStore: NovelAgentConfigStore
  /** 记忆 Agent 生成器（结构化 LLM 调用，替代原工具循环模式） */
  private readonly memoryGenerator?: NovelMemoryGenerator
  /** 章节收尾逻辑（Memory 阶段 + 实体同步 + 快照 + 持久化），workflow 和 discussion 共用 */
  private readonly finalizer: ChapterFinalizer
  constructor(
    private store: NovelStore,
    private memoryStore: NovelMemoryStore,
    private sessionFactory: NovelSessionFactory,
    private promptBuilder: NovelPromptBuilder,
    private engine: NovelEngine,
    private context: PluginContext,
    agentConfigStore: NovelAgentConfigStore,
    memoryGenerator?: NovelMemoryGenerator,
  ) {
    this.agentConfigStore = agentConfigStore
    this.memoryGenerator = memoryGenerator
    // 创建 ChapterFinalizer，注入相同的依赖 + runAgent 回调（用于 memoryGenerator 未注入时的回退）
    this.finalizer = new ChapterFinalizer(
      store,
      memoryStore,
      promptBuilder,
      engine,
      context,
      memoryGenerator,
      (agentType, projectId, chapterNumber, input, options) =>
        this.runAgent(agentType, projectId, chapterNumber, input, options),
    )
  }

  /**
   * 设置用户在检查点期间发送的创作指令
   * 这些指令会在下一个 Agent 执行时附加到其输入中，随后清空
   */
  setUserMessages(projectId: string, chapterNumber: number, messages: string[]): void {
    this.pendingUserMessages.set(this.runKey(projectId, chapterNumber), messages.slice())
  }

  async createChapterWithFlow(
    projectId: string,
    chapterNumber: number,
    options: CreationOptions,
    /** PostWriteGuard 自动重写计数（内部递归用，外部调用不传） */
    guardRewriteCount = 0,
  ): Promise<CreationResult> {
    if (this.runStorage.getStore()) {
      return this.createChapterWithFlowInContext(projectId, chapterNumber, options, guardRewriteCount)
    }
    return this.runStorage.run(
      {
        arrangedEntities: options.arrangedEntities,
        semiLayerSharedCache: null,
      },
      () => this.createChapterWithFlowInContext(projectId, chapterNumber, options, guardRewriteCount),
    )
  }

  private async createChapterWithFlowInContext(
    projectId: string,
    chapterNumber: number,
    options: CreationOptions,
    guardRewriteCount: number,
  ): Promise<CreationResult> {
    const run = this.requireRunContext()
    // 将本章编排实体约束暂存到实例字段，供 runAgent 构建 SEMI 层时读取。
    // 采用临时字段方案是最小改动：无需改 runAgent 签名，也无需沿调用链透传。
    run.arrangedEntities = options.arrangedEntities
    // 清空单章 SEMI shared 缓存：每次进入 createChapterWithFlow（含 rewrite 递归）都重新构建，
    // 避免上一章/上一次创作的 shared 字符串残留导致 LLM 缓存条目错配。
    run.semiLayerSharedCache = null
    try {
      const styleProfile = this.store.getWritingStyleProfile(projectId)
      if (!styleProfile || styleProfile.positiveExamples.length === 0 || styleProfile.negativeExamples.length === 0) {
        this.emitProgress(options, 'directing', 'phase_change', {
          message: '文风质量基线尚未完整配置，本次仍可创作，但正文声音可能不稳定',
          detail: {
            kind: 'style_baseline_warning',
            hasProfile: Boolean(styleProfile),
            positiveExamples: styleProfile?.positiveExamples.length ?? 0,
            negativeExamples: styleProfile?.negativeExamples.length ?? 0,
          },
        })
      }
      // 计算本章节奏建议（供 Director 在规划叙事任务时参考节奏）
      const rhythmController = new RhythmController()
      const project = this.store.getProject(projectId)
      const chapters = this.store.listChapters(projectId)
      const rhythmHistory = chapters
        .filter(c => c.rhythm)
        .map(c => ({
          chapterNumber: c.chapterNumber,
          rhythm: c.rhythm!,
          effectiveness: 'medium' as const,
        }))
      const rhythmModel = RhythmController.MODELS.find(m => m.id === project?.rhythmModelId) ?? RhythmController.DEFAULT_MODEL
      // 读取活跃冲突和待回收伏笔，让 RhythmController 感知故事状态
      const activeConflicts = this.store.listConflicts(projectId).filter(
        c => c.stage !== 'resolved' && c.stage !== 'transformed'
      )
      const pendingForeshadows = this.store.listForeshadowing(projectId).filter(
        f => f.status !== 'recovered' && f.status !== 'abandoned'
      )
      const rhythmSuggestion = rhythmController.suggestRhythm(
        chapterNumber,
        project?.currentStage ?? 'setup',
        rhythmHistory,
        rhythmModel,
        { activeConflicts, pendingForeshadows },
      )
      // 暂存节奏建议：runAgent 构建 ChapterConstraints 时注入 rhythmConstraint
      run.rhythmSuggestion = rhythmSuggestion

      // 推送节奏建议详情，让用户了解本章节奏规划（气泡展示）
      this.emitProgress(options, 'directing', 'phase_change', {
        message: '本章节奏建议已生成',
        detail: {
          kind: 'rhythm_suggestion',
          rhythm: rhythmSuggestion.rhythm,
          climaxIntensity: rhythmSuggestion.climaxIntensity,
          climaxType: rhythmSuggestion.climaxType,
          description: rhythmSuggestion.description,
          reason: rhythmSuggestion.reason,
        },
      })

      // Phase 1: Director（支持 rewrite 循环：用户在检查点补充修改意见后可重写）
      const chapter = this.store.getChapter(projectId, chapterNumber)
      let directorResult = ''
      let needRewrite = true
      while (needRewrite) {
        this.emitProgress(options, 'directing', 'phase_change', { message: '导演 Agent 正在分析故事状态...' })
        // input 统一为字符串：避免 runAgent JSON.stringify 对象导致 LLM 收到 JSON 字符串
        // 章纲和节奏建议已分别进入 shared context 的「章节信息」「创作约束」，
        // 动态消息只保留本轮动作，避免把同一份内容再发一次。
        // rewrite 时 runAgent 会把 userMessages 作为"用户修改意见"注入 Director 输入
        directorResult = await this.runAgent('director', projectId, chapterNumber,
          `请依据章节上下文中的章纲、故事状态和节奏约束，为第 ${chapterNumber} 章规划叙事任务。`,
          options,
        )

        // 检查点 1
        this.emitProgress(options, 'checkpoint_narrative', 'phase_change', { message: '等待用户确认叙事任务...' })
        const narrativeDecision = await options.onCheckpoint({
          type: 'narrative_task',
          phase: 'checkpoint_narrative',
          data: directorResult,
        })

        if (narrativeDecision === 'reject') {
          this.emitProgress(options, 'cancelled', 'cancelled', { message: '用户取消了创作流程' })
          return { status: 'cancelled' }
        }

        if (narrativeDecision === 'rewrite' || narrativeDecision === 'revise') {
          // 用户补充了修改意见，重新调用 Director
          // userMessages 已由 setUserMessages 设置，runAgent 会注入 Director 输入
          this.emitProgress(options, 'directing', 'phase_change', { message: '按修改意见重新规划叙事任务...' })
          continue
        }

        // approve → 跳出循环
        needRewrite = false
      }

      // 暂存 Director 的实时输出：runAgent 构建 Writer 的 SEMI 层时，会将其注入
      // chapter-instruction 模板的 {{narrative_task}}，替代原来的章纲字段。
      // 这是方案 A 的核心：让 Director 的规划真正成为 Writer 的创作指导。
      // 注入前清洗破折号：Director 输出可能含破折号，注入 Writer 后会被模仿，
      // 在注入点清洗切断示范传播链。
      run.directorOutput = this.promptBuilder.stripEmDash(directorResult)
      // 解析 Director 输出为结构化 NarrativeTask，让 14 种任务类型真正传递到 Writer。
      // Director 提示词要求输出"任务类型"字段（如 create_suspense/escalate_conflict），
      // parseDirectorTask 从输出文本中提取任务类型、优先级、高潮目标等执行参数。
      run.directorTask = this.parseDirectorTask(directorResult, rhythmSuggestion)

      // 推送叙事任务详情，让用户了解 Director 解析出的结构化任务（气泡展示）
      this.emitProgress(options, 'directing', 'phase_change', {
        message: '叙事任务已解析',
        detail: {
          kind: 'narrative_task',
          taskType: run.directorTask.type,
          priority: run.directorTask.priority,
          targetEntity: run.directorTask.targetEntity,
          climaxTarget: run.directorTask.climaxTarget,
          suspenseDuration: run.directorTask.suspenseDuration,
          expectedIntensityDelta: run.directorTask.expectedIntensityDelta,
          positioning: run.directorTask.positioning,
        },
      })

      // v0.2：Director 规划通过后，创建/更新本章钩子实体（替代只填枚举字段）。
      // 同章重写必须复用已有钩子，避免每次 rewrite 都追加重复记录；中间章节
      // 若原先没有钩子，则不新建 pending 钩子污染已经存在的后续时间线。
      if (run.directorTask?.chapterEndingHook &&
          run.directorTask.chapterEndingHook !== 'none' &&
          run.directorTask.chapterEndingHookDescription) {
        try {
          const existingHook = this.store.listHooksByChapter(projectId, chapterNumber)[0]
          const historicalRewrite = (this.store.getProject(projectId)?.currentChapter ?? 0) > chapterNumber
          let hookId = existingHook?.id
          if (existingHook) {
            this.store.updateHook(existingHook.id, {
              hookType: run.directorTask.chapterEndingHook,
              description: run.directorTask.chapterEndingHookDescription,
            })
          } else if (!historicalRewrite) {
            hookId = randomUUID()
            this.store.createHook({
              id: hookId,
              projectId,
              chapterNumber,
              hookType: run.directorTask.chapterEndingHook,
              description: run.directorTask.chapterEndingHookDescription,
              status: 'thrown',
              fulfilledAtChapter: null,
              fulfilledDescription: null,
              linkedForeshadowId: null,
              linkedConflictId: null,
            })
          }
          this.context.logger.info(
            { projectId, chapterNumber, hookId, hookType: run.directorTask.chapterEndingHook, historicalRewrite },
            hookId ? 'v0.2: 已创建或更新本章钩子实体' : 'v0.2: 历史重写未新增待处理钩子',
          )
        } catch (err) {
          this.context.logger.warn({ projectId, chapterNumber, err }, 'v0.2: 创建钩子实体失败，不影响主流程')
        }
      }

      // Phase 2: Writer（支持 pushback：Writer 发现叙事任务有逻辑问题时可推回给 Director）
      let writerResult = ''
      let directorPushbackCount = 0
      let writerGuardRewriteCount = guardRewriteCount
      let writerGuardRewriteReason = ''
      let writerGuardRewriteDetails = ''
      let finalPostWriteGuard: PostWriteGuardResult | undefined
      let bestWriterCandidate: { content: string; score: number } | undefined
      const MAX_PUSHBACK = 1 // 限制推回 1 次，避免无限循环

      while (true) {
        this.emitProgress(options, 'writing', 'phase_change', {
          message: writerGuardRewriteReason
            ? `写作 Agent 正在沿用已批准的导演方案重写正文（${writerGuardRewriteCount}/${NovelOrchestrator.MAX_GUARD_REWRITE}）...`
            : directorPushbackCount > 0
            ? '写作 Agent 正在根据调整后的叙事任务重新创作...'
            : '写作 Agent 正在创作章节正文...',
        })
        // Director 的完整方案由 Writer 专属 suffix 注入，并带独立缓存断点；
        // 推回机制已在 role-writer 中定义，动态消息无需重复。
        writerResult = await this.runAgent('writer', projectId, chapterNumber,
          writerGuardRewriteReason
            ? `请沿用已批准的本章叙事任务，只重写第 ${chapterNumber} 章正文，不要重新规划或推回 Director。上一稿未通过确定性检查：${writerGuardRewriteReason}${writerGuardRewriteDetails ? `。具体问题：${writerGuardRewriteDetails}` : ''}。立即输出完整章节正文，不要输出核对过程、计划或重写说明。`
            : `请执行已批准的本章叙事任务，直接创作第 ${chapterNumber} 章正文。`,
          options,
        )

        // 检测 Writer 是否标记推回
        if (writerResult.trimStart().startsWith('[DIRECTOR_PUSHBACK]') && directorPushbackCount < MAX_PUSHBACK) {
          const pushbackReason = writerResult.replace(/\[DIRECTOR_PUSHBACK\]/i, '').trim()
          directorPushbackCount++
          this.emitProgress(options, 'directing', 'phase_change', {
            message: `写作 Agent 认为叙事任务存在问题，Director 正在重新规划...（推回原因：${pushbackReason.slice(0, 100)}）`,
          })
          this.context.logger.info(
            { projectId, chapterNumber, pushbackCount: directorPushbackCount, pushbackReason: pushbackReason.slice(0, 200) },
            'Writer 推回 Director，重新规划叙事任务',
          )

          // 将 Writer 的推回原因注入 Director，重新规划
          // 注入前清洗破折号：Writer 输出的推回原因可能含破折号
          run.directorOutput = undefined
          const rewriteDirectorResult = await this.runAgent('director', projectId, chapterNumber,
            `写作 Agent 对之前的叙事任务提出了异议，请依据既有章纲和节奏约束重新规划第 ${chapterNumber} 章。\n\n## 推回原因\n\n${this.promptBuilder.stripEmDash(pushbackReason)}`,
            options,
          )
          run.directorOutput = this.promptBuilder.stripEmDash(rewriteDirectorResult)
          run.directorTask = this.parseDirectorTask(rewriteDirectorResult, rhythmSuggestion)
          this.emitProgress(options, 'directing', 'phase_change', {
            message: '叙事任务已根据写作 Agent 的反馈调整',
            detail: {
              kind: 'narrative_task',
              taskType: run.directorTask.type,
              priority: run.directorTask.priority,
              pushback: true,
            },
          })
          // 继续循环，让 Writer 基于新任务重新创作
          continue
        }

        // PostWriteGuard 只重写 Writer，保留已批准的 Director 方案和本轮缓存。
        // 旧逻辑递归 createChapterWithFlow，会从 Director 开始整条重跑。
        const postWriteGuard = this.runPostWriteGuard(
          writerResult, projectId, chapterNumber, run.arrangedEntities,
        )
        const candidateScore = this.scoreWriterCandidate(writerResult, postWriteGuard)
        if (!bestWriterCandidate || candidateScore > bestWriterCandidate.score) {
          bestWriterCandidate = { content: writerResult, score: candidateScore }
        }
        if (postWriteGuard.shouldRewrite && writerGuardRewriteCount < NovelOrchestrator.MAX_GUARD_REWRITE) {
          writerGuardRewriteCount++
          writerGuardRewriteReason = postWriteGuard.reason
          writerGuardRewriteDetails = postWriteGuard.details ?? ''
          this.emitProgress(options, 'rewriting', 'phase_change', {
            message: `PostWriteGuard 检测到致命问题，仅重写正文，不重新调用 Director（第 ${writerGuardRewriteCount}/${NovelOrchestrator.MAX_GUARD_REWRITE} 次）：${postWriteGuard.reason}`,
          })
          this.context.logger.warn(
            { projectId, chapterNumber, writerGuardRewriteCount, reason: postWriteGuard.reason, details: postWriteGuard.details },
            'PostWriteGuard 触发 Writer 原地重写',
          )
          continue
        }
        if (postWriteGuard.shouldRewrite) {
          // 最后一次重试若退化成计划/说明或更差的草稿，不允许覆盖此前较好的正文。
          // 选回最佳候选后重新跑 Guard，并把仍存在的问题交给 Reviewer 判断。
          if (bestWriterCandidate && bestWriterCandidate.content !== writerResult) {
            const discardedWordCount = writerResult.replace(/\s/g, '').length
            writerResult = bestWriterCandidate.content
            finalPostWriteGuard = this.runPostWriteGuard(
              writerResult, projectId, chapterNumber, run.arrangedEntities,
            )
            this.context.logger.warn(
              {
                projectId,
                chapterNumber,
                writerGuardRewriteCount,
                discardedWordCount,
                restoredLength: writerResult.replace(/\s/g, '').length,
                reason: postWriteGuard.reason,
              },
              'Writer 最后一次重试质量退化，已恢复此前最佳正文',
            )
          } else {
            finalPostWriteGuard = postWriteGuard
          }
          this.context.logger.warn(
            {
              projectId,
              chapterNumber,
              writerGuardRewriteCount,
              reason: finalPostWriteGuard.reason,
              details: finalPostWriteGuard.details,
            },
            'PostWriteGuard Writer 重写已达上限，降级交给 Reviewer',
          )
          this.emitProgress(options, 'reviewing', 'phase_change', {
            message: `PostWriteGuard 已让 Writer 重写 ${writerGuardRewriteCount} 次仍未通过（${finalPostWriteGuard.reason}），交给审稿 Agent 判断`,
          })
        } else {
          finalPostWriteGuard = postWriteGuard
        }

        // 没有 pushback，且 Writer 确定性检查已结束，进入 Reviewer
        break
      }

      // Phase 3: Reviewer
      this.emitProgress(options, 'reviewing', 'phase_change', { message: '审稿 Agent 正在检查章节...' })

      // 先执行确定性的符号清理，再让 Reviewer 审查最终会落库的同一版本。
      const reviewContent = sanitizeNovelProse(writerResult)
      const clicheHits = scanCliches(reviewContent)
      const clicheReport = formatClicheReport(clicheHits)
      const proseQuality = evaluateProseQuality(reviewContent)
      const proseQualityReport = formatProseQualityReport(proseQuality)
      const guardReviewReport = finalPostWriteGuard?.reason
        ? `## PostWriteGuard 检查提示\n\n${finalPostWriteGuard.reason}${finalPostWriteGuard.details ? `：${finalPostWriteGuard.details}` : ''}\n\n请结合正文语义判断是否真的缺失；这是验收提示，不代表必须整章重写。`
        : ''
      const autoReviseHits = clicheHits.filter(hit => (
        hit.pattern === 'ending_summary'
        || hit.pattern === 'explanation_tone'
        || hit.pattern === 'god_view_arrangement'
        || hit.pattern === 'fragment_sentences'
        || hit.pattern === 'over_compression'
      ))
      const severeProseIssues = proseQuality.issues.filter(issue => issue.severity === 'error')
      this.emitProgress(options, 'reviewing', 'phase_change', { message: '文字编辑正在盲审正文读感...' })
      const proseEditorResult = await this.runAgent(
        'reviewer',
        projectId,
        chapterNumber,
        `请只从文字读感审查以下正文。\n\n## 待审正文\n\n${reviewContent}\n\n---\n\n${proseQualityReport}`,
        options,
        {
          phase: 'reviewing',
          displayAgentType: 'reviewer',
          displayAgentName: '文字编辑',
          contextMode: 'identity_only',
          identityPrompt: this.promptBuilder.buildProseEditorIdentity(projectId),
          consumeUserMessages: false,
        },
      )
      // ⚠️ 不能传 JSON 对象 { task, content }：runAgent 会 JSON.stringify 它，
      // 导致 Writer 输出的正文被压缩在 JSON 的 content 字段中（换行变 \n、引号被转义），
      // LLM 需要解析 JSON 才能提取正文，不同模型解析能力不同，行为不稳定。
      // 改为结构化 Markdown 字符串：明确的标题分隔，让 LLM 直接看到正文。
      const reviewResult = await this.runAgent('reviewer', projectId, chapterNumber,
        `请验收第 ${chapterNumber} 章的内容。\n\n---\n\n## 待审稿章节正文\n\n${reviewContent}\n\n---\n\n${clicheReport}\n\n---\n\n${proseQualityReport}\n\n---\n\n## 盲审文字编辑意见\n\n${this.promptBuilder.stripEmDash(proseEditorResult)}${guardReviewReport ? `\n\n---\n\n${guardReviewReport}` : ''}`,
        options,
      )
      if (chapter?.id) {
        try {
          await this.engine.saveReview({
            projectId,
            chapterId: chapter.id,
            ...parseChapterReviewReport(reviewResult),
            reviewedBy: 'novel-reviewer',
          })
        } catch (error) {
          this.context.logger.warn(
            { error, projectId, chapterNumber },
            '章节审稿报告持久化失败，不阻断创作流程',
          )
        }
      }

      // 检查点 2
      this.emitProgress(options, 'checkpoint_review', 'phase_change', { message: '等待用户确认验收报告...' })
      const reviewDecision = await options.onCheckpoint({
        type: 'review',
        phase: 'checkpoint_review',
        data: reviewResult,
      })

      let finalContent = reviewContent

      if (reviewDecision === 'reject') {
        this.emitProgress(options, 'cancelled', 'cancelled', { message: '用户拒绝了验收结果，创作流程已取消' })
        return { status: 'cancelled' }
      }

      if (
        reviewDecision === 'revise'
        || (reviewDecision === 'approve' && (autoReviseHits.length > 0 || severeProseIssues.length > 0))
      ) {
        const autoReviseLabels = [
          ...autoReviseHits.map(hit => hit.name),
          ...severeProseIssues.map(issue => issue.message),
        ]
        const autoReviseReason = autoReviseLabels.length > 0
          ? `确定性质量门命中：${autoReviseLabels.join('、')}`
          : ''
        this.emitProgress(options, 'revising', 'phase_change', {
          message: autoReviseReason
            ? `${autoReviseReason}，修订 Agent 正在自动优化正文...`
            : '修订 Agent 正在根据审稿意见修订章节...',
        })
        // ⚠️ 同 Reviewer：不能传 JSON 对象，改为结构化 Markdown 字符串
        // 使用独立的 'reviser' agent 类型，加载 role-reviser.md（最小改动原则），
        // 而非复用 'writer'（会加载 role-writer.md + chapter-instruction.md 导致
        // LLM 把任务误解为"重新创作"，只输出修订片段覆盖原正文）。
        // 注入原始 writerResult（含破折号）：Reviser 需要看到破折号在哪才能清除它们，
        // 审稿意见中的破折号由 stripEmDash 清洗（审稿意见是 Reviewer 产出，非正文）。
        const reviseResult = await this.runAgent('reviser', projectId, chapterNumber,
          `请根据审稿意见修订第 ${chapterNumber} 章的局部内容。\n\n---\n\n## 原章节正文\n\n${reviewContent}\n\n---\n\n## 审稿意见\n\n${this.promptBuilder.stripEmDash(reviewResult)}${autoReviseReason ? `\n\n---\n\n## 系统质量门（必须修复）\n\n${autoReviseReason}\n\n${clicheReport}` : ''}`,
          options,
          {
            phase: 'revising',
          },
        )
        // 代码层保护正文：优先应用“原文/修改后”局部补丁；兼容旧模型偶尔返回
        // 完整正文，但只有保留足够原文段落时才允许整体替换。
        const revisionDecision = applySafeRevision(reviewContent, reviseResult)
        if (!revisionDecision.accepted) {
          this.context.logger.warn(
            {
              projectId,
              chapterNumber,
              originalLength: writerResult.length,
              revisedLength: reviseResult.length,
              reason: revisionDecision.reason,
            },
            '修订输出不是可安全落库的完整正文，保留原正文',
          )
          // 告知用户修订被丢弃：避免静默回退让用户误以为修订已生效。
          // 历史问题：applySafeRevision 判定不安全时只打 warn 日志，用户无感知，
          // 导致用户看到审稿意见却不知道修订未被采用。这里通过气泡明确告知。
          this.emitProgress(options, 'revising', 'phase_change', {
            message: `修订输出未通过安全校验（${revisionDecision.reason}），已保留审稿后正文`,
            detail: {
              kind: 'revision_discarded',
              reason: revisionDecision.reason,
              originalLength: writerResult.length,
              revisedLength: reviseResult.length,
            },
          })
          finalContent = reviewContent
        } else {
          this.context.logger.info(
            {
              projectId,
              chapterNumber,
              mode: revisionDecision.mode,
              originalLength: writerResult.length,
              revisedLength: revisionDecision.content.length,
            },
            '修订结果已安全合并到章节正文',
          )
          finalContent = revisionDecision.content
        }
      } else if (reviewDecision === 'rewrite') {
        this.emitProgress(options, 'rewriting', 'phase_change', { message: '重新创作章节...' })
        return this.createChapterWithFlow(
          projectId,
          chapterNumber,
          { ...options, arrangedEntities: run.arrangedEntities },
        )
      }

      // 最终正文边界做确定性清理。提示词和 Reviewer 是质量引导，不能替代落库约束。
      const sanitizedFinalContent = sanitizeNovelProse(finalContent)
      if (sanitizedFinalContent !== finalContent) {
        this.context.logger.info(
          { projectId, chapterNumber },
          '最终正文已清理 Unicode 长横线破折号',
        )
      }

      // Phase 5: Memory（收尾逻辑委托给 ChapterFinalizer）。Memory 只读取正文和
      // 相关实体状态，不携带创作阶段的 shared context。
      // 计算版本来源：是否经过 Reviser 修订（finalContent 与 reviewContent 不同表示修订已生效）
      const isReviserPath = finalContent !== reviewContent
      const versionSource: VersionSource = isReviserPath
        ? { phase: 'reviser_final', agentType: 'reviser', trigger: 'Reviser 修订后落库' }
        : writerGuardRewriteCount > 0
          ? { phase: 'writer_initial', agentType: 'writer', trigger: `PostWriteGuard 原地重写后落库（第 ${writerGuardRewriteCount} 次）` }
          : { phase: 'writer_initial', agentType: 'writer', trigger: 'Writer 初稿落库' }
      return await this.finalizer.finalize({
        projectId,
        chapterNumber,
        content: sanitizedFinalContent,
        options,
        arrangedEntities: options.arrangedEntities,
        directorTask: run.directorTask,
        chapterId: chapter?.id ?? null,
        versionSource,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (options.signal?.aborted) {
        this.emitProgress(options, 'cancelled', 'cancelled', { message: '用户已停止创作流程' })
        return { status: 'cancelled' }
      }
      this.emitProgress(options, 'error', 'error', { message })
      return { status: 'error', error: message }
    } finally {
      // AsyncLocalStorage 会在本次 create-flow Promise 结束后释放运行上下文。
    }
  }

  /**
   * PostWriteGuard：正文后确定性检测
   *
   * 在 Reviewer 之前运行，捕获模型退化等致命问题，避免浪费 Reviewer token。
   * 检测项：
   * 1. 模型退化（复读/截断/拒绝/工程词泄漏）→ 自动重写
   * 2. 字数严重偏离（低于 75% 或高于 130%）→ 自动重写；轻微偏离交 Reviewer
   * 3. 大纲边界检查（简化版：检测是否包含工程词）
   */
  private runPostWriteGuard(
    content: string,
    projectId: string,
    chapterNumber: number,
    arrangedEntities?: ArrangedEntity,
  ): PostWriteGuardResult {
    const wordCount = content.replace(/\s/g, '').length

    // 单独拦截“说明了要写什么，却没有输出正文”的退化结果。
    // 这类输出可能未命中通用工程词扫描，但绝不能覆盖此前已生成的正文。
    if (
      wordCount < 500
      && /(?:先核对|按(?:章纲|已批准方案|导演方案)|重写第\s*\d+\s*章|输出(?:完整)?正文|创作第\s*\d+\s*章正文)/.test(content)
    ) {
      return {
        shouldRewrite: true,
        reason: '模型未输出正文',
        details: `仅输出了 ${wordCount} 字的计划或写作说明`,
      }
    }

    // 1. 模型退化检测（复用 cliche-scanner 的模型退化模式）
    const clicheHits = scanCliches(content)
    const modelDegradationHits = clicheHits.filter(
      h => h.severity === 'high' && (
        h.pattern === 'model_repetition' ||
        h.pattern === 'model_refusal' ||
        h.pattern === 'engineering_leak' ||
        h.pattern === 'engineering_words_cn'
      ),
    )

    if (modelDegradationHits.length > 0) {
      const hitNames = modelDegradationHits.map(h => `${h.name}(${h.count}次)`).join(', ')
      return {
        shouldRewrite: true,
        reason: '模型退化检测命中',
        details: hitNames,
      }
    }

    // 2. 字数检测
    const project = this.store.getProject(projectId)
    const advisories: Array<{ reason: string; details: string }> = []
    if (project) {
      // 复用 prompt-builder 的 computeChapterTargetWords（含节奏系数），
      // 确保 Guard 的目标字数与 Writer 提示词注入的 target_words 一致。
      const run = this.requireRunContext()
      const positioning = run.directorTask?.positioning
        ?? this.store.getChapter(projectId, chapterNumber)?.positioning
      const targetWords = this.engine.buildChapterConstraints(
        projectId,
        chapterNumber,
        run.rhythmSuggestion,
        positioning,
        arrangedEntities,
      ).wordBudget?.target ?? this.promptBuilder.computeChapterTargetWords(
        project,
        run.rhythmSuggestion?.rhythm,
      )

      // 只有明显失控才整章重写。75%-85% 与 115%-130% 属于轻微偏差，
      // 交给 Reviewer 结合章节完整性判断，避免边界差几个字就浪费一次 Writer 调用。
      if (wordCount < targetWords * 0.75) {
        return {
          shouldRewrite: true,
          reason: '字数严重不足',
          details: `实际 ${wordCount} 字，目标 ${targetWords} 字（仅 ${Math.round((wordCount / targetWords) * 100)}%）`,
        }
      }
      if (wordCount > targetWords * 1.30) {
        return {
          shouldRewrite: true,
          reason: '字数严重超标',
          details: `实际 ${wordCount} 字，目标 ${targetWords} 字（${Math.round((wordCount / targetWords) * 100)}%）`,
        }
      }
      if (wordCount < targetWords * 0.85) {
        advisories.push({
          reason: '字数略低于建议范围',
          details: `实际 ${wordCount} 字，目标 ${targetWords} 字（${Math.round((wordCount / targetWords) * 100)}%）`,
        })
      } else if (wordCount > targetWords * 1.15) {
        advisories.push({
          reason: '字数略高于建议范围',
          details: `实际 ${wordCount} 字，目标 ${targetWords} 字（${Math.round((wordCount / targetWords) * 100)}%）`,
        })
      }

    }

    // 3. 矩阵实体检查：角色姓名缺失属于确定性失败；势力和地点可能使用简称、
    // 场景别称或空间描述，精确字符串缺失只能作为 Reviewer 的语义验收提示。
    // 冲突和伏笔同样属于语义动作，继续交给 Reviewer 逐项验收。
    if (arrangedEntities) {
      const isConcreteName = (name: string | undefined): name is string => (
        !!name && !/（待定）|待补充|待定$/.test(name)
      )
      const characterNames = arrangedEntities.characterIds
        .map(id => this.store.getCharacter(id)?.name)
        .filter(isConcreteName)
      const missingCharacters = characterNames.filter(name => !content.includes(name))
      if (missingCharacters.length > 0) {
        return {
          shouldRewrite: true,
          reason: '未完整执行矩阵编排',
          details: `正文未出现矩阵角色：${missingCharacters.join('、')}`,
        }
      }

      const semanticEntityNames = [
        ...arrangedEntities.factionIds.map(id => this.store.getFaction(id)?.name),
        ...arrangedEntities.locationIds.map(id => this.store.getLocation(id)?.name),
      ].filter(isConcreteName)
      const missingSemanticEntities = semanticEntityNames.filter(name => !content.includes(name))
      if (missingSemanticEntities.length > 0) {
        advisories.push({
          reason: '矩阵实体需要语义验收',
          details: `正文未出现全名（可能使用简称或场景描述）：${missingSemanticEntities.join('、')}`,
        })
      }
    }

    if (advisories.length > 0) {
      return {
        shouldRewrite: false,
        advisory: true,
        reason: advisories.length === 1 ? advisories[0].reason : '确定性检查提示',
        details: advisories.map(item => `${item.reason}：${item.details}`).join('；'),
      }
    }
    return { shouldRewrite: false, reason: '' }
  }

  /**
   * 为 Writer 重试结果做保底排序。通过 Guard 的正文优先；矩阵缺项但仍是完整正文
   * 次之；模型退化/元说明最低。用于重试上限后的回退，不替代 Reviewer 评分。
   */
  private scoreWriterCandidate(content: string, guard: PostWriteGuardResult): number {
    const wordCount = content.replace(/\s/g, '').length
    if (guard.reason === '模型退化检测命中' || guard.reason === '模型未输出正文') {
      return -1_000_000 + wordCount
    }
    if (!guard.shouldRewrite) return 1_000_000 + wordCount
    if (guard.reason === '未完整执行矩阵编排') return 500_000 + wordCount
    if (guard.reason === '字数严重超标') return 100_000 - wordCount
    return wordCount
  }

  /** 运行单个 Agent（通过 Pi SDK Session，流式推送 delta） */
  private async runAgent(
    agentType: NovelAgentType,
    projectId: string,
    chapterNumber: number,
    input: unknown,
    options: CreationOptions,
    overrides?: {
      /** 展示用的 agentType（如 writer 用于修订时展示为 reviser） */
      displayAgentType?: 'director' | 'writer' | 'reviewer' | 'reviser' | 'memory'
      /** 展示用的 agentName */
      displayAgentName?: string
      /** 当前阶段（默认按 agentType 推断） */
      phase?: CreationPhase
      /** identity_only 用于盲审：不注入全局 system、章节 shared/suffix 和工具。 */
      contextMode?: 'full' | 'identity_only'
      /** 覆盖成员身份提示词，例如盲审文字编辑。 */
      identityPrompt?: string
      /** 是否消费流程中追加的用户指令；盲审应留给完整 Reviewer。 */
      consumeUserMessages?: boolean
    },
  ): Promise<string> {
    const run = this.requireRunContext()
    const config = NOVEL_AGENT_CONFIGS[agentType]
    // agentType → 阶段映射（config 无 phase 字段，这里显式维护）
    const phaseMap: Record<NovelAgentType, CreationPhase> = {
      director: 'directing',
      writer: 'writing',
      reviser: 'revising',
      reviewer: 'reviewing',
      memory: 'memory',
    }
    const phase = overrides?.phase ?? phaseMap[agentType]
    const displayAgentType = overrides?.displayAgentType ?? agentType
    const displayAgentName = overrides?.displayAgentName ?? config.name

    let inputText = typeof input === 'string' ? input : JSON.stringify(input)

    // Agent 身份保持在公共 system 之后，既不破坏跨 Agent 的 system/shared 缓存，
    // 又作为独立 prefix 获得缓存断点，供同 Agent 重试命中。
    const identityOnly = overrides?.contextMode === 'identity_only'
    const agentIdentity = overrides?.identityPrompt
      ?? this.promptBuilder.buildAgentIdentity(projectId, agentType)

    // 保存真正的原始任务输入（用于日志记录），再附加用户指令。
    // agentIdentity 是真实前缀，不再伪装成 taskInput 的一部分。
    const taskInputForLog = inputText

    // 附加用户在检查点期间发送的创作指令（消费后清空）
    // 保留副本用于日志记录
    const pendingMessageKey = this.runKey(projectId, chapterNumber)
    const consumeUserMessages = overrides?.consumeUserMessages !== false
    const userMessages = consumeUserMessages
      ? this.pendingUserMessages.get(pendingMessageKey) ?? []
      : []
    if (consumeUserMessages) this.pendingUserMessages.delete(pendingMessageKey)
    const userInstructionsForLog = userMessages.slice()
    if (userMessages.length > 0) {
      // 注入前清洗破折号：用户指令可能含破折号，防止成为 LLM 的示范
      const userInstructions = userMessages.map((m, i) => `${i + 1}. ${this.promptBuilder.stripEmDash(m)}`).join('\n')
      inputText += `\n\n## 用户创作指令\n用户在创作过程中提出以下指令，请在创作中予以考虑：\n${userInstructions}`
    }

    // STATIC 层：系统提示词（Agent 身份 + 世界规则 + 风格 + 角色定义）
    const systemPrompt = identityOnly
      ? ''
      : this.promptBuilder.buildSystemPrompt(projectId, agentType)

    // SEMI 层：章节上下文（"共享前缀 + Agent 专属后缀"分离）
    //
    // shared 部分跨 Agent 完全相同（章节信息 + 约束 + 故事状态 + 实体关联 + 信息差
    // + 摘要 + 因果链），通过 prefixUserMessage 数组第一条注入，打 cache_control
    // breakpoint 后能跨 Agent 命中 prompt cache（Director 写入 → 其他 Agent 命中）。
    //
    // suffix 部分各 Agent 不同（Director: 节奏+反馈；Writer: 结尾+锚点+指令；
    // Reviser/Reviewer: 结尾+锚点），放在 identity 之后作为最后一个缓存断点。
    // suffix 内容少，每次实时构建，无需缓存。
    //
    // 所有 Agent 的 shared narrativeTask 统一用数据库章纲，确保 shared 部分
    // 跨 Agent 完全一致。Director 的实时输出只进入 Writer/Reviewer 专属 suffix。
    const chapter = this.store.getChapter(projectId, chapterNumber)
    const narrativeTask: NarrativeTask = {
      description: chapter?.narrativeTask ?? `第 ${chapterNumber} 章创作`,
      type: 'advance_mainline',
      targetEntity: null,
      priority: 'medium',
    }
    const constraints: ChapterConstraints = this.engine.buildChapterConstraints(
      projectId,
      chapterNumber,
      run.rhythmSuggestion,
      run.directorTask?.positioning ?? chapter?.positioning,
      run.arrangedEntities,
    )

    // 推送章节约束详情（仅 Director 首次构建时发射，避免重复）
    // 让用户了解 Writer 将要面对的冲突推进目标、悬念钩子、节奏约束
    if (agentType === 'director') {
      this.emitProgress(options, phase, 'phase_change', {
        message: '章节约束已构建',
        detail: {
          kind: 'chapter_context',
          conflictTargets: constraints.conflictTargets.map(t => ({
            description: t.conflict.description,
            targetStage: t.targetStage,
            intensityDelta: t.intensityDelta,
            isClimax: t.isClimax,
          })),
          suspenseHooks: constraints.suspenseHooks.map(h => ({
            description: h.description,
            status: h.status,
            sustainedChapters: h.sustainedChapters,
            releaseByChapter: h.releaseByChapter,
          })),
          rhythmConstraint: constraints.rhythmConstraint,
          povCharacters: narrativeTask.povCharacters,
          sceneCount: narrativeTask.sceneCount,
          timeOffset: narrativeTask.timeOffset,
        },
      })
    }

    // shared 部分：单章缓存（跨 Agent 复用，projectId|chapterNumber 为 key）
    const sharedCacheKey = `${projectId}|${chapterNumber}`
    let sharedContext: string
    if (identityOnly) {
      sharedContext = ''
    } else if (run.semiLayerSharedCache && run.semiLayerSharedCache.key === sharedCacheKey) {
      sharedContext = run.semiLayerSharedCache.value
      this.context.logger.debug(
        { agentType, projectId, chapterNumber, sharedLength: sharedContext.length },
        'SEMI 层 shared 前缀命中单章缓存',
      )
    } else {
      sharedContext = this.promptBuilder.buildChapterContextShared(
        projectId,
        chapterNumber,
        narrativeTask,
        constraints,
        run.arrangedEntities,
      )
      run.semiLayerSharedCache = { key: sharedCacheKey, value: sharedContext }
      this.context.logger.debug(
        { agentType, projectId, chapterNumber, sharedLength: sharedContext.length },
        'SEMI 层 shared 前缀已写入单章缓存',
      )
    }

    // Writer 和 Reviewer 必须看到检查点批准后的 Director 完整方案。
    // 它只进入专属 suffix，不污染跨 Agent 复用的 shared 前缀。
    const suffixNarrativeTask = (
      (agentType === 'writer' || agentType === 'reviewer') && run.directorTask
    ) ? run.directorTask : narrativeTask

    // suffix 部分：每次实时构建（各 Agent 不同，可供同 Agent 重试缓存）
    const suffixContext = identityOnly
      ? ''
      : this.promptBuilder.buildChapterContextSuffix(
          projectId,
          chapterNumber,
          suffixNarrativeTask,
          constraints,
          run.arrangedEntities,
          agentType,
        )

    // DYNAMIC 层：Agent 任务指令（每次调用不同）
    // 章节上下文（SEMI 层）通过 prefixUserMessage 独立注入，不与任务拼接，
    // 确保 SEMI 层前缀跨 Agent 稳定，可被 prompt cache 命中。
    const userMessage = inputText

    // 按 Agent 类型过滤工具权限
    const allNovelTools = this.sessionFactory.getNovelTools()
    const allowedToolNames = config.tools
    const filteredTools = identityOnly
      ? []
      : allNovelTools.filter(t => allowedToolNames.includes(t.name))
    const toolNamesForLog = filteredTools.map(t => t.name)

    // 记录提示词日志（STATIC + SEMI + DYNAMIC 三层）
    this.context.logger.debug(
      {
        agentType,
        agentName: config.name,
        projectId,
        chapterNumber,
        systemPromptLength: systemPrompt.length,
        systemPromptPreview: systemPrompt.slice(0, 500),
        sharedLength: sharedContext.length,
        sharedPreview: sharedContext.slice(0, 500),
        suffixLength: suffixContext.length,
        suffixPreview: suffixContext.slice(0, 500),
        userMessageLength: userMessage.length,
        userMessagePreview: userMessage.slice(0, 500),
        toolsCount: filteredTools.length,
        toolNames: toolNamesForLog,
      },
      'Agent 提示词构建完成',
    )

    // 推送准备阶段进度，让前端知道 Agent 正在工作（不等 LLM 首 token）
    const totalInputChars = systemPrompt.length + sharedContext.length + suffixContext.length
      + agentIdentity.length + userMessage.length
    this.emitProgress(options, phase, 'phase_change', {
      message: `${displayAgentName} 正在准备调用 LLM（输入约 ${totalInputChars} 字符）...`,
    })

    // 创建独立 Session 并调用 LLM
    const startTime = Date.now()
    // 合并温度：持久化覆盖 > 角色默认值（NOVEL_AGENT_CONFIGS）
    const temperature = this.agentConfigStore.getByType(agentType)

    // 读取该 Agent 在 AgentPage 配置的 model（未配置则 undefined，走默认 Provider）
    // 与群聊模式 buildMembers 行为对齐：让 4 大 Agent 的 LLM 调用按用户在
    // AgentPage 配置的 provider+model 进行，而不是统一用默认 Provider。
    const agentConfig = this.context.subagentManager?.getAgent(config.id)
    const modelId = agentConfig?.model

    // LLM 调用超时：统一走 runtimePerformance（默认 300s，可通过环境变量
    // PI_LLM_TIMEOUT_MS 调大）。国内 OpenAI 兼容网关首 token 偏慢、长输出耗时
    // 较长，原 Director/Reviewer 120s 容易超时，且硬编码值无法在不改代码的情况下
    // 适配不同 Provider 速度。取消 writer/memory 与其他 Agent 的差异化：所有 Agent
    // 共享同一超时阈值，由 env 统一调控。
    const timeoutMs = runtimePerformance.llm.timeoutMs

    // 首 token 心跳：LLM 处理大 prompt 时首 token 延迟可能很长，
    // 期间没有 TEXT_MESSAGE_CONTENT 事件。每 5s 推一个心跳 progress，让用户感知到进度。
    // 首段 text_delta 到达后由工厂的 onFirstText 回调设置 firstTextReceived=true，心跳停止推送。
    // 间隔从 15s 缩短为 5s：避免用户在 approve 后长时间无反馈而失去耐心。
    let firstTextReceived = false
    const heartbeatTimer = setInterval(() => {
      if (firstTextReceived) return
      this.emitProgress(options, phase, 'phase_change', {
        message: `${displayAgentName} 正在等待 LLM 响应...（已等待 ${Math.round((Date.now() - startTime) / 1000)}s）`,
      })
    }, 5_000)

    // 声明在 try 块外：createAgUiSession 抛错时 finally 仍需安全清理
    let agUiSession: Awaited<ReturnType<PluginContext['createAgUiSession']>> | undefined
    let unsubscribeUsage: (() => void) | undefined
    let capturedUsage: LlmUsageSnapshot | undefined

    // 在 try/catch/finally 中捕获结果与错误，finally 持久化到日志表
    let logStatus: NovelAgentLogStatus = 'success'
    let logError = ''
    let logResult = ''
    try {
      // 通过底座工厂创建 AG-UI Session：封装 StreamEmitter + ReasoningPipeline + 订阅连接
      // 插件不再自己 new 这些基础设施层实例，真正"依托 chat 底座能力"
      // 首 token 检测下沉到工厂：通过 onFirstText 回调通知前端"开始生成"
      agUiSession = await this.context.createAgUiSession({
        systemPrompt,
        // 前缀顺序固定为 shared → identity → suffix：shared 跨 Agent 复用；
        // identity 在同 Agent 重试时继续命中；动态 suffix 放最后，避免其变化拖累身份缓存。
        prefixUserMessage: [sharedContext, agentIdentity, suffixContext].filter(Boolean),
        userMessage,
        tools: filteredTools,
        signal: options?.signal,
        temperature,
        // 透传 AgentPage 配置的 modelId（未配置则 undefined，走默认 Provider）
        modelId,
        timeoutMs,
        emit: options.emit,
        emitRaw: false, // novel 不需要 RAW 事件（chat 才用于调试）
        onFirstText: () => {
          firstTextReceived = true
          this.emitProgress(options, phase, 'phase_change', {
            message: `${displayAgentName} 开始生成内容...`,
          })
        },
      })
      const { session, streamEmitter, messageId } = agUiSession

      // 订阅 Pi Session 事件流，捕获 message_end 中的 usage 数据
      // （inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/model/provider）
      // 供 AgentLog 面板展示真实缓存命中率。
      // 多次 subscribe 互不干扰，工厂内部的 StreamEmitter 订阅不受影响。
      unsubscribeUsage = session.subscribe((event: Record<string, unknown>) => {
        if (event.type !== 'message_end') return
        const msg = (event as { message?: Record<string, unknown> }).message
        if (!msg || msg.role !== 'assistant') return
        const usage = extractLlmUsageFromMessage(msg)
        if (usage) capturedUsage = addLlmUsage(capturedUsage, usage)
      })

      // 通知前端 Agent 开始：带 messageId 让前端将后续 TEXT_MESSAGE_* 事件
      // 关联到对应 Agent 输出（前端维护 messageId → agentType 映射）
      //
      // ⚠️ 时序契约：此 agent_start 必须在 session.prompt() 之前发射，
      // 否则前端收到 TEXT_MESSAGE_START 时找不到 messageId 映射，输出不显示。
      // 包含 message 字段：让前端在首 token 到达前就能看到 Agent 已启动的反馈，
      // 避免 approve 后出现"空白等待"。
      this.emitProgress(options, phase, 'agent_start', {
        agentType: displayAgentType,
        agentName: displayAgentName,
        messageId,
        message: `${displayAgentName} 已启动，正在向 AI 发送请求...`,
      })

      this.context.logger.info(
        { agentType, agentName: config.name, projectId, chapterNumber, userMessageLength: userMessage.length, messageId },
        'Agent 开始调用 LLM（通过 createAgUiSession 工厂发射 AG-UI 标准事件）',
      )

      // 使用 prompt() 而非 promptStream()：StreamEmitter 已由工厂订阅
      // 实时发射 TEXT_MESSAGE_CONTENT 增量事件，prompt() 只负责触发 LLM 调用。
      // 首 token 检测由 createAgUiSession 工厂的 onFirstText 回调完成（见上方调用）。
      const result = await session.prompt()
      streamEmitter.finishTextMessage()

      this.context.logger.info(
        {
          agentType,
          agentName: config.name,
          projectId,
          resultLength: result.length,
          resultPreview: result.slice(0, 200),
        },
        'Agent prompt 返回',
      )

      // 破折号控制完全依赖 prompt 铁律禁令 + 正面示范，不做正则后处理。
      // 正则替换会破坏语义，应由 LLM 从源头学会不输出破折号。
      // 若仍有破折号，Reviewer 的 cliche-scanner 会检测到并触发 revise。

      logResult = result
      return result
    } catch (err) {
      logStatus = 'error'
      logError = err instanceof Error ? err.message : String(err)
      this.context.logger.error(
        { agentType, agentName: config.name, projectId, err },
        'Agent 推理失败',
      )
      throw err
    } finally {
      clearInterval(heartbeatTimer)
      // 不再需要 heartbeatUnsubscribe()：首 token 检测已下沉到 createAgUiSession 工厂，
      // 工厂内部 subscribe 在 dispose 时统一清理
      agUiSession?.dispose()
      unsubscribeUsage?.()

      const usageForLog = hasLlmUsage(capturedUsage)
        ? capturedUsage
        : this.readUsageFromLedgerWindow(startTime, Date.now(), agUiSession?.sessionId ?? agUiSession?.session.sessionId)

      // 持久化 Agent 调用日志（fire-and-forget，失败不影响主流程）
      try {
        this.store.insertAgentLog({
          projectId,
          chapterNumber,
          agentType,
          agentName: config.name,
          displayAgentType,
          displayAgentName,
          phase,
          systemPrompt,
          chapterContext: [sharedContext, agentIdentity, suffixContext].filter(Boolean).join('\n\n---\n\n'),
          userMessage,
          taskInput: taskInputForLog,
          userInstructions: userInstructionsForLog,
          tools: filteredTools.map(t => ({ name: t.name, description: t.description })),
          toolNames: toolNamesForLog,
          result: logResult,
          resultLength: logResult.length,
          durationMs: Date.now() - startTime,
          status: logStatus,
          error: logError,
          sessionId: agUiSession?.sessionId ?? agUiSession?.session.sessionId ?? '',
          inputTokens: usageForLog?.inputTokens ?? 0,
          outputTokens: usageForLog?.outputTokens ?? 0,
          cacheReadTokens: usageForLog?.cacheReadTokens ?? 0,
          cacheWriteTokens: usageForLog?.cacheWriteTokens ?? 0,
          llmProvider: usageForLog?.llmProvider ?? '',
          llmModel: usageForLog?.llmModel ?? '',
        })
      } catch (logErr) {
        // 日志写入失败不影响主流程
        this.context.logger.warn(
          { agentType, projectId, err: logErr },
          'Agent 调用日志写入失败',
        )
      }

      // 同步写入通用 agent_call_logs（chat 底座统一记录层）
      // metadata 携带 novel 领域扩展字段，供跨领域查询与审计
      if (this.context.agentCallLogger) {
        try {
          this.context.agentCallLogger.record({
            agentId: config.id,
            agentName: config.name,
            threadId: agUiSession?.sessionId ?? agUiSession?.session.sessionId ?? '',
            systemPrompt,
            userMessage,
            taskInput: taskInputForLog,
            tools: JSON.stringify(filteredTools.map(t => ({ name: t.name, description: t.description }))),
            toolNames: JSON.stringify(toolNamesForLog),
            result: logResult,
            resultLength: logResult.length,
            durationMs: Date.now() - startTime,
            status: logStatus === 'success' ? 'success' : 'error',
            error: logError,
            metadata: JSON.stringify({
              projectId,
              chapterNumber,
              agentType,
              phase,
              displayAgentType,
              displayAgentName,
              source: 'novel-orchestrator',
            }),
          })
        } catch (err) {
          this.context.logger.debug({ err }, 'agentCallLogger 记录失败')
        }
      }
    }
  }

  /**
   * 从通用 usage_records 表回填本次 Agent 调用的 token 用量。
   *
   * 背景：部分 Pi SDK/Provider 事件在插件侧订阅不到 usage，但底座 usage-ledger
   * 已经通过同一个 message_end 事件写入 usage_records。AgentLog 需要真实 cache read
   * 数据用于诊断命中率，因此在订阅未采集到 usage 时按 session 精确回填。
   */
  private readUsageFromLedgerWindow(startTime: number, endTime: number, sessionId?: string): LlmUsageSnapshot | undefined {
    try {
      // 没有 sessionId 时不能安全地从时间窗口推断归属，避免并发 Agent 串账。
      if (!sessionId) return undefined
      const rows = this.context.db.prepare(`
        SELECT provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, timestamp
        FROM usage_records
        WHERE timestamp >= ? AND timestamp <= ?
          AND session_id = ?
        ORDER BY timestamp ASC
      `).all(startTime - 500, endTime + 500, sessionId) as Array<{
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

  /**
   * 发射编排事件。
   *
   * type 由调用方显式指定，与 data.type 保持一致，避免靠字段嗅探推断。
   * phase === 'completed' | 'error' | 'cancelled' 时 type 自动跟随 phase。
   *
   * 时序契约：
   * - agent_start 必须在 session.prompt() 之前发射（带 messageId），
   *   前端用 messageId 关联后续 TEXT_MESSAGE_* 事件
   * - data_changed 在 Memory Agent 写入完成后发射
   * - phase_change 用于心跳 / 准备阶段 / 开始生成提示
   *
   * 注意：仅通过 options.onProgress 回调推送，不再 emit EventEmitter 事件
   * （原 'event' 事件无监听者，移除继承以简化职责）。
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
   * 从 Director 输出文本中解析结构化 NarrativeTask
   *
   * Director 提示词（role-director.md）要求输出包含"任务类型"字段，
   * 本方法从输出文本中提取任务类型、优先级、高潮目标、悬念持续章数等执行参数，
   * 让 14 种 NarrativeTaskType（create_suspense/create_reversal/escalate_conflict 等）
   * 真正传递到 Writer 和下游约束构建，而非被硬编码为 advance_mainline。
   *
   * 解析策略：正则匹配 Director 输出中的关键字段，失败时回退到 advance_mainline。
   */
  private parseDirectorTask(directorOutput: string, rhythmSuggestion: RhythmSuggestion): NarrativeTask {
    const text = directorOutput

    // 提取任务类型（支持中英文标识）
    const validTypes: NarrativeTaskType[] = [
      'advance_mainline', 'advance_subline', 'create_conflict', 'escalate_conflict',
      'release_info', 'hide_info', 'reinforce_foreshadow', 'recover_foreshadow',
      'change_relationship', 'change_cognition', 'create_reversal', 'create_suspense',
      'phase_closure', 'introduce_problem',
    ]
    // 中文标签 → NarrativeTaskType 映射
    const typeLabels: Record<string, NarrativeTaskType> = {
      '推进主线': 'advance_mainline', '推进副线': 'advance_subline',
      '创建冲突': 'create_conflict', '升级冲突': 'escalate_conflict',
      '释放信息': 'release_info', '隐藏信息': 'hide_info',
      '强化伏笔': 'reinforce_foreshadow', '回收伏笔': 'recover_foreshadow',
      '改变关系': 'change_relationship', '改变认知': 'change_cognition',
      '制造突转': 'create_reversal', '制造悬念': 'create_suspense',
      '阶段收束': 'phase_closure', '引入问题': 'introduce_problem',
    }

    let taskType: NarrativeTaskType = 'advance_mainline'

    // 先匹配英文标识
    const englishMatch = validTypes.find(t => new RegExp(`\\b${t}\\b`, 'i').test(text))
    if (englishMatch) {
      taskType = englishMatch
    } else {
      // 再匹配中文标签
      for (const [label, type] of Object.entries(typeLabels)) {
        if (text.includes(label)) {
          taskType = type
          break
        }
      }
    }

    // 提取优先级
    let priority: NarrativeTask['priority'] = 'medium'
    if (/优先级[：:]\s*高|priority[：:]\s*high/i.test(text)) {
      priority = 'high'
    } else if (/优先级[：:]\s*低|priority[：:]\s*low/i.test(text)) {
      priority = 'low'
    }

    // 构建任务对象
    const task: NarrativeTask = {
      description: directorOutput,
      type: taskType,
      targetEntity: null,
      priority,
    }

    // 如果节奏建议是 climax，注入高潮目标
    if (rhythmSuggestion.rhythm === 'climax' && rhythmSuggestion.climaxIntensity) {
      task.climaxTarget = {
        type: rhythmSuggestion.climaxType ?? 'composite',
        intensity: rhythmSuggestion.climaxIntensity,
      }
    }

    // 如果任务类型是 create_suspense，注入悬念持续章数（默认 3 章）
    if (taskType === 'create_suspense') {
      const durationMatch = text.match(/悬念持续[：:]\s*(\d+)\s*章/)
      task.suspenseDuration = durationMatch ? parseInt(durationMatch[1], 10) : 3
    }

    // 如果任务类型是 escalate_conflict，提取预期强度变化
    if (taskType === 'escalate_conflict') {
      const deltaMatch = text.match(/强度变化[：:]\s*([+-]?\d+)/)
      task.expectedIntensityDelta = deltaMatch ? parseInt(deltaMatch[1], 10) : 1
    }

    // 提取次要任务（最多 2 个）
    const secondarySection = text.match(/##\s*次要任务[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i)
    if (secondarySection) {
      const secondaryTypes: NarrativeTaskType[] = []
      for (const validType of validTypes) {
        if (validType === taskType) continue // 不重复主任务
        if (new RegExp(`\\b${validType}\\b`, 'i').test(secondarySection[1])) {
          secondaryTypes.push(validType)
        }
        if (secondaryTypes.length >= 2) break
      }
      if (secondaryTypes.length > 0) task.secondaryTasks = secondaryTypes
    }

    // 提取章尾钩子类型 + 描述（v0.2：钩子升级为实体，需要描述文本）
    const hookSection = text.match(/##\s*章尾钩子设计[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i)
    if (hookSection) {
      const hookText = hookSection[1].trim()
      // 保留完整描述供创建钩子实体
      task.chapterEndingHookDescription = hookText.slice(0, 200)
      // 保留现有的类型解析逻辑（suspense/reversal/emotional/action）
      if (/悬念钩子|suspense/i.test(hookText)) task.chapterEndingHook = 'suspense'
      else if (/反转钩子|reversal/i.test(hookText)) task.chapterEndingHook = 'reversal'
      else if (/情感钩子|emotional/i.test(hookText)) task.chapterEndingHook = 'emotional'
      else if (/行动钩子|action/i.test(hookText)) task.chapterEndingHook = 'action'
    }

    // 解析 POV 角色
    const povMatch = directorOutput.match(/##\s*POV[\s\S]*?本章\s*POV\s*角色[：:]\s*(.+)/i)
    if (povMatch) {
      const povNames = povMatch[1].split(/[、,，]/).map(s => s.trim()).filter(Boolean)
      if (povNames.length > 0) task.povCharacters = povNames
    }

    // 解析场景数
    const sceneMatch = directorOutput.match(/##\s*场景数[\s\S]*?场景数[：:]\s*(\d)/i)
    if (sceneMatch) {
      const n = parseInt(sceneMatch[1], 10)
      if (n >= 1 && n <= 5) task.sceneCount = n
    }

    // 解析章节六型定位。Director 输出格式为：
    // “- 章节定位：high_pressure/advancement/...”
    const positioningMatch = text.match(/章节定位[：:]\s*(high_pressure|advancement|cultivation|relationship|low_pressure|information)\b/i)
    if (positioningMatch) {
      task.positioning = positioningMatch[1].toLowerCase() as NonNullable<NarrativeTask['positioning']>
    }

    // 解析时间线偏移（相对第1章的天数）
    // 支持格式："+3天" / "-2天" / "第1天" / "同日" / "3天后"
    const timeMatch = directorOutput.match(/##\s*时间线偏移[\s\S]*?时间线[：:]\s*(.+)/i)
    if (timeMatch) {
      const timeText = timeMatch[1].trim()
      const plusMatch = timeText.match(/\+(\d+)\s*天/)
      const minusMatch = timeText.match(/-(\d+)\s*天/)
      const dayNMatch = timeText.match(/第\s*(\d+)\s*天/)
      if (plusMatch) {
        task.timeOffset = parseInt(plusMatch[1], 10)
      } else if (minusMatch) {
        task.timeOffset = -parseInt(minusMatch[1], 10)
      } else if (dayNMatch) {
        task.timeOffset = parseInt(dayNMatch[1], 10) - 1
      } else if (/同日|当天|当日/.test(timeText)) {
        task.timeOffset = 0
      }
    }

    return task
  }

  private requireRunContext(): CreationRunContext {
    const run = this.runStorage.getStore()
    if (!run) throw new Error('create-flow 运行上下文不存在')
    return run
  }

  private runKey(projectId: string, chapterNumber: number): string {
    return `${projectId}|${chapterNumber}`
  }
}
