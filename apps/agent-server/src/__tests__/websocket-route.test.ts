import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'

type WebSocketMessage = {
  toString(): string
}

describe('websocket route', () => {
  let app: Awaited<ReturnType<typeof createApp>>

  beforeAll(async () => {
    process.env.PI_AGENT_AUTH_TOKEN = 'test-token-123'
    app = await createApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    delete process.env.PI_AGENT_AUTH_TOKEN
  })

  it('pushes confirmation requests to connected clients', async () => {
    const socket = await app.injectWS('/ws', {
      headers: {
        authorization: 'Bearer test-token-123',
      },
    })

    const message = new Promise<unknown>((resolve) => {
      socket.once('message', (data: WebSocketMessage) => {
        resolve(JSON.parse(data.toString()))
      })
    })

    void app.confirmationManager.requestConfirmation({
      threadId: 'thread-1',
      toolCallId: 'tool-call-1',
      toolName: 'bash',
      args: { command: 'rm -rf dist' },
      reason: 'bash 需要用户确认',
    })

    await expect(message).resolves.toMatchObject({
      type: 'confirmation_request',
      payload: {
        threadId: 'thread-1',
        toolName: 'bash',
      },
    })

    socket.close()
  })
})
