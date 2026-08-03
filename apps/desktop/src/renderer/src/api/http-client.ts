import type { ApiResponse } from '@repo/shared/api'
import { browserConfig } from '@repo/config/browser'
export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly traceId?: string,
    public readonly details?: unknown
  ) {
    super(message)
    this.name = 'ApiClientError'
  }
}

/**
 * 安全解析 JSON 响应体，避免非 JSON 响应导致 SyntaxError
 */
async function safeParseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/**
 * 从 AG-UI 裸 JSON 错误响应中提取错误信息
 */
function extractAguiErrorMessage(body: unknown, fallbackStatus: number): { message: string; details?: unknown } {
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>
    // 后端 AppError 格式：{ error: { message, code, details } }
    if (obj.error && typeof obj.error === 'object') {
      const err = obj.error as Record<string, unknown>
      if (typeof err.message === 'string') {
        return { message: err.message, details: err.details }
      }
    }
    // 直接有 message 字段
    if (typeof obj.message === 'string') {
      return { message: obj.message, details: obj }
    }
  }
  return { message: `AG-UI 请求失败: HTTP ${fallbackStatus}` }
}

/**
 * 调用后端 API（返回 ApiResponse 包装格式：{ ok, data, error, meta }）
 * 适用于 /api/* 路由
 */
export async function getApi<T>(path: string): Promise<T> {
  const response = await fetch(`${browserConfig.apiBaseUrl}${path}`, {
    method: 'GET'
  })

  const body = (await safeParseJson(response)) as ApiResponse<T> | null

  if (!body) {
    throw new ApiClientError(
      `API 请求失败: HTTP ${response.status} ${response.statusText}`,
      'API_ERROR'
    )
  }

  if (!body.ok) {
    const errorMsg = body.error?.message ?? `API 请求失败: HTTP ${response.status}`
    throw new ApiClientError(
      errorMsg,
      body.error?.code ?? 'API_ERROR',
      body.meta?.traceId,
      body.error?.details
    )
  }

  return body.data
}

/**
 * 调用 AG-UI 端点（返回裸 JSON，无 ApiResponse 包装）
 * 适用于 /ag-ui/* 路由
 */
export async function getAgui<T>(path: string): Promise<T> {
  const response = await fetch(`${browserConfig.aguiBaseUrl}${path}`, {
    method: 'GET'
  })

  if (!response.ok) {
    const body = await safeParseJson(response)
    const { message, details } = extractAguiErrorMessage(body, response.status)
    throw new ApiClientError(message, 'AGUI_ERROR', undefined, details)
  }

  return (await response.json()) as T
}

/**
 * POST 调用 AG-UI 端点（返回裸 JSON，无 ApiResponse 包装）
 * 适用于 /ag-ui/* 路由
 */
export async function postAgui<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${browserConfig.aguiBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const body = await safeParseJson(response)
    const { message, details } = extractAguiErrorMessage(body, response.status)
    throw new ApiClientError(message, 'AGUI_ERROR', undefined, details)
  }

  return (await response.json()) as T
}

export async function putApi<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${browserConfig.apiBaseUrl}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const body = (await safeParseJson(response)) as ApiResponse<T> | null

  if (!body) {
    throw new ApiClientError(
      `API 请求失败: HTTP ${response.status} ${response.statusText}`,
      'API_ERROR'
    )
  }

  if (!body.ok) {
    const errorMsg = body.error?.message ?? `API 请求失败: HTTP ${response.status}`
    throw new ApiClientError(
      errorMsg,
      body.error?.code ?? 'API_ERROR',
      body.meta?.traceId,
      body.error?.details
    )
  }

  return body.data
}

export async function patchApi<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${browserConfig.apiBaseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const body = (await safeParseJson(response)) as ApiResponse<T> | null

  if (!body) {
    throw new ApiClientError(
      `API 请求失败: HTTP ${response.status} ${response.statusText}`,
      'API_ERROR'
    )
  }

  if (!body.ok) {
    const errorMsg = body.error?.message ?? `API 请求失败: HTTP ${response.status}`
    throw new ApiClientError(
      errorMsg,
      body.error?.code ?? 'API_ERROR',
      body.meta?.traceId,
      body.error?.details
    )
  }

  return body.data
}

