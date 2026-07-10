import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createApp } from '../app.js'

describe('AG-UI 路由', () => {
  let app: Awaited<ReturnType<typeof createApp>>

  beforeAll(async () => {
    process.env.WENLANG_AGENT_AUTH_TOKEN = 'test-token-123'
    app = await createApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  const authHeaders = {
    authorization: 'Bearer test-token-123',
  }

  it('GET /ag-ui/info 返回协议信息', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ag-ui/info',
      headers: authHeaders,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.protocol).toBe('ag-ui')
    expect(body.agents).toBeDefined()
    expect(body.agents.length).toBeGreaterThan(0)
  })

  it('POST /ag-ui/agent/default/run 返回 SSE 流', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ag-ui/agent/default/run',
      headers: {
        ...authHeaders,
        'content-type': 'application/json',
      },
      body: {
        threadId: 'test-thread',
        runId: 'test-run',
        messages: [],
      },
    })
    expect(response.statusCode).toBe(200)
  })

  it('GET /ag-ui/agent/default/models 需要 threadId', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ag-ui/agent/default/models',
      headers: authHeaders,
    })
    expect(response.statusCode).toBe(400)
  })

  it('GET /ag-ui/agent/default/tools 需要 threadId', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ag-ui/agent/default/tools',
      headers: authHeaders,
    })
    expect(response.statusCode).toBe(400)
  })

  it('未知 agentId 返回 404', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ag-ui/agent/nonexistent/models?threadId=t1',
      headers: authHeaders,
    })
    expect(response.statusCode).toBe(404)
  })
})
