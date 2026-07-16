/**
 * ChapterChatRunner：章节级自由聊天执行器
 *
 * 在结构化创作流程（工作流/群聊）之外，提供章节级自由聊天能力：
 * - 用户可随时就当前章节与 Agent 对话，不影响创作流程
 * - 支持 Moderator 调度（自动选 Agent 回复）和 @ 指定 Agent 两种模式
 * - 聊天记录按章节持久化到 ChapterChatStore
 *
 * 与 NovelDiscussionRunner 的区别：
 * - DiscussionRunner 是结构化群聊共创，产出章节正文
 * - ChapterChatRunner 是非结构化自由对话，回答用户关于章节的问题
 * - 共用成员构建逻辑（4 工种 + 活跃角色），但运行机制不同
 */

import type { PluginContext } from '../../../core/plugin/plugin-types.js'
import type { AgUiEventSink } from '@repo/protocol/events'
import { EventType } from '@ag-ui/core'
import { Moderator } from '../../../core/agent/moderator.js'
import type {
  DiscussionMember,
  ModeratorState,
} from '../../../core/agent/discussion-types.js'
import { ChapterChatStore, type ChapterChatMessage } from './chapter-chat-store.js'
import { NovelStore } from './novel-store.js'
import { NovelPromptBuilder } from './prompt-builder.js'
import { NovelEngine } from './novel-engine.js'
import { runtimePerformance } from '../../../config/performance.js'
import { NOVEL_AGENT_CONFIGS, type NovelAgentType } from './novel-agents.js'
import type { NovelCharacter } from './types.js'

/** 自由聊天工种 Agent（与 DiscussionRunner 一致，不含 memory） */
const CHAT_AGENT_TYPES: NovelAgentType[] = ['director', 'writer', 'reviewer', 'reviser']

/** 自由聊天运行选项 */
export interface ChapterChatOptions {
  /** AG-UI 事件发射器 */
  emit: AgUiEventSink
  /** 取消信号 */
  signal?: AbortSignal
  /** Moderator 模型配置 */
  moderatorModel?: { provider: string; modelId: string }
}

/** 自由聊天请求输入 */
export interface ChapterChatInput {
  /** 用户消息内容 */
  message: string
  /** 用户 @ 指定的 Agent ID 列表（如 ['novel-director', 'char-xxx']），为空时由 Moderator 调度 */
  mentionedAgents?: string[]
}

/** 自由聊天单条 Agent 回复结果 */
export interface ChapterChatReply {
  agentId: string
  agentName: string
  agentType: string
  content: string
}

export class ChapterChatRunner {
  constructor(
    private store: NovelStore,
    private promptBuilder: NovelPromptBuilder,
    private engine: NovelEngine,
    private context: PluginContext,
    private chatStore: ChapterChatStore,
    private moderatorModel?: { provider: string; modelId: string },
  ) {}

