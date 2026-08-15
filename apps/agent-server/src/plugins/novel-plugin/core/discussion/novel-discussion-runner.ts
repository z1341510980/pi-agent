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

import type { PluginContext } from '../../../../core/plugin/plugin-types.js'
import { AgentChannel } from '../../../../core/agent/agent-channel.js'
import { Moderator } from '../../../../core/agent/moderator.js'
import { TeamDiscussionEngine } from '../../../../core/agent/team-discussion-engine.js'
import { ChapterFinalizer } from '../../../../core/agent/chapter-finalizer.js'
import type {
  DiscussionFlowEvent,
  DiscussionGoal,
  DiscussionMember,
  DiscussionOptions,
  DiscussionPhase,
  DiscussionResult,
  DiscussionResumeState,
  SceneDefinition,
} from '../../../../core/agent/discussion-types.js'
import type { DiscussionSettingsStore } from '../../../../core/agent/discussion-settings-store.js'
import { NovelStore } from '../novel-store.js'
import { NovelMemoryStore } from '../novel-memory-store.js'
import { NovelPromptBuilder, type ChapterBoundaryContext } from '../prompting/prompt-builder.js'
import { NovelEngine } from '../novel-engine.js'
import type { NovelMemoryGenerator } from '../generation/novel-memory-generator.js'
import { NOVEL_AGENT_CONFIGS, type NovelAgentType } from '../domain/novel-agents.js'
import type { NovelCharacter, NarrativeTask, ArrangedEntity, VersionSource } from '../types.js'
import { isNovelFeatureEnabled } from '../domain/novel-feature-flags.js'
import { baseTargetOf, resolveWordBudget } from '../chapters/word-budget-resolver.js'
import { buildScenePlanFromSceneDefinitions } from '../chapters/chapter-scene-plan-adapter.js'
import { sanitizeNovelProse } from '../agent-run-utils.js'
import { createNovelApplyRevisionTool, type RevisionDraftHolder } from '../novel-tools.js'
import { createNovelSubmitReviewTool, type ReviewDraftHolder } from '../novel-tools.js'
import {
  buildVoiceProfiles,
  type CharacterVoiceProfile,
} from '../entities/character-voice.js'
import {
  buildCharacterIdentityPrompt,
  buildCharacterSystemPrompt,
  buildCharacterVisibleContext,
  collectCharacterKnowledge,
} from './novel-character-discussion-context.js'
import { resolveChapterBoundaryEntity } from '../chapters/chapter-boundary-resolution.js'
import { parseNovelModelRef } from '../domain/novel-model-ref.js'
import { evaluateProseQuality, formatProseQualityReport } from '../quality/prose-quality-evaluator.js'
import { registerInterjectEnqueuer, unregisterInterjectEnqueuer } from '../../utils/chapter-task-registry.js'


/** 群聊参与工种（不含 memory，memory 由 ChapterFinalizer 收尾阶段调用） */
const DISCUSSION_AGENT_TYPES: NovelAgentType[] = ['director', 'writer', 'reviewer', 'reviser']

