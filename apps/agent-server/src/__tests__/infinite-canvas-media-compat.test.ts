/**
 * 画布媒体链路经 Registry 的集成测试（spec §6）：
 * - generate-image：画布 providerId 命中 / 默认回退 / 未配置引导文案
 * - generate-media：audio/video 阶段一未配置的按模态命名文案
 * - reverse-prompt：宿主文字模型桥接（未配置 → 引导；配置 → /chat/completions）
 * - 旧 media-config GET/PUT：与 image 默认 Provider 的兼容字段映射（deprecated）
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../app.js'
import { TEXT_PROVIDER_UNCONFIGURED_MESSAGE } from '../plugins/infinite-canvas-plugin/media/registry.js'
import { MediaProviderStore } from '../plugins/infinite-canvas-plugin/media/media-provider-store.js'
import type { MediaProviderRow } from '../plugins/infinite-canvas-plugin/media/adapter.js'

const CANVAS_PREFIX = '/api/plugins/infinite-canvas'
const IMAGE_UNCONFIGURED = '图片尚未配置生成 Provider，请到 设置 → 媒体生成 配置'

describe('infinite canvas media × media provider registry', () => {
  let app: Awaited<ReturnType<typeof createApp>>
  let mediaStore: MediaProviderStore
  let dataDir: string
  let projectId: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pi-canvas-media-registry-'))
    process.env.PI_DATA_DIR = dataDir
    process.env.PI_CWD = dataDir
    app = await createApp()
    await app.ready()
    // 插件自建的媒体 Provider store（与 app.db 同库）
    mediaStore = new MediaProviderStore(app.db)

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
    mediaStore.list('image').forEach((row) => mediaStore.remove(row.id))
  }

  const createImageProvider = (
    overrides: Partial<Parameters<typeof mediaStore.create>[0]> = {}
  ): MediaProviderRow =>
    mediaStore.create({
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
    mediaStore.setDefault(def.id)

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
    clearImageProviders()
    mediaStore.list('audio').forEach((row) => mediaStore.remove(row.id))
    mediaStore.list('video').forEach((row) => mediaStore.remove(row.id))
    const audio = await app.inject({
      method: 'POST',
      url: `${CANVAS_PREFIX}/projects/${projectId}/generate-media`,
      body: { mode: 'audio', prompt: '海浪声' }
    })
    expect(audio.statusCode).toBe(502)
    expect(audio.json().error.message).toBe('音频尚未配置生成 Provider，请到 设置 → 媒体生成 配置')
    expect(audio.json().error.code).toBe('MEDIA_GENERATION_FAILED')

    const video = await app.inject({
      method: 'POST',
      url: `${CANVAS_PREFIX}/projects/${projectId}/generate-media`,
      body: { mode: 'video', prompt: '延时摄影' }
    })
    expect(video.statusCode).toBe(502)
    expect(video.json().error.message).toBe('视频尚未配置生成 Provider，请到 设置 → 媒体生成 配置')
    expect(video.json().error.code).toBe('MEDIA_GENERATION_FAILED')
  })

  it('generate-media audio：openai-audio 产出的 data URL 经资产链路落盘', async () => {
    const audioProvider = mediaStore.create({
      name: '语音合成',
      modality: 'audio',
      adapter: 'openai-audio',
      baseUrl: 'https://tts.example.com',
      apiKey: 'sk-tts-1',
      model: 'tts-1'
    })
    mediaStore.setDefault(audioProvider.id)

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // TTS 响应是二进制音频（无 JSON 包裹）
    fetchMock.mockResolvedValueOnce(
      new Response(Buffer.from('RIFF-fake-audio-bytes'), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' }
      })
    )
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${CANVAS_PREFIX}/projects/${projectId}/generate-media`,
        body: { mode: 'audio', prompt: '海浪声', voice: 'nova', speed: 1.5 }
      })
      expect(response.statusCode).toBe(200)
      const outputs = response.json().data.outputs as Array<{ url: string; mimeType: string }>
      // 音频 data URL 被本地化为本地资产（磁盘文件按 audio/mpeg 落 .mp3）
      expect(outputs[0].mimeType).toBe('audio/mpeg')
      expect(outputs[0].url).toMatch(/^\/api\/plugins\/infinite-canvas\/assets\/[\w-]+$/)
      // 请求 payload：/v1 根归一 + 语音字段
      expect(fetchMock.mock.calls[0][0]).toBe('https://tts.example.com/v1/audio/speech')
      expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({
        model: 'tts-1',
        input: '海浪声',
        voice: 'nova',
        response_format: 'mp3',
        speed: 1.5
      })
      // 资产可取回，Content-Type 为音频
      const asset = await app.inject({ method: 'GET', url: outputs[0].url })
      expect(asset.statusCode).toBe(200)
      expect(asset.headers['content-type']).toBe('audio/mpeg')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('generate-media audio：providerId 透传优先于模态默认', async () => {
    const defaultProvider = mediaStore.create({
      name: '默认语音',
      modality: 'audio',
      adapter: 'openai-audio',
      baseUrl: 'https://tts-default.example.com',
      apiKey: 'sk-def',
      model: 'tts-1'
    })
    mediaStore.setDefault(defaultProvider.id)
    const target = mediaStore.create({
      name: '画布指定语音',
      modality: 'audio',
      adapter: 'openai-audio',
      baseUrl: 'https://tts-target.example.com',
      apiKey: 'sk-target',
      model: 'tts-1'
    })

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      new Response(Buffer.from('audio-bytes'), {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' }
      })
    )
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${CANVAS_PREFIX}/projects/${projectId}/generate-media`,
        body: { mode: 'audio', prompt: '鸟鸣', providerId: target.id, format: 'wav' }
      })
      expect(response.statusCode).toBe(200)
      expect(fetchMock.mock.calls[0][0]).toBe('https://tts-target.example.com/v1/audio/speech')
      expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer sk-target'
      })
      expect(response.json().data.outputs[0].mimeType).toBe('audio/wav')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('generate-media video：newapi-video 任务轮询完成后输出转存资产', async () => {
    const videoProvider = mediaStore.create({
      name: '视频任务',
      modality: 'video',
      adapter: 'newapi-video',
      baseUrl: 'https://video.example.com',
      apiKey: 'sk-video-1',
      model: 'kling-v1'
    })
    mediaStore.setDefault(videoProvider.id)

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock
      // 提交任务
      .mockResolvedValueOnce(jsonResponse({ task_id: 'task-1', status: 'queued' }))
      // 第一次轮询：进行中
      .mockResolvedValueOnce(jsonResponse({ task_id: 'task-1', status: 'in_progress' }))
      // 第二次轮询：完成
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: 'task-1',
          status: 'completed',
          url: 'https://cdn.example.com/out.mp4',
          format: 'mp4'
        })
      )
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${CANVAS_PREFIX}/projects/${projectId}/generate-media`,
        body: { mode: 'video', prompt: '延时摄影', size: '1280x720', seconds: 5 }
      })
      expect(response.statusCode).toBe(200)
      const outputs = response.json().data.outputs as Array<{ url: string; mimeType: string }>
      expect(outputs[0].mimeType).toBe('video/mp4')
      expect(outputs[0].url).toMatch(/^\/api\/plugins\/infinite-canvas\/assets\//)
      // 提交 payload：显式分辨率 + duration，response_format=url
      expect(fetchMock.mock.calls[0][0]).toBe('https://video.example.com/v1/video/generations')
      expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({
        model: 'kling-v1',
        prompt: '延时摄影',
        duration: 5,
        width: 1280,
        height: 720,
        response_format: 'url'
      })
      // 轮询端点
      expect(fetchMock.mock.calls[1][0]).toBe(
        'https://video.example.com/v1/video/generations/task-1'
      )
      expect(fetchMock.mock.calls[2][0]).toBe(
        'https://video.example.com/v1/video/generations/task-1'
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('generate-media video：任务失败时透出服务端 error.message', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ task_id: 'task-2', status: 'queued' }))
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: 'task-2',
          status: 'failed',
          error: { code: 1001, message: '内容审核未通过' }
        })
      )
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${CANVAS_PREFIX}/projects/${projectId}/generate-media`,
        body: { mode: 'video', prompt: '违规内容' }
      })
      expect(response.statusCode).toBe(502)
      expect(response.json().error.message).toContain('内容审核未通过')
      expect(response.json().error.code).toBe('MEDIA_GENERATION_FAILED')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reverse-prompt 在宿主未配置文字模型时引导设置', async () => {
    clearImageProviders()
    // 文字模型桥接读宿主 provider-config-store：清空后 bridge 返回 null
    app.providerConfigStore
      .list()
      .forEach((provider) => app.providerConfigStore.delete(provider.id))

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${CANVAS_PREFIX}/projects/${projectId}/reverse-prompt`,
        body: { image: 'data:image/png;base64,AA==' }
      })
      expect(response.statusCode).toBe(502)
      expect(response.json().error.message).toBe(TEXT_PROVIDER_UNCONFIGURED_MESSAGE)
      expect(response.json().error.code).toBe('REVERSE_PROMPT_FAILED')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reverse-prompt 经宿主文字模型桥接走多模态聊天', async () => {
    clearImageProviders()
    // 反推提示词是视觉理解聊天：模型/端点/鉴权来自宿主 LLM Provider，与图片 Provider 无关
    app.providerConfigStore.upsert({
      id: 'llm-default',
      name: 'LLM Provider',
      baseUrl: 'https://llm.example.com',
      apiKey: 'sk-llm',
      api: 'openai-completions',
      models: [{ id: 'vision-model', name: 'Vision Model' }]
    })

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
      // openai 兼容 api 归一 /v1 根 + chat 端点；模型与鉴权来自 Provider 行
      expect(fetchMock.mock.calls[0][0]).toBe('https://llm.example.com/v1/chat/completions')
      const request = fetchMock.mock.calls[0][1] as RequestInit
      expect(request.headers).toMatchObject({ Authorization: 'Bearer sk-llm' })
      expect(JSON.parse(String(request.body))).toMatchObject({
        model: 'vision-model',
        max_tokens: 800
      })
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
    mediaStore.setDefault(def.id)

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

    const saved = mediaStore.get(def.id)
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
    const apimart = mediaStore.create({
      name: 'APIMart 行',
      modality: 'image',
      adapter: 'apimart',
      baseUrl: 'https://api.apimart.example',
      apiKey: 'am-keep-1234',
      model: 'gpt-image-2',
      params: { size: '1024x1024' }
    })
    mediaStore.setDefault(apimart.id)

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

    const saved = mediaStore.get(apimart.id)
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

    const def = mediaStore.resolveDefault('image')
    expect(def).toMatchObject({ adapter: 'openai-images', model: 'm-fresh' })
    expect(def?.params).toEqual({ size: '512x512' })
  })
})
