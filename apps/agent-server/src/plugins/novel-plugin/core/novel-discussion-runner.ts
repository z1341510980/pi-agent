/**
 * NovelDiscussionRunner：novel 适配器
 *
 * 把 novel 的 Agent 角色翻译成群聊成员，构建目标，调用 TeamDiscussionEngine，
 * 成功后调用 ChapterFinalizer 收尾。
 *
 * 职责边界：
 * - 不实现群聊循环逻辑（由 TeamDiscussionEngine 负责）
 * - 不实现 Moderator 决策逻辑（由 Moderator 负责）
 * - 不实现收尾细节（由 ChapterFinalizer 负责）
 * - 只负责"翻译"：novel 概念 ↔ 通用群聊类型
 */

import type { PluginContext } from '../../../core/plugin/plugin-types.js'
import { AgentChannel } from '../../../core/agent/agent-channel.js'
import { Moderator } from '../../../core/agent/moderator.js'
import { TeamDiscussionEngine } from '../../../core/agent/team-discussion-engine.js'
import { ChapterFinalizer } from '../../../core/agent/chapter-finalizer.js'
import type {
  DiscussionFlowEvent,
  DiscussionGoal,
  DiscussionMember,
  DiscussionOptions,
  DiscussionPhase,
  DiscussionResult,
} from '../../../core/agent/discussion-types.js'
import type { DiscussionSettingsStore } from '../../../core/agent/discussion-settings-store.js'
import { NovelStore } from './novel-store.js'
import { NovelMemoryStore } from './novel-memory-store.js'
import { NovelPromptBuilder } from './prompt-builder.js'
import { NovelEngine } from './novel-engine.js'
import { NovelSessionFactory } from './novel-session.js'
import type { NovelMemoryGenerator } from './novel-memory-generator.js'
import { NOVEL_AGENT_CONFIGS, type NovelAgentType } from './novel-agents.js'
import type { NovelCharacter, NarrativeTask, ArrangedEntity } from './types.js'

/** 群聊参与工种（不含 memory，memory 由 ChapterFinalizer 收尾阶段调用） */
const DISCUSSION_AGENT_TYPES: NovelAgentType[] = ['director', 'writer', 'reviewer', 'reviser']

export class NovelDiscussionRunner {
  constructor(
    private store: NovelStore,
    private memoryStore: NovelMemoryStore,
    private sessionFactory: NovelSessionFactory,
    private promptBuilder: NovelPromptBuilder,
    private engine: NovelEngine,
    private context: PluginContext,
    private moderatorModel?: { provider: string; modelId: string },
    private memoryGenerator?: NovelMemoryGenerator,
    private discussionSettingsStore?: DiscussionSettingsStore,
  ) {}

