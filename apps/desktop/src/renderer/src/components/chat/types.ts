import type { AgentMessage } from '@repo/shared/agent'

/** 附件类型 */
export type AttachmentType = 'file' | 'image'

/** 文件附件 */
export interface FileAttachment {
  /** 唯一标识 */
  id: string
  /** 文件名 */
  name: string
  /** 文件路径（Electron 主进程路径） */
  path: string
  /** 文件大小（字节） */
  size: number
  /** 附件类型 */
  type: AttachmentType
  /** MIME 类型 */
  mimeType?: string
  /** 文件内容（文本或 base64） */
  content?: string
  /** 内容编码 */
  encoding?: 'utf-8' | 'base64'
  /** 图片缩略图（base64 data URL） */
  thumbnail?: string
}

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
  /** 文件附件列表 */
  attachments?: FileAttachment[]
}

/** 创建用户消息 */
export function createUserMessage(content: string, attachments?: FileAttachment[]): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content,
    createdAt: Date.now(),
    toolCalls: [],
    status: 'complete',
    attachments,
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
