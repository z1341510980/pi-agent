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
 * 通过 onProgress 回调和 EventEmitter 向外推送 CreationFlowEvent，
 * 上层（如 SSE 路由）可订阅事件实现实时进度推送。
 */

import { EventEmitter } from 'node:events'
import type { NovelStore } from './novel-store.js'
import type { NovelSessionFactory } from './novel-session.js'
import type { NovelPromptBuilder } from './prompt-builder.js'
import type { NovelEngine } from './novel-engine.js'
import type { PluginContext } from '../../../core/plugin/plugin-types.js'
import { NOVEL_AGENT_CONFIGS, type NovelAgentType, type CreationPhase, type CheckpointData, type CreationFlowEvent, type AgentOutputData } from './novel-agents.js'
import type { NarrativeTask, ChapterConstraints, ArrangedEntity } from './types.js'
import type { ToolDefinition as PluginToolDefinition } from '../../../core/plugin/plugin-types.js'
import { RhythmController } from './rhythm-controller.js'
import { NovelMemoryStore, type MemoryEvent } from './novel-memory-store.js'
import type { NovelAgentConfigStore } from './novel-agent-config-store.js'
import type { NovelAgentLogStatus } from './types.js'

export interface CreationOptions {
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

export class NovelOrchestrator extends EventEmitter {
  /** 用户在检查点期间发送的创作指令（供下一个 Agent 使用后清空） */
  private userMessages: string[] = []
  /** 本章已编排实体约束（由 createChapterWithFlow 设置，runAgent 读取后清空） */
  private currentArrangedEntities?: ArrangedEntity
  /** 小说角色温度配置存储（runAgent 中按角色合并温度） */
  private readonly agentConfigStore: NovelAgentConfigStore

