import type { AgentMessage } from '@repo/shared/agent'

/** 工具调用信息 */
export interface ToolCallInfo {
  toolCallId: string
  toolName: string
  args?: unknown
  partialResult?: unknown
  status: 'pending' | 'running' | 'success' | 'error'
  startedAt?: number
  endedAt?: number
}

/** 思考块 */
export interface ThinkingBlock {
  content: string
  isStreaming: boolean
}

/** 聊天消息（扩展 AgentMessage，增加流式状态） */
export interface ChatMessage extends AgentMessage {
  /** 流式文本缓冲（TEXT_MESSAGE_CONTENT 累积） */
  streamingBuffer?: string
  /** 思考块（REASONING_/THINKING_ 事件） */
  thinking?: ThinkingBlock
  /** 工具调用列表 */
  toolCalls: ToolCallInfo[]
  /** 消息状态 */
  status: 'complete' | 'streaming' | 'error'
  /** 错误信息（status === 'error' 时） */
  error?: string
  /** 关联的 runId */
  runId?: string
}

/** 创建用户消息 */
export function createUserMessage(content: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content,
    createdAt: Date.now(),
    toolCalls: [],
    status: 'complete',
  }
}

/** 创建空的助手消息（流式开始时） */
export function createAssistantMessage(runId: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
    toolCalls: [],
    status: 'streaming',
    runId,
  }
}
