import { afterAll, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  createMediaGenerator,
  defaultImageModelForBaseUrl,
  normalizeImageBaseUrl,
  parseImages,
  requestImageEdit,
  splitModel
} from './media-generator.js'
import { ProviderConfigStore } from './provider-config-store.js'
import { runMigrations } from '../db/migrations.js'
import { extractDataUrls } from '../../plugins/infinite-canvas-plugin/routes.js'

describe('media generator', () => {
  const db = new Database(':memory:')
  runMigrations(db)
  const store = new ProviderConfigStore(db)
  const generator = createMediaGenerator(store)

  afterAll(() => db.close())

  it('splits provider-scoped model ids and falls back to the default provider', () => {
    expect(splitModel('openai:gpt-image-1', 'fallback')).toEqual({ providerId: 'openai', modelId: 'gpt-image-1' })
    expect(splitModel('gpt-image-1', 'fallback')).toEqual({ providerId: 'fallback', modelId: 'gpt-image-1' })
    expect(splitModel(undefined, 'fallback')).toEqual({ providerId: 'fallback' })
  })

  it('parses b64 and url image payloads', () => {
    expect(parseImages({ data: [{ b64_json: 'abc' }, { url: 'https://example.com/a.png' }, {}] })).toEqual([
      'data:image/png;base64,abc',
      'https://example.com/a.png'
    ])
    expect(parseImages(null)).toEqual([])
  })

  it('extracts legacy data URL references from canvas context text', () => {
    expect(extractDataUrls('主页.png: data:image/png;base64,AA== 剪贴板图片: data:image/webp;base64,BBBB')).toEqual([
      'data:image/png;base64,AA==',
      'data:image/webp;base64,BBBB'
    ])
  })

  it('submits xKiro image jobs and polls until the image is ready', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const configuredDb = new Database(':memory:')
    runMigrations(configuredDb)
    const configuredStore = new ProviderConfigStore(configuredDb)
    configuredStore.upsert({
      id: 'xkiro',
      name: 'xKiro',
      baseUrl: 'https://api.xkiro.com/v1',
      apiKey: 'xk-test-key',
      api: 'openai-completions',
      models: []
    })
    configuredStore.setDefaultProviderId('xkiro')
    const configuredGenerator = createMediaGenerator(configuredStore)
    const response = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
      })

    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(response({ id: 'job-1', object: 'image.generation.job', status: 'processing' }, 202))
      .mockResolvedValueOnce(
        response({
          id: 'job-1',
          object: 'image.generation.job',
          status: 'succeeded',
          data: [{ url: 'https://cdn.xkiro.com/image.png' }]
        })
      )

    try {
      const resultPromise = configuredGenerator.generateImage({ prompt: 'a lighthouse', count: 4 })
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(resultPromise).resolves.toEqual({ images: ['https://cdn.xkiro.com/image.png'] })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls[1][0]).toBe('https://api.xkiro.com/v1/images/generations/job-1')
      const request = fetchMock.mock.calls[0][1] as RequestInit
      expect(JSON.parse(String(request.body))).toMatchObject({ model: 'gpt-image', n: 1 })
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
      configuredDb.close()
    }
  })

  it('submits APIMart tasks with resolution and resolves nested task results', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const configuredDb = new Database(':memory:')
    runMigrations(configuredDb)
    const configuredStore = new ProviderConfigStore(configuredDb)
    configuredStore.upsert({
      id: 'apimart',
      name: 'APIMart',
      baseUrl: 'https://api.apimart.example',
      apiKey: 'apimart-test-key',
      api: 'openai-completions',
      models: [{ id: 'chat-model', name: 'Chat model' }],
      mediaProtocol: 'apimart',
      mediaResolution: '2k',
      mediaLanguage: 'zh'
    })
    configuredStore.setDefaultProviderId('apimart')
    const response = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
      })

    fetchMock
      .mockResolvedValueOnce(response({ data: { task_id: 'task-1', status: 'processing' } }, 202))
      .mockResolvedValueOnce(
        response({
          data: {
            result: {
              status: 'succeeded',
              images: [{ url: 'https://cdn.apimart.example/image.png' }]
            }
          }
        })
      )

    try {
      const resultPromise = createMediaGenerator(configuredStore).generateImage({
        prompt: 'a paper crane',
        size: '1024x1024'
      })
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(resultPromise).resolves.toEqual({
        images: ['https://cdn.apimart.example/image.png']
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls[1][0]).toBe(
        'https://api.apimart.example/v1/tasks/task-1?language=zh'
      )
      const request = fetchMock.mock.calls[0][1] as RequestInit
      expect(JSON.parse(String(request.body))).toMatchObject({
        model: 'gpt-image-2',
        size: '1:1',
        resolution: '2k',
        n: 1
      })
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
      configuredDb.close()
    }
  })

  it('uses image edits when generation receives reference images', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const response = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    fetchMock
      .mockResolvedValueOnce(response({ id: 'reference-job', status: 'processing' }, 202))
      .mockResolvedValueOnce(response({ id: 'reference-job', status: 'succeeded', data: [{ url: 'https://cdn.xkiro.com/reference-result.png' }] }))

    try {
      const resultPromise = createMediaGenerator(store, () => ({
        imageBaseUrl: 'https://api.xkiro.com',
        imageApiKey: 'xk-test-key',
        imageModel: 'gpt-image',
        imageSize: '1024x1024'
      })).generateImage({
        prompt: '参考第二张图修改首页样式',
        references: ['data:image/png;base64,AA==', 'data:image/png;base64,Ag==']
      })
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(resultPromise).resolves.toEqual({ images: ['https://cdn.xkiro.com/reference-result.png'] })
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.xkiro.com/v1/images/edits')
      const request = fetchMock.mock.calls[0][1] as RequestInit
      expect(request.body).toBeInstanceOf(FormData)
      expect((request.body as FormData).getAll('image')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('uses the xKiro model default and resolves async edit jobs', async () => {
    expect(normalizeImageBaseUrl('https://api.xkiro.com')).toBe('https://api.xkiro.com/v1')
    expect(normalizeImageBaseUrl('https://api.xkiro.com/v1/')).toBe('https://api.xkiro.com/v1')
    expect(defaultImageModelForBaseUrl('https://api.xkiro.com/v1')).toBe('gpt-image')
    expect(defaultImageModelForBaseUrl('https://api.openai.com/v1')).toBe('dall-e-3')

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const response = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    fetchMock
      .mockResolvedValueOnce(response({ id: 'edit-1', status: 'processing' }, 202))
      .mockResolvedValueOnce(response({ id: 'edit-1', status: 'succeeded', data: [{ url: 'https://cdn.xkiro.com/edited.png' }] }))

    try {
      const resultPromise = requestImageEdit({
        context: {
          baseUrl: 'https://api.xkiro.com/v1',
          modelId: 'gpt-image',
          headers: { Authorization: 'Bearer xk-test-key' }
        },
        prompt: 'make the sky a sunset',
        image: 'data:image/png;base64,AA==',
        images: ['data:image/png;base64,Ag=='],
        size: '1024x1024'
      })
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(resultPromise).resolves.toEqual({ images: ['https://cdn.xkiro.com/edited.png'] })
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.xkiro.com/v1/images/edits')
      const request = fetchMock.mock.calls[0][1] as RequestInit
      expect(request.headers).toEqual({ Authorization: 'Bearer xk-test-key' })
      expect(request.body).toBeInstanceOf(FormData)
      expect((request.body as FormData).getAll('image')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('does not select a chat model when xKiro is configured as a normal Provider', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const configuredDb = new Database(':memory:')
    runMigrations(configuredDb)
    const configuredStore = new ProviderConfigStore(configuredDb)
    configuredStore.upsert({
      id: 'xkiro-chat-catalog',
      name: 'xKiro',
      baseUrl: 'https://api.xkiro.com/v1',
      apiKey: 'xk-test-key',
      api: 'openai-completions',
      models: [{ id: 'openai/gpt-5.6-luna', name: 'Chat model' }]
    })
    configuredStore.setDefaultProviderId('xkiro-chat-catalog')
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ url: 'https://cdn.xkiro.com/image.png' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )

    try {
      await expect(createMediaGenerator(configuredStore).generateImage({ prompt: 'a cat' })).resolves.toEqual({
        images: ['https://cdn.xkiro.com/image.png']
      })
      const request = fetchMock.mock.calls[0][1] as RequestInit
      expect(JSON.parse(String(request.body))).toMatchObject({ model: 'gpt-image' })
    } finally {
      vi.unstubAllGlobals()
      configuredDb.close()
    }
  })

  it('fails image generation with a clear error when no provider exists', async () => {
    await expect(generator.generateImage({ prompt: 'a cat' })).rejects.toThrow('未配置图片 Provider')
  })

  it('rejects audio/video generation with an explicit unsupported error', async () => {
    await expect(generator.generateAudio({ prompt: 'x' })).rejects.toThrow(/音频生成协议/)
    await expect(generator.generateVideo({ prompt: 'x' })).rejects.toThrow(/视频生成协议/)
  })

  it('persists and validates the Agent terminal shell setting', () => {
    expect(store.getTerminalShell()).toBe('git-bash')

    store.setTerminalShell('pwsh')
    expect(store.getTerminalShell()).toBe('pwsh')

    db.prepare("UPDATE app_settings SET value = 'unsupported' WHERE key = 'terminal_shell'").run()
    expect(store.getTerminalShell()).toBe('git-bash')
  })
})
