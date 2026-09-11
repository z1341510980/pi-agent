import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createMediaGenerator } from '../generator.js'
import { MediaProviderStore } from '../media-provider-store.js'
import {
  TEXT_BRIDGE_ADAPTER,
  TEXT_PROVIDER_UNCONFIGURED_MESSAGE,
  createMediaProviderRegistry
} from '../registry.js'
import type { MediaProviderRow } from '../adapter.js'
import { applyPluginMediaMigration } from './plugin-media-db.js'

/**
 * 插件媒体 facade（registry-backed）用例：协议级行为由
 * media/__tests__/{openai-images,apimart}-adapter.test.ts 覆盖，
 * 此处只验证 facade 的 resolve/门禁/委托语义（analyzeImage 走文字模型桥接）。
 */
describe('media generator facade (registry-backed)', () => {
  const db = new Database(':memory:')
  applyPluginMediaMigration(db)
  const mediaStore = new MediaProviderStore(db)
  const registry = createMediaProviderRegistry(mediaStore)
  const generator = createMediaGenerator(registry)

  afterAll(() => db.close())

  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  const createImageProvider = (
    overrides: Partial<Parameters<typeof mediaStore.create>[0]> = {}
  ): MediaProviderRow =>
    mediaStore.create({
      name: '生图 Provider',
      modality: 'image',
      adapter: 'openai-images',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-image-1',
      ...overrides
    })

  it('resolves the explicit canvas providerId and delegates to its adapter', async () => {
    const p1 = createImageProvider({
      name: '画布指定',
      baseUrl: 'https://p1.example.com/v1',
      apiKey: 'sk-p1',
      model: 'm-p1'
    })
    const fallback = createImageProvider({
      name: '默认行',
      baseUrl: 'https://def.example.com/v1',
      apiKey: 'sk-def',
      model: 'm-def'
    })
    mediaStore.setDefault(fallback.id)

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ url: 'https://cdn.p1.example.com/a.png' }] })
    )
    try {
      await expect(
        generator.generateImage({ prompt: 'a lighthouse', providerId: p1.id, size: '1536x1024' })
      ).resolves.toEqual({ images: ['https://cdn.p1.example.com/a.png'] })
      expect(fetchMock.mock.calls[0][0]).toBe('https://p1.example.com/v1/images/generations')
      const request = fetchMock.mock.calls[0][1] as RequestInit
      expect((request.headers as Record<string, string>).Authorization).toBe('Bearer sk-p1')
      expect(JSON.parse(String(request.body))).toMatchObject({ model: 'm-p1', size: '1536x1024' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('falls back to the modality default when providerId is missing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ url: 'https://cdn.def.example.com/1.png' }] })
    )
    try {
      await expect(generator.generateImage({ prompt: 'a' })).resolves.toEqual({
        images: ['https://cdn.def.example.com/1.png']
      })
      expect(fetchMock.mock.calls[0][0]).toBe('https://def.example.com/v1/images/generations')
      expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).model).toBe(
        'm-def'
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fails image generation with the modality guidance message when nothing is configured', async () => {
    const emptyDb = new Database(':memory:')
    applyPluginMediaMigration(emptyDb)
    const emptyRegistry = createMediaProviderRegistry(new MediaProviderStore(emptyDb))
    const emptyGenerator = createMediaGenerator(emptyRegistry)

    await expect(emptyGenerator.generateImage({ prompt: 'a cat' })).rejects.toThrow(
      '图片尚未配置生成 Provider，请到 设置 → 媒体生成 配置'
    )
    emptyDb.close()
  })

  it('routes explicit edits through the resolved adapter with providerId passthrough', async () => {
    const target = createImageProvider({
      name: '编辑目标',
      baseUrl: 'https://edit.example.com/v1',
      apiKey: 'sk-edit',
      model: 'm-edit'
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ url: 'https://cdn.edit.example.com/e.png' }] })
    )
    try {
      await expect(
        generator.editImage!({
          prompt: 'make the sky a sunset',
          providerId: target.id,
          image: 'data:image/png;base64,AA==',
          size: '1024x1024'
        })
      ).resolves.toEqual({ images: ['https://cdn.edit.example.com/e.png'] })
      expect(fetchMock.mock.calls[0][0]).toBe('https://edit.example.com/v1/images/edits')
      expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).model).toBe(
        'm-edit'
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('forwards quality/background and a 1-10 count into the adapter request payload', async () => {
    const row = createImageProvider({
      name: '参数透传',
      baseUrl: 'https://passthrough.example.com/v1',
      apiKey: 'sk-passthrough',
      model: 'gpt-image-1'
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ url: 'https://cdn.passthrough.example.com/a.png' }] })
    )
    try {
      await expect(
        generator.generateImage({
          prompt: 'a lighthouse',
          providerId: row.id,
          quality: 'high',
          background: 'transparent',
          count: 10
        })
      ).resolves.toEqual({ images: ['https://cdn.passthrough.example.com/a.png'] })
      expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({
        quality: 'high',
        background: 'transparent',
        n: 10
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('routes analyzeImage through the host text bridge chat endpoint', async () => {
    const bridge = vi.fn(async (providerId?: string) => ({
      providerId: providerId ?? 'llm-default',
      adapter: TEXT_BRIDGE_ADAPTER,
      ctx: {
        providerId: providerId ?? 'llm-default',
        baseUrl: 'https://llm.example.com/v1',
        apiKey: 'sk-llm',
        model: 'vision-model',
        params: {},
        headers: { Authorization: 'Bearer sk-llm' }
      }
    }))
    const generator = createMediaGenerator(
      createMediaProviderRegistry(mediaStore, { textBridge: bridge })
    )

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: '一只纸鹤' } }] })
    )
    try {
      await expect(
        generator.analyzeImage({ image: 'data:image/png;base64,AA==' })
      ).resolves.toEqual({ text: '一只纸鹤' })

      // 无 providerId → bridge 收到 undefined；chat 请求用 bridge 的 baseUrl/model/headers
      expect(bridge).toHaveBeenCalledWith(undefined)
      expect(fetchMock.mock.calls[0][0]).toBe('https://llm.example.com/v1/chat/completions')
      const request = fetchMock.mock.calls[0][1] as RequestInit
      expect(request.headers).toEqual({
        Authorization: 'Bearer sk-llm',
        'Content-Type': 'application/json'
      })
      expect(JSON.parse(String(request.body))).toMatchObject({
        model: 'vision-model',
        max_tokens: 800
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('lets input.model override the bridged chat model', async () => {
    const bridge = vi.fn(async (providerId?: string) => ({
      providerId: providerId ?? 'llm-default',
      adapter: TEXT_BRIDGE_ADAPTER,
      ctx: {
        providerId: providerId ?? 'llm-default',
        baseUrl: 'https://llm.example.com/v1',
        apiKey: 'sk-llm',
        model: 'vision-model',
        params: {}
      }
    }))
    const generator = createMediaGenerator(
      createMediaProviderRegistry(mediaStore, { textBridge: bridge })
    )

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: '覆盖模型输出' } }] })
    )
    try {
      await expect(
        generator.analyzeImage({ image: 'data:image/png;base64,AA==', model: 'custom-vision' })
      ).resolves.toEqual({ text: '覆盖模型输出' })
      expect(bridge).toHaveBeenCalledWith(undefined)
      expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).model).toBe(
        'custom-vision'
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('splits provider:model input into a bridge providerId plus model override', async () => {
    const bridge = vi.fn(async (providerId?: string) => ({
      providerId: providerId ?? 'llm-default',
      adapter: TEXT_BRIDGE_ADAPTER,
      ctx: {
        providerId: providerId ?? 'llm-default',
        baseUrl: 'https://llm.example.com/v1',
        apiKey: 'sk-llm',
        model: 'vision-model',
        params: {}
      }
    }))
    const generator = createMediaGenerator(
      createMediaProviderRegistry(mediaStore, { textBridge: bridge })
    )

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: '拆分命中' } }] })
    )
    try {
      await expect(
        generator.analyzeImage({
          image: 'data:image/png;base64,AA==',
          model: 'llm-2:custom-vision'
        })
      ).resolves.toEqual({ text: '拆分命中' })
      expect(bridge).toHaveBeenCalledWith('llm-2')
      expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).model).toBe(
        'custom-vision'
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('guides to text model settings when the host bridge has no provider', async () => {
    const bridge = vi.fn(async () => null)
    const generator = createMediaGenerator(
      createMediaProviderRegistry(mediaStore, { textBridge: bridge })
    )

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(generator.analyzeImage({ image: 'data:image/png;base64,AA==' })).rejects.toThrow(
        TEXT_PROVIDER_UNCONFIGURED_MESSAGE
      )
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('wraps upstream chat failures with the model vision hint', async () => {
    const bridge = vi.fn(async (providerId?: string) => ({
      providerId: providerId ?? 'llm-default',
      adapter: TEXT_BRIDGE_ADAPTER,
      ctx: {
        providerId: providerId ?? 'llm-default',
        baseUrl: 'https://llm.example.com/v1',
        apiKey: 'sk-llm',
        model: 'vision-model',
        params: {}
      }
    }))
    const generator = createMediaGenerator(
      createMediaProviderRegistry(mediaStore, { textBridge: bridge })
    )

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'bad image' } }, 500))
    try {
      await expect(generator.analyzeImage({ image: 'data:image/png;base64,AA==' })).rejects.toThrow(
        '图片理解失败（模型 vision-model 可能不支持视觉输入）：{"message":"bad image"}'
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects audio/video generation with the per-modality guidance messages', async () => {
    const emptyDb = new Database(':memory:')
    applyPluginMediaMigration(emptyDb)
    const emptyGenerator = createMediaGenerator(
      createMediaProviderRegistry(new MediaProviderStore(emptyDb))
    )
    await expect(emptyGenerator.generateAudio({ prompt: 'x' })).rejects.toThrow(
      '音频尚未配置生成 Provider，请到 设置 → 媒体生成 配置'
    )
    await expect(emptyGenerator.generateVideo({ prompt: 'x' })).rejects.toThrow(
      '视频尚未配置生成 Provider，请到 设置 → 媒体生成 配置'
    )
    emptyDb.close()
  })
})

