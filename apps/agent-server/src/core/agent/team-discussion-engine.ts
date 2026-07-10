/**
 * TeamDiscussionEngine：通用群聊引擎
 *
 * 驱动群聊循环：Moderator 决策 → 成员发言 → 消息入历史 → 下一轮。
 * 不依赖任何业务领域（不知道"小说"是什么）。
 *
 * 循环阶段：
 * 1. planning：Moderator 驱动规划，Director 输出场景拆分
 * 2. acting（场景循环）：每个场景内角色演出 → Writer 整理
 * 3. chapter_weaving：Writer 合并各场景片段
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
    const history: DiscussionMessage[] = []
    const channelName = `discuss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // 订阅所有成员到群聊频道
    for (const member of members) {
      this.channel.subscribe(channelName, member.id)
    }

    // 注入初始系统消息
    history.push(this.systemMessage(`目标：${goal.task}\n\n## 上下文\n${goal.context}`))

    let scenes: SceneDefinition[] = []
    let sceneContents: string[] = []
    let finalContent = ''
    let rounds = 0
    let noProgressRounds = 0
    let chapterConvergerId: string | undefined

    try {
      // ── Phase 1：规划 ──
      let planningDone = false
      while (!planningDone && rounds < DISCUSSION_LIMITS.MAX_ROUNDS) {
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
          chapterConvergerId = decision.agentId
          planningDone = true
        }
        if (decision.type === 'observe') {
          noProgressRounds++
          if (noProgressRounds >= DISCUSSION_LIMITS.MAX_OBSERVE_ROUNDS) {
            planningDone = true
            scenes = []
          }
        } else {
          noProgressRounds = 0
        }
      }

      // ── Phase 2：场景循环（如有场景）──
      if (scenes.length > 0) {
        for (let i = 0; i < scenes.length; i++) {
          const scene = scenes[i]
          rounds = 0
          noProgressRounds = 0

          history.push(this.systemMessage(this.buildSceneContext(scene)))
          this.emitProgress(options, 'scene_setup', { type: 'scene_change', data: { scene } })

          const activeMembers = this.filterMembersByScene(members, scene)
          let sceneDone = false

          while (!sceneDone && rounds < DISCUSSION_LIMITS.MAX_ROUNDS_PER_SCENE) {
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

            if (decision.type === 'converge' && decision.scope === 'scene') {
              const sceneContent = await this.weaveScene(decision.agentId, history, scene, members, options)
              sceneContents.push(sceneContent)
              sceneDone = true
            } else if (decision.type === 'next_scene') {
              sceneDone = true
            } else if (decision.type === 'observe') {
              noProgressRounds++
              if (noProgressRounds >= DISCUSSION_LIMITS.MAX_OBSERVE_ROUNDS) {
                const writer = members.find(m => m.canConverge)
                if (writer) {
                  const sceneContent = await this.weaveScene(writer.id, history, scene, members, options)
                  sceneContents.push(sceneContent)
                  sceneDone = true
                }
              }
            } else {
              noProgressRounds = 0
            }
          }
        }
      }

      // ── Phase 3：全章编织 ──
      this.emitProgress(options, 'chapter_weaving', { type: 'phase_change', data: { message: '正在编织完整章节' } })
      finalContent = await this.weaveChapter(members, sceneContents, scenes, goal, options, chapterConvergerId)

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
        try {
          const content = await this.invokeMember(member, decision.prompt, history, options, ctx)
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
  ): Promise<string> {
    const systemPrompt = member.buildSystemPrompt()
    const transcriptSummary = this.formatTranscriptForMember(history, member.id)
    const userMessage = `${prompt}\n\n---\n\n## 群聊记录\n\n${transcriptSummary}`

    const handle = await this.context.createAgUiSession({
      systemPrompt,
      userMessage,
      tools: [],
      signal: options.signal,
      temperature: member.type === 'character' ? 0.8 : 0.7,
      timeoutMs: 300_000,
      emit: options.emit,
      emitRaw: false,
      onFirstText: () => {
        this.emitProgress(options, ctx.phase, {
          type: 'agent_start',
          data: { agentName: member.name, message: `${member.name} 开始发言...` },
        })
      },
    })

    try {
      const result = await handle.session.prompt()
      handle.streamEmitter.finishTextMessage()
      return result
    } finally {
      handle.dispose()
    }
  }

  /** 整理单个场景的群聊记录为正文片段 */
  private async weaveScene(
    writerId: string,
    history: DiscussionMessage[],
    scene: SceneDefinition,
    members: DiscussionMember[],
    options: DiscussionOptions,
  ): Promise<string> {
    const writer = members.find(m => m.id === writerId)
    if (!writer) throw new Error(`收敛成员不存在: ${writerId}`)

    const sceneMessages = history.filter(m => m.sceneId === scene.sceneId && m.type === 'member')
    const transcript = sceneMessages.map(m => `[${m.fromName}] ${m.content}`).join('\n\n')

    const prompt = `请将以下群聊演出记录整理为小说正文片段。

## 场景信息
- 标题：${scene.title}
- 地点：${scene.location}
- 时间：${scene.time}
- 冲突：${scene.conflict ?? '无'}
- 目标：${scene.goal}

## 群聊演出记录
${transcript}

## 要求
1. 把剧本格式（[动作] "台词"）编织为小说叙事
2. 统一叙事视角，加入环境描写和节奏控制
3. 保留角色台词的核心内容，但可以调整措辞以适应叙事
4. 绝不使用破折号"——"`

    const result = await this.invokeMember(writer, prompt, [], options, { phase: 'scene_weaving' })
    return result
  }

  /** 合并各场景片段为完整章节正文 */
  private async weaveChapter(
    members: DiscussionMember[],
    sceneContents: string[],
    scenes: SceneDefinition[],
    goal: DiscussionGoal,
    options: DiscussionOptions,
    chapterConvergerId?: string,
  ): Promise<string> {
    const writer = members.find(m => m.canConverge)
      ?? (chapterConvergerId ? members.find(m => m.id === chapterConvergerId) : undefined)
      ?? members[0]
    if (!writer) throw new Error('无可收敛成员')

    if (sceneContents.length === 0) {
      const result = await this.invokeMember(writer, '请基于群聊记录产出完整章节正文', [], options, { phase: 'chapter_weaving' })
      return result
    }

    const combined = sceneContents.map((content, i) => {
      const scene = scenes[i]
      return `### 场景${i + 1}：${scene?.title ?? ''}\n\n${content}`
    }).join('\n\n---\n\n')

    const prompt = `请将以下各场景的正文片段合并为完整章节正文。

## 各场景片段
${combined}

## 要求
1. 场景之间自然过渡，不要生硬拼接
2. 确保整体节奏流畅
3. 绝不使用破折号"——"`

    const result = await this.invokeMember(writer, prompt, [], options, { phase: 'chapter_weaving' })
    return result
  }

  /** 解析 Director 输出为场景列表 */
  private parseScenes(history: DiscussionMessage[], members: DiscussionMember[]): SceneDefinition[] {
    const directorMsg = [...history].reverse().find(m => m.type === 'member' && m.fromId.startsWith('novel-'))
    if (!directorMsg) return []

    const nameToId = new Map<string, string>()
    for (const m of members) {
      if (m.type === 'character') {
        nameToId.set(m.name, m.id)
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

      const presentNamesRaw = this.extractField(block, '在场角色') ?? ''
      const presentNames = presentNamesRaw.split(/[、,，\s]+/).filter(Boolean)
      const presentCharacters = presentNames
        .map(name => nameToId.get(name.trim()))
        .filter((id): id is string => !!id)

      scenes.push({ sceneId, title, location, time, presentCharacters, conflict, goal: goalText })
    }

    return scenes
  }

  /** 构建场景上下文摘要（注入群聊历史，告知成员当前场景信息） */
  private buildSceneContext(scene: SceneDefinition): string {
    return `## 场景${scene.sceneId}：${scene.title}
- 地点：${scene.location}
- 时间：${scene.time}
- 冲突：${scene.conflict ?? '无'}
- 目标：${scene.goal}`
  }

  /** 从 markdown 块中提取字段值 */
  private extractField(block: string, fieldName: string): string | undefined {
    const regex = new RegExp(`-\\s*${fieldName}[：:]\\s*(.+)`)
    const match = block.match(regex)
    return match?.[1]?.trim()
  }

  /** 过滤场景在场成员 */
  private filterMembersByScene(members: DiscussionMember[], scene: SceneDefinition): DiscussionMember[] {
    return members.filter(m => {
      if (m.type === 'role') return true
      return scene.presentCharacters.includes(m.id)
    })
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
    options.onProgress({
      type: event.type,
      phase,
      data: event.data,
      timestamp: Date.now(),
    })
  }
}