  constructor(
    private store: NovelStore,
    private memoryStore: NovelMemoryStore,
    private sessionFactory: NovelSessionFactory,
    private promptBuilder: NovelPromptBuilder,
    private engine: NovelEngine,
    private context: PluginContext,
    agentConfigStore: NovelAgentConfigStore,
  ) {
    super()
    this.agentConfigStore = agentConfigStore
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
      const rhythmSuggestion = rhythmController.suggestRhythm(
        chapterNumber,
        project?.currentStage ?? 'setup',
        rhythmHistory,
        rhythmModel,
      )

      // Phase 1: Director
      this.emitProgress(options, 'directing', { message: '导演 Agent 正在分析故事状态...' })
      const directorResult = await this.runAgent('director', projectId, chapterNumber, {
        task: `请分析当前故事状态，为第 ${chapterNumber} 章规划叙事任务。`,
        rhythmSuggestion,
      }, options)

      // 检查点 1
      this.emitProgress(options, 'checkpoint_narrative', { message: '等待用户确认叙事任务...' })
      const narrativeDecision = await options.onCheckpoint({
        type: 'narrative_task',
        phase: 'checkpoint_narrative',
        data: directorResult,
      })

      if (narrativeDecision === 'reject') {
        this.emitProgress(options, 'cancelled', { message: '用户取消了创作流程' })
        return { status: 'cancelled' }
      }

      // Phase 2: Writer
      this.emitProgress(options, 'writing', { message: '写作 Agent 正在创作章节正文...' })
      const writerResult = await this.runAgent('writer', projectId, chapterNumber, {
        task: `请根据叙事任务创作第 ${chapterNumber} 章正文。`,
        narrativeTask: directorResult,
      }, options)

      // Phase 3: Reviewer
      this.emitProgress(options, 'reviewing', { message: '审稿 Agent 正在检查章节...' })
      const reviewResult = await this.runAgent('reviewer', projectId, chapterNumber, {
        task: `请验收第 ${chapterNumber} 章的内容。`,
        content: writerResult,
      }, options)

      // 检查点 2
      this.emitProgress(options, 'checkpoint_review', { message: '等待用户确认验收报告...' })
      const reviewDecision = await options.onCheckpoint({
        type: 'review',
        phase: 'checkpoint_review',
        data: reviewResult,
      })

      let finalContent = writerResult

      if (reviewDecision === 'revise') {
        this.emitProgress(options, 'revising', { message: '写作 Agent 正在根据审稿意见修订章节...' })
        const reviseResult = await this.runAgent('writer', projectId, chapterNumber, {
          task: `请根据审稿意见修订第 ${chapterNumber} 章的局部内容。`,
          content: writerResult,
          issues: reviewResult,
        }, options, {
          phase: 'revising',
          displayAgentType: 'reviser',
          displayAgentName: '修订',
        })
        finalContent = reviseResult
      } else if (reviewDecision === 'rewrite') {
        this.emitProgress(options, 'rewriting', { message: '重新创作章节...' })
        return this.createChapterWithFlow(projectId, chapterNumber, options)
      }

      // Phase 5: Memory
      // 在 Memory Agent 执行前捕获实体状态快照，执行后比较差异并记录记忆事件
      this.emitProgress(options, 'memory', { message: '记忆 Agent 正在提取状态变更...' })
      const beforeState = this.captureEntityState(projectId)
      const memoryResult = await this.runAgent('memory', projectId, chapterNumber, {
        task: `请从第 ${chapterNumber} 章中提取状态变更。`,
        content: finalContent,
      }, options)
      const chapter = this.store.getChapter(projectId, chapterNumber)
      const memoryEvents = this.recordMemoryEvents(
        projectId,
        chapterNumber,
        chapter?.id ?? null,
        beforeState,
      )

      // 章节完成时保存全量状态快照（情景记忆）
      this.saveChapterSnapshot(projectId, chapterNumber)

      // 推送数据变更通知：Memory Agent 已写入实体状态、快照已保存，
      // 前端收到后刷新画布（替代轮询）。此事件不展示在时间线（dataChanged: true）。
      this.emitProgress(options, 'memory', {
        agentType: 'memory',
        agentName: '记忆',
        content: '数据已更新',
        preview: '数据已更新',
        dataChanged: true,
      } as AgentOutputData)

      // 自动保存章节内容到数据库（创作完成后立即持久化，无需用户手动点击"保存到章节"）
      if (chapter) {
        this.store.updateChapter(chapter.id, {
          content: finalContent,
          status: 'review',
          wordCount: finalContent.length,
        })
      }

      this.emitProgress(options, 'completed', { message: '章节创作完成' })

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
      this.emitProgress(options, 'error', { message })
      return { status: 'error', error: message }
    } finally {
      // 流程结束（含 rewrite 递归返回后）清理编排约束，避免泄漏到下一次创作
      this.currentArrangedEntities = undefined
    }
  }

