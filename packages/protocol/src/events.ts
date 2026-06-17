/**
 * AG-UI 事件类型
 * 从 @ag-ui/core 重导出，提供项目统一的类型入口
 */
import type { BaseEvent } from '@ag-ui/core'

export {
  EventType,
  type BaseEvent,
  type RunStartedEvent,
  type RunFinishedEvent,
  type RunErrorEvent,
  type TextMessageStartEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type ToolCallStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type StepStartedEvent,
  type StepFinishedEvent,
  type StateSnapshotEvent,
  type MessagesSnapshotEvent,
  type ActivitySnapshotEvent,
  type ActivityDeltaEvent,
  type CustomEvent,
  type RawEvent,
  type ReasoningStartEvent,
  type ReasoningMessageStartEvent,
  type ReasoningMessageContentEvent,
  type ReasoningMessageEndEvent,
  type ReasoningEndEvent,
  type ThinkingStartEvent,
  type ThinkingEndEvent,
  type ThinkingTextMessageStartEvent,
  type ThinkingTextMessageContentEvent,
  type ThinkingTextMessageEndEvent,
  type Message,
  type RunAgentInput,
} from '@ag-ui/core'

/** AG-UI 事件接收器：接收 BaseEvent 的回调函数 */
export type AgUiEventSink = (event: BaseEvent) => void
