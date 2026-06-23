import { useEffect, useRef, useState, useCallback } from 'react'
import { browserConfig } from '@repo/config/browser'

/** 服务端推送的消息类型 */
export type ServerMessage =
  | { type: 'confirmation_request'; payload: ConfirmationRequestPayload }
  | { type: 'confirmation_resolved'; payload: { id: string; approved: boolean } }
  | { type: 'tool_execution'; payload: { phase: 'start' | 'end'; toolName: string; toolCallId: string } }
  | { type: 'pong' }
  | { type: 'connected'; payload: { threadId?: string } }
  | { type: 'notification'; payload: NotificationPayload }
  | { type: 'devlog'; payload: DevLogPayload }
  | { type: 'usage_update'; payload: UsageUpdatePayload }
  | { type: 'compaction'; payload: CompactionPayload }
  | { type: 'agent_status'; payload: AgentStatusPayload }

export interface ConfirmationRequestPayload {
  id: string
  threadId: string
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  reason: string
  createdAt: number
}

/** 通知事件载荷 */
export interface NotificationPayload {
  id: string
  level: 'info' | 'success' | 'warning' | 'error'
  title: string
  message?: string
  category: 'system' | 'tool' | 'memory' | 'usage' | 'compaction' | 'agent' | 'confirmation' | 'devlog'
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

export interface UseWebSocketOptions {
  threadId?: string
  onMessage?: (msg: ServerMessage) => void
  /** 通知回调（收到 notification 事件时触发） */
  onNotification?: (notification: NotificationPayload) => void
  /** DevLog 回调（收到 devlog 事件时触发） */
  onDevLog?: (log: DevLogPayload) => void
  /** 用量更新回调 */
  onUsageUpdate?: (usage: UsageUpdatePayload) => void
}

export interface UseWebSocketReturn {
  /** WebSocket 连接状态 */
  status: 'connecting' | 'connected' | 'disconnected'
  /** 发送消息 */
  send: (msg: unknown) => void
  /** 当前待处理的确认请求 */
  pendingConfirmation: ConfirmationRequestPayload | null
  /** 回复确认请求 */
  respondConfirmation: (id: string, approved: boolean) => void
}

/** 指数退避重连配置 */
const RECONNECT_BASE_DELAY = 1000 // 1s
const RECONNECT_MAX_DELAY = 30000 // 30s 上限
// 不设上限：后端可能重启，前端应持续尝试重连
// const RECONNECT_MAX_ATTEMPTS = 10

/**
 * WebSocket 客户端 hook
 *
 * 自动处理：
 * - 连接建立/断开/指数退避重连（1s → 2s → 4s → ... → 30s 上限）
 * - 认证 Token 注入
 * - confirmation_request 接收
 * - confirmation_response 发送
 * - ping/pong 心跳（30s）
 * - notification/devlog/usage_update 事件分发
 */
export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const { threadId, onMessage, onNotification, onDevLog, onUsageUpdate } = options
  const [status, setStatus] = useState<UseWebSocketReturn['status']>('connecting')
  const [pendingConfirmation, setPendingConfirmation] = useState<ConfirmationRequestPayload | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const onMessageRef = useRef(onMessage)
  const onNotificationRef = useRef(onNotification)
  const onDevLogRef = useRef(onDevLog)
  const onUsageUpdateRef = useRef(onUsageUpdate)
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 保持回调引用最新
  onMessageRef.current = onMessage
  onNotificationRef.current = onNotification
  onDevLogRef.current = onDevLog
  onUsageUpdateRef.current = onUsageUpdate

  const send = useCallback((msg: unknown) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }, [])

  const respondConfirmation = useCallback((id: string, approved: boolean) => {
    send({ type: 'confirmation_response', payload: { id, approved } })
    setPendingConfirmation(null)
  }, [send])

  useEffect(() => {
    let cancelled = false

    const connect = () => {
      if (cancelled) return

      const token = localStorage.getItem('pi-agent.auth-token') ?? ''
      const params = new URLSearchParams()
      if (threadId) params.set('threadId', threadId)
      // 从 apiBaseUrl 派生 WebSocket 基础 URL（http(s):// → ws(s)://）
      const wsBaseUrl = browserConfig.apiBaseUrl.replace(/^http/, 'ws')
      const wsUrl = `${wsBaseUrl}/ws?${params.toString()}`

      // Electron 环境下 WebSocket 不支持自定义 headers，通过 query param 传 token
      const urlWithToken = token
        ? `${wsUrl}&token=${encodeURIComponent(token)}`
        : wsUrl

      const ws = new WebSocket(urlWithToken)
      wsRef.current = ws
      setStatus('connecting')

      ws.onopen = () => {
        if (cancelled) return
        setStatus('connected')
        reconnectAttemptsRef.current = 0 // 重置重连计数
        // 启动心跳
        const heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }))
          }
        }, 30_000)
        ws.addEventListener('close', () => clearInterval(heartbeat))
      }

      ws.onmessage = (event) => {
        if (cancelled) return
        try {
          const msg = JSON.parse(event.data) as ServerMessage
          // 分发到具体回调
          switch (msg.type) {
            case 'confirmation_request':
              setPendingConfirmation(msg.payload)
              break
            case 'notification':
              onNotificationRef.current?.(msg.payload)
              break
            case 'devlog':
              onDevLogRef.current?.(msg.payload)
              break
            case 'usage_update':
              onUsageUpdateRef.current?.(msg.payload)
              break
          }
          onMessageRef.current?.(msg)
        } catch {
          // 忽略无效消息
        }
      }

      ws.onclose = () => {
        if (cancelled) return
        setStatus('disconnected')
        wsRef.current = null

        // 指数退避重连：1s → 2s → 4s → 8s → 16s → 30s（上限），无次数上限
        // 后端可能重启，前端应持续尝试重连直到成功
        const attempts = reconnectAttemptsRef.current
        const delay = Math.min(
          RECONNECT_BASE_DELAY * Math.pow(2, Math.min(attempts, 10)),
          RECONNECT_MAX_DELAY
        )
        // cap attempts 避免无限增长
        if (reconnectAttemptsRef.current < 100) {
          reconnectAttemptsRef.current = attempts + 1
        }
        reconnectTimerRef.current = setTimeout(() => {
          if (!cancelled) {
            setStatus('connecting')
            connect()
          }
        }, delay)
      }

      ws.onerror = () => {
        if (cancelled) return
        setStatus('disconnected')
      }
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      reconnectAttemptsRef.current = 0
      const ws = wsRef.current
      if (ws) {
        ws.onclose = null // 防止 cleanup 触发重连
        ws.close()
        wsRef.current = null
      }
    }
  }, [threadId])

  return {
    status,
    send,
    pendingConfirmation,
    respondConfirmation,
  }
}
