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
 * │           Reviser          (重新开始)           Memory       │
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
 *   - revise：调用 Reviser 修订局部内容
 *   - rewrite：重新开始整个创作流程（递归调用）
 *
 * ── 事件流 ──
 *
 * 通过 onProgress 回调和 EventEmitter 向外推送 CreationFlowEvent，
 * 上层（如 SSE 路由）可订阅事件实现实时进度推送。
 */

import { EventEmitter } from 'node:events'
import type { NovelStore } from '../../../core/novel/novel-store.js'
import type { NovelSessionFactory } from '../../../core/novel/novel-session.js'
import type { NovelPromptBuilder } from '../../../core/novel/prompt-builder.js'
import type { NovelEngine } from '../../../core/novel/novel-engine.js'
import type { PluginContext } from '../../../core/plugin/plugin-types.js'
import { NOVEL_AGENT_CONFIGS, type NovelAgentType, type CreationPhase, type CheckpointData, type CreationFlowEvent } from './novel-agents.js'
import { RhythmController } from './rhythm-controller.js'

export interface CreationOptions {
  onCheckpoint: (checkpoint: CheckpointData) => Promise<'approve' | 'reject' | 'revise' | 'rewrite'>
  onProgress: (event: CreationFlowEvent) => void
  signal?: AbortSignal
}

export interface CreationResult {
  status: 'completed' | 'cancelled' | 'error'
  chapterId?: string
  content?: string
  stateChanges?: Array<{ type: string; description: string }>
  error?: string
}

export class NovelOrchestrator extends EventEmitter {
  constructor(
    private store: NovelStore,
    private sessionFactory: NovelSessionFactory,
    private promptBuilder: NovelPromptBuilder,
    private engine: NovelEngine,
    private context: PluginContext,
  ) {
    super()
  }

  async createChapterWithFlow(
    projectId: string,
    chapterNumber: number,
    options: CreationOptions,
  ): Promise<CreationResult> {
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
      const directorResult = await this.runAgent('director', projectId, {
        task: `请分析当前故事状态，为第 ${chapterNumber} 章规划叙事任务。`,
        rhythmSuggestion,
      })

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
      const writerResult = await this.runAgent('writer', projectId, {
        task: `请根据叙事任务创作第 ${chapterNumber} 章正文。`,
        narrativeTask: directorResult,
      })

      // Phase 3: Reviewer
      this.emitProgress(options, 'reviewing', { message: '审稿 Agent 正在检查章节...' })
      const reviewResult = await this.runAgent('reviewer', projectId, {
        task: `请验收第 ${chapterNumber} 章的内容。`,
        content: writerResult,
      })

      // 检查点 2
      this.emitProgress(options, 'checkpoint_review', { message: '等待用户确认验收报告...' })
      const reviewDecision = await options.onCheckpoint({
        type: 'review',
        phase: 'checkpoint_review',
        data: reviewResult,
      })

      let finalContent = writerResult

      if (reviewDecision === 'revise') {
        this.emitProgress(options, 'revising', { message: '修订 Agent 正在重写局部内容...' })
        const reviseResult = await this.runAgent('reviser', projectId, {
          task: `请根据审稿问题修订第 ${chapterNumber} 章。`,
          content: writerResult,
          issues: reviewResult,
        })
        finalContent = reviseResult
      } else if (reviewDecision === 'rewrite') {
        this.emitProgress(options, 'rewriting', { message: '重新创作章节...' })
        return this.createChapterWithFlow(projectId, chapterNumber, options)
      }

      // Phase 5: Memory
      this.emitProgress(options, 'memory', { message: '记忆 Agent 正在提取状态变更...' })
      const memoryResult = await this.runAgent('memory', projectId, {
        task: `请从第 ${chapterNumber} 章中提取状态变更。`,
        content: finalContent,
      })

      this.emitProgress(options, 'completed', { message: '章节创作完成' })

      return {
        status: 'completed',
        content: finalContent,
        stateChanges: [{ type: 'memory', description: memoryResult.slice(0, 200) }],
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emitProgress(options, 'error', { message })
      return { status: 'error', error: message }
    }
  }

  /** 运行单个 Agent（通过 Pi SDK Session） */
  private async runAgent(agentType: NovelAgentType, projectId: string, input: unknown): Promise<string> {
    const config = NOVEL_AGENT_CONFIGS[agentType]
    const inputText = typeof input === 'string' ? input : JSON.stringify(input)

    // 构建系统提示词（STATIC 层 - Agent 身份 + 世界规则 + 风格 + 角色定义）
    const systemPrompt = this.promptBuilder.buildSystemPrompt(projectId, agentType)

    // 构建用户消息（Agent 任务指令 + 输入数据）
    const userMessage = inputText

    // 创建独立 Session 并调用 LLM
    // TODO: 从 CreationOptions 传入 signal（需要扩展 runAgent 签名）
    const session = await this.context.createSession({
      systemPrompt,
      userMessage,
    })

    try {
      const result = await session.prompt()
      this.context.logger.info(
        {
          agentType,
          agentName: config.name,
          projectId,
          resultLength: result.length,
          resultPreview: result.slice(0, 200),
        },
        'Agent 推理完成',
      )
      return result
    } catch (err) {
      this.context.logger.error(
        { agentType, agentName: config.name, projectId, err },
        'Agent 推理失败',
      )
      throw err
    } finally {
      session.dispose()
    }
  }

  private emitProgress(options: CreationOptions, phase: CreationPhase, data: unknown): void {
    const event: CreationFlowEvent = {
      type: phase === 'completed' || phase === 'error' || phase === 'cancelled' ? phase : 'phase_change',
      phase,
      data,
      timestamp: Date.now(),
    }
    options.onProgress(event)
    this.emit('event', event)
  }
}
