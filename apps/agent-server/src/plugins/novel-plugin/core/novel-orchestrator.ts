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
import { NOVEL_AGENT_CONFIGS, type NovelAgentType, type CreationPhase, type CheckpointData, type CreationFlowEvent } from './novel-agents.js'

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
  ) {
    super()
  }

  async createChapterWithFlow(
    projectId: string,
    chapterNumber: number,
    options: CreationOptions,
  ): Promise<CreationResult> {
    try {
      // Phase 1: Director
      this.emitProgress(options, 'directing', { message: '导演 Agent 正在分析故事状态...' })
      const directorResult = await this.runAgent('director', projectId, {
        task: `请分析当前故事状态，为第 ${chapterNumber} 章规划叙事任务。`,
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
    // TODO: 集成 Pi SDK Session
    // 当前返回占位文本，实际 LLM 调用在集成 Pi SDK 后完成
    const config = NOVEL_AGENT_CONFIGS[agentType]
    const inputText = typeof input === 'string' ? input : JSON.stringify(input)

    // 临时实现：返回占位文本
    // 实际实现需要通过 createPiSession 创建 Session 并运行
    console.log(`[Novel] Running agent: ${config.name}, input: ${inputText.slice(0, 100)}...`)
    return `[${config.name}] 已处理请求。这是占位响应，实际 LLM 集成在后续实现。`
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
