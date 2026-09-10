/**
 * 画布媒体链路经 Registry 的集成测试（spec §6）：
 * - generate-image：画布 providerId 命中 / 默认回退 / 未配置引导文案
 * - generate-media：audio/video 阶段一未配置的按模态命名文案
 * - reverse-prompt：analyze 能力门禁（方案 A）
 * - 旧 media-config GET/PUT：与 image 默认 Provider 的兼容字段映射（deprecated）
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../app.js'
import type { MediaProviderRow } from '../core/media/adapter.js'

const CANVAS_PREFIX = '/api/plugins/infinite-canvas'
const IMAGE_UNCONFIGURED = '图片尚未配置生成 Provider，请到 设置 → 媒体生成 配置'
const ANALYZE_UNSUPPORTED =
  '该图片 Provider 不支持图像反推提示词，请到 设置 → 媒体生成 更换支持视觉理解的 Provider'

describe('infinite canvas media × media provider registry', () => {
  let app: Awaited<ReturnType<typeof createApp>>
  let dataDir: string
  let projectId: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pi-canvas-media-registry-'))
    process.env.PI_DATA_DIR = dataDir
    process.env.PI_CWD = dataDir
    app = await createApp()
    await app.ready()

    const project = await app.inject({
      method: 'POST',
      url: `${CANVAS_PREFIX}/projects`,
      body: { title: '媒体链路' }
    })
    projectId = project.json().data.id
  })

  afterAll(async () => {
    await app.close()
    delete process.env.PI_DATA_DIR
    delete process.env.PI_CWD
    rmSync(dataDir, { recursive: true, force: true })
  })

  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  const clearImageProviders = (): void => {
    app.mediaProviderStore.list('image').forEach((row) => app.mediaProviderStore.remove(row.id))
  }

  const createImageProvider = (
    overrides: Partial<Parameters<typeof app.mediaProviderStore.create>[0]> = {}
  ): MediaProviderRow =>
    app.mediaProviderStore.create({
      name: '生图 Provider',
      modality: 'image',
      adapter: 'openai-images',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test-1234',
      model: 'gpt-image-1',
      ...overrides
    })

  it('generate-image 未配置时返回按模态命名的引导文案', async () => {
    clearImageProviders()
    const response = await app.inject({
      method: 'POST',
      url: `${CANVAS_PREFIX}/projects/${projectId}/generate-image`,
      body: { prompt: 'a lighthouse' }
    })
    expect(response.statusCode).toBe(502)
    expect(response.json().error.message).toBe(IMAGE_UNCONFIGURED)
  })

  it('generate-image 无 providerId 时经 Registry 命中 image 默认 Provider', async () => {
    const def = createImageProvider({
      name: '默认行',
      baseUrl: 'https://def.example.com/v1',
      apiKey: 'sk-def',
      model: 'm-def'
    })
    app.mediaProviderStore.setDefault(def.id)

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ url: 'https://cdn.def.example.com/a.png' }] })
    )
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${CANVAS_PREFIX}/projects/${projectId}/generate-image`,
        body: { prompt: 'a lighthouse', size: '1024x1024' }
      })
      expect(response.statusCode).toBe(200)
      // 结果会被插件本地化为本地资产路径（https 结果后台转存，立即返回资产路径）
      expect(response.json().data.images).toEqual([
        expect.stringMatching(/^\/api\/plugins\/infinite-canvas\/assets\//)
      ])
      expect(fetchMock.mock.calls[0][0]).toBe('https://def.example.com/v1/images/generations')
      expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({
        model: 'm-def'
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('generate-image 画布 providerId 优先于模态默认', async () => {
    const target = createImageProvider({
      name: '画布指定行',
      baseUrl: 'https://target.example.com/v1',
      apiKey: 'sk-target',
      model: 'm-target'
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ url: 'https://cdn.target.example.com/b.png' }] })
    )
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${CANVAS_PREFIX}/projects/${projectId}/generate-image`,
        body: { prompt: 'a crane', providerId: target.id, size: '1536x1024' }
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().data.images).toEqual([
        expect.stringMatching(/^\/api\/plugins\/infinite-canvas\/assets\//)
      ])
      expect(fetchMock.mock.calls[0][0]).toBe('https://target.example.com/v1/images/generations')
      expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer sk-target'
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('generate-media 在阶段一返回按模态命名的统一引导文案', async () => {
    const audio = await app.inject({
      method: 'POST',
      url: `${CANVAS_PREFIX}/projects/${projectId}/generate-media`,
      body: { mode: 'audio', prompt: '海浪声' }
    })
    expect(audio.statusCode).toBe(502)
    expect(audio.json().error).toBe('音频尚未配置生成 Provider，请到 设置 → 媒体生成 配置')

    const video = await app.inject({
      method: 'POST',
      url: `${CANVAS_PREFIX}/projects/${projectId}/generate-media`,
      body: { mode: 'video', prompt: '延时摄影' }
    })
    expect(video.statusCode).toBe(502)
    expect(video.json().error).toBe('视频尚未配置生成 Provider，请到 设置 → 媒体生成 配置')
  })

  it('reverse-prompt 在 analyze=false 的默认 Provider 上被门禁拦截', async () => {
    clearImageProviders()
    const apimart = app.mediaProviderStore.create({
      name: 'APIMart',
      modality: 'image',
      adapter: 'apimart',
      baseUrl: 'https://api.apimart.example',
      apiKey: 'am-key',
      model: 'gpt-image-2'
    })
    app.mediaProviderStore.setDefault(apimart.id)

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${CANVAS_PREFIX}/projects/${projectId}/reverse-prompt`,
        body: { image: 'data:image/png;base64,AA==' }
      })
      expect(response.statusCode).toBe(502)
      expect(response.json().error).toBe(ANALYZE_UNSUPPORTED)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reverse-prompt 在 analyze=true 的默认 Provider 上走多模态理解', async () => {
    clearImageProviders()
    const vision = createImageProvider({
      name: '视觉行',
      baseUrl: 'https://vision.example.com/v1',
      apiKey: 'sk-vision',
      model: 'm-vision'
    })
    app.mediaProviderStore.setDefault(vision.id)

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: '灯塔水彩画' } }] })
    )
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${CANVAS_PREFIX}/projects/${projectId}/reverse-prompt`,
        body: { image: 'data:image/png;base64,AA==' }
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().data.text).toBe('灯塔水彩画')
      expect(fetchMock.mock.calls[0][0]).toBe('https://vision.example.com/v1/chat/completions')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('GET /media-config 无默认行时返回未配置空态', async () => {
    clearImageProviders()
    const response = await app.inject({ method: 'GET', url: `${CANVAS_PREFIX}/media-config` })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toEqual({
      configured: false,
      baseUrl: '',
      model: '',
      imageSize: '1024x1024',
      imageProtocol: 'openai-images',
      imageResolution: '',
      imageLanguage: 'en',
      keyHint: ''
    })
  })

  it('PUT /media-config 写回 image 默认 Provider（adapter/params 映射、空 Key 保留）', async () => {
    const def = createImageProvider({
      name: '兼容行',
      baseUrl: 'https://compat.example.com/v1',
      apiKey: 'sk-compat-5678',
      model: 'm-compat',
      params: { size: '1024x1024', resolution: '2k', language: 'zh' }
    })
    app.mediaProviderStore.setDefault(def.id)

    const response = await app.inject({
      method: 'PUT',
      url: `${CANVAS_PREFIX}/media-config`,
      body: {
        imageBaseUrl: 'https://migrated.example.com/v1',
        imageApiKey: '',
        imageModel: 'm-updated',
        imageSize: '1792x1024',
        imageProtocol: 'apimart',
        imageResolution: '4k',
        imageLanguage: 'ja'
      }
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toMatchObject({
      configured: true,
      baseUrl: 'https://migrated.example.com/v1',
      model: 'm-updated',
      imageSize: '1792x1024',
      imageProtocol: 'apimart',
      imageResolution: '4k',
      imageLanguage: 'ja',
      keyHint: 'sk-c…5678'
    })

    const saved = app.mediaProviderStore.get(def.id)
    expect(saved).toMatchObject({
      adapter: 'apimart',
      baseUrl: 'https://migrated.example.com/v1',
      model: 'm-updated'
    })
    // 空 Key 保留旧值；params 按字段映射合并
    expect(saved?.apiKey).toBe('sk-compat-5678')
    expect(saved?.params).toEqual({ size: '1792x1024', resolution: '4k', language: 'ja' })
  })

  it('PUT /media-config 不带 imageProtocol 时保留行内现协议', async () => {
    clearImageProviders()
    const apimart = app.mediaProviderStore.create({
      name: 'APIMart 行',
      modality: 'image',
      adapter: 'apimart',
      baseUrl: 'https://api.apimart.example',
      apiKey: 'am-keep-1234',
      model: 'gpt-image-2',
      params: { size: '1024x1024' }
    })
    app.mediaProviderStore.setDefault(apimart.id)

    // 旧客户端缺省 imageProtocol：仅回写显式字段，adapter 保持 apimart
    const response = await app.inject({
      method: 'PUT',
      url: `${CANVAS_PREFIX}/media-config`,
      body: {
        imageBaseUrl: 'https://kept.example.com/v1',
        imageModel: 'm-kept'
      }
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toMatchObject({
      configured: true,
      baseUrl: 'https://kept.example.com/v1',
      model: 'm-kept',
      imageProtocol: 'apimart'
    })

    const saved = app.mediaProviderStore.get(apimart.id)
    expect(saved?.adapter).toBe('apimart')
    expect(saved?.model).toBe('m-kept')
  })

  it('PUT /media-config 在无默认行时创建首行并自动设为默认', async () => {
    clearImageProviders()
    const response = await app.inject({
      method: 'PUT',
      url: `${CANVAS_PREFIX}/media-config`,
      body: {
        imageBaseUrl: 'https://fresh.example.com',
        imageApiKey: 'sk-fresh-9012',
        imageModel: 'm-fresh',
        imageSize: '512x512'
      }
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toMatchObject({
      configured: true,
      baseUrl: 'https://fresh.example.com',
      model: 'm-fresh',
      imageSize: '512x512',
      imageProtocol: 'openai-images',
      keyHint: 'sk-f…9012'
    })

    const def = app.mediaProviderStore.resolveDefault('image')
    expect(def).toMatchObject({ adapter: 'openai-images', model: 'm-fresh' })
    expect(def?.params).toEqual({ size: '512x512' })
  })
})