  /**
   * 运行一次自由聊天
   *
   * 1. 持久化用户消息
   * 2. 构建 members（4 工种 + 活跃角色）
   * 3. 决策回复 Agent：
   *    - mentionedAgents 非空 → 依次让被 @ 的 Agent 回复
   *    - 否则 → Moderator 单轮决策选一个 Agent 回复
   * 4. 调用 Agent 发言（SSE 流式）
   * 5. 持久化 Agent 回复
   */
  async run(
    projectId: string,
    chapterNumber: number,
    input: ChapterChatInput,
    options: ChapterChatOptions,
  ): Promise<{ replies: ChapterChatReply[] }> {
    const replies: ChapterChatReply[] = []

    // 1. 持久化用户消息
    this.chatStore.add({
      projectId,
      chapterNumber,
      role: 'user',
      fromId: 'user',
      fromName: '用户',
      content: input.message,
      phase: 'free_chat',
      metadata: {
        mentionedAgents: input.mentionedAgents,
      },
    })

    // 2. 构建 members
    const members = this.buildMembers(projectId)
    if (members.length === 0) {
      throw new Error('无可用的聊天成员')
    }

    // 3. 决策回复 Agent
    const respondents = await this.selectRespondents(members, input.mentionedAgents, options, input.message)

    // 4. 依次调用 Agent 发言
    for (const member of respondents) {
      const history = this.chatStore.list(projectId, chapterNumber)
      try {
        const content = await this.invokeMember(member, input.message, history, options)
        const agentType = this.inferAgentType(member.id)
        const reply: ChapterChatReply = {
          agentId: member.id,
          agentName: member.name,
          agentType,
          content,
        }
        replies.push(reply)

        // 5. 持久化 Agent 回复
        this.chatStore.add({
          projectId,
          chapterNumber,
          role: 'agent',
          fromId: member.id,
          fromName: member.name,
          content,
          phase: 'free_chat',
          metadata: {
            agentType,
            mentionedAgents: input.mentionedAgents,
          },
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.context.logger.warn({ err, agentId: member.id }, 'ChapterChat Agent 发言失败')
        // 错误不阻塞，继续下一个 Agent
        this.chatStore.add({
          projectId,
          chapterNumber,
          role: 'system',
          fromId: 'system',
          fromName: '系统',
          content: `${member.name} 回复失败：${message}`,
          phase: 'free_chat',
        })
      }
    }

    return { replies }
  }

  /**
   * 选择回复 Agent
   *
   * - mentionedAgents 非空 → 过滤出存在的成员，依次回复
   * - 否则 → Moderator 单轮决策选一个 Agent
   */
  private async selectRespondents(
    members: DiscussionMember[],
    mentionedAgents: string[] | undefined,
    options: ChapterChatOptions,
    userMessage: string,
  ): Promise<DiscussionMember[]> {
    // @ 指定模式
    if (mentionedAgents && mentionedAgents.length > 0) {
      const selected = members.filter((m) => mentionedAgents.includes(m.id))
      if (selected.length > 0) return selected
      // @ 的 Agent 都不存在，降级为 Moderator 调度
      this.context.logger.warn({ mentionedAgents }, '@ 指定的 Agent 均不存在，降级为 Moderator 调度')
    }

    // Moderator 调度模式：单轮决策选一个 Agent
    const member = await this.selectRespondentViaModerator(members, userMessage, options)
    return member ? [member] : []
  }

  /**
   * 异步选择回复 Agent（Moderator 调度模式）
   *
   * Moderator 看到用户消息 + 成员列表，输出一个 invite 决策，
   * 引擎执行该决策让被点名的 Agent 回复。
   */
  private async selectRespondentViaModerator(
    members: DiscussionMember[],
    userMessage: string,
    options: ChapterChatOptions,
  ): Promise<DiscussionMember | null> {
    const moderator = new Moderator(
      {
        createSession: async (opts) => {
          return this.context.createSession({
            systemPrompt: opts.systemPrompt,
            userMessage: opts.userMessage,
            timeoutMs: opts.timeoutMs,
            modelId: opts.model,
            signal: opts.signal,
          })
        },
        logger: this.context.logger,
      },
      options.moderatorModel ?? this.moderatorModel,
    )

    const state: ModeratorState = {
      phase: 'free_chat',
      round: 0,
      scenesDefined: true, // 自由聊天不拆场
    }

    // 构造简化的目标 + 历史（只含用户消息）
    const goal = {
      task: '回应用户关于本章的提问或讨论',
      context: userMessage,
    }
    const history = [
      {
        id: `user-${Date.now()}`,
        fromId: 'user',
        fromName: '用户',
        content: userMessage,
        timestamp: Date.now(),
        type: 'user' as const,
      },
    ]

    const decision = await moderator.decide(goal, history, members, state, options.signal)
    if (decision.type === 'invite') {
      return members.find((m) => m.id === decision.agentId) ?? null
    }
    // Moderator 返回 converge/observe/next_scene 时，降级为选第一个工种 Agent
    if (decision.type === 'converge') {
      return members.find((m) => m.id === decision.agentId) ?? null
    }
    // 其他情况：选 director 作为默认回复者
    return members.find((m) => m.id === NOVEL_AGENT_CONFIGS.director.id) ?? members[0]
  }

  /** 调用 Agent 发言 */
  private async invokeMember(
    member: DiscussionMember,
    userMessage: string,
    history: ChapterChatMessage[],
    options: ChapterChatOptions,
  ): Promise<string> {
    const systemPrompt = member.buildSystemPrompt()
    // 构建上下文：最近 10 条聊天记录 + 当前章节信息提示
    const recentHistory = history.slice(-10)
    const transcript = recentHistory
      .map((m) => `[${m.fromName}] ${m.content}`)
      .join('\n\n')

    const userMessageWithCtx = `## 用户提问\n${userMessage}\n\n---\n\n## 章节聊天记录（最近 ${recentHistory.length} 条）\n${transcript}\n\n---\n\n请基于你的角色定位回应用户。回答要简洁、聚焦，不要写小说正文，不要使用破折号"——"。`

    const handle = await this.context.createAgUiSession({
      systemPrompt,
      userMessage: userMessageWithCtx,
      tools: [],
      signal: options.signal,
      temperature: member.type === 'character' ? 0.8 : 0.5,
      timeoutMs: runtimePerformance.llm.timeoutMs,
      emit: options.emit,
      emitRaw: false,
      onFirstText: () => {
        // Agent 开始发言的进度由 SSE 事件本身反映，这里不做额外处理
      },
    })

    const agentType = this.inferAgentType(member.id)

    // ⚠️ 时序契约：agent_start 必须在 session.prompt() 之前发射，
    // 前端据此建立 messageId → agent 映射，关联后续 TEXT_MESSAGE_* 事件。
    // 与 NovelOrchestrator.runAgent 的 agent_start 发射模式一致。
    options.emit({
      type: EventType.CUSTOM,
      name: 'novel:progress',
      value: {
        type: 'agent_start',
        phase: 'free_chat',
        timestamp: Date.now(),
        data: {
          agentId: member.id,
          agentName: member.name,
          agentType,
          messageId: handle.messageId,
          message: `${member.name} 正在回复...`,
        },
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

  /** 从 member.id 推断 agentType */
  private inferAgentType(memberId: string): string {
    if (memberId.startsWith('char-')) return 'character'
    const entry = Object.entries(NOVEL_AGENT_CONFIGS).find(([, cfg]) => cfg.id === memberId)
    return entry?.[0] ?? 'unknown'
  }

  /**
   * 构建聊天成员列表
   *
   * 与 NovelDiscussionRunner.buildMembers 逻辑一致：
   * 4 个工种 Agent + 项目活跃角色
   */
  private buildMembers(projectId: string): DiscussionMember[] {
    const members: DiscussionMember[] = []

    // 4 个工种 Agent
    for (const agentType of CHAT_AGENT_TYPES) {
      const config = NOVEL_AGENT_CONFIGS[agentType]
      members.push({
        id: config.id,
        type: 'role',
        name: config.name,
        expertise: config.identity,
        canConverge: false, // 自由聊天不需要收敛
        buildSystemPrompt: () => this.buildRolePrompt(agentType, projectId),
      })
    }

    // 项目活跃角色
    const characters = this.store.listCharacters(projectId)
    for (const char of characters) {
      if (char.arcStage === 'resolved' && !char.currentGoal) continue
      members.push(this.buildCharacterMember(char))
    }

    return members
  }

  /** 构建工种 Agent 的自由聊天 prompt */
  private buildRolePrompt(agentType: NovelAgentType, projectId: string): string {
    const basePrompt = this.promptBuilder.buildSystemPrompt(projectId, agentType)
    const roleHint = `\n\n## 当前模式：章节自由聊天\n你正在与用户就当前章节进行自由对话。回答要简洁、聚焦，不要写小说正文，不要使用破折号"——"。`
    return basePrompt + roleHint
  }

  /** 构建角色成员 */
  private buildCharacterMember(char: NovelCharacter): DiscussionMember {
    return {
      id: `char-${char.id}`,
      type: 'character',
      name: char.name,
      expertise: char.personality || char.identity || char.description,
      canConverge: false,
      characterProfile: {
        personality: char.personality,
        currentState: char.currentState,
        currentGoal: char.currentGoal,
        secret: char.secret,
        arcStage: char.arcStage,
        participatingConflicts: this.parseIdList(char.participatingConflicts),
      },
      buildSystemPrompt: () => this.buildCharacterPrompt(char),
    }
  }

  /** 构建角色人设 prompt */
  private buildCharacterPrompt(char: NovelCharacter): string {
    const lines: string[] = [
      `你是小说中的角色「${char.name}」，以第一人称视角与用户对话。`,
      '',
      '## 你的设定',
    ]
    if (char.identity) lines.push(`- 身份：${char.identity}`)
    if (char.personality) lines.push(`- 性格：${char.personality}`)
    if (char.currentState) lines.push(`- 当前状态：${char.currentState}`)
    if (char.currentGoal) lines.push(`- 当前目标：${char.currentGoal}`)
    if (char.secret) lines.push(`- 隐藏秘密：${char.secret}`)
    if (char.arcStage) lines.push(`- 角色弧光阶段：${char.arcStage}`)
    lines.push('')
    lines.push('## 发言要求')
    lines.push('- 以角色口吻发言，保持性格一致')
    lines.push('- 基于当前状态和目标表达观点')
    lines.push('- 回答要简洁、聚焦，不要写小说正文')
    lines.push('- 绝不使用破折号"——"，转折用句号，补充用逗号，列举用顿号')
    return lines.join('\n')
  }

  /** 容错解析 JSON 字符串数组 */
  private parseIdList(raw: string): string[] {
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === 'string')
        : []
    } catch {
      return []
    }
  }
}
