import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createApp } from '../app.js'

describe('安全基线', () => {
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

  it('非白名单来源被 CORS 拒绝', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        origin: 'https://evil.com',
      },
    })
    // CORS 拒绝时无 access-control-allow-origin 头
    const allowOrigin = response.headers['access-control-allow-origin']
    expect(allowOrigin).toBeUndefined()
  })

  it('localhost 来源被 CORS 允许', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        origin: 'http://localhost:5173',
      },
    })
    const allowOrigin = response.headers['access-control-allow-origin']
    expect(allowOrigin).toBe('http://localhost:5173')
  })

  it('无 Token 请求返回 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ag-ui/agent/default/run',
      body: {},
    })
    expect(response.statusCode).toBe(401)
  })

  it('错误 Token 请求返回 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ag-ui/agent/default/run',
      headers: {
        authorization: 'Bearer wrong-token',
      },
      body: {},
    })
    expect(response.statusCode).toBe(401)
  })

  it('正确 Token 通过认证', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ag-ui/agent/default/run',
      headers: {
        authorization: 'Bearer test-token-123',
      },
      body: {},
    })
    // 通过认证后应不再返回 401（可能返回 400 或其他错误，但不是 401）
    expect(response.statusCode).not.toBe(401)
  })

  it('health 端点不需要认证', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
    })
    expect(response.statusCode).toBe(200)
  })
})