  /**
   * 运行群聊共创流程
   *
   * 1. 构建章节约束 + 默认叙事任务
   * 2. 构建 SEMI 层 shared 上下文（跨成员复用 prompt cache）
   * 3. 构建群聊目标
   * 4. 构建成员列表（4 工种 Agent + 项目活跃角色）
   * 5. 构建引擎并运行
   * 6. 成功后调用 ChapterFinalizer.finalize 收尾
   */
  async run(
    projectId: string,
    chapterNumber: number,
    options: DiscussionOptions,
    arrangedEntities?: ArrangedEntity,
  ): Promise<DiscussionResult> {
    try {
      // 1. 构建约束 + 默认叙事任务
      const constraints = this.engine.buildChapterConstraints(projectId, chapterNumber)
      const narrativeTask = this.buildDefaultNarrativeTask(chapterNumber)

      // 2. 构建 shared 上下文（SEMI 层前缀，跨成员复用 prompt cache）
      const sharedContext = this.promptBuilder.buildChapterContextShared(
        projectId,
        chapterNumber,
        narrativeTask,
        constraints,
      )

      // 3. 构建目标
      const goal: DiscussionGoal = {
        task: `创作第 ${chapterNumber} 章正文`,
        context: sharedContext,
        constraints: {
          facts: constraints.facts.map((c) => c.rule),
          cognitive: constraints.cognitive.map((c) => c.rule),
        },
      }

      // 4. 构建成员列表
      const members = this.buildMembers(projectId, chapterNumber)

      // 5. 构建引擎并运行
      const channel = new AgentChannel()
      const moderator = new Moderator(
        {
          createSession: async (opts) => {
            return this.context.createSession({
              systemPrompt: opts.systemPrompt,
              userMessage: opts.userMessage,
              timeoutMs: opts.timeoutMs,
              modelId: opts.model,
            })
          },
          logger: this.context.logger,
        },
        options.moderatorModel ?? this.moderatorModel,
      )
      const discussionEngine = new TeamDiscussionEngine(moderator, channel, {
        createAgUiSession: async (opts) => {
          return this.context.createAgUiSession({
            systemPrompt: opts.systemPrompt,
            prefixUserMessage: opts.prefixUserMessage,
            userMessage: opts.userMessage,
            tools: opts.tools as never[],
            signal: opts.signal,
            temperature: opts.temperature,
            timeoutMs: opts.timeoutMs,
            emit: opts.emit,
            emitRaw: opts.emitRaw,
            onFirstText: opts.onFirstText,
          })
        },
        logger: this.context.logger,
      })

      // 6. 运行群聊
      // DiscussionPhase → CreationPhase 映射：前端 CreationPhase 不含群聊专属 phase
      // （planning/scene_setup/acting/scene_weaving/chapter_weaving），
      // 需在 onProgress 翻译器中映射到前端可识别的最近语义 phase。
      const phaseMap: Record<string, string> = {
        planning: 'directing',       // 规划 ≈ 导演阶段
        scene_setup: 'directing',    // 场景设置 ≈ 导演
        acting: 'writing',           // 演出 ≈ 写作
        scene_weaving: 'writing',    // 场景编织 ≈ 写作
        chapter_weaving: 'writing',  // 全章编织 ≈ 写作
        reviewing: 'reviewing',
        memory: 'memory',
        completed: 'completed',
        error: 'error',
        cancelled: 'cancelled',
      }
      // 从 discussionSettingsStore 读取运行时限制（maxRounds/maxRoundsPerScene/characterTemperature），
      // 覆盖引擎默认 DISCUSSION_LIMITS，让设置页的修改即时生效。
      const settings = this.discussionSettingsStore?.get() ?? {}
      const engineOptions: DiscussionOptions = {
        ...options,
        onProgress: (event) => {
          const mappedPhase = phaseMap[event.phase] ?? 'writing'
          options.onProgress({
            type: event.type,
            phase: mappedPhase as DiscussionPhase,
            data: event.data,
            timestamp: event.timestamp,
          })
        },
        limits: {
          maxRounds: settings.maxRounds,
          maxRoundsPerScene: settings.maxRoundsPerScene,
          characterTemperature: settings.characterTemperature,
        },
      }
      const result = await discussionEngine.run(goal, members, engineOptions)

      // 7. 收尾（成功时调用 ChapterFinalizer.finalize）
      if (result.status === 'completed' && result.content) {
        const finalizer = new ChapterFinalizer(
          this.store,
          this.memoryStore,
          this.promptBuilder,
          this.engine,
          this.context,
          this.memoryGenerator,
        )
        const finalizeResult = await finalizer.finalize({
          projectId,
          chapterNumber,
          content: result.content,
          arrangedEntities,
          options: {
            emit: options.emit,
            onCheckpoint: async (checkpoint) => {
              const reply = await options.onCheckpoint({
                type: 'discussion_pause',
                phase: checkpoint.phase,
                question: checkpoint.type === 'narrative_task' ? '叙事任务确认' : '验收报告确认',
              })
              return reply as 'approve' | 'reject' | 'revise' | 'rewrite'
            },
            onProgress: (event) => {
              const phaseMap: Record<string, DiscussionPhase> = {
                memory: 'memory',
                completed: 'completed',
                error: 'error',
                cancelled: 'cancelled',
                reviewing: 'reviewing',
              }
              options.onProgress({
                type: (event.type === 'checkpoint' ? 'pause' : event.type) as DiscussionFlowEvent['type'],
                phase: phaseMap[event.phase] ?? 'completed',
                data: event.data,
                timestamp: event.timestamp,
              })
            },
            signal: options.signal,
          },
          chapterId: null,
          sharedContextPrefix: sharedContext,
        })
        return {
          ...result,
          stateChanges: finalizeResult.stateChanges,
        }
      }

      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      options.onProgress({
        type: 'error',
        phase: 'error',
        data: { message },
        timestamp: Date.now(),
      })
      return {
        status: 'error',
        error: message,
        transcript: [],
        scenes: [],
      }
    }
  }

  /**
   * 构建群聊成员列表
   *
   * 4 个工种 Agent（director/writer/reviewer/reviser，不含 memory）
   * + 项目活跃角色（跳过 arcStage === 'resolved' 且无 currentGoal 的角色）
   */
  private buildMembers(projectId: string, _chapterNumber: number): DiscussionMember[] {
    const members: DiscussionMember[] = []

    // 4 个工种 Agent
    for (const agentType of DISCUSSION_AGENT_TYPES) {
      const config = NOVEL_AGENT_CONFIGS[agentType]
      members.push({
        id: config.id,
        type: 'role',
        name: config.name,
        expertise: config.identity,
        canConverge: agentType === 'writer' || agentType === 'reviser',
        buildSystemPrompt: () =>
          this.promptBuilder.buildSystemPrompt(projectId, agentType),
      })
    }

    // 项目活跃角色（跳过 arcStage === 'resolved' 且无 currentGoal 的角色）
    const characters = this.store.listCharacters(projectId)
    for (const char of characters) {
      if (char.arcStage === 'resolved' && !char.currentGoal) continue
      members.push(this.buildCharacterMember(char))
    }

    return members
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

  /**
   * 构建角色人设 prompt
   *
   * 注入角色人设字段，让角色 Agent 以第一人称视角参与群聊。
   */
  private buildCharacterPrompt(char: NovelCharacter): string {
    const lines: string[] = [
      `你是小说中的角色「${char.name}」，以第一人称视角参与群聊讨论。`,
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
    lines.push('- 绝不使用破折号"——"，转折用句号，补充用逗号，列举用顿号')
    return lines.join('\n')
  }

  /** 构建默认叙事任务（群聊模式下 Director 在群聊中规划，此处仅提供占位） */
  private buildDefaultNarrativeTask(chapterNumber: number): NarrativeTask {
    return {
      description: `推进第 ${chapterNumber} 章主线剧情`,
      type: 'advance_mainline',
      targetEntity: null,
      priority: 'high',
    }
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
