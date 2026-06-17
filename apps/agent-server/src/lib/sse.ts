import type { FastifyReply } from 'fastify'
import type { OutgoingHttpHeader, OutgoingHttpHeaders } from 'node:http'
import type { BaseEvent } from '@ag-ui/core'

function isOutgoingHeader(value: unknown): value is OutgoingHttpHeader {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  )
}

/** AG-UI SSE 响应头 */
const SSE_HEADERS: OutgoingHttpHeaders = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
}

/** 设置 SSE 响应头 */
export function setupSse(reply: FastifyReply): void {
  const headers: OutgoingHttpHeaders = { ...SSE_HEADERS }
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (isOutgoingHeader(value)) {
      headers[name] = value
    }
  }
  reply.raw.writeHead(200, headers)
}

/** 发送 SSE 事件 */
export function sendSseEvent(reply: FastifyReply, event: BaseEvent | Record<string, unknown>): void {
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
}

/** 发送 SSE 注释 */
export function sendSseComment(reply: FastifyReply, comment: string): void {
  reply.raw.write(`: ${comment.replace(/\n/g, ' ')}\n\n`)
}

/** 关闭 SSE 连接 */
export function closeSse(reply: FastifyReply): void {
  reply.raw.end()
}
