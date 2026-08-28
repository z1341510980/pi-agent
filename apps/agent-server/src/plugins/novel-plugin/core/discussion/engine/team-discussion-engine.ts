/**
 * TeamDiscussionEngine：通用群聊引擎
 *
 * 驱动群聊循环：Director 规划 → 动作图驱动角色演出 → Writer 编织。
 * 不依赖任何业务领域（不知道"小说"是什么）。
 *
 * 循环阶段：
 * 1. planning：引擎直呼 Director，工具提交结构化场景计划（含动作图）即完成
 * 2. acting（场景循环）：动作节点驱动角色演出，剧本记录到 history，不即时编织
 * 3. chapter_weaving：Writer 一次性整合所有场景剧本为完整章节正文
 *
 * 设计要点：
 * - Writer 只在 Phase 3 触发 1 次，避免逐场景编织导致的多次触发和风格割裂。
 * - planning 不经 Moderator（2026-08-28 控制平面重排）：该阶段决策空间只有一个选项
 *   （只能点 Director），LLM 往返无信息增益，只贡献延迟与失败面。详见 runPlanning。
 *
 * 死锁防护：
 * - planning 尝试次数 ≤ 3（runPlanning 内固定上限）
 * - 单场景轮数 ≤ MAX_ROUNDS_PER_SCENE(10)
 * - 连续 observe ≤ MAX_OBSERVE_ROUNDS(3)（仅 legacy acting）
 * - 任一超限 → 强制收敛
 */

import type { FastifyBaseLogger } from 'fastify'
import type { AgUiSessionHandle } from '../../../../../core/plugin/plugin-types.js'
import type { PluginSessionOptions } from '../../../../../core/plugin/plugin-types.js'
import type { AgUiEventSink } from '@repo/protocol/events'
import { AgentChannel } from '../../../../../core/agent/agent-channel.js'
import { runToolPayloadStep, throwIfAborted } from './step-executor.js'
import {
  ACTING_POLICY,
  createSceneActingReport,
  decideWeaveGate,
  summarizeActing,
  buildWriterQualityContract,
  type SceneActingReport,
  type ActingSummary,
} from './acting-policy.js'
import type {
  DiscussionGoal,
  DiscussionInterjectMessage,
  DiscussionMember,
  DiscussionMessage,
  DiscussionOptions,
  DiscussionResult,
  DiscussionFlowEvent,
  SceneDefinition,
  SceneActionBeat,
  CharacterTurn,
  DiscussionPhase,
  DiscussionResumeState,
  ReviewerOutcome,
  ScenePlanToolset,
  SubmittedSceneInput,
  DiscussionDiagnostics,
  CharacterTurnToolset,
} from './discussion-types.js'
import { DISCUSSION_LIMITS } from './discussion-types.js'

/** 引擎上下文：提供 createAgUiSession 工厂 + 日志 */
export interface EngineContext {
  createAgUiSession(options: {
    systemPrompt: string
    prefixUserMessage?: string | string[]
    userMessage: string
    tools?: unknown[]
    signal?: AbortSignal
    temperature?: number
    timeoutMs?: number
    /** 成员配置的 modelId（透传给底层 createAgUiSession） */
    modelId?: PluginSessionOptions['modelId']
    /** 显式授权给本次成员会话的 Skill（/skill: 展开提供角色方法） */
    skill?: { name: string; path: string }
    emit: AgUiEventSink
    emitRaw?: boolean
    onFirstText?: () => void
    /** 每次 provider 请求的真实 payload 体积计量（只读，不改 payload） */
    onPayloadStats?: (stats: {
      messagesChars: number
      toolsChars: number
      toolCount: number
      totalChars: number
    }) => void
  }): Promise<AgUiSessionHandle>
  logger: FastifyBaseLogger
}

export class TeamDiscussionEngine {
  /** 当前讨论目标，用于给每个成员注入共享上下文 */
  private currentGoal?: DiscussionGoal

  /**
   * 用户插话队列（对话化交互形态 §3.1，实例级）：
   * 由端点经 enqueueUserMessage 入队，planning/编织阶段 drain 写入 history。
   */
  private interjectQueue: DiscussionInterjectMessage[] = []

  /**
   * 插话存活标记：run/resumeChapterWeaving 的 finally 收尾（含 dropped flush）
   * 前置 false，之后 enqueueUserMessage 拒绝受理并返回 false。插话端点在
   * 取到投递闭包与实际调用之间引擎可能刚好收尾（TOCTOU 微窗口），若仍入队
   * 只会进入无人 drain 的死队列，SSE 状态永远停在 queued。构造即置 true：
   * runner 在 engine.run 调用前就登记投递闭包，run 启动前入队的插话会在
   * planning 首轮被 drain。
   */
  private acceptingInterjects = true

  /**
   * 最近一次编织的台词复用率（P1-2）：由 ensureTranscriptFidelity 写入，
   * run() 在编织完成后并入 diagnostics.transcriptReuseRate。undefined 表示未检测
   * （盲写降级或无推演台词）。
   */
  private transcriptReuseRate?: number

  /**
   * 当前推演场景（P1-4a）：runSceneLoop 每进入一个场景时设置，循环结束后清除。
   * 供 invokeMember 给角色成员常驻注入场景契约，避免场景信息随 10 条滑动窗口滑出。
   */
  private currentScene?: SceneDefinition

  /** 当前角色回合工具集；仅在一次 actor 调用期间有效。 */
  private currentCharacterTurn?: CharacterTurnToolset

  /** 当前自主演出产生的待回应角色，按因果顺序 FIFO 执行。 */
  private pendingCharacterMentions: Array<{ targetId: string; sourceMessageId: string; depth: number }> = []

  /** 正常自主角色逻辑回合计数。 */
  private autonomousCharacterTurns = 0

  /** 角色主动 mention 计数。 */
  private autonomousMentions = 0

  /** 新动作图场景完成的节点数，用于诊断与收敛判断。 */
  private completedActionBeats = 0

  /** 当前 run 的诊断计数（Moderator 已删除，仅保留角色侧统计）。 */
  private characterTurnFailures = 0
  private characterTurnCancelled = 0
  private currentActionBeatId?: string
  private currentActionBeatSceneId?: number
  private totalMemberInvocations = 0
  private totalLlmRoundTrips = 0
  private runStartedAt = 0

  /** planning 阶段 Director 的逻辑调用次数（含纠正性重试与检查点后重试）。 */
  private plannerInvocations = 0

  constructor(
    private channel: AgentChannel,
    private context: EngineContext,
  ) {}

  /**
   * 用户插话入队（append 语义）：flow 运行中随时可调用，
   * 消息在 planning 首轮或编织前以 user 角色追加进群聊 history。
   * 返回 false 表示引擎已收尾（队列已 flush），消息未入队，调用方应拒绝受理。
   */
  enqueueUserMessage(msg: DiscussionInterjectMessage): boolean {
    if (!this.acceptingInterjects) return false
    this.interjectQueue.push({ ...msg })
    return true
  }

