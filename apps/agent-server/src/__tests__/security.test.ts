import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createApp } from '../app.js'

describe('安全基线', () => {
  let app: Awaited<ReturnType<typeof createApp>>

  beforeAll(async () => {
    app = await createApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
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

  it('请求正常处理（无需认证）', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ag-ui/agent/default/run',
      body: {},
    })
    // 无认证机制，应返回非 401 的响应（可能返回 400 或其他错误）
    expect(response.statusCode).not.toBe(401)
  })

  it('health 端点正常响应', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
    })
    expect(response.statusCode).toBe(200)
  })
})
