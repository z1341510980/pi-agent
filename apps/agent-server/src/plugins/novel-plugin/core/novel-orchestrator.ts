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
import type { NovelPromptBuilder } from './prompt-builder.js'
import type { NovelEngine } from './novel-engine.js'
import type { PluginContext } from '../../../core/plugin/plugin-types.js'
import { runtimePerformance } from '../../../config/performance.js'
import { NOVEL_AGENT_CONFIGS, type NovelAgentType, type CreationPhase, type CreationFlowEvent, getNovelAgentTemperature } from './novel-agents.js'
import {
  getNovelAskStoryPolicy,
  isNovelAskStoryEnabled,
  resolveNovelAgentToolNames,
  type NovelAskStoryPolicy,
} from './novel-ask-story-policy.js'
import type { NarrativeTask, NarrativeTaskType, ChapterConstraints, ArrangedEntity, RhythmSuggestion, VersionSource } from './types.js'
import { RhythmController } from './rhythm-controller.js'
import { scanCliches, formatClicheReport } from './cliche-scanner.js'
import type { NovelMemoryStore } from './novel-memory-store.js'
import type { NovelMemoryGenerator } from './novel-memory-generator.js'
import type { NovelAgentLogStatus } from './types.js'
import {
  addLlmUsage,
  extractLlmUsageFromMessage,
  hasLlmUsage,
  sanitizeNovelProse,
  type LlmUsageSnapshot,
} from './agent-run-utils.js'
import { createNovelApplyRevisionTool, type RevisionDraftHolder } from './novel-tools.js'
import { createNovelSubmitNarrativeTaskTool, type NarrativeTaskDraftHolder } from './novel-tools.js'
import { createNovelSubmitReviewTool, type ReviewDraftHolder } from './novel-tools.js'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { ChapterFinalizer, type CreationOptions, type CreationResult } from '../../../core/agent/chapter-finalizer.js'
import { cancelDebug } from '../utils/cancel-debug-log.js'
import { evaluateProseQuality, formatProseQualityReport } from './prose-quality-evaluator.js'
import { classifyLlmFailure, retryDelayMs, LLM_MAX_RETRIES } from './llm-error-policy.js'
import { buildWriterRewritePlan } from './writer-rewrite-plan.js'
import {
  createChapterBudgetUsage,
  evaluateChapterBudget,
  getChapterBudgetCategorySnapshot,
  recordChapterBudgetCategory,
  recordLlmCall,
  shouldPromptBudgetCheckpoint,
  tryRecordFullChapterRewrite,
  type ChapterBudgetUsage,
} from './chapter-budget.js'
export type { CreationOptions, CreationResult } from '../../../core/agent/chapter-finalizer.js'

interface CreationRunContext {
  /** 策略在流程启动时冻结，避免并发请求或运行中环境变更影响同一章。 */
  askStoryPolicy: NovelAskStoryPolicy
  /** Deterministic Writer/Reviser fact-pack injection is enabled for this run. */
  factPackPathActive: boolean
  arrangedEntities?: ArrangedEntity
  directorOutput?: string
  directorTask?: NarrativeTask
  rhythmSuggestion?: RhythmSuggestion
  semiLayerSharedCache: { key: string; value: string } | null
  /**
   * 单章成本累计。
   *
   * 放在 run context 而非实例字段：并发创作多个章节时各自独立，
   * 否则两章的调用数会互相污染。
   */
  budget: ChapterBudgetUsage
}

interface PostWriteGuardResult {
  shouldRewrite: boolean
  reason: string
  details?: string
  /** 非致命偏差：不重写整章，交给 Reviewer 做语义和质量判断。 */
  advisory?: boolean
}

/**
 * runAgent 的可选覆盖项。
 *
 * 提取为命名接口是因为它现在被 runAgent（重试外壳）与 runAgentOnce（单次尝试）
 * 两处共用，内联字面量会写两遍。
 */
interface RunAgentOverrides {
  /** 展示用的 agentType（如 writer 用于修订时展示为 reviser） */
  displayAgentType?: 'director' | 'writer' | 'reviewer' | 'reviser' | 'memory'
  /** 展示用的 agentName */
  displayAgentName?: string
  /** 当前阶段（默认按 agentType 推断） */
  phase?: CreationPhase
  /**
   * identity_only 用于盲审：不注入全局 system、章节 shared/suffix 和工具。
   * editor 保留身份和 agent 专属 suffix，但跳过全局与章节 shared 上下文。
   */
  contextMode?: 'full' | 'identity_only' | 'editor'
  /** 覆盖成员身份提示词，例如盲审文字编辑。 */
  identityPrompt?: string
  /** 是否消费流程中追加的用户指令；盲审应留给完整 Reviewer。 */
  consumeUserMessages?: boolean
  /**
   * 动态注入的额外工具（不进入 NOVEL_AGENT_CONFIGS 的 tools 过滤白名单）。
   * 用于 Reviser 调用 novel_apply_revision 工具：工具通过闭包引用 draft 对象，
   * orchestrator 在 Reviser 结束后从 draft 读取最终正文，完全绕开正则解析。
   */
  extraTools?: ToolDefinition[]
  /**
   * 增强 agent_log.result 字段（不影响 runAgent 的返回值）。
   *
   * 用于工具化 Agent：raw 文本输出只是"我已应用 N 处修订"之类客套话，
   * 真正的结果（如修订后正文）在工具闭包里。回调在 runAgent 写 agent_log 前
   * 被调用，把工具应用结果追加到 logResult，让用户能在日志面板审查真实结果。
   * 返回值会覆盖 logResult；runAgent 仍返回 raw result 给调用方。
   */
  augmentLogResult?: (rawResult: string) => string
}