  async run(
    goal: DiscussionGoal,
    members: DiscussionMember[],
    options: DiscussionOptions,
  ): Promise<DiscussionResult> {
    this.runStartedAt = Date.now()
    // 合并运行时限制：options.limits（来自 DiscussionSettingsStore）覆盖默认 DISCUSSION_LIMITS。
    // maxRounds 自 2026-08-28 起不再被读取：planning 有固定尝试上限，
    // acting 预算按 beat/reaction 计数（见 ACTING_POLICY），不再消耗全局轮数。
    const limits = {
      maxRoundsPerScene: options.limits?.maxRoundsPerScene ?? DISCUSSION_LIMITS.MAX_ROUNDS_PER_SCENE,
      maxObserveRounds: DISCUSSION_LIMITS.MAX_OBSERVE_ROUNDS,
      characterTemperature: options.limits?.characterTemperature ?? 0.8,
    }

    const history: DiscussionMessage[] = []
    const channelName = `discuss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // 订阅所有成员到群聊频道
    for (const member of members) {
      this.channel.subscribe(channelName, member.id)
    }

    // 只把目标写入可增长的群聊历史。完整章节上下文由 invokeMember 作为
    // prefixUserMessage 单独注入；若同时写入 history，首轮 userMessage 会重复
    // 一整份上下文，既浪费 token，也让动态消息吞掉缓存收益。
    history.push(this.systemMessage(`目标：${goal.task}`))

    let scenes: SceneDefinition[] = []
    let finalContent = ''
    let chapterConvergerId: string | undefined
    // 阶段/场景追踪：失败时生成 failedPhase + failedSceneId（acting 断点续跑定位）
    const track: { phase: DiscussionPhase; sceneId?: number } = { phase: 'planning' }
    // 演出链路诊断（2026-08-24）：让"演出是否真的发生"成为可查询数据
    this.transcriptReuseRate = undefined
    this.plannerInvocations = 0
    this.currentCharacterTurn = undefined
    this.pendingCharacterMentions = []
    this.autonomousCharacterTurns = 0
    this.autonomousMentions = 0
    this.completedActionBeats = 0
    this.characterTurnFailures = 0
    this.characterTurnCancelled = 0
    this.currentActionBeatId = undefined
    this.currentActionBeatSceneId = undefined
    this.totalMemberInvocations = 0
    this.totalLlmRoundTrips = 0
    let planningRetries = 0
    let sceneSource: DiscussionDiagnostics['sceneSource'] = 'none'
    // 场景计划工具集：业务层提供时，Director 规划调用会挂载 novel_submit_scene_plan，
    // 引擎直呼后直接读取工具提交结果，Markdown 解析降级为回退。
    const scenePlan = options.buildScenePlanToolset?.()

    try {
      // 记录当前目标，供 invokeMember 注入成员 prefixUserMessage
      this.currentGoal = goal

      // ── Phase 1：规划（引擎直呼 Director，不经 Moderator）──
      const planning = await this.runPlanning({
        goal,
        members,
        history,
        options,
        channelName,
        scenePlan,
      })
      scenes = planning.scenes
      sceneSource = planning.source
      planningRetries = planning.retries
      chapterConvergerId = members.find(member => member.canConverge)?.id

      // ── Phase 2：场景循环（如有场景）—— 角色推演，不即时编织 ──
      // 设计变更：场景循环只让角色对戏推演，剧本记录到 history，不触发 weaveScene。
      // 所有场景推演完毕后，Phase 3 的 weaveChapter 一次性整合全章剧本为正文。
      // 这样 Writer 只触发 1 次，避免多次触发导致的风格割裂和 token 浪费。
      let actingReports: SceneActingReport[] = []
      if (scenes.length > 0) {
        actingReports = await this.runSceneLoop({
          goal,
          members,
          history,
          scenes,
          options,
          limits: {
            maxRoundsPerScene: limits.maxRoundsPerScene,
            maxObserveRounds: limits.maxObserveRounds,
          },
          channelName,
          startIndex: 0,
          track,
        })
      }

      // ── Phase 2.5：演出产出闸门（2026-08-28 改为策略表判定）──
      //
      // 旧路径有两道硬闸：任一场景零演出即 throw、scenes=[] 即 throw。
      // 结果是一次角色回合抖动能让整章作废，已有演出全部丢弃。
      // 现在按全章汇总判断：有场景演成了就继续（缺口写进 Writer 质量契约），
      // 一场都没演成才停下问用户——那才是真正需要人介入的情况。
      const actingSummary = summarizeActing(actingReports)
      const diagnostics = this.buildDiagnosticsSnapshot({
        sceneSource,
        scenes,
        history,
        members,
        planningRetries,
        actingSummary,
      })
      const writerContract = buildWriterQualityContract(actingReports, scenes)
      if (actingSummary.barrenSceneIds.length > 0) {
        const detail = actingSummary.barrenSceneIds
          .map(sceneId => `场景${sceneId}`)
          .join('、')
        this.emitProgress(options, 'chapter_weaving', {
          type: 'phase_change',
          data: { message: `⚠️ ${detail}未产生角色推演，编织时将绕开这些场景的缺口。` },
        })
      }

      if (decideWeaveGate(actingSummary) === 'ask_user') {
        // 闸门属于编织前置判断：失败阶段记为 chapter_weaving，
        // 这样断点续跑会从编织重来，而不是重演已经确认失败的 acting。
        track.phase = 'chapter_weaving'
        const reply = await this.askWeaveGateDecision(scenes.length, options, history)
        if (reply !== 'approve') {
          throw new Error(
            scenes.length === 0
              ? '群聊没有产生可用场景，用户选择中止'
              : '群聊没有任何场景产生有效角色演出，用户选择中止',
          )
        }
      }

      // ── Phase 3：全章编织（一次性整合所有场景剧本）──
      track.phase = 'chapter_weaving'
      this.emitProgress(options, 'chapter_weaving', { type: 'phase_change', data: { message: '正在编织完整章节' } })
      finalContent = await this.weaveChapter(
        members, history, scenes, goal, options, chapterConvergerId, writerContract,
      )
      // P1-2：编织完成后回填台词复用率（weaveChapter 内部经 ensureTranscriptFidelity 写入）
      diagnostics.transcriptReuseRate = this.transcriptReuseRate
      this.recordWriterOutput(members, history, finalContent)

      // ── Phase 4：最终正文质量门 ──
      track.phase = 'reviewing'
      const qualityResult = await this.reviewFinalChapter(finalContent, members, history, options, goal.targetWords)
      if (qualityResult.status === 'cancelled') {
        return { status: 'cancelled', transcript: history, scenes, review: qualityResult.review, diagnostics }
      }
      finalContent = qualityResult.content

      return {
        status: 'completed',
        content: finalContent,
        transcript: history,
        scenes,
        review: qualityResult.review,
        diagnostics,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.context.logger.error({ err }, '群聊引擎异常')
      if (options.signal?.aborted) {
        return {
          status: 'cancelled',
          content: finalContent || undefined,
          transcript: history,
          scenes,
          diagnostics: this.buildDiagnosticsSnapshot({ sceneSource, scenes, history, members, planningRetries }),
        }
      }
      return {
        status: 'error',
        error: message,
        failedPhase: track.phase,
        failedSceneId: this.sceneIdForFailure(track),
        // acting 中断必须带上动作节点位置，否则续跑只能整场重演。
        // resumeSceneActing 早已返回该字段，首跑漏了同一口径。
        failedActionBeatId: this.currentActionBeatSceneId === track.sceneId
          ? this.currentActionBeatId
          : undefined,
        content: finalContent || undefined,
        transcript: history,
        scenes,
        diagnostics: this.buildDiagnosticsSnapshot({ sceneSource, scenes, history, members, planningRetries }),
      }
    } finally {
      // 先关闭插话通道再收尾：收尾期间（dropped flush 等）新到插话直接拒绝，
      // 不进入无人消费的死队列。
      this.acceptingInterjects = false
      this.currentActionBeatId = undefined
      this.currentActionBeatSceneId = undefined
      for (const member of members) {
        this.channel.unsubscribe(channelName, member.id)
      }
      // 插话收尾（§3.1）：flow 终态（正常/异常/取消）时仍未被 Moderator 消费的
      // 插话以 dropped 回调暴露，不静默丢失。
      this.flushInterjectDropped(options)
    }
  }

  /** 推演阶段失败时的中断场景 ID（非推演阶段返回 undefined） */
  private sceneIdForFailure(track: { phase: DiscussionPhase; sceneId?: number }): number | undefined {
    return track.phase === 'acting' || track.phase === 'scene_setup' ? track.sceneId : undefined
  }

  /**
   * Phase 1 规划：引擎直呼 Director（2026-08-28 控制平面重排 T1）。
   *
   * ⚠️ 为什么删掉 Moderator 循环：
   * 旧路径每轮先 `moderator.decide()` 再 `handleDecision` 邀请 Director，但 Moderator
   * 在 planning 被 `enforceDecision` 与 `handleDecision` 双重限制为"只能点 Director"——
   * 决策空间只有一个选项，这次 LLM 往返没有任何信息增益，只贡献延迟（session-diag 实测
   * 单次 10.9–26.2s）与失败面（双次重试 + 90s 超时 + 解析失败降级）。库内 maxRounds=50
   * 意味着最坏情况白付 50 次。现在改为：引擎直接调 Director，工具 payload 即完成信号。
   *
   * 收敛路径（每一步都有确定性出口，不依赖 LLM 决定"下一步做什么"）：
   *   直呼 Director → 有工具 payload 则完成（终答为空也算完成）
   *                 → 无 payload 但文本可解析则 Markdown 回退（显式告警）
   *                 → 有文本但不可解析：纠正性重试一次，仍不可解析则交出空计划，
   *                   由 Phase 2.5 闸门决定（严格模式阻断盲写 / legacy 模式告警后盲写）
   *                 → 完全没有产出（空响应或调用失败）：重试；连续两次仍无产出则抛检查点
   *                   （approve=再来一轮 / reject=中止），因为这更可能是模型异常而非格式问题
   */
  private async runPlanning(params: {
    goal: DiscussionGoal
    members: DiscussionMember[]
    history: DiscussionMessage[]
    options: DiscussionOptions
    channelName: string
    scenePlan?: ScenePlanToolset
  }): Promise<{
    scenes: SceneDefinition[]
    source: DiscussionDiagnostics['sceneSource']
    retries: number
  }> {
    const { members, history, options, channelName, scenePlan } = params
    const director = this.findDirector(members)
    if (!director) {
      throw new Error('群聊缺少 Director 成员，无法进行场景规划')
    }

    // 调用预算：Director 最多被调用这么多次（含所有重试与检查点后重试）。
    // 与旧路径的 maxRounds(库内 50) 相比是硬收紧：规划要么在三次内产出可用计划，
    // 要么就是模型或提示词有问题，继续烧调用不会变好。
    const maxInvocations = 3
    let retries = 0
    // 连续"完全无产出"计数；拿到任何文本即清零。
    let consecutiveBarren = 0
    // 不可解析文本只给一次纠正机会：模型在输出但格式不对，多轮重试的边际收益很低。
    let textRetryUsed = false

    for (let attempt = 1; attempt <= maxInvocations; attempt++) {
      // 插话 drain（§3.1）：Director 看到本轮 history 前把用户中途反馈以 user 角色追加。
      this.drainInterjectQueue(history, options)

      let text = ''
      let payload: { scenes: SubmittedSceneInput[] } | null = null
      let emptyFinalAnswer = false
      try {
        const outcome = await runToolPayloadStep<{ scenes: SubmittedSceneInput[] }>({
          kind: 'planning:director',
          signal: options.signal,
          logger: this.context.logger,
          invoke: async () => {
            this.plannerInvocations++
            return this.invokeMember(
              director,
              attempt === 1
                ? this.buildDirectorPlanningPrompt()
                : this.buildDirectorPlanningRetryPrompt(),
              history,
              options,
              { phase: 'planning', extraTools: scenePlan?.tools },
            )
          },
          extract: () => scenePlan?.extractResult() ?? null,
        })
        text = outcome.text
        payload = outcome.payload
        emptyFinalAnswer = outcome.emptyFinalAnswer
      } catch (err) {
        // 取消必须原样抛出：run 的 catch 据此返回 cancelled 并保留已有产物。
        if (options.signal?.aborted) throw err
        // Director 调用失败（provider 报错/超时）：记入 transcript，按"无产出"继续判定，
        // 不直接终止 run —— 一次抖动不该让整章创作作废。
        const errMsg = err instanceof Error ? err.message : String(err)
        history.push(this.errorMessage(`${director.name} 规划失败：${errMsg}`))
        this.emitProgress(options, 'planning', {
          type: 'phase_change',
          data: { message: `⚠️ 导演规划调用失败：${errMsg}` },
        })
      }

      // 工具主路径：payload 即完成信号。终答为空也照样采用（gpt-5.6-luna 实证行为），
      // 并把工具参数完整格式化进 transcript + 气泡，前端不会只看到一个空占位。
      if (payload && payload.scenes.length > 0) {
        const content = this.formatSubmittedScenePlan(payload.scenes)
        this.appendDirectorPlanMessage(director, content, history, channelName, options, emptyFinalAnswer)
        const scenes = this.toSceneDefinitions(payload.scenes, members)
        this.emitProgress(options, 'planning', {
          type: 'phase_change',
          data: { message: `✅ 场景计划已提交，进入演出（共 ${scenes.length} 个场景）` },
        })
        this.applyCastWhitelist(scenes, history, options, members)
        await this.resolveSceneCharacters(scenes, members, options, channelName)
        return { scenes, source: 'tool', retries }
      }

      const hasText = text.trim().length > 0
      if (hasText) {
        consecutiveBarren = 0
        // Markdown 回退：工具没提交但文本能解析。保留兼容，但必须显式告警——
        // 这条路径的场景没有 actionBeats，严格模式会在 acting 入口拒绝。
        this.appendDirectorPlanMessage(director, text, history, channelName, options, false)
        const markdownScenes = this.parseScenes(history, members)
        if (markdownScenes.length > 0) {
          this.emitProgress(options, 'planning', {
            type: 'phase_change',
            data: { message: '⚠️ Director 未通过工具提交场景计划，已回退文本解析；格式不符时演出阶段可能不完整。' },
          })
          this.applyCastWhitelist(markdownScenes, history, options, members)
          await this.resolveSceneCharacters(markdownScenes, members, options, channelName)
          return { scenes: markdownScenes, source: 'markdown', retries }
        }
      } else {
        consecutiveBarren++
      }

      const canRetry = attempt < maxInvocations

      // 连续两轮完全没有产出：更像模型异常而非格式问题，交用户决策。
      if (consecutiveBarren >= 2 && canRetry) {
        history.push(this.systemMessage('导演连续两轮未产出内容（模型可能异常），等待用户决策。'))
        const reply = await options.onCheckpoint({
          type: 'discussion_pause',
          phase: 'planning',
          question:
            '导演连续两轮未产出任何内容（模型可能异常或输出预算耗尽）。可重试导演规划，或中止本次群聊（中止后可对同章改用标准工作流创作）。',
          data: {
            message: '导演连续两轮未产出任何内容（模型可能异常或输出预算耗尽）。',
            choices: ['重试导演规划', '中止群聊'],
          },
          options: ['approve', 'reject'],
        })
        history.push({
          id: `user-checkpoint-${Date.now()}`,
          fromId: 'user',
          fromName: '用户',
          content: typeof reply === 'string' ? reply : '已决策',
          timestamp: Date.now(),
          type: 'user',
        })
        if (reply !== 'approve') {
          throw new Error('导演未能产出场景拆分，用户选择中止群聊')
        }
        consecutiveBarren = 0
        retries++
        continue
      }

      // 不可解析文本只重试一次；用完就交出空计划，让下游闸门决定阻断还是降级。
      if (hasText && textRetryUsed) break
      if (!canRetry) break

      if (hasText) textRetryUsed = true
      retries++
      history.push(this.moderatorMessage(
        hasText
          ? `@${director.name} 你的场景拆分无法被系统读取：既没有调用 novel_submit_scene_plan 工具，文本输出也不符合可解析格式。请立即调用 novel_submit_scene_plan 工具，按顺序提交每个场景的标题、地点、时间、冲突、目标、情绪和在场角色。`
          : `@${director.name} 你上一条回复没有任何内容，系统无法读取场景拆分。请立即调用 novel_submit_scene_plan 工具提交本章场景拆分。`,
      ))
      this.emitProgress(options, 'planning', {
        type: 'phase_change',
        data: { message: '⚠️ 导演未产出可用的场景计划，已发起纠正性重试' },
      })
    }

    // 预算用尽仍无可用计划：返回空计划。是否允许盲写由 Phase 2.5 闸门按
    // allowLegacyActing 决定，规划阶段不在这里替下游做判断。
    return { scenes: [], source: 'none', retries }
  }

  /** Director 成员定位（id 精确匹配优先，兼容 `*director*` 命名）。 */
  private findDirector(members: DiscussionMember[]): DiscussionMember | undefined {
    return members.find(member =>
      member.type === 'role' && (member.id === 'novel-director' || member.id.includes('director')),
    )
  }

  private buildDirectorPlanningPrompt(): string {
    return '请完成本章的场景拆分规划：调用 novel_submit_scene_plan 工具提交每个场景的标题、地点、时间、冲突、目标、情绪、在场角色，以及按因果顺序排列的戏剧动作节点（actionBeats）。工具参数会强制校验结构，不要在文本里重复完整计划。'
  }

  private buildDirectorPlanningRetryPrompt(): string {
    return '上一次输出没有生成可用的场景计划。请立即调用 novel_submit_scene_plan 工具提交本章场景拆分（每个场景含标题/地点/时间/冲突/目标/情绪/在场角色 + actionBeats）；若确实无法调用工具，才在文本中按 `### 场景N：标题` 格式输出完整场景列表，不要输出空内容。'
  }

