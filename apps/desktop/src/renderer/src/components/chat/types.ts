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

/**
 * 工具结果的结构化细节。
 *
 * 目前只有 edit/write 类工具会产出（对应 pi-coding-agent 的 EditToolDetails）。
 * 由后端 stream-emitter 的 `PI_TOOL_RESULT` 事件转发。
 */
export interface ToolResultDetails {
  /** 带行号的展示型 diff */
  diff?: string
  /** 标准 unified patch */
  patch?: string
  /** 新文件里第一处改动的行号，用于跳转 */
  firstChangedLine?: number
  /** diff 字段是否被后端截断（超长 patch 会截） */
  diffTruncated?: boolean
  patchTruncated?: boolean
  [key: string]: unknown
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
  /** 结构化结果细节（diff / patch 等） */
  details?: ToolResultDetails
}

/** 思考块 */
export interface ThinkingBlock {
  content: string
  isStreaming: boolean
  /** 思考开始时间戳（ms） */
  startedAt?: number
  /** 思考结束时间戳（ms）；流式时为 undefined */
  endedAt?: number
}

// ── 有序分段 ────────────────────────────────────────────────────────

/**
 * 消息分段。
 *
 * ## 为什么需要
 *
 * 之前的模型是「扁平 `content` 字符串 + 旁挂 `thinking` + 旁挂 `toolCalls`」三通道，
 * 渲染顺序在 message-bubble 里硬编码成 thinking → tools → markdown。
 * 这表达不了 agent 长回答的常态：
 *
 * > 「我先看一下这个文件」→ 调 read → 「里面确实有问题，我改一下」→ 调 edit →
 * > 「改完了，另外还有一处」→ 调 edit → 总结
 *
 * 旧模型渲染出来会变成：所有工具卡挤在最上面，全部文字挤在最下面 —— 读者完全
 * 无法知道哪句话对应哪次调用。
 *
 * ## 为什么不用 AionUi 的「一轮 = 多条兄弟消息」
 *
 * AionUi 靠 `msg_id` 归并 + 扁平列表里的多条消息表达交错。那个方案要求消息列表
 * 本身承担排序职责，会波及 store、分页合并、去重、hover 工具栏的「每轮一行」判定。
 * pi-agent 一轮只对应一条 assistant 消息，把顺序收进消息内部的 `segments`
 * 改动面小得多，且天然不会和分页去重打架。
 */

export interface TextSegment {
  kind: 'text'
  id: string
  text: string
}

export interface ThinkingSegment {
  kind: 'thinking'
  id: string
  content: string
  isStreaming: boolean
  startedAt?: number
  endedAt?: number
}

export interface ToolSegment {
  kind: 'tool'
  id: string
  call: ToolCallInfo
}

export type MessageSegment = TextSegment | ThinkingSegment | ToolSegment

/** 聊天消息（扩展 AgentMessage，增加流式状态与有序分段） */
export interface ChatMessage extends AgentMessage {
  /**
   * 有序分段：**渲染顺序 = 实际发生顺序**。
   *
   * `content` 仍然保留（属于 AgentMessage，且复制/引用/持久化都用它），
   * 但它是文本分段的拼接结果，不是独立事实来源。
   */
  segments: MessageSegment[]
  /** 消息状态 */
  status: 'complete' | 'streaming' | 'error'
  /** 错误信息（status === 'error' 时） */
  error?: string
  /** 关联的 runId */
  runId?: string
  /** 文件附件列表 */
  attachments?: FileAttachment[]
}

// ── 分段工具函数 ────────────────────────────────────────────────────

let segmentSeq = 0
/** 分段 id：只用于 React key，不需要全局唯一，递增即可 */
export function nextSegmentId(prefix: string): string {
  segmentSeq += 1
  return `${prefix}-${segmentSeq}`
}

/** 兜底用的共享空数组：避免每次读到畸形消息都新建对象，破坏 useMemo 的引用比较 */
const NO_SEGMENTS: readonly MessageSegment[] = []

/**
 * 安全读取 `segments`。
 *
 * 类型上 `segments` 是必填数组，但运行时未必：曾经有一版把 `sessionMessages` 写进
 * localStorage，那时的 `ChatMessage` 还是旧模型（旁挂 `toolCalls`，没有 `segments`），
 * 这些快照 rehydrate 回来就是一批"缺 segments 的消息"。
 * session-store 的 v1 migrate 已经在源头清掉了它们，这里是第二道防线 ——
 * 一条畸形消息不该让整个聊天区白屏，而它必然是从这些纯函数入口进来的。
 *
 * 导出是为了让渲染路径（message-bubble / streaming-indicator）复用同一个收口，
 * 而不是各写一遍 `Array.isArray`。
 */
