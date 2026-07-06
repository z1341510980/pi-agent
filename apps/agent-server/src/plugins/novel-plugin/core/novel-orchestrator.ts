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
 *   - revise/rewrite：当前实现中视为 approve 继续（可扩展）
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

import type { NovelStore } from './novel-store.js'
import type { NovelSessionFactory } from './novel-session.js'
import type { NovelPromptBuilder } from './prompt-builder.js'
import type { NovelEngine } from './novel-engine.js'
import type { PluginContext } from '../../../core/plugin/plugin-types.js'
import { runtimePerformance } from '../../../config/performance.js'
import { NOVEL_AGENT_CONFIGS, type NovelAgentType, type CreationPhase, type CheckpointData, type CreationFlowEvent, type AgentOutputData } from './novel-agents.js'
import type { NarrativeTask, NarrativeTaskType, ChapterConstraints, ArrangedEntity, NovelConflict, NovelForeshadow, NovelCharacterHistory, NovelFaction, NovelLocation, ChapterSpan, RhythmSuggestion } from './types.js'
import { RhythmController } from './rhythm-controller.js'
import { NovelMemoryStore, type MemoryEvent } from './novel-memory-store.js'
import type { NovelMemoryGenerator } from './novel-memory-generator.js'
import type { NovelAgentConfigStore } from './novel-agent-config-store.js'
import type { NovelAgentLogStatus } from './types.js'
import type { AgUiEventSink } from '@repo/protocol/events'

/**
 * 合并章节号到跨度数组：连续则扩展尾段，否则追加新段；保持 spans 有序。
 * - 空数组 → [[chapter, chapter]]
 * - 尾段 end+1 === chapter → 扩展尾段 end 为 chapter
 * - chapter 已被尾段覆盖（chapter <= lastEnd）→ 不变（去重）
 * - 否则 → 追加 [chapter, chapter]
 * 返回新数组，不修改入参。
 */
function appendChapterToSpans(spans: ChapterSpan[], chapter: number): ChapterSpan[] {
  if (spans.length === 0) {
    return [[chapter, chapter]]
  }
  const next = spans.map((s) => [s[0], s[1]] as ChapterSpan)
  const last = next[next.length - 1]
  if (chapter <= last[1]) {
    return next
  }
  if (last[1] + 1 === chapter) {
    last[1] = chapter
    return next
  }
  next.push([chapter, chapter])
  return next
}

export interface CreationOptions {
  /** AG-UI 事件发射器（与 chat 共用同一类型），供 StreamEmitter 发射标准 AG-UI 事件 */
  emit: AgUiEventSink
  onCheckpoint: (checkpoint: CheckpointData) => Promise<'approve' | 'reject' | 'revise' | 'rewrite'>
  onProgress: (event: CreationFlowEvent) => void
  signal?: AbortSignal
  /** 本章已编排实体约束（模式1手动编排 / 模式2 AI编排产出），注入 SEMI 层 */
  arrangedEntities?: ArrangedEntity
}

export interface CreationResult {
  status: 'completed' | 'cancelled' | 'error'
  chapterId?: string
  content?: string
  stateChanges?: Array<{ type: string; description: string }>
  error?: string
}