describe('analyzeImage analyzeModel 偏好优先级', () => {
  const db = new Database(':memory:')
  applyPluginMediaMigration(db)
  afterAll(() => db.close())

  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  /**
   * 构造带偏好与 textBridge 桩的 generator（bridge 默认模型 vision-model），
   * 执行 analyzeImage 并回传 bridge 收到的 providerId 与 chat 请求体模型。
   */
  async function runAnalyze(
    pref: string | null,
    inputModel?: string
  ): Promise<{ bridgeProviderId: string | undefined; requestModel: string }> {
    const bridge = vi.fn(async (providerId?: string) => ({
      providerId: providerId ?? 'llm-default',
      adapter: TEXT_BRIDGE_ADAPTER,
      ctx: {
        providerId: providerId ?? 'llm-default',
        baseUrl: 'https://llm.example.com/v1',
        apiKey: 'sk-llm',
        model: 'vision-model',
        params: {}
      }
    }))
    const generator = createMediaGenerator(
      createMediaProviderRegistry(new MediaProviderStore(db), { textBridge: bridge }),
      { prefs: { getPref: (key: string) => (key === 'analyzeModel' ? pref : null) } }
    )
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }))
    try {
      await generator.analyzeImage({
        image: 'data:image/png;base64,AA==',
        ...(inputModel !== undefined ? { model: inputModel } : {})
      })
    } finally {
      vi.unstubAllGlobals()
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://llm.example.com/v1/chat/completions')
    return {
      bridgeProviderId: bridge.mock.calls[0]?.[0],
      requestModel: JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
        .model as string
    }
  }

  it('input.model（provider:model）覆盖偏好', async () => {
    const { bridgeProviderId, requestModel } = await runAnalyze(
      'pref-llm:pref-model',
      'input-llm:input-model'
    )
    expect(bridgeProviderId).toBe('input-llm')
    expect(requestModel).toBe('input-model')
  })

  it('input.model（裸 model id）覆盖偏好并走默认 Provider', async () => {
    const { bridgeProviderId, requestModel } = await runAnalyze('pref-llm:pref-model', 'bare-model')
    expect(bridgeProviderId).toBe(undefined)
    expect(requestModel).toBe('bare-model')
  })

  it('偏好覆盖默认：analyzeModel 解析为 bridge providerId + model 覆盖', async () => {
    const { bridgeProviderId, requestModel } = await runAnalyze('pref-llm:pref-model')
    expect(bridgeProviderId).toBe('pref-llm')
    expect(requestModel).toBe('pref-model')
  })

  it('input.model 与偏好都空时走默认（bridge 首个模型）', async () => {
    const { bridgeProviderId, requestModel } = await runAnalyze(null)
    expect(bridgeProviderId).toBe(undefined)
    expect(requestModel).toBe('vision-model')
  })

  it('偏好格式非法（缺冒号/空段）视为未设置，回落默认', async () => {
    for (const invalid of ['no-colon-model', 'pref-llm:', ':model', '']) {
      const { bridgeProviderId, requestModel } = await runAnalyze(invalid)
      expect(bridgeProviderId).toBe(undefined)
      expect(requestModel).toBe('vision-model')
    }
  })
})

