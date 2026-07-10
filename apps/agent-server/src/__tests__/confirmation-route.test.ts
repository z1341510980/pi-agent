import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'

describe('confirmation route', () => {
  let app: Awaited<ReturnType<typeof createApp>>

  beforeAll(async () => {
    process.env.WENLANG_AGENT_AUTH_TOKEN = 'test-token-123'
    app = await createApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    delete process.env.WENLANG_AGENT_AUTH_TOKEN
  })

  it('lists pending confirmations', async () => {
    void app.confirmationManager.requestConfirmation({
      threadId: 'thread-1',
      toolCallId: 'tool-call-1',
      toolName: 'bash',
      args: { command: 'rm -rf dist' },
      reason: 'bash 需要用户确认',
    })

    const response = await app.inject({
      method: 'GET',
      url: '/api/confirmations',
      headers: {
        authorization: 'Bearer test-token-123',
      },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ok).toBe(true)
    expect(body.data.pending).toHaveLength(1)
    expect(body.data.pending[0].toolName).toBe('bash')
  })

  it('resolves a pending confirmation response', async () => {
    const decision = app.confirmationManager.requestConfirmation({
      threadId: 'thread-1',
      toolCallId: 'tool-call-2',
      toolName: 'write',
      args: { path: 'README.md' },
      reason: 'write 需要用户确认',
    })
    const pending = app.confirmationManager.listPending().find((item) => item.toolCallId === 'tool-call-2')

    const response = await app.inject({
      method: 'POST',
      url: `/api/confirmations/${pending!.id}/respond`,
      headers: {
        authorization: 'Bearer test-token-123',
      },
      body: {
        approved: true,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data).toEqual({ accepted: true })
    await expect(decision).resolves.toBe(true)
  })

  it('returns 404 for unknown confirmation ids', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/confirmations/missing/respond',
      headers: {
        authorization: 'Bearer test-token-123',
      },
      body: {
        approved: true,
      },
    })

    expect(response.statusCode).toBe(404)
  })
})
