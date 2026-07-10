import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'

describe('gate route', () => {
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

  it('GET /api/gate 返回当前权限模式（默认 auto）', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/gate',
      headers: { authorization: 'Bearer test-token-123' },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ok).toBe(true)
    expect(body.data.mode).toBe('auto')
  })

  it('PUT /api/gate/mode 切换到 plan 模式', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/gate/mode',
      headers: { authorization: 'Bearer test-token-123' },
      body: { mode: 'plan' },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.data.mode).toBe('plan')

    // 验证 Gate 实例状态已更新
    expect(app.gate.getMode()).toBe('plan')
  })

  it('PUT /api/gate/mode 切换到 readonly 模式', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/gate/mode',
      headers: { authorization: 'Bearer test-token-123' },
      body: { mode: 'readonly' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data.mode).toBe('readonly')
    expect(app.gate.getMode()).toBe('readonly')
  })

  it('PUT /api/gate/mode 切换回 auto 模式', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/gate/mode',
      headers: { authorization: 'Bearer test-token-123' },
      body: { mode: 'auto' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data.mode).toBe('auto')
    expect(app.gate.getMode()).toBe('auto')
  })

  it('PUT /api/gate/mode 拒绝无效的模式值', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/gate/mode',
      headers: { authorization: 'Bearer test-token-123' },
      body: { mode: 'invalid-mode' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('权限模式切换影响 Gate.check 行为', async () => {
    // 切换到 readonly：write 工具应被禁止
    app.gate.setMode('readonly')
    let result = await app.gate.check('write', { path: 'test.txt' })
    expect(result.allowed).toBe(false)
    expect(result.needsConfirmation).toBe(false)

    // 切换到 auto：write 工具（moderate）应自动允许
    app.gate.setMode('auto')
    result = await app.gate.check('write', { path: 'test.txt' })
    expect(result.allowed).toBe(true)

    // 切换到 plan：write 工具（moderate）应需要确认
    app.gate.setMode('plan')
    result = await app.gate.check('write', { path: 'test.txt' })
    expect(result.allowed).toBe(false)
    expect(result.needsConfirmation).toBe(true)

    // 恢复默认
    app.gate.setMode('auto')
  })
})
