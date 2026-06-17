import {
  EventType,
  type RunFinishedEvent,
  type RunStartedEvent,
  type RunErrorEvent,
  type MessagesSnapshotEvent,
  type ToolCallResultEvent,
} from '@ag-ui/core'
import { randomUUID } from 'node:crypto'
import type { AgUiEventSink } from '@repo/protocol/events'
import type { PiSessionStore } from './session-store.js'
import { StreamEmitter, emitSingleAssistantMessage } from './stream-emitter.js'
import { ReasoningPipeline } from './reasoning-pipeline.js'

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

/**
 * PiAgUiAgent：AG-UI 适配层核心类
 */
export class PiAgUiAgent {
  readonly agentId: string

  constructor(
    private readonly sessionStore: PiSessionStore,
    agentId = 'default',
  ) {
    this.agentId = agentId
  }

  async streamRun(
    input: StreamRunInput,
    emit: AgUiEventSink,
    runOptions: StreamRunOptions = {},
  ): Promise<void> {
    const threadId = input.threadId
    const runId = input.runId

    emit({
      type: EventType.RUN_STARTED,
      threadId,
      runId,
    } as RunStartedEvent)

    emit({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: input.messages,
    } as MessagesSnapshotEvent)

    const lastMessage = input.messages[input.messages.length - 1]
    if (lastMessage?.role === 'tool') {
      const toolCallId = (lastMessage as { toolCallId?: string }).toolCallId
      if (toolCallId) {
        emit({
          type: EventType.TOOL_CALL_RESULT,
          messageId: lastMessage.id,
          toolCallId,
          content: typeof lastMessage.content === 'string' ? lastMessage.content : JSON.stringify(lastMessage.content),
          role: 'tool',
        } as ToolCallResultEvent)
      }
    }

    try {
      const threadSession = await this.sessionStore.getOrCreate(threadId)

      const assistantResponseMessageId = randomUUID()
      const reasoningPipeline = new ReasoningPipeline(emit, assistantResponseMessageId)
      const streamEmitter = new StreamEmitter(
        emit,
        assistantResponseMessageId,
        reasoningPipeline,
      )

      const unsubscribe = threadSession.session.subscribe((event: Record<string, unknown>) => {
        streamEmitter.handleSessionEvent(event)
      })

      const abortHandler = () => {
        void threadSession.session.abort()
      }
      runOptions.signal?.addEventListener('abort', abortHandler, { once: true })

      try {
        const lastUserMessage = [...input.messages]
          .reverse()
          .find((m) => m.role === 'user')
        const userText = typeof lastUserMessage?.content === 'string'
          ? lastUserMessage.content
          : ''

        if (!userText) {
          emitSingleAssistantMessage(emit, '我需要一条用户消息才能继续。')
          emit({
            type: EventType.RUN_FINISHED,
            threadId,
            runId,
          } as RunFinishedEvent)
          return
        }

        await threadSession.session.prompt(userText)

        streamEmitter.finishTextMessage()

        const completeText = streamEmitter.getCompleteAssistantText()
        emit({
          type: EventType.RUN_FINISHED,
          threadId,
          runId,
          ...(completeText ? { result: completeText } : {}),
        } as RunFinishedEvent)
      } finally {
        unsubscribe()
        runOptions.signal?.removeEventListener('abort', abortHandler)
        threadSession.lastRunId = runId
        threadSession.lastAccessedAt = Date.now()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知 AG-UI 运行错误'
      emit({
        type: EventType.RUN_ERROR,
        message,
      } as RunErrorEvent)
    }
  }

  async steerThread(threadId: string, text: string): Promise<void> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    await threadSession.session.steer(text)
    threadSession.lastAccessedAt = Date.now()
  }

  async followUpThread(threadId: string, text: string): Promise<void> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    await threadSession.session.followUp(text)
    threadSession.lastAccessedAt = Date.now()
  }

  async forkThread(threadId: string, entryId: string): Promise<{ selectedText: string; cancelled: boolean }> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    const result = await threadSession.session.fork(entryId)
    threadSession.pendingToolCalls.clear()
    threadSession.lastAccessedAt = Date.now()
    return result
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
