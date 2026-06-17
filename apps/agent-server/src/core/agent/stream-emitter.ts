import {
  EventType,
  type ActivityDeltaEvent,
  type ActivitySnapshotEvent,
  type CustomEvent,
  type RawEvent,
  type StepFinishedEvent,
  type StepStartedEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
  type ReasoningMessageContentEvent,
  type ThinkingTextMessageContentEvent,
} from '@ag-ui/core'
import { randomUUID } from 'node:crypto'
import type { AgUiEventSink } from '@repo/protocol/events'
import type { ReasoningPipeline } from './reasoning-pipeline.js'

function safeSerializeForRawEvent(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack }
    }
    return { type: typeof value, fallback: String(value) }
  }
}

/**
 * StreamEmitter：Pi SDK 事件 → AG-UI 事件映射
 */
export class StreamEmitter {
  private startedTextMessageId: string | null = null
  private completeAssistantText = ''
  private readonly toolActivityIdsByName = new Map<string, string[]>()

  constructor(
    private readonly emit: AgUiEventSink,
    private readonly assistantResponseMessageId: string,
    private readonly reasoningPipeline: ReasoningPipeline,
  ) {}

  private ensureTextStarted(): string {
    if (this.startedTextMessageId) {
      return this.startedTextMessageId
    }

    this.reasoningPipeline.ensureReasoningTargetMessage()
    this.startedTextMessageId = this.assistantResponseMessageId
    this.emit({
      type: EventType.TEXT_MESSAGE_START,
      messageId: this.startedTextMessageId,
      role: 'assistant',
    } as TextMessageStartEvent)
    return this.startedTextMessageId
  }

  emitTextChunk(chunk: string): void {
    if (!chunk.length) return
    const messageId = this.ensureTextStarted()
    this.emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: chunk,
    } as TextMessageContentEvent)
  }

  finishTextMessage(): void {
    if (!this.startedTextMessageId) return
    this.emit({
      type: EventType.TEXT_MESSAGE_END,
      messageId: this.startedTextMessageId,
    } as TextMessageEndEvent)
    this.startedTextMessageId = null
  }

  getCompleteAssistantText(): string {
    return this.completeAssistantText
  }

  handleSessionEvent(event: Record<string, unknown>): void {
    this.emit({
      type: EventType.RAW,
      source: 'pi-session-event',
      event: safeSerializeForRawEvent(event),
    } as RawEvent)

    const eventType = event.type as string

    if (eventType === 'tool_execution_start') {
      const startedAt = Date.now()
      const activityMessageId = randomUUID()
      const toolName = (event.toolName as string) ?? 'unknown'

      const existingActivityIds = this.toolActivityIdsByName.get(toolName) ?? []
      this.toolActivityIdsByName.set(toolName, [...existingActivityIds, activityMessageId])

      this.emit({
        type: EventType.STEP_STARTED,
        stepName: `pi:${toolName}`,
      } as StepStartedEvent)

      this.emit({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: activityMessageId,
        activityType: 'pi:tool_execution',
        content: { toolName, status: 'running', startedAt },
        replace: true,
      } as ActivitySnapshotEvent)
      return
    }

    if (eventType === 'tool_execution_end') {
      const endedAt = Date.now()
      const toolName = (event.toolName as string) ?? 'unknown'

      const existingActivityIds = this.toolActivityIdsByName.get(toolName) ?? []
      const activityMessageId = existingActivityIds.pop()

      if (existingActivityIds.length) {
        this.toolActivityIdsByName.set(toolName, existingActivityIds)
      } else {
        this.toolActivityIdsByName.delete(toolName)
      }

      this.emit({
        type: EventType.STEP_FINISHED,
        stepName: `pi:${toolName}`,
      } as StepFinishedEvent)

      if (activityMessageId) {
        this.emit({
          type: EventType.ACTIVITY_DELTA,
          messageId: activityMessageId,
          activityType: 'pi:tool_execution',
          patch: [
            { op: 'replace', path: '/status', value: 'finished' },
            { op: 'add', path: '/endedAt', value: endedAt },
          ],
        } as ActivityDeltaEvent)
      }
      return
    }

    if (eventType === 'tool_execution_update') {
      this.emit({
        type: EventType.CUSTOM,
        name: 'PI_TOOL_EXECUTION_UPDATE',
        value: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: safeSerializeForRawEvent(event.args),
          partialResult: safeSerializeForRawEvent(event.partialResult),
        },
      } as CustomEvent)
      return
    }

    if (eventType !== 'message_update') return

    const assistantMessageEvent = event.assistantMessageEvent as Record<string, unknown> | undefined
    if (!assistantMessageEvent) return

    const subType = assistantMessageEvent.type as string

    if (subType === 'thinking_start') {
      this.reasoningPipeline.emitNativeReasoningStart()
      return
    }

    if (subType === 'thinking_delta') {
      const delta = (assistantMessageEvent.delta as string) ?? ''
      if (!delta.length) return

      const reasoningMessageId = this.reasoningPipeline.ensureNativeReasoningStart()

      this.emit({
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: reasoningMessageId,
        delta,
      } as ReasoningMessageContentEvent)

      this.emit({
        type: EventType.THINKING_TEXT_MESSAGE_CONTENT,
        delta,
      } as ThinkingTextMessageContentEvent)

      this.reasoningPipeline.emitReasoningCompatEvent('REASONING_TEXT_MESSAGE_CONTENT', { delta })
      return
    }

    if (subType === 'thinking_end') {
      this.reasoningPipeline.emitNativeReasoningEnd()
      return
    }

    if (subType === 'text_delta') {
      const delta = (assistantMessageEvent.delta as string) ?? ''
      if (!delta.length) return

      this.completeAssistantText += delta
      this.emitTextChunk(delta)
    }
  }
}

export function emitSingleAssistantMessage(emit: AgUiEventSink, text: string): void {
  const messageId = randomUUID()
  emit({
    type: EventType.TEXT_MESSAGE_START,
    messageId,
    role: 'assistant',
  } as TextMessageStartEvent)

  emit({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId,
    delta: text,
  } as TextMessageContentEvent)

  emit({
    type: EventType.TEXT_MESSAGE_END,
    messageId,
  } as TextMessageEndEvent)
}