export async function deleteApi<T>(path: string): Promise<T> {
  const response = await fetch(`${browserConfig.apiBaseUrl}${path}`, {
    method: 'DELETE'
  })

  const body = (await safeParseJson(response)) as ApiResponse<T> | null

  if (!body) {
    throw new ApiClientError(
      `API 请求失败: HTTP ${response.status} ${response.statusText}`,
      'API_ERROR'
    )
  }

  if (!body.ok) {
    const errorMsg = body.error?.message ?? `API 请求失败: HTTP ${response.status}`
    throw new ApiClientError(
      errorMsg,
      body.error?.code ?? 'API_ERROR',
      body.meta?.traceId,
      body.error?.details
    )
  }

  return body.data
}

export async function postApi<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${browserConfig.apiBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const body = (await safeParseJson(response)) as ApiResponse<T> | null

  if (!body) {
    throw new ApiClientError(
      `API 请求失败: HTTP ${response.status} ${response.statusText}`,
      'API_ERROR'
    )
  }

  if (!body.ok) {
    const errorMsg = body.error?.message ?? `API 请求失败: HTTP ${response.status}`
    throw new ApiClientError(
      errorMsg,
      body.error?.code ?? 'API_ERROR',
      body.meta?.traceId,
      body.error?.details
    )
  }

  return body.data
}

// ── Agent 相关 API 类型 ──

/** Agent 配置（与后端 AgentConfig 对齐） */
export interface AgentInfo {
  id: string
  name: string
  description?: string
  model?: { provider: string; modelId: string }
  systemPrompt?: string
  tools?: string[]
  temperature?: number
}

// ── 会话消息分页 API 类型 ──

/**
 * 会话 JSONL 里的内容块。
 *
 * 来自 `@earendil-works/pi-ai`：user 消息是 `string | (text|image)[]`，
 * assistant 是 `(text|thinking|toolCall)[]`，toolResult 是 `(text|image)[]`。
 */
export type SessionContentBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string; redacted?: boolean }
  | { type: 'toolCall'; id?: string; name?: string; arguments?: Record<string, unknown> }
  | { type: 'image'; data?: string; mimeType?: string }
  | { type: string; [key: string]: unknown }

/** JSONL 里 `type: 'message'` 条目携带的实际消息体 */
export interface SessionMessagePayload {
  role?: 'user' | 'assistant' | 'toolResult' | string
  content?: string | SessionContentBlock[]
  /** 毫秒时间戳 */
  timestamp?: number
  stopReason?: string
  /** role === 'toolResult' 时指向对应的 toolCall */
  toolCallId?: string
  toolName?: string
  isError?: boolean
  errorMessage?: string
  /** role === 'toolResult' 时的结构化细节（edit/write 的 diff / patch 就在这里） */
  details?: unknown
  [key: string]: unknown
}

/**
 * 单条会话条目。
 *
 * 注意这是**会话事件日志**的条目，不是消息本身 —— 真正的消息在 `message` 字段里。
 * 后端 `session-reader` 已经过滤掉了非 `type: 'message'` 的条目。
 */
export interface SessionMessageEntry {
  /** 条目 ID（entry 级，不是消息级） */
  id?: string
  type?: string
  parentId?: string | null
  /** ISO 时间戳（entry 级） */
  timestamp?: string
  message?: SessionMessagePayload
  [key: string]: unknown
}

/** 分页消息响应 */
export interface PaginatedMessages {
  /** 倒序的消息条目（最新在前） */
  messages: SessionMessageEntry[]
  /** 下一页游标（行号）；null 表示已到顶部 */
  nextCursor: number | null
  /** 是否还有更早的消息 */
  hasMore: boolean
}

/** 频道信息 */
export interface ChannelInfo {
  name: string
  subscribers: string[]
  messageCount: number
}

/** 频道消息 */
export interface ChannelMessage {
  channel: string
  fromAgentId: string
  content: unknown
  timestamp: number
  id: string
}

/** 私信消息 */
export interface DmMessage {
  fromAgentId: string
  toAgentId: string
  content: unknown
  timestamp: number
  id: string
}

/** subagent 派遣结果 */
export interface DispatchResult {
  agentId: string
  task: string
  result: string
  success: boolean
  error?: string
  durationMs: number
  depth: number
}

/** 并发限流器状态 */
export interface LimiterStats {
  activeCount: number
  totalCount: number
  queueLength: number
}

