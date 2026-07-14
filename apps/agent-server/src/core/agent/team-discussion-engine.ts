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

    // 注入初始系统消息
    history.push(this.systemMessage(`目标：${goal.task}\n\n## 上下文\n${goal.context}`))

    let scenes: SceneDefinition[] = []
    let finalContent = ''
    let rounds = 0
    let noProgressRounds = 0
    let chapterConvergerId: string | undefined

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
        const decision = await this.moderator.decide(goal, history, members, state)
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
        for (let i = 0; i < scenes.length; i++) {
          const scene = scenes[i]
          rounds = 0
          noProgressRounds = 0

          history.push(this.systemMessage(this.buildSceneContext(scene)))
          this.emitProgress(options, 'scene_setup', { type: 'scene_change', data: { scene } })

          const activeMembers = this.filterMembersByScene(members, scene)
          let sceneDone = false

          while (!sceneDone && rounds < limits.maxRoundsPerScene) {
            const state: ModeratorState = {
              phase: 'acting',
              round: rounds,
              currentScene: scene,
              scenesRemaining: scenes.length - i - 1,
              scenesDefined: true,
            }
            const decision = await this.moderator.decide(goal, history, activeMembers, state)
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
      this.emitProgress(options, 'chapter_weaving', { type: 'phase_change', data: { message: '正在编织完整章节' } })
      finalContent = await this.weaveChapter(members, history, scenes, goal, options, chapterConvergerId)

      // ── Phase 4：最终正文质量门 ──
      const qualityResult = await this.reviewFinalChapter(finalContent, members, history, options)
      if (qualityResult.status === 'cancelled') {
        return { status: 'cancelled', transcript: history, scenes }
      }
      finalContent = qualityResult.content

      return {
        status: 'completed',
        content: finalContent,
        transcript: history,
        scenes,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.context.logger.error({ err }, '群聊引擎异常')
      return { status: 'error', error: message, transcript: history, scenes }
    } finally {
      for (const member of members) {
        this.channel.unsubscribe(channelName, member.id)
      }
    }
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
          let content = await this.invokeMember(member, decision.prompt, history, options, ctx)

          // 角色成员发言后触发 Reviewer 实时审查（最多重发 1 次）
          if (member.type === 'character') {
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
    ctx: { phase: DiscussionPhase; sceneId?: number },
    visibility: 'public' | 'internal' = 'public',
  ): Promise<string> {
    const systemPrompt = member.buildSystemPrompt()
    const transcriptSummary = this.formatTranscriptForMember(history, member.id)
    const userMessage = `${prompt}\n\n---\n\n## 群聊记录\n\n${transcriptSummary}`

    const handle = await this.context.createAgUiSession({
      systemPrompt,
      // 注入章节/矩阵共享上下文到 SEMI 层，确保每个成员都能看到完整背景。
      // 群聊目标中的 context 由 NovelDiscussionRunner 通过 promptBuilder 构建，
      // 包含章节约束、实体关系、矩阵状态等关键信息。
      prefixUserMessage: this.currentGoal?.context,
      userMessage,
      tools: [],
      signal: options.signal,
      temperature: member.type === 'character' ? (options.limits?.characterTemperature ?? 0.8) : 0.7,
      timeoutMs: 300_000,
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
      const result = await session.prompt()
      streamEmitter.finishTextMessage()
      return result
    } finally {
      handle.dispose()
    }
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
      const result = await this.invokeMember(writer, '请基于群聊记录产出完整章节正文', [], options, { phase: 'chapter_weaving' })
      return result
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

    const prompt = `请将以下各场景的角色推演剧本一次性编织为完整章节正文。

## 全章剧本（共 ${scenes.length} 个场景）
${combined}

## 编织要求
1. 把剧本格式（[动作] "台词"）编织为小说叙事，保留角色台词的核心内容，但可调整措辞以适应叙事节奏
2. 统一叙事视角，加入环境描写和节奏控制
3. 场景之间自然过渡，不要生硬拼接，确保整体节奏流畅
4. 保留角色演出中的情绪信号（动作节奏、台词语气），不要把情绪丰富的剧本压成干瘪的情节交代
5. 各场景的情绪应衔接成完整的全章情绪曲线，与 Director 规划的情绪走向呼应
6. 绝不使用破折号"——"`

    const result = await this.invokeMember(writer, prompt, [], options, { phase: 'chapter_weaving' })
    return result
  }

  /** 对 Writer 编织后的完整正文执行 Reviewer + 可选 Reviser 闭环。 */
  private async reviewFinalChapter(
    content: string,
    members: DiscussionMember[],
    history: DiscussionMessage[],
    options: DiscussionOptions,
  ): Promise<{ status: 'completed'; content: string } | { status: 'cancelled' }> {
    const reviewer = members.find(member => member.id === 'novel-reviewer')
    if (!reviewer) return { status: 'completed', content }

    this.emitProgress(options, 'reviewing', {
      type: 'phase_change',
      data: { message: '审稿 Agent 正在验收完整章节' },
    })
    const finalReviewer = reviewer.buildFinalReviewSystemPrompt
      ? { ...reviewer, buildSystemPrompt: reviewer.buildFinalReviewSystemPrompt }
      : reviewer
    const report = await this.invokeMember(
      finalReviewer,
      `请验收以下群聊编织完成的章节正文，并按审稿格式给出 accept/revise/reject 结论。

## 待审稿章节正文

${content}`,
      [],
      options,
      { phase: 'reviewing' },
    )
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
    if (decision === 'reject') return { status: 'cancelled' }
    if (decision !== 'revise' && decision !== 'rewrite') {
      return { status: 'completed', content }
    }

    const reviser = members.find(member => member.id === 'novel-reviser')
    if (!reviser) return { status: 'completed', content }
    const revisedContent = await this.invokeMember(
      reviser,
      `请根据审稿意见修订章节，并直接输出完整正文。

## 原章节正文

${content}

## 审稿意见

${report}`,
      [],
      options,
      { phase: 'reviewing' },
    )
    history.push({
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fromId: reviser.id,
      fromName: reviser.name,
      content: revisedContent,
      timestamp: Date.now(),
      type: 'member',
    })
    return { status: 'completed', content: revisedContent }
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
      .replace(/^[「『\[【]/, '')
      .replace(/[」』\]】]$/, '')
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
