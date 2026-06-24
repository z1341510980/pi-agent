import type { FastifyPluginAsync } from 'fastify'
import type { WebSocket } from '@fastify/websocket'
import type { ConfirmationRequest } from '../core/tool/confirmation-manager.js'

/** 客户端可发送的消息类型 */
type ClientMessage =
  | { type: 'confirmation_response'; payload: { id: string; approved: boolean } }
  | { type: 'ping' }

/** 服务端推送的消息类型 */
export type ServerMessage =
  | { type: 'confirmation_request'; payload: ConfirmationRequest }
  | { type: 'confirmation_resolved'; payload: { id: string; approved: boolean } }
  | { type: 'tool_execution'; payload: { phase: 'start' | 'end'; toolName: string; toolCallId: string } }
  | { type: 'pong' }
  | { type: 'connected'; payload: { threadId?: string } }
  | { type: 'notification'; payload: NotificationPayload }
  | { type: 'devlog'; payload: DevLogPayload }
  | { type: 'usage_update'; payload: UsageUpdatePayload }
  | { type: 'compaction'; payload: CompactionPayload }
  | { type: 'agent_status'; payload: AgentStatusPayload }
  | { type: 'context_update'; payload: ContextUpdatePayload }

/** 通知事件载荷 */
export interface NotificationPayload {
  id: string
  level: 'info' | 'success' | 'warning' | 'error'
  title: string
  message?: string
  category: 'system' | 'tool' | 'memory' | 'usage' | 'compaction' | 'agent'
  threadId?: string
  timestamp: number
}

/** DevLog 事件载荷 */
export interface DevLogPayload {
  id: string
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
  source?: string
  timestamp: number
}

/** 用量更新事件载荷 */
export interface UsageUpdatePayload {
  threadId?: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cost?: number
  timestamp: number
}

/** 压缩事件载荷 */
export interface CompactionPayload {
  threadId: string
  status: 'started' | 'completed' | 'failed'
  reason?: string
  durationMs?: number
  error?: string
  message?: string
  timestamp: number
}

/** Agent 状态变更事件载荷 */
export interface AgentStatusPayload {
  threadId?: string
  status: 'idle' | 'running' | 'thinking' | 'tool_calling' | 'error'
  message?: string
  timestamp: number
}

/** 上下文占用更新事件载荷 */
export interface ContextUpdatePayload {
  threadId?: string
  /** 当前上下文窗口实际占用的 token 数（来自 LLM 返回的 usage.totalTokens） */
  tokensUsed: number
  /** 本次调用输入 tokens */
  inputTokens: number
  /** 本次调用输出 tokens */
  outputTokens: number
  /** 当前使用的模型 */
  model: string
  /** 当前使用的 provider */
  provider: string
  /** 模型的上下文窗口大小（来自 modelRegistry） */
  contextWindow: number
  timestamp: number
}

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState !== socket.OPEN) return
  socket.send(JSON.stringify(msg))
}

