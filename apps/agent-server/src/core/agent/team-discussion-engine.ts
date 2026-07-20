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
import type { AgUiSessionHandle } from '../plugin/plugin-types.js'
import type { AgUiEventSink } from '@repo/protocol/events'
import { AgentChannel } from './agent-channel.js'
import { Moderator } from './moderator.js'
import type {
  DiscussionGoal,
  DiscussionMember,
  DiscussionMessage,
  DiscussionOptions,
  DiscussionResult,
  DiscussionFlowEvent,
  ModeratorState,
  ModeratorDecision,
  SceneDefinition,
  DiscussionPhase,
  DiscussionResumeState,
  ReviewerOutcome,
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
    modelId?: { provider: string; modelId: string }
    emit: AgUiEventSink
    emitRaw?: boolean
    onFirstText?: () => void
  }): Promise<AgUiSessionHandle>
  logger: FastifyBaseLogger
}

export class TeamDiscussionEngine {
  /** 当前讨论目标，用于给每个成员注入共享上下文 */
  private currentGoal?: DiscussionGoal

  constructor(
    private moderator: Moderator,
    private channel: AgentChannel,
    private context: EngineContext,
  ) {}

  async run(
    goal: DiscussionGoal,
    members: DiscussionMember[],
    options: DiscussionOptions,
  ): Promise<DiscussionResult> {
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
    let activePhase: DiscussionPhase = 'planning'

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
        const decision = await this.moderator.decide(goal, history, members, state, options.signal)
        await this.handleDecision(decision, history, members, options, channelName, { phase: 'planning' })
        rounds++

        if (decision.type === 'converge' && decision.scope === 'chapter') {
          scenes = this.parseScenes(history, members)
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
        activePhase = 'scene_setup'
        for (let i = 0; i < scenes.length; i++) {
          const scene = scenes[i]
          rounds = 0
          noProgressRounds = 0

          history.push(this.systemMessage(this.buildSceneContext(scene)))
          this.emitProgress(options, 'scene_setup', { type: 'scene_change', data: { scene } })

          const activeMembers = this.filterMembersByScene(members, scene)
          let sceneDone = false

          while (!sceneDone && rounds < limits.maxRoundsPerScene) {
            activePhase = 'acting'
            const state: ModeratorState = {
              phase: 'acting',
              round: rounds,
              currentScene: scene,
              scenesRemaining: scenes.length - i - 1,
              scenesDefined: true,
            }
            const decision = await this.moderator.decide(goal, history, activeMembers, state, options.signal)
            await this.handleDecision(decision, history, activeMembers, options, channelName, { phase: 'acting', sceneId: scene.sceneId })
            rounds++

            // 场景推演阶段：converge(scope=scene) 和 next_scene 都只标记场景结束，不触发 Writer。
            // observe 超限也只标记结束，由 Phase 3 统一编织。
            if (decision.type === 'converge' && decision.scope === 'scene') {
              sceneDone = true
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
      }

      // ── Phase 3：全章编织（一次性整合所有场景剧本）──
      activePhase = 'chapter_weaving'
      this.emitProgress(options, 'chapter_weaving', { type: 'phase_change', data: { message: '正在编织完整章节' } })
      finalContent = await this.weaveChapter(members, history, scenes, goal, options, chapterConvergerId)
      this.recordWriterOutput(members, history, finalContent)

      // ── Phase 4：最终正文质量门 ──
      activePhase = 'reviewing'
      const qualityResult = await this.reviewFinalChapter(finalContent, members, history, options, goal.targetWords)
      if (qualityResult.status === 'cancelled') {
        return { status: 'cancelled', transcript: history, scenes, review: qualityResult.review }
      }
      finalContent = qualityResult.content

      return {
        status: 'completed',
        content: finalContent,
        transcript: history,
        scenes,
        review: qualityResult.review,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.context.logger.error({ err }, '群聊引擎异常')
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
      for (const member of members) {
        this.channel.unsubscribe(channelName, member.id)
      }
    }
  }

  /**
   * 从持久化快照直接恢复全章编织，不再调用 Moderator、Director 或角色 Agent。
   * Writer 成功后继续执行 Reviewer/Reviser 与原有检查点流程。
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
    }))
    const channelName = `discuss-resume-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    let finalContent = ''
    let activePhase: DiscussionPhase = 'chapter_weaving'

    for (const member of members) this.channel.subscribe(channelName, member.id)

    try {
      this.currentGoal = goal
      this.emitProgress(options, 'chapter_weaving', {
        type: 'phase_change',
        data: { message: '已恢复群聊记录，正在从写作 Agent 继续' },
      })
      finalContent = await this.weaveChapter(members, history, scenes, goal, options)
      this.recordWriterOutput(members, history, finalContent)

      activePhase = 'reviewing'
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
      for (const member of members) this.channel.unsubscribe(channelName, member.id)
    }
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
    ctx: { phase: DiscussionPhase; sceneId?: number },
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
        try {
          const memberPrompt = member.type === 'character'
            ? `${decision.prompt}\n\n主持人的任务只说明本回合关注点，不代表预设结果。你可以拒绝不符合人设、已知信息或当前目标的结论。只演此刻一个动作单元。`
            : decision.prompt
          let content = await this.invokeMember(member, memberPrompt, history, options, ctx)

          // 剧本协议是角色推演能否被 Writer 当作现场素材的边界。格式错误时先重试，
          // 仍失败则做保守归一化，禁止“意图/心理/应对”提纲直接进入全章编织。
          if (member.type === 'character' && !this.isValidCharacterSpeech(content)) {
            this.emitProgress(options, ctx.phase, {
              type: 'phase_change',
              data: { message: `${member.name} 未按剧本格式发言，正在纠正当前发言` },
            })
            const retry = await this.invokeMember(
              member,
              `上一条输出不是角色演出。重新演出当前回合，只输出 2-6 行，每行严格使用：[可见动作] “角色台词”。\n不得输出“意图、心理、应对、分析、说明”等标签，不得替其他角色说话。\n\n当前回合：${memberPrompt}`,
              history,
              options,
              ctx,
            )
            content = this.isValidCharacterSpeech(retry)
              ? retry
              : this.normalizeCharacterSpeech(retry || content, member.name)
          }

          // 角色成员发言后触发 Reviewer 实时审查（最多重发 1 次）
          if (member.type === 'character' && options.reviewCharacterSpeech !== false) {
            const reviewResult = await this.reviewCharacterSpeech(
              member, content, history, members, options, ctx,
            )
            if (reviewResult.verdict === 'request_rewrite' && reviewResult.rewrite_suggestion) {
              // 审查不通过，要求角色重发
              this.emitProgress(options, ctx.phase, {
                type: 'phase_change',
                data: { message: `审查员要求 ${member.name} 重发：${reviewResult.issues.join('；')}` },
              })
              const rewritePrompt = `审查员认为你的上一条发言需要修改。

## 原始发言
${content}

## 存在的问题
${reviewResult.issues.join('\n')}

## 修改建议
${reviewResult.rewrite_suggestion}

请保留原发言的有效信息，按建议重新发言。`
              content = await this.invokeMember(member, rewritePrompt, history, options, ctx)
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
          const errMsg = err instanceof Error ? err.message : String(err)
          history.push(this.errorMessage(`${member.name} 发言失败：${errMsg}`))
        }
        break
      }
      case 'pause': {
        this.emitProgress(options, ctx.phase, { type: 'pause', data: { question: decision.question } })
        const userReply = await options.onCheckpoint({
          type: 'discussion_pause',
          phase: ctx.phase,
          question: decision.question,
          options: decision.options,
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

  /** 调用成员发言（通过 createAgUiSession 工厂） */
  private async invokeMember(
    member: DiscussionMember,
    prompt: string,
    history: DiscussionMessage[],
    options: DiscussionOptions,
    ctx: { phase: DiscussionPhase; sceneId?: number; extraTools?: unknown[] },
    visibility: 'public' | 'internal' = 'public',
  ): Promise<string> {
    const systemPrompt = member.buildSystemPrompt()
    const identityPrompt = member.buildIdentityPrompt?.() ?? ''
    const visibleChapterContext = member.buildContextPrompt?.() ?? this.currentGoal?.context ?? ''
    const prefixMessages = [visibleChapterContext, identityPrompt]
      .filter(message => message.trim().length > 0)
    const transcriptSummary = this.formatTranscriptForMember(history, member.id)
    const userMessage = `${prompt}\n\n---\n\n## 群聊记录\n\n${transcriptSummary}`
    const startTime = Date.now()
    let result = ''
    let status: 'success' | 'error' | 'cancelled' = 'success'
    let error = ''

    const handle = await this.context.createAgUiSession({
      systemPrompt,
      // 工种成员使用共享章节上下文；角色成员可通过 buildContextPrompt 使用
      // 只含本人已知信息的私有上下文，避免角色看到全知状态和他人秘密。
      prefixUserMessage: prefixMessages.length === 1 ? prefixMessages[0] : prefixMessages,
      userMessage,
      // 注入业务层提供的工具（如 Reviser 的 novel_apply_revision）。
      // 工具不在 STATIC/SEMI 层 prompt 中出现，不影响跨 Agent 的 prompt cache 命中率。
      tools: ctx.extraTools ?? [],
      signal: options.signal,
      // 温度优先级：member.temperature（工种成员从 AgentPage 角色温度配置读取）
      // > 角色成员回退到 characterTemperature > 默认 0.7
      temperature: member.temperature
        ?? (member.type === 'character' ? (options.limits?.characterTemperature ?? 0.8) : 0.7),
      timeoutMs: 300_000,
      // 透传成员配置的 modelId：工种成员从 AgentManager 读取该 Agent 的 model 配置，
      // 角色成员不填（走默认 Provider）。
      modelId: member.modelId,
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
          agentName: member.name,
          messageId,
          message: `${member.name} 已启动，正在向 AI 发送请求...`,
        },
      })
    }

    try {
      result = await session.prompt()
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
          phase: ctx.phase,
          systemPrompt,
          chapterContext: prefixMessages.join('\n\n---\n\n'),
          userMessage,
          result,
          durationMs: Date.now() - startTime,
          status,
          error,
          sessionId: handle.sessionId ?? session.sessionId ?? '',
          inputTokens: capturedUsage?.inputTokens ?? 0,
          outputTokens: capturedUsage?.outputTokens ?? 0,
          cacheReadTokens: capturedUsage?.cacheReadTokens ?? 0,
          cacheWriteTokens: capturedUsage?.cacheWriteTokens ?? 0,
          llmProvider: capturedUsage?.llmProvider ?? member.modelId?.provider ?? '',
          llmModel: capturedUsage?.llmModel ?? member.modelId?.modelId ?? '',
        })
      } catch (logError) {
        this.context.logger.warn({ err: logError, memberId: member.id }, '群聊成员调用日志写入失败')
      }
      handle.dispose()
    }
  }

  private isValidCharacterSpeech(content: string): boolean {
    const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    if (lines.length < 1 || lines.length > 6) return false
    return lines.every(line => (
      /^\[[^\]\n]{1,100}\]\s*[“「『"][^”」』"\n]{1,300}[”」』"](?:\s*\[PUSHBACK\][^\n]*)?$/.test(line)
    ))
  }

  private normalizeCharacterSpeech(content: string, characterName: string): string {
    const quoted = [...content.matchAll(/[“「『"]([^”」』"\n]{1,220})[”」』"]/g)]
      .map(match => match[1].trim())
      .filter(Boolean)
      .slice(0, 3)
    if (quoted.length > 0) {
      return quoted.map(line => `[${characterName}按住没有说出口的话] “${line}”`).join('\n')
    }
    const response = content.match(/(?:应对|回应|台词)\s*[：:]\s*([^\n]{2,180})/)?.[1]
      ?.replace(/^[“「『"]|[”」』"]$/g, '')
      .trim()
    if (response) return `[${characterName}看向对方] “${response}”`
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
      const transcript = sceneMessages.map(m => `[${m.fromName}] ${m.content}`).join('\n\n')
      return { scene, transcript }
    })

    // 兜底：群聊未产出场景内容（Director 未拆场或场景循环全部失败），
    // 让 Writer 基于群聊记录产出完整章节正文。
    // ⚠️ 这是降级行为，不是 bug。role 注入后 Director 应正确拆场走 Phase 2，
    // 不会走到这里。仅在 Director 不听话时降级，此时只有 Writer 生成一次，
    // 不会出现"双重生成"（双重生成的根因是 role 未注入导致第一个 Agent 直接写正文）。
    const hasAnyScript = sceneScripts.some(s => s.transcript.length > 0)
    if (scenes.length === 0 || !hasAnyScript) {
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
2. 统一叙事视角，加入环境描写和节奏控制
3. 场景之间自然过渡，不要生硬拼接，确保整体节奏流畅
4. 根据角色推演补全必要的动作和台词，但不得擅自改变角色意图、心理状态和应对策略
5. 各场景的情绪应衔接成完整的全章情绪曲线，与 Director 规划的情绪走向呼应
6. 多名同性角色同场时，段首、动作主体切换和对话归属必须写角色姓名；“他/她”只能在唯一先行词明确时使用
7. 绝不使用长横线破折号`

    const result = await this.invokeMember(writer, prompt, [], options, { phase: 'chapter_weaving' })
    // PostWriteGuard：模型退化/字数失控检测，命中则让 Writer 重写一次
    return this.guardAndMaybeRewrite(
      result, writer, prompt, options, goal.targetWords, goal.requiredMentions,
    )
  }

  /** 对 Writer 编织后的完整正文执行 Reviewer + 可选 Reviser 闭环。 */
  private async reviewFinalChapter(
    content: string,
    members: DiscussionMember[],
    history: DiscussionMessage[],
    options: DiscussionOptions,
    targetWords?: number,
  ): Promise<{ status: 'completed'; content: string; review?: ReviewerOutcome } | { status: 'cancelled'; review?: ReviewerOutcome }> {
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
    if (decision === 'reject') return { status: 'cancelled', review: reviewOutcome ?? undefined }
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
    const rawRevision = await this.invokeMember(
      reviser,
      `请根据审稿意见修订章节，必须通过调用 novel_apply_revision 工具应用修改，不要在对话文本中输出"原文/修改后"配对。${targetWords ? `修订后正文目标约 ${targetWords} 字。` : ''}

## 原章节正文

${content}

## 审稿意见

${report}`,
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
  private formatTranscriptForMember(history: DiscussionMessage[], _memberId: string): string {
    const recent = history.slice(-10)
    return recent.map(m => `[${m.fromName}] ${m.content}`).join('\n\n')
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
