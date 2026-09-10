import { afterAll, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createMediaGenerator, IMAGE_ANALYZE_UNSUPPORTED_MESSAGE } from './media-generator.js'
import { ProviderConfigStore } from './provider-config-store.js'
import { runMigrations } from '../db/migrations.js'
import { MediaProviderStore } from '../media/media-provider-store.js'
import { createMediaProviderRegistry } from '../media/registry.js'
import {
  normalizeImageBaseUrl,
  normalizeOpenAiCompatibleSize,
  parseImages
} from '../media/shared.js'
import type { MediaProviderRow } from '../media/adapter.js'
import { defaultImageModelForBaseUrl } from '../media/adapters/openai-images.js'
import { extractDataUrls } from '../../plugins/infinite-canvas-plugin/routes.js'

/**
 * Registry 体系落位后的媒体 facade 用例：旧双路（providers 表媒体列解析 +
 * 画布 override 手写 ImageRequestContext）已删除，协议级行为由
 * core/media/__tests__/{openai-images,apimart}-adapter.test.ts 覆盖，
 * 此处只验证 facade 的 resolve/门禁/委托语义。
 */
describe('media generator facade (registry-backed)', () => {
  const db = new Database(':memory:')
  runMigrations(db)
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

  it('falls back to the modality default when providerId is missing or unknown', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.def.example.com/1.png' }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.def.example.com/2.png' }] }))
    try {
      await expect(generator.generateImage({ prompt: 'a' })).resolves.toEqual({
        images: ['https://cdn.def.example.com/1.png']
      })
      await expect(
        generator.generateImage({ prompt: 'a', providerId: 'no-such-provider' })
      ).resolves.toEqual({
        images: ['https://cdn.def.example.com/2.png']
      })
      expect(fetchMock.mock.calls[0][0]).toBe('https://def.example.com/v1/images/generations')
      expect(fetchMock.mock.calls[1][0]).toBe('https://def.example.com/v1/images/generations')
      expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).model).toBe(
        'm-def'
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fails image generation with the modality guidance message when nothing is configured', async () => {
    const emptyDb = new Database(':memory:')
    runMigrations(emptyDb)
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

  it('gates analyzeImage on adapter capabilities with the settings guidance message', async () => {
    // analyze=false 的 apimart 默认行 → 门禁文案，且不发起请求
    const apimart = mediaStore.create({
      name: 'APIMart',
      modality: 'image',
      adapter: 'apimart',
      baseUrl: 'https://api.apimart.example',
      apiKey: 'am-key',
      model: 'gpt-image-2'
    })
    mediaStore.setDefault(apimart.id)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(
        generator.analyzeImage!({ image: 'data:image/png;base64,AA==' })
      ).rejects.toThrow(IMAGE_ANALYZE_UNSUPPORTED_MESSAGE)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }

    // analyze=true 的 openai-images 行 → 走 /chat/completions 多模态理解
    const vision = createImageProvider({
      name: '视觉行',
      baseUrl: 'https://vision.example.com/v1',
      apiKey: 'sk-v',
      model: 'm-v'
    })
    mediaStore.setDefault(vision.id)
    const fetchMock2 = vi.fn()
    vi.stubGlobal('fetch', fetchMock2)
    fetchMock2.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: '一只纸鹤' } }] })
    )
    try {
      await expect(
        generator.analyzeImage!({ image: 'data:image/png;base64,AA==' })
      ).resolves.toEqual({
        text: '一只纸鹤'
      })
      expect(fetchMock2.mock.calls[0][0]).toBe('https://vision.example.com/v1/chat/completions')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects audio/video generation with the per-modality guidance messages', async () => {
    await expect(generator.generateAudio({ prompt: 'x' })).rejects.toThrow(
      '音频尚未配置生成 Provider，请到 设置 → 媒体生成 配置'
    )
    await expect(generator.generateVideo({ prompt: 'x' })).rejects.toThrow(
      '视频尚未配置生成 Provider，请到 设置 → 媒体生成 配置'
    )
  })

  it('parses b64 and url image payloads', () => {
    expect(
      parseImages({ data: [{ b64_json: 'abc' }, { url: 'https://example.com/a.png' }, {}] })
    ).toEqual(['data:image/png;base64,abc', 'https://example.com/a.png'])
    expect(parseImages(null)).toEqual([])
  })

  it('extracts legacy data URL references from canvas context text', () => {
    expect(
      extractDataUrls(
        '主页.png: data:image/png;base64,AA== 剪贴板图片: data:image/webp;base64,BBBB'
      )
    ).toEqual(['data:image/png;base64,AA==', 'data:image/webp;base64,BBBB'])
  })

  it('snaps non-whitelist sizes to the documented OpenAI-compatible size table', () => {
    expect(normalizeOpenAiCompatibleSize('1024x1024')).toBe('1024x1024')
    expect(normalizeOpenAiCompatibleSize('2048x1152')).toBe('2048x1152')
    expect(normalizeOpenAiCompatibleSize('3840x2160')).toBe('3840x2160')
    // 旧 dall-e 比例吸附到 1k 白名单
    expect(normalizeOpenAiCompatibleSize('1024x1792')).toBe('864x1536')
    expect(normalizeOpenAiCompatibleSize('1792x1024')).toBe('1536x864')
    // 非法自由分辨率按比例吸附（5678px 高 → 4k 档内选最近长宽比）
    expect(normalizeOpenAiCompatibleSize('1234x5678')).toBe('2160x3840')
    expect(normalizeOpenAiCompatibleSize(undefined)).toBeUndefined()
    expect(normalizeOpenAiCompatibleSize('auto')).toBeUndefined()
  })

  it('normalizes canvas base urls and resolves the xKiro model default', () => {
    expect(normalizeImageBaseUrl('https://api.xkiro.com')).toBe('https://api.xkiro.com/v1')
    expect(normalizeImageBaseUrl('https://api.xkiro.com/v1/')).toBe('https://api.xkiro.com/v1')
    expect(defaultImageModelForBaseUrl('https://api.xkiro.com/v1')).toBe('gpt-image')
    expect(defaultImageModelForBaseUrl('https://api.openai.com/v1')).toBe('dall-e-3')
  })

  it('persists and validates the Agent terminal shell setting', () => {
    const store = new ProviderConfigStore(db)

    expect(store.getTerminalShell()).toBe('git-bash')

    store.setTerminalShell('pwsh')
    expect(store.getTerminalShell()).toBe('pwsh')

    db.prepare("UPDATE app_settings SET value = 'unsupported' WHERE key = 'terminal_shell'").run()
    expect(store.getTerminalShell()).toBe('git-bash')
  })
})
