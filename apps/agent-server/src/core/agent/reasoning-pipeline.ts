import {
  EventType,
  type CustomEvent,
  type ReasoningEndEvent,
  type ReasoningMessageEndEvent,
  type ReasoningMessageStartEvent,
  type ReasoningStartEvent,
  type ThinkingEndEvent,
  type ThinkingStartEvent,
  type ThinkingTextMessageEndEvent,
  type ThinkingTextMessageStartEvent,
} from '@ag-ui/core'
import { randomUUID } from 'node:crypto'
import type { AgUiEventSink } from '@repo/protocol/events'

export const REASONING_TARGET_MESSAGE_EVENT = 'REASONING_TARGET_MESSAGE'

/**
 * ReasoningPipeline：管理 thinking/reasoning 事件流
 */
export class ReasoningPipeline {
  private emittedReasoningTargetMessage = false
  private activeReasoningMessageId: string | null = null

  constructor(
    private readonly emit: AgUiEventSink,
    private readonly assistantResponseMessageId: string,
  ) {}

  ensureReasoningTargetMessage(): void {
    if (this.emittedReasoningTargetMessage) return
    this.emittedReasoningTargetMessage = true

    this.emit({
      type: EventType.CUSTOM,
      name: REASONING_TARGET_MESSAGE_EVENT,
      value: { messageId: this.assistantResponseMessageId },
    } as CustomEvent)
  }

  emitNativeReasoningStart(): string {
    this.ensureReasoningTargetMessage()

    const reasoningMessageId = randomUUID()
    this.activeReasoningMessageId = reasoningMessageId

    this.emit({
      type: EventType.REASONING_START,
      messageId: reasoningMessageId,
    } as ReasoningStartEvent)

    this.emit({
      type: EventType.REASONING_MESSAGE_START,
      messageId: reasoningMessageId,
      role: 'reasoning',
    } as ReasoningMessageStartEvent)

    this.emit({
      type: EventType.THINKING_START,
    } as ThinkingStartEvent)

    this.emit({
      type: EventType.THINKING_TEXT_MESSAGE_START,
    } as ThinkingTextMessageStartEvent)

    return reasoningMessageId
  }

  ensureNativeReasoningStart(): string {
    if (this.activeReasoningMessageId) {
      return this.activeReasoningMessageId
    }
    return this.emitNativeReasoningStart()
  }

  emitNativeReasoningEnd(): void {
    const reasoningMessageId = this.ensureNativeReasoningStart()

    this.emit({
      type: EventType.REASONING_MESSAGE_END,
      messageId: reasoningMessageId,
    } as ReasoningMessageEndEvent)

    this.emit({
      type: EventType.THINKING_TEXT_MESSAGE_END,
    } as ThinkingTextMessageEndEvent)

    this.emit({
      type: EventType.REASONING_END,
      messageId: reasoningMessageId,
    } as ReasoningEndEvent)

    this.emit({
      type: EventType.THINKING_END,
    } as ThinkingEndEvent)

    this.activeReasoningMessageId = null
  }

  emitReasoningCompatEvent(
    name:
      | 'REASONING_START'
      | 'REASONING_TEXT_MESSAGE_START'
      | 'REASONING_TEXT_MESSAGE_CONTENT'
      | 'REASONING_TEXT_MESSAGE_END'
      | 'REASONING_END',
    value?: Record<string, unknown>,
  ): void {
    this.emit({
      type: EventType.CUSTOM,
      name,
      ...(value ? { value } : {}),
    } as CustomEvent)
  }
}