export class NovelOrchestrator {
  /** 用户在检查点期间发送的创作指令（供下一个 Agent 使用后清空） */
  private userMessages: string[] = []
  /** 本章已编排实体约束（由 createChapterWithFlow 设置，runAgent 读取后清空） */
  private currentArrangedEntities?: ArrangedEntity
  /** Director 的实时输出（方案 A：让 Director 规划真正注入 Writer）
   *  Director 完成并经检查点确认后暂存，runAgent 构建 Writer 的 SEMI 层 chapter-instruction
   *  模板时用作 {{narrative_task}}，替代原来的章纲字段，让 Writer 真正基于导演规划创作。
   *  流程结束（含 rewrite 递归返回后）清空。
   *
   *  包含两个字段：
   *  - outputText: Director 的完整规划文本（用于注入 {{narrative_task}} 占位符）
   *  - task: 从 Director 输出中解析的结构化 NarrativeTask（含 type/priority/climaxTarget 等）
   *         让 14 种 NarrativeTaskType（create_suspense/create_reversal 等）真正传递到下游
   */
  private currentDirectorOutput?: string
  private currentDirectorTask?: NarrativeTask
  /** 本章节奏建议（由 createChapterWithFlow 计算，runAgent 构建约束时注入 rhythmConstraint） */
  private currentRhythmSuggestion?: RhythmSuggestion
  /** 小说角色温度配置存储（runAgent 中按角色合并温度） */
  private readonly agentConfigStore: NovelAgentConfigStore
  /** 记忆 Agent 生成器（结构化 LLM 调用，替代原工具循环模式） */
  private readonly memoryGenerator?: NovelMemoryGenerator
  /**
   * 单章 SEMI 层前缀缓存（projectId|chapterNumber → prefixUserMessage 字符串）
   *
   * 用于在 director→writer→reviewer 三次调用之间复用同一份 buildChapterContext 输出：
   * - 这三个 Agent 都只读 query_* 工具，不会修改故事状态，SEMI 字符串完全一致
   * - 复用字符串可：1) 节省重复构建开销 2) 确保 LLM provider 端能命中 director 写入的缓存条目
   *
   * 失效场景：检查点 reject / rewrite 后重新进入 createChapterWithFlow 时清空；
   * Memory Agent 走 runMemoryAgent 不经过此缓存。
   */
  private semiLayerCache: { key: string; value: string } | null = null

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
  }

  /**
   * 设置用户在检查点期间发送的创作指令
   * 这些指令会在下一个 Agent 执行时附加到其输入中，随后清空
   */
  setUserMessages(messages: string[]): void {
    this.userMessages = messages.slice()
  }

  async createChapterWithFlow(
    projectId: string,
    chapterNumber: number,
    options: CreationOptions,
  ): Promise<CreationResult> {
    // 将本章编排实体约束暂存到实例字段，供 runAgent 构建 SEMI 层时读取。
    // 采用临时字段方案是最小改动：无需改 runAgent 签名，也无需沿调用链透传。
    this.currentArrangedEntities = options.arrangedEntities
    // 清空单章 SEMI 缓存：每次进入 createChapterWithFlow（含 rewrite 递归）都重新构建，
    // 避免上一章/上一次创作的 SEMI 字符串残留导致 LLM 缓存条目错配。
    this.semiLayerCache = null
    try {
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
      this.currentRhythmSuggestion = rhythmSuggestion

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

      // Phase 1: Director
      this.emitProgress(options, 'directing', 'phase_change', { message: '导演 Agent 正在分析故事状态...' })
      // input 统一为字符串：避免 runAgent JSON.stringify 对象导致 LLM 收到 JSON 字符串
      const directorResult = await this.runAgent('director', projectId, chapterNumber,
        `请分析当前故事状态，为第 ${chapterNumber} 章规划叙事任务。\n\n---\n\n## 节奏建议\n\n${JSON.stringify(rhythmSuggestion, null, 2)}`,
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

      // 暂存 Director 的实时输出：runAgent 构建 Writer 的 SEMI 层时，会将其注入
      // chapter-instruction 模板的 {{narrative_task}}，替代原来的章纲字段。
      // 这是方案 A 的核心：让 Director 的规划真正成为 Writer 的创作指导。
      this.currentDirectorOutput = directorResult
      // 解析 Director 输出为结构化 NarrativeTask，让 14 种任务类型真正传递到 Writer。
      // Director 提示词要求输出"任务类型"字段（如 create_suspense/escalate_conflict），
      // parseDirectorTask 从输出文本中提取任务类型、优先级、高潮目标等执行参数。
      this.currentDirectorTask = this.parseDirectorTask(directorResult, rhythmSuggestion)

      // 推送叙事任务详情，让用户了解 Director 解析出的结构化任务（气泡展示）
      this.emitProgress(options, 'directing', 'phase_change', {
        message: '叙事任务已解析',
        detail: {
          kind: 'narrative_task',
          taskType: this.currentDirectorTask.type,
          priority: this.currentDirectorTask.priority,
          targetEntity: this.currentDirectorTask.targetEntity,
          climaxTarget: this.currentDirectorTask.climaxTarget,
          suspenseDuration: this.currentDirectorTask.suspenseDuration,
          expectedIntensityDelta: this.currentDirectorTask.expectedIntensityDelta,
        },
      })

      // Phase 2: Writer
      this.emitProgress(options, 'writing', 'phase_change', { message: '写作 Agent 正在创作章节正文...' })
      // input 统一为字符串：避免 runAgent JSON.stringify 对象导致 LLM 收到 JSON 字符串
      const writerResult = await this.runAgent('writer', projectId, chapterNumber,
        `请根据上方"本章叙事任务"中的导演规划，创作第 ${chapterNumber} 章正文。`,
        options,
      )

      // Phase 3: Reviewer
      this.emitProgress(options, 'reviewing', 'phase_change', { message: '审稿 Agent 正在检查章节...' })
      // ⚠️ 不能传 JSON 对象 { task, content }：runAgent 会 JSON.stringify 它，
      // 导致 Writer 输出的正文被压缩在 JSON 的 content 字段中（换行变 \n、引号被转义），
      // LLM 需要解析 JSON 才能提取正文，不同模型解析能力不同，行为不稳定。
      // 改为结构化 Markdown 字符串：明确的标题分隔，让 LLM 直接看到正文。
      const reviewResult = await this.runAgent('reviewer', projectId, chapterNumber,
        `请验收第 ${chapterNumber} 章的内容。\n\n---\n\n## 待审稿章节正文\n\n${writerResult}`,
        options,
      )

      // 检查点 2
      this.emitProgress(options, 'checkpoint_review', 'phase_change', { message: '等待用户确认验收报告...' })
      const reviewDecision = await options.onCheckpoint({
        type: 'review',
        phase: 'checkpoint_review',
        data: reviewResult,
      })

      let finalContent = writerResult

      if (reviewDecision === 'revise') {
        this.emitProgress(options, 'revising', 'phase_change', { message: '写作 Agent 正在根据审稿意见修订章节...' })
        // ⚠️ 同 Reviewer：不能传 JSON 对象，改为结构化 Markdown 字符串
        const reviseResult = await this.runAgent('writer', projectId, chapterNumber,
          `请根据审稿意见修订第 ${chapterNumber} 章的局部内容。\n\n---\n\n## 原章节正文\n\n${writerResult}\n\n---\n\n## 审稿意见\n\n${reviewResult}`,
          options,
          {
            phase: 'revising',
            displayAgentType: 'reviser',
            displayAgentName: '修订',
          },
        )
        finalContent = reviseResult
      } else if (reviewDecision === 'rewrite') {
        this.emitProgress(options, 'rewriting', 'phase_change', { message: '重新创作章节...' })
        return this.createChapterWithFlow(projectId, chapterNumber, options)
      }

      // Phase 5: Memory
      // 在 Memory Agent 执行前捕获实体状态快照，执行后比较差异并记录记忆事件
      this.emitProgress(options, 'memory', 'phase_change', { message: '记忆 Agent 正在提取状态变更...' })
      const beforeState = this.captureEntityState(projectId)
      const memoryResult = await this.runMemoryAgent(
        projectId, chapterNumber, finalContent, options,
      )
      const chapter = this.store.getChapter(projectId, chapterNumber)
      const memoryEvents = this.recordMemoryEvents(
        projectId,
        chapterNumber,
        chapter?.id ?? null,
        beforeState,
      )

      // 同步本章涉及实体的章节维度字段（firstChapter/lastChapter/characterHistory）
      // 解决 Memory Agent 只改动态状态、不写章节维度导致的矩阵视图滞后问题
      this.syncChapterDimensions(
        projectId,
        chapterNumber,
        chapter?.id ?? null,
        options.arrangedEntities,
        beforeState,
      )

      // 章节完成时保存全量状态快照（情景记忆）
      this.saveChapterSnapshot(projectId, chapterNumber)

      // 推送数据变更通知：Memory Agent 已写入实体状态、快照已保存，
      // 前端收到后刷新画布（替代轮询）。同时携带提取摘要和变更明细供气泡展示。
      this.emitProgress(options, 'memory', 'data_changed', {
        agentType: 'memory',
        agentName: '记忆',
        message: '记忆提取完成',
        dataChanged: true,
        detail: {
          kind: 'memory_result',
          summary: memoryResult,
          events: memoryEvents.map(e => ({ type: e.eventType, description: e.description })),
        },
      })

      // 自动保存章节内容到数据库（创作完成后立即持久化，无需用户手动点击"保存到章节"）
      if (chapter) {
        this.store.updateChapter(chapter.id, {
          content: finalContent,
          status: 'review',
          wordCount: finalContent.length,
        })
      }

      this.emitProgress(options, 'completed', 'completed', { message: '章节创作完成' })

      return {
        status: 'completed',
        content: finalContent,
        stateChanges: [
          { type: 'memory', description: memoryResult.slice(0, 200) },
          ...memoryEvents.map((e) => ({
            type: e.eventType,
            description: e.description,
          })),
        ],
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emitProgress(options, 'error', 'error', { message })
      return { status: 'error', error: message }
    } finally {
      // 流程结束（含 rewrite 递归返回后）清理编排约束和 Director 输出，避免泄漏到下一次创作
      this.currentArrangedEntities = undefined
      this.currentDirectorOutput = undefined
      this.currentDirectorTask = undefined
      this.currentRhythmSuggestion = undefined
    }
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
    },
  ): Promise<string> {
    const config = NOVEL_AGENT_CONFIGS[agentType]
    // agentType → 阶段映射（config 无 phase 字段，这里显式维护）
    const phaseMap: Record<NovelAgentType, CreationPhase> = {
      director: 'directing',
      writer: 'writing',
      reviewer: 'reviewing',
      memory: 'memory',
    }
    const phase = overrides?.phase ?? phaseMap[agentType]
    const displayAgentType = overrides?.displayAgentType ?? agentType
    const displayAgentName = overrides?.displayAgentName ?? config.name

    let inputText = typeof input === 'string' ? input : JSON.stringify(input)
    // 保存原始任务输入（用于日志记录），再附加用户指令
    const taskInputForLog = inputText

    // 附加用户在检查点期间发送的创作指令（消费后清空）
    // 保留副本用于日志记录
    const userInstructionsForLog = this.userMessages.slice()
    if (this.userMessages.length > 0) {
      const userInstructions = this.userMessages.map((m, i) => `${i + 1}. ${m}`).join('\n')
      inputText += `\n\n## 用户创作指令\n用户在创作过程中提出以下指令，请在创作中予以考虑：\n${userInstructions}`
      this.userMessages = []
    }

    // STATIC 层：系统提示词（Agent 身份 + 世界规则 + 风格 + 角色定义）
    const systemPrompt = this.promptBuilder.buildSystemPrompt(projectId, agentType)

    // SEMI 层：章节上下文（作为首条 user 消息的前缀，单章内不变）
    // 单章内 director→writer→reviewer 三次调用之间，故事状态未被修改（这三个 Agent
    // 只读 query_* 工具），因此 chapterContext 字符串稳定。缓存按 agentType 分桶：
    // writer 因 buildChapterContext 内部注入 chapter-instruction 与其他 Agent 不同，
    // 需独立缓存；director/reviewer 共享同一份（buildChapterContext 内部 if 只判断 writer）。
    // 复用字符串可：1) 节省 formatStoryState 等遍历实体的计算开销
    //              2) 确保字符串稳定，让 LLM provider 端能命中 director 写入的缓存条目
    const chapter = this.store.getChapter(projectId, chapterNumber)
    const cacheKey = `${projectId}|${chapterNumber}|${agentType}`
    let chapterContext: string
    if (this.semiLayerCache && this.semiLayerCache.key === cacheKey) {
      chapterContext = this.semiLayerCache.value
      this.context.logger.debug(
        { agentType, projectId, chapterNumber, contextLength: chapterContext.length },
        'SEMI 层前缀命中单章缓存',
      )
    } else {
      // ⚠️ Token 优化：Reviewer 使用精简版 buildReviewContext，只包含章节信息 +
      // 创作约束 + 本章编排实体，不注入完整故事状态/实体关联/信息差/摘要/因果链。
      // Writer 全文已通过 user_message 注入，Reviewer 不需要这些上下文。
      // 预期节省 ~6K 字符 / 5K tokens。
      if (agentType === 'reviewer') {
        const narrativeTask: NarrativeTask = {
          description: chapter?.narrativeTask ?? `第 ${chapterNumber} 章创作`,
          type: 'advance_mainline',
          targetEntity: null,
          priority: 'medium',
        }
        const constraints: ChapterConstraints = this.engine.buildChapterConstraints(
          projectId, chapterNumber, this.currentRhythmSuggestion,
        )
        chapterContext = this.promptBuilder.buildReviewContext(
          projectId,
          chapterNumber,
          narrativeTask,
          constraints,
          this.currentArrangedEntities,
        )
        this.semiLayerCache = { key: cacheKey, value: chapterContext }
        this.context.logger.debug(
          { agentType, projectId, chapterNumber, contextLength: chapterContext.length },
          'Reviewer 使用精简版 SEMI 层（buildReviewContext）',
        )
      } else {
      // ⚠️ 缓存关键：所有 Agent 的 narrativeTask 统一用数据库章纲，确保 SEMI 层前缀
      // （章节信息 + 约束 + 故事状态 + ...）跨 Agent 完全一致，最大化 LLM provider
      // 端的 prompt cache 命中率。
      //
      // Director 的实时输出（this.currentDirectorTask）只通过 buildChapterContext
      // 的 directorOutput 参数注入到 SEMI 层末尾的 chapter-instruction 模板，
      // 不影响前缀缓存匹配。
      //
      // 历史背景：b4f720b 改动让 Writer 的 narrativeTask 直接用 Director 实时输出，
      // 导致 formatChapterInfo 对 Writer 用摘要、对其他 Agent 用完整描述，
      // SEMI 层第一段就分叉，跨 Agent 缓存全 miss。现已回退。
      const narrativeTask: NarrativeTask = {
        description: chapter?.narrativeTask ?? `第 ${chapterNumber} 章创作`,
        type: 'advance_mainline',
        targetEntity: null,
        priority: 'medium',
      }
      const constraints: ChapterConstraints = this.engine.buildChapterConstraints(
        projectId, chapterNumber, this.currentRhythmSuggestion,
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
          },
        })
      }
      chapterContext = this.promptBuilder.buildChapterContext(
        projectId,
        chapterNumber,
        narrativeTask,
        constraints,
        this.currentArrangedEntities,
        agentType,
        // directorOutput：Director 的实时输出，仅 Writer 的 chapter-instruction
        // 模板会渲染它（在 SEMI 层末尾，不破坏前缀缓存）。其他 Agent 传入但不会被使用。
        this.currentDirectorTask?.description,
      )
      this.semiLayerCache = { key: cacheKey, value: chapterContext }
      this.context.logger.debug(
        { agentType, projectId, chapterNumber, contextLength: chapterContext.length },
        'SEMI 层前缀已写入单章缓存',
      )
      }
    }

    // DYNAMIC 层：Agent 任务指令（每次调用不同）
    // 章节上下文（SEMI 层）通过 prefixUserMessage 独立注入，不与任务拼接，
    // 确保 SEMI 层前缀跨 Agent 稳定，可被 prompt cache 命中。
    const userMessage = inputText

    // 按 Agent 类型过滤工具权限
    const allNovelTools = this.sessionFactory.getNovelTools()
    const allowedToolNames = config.tools
    const filteredTools = allNovelTools.filter(t => allowedToolNames.includes(t.name))
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
        prefixUserMessageLength: chapterContext.length,
        prefixUserMessagePreview: chapterContext.slice(0, 500),
        userMessageLength: userMessage.length,
        userMessagePreview: userMessage.slice(0, 500),
        toolsCount: filteredTools.length,
        toolNames: toolNamesForLog,
      },
      'Agent 提示词构建完成',
    )

    // 推送准备阶段进度，让前端知道 Agent 正在工作（不等 LLM 首 token）
    const totalInputChars = systemPrompt.length + chapterContext.length + userMessage.length
    this.emitProgress(options, phase, 'phase_change', {
      message: `${displayAgentName} 正在准备调用 LLM（输入约 ${totalInputChars} 字符）...`,
    })

    // 创建独立 Session 并调用 LLM
    const startTime = Date.now()
    // 合并温度：持久化覆盖 > 角色默认值（NOVEL_AGENT_CONFIGS）
    const temperature = this.agentConfigStore.getByType(agentType)

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

    // 通过底座工厂创建 AG-UI Session：封装 StreamEmitter + ReasoningPipeline + 订阅连接
    // 插件不再自己 new 这些基础设施层实例，真正"依托 chat 底座能力"
    // 首 token 检测下沉到工厂：通过 onFirstText 回调通知前端"开始生成"
    const agUiSession = await this.context.createAgUiSession({
      systemPrompt,
      prefixUserMessage: chapterContext,
      userMessage,
      tools: filteredTools,
      signal: options?.signal,
      temperature,
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

    // 在 try/catch/finally 中捕获结果与错误，finally 持久化到日志表
    let logStatus: NovelAgentLogStatus = 'success'
    let logError = ''
    let logResult = ''
    try {
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

      let result: string
      try {
        // 使用 prompt() 而非 promptStream()：StreamEmitter 已由工厂订阅
        // 实时发射 TEXT_MESSAGE_CONTENT 增量事件，prompt() 只负责触发 LLM 调用。
        // 首 token 检测由 createAgUiSession 工厂的 onFirstText 回调完成（见上方调用）。
        result = await session.prompt()
        streamEmitter.finishTextMessage()
      } finally {
        clearInterval(heartbeatTimer)
        // 不再需要 heartbeatUnsubscribe()：首 token 检测已下沉到 createAgUiSession 工厂，
        // 工厂内部 subscribe 在 dispose 时统一清理
      }

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
      agUiSession.dispose()

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
          chapterContext,
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
          sessionId: '',
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
            threadId: '',
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
        } catch {
          // 通用日志写入失败不影响主流程
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 长期记忆：实体状态捕获 + 记忆事件记录
  // ═══════════════════════════════════════════════════════════════

  /**
   * 运行 Memory Agent
   *
   * 优先使用 NovelMemoryGenerator（结构化 LLM 调用，单次完成，~30s），
   * 回退到原 runAgent('memory', ...)（LLM 工具循环，300s 超时）。
   *
   * 回退场景：memoryGenerator 未注入（旧版本兼容或测试环境）。
   * 回退时仍走原工具循环模式，记录日志并保持流程完整。
   */
  private async runMemoryAgent(
    projectId: string,
    chapterNumber: number,
    chapterContent: string,
    options: CreationOptions,
  ): Promise<string> {
    // 优先使用结构化 LLM 调用模式
    if (this.memoryGenerator) {
      const startTime = Date.now()
      let status: 'success' | 'error' = 'success'
      let errorMsg: string | undefined
      let resultSummary = ''
      try {
        const result = await this.memoryGenerator.generate(
          projectId, chapterNumber, chapterContent,
          (event) => {
            this.emitProgress(options, 'memory', 'phase_change', {
              message: event.message,
              phase: event.phase,
              data: event.data,
            })
          },
        )
        resultSummary = result.summary
        return result.summary
      } catch (err) {
        status = 'error'
        errorMsg = err instanceof Error ? err.message : String(err)
        this.context.logger.error(
          { projectId, chapterNumber, err },
          'Memory Generator 调用失败，回退到空结果',
        )
        // 不再回退到工具循环（容易 300s 超时），直接返回空结果让流程继续
        resultSummary = '记忆提取失败，未应用状态变更'
        return resultSummary
      } finally {
        const durationMs = Date.now() - startTime

        // 持久化领域层日志
        try {
          this.store.insertAgentLog({
            projectId,
            chapterNumber,
            agentType: 'memory',
            agentName: '记忆',
            displayAgentType: 'memory',
            displayAgentName: '记忆',
            phase: 'memory',
            systemPrompt: '(结构化 LLM 调用 - role-memory-generator)',
            chapterContext: '',
            userMessage: `请从第 ${chapterNumber} 章中提取状态变更。`,
            taskInput: chapterContent.slice(0, 500),
            userInstructions: [],
            tools: [],
            toolNames: [],
            result: resultSummary,
            resultLength: resultSummary.length,
            durationMs,
            status,
            error: errorMsg ?? '',
            sessionId: '',
          })
        } catch {
          // 日志写入失败不影响主流程
        }

        // 同步写入通用 agent_call_logs
        if (this.context.agentCallLogger) {
          try {
            this.context.agentCallLogger.record({
              agentId: 'novel-memory',
              agentName: '记忆',
              threadId: '',
              systemPrompt: '(结构化 LLM 调用 - role-memory-generator)',
              userMessage: `请从第 ${chapterNumber} 章中提取状态变更。`,
              taskInput: chapterContent.slice(0, 500),
              tools: '[]',
              toolNames: '[]',
              result: resultSummary,
              resultLength: resultSummary.length,
              durationMs,
              status: status === 'success' ? 'success' : 'error',
              error: errorMsg ?? '',
              metadata: JSON.stringify({
                projectId,
                chapterNumber,
                agentType: 'memory',
                phase: 'memory',
                displayAgentType: 'memory',
                displayAgentName: '记忆',
                source: 'novel-memory-generator',
              }),
            })
          } catch {
            // 通用日志写入失败不影响主流程
          }
        }
      }
    }

    // 回退：原 LLM 工具循环模式（仅当 memoryGenerator 未注入时）
    this.context.logger.warn(
      { projectId, chapterNumber },
      'memoryGenerator 未注入，回退到 LLM 工具循环模式（可能 300s 超时）',
    )
    return this.runAgent('memory', projectId, chapterNumber, {
      task: `请从第 ${chapterNumber} 章中提取状态变更。`,
      content: chapterContent,
    }, options)
  }



  /**
   * 捕获项目当前实体状态（角色 / 冲突 / 伏笔 / 势力 / 地点 / 关系）
   * 返回按实体 ID 索引的 Map，用于 Memory Agent 执行前后差异比较
   *
   * 关系层（四层逻辑②）跟踪字段：
   * - currentStage / dynamicRole / alignment / trend / chapterHint / lastUpdatedChapter
   * - 任意字段变化都会触发 relationship_change 记忆事件
   *
   * 影响层（四层逻辑④）跟踪字段：
   * - character.participatingConflicts（由冲突 CRUD 自动同步的反向索引）
   * - 变化时记录"角色参与冲突变更"事件，让用户知道哪些冲突线被接入/切断
   */
  private captureEntityState(projectId: string): {
    characters: Map<string, { name: string; currentState: string; currentGoal: string; currentPressure: string; secret: string; arcStage: string; longTermDesire: string; removalImpact: string; participatingConflicts: string[] }>
    conflicts: Map<string, { description: string; stage: string; intensity: number; plotFunction: string | undefined; progressionMode: string | undefined }>
    foreshadowing: Map<string, { description: string; status: string; firstChapter: number | null; lastChapter: number | null; plantMethod: string | undefined; recoverMethod: string | undefined; linkedInfoLayers: string[] }>
    factions: Map<string, { name: string; status: string; strength: string }>
    locations: Map<string, { name: string; status: string; appearChapters: number[] }>
    relationships: Map<string, { characterA: string; characterB: string; relationType: string; currentStage: string; dynamicRole: string; alignment: string; trend: string; chapterHint: string; lastUpdatedChapter: number | null }>
    infoLayers: Map<string, { infoDescription: string; readerKnows: boolean; isRevealed: boolean; revealChapter: number | null; linkedForeshadows: string[] }>
  } {
    const characters = new Map(
      this.store.listCharacters(projectId).map((c) => [
        c.id,
        {
          name: c.name,
          currentState: c.currentState,
          currentGoal: c.currentGoal,
          currentPressure: c.currentPressure,
          secret: c.secret,
          arcStage: c.arcStage,
          longTermDesire: c.longTermDesire,
          removalImpact: c.removalImpact,
          // 反向索引同步由 store 维护，这里只读快照用于差异比较
          participatingConflicts: this.parseIdList(c.participatingConflicts),
        },
      ]),
    )
    const conflicts = new Map(
      this.store.listConflicts(projectId).map((c) => [
        c.id,
        {
          description: c.description,
          stage: c.stage,
          intensity: c.intensity,
          plotFunction: c.plotFunction,
          progressionMode: c.progressionMode,
        },
      ]),
    )
    const foreshadowing = new Map(
      this.store.listForeshadowing(projectId).map((f) => [
        f.id,
        {
          description: f.description,
          status: f.status,
          firstChapter: f.firstChapter,
          lastChapter: f.lastChapter,
          plantMethod: f.plantMethod,
          recoverMethod: f.recoverMethod,
          // P3-2：跟踪 linkedInfoLayers 变化（用于 Rule 4 关联 info_layer_change）
          linkedInfoLayers: this.parseIdList(f.linkedInfoLayers),
        },
      ]),
    )
    const factions = new Map(
      this.store.listFactions(projectId).map((f) => [
        f.id,
        { name: f.name, status: f.status, strength: f.strength },
      ]),
    )
    const locations = new Map(
      this.store.listLocations(projectId).map((l) => [
        l.id,
        { name: l.name, status: l.status, appearChapters: l.appearChapters ? [...l.appearChapters] : [] },
      ]),
    )
    const relationships = new Map(
      this.store.listRelationships(projectId).map((r) => [
        r.id,
        {
          characterA: r.characterA,
          characterB: r.characterB,
          relationType: r.relationType,
          currentStage: r.currentStage,
          dynamicRole: r.dynamicRole,
          alignment: r.alignment,
          trend: r.trend,
          chapterHint: r.chapterHint,
          lastUpdatedChapter: r.lastUpdatedChapter,
        },
      ]),
    )
    // P3-2：捕获信息差状态用于差异比较
    const infoLayers = new Map(
      this.store.listInformationLayers(projectId).map((l) => [
        l.id,
        {
          infoDescription: l.infoDescription,
          readerKnows: l.readerKnows,
          isRevealed: l.isRevealed,
          revealChapter: l.revealChapter,
          linkedForeshadows: this.parseIdList(l.linkedForeshadows),
        },
      ]),
    )
    return { characters, conflicts, foreshadowing, factions, locations, relationships, infoLayers }
  }

  /** 容错解析 JSON: string[]，避免非 JSON / 旧数据格式导致 captureEntityState 抛错 */
  private parseIdList(raw: string): string[] {
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }

  /**
   * 比较 Memory Agent 执行前后的实体状态，记录记忆事件
   * - 角色状态变更 → character_change 事件
   * - 冲突阶段变更 → conflict_change 事件
   * - 伏笔状态变更 → foreshadow_change 事件
   */
  private recordMemoryEvents(
    projectId: string,
    chapterNumber: number,
    chapterId: string | null,
    before: ReturnType<NovelOrchestrator['captureEntityState']>,
  ): MemoryEvent[] {
    const events: MemoryEvent[] = []
    const after = this.captureEntityState(projectId)

    // ── 角色变更 ──
    const characterFields = ['currentState', 'currentGoal', 'currentPressure', 'secret', 'arcStage', 'longTermDesire', 'removalImpact'] as const
    for (const [id, afterChar] of after.characters) {
      const beforeChar = before.characters.get(id)
      if (!beforeChar) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'character_change',
          entityId: id, entityType: 'character',
          description: `角色创建: ${afterChar.name}`,
          oldValue: null,
          newValue: JSON.stringify({ name: afterChar.name, arcStage: afterChar.arcStage }),
          cause: null, effectIds: [], significance: 7,
        }))
        continue
      }
      for (const field of characterFields) {
        if (beforeChar[field] !== afterChar[field]) {
          events.push(this.memoryStore.recordEvent({
            projectId, chapterId, chapterNumber,
            eventType: 'character_change',
            entityId: id, entityType: 'character',
            description: `角色 ${afterChar.name} 的 ${field} 变更`,
            oldValue: JSON.stringify({ [field]: beforeChar[field] }),
            newValue: JSON.stringify({ [field]: afterChar[field] }),
            cause: null, effectIds: [], significance: 6,
          }))
        }
      }
      // ── 四层逻辑④：参与冲突线变更（角色端反向索引）──
      // 当 syncConflictParticipantsToCharacters 在 store 层自动同步时，
      // 这里捕获快照差异，让用户感知"角色接入了 X 冲突 / 切断了 Y 冲突"。
      const beforeConflicts = beforeChar.participatingConflicts
      const afterConflicts = afterChar.participatingConflicts
      const addedConflicts = afterConflicts.filter((cid) => !beforeConflicts.includes(cid))
      const removedConflicts = beforeConflicts.filter((cid) => !afterConflicts.includes(cid))
      if (addedConflicts.length > 0 || removedConflicts.length > 0) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'character_change',
          entityId: id, entityType: 'character',
          description: `角色 ${afterChar.name} 参与冲突变更（新增 ${addedConflicts.length} 条，切断 ${removedConflicts.length} 条）`,
          oldValue: JSON.stringify({ participatingConflicts: beforeConflicts }),
          newValue: JSON.stringify({ participatingConflicts: afterConflicts }),
          cause: null, effectIds: [], significance: 6,
        }))
      }
    }

    // ── 冲突变更 ──
    for (const [id, afterConflict] of after.conflicts) {
      const beforeConflict = before.conflicts.get(id)
      if (!beforeConflict) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'conflict_change',
          entityId: id, entityType: 'conflict',
          description: `冲突创建: ${afterConflict.description}`,
          oldValue: null,
          newValue: JSON.stringify({ stage: afterConflict.stage, intensity: afterConflict.intensity, plotFunction: afterConflict.plotFunction, progressionMode: afterConflict.progressionMode }),
          cause: null, effectIds: [], significance: 7,
        }))
        continue
      }
      if (beforeConflict.stage !== afterConflict.stage) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'conflict_change',
          entityId: id, entityType: 'conflict',
          description: `冲突阶段变更: ${afterConflict.description}（${beforeConflict.stage} → ${afterConflict.stage}）`,
          oldValue: JSON.stringify({ stage: beforeConflict.stage, intensity: beforeConflict.intensity }),
          newValue: JSON.stringify({ stage: afterConflict.stage, intensity: afterConflict.intensity }),
          cause: null, effectIds: [], significance: 7,
        }))
      } else if (beforeConflict.intensity !== afterConflict.intensity) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'conflict_change',
          entityId: id, entityType: 'conflict',
          description: `冲突强度变更: ${afterConflict.description}（${beforeConflict.intensity} → ${afterConflict.intensity}）`,
          oldValue: JSON.stringify({ intensity: beforeConflict.intensity }),
          newValue: JSON.stringify({ intensity: afterConflict.intensity }),
          cause: null, effectIds: [], significance: 5,
        }))
      }
      // ── P2-1：功能位变更事件 ──
      if (beforeConflict.plotFunction !== afterConflict.plotFunction) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'conflict_change',
          entityId: id, entityType: 'conflict',
          description: `冲突功能位变更: ${afterConflict.description}（${beforeConflict.plotFunction ?? '(未指定)'} → ${afterConflict.plotFunction ?? '(未指定)'}）`,
          oldValue: JSON.stringify({ plotFunction: beforeConflict.plotFunction }),
          newValue: JSON.stringify({ plotFunction: afterConflict.plotFunction }),
          cause: null, effectIds: [], significance: 6,
        }))
      }
      // ── P2-1：推进模式变更事件 ──
      if (beforeConflict.progressionMode !== afterConflict.progressionMode) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'conflict_change',
          entityId: id, entityType: 'conflict',
          description: `冲突推进模式变更: ${afterConflict.description}（${beforeConflict.progressionMode ?? 'linear'} → ${afterConflict.progressionMode ?? 'linear'}）`,
          oldValue: JSON.stringify({ progressionMode: beforeConflict.progressionMode }),
          newValue: JSON.stringify({ progressionMode: afterConflict.progressionMode }),
          cause: null, effectIds: [], significance: 6,
        }))
      }
    }

    // ── 伏笔变更 ──
    for (const [id, afterF] of after.foreshadowing) {
      const beforeF = before.foreshadowing.get(id)
      if (!beforeF) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'foreshadow_change',
          entityId: id, entityType: 'foreshadow',
          description: `伏笔创建: ${afterF.description}`,
          oldValue: null,
          newValue: JSON.stringify({ status: afterF.status, plantMethod: afterF.plantMethod, recoverMethod: afterF.recoverMethod }),
          cause: null, effectIds: [], significance: 7,
        }))
        continue
      }
      if (beforeF.status !== afterF.status) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'foreshadow_change',
          entityId: id, entityType: 'foreshadow',
          description: `伏笔状态变更: ${afterF.description}（${beforeF.status} → ${afterF.status}）`,
          oldValue: JSON.stringify({ status: beforeF.status }),
          newValue: JSON.stringify({ status: afterF.status }),
          cause: null, effectIds: [], significance: 6,
        }))
      }
      if (beforeF.lastChapter !== afterF.lastChapter) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'foreshadow_change',
          entityId: id, entityType: 'foreshadow',
          description: `伏笔回收章节更新: ${afterF.description}`,
          oldValue: JSON.stringify({ lastChapter: beforeF.lastChapter }),
          newValue: JSON.stringify({ lastChapter: afterF.lastChapter }),
          cause: null, effectIds: [], significance: 8,
        }))
      }
      // ── P2-2：埋设方式变更事件 ──
      if (beforeF.plantMethod !== afterF.plantMethod) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'foreshadow_change',
          entityId: id, entityType: 'foreshadow',
          description: `伏笔埋设方式变更: ${afterF.description}（${beforeF.plantMethod ?? '(未指定)'} → ${afterF.plantMethod ?? '(未指定)'}）`,
          oldValue: JSON.stringify({ plantMethod: beforeF.plantMethod }),
          newValue: JSON.stringify({ plantMethod: afterF.plantMethod }),
          cause: null, effectIds: [], significance: 5,
        }))
      }
      // ── P2-2：回收方式变更事件 ──
      if (beforeF.recoverMethod !== afterF.recoverMethod) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'foreshadow_change',
          entityId: id, entityType: 'foreshadow',
          description: `伏笔回收方式变更: ${afterF.description}（${beforeF.recoverMethod ?? '(未指定)'} → ${afterF.recoverMethod ?? '(未指定)'}）`,
          oldValue: JSON.stringify({ recoverMethod: beforeF.recoverMethod }),
          newValue: JSON.stringify({ recoverMethod: afterF.recoverMethod }),
          cause: null, effectIds: [], significance: 5,
        }))
      }
    }

    // ── 势力变更 ──
    for (const [id, afterFac] of after.factions) {
      const beforeFac = before.factions.get(id)
      if (!beforeFac) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'faction_change',
          entityId: id, entityType: 'faction',
          description: `势力创建: ${afterFac.name}`,
          oldValue: null,
          newValue: JSON.stringify({ name: afterFac.name, status: afterFac.status, strength: afterFac.strength }),
          cause: null, effectIds: [], significance: 7,
        }))
        continue
      }
      if (beforeFac.status !== afterFac.status) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'faction_change',
          entityId: id, entityType: 'faction',
          description: `势力状态变更: ${afterFac.name}（${beforeFac.status} → ${afterFac.status}）`,
          oldValue: JSON.stringify({ status: beforeFac.status }),
          newValue: JSON.stringify({ status: afterFac.status }),
          cause: null, effectIds: [], significance: 6,
        }))
      }
    }

    // ── 地点变更 ──
    for (const [id, afterLoc] of after.locations) {
      const beforeLoc = before.locations.get(id)
      if (!beforeLoc) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'location_change',
          entityId: id, entityType: 'location',
          description: `地点创建: ${afterLoc.name}`,
          oldValue: null,
          newValue: JSON.stringify({ name: afterLoc.name, status: afterLoc.status }),
          cause: null, effectIds: [], significance: 6,
        }))
        continue
      }
      if (beforeLoc.status !== afterLoc.status) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'location_change',
          entityId: id, entityType: 'location',
          description: `地点状态变更: ${afterLoc.name}（${beforeLoc.status} → ${afterLoc.status}）`,
          oldValue: JSON.stringify({ status: beforeLoc.status }),
          newValue: JSON.stringify({ status: afterLoc.status }),
          cause: null, effectIds: [], significance: 5,
        }))
      }
      const beforeChs = beforeLoc.appearChapters
      const afterChs = afterLoc.appearChapters
      if (beforeChs.join(',') !== afterChs.join(',')) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'location_change',
          entityId: id, entityType: 'location',
          description: `地点出场章节更新: ${afterLoc.name}`,
          oldValue: JSON.stringify({ appearChapters: beforeChs }),
          newValue: JSON.stringify({ appearChapters: afterChs }),
          cause: null, effectIds: [], significance: 5,
        }))
      }
    }

    // ── 关系变更（四层逻辑②关系层）──
    // currentStage / dynamicRole / alignment / trend / chapterHint / lastUpdatedChapter
    // 任一字段变化都生成 relationship_change 事件，让 Memory Agent 的关系更新可追溯。
    // 关系是小说动态骨架的核心，所以阶段/阵营/走向变更都用 significance 6+ 强提示。
    const relationshipFields = ['currentStage', 'dynamicRole', 'alignment', 'trend', 'chapterHint', 'lastUpdatedChapter'] as const
    for (const [id, afterRel] of after.relationships) {
      const beforeRel = before.relationships.get(id)
      if (!beforeRel) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'relationship_change',
          entityId: id, entityType: 'relationship',
          description: `关系创建: ${afterRel.characterA} ↔ ${afterRel.characterB}（${afterRel.relationType}）`,
          oldValue: null,
          newValue: JSON.stringify({
            relationType: afterRel.relationType,
            currentStage: afterRel.currentStage,
            alignment: afterRel.alignment,
            trend: afterRel.trend,
          }),
          cause: null, effectIds: [], significance: 7,
        }))
        continue
      }
      for (const field of relationshipFields) {
        if (beforeRel[field] !== afterRel[field]) {
          // 阶段变更最重要（剧情节点切换）；其他字段（功能位/阵营/走向）次之
          const significance = field === 'currentStage' ? 7 : 6
          events.push(this.memoryStore.recordEvent({
            projectId, chapterId, chapterNumber,
            eventType: 'relationship_change',
            entityId: id, entityType: 'relationship',
            description: `关系 ${afterRel.characterA} ↔ ${afterRel.characterB} 的 ${field} 变更`,
            oldValue: JSON.stringify({ [field]: beforeRel[field] }),
            newValue: JSON.stringify({ [field]: afterRel[field] }),
            cause: null, effectIds: [], significance,
          }))
        }
      }
    }

    // ── P3-2：信息差变更 ──
    // 监控 readerKnows / isRevealed / linkedForeshadows 三个关键维度：
    // - readerKnows: 读者认知翻转（从不知道到知道，是揭示性事件）
    // - isRevealed: 信息差正式揭露（与 revealChapter 配对）
    // - linkedForeshadows: 关联伏笔变化（手动 link/unlink 时触发）
    for (const [id, afterLayer] of after.infoLayers) {
      const beforeLayer = before.infoLayers.get(id)
      if (!beforeLayer) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'info_layer_change',
          entityId: id, entityType: 'relationship',
          description: `信息差创建: ${afterLayer.infoDescription}`,
          oldValue: null,
          newValue: JSON.stringify({ readerKnows: afterLayer.readerKnows, isRevealed: afterLayer.isRevealed }),
          cause: null, effectIds: [], significance: 7,
        }))
        continue
      }
      if (beforeLayer.readerKnows !== afterLayer.readerKnows) {
        // 读者认知翻转是重大叙事节点（揭示性事件）
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'info_layer_change',
          entityId: id, entityType: 'relationship',
          description: `信息差读者认知翻转: ${afterLayer.infoDescription}（读者未知 → 读者已知）`,
          oldValue: JSON.stringify({ readerKnows: beforeLayer.readerKnows }),
          newValue: JSON.stringify({ readerKnows: afterLayer.readerKnows }),
          cause: null, effectIds: [], significance: 8,
        }))
      }
      if (beforeLayer.isRevealed !== afterLayer.isRevealed) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'info_layer_change',
          entityId: id, entityType: 'relationship',
          description: `信息差揭露状态变更: ${afterLayer.infoDescription}（${beforeLayer.isRevealed ? '已揭露' : '未揭露'} → ${afterLayer.isRevealed ? '已揭露' : '未揭露'}）`,
          oldValue: JSON.stringify({ isRevealed: beforeLayer.isRevealed }),
          newValue: JSON.stringify({ isRevealed: afterLayer.isRevealed }),
          cause: null, effectIds: [], significance: 7,
        }))
      }
      const beforeLinks = beforeLayer.linkedForeshadows
      const afterLinks = afterLayer.linkedForeshadows
      if (beforeLinks.join(',') !== afterLinks.join(',')) {
        events.push(this.memoryStore.recordEvent({
          projectId, chapterId, chapterNumber,
          eventType: 'info_layer_change',
          entityId: id, entityType: 'relationship',
          description: `信息差关联伏笔变更: ${afterLayer.infoDescription}（新增 ${afterLinks.filter(x => !beforeLinks.includes(x)).length} 条，解除 ${beforeLinks.filter(x => !afterLinks.includes(x)).length} 条）`,
          oldValue: JSON.stringify({ linkedForeshadows: beforeLinks }),
          newValue: JSON.stringify({ linkedForeshadows: afterLinks }),
          cause: null, effectIds: [], significance: 5,
        }))
      }
    }

    // ── P3-1：跨实体因果链启发式连边 ──
    // 在所有事件落库完成后，根据本章实体关联性自动建立 cause/effect 边。
    // 不依赖 LLM 主动推断，纯基于 events 数组内的实体引用关系回填。
    // linkCause 内部已处理"已有 cause 则跳过"，所以无需在外层去重。
    this.applyHeuristicCausalLinks(events, projectId)

    return events
  }

  /**
   * 启发式因果连边：根据本章 events 间的实体引用关系自动建立 cause/effect 边。
   *
   * 3 条规则（基于 docs/novel/character-conflict-foreshadow-analysis.md P3-1 定义）：
   *
   * 规则 1（角色→冲突）：
   *   角色 participatingConflicts 变更（参与冲突线接入或切断）
   *   → 该冲突在同章后续发生的 conflict_change 事件的 cause
   *   场景：角色被卷入冲突后，冲突立刻升级或爆发
   *
   * 规则 2（冲突→关系）：
   *   冲突 stage → erupting（爆发）
   *   → 同章涉及该冲突参与者的下一个 relationship_change 事件的 cause
   *   场景：冲突爆发导致参与者之间的关系失衡
   *
   * 规则 3（伏笔→角色）：
   *   伏笔 status → recovered（已回收）
   *   → 同章该伏笔 linkedCharacters 中角色的下一个 character_change 事件的 cause
   *   场景：伏笔回收揭示真相，改变角色认知/状态
   *
   * 每个 effect 事件只接受第一个匹配的 cause（首次写入后 linkCause 自动跳过后续）。
   */
  private applyHeuristicCausalLinks(events: MemoryEvent[], projectId: string): void {
    if (events.length === 0) return

    // 预构建索引：按 entityId 分组本章事件，便于按实体查找后续事件
    const eventsByEntity = new Map<string, MemoryEvent[]>()
    for (const e of events) {
      const list = eventsByEntity.get(e.entityId)
      if (list) list.push(e)
      else eventsByEntity.set(e.entityId, [e])
    }

    // ── 规则 1：角色参与冲突变更 → 冲突的下一个 conflict_change 的 cause ──
    for (const e of events) {
      if (e.eventType !== 'character_change') continue
      if (!e.newValue) continue
      let parsed: { participatingConflicts?: unknown } = {}
      try { parsed = JSON.parse(e.newValue) } catch { continue }
      if (!Array.isArray(parsed.participatingConflicts) || parsed.participatingConflicts.length === 0) continue
      const conflictIds = parsed.participatingConflicts.filter((x): x is string => typeof x === 'string')
      if (conflictIds.length === 0) continue

      for (const conflictId of conflictIds) {
        // 找该冲突在同章后续发生的 conflict_change 事件（按 createdAt 升序）
        const conflictEvents = (eventsByEntity.get(conflictId) ?? [])
          .filter(ev => ev.eventType === 'conflict_change' && ev.createdAt >= e.createdAt)
          .sort((a, b) => a.createdAt - b.createdAt)
        if (conflictEvents.length === 0) continue
        // 只连第一个未带 cause 的 conflict_change
        this.memoryStore.linkCause(conflictEvents[0].id, e.id)
        break
      }
    }

    // ── 规则 2：冲突 stage=erupting → 涉及参与者的 relationship_change 的 cause ──
    for (const e of events) {
      if (e.eventType !== 'conflict_change') continue
      if (!e.newValue) continue
      let parsed: { stage?: unknown } = {}
      try { parsed = JSON.parse(e.newValue) } catch { continue }
      if (parsed.stage !== 'erupting') continue

      // 查询该冲突的 participants（captureEntityState 快照未含此字段，需查 store）
      const conflict = this.store.getConflict(e.entityId)
      if (!conflict) continue
      const participantIds = this.parseIdList(conflict.participants)
      if (participantIds.length === 0) continue

      // 找本章内涉及这些参与者的 relationship_change 事件（在冲突爆发之后发生）
      for (const relEvent of events) {
        if (relEvent.eventType !== 'relationship_change') continue
        if (relEvent.createdAt < e.createdAt) continue
        const rel = this.store.getRelationship(relEvent.entityId)
        if (!rel) continue
        // 关系涉及的角色是否是冲突的参与者（characterA/B 是角色 ID）
        const involves = participantIds.includes(rel.characterA) || participantIds.includes(rel.characterB)
        if (!involves) continue
        this.memoryStore.linkCause(relEvent.id, e.id)
        break // 该冲突只连第一个匹配的关系变更
      }
    }

    // ── 规则 3：伏笔 status=recovered → linkedCharacters 的 character_change 的 cause ──
    for (const e of events) {
      if (e.eventType !== 'foreshadow_change') continue
      if (!e.newValue) continue
      let parsed: { status?: unknown } = {}
      try { parsed = JSON.parse(e.newValue) } catch { continue }
      if (parsed.status !== 'recovered') continue

      // 查询伏笔的 linkedCharacters（captureEntityState 快照未含此字段，需查 store）
      const foreshadow = this.store.getForeshadow(e.entityId)
      if (!foreshadow) continue
      const linkedCharIds = this.parseIdList(foreshadow.linkedCharacters)
      if (linkedCharIds.length === 0) continue

      for (const charId of linkedCharIds) {
        // 找该角色在同章后续发生的 character_change 事件
        const charEvents = (eventsByEntity.get(charId) ?? [])
          .filter(ev => ev.eventType === 'character_change' && ev.createdAt >= e.createdAt)
          .sort((a, b) => a.createdAt - b.createdAt)
        if (charEvents.length === 0) continue
        this.memoryStore.linkCause(charEvents[0].id, e.id)
      }
    }

    // ── 规则 4（P3-2）：伏笔回收 → 关联信息差的 info_layer_change 的 cause ──
    // 场景：伏笔回收揭示真相，导致承载的信息差 readerKnows 翻转或 isRevealed=true
    // 实现：伏笔 status=recovered 时，找其 linkedInfoLayers 对应的 info_layer_change 事件
    for (const e of events) {
      if (e.eventType !== 'foreshadow_change') continue
      if (!e.newValue) continue
      let parsed: { status?: unknown } = {}
      try { parsed = JSON.parse(e.newValue) } catch { continue }
      if (parsed.status !== 'recovered') continue

      // 查询伏笔的 linkedInfoLayers（P3-2 双向关联字段）
      const foreshadow = this.store.getForeshadow(e.entityId)
      if (!foreshadow) continue
      const linkedInfoLayerIds = this.parseIdList(foreshadow.linkedInfoLayers)
      if (linkedInfoLayerIds.length === 0) continue

      for (const infoLayerId of linkedInfoLayerIds) {
        // 找该信息差在同章后续发生的 info_layer_change 事件（读者认知翻转或揭露状态变更）
        const infoEvents = (eventsByEntity.get(infoLayerId) ?? [])
          .filter(ev => ev.eventType === 'info_layer_change' && ev.createdAt >= e.createdAt)
          .sort((a, b) => a.createdAt - b.createdAt)
        if (infoEvents.length === 0) continue
        // 只连第一个匹配的 info_layer_change（最接近伏笔回收时刻的事件）
        this.memoryStore.linkCause(infoEvents[0].id, e.id)
      }
    }
  }

  /**
   * 同步本章涉及实体的章节维度字段（GAP A/B/C 统一修复）。
   *
   * 问题背景：
   * - Memory Agent 工具只改实体的「动态状态」（currentState/stage/intensity/status），
   *   不稳定写入「章节维度」字段（chapterSpans/firstChapter/lastChapter/characterHistory）。
   * - 矩阵视图依赖章节维度字段画跨度色带，导致 Memory 写完后矩阵图不变。
   *
   * 本方法在 Memory Agent 执行后统一补全，不依赖 LLM 是否传 chapterNumber：
   * - 角色：本章编排涉及角色 + Memory 新建角色，若无本章 character_history 记录则写入
   * - 冲突：本章编排涉及冲突 + Memory 新建冲突，合并本章号到 chapterSpans（连续扩展或新段追加）
   * - 伏笔：firstChapter 兜底，lastChapter 更新为本章号
   * - 势力：同冲突（chapterSpans 合并）
   * - 地点：本章编排涉及地点 + Memory 新建地点，若 appearChapters 不含本章号则追加
   */
  private syncChapterDimensions(
    projectId: string,
    chapterNumber: number,
    chapterId: string | null,
    arrangedEntities: ArrangedEntity | undefined,
    before: ReturnType<NovelOrchestrator['captureEntityState']>,
  ): void {
    // ── 角色：补全 character_history（本章出场记录）──
    // 涉及角色 = arrangedEntities.characterIds + Memory 新建角色（before.characters 没有的）
    const afterChars = this.store.listCharacters(projectId)
    const newCharacterIds = afterChars
      .filter((c) => !before.characters.has(c.id))
      .map((c) => c.id)
    const involvedCharacterIds = new Set<string>([
      ...(arrangedEntities?.characterIds ?? []),
      ...newCharacterIds,
    ])

    if (involvedCharacterIds.size > 0) {
      // 查询本章已有的 character_history，避免重复写入
      const existingHistory = this.store.listCharacterHistory(projectId)
      const existingInChapter = new Set(
        existingHistory
          .filter((h) => h.chapterNumber === chapterNumber)
          .map((h) => h.characterId),
      )
      const newEntries: Array<Omit<NovelCharacterHistory, 'id' | 'createdAt'>> = []
      for (const characterId of involvedCharacterIds) {
        if (existingInChapter.has(characterId)) continue
        const character = afterChars.find((c) => c.id === characterId)
        if (!character) continue
        newEntries.push({
          projectId,
          characterId,
          chapterId,
          chapterNumber,
          fieldName: 'currentState',
          oldValue: null,
          newValue: '本章出场',
          reason: 'orchestrator.syncChapterDimensions 自动补全',
        })
      }
      if (newEntries.length > 0) {
        this.store.batchCreateCharacterHistory(newEntries)
      }
    }

    // ── 冲突：补全 chapterSpans ──
    // 涉及冲突 = arrangedEntities.conflictIds + Memory 新建冲突
    const afterConflicts = this.store.listConflicts(projectId)
    const newConflictIds = afterConflicts
      .filter((c) => !before.conflicts.has(c.id))
      .map((c) => c.id)
    const involvedConflictIds = new Set<string>([
      ...(arrangedEntities?.conflictIds ?? []),
      ...newConflictIds,
    ])
    for (const conflictId of involvedConflictIds) {
      const conflict = afterConflicts.find((c) => c.id === conflictId)
      if (!conflict) continue
      const nextSpans = appendChapterToSpans(conflict.chapterSpans, chapterNumber)
      const patch: Partial<NovelConflict> = { chapterSpans: nextSpans }
      this.store.updateConflict(conflictId, patch)
    }

    // ── 伏笔：补全 firstChapter/lastChapter ──
    // 涉及伏笔 = arrangedEntities.foreshadowIds + Memory 新建伏笔
    const afterForeshadows = this.store.listForeshadowing(projectId)
    const newForeshadowIds = afterForeshadows
      .filter((f) => !before.foreshadowing.has(f.id))
      .map((f) => f.id)
    const involvedForeshadowIds = new Set<string>([
      ...(arrangedEntities?.foreshadowIds ?? []),
      ...newForeshadowIds,
    ])
    for (const foreshadowId of involvedForeshadowIds) {
      const foreshadow = afterForeshadows.find((f) => f.id === foreshadowId)
      if (!foreshadow) continue
      const patch: Partial<NovelForeshadow> = { lastChapter: chapterNumber }
      if (foreshadow.firstChapter == null) {
        patch.firstChapter = chapterNumber
      }
      this.store.updateForeshadow(foreshadowId, patch)
    }

    // ── 势力：补全 chapterSpans（同冲突逻辑）──
    // 涉及势力 = arrangedEntities.factionIds + Memory 新建势力
    const afterFactions = this.store.listFactions(projectId)
    const newFactionIds = afterFactions
      .filter((f) => !before.factions.has(f.id))
      .map((f) => f.id)
    const involvedFactionIds = new Set<string>([
      ...(arrangedEntities?.factionIds ?? []),
      ...newFactionIds,
    ])
    for (const factionId of involvedFactionIds) {
      const faction = afterFactions.find((f) => f.id === factionId)
      if (!faction) continue
      const nextSpans = appendChapterToSpans(faction.chapterSpans, chapterNumber)
      const patch: Partial<NovelFaction> = { chapterSpans: nextSpans }
      this.store.updateFaction(factionId, patch)
    }

    // ── 地点：补全 appearChapters（本章出场记录）──
    // 涉及地点 = arrangedEntities.locationIds + Memory 新建地点
    const afterLocations = this.store.listLocations(projectId)
    const newLocationIds = afterLocations
      .filter((l) => !before.locations.has(l.id))
      .map((l) => l.id)
    const involvedLocationIds = new Set<string>([
      ...(arrangedEntities?.locationIds ?? []),
      ...newLocationIds,
    ])
    for (const locationId of involvedLocationIds) {
      const location = afterLocations.find((l) => l.id === locationId)
      if (!location) continue
      const appears = location.appearChapters ?? []
      if (!appears.includes(chapterNumber)) {
        const next = Array.from(new Set([...appears, chapterNumber])).sort((a, b) => a - b)
        const patch: Partial<NovelLocation> = { appearChapters: next }
        if (location.firstChapter == null) {
          patch.firstChapter = chapterNumber
        }
        this.store.updateLocation(locationId, patch)
      }
    }
  }

  /**
   * 保存章节完成时的全量状态快照（情景记忆）
   * 包含角色 / 冲突 / 伏笔 / 势力 / 地点 / 关系的当前状态，供时间线查询
   */
  private saveChapterSnapshot(projectId: string, chapterNumber: number): void {
    const data = {
      characters: this.store.listCharacters(projectId),
      conflicts: this.store.listConflicts(projectId),
      foreshadowing: this.store.listForeshadowing(projectId),
      factions: this.store.listFactions(projectId),
      locations: this.store.listLocations(projectId),
      relationships: this.store.listRelationships(projectId),
    }
    this.memoryStore.saveSnapshot({
      projectId,
      chapterNumber,
      snapshotType: 'full',
      entityId: null,
      snapshotData: JSON.stringify(data),
    })
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

    return task
  }
}
