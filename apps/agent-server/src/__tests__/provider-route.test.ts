/**
 * provider route 的 createOnly 冲突保护测试
 *
 * 背景：POST /api/providers 是 upsert 语义（按 id 覆盖），而"新增 Provider"时
 * 前端从名称派生 id（如 openai/deepseek），可能撞上已有 Provider（尤其默认 Provider）的 id，
 * 导致"新增"意外覆盖已有数据。createOnly 标记用于区分新增/更新：
 * - createOnly=true 且 id 已存在 → 409 CONFLICT，拒绝写入
 * - 不带 createOnly（编辑/更新）→ 正常 upsert
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../app.js'

describe('provider route createOnly 冲突保护', () => {
  let app: Awaited<ReturnType<typeof createApp>>
  let dataDir: string

  beforeAll(async () => {
    // 隔离数据目录，避免污染真实 ~/.pi 数据
    dataDir = mkdtempSync(join(tmpdir(), 'pi-provider-route-'))
    process.env.PI_DATA_DIR = dataDir
    process.env.PI_CWD = dataDir
    app = await createApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    delete process.env.PI_DATA_DIR
    delete process.env.PI_CWD
    rmSync(dataDir, { recursive: true, force: true })
  })

  const baseConfig = {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test-1234567890',
    api: 'openai-completions',
    authHeader: true,
    models: [{ id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' }],
  }

  it('新增（createOnly=true 且 id 不存在）成功', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/providers',
      body: { ...baseConfig, id: 'brand-new-provider', createOnly: true },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.id).toBe('brand-new-provider')
  })

  it('创建请求省略 id 时由后端分配与名称无关的唯一 ID', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/providers',
      body: { ...baseConfig, createOnly: true },
    })
    expect(response.statusCode).toBe(200)

    const id = response.json().data.id as string
    expect(id).toMatch(/^provider-/)
    expect(id).not.toBe('OpenAI')
    expect(id).not.toBe('openai')

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/providers/${encodeURIComponent(id)}`,
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json().data.deleted).toBe(true)
    expect(app.modelRegistry.find(id, 'gpt-5.4-mini')).toBeUndefined()
  })

  it('新增（createOnly=true）遇已存在 id 返回 409，且不覆盖原数据', async () => {
    // 先正常注册 id=openai（不带 createOnly，模拟既有 Provider）
    const seed = await app.inject({
      method: 'POST',
      url: '/api/providers',
      body: { ...baseConfig, id: 'openai' },
    })
    expect(seed.statusCode).toBe(200)

    // 以相同 id 发起"新增" → 应被 409 拒绝
    const response = await app.inject({
      method: 'POST',
      url: '/api/providers',
      body: {
        ...baseConfig,
        id: 'openai',
        name: 'OpenAI 新增覆盖',
        apiKey: 'sk-should-not-write',
        createOnly: true,
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('CONFLICT')

    // 确认原数据未被覆盖
    const listRes = await app.inject({ method: 'GET', url: '/api/providers' })
    const openai = listRes.json().data.find((p: { id: string }) => p.id === 'openai')
    expect(openai.name).toBe('OpenAI')
    expect(openai.apiKey).toBeUndefined() // GET 列表不返回 apiKey
  })

  it('编辑（不带 createOnly）可正常覆盖更新', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/providers',
      body: { ...baseConfig, id: 'openai', name: 'OpenAI 已更新' },
    })
    expect(response.statusCode).toBe(200)

    const listRes = await app.inject({ method: 'GET', url: '/api/providers' })
    const openai = listRes.json().data.find((p: { id: string }) => p.id === 'openai')
    expect(openai.name).toBe('OpenAI 已更新')
  })

  it('createOnly 标记不会持久化到 store（GET 列表不含该字段）', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/providers' })
    const all = listRes.json().data as Array<Record<string, unknown>>
    for (const p of all) {
      expect(p).not.toHaveProperty('createOnly')
    }
  })

  it('可读取、更新并持久化 Agent 终端类型', async () => {
    const initial = await app.inject({ method: 'GET', url: '/api/settings/terminal' })
    expect(initial.statusCode).toBe(200)
    expect(initial.json().data.shell).toBe('git-bash')

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/settings/terminal',
      body: { shell: 'pwsh' },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().data.shell).toBe('pwsh')

    const reread = await app.inject({ method: 'GET', url: '/api/settings/terminal' })
    expect(reread.json().data.shell).toBe('pwsh')
  })

  it('拒绝不支持的 Agent 终端类型', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/terminal',
      body: { shell: 'powershell' },
    })
    expect(response.statusCode).toBe(400)
  })
})
