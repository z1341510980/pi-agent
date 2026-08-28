/**
 * TeamDiscussionEngine：通用群聊引擎
 *
 * 驱动群聊循环：Moderator 决策 → 成员发言 → 消息入历史 → 下一轮。
 * 不依赖任何业务领域（不知道"小说"是什么）。
 *
 * 循环阶段：
 * 1. planning：Moderator 驱动规划，Director 输出场景拆分
 * 2. acting（场景循环）：每个场景内角色推演对戏（不即时编织，剧本记录到 history）
 * 3. chapter_weaving：Writer 一次性整合所有场景剧本为完整章节正文
 *
 * 设计要点：Writer 只在 Phase 3 触发 1 次，避免逐场景编织导致的多次触发和风格割裂。
 *
 * 死锁防护：
 * - 总轮数 ≤ MAX_ROUNDS(20)
 * - 单场景轮数 ≤ MAX_ROUNDS_PER_SCENE(10)
 * - 连续 observe ≤ MAX_OBSERVE_ROUNDS(3)
 * - 任一超限 → 强制 converge
 */

import type { FastifyBaseLogger } from 'fastify'
import type { AgUiSessionHandle } from '../../../../../core/plugin/plugin-types.js'
import type { PluginSessionOptions } from '../../../../../core/plugin/plugin-types.js'
import type { AgUiEventSink } from '@repo/protocol/events'
import { AgentChannel } from '../../../../../core/agent/agent-channel.js'
import { Moderator } from './moderator.js'
import type {
  DiscussionGoal,
  DiscussionInterjectMessage,
  DiscussionMember,
  DiscussionMessage,
  DiscussionOptions,
  DiscussionResult,
  DiscussionFlowEvent,
  ModeratorState,
  ModeratorDecision,
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
import {
  buildMergedActorPrompt,
  computeKnowledgeFingerprint,
  parseMergedActorResponse,
  MIN_MERGE_GROUP_SIZE,
  MAX_MERGE_GROUP_SIZE,
} from './discussion-actor-batching.js'

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
   * 由端点经 enqueueUserMessage 入队，Moderator 每轮 decide 前 drain 写入 history。
   */
  private interjectQueue: DiscussionInterjectMessage[] = []

  /**
   * 插话存活标记：run/resumeChapterWeaving 的 finally 收尾（含 dropped flush）
   * 前置 false，之后 enqueueUserMessage 拒绝受理并返回 false。插话端点在
   * 取到投递闭包与实际调用之间引擎可能刚好收尾（TOCTOU 微窗口），若仍入队
   * 只会进入无人 drain 的死队列，SSE 状态永远停在 queued。构造即置 true：
   * runner 在 engine.run 调用前就登记投递闭包，run 启动前入队的插话会在
   * 首轮 decide 被 drain。
   */
  private acceptingInterjects = true

  /**
   * 角色发言格式纠正计数（演绎链路诊断，2026-08-24）：
   * 每次进入 prepareCharacterSpeech 且首次输出未通过校验时 +1，
   * run/resume 入口重置。随 diagnostics.formatCorrections 对外暴露。
   */
  private formatCorrectionCount = 0

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

  /** 是否已对用户发出过"主持人降级"警告（每次 run 只警告一次） */
  private moderatorDegradeWarned = false

  /**
   * 当前场景计划工具集（P2.0 修复 2026-08-26）：
   * run() planning 阶段设置，供 handleDecision 在 Director 返回空串时检查工具是否已提交。
   * 推理模型（gpt-5.6-luna）工具调用后第二轮返回空 stop 是已实证行为——工具执行了，
   * 但 prompt() 只返回第二轮 text delta = 空。引擎需用工具结果替代空串。
   */
  private currentScenePlan?: ScenePlanToolset

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

  /** 当前 run 的诊断计数，不依赖 Moderator 的 degradedRounds。 */
  private moderatorExceptionInvocations = 0
  private characterTurnFailures = 0
  private characterTurnCancelled = 0
  private currentActionBeatId?: string
  private currentActionBeatSceneId?: number
  private totalMemberInvocations = 0
  private totalModeratorInvocations = 0
  private totalLlmRoundTrips = 0
  private runStartedAt = 0

  /**
   * Planning 阶段 Director 连续空响应标志（2026-08-26）：
   * 空响应且工具未提交、纠正性重试仍空时置此标志，由 planning 循环抛检查点
   * 让用户决策（重试/中止），不再静默循环邀请。
   */
  private planningDirectorEmpty = false

  constructor(
    private moderator: Moderator,
    private channel: AgentChannel,
    private context: EngineContext,
  ) {}

  /**
   * 用户插话入队（append 语义）：flow 运行中随时可调用，
   * 消息在下一轮 Moderator decide 前以 user 角色追加进群聊 history。
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
    this.moderator.resetRunState()
    // 合并运行时限制：options.limits（来自 DiscussionSettingsStore）覆盖默认 DISCUSSION_LIMITS
    const limits = {
      maxRounds: options.limits?.maxRounds ?? DISCUSSION_LIMITS.MAX_ROUNDS,
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
    let rounds = 0
    let noProgressRounds = 0
    let chapterConvergerId: string | undefined
    // 阶段/场景追踪：失败时生成 failedPhase + failedSceneId（acting 断点续跑定位）
    const track: { phase: DiscussionPhase; sceneId?: number } = { phase: 'planning' }
    // 演出链路诊断（2026-08-24）：让"演出是否真的发生"成为可查询数据
    this.formatCorrectionCount = 0
    this.transcriptReuseRate = undefined
    this.moderatorDegradeWarned = false
    this.planningDirectorEmpty = false
    this.currentScenePlan = undefined
    this.currentCharacterTurn = undefined
    this.pendingCharacterMentions = []
    this.autonomousCharacterTurns = 0
    this.autonomousMentions = 0
    this.completedActionBeats = 0
    this.moderatorExceptionInvocations = 0
    this.characterTurnFailures = 0
    this.characterTurnCancelled = 0
    this.currentActionBeatId = undefined
    this.currentActionBeatSceneId = undefined
    this.totalMemberInvocations = 0
    this.totalModeratorInvocations = 0
    this.totalLlmRoundTrips = 0
    let planningRetries = 0
    let sceneSource: DiscussionDiagnostics['sceneSource'] = 'none'
    // 场景计划工具集：业务层提供时，Director 规划调用会挂载 novel_submit_scene_plan，
    // converge 后优先读取工具提交结果，Markdown 解析降级为回退。
    const scenePlan = options.buildScenePlanToolset?.()
    // 供 handleDecision 在 Director 返回空串时检查工具是否已提交（见字段注释）
    this.currentScenePlan = scenePlan

    try {
      // 记录当前目标，供 invokeMember 注入成员 prefixUserMessage
      this.currentGoal = goal

      // ── Phase 1：规划 ──
      let planningDone = false
      while (!planningDone && rounds < limits.maxRounds) {
        const state: ModeratorState = {
          phase: 'planning',
          round: rounds,
          scenesDefined: scenes.length > 0,
        }
        // 插话 drain（§3.1）：在 Moderator 看到本轮 history 前把用户中途反馈
        // 以 user 角色追加进去（只追加不重排），Moderator 自主决定如何响应。
        this.drainInterjectQueue(history, options)
        const decision = await this.moderator.decide(goal, history, members, state, options.signal)
        this.noteModeratorDegradation(options, 'planning')
        await this.handleDecision(decision, history, members, options, channelName, { phase: 'planning', extraTools: scenePlan?.tools })
        rounds++

        // 工具提交本身就是 planning 完成信号，不再把控制权交回 Moderator。
        // gpt-5.6-luna 经实测会在 novel_submit_scene_plan 成功后返回空 stop：
        // 工具结果已经写入 draft，但 prompt() 的文本结果为空。上一版只写占位
        // 消息，仍让下一轮 Moderator 决定 invite，导致 Director 被重复调用。
        // 这里直接采用工具计划并进入 acting，彻底切断重复邀请链。
        if (!planningDone && scenePlan?.extractResult()?.scenes.length) {
          const collected = this.collectScenes(scenePlan, history, members)
          scenes = collected.scenes
          sceneSource = collected.source
          if (sceneSource === 'tool') {
            this.emitProgress(options, 'planning', {
              type: 'phase_change',
              data: { message: `✅ 场景计划已提交，结束规划并进入演出（共 ${scenes.length} 个场景）` },
            })
          }
          this.applyCastWhitelist(scenes, history, options, members)
          await this.resolveSceneCharacters(scenes, members, options, channelName)
          chapterConvergerId = members.find(member => member.canConverge)?.id
          planningDone = true
        }

        // ── Director 空响应检查点（2026-08-26）──
        // handleDecision 在 Director 连续两轮空响应时置此标志；不让 Moderator 继续
        // 死循环邀请，而是抛检查点让用户决策。approve → 清标志继续循环（Moderator
        // 会再次邀请导演）；其它（reject 等）→ 抛错，run 以 failed_phase=planning 终止。
        if (this.planningDirectorEmpty) {
          this.planningDirectorEmpty = false
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
          // 检查点视为用户参与，重置 observe 停滞计数
          noProgressRounds = 0
        }

        if (decision.type === 'converge' && decision.scope === 'chapter') {
          const collected = this.collectScenes(scenePlan, history, members)
          sceneSource = collected.source
          if (collected.scenes.length === 0) {
            // 纠正性重试一次：显式要求 Director 调用工具提交，不再静默落入盲写
            planningRetries++
            const retried = await this.retrySceneCollection(scenePlan, history, members, options)
            scenes = retried.scenes
            if (retried.source !== 'none') sceneSource = retried.source
          } else {
            scenes = collected.scenes
          }
          if (sceneSource === 'markdown') {
            this.emitProgress(options, 'planning', {
              type: 'phase_change',
              data: { message: '⚠️ Director 未通过工具提交场景计划，已回退文本解析；格式不符时演出阶段可能不完整。' },
            })
          }
          // 编排白名单（2026-08-24）：编排了角色清单时，把 Director 点名中
          // 白名单外的角色过滤掉，不再动态建临时角色出场
          this.applyCastWhitelist(scenes, history, options, members)
          await this.resolveSceneCharacters(scenes, members, options, channelName)
          chapterConvergerId = decision.agentId
          planningDone = true
        }
        if (decision.type === 'observe') {
          noProgressRounds++
          if (noProgressRounds >= limits.maxObserveRounds) {
            planningDone = true
            scenes = []
          }
        } else {
          noProgressRounds = 0
        }
      }

      // ── Phase 2：场景循环（如有场景）—— 角色推演，不即时编织 ──
      // 设计变更：场景循环只让角色对戏推演，剧本记录到 history，不触发 weaveScene。
      // 所有场景推演完毕后，Phase 3 的 weaveChapter 一次性整合全章剧本为正文。
      // 这样 Writer 只触发 1 次，避免多次触发导致的风格割裂和 token 浪费。
      if (scenes.length > 0) {
        await this.runSceneLoop({
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

      // ── Phase 2.5：演出产出闸门（2026-08-24）──
      // 静默盲写是"没有演绎"的直接来源：旧路径在 scenes=[] 或场景零发言时
      // 无任何用户可见信号。此处统计覆盖度并显式告警；盲写兜底本身保留
      // （weaveChapter 内），但必须携带警告事件与 transcript 记录。
      const characterMemberIds = new Set(members.filter(m => m.type === 'character').map(m => m.id))
      const emptyScenes = scenes.filter(scene =>
        !history.some(m => m.type === 'member' && m.sceneId === scene.sceneId && characterMemberIds.has(m.fromId)),
      )
      const diagnostics = this.buildDiagnosticsSnapshot({
        sceneSource,
        scenes,
        history,
        members,
        planningRetries,
      })
      if (scenes.length > 0 && emptyScenes.length > 0) {
        const detail = emptyScenes.map(s => `场景${s.sceneId}「${s.title}」`).join('、')
        this.emitProgress(options, 'chapter_weaving', {
          type: 'phase_change',
          data: { message: `⚠️ ${detail}未产生角色推演，编织时将以场景契约为准补写。` },
        })
      }

      if (options.allowLegacyActing === false && emptyScenes.length > 0) {
        throw new Error(
          `有 ${emptyScenes.length} 个场景未产生有效角色演出，已阻止 Writer 盲写。请重试角色演出或改用标准工作流。`,
        )
      }

      if (scenes.length === 0 && options.allowLegacyActing === false) {
        throw new Error('群聊没有产生可用场景或角色演出，已阻止静默盲写。请重试规划或改用标准工作流。')
      }

      // ── Phase 3：全章编织（一次性整合所有场景剧本）──
      track.phase = 'chapter_weaving'
      this.emitProgress(options, 'chapter_weaving', { type: 'phase_change', data: { message: '正在编织完整章节' } })
      finalContent = await this.weaveChapter(members, history, scenes, goal, options, chapterConvergerId)
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
   * 场景推演循环（run 与 acting/scene_setup 断点续跑共用）。
   *
   * 从 startIndex 场景开始推演（续跑时中断场景重演该场景的轮次，已完成场景
   * 的剧本已在 history）。track.phase/track.sceneId 由调用方持有：失败时据此
   * 生成 failedPhase/failedSceneId 供下次断点定位。
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
  }): Promise<void> {
    const { goal, members, history, scenes, options, limits, channelName, startIndex, track } = params
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

      if (options.allowLegacyActing === false && (!scene.actionBeats || scene.actionBeats.length === 0)) {
        throw new Error(`场景「${scene.title}」缺少 Director 动作节点，无法进入严格演出`)
      }
      if (scene.actionBeats && scene.actionBeats.length > 0 && options.buildCharacterTurnToolset) {
        await this.runActionBeatScene({
          ...params,
          scene,
          activeMembers,
          startIndex: i,
          failedActionBeatId: i === startIndex ? params.failedActionBeatId : undefined,
        })
        continue
      }

      if (options.allowLegacyActing === false) {
        throw new Error(`场景「${scene.title}」没有可执行的动作图，已阻止回退到 Moderator 轮询`)
      }

      while (!sceneDone && rounds < limits.maxRoundsPerScene) {
        track.phase = 'acting'
        const state: ModeratorState = {
          phase: 'acting',
          round: rounds,
          currentScene: scene,
          scenesRemaining: scenes.length - i - 1,
          scenesDefined: true,
        }
        // 插话 drain（§3.1）：与规划阶段同口径，场景轮次 decide 前注入。
        this.drainInterjectQueue(history, options)
        const decision = await this.moderator.decide(goal, history, activeMembers, state, options.signal)
        this.noteModeratorDegradation(options, 'acting')
        await this.handleDecision(decision, history, activeMembers, options, channelName, { phase: 'acting', sceneId: scene.sceneId })
        rounds++

        // 场景推演阶段：converge(scope=scene) 和 next_scene 都只标记场景结束，不触发 Writer。
        // observe 超限也只标记结束，由 Phase 3 统一编织。
        if (decision.type === 'converge' && decision.scope === 'scene') {
          const spokenIds = new Set(
            history
              .filter(message => message.type === 'member' && message.sceneId === scene.sceneId)
              .map(message => message.fromId),
          )
          const missing = activeMembers.filter(member => member.type === 'character' && !spokenIds.has(member.id))
          if (params.enforceCastCoverage !== false && missing.length > 0 && rounds < limits.maxRoundsPerScene) {
            noProgressRounds = 0
            await this.handleDecision({
              type: 'invite',
              agentId: missing[0].id,
              prompt: this.buildLegacyActingPrompt(missing[0], scene),
              reason: `场景仍有 ${missing.length} 个角色未完成有效演出`,
            }, history, activeMembers, options, channelName, { phase: 'acting', sceneId: scene.sceneId })
          } else {
            sceneDone = true
          }
        } else if (decision.type === 'next_scene') {
          sceneDone = true
        } else if (decision.type === 'observe') {
          noProgressRounds++
          if (noProgressRounds >= limits.maxObserveRounds) {
            sceneDone = true
          }
        } else {
          noProgressRounds = 0
        }
      }
      // 场景推演结束，剧本已在 history 中，直接进入下一场景
    }
    this.currentScene = undefined
  }

  private buildLegacyActingPrompt(member: DiscussionMember, scene: SceneDefinition): string {
    return `${member.name}，围绕场景「${scene.title}」的冲突“${scene.conflict ?? '当前阻力'}”，做出一个具体选择。请写清你看到的阻力、准备采取的动作、动作带来的风险或后果，并用角色自己的动作和台词演出来。不要只复述场景目标。`
  }

  /**
   * 新版动作图演出：Director 决定戏剧节点，角色决定现场表达和下一位回应者。
   * Moderator 不参与正常回合，只在节点失败或队列出现异常时介入。
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
  }): Promise<void> {
    const { history, members, options, channelName, track, scene, activeMembers } = params
    const actionBeats = scene.actionBeats ?? []
    const characterMembers = activeMembers.filter(member => member.type === 'character')
    const memberById = new Map(characterMembers.map(member => [member.id, member]))
    const memberByName = new Map(characterMembers.map(member => [this.normalizeCharacterName(member.name), member]))
    const completed = new Set<string>()
    const failed = new Set<string>()
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
    for (const beatId of turnBeatIds) completed.add(beatId)
    const resumeAfter = params.failedActionBeatId
    if (resumeAfter && turnBeatIds.length === 0) {
      // 早期快照的角色消息没有 actorTurn：退回下标口径，但只把「严格早于」
      // 中断节点的节点算作已完成，保证中断节点本身会被重演而不是被跳过。
      const failedBeatIndex = actionBeats.findIndex(beat => beat.beatId === resumeAfter)
      if (failedBeatIndex > 0) {
        for (const beat of actionBeats.slice(0, failedBeatIndex)) completed.add(beat.beatId)
      }
    }
    const edgeCounts = new Map<string, number>()
    let autonomousRounds = 0
    let pending: Array<{ targetId: string; sourceMessageId: string; depth: number }> = []

    for (const actionBeat of actionBeats) {
      if (completed.has(actionBeat.beatId)) continue
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('角色演出已取消')
      // 预算判断必须在发「节点开始」之前：否则会为一个永远不会执行的节点
      // 推一条开始事件，用户看到的节点数与实际演出不符。
      if (autonomousRounds >= params.limits.maxRoundsPerScene) break
      track.phase = 'acting'
      this.currentActionBeatId = actionBeat.beatId
      this.currentActionBeatSceneId = scene.sceneId
      this.appendActionBeatSystemMessage(history, options, scene, actionBeat, 'start')
      const actor = memberById.get(actionBeat.actor)
      if (!actor) {
        failed.add(actionBeat.beatId)
        const decision = await this.interveneForActionBeat(
          `动作节点「${actionBeat.beatId}」的 actor 不在当前场景：${actionBeat.actor}`,
          scene,
          history,
          members,
          options,
          channelName,
          track,
        )
        if (decision === 'abort') throw new Error('主持人终止当前动作节点，群聊演出中止')
        continue
      }

      let turn = await this.invokeCharacterTurn(
        actor,
        actionBeat,
        scene,
        history,
        members,
        options,
        channelName,
        track,
        memberById,
        undefined,
      )
      autonomousRounds++
      this.autonomousCharacterTurns++
      if (!turn) {
        // 单节点允许一次重试（方案 T5）：失败可能只是一次 provider 抖动或
        // 工具未提交，直接判失败会让整场戏因一次偶发错误缺一个因果环节。
        // 重试仅此一次，避免退化成无界重试放大调用预算。
        if (options.signal?.aborted) throw options.signal.reason ?? new Error('角色演出已取消')
        this.emitProgress(options, 'acting', {
          type: 'phase_change',
          data: { message: `${actor.name} 未提交有效回合，正在重试一次动作节点「${actionBeat.beatId}」` },
        })
        turn = await this.invokeCharacterTurn(
          actor,
          actionBeat,
          scene,
          history,
          members,
          options,
          channelName,
          track,
          memberById,
          undefined,
        )
        autonomousRounds++
        this.autonomousCharacterTurns++
      }
      if (!turn) {
        failed.add(actionBeat.beatId)
        this.appendActionBeatSystemMessage(history, options, scene, actionBeat, 'failed')
        const decision = await this.interveneForActionBeat(
          `角色「${actor.name}」未提交动作节点「${actionBeat.beatId}」的有效回合`,
          scene,
          history,
          members,
          options,
          channelName,
          track,
        )
        if (decision === 'abort') throw new Error('主持人终止当前动作节点，群聊演出中止')
        continue
      }

      if (turn.progress === 'stall' || !turn.consequence.trim()) {
        failed.add(actionBeat.beatId)
        this.appendActionBeatSystemMessage(history, options, scene, actionBeat, 'failed')
        const decision = await this.interveneForActionBeat(
          `角色「${actor.name}」的回合没有产生有效进展或后果，动作节点「${actionBeat.beatId}」暂不标记完成`,
          scene,
          history,
          members,
          options,
          channelName,
          track,
        )
        if (decision === 'abort') throw new Error('主持人终止当前动作节点，群聊演出中止')
        continue
      }

      // 工具提交的角色回合是该动作节点的完成凭证；没有提交有效回合才允许仲裁。
      // 角色已完成当前动作节点的提交。若它主动转交给另一个角色，
      // pending 队列只承载回应关系，不重复执行已完成的 actionBeat。
      completed.add(actionBeat.beatId)
      this.completedActionBeats++
      this.appendActionBeatSystemMessage(history, options, scene, actionBeat, 'complete')

      const sourceMessageId = this.appendCharacterTurn(
        actor,
        turn,
        scene.sceneId,
        history,
        options,
        channelName,
      )
      pending = this.enqueueCharacterMentions(
        pending,
        actor,
        turn,
        sourceMessageId,
        scene,
        memberByName,
        edgeCounts,
        history,
        options,
      )
      if (actionBeat.nextActor && pending.length === 0) {
        const defaultTarget = memberById.get(actionBeat.nextActor)
        if (defaultTarget && defaultTarget.id !== actor.id) {
          pending.push({ targetId: defaultTarget.id, sourceMessageId, depth: 1 })
        }
      }

      while (pending.length > 0 && autonomousRounds < params.limits.maxRoundsPerScene) {
        if (options.signal?.aborted) throw options.signal.reason ?? new Error('角色演出已取消')
        const next = pending.shift()!
        const target = memberById.get(next.targetId)
        if (!target) continue
        const source = history.find(message => message.id === next.sourceMessageId)
        const targetBeat = actionBeats.find(beat =>
          beat.actor === target.id && !completed.has(beat.beatId),
        )
        if (!targetBeat) {
          this.context.logger.warn(
            { sceneId: scene.sceneId, sourceMessageId: next.sourceMessageId, targetId: target.id },
            '角色 mention 未找到对应动作节点，跳过以保护动作顺序',
          )
          continue
        }
        const response = await this.invokeCharacterTurn(
          target,
          targetBeat,
          scene,
          history,
          members,
          options,
          channelName,
          track,
          memberById,
          source,
        )
        autonomousRounds++
        this.autonomousCharacterTurns++
        if (!response) {
          const decision = await this.interveneForActionBeat(
            `角色「${target.name}」未能回应「${actor.name}」的主动点名`,
            scene,
            history,
            members,
            options,
            channelName,
            track,
          )
          if (decision === 'abort') throw new Error('主持人终止当前动作节点，群聊演出中止')
          continue
        }
        if (response.progress === 'stall' || !response.consequence.trim()) {
          const decision = await this.interveneForActionBeat(
            `角色「${target.name}」的回应没有产生有效进展或后果`,
            scene,
            history,
            members,
            options,
            channelName,
            track,
          )
          if (decision === 'abort') throw new Error('主持人终止当前动作节点，群聊演出中止')
          continue
        }
        completed.add(targetBeat.beatId)
        // 自主回应同样是动作节点的完成凭证：不计数会让 completedActionBeats
        // 只统计外层 Director 顺序驱动的节点，mention 接戏完成的节点凭空消失，
        // 5 场景验收基线（完成度 / incompleteActionBeats）随之失真。
        this.completedActionBeats++
        this.appendActionBeatSystemMessage(history, options, scene, targetBeat, 'complete')
        const responseMessageId = this.appendCharacterTurn(
          target,
          response,
          scene.sceneId,
          history,
          options,
          channelName,
        )
        pending = this.enqueueCharacterMentions(
          pending,
          target,
          response,
          responseMessageId,
          scene,
          memberByName,
          edgeCounts,
          history,
          options,
          next.depth,
        )
        if (targetBeat?.nextActor && pending.length === 0) {
          const defaultTarget = memberById.get(targetBeat.nextActor)
          if (defaultTarget && defaultTarget.id !== target.id) {
            pending.push({ targetId: defaultTarget.id, sourceMessageId: responseMessageId, depth: next.depth + 1 })
          }
        }
      }
    }

    const incomplete = actionBeats.filter(beat => !completed.has(beat.beatId))
    if (incomplete.length > 0) {
      const decision = await this.interveneForActionBeat(
        `场景「${scene.title}」仍有 ${incomplete.length} 个动作节点未完成：${incomplete.map(beat => beat.beatId).join('、')}`,
        scene,
        history,
        members,
        options,
        channelName,
        track,
      )
      if (decision === 'abort') throw new Error('主持人终止当前动作节点，群聊演出中止')
      if (options.allowLegacyActing === false) {
        throw new Error(
          `场景「${scene.title}」有 ${incomplete.length} 个动作节点未完成（失败 ${failed.size} 个），已阻止 Writer 盲写。`,
        )
      }
    }
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
      if (count >= 2 || parentDepth >= 3) {
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

  private async interveneForActionBeat(
    reason: string,
    scene: SceneDefinition,
    history: DiscussionMessage[],
    members: DiscussionMember[],
    options: DiscussionOptions,
    channelName: string,
    track: { phase: DiscussionPhase; sceneId?: number },
  ): Promise<'continue' | 'abort'> {
    this.moderatorExceptionInvocations++
    this.totalModeratorInvocations++
    this.emitProgress(options, 'acting', {
      type: 'phase_change',
      data: { message: `⚠️ 演出异常，交由主持人仲裁：${reason}` },
    })
    const sceneMembers = [
      ...members.filter(member => member.type === 'role'),
      ...members.filter(member => member.type === 'character' && scene.presentCharacters.includes(member.id)),
    ]
    const decision = await this.moderator.decide(
      {
        task: `当前场景「${scene.title}」的动作节点演出出现异常：${reason}`,
        context: '',
      },
      history,
      sceneMembers,
      {
        phase: 'acting',
        round: this.moderatorExceptionInvocations,
          currentScene: scene,
      currentActionBeat: scene.actionBeats?.find(beat => beat.beatId === this.currentActionBeatId),
          actionBeatsCompleted: this.completedActionBeats,
          scenesDefined: true,
      },
      options.signal,
    )
    this.noteModeratorDegradation(options, 'acting')
    await this.handleDecision(decision, history, sceneMembers, options, channelName, {
      phase: 'acting',
      sceneId: track.sceneId,
    })
      if (decision.type === 'pause') return 'abort'
    if (decision.type === 'converge' || decision.type === 'next_scene') return 'continue'
    return 'continue'
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
      await this.runSceneLoop({
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
      finalContent = await this.weaveChapter(members, history, scenes, goal, options)
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

  /** 处理 Moderator 决策 */
  private async handleDecision(
    decision: ModeratorDecision,
    history: DiscussionMessage[],
    members: DiscussionMember[],
    options: DiscussionOptions,
    channelName: string,
    ctx: { phase: DiscussionPhase; sceneId?: number; extraTools?: unknown[] },
  ): Promise<void> {
    switch (decision.type) {
      case 'invite': {
        const member = members.find(m => m.id === decision.agentId)
        if (!member) {
          history.push(this.errorMessage(`Moderator 点名了不存在的成员: ${decision.agentId}`))
          return
        }
        if (ctx.phase === 'planning' && !(member.id === 'novel-director' || member.id.includes('director'))) {
          history.push(this.systemMessage(`规划阶段拒绝点名非 Director 成员：${member.name}`))
          return
        }
        if (ctx.phase === 'acting' && member.type !== 'character') {
          history.push(this.systemMessage(`演出阶段拒绝点名非角色成员：${member.name}`))
          return
        }
        // 写作/修订 Agent 只在收敛阶段触发（weaveScene/weaveChapter），
        // 不应被 invite 直接发言。Moderator 误点名时跳过，记录警告但不触发 LLM 调用。
        if (member.canConverge) {
          history.push(this.systemMessage(
            `主持人尝试点名 ${member.name} 发言，但写作/修订 Agent 只在收敛阶段触发，已跳过。`,
          ))
          return
        }
        // 多角色点名：把信息对称的角色合并为一次调用。
        //
        // 逐角色轮询每次都要重发完整 system + 场景上下文 + 对话历史，
        // ch10 实测 20 次调用 × 15.9s ≈ 318 秒只换回 3.7k token。
        // 合并的前提是信息对称 —— 认知不同的角色可见上下文不同，合并会把秘密
        // 泄露给不该知道的角色（见 groupSymmetricActors）。
        if (decision.agentIds && decision.agentIds.length > 1 && ctx.phase === 'acting') {
          const handled = await this.handleMergedInvite(
            decision, decision.agentIds, members, history, options, channelName, ctx,
          )
          // 多角色分支一旦接受决策，就负责处理全部有效角色；不可合并者也逐个调用。
          if (handled) break
        }

        // 主持人点名消息先入 history + emit 给前端（在成员发言之前），
        // 让前端能看到"谁被点名做什么"，而不是等到成员首 token 才显示"XX 开始发言"。
        const moderatorMsg: DiscussionMessage = {
          id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          fromId: 'moderator',
          fromName: '主持人',
          content: `@${member.name} ${decision.prompt}${decision.reason ? `（${decision.reason}）` : ''}`,
          timestamp: Date.now(),
          sceneId: ctx.sceneId,
          type: 'moderator',
        }
        history.push(moderatorMsg)
        this.emitProgress(options, ctx.phase, {
          type: 'phase_change',
          data: { message: moderatorMsg.content },
        })
        // 主持人点名以完整气泡实时呈现（2026-08-24）：此前只更新状态栏一行文案，
        // 运行中看不到主持人的调度（持久化气泡要等流程结束落库后才可见）
        this.emitProgress(options, ctx.phase, {
          type: 'agent_output',
          data: { type: 'agent_output', agentType: 'moderator', agentName: '主持人', content: moderatorMsg.content },
        })
        try {
          const memberPrompt = member.type === 'character'
            ? `${decision.prompt}\n\n主持人的任务只说明本回合关注点，不代表预设结果。你可以拒绝不符合人设、已知信息或当前目标的结论。只演此刻一个动作单元。`
            : decision.prompt
          let content = await this.invokeMember(member, memberPrompt, history, options, ctx)
          if (member.type === 'character') {
            content = await this.prepareCharacterSpeech(
              member, content, memberPrompt, history, members, options, ctx,
            )
          }

          // ── Planning 阶段 Director 空响应处理（2026-08-26，基于 diag 日志实证）──
          // 推理模型（gpt-5.6-luna）已实证行为：第一轮正常调用 novel_submit_scene_plan
          // 工具（工具执行成功），但 SDK 回传工具结果后的第二轮返回空 stop
          // （contentBlocks=[]、零 delta）→ prompt() 只返回第二轮 text = 空串。
          // 此时工具 draft 里已有完整场景计划，绝不能当"没产出"处理。
          if (ctx.phase === 'planning' && member.type === 'role' && !content.trim()) {
            const isDirector = member.id === 'novel-director' || member.id.includes('director')
            if (isDirector) {
              const submitted = this.currentScenePlan?.extractResult()
              if (submitted && submitted.scenes.length > 0) {
                // 工具已提交场景计划：把工具参数完整格式化为 Director 气泡，
                // 同时用非空摘要让兼容旧流程的 Moderator 仍能看到导演有产出。
                content = this.formatSubmittedScenePlan(submitted.scenes)
                this.emitProgress(options, ctx.phase, {
                  type: 'phase_change',
                  data: { message: '✅ 导演已通过工具提交场景计划（正文返回为空，已直接采用工具结果）' },
                })
                this.emitProgress(options, ctx.phase, {
                  type: 'agent_output',
                  data: {
                    agentType: 'director',
                    agentName: member.name,
                    content,
                  },
                })
              } else {
                // 工具未提交 + 文本为空：纠正性重试一次（明确要求调用工具或文本输出）
                const retryNotice = this.moderatorMessage(
                  `@${member.name} 你上一条回复没有任何内容，系统无法读取场景拆分。请立即调用 novel_submit_scene_plan 工具提交本章场景拆分；若无法调用工具，直接在文本中输出各场景的标题、地点、时间、冲突、目标、情绪与在场角色。`,
                )
                history.push(retryNotice)
                this.emitProgress(options, ctx.phase, {
                  type: 'phase_change',
                  data: { message: '⚠️ 导演本轮回复为空，已发起纠正性重试' },
                })
                content = await this.invokeMember(
                  member,
                  '你上一条回复为空。请立即调用 novel_submit_scene_plan 工具提交本章场景拆分（每个场景含标题/地点/时间/冲突/目标/情绪/在场角色）；若无法调用工具，在文本中直接输出完整场景列表，不要输出空内容。',
                  history,
                  options,
                  ctx,
                )
                if (!content.trim()) {
                  // 重试后再次检查工具（重试轮同样可能只调工具不产文本）
                  const resubmitted = this.currentScenePlan?.extractResult()
                  if (resubmitted && resubmitted.scenes.length > 0) {
                    content = this.formatSubmittedScenePlan(resubmitted.scenes)
                    this.emitProgress(options, ctx.phase, {
                      type: 'phase_change',
                      data: { message: '✅ 重试轮导演通过工具提交了场景计划，已直接采用工具结果' },
                    })
                    this.emitProgress(options, ctx.phase, {
                      type: 'agent_output',
                      data: {
                        agentType: 'director',
                        agentName: member.name,
                        content,
                      },
                    })
                  } else {
                    // 两次均空且工具未提交：不把空消息计入 history，标记由 planning 循环抛检查点/中止
                    history.push(this.systemMessage('导演连续两轮未产出内容（模型可能异常），等待用户决策。'))
                    this.planningDirectorEmpty = true
                    break
                  }
                }
              }
            }
          }

          const msg: DiscussionMessage = {
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            fromId: member.id,
            fromName: member.name,
            content,
            timestamp: Date.now(),
            sceneId: ctx.sceneId,
            type: 'member',
          }
          history.push(msg)
          this.channel.broadcast(channelName, member.id, msg)
          } catch (err) {
            if (options.signal?.aborted) throw err
            const errMsg = err instanceof Error ? err.message : String(err)
            history.push(this.errorMessage(`${member.name} 发言失败：${errMsg}`))
        }
        break
      }
      case 'pause': {
        this.emitProgress(options, ctx.phase, { type: 'pause', data: { question: decision.question } })
        // 2026-08-24 空检查点修复：前端渲染读 data 字段、决策按钮按 options 过滤。
        // LLM 给的 choices 是自由文本（如"方案A/方案B"），只作内容展示；
        // 可执行按钮固定为 继续(approve) / 终止(reject)，LLM 未给 options 时同样兜底。
        const userReply = await options.onCheckpoint({
          type: 'discussion_pause',
          phase: ctx.phase,
          question: decision.question,
          data: {
            message: decision.question,
            ...(decision.options?.length ? { choices: decision.options } : {}),
          },
          options: ['approve', 'reject'],
        })
        history.push({
          id: `user-${Date.now()}`,
          fromId: 'user',
          fromName: '用户',
          content: typeof userReply === 'string' ? userReply : String(userReply),
          timestamp: Date.now(),
          sceneId: ctx.sceneId,
          type: 'user',
        })
        break
      }
      case 'converge':
      case 'next_scene':
      case 'observe':
        // 由调用方循环处理
        break
    }
  }

  /**
   * 合并调用同场信息对称的角色。
   *
   * @returns true 表示已处理全部有效的多角色点名；false 表示有效角色不足两个，
   *   调用方继续使用兼容的单角色路径。
   */
  private async handleMergedInvite(
    decision: Extract<ModeratorDecision, { type: 'invite' }>,
    agentIds: string[],
    members: DiscussionMember[],
    history: DiscussionMessage[],
    options: DiscussionOptions,
    channelName: string,
    ctx: { phase: DiscussionPhase; sceneId?: number },
  ): Promise<boolean> {
    const picked = agentIds
      .map((id) => members.find((m) => m.id === id))
      .filter((m): m is DiscussionMember => !!m && m.type === 'character')
    if (picked.length < MIN_MERGE_GROUP_SIZE) return false

    const allLayerIds = Array.from(new Set(
      picked.flatMap(member => member.knowledge ? Object.keys(member.knowledge) : []),
    )).sort()
    const resolved = picked.map((member) => {
      try {
        const systemPrompt = member.buildSystemPrompt()
        const contextPrompt = member.buildContextPrompt?.() ?? this.currentGoal?.context ?? ''
        const identityPrompt = member.buildMergedActorIdentityPrompt?.() ?? member.buildIdentityPrompt?.() ?? ''
        const temperature = member.temperature
          ?? (options.limits?.characterTemperature ?? 0.8)
        const modelId = member.modelId
        return {
          member,
          systemPrompt,
          contextPrompt,
          identityPrompt,
          temperature,
          modelId,
          fingerprint: member.knowledge === undefined
            ? undefined
            : computeKnowledgeFingerprint({
                id: member.id,
                name: member.name,
                knowledge: member.knowledge,
              }, allLayerIds),
        }
      } catch (err) {
        this.context.logger.warn({ err, memberId: member.id }, '预解析角色合并资格失败，回落为单独调用')
        return { member }
      }
    })
    type ResolvedActor = typeof resolved[number]
    const canMerge = (left: ResolvedActor, right: ResolvedActor): boolean => (
      left.member.allowMergedInvocation !== false
      && right.member.allowMergedInvocation !== false
      && left.fingerprint !== undefined
      && left.fingerprint === right.fingerprint
      && left.member.name !== right.member.name
      && left.systemPrompt === right.systemPrompt
      && left.contextPrompt === right.contextPrompt
      && left.identityPrompt?.trim().length > 0
      && right.identityPrompt?.trim().length > 0
      && left.temperature === right.temperature
      && left.modelId?.provider === right.modelId?.provider
      && left.modelId?.modelId === right.modelId?.modelId
    )
    const batches: ResolvedActor[][] = []
    for (const actor of resolved) {
      const current = batches[batches.length - 1]
      if (current && current.length < MAX_MERGE_GROUP_SIZE && canMerge(current[0], actor)) {
        current.push(actor)
      } else {
        batches.push([actor])
      }
    }
    const mergedBatches = batches.filter(batch => batch.length >= MIN_MERGE_GROUP_SIZE)

    this.context.logger.info(
      {
        phase: ctx.phase,
        sceneId: ctx.sceneId,
        requested: picked.length,
        groups: batches.length,
        mergedBatches: mergedBatches.length,
      },
      '群聊演出：同场信息对称角色合并调用',
    )

    const moderatorMsg: DiscussionMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fromId: 'moderator',
      fromName: '主持人',
      content: `@${picked.map(member => member.name).join(' @')} ${decision.prompt}${decision.reason ? `（${decision.reason}）` : ''}`,
      timestamp: Date.now(),
      sceneId: ctx.sceneId,
      type: 'moderator',
    }
    history.push(moderatorMsg)
    this.emitProgress(options, ctx.phase, {
      type: 'phase_change',
      data: { message: moderatorMsg.content },
    })
    // 合并点名同样以完整气泡实时呈现（与单角色 invite 同口径）
    this.emitProgress(options, ctx.phase, {
      type: 'agent_output',
      data: { type: 'agent_output', agentType: 'moderator', agentName: '主持人', content: moderatorMsg.content },
    })

    for (const batch of batches) {
      if (batch.length < MIN_MERGE_GROUP_SIZE) {
        await this.speakSingleCharacter(
          batch[0].member, decision.prompt, history, members, options, channelName, ctx,
        )
        continue
      }

      const leader = batch[0]
      const batchMembers = batch.map(actor => actor.member)
      const names = batchMembers.map(member => member.name)
      const identities = batch.map(actor => (
        `## 角色「${actor.member.name}」的私有身份\n${actor.identityPrompt}`
      )).join('\n\n---\n\n')
      const group = {
        actors: batchMembers.map(member => ({
          id: member.id,
          name: member.name,
          knowledge: member.knowledge!,
        })),
        fingerprint: leader.fingerprint!,
      }

      let merged: string
      try {
        merged = await this.invokeMember(
          leader.member,
          buildMergedActorPrompt(group, `${decision.prompt}\n\n主持人的任务只说明本回合关注点，不代表预设结果。各角色可以拒绝不符合人设、已知信息或当前目标的结论。`),
          history,
          options,
          ctx,
          'public',
          {
            systemPrompt: leader.systemPrompt!,
            prefixMessages: [leader.contextPrompt!, identities],
            temperature: leader.temperature!,
            modelId: leader.modelId,
            participantIds: batchMembers.map(member => member.id),
            participantNames: names,
          },
        )
      } catch (err) {
        if (options.signal?.aborted) throw err
        const errMsg = err instanceof Error ? err.message : String(err)
        history.push(this.errorMessage(`${names.join('、')} 合并发言失败：${errMsg}`))
        for (const member of batchMembers) {
          await this.speakSingleCharacter(
            member, decision.prompt, history, members, options, channelName, ctx,
          )
        }
        continue
      }

      const parsed = parseMergedActorResponse(merged, names)
      for (const member of batchMembers) {
        const segment = parsed.get(member.name)
        if (!segment) {
          this.context.logger.warn(
            { memberId: member.id, memberName: member.name },
            '合并输出缺少该角色分段，回落为单独调用',
          )
          await this.speakSingleCharacter(
            member, decision.prompt, history, members, options, channelName, ctx,
          )
          continue
        }
        try {
          const content = await this.prepareCharacterSpeech(
            member, segment, decision.prompt, history, members, options, ctx,
          )
          const msg: DiscussionMessage = {
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            fromId: member.id,
            fromName: member.name,
            content,
            timestamp: Date.now(),
            sceneId: ctx.sceneId,
            type: 'member',
          }
          history.push(msg)
          this.channel.broadcast(channelName, member.id, msg)
        } catch (err) {
          if (options.signal?.aborted) throw err
          this.context.logger.warn(
            { err, memberId: member.id, memberName: member.name },
            '合并输出的角色分段处理失败，回落为单独调用',
          )
          await this.speakSingleCharacter(
            member, decision.prompt, history, members, options, channelName, ctx,
          )
        }
      }
    }
    return true
  }

  /** 单角色发言：合并路径的回落分支，与 invite 单人路径保持同一套校验 */
  private async speakSingleCharacter(
    member: DiscussionMember,
    prompt: string,
    history: DiscussionMessage[],
    members: DiscussionMember[],
    options: DiscussionOptions,
    channelName: string,
    ctx: { phase: DiscussionPhase; sceneId?: number },
  ): Promise<void> {
    try {
      const raw = await this.invokeMember(
        member,
        `${prompt}\n\n主持人的任务只说明本回合关注点，不代表预设结果。你可以拒绝不符合人设、已知信息或当前目标的结论。只演此刻一个动作单元。`,
        history,
        options,
        ctx,
      )
      const content = await this.prepareCharacterSpeech(
        member, raw, prompt, history, members, options, ctx,
      )
      const msg: DiscussionMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        fromId: member.id,
        fromName: member.name,
        content,
        timestamp: Date.now(),
        sceneId: ctx.sceneId,
        type: 'member',
      }
      history.push(msg)
      this.channel.broadcast(channelName, member.id, msg)
    } catch (err) {
      if (options.signal?.aborted) throw err
      const errMsg = err instanceof Error ? err.message : String(err)
      history.push(this.errorMessage(`${member.name} 发言失败：${errMsg}`))
    }
  }

  /** 统一角色发言协议：格式纠正、实时 Reviewer、必要时重写。 */
  private async prepareCharacterSpeech(
    member: DiscussionMember,
    initialContent: string,
    memberPrompt: string,
    history: DiscussionMessage[],
    members: DiscussionMember[],
    options: DiscussionOptions,
    ctx: { phase: DiscussionPhase; sceneId?: number },
  ): Promise<string> {
    let content = initialContent
    if (!this.isValidCharacterSpeech(content)) {
      this.formatCorrectionCount++
      this.emitProgress(options, ctx.phase, {
        type: 'phase_change',
        data: { message: `${member.name} 未按剧本格式发言，正在纠正当前发言` },
      })
      // 2026-08-24 刻板修复：旧重试词命令"重新演出"，实测模型会把 433 字的内容
      // 压成 29 字的口号交差。改为"保留全部内容、只调整排版"，并放宽到 2-8 行。
      const retry = await this.invokeMember(
        member,
        `上一条输出未通过剧本格式检查。请保留其中的全部信息、台词和行动，只调整排版：每行一个动作单元，格式为 [可见动作] "角色台词"，2-8 行。\n不得输出"意图/心理/应对/分析/说明"等标签或小节标题，不得替其他角色说话，不要删减已有内容。\n\n当前回合：${memberPrompt}`,
        history,
        options,
        ctx,
      )
      content = this.isValidCharacterSpeech(retry)
        ? retry
        : this.normalizeCharacterSpeech(retry || content, member.name)
    }

    if (options.reviewCharacterSpeech !== false) {
      const reviewResult = await this.reviewCharacterSpeech(
        member, content, history, members, options, ctx,
      )
      if (reviewResult.verdict === 'request_rewrite' && reviewResult.rewrite_suggestion) {
        this.emitProgress(options, ctx.phase, {
          type: 'phase_change',
          data: { message: `审查员要求 ${member.name} 重发：${reviewResult.issues.join('；')}` },
        })
        const rewritten = await this.invokeMember(
          member,
          `审查员认为你的上一条发言需要修改。

## 原始发言
${content}

## 存在的问题
${reviewResult.issues.join('\n')}

## 修改建议
${reviewResult.rewrite_suggestion}

请保留原发言的有效信息，按建议重新发言。`,
          history,
          options,
          ctx,
        )
        content = this.isValidCharacterSpeech(rewritten)
          ? rewritten
          : this.normalizeCharacterSpeech(rewritten || content, member.name)
      }
    }
    return content
  }

  /** 调用成员发言（通过 createAgUiSession 工厂） */
  private async invokeMember(
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
   * 角色发言校验（2026-08-24 放宽）。
   *
   * 旧版要求每行严格匹配 `[动作] “台词”` 且总行数 ≤6，实测一次运行中 48% 的首次
   * 发言被误杀（全角括号动作、名字前缀双括号、第 7 行），重试后产出缩水、归一化把
   * 动作改写成罐头文本——演出在校验层就被销毁。
   *
   * 新版只拒绝明显不可用的形态：
   * - 空输出 / 超长（>12 行）
   * - 完全没有台词（任何引号内容都没有）
   * - 提纲/分析式输出（Markdown 标题，或"意图/心理/应对"等元标签行）
   * 动作与台词的排列组合不再强校验，格式引导交给 role-character-actor 提示词与重试提示。
   */
  private isValidCharacterSpeech(content: string): boolean {
    const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    if (lines.length < 1 || lines.length > 12) return false
    // 必须至少有一句台词（兼容中英日引号）
    if (!/[“「『"][^”」』"\n]{1,300}[”」』"]/.test(content)) return false
    // 拒绝提纲式输出：Markdown 标题或以元标签开头的行
    if (/^#{1,6}\s/m.test(content)) return false
    if (/^\s*(意图|心理|应对|策略|分析|说明|旁白|备注|提纲)\s*[：:]/m.test(content)) return false
    return true
  }

  /**
   * 兜底归一化（仅在重试后仍不合格时使用）。尽量保留原文台词与动作：
   * - 逐行提取 `[动作] “台词”` 配对原样保留；
   * - 无动作的裸台词补中性动作 `[X开口]`；
   * - "台词：/回应：/应对：" 标签值保留（沿用旧版行为）；
   * - 只有完全没有任何引号台词时才使用罐头兜底句，并记审计日志。
   * 不再截断到前 3 句、不再把所有动作改写成"按住没有说出口的话"。
   */
  private normalizeCharacterSpeech(content: string, characterName: string): string {
    const kept: string[] = []
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      const paired = line.match(/^\[([^\]\n]{1,100})\]\s*[“「『"]([^”」』"\n]{1,300})[”」』"]\s*$/)
      if (paired) {
        kept.push(`[${paired[1].trim()}] “${paired[2].trim()}”`)
        continue
      }
      for (const match of line.matchAll(/[“「『"]([^”」』"\n]{1,300})[”」』"]/g)) {
        const quote = match[1].trim()
        if (quote) kept.push(`[${characterName}开口] “${quote}”`)
      }
    }
    if (kept.length > 0) return kept.slice(0, 12).join('\n')

    const response = content.match(/(?:应对|回应|台词)\s*[：:]\s*([^\n]{2,180})/)?.[1]
      ?.replace(/^[“「『"]|[”」』"]$/g, '')
      .trim()
    if (response) return `[${characterName}看向对方] “${response}”`
    this.context.logger.warn(
      { characterName },
      '角色发言完全无台词，使用罐头兜底句',
    )
    return `[${characterName}没有立刻表态] “先把眼前这件事说清楚。”`
  }

  /**
   * 审查角色发言是否符合人设和场景。
   *
   * 角色成员发言后触发，用 Reviewer 成员的 systemPrompt + 审查 prompt 调用 LLM。
   * 审查结果为 pass 或 request_rewrite。request_rewrite 时调用方要求角色重发（最多 1 次）。
   *
   * 审查调用用 noop emit，不流式渲染到前端（审查结果通过 phase_change message 告知用户）。
   */
  private async reviewCharacterSpeech(
    character: DiscussionMember,
    speech: string,
    history: DiscussionMessage[],
    members: DiscussionMember[],
    options: DiscussionOptions,
    ctx: { phase: DiscussionPhase; sceneId?: number },
  ): Promise<{ verdict: 'pass' | 'request_rewrite'; issues: string[]; rewrite_suggestion: string; reason: string }> {
    const reviewer = members.find(m => m.id === 'novel-reviewer')
    if (!reviewer) {
      // 没有审查员成员，跳过审查
      return { verdict: 'pass', issues: [], rewrite_suggestion: '', reason: '无审查员成员，跳过审查' }
    }

    // 构建角色档案摘要
    const profile = character.characterProfile
    const profileText = profile
      ? `性格：${profile.personality}\n当前状态：${profile.currentState}\n当前目标：${profile.currentGoal}\n秘密：${profile.secret ?? '无'}\n弧光阶段：${profile.arcStage ?? '未指定'}`
      : '（无角色档案）'

    // 从 history 提取当前场景上下文（最近一条 scene_setup 系统消息）
    const sceneContext = [...history].reverse().find(m => m.type === 'system' && m.content.includes('场景'))?.content ?? '（无场景上下文）'

    const reviewPrompt = `请审查以下角色发言是否符合人设和场景。

## 角色档案
姓名：${character.name}
${profileText}

## 当前场景上下文
${sceneContext}

## 角色本次发言
${speech}

## 请给出审查结论（输出 JSON）`

    // 审查调用用 noop emit，不流式渲染到前端
    const noopEmit: AgUiEventSink = () => {}
    try {
      const raw = await this.invokeMember(
        reviewer,
        reviewPrompt,
        [], // 审查不需要群聊记录上下文
        { ...options, emit: noopEmit },
        { phase: 'acting', sceneId: ctx.sceneId },
        'internal',
      )
      return this.parseReviewResult(raw)
    } catch (err) {
      this.context.logger.warn({ err, characterId: character.id }, '角色发言审查失败，放行')
      return { verdict: 'pass', issues: [], rewrite_suggestion: '', reason: `审查失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }

  /** 解析审查员输出（容错 markdown 包裹） */
  private parseReviewResult(raw: string): { verdict: 'pass' | 'request_rewrite'; issues: string[]; rewrite_suggestion: string; reason: string } {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      // 无法解析，放行
      return { verdict: 'pass', issues: [], rewrite_suggestion: '', reason: '审查输出无法解析为 JSON，放行' }
    }
    try {
      const parsed = JSON.parse(jsonMatch[0])
      if (parsed.verdict !== 'pass' && parsed.verdict !== 'request_rewrite') {
        return { verdict: 'pass', issues: [], rewrite_suggestion: '', reason: `审查 verdict 非法: ${parsed.verdict}，放行` }
      }
      return {
        verdict: parsed.verdict,
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        rewrite_suggestion: typeof parsed.rewrite_suggestion === 'string' ? parsed.rewrite_suggestion : '',
        reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      }
    } catch {
      return { verdict: 'pass', issues: [], rewrite_suggestion: '', reason: '审查 JSON 解析失败，放行' }
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

    // 兜底：群聊未产出场景内容（Director 未拆场或场景循环全部失败），
    // 让 Writer 基于群聊记录产出完整章节正文。
    // ⚠️ 这是降级行为，不是 bug。role 注入后 Director 应正确拆场走 Phase 2，
    // 不会走到这里。仅在 Director 不听话时降级，此时只有 Writer 生成一次，
    // 不会出现"双重生成"（双重生成的根因是 role 未注入导致第一个 Agent 直接写正文）。
    // 2026-08-24：降级不再静默——显式事件 + transcript 记录，让用户与 Writer 都知道
    // 本章没有角色推演素材。
    const hasAnyScript = sceneScripts.some(s => s.transcript.length > 0)
    if ((scenes.length === 0 || !hasAnyScript) && options.allowLegacyActing !== false) {
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
      const scriptBlock = entry.transcript.length > 0
        ? entry.transcript
        : '（本场景角色未发言，请基于场景信息补写）'
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
   * 收集场景计划（2026-08-24 演绎链路修复）：
   * 优先读取 Director 通过 novel_submit_scene_plan 工具提交的结构化计划；
   * 未提交时回退 Markdown 解析（source='markdown'，调用方必须显式告警）。
   */
  private collectScenes(
    planToolset: ScenePlanToolset | undefined,
    history: DiscussionMessage[],
    members: DiscussionMember[],
  ): { scenes: SceneDefinition[]; source: 'tool' | 'markdown' | 'none' } {
    const submitted = planToolset?.extractResult()?.scenes ?? []
    if (submitted.length > 0) {
      return { scenes: this.toSceneDefinitions(submitted, members), source: 'tool' }
    }
    const markdownScenes = this.parseScenes(history, members)
    if (markdownScenes.length > 0) {
      return { scenes: markdownScenes, source: 'markdown' }
    }
    return { scenes: [], source: 'none' }
  }

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

  /**
   * 场景计划缺失时的纠正性重试：显式要求 Director 调用工具重新提交一次。
   * 旧路径在此处直接静默落入盲写；现在至少给模型一次结构化补救机会，
   * 重试后仍失败才进入盲写降级（且 weaveChapter 会发显式警告）。
   */
  private async retrySceneCollection(
    planToolset: ScenePlanToolset | undefined,
    history: DiscussionMessage[],
    members: DiscussionMember[],
    options: DiscussionOptions,
  ): Promise<{ scenes: SceneDefinition[]; source: 'tool' | 'markdown' | 'none' }> {
    const director = members.find(member =>
      member.type === 'role' && (member.id === 'novel-director' || member.id.includes('director')),
    )
    if (!director) return { scenes: [], source: 'none' }
    const moderatorMsg = this.moderatorMessage(
      `@${director.name} 你的场景拆分无法被系统读取：既没有调用 novel_submit_scene_plan 工具，文本输出也不符合可解析格式。请立即调用 novel_submit_scene_plan 工具，按顺序提交每个场景的标题、地点、时间、冲突、目标、情绪和在场角色。`,
    )
    history.push(moderatorMsg)
    this.emitProgress(options, 'planning', { type: 'phase_change', data: { message: moderatorMsg.content } })
    try {
      await this.invokeMember(
        director,
        '上一次输出没有生成可用的场景计划。请立即调用 novel_submit_scene_plan 工具提交本章场景拆分；工具参数会强制校验结构，不要在文本中重复完整计划。',
        history,
        options,
        { phase: 'planning', extraTools: planToolset?.tools },
      )
    } catch (err) {
      if (options.signal?.aborted) throw err
      this.context.logger.warn({ err }, '场景计划纠正性重试失败')
      return { scenes: [], source: 'none' }
    }
    return this.collectScenes(planToolset, history, members)
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

  /** 演出链路诊断：Moderator 首次降级时对用户发显式警告（每次 run 一次，附失败原因） */
  private noteModeratorDegradation(options: DiscussionOptions, phase: DiscussionPhase): void {
    if (this.moderatorDegradeWarned) return
    if (this.moderator.degradedRounds <= 0) return
    this.moderatorDegradeWarned = true
    const reason = this.moderator.lastErrorReason.replace(/\s+/g, ' ').slice(0, 80)
    this.emitProgress(options, phase, {
      type: 'phase_change',
      data: { message: `⚠️ 主持人决策连续失败（${reason || '原因未知'}），已降级为规则协调点名（对戏刺激会变弱）。建议检查群聊设置里的 Moderator 模型，或调大 moderatorTimeoutMs。` },
    })
  }

  /**
   * 出场角色白名单（2026-08-24）：编排了角色清单时过滤 Director 点名。
   * 以"允许成员的名字→ID 映射"为准双口径过滤：不在白名单的名字从
   * presentCharacters/presentCharacterNames 中剔除、unresolved 清空，
   * 并写入 system 警告，让用户与后续 Moderator 都知道该角色被编排约束拦截。
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
  }): DiscussionDiagnostics {
    const { sceneSource, scenes, history, members, planningRetries } = input
    const characterMemberIds = new Set(members.filter(m => m.type === 'character').map(m => m.id))
    const emptyCount = scenes.filter(scene =>
      !history.some(m => m.type === 'member' && m.sceneId === scene.sceneId && characterMemberIds.has(m.fromId)),
    ).length
    return {
      sceneSource,
      scenesTotal: scenes.length,
      scenesWithActing: scenes.length - emptyCount,
      characterSpeeches: history.filter(m => m.type === 'member' && characterMemberIds.has(m.fromId)).length,
      formatCorrections: this.formatCorrectionCount,
      planningRetries,
      moderatorDegradedRounds: this.moderator.degradedRounds,
      autonomousCharacterTurns: this.autonomousCharacterTurns,
      autonomousMentions: this.autonomousMentions,
      moderatorExceptionInvocations: this.moderatorExceptionInvocations,
      characterTurnFailures: this.characterTurnFailures,
      characterTurnCancelled: this.characterTurnCancelled,
      completedActionBeats: this.completedActionBeats,
      totalMemberInvocations: this.totalMemberInvocations,
      // Moderator 的真实总调用取自 Moderator 自身计数：planning 循环和 legacy
      // acting 轮询都直接调 decide()，只在引擎侧累加会漏掉这两条路径，
      // 5 场景基线就无法核对「正常 acting 的 Moderator 调用为 0」。
      totalModeratorInvocations: Math.max(this.moderator.invocations, this.totalModeratorInvocations),
      totalLlmRoundTrips: this.totalLlmRoundTrips,
      totalDurationMs: this.runStartedAt > 0 ? Date.now() - this.runStartedAt : undefined,
      legacyPlanScenes: scenes.filter(scene => scene.legacyPlan || !scene.actionBeats?.length).length,
      incompleteActionBeats: scenes.reduce((sum, scene) => {
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
