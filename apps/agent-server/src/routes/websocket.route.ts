import type { FastifyPluginAsync } from 'fastify'
import type { WebSocket } from '@fastify/websocket'
import type { ConfirmationRequest } from '../core/tool/confirmation-manager.js'

/** 客户端可发送的消息类型 */
type ClientMessage =
  | { type: 'confirmation_response'; payload: { id: string; approved: boolean } }
  | { type: 'ping' }

/** 服务端推送的消息类型 */
type ServerMessage =
  | { type: 'confirmation_request'; payload: ConfirmationRequest }
  | { type: 'confirmation_resolved'; payload: { id: string; approved: boolean } }
  | { type: 'tool_execution'; payload: { phase: 'start' | 'end'; toolName: string; toolCallId: string } }
  | { type: 'pong' }
  | { type: 'connected'; payload: { threadId?: string } }

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState !== socket.OPEN) return
  socket.send(JSON.stringify(msg))
}

export const websocketRoute: FastifyPluginAsync = async (app) => {
  app.get('/ws', { websocket: true }, (socket, request) => {
    // 从查询参数提取 threadId（可选，用于过滤事件）
    const threadId = (request.query as { threadId?: string }).threadId

    // ── 推送：确认请求 ──
    const sendConfirmation = (payload: ConfirmationRequest): void => {
      // 如果客户端指定了 threadId，只推送匹配的确认请求
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

    // ── 清理 ──
    socket.on('close', () => {
      app.eventBus.off('confirmation:request', sendConfirmation)
      app.eventBus.off('confirmation:resolved', sendResolved)
      app.eventBus.off('tool:execution:start', sendToolStart)
      app.eventBus.off('tool:execution:end', sendToolEnd)
    })
  })
}
