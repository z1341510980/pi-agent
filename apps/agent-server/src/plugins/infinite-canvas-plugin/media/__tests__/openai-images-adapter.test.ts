import { describe, expect, it, vi } from 'vitest'
import type { MediaModalityContext } from '../adapter.js'
import {
  defaultImageModelForBaseUrl,
  openaiImagesAdapter,
  openAiBackgroundParam,
  openAiQualityParam
} from '../adapters/openai-images.js'
import { normalizeImageBaseUrl } from '../shared.js'

/**
 * 从 core/config/media-generator.test.ts 迁移的 openai-images 行为用例：
 * 构造方式从 createMediaGenerator 改为直接构造 MediaModalityContext 调
 * adapter.generateImage/editImage，断言逐字等价
 * （payload 字段、headers、URL、轮询序列、错误消息）。
 * 反推提示词（analyzeImage）已上移到 generator 的文字模型桥接链路。
 */
describe('openai-images adapter', () => {
  const adapter = openaiImagesAdapter

  const createContext = (overrides: Partial<MediaModalityContext> = {}): MediaModalityContext => ({
    providerId: 'test-id',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-image-1',
    params: {},
    ...overrides
  })

  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })

  it('submits xKiro image jobs and polls until the image is ready', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', object: 'image.generation.job', status: 'processing' }, 202))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'job-1',
          object: 'image.generation.job',
          status: 'succeeded',
          data: [{ url: 'https://cdn.xkiro.com/image.png' }]
        })
      )

    try {
      const resultPromise = adapter.generateImage!(
        createContext({
          providerId: 'xkiro',
          baseUrl: 'https://api.xkiro.com/v1',
          apiKey: 'xk-test-key',
          model: 'gpt-image'
        }),
        { prompt: 'a lighthouse', count: 4 }
      )
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(resultPromise).resolves.toEqual({ images: ['https://cdn.xkiro.com/image.png'] })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls[1][0]).toBe('https://api.xkiro.com/v1/images/generations/job-1')
      const request = fetchMock.mock.calls[0][1] as RequestInit
      expect(JSON.parse(String(request.body))).toMatchObject({ model: 'gpt-image', n: 1 })
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('sends reference images as a JSON image array to /images/edits per the aggregator contract', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'reference-job', status: 'processing' }, 202))
      .mockResolvedValueOnce(jsonResponse({ id: 'reference-job', status: 'succeeded', data: [{ url: 'https://cdn.xkiro.com/reference-result.png' }] }))

    try {
      const resultPromise = adapter.generateImage!(
        createContext({
          providerId: 'xkiro-override',
          baseUrl: 'https://api.xkiro.com',
          apiKey: 'xk-test-key',
          model: 'gpt-image',
          params: { size: '1024x1024' }
        }),
        {
          prompt: '参考第二张图修改首页样式',
          references: ['data:image/png;base64,AA==', 'data:image/png;base64,Ag==']
        }
      )
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(resultPromise).resolves.toEqual({ images: ['https://cdn.xkiro.com/reference-result.png'] })
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.xkiro.com/v1/images/edits')
      const request = fetchMock.mock.calls[0][1] as RequestInit
      expect((request.headers as Record<string, string>)['Content-Type']).toBe('application/json')
      const body = JSON.parse(String(request.body))
      expect(body).toMatchObject({
        model: 'gpt-image',
        n: 1,
        size: '1024x1024',
        response_format: 'url',
        image: ['data:image/png;base64,AA==', 'data:image/png;base64,Ag==']
      })
      expect(body.prompt).toContain('参考第二张图修改首页样式')
      expect(body.prompt).toContain('第一张上传图片是需要修改的原图')
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('falls back to multipart /images/edits when the JSON contract is rejected with 400', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Image must be a multipart file' }, code: 'invalid_image' }, 400))
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.openai.com/edited.png' }] }))

    try {
      await expect(
        adapter.editImage!(
          createContext({ providerId: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-image-1' }),
          {
            prompt: 'make the sky a sunset',
            image: 'data:image/png;base64,AA==',
            size: '1024x1024'
          }
        )
      ).resolves.toEqual({ images: ['https://cdn.openai.com/edited.png'] })

      expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/images/edits')
      expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).image).toBe(
        'data:image/png;base64,AA=='
      )
      expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBeInstanceOf(FormData)
    } finally {
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
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'edit-1', status: 'processing' }, 202))
      .mockResolvedValueOnce(jsonResponse({ id: 'edit-1', status: 'succeeded', data: [{ url: 'https://cdn.xkiro.com/edited.png' }] }))

    try {
      const resultPromise = adapter.editImage!(
        createContext({ providerId: 'xkiro', baseUrl: 'https://api.xkiro.com/v1', apiKey: 'xk-test-key', model: 'gpt-image' }),
        {
          prompt: 'make the sky a sunset',
          image: 'data:image/png;base64,AA==',
          images: ['data:image/png;base64,Ag=='],
          size: '1024x1024'
        }
      )
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(resultPromise).resolves.toEqual({ images: ['https://cdn.xkiro.com/edited.png'] })
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.xkiro.com/v1/images/edits')
      const request = fetchMock.mock.calls[0][1] as RequestInit
      expect(request.headers).toEqual({
        Authorization: 'Bearer xk-test-key',
        'Content-Type': 'application/json'
      })
      expect(JSON.parse(String(request.body)).image).toEqual([
        'data:image/png;base64,AA==',
        'data:image/png;base64,Ag=='
      ])
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('remembers multipart-only providers and skips the doomed JSON attempt next time', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const ok = (): Response =>
      jsonResponse({ data: [{ url: 'https://cdn.example.com/mp.png' }] })
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'json unsupported' } }), { status: 400 }))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())

    const edit = (): Promise<{ images: string[] }> =>
      adapter.editImage!(
        createContext({ providerId: 'multipart-only', baseUrl: 'https://multipart-only.example.com/v1', apiKey: '', model: 'gpt-image-2' }),
        {
          prompt: '按参考图重画',
          image: 'data:image/png;base64,AA=='
        }
      )

    try {
      await expect(edit()).resolves.toEqual({ images: ['https://cdn.example.com/mp.png'] })
      await expect(edit()).resolves.toEqual({ images: ['https://cdn.example.com/mp.png'] })

      // 第一次：JSON(400) + multipart(200)；第二次：直接 multipart(200)
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(fetchMock.mock.calls[2][1] as RequestInit).toHaveProperty('body')
      expect((fetchMock.mock.calls[2][1] as RequestInit).body).toBeInstanceOf(FormData)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('never silently drops reference images when /images/edits fails mid-flight', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted', 'AbortError'))

    try {
      await expect(
        adapter.editImage!(
          createContext({ providerId: 'slow-edits', baseUrl: 'https://slow-edits.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2' }),
          {
            prompt: '按参考图重画',
            image: 'data:image/png;base64,AA=='
          }
        )
      ).rejects.toThrow()

      // 超时不代表端点不存在：不能退到不吃参考图的 JSON 生成端点
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0][0]).toBe('https://slow-edits.example.com/v1/images/edits')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('falls back to JSON image_urls when /images/edits is not implemented', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ url: 'https://cdn.example.com/fallback.png' }] })
      )

    try {
      await expect(
        adapter.generateImage!(
          createContext({ providerId: 'not-implemented', baseUrl: 'https://not-implemented.example.com', apiKey: 'sk-test', model: 'gpt-image-2', params: { size: '1024x1792' } }),
          {
            prompt: '参考图生图',
            references: ['data:image/png;base64,AA==', 'data:image/png;base64,Ag==']
          }
        )
      ).resolves.toEqual({ images: ['https://cdn.example.com/fallback.png'] })

      expect(fetchMock.mock.calls[0][0]).toBe('https://not-implemented.example.com/v1/images/edits')
      expect(fetchMock.mock.calls[1][0]).toBe(
        'https://not-implemented.example.com/v1/images/generations'
      )
      expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toMatchObject({
        image_urls: ['data:image/png;base64,AA==', 'data:image/png;base64,Ag==']
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('remembers providers without /images/edits and goes straight to the JSON endpoint', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const images = (url: string): Response => jsonResponse({ data: [{ url }] })
    fetchMock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(images('https://cdn.example.com/first.png'))
      .mockResolvedValueOnce(images('https://cdn.example.com/second.png'))

    const edit = (): Promise<{ images: string[] }> =>
      adapter.editImage!(
        createContext({ providerId: 'json-only', baseUrl: 'https://json-only.example.com/v1', apiKey: '', model: 'gpt-image-2' }),
        {
          prompt: '参考图生图',
          image: 'data:image/png;base64,AA=='
        }
      )

    try {
      await expect(edit()).resolves.toEqual({ images: ['https://cdn.example.com/first.png'] })
      await expect(edit()).resolves.toEqual({ images: ['https://cdn.example.com/second.png'] })

      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(fetchMock.mock.calls[2][0]).toBe('https://json-only.example.com/v1/images/generations')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('snaps non-whitelist sizes in the generation payload to the documented size table', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example.com/snap-1.png' }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example.com/snap-2.png' }] }))

    try {
      await expect(
        adapter.generateImage!(
          createContext({ providerId: 'snap-1', baseUrl: 'https://snap.example.com/v1', model: 'gpt-image-1' }),
          { prompt: 'a lighthouse', size: '1024x1792' }
        )
      ).resolves.toEqual({ images: ['https://cdn.example.com/snap-1.png'] })
      await expect(
        adapter.generateImage!(
          createContext({ providerId: 'snap-2', baseUrl: 'https://snap.example.com/v1', model: 'gpt-image-1' }),
          { prompt: 'a lighthouse', size: '1234x5678' }
        )
      ).resolves.toEqual({ images: ['https://cdn.example.com/snap-2.png'] })

      // 旧 dall-e 比例吸附到 1k 白名单；非法自由分辨率按最大边选 4k 档内最近长宽比
      expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).size).toBe('864x1536')
      expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body)).size).toBe('2160x3840')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('passes quality/background and a 1-10 count into the JSON generation body', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ url: 'https://cdn.example.com/qb-1.png' }] })
    )
    try {
      await expect(
        adapter.generateImage!(
          createContext({ providerId: 'qb-json', baseUrl: 'https://qb.example.com/v1', model: 'gpt-image-1' }),
          { prompt: 'a lighthouse', quality: 'high', background: 'transparent', count: 5 }
        )
      ).resolves.toEqual({ images: ['https://cdn.example.com/qb-1.png'] })
      expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({
        quality: 'high',
        background: 'transparent',
        n: 5
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('omits quality when it is auto and background when unset', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ url: 'https://cdn.example.com/qb-2.png' }] })
    )
    try {
      await expect(
        adapter.generateImage!(
          createContext({ providerId: 'qb-omit', baseUrl: 'https://qb.example.com/v1', model: 'gpt-image-1' }),
          { prompt: 'a lighthouse', quality: 'auto', count: 1 }
        )
      ).resolves.toEqual({ images: ['https://cdn.example.com/qb-2.png'] })
      const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
      expect(body).not.toHaveProperty('quality')
      expect(body).not.toHaveProperty('background')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('clamps count to 10 and forces n=1 on xKiro', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example.com/c10.png' }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example.com/c99.png' }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.xkiro.com/x.png' }] }))

    try {
      await expect(
        adapter.generateImage!(
          createContext({ providerId: 'qb-clamp-10', baseUrl: 'https://clamp.example.com/v1', model: 'gpt-image-1' }),
          { prompt: 'p', count: 10 }
        )
      ).resolves.toEqual({ images: ['https://cdn.example.com/c10.png'] })
      await expect(
        adapter.generateImage!(
          createContext({ providerId: 'qb-clamp-99', baseUrl: 'https://clamp.example.com/v1', model: 'gpt-image-1' }),
          { prompt: 'p', count: 99 }
        )
      ).resolves.toEqual({ images: ['https://cdn.example.com/c99.png'] })
      await expect(
        adapter.generateImage!(
          createContext({ providerId: 'qb-xkiro', baseUrl: 'https://api.xkiro.com/v1', model: 'gpt-image' }),
          { prompt: 'p', count: 10 }
        )
      ).resolves.toEqual({ images: ['https://cdn.xkiro.com/x.png'] })

      const bodies = fetchMock.mock.calls.map((call) =>
        JSON.parse(String((call[1] as RequestInit).body))
      )
      expect(bodies.map((body: { n: number }) => body.n)).toEqual([10, 10, 1])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('maps quality and background into the multipart /images/edits form fields', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Image must be a multipart file' }, code: 'invalid_image' }, 400))
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example.com/mp-qb.png' }] }))

    try {
      await expect(
        adapter.generateImage!(
          createContext({ providerId: 'qb-multipart', baseUrl: 'https://qb-mp.example.com/v1', model: 'gpt-image-1' }),
          {
            prompt: 'transparent version',
            references: ['data:image/png;base64,AA=='],
            quality: 'high',
            background: 'transparent'
          }
        )
      ).resolves.toEqual({ images: ['https://cdn.example.com/mp-qb.png'] })

      const form = (fetchMock.mock.calls[1][1] as RequestInit).body as FormData
      expect(form).toBeInstanceOf(FormData)
      expect(form.get('quality')).toBe('high')
      expect(form.get('background')).toBe('transparent')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('declares image capabilities and the adapter-specific size form schema', () => {
    expect(adapter.id).toBe('openai-images')
    expect(adapter.label).toBe('OpenAI Images 兼容')
    expect(adapter.modality).toBe('image')
    expect(adapter.capabilities).toEqual({ generate: true, edit: true, mask: true })
    // 约定：formSchema 只声明 adapter 特有参数；baseUrl/apiKey/model 为通用列，由设置页固定渲染
    expect(adapter.formSchema).toEqual([
      {
        key: 'size',
        label: '尺寸',
        type: 'select',
        options: [
          { value: '1024x1024', label: '1024x1024' },
          { value: '1792x1024', label: '1792x1024' },
          { value: '1024x1792', label: '1024x1792' },
          { value: '512x512', label: '512x512' }
        ]
      }
    ])
  })
})

describe('openAiQualityParam / openAiBackgroundParam', () => {
  it('normalizes casing and whitelists quality values (auto omits the key)', () => {
    expect(openAiQualityParam('high')).toEqual({ quality: 'high' })
    expect(openAiQualityParam('  HIGH ')).toEqual({ quality: 'high' })
    expect(openAiQualityParam('Medium')).toEqual({ quality: 'medium' })
    expect(openAiQualityParam('low')).toEqual({ quality: 'low' })
    expect(openAiQualityParam('auto')).toBeUndefined()
    expect(openAiQualityParam('Auto')).toBeUndefined()
    expect(openAiQualityParam('ultra')).toBeUndefined()
    expect(openAiQualityParam('')).toBeUndefined()
    expect(openAiQualityParam(undefined)).toBeUndefined()
  })

  it('whitelists background values and drops everything else', () => {
    expect(openAiBackgroundParam('transparent')).toEqual({ background: 'transparent' })
    expect(openAiBackgroundParam(' Transparent ')).toEqual({ background: 'transparent' })
    expect(openAiBackgroundParam('opaque')).toEqual({ background: 'opaque' })
    expect(openAiBackgroundParam('alpha')).toBeUndefined()
    expect(openAiBackgroundParam('')).toBeUndefined()
    expect(openAiBackgroundParam(undefined)).toBeUndefined()
  })
})