  /**
   * Director 计划入 transcript + 实时气泡。
   *
   * 工具主路径终答为空时不会有 TEXT_MESSAGE_*，前端的 agent_start 占位气泡没人关闭；
   * 这里补发 agent_output 让前端覆盖占位（详见 use-novel-creation-flow 的占位覆盖逻辑）。
   */
  private appendDirectorPlanMessage(
    director: DiscussionMember,
    content: string,
    history: DiscussionMessage[],
    channelName: string,
    options: DiscussionOptions,
    emptyFinalAnswer: boolean,
  ): void {
    const message: DiscussionMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fromId: director.id,
      fromName: director.name,
      content,
      timestamp: Date.now(),
      type: 'member',
    }
    history.push(message)
    this.channel.broadcast(channelName, director.id, message)
    if (emptyFinalAnswer) {
      this.emitProgress(options, 'planning', {
        type: 'phase_change',
        data: { message: '✅ 导演已通过工具提交场景计划（终答为空，已直接采用工具结果）' },
      })
    }
    this.emitProgress(options, 'planning', {
      type: 'agent_output',
      data: { agentType: 'director', agentName: director.name, content },
    })
  }

  /**
   * 编织闸门检查点：一场都没演成时问用户，而不是静默盲写或直接失败。
   *
   * 盲写在这种情况下等于让 Writer 凭场景契约编造整章，与"群聊共创"的前提相悖；
   * 但直接失败会丢掉用户已经等待的时间与已有 transcript。交给用户判断最合适。
   */
  private async askWeaveGateDecision(
    sceneCount: number,
    options: DiscussionOptions,
    history: DiscussionMessage[],
  ): Promise<string> {
    const question = sceneCount === 0
      ? '导演没有产出可用场景，群聊无法进入演出。可继续让 Writer 按章节上下文直接成文（等同标准工作流），或中止本次群聊。'
      : '所有场景都没有产生有效的角色演出。可继续让 Writer 按场景契约成文（此时正文由 Writer 独立完成，不含角色对戏），或中止本次群聊改用标准工作流。'
    history.push(this.systemMessage(`【降级】${question}`))
    this.emitProgress(options, 'chapter_weaving', {
      type: 'phase_change',
      data: { message: `⚠️ 盲写降级确认：${question}` },
    })
    const reply = await options.onCheckpoint({
      type: 'discussion_pause',
      phase: 'chapter_weaving',
      question,
      data: { message: question, choices: ['继续编织（Writer 独立成文）', '中止群聊'] },
      options: ['approve', 'reject'],
    })
    history.push({
      id: `user-weave-gate-${Date.now()}`,
      fromId: 'user',
      fromName: '用户',
      content: typeof reply === 'string' ? reply : '已决策',
      timestamp: Date.now(),
      type: 'user',
    })
    return typeof reply === 'string' ? reply : String(reply)
  }

  /**
   * 场景推演循环（run 与 acting/scene_setup 断点续跑共用）。
   *
   * 从 startIndex 场景开始推演（续跑时中断场景重演该场景的轮次，已完成场景
   * 的剧本已在 history）。track.phase/track.sceneId 由调用方持有：失败时据此
   * 生成 failedPhase/failedSceneId 供下次断点定位。
   *
   * 返回每个场景的演出账目，供 Phase 2.5 闸门与 Writer 质量契约使用。
   */
  private async runSceneLoop(params: {
    goal: DiscussionGoal
    members: DiscussionMember[]
    history: DiscussionMessage[]
    scenes: SceneDefinition[]
    options: DiscussionOptions
    limits: { maxRoundsPerScene: number; maxObserveRounds: number }
    channelName: string
    startIndex: number
    track: { phase: DiscussionPhase; sceneId?: number }
    /** 断点续跑保留旧收敛语义，不额外补齐历史快照中未发言角色。 */
    enforceCastCoverage?: boolean
    /** acting 中断时从该场景的指定动作节点之后继续。 */
    failedActionBeatId?: string
  }): Promise<SceneActingReport[]> {
    const { goal, members, history, scenes, options, limits, channelName, startIndex, track } = params
    const reports: SceneActingReport[] = []
    for (let i = startIndex; i < scenes.length; i++) {
      const scene = scenes[i]
      let rounds = 0
      let noProgressRounds = 0

      track.sceneId = scene.sceneId
      track.phase = 'scene_setup'
      // P1-4a：记录当前场景，供 invokeMember 给角色常驻注入场景契约
      this.currentScene = scene
      history.push(this.systemMessage(this.buildSceneContext(scene)))
      this.emitProgress(options, 'scene_setup', { type: 'scene_change', data: { scene } })

      const activeMembers = this.filterMembersByScene(members, scene)
      let sceneDone = false

      if (scene.actionBeats && scene.actionBeats.length > 0 && options.buildCharacterTurnToolset) {
        reports.push(await this.runActionBeatScene({
          ...params,
          scene,
          activeMembers,
          startIndex: i,
          failedActionBeatId: i === startIndex ? params.failedActionBeatId : undefined,
        }))
        continue
      }

      // 无动作图（旧快照或业务层未提供角色回合工具）：
      // 严格模式记为整场缺口交给闸门，不在这里 throw —— 其他场景可能演成了。
      if (options.allowLegacyActing === false) {
        const report = createSceneActingReport(scene)
        for (const beat of scene.actionBeats ?? []) report.unreached.push(beat.beatId)
        reports.push(report)
        const message = `⚠️ 场景「${scene.title}」缺少可执行的动作图，已跳过该场演出。`
        history.push(this.sceneScopedSystemMessage('【演出缺口】缺少可执行动作图，本场未演出', scene.sceneId))
        this.emitProgress(options, 'acting', {
          type: 'phase_change',
          data: { message, sceneId: scene.sceneId },
        })
        continue
      }

      // ── 无动作图的场景（旧快照）──
      // 2026-08-28：legacy Moderator 轮询已删除（生产三路径恒 allowLegacyActing:false，
      // 该循环只活在测试里）。旧快照续跑遇到无 actionBeats 的场景按"整场缺口"降级：
      // 记账并继续，缺口经 Writer 质量契约传达，不回退到任何 LLM 轮询。
      const legacyReport = createSceneActingReport(scene)
      for (const beat of scene.actionBeats ?? []) legacyReport.unreached.push(beat.beatId)
      reports.push(legacyReport)
      const gapMessage = `⚠️ 场景「${scene.title}」缺少可执行的动作图，本场未演出。`
      history.push(this.sceneScopedSystemMessage('【演出缺口】缺少可执行动作图，本场未演出', scene.sceneId))
      this.emitProgress(options, 'acting', {
        type: 'phase_change',
        data: { message: gapMessage, sceneId: scene.sceneId },
      })
      // 场景推演结束，直接进入下一场景
    }
    this.currentScene = undefined
    return reports
  }

  /**
   * 新版动作图演出：Director 决定戏剧节点，角色决定现场表达和下一位回应者。
   *
   * ⚠️ 异常处理是策略表，不是 LLM 决策（2026-08-28 控制平面重排 T2）：
   * 每个节点得到一个确定处置（completed / thin / skipped），场景累积成
   * SceneActingReport 交给调用方。这里既不调 Moderator，也不 throw ——
   * "够不够写"由 run() 的 Phase 2.5 闸门按全章汇总统一判断。
   * 取消是唯一的例外：AbortSignal 立即抛出，冻结整个 run。
   */
  private async runActionBeatScene(params: {
    goal: DiscussionGoal
    members: DiscussionMember[]
    history: DiscussionMessage[]
    scenes: SceneDefinition[]
    options: DiscussionOptions
    limits: { maxRoundsPerScene: number; maxObserveRounds: number }
    channelName: string
    startIndex: number
    track: { phase: DiscussionPhase; sceneId?: number }
    scene: SceneDefinition
    activeMembers: DiscussionMember[]
    failedActionBeatId?: string
  }): Promise<SceneActingReport> {
    const { history, members, options, channelName, track, scene, activeMembers } = params
    const actionBeats = scene.actionBeats ?? []
    const characterMembers = activeMembers.filter(member => member.type === 'character')
    const memberById = new Map(characterMembers.map(member => [member.id, member]))
    const memberByName = new Map(characterMembers.map(member => [this.normalizeCharacterName(member.name), member]))
    const report = createSceneActingReport(scene)
    const completed = new Set<string>()
    // 续跑完成度以 transcript 为准，不以 failedActionBeatId 的下标为准。
    //
    // failedActionBeatId 只是「中断时正在执行的节点」，它既可能自身失败（未产出
    // 任何回合），也可能已经完成、错误发生在它触发的 mention 回应里。按下标
    // 跳到它之后继续，前者会把没演过的节点静默算作已完成，后者会重复演一次。
    // 每条角色消息都带 actorTurn.actionBeatId，据此还原真实完成集合最可靠。
    const turnBeatIds = history
      .filter(message => message.type === 'member' && message.sceneId === scene.sceneId)
      .map(message => message.actorTurn?.actionBeatId)
      .filter((beatId): beatId is string => Boolean(beatId))
    for (const beatId of turnBeatIds) {
      completed.add(beatId)
      report.completed.push(beatId)
    }
    const resumeAfter = params.failedActionBeatId
    if (resumeAfter && turnBeatIds.length === 0) {
      // 早期快照的角色消息没有 actorTurn：退回下标口径，但只把「严格早于」
      // 中断节点的节点算作已完成，保证中断节点本身会被重演而不是被跳过。
      const failedBeatIndex = actionBeats.findIndex(beat => beat.beatId === resumeAfter)
      if (failedBeatIndex > 0) {
        for (const beat of actionBeats.slice(0, failedBeatIndex)) {
          completed.add(beat.beatId)
          report.completed.push(beat.beatId)
        }
      }
    }
    const edgeCounts = new Map<string, number>()
    let beatRounds = 0
    let pending: Array<{ targetId: string; sourceMessageId: string; depth: number }> = []

    for (const actionBeat of actionBeats) {
      if (completed.has(actionBeat.beatId)) continue
      throwIfAborted(options.signal)
      // 预算判断必须在发「节点开始」之前：否则会为一个永远不会执行的节点
      // 推一条开始事件，用户看到的节点数与实际演出不符。
      if (beatRounds >= params.limits.maxRoundsPerScene) {
        report.unreached.push(actionBeat.beatId)
        continue
      }
      track.phase = 'acting'
      this.currentActionBeatId = actionBeat.beatId
      this.currentActionBeatSceneId = scene.sceneId
      this.appendActionBeatSystemMessage(history, options, scene, actionBeat, 'start')

      const actor = memberById.get(actionBeat.actor)
      if (!actor) {
        // 策略表：actor 不在场（白名单裁剪或计划与名册冲突）→ 丢弃该节点继续。
        // 旧路径为此调一次 Moderator，但它同样只能选择跳过——没有信息增益。
        this.noteBeatSkipped(report, actionBeat, history, options, scene,
          `actor 不在当前场景：${actionBeat.actor}`)
        continue
      }

      // 单节点最多两次尝试：一次抖动值得重试，两次就是稳定失败。
      let turn: CharacterTurn | null = null
      for (let attempt = 1; attempt <= ACTING_POLICY.MAX_BEAT_ATTEMPTS && !turn; attempt++) {
        if (attempt > 1) {
          throwIfAborted(options.signal)
          this.emitProgress(options, 'acting', {
            type: 'phase_change',
            data: { message: `${actor.name} 未提交有效回合，正在重试一次动作节点「${actionBeat.beatId}」` },
          })
        }
        turn = await this.invokeCharacterTurn(
          actor, actionBeat, scene, history, members, options, channelName, track, memberById, undefined,
        )
        beatRounds++
        this.autonomousCharacterTurns++
      }

      if (!turn) {
        this.noteBeatSkipped(report, actionBeat, history, options, scene,
          `角色「${actor.name}」连续两次未提交有效回合`)
        continue
      }

      if (turn.progress === 'stall' || !turn.consequence.trim()) {
        // 策略表：演了但没推进 → 记 thin，继续下一节点。
        // 这类回合的 publicText 仍进 transcript（可能有可用的氛围/台词），
        // 只是不算作该节点的完成凭证。
        this.noteBeatThin(report, actionBeat, history, options, scene,
          `角色「${actor.name}」的回合没有产生有效进展或后果`)
        continue
      }

      completed.add(actionBeat.beatId)
      report.completed.push(actionBeat.beatId)
      this.completedActionBeats++
      this.appendActionBeatSystemMessage(history, options, scene, actionBeat, 'complete')

      const sourceMessageId = this.appendCharacterTurn(
        actor, turn, scene.sceneId, history, options, channelName,
      )
      pending = this.enqueueCharacterMentions(
        pending, actor, turn, sourceMessageId, scene, memberByName, edgeCounts, history, options,
      )
      if (actionBeat.nextActor && pending.length === 0) {
        const defaultTarget = memberById.get(actionBeat.nextActor)
        if (defaultTarget && defaultTarget.id !== actor.id) {
          pending.push({ targetId: defaultTarget.id, sourceMessageId, depth: 1 })
        }
      }

      pending = await this.drainPendingReactions({
        pending, report, actionBeats, completed, scene, history, members, options,
        channelName, track, memberById, memberByName, edgeCounts,
      })
    }

    // 未完成节点不再调 Moderator、不再 throw：账目交给 Phase 2.5 闸门。
    const remaining = actionBeats.filter(beat =>
      !completed.has(beat.beatId)
      && !report.thin.includes(beat.beatId)
      && !report.skipped.includes(beat.beatId)
      && !report.unreached.includes(beat.beatId),
    )
    for (const beat of remaining) report.unreached.push(beat.beatId)

    const gaps = report.thin.length + report.skipped.length + report.unreached.length
    if (gaps > 0) {
      const detail = `完成 ${report.completed.length} / 缺口 ${gaps}`
      const message = `⚠️ 场景「${scene.title}」动作节点${detail}，编织时将绕开未演出的节点。`
      history.push(this.sceneScopedSystemMessage(`【演出缺口】${detail}`, scene.sceneId))
      this.emitProgress(options, 'acting', {
        type: 'phase_change',
        data: { message, sceneId: scene.sceneId },
      })
    }
    return report
  }

  /**
   * 执行 pending mention 队列。
   *
   * 被 mention 角色若恰好有未完成节点，该回合兼作节点完成凭证；否则作为
   * 独立 reaction 回合（不占 beat 名额，单独扣 reaction 预算）。
   * 这是 T3 的"追加 reaction 节点"语义的前半步：先不再因"找不到节点"丢弃 mention。
   */
  private async drainPendingReactions(params: {
    pending: Array<{ targetId: string; sourceMessageId: string; depth: number }>
    report: SceneActingReport
    actionBeats: SceneActionBeat[]
    completed: Set<string>
    scene: SceneDefinition
    history: DiscussionMessage[]
    members: DiscussionMember[]
    options: DiscussionOptions
    channelName: string
    track: { phase: DiscussionPhase; sceneId?: number }
    memberById: Map<string, DiscussionMember>
    memberByName: Map<string, DiscussionMember>
    edgeCounts: Map<string, number>
  }): Promise<Array<{ targetId: string; sourceMessageId: string; depth: number }>> {
    const {
      report, actionBeats, completed, scene, history, members, options,
      channelName, track, memberById, memberByName, edgeCounts,
    } = params
    let pending = params.pending

    while (pending.length > 0 && report.reactionTurns < ACTING_POLICY.MAX_REACTION_TURNS_PER_SCENE) {
      throwIfAborted(options.signal)
      const next = pending.shift()!
      const target = memberById.get(next.targetId)
      if (!target) continue
      const source = history.find(message => message.id === next.sourceMessageId)
      // 优先认领该角色尚未完成的节点；没有则以触发它的节点作为压力上下文，
      // 走独立 reaction 回合（旧路径在这里直接丢弃 mention，导致自主接戏基本失效）。
      const claimedBeat = actionBeats.find(beat => beat.actor === target.id && !completed.has(beat.beatId))
      const contextBeat = claimedBeat
        ?? actionBeats.find(beat => beat.beatId === this.currentActionBeatId)
        ?? actionBeats[0]
      if (!contextBeat) continue

      const response = await this.invokeCharacterTurn(
        target, contextBeat, scene, history, members, options, channelName, track, memberById, source,
      )
      report.reactionTurns++
      this.autonomousCharacterTurns++

      if (!response) {
        if (claimedBeat) {
          this.noteBeatSkipped(report, claimedBeat, history, options, scene,
            `角色「${target.name}」未能回应主动点名`)
        }
        continue
      }
      if (response.progress === 'stall' || !response.consequence.trim()) {
        if (claimedBeat) {
          this.noteBeatThin(report, claimedBeat, history, options, scene,
            `角色「${target.name}」的回应没有产生有效进展或后果`)
        }
        continue
      }

      if (claimedBeat) {
        completed.add(claimedBeat.beatId)
        report.completed.push(claimedBeat.beatId)
        // 自主回应同样是动作节点的完成凭证：不计数会让 completedActionBeats
        // 只统计外层 Director 顺序驱动的节点，mention 接戏完成的节点凭空消失。
        this.completedActionBeats++
        this.appendActionBeatSystemMessage(history, options, scene, claimedBeat, 'complete')
      }

      const responseMessageId = this.appendCharacterTurn(
        target, response, scene.sceneId, history, options, channelName,
      )
      pending = this.enqueueCharacterMentions(
        pending, target, response, responseMessageId, scene,
        memberByName, edgeCounts, history, options, next.depth,
      )
      if (claimedBeat?.nextActor && pending.length === 0) {
        const defaultTarget = memberById.get(claimedBeat.nextActor)
        if (defaultTarget && defaultTarget.id !== target.id) {
          pending.push({ targetId: defaultTarget.id, sourceMessageId: responseMessageId, depth: next.depth + 1 })
        }
      }
    }
    // 预算耗尽时清空剩余队列：留着也不会执行，只会让下一节点的 drain 误以为有待办。
    return []
  }

  /** 策略表处置：节点未能执行（actor 缺失或稳定失败）。 */
  private noteBeatSkipped(
    report: SceneActingReport,
    beat: SceneActionBeat,
    history: DiscussionMessage[],
    options: DiscussionOptions,
    scene: SceneDefinition,
    reason: string,
  ): void {
    report.skipped.push(beat.beatId)
    this.characterTurnFailures++
    this.appendActionBeatSystemMessage(history, options, scene, beat, 'failed')
    this.emitProgress(options, 'acting', {
      type: 'phase_change',
      data: { message: `⚠️ 动作节点「${beat.beatId}」跳过：${reason}`, sceneId: scene.sceneId },
    })
  }

  /** 策略表处置：角色演了但没推进（stall / 无后果）。 */
  private noteBeatThin(
    report: SceneActingReport,
    beat: SceneActionBeat,
    history: DiscussionMessage[],
    options: DiscussionOptions,
    scene: SceneDefinition,
    reason: string,
  ): void {
    report.thin.push(beat.beatId)
    this.appendActionBeatSystemMessage(history, options, scene, beat, 'failed')
    this.emitProgress(options, 'acting', {
      type: 'phase_change',
      data: { message: `⚠️ 动作节点「${beat.beatId}」无有效进展：${reason}`, sceneId: scene.sceneId },
    })
  }

  /** 带 sceneId 的系统消息（场景级账目要能按场景过滤）。 */
  private sceneScopedSystemMessage(content: string, sceneId: number): DiscussionMessage {
    const message = this.systemMessage(content)
    message.sceneId = sceneId
    return message
  }

  private appendActionBeatSystemMessage(
    history: DiscussionMessage[],
    options: DiscussionOptions,
    scene: SceneDefinition,
    beat: SceneActionBeat,
    kind: 'start' | 'complete' | 'failed',
  ): void {
    const label = kind === 'start' ? '开始' : kind === 'complete' ? '完成' : '失败'
    const message = this.systemMessage(
      `【动作节点${label}】${beat.beatId}：${beat.action}；选择：${beat.choice}；后果：${beat.consequence}`,
    )
    message.sceneId = scene.sceneId
    history.push(message)
    this.emitProgress(options, 'acting', {
      type: 'phase_change',
      data: { message: message.content, sceneId: scene.sceneId, actionBeatId: beat.beatId },
    })
  }

  private async invokeCharacterTurn(
    member: DiscussionMember,
    actionBeat: SceneActionBeat,
    scene: SceneDefinition,
    history: DiscussionMessage[],
    members: DiscussionMember[],
    options: DiscussionOptions,
    channelName: string,
    track: { phase: DiscussionPhase; sceneId?: number },
    memberById: Map<string, DiscussionMember>,
    sourceMessage?: DiscussionMessage,
  ): Promise<CharacterTurn | null> {
    const toolset = options.buildCharacterTurnToolset?.({
      memberId: member.id,
      sceneId: scene.sceneId,
      actionBeatId: actionBeat.beatId,
    })
    this.currentCharacterTurn = toolset
    if (!toolset) {
      this.context.logger.warn({ memberId: member.id, sceneId: scene.sceneId }, '角色回合工具集未提供，进入一次性 legacy 回退')
    }
    const prompt = [
      `当前动作节点：${actionBeat.beatId}`,
      `当前阻力：${actionBeat.pressure}`,
      `你要采取的行动边界：${actionBeat.action}`,
      `你必须面对的选择：${actionBeat.choice}`,
      `节点预期即时后果：${actionBeat.consequence}`,
      `节点完成条件：${actionBeat.exitCondition}`,
      sourceMessage ? `请回应 ${sourceMessage.fromName} 刚才的动作：\n${sourceMessage.content}` : '',
      '只演当前角色，不替其他角色说话。完成后必须调用 novel_submit_character_turn 工具提交结构化回合。',
    ].filter(Boolean).join('\n')
    try {
      const raw = await this.invokeMember(
        member,
        prompt,
        history,
        options,
        { phase: 'acting', sceneId: scene.sceneId },
      )
      const submitted = toolset?.extractResult() ?? null
      if (submitted) {
        if (submitted.actionBeatId && submitted.actionBeatId !== actionBeat.beatId) {
          this.context.logger.warn(
            { expected: actionBeat.beatId, received: submitted.actionBeatId, memberId: member.id },
            '角色回合未对应当前动作节点，拒绝提交',
          )
          return null
        }
        if (submitted.progress === 'stall' || !submitted.consequence.trim()) return null
        return submitted
      }
      // provider 不支持工具时保留 legacy 文本兼容，但只允许当前角色的公开演出。
      if (raw.trim()) {
        // nextActor 是 canonical member ID；mentionNames 走显示名口径，
        // 这里必须按 ID 反查成员名，不能拿 ID 当名字去查 name→member 表。
        const fallbackMention = actionBeat.nextActor
          ? memberById.get(actionBeat.nextActor)?.name
          : undefined
        return {
          publicText: raw.trim(),
          innerThought: '',
          conflictReading: actionBeat.pressure,
          responsePlan: actionBeat.action,
          consequence: actionBeat.consequence,
          progress: 'advance',
          mentionNames: fallbackMention ? [fallbackMention] : [],
        }
      }
      return null
    } catch (err) {
      if (options.signal?.aborted) {
        this.characterTurnCancelled++
        throw err
      }
      this.characterTurnFailures++
      this.context.logger.warn({ err, memberId: member.id, sceneId: scene.sceneId }, '自主角色回合失败，保留场景继续')
      this.emitProgress(options, 'acting', {
        type: 'phase_change',
        data: { message: `⚠️ ${member.name} 本回合失败，跳过当前节点并继续演出` },
      })
      return null
    } finally {
      this.currentCharacterTurn = undefined
    }
  }

  private appendCharacterTurn(
    member: DiscussionMember,
    turn: CharacterTurn,
    sceneId: number,
    history: DiscussionMessage[],
    options: DiscussionOptions,
    channelName: string,
  ): string {
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const message: DiscussionMessage = {
      id,
      fromId: member.id,
      fromName: member.name,
      content: turn.publicText,
      timestamp: Date.now(),
      sceneId,
      type: 'member',
      actorTurn: turn,
    }
    history.push(message)
    this.channel.broadcast(channelName, member.id, message)
    this.emitProgress(options, 'acting', {
      type: 'agent_output',
      data: {
        agentType: 'character',
        agentName: member.name,
        content: turn.publicText,
        actorTurn: turn,
        messageId: id,
      },
    })
    return id
  }

  private enqueueCharacterMentions(
    pending: Array<{ targetId: string; sourceMessageId: string; depth: number }>,
    sourceMember: DiscussionMember,
    turn: CharacterTurn,
    sourceMessageId: string,
    scene: SceneDefinition,
    memberByName: Map<string, DiscussionMember>,
    edgeCounts: Map<string, number>,
    history: DiscussionMessage[],
    options: DiscussionOptions,
    parentDepth = 0,
  ): Array<{ targetId: string; sourceMessageId: string; depth: number }> {
    const result = [...pending]
    const seen = new Set(result.map(item => `${item.sourceMessageId}:${item.targetId}`))
    for (const name of turn.mentionNames) {
      const target = memberByName.get(this.normalizeCharacterName(name))
      if (!target || target.id === sourceMember.id) continue
      const edge = `${sourceMember.id}->${target.id}`
      const count = edgeCounts.get(edge) ?? 0
      if (count >= ACTING_POLICY.MAX_MENTION_EDGE_REPEATS || parentDepth >= ACTING_POLICY.MAX_MENTION_DEPTH) {
        this.context.logger.warn({ sceneId: scene.sceneId, edge, parentDepth }, '角色主动 mention 被回环/深度预算拦截')
        continue
      }
      const key = `${sourceMessageId}:${target.id}`
      if (seen.has(key)) continue
      seen.add(key)
      edgeCounts.set(edge, count + 1)
      result.push({ targetId: target.id, sourceMessageId, depth: parentDepth + 1 })
      this.autonomousMentions++
      this.emitProgress(options, 'acting', {
        type: 'phase_change',
        data: { message: `${sourceMember.name} 主动邀请 ${target.name} 接戏` },
      })
    }
    return result
  }

  /**
   * 从持久化快照直接恢复全章编织，不再调用 Moderator、Director 或角色 Agent。
   * Writer 成功后继续执行 Reviewer/Reviser 与原有检查点流程。
   *
   * phase='reviewing' 入口：正文已在快照中（content），跳过编织直接进最终质量门。
   */
  async resumeChapterWeaving(
    goal: DiscussionGoal,
    members: DiscussionMember[],
    options: DiscussionOptions,
    resumeState: DiscussionResumeState,
  ): Promise<DiscussionResult> {
    const history = resumeState.transcript.map(message => ({ ...message }))
    const scenes = resumeState.scenes.map(scene => ({
      ...scene,
      presentCharacters: [...scene.presentCharacters],
      presentCharacterNames: scene.presentCharacterNames ? [...scene.presentCharacterNames] : undefined,
      unresolvedCharacterNames: scene.unresolvedCharacterNames ? [...scene.unresolvedCharacterNames] : undefined,
      actionBeatInputs: scene.actionBeatInputs ? scene.actionBeatInputs.map(beat => ({ ...beat })) : undefined,
      actionBeats: scene.actionBeats ? scene.actionBeats.map(beat => ({ ...beat })) : undefined,
    }))
    const channelName = `discuss-resume-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    let finalContent = ''
    let activePhase: DiscussionPhase = 'chapter_weaving'

    for (const member of members) this.channel.subscribe(channelName, member.id)

    try {
      this.currentGoal = goal
      if (resumeState.phase === 'reviewing' && resumeState.content) {
        // reviewing 入口：正文已在首跑织成并落快照，直接从最终质量门继续
        finalContent = resumeState.content
        activePhase = 'reviewing'
        this.emitProgress(options, 'reviewing', {
          type: 'phase_change',
          data: { message: '已恢复群聊记录与章节正文，从最终质量门继续' },
        })
      } else {
        this.emitProgress(options, 'chapter_weaving', {
          type: 'phase_change',
          data: { message: '已恢复群聊记录，正在从写作 Agent 继续' },
        })
        // 续跑的 chapter_weaving 没有 Moderator 循环，仍需在 Writer 调用前消费
        // 已排队插话，否则 finally 会把它们全部标为 dropped。
        this.drainInterjectQueue(history, options)
        finalContent = await this.weaveChapter(members, history, scenes, goal, options)
        this.recordWriterOutput(members, history, finalContent)

        activePhase = 'reviewing'
      }
      this.drainInterjectQueue(history, options)
      const qualityResult = await this.reviewFinalChapter(
        finalContent,
        members,
        history,
        options,
        goal.targetWords,
      )
      if (qualityResult.status === 'cancelled') {
        return { status: 'cancelled', content: finalContent, transcript: history, scenes, review: qualityResult.review }
      }
      finalContent = qualityResult.content
      return { status: 'completed', content: finalContent, transcript: history, scenes, review: qualityResult.review }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.context.logger.error({ err }, '群聊断点续跑异常')
      if (options.signal?.aborted) {
        return { status: 'cancelled', content: finalContent || undefined, transcript: history, scenes }
      }
      return {
        status: 'error',
        error: message,
        failedPhase: activePhase,
        content: finalContent || undefined,
        transcript: history,
        scenes,
      }
    } finally {
      // 与 run 同口径：先关闭插话通道再收尾，收尾后插话一律拒绝。
      this.acceptingInterjects = false
      for (const member of members) this.channel.unsubscribe(channelName, member.id)
      // 断点续跑不走 Moderator decide，期间入队的插话全部在收尾 dropped。
      this.flushInterjectDropped(options)
    }
  }

  /**
   * 从场景推演中断处恢复（acting/scene_setup 失败）：
   * 恢复 transcript + scenes，从 failedSceneId 对应场景继续推演（该场景未完成
   * 的轮次从头算，此前已完成场景的剧本保留在 history）。推演完毕后进入
   * 全章编织与最终质量门（与 run 的 Phase 3/4 相同）。
   */
  async resumeSceneActing(
    goal: DiscussionGoal,
    members: DiscussionMember[],
    options: DiscussionOptions,
    resumeState: DiscussionResumeState,
  ): Promise<DiscussionResult> {
    const history = resumeState.transcript.map(message => ({ ...message }))
    const scenes = resumeState.scenes.map(scene => ({
      ...scene,
      presentCharacters: [...scene.presentCharacters],
      presentCharacterNames: scene.presentCharacterNames ? [...scene.presentCharacterNames] : undefined,
      unresolvedCharacterNames: scene.unresolvedCharacterNames ? [...scene.unresolvedCharacterNames] : undefined,
      // 动作图必须与 resumeChapterWeaving 同口径深拷：浅拷贝会让续跑期间的
      // 白名单重算/节点裁剪直接改写调用方持有的 resumeState.scenes。
      actionBeatInputs: scene.actionBeatInputs ? scene.actionBeatInputs.map(beat => ({ ...beat })) : undefined,
      actionBeats: scene.actionBeats ? scene.actionBeats.map(beat => ({ ...beat })) : undefined,
    }))
    const channelName = `discuss-resume-acting-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const limits = {
      maxRoundsPerScene: options.limits?.maxRoundsPerScene ?? DISCUSSION_LIMITS.MAX_ROUNDS_PER_SCENE,
      maxObserveRounds: DISCUSSION_LIMITS.MAX_OBSERVE_ROUNDS,
    }
    const track: { phase: DiscussionPhase; sceneId?: number } = {
      phase: resumeState.phase,
      sceneId: resumeState.failedSceneId,
    }
    let finalContent = ''

    for (const member of members) this.channel.subscribe(channelName, member.id)

    try {
      this.currentGoal = goal
      // 中断场景定位：failedSceneId 缺失（scene_setup 入口或旧快照）时从头推演
      const failedIndex = resumeState.failedSceneId != null
        ? scenes.findIndex(scene => scene.sceneId === resumeState.failedSceneId)
        : -1
      const startIndex = failedIndex >= 0 ? failedIndex : 0
      this.emitProgress(options, resumeState.phase, {
        type: 'phase_change',
        data: { message: `已恢复群聊记录，从场景 ${scenes[startIndex]?.sceneId ?? 1} 继续推演` },
      })
      const resumeReports = await this.runSceneLoop({
        goal,
        members,
        history,
        scenes,
        options,
        limits,
        channelName,
        startIndex,
        track,
        enforceCastCoverage: false,
        failedActionBeatId: resumeState.failedActionBeatId,
      })

      track.phase = 'chapter_weaving'
      this.emitProgress(options, 'chapter_weaving', { type: 'phase_change', data: { message: '正在编织完整章节' } })
      this.drainInterjectQueue(history, options)
      // 续跑同样把演出缺口写进 Writer 质量契约：本次只重演了部分场景，
      // 但缺口判断要看全章（已完成场景的剧本在 transcript 里）。
      finalContent = await this.weaveChapter(
        members, history, scenes, goal, options, undefined,
        buildWriterQualityContract(resumeReports, scenes),
      )
      this.recordWriterOutput(members, history, finalContent)

      track.phase = 'reviewing'
      this.drainInterjectQueue(history, options)
      const qualityResult = await this.reviewFinalChapter(finalContent, members, history, options, goal.targetWords)
      if (qualityResult.status === 'cancelled') {
        return { status: 'cancelled', content: finalContent, transcript: history, scenes, review: qualityResult.review }
      }
      finalContent = qualityResult.content
      return { status: 'completed', content: finalContent, transcript: history, scenes, review: qualityResult.review }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.context.logger.error({ err }, '群聊场景推演断点续跑异常')
      if (options.signal?.aborted) {
        return { status: 'cancelled', content: finalContent || undefined, transcript: history, scenes }
      }
      return {
        status: 'error',
        error: message,
        failedPhase: track.phase,
        failedSceneId: this.sceneIdForFailure(track),
        failedActionBeatId: this.currentActionBeatSceneId === track.sceneId ? this.currentActionBeatId : undefined,
        content: finalContent || undefined,
        transcript: history,
        scenes,
      }
    } finally {
      this.currentActionBeatId = undefined
      this.currentActionBeatSceneId = undefined
      this.acceptingInterjects = false
      for (const member of members) this.channel.unsubscribe(channelName, member.id)
      this.flushInterjectDropped(options)
    }
  }

  /**
   * 插话 drain（§3.1）：把队列中全部插话以 user 角色追加进 history（只追加不重排），
   * 文本带「用户中途反馈」显式区块（与 create-flow 插话注入格式同构），
   * 随后一次性回调 onInterjectInjected。取走即出队，重复调用天然幂等。
   */
  private drainInterjectQueue(history: DiscussionMessage[], options: DiscussionOptions): void {
    if (this.interjectQueue.length === 0) return
    const batch = this.interjectQueue
    this.interjectQueue = []
    const ids: string[] = []
    for (const msg of batch) {
      history.push({
        id: `interject-${msg.id}`,
        fromId: 'user',
        fromName: '用户',
        content: `【用户中途反馈】\n（讨论进行中用户提出，可影响讨论方向）\n${msg.content}`,
        timestamp: msg.createdAt || Date.now(),
        type: 'user',
      })
      ids.push(msg.id)
    }
    options.onInterjectInjected?.(ids)
  }

  /** 插话收尾（§3.1）：flow 终态时清空队列，未被消费的插话以 dropped 回调暴露。 */
  private flushInterjectDropped(options: DiscussionOptions): void {
    if (this.interjectQueue.length === 0) return
    const ids = this.interjectQueue.map(msg => msg.id)
    this.interjectQueue = []
    options.onInterjectDropped?.(ids)
  }

  private recordWriterOutput(
    members: DiscussionMember[],
    history: DiscussionMessage[],
    content: string,
  ): void {
    const writer = members.find(member => member.id === 'novel-writer')
      ?? members.find(member => member.canConverge)
    if (!writer || !content) return
    history.push({
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fromId: writer.id,
      fromName: writer.name,
      content,
      timestamp: Date.now(),
      type: 'member',
    })
  }

  /**
   * 调用成员发言（通过 createAgUiSession 工厂）
   */  private async invokeMember(
    member: DiscussionMember,
    prompt: string,
    history: DiscussionMessage[],
    options: DiscussionOptions,
    ctx: { phase: DiscussionPhase; sceneId?: number; extraTools?: unknown[] },
    visibility: 'public' | 'internal' = 'public',
    invocationOverrides?: {
      systemPrompt: string
      prefixMessages: string[]
      temperature: number
      modelId?: PluginSessionOptions['modelId']
      participantIds?: string[]
      participantNames?: string[]
    },
  ): Promise<string> {
    const characterTurnToolset = member.type === 'character'
      ? this.currentCharacterTurn
      : undefined
    const systemPrompt = invocationOverrides?.systemPrompt ?? member.buildSystemPrompt()
    const identityPrompt = invocationOverrides ? '' : member.buildIdentityPrompt?.() ?? ''
    const visibleChapterContext = invocationOverrides
      ? ''
      : member.buildContextPrompt?.() ?? this.currentGoal?.context ?? ''
    const prefixMessages = (invocationOverrides?.prefixMessages ?? [visibleChapterContext, identityPrompt])
      .filter(message => message.trim().length > 0)
    // P1-4a（2026-08-24）：演出阶段给角色成员常驻注入当前场景契约。
    // 场景契约此前只以 system 消息进 history，而角色可见的群聊记录仅最近 10 条，
    // 场景中段之后角色看不到本场地点/冲突/目标/情绪（Moderator 自己看 15 条，
    // 会误以为角色仍然知道）。固定前缀不随窗口滑动，且场景内稳定可命中缓存。
    if (
      !invocationOverrides
      && member.type === 'character'
      && ctx.sceneId != null
      && this.currentScene
      && this.currentScene.sceneId === ctx.sceneId
    ) {
      prefixMessages.push(this.buildSceneContext(this.currentScene))
    }
    const transcriptSummary = this.formatTranscriptForMember(history, member.id)
    const userMessage = `${prompt}\n\n---\n\n## 群聊记录\n\n${transcriptSummary}`
    const startTime = Date.now()
    const requestedTools = characterTurnToolset?.tools ?? ctx.extraTools ?? []
    let result = ''
    let status: 'success' | 'error' | 'cancelled' = 'success'
    let error = ''

    // 真实 payload 体积累加器：每次 LLM 往返一次回调，累加才是本次调用送出去的总量
    const payloadStats = { messagesChars: 0, toolsChars: 0, toolCount: 0, totalChars: 0, roundTrips: 0 }
    this.totalMemberInvocations++
    const handle = await this.context.createAgUiSession({
      systemPrompt,
      // 工种成员使用共享章节上下文；角色成员可通过 buildContextPrompt 使用
      // 只含本人已知信息的私有上下文，避免角色看到全知状态和他人秘密。
      prefixUserMessage: prefixMessages.length === 1 ? prefixMessages[0] : prefixMessages,
      userMessage,
      // 注入业务层提供的工具（如 Reviser 的 novel_apply_revision）。
      // 工具不在 STATIC/SEMI 层 prompt 中出现，不影响跨 Agent 的 prompt cache 命中率。
      tools: requestedTools,
      onPayloadStats: (stats) => {
        payloadStats.roundTrips += 1
        this.totalLlmRoundTrips += 1
        payloadStats.messagesChars += stats.messagesChars
        payloadStats.toolsChars += stats.toolsChars
        payloadStats.totalChars += stats.totalChars
        payloadStats.toolCount = Math.max(payloadStats.toolCount, stats.toolCount)
      },
      signal: options.signal,
      // 温度优先级：member.temperature（工种成员从 AgentPage 角色温度配置读取）
      // > 角色成员回退到 characterTemperature > 默认 0.7
      temperature: invocationOverrides?.temperature ?? member.temperature
        ?? (member.type === 'character' ? (options.limits?.characterTemperature ?? 0.8) : 0.7),
      timeoutMs: 300_000,
      // 透传成员配置的 modelId：工种成员从 AgentManager 读取该 Agent 的 model 配置，
      // 角色成员不填（走默认 Provider）。
      modelId: invocationOverrides?.modelId ?? member.modelId,
      // Skill 白名单接入：常规成员调用透传业务层授权的 Skill；invocationOverrides
      // 派生的特殊调用（如编织/合并演出）自带完整 prompt，不展开成员 Skill。
      skill: invocationOverrides ? undefined : member.skill,
      emit: options.emit,
      emitRaw: false,
      onFirstText: () => {
        // 首 token 到达：成员发言已开始，无需额外 emit。
        // 主持人点名消息已在 handleDecision 的 invite 分支发射（在 invokeMember 之前），
        // agent_start 事件已标识成员启动，TEXT_MESSAGE_* 会流式渲染发言内容。
        // 此处不再发射 phase_change message，避免前端创建重复的"主持人"气泡。
      },
    })
    const { session, streamEmitter, messageId } = handle
    let capturedUsage: DiscussionUsage | undefined
    const usageSession = session as unknown as {
      subscribe?: (listener: (event: Record<string, unknown>) => void) => () => void
    }
    const unsubscribeUsage = usageSession.subscribe?.((event) => {
      if (event.type !== 'message_end') return
      const message = event.message as Record<string, unknown> | undefined
      if (!message || message.role !== 'assistant') return
      const usage = extractDiscussionUsage(message)
      if (usage) capturedUsage = addDiscussionUsage(capturedUsage, usage)
    })

    // agent_start 必须在 prompt() 之前发射，否则前端收到 TEXT_MESSAGE_START 时
    // 找不到 messageId 映射，成员输出不显示。携带 messageId + agentType 对齐 workflow 模式契约。
    if (visibility === 'public') {
      this.emitProgress(options, ctx.phase, {
        type: 'agent_start',
        data: {
          agentId: member.id,
          agentType: member.type === 'character' ? 'character' : member.id.replace('novel-', ''),
          agentName: invocationOverrides?.participantNames?.join('、') ?? member.name,
          participantIds: invocationOverrides?.participantIds,
          participantNames: invocationOverrides?.participantNames,
          messageId,
          message: `${invocationOverrides?.participantNames?.join('、') ?? member.name} 已启动，正在向 AI 发送请求...`,
        },
      })
    }

    try {
      result = await session.prompt()
      if (member.type === 'character' && characterTurnToolset?.extractResult()) {
        // 工具主路径的终答可能为空；调用方读取闭包 payload，不能再触发一次 legacy 解析。
        streamEmitter.finishTextMessage()
        return result
      }
      streamEmitter.finishTextMessage()
      return result
    } catch (err) {
      status = options.signal?.aborted ? 'cancelled' : 'error'
      error = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      unsubscribeUsage?.()
      try {
        options.onMemberInvocation?.({
          member,
          participantIds: invocationOverrides?.participantIds,
          participantNames: invocationOverrides?.participantNames,
          phase: ctx.phase,
          systemPrompt,
          chapterContext: prefixMessages.join('\n\n---\n\n'),
          userMessage,
          result,
          // 记录实际挂载的工具名：排查"修订没生效"时要能区分
          // "工具没挂上"与"工具挂了但模型没调"
          toolNames: [
            ...(characterTurnToolset?.tools ?? []),
            ...(ctx.extraTools ?? []),
          ].map(tool => (tool as { name: string }).name),
          durationMs: Date.now() - startTime,
          status,
          error,
          sessionId: handle.sessionId ?? session.sessionId ?? '',
          inputTokens: capturedUsage?.inputTokens ?? 0,
          outputTokens: capturedUsage?.outputTokens ?? 0,
          cacheReadTokens: capturedUsage?.cacheReadTokens ?? 0,
          cacheWriteTokens: capturedUsage?.cacheWriteTokens ?? 0,
          llmProvider: capturedUsage?.llmProvider ?? invocationOverrides?.modelId?.provider ?? member.modelId?.provider ?? '',
          llmModel: capturedUsage?.llmModel ?? invocationOverrides?.modelId?.modelId ?? member.modelId?.modelId ?? '',
          payloadMessagesChars: payloadStats.messagesChars,
          payloadToolsChars: payloadStats.toolsChars,
          payloadToolCount: payloadStats.toolCount,
          payloadTotalChars: payloadStats.totalChars,
          llmRoundTrips: payloadStats.roundTrips,
        })
      } catch (logError) {
        this.context.logger.warn({ err: logError, memberId: member.id }, '群聊成员调用日志写入失败')
      }
      handle.dispose()
    }
  }

  /**
   * 正文后确定性检测：模型退化 / 字数失控。
   *
   * 群聊编织完成后、Reviewer 审稿前运行，捕获模型失控问题，避免浪费 Reviewer token。
   * 命中则让 Writer 重写一次（最多 1 次），重写后不再检测，交给 reviewFinalChapter 兜底。
   *
   * 检测项（轻量级，不依赖 novel-plugin 的 cliche-scanner，保持引擎通用）：
   * 1. 空输出或过短（< 100 字）
   * 2. 模型拒绝标记（开头包含"我无法"/"作为AI"等）
   * 3. 重复模式（同一行重复 >= 3 次，长度 >= 10 字）
   * 4. 字数严重偏离（< 75% 或 > 130% 目标字数，与 create-flow 一致）
   */
  private runDiscussionPostWriteGuard(
    content: string,
    targetWords?: number,
    requiredMentions?: string[],
  ): { shouldRewrite: boolean; reason: string; details?: string } {
    const wordCount = content.replace(/\s/g, '').length

    if (
      wordCount < 500
      && /(?:先核对|按(?:章纲|已批准方案|导演方案)|重写第\s*\d+\s*章|输出(?:完整)?正文|创作第\s*\d+\s*章正文|确保(?:冲突|伏笔|钩子))/.test(content)
    ) {
      return {
        shouldRewrite: true,
        reason: '模型未输出正文',
        details: `仅输出了 ${wordCount} 字的计划或写作说明`,
      }
    }

    // 1. 空输出或过短
    if (wordCount < 100) {
      return {
        shouldRewrite: true,
        reason: '正文过短',
        details: `仅 ${wordCount} 字，模型可能未正常输出正文`,
      }
    }

    // 2. 模型拒绝标记（只检查前 300 字，避免误判正文中的引用）
    const head = content.slice(0, 300)
    const refusalPatterns = [
      /作为(?:一个)?(?:AI|人工智能|语言模型)/,
      /我(?:无法|不能|不可以)[\s\S]{0,15}(?:创作|写|生成|提供|完成)/,
      /抱歉[\s\S]{0,10}(?:无法|不能)/,
    ]
    for (const pattern of refusalPatterns) {
      if (pattern.test(head)) {
        return {
          shouldRewrite: true,
          reason: '模型拒绝输出',
          details: `正文开头包含拒绝标记`,
        }
      }
    }

    // 3. 重复模式：同一行重复 >= 3 次（长度 >= 10 字才算，避免短台词误判）
    const lines = content.split('\n').map(l => l.trim()).filter(l => l.length >= 10)
    const lineCounts = new Map<string, number>()
    for (const line of lines) {
      lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1)
    }
    for (const [line, count] of lineCounts) {
      if (count >= 3) {
        return {
          shouldRewrite: true,
          reason: '模型复读',
          details: `行重复 ${count} 次：${line.slice(0, 40)}${line.length > 40 ? '...' : ''}`,
        }
      }
    }

    // 4. 只有明显失控才自动重写；75%-85% 交给 Reviewer 判断完整性。
    if (targetWords != null && targetWords > 0) {
      if (wordCount < targetWords * 0.75) {
        return {
          shouldRewrite: true,
          reason: '字数严重不足',
          details: `实际 ${wordCount} 字，目标 ${targetWords} 字（${Math.round((wordCount / targetWords) * 100)}%）`,
        }
      }
      if (wordCount > targetWords * 1.30) {
        return {
          shouldRewrite: true,
          reason: '字数严重超标',
          details: `实际 ${wordCount} 字，目标 ${targetWords} 字（${Math.round((wordCount / targetWords) * 100)}%）`,
        }
      }
    }

    const missingMentions = (requiredMentions ?? []).filter(name => !content.includes(name))
    if (missingMentions.length > 0) {
      return {
        shouldRewrite: true,
        reason: '未完整执行矩阵编排',
        details: `正文未出现：${missingMentions.join('、')}`,
      }
    }

    return { shouldRewrite: false, reason: '' }
  }

  /** 从角色成员发言中提取引号台词（P1-2 台词复用率检测用） */
  private collectTranscriptQuotes(history: DiscussionMessage[], members: DiscussionMember[]): string[] {
    const characterIds = new Set(members.filter(m => m.type === 'character').map(m => m.id))
    const quotes: string[] = []
    for (const message of history) {
      if (message.type !== 'member' || !characterIds.has(message.fromId)) continue
      for (const match of message.content.matchAll(/[“「『"]([^”」』"\n]{6,120})[”」』"]/g)) {
        const quote = match[1].trim()
        if (quote) quotes.push(quote)
      }
    }
    return quotes
  }

  /** 匹配口径归一化：去空白、标点与符号（允许 Writer 改写句式后仍可命中） */
  private static normalizeForMatch(text: string): string {
    return text.replace(/[\s\p{P}\p{S}]+/gu, '')
  }

  /**
   * 计算正文对角色推演台词的复用率（P1-2）。
   * 台词去空白/标点后，任一 8 字窗口出现在正文中即算命中——只检测语义载体的
   * 存在性，不要求逐字复刻。
   */
  private computeTranscriptFidelity(
    content: string,
    history: DiscussionMessage[],
    members: DiscussionMember[],
  ): { rate: number; totalLines: number; missedLines: string[] } {
    const quotes = this.collectTranscriptQuotes(history, members)
    if (quotes.length === 0) return { rate: 1, totalLines: 0, missedLines: [] }
    const haystack = TeamDiscussionEngine.normalizeForMatch(content)
    const missedLines: string[] = []
    let hits = 0
    for (const quote of quotes) {
      const needle = TeamDiscussionEngine.normalizeForMatch(quote)
      let found = false
      if (needle.length >= 8) {
        for (let i = 0; i + 8 <= needle.length; i += 2) {
          if (haystack.includes(needle.slice(i, i + 8))) {
            found = true
            break
          }
        }
      } else if (needle.length > 0 && haystack.includes(needle)) {
        found = true
      }
      if (found) hits++
      else missedLines.push(quote)
    }
    return { rate: hits / quotes.length, totalLines: quotes.length, missedLines }
  }

  /**
   * 台词复用率闸门（P1-2，2026-08-24）：演出素材进入正文的可验证收据。
   *
   * 旧链路里 transcript 全量注入 weave prompt，但 Writer 提示词明确豁免复用义务，
   * PostWriteGuard 只查字数/复读/角色名出现——实测台词正文复用率仅 15%~44%，
   * 「别回头，趴下！」这类关键动作台词直接消失且无人发现。
   *
   * 现在编织后计算复用率：低于阈值且推演台词足够多（≥ FIDELITY_MIN_QUOTED_LINES）
   * 时，携带未落地台词清单定向重写一次（PostWriteGuard 照常把关），取两次中
   * 复用率较高者。结果写入 this.transcriptReuseRate → diagnostics.transcriptReuseRate，
   * 形成"演出已进正文"的第四态记录。
   */
  private async ensureTranscriptFidelity(
    content: string,
    writer: DiscussionMember,
    history: DiscussionMessage[],
    members: DiscussionMember[],
    goal: DiscussionGoal,
    options: DiscussionOptions,
    originalPrompt: string,
  ): Promise<string> {
    const first = this.computeTranscriptFidelity(content, history, members)
    this.transcriptReuseRate = first.rate
    if (
      first.totalLines < DISCUSSION_LIMITS.FIDELITY_MIN_QUOTED_LINES
      || first.rate >= DISCUSSION_LIMITS.FIDELITY_RATE_THRESHOLD
    ) {
      return content
    }

    const percent = Math.round(first.rate * 100)
    const listed = first.missedLines
      .slice(0, DISCUSSION_LIMITS.FIDELITY_MAX_LISTED)
      .map(line => `- ${line}`)
      .join('\n')
    this.emitProgress(options, 'chapter_weaving', {
      type: 'phase_change',
      data: { message: `⚠️ 角色台词正文复用率仅 ${percent}%（${first.missedLines.length}/${first.totalLines} 条未落地），正在定向补织。` },
    })
    this.context.logger.warn(
      { rate: first.rate, totalLines: first.totalLines, missedCount: first.missedLines.length },
      '群聊编织台词复用率低于阈值，触发定向补织重写',
    )

    const rewritePrompt = `${originalPrompt}

---

## ⚠️ 上一次编织丢弃了过多角色推演台词（当前复用率 ${percent}%）

以下推演台词在正文中找不到踪迹。请重写完整章节正文，把它们之中至少一半自然织入对应场景（可直接引用、可拆成被打断的半句、可嵌入叙述转述），其余确实与场景目标冲突的才允许舍弃：

${listed}

再次强调：推演中每个角色说过的关键台词，其语义都必须在正文中有着落；字数硬约束不变。`
    try {
      const rewritten = await this.invokeMember(writer, rewritePrompt, [], options, { phase: 'chapter_weaving' })
      const guarded = await this.guardAndMaybeRewrite(
        rewritten, writer, rewritePrompt, options, goal.targetWords, goal.requiredMentions,
      )
      const second = this.computeTranscriptFidelity(guarded, history, members)
      // 取复用率更高的一版；重写退化时不回退内容
      if (second.rate >= first.rate) {
        this.transcriptReuseRate = second.rate
        return guarded
      }
      return content
    } catch (err) {
      if (options.signal?.aborted) throw err
      this.context.logger.warn({ err }, '台词定向补织重写失败，保留首次编织正文')
      return content
    }
  }

  /**
   * 场景推演摘要（P1-3）：给 Reviser 的角色声音基准。
   * 修订阶段看不到演出素材时，会把 Writer 已落地的角色声音当冗余删掉（二次抹平）。
   */
  private buildTranscriptDigest(history: DiscussionMessage[], members: DiscussionMember[]): string {
    const characterIds = new Set(members.filter(m => m.type === 'character').map(m => m.id))
    const lines: string[] = []
    for (const message of history) {
      if (message.type !== 'member' || !characterIds.has(message.fromId)) continue
      const sceneLabel = message.sceneId != null ? `（场景${message.sceneId}）` : ''
      const body = message.content.length > 200 ? `${message.content.slice(0, 200)}…` : message.content
      lines.push(`[${message.fromName}]${sceneLabel} ${body}`)
    }
    return lines.slice(0, 24).join('\n\n')
  }

  /**
   * 对 Writer 编织后的正文执行 PostWriteGuard，命中则重写一次。
   *
   * 重写策略：在原始 prompt 后追加"上一次输出问题"提示，让 Writer 针对性修正。
   * 最多重写 1 次，重写后不再检测（避免无限循环），交给 reviewFinalChapter 兜底。
   */
  private async guardAndMaybeRewrite(
    content: string,
    writer: DiscussionMember,
    originalPrompt: string,
    options: DiscussionOptions,
    targetWords?: number,
    requiredMentions?: string[],
  ): Promise<string> {
    const guard = this.runDiscussionPostWriteGuard(content, targetWords, requiredMentions)
    if (!guard.shouldRewrite) return content

    this.emitProgress(options, 'chapter_weaving', {
      type: 'phase_change',
      data: {
        message: `正文质量门命中：${guard.reason}（${guard.details ?? ''}），写作 Agent 正在重写...`,
      },
    })
    this.context.logger.warn(
      { reason: guard.reason, details: guard.details, contentLength: content.length },
      '群聊正文质量门命中，触发 Writer 重写',
    )

    const rewritePrompt = `${originalPrompt}\n\n---\n\n## 上一次输出问题（请避免）\n\n- ${guard.reason}：${guard.details ?? ''}\n\n请重新编织完整章节正文，确保本次输出完整、字数达标、无重复或拒绝内容。`
    const rewritten = await this.invokeMember(
      writer,
      rewritePrompt,
      [],
      options,
      { phase: 'chapter_weaving' },
    )
    const rewrittenGuard = this.runDiscussionPostWriteGuard(
      rewritten,
      targetWords,
      requiredMentions,
    )
    if (
      rewrittenGuard.shouldRewrite
      && ['正文过短', '模型未输出正文', '模型拒绝输出', '模型复读'].includes(rewrittenGuard.reason)
    ) {
      this.context.logger.warn(
        { reason: rewrittenGuard.reason, details: rewrittenGuard.details },
        '群聊 Writer 重写结果退化，保留原正文交给 Reviewer',
      )
      return content
    }
    return rewritten
  }

  /**
   * 全章编织：一次性整合所有场景的剧本记录为完整章节正文。
   *
   * 设计变更：不再逐场景 weaveScene，而是收集所有场景的角色推演剧本，
   * 由 Writer 一次性编织全章。这样：
   * 1. Writer 只触发 1 次，避免多次触发的风格割裂
   * 2. Writer 能看到全章所有剧本，节奏把控更全局
   * 3. 角色有充分空间对戏，剧本素材更丰富
   */
  private async weaveChapter(
    members: DiscussionMember[],
    history: DiscussionMessage[],
    scenes: SceneDefinition[],
    goal: DiscussionGoal,
    options: DiscussionOptions,
    chapterConvergerId?: string,
    /** 演出缺口质量契约（acting-policy 生成）：告诉 Writer 哪些戏不能编。 */
    writerContract?: string,
  ): Promise<string> {
    const writer = members.find(m => m.canConverge)
      ?? (chapterConvergerId ? members.find(m => m.id === chapterConvergerId) : undefined)
      ?? members[0]
    if (!writer) throw new Error('无可收敛成员')

    // 从 history 提取每个场景的角色推演剧本（type='member' 且 sceneId 匹配）
      const sceneScripts = scenes.map(scene => {
        const sceneMessages = history.filter(m => m.sceneId === scene.sceneId && m.type === 'member')
        const transcript = sceneMessages.map(m => {
          const actorTurn = m.actorTurn
          if (!actorTurn) return `[${m.fromName}] ${m.content}`
          return `[${m.fromName}] ${m.content}\n` +
            `[角色判断，仅 Writer 可见]\n` +
            `- 内心：${actorTurn.innerThought}\n` +
            `- 冲突：${actorTurn.conflictReading}\n` +
            `- 应对：${actorTurn.responsePlan}\n` +
            `- 后果：${actorTurn.consequence}`
        }).join('\n\n')
      return { scene, transcript }
    })

    // 兜底：群聊未产出任何场景剧本。
    //
    // 2026-08-28 起这条路径只在用户于 Phase 2.5 闸门显式选择"继续编织"后才可达
    // （闸门已确认没有任何场景演成），因此不再按 allowLegacyActing 区分：
    // 用户已经知道这是 Writer 独立成文。
    const hasAnyScript = sceneScripts.some(s => s.transcript.length > 0)
    if (scenes.length === 0 || !hasAnyScript) {
      history.push(this.systemMessage('【降级】本章未产生可用的角色推演剧本，Writer 直接基于群聊记录成文。'))
      this.emitProgress(options, 'chapter_weaving', {
        type: 'phase_change',
        data: { message: '⚠️ 未获取到角色推演剧本，Writer 进入盲写降级路径（本章没有角色演出素材）。' },
      })
      const targetHint = goal.targetWords
        ? `正文必须控制在 ${Math.round(goal.targetWords * 0.85)}-${Math.round(goal.targetWords * 1.30)} 字，目标约 ${goal.targetWords} 字。生成后自行计数并删减或补足。`
        : ''
      const fallbackPrompt = `请基于群聊记录产出完整章节正文。${targetHint}`
      const result = await this.invokeMember(writer, fallbackPrompt, [], options, { phase: 'chapter_weaving' })
      // PostWriteGuard：模型退化/字数失控检测，命中则让 Writer 重写一次
      return this.guardAndMaybeRewrite(
        result, writer, fallbackPrompt, options, goal.targetWords, goal.requiredMentions,
      )
    }

    // 构建全章剧本上下文：每个场景的信息 + 角色推演记录
    const combined = sceneScripts.map((entry, i) => {
      const s = entry.scene
      // 有缺口的场景不再提示"请基于场景信息补写"——那正是编造的来源。
      // 具体缺口与处理方式由 writerContract 统一给出。
      const scriptBlock = entry.transcript.length > 0
        ? entry.transcript
        : '（本场景没有角色演出，见下方「演出缺口」约束）'
      return `### 场景${i + 1}：${s.title}
- 地点：${s.location}
- 时间：${s.time}
- 冲突：${s.conflict ?? '无'}
- 目标：${s.goal}
- 情绪：${s.emotion ?? '未指定'}
- 戏剧动作节点：${s.actionBeats?.map(beat => `${beat.actor}${beat.target ? `→${beat.target}` : ''}：${beat.action}；选择：${beat.choice}；后果：${beat.consequence}`).join(' / ') || '无'}

## 角色推演记录
${scriptBlock}`
    }).join('\n\n---\n\n')

    const targetHint = goal.targetWords
      ? `本章目标字数为 ${goal.targetWords} 字，允许范围 ${Math.round(goal.targetWords * 0.85)}-${Math.round(goal.targetWords * 1.30)} 字。输出前自行估算正文长度，必须在此范围内。`
      : '控制正文长度，不要无目的扩写。'
    const prompt = `请将以下各场景的角色推演一次性编织为完整章节正文。

## 字数硬约束
${targetHint}

## 全章剧本（共 ${scenes.length} 个场景）
${combined}
${writerContract ? `\n${writerContract}\n` : ''}
## 编织要求
1. 把角色的“意图 / 心理 / 应对”推演转化为小说叙事，不要把推演标签原样写入正文
2. 统一叙事视角；只在场景切换或建立新空间时补必要的环境描写，不得为凑字数堆砌景物、心理或动作描写
3. 场景之间自然过渡，不要生硬拼接，确保整体节奏流畅
4. 根据角色推演补全必要的动作和台词，但不得擅自改变角色意图、心理状态和应对策略
5. 各场景的情绪应衔接成完整的全章情绪曲线，与 Director 规划的情绪走向呼应
6. 多名同性角色同场时，段首、动作主体切换和对话归属必须写角色姓名；“他/她”只能在唯一先行词明确时使用
7. 绝不使用长横线破折号
8. **优先保证剧情推进和信息密度**：每个段落都应推进事件、暴露信息或改变角色状态；若剧情已在更短篇幅内完整表达，宁可缩短正文也不要用"他深吸一口气""她看向远方"等空转描写凑字数`

    const result = await this.invokeMember(writer, prompt, [], options, { phase: 'chapter_weaving' })
    // PostWriteGuard：模型退化/字数失控检测，命中则让 Writer 重写一次
    const guarded = await this.guardAndMaybeRewrite(
      result, writer, prompt, options, goal.targetWords, goal.requiredMentions,
    )
    // P1-2：台词复用率闸门——低于阈值时携带未落地台词清单定向补织一次
    return this.ensureTranscriptFidelity(
      guarded, writer, history, members, goal, options, prompt,
    )
  }

  /** 对 Writer 编织后的完整正文执行 Reviewer + 可选 Reviser 闭环。 */
  private async reviewFinalChapter(
    content: string,
    members: DiscussionMember[],
    history: DiscussionMessage[],
    options: DiscussionOptions,
    targetWords?: number,
  ): Promise<{ status: 'completed'; content: string; review?: ReviewerOutcome } | { status: 'cancelled'; content: string; review?: ReviewerOutcome }> {
    const reviewer = members.find(member => member.id === 'novel-reviewer')
    if (!reviewer) return { status: 'completed', content }

    this.emitProgress(options, 'reviewing', {
      type: 'phase_change',
      data: { message: '审稿 Agent 正在验收完整章节' },
    })
    const finalReviewer = reviewer.buildFinalReviewSystemPrompt
      ? {
          ...reviewer,
          buildSystemPrompt: reviewer.buildFinalReviewSystemPrompt,
          buildIdentityPrompt: reviewer.buildFinalReviewIdentityPrompt
            ?? reviewer.buildIdentityPrompt,
          // 最终验收走标准角色方法（novel-reviewer），与主身份的群聊审查 Skill 不同
          skill: reviewer.finalReviewSkill ?? reviewer.skill,
        }
      : reviewer
    const targetHint = targetWords
      ? `\n\n## 字数验收\n目标 ${targetWords} 字，建议范围 ${Math.round(targetWords * 0.85)}-${Math.round(targetWords * 1.15)} 字。轻微偏离需结合章节完整性判断；只有低于 ${Math.round(targetWords * 0.75)} 或高于 ${Math.round(targetWords * 1.30)} 字才必须给出 revise。`
      : ''
    const proseQualityReport = options.buildProseQualityReport?.(content) ?? ''
    const proseEditor: DiscussionMember = {
      ...reviewer,
      name: '文字编辑',
      buildSystemPrompt: () => '',
      buildContextPrompt: () => '',
      buildIdentityPrompt: reviewer.buildProseEditorIdentityPrompt
        ?? reviewer.buildFinalReviewIdentityPrompt
        ?? reviewer.buildIdentityPrompt,
      // 盲审文字编辑不注入共享上下文，也不挂 Skill（与标准工作流盲审一致）
      skill: undefined,
    }
    const proseEditorReport = await this.invokeMember(
      proseEditor,
      `请只从文字读感盲审以下正文。\n\n## 待审正文\n\n${content}${proseQualityReport ? `\n\n---\n\n${proseQualityReport}` : ''}`,
      [],
      options,
      { phase: 'reviewing' },
    )
    // ⚠️ 工具化方案：业务层通过 buildReviewerToolset 提供 draft + 工具。
    // 引擎把工具注入 Reviewer 的 LLM 调用。Reviewer 必须调用 novel_submit_review
    // 工具才能提交结构化验收对象（十维评分 + verdict + issues + suggestions），
    // 工具参数 schema 强制校验，完全绕开正则解析。
    // 旧路径让 Reviewer 输出 Markdown 报告，再用 parseChapterReviewReport 正则解析，
    // LLM 不严格遵守格式时评分/结论降级为 null，Reviewer 的真实判断丢失。
    const reviewToolset = options.buildReviewerToolset?.()
    const report = await this.invokeMember(
      finalReviewer,
      `请验收以下群聊编织完成的章节正文，并必须通过调用 novel_submit_review 工具提交结构化验收报告（十维评分、verdict、issues、suggestions），不要在对话文本中输出 Markdown 评分表或 Findings 表格。${targetHint}

## 待审稿章节正文

${content}${proseQualityReport ? `\n\n---\n\n${proseQualityReport}` : ''}\n\n---\n\n## 盲审文字编辑意见\n\n${proseEditorReport}`,
      [],
      options,
      { phase: 'reviewing', extraTools: reviewToolset?.tools },
    )
    // Reviewer 结束后立即取得 outcome，无论后续决策如何都透传给上层
    const reviewOutcome: ReviewerOutcome | null = reviewToolset?.extractResult() ?? null
    if (reviewOutcome && !reviewOutcome.toolCalled) {
      this.context.logger.warn(
        { reviewLength: report.length },
        '群聊 Reviewer 未调用 novel_submit_review 工具提交验收报告',
      )
    }
    history.push({
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fromId: reviewer.id,
      fromName: reviewer.name,
      content: report,
      timestamp: Date.now(),
      type: 'member',
    })

    const decision = await options.onCheckpoint({
      type: 'review',
      phase: 'reviewing',
      question: '完整章节审稿已完成，请确认是否采用或修订。',
      options: ['approve', 'revise', 'reject'],
      context: report,
    })
    if (decision === 'reject') return { status: 'cancelled', content, review: reviewOutcome ?? undefined }
    const wordCount = content.replace(/\s/g, '').length
    // 仅严重偏离触发自动 Reviser；轻微偏离由 Reviewer/用户决定。
    const lengthOutOfRange = targetWords != null && (
      wordCount < targetWords * 0.75 || wordCount > targetWords * 1.30
    )
    if (decision !== 'revise' && decision !== 'rewrite' && !lengthOutOfRange) {
      return { status: 'completed', content, review: reviewOutcome ?? undefined }
    }

    const reviser = members.find(member => member.id === 'novel-reviser')
    if (!reviser) return { status: 'completed', content, review: reviewOutcome ?? undefined }
    // ⚠️ 工具化方案：业务层通过 buildReviserToolset 提供 draft + 工具，
    // 引擎把工具注入 Reviser 的 LLM 调用。Reviser 必须调用 novel_apply_revision
    // 工具才能修改正文，工具内部用 String.replace 做精确替换，完全绕开正则解析。
    // 旧 applyRevision 回调让 Reviser 输出"原文/修改后"配对文本再正则解析，
    // LLM 不严格遵守格式时会走 full 兜底把"修改意见"当作完整正文落库。
    const toolset = options.buildReviserToolset?.(content)
    // P1-3（2026-08-24）：Reviser 必须看到角色推演摘要。修订阶段若看不到演出素材，
    // 会把 Writer 已落地的角色声音当冗余删掉，造成二次抹平。
    const transcriptDigest = this.buildTranscriptDigest(history, members)
    const rawRevision = await this.invokeMember(
      reviser,
      `请根据审稿意见修订章节，必须通过调用 novel_apply_revision 工具应用修改，不要在对话文本中输出"原文/修改后"配对。${targetWords ? `修订后正文目标约 ${targetWords} 字。` : ''}

## 原章节正文

${content}

## 审稿意见

${report}${transcriptDigest ? `

## 角色推演记录（修订时的角色声音基准）

以下是小组成员在推演中的原始发言。正文中已落地的台词和动作是其语义的载体：修订可以润色句式，但不得整体删除或替换角色的核心表达。

${transcriptDigest}` : ''}`,
      [],
      options,
      { phase: 'reviewing', extraTools: toolset?.tools },
    )
    let revisedContent: string
    if (toolset) {
      const outcome = toolset.extractResult()
      if (outcome.mode === 'rejected' || outcome.successCount === 0) {
        this.context.logger.warn(
          {
            reason: outcome.reason,
            mode: outcome.mode,
            appliedPatchCount: outcome.appliedPatchCount,
            successCount: outcome.successCount,
          },
          '群聊 Reviser 未通过工具成功应用任何修订，保留原正文',
        )
      } else {
        this.context.logger.info(
          {
            appliedPatchCount: outcome.appliedPatchCount,
            successCount: outcome.successCount,
            originalLength: content.length,
            revisedLength: outcome.content.length,
          },
          '群聊 Reviser 已通过工具应用修订',
        )
      }
      revisedContent = outcome.content
    } else {
      // 业务层未提供 buildReviserToolset：保留原正文（避免误把 Reviser 文本输出当作完整正文落库）
      this.context.logger.warn(
        { rawRevisionLength: rawRevision.length },
        '业务层未提供 buildReviserToolset，群聊 Reviser 修订未应用，保留原正文',
      )
      revisedContent = content
    }
    history.push({
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fromId: reviser.id,
      fromName: reviser.name,
      content: rawRevision,
      timestamp: Date.now(),
      type: 'member',
    })
    return { status: 'completed', content: revisedContent, review: reviewOutcome ?? undefined }
  }

  /** 解析 Director 输出为场景列表 */
  /**
   * 工具提交的场景计划 → Director 可见气泡正文。
   *
   * 工具调用后的终答可能是空 stop，不能只用工具摘要或依赖 TEXT_MESSAGE_CONTENT；
   * 这里直接把工具参数中的完整结构写入 transcript，并通过 agent_output 实时推给前端。
   */
  private formatSubmittedScenePlan(scenes: SubmittedSceneInput[]): string {
    const sections = scenes.map((scene, index) => [
      `### 场景${index + 1}：${scene.title}`,
      `- 地点：${scene.location}`,
      `- 时间：${scene.time}`,
      `- 冲突：${scene.conflict ?? '无'}`,
      `- 目标：${scene.goal}`,
      `- 情绪：${scene.emotion ?? '未指定'}`,
      `- 在场角色：${scene.presentCharacters.length > 0 ? scene.presentCharacters.join('、') : '未指定'}`,
    ].join('\n'))
    return `## 场景拆分计划（已通过工具提交）\n\n${sections.join('\n\n')}`
  }

  /** 工具提交的原始场景 → SceneDefinition（角色名映射为成员 ID，未命中记入 unresolvedCharacterNames） */
  private toSceneDefinitions(inputs: SubmittedSceneInput[], members: DiscussionMember[]): SceneDefinition[] {
    const nameToId = new Map<string, string>()
    for (const member of members) {
      if (member.type === 'character') {
        nameToId.set(this.normalizeCharacterName(member.name), member.id)
      }
    }
    return inputs.flatMap((input, index) => {
      const names = input.presentCharacters.map(name => name.trim()).filter(Boolean)
      const presentCharacters = names
        .map(name => nameToId.get(this.normalizeCharacterName(name)))
        .filter((id): id is string => !!id)
      const unmatchedNames = names.filter(name => !nameToId.has(this.normalizeCharacterName(name)))
      if (unmatchedNames.length > 0) {
        this.context.logger.warn(
          { title: input.title, unmatchedNames, availableCharacters: Array.from(nameToId.keys()) },
          '场景计划在场角色名匹配不上成员列表，未命中者将走动态角色解析',
        )
      }
      // 工具 schema 无场景编号字段：数组顺序即演出顺序，sceneId 按序分配（1 起）
      return {
        sceneId: index + 1,
        title: input.title,
        location: input.location,
        time: input.time,
        conflict: input.conflict,
        goal: input.goal,
        emotion: input.emotion,
        presentCharacters,
        presentCharacterNames: names,
        unresolvedCharacterNames: unmatchedNames,
        actionBeats: this.toActionBeats(input.actionBeats, names, nameToId),
        actionBeatInputs: input.actionBeats,
        legacyPlan: !input.actionBeats || input.actionBeats.length === 0,
      }
    })
  }

  /** 将 Director 提交的角色名动作图转换为 canonical member ID 动作图。 */
  private toActionBeats(
    inputs: SubmittedSceneInput['actionBeats'],
    presentNames: string[],
    nameToId: Map<string, string>,
  ): SceneActionBeat[] {
    if (!inputs || inputs.length === 0) return []
    const present = new Set(presentNames.map(name => this.normalizeCharacterName(name)))
    return inputs.flatMap((input, index) => {
      const actorName = this.normalizeCharacterName(input.actor)
      const targetName = input.target ? this.normalizeCharacterName(input.target) : undefined
      const nextActorName = input.nextActor ? this.normalizeCharacterName(input.nextActor) : undefined
      const actor = nameToId.get(actorName)
      const target = targetName ? nameToId.get(targetName) : undefined
      const nextActor = nextActorName ? nameToId.get(nextActorName) : undefined
      if (!actor || !present.has(actorName) || (targetName && (!target || !present.has(targetName))) || (nextActorName && (!nextActor || !present.has(nextActorName)))) {
        this.context.logger.warn(
          { beatId: input.beatId, actor: input.actor, target: input.target, nextActor: input.nextActor },
          '动作节点角色不在本场在场名单，已丢弃不可执行节点',
        )
        return []
      }
      return [{
        beatId: input.beatId.trim() || `action-${index + 1}`,
        actor,
        ...(target ? { target } : {}),
        pressure: input.pressure.trim(),
        action: input.action.trim(),
        choice: input.choice.trim(),
        consequence: input.consequence.trim(),
        ...(nextActor ? { nextActor } : {}),
        exitCondition: input.exitCondition.trim(),
      }]
    })
  }

  private moderatorMessage(content: string): DiscussionMessage {
    return {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fromId: 'moderator',
      fromName: '主持人',
      content,
      timestamp: Date.now(),
      type: 'moderator',
    }
  }

  /**
   * 出场角色白名单（2026-08-24）：编排了角色清单时过滤 Director 点名。
   * 以"允许成员的名字→ID 映射"为准双口径过滤：不在白名单的名字从
   * presentCharacters/presentCharacterNames 中剔除、unresolved 清空，
   * 并写入 system 警告，让用户与后续角色都知道该角色被编排约束拦截。
   */
  private applyCastWhitelist(
    scenes: SceneDefinition[],
    history: DiscussionMessage[],
    options: DiscussionOptions,
    members: DiscussionMember[],
  ): void {
    const allowed = options.allowedCharacterMemberIds
    if (!allowed || allowed.length === 0) return
    const allowedSet = new Set(allowed)
    const nameToAllowedId = new Map(
      members
        .filter(member => member.type === 'character' && allowedSet.has(member.id))
        .map(member => [this.normalizeCharacterName(member.name), member.id]),
    )
    const droppedNames: string[] = []
    for (const scene of scenes) {
      const names = scene.presentCharacterNames ?? []
      if (names.length > 0) {
        const keptNames: string[] = []
        const keptIds: string[] = []
        for (const name of names) {
          const id = nameToAllowedId.get(this.normalizeCharacterName(name))
          if (id) {
            keptNames.push(name)
            keptIds.push(id)
          } else {
            droppedNames.push(name)
          }
        }
        scene.presentCharacterNames = keptNames
        scene.presentCharacters = keptIds
        scene.unresolvedCharacterNames = []
        // 白名单是硬约束：动作图必须按裁剪后的在场名单重算。
        // 否则被拦截角色的 actionBeat 仍带着 canonical ID 留在计划里
        // （toSceneDefinitions 映射时用的是全量成员表），演出阶段 actor
        // 查不到成员 → 每个这样的节点都白白触发一次 Moderator 异常仲裁。
        if (scene.actionBeatInputs?.length) {
          scene.actionBeats = this.toActionBeats(scene.actionBeatInputs, keptNames, nameToAllowedId)
        } else if (scene.actionBeats?.length) {
          scene.actionBeats = scene.actionBeats.filter(beat =>
            allowedSet.has(beat.actor)
            && (!beat.target || allowedSet.has(beat.target))
            && (!beat.nextActor || allowedSet.has(beat.nextActor)),
          )
        }
      } else if (scene.presentCharacters.length > 0) {
        // 无名字口径（旧快照）时按 ID 直接过滤
        scene.presentCharacters = scene.presentCharacters.filter(id => allowedSet.has(id))
        if (scene.actionBeats?.length) {
          scene.actionBeats = scene.actionBeats.filter(beat =>
            allowedSet.has(beat.actor)
            && (!beat.target || allowedSet.has(beat.target))
            && (!beat.nextActor || allowedSet.has(beat.nextActor)),
          )
        }
      }
    }
    if (droppedNames.length > 0) {
      const detail = Array.from(new Set(droppedNames)).join('、')
      history.push(this.systemMessage(`【编排约束】以下角色不在本章编排清单中，已拦截不出场：${detail}`))
      this.emitProgress(options, 'planning', {
        type: 'phase_change',
        data: { message: `⚠️ 编排外角色已拦截：${detail}（如需让其出场请回到矩阵编排）` },
      })
      this.context.logger.warn({ droppedNames }, '编排外角色已被白名单拦截')
    }
  }

  /** 汇总演绎链路诊断快照（run 各返回点共用同一口径） */
  private buildDiagnosticsSnapshot(input: {
    sceneSource: DiscussionDiagnostics['sceneSource']
    scenes: SceneDefinition[]
    history: DiscussionMessage[]
    members: DiscussionMember[]
    planningRetries: number
    /** 策略表汇总；缺失（异常/取消提前返回）时回退到按 transcript 推算。 */
    actingSummary?: ActingSummary
  }): DiscussionDiagnostics {
    const { sceneSource, scenes, history, members, planningRetries, actingSummary } = input
    const characterMemberIds = new Set(members.filter(m => m.type === 'character').map(m => m.id))
    const emptyCount = scenes.filter(scene =>
      !history.some(m => m.type === 'member' && m.sceneId === scene.sceneId && characterMemberIds.has(m.fromId)),
    ).length
    return {
      sceneSource,
      scenesTotal: scenes.length,
      scenesWithActing: actingSummary?.productiveScenes ?? scenes.length - emptyCount,
      characterSpeeches: history.filter(m => m.type === 'member' && characterMemberIds.has(m.fromId)).length,
      formatCorrections: 0,
      planningRetries,
      plannerInvocations: this.plannerInvocations,
      moderatorDegradedRounds: 0,
      autonomousCharacterTurns: this.autonomousCharacterTurns,
      autonomousMentions: this.autonomousMentions,
      mentionResponseTurns: actingSummary?.reactionTurns,
      degradedContinues: actingSummary
        ? actingSummary.incompleteBeats
        : undefined,
      barrenSceneIds: actingSummary?.barrenSceneIds,
      incompleteActionBeatIds: actingSummary?.incompleteBeatIds,
      moderatorExceptionInvocations: 0,
      characterTurnFailures: this.characterTurnFailures,
      characterTurnCancelled: this.characterTurnCancelled,
      completedActionBeats: this.completedActionBeats,
      totalMemberInvocations: this.totalMemberInvocations,
      // Moderator 已删除（2026-08-28 控制平面重排）：新 run 的 Moderator 调用恒为 0。
      totalModeratorInvocations: 0,
      totalLlmRoundTrips: this.totalLlmRoundTrips,
      totalDurationMs: this.runStartedAt > 0 ? Date.now() - this.runStartedAt : undefined,
      legacyPlanScenes: scenes.filter(scene => scene.legacyPlan || !scene.actionBeats?.length).length,
      // 策略表口径优先：thin/skipped/unreached 都算缺口。
      // 无策略表数据时回退按 transcript 推算（异常提前返回、resume 路径）。
      incompleteActionBeats: actingSummary?.incompleteBeats ?? scenes.reduce((sum, scene) => {
        if (!scene.actionBeats?.length) return sum
        const acted = new Set(history
          .filter(message => message.type === 'member' && message.sceneId === scene.sceneId)
          .map(message => message.actorTurn?.actionBeatId)
          .filter((beatId): beatId is string => Boolean(beatId)))
        return sum + Math.max(0, scene.actionBeats.length - acted.size)
      }, 0),
    }
  }

  private parseScenes(history: DiscussionMessage[], members: DiscussionMember[]): SceneDefinition[] {
    const directorIds = new Set(
      members
        .filter(member => member.type === 'role' && (member.id === 'novel-director' || member.id.includes('director')))
        .map(member => member.id),
    )
    const directorMsg = [...history].reverse().find(m => m.type === 'member' && directorIds.has(m.fromId))
    if (!directorMsg) return []

    const nameToId = new Map<string, string>()
    for (const m of members) {
      if (m.type === 'character') {
        nameToId.set(this.normalizeCharacterName(m.name), m.id)
      }
    }

    const scenes: SceneDefinition[] = []
    const sceneRegex = /###\s*场景\s*(\d+)[：:]\s*(.+?)(?=\n###\s*场景|$)/gs
    const matches = directorMsg.content.matchAll(sceneRegex)

    for (const match of matches) {
      const sceneId = parseInt(match[1], 10)
      const block = match[2]
      const title = block.split('\n')[0].trim()
      const location = this.extractField(block, '地点') ?? '未指定'
      const time = this.extractField(block, '时间') ?? '未指定'
      const conflict = this.extractField(block, '冲突') ?? undefined
      const goalText = this.extractField(block, '目标') ?? ''
      const emotion = this.extractField(block, '情绪') ?? undefined

      const presentNamesRaw = this.extractField(block, '在场角色') ?? ''
      const presentNames = presentNamesRaw.split(/[、,，\s]+/).filter(Boolean)
      const presentCharacters = presentNames
        .map(name => nameToId.get(this.normalizeCharacterName(name)))
        .filter((id): id is string => !!id)

      // 角色名匹配不上的警告：Director 可能写了项目不存在的角色名
      const unmatchedNames = presentNames.filter(name => !nameToId.has(this.normalizeCharacterName(name)))
      if (unmatchedNames.length > 0) {
        this.context.logger.warn(
          { sceneId, title, unmatchedNames, availableCharacters: Array.from(nameToId.keys()) },
          '场景在场角色名匹配不上项目角色列表，这些角色不会参与群聊。请检查 Director 输出的角色名是否与项目角色名一致。',
        )
      }

      scenes.push({
        sceneId,
        title,
        location,
        time,
        presentCharacters,
        presentCharacterNames: presentNames,
        unresolvedCharacterNames: unmatchedNames,
        conflict,
        goal: goalText,
        emotion,
      })
    }

    return scenes
  }

  /** 构建场景上下文摘要（注入群聊历史，告知成员当前场景信息） */
  private buildSceneContext(scene: SceneDefinition): string {
    return `## 场景${scene.sceneId}：${scene.title}
- 地点：${scene.location}
- 时间：${scene.time}
- 冲突：${scene.conflict ?? '无'}
- 目标：${scene.goal}
- 情绪：${scene.emotion ?? '未指定'}`
  }

  /** 从 markdown 块中提取字段值 */
  private extractField(block: string, fieldName: string): string | undefined {
    const regex = new RegExp(`-\\s*${fieldName}[：:]\\s*(.+)`)
    const match = block.match(regex)
    return match?.[1]?.trim()
  }

  /**
   * 过滤场景在场成员。
   *
   * 工种 Agent（role 类型）始终保留（Director/Writer/Reviewer 等）。
   * 角色成员按 scene.presentCharacters 过滤。
   * 如果场景指定了在场角色但全部匹配不上（Director 写错名字），回退为所有角色成员，
   * 避免场景无角色可演。
   */
  private filterMembersByScene(members: DiscussionMember[], scene: SceneDefinition): DiscussionMember[] {
    const roleMembers = members.filter(m => m.type === 'role')
    const characterMembers = members.filter(m => m.type === 'character')

    if (!scene.presentCharacterNames || scene.presentCharacterNames.length === 0) {
      // Director 未指定在场角色时才允许所有角色参与
      return members
    }

    const presentCharacters = characterMembers.filter(m => scene.presentCharacters.includes(m.id))
    if (presentCharacters.length === 0) {
      // 明确指定但仍无可用角色时只保留工种成员，不让无关角色顶替
      this.context.logger.warn(
        { sceneId: scene.sceneId, title: scene.title, expectedPresent: scene.presentCharacters },
        '场景在场角色全部匹配不上成员列表，不拉入无关角色',
      )
      return roleMembers
    }

    return [...roleMembers, ...presentCharacters]
  }

  private async resolveSceneCharacters(
    scenes: SceneDefinition[],
    members: DiscussionMember[],
    options: DiscussionOptions,
    channelName: string,
  ): Promise<void> {
    const unresolvedNames = Array.from(new Set(
      scenes.flatMap(scene => scene.unresolvedCharacterNames ?? []),
    ))
    if (unresolvedNames.length === 0 || !options.resolveCharacterMembers) return

    // 编排白名单（2026-08-24）：编排了角色清单时不再动态建临时角色，
    // 白名单外的名字已在 applyCastWhitelist 拦截；此处兜底防漏。
    if (options.allowedCharacterMemberIds && options.allowedCharacterMemberIds.length > 0) {
      this.context.logger.warn(
        { unresolvedNames, allowedCount: options.allowedCharacterMemberIds.length },
        '存在编排白名单，跳过动态角色解析',
      )
      return
    }

    const resolvedMembers = await options.resolveCharacterMembers(unresolvedNames)
    for (const member of resolvedMembers) {
      if (member.type !== 'character' || members.some(existing => existing.id === member.id)) continue
      members.push(member)
      this.channel.subscribe(channelName, member.id)
    }

    const nameToId = new Map(
      members
        .filter(member => member.type === 'character')
        .map(member => [this.normalizeCharacterName(member.name), member.id]),
    )
    for (const scene of scenes) {
      const names = scene.presentCharacterNames ?? []
      scene.presentCharacters = names
        .map(name => nameToId.get(this.normalizeCharacterName(name)))
        .filter((id): id is string => !!id)
      scene.unresolvedCharacterNames = names
        .filter(name => !nameToId.has(this.normalizeCharacterName(name)))
      scene.actionBeats = this.toActionBeats(
        scene.actionBeatInputs,
        names,
        nameToId,
      )
    }
  }

  private normalizeCharacterName(name: string): string {
    return name
      .normalize('NFKC')
      .trim()
      .replace(/^(?:「|『|【|\[)/, '')
      .replace(/(?:」|』|】|\])$/, '')
      .toLocaleLowerCase()
  }

  /** 格式化群聊记录摘要（给成员看） */
  private formatTranscriptForMember(history: DiscussionMessage[], memberId: string): string {
    const recent = history.slice(-10)
    return recent.map(m => {
      const publicLine = `[${m.fromName}] ${m.content}`
      // 角色只接收公共演出；Writer 可以读取角色私有判断，避免信息差泄漏。
      if (memberId === 'novel-writer' && m.actorTurn) {
        return `${publicLine}\n[角色私有判断，仅 Writer 可见]\n- 内心：${m.actorTurn.innerThought}\n- 冲突：${m.actorTurn.conflictReading}\n- 应对：${m.actorTurn.responsePlan}\n- 后果：${m.actorTurn.consequence}`
      }
      return publicLine
    }).join('\n\n')
  }

  private systemMessage(content: string): DiscussionMessage {
    return {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      fromId: 'system',
      fromName: '系统',
      content,
      timestamp: Date.now(),
      type: 'system',
    }
  }

  private errorMessage(content: string): DiscussionMessage {
    return {
      id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      fromId: 'system',
      fromName: '系统',
      content,
      timestamp: Date.now(),
      type: 'error',
    }
  }

  private emitProgress(options: DiscussionOptions, phase: DiscussionPhase, event: { type: DiscussionFlowEvent['type']; data: unknown }): void {
    // 将事件 type 注入 data，与 workflow 模式（novel-orchestrator）保持一致，
    // 确保前端通过 data.type 识别 agent_start / phase_change 等子类型。
    const data = typeof event.data === 'object' && event.data !== null
      ? { ...(event.data as Record<string, unknown>), type: event.type }
      : { type: event.type, raw: event.data }
    options.onProgress({
      type: event.type,
      phase,
      data,
      timestamp: Date.now(),
    })
  }
}

