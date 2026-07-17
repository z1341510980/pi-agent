import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'

type WebSocketMessage = {
  toString(): string
}

interface TestSocket {
  once: (event: string, cb: (data: WebSocketMessage) => void) => void
  send: (data: string) => void
  close: () => void
}

interface ServerMessage {
  type: string
  payload?: unknown
}

/** 等待下一条消息 */
function nextMessage(socket: TestSocket): Promise<ServerMessage> {
  return new Promise((resolve) => {
    socket.once('message', (data: WebSocketMessage) => {
      try {
        resolve(JSON.parse(data.toString()) as ServerMessage)
      } catch {
        resolve({ type: 'invalid' })
      }
    })
  })
}

/** 等待指定类型的消息，跳过其他消息 */
async function waitForType(socket: TestSocket, type: string): Promise<ServerMessage> {
  let msg = await nextMessage(socket)
  while (msg.type !== type) {
    msg = await nextMessage(socket)
  }
  return msg
}

describe('websocket route', () => {
  let app: Awaited<ReturnType<typeof createApp>>

  beforeAll(async () => {
    app = await createApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('推送 confirmation_request 到连接的客户端', async () => {
    const socket = (await app.injectWS('/ws', {
    })) as unknown as TestSocket

    const messagePromise = nextMessage(socket)

    void app.confirmationManager.requestConfirmation({
      threadId: 'thread-1',
      toolCallId: 'tool-call-1',
      toolName: 'bash',
      args: { command: 'rm -rf dist' },
      reason: 'bash 需要用户确认',
    })

    const msg = await messagePromise
    expect(msg.type).toBe('confirmation_request')
    expect((msg.payload as { threadId: string }).threadId).toBe('thread-1')
    expect((msg.payload as { toolName: string }).toolName).toBe('bash')

    socket.close()
  })

  it('接收 confirmation_response 并解析确认请求', async () => {
    const socket = (await app.injectWS('/ws', {
    })) as unknown as TestSocket

    // 发起确认请求
    const confirmPromise = app.confirmationManager.requestConfirmation({
      threadId: 'thread-1',
      toolCallId: 'tool-call-2',
      toolName: 'bash',
      args: { command: 'ls' },
      reason: '需要确认',
    })

    // 等待 confirmation_request 推送
    const requestMsg = await nextMessage(socket)
    expect(requestMsg.type).toBe('confirmation_request')
    const requestId = (requestMsg.payload as { id: string }).id

    // 通过 WebSocket 回复确认
    socket.send(JSON.stringify({
      type: 'confirmation_response',
      payload: { id: requestId, approved: true },
    }))

    // 确认请求应被解析为 true
    await expect(confirmPromise).resolves.toBe(true)

    socket.close()
  })

  it('ping 消息返回 pong', async () => {
    const socket = (await app.injectWS('/ws', {
    })) as unknown as TestSocket

    const pongPromise = waitForType(socket, 'pong')
    socket.send(JSON.stringify({ type: 'ping' }))

    const msg = await pongPromise
    expect(msg.type).toBe('pong')
    socket.close()
  })

  it('threadId 过滤：只推送匹配的确认请求', async () => {
    const socket = (await app.injectWS('/ws?threadId=thread-A', {
    })) as unknown as TestSocket

    // 发送给 thread-B 的确认请求不应推送到此客户端
    void app.confirmationManager.requestConfirmation({
      threadId: 'thread-B',
      toolCallId: 'tool-call-3',
      toolName: 'bash',
      args: {},
      reason: '其他线程',
    })

    // 发送给 thread-A 的确认请求应推送
    const messagePromise = nextMessage(socket)

    void app.confirmationManager.requestConfirmation({
      threadId: 'thread-A',
      toolCallId: 'tool-call-4',
      toolName: 'bash',
      args: {},
      reason: '当前线程',
    })

    const msg = await messagePromise
    expect(msg.type).toBe('confirmation_request')
    expect((msg.payload as { threadId: string }).threadId).toBe('thread-A')

    socket.close()
  })
})