  /** 运行单个 Agent（通过 Pi SDK Session，流式推送 delta） */
  private async runAgent(
    agentType: NovelAgentType,
    projectId: string,
    chapterNumber: number,
    input: unknown,
    options?: CreationOptions,
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
    const chapter = this.store.getChapter(projectId, chapterNumber)
    const narrativeTask: NarrativeTask = {
      description: chapter?.narrativeTask ?? `第 ${chapterNumber} 章创作`,
      type: 'advance_mainline',
      targetEntity: null,
      priority: 'medium',
    }
    const constraints: ChapterConstraints = this.engine.buildChapterConstraints(projectId)
    const chapterContext = this.promptBuilder.buildChapterContext(
      projectId,
      chapterNumber,
      narrativeTask,
      constraints,
      this.currentArrangedEntities,
    )

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

    // 创建独立 Session 并调用 LLM
    const startTime = Date.now()
    // 合并温度：持久化覆盖 > 角色默认值（NOVEL_AGENT_CONFIGS）
    const temperature = this.agentConfigStore.getByType(agentType)

    const session = await this.context.createSession({
      systemPrompt,
      prefixUserMessage: chapterContext,
      userMessage,
      tools: filteredTools as unknown as PluginToolDefinition[],
      signal: options?.signal,
      temperature,
    })

    // 在 try/catch/finally 中捕获结果与错误，finally 持久化到日志表
    let logStatus: NovelAgentLogStatus = 'success'
    let logError = ''
    let logResult = ''
    try {
      // 流式推送：每收到一段 delta 就通过 emitProgress 推送给前端，
      // 前端据此实时更新最后一条同类型 Agent 输出（streaming: true）。
      let streamedText = ''
      let deltaCount = 0
      this.context.logger.info(
        { agentType, agentName: config.name, projectId, chapterNumber, userMessageLength: userMessage.length },
        'Agent promptStream 开始调用 LLM',
      )
      const result = await session.promptStream((delta: string) => {
        deltaCount++
        streamedText += delta
        this.emitProgress(options, phase, {
          agentType: displayAgentType,
          agentName: displayAgentName,
          content: streamedText,
          // 取最后 200 字符作为预览，避免 SSE 事件过大
          preview: streamedText.slice(-200),
          streaming: true,
        } as AgentOutputData)
      })

      this.context.logger.info(
        {
          agentType,
          agentName: config.name,
          projectId,
          deltaCount,
          streamedLength: streamedText.length,
          resultLength: result.length,
          resultPreview: result.slice(0, 200),
        },
        'Agent promptStream 返回',
      )

      // 推送最终完整输出（streaming: false 标记生成结束，
      // 前端会更新最后一条同类型输出并移除"正在生成"状态）
      this.emitProgress(options, phase, {
        agentType: displayAgentType,
        agentName: displayAgentName,
        content: result,
        preview: result.slice(0, 500),
        streaming: false,
      } as AgentOutputData)

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
      session.dispose()

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
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 长期记忆：实体状态捕获 + 记忆事件记录
  // ═══════════════════════════════════════════════════════════════

  /**
   * 捕获项目当前实体状态（角色 / 冲突 / 伏笔）
   * 返回按实体 ID 索引的 Map，用于 Memory Agent 执行前后差异比较
   */
  private captureEntityState(projectId: string): {
    characters: Map<string, { name: string; currentState: string; currentGoal: string; currentPressure: string; secret: string; arcStage: string }>
    conflicts: Map<string, { description: string; stage: string; intensity: number }>
    foreshadowing: Map<string, { description: string; status: string; firstChapter: number | null; lastChapter: number | null }>
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
        },
      ]),
    )
    const conflicts = new Map(
      this.store.listConflicts(projectId).map((c) => [
        c.id,
        { description: c.description, stage: c.stage, intensity: c.intensity },
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
        },
      ]),
    )
    return { characters, conflicts, foreshadowing }
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
    const characterFields = ['currentState', 'currentGoal', 'currentPressure', 'secret', 'arcStage'] as const
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
          newValue: JSON.stringify({ stage: afterConflict.stage, intensity: afterConflict.intensity }),
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
          newValue: JSON.stringify({ status: afterF.status }),
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
    }

    return events
  }

  /**
   * 保存章节完成时的全量状态快照（情景记忆）
   * 包含角色 / 冲突 / 伏笔 / 关系的当前状态，供时间线查询
   */
  private saveChapterSnapshot(projectId: string, chapterNumber: number): void {
    const data = {
      characters: this.store.listCharacters(projectId),
      conflicts: this.store.listConflicts(projectId),
      foreshadowing: this.store.listForeshadowing(projectId),
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

  private emitProgress(options: CreationOptions | undefined, phase: CreationPhase, data: unknown): void {
    const event: CreationFlowEvent = {
      type: phase === 'completed' || phase === 'error' || phase === 'cancelled'
        ? phase
        : (data && typeof data === 'object' && 'agentType' in data ? 'agent_output' : 'phase_change'),
      phase,
      data,
      timestamp: Date.now(),
    }
    options?.onProgress(event)
    this.emit('event', event)
  }
}
