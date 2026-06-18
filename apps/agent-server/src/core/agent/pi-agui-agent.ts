import {
  EventType,
  type RunFinishedEvent,
  type RunStartedEvent,
  type RunErrorEvent,
  type MessagesSnapshotEvent,
  type ToolCallResultEvent
} from '@ag-ui/core'
import { randomUUID } from 'node:crypto'
import type { AgUiEventSink } from '@repo/protocol/events'
import type { PiSessionStore, PiThreadSession } from './session-store.js'
import { StreamEmitter, emitSingleAssistantMessage } from './stream-emitter.js'
import { ReasoningPipeline } from './reasoning-pipeline.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

/** streamRun 输入（宽松类型，兼容 @repo/protocol schema 输出） */
export interface StreamRunInput {
  threadId: string
  runId: string
  messages: Array<{
    id: string
    role: string
    content: string | unknown
    toolCallId?: string
  }>
}

export interface StreamRunOptions {
  signal?: AbortSignal
}

/** steer/follow-up 结果 */
export interface SteerResult {
  status: 'accepted' | 'no_active_run'
  threadId: string
}

/**
 * PiAgUiAgent：AG-UI 适配层核心类
 *
 * 关键不变量：
 * 1. 一次 streamRun 恰好发射一个终止事件（RUN_FINISHED 或 RUN_ERROR），之后不再发射任何事件
 * 2. abort 视为正常终止，发射 RUN_FINISHED（reason: 'aborted'），不发射 RUN_ERROR
 * 3. 同一 threadId 同时只允许一个活跃 run，并发 run 返回 409
 */
export class PiAgUiAgent {
  readonly agentId: string

  constructor(
    private readonly sessionStore: PiSessionStore,
    agentId = 'default'
  ) {
    this.agentId = agentId
  }

  async streamRun(
    input: StreamRunInput,
    emit: AgUiEventSink,
    runOptions: StreamRunOptions = {}
  ): Promise<void> {
    const threadId = input.threadId
    const runId = input.runId

    // 终止事件守卫：确保只发射一次
    let terminated = false
    const emitTermination = (event: RunFinishedEvent | RunErrorEvent) => {
      if (terminated) return
      terminated = true
      emit(event)
    }

    emit({
      type: EventType.RUN_STARTED,
      threadId,
      runId
    } as RunStartedEvent)

    emit({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: input.messages
    } as MessagesSnapshotEvent)

    const lastMessage = input.messages[input.messages.length - 1]
    if (lastMessage?.role === 'tool') {
      const toolCallId = (lastMessage as { toolCallId?: string }).toolCallId
      if (toolCallId) {
        emit({
          type: EventType.TOOL_CALL_RESULT,
          messageId: lastMessage.id,
          toolCallId,
          content:
            typeof lastMessage.content === 'string'
              ? lastMessage.content
              : JSON.stringify(lastMessage.content),
          role: 'tool'
        } as ToolCallResultEvent)
      }
    }

    // 同线程 run 互斥：尝试占用 activeRunId
    const acquired = this.sessionStore.tryAcquireRun(threadId, runId)
    if (!acquired) {
      emitTermination({
        type: EventType.RUN_ERROR,
        message: `线程 ${threadId} 已有活跃 run，请等待完成或中断后再试`
      } as RunErrorEvent)
      return
    }

    let threadSession: PiThreadSession | null = null
    let unsubscribe: (() => void) | null = null
    let abortHandler: (() => void) | null = null

    try {
      threadSession = await this.sessionStore.getOrCreate(threadId)

      const assistantResponseMessageId = randomUUID()
      const reasoningPipeline = new ReasoningPipeline(emit, assistantResponseMessageId)
      const streamEmitter = new StreamEmitter(emit, assistantResponseMessageId, reasoningPipeline)

      unsubscribe = threadSession.session.subscribe((event: Record<string, unknown>) => {
        streamEmitter.handleSessionEvent(event)
      })

      abortHandler = () => {
        void threadSession!.session.abort()
      }
      runOptions.signal?.addEventListener('abort', abortHandler, { once: true })

      const lastUserMessage = [...input.messages].reverse().find((m) => m.role === 'user')
      const userText = typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : ''

      if (!userText) {
        emitSingleAssistantMessage(emit, '我需要一条用户消息才能继续。')
        emitTermination({
          type: EventType.RUN_FINISHED,
          threadId,
          runId
        } as RunFinishedEvent)
        return
      }

      await threadSession.session.prompt(userText)

      // 正常完成：先关闭文本消息，再发射 RUN_FINISHED
      streamEmitter.finishTextMessage()

      const completeText = streamEmitter.getCompleteAssistantText()
      emitTermination({
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        ...(completeText ? { result: completeText } : {})
      } as RunFinishedEvent)
    } catch (error) {
      // abort 视为正常终止，发射 RUN_FINISHED 而非 RUN_ERROR
      if (runOptions.signal?.aborted) {
        emitTermination({
          type: EventType.RUN_FINISHED,
          threadId,
          runId,
          reason: 'aborted'
        } as RunFinishedEvent)
        return
      }

      const message = error instanceof Error ? error.message : '未知 AG-UI 运行错误'
      emitTermination({
        type: EventType.RUN_ERROR,
        message
      } as RunErrorEvent)
    } finally {
      // 清理资源顺序：移除 abort 监听 → 取消订阅 → 清理 pendingToolCalls → 释放 run 占用
      if (abortHandler && runOptions.signal) {
        runOptions.signal.removeEventListener('abort', abortHandler)
      }
      if (unsubscribe) {
        unsubscribe()
      }
      if (threadSession) {
        threadSession.pendingToolCalls.clear()
        threadSession.lastRunId = runId
        threadSession.lastAccessedAt = Date.now()
      }
      this.sessionStore.releaseRun(threadId, runId)
    }
  }