export function readSegments(message: ChatMessage): readonly MessageSegment[] {
  return Array.isArray(message.segments) ? message.segments : NO_SEGMENTS
}

/** 拼接所有文本分段 —— 复制、引用、持久化用的就是这个 */
export function segmentsToText(segments: MessageSegment[]): string {
  let text = ''
  for (const segment of segments) {
    if (segment.kind === 'text') text += segment.text
  }
  return text
}

/** 摊平出所有工具调用（关联文件提取、工具执行面板等需要平铺列表） */
export function collectToolCalls(message: ChatMessage): ToolCallInfo[] {
  const calls: ToolCallInfo[] = []
  for (const segment of readSegments(message)) {
    if (segment.kind === 'tool') calls.push(segment.call)
  }
  return calls
}

/** 取最后一个思考分段（流式指示器判断「是否在思考」用） */
export function lastThinkingSegment(message: ChatMessage): ThinkingSegment | undefined {
  const segments = readSegments(message)
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]
    if (segment.kind === 'thinking') return segment
  }
  return undefined
}

/**
 * 把 delta 追加到末尾的文本分段。
 *
 * 末尾**不是**文本分段时新开一个 —— 这正是交错的实现点：中间插过一次工具调用后，
 * 后续文字会落到新的文本分段里，从而排在工具卡之后。
 */
export function appendText(segments: MessageSegment[], delta: string): MessageSegment[] {
  const last = segments[segments.length - 1]
  if (last?.kind === 'text') {
    return [...segments.slice(0, -1), { ...last, text: last.text + delta }]
  }
  return [...segments, { kind: 'text', id: nextSegmentId('text'), text: delta }]
}

/** 把 delta 追加到末尾的**流式中**思考分段；否则新开一个 */
export function appendThinking(
  segments: MessageSegment[],
  delta: string,
  now: number,
): MessageSegment[] {
  const last = segments[segments.length - 1]
  if (last?.kind === 'thinking' && last.isStreaming) {
    return [...segments.slice(0, -1), { ...last, content: last.content + delta }]
  }
  return [
    ...segments,
    {
      kind: 'thinking',
      id: nextSegmentId('thinking'),
      content: delta,
      isStreaming: true,
      startedAt: now,
    },
  ]
}

/** 关闭所有仍在流式的思考分段 */
export function closeThinking(segments: MessageSegment[], now: number): MessageSegment[] {
  let changed = false
  const next = segments.map((segment) => {
    if (segment.kind === 'thinking' && segment.isStreaming) {
      changed = true
      return { ...segment, isStreaming: false, endedAt: segment.endedAt ?? now }
    }
    return segment
  })
  return changed ? next : segments
}

/** 追加一个工具分段 */
export function appendToolCall(segments: MessageSegment[], call: ToolCallInfo): MessageSegment[] {
  return [...segments, { kind: 'tool', id: nextSegmentId('tool'), call }]
}

/**
 * 就地更新某个工具分段。
 *
 * `match` 返回 true 的**第一个**分段被更新 —— 遍历方向由 `fromEnd` 决定：
 * 结束/结果类事件要从后往前找（最近一次调用），避免命中更早的同名调用。
 */
export function updateToolCall(
  segments: MessageSegment[],
  match: (call: ToolCallInfo) => boolean,
  patch: (call: ToolCallInfo) => ToolCallInfo,
  fromEnd = true,
): MessageSegment[] {
  const indices = segments.map((_, i) => i)
  const order = fromEnd ? indices.reverse() : indices
  for (const i of order) {
    const segment = segments[i]
    if (segment.kind !== 'tool') continue
    if (!match(segment.call)) continue
    const next = [...segments]
    next[i] = { ...segment, call: patch(segment.call) }
    return next
  }
  return segments
}

/** 创建用户消息 */
export function createUserMessage(content: string, attachments?: FileAttachment[]): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content,
    createdAt: Date.now(),
    segments: content ? [{ kind: 'text', id: nextSegmentId('text'), text: content }] : [],
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
    segments: [],
    status: 'streaming',
    runId,
  }
}
