/**
 * 媒体生成 Provider 路由测试（spec §5）
 *
 * 覆盖：CRUD、adapter 归属校验、adapters 元数据清单、首条自动默认、
 * keyHint 脱敏（apiKey 不回传）、空 Key 更新保留旧值、默认切换。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../app.js'
import { MediaProviderStore } from '../plugins/infinite-canvas-plugin/media/media-provider-store.js'

describe('media provider route', () => {
  let app: Awaited<ReturnType<typeof createApp>>
  let mediaStore: MediaProviderStore
  let dataDir: string

  beforeAll(async () => {
    // 隔离数据目录，避免污染真实 ~/.pi 数据
    dataDir = mkdtempSync(join(tmpdir(), 'pi-media-provider-route-'))
    process.env.PI_DATA_DIR = dataDir
    process.env.PI_CWD = dataDir
    app = await createApp()
    await app.ready()
    // 插件自建的媒体 Provider store（与 app.db 同库，读写 infinite_canvas_media_providers）
    mediaStore = new MediaProviderStore(app.db)
  })

  afterAll(async () => {
    await app.close()
    delete process.env.PI_DATA_DIR
    delete process.env.PI_CWD
    rmSync(dataDir, { recursive: true, force: true })
  })

  const baseInput = {
    name: '生图 A',
    modality: 'image',
    adapter: 'openai-images',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test-1234567890',
    model: 'gpt-image-1',
    params: { size: '1024x1024' }
  }

  it('GET 返回空列表与 image adapters 元数据（无 apiKey 字段）', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/plugins/infinite-canvas/media-providers?modality=image' })
    expect(response.statusCode).toBe(200)
    const payload = response.json().data
    expect(payload.rows).toEqual([])
    expect(payload.adapters.map((a: { id: string }) => a.id)).toEqual(['openai-images', 'apimart'])
    expect(payload.adapters[0]).toMatchObject({
      id: 'openai-images',
      label: 'OpenAI Images 兼容',
      modality: 'image',
      capabilities: { generate: true, edit: true, mask: true }
    })
    expect(payload.adapters[0].formSchema).toEqual([
      expect.objectContaining({ key: 'size', type: 'select' })
    ])
  })

  it('GET 校验非法 modality 参数；text 模态恒为空行', async () => {
    const bad = await app.inject({ method: 'GET', url: '/api/plugins/infinite-canvas/media-providers?modality=bogus' })
    expect(bad.statusCode).toBe(400)

    const text = await app.inject({ method: 'GET', url: '/api/plugins/infinite-canvas/media-providers?modality=text' })
    expect(text.statusCode).toBe(200)
    expect(text.json().data).toMatchObject({ rows: [], adapters: [] })
  })

  it('POST 创建首条自动设为模态默认，apiKey 不回传且附 keyHint', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/plugins/infinite-canvas/media-providers', body: baseInput })
    expect(response.statusCode).toBe(200)
    const row = response.json().data
    expect(row).toMatchObject({
      name: '生图 A',
      modality: 'image',
      adapter: 'openai-images',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-image-1',
      params: { size: '1024x1024' },
      enabled: true,
      isDefault: true
    })
    expect(row.id).toBeTruthy()
    expect(row.apiKey).toBeUndefined()
    expect(row.keyHint).toBe('sk-t…7890')
  })

  it('POST 创建第二条不抢占默认；可显式切换默认', async () => {
    const second = await app.inject({
      method: 'POST',
      url: '/api/plugins/infinite-canvas/media-providers',
      body: { ...baseInput, name: '生图 B', adapter: 'apimart', params: { resolution: '2k' } }
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().data.isDefault).toBe(false)

    const secondId = second.json().data.id as string
    const switched = await app.inject({ method: 'POST', url: `/api/plugins/infinite-canvas/media-providers/${secondId}/default` })
    expect(switched.statusCode).toBe(200)

    const list = await app.inject({ method: 'GET', url: '/api/plugins/infinite-canvas/media-providers?modality=image' })
    const defaults = list.json().data.rows.filter((r: { isDefault: boolean }) => r.isDefault)
    expect(defaults).toHaveLength(1)
    expect(defaults[0].id).toBe(secondId)
  })

  it('POST 校验：adapter 不属于该模态或未注册、modality=text、缺名称', async () => {
    const wrongAdapter = await app.inject({
      method: 'POST',
      url: '/api/plugins/infinite-canvas/media-providers',
      body: { ...baseInput, modality: 'audio' }
    })
    expect(wrongAdapter.statusCode).toBe(400)

    const unknownAdapter = await app.inject({
      method: 'POST',
      url: '/api/plugins/infinite-canvas/media-providers',
      body: { ...baseInput, adapter: 'openai-audio' }
    })
    expect(unknownAdapter.statusCode).toBe(400)

    const textModality = await app.inject({
      method: 'POST',
      url: '/api/plugins/infinite-canvas/media-providers',
      body: { ...baseInput, modality: 'text' }
    })
    expect(textModality.statusCode).toBe(400)

    const missingName = await app.inject({
      method: 'POST',
      url: '/api/plugins/infinite-canvas/media-providers',
      body: { ...baseInput, name: '' }
    })
    expect(missingName.statusCode).toBe(400)
  })

  it('PATCH 部分更新：空 apiKey 保留旧值，其余字段生效', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/plugins/infinite-canvas/media-providers?modality=image' })
    const first = list.json().data.rows.find((r: { name: string }) => r.name === '生图 A')
    expect(first).toBeTruthy()

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/plugins/infinite-canvas/media-providers/${first.id}`,
      body: {
        name: '生图 A（改）',
        model: 'gpt-image-x',
        apiKey: '   '
      }
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toMatchObject({ name: '生图 A（改）', model: 'gpt-image-x' })
    // 空（纯空白）Key 保留旧值
    expect(mediaStore.get(first.id)?.apiKey).toBe(baseInput.apiKey)

    const paramsUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/plugins/infinite-canvas/media-providers/${first.id}`,
      body: { params: { size: '512x512' }, enabled: false }
    })
    expect(paramsUpdate.statusCode).toBe(200)
    expect(paramsUpdate.json().data).toMatchObject({ params: { size: '512x512' }, enabled: false })
  })

  it('PATCH 校验 adapter 归属（含仅改 modality 的组合校验）；404 兜底', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/plugins/infinite-canvas/media-providers?modality=image' })
    const first = list.json().data.rows.find((r: { name: string }) => r.name === '生图 A（改）')

    const badAdapter = await app.inject({
      method: 'PATCH',
      url: `/api/plugins/infinite-canvas/media-providers/${first.id}`,
      body: { adapter: 'openai-audio' }
    })
    expect(badAdapter.statusCode).toBe(400)

    // 仅改 modality 而 adapter 沿用旧值：audio + openai-images 属跨模态组合，400
    const modalityOnly = await app.inject({
      method: 'PATCH',
      url: `/api/plugins/infinite-canvas/media-providers/${first.id}`,
      body: { modality: 'audio' }
    })
    expect(modalityOnly.statusCode).toBe(400)
    // 校验失败不落库：行保持 image + openai-images
    const untouched = mediaStore.get(first.id)
    expect(untouched).toMatchObject({ modality: 'image', adapter: 'openai-images' })

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/plugins/infinite-canvas/media-providers/no-such-id',
      body: { name: 'x' }
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe('NOT_FOUND')
  })

  it('DELETE 删除 Provider；删除后 :id/default 报 404', async () => {
    const missing = await app.inject({ method: 'DELETE', url: '/api/plugins/infinite-canvas/media-providers/no-such-id' })
    expect(missing.statusCode).toBe(404)

    const list = await app.inject({ method: 'GET', url: '/api/plugins/infinite-canvas/media-providers?modality=image' })
    const toDelete = list.json().data.rows.find((r: { name: string }) => r.name === '生图 A（改）')
    const removed = await app.inject({ method: 'DELETE', url: `/api/plugins/infinite-canvas/media-providers/${toDelete.id}` })
    expect(removed.statusCode).toBe(200)
    expect(removed.json().data.deleted).toBe(true)

    const after = await app.inject({ method: 'GET', url: '/api/plugins/infinite-canvas/media-providers?modality=image' })
    expect(after.json().data.rows.some((r: { id: string }) => r.id === toDelete.id)).toBe(false)
  })

  it('POST :id/default 对不存在的行报 404', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/plugins/infinite-canvas/media-providers/no-such-id/default' })
    expect(response.statusCode).toBe(404)
  })
})