interface DiscussionUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  llmProvider: string
  llmModel: string
}

function usageRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function usageNumber(source: Record<string, unknown> | undefined, keys: string[]): number {
  if (!source) return 0
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && Number.isFinite(Number(value))) return Number(value)
  }
  return 0
}

function usageString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (typeof source[key] === 'string') return source[key] as string
  }
  return ''
}

function extractDiscussionUsage(message: Record<string, unknown>): DiscussionUsage | undefined {
  const usage = usageRecord(message.usage) ?? message
  const snapshot: DiscussionUsage = {
    inputTokens: usageNumber(usage, ['input', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']),
    outputTokens: usageNumber(usage, ['output', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']),
    cacheReadTokens: usageNumber(usage, ['cacheRead', 'cacheReadTokens', 'cache_read_tokens', 'cachedTokens', 'cached_tokens', 'prompt_cache_hit_tokens']),
    cacheWriteTokens: usageNumber(usage, ['cacheWrite', 'cacheWriteTokens', 'cache_write_tokens', 'prompt_cache_miss_tokens']),
    llmProvider: usageString(message, ['provider', 'providerId']),
    llmModel: usageString(message, ['model', 'modelId']),
  }
  return snapshot.inputTokens + snapshot.outputTokens + snapshot.cacheReadTokens + snapshot.cacheWriteTokens > 0
    ? snapshot
    : undefined
}

function addDiscussionUsage(
  current: DiscussionUsage | undefined,
  next: DiscussionUsage,
): DiscussionUsage {
  return {
    inputTokens: (current?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + next.outputTokens,
    cacheReadTokens: (current?.cacheReadTokens ?? 0) + next.cacheReadTokens,
    cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
    llmProvider: next.llmProvider || current?.llmProvider || '',
    llmModel: next.llmModel || current?.llmModel || '',
  }
}
