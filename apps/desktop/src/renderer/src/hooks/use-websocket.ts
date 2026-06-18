import { useEffect, useRef, useState, useCallback } from 'react'
import { browserConfig } from '@repo/config/browser'

/** 服务端推送的消息类型 */
export type ServerMessage =
  | { type: 'confirmation_request'; payload: ConfirmationRequestPayload }
  | { type: 'confirmation_resolved'; payload: { id: string; approved: boolean } }
  | { type: 'tool_execution'; payload: { phase: 'start' | 'end'; toolName: string; toolCallId: string } }
  | { type: 'pong' }

export interface ConfirmationRequestPayload {
  id: string
  threadId: string
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  reason: string
  createdAt: number
}

export interface UseWebSocketOptions {
  threadId?: string
  onMessage?: (msg: ServerMessage) => void
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

/**
 * WebSocket 客户端 hook
 *
 * 自动处理：
 * - 连接建立/断开/重连
 * - 认证 Token 注入
 * - confirmation_request 接收
 * - confirmation_response 发送
 * - ping/pong 心跳
 */
export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const { threadId, onMessage } = options
  const [status, setStatus] = useState<UseWebSocketReturn['status']>('connecting')
  const [pendingConfirmation, setPendingConfirmation] = useState<ConfirmationRequestPayload | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

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
      setStatus('connected')
      // 启动心跳
      const heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, 30_000)
      ws.addEventListener('close', () => clearInterval(heartbeat))
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as ServerMessage
        if (msg.type === 'confirmation_request') {
          setPendingConfirmation(msg.payload)
        }
        onMessageRef.current?.(msg)
      } catch {
        // 忽略无效消息
      }
    }

    ws.onclose = () => {
      setStatus('disconnected')
      // 自动重连（3 秒后）
      setTimeout(() => {
        if (wsRef.current === ws) {
          setStatus('connecting')
        }
      }, 3000)
    }

    ws.onerror = () => {
      setStatus('disconnected')
    }

    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [threadId])

  return {
    status,
    send,
    pendingConfirmation,
    respondConfirmation,
  }
}
