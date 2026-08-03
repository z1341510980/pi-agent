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

/** 单个字符串字段的转发上限：大改动的 patch 能有几百 KB，塞进 SSE 会拖垮渲染 */
const MAX_DETAIL_STRING_CHARS = 64_000

/**
 * 裁剪工具结果 details 里的超长字符串。
 *
 * 返回 undefined 表示没有值得转发的内容（多数工具的 details 是 undefined）。
 * 被裁剪的字段会同时带一个 `<field>Truncated: true` 标记，让前端能显式说明
 * "这里被截断了"，而不是让用户以为 diff 就这么短。
 */
function truncateDetails(details: unknown): unknown {
  if (details == null) return undefined
  if (typeof details === 'string') {
    return details.length > MAX_DETAIL_STRING_CHARS
      ? details.slice(0, MAX_DETAIL_STRING_CHARS)
      : details
  }
  if (typeof details !== 'object') return details

  const source = details as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.length > MAX_DETAIL_STRING_CHARS) {
      result[key] = value.slice(0, MAX_DETAIL_STRING_CHARS)
      result[`${key}Truncated`] = true
    } else {
      result[key] = value
    }
  }
  return result
}

/**
 * StreamEmitter：Pi SDK 事件 → AG-UI 事件映射
 *
 * 选项：
 * - emitRaw: 是否发射 RAW 事件（默认 true，chat 用；novel 关闭以减少 SSE 噪声）
 */
export class StreamEmitter {
  private startedTextMessageId: string | null = null
  private completeAssistantText = ''
  private readonly toolActivityIdsByName = new Map<string, string[]>()

  constructor(
    private readonly emit: AgUiEventSink,
    private readonly assistantResponseMessageId: string,
    private readonly reasoningPipeline: ReasoningPipeline,
    private readonly options: { emitRaw?: boolean } = {},
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
    // agent_start 可能先于任何文本到达（例如 Reviser 只调用工具）。
    // 确保对应的占位气泡也能收到结束事件，不会永久停留在 streaming 状态。
    if (!this.startedTextMessageId) {
      this.startedTextMessageId = this.assistantResponseMessageId
      this.emit({
        type: EventType.TEXT_MESSAGE_START,
        messageId: this.startedTextMessageId,
        role: 'assistant',
      } as TextMessageStartEvent)
    }
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
    // RAW 事件默认开启（chat 用于调试），novel 关闭以减少 SSE 噪声
    if (this.options.emitRaw !== false) {
      this.emit({
        type: EventType.RAW,
        source: 'pi-session-event',
        event: safeSerializeForRawEvent(event),
      } as RawEvent)
    }

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

      /**
       * 真实 toolCallId 的下发。
       *
       * `STEP_STARTED` 的 AG-UI 形状里只有 `stepName`，装不下 id，于是前端只能
       * 自造一个 uuid，再靠「同名 + running」把 STEP_FINISHED 回配上去 ——
       * **同名工具并发调用时必然错配**（两个 read 同时跑，先结束的那个会被记到
       * 后开始的那个身上）。这里额外发一条带真实 id 的 CUSTOM 事件，
       * 前端优先用它建分段。
       */
      this.emit({
        type: EventType.CUSTOM,
        name: 'PI_TOOL_CALL_START',
        value: {
          toolCallId: event.toolCallId,
          toolName,
          args: safeSerializeForRawEvent(event.args),
          startedAt,
        },
      } as CustomEvent)

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

      // 与 PI_TOOL_CALL_START 配对，让前端能按真实 id 精确收尾
      this.emit({
        type: EventType.CUSTOM,
        name: 'PI_TOOL_CALL_END',
        value: {
          toolCallId: event.toolCallId,
          toolName,
          isError: event.isError === true,
          endedAt,
        },
      } as CustomEvent)

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

    /**
     * 工具结果的**结构化 details**。
     *
     * `tool_execution_update` 只带 `args` / `partialResult`（人可读文本），
     * 而 edit/write 工具真正有价值的东西在 `details` 里：`{ diff, patch,
     * firstChangedLine }`（见 pi-coding-agent 的 EditToolDetails）。
     * 不转发的话前端永远拿不到 diff，只能显示一段纯文本结果 —— 对一个
     * 会改代码的 Agent 来说，「改了什么」比「改成功了」重要得多。
     *
     * 只转发 details，不转发 content：content 的文本已经通过 partialResult
     * 到过前端，重复发一遍纯属浪费带宽。
     */
    if (eventType === 'tool_result') {
      // 先判空再序列化：safeSerializeForRawEvent(undefined) 会走进 catch 分支
      // 返回 `{ type: 'undefined', fallback: 'undefined' }`，那就不是"空"了
      if (event.details == null) return
      const details = truncateDetails(safeSerializeForRawEvent(event.details))
      if (details === undefined) return
      this.emit({
        type: EventType.CUSTOM,
        name: 'PI_TOOL_RESULT',
        value: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError === true,
          details,
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