describe('节点显式模型选择校验', () => {
  const db = new Database(':memory:')
  applyPluginMediaMigration(db)
  const mediaStore = new MediaProviderStore(db)
  afterAll(() => db.close())

  afterEach(() => {
    db.exec('DELETE FROM infinite_canvas_media_providers')
  })

  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  const createImageProvider = (
    overrides: Partial<Parameters<typeof mediaStore.create>[0]> = {}
  ): MediaProviderRow =>
    mediaStore.create({
      name: '生图 Provider',
      modality: 'image',
      adapter: 'openai-images',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-image-1',
      ...overrides
    })

  const stubFetch = (): ReturnType<typeof vi.fn> => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('generateImage 显式 providerId 已不存在时拒绝且不发起请求', async () => {
    const generator = createMediaGenerator(createMediaProviderRegistry(mediaStore))
    const fetchMock = stubFetch()
    try {
      await expect(
        generator.generateImage({ prompt: 'a lighthouse', providerId: 'no-such-provider' })
      ).rejects.toThrow('已被删除或停用')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('generateImage 显式 providerId 已停用时拒绝且不发起请求', async () => {
    const row = createImageProvider({ name: '已停用 Provider' })
    mediaStore.update(row.id, { enabled: false })
    const generator = createMediaGenerator(createMediaProviderRegistry(mediaStore))
    const fetchMock = stubFetch()
    try {
      await expect(
        generator.generateImage({ prompt: 'a lighthouse', providerId: row.id })
      ).rejects.toThrow('已被删除或停用')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('generateImage 显式 model 已不在 Provider 候选内时拒绝且不发起请求', async () => {
    createImageProvider({
      name: '候选收缩 Provider',
      model: 'img-a',
      params: { models: 'img-b\ncustom-x' }
    })
    const generator = createMediaGenerator(createMediaProviderRegistry(mediaStore))
    const fetchMock = stubFetch()
    try {
      await expect(
        generator.generateImage({
          prompt: 'a lighthouse',
          providerId: mediaStore.list('image')[0]!.id,
          model: 'gone-model'
        })
      ).rejects.toThrow('已从 Provider')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('generateImage 显式 model 命中 params.models 候选时放行并透传请求体', async () => {
    const row = createImageProvider({
      name: '候选命中 Provider',
      model: 'img-a',
      params: { models: 'img-b\ncustom-x' }
    })
    const generator = createMediaGenerator(createMediaProviderRegistry(mediaStore))
    const fetchMock = stubFetch()
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ url: 'https://cdn.example.com/a.png' }] })
    )
    try {
      await expect(
        generator.generateImage({
          prompt: 'a lighthouse',
          providerId: row.id,
          model: 'custom-x'
        })
      ).resolves.toEqual({ images: ['https://cdn.example.com/a.png'] })
      expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).model).toBe(
        'custom-x'
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('generateAudio 显式 providerId 已不存在时拒绝且不发起请求', async () => {
    const generator = createMediaGenerator(createMediaProviderRegistry(mediaStore))
    const fetchMock = stubFetch()
    try {
      await expect(
        generator.generateAudio({ prompt: '一段风声', providerId: 'no-such-provider' })
      ).rejects.toThrow('已被删除或停用')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('generateVideo 显式 providerId 已不存在时拒绝且不发起请求', async () => {
    const generator = createMediaGenerator(createMediaProviderRegistry(mediaStore))
    const fetchMock = stubFetch()
    try {
      await expect(
        generator.generateVideo({ prompt: '一段海浪', providerId: 'no-such-provider' })
      ).rejects.toThrow('已被删除或停用')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