export class NovelOrchestrator {
  /** PostWriteGuard 自动重写上限：超过则降级交给 Reviewer 人工判断，避免无限递归 */
  private static readonly MAX_GUARD_REWRITE = 2
  /** 每次 create-flow 独立的异步运行上下文，防止并发章节互相覆盖状态。 */
  private readonly runStorage = new AsyncLocalStorage<CreationRunContext>()
  /** 检查点请求来自另一条 HTTP 请求，按项目和章节暂存用户指令。 */
  private readonly pendingUserMessages = new Map<string, string[]>()
  /** 记忆 Agent 生成器（结构化 LLM 调用，替代原工具循环模式） */
  private readonly memoryGenerator?: NovelMemoryGenerator
  /** 章节收尾逻辑（Memory 阶段 + 实体同步 + 快照 + 持久化），workflow 和 discussion 共用 */
  private readonly finalizer: ChapterFinalizer
  constructor(
    private store: NovelStore,
    private memoryStore: NovelMemoryStore,
    private novelTools: ToolDefinition[],
    private promptBuilder: NovelPromptBuilder,
    private engine: NovelEngine,
    private context: PluginContext,
    memoryGenerator?: NovelMemoryGenerator,
  ) {
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
        askStoryPolicy: getNovelAskStoryPolicy(this.store.getProject(projectId)?.novelAskStoryPolicy),
        factPackPathActive: true,
        arrangedEntities: options.arrangedEntities,
        semiLayerSharedCache: null,
        budget: createChapterBudgetUsage(),
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
      // Director 未调用工具时的重试计数器，避免无限循环
      let directorToolMissedCount = 0
      const MAX_DIRECTOR_TOOL_MISS = 2
      // narrativeDraft 提到 while 外：Director 成功调用工具后，循环退出仍需读取 draft.task
      let narrativeDraft: NarrativeTaskDraftHolder = {}
      while (needRewrite) {
        this.emitProgress(options, 'directing', 'phase_change', { message: '导演 Agent 正在分析故事状态...' })
        // input 统一为字符串：避免 runAgent JSON.stringify 对象导致 LLM 收到 JSON 字符串
        // 章纲和节奏建议已分别进入 shared context 的「章节信息」「创作约束」，
        // 动态消息只保留本轮动作，避免把同一份内容再发一次。
        // rewrite 时 runAgent 会把 userMessages 作为"用户修改意见"注入 Director 输入
        // ⚠️ 工具化方案：通过 novel_submit_narrative_task 工具协议化输入。
        // 旧方案让 Director 输出 Markdown 自由文本，再用 parseDirectorTask 用 18 处正则提取字段。
        // LLM 不严格遵守格式时正则解析失败，降级到默认值，Director 的真实意图丢失。
        // 新方案：Director 必须调用工具提交结构化对象，工具参数 schema 强制校验。
        // draft 通过闭包传递，Director 结束后 orchestrator 直接读取 draft.task。
        // 每次循环重置 draft：保留对外部 narrativeDraft 引用，避免重试时旧 task 残留
        narrativeDraft = {}
        const submitNarrativeTaskTool = createNovelSubmitNarrativeTaskTool(narrativeDraft)
        directorResult = await this.runAgent('director', projectId, chapterNumber,
          `请依据章节上下文中的章纲、故事状态和节奏约束，为第 ${chapterNumber} 章规划叙事任务。`,
          options,
          { extraTools: [submitNarrativeTaskTool] },
        )
        narrativeDraft.rawOutput = directorResult

        // 检查点 1
        this.emitProgress(options, 'checkpoint_narrative', 'phase_change', { message: '等待用户确认叙事任务...' })
        // ⚠️ 工具化方案：checkpoint.data 优先携带 Director 通过工具提交的结构化 NarrativeTask 对象，
        // 前端 CheckpointMessage 识别 kind 后用 formatDetailBubble 格式化为可读 markdown 展示。
        // 若 Director 未调用工具（narrativeDraft.task 为 undefined），构造显式提示让用户选择重写：
        // 不再 fallback 到 directorResult（LLM 可能输出"叙事任务已通过工具提交"等误导性文本，
        // 让用户误以为调了工具但其实没有）。
        const directorTaskSubmitted = Boolean(narrativeDraft.task)
        const checkpointData: unknown = narrativeDraft.task
          ? { kind: 'narrative_task', ...narrativeDraft.task }
          : {
              kind: 'narrative_task_missing',
              directorRawOutput: directorResult.slice(0, 800),
              message: 'Director 未通过工具提交叙事任务',
            }
        this.context.logger.warn(
          {
            projectId,
            chapterNumber,
            directorTaskSubmitted,
            directorOutputLength: directorResult.length,
            directorOutputPreview: directorResult.slice(0, 200),
          },
          'Director 检查点 1 状态：是否通过工具提交叙事任务',
        )
        const narrativeDecision = await options.onCheckpoint({
          type: 'narrative_task',
          phase: 'checkpoint_narrative',
          data: checkpointData,
          options: ['approve', 'revise', 'rewrite', 'reject'],
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

        // approve → 检查 Director 是否通过工具提交了任务
        // ⚠️ 工具化方案：Director 必须调用 novel_submit_narrative_task 工具提交结构化对象。
        // 未调用时给出明确错误而非降级默认值，避免 Director 真实意图丢失却静默继续。
        if (!narrativeDraft.task) {
          directorToolMissedCount++
          this.context.logger.error(
            { projectId, chapterNumber, directorOutputLength: directorResult.length, missedCount: directorToolMissedCount },
            'Director 未调用 novel_submit_narrative_task 工具提交叙事任务',
          )
          if (directorToolMissedCount >= MAX_DIRECTOR_TOOL_MISS) {
            // 达到上限：转为错误终止流程，避免无限重试
            this.emitProgress(options, 'error', 'error', {
              message: `Director 连续 ${directorToolMissedCount} 次未调用工具提交叙事任务，流程终止`,
              detail: {
                kind: 'narrative_tool_miss_limit',
                directorRawOutput: directorResult.slice(0, 500),
              },
            })
            return { status: 'error', error: 'Director 未通过工具提交叙事任务' }
          }
          this.emitProgress(options, 'directing', 'phase_change', {
            message: `Director 未通过工具提交叙事任务（第 ${directorToolMissedCount}/${MAX_DIRECTOR_TOOL_MISS} 次），重试中...`,
            detail: {
              kind: 'narrative_task_not_submitted',
              directorRawOutput: directorResult.slice(0, 500),
            },
          })
          // 给 Director 一次重试机会
          needRewrite = true
          continue
        }

        // Director 已通过工具提交任务 → 跳出循环
        needRewrite = false
      }

      // 暂存 Director 的实时输出：runAgent 构建 Writer 的 SEMI 层时，会将其注入
      // chapter-instruction 模板的 {{narrative_task}}，替代原来的章纲字段。
      // 这是方案 A 的核心：让 Director 的规划真正成为 Writer 的创作指导。
      // 注入前清洗破折号：Director 输出可能含破折号，注入 Writer 后会被模仿，
      // 在注入点清洗切断示范传播链。
      run.directorOutput = this.promptBuilder.stripEmDash(directorResult)
      // 此时 narrativeDraft.task 必然存在（while 内部已校验）
      // 使用非空断言：TS 无法跨闭包收窄 narrativeDraft.task 的可选性
      const directorTask = narrativeDraft.task!
      // 注入高潮目标（来自节奏建议，parseDirectorTask 旧逻辑也在这里注入）
      if (rhythmSuggestion.rhythm === 'climax' && rhythmSuggestion.climaxIntensity) {
        directorTask.climaxTarget = {
          type: rhythmSuggestion.climaxType ?? 'composite',
          intensity: rhythmSuggestion.climaxIntensity,
        }
      }
      // 悬念持续章数默认值（仅 create_suspense 任务且 Director 未指定时）
      if (directorTask.type === 'create_suspense' && directorTask.suspenseDuration === undefined) {
        directorTask.suspenseDuration = 3
      }
      // 冲突强度变化默认值（仅 escalate_conflict 任务且 Director 未指定时）
      if (directorTask.type === 'escalate_conflict' && directorTask.expectedIntensityDelta === undefined) {
        directorTask.expectedIntensityDelta = 1
      }
      run.directorTask = directorTask

      // 推送叙事任务详情，让用户了解 Director 通过工具提交的完整结构化任务（气泡展示）
      // 直接用 directorTask 局部变量（已断言非空），避免 run.directorTask 可能 undefined 的类型问题
      // ⚠️ 工具化方案：Director 通过 novel_submit_narrative_task 工具提交了完整 NarrativeTask 对象，
      // 这里把全部字段透传到前端气泡展示，避免"只看到一句话"的反模式。
      this.emitProgress(options, 'directing', 'phase_change', {
        message: '叙事任务已提交',
        detail: {
          kind: 'narrative_task',
          description: directorTask.description,
          taskType: directorTask.type,
          secondaryTasks: directorTask.secondaryTasks,
          targetEntity: directorTask.targetEntity,
          priority: directorTask.priority,
          expectedIntensityDelta: directorTask.expectedIntensityDelta,
          climaxTarget: directorTask.climaxTarget,
          suspenseDuration: directorTask.suspenseDuration,
          chapterEndingHook: directorTask.chapterEndingHook,
          chapterEndingHookDescription: directorTask.chapterEndingHookDescription,
          povCharacters: directorTask.povCharacters,
          sceneCount: directorTask.sceneCount,
           positioning: directorTask.positioning,
           timeOffset: directorTask.timeOffset,
           requiredReferences: directorTask.requiredReferences,
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
      // 用户在 Guard 检查点明确选择 Reviser 后，Reviewer 只负责生成修订依据，
      // 不再弹出第二个会覆盖该选择的验收检查点。
      let requestedRevisionReason = ''
      let bestWriterCandidate: { content: string; score: number } | undefined
      const MAX_PUSHBACK = 1 // 限制推回 1 次，避免无限循环

      while (true) {
        // 重写策略：上一稿可用时做定向修改，否则全量重写。
        // 此前一律全量重写（只传 reason 字符串），每次都要重新吃掉 19k input，
        // 而 ch9 重写 10 次 / ch10 重写 13 次 —— 那两章 token 爆炸的主要来源之一。
        const rewritePlan = writerGuardRewriteReason
          ? buildWriterRewritePlan({
              chapterNumber,
              reason: writerGuardRewriteReason,
              details: writerGuardRewriteDetails,
              previousDraft: writerResult,
              attempt: writerGuardRewriteCount,
              maxAttempts: NovelOrchestrator.MAX_GUARD_REWRITE,
            })
          : null

        this.emitProgress(options, 'writing', 'phase_change', {
          message: rewritePlan
            ? `写作 Agent 正在${rewritePlan.summary}...`
            : directorPushbackCount > 0
            ? '写作 Agent 正在根据调整后的叙事任务重新创作...'
            : '写作 Agent 正在创作章节正文...',
        })
        if (rewritePlan) {
          this.context.logger.info(
            {
              projectId,
              chapterNumber,
              strategy: rewritePlan.strategy,
              reason: writerGuardRewriteReason,
              previousDraftChars: writerResult.length,
              attempt: writerGuardRewriteCount,
            },
            'Writer 重写策略已确定',
          )
        }
        // Director 的完整方案由 Writer 专属 suffix 注入，并带独立缓存断点；
        // 推回机制已在 role-writer 中定义，动态消息无需重复。
        writerResult = await this.runAgent('writer', projectId, chapterNumber,
          rewritePlan
            ? rewritePlan.input
            : `请执行已批准的本章叙事任务，直接创作第 ${chapterNumber} 章正文。`,
          options,
        )

        // 检测 Writer 是否标记推回
        if (writerResult.trimStart().startsWith('[DIRECTOR_PUSHBACK]') && directorPushbackCount < MAX_PUSHBACK) {
          const pushbackReason = writerResult.replace(/\[DIRECTOR_PUSHBACK\]/i, '').trim()
          directorPushbackCount++
          this.emitProgress(options, 'directing', 'phase_change', {
            message: `写作 Agent 认为叙事任务存在问题，等待用户确认是否推回 Director...（推回原因：${pushbackReason.slice(0, 100)}）`,
          })
          this.context.logger.info(
            { projectId, chapterNumber, pushbackCount: directorPushbackCount, pushbackReason: pushbackReason.slice(0, 200) },
            'Writer 推回 Director，等待用户决策',
          )

          // ⚠️ 检查点：Writer 推回 Director 让用户决策。
          // 旧逻辑直接 continue 静默重跑 Director，用户失去控制：
          // 用户看不到 pushbackReason 完整内容，也无法选择"强制让 Writer 继续"或"取消"。
          // 现改为检查点：approve=同意推回重跑 Director，rewrite=让 Writer 强制继续当前任务，
          // reject=取消整个流程。
          const pushbackDecision = await options.onCheckpoint({
            type: 'writer_pushback',
            phase: 'directing',
            data: {
              pushbackReason,
              currentWriterOutput: writerResult,
              pushbackCount: directorPushbackCount,
              maxPushback: MAX_PUSHBACK,
              chapterNumber,
            },
            options: ['approve', 'rewrite', 'reject'],
          })

          if (pushbackDecision === 'reject') {
            this.emitProgress(options, 'cancelled', 'cancelled', { message: '用户取消了创作流程' })
            return { status: 'cancelled' }
          }
          if (pushbackDecision === 'rewrite') {
            // 用户选择"让 Writer 强制继续"：不重跑 Director，让 Writer 重新写正文。
            // ⚠️ 注意：不设置 writerGuardRewriteReason，因为那是 PostWriteGuard 专用字段，
            // 设置后会让 Writer 误以为是 Guard 命中而看到"用户要求忽略推回"作为失败原因。
            // 用户决策不应混入 Guard 流程的提示词，Writer 直接重新创作即可。
            this.emitProgress(options, 'writing', 'phase_change', {
              message: '用户要求 Writer 按原叙事任务强制继续创作...',
            })
            continue
          }
          // approve（默认行为）：同意推回，重跑 Director
          // 将 Writer 的推回原因注入 Director，重新规划
          // 注入前清洗破折号：Writer 输出的推回原因可能含破折号
          run.directorOutput = undefined
          // ⚠️ 工具化方案：重跑 Director 时也要创建新的 draft 并注入工具
          const pushbackNarrativeDraft: NarrativeTaskDraftHolder = {}
          const pushbackSubmitTool = createNovelSubmitNarrativeTaskTool(pushbackNarrativeDraft)
          const rewriteDirectorResult = await this.runAgent('director', projectId, chapterNumber,
            `写作 Agent 对之前的叙事任务提出了异议，请依据既有章纲和节奏约束重新规划第 ${chapterNumber} 章。\n\n## 推回原因\n\n${this.promptBuilder.stripEmDash(pushbackReason)}`,
            options,
            { extraTools: [pushbackSubmitTool] },
          )
          pushbackNarrativeDraft.rawOutput = rewriteDirectorResult
          if (!pushbackNarrativeDraft.task) {
            // 推回后重跑 Director 也未调用工具：报错并取消
            this.context.logger.error(
              { projectId, chapterNumber, pushbackReason: pushbackReason.slice(0, 200) },
              'Director 推回重跑后仍未调用 novel_submit_narrative_task 工具',
            )
            this.emitProgress(options, 'error', 'error', {
              message: 'Director 推回重跑后未通过工具提交叙事任务，流程终止',
            })
            return { status: 'error', error: 'Director 推回重跑后未通过工具提交叙事任务' }
          }
          // 注入高潮目标（与首次调用一致）
          if (rhythmSuggestion.rhythm === 'climax' && rhythmSuggestion.climaxIntensity) {
            pushbackNarrativeDraft.task.climaxTarget = {
              type: rhythmSuggestion.climaxType ?? 'composite',
              intensity: rhythmSuggestion.climaxIntensity,
            }
          }
          if (pushbackNarrativeDraft.task.type === 'create_suspense' && pushbackNarrativeDraft.task.suspenseDuration === undefined) {
            pushbackNarrativeDraft.task.suspenseDuration = 3
          }
          if (pushbackNarrativeDraft.task.type === 'escalate_conflict' && pushbackNarrativeDraft.task.expectedIntensityDelta === undefined) {
            pushbackNarrativeDraft.task.expectedIntensityDelta = 1
          }
          run.directorOutput = this.promptBuilder.stripEmDash(rewriteDirectorResult)
          run.directorTask = pushbackNarrativeDraft.task
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
          // ⚠️ 检查点：PostWriteGuard 命中后让用户决策是否重写。
          // 旧逻辑直接 continue 静默重写，用户看不到 details（如"实际 1200 字，目标 3000 字 40%"），
          // 也无法选择"接受当前草稿跳过重写"或"转 Reviser 局部修订"。
          // 现改为检查点：approve=接受当前草稿进 Reviewer，rewrite=按原因重写（默认），
          // revise=跳过重写直接让 Reviser 局部修订，reject=取消。
          // 注意：approve/revise 路径用 break 跳出 while 循环，下方触发点 4（达上限降级）
          // 的 if 块在 while 内，break 后不会进入，无需担心连续弹框。
          const guardDecision = await options.onCheckpoint({
            type: 'post_write_guard',
            phase: 'rewriting',
            data: {
              reason: postWriteGuard.reason,
              details: postWriteGuard.details,
              advisory: postWriteGuard.advisory,
              currentWriterOutput: writerResult,
              wordCount: writerResult.replace(/\s/g, '').length,
              rewriteCount: writerGuardRewriteCount + 1,
              maxRewrite: NovelOrchestrator.MAX_GUARD_REWRITE,
              chapterNumber,
            },
            options: ['rewrite', 'approve', 'revise', 'reject'],
          })

          if (guardDecision === 'reject') {
            this.emitProgress(options, 'cancelled', 'cancelled', { message: '用户取消了创作流程' })
            return { status: 'cancelled' }
          }
          if (guardDecision === 'approve') {
            // 用户选择"接受当前草稿"：跳过重写，break 出 while 进入 Reviewer
            this.emitProgress(options, 'reviewing', 'phase_change', {
              message: `用户接受当前草稿（PostWriteGuard 命中：${postWriteGuard.reason}），进入审稿阶段`,
            })
            this.context.logger.info(
              { projectId, chapterNumber, reason: postWriteGuard.reason },
              '用户接受 PostWriteGuard 命中的草稿，跳过重写',
            )
            finalPostWriteGuard = postWriteGuard
            break
          }
          if (guardDecision === 'revise') {
            // 用户选择"转 Reviser 局部修订"：跳过 Writer 重写，break 出 while 进入 Reviewer，
            // 让 Reviewer 把 Guard 问题作为审稿意见交 Reviser 局部修复
            this.emitProgress(options, 'reviewing', 'phase_change', {
              message: `用户选择转 Reviser 局部修订（PostWriteGuard 命中：${postWriteGuard.reason}），进入审稿阶段`,
            })
            this.context.logger.info(
              { projectId, chapterNumber, reason: postWriteGuard.reason },
              '用户选择转 Reviser 局部修订，跳过 Writer 重写',
            )
            finalPostWriteGuard = postWriteGuard
            requestedRevisionReason = `用户在写作守护检查点选择局部修订：${postWriteGuard.reason}${postWriteGuard.details ? `（${postWriteGuard.details}）` : ''}`
            break
          }
          // rewrite（默认行为）：按原因重写 Writer
          writerGuardRewriteCount++
          run.budget = recordChapterBudgetCategory(run.budget, 'guardWriterRewrites')
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
            message: `PostWriteGuard 已让 Writer 重写 ${writerGuardRewriteCount} 次仍未通过（${finalPostWriteGuard.reason}），等待用户决策...`,
          })

          // ⚠️ 检查点：Guard 达上限后让用户决策。
          // 旧逻辑直接进入 Reviewer，用户无法选择"从头重写整个流程"或"取消"。
          // 现改为检查点：approve=接受当前草稿进 Reviewer（默认），rewrite=从头重写整章，
          // revise=让 Reviser 局部修复 Guard 命中的问题，reject=取消。
          const budgetCategories = getChapterBudgetCategorySnapshot(run.budget)
          const degradedDecision = await options.onCheckpoint({
            type: 'guard_degraded',
            phase: 'rewriting',
            data: {
              reason: finalPostWriteGuard.reason,
              details: finalPostWriteGuard.details,
              currentWriterOutput: writerResult,
              restoredFromBest: bestWriterCandidate && bestWriterCandidate.content === writerResult,
              rewriteCount: writerGuardRewriteCount,
              maxRewrite: NovelOrchestrator.MAX_GUARD_REWRITE,
              chapterNumber,
              budgetCategories,
            },
            options: budgetCategories.fullChapterRewriteAvailable
              ? ['approve', 'rewrite', 'revise', 'reject']
              : ['approve', 'revise', 'reject'],
          })

          if (degradedDecision === 'reject') {
            this.emitProgress(options, 'cancelled', 'cancelled', { message: '用户取消了创作流程' })
            return { status: 'cancelled' }
          }
          if (degradedDecision === 'rewrite') {
            const rewrite = tryRecordFullChapterRewrite(run.budget)
            if (rewrite.allowed) {
              run.budget = rewrite.usage
              this.emitProgress(options, 'rewriting', 'phase_change', { message: '用户选择从头重写整章...' })
              return this.createChapterWithFlow(
                projectId,
                chapterNumber,
                { ...options, arrangedEntities: run.arrangedEntities },
              )
            }
            requestedRevisionReason = '整章重写次数已达到本章上限，改为局部修订'
            this.emitProgress(options, 'revising', 'phase_change', {
              message: '整章重写次数已达到本章上限，将保留当前正文并进入局部修订。',
            })
          }
          if (degradedDecision === 'revise') {
            requestedRevisionReason = `用户在守护降级检查点选择局部修订：${finalPostWriteGuard.reason}${finalPostWriteGuard.details ? `（${finalPostWriteGuard.details}）` : ''}`
          }
          // approve 接受当前草稿；revise 已记录为必须执行的 Reviser 分支。
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
      run.budget = recordChapterBudgetCategory(run.budget, 'reviewerRuns')
      // ⚠️ 不能传 JSON 对象 { task, content }：runAgent 会 JSON.stringify 它，
      // 导致 Writer 输出的正文被压缩在 JSON 的 content 字段中（换行变 \n、引号被转义），
      // LLM 需要解析 JSON 才能提取正文，不同模型解析能力不同，行为不稳定。
      // 改为结构化 Markdown 字符串：明确的标题分隔，让 LLM 直接看到正文。
      // ⚠️ 工具化方案：通过 novel_submit_review 工具协议化输入。
      // 旧方案让 Reviewer 输出 Markdown 报告（十维评分表 + Findings 表格 + 结论），
      // 再由 parseChapterReviewReport 用正则提取 11 个评分 + verdict + issues + suggestions。
      // LLM 不严格遵守格式时正则解析失败，评分/结论降级为 null，Reviewer 的真实判断丢失。
      // 新方案：Reviewer 必须调用工具提交结构化对象，工具参数 schema 强制校验。
      // draft 通过闭包传递，Reviewer 结束后 orchestrator 直接读取 draft.review。
      const reviewDraft: ReviewDraftHolder = {}
      const submitReviewTool = createNovelSubmitReviewTool(reviewDraft)
      const reviewResult = await this.runAgent('reviewer', projectId, chapterNumber,
        `请验收第 ${chapterNumber} 章的内容。\n\n---\n\n## 待审稿章节正文\n\n${reviewContent}\n\n---\n\n${clicheReport}\n\n---\n\n${proseQualityReport}\n\n---\n\n## 盲审文字编辑意见\n\n${this.promptBuilder.stripEmDash(proseEditorResult)}${guardReviewReport ? `\n\n---\n\n${guardReviewReport}` : ''}`,
        options,
        {
          extraTools: [submitReviewTool],
          // Restricted Reviewer runs retain chapter facts through the shared context. Legacy
          // runs keep the cheaper editor context because ask_story remains available there.
          contextMode: isNovelAskStoryEnabled(
            run.askStoryPolicy,
            'reviewer',
            run.factPackPathActive,
          ) ? 'editor' : 'full',
          // Guard 检查点选择 revise 时，附言必须留给后面的 Reviser；Reviewer
          // 只生成修订依据，不应抢先消费这批针对修订的用户意见。
          consumeUserMessages: !requestedRevisionReason,
        },
      )
      run.budget = recordChapterBudgetCategory(run.budget, 'reviewerRuns')
      reviewDraft.rawOutput = reviewResult

      // 检查 Reviewer 是否通过工具提交了验收报告
      // 未调用工具时给出明确警告，不降级默认值，避免 Reviewer 真实判断丢失却静默继续
      if (!reviewDraft.review) {
        this.context.logger.warn(
          { projectId, chapterNumber, reviewerOutputLength: reviewResult.length },
          'Reviewer 未调用 novel_submit_review 工具提交验收报告',
        )
        this.emitProgress(options, 'reviewing', 'phase_change', {
          message: 'Reviewer 未通过工具提交验收报告，结构化评分缺失，请结合文本报告人工判断',
          detail: {
            kind: 'review_tool_missed',
            reviewerRawOutput: reviewResult.slice(0, 500),
          },
        })
      }

      if (chapter?.id) {
        try {
          await this.engine.saveReview({
            projectId,
            chapterId: chapter.id,
            // Reviewer 未调用工具时，draft.review 为 undefined，展开为空对象，
            // saveReview 接受 null 字段，会存入一份"未评分"的占位记录
            ...(reviewDraft.review ?? {
              consistencyScore: null,
              characterScore: null,
              taskCompletionScore: null,
              clueProgressScore: null,
              foreshadowStatusScore: null,
              conflictChangeScore: null,
              pacingScore: null,
              infoControlScore: null,
              readerHookScore: null,
              styleScore: null,
              overallScore: null,
              verdict: null,
              issues: null,
              suggestions: null,
            }),
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
      this.emitProgress(
        options,
        requestedRevisionReason ? 'revising' : 'checkpoint_review',
        'phase_change',
        {
          message: requestedRevisionReason
            ? 'Reviewer 已完成检查，按此前选择进入 Reviser...'
            : '等待用户确认验收报告...',
        },
      )
      const reviewDecision = requestedRevisionReason
        ? 'revise'
        : await options.onCheckpoint({
            type: 'review',
            phase: 'checkpoint_review',
            data: {
              review: reviewResult,
              budgetCategories: getChapterBudgetCategorySnapshot(run.budget),
            },
            options: getChapterBudgetCategorySnapshot(run.budget).fullChapterRewriteAvailable
              ? ['approve', 'revise', 'rewrite', 'reject']
              : ['approve', 'revise', 'reject'],
          })

      if (requestedRevisionReason) {
        this.emitProgress(options, 'revising', 'phase_change', {
          message: `${requestedRevisionReason}。Reviewer 已生成修订依据，直接进入 Reviser。`,
        })
      }

      let finalContent = reviewContent

      if (reviewDecision === 'reject') {
        this.emitProgress(options, 'cancelled', 'cancelled', { message: '用户拒绝了验收结果，创作流程已取消' })
        return { status: 'cancelled' }
      }

      if (reviewDecision === 'revise') {
        const autoReviseLabels = [
          ...autoReviseHits.map(hit => hit.name),
          ...severeProseIssues.map(issue => issue.message),
        ]
        const autoReviseReason = [
          requestedRevisionReason,
          autoReviseLabels.length > 0 ? `确定性质量门命中：${autoReviseLabels.join('、')}` : '',
        ].filter(Boolean).join('；')
        this.emitProgress(options, 'revising', 'phase_change', {
          message: autoReviseReason
            ? `${autoReviseReason}，修订 Agent 正在自动优化正文...`
            : '修订 Agent 正在根据审稿意见修订章节...',
        })
        // ⚠️ 工具化修订方案：
        // 旧方案让 Reviser 输出"原文/修改后"配对文本，再用正则解析。LLM 不严格遵守
        // 格式时正则解析失败，会走 full 兜底把"修改意见"当作完整正文落库——这正是
        // 用户反馈的"修改意见覆盖正文"问题的根因。
        //
        // 新方案：通过 novel_apply_revision 工具协议化输入。Reviser 必须调用工具才能
        // 修改正文，工具参数 schema 强制结构化（pairs: [{from, to}]），工具内部用
        // String.replace 做精确替换，完全绕开自然语言解析。draft 通过闭包传递，
        // orchestrator 在 Reviser 结束后直接读取 draft.content 作为最终正文。
        const draft: RevisionDraftHolder = {
          content: reviewContent,
          appliedPatches: [],
        }
        const applyRevisionTool = createNovelApplyRevisionTool(draft)
        // ── 修复：把 Reviewer 工具化提交的结构化验收报告格式化为可读文本，注入 Reviser 上下文 ──
        // 历史问题：Reviewer 工具化后 raw 文本输出（reviewResult）只剩推理过程/客套话，
        // 真正的 issues/suggestions/verdict/scores 在 reviewDraft.review 里（结构化对象）。
        // 旧代码只传 reviewResult 给 Reviser，导致 Reviser 看不到具体问题和建议，
        // "修订"变成无的放矢。现在把 reviewDraft.review 格式化后作为"结构化审稿报告"注入。
        const structuredReviewReport = this.formatReviewReportForReviser(reviewDraft.review)
        let reviewFindingTexts: string[] = []
        try {
          const findings = JSON.parse(reviewDraft.review?.issues ?? '[]') as Array<{
            description?: string
            location?: string
            suggestion?: string
          }>
          if (Array.isArray(findings)) {
            reviewFindingTexts = findings.flatMap((finding) => [
              finding.description ?? '',
              finding.location ?? '',
              finding.suggestion ?? '',
            ]).filter(Boolean)
          }
        } catch {
          // Invalid review JSON yields no derived references; the structured report remains available.
        }
        const reviserFactPack = this.promptBuilder.buildReviewFactPack(
          projectId,
          reviewFindingTexts,
          run.directorTask?.requiredReferences,
        )
        // 注入原始 writerResult（含破折号）：Reviser 需要看到破折号在哪才能清除它们，
        // 审稿意见中的破折号由 stripEmDash 清洗（审稿意见是 Reviewer 产出，非正文）。
        const reviseResult = await this.runAgent('reviser', projectId, chapterNumber,
          `请根据审稿意见修订第 ${chapterNumber} 章的局部内容。\n\n---\n\n## 原章节正文\n\n${reviewContent}\n\n---\n\n${structuredReviewReport}${reviserFactPack ? `\n\n---\n\n${reviserFactPack}` : ''}\n\n---\n\n## Reviewer 分析过程（参考，结构化报告为准）\n\n${this.promptBuilder.stripEmDash(reviewResult)}${autoReviseReason ? `\n\n---\n\n## 系统质量门（必须修复）\n\n${autoReviseReason}\n\n${clicheReport}` : ''}`,
          options,
          {
            phase: 'revising',
            extraTools: [applyRevisionTool],
            // Reviser 的输入已包含原文、结构化审稿意见和文风身份；不再重复
            // 发送全书大纲、实体档案和章节 shared 上下文。
            contextMode: 'editor',
            // ── 修复：把修订后正文（draft.content）追加到 reviser 的 agent_log.result ──
            // 工具化后 reviser 的 raw 文本输出只是"我已应用 N 处修订"，真正的修订后正文
            // 在 draft.content 里（通过 novel_apply_revision 工具闭包更新）。
            // 不追加的话 agent_log 看不到修订结果，用户无法在日志面板审查修订后的正文。
            augmentLogResult: (raw) => this.augmentReviserLogResult(raw, draft),
          },
        )
        run.budget = recordChapterBudgetCategory(run.budget, 'reviserRuns')
        // 工具调用结果决定最终正文：
        // - draft.appliedPatches 至少有一处成功应用 → 使用 draft.content 作为最终正文
        // - draft.appliedPatches 为空或全部失败 → 保留原正文，告知用户修订未生效
        const successfulPatches = draft.appliedPatches.filter(p => p.success)
        if (successfulPatches.length > 0) {
          this.context.logger.info(
            {
              projectId,
              chapterNumber,
              appliedCount: successfulPatches.length,
              failedCount: draft.appliedPatches.length - successfulPatches.length,
              originalLength: writerResult.length,
              revisedLength: draft.content.length,
            },
            '修订已通过 novel_apply_revision 工具应用到章节正文',
          )
          finalContent = draft.content
        } else {
          // 修订未生效：Reviser 未调用工具，或所有 patch 都定位失败。
          // 保留原正文，把 Reviser 输出附给用户决定是否手动采纳。
          this.context.logger.warn(
            {
              projectId,
              chapterNumber,
              patchCount: draft.appliedPatches.length,
              reviseResultLength: reviseResult.length,
            },
            'Reviser 未通过工具成功应用任何修订，保留原正文',
          )
          this.emitProgress(options, 'revising', 'phase_change', {
            message: draft.appliedPatches.length === 0
              ? '修订未生效：Reviser 未调用 novel_apply_revision 工具，已保留原正文，建议可在前端查看 Reviser 输出后手动决定'
              : `修订未生效：${draft.appliedPatches.length} 处 patch 全部定位失败，已保留原正文`,
            detail: {
              kind: 'revision_not_applied',
              reason: draft.appliedPatches.length === 0 ? 'tool_not_called' : 'all_patches_failed',
              patchCount: draft.appliedPatches.length,
              reviserRawOutput: reviseResult,
            },
          })
          finalContent = reviewContent
        }
      } else if (reviewDecision === 'rewrite') {
        const rewrite = tryRecordFullChapterRewrite(run.budget)
        if (rewrite.allowed) {
          run.budget = rewrite.usage
          this.emitProgress(options, 'rewriting', 'phase_change', { message: '重新创作章节...' })
          return this.createChapterWithFlow(
            projectId,
            chapterNumber,
            { ...options, arrangedEntities: run.arrangedEntities },
          )
        }
        this.emitProgress(options, 'revising', 'phase_change', {
          message: '整章重写次数已达到本章上限，将接受当前正文并跳过整章重开。',
        })
      } else if (reviewDecision === 'approve') {
        // 显式分支：用户接受当前正文，跳过 Reviser。写一条进度让这个选择在
        // 对话流里可见 —— 否则界面上「审稿完成」后直接跳到「记忆提取」，
        // 用户会以为修订环节被系统吞了。
        this.emitProgress(options, 'reviewing', 'phase_change', {
          message: '已按你的选择接受当前正文，跳过修订，直接进入落库与记忆提取。',
        })
      } else {
        /**
         * 兜底：收到不认识的决策值。
         *
         * 原来这里没有 else —— 任何非 reject/revise/rewrite 的值（undefined、
         * 拼错、前后端协议漂移）都会静默沿用 `finalContent = reviewContent`
         * 走完落库，表现和用户选了"接受"完全一样。在一个会花钱、会覆盖正文的
         * 分支上"不认识就当同意"是危险的默认。
         *
         * 这里不抛错（抛错会让整章白跑），但必须**留痕**：日志 warn + 进度事件，
         * 让异常可被发现，而不是伪装成正常路径。
         */
        this.context.logger.warn(
          { projectId, chapterNumber, reviewDecision },
          '验收检查点返回了未知决策值，按「接受当前正文」处理',
        )
        this.emitProgress(options, 'reviewing', 'phase_change', {
          message: `验收决策未能识别（${String(reviewDecision)}），已按「接受当前正文」继续。若你选择的是修订，请重试或反馈此问题。`,
          detail: { kind: 'unknown_review_decision', reviewDecision: String(reviewDecision) },
        })
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
      cancelDebug('orchestrator-catch', { projectId, chapterNumber, errMessage: message, errStack: err instanceof Error ? err.stack : undefined, signalAborted: options.signal?.aborted, errName: err instanceof Error ? err.name : typeof err })
      if (options.signal?.aborted) {
        this.emitProgress(options, 'cancelled', 'cancelled', { message: '用户已停止创作流程' })
        return { status: 'cancelled' }
      }
      this.emitProgress(options, 'error', 'error', { message })
      return { status: 'error', error: message }
    } finally {
      cancelDebug('orchestrator-finally', { projectId, chapterNumber, signalAborted: options.signal?.aborted })
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

  /**
   * 运行单个 Agent，失败时按错误性质分类重试。
   *
   * 实测 Director 有 28% 的调用失败，且全部是可重试类（502/503/超时/流被掐断），
   * 而此前外层没有任何重试 —— 一次网关抖动就废掉整个 create-flow。
   *
   * 三点设计约束：
   * 1. **重试不占 `MAX_GUARD_REWRITE` 配额**。那个配额限制的是"正文质量不合格所以重写"，
   *    与"网关 502"是两件事；混用会让几次网络抖动吃掉本该留给质量问题的重写次数。
   *    这里的重试完全在 `runAgent` 内部完成，`createChapterWithFlow` 感知不到。
   * 2. **账户类错误立即失败**并带明确文案。此前一律显示"LLM 调用失败"，
   *    用户分不清是自己欠费还是服务挂了，只会反复重试烧掉更多时间。
   * 3. **用户取消不重试**。`Request was aborted` 既来自 Provider 连接中断，
   *    也来自用户点「停止创作」，仅凭 message 无法区分，所以显式传入 signal 状态。
   */
  private async runAgent(
    agentType: NovelAgentType,
    projectId: string,
    chapterNumber: number,
    input: unknown,
    options: CreationOptions,
    overrides?: RunAgentOverrides,
  ): Promise<string> {
    const displayName = overrides?.displayAgentName ?? NOVEL_AGENT_CONFIGS[agentType].name

    // 单章成本闸门：在真正发起调用之前问，超限后不再白花一次
    await this.enforceChapterBudget(projectId, chapterNumber, options)

    let attempt = 0
    for (;;) {
      try {
        return await this.runAgentOnce(agentType, projectId, chapterNumber, input, options, overrides)
      } catch (err) {
        const classification = classifyLlmFailure(err, options.signal?.aborted === true)

        // 账户类 / 消息不成对：带上可操作的文案重新抛出，替代笼统的「LLM 调用失败」
        if (classification.userMessage) {
          this.context.logger.error(
            { agentType, projectId, chapterNumber, kind: classification.kind },
            'Agent 调用失败且不可重试',
          )
          throw new Error(classification.userMessage, { cause: err })
        }

        const delay = classification.retryable ? retryDelayMs(attempt + 1) : null
        if (delay == null) throw err

        attempt += 1
        this.context.logger.warn(
          {
            agentType,
            projectId,
            chapterNumber,
            attempt,
            maxRetries: LLM_MAX_RETRIES,
            delayMs: delay,
            err: err instanceof Error ? err.message : String(err),
          },
          'Agent 调用瞬时失败，退避后重试',
        )
        // 让用户看到"正在重试"而不是长时间静默，否则表现和卡死一样
        this.emitProgress(options, 'error', 'phase_change', {
          message: `${displayName} 调用失败（可重试），${Math.round(delay / 1000)} 秒后重试（${attempt}/${LLM_MAX_RETRIES}）...`,
        })

        await this.sleep(delay, options.signal)
        // 等待期间用户点了停止：不再重试
        if (options.signal?.aborted) throw err
      }
    }
  }

  /** 可被 signal 提前唤醒的等待 */
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
   * 单章成本闸门：超出预算时弹检查点让用户决定，而不是硬停。
   *
   * 硬停会让已经花掉的 token 全部作废，比超支更糟 —— 实测第 10 章烧了 126 万
   * 输入 token / 61 分钟，用户到那时候往往宁愿再花一点把这一章写完。
   * 所以这里只做"告知 + 给出口"：
   *   - approve：继续，且本章不再重复提示
   *   - reject：抛出取消，走既有的 cancelled 路径
   *
   * 抛错而非返回值：runAgent 被十几处调用，返回一个"要不要继续"的标记
   * 会让每个调用点都得处理一遍；用异常统一走 createChapterWithFlow 的 catch。
   */
  private async enforceChapterBudget(
    projectId: string,
    chapterNumber: number,
    options: CreationOptions,
  ): Promise<void> {
    const run = this.runStorage.getStore()
    // 没有 run context（如 finalizer 回退路径直接调 runAgent）时不设闸门
    if (!run?.budget) return
    if (!shouldPromptBudgetCheckpoint(run.budget)) return

    const evaluation = evaluateChapterBudget(run.budget)
    this.context.logger.warn(
      { projectId, chapterNumber, dimension: evaluation.dimension, ...evaluation.snapshot },
      '单章成本超出预算，弹检查点',
    )

    const decision = await options.onCheckpoint({
      type: 'chapter_budget',
      phase: 'directing',
      data: {
        chapterNumber,
        dimension: evaluation.dimension,
        message: evaluation.message,
        ...evaluation.snapshot,
      },
      options: ['approve', 'reject'],
    })

    if (decision === 'reject') {
      throw new Error('用户在成本闸门处停止了创作流程')
    }
    if (decision !== 'approve') {
      throw new Error(`成本闸门不支持决策：${String(decision)}`)
    }
    run.budget = { ...run.budget, acknowledged: true }
  }

  /** 运行单个 Agent（通过 Pi SDK Session，流式推送 delta）——单次尝试，不含重试 */
  private async runAgentOnce(
    agentType: NovelAgentType,
    projectId: string,
    chapterNumber: number,
    input: unknown,
    options: CreationOptions,
    overrides?: RunAgentOverrides,
  ): Promise<string> {
    const run = this.requireRunContext()
    const config = NOVEL_AGENT_CONFIGS[agentType]
    const identityOnly = overrides?.contextMode === 'identity_only'
    // 审计字段描述本次调用的实际可用性，而非静态角色配置。
    // identity_only 盲审会清空最终工具集，即使 Reviewer 的静态白名单含 ask_story，
    // 也不能把它记成可用，否则灰度验收会把盲审误判为一条允许工具查询的调用。
    const askStoryEnabled = !identityOnly
      && isNovelAskStoryEnabled(run.askStoryPolicy, agentType, run.factPackPathActive)
      && config.tools.includes('novel_ask_story')
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
    const editorOnly = overrides?.contextMode === 'editor'
    const needsChapterContext = !identityOnly && !editorOnly
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
    const systemPrompt = needsChapterContext
      ? this.promptBuilder.buildSystemPrompt(projectId, agentType)
      : ''

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
    // 工具可用性会改变无编排回退提示，必须进入缓存 key，避免不同角色复用错误引导。
    const sharedCacheKey = `${projectId}|${chapterNumber}|ask-story:${askStoryEnabled}`
    let sharedContext: string
    if (!needsChapterContext) {
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
        { askStoryEnabled },
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
    let suffixContext = identityOnly
      ? ''
      : this.promptBuilder.buildChapterContextSuffix(
          projectId,
          chapterNumber,
          suffixNarrativeTask,
          constraints,
          run.arrangedEntities,
          agentType,
         )
    if (agentType === 'writer' && run.directorTask?.requiredReferences?.length) {
      const writerFactPack = this.promptBuilder.buildReferenceFactPack(
        projectId,
        run.directorTask.requiredReferences,
      )
      if (writerFactPack) suffixContext += `${suffixContext ? '\n\n---\n\n' : ''}${writerFactPack}`
    }

    // DYNAMIC 层：Agent 任务指令（每次调用不同）
    // 章节上下文（SEMI 层）通过 prefixUserMessage 独立注入，不与任务拼接，
    // 确保 SEMI 层前缀跨 Agent 稳定，可被 prompt cache 命中。
    const userMessage = inputText

    // 按 Agent 类型过滤工具权限
    const allNovelTools = this.novelTools
    // 静态白名单是兼容基线；策略只派生本次运行的局部副本，绝不修改共享配置。
    const allowedToolNames = resolveNovelAgentToolNames(
      agentType,
      config.tools,
      run.askStoryPolicy,
      run.factPackPathActive,
    )
    const filteredTools = identityOnly
      ? []
      : allNovelTools.filter(t => allowedToolNames.includes(t.name))
    // 合并动态注入的额外工具（如 Reviser 的 novel_apply_revision）。
    // extraTools 不进 NOVEL_AGENT_CONFIGS.tools 白名单：白名单是静态配置，
    // 而 apply_revision 工具通过闭包持有 draft，每次调用都要重新创建。
    const finalTools = [...filteredTools, ...(overrides?.extraTools ?? [])]
    const toolNamesForLog = finalTools.map(t => t.name)

    // 记录提示词日志（STATIC + SEMI + DYNAMIC 三层）
    this.context.logger.debug(
      {
        agentType,
        agentName: config.name,
        projectId,
        chapterNumber,
        askStoryPolicy: run.askStoryPolicy,
        askStoryEnabled,
        systemPromptLength: systemPrompt.length,
        systemPromptPreview: systemPrompt.slice(0, 500),
        sharedLength: sharedContext.length,
        sharedPreview: sharedContext.slice(0, 500),
        suffixLength: suffixContext.length,
        suffixPreview: suffixContext.slice(0, 500),
        userMessageLength: userMessage.length,
        userMessagePreview: userMessage.slice(0, 500),
        toolsCount: finalTools.length,
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
    const temperature = getNovelAgentTemperature(agentType, this.context.subagentManager)

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
    // 心跳消息带 prompt 字符数：让用户在等待期间就能判断是否 prompt 过大导致延迟，
    // 便于诊断 C3 prompt 增强（audit + 派生边）是否让 prompt 膨胀过多。
    let firstTextReceived = false
    const heartbeatTimer = setInterval(() => {
      if (firstTextReceived) return
      const elapsedSec = Math.round((Date.now() - startTime) / 1000)
      this.emitProgress(options, phase, 'phase_change', {
        message: `${displayAgentName} 正在等待 LLM 响应...（已等待 ${elapsedSec}s，输入约 ${totalInputChars} 字符）`,
      })
    }, 5_000)

    // 声明在 try 块外：createAgUiSession 抛错时 finally 仍需安全清理
    let agUiSession: Awaited<ReturnType<PluginContext['createAgUiSession']>> | undefined
    let unsubscribeUsage: (() => void) | undefined
    let capturedUsage: LlmUsageSnapshot | undefined
    /**
     * 真实 payload 体积累加器。
     *
     * 每次 LLM 往返触发一次。**累加而不是取最后一次**：工具调用会让一次
     * Agent 调用变成多次往返，每次都重发完整历史，累加值才是这次调用真正
     * 送出去的总量 —— 也正是 inputTokens 的来源。
     */
    const payloadStats = { messagesChars: 0, toolsChars: 0, toolCount: 0, totalChars: 0, roundTrips: 0 }

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
        // 同一章的 Director / Writer / Reviewer 共享 system + shared 前缀，
        // 必须给同一个缓存路由键，否则各自被导到不同机器，前缀白建。
        promptCacheScope: `novel:${projectId}:${chapterNumber}`,
        userMessage,
        tools: finalTools,
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
        onPayloadStats: (stats) => {
          payloadStats.roundTrips += 1
          payloadStats.messagesChars += stats.messagesChars
          payloadStats.toolsChars += stats.toolsChars
          payloadStats.totalChars += stats.totalChars
          // 工具个数不累加：取最大值即可（每次往返带的是同一套工具）
          payloadStats.toolCount = Math.max(payloadStats.toolCount, stats.toolCount)
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

      logResult = overrides?.augmentLogResult ? overrides.augmentLogResult(result) : result
      options.onConversationMessage?.({
        role: 'agent',
        fromId: config.id,
        fromName: displayAgentName,
        content: result,
        phase: phase === 'directing' ? 'pre_creation' : 'review',
        metadata: {
          agentType: displayAgentType,
          workflowMessageType: 'agent',
        },
      })
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

      // 累计单章成本。放在 finally：失败的调用同样烧了 token 与时间，
      // 只统计成功调用会让闸门低估实际开销（Director 实测 28% 失败率）。
      const runForBudget = this.runStorage.getStore()
      if (runForBudget?.budget) {
        runForBudget.budget = recordLlmCall(runForBudget.budget, usageForLog?.inputTokens ?? 0)
      }

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
          tools: finalTools.map(t => ({ name: t.name, description: t.description })),
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
          payloadMessagesChars: payloadStats.messagesChars,
          payloadToolsChars: payloadStats.toolsChars,
          payloadToolCount: payloadStats.toolCount,
          payloadTotalChars: payloadStats.totalChars,
          llmRoundTrips: payloadStats.roundTrips,
          askStoryPolicy: run.askStoryPolicy,
          askStoryEnabled,
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
            tools: JSON.stringify(finalTools.map(t => ({ name: t.name, description: t.description }))),
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
              askStoryPolicy: run.askStoryPolicy,
              askStoryEnabled,
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
   * 把 Reviewer 通过 novel_submit_review 工具提交的结构化验收报告格式化为可读文本，
   * 作为 Reviser 的"审稿意见"注入。
   *
   * 背景：Reviewer 工具化后，raw 文本输出（reviewResult）只剩推理过程/客套话，
   * 真正的 issues/suggestions/verdict/scores 在 reviewDraft.review 里。旧代码只传
   * reviewResult 给 Reviser，导致 Reviser 看不到具体问题清单，"修订"变成无的放矢。
   *
   * 未调用工具（review 为 undefined）时回退为提示文本，让 Reviser 知道结构化报告缺失，
   * 只能参考下方的"Reviewer 分析过程"段落。
   */
  private formatReviewReportForReviser(
    review: ReviewDraftHolder['review'],
  ): string {
    if (!review) {
      return '## 结构化审稿报告\n\n（Reviewer 未调用 novel_submit_review 工具提交结构化报告，请参考下方"Reviewer 分析过程"段落自行提取修订要点。）'
    }
    const lines: string[] = ['## 结构化审稿报告（Reviewer 通过工具提交，这是修订的主要依据）', '']
    // 结论
    const verdictLabel = review.verdict === 'accept' ? '通过'
      : review.verdict === 'revise' ? '需修订'
      : review.verdict === 'reject' ? '需重写'
      : review.verdict ?? '（未提供）'
    lines.push(`- 验收结论：${verdictLabel}`)
    if (review.overallScore != null) lines.push(`- 总体评分：${review.overallScore}/10`)
    // 十维评分（只输出有值的）
    const scores: Array<[number | null | undefined, string]> = [
      [review.consistencyScore, '一致性'],
      [review.characterScore, '角色'],
      [review.taskCompletionScore, '任务完成'],
      [review.clueProgressScore, '线索推进'],
      [review.foreshadowStatusScore, '伏笔状态'],
      [review.conflictChangeScore, '冲突变化'],
      [review.pacingScore, '节奏'],
      [review.infoControlScore, '信息控制'],
      [review.readerHookScore, '读者钩子'],
      [review.styleScore, '文风'],
    ]
    const scoreParts = scores
      .filter(([v]) => v != null)
      .map(([v, label]) => `${label}=${v}`)
    if (scoreParts.length > 0) {
      lines.push(`- 十维评分：${scoreParts.join(' / ')}`)
    }
    // 问题清单（核心：Reviser 据此定位修订点）
    let issues: Array<{ severity?: string; category?: string; description?: string; location?: string }> = []
    try {
      const parsed = JSON.parse(review.issues ?? '[]')
      if (Array.isArray(parsed)) issues = parsed
    } catch { /* 旧数据可能不是 JSON */ }
    if (issues.length > 0) {
      lines.push('')
      lines.push('### 问题清单（按严重度排序，S1 最致命，必须优先修复）')
      // S1 > S2 > S3 > S4
      const severityOrder: Record<string, number> = { S1: 0, S2: 1, S3: 2, S4: 3 }
      const sorted = [...issues].sort((a, b) =>
        (severityOrder[a.severity ?? ''] ?? 99) - (severityOrder[b.severity ?? ''] ?? 99))
      for (const issue of sorted) {
        const tags: string[] = []
        if (issue.severity) tags.push(issue.severity)
        if (issue.category) tags.push(issue.category)
        const tagStr = tags.length > 0 ? `【${tags.join('|')}】` : ''
        const loc = issue.location ? `（位置：${issue.location}）` : ''
        lines.push(`- ${tagStr}${issue.description ?? '(无描述)'}${loc}`)
      }
    } else {
      lines.push('')
      lines.push('### 问题清单\n（空，Reviewer 未提交具体问题）')
    }
    // 修改建议
    let suggestions: string[] = []
    try {
      const parsed = JSON.parse(review.suggestions ?? '[]')
      if (Array.isArray(parsed)) suggestions = parsed.filter((s): s is string => typeof s === 'string')
    } catch { /* 旧数据可能不是 JSON */ }
    if (suggestions.length > 0) {
      lines.push('')
      lines.push('### 修改建议')
      suggestions.forEach((s, i) => lines.push(`${i + 1}. ${s}`))
    }
    return lines.join('\n')
  }

  /**
   * 把 Reviser 通过 novel_apply_revision 工具应用后的修订结果（draft.content）
   * 追加到 reviser 的 agent_log.result 字段。
   *
   * 背景：工具化后 reviser 的 raw 文本输出（reviseResult）只是"我已应用 N 处修订"，
   * 真正的修订后正文在 draft.content 里（通过工具闭包更新）。不追加的话 agent_log
   * 看不到修订结果，用户无法在日志面板审查修订后的正文，"修订"过程不可审计。
   *
   * 返回值会覆盖 runAgent finally 块里写入 agent_log 的 logResult 字段，
   * 但不影响 runAgent 的返回值（调用方拿到的仍是 raw result）。
   */
  private augmentReviserLogResult(raw: string, draft: RevisionDraftHolder): string {
    const successful = draft.appliedPatches.filter(p => p.success)
    const failed = draft.appliedPatches.filter(p => !p.success)
    const parts: string[] = [raw, '', '---', '', '## 修订后正文（draft.content，由 novel_apply_revision 工具应用）', '', draft.content, '', '---', '', '## 修订统计', '']
    parts.push(`- 成功应用：${successful.length} 处`)
    parts.push(`- 定位失败：${failed.length} 处`)
    if (failed.length > 0) {
      parts.push('', '### 失败的 patch（原文片段未在章节中找到）')
      failed.forEach((p, i) => {
        const preview = p.from.length > 60 ? p.from.slice(0, 60) + '...' : p.from
        parts.push(`${i + 1}. "${preview}"`)
      })
    }
    return parts.join('\n')
  }

  /**
   * parseDirectorTask 已被 novel_submit_narrative_task 工具化方案替代。
   *
   * 旧方案让 Director 输出 Markdown 自由文本，再用 18 处正则提取字段：
   * - 任务类型（advance_mainline/create_suspense 等 14 种枚举）
   * - 优先级、悬念持续章数、冲突强度变化
   * - 次要任务段落、章尾钩子设计段落
   * - POV 角色列表、场景数、章节六型定位、时间线偏移
   *
   * LLM 不严格遵守格式时正则解析失败，降级到默认值，Director 的真实意图丢失。
   *
   * 新方案：Director 必须调用 novel_submit_narrative_task 工具提交结构化对象，
   * 工具参数 schema（SubmitNarrativeTaskParams）强制校验，orchestrator 直接读取
   * draft.task 作为 NarrativeTask，完全绕开正则解析。
   */

  private requireRunContext(): CreationRunContext {
    const run = this.runStorage.getStore()
    if (!run) throw new Error('create-flow 运行上下文不存在')
    return run
  }

  private runKey(projectId: string, chapterNumber: number): string {
    return `${projectId}|${chapterNumber}`
  }
}
