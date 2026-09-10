import { describe, expect, it, vi } from 'vitest'
import type { MediaModalityContext } from '../adapter.js'
import {
  APIMART_DEFAULT_IMAGE_MODEL,
  apimartAdapter,
  normalizeApimartSize
} from '../adapters/apimart.js'

/**
 * 从 core/config/media-generator.test.ts 迁移的 apimart 行为用例：
 * 构造方式从 createMediaGenerator 改为直接构造 MediaModalityContext 调
 * adapter.generateImage/editImage，断言逐字等价
 * （payload 比例 size/resolution/image_urls、/tasks/{task_id}?language= 轮询、
 * 默认模型 gpt-image-2、mask 抛错语义）。
 */
describe('apimart adapter', () => {
  const adapter = apimartAdapter

  const createContext = (overrides: Partial<MediaModalityContext> = {}): MediaModalityContext => ({
    providerId: 'apimart',
    baseUrl: 'https://api.apimart.example',
    apiKey: 'apimart-test-key',
    model: APIMART_DEFAULT_IMAGE_MODEL,
    params: {},
    ...overrides
  })

  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })

  it('submits APIMart tasks with resolution and resolves nested task results', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ data: { task_id: 'task-1', status: 'processing' } }, 202)
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            result: {
              status: 'succeeded',
              images: [{ url: 'https://cdn.apimart.example/image.png' }]
            }
          }
        })
      )

    try {
      const resultPromise = adapter.generateImage!(
        createContext({ params: { resolution: '2k', language: 'zh' } }),
        { prompt: 'a paper crane', size: '1024x1024' }
      )
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
    }
  })

  it('defaults the task language to en and omits size when none is configured', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ data: { task_id: 'task-9', status: 'processing' } }, 202)
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            result: {
              status: 'succeeded',
              images: [{ url: 'https://cdn.apimart.example/default-lang.png' }]
            }
          }
        })
      )

    try {
      const resultPromise = adapter.generateImage!(createContext(), { prompt: 'a paper crane' })
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(resultPromise).resolves.toEqual({
        images: ['https://cdn.apimart.example/default-lang.png']
      })
      expect(fetchMock.mock.calls[1][0]).toBe(
        'https://api.apimart.example/v1/tasks/task-9?language=en'
      )
      const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
      expect(body.model).toBe('gpt-image-2')
      expect(body.size).toBeUndefined()
      expect(body.resolution).toBeUndefined()
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('sends reference images as JSON image_urls on /images/generations and never uses multipart edits', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ url: 'https://cdn.apimart.example/edited.png' }] })
    )

    try {
      await expect(
        adapter.editImage!(createContext({ params: { resolution: '4k' } }), {
          prompt: '按参考图重画',
          image: 'data:image/png;base64,AA==',
          images: ['data:image/png;base64,Ag=='],
          count: 3
        })
      ).resolves.toEqual({ images: ['https://cdn.apimart.example/edited.png'] })

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.apimart.example/v1/images/generations')
      const request = fetchMock.mock.calls[0][1] as RequestInit
      expect(request.method).toBe('POST')
      const body = JSON.parse(String(request.body))
      expect(body).toMatchObject({
        model: 'gpt-image-2',
        n: 1,
        resolution: '4k',
        image_urls: ['data:image/png;base64,AA==', 'data:image/png;base64,Ag==']
      })
      expect(body.size).toBeUndefined()
      expect(body.response_format).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects mask-based inpainting for the APIMart protocol', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    try {
      await expect(
        adapter.editImage!(createContext(), {
          prompt: '只重绘蒙版区域',
          image: 'data:image/png;base64,AA==',
          mask: 'data:image/png;base64,Ag=='
        })
      ).rejects.toThrow('APIMart 图片协议不支持 mask 局部重绘')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('normalizes legacy pixel sizes to APIMart aspect ratios and keeps ratio values verbatim', () => {
    expect(normalizeApimartSize('1024x1024')).toBe('1:1')
    expect(normalizeApimartSize('512x512')).toBe('1:1')
    expect(normalizeApimartSize('1536x1024')).toBe('3:2')
    expect(normalizeApimartSize('1024x1536')).toBe('2:3')
    expect(normalizeApimartSize('1792x1024')).toBe('16:9')
    expect(normalizeApimartSize('1920x1080')).toBe('16:9')
    expect(normalizeApimartSize('3:2')).toBe('3:2')
    expect(normalizeApimartSize('auto')).toBeUndefined()
    expect(normalizeApimartSize(undefined)).toBeUndefined()
  })

  it('declares image capabilities without mask/analyze and the apimart form schema', () => {
    expect(adapter.id).toBe('apimart')
    expect(adapter.label).toBe('APIMart 异步任务')
    expect(adapter.modality).toBe('image')
    expect(APIMART_DEFAULT_IMAGE_MODEL).toBe('gpt-image-2')
    expect(adapter.capabilities).toEqual({
      generate: true,
      edit: true,
      mask: false,
      analyze: false
    })
    expect(adapter.formSchema).toEqual([
      {
        key: 'resolution',
        label: '分辨率',
        type: 'select',
        options: [
          { value: '1k', label: '1k' },
          { value: '2k', label: '2k' },
          { value: '4k', label: '4k' }
        ]
      },
      { key: 'language', label: '任务语言', type: 'text', placeholder: 'en' }
    ])
  })
})