/** 生成唯一 ID */
function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export const websocketRoute: FastifyPluginAsync = async (app) => {
  app.get('/ws', { websocket: true }, (socket, request) => {
    // 从查询参数提取 threadId（可选，用于过滤事件）
    const threadId = (request.query as { threadId?: string }).threadId

    // 发送连接成功事件
    send(socket, { type: 'connected', payload: { threadId } })

    // ── 推送：确认请求 ──
    const sendConfirmation = (payload: ConfirmationRequest): void => {
      if (threadId && payload.threadId !== threadId) return
      send(socket, { type: 'confirmation_request', payload })
    }
    app.eventBus.on('confirmation:request', sendConfirmation)

    // ── 推送：确认结果 ──
    const sendResolved = (payload: { id: string; approved: boolean }): void => {
      send(socket, { type: 'confirmation_resolved', payload })
    }
    app.eventBus.on('confirmation:resolved', sendResolved)

    // ── 推送：工具执行事件 ──
    const sendToolStart = (payload: { toolName: string; toolCallId: string }): void => {
      send(socket, { type: 'tool_execution', payload: { phase: 'start', ...payload } })
    }
    const sendToolEnd = (payload: { toolName: string; toolCallId: string }): void => {
      send(socket, { type: 'tool_execution', payload: { phase: 'end', ...payload } })
    }
    app.eventBus.on('tool:execution:start', sendToolStart)
    app.eventBus.on('tool:execution:end', sendToolEnd)

    // ── 推送：DevLog（日志事件）──
    const sendDevLog = (payload: { level: string; message: string; source?: string }): void => {
      const devLogPayload: DevLogPayload = {
        id: genId(),
        level: (['info', 'warn', 'error', 'debug'].includes(payload.level) ? payload.level : 'info') as DevLogPayload['level'],
        message: payload.message,
        source: payload.source,
        timestamp: Date.now(),
      }
      send(socket, { type: 'devlog', payload: devLogPayload })
    }
    // devlog:entry：统一 DevLog 事件（level 在 payload 中）
    app.eventBus.on('devlog:entry', sendDevLog)
    // 兼容 log:* 事件（level-specific，包装后转发到 sendDevLog）
    const onLogInfo = (p: { message: string; source?: string }): void => sendDevLog({ level: 'info', ...p })
    const onLogWarn = (p: { message: string; source?: string }): void => sendDevLog({ level: 'warn', ...p })
    const onLogError = (p: { message: string; source?: string }): void => sendDevLog({ level: 'error', ...p })
    const onLogDebug = (p: { message: string; source?: string }): void => sendDevLog({ level: 'debug', ...p })
    app.eventBus.on('log:info', onLogInfo)
    app.eventBus.on('log:warn', onLogWarn)
    app.eventBus.on('log:error', onLogError)
    app.eventBus.on('log:debug', onLogDebug)

    // ── 推送：通知事件（notification:push）──
    const sendNotification = (payload: {
      level: 'info' | 'success' | 'warning' | 'error'
      title: string
      message?: string
      category: 'system' | 'tool' | 'memory' | 'usage' | 'compaction' | 'agent'
      threadId?: string
    }): void => {
      if (threadId && payload.threadId && payload.threadId !== threadId) return
      const notification: NotificationPayload = {
        id: genId(),
        level: payload.level,
        title: payload.title,
        message: payload.message,
        category: payload.category,
        threadId: payload.threadId,
        timestamp: Date.now(),
      }
      send(socket, { type: 'notification', payload: notification })
    }
    app.eventBus.on('notification:push', sendNotification)

    // ── 推送：工具输出截断通知 ──
    const sendToolTruncated = (payload: { toolName: string; toolCallId: string; originalSize: number; truncatedSize: number }): void => {
      const notification: NotificationPayload = {
        id: genId(),
        level: 'warning',
        title: '工具输出已截断',
        message: `${payload.toolName} 输出从 ${payload.originalSize} 截断到 ${payload.truncatedSize}`,
        category: 'tool',
        threadId,
        timestamp: Date.now(),
      }
      send(socket, { type: 'notification', payload: notification })
    }
    app.eventBus.on('tool:output:truncated', sendToolTruncated)

    // ── 推送：Storm Breaker 检测 ──
    const sendStormDetected = (payload: { toolName: string; toolCallId: string; reason: string }): void => {
      const notification: NotificationPayload = {
        id: genId(),
        level: 'error',
        title: '检测到工具调用死循环',
        message: `${payload.toolName}: ${payload.reason}`,
        category: 'tool',
        threadId,
        timestamp: Date.now(),
      }
      send(socket, { type: 'notification', payload: notification })
    }
    app.eventBus.on('tool:storm:detected', sendStormDetected)

    // ── 推送：LLM 调用完成（实时用量，含 cost）──
    const sendLlmCallComplete = (payload: { threadId?: string; provider: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; cost?: number }): void => {
      if (threadId && payload.threadId && payload.threadId !== threadId) return
      const usagePayload: UsageUpdatePayload = {
        threadId: payload.threadId,
        provider: payload.provider,
        model: payload.model,
        inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens,
        cacheReadTokens: payload.cacheReadTokens,
        cacheWriteTokens: payload.cacheWriteTokens,
        cost: payload.cost,
        timestamp: Date.now(),
      }
      send(socket, { type: 'usage_update', payload: usagePayload })
    }
    // 订阅带 cost 的 usage:recorded 事件（由 usage-ledger.plugin 在记录后发射）
    app.eventBus.on('usage:recorded', sendLlmCallComplete)

    // ── 推送：记忆编译请求 ──
    const sendMemoryCompile = (payload: { threadId?: string; phase: string }): void => {
      if (threadId && payload.threadId && payload.threadId !== threadId) return
      const notification: NotificationPayload = {
        id: genId(),
        level: 'info',
        title: '记忆编译已触发',
        message: `阶段：${payload.phase}`,
        category: 'memory',
        threadId: payload.threadId,
        timestamp: Date.now(),
      }
      send(socket, { type: 'notification', payload: notification })
    }
    app.eventBus.on('memory:compile:requested', sendMemoryCompile)

    // ── 订阅：压缩事件 ──
    function sendCompactionStarted(payload: { threadId: string; reason: string; startedAt: number }) {
      const compaction: CompactionPayload = {
        threadId: payload.threadId,
        status: 'started',
        reason: payload.reason,
        timestamp: payload.startedAt,
      }
      send(socket, { type: 'compaction', payload: compaction })
    }
    function sendCompactionCompleted(payload: { threadId: string; reason: string; durationMs: number; result: unknown }) {
      const compaction: CompactionPayload = {
        threadId: payload.threadId,
        status: 'completed',
        reason: payload.reason,
        durationMs: payload.durationMs,
        timestamp: Date.now(),
      }
      send(socket, { type: 'compaction', payload: compaction })
    }
    function sendCompactionFailed(payload: { threadId: string; reason: string; error: string }) {
      const compaction: CompactionPayload = {
        threadId: payload.threadId,
        status: 'failed',
        reason: payload.reason,
        error: payload.error,
        timestamp: Date.now(),
      }
      send(socket, { type: 'compaction', payload: compaction })
    }
    app.eventBus.on('compaction:started', sendCompactionStarted)
    app.eventBus.on('compaction:completed', sendCompactionCompleted)
    app.eventBus.on('compaction:failed', sendCompactionFailed)

    // ── 推送：上下文占用更新（context:update）──
    const sendContextUpdate = (payload: { threadId?: string; tokensUsed: number; inputTokens: number; outputTokens: number; model: string; provider: string; contextWindow: number }): void => {
      if (threadId && payload.threadId && payload.threadId !== threadId) return
      const contextPayload: ContextUpdatePayload = {
        threadId: payload.threadId,
        tokensUsed: payload.tokensUsed,
        inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens,
        model: payload.model,
        provider: payload.provider,
        contextWindow: payload.contextWindow,
        timestamp: Date.now(),
      }
      send(socket, { type: 'context_update', payload: contextPayload })
    }
    app.eventBus.on('context:update', sendContextUpdate)

    // ── 接收：客户端消息 ──
    socket.on('message', (raw: Buffer) => {
      let msg: ClientMessage
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage
      } catch {
        return // 忽略无效 JSON
      }

      switch (msg.type) {
        case 'confirmation_response': {
          app.confirmationManager.respond(msg.payload.id, msg.payload.approved)
          break
        }
        case 'ping': {
          send(socket, { type: 'pong' })
          break
        }
      }
    })

    // ── 错误处理：防止 ECONNRESET 等网络错误导致进程崩溃 ──
    socket.on('error', (err: Error) => {
      app.log.warn({ err, threadId }, 'WebSocket 连接错误')
    })

    // ── 清理 ──
    socket.on('close', () => {
      app.eventBus.off('confirmation:request', sendConfirmation)
      app.eventBus.off('confirmation:resolved', sendResolved)
      app.eventBus.off('tool:execution:start', sendToolStart)
      app.eventBus.off('tool:execution:end', sendToolEnd)
      app.eventBus.off('tool:output:truncated', sendToolTruncated)
      app.eventBus.off('tool:storm:detected', sendStormDetected)
      app.eventBus.off('usage:recorded', sendLlmCallComplete)
      app.eventBus.off('memory:compile:requested', sendMemoryCompile)
      // 压缩事件
      app.eventBus.off('compaction:started', sendCompactionStarted)
      app.eventBus.off('compaction:completed', sendCompactionCompleted)
      app.eventBus.off('compaction:failed', sendCompactionFailed)
      // 上下文占用更新
      app.eventBus.off('context:update', sendContextUpdate)
      // DevLog 事件
      app.eventBus.off('devlog:entry', sendDevLog)
      app.eventBus.off('log:info', onLogInfo)
      app.eventBus.off('log:warn', onLogWarn)
      app.eventBus.off('log:error', onLogError)
      app.eventBus.off('log:debug', onLogDebug)
      // 通知事件
      app.eventBus.off('notification:push', sendNotification)
    })
  })
}