export class NovelDiscussionRunner {
  constructor(
    private store: NovelStore,
    private memoryStore: NovelMemoryStore,
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
    resumeState?: DiscussionResumeState,
  ): Promise<DiscussionResult> {
    let discussionResult: DiscussionResult | undefined
    let outerPhase: DiscussionPhase | undefined
    // 插话投递通道（对话化交互形态 §3.1，批次 1 任务 3）：engine 是本方法内的
    // 局部实例、插话端点不可直达，因此把 enqueueUserMessage 闭包登记到共享注册表，
    // 供 POST /projects/:projectId/flows/:flowId/messages 在 kind='discussion' 时路由。
    const interjectFlowKey = `${projectId}|${chapterNumber}`
    try {
      this.store.assertTimelineAllowsGeneration?.(projectId, chapterNumber)
      // 首次运行解析并冻结项目主模型；恢复旧快照没有该字段时才回读当前设置。
      // 新快照会持久化解析结果，避免失败后项目设置变更导致同一章换模型。
      const projectModel = options.projectModel === null
        ? undefined
        : options.projectModel ?? parseNovelModelRef(this.store.getNovelModelId(projectId))
      const styleProfile = this.store.getWritingStyleProfile(projectId)
      if (!styleProfile || styleProfile.positiveExamples.length === 0 || styleProfile.negativeExamples.length === 0) {
        options.onProgress({
          type: 'phase_change',
          phase: 'planning',
          data: {
            message: '文风质量基线尚未完整配置，本次仍可创作，但正文声音可能不稳定',
            detail: {
              kind: 'style_baseline_warning',
              hasProfile: Boolean(styleProfile),
              positiveExamples: styleProfile?.positiveExamples.length ?? 0,
              negativeExamples: styleProfile?.negativeExamples.length ?? 0,
            },
          },
          timestamp: Date.now(),
        })
      }
      // 1. 构建约束 + 默认叙事任务
      const chapter = this.store.getChapter(projectId, chapterNumber)
      const boundary = this.promptBuilder.getChapterBoundaryContext(projectId, chapterNumber)
      const constraints = this.engine.buildChapterConstraints(
        projectId,
        chapterNumber,
        undefined,
        chapter?.positioning,
        arrangedEntities,
        boundary.entities,
      )
      const narrativeTask = this.buildDefaultNarrativeTask(projectId, chapterNumber)

      // 2. 构建 shared 上下文（SEMI 层前缀，跨成员复用 prompt cache）
      // ⚠️ 必须传递 arrangedEntities，否则矩阵中为本章编排的实体（角色/冲突/伏笔等）
      // 不会注入 SEMI 层共享上下文，群聊成员看不到矩阵约束。
      const sharedContext = this.promptBuilder.buildChapterContextShared(
        projectId,
        chapterNumber,
        narrativeTask,
        constraints,
        arrangedEntities,
      )
      // 3. 构建目标
      const goal: DiscussionGoal = {
        task: `创作第 ${chapterNumber} 章正文`,
        context: sharedContext,
        targetWords: constraints.wordBudget?.target
          ?? resolveWordBudget({ baseTarget: baseTargetOf(this.store.getProject(projectId)?.targetWords) }).resolvedTarget,
        requiredMentions: arrangedEntities
          ? arrangedEntities.characterIds
              .map(id => this.store.getCharacter(id)?.name)
              .filter((name): name is string => !!name && !/（待定）|待补充|待定$/.test(name))
          : undefined,
        constraints: {
          facts: constraints.facts.map((c) => c.rule),
          cognitive: constraints.cognitive.map((c) => c.rule),
        },
      }

      // 4. 构建成员列表
      const members = this.buildMembers(
        projectId,
        chapterNumber,
        arrangedEntities,
        boundary,
        options.memberModel,
        projectModel,
      )

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
              signal: opts.signal,
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
            modelId: opts.modelId,
            // Skill 白名单接入：透传成员授权的群聊角色 Skill
            skill: opts.skill,
            emit: opts.emit,
            emitRaw: opts.emitRaw,
            onFirstText: opts.onFirstText,
          })
        },
        logger: this.context.logger,
      })
      // 登记插话投递闭包：engine 创建成功即对外可插话（闭包携带存活标记，
      // engine 收尾后返回 false），engine 调用一返回即注销（见下方 finally）。
      registerInterjectEnqueuer(
        interjectFlowKey,
        msg => discussionEngine.enqueueUserMessage(msg),
      )

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
        projectModel,
        resolveCharacterMembers: (characterNames) =>
          this.resolveCharacterMembers(
            projectId,
            chapterNumber,
            arrangedEntities,
            boundary,
            characterNames,
            options.memberModel,
            projectModel,
          ),
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
        // 最终整章 Reviewer 已覆盖整体质量门，默认关闭逐角色即时审查，
        // 避免角色数 × 对戏轮数的额外 LLM 调用。底层引擎仍保留显式开启能力。
        reviewCharacterSpeech: false,
        buildProseQualityReport: content => formatProseQualityReport(evaluateProseQuality(content)),
        // ⚠️ 工具化修订方案：业务层通过 buildReviserToolset 提供 draft + 工具。
        // 引擎在调用 Reviser 前传入原章节正文，工厂创建 draft（持有原正文）+ 工具，
        // 引擎把工具注入 Reviser 的 LLM 调用。Reviser 必须调用 novel_apply_revision
        // 工具才能修改正文，工具内部用 String.replace 做精确替换，完全绕开正则解析。
        // 旧方案让 Reviser 输出"原文/修改后"配对文本，引擎再用 applySafeRevision 正则解析，
        // LLM 不严格遵守格式时会走 full 兜底把"修改意见"当作完整正文落库。
        buildReviserToolset: originalContent => {
          const draft: RevisionDraftHolder = {
            content: originalContent,
            appliedPatches: [],
          }
          return {
            tools: [createNovelApplyRevisionTool(draft)],
            extractResult: () => {
              const successCount = draft.appliedPatches.filter(p => p.success).length
              return {
                content: draft.content,
                appliedPatchCount: draft.appliedPatches.length,
                successCount,
                mode: successCount > 0 ? 'patch' as const : 'rejected' as const,
                reason: draft.appliedPatches.length === 0
                  ? 'tool_not_called'
                  : 'all_patches_failed',
              }
            },
          }
        },
        // ⚠️ 工具化方案：业务层通过 buildReviewerToolset 提供 draft + 工具。
        // 引擎把工具注入 Reviewer 的 LLM 调用。Reviewer 必须调用 novel_submit_review
        // 工具才能提交结构化验收对象（十维评分 + verdict + issues + suggestions），
        // 工具参数 schema 强制校验，完全绕开正则解析。
        // 旧路径让 Reviewer 输出 Markdown 报告，再用 parseChapterReviewReport 正则解析，
        // LLM 不严格遵守格式时评分/结论降级为 null，Reviewer 的真实判断丢失。
        buildReviewerToolset: () => {
          const draft: ReviewDraftHolder = {}
          return {
            tools: [createNovelSubmitReviewTool(draft)],
            extractResult: () => ({
              toolCalled: Boolean(draft.review),
              review: draft.review ?? null,
            }),
          }
        },
        onMemberInvocation: (invocation) => {
          const agentType = invocation.member.type === 'character'
            ? 'character'
            : invocation.member.id.replace(/^novel-/, '')
          const participantName = invocation.participantNames?.join('、') || invocation.member.name
          this.store.insertAgentLog({
            projectId,
            chapterNumber,
            agentType,
            agentName: participantName,
            displayAgentType: agentType,
            displayAgentName: participantName,
            phase: invocation.phase,
            systemPrompt: invocation.systemPrompt,
            chapterContext: invocation.chapterContext,
            userMessage: invocation.userMessage,
            taskInput: invocation.userMessage,
            userInstructions: [],
            // 群聊侧原来把这两个字段硬编码成空数组，导致日志里看不出
            // Reviser 到底有没有拿到 novel_apply_revision。现在从引擎透传真实工具名。
            // `?? []` 兜底：onMemberInvocation 是对外回调，旧调用方可能不带这个字段。
            tools: (invocation.toolNames ?? []).map(name => ({ name, description: '' })),
            toolNames: invocation.toolNames ?? [],
            result: invocation.result,
            resultLength: invocation.result.length,
            durationMs: invocation.durationMs,
            status: invocation.status,
            error: invocation.error,
            sessionId: invocation.sessionId,
            inputTokens: invocation.inputTokens,
            outputTokens: invocation.outputTokens,
            cacheReadTokens: invocation.cacheReadTokens,
            cacheWriteTokens: invocation.cacheWriteTokens,
            llmProvider: invocation.llmProvider || invocation.member.modelId?.provider || '',
            llmModel: invocation.llmModel || invocation.member.modelId?.modelId || '',
            payloadMessagesChars: invocation.payloadMessagesChars ?? 0,
            payloadToolsChars: invocation.payloadToolsChars ?? 0,
            payloadToolCount: invocation.payloadToolCount ?? 0,
            payloadTotalChars: invocation.payloadTotalChars ?? 0,
            llmRoundTrips: invocation.llmRoundTrips ?? 0,
            // 群聊尚未接入 ask_story 灰度策略；按实际透传工具名记录兼容默认。
            askStoryPolicy: 'legacy',
            askStoryEnabled: (invocation.toolNames ?? []).includes('novel_ask_story'),
          })
        },
      }
      // engine 调用返回（正常/异常/取消，其 finally 已 flush dropped 插话）后
      // 必须立即注销投递闭包：其后还有数十秒的 ChapterFinalizer 收尾阶段，
      // 若窗口内仍受理插话，消息只会进入已无人 drain 的死队列，SSE 状态
      // 永远停在 queued。注销后收尾窗口内的插话由端点回 409。
      let result: DiscussionResult
      try {
        result = resumeState
          ? await discussionEngine.resumeChapterWeaving(goal, members, engineOptions, resumeState)
          : await discussionEngine.run(goal, members, engineOptions)
      } finally {
        unregisterInterjectEnqueuer(interjectFlowKey)
      }
      discussionResult = result

      // ⚠️ 工具化方案：Reviewer 通过 novel_submit_review 工具提交结构化验收对象，
      // 引擎在 result.review 中透传 ReviewerOutcome（含 review 字段，未知类型）。
      // Review 必须等 Finalizer 创建 current content revision 后再保存，否则
      // saveReview 无法绑定 revision，发布前置条件会把它视为旧稿审查。
      const reviewOutcome = result.review

      // 7. 收尾（成功时调用 ChapterFinalizer.finalize）
      if (result.status === 'completed' && result.content) {
        outerPhase = 'memory'

        // T03 V2 计划写（2026-08-12 逻辑统一：scenePlanV2Write 转正，恒写群聊 V2 plan）
        this.shadowWriteDiscussionPlan(projectId, chapterNumber, result.scenes ?? [])

        const sanitizedContent = sanitizeNovelProse(result.content)
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
          content: sanitizedContent,
          arrangedEntities,
          versionSource: {
            phase: 'discussion_weaver',
            agentType: 'writer',
            trigger: '群聊共创编织',
          } satisfies VersionSource,
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
            modelId: options.memberModel ?? projectModel,
          },
          chapterId: this.store.getChapter(projectId, chapterNumber)?.id ?? null,
        })
        if (typeof finalizeResult.content !== 'string') {
          throw new Error('章节收尾未返回可持久化正文')
        }
        const reviewedChapter = this.store.getChapter(projectId, chapterNumber)
        if (reviewOutcome?.review && reviewedChapter) {
          try {
            await this.engine.saveReview({
              projectId,
              chapterId: reviewedChapter.id,
              // Finalizer 已完成正文清洗、revision 创建和 current revision 更新。
              reviewedContent: finalizeResult.content,
              ...(reviewOutcome.review as Omit<
                import('@repo/shared/novel').NovelChapterReview,
                'id' | 'projectId' | 'chapterId' | 'reviewedBy' | 'createdAt' | 'contentRevisionId' | 'contentHash'
              >),
              reviewedBy: 'novel-reviewer',
            })
          } catch (error) {
            this.context.logger.warn(
              { error, projectId, chapterNumber },
              '群聊章节审稿报告持久化失败，不阻断创作流程',
            )
          }
        } else if (reviewedChapter && reviewOutcome && !reviewOutcome.toolCalled) {
          this.context.logger.warn(
            { projectId, chapterNumber },
            '群聊 Reviewer 未调用 novel_submit_review 工具，验收报告未持久化',
          )
        }
        return {
          ...result,
          content: finalizeResult.content,
          stateChanges: finalizeResult.stateChanges,
        }
      }

      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (options.signal?.aborted) {
        options.onProgress({
          type: 'cancelled',
          phase: 'cancelled',
          data: { message: '用户已停止群聊创作流程' },
          timestamp: Date.now(),
        })
        return {
          status: 'cancelled',
          content: discussionResult?.content,
          transcript: discussionResult?.transcript ?? resumeState?.transcript ?? [],
          scenes: discussionResult?.scenes ?? resumeState?.scenes ?? [],
        }
      }
      options.onProgress({
        type: 'error',
        phase: 'error',
        data: { message },
        timestamp: Date.now(),
      })
      return {
        status: 'error',
        error: message,
        failedPhase: outerPhase ?? discussionResult?.failedPhase,
        content: discussionResult?.content,
        transcript: discussionResult?.transcript ?? resumeState?.transcript ?? [],
        scenes: discussionResult?.scenes ?? resumeState?.scenes ?? [],
      }
    } finally {
      // 幂等双保险：engine 调用返回后已在其紧跟的 finally 内注销（见上），
      // 此处兜底覆盖 engine 调用之前抛错（注册后未运行）等路径，重复注销无害。
      unregisterInterjectEnqueuer(interjectFlowKey)
    }
  }

  /**
   * T03 影子写（V2）：群聊 SceneDefinition[] → V2 plan + scenes（flag 开启时调用）。
   * 只落库不改行为；失败仅告警。
   */
  private shadowWriteDiscussionPlan(
    projectId: string,
    chapterNumber: number,
    sceneDefinitions: SceneDefinition[],
  ): void {
    const chapter = this.store.getChapter(projectId, chapterNumber)
    if (!chapter || sceneDefinitions.length === 0) return
    try {
      const project = this.store.getProject(projectId)
      const budget = resolveWordBudget({ baseTarget: baseTargetOf(project?.targetWords) })
      this.store.supersedeActivePlans(chapter.id)
      const plan = this.store.createPlanRevision({
        chapterId: chapter.id,
        projectId,
        positioning: chapter.positioning ?? null,
        rhythm: null,
        budget,
      })
      const scenePlan = buildScenePlanFromSceneDefinitions({
        planRevisionId: plan.id,
        chapterId: chapter.id,
        projectId,
        sceneDefinitions,
        budget,
      })
      this.store.createSceneRevisions(plan, scenePlan.scenes)
      this.store.transitionPlan(plan.id, 'approved', 'draft')
      this.context.logger.info(
        { projectId, chapterNumber, planId: plan.id, sceneCount: sceneDefinitions.length },
        'T03: 群聊场景计划已影子写入 V2',
      )
    } catch (err) {
      this.context.logger.warn({ projectId, chapterNumber, err }, 'T03: 影子写入群聊 V2 计划失败，不影响主流程')
    }
  }

  /**
   * 构建群聊成员列表
   *
   * 4 个工种 Agent（director/writer/reviewer/reviser，不含 memory）
   * + 项目活跃角色（跳过 arcStage === 'resolved' 且无 currentGoal 的角色）
   *
   * ⚠️ 群聊模式必须注入 role 身份段（discussion=true）：
   * - Director 加载 role-director-discussion.md（含场景拆分格式，避免直接写正文）
   * - Writer 加载 role-writer-discussion.md（含剧本编织约束）
   * - 角色成员加载 role-character-actor.md（含剧本演出格式 [动作] "台词"）
   * 不注入会导致 Agent 不知道群聊职责，出现 Director 直接写正文、
   * 角色写小说叙述等问题（见 create-flow 无限回退 bug 的姊妹问题）。
   */
  private buildMembers(
    projectId: string,
    chapterNumber: number,
    arrangedEntities?: ArrangedEntity,
    boundary?: ChapterBoundaryContext,
    memberModel?: { provider: string; modelId: string },
    projectModel: { provider: string; modelId: string } | undefined = parseNovelModelRef(this.store.getNovelModelId(projectId)),
  ): DiscussionMember[] {
    const members: DiscussionMember[] = []

    // 4 个工种 Agent
    for (const agentType of DISCUSSION_AGENT_TYPES) {
      const config = NOVEL_AGENT_CONFIGS[agentType]
      // 从 AgentManager 读取该 Agent 在 AgentPage 配置的 model/temperature
      // （未配置 model 则走默认 Provider；temperature 读取 AgentManager.temperature）
      const agentConfig = this.context.subagentManager?.getAgent(config.id)
      // Skill 白名单接入：群聊角色方法由 novel-{role}-discussion Skill 提供；
      // 模板缺失（如 reviser 无 discussion 模板）或项目/SQLite 覆盖时回退旧身份。
      const discussionSkillPath = typeof this.promptBuilder.getDiscussionSkillPath === 'function'
        ? this.promptBuilder.getDiscussionSkillPath(agentType, projectId)
        : undefined
      // Reviewer 的最终验收走标准角色方法（novel-reviewer），与群聊审查身份不同
      const finalReviewSkillPath = agentType === 'reviewer'
        && typeof this.promptBuilder.getReviewerSkillPath === 'function'
        ? this.promptBuilder.getReviewerSkillPath(projectId)
        : undefined
      members.push({
        id: config.id,
        type: 'role',
        name: config.name,
        expertise: config.identity,
        canConverge: agentType === 'writer' || agentType === 'reviser',
        // system 只放项目级静态背景，4 个工种完全相同；成员身份作为第二条
        // prefix user message 注入。请求顺序为 system → shared → identity → task，
        // 因此 shared 末尾的 cache breakpoint 可跨工种命中。
        buildSystemPrompt: () => this.promptBuilder.buildSystemPrompt(projectId, agentType),
        buildIdentityPrompt: () => discussionSkillPath
          ? this.promptBuilder.buildDiscussionSkillIdentity(agentType, projectId)
          : this.promptBuilder.buildAgentIdentity(projectId, agentType, true),
        ...(discussionSkillPath
          ? { skill: { name: `novel-${agentType}-discussion`, path: discussionSkillPath } }
          : {}),
        buildFinalReviewSystemPrompt: agentType === 'reviewer'
          ? () => this.promptBuilder.buildSystemPrompt(projectId, agentType)
          : undefined,
        buildFinalReviewIdentityPrompt: agentType === 'reviewer'
          ? () => finalReviewSkillPath
            ? this.promptBuilder.buildReviewerSkillIdentity(projectId)
            : this.promptBuilder.buildAgentIdentity(projectId, agentType, false)
          : undefined,
        ...(finalReviewSkillPath
          ? { finalReviewSkill: { name: 'novel-reviewer', path: finalReviewSkillPath } }
          : {}),
        buildProseEditorIdentityPrompt: agentType === 'reviewer'
          ? () => this.promptBuilder.buildProseEditorIdentity(projectId)
          : undefined,
        // 工作流与群聊共用优先级：本次模型 > 项目创作主模型 > AgentPage 配置。
        modelId: memberModel ?? projectModel ?? agentConfig?.model,
        temperature: agentConfig?.temperature,
      })
    }

    // 有矩阵编排时只预加载本章角色，避免全部角色进入 Moderator 成员清单。
    // Director 临时引入的其他角色会在 resolveSceneCharacters 中按名动态补入。
    const boundaryCharacters = new Map((boundary?.entities.characters ?? this.store.listCharacters(projectId)).map((character) => [character.id, character]))
    const characterIds = arrangedEntities?.characterIds?.length
      ? arrangedEntities.characterIds
      : [...boundaryCharacters.keys()]
    const characters = characterIds
      .map((id) => resolveChapterBoundaryEntity(
        id,
        boundaryCharacters,
        entityId => this.store.getCharacter(entityId),
        boundary?.fromSnapshot ?? false,
      ))
      .filter((resolved): resolved is NonNullable<typeof resolved> => resolved != null)
    // 声音坐标必须按**全体出场角色**一次算出：分配逻辑保证同场角色的轴互不相同，
    // 逐个角色单独计算会让每个人都拿到"第一顺位"的那把嗓子，群聊里所有 NPC 同声。
    const voiceProfiles = new Map(
      buildVoiceProfiles(characters.map(({ entity }) => entity))
        .map((profile) => [profile.characterId, profile]),
    )
    for (const { entity: char, hasBoundaryState } of characters) {
      members.push(this.buildCharacterMember(
        projectId,
        chapterNumber,
        char,
        arrangedEntities,
        boundary,
        voiceProfiles.get(char.id),
        hasBoundaryState,
        memberModel,
        projectModel,
      ))
    }

    return members
  }

  /** 构建角色成员 */
  private buildCharacterMember(
    projectId: string,
    chapterNumber: number,
    char: NovelCharacter,
    arrangedEntities?: ArrangedEntity,
    boundary?: ChapterBoundaryContext,
    voiceProfile?: CharacterVoiceProfile,
    hasBoundaryState = true,
    memberModel?: { provider: string; modelId: string },
    projectModel: { provider: string; modelId: string } | undefined = parseNovelModelRef(this.store.getNovelModelId(projectId)),
  ): DiscussionMember {
    // Skill 白名单接入：单角色调用由 novel-character-actor Skill 提供演出方法；
    // 合并演出（多角色同一次调用）不走 Skill，必须内联完整模板身份。
    const actorSkillPath = typeof this.promptBuilder.getCharacterActorSkillPath === 'function'
      ? this.promptBuilder.getCharacterActorSkillPath(projectId)
      : undefined
    const actorIdentityBuilder = actorSkillPath
      ? (pid: string) => this.promptBuilder.buildCharacterActorSkillIdentity(pid)
      : undefined
    const baseIdentityInput = {
      projectId,
      character: char,
      promptBuilder: this.promptBuilder,
      mode: 'discussion' as const,
      voiceProfile,
      hasBoundaryState,
    }
    return {
      id: `char-${char.id}`,
      type: 'character',
      name: char.name,
      expertise: char.personality || char.identity || char.description,
      canConverge: false,
      modelId: memberModel ?? projectModel,
      ...(actorSkillPath
        ? { skill: { name: 'novel-character-actor', path: actorSkillPath } }
        : {}),
      characterProfile: {
        personality: char.personality,
        currentState: hasBoundaryState ? char.currentState : '',
        currentGoal: hasBoundaryState ? char.currentGoal : '',
        secret: hasBoundaryState ? char.secret : '',
        arcStage: hasBoundaryState ? char.arcStage : '',
        participatingConflicts: (boundary?.entities.edges ?? this.store.listEdgesByEntity(char.id, { edgeType: 'related' }))
          .filter(e => e.edgeType === 'related' && e.sourceType === 'character' && e.targetType === 'conflict' && e.sourceId === char.id)
          .map(e => e.targetId),
      },
      // 角色共用一个极小且稳定的 system；角色卡和演出职责放在 identity 前缀。
      // 角色不再读取工种的全知 shared context，而是只读取本人可见上下文。
      buildSystemPrompt: buildCharacterSystemPrompt,
      // 认知状态：供引擎判断哪些角色信息对称、可合并为一次调用。
      // 必须与 buildCharacterVisibleContext 的裁剪口径一致（见 collectCharacterKnowledge）。
      knowledge: collectCharacterKnowledge(this.store, projectId, char, boundary),
      // 合并调用会同时携带组内所有角色身份。身份里有显式隐藏秘密时，提示词
      // 约束不足以形成信息隔离，必须逐角色调用。
      allowMergedInvocation: !(hasBoundaryState && char.secret.trim().length > 0),
      buildContextPrompt: () => buildCharacterVisibleContext({
        store: this.store,
        projectId,
        chapterNumber,
        character: char,
        arrangedEntities,
        boundary,
      }),
      buildIdentityPrompt: () => buildCharacterIdentityPrompt({
        ...baseIdentityInput,
        actorIdentityBuilder,
      }),
      buildMergedActorIdentityPrompt: () => buildCharacterIdentityPrompt(baseIdentityInput),
    }
  }

  /** 为 Director 临时引入、但角色库尚未建档的人物创建本次运行使用的 Agent。 */
  private resolveCharacterMembers(
    projectId: string,
    chapterNumber: number,
    arrangedEntities: ArrangedEntity | undefined,
    boundary: ChapterBoundaryContext,
    characterNames: string[],
    memberModel?: { provider: string; modelId: string },
    projectModel: { provider: string; modelId: string } | undefined = parseNovelModelRef(this.store.getNovelModelId(projectId)),
  ): DiscussionMember[] {
    const existingCharacters = boundary.entities.characters
    const byName = new Map(
      existingCharacters.map(character => [this.normalizeCharacterName(character.name), {
        character,
        hasBoundaryState: true,
      }]),
    )
    for (const character of this.store.listCharacters(projectId)) {
      const normalizedName = this.normalizeCharacterName(character.name)
      if (!byName.has(normalizedName)) {
        byName.set(normalizedName, {
          character,
          hasBoundaryState: !boundary.fromSnapshot,
        })
      }
    }

    return characterNames.map((name) => {
      const existing = byName.get(this.normalizeCharacterName(name))
      if (existing) {
        return this.buildCharacterMember(
          projectId,
          chapterNumber,
          existing.character,
          arrangedEntities,
          boundary,
          undefined,
          existing.hasBoundaryState,
          memberModel,
          projectModel,
        )
      }

      const stableSuffix = Array.from(name)
        .map(char => char.codePointAt(0)?.toString(16) ?? '')
        .join('-')
      // Skill 白名单接入：临时角色与建档角色同口径（Skill 薄壳 + 合并身份内联模板）
      const actorSkillPath = typeof this.promptBuilder.getCharacterActorSkillPath === 'function'
        ? this.promptBuilder.getCharacterActorSkillPath(projectId)
        : undefined
      const actorIdentityBuilder = actorSkillPath
        ? (pid: string) => this.promptBuilder.buildCharacterActorSkillIdentity(pid)
        : undefined
      const actorRoleBody = (): string => actorIdentityBuilder
        ? this.promptBuilder.buildCharacterActorSkillIdentity(projectId)
        : this.promptBuilder.buildAgentIdentity(projectId, 'character-actor', true)
      const member: DiscussionMember = {
        id: `char-ephemeral-${stableSuffix}`,
        type: 'character',
        name: name.trim(),
        expertise: 'Director 在本章场景中临时引入的角色，尚无持久化角色卡',
        canConverge: false,
        modelId: memberModel ?? projectModel,
        ...(actorSkillPath
          ? { skill: { name: 'novel-character-actor', path: actorSkillPath } }
          : {}),
        characterProfile: {
          personality: '未指定',
          currentState: '按当前场景行动',
          currentGoal: '推进当前场景目标',
          secret: '',
          arcStage: '未指定',
          participatingConflicts: [],
        },
        buildSystemPrompt: buildCharacterSystemPrompt,
        buildContextPrompt: () => buildCharacterVisibleContext({
          store: this.store,
          projectId,
          chapterNumber,
          arrangedEntities,
          boundary,
        }),
        buildIdentityPrompt: () => [
          `你是小说中的临时角色「${name.trim()}」。当前角色库没有你的完整角色卡。`,
          '只依据 Director 给出的场景信息行动，不得自行虚构重大背景、秘密或世界设定。',
          '如果缺少决定行为所必需的信息，用最保守的方式回应。',
          '',
          actorRoleBody(),
        ].join('\n'),
      }
      // 合并演出身份：引擎优先取 buildMergedActorIdentityPrompt，回退 buildIdentityPrompt。
      // 临时角色身份本身已内联 actorRoleBody（薄壳），合并路径必须换回完整模板。
      member.buildMergedActorIdentityPrompt = () => [
        `你是小说中的临时角色「${name.trim()}」。当前角色库没有你的完整角色卡。`,
        '只依据 Director 给出的场景信息行动，不得自行虚构重大背景、秘密或世界设定。',
        '如果缺少决定行为所必需的信息，用最保守的方式回应。',
        '',
        this.promptBuilder.buildAgentIdentity(projectId, 'character-actor', true),
      ].join('\n')
      this.context.logger.warn(
        { projectId, characterName: name, memberId: member.id },
        'Director 引入了未建档角色，已创建本次群聊使用的临时角色 Agent',
      )
      return member
    })
  }

  private normalizeCharacterName(name: string): string {
    return name.normalize('NFKC').trim().toLocaleLowerCase()
  }

  /**
   * 构建默认叙事任务
   *
   * 群聊模式下 Director 在群聊中规划具体任务，此处仅提供初始占位。
   * 优先使用章节已存储的 narrativeTask（由创建章节时写入），
   * 让 formatChapterInfo 在 outline 为空时也能显示有意义的章纲。
   */
  private buildDefaultNarrativeTask(projectId: string, chapterNumber: number): NarrativeTask {
    const chapter = this.store.getChapter(projectId, chapterNumber)
    const storedTask = chapter?.narrativeTask?.trim()
    return {
      description: storedTask || `推进第 ${chapterNumber} 章主线剧情`,
      type: 'advance_mainline',
      targetEntity: null,
      priority: 'high',
    }
  }

}