  async steerThread(threadId: string, text: string): Promise<SteerResult> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)

    // 无活跃 run 时，steer 无意义，返回状态标识
    if (!this.sessionStore.hasActiveRun(threadId)) {
      return { status: 'no_active_run', threadId }
    }

    try {
      await threadSession.session.steer(text)
      threadSession.lastAccessedAt = Date.now()
      return { status: 'accepted', threadId }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'steer 失败'
      throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, `Steer 失败: ${message}`, 500)
    }
  }

  async followUpThread(threadId: string, text: string): Promise<SteerResult> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)

    try {
      await threadSession.session.followUp(text)
      threadSession.lastAccessedAt = Date.now()
      return { status: 'accepted', threadId }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'follow-up 失败'
      throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, `Follow-up 失败: ${message}`, 500)
    }
  }

  async forkThread(
    threadId: string,
    entryId: string
  ): Promise<{ selectedText: string; cancelled: boolean }> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    const result = await threadSession.session.fork(entryId)
    threadSession.pendingToolCalls.clear()
    threadSession.lastAccessedAt = Date.now()
    return result
  }

  async navigateThread(
    threadId: string,
    targetId: string,
    options: { summarize?: boolean; customInstructions?: string } = {}
  ): Promise<Record<string, unknown>> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    const result = await threadSession.session.navigateTree(targetId, {
      summarize: options.summarize ?? true,
      ...(options.customInstructions ? { customInstructions: options.customInstructions } : {})
    })
    threadSession.lastAccessedAt = Date.now()
    return isRecord(result) ? result : { result }
  }

  async compactThread(threadId: string, customInstructions?: string): Promise<unknown> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    const result = await threadSession.session.compact(customInstructions)
    threadSession.lastAccessedAt = Date.now()
    return result
  }

  async getThreadTree(threadId: string): Promise<unknown[]> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    const tree = threadSession.session.sessionManager.getTree()
    threadSession.lastAccessedAt = Date.now()
    return tree
  }

  async getThreadModels(threadId: string): Promise<unknown[]> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    const models = threadSession.session.modelRegistry.getAvailable()
    threadSession.lastAccessedAt = Date.now()
    return models
  }

  async getThreadTools(threadId: string): Promise<{ tools: unknown[]; activeToolNames: string[] }> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    const tools = threadSession.session.getAllTools?.() ?? threadSession.session.tools ?? []
    const activeToolNames = threadSession.session.getActiveToolNames?.() ?? []
    threadSession.lastAccessedAt = Date.now()
    return { tools, activeToolNames }
  }

  async setThreadActiveTools(threadId: string, toolNames: string[]): Promise<string[]> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    if (threadSession.session.setActiveToolsByName) {
      threadSession.session.setActiveToolsByName(toolNames)
    }
    threadSession.lastAccessedAt = Date.now()
    return toolNames
  }

  async reloadThread(threadId: string): Promise<void> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    await threadSession.session.reload()
    threadSession.lastAccessedAt = Date.now()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