// ── Agent API 方法 ──

/** 获取所有可用 Agent 列表 */
export async function getAgents(): Promise<AgentInfo[]> {
  return getApi<AgentInfo[]>('/api/agents')
}

/** 创建 Agent（持久化到 SQLite） */
export async function createAgent(agent: AgentInfo): Promise<AgentInfo> {
  return postApi<AgentInfo>('/api/agents', agent)
}

/** 更新 Agent 配置 */
export async function updateAgent(id: string, patch: Partial<AgentInfo>): Promise<AgentInfo> {
  return putApi<AgentInfo>(`/api/agents/${id}`, patch)
}

/** 删除 Agent */
export async function deleteAgent(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`/api/agents/${id}`)
}

/** 获取并发限流器状态 */
export async function getLimiterStats(): Promise<LimiterStats> {
  return getApi<LimiterStats>('/api/agents/limiter/stats')
}

/** 获取所有频道 */
export async function getAgentChannels(): Promise<ChannelInfo[]> {
  return getApi<ChannelInfo[]>('/api/agents/channels')
}

/** 发送频道消息 */
export async function sendChannelMessage(
  agentId: string,
  channel: string,
  content: unknown,
): Promise<{ channel: string; fromAgentId: string; deliveredTo: string[] }> {
  return postApi(`/api/agents/${agentId}/channel`, { channel, content })
}

/** 发送私信 */
export async function sendDirectMessage(
  agentId: string,
  toAgentId: string,
  content: unknown,
): Promise<{ fromAgentId: string; toAgentId: string; sent: boolean }> {
  return postApi(`/api/agents/${agentId}/dm`, { toAgentId, content })
}

/** 派遣子任务 */
export async function dispatchSubtask(
  agentId: string,
  task: string,
  timeout?: number,
): Promise<DispatchResult> {
  return postApi<DispatchResult>(`/api/agents/${agentId}/dispatch`, {
    task,
    timeout,
  })
}

/** 获取频道消息历史 */
export async function getChannelMessages(
  channelName: string,
): Promise<ChannelMessage[]> {
  return getApi<ChannelMessage[]>(
    `/api/agents/channels/${encodeURIComponent(channelName)}/messages`,
  )
}

/** 获取 Agent 私信历史 */
export async function getDirectMessages(
  agentId: string,
): Promise<DmMessage[]> {
  return getApi<DmMessage[]>(`/api/agents/${agentId}/dm`)
}

/** 订阅 Agent 到频道 */
export async function subscribeAgentToChannel(
  agentId: string,
  channel: string,
): Promise<{ agentId: string; channel: string; subscribed: boolean }> {
  return postApi(`/api/agents/${agentId}/subscribe`, { channel })
}

// ── 会话消息分页 API 方法 ──

/**
 * 按行号游标分页读取会话消息（最新在前）
 *
 * @param threadId 会话 ID
 * @param options.before 上一页返回的 nextCursor；首次加载省略
 * @param options.limit  单次返回上限，默认 30，最大 100
 */
export async function getSessionMessages(
  threadId: string,
  options?: { before?: number; limit?: number },
): Promise<PaginatedMessages> {
  const params = new URLSearchParams()
  if (options?.before != null) params.set('before', String(options.before))
  if (options?.limit != null) params.set('limit', String(options.limit))
  const qs = params.toString()
  return getApi<PaginatedMessages>(
    `/api/sessions/${encodeURIComponent(threadId)}/messages${qs ? `?${qs}` : ''}`,
  )
}

/** 待处理的工具执行确认请求（与 use-websocket 的 ConfirmationRequestPayload 同构） */
export interface PendingConfirmation {
  id: string
  threadId: string
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  reason: string
  createdAt: number
}

/**
 * 拉取尚未处理的确认请求。
 *
 * 确认请求原来只通过 WebSocket 的 `confirmation_request` 推送，一旦刷新页面或
 * 断线重连，正在等待的审批就从界面上消失了 —— 而后端那边 Agent 还在阻塞等回答，
 * 表现就是「卡住不动了」。这个接口用于挂载与重连时把它们捞回来。
 */
export async function getPendingConfirmations(): Promise<PendingConfirmation[]> {
  const data = await getApi<{ pending: PendingConfirmation[] }>('/api/confirmations')
  return data.pending ?? []
}
