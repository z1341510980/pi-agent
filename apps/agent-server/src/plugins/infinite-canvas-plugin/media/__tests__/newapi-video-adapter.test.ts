import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaModalityContext } from '../adapter.js'
import {
  NEWAPI_VIDEO_DEFAULT_MODEL,
  NEWAPI_VIDEO_DEFAULTS,
  newapiVideoAdapter
} from '../adapters/newapi-video.js'

/**
 * newapi-video adapter 用例：提交 payload、任务轮询序列（queued → in_progress →
 * completed+url）、失败路径透出 error.message、参数默认值与图生视频透传。
 */
describe('newapi-video adapter', () => {
  const adapter = newapiVideoAdapter

  const createContext = (overrides: Partial<MediaModalityContext> = {}): MediaModalityContext => ({
    providerId: 'video',
    baseUrl: 'https://api.video.example',
    apiKey: 'sk-video',
    model: '',
    params: {},
    ...overrides
  })

  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('submits the documented payload and polls until the task completes with a url', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ task_id: 'task-9', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ task_id: 'task-9', status: 'in_progress' }))
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: 'task-9',
          status: 'completed',
          url: 'https://cdn.video.example/out.mp4',
          format: 'mp4'
        })
      )

    try {
      const resultPromise = adapter.generateVideo!(createContext(), {
        prompt: '延时摄影',
        duration: 5,
        width: 1280,
        height: 720,
        fps: 30
      })
      // 轮询退避：首个间隔 2s，其后 1.5 倍 → 3s
      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(3_000)
      await expect(resultPromise).resolves.toEqual({
        outputs: [{ url: 'https://cdn.video.example/out.mp4', mimeType: 'video/mp4' }]
      })

      expect(fetchMock).toHaveBeenCalledTimes(3)
      // 提交端点 + Bearer
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.video.example/v1/video/generations')
      const submit = fetchMock.mock.calls[0][1] as RequestInit
      expect((submit.headers as Record<string, string>).Authorization).toBe('Bearer sk-video')
      expect(JSON.parse(String(submit.body))).toMatchObject({
        model: NEWAPI_VIDEO_DEFAULT_MODEL,
        prompt: '延时摄影',
        duration: 5,
        width: 1280,
        height: 720,
        fps: 30,
        response_format: 'url'
      })
      // 轮询端点按 task_id 拼装
      expect(fetchMock.mock.calls[1][0]).toBe('https://api.video.example/v1/video/generations/task-9')
      expect(fetchMock.mock.calls[2][0]).toBe('https://api.video.example/v1/video/generations/task-9')
    } finally {
      vi.useRealTimers()
    }
  })

  it('throws the server-side error message when the task fails', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ task_id: 'task-f', status: 'queued' }))
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: 'task-f',
          status: 'failed',
          error: { code: 1001, message: '内容审核未通过' }
        })
      )

    try {
      // 先挂上 rejects 断言（拒绝发生在假计时器推进期间，晚挂会触发 unhandled rejection）
      const expectation = expect(
        adapter.generateVideo!(createContext(), { prompt: '违规内容' })
      ).rejects.toThrow('视频生成失败: 内容审核未通过')
      await vi.advanceTimersByTimeAsync(2_000)
      await expectation
    } finally {
      vi.useRealTimers()
    }
  })

  it('fills duration/width/height/fps from provider params and hard defaults in order', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // 提交响应直接给 completed+url：payload 断言不依赖轮询
    const immediateDone = (): Response =>
      jsonResponse({ task_id: 't', status: 'completed', url: 'https://cdn.video.com/v.mp4' })
    // 输入缺省 + 行内参数缺省 → 硬编码文档默认
    fetchMock.mockResolvedValueOnce(immediateDone())

    await expect(adapter.generateVideo!(createContext(), { prompt: 'x' })).resolves.toBeTruthy()
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({
      duration: NEWAPI_VIDEO_DEFAULTS.duration,
      width: NEWAPI_VIDEO_DEFAULTS.width,
      height: NEWAPI_VIDEO_DEFAULTS.height,
      fps: NEWAPI_VIDEO_DEFAULTS.fps
    })

    // 行内参数补齐输入缺省
    fetchMock.mockResolvedValueOnce(immediateDone())
    await expect(
      adapter.generateVideo!(
        createContext({ params: { duration: '8', width: '1920', height: '1080', fps: '24' } }),
        { prompt: 'x' }
      )
    ).resolves.toBeTruthy()
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toMatchObject({
      duration: 8,
      width: 1920,
      height: 1080,
      fps: 24
    })

    // 显式输入最优先
    fetchMock.mockResolvedValueOnce(immediateDone())
    await expect(
      adapter.generateVideo!(createContext({ params: { duration: '8' } }), {
        prompt: 'x',
        duration: 3
      })
    ).resolves.toBeTruthy()
    expect(
      JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body)).duration
    ).toBe(3)
  })

  it('forwards the image field for image-to-video requests', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task_id: 't', status: 'completed', url: 'https://cdn.video.com/v.mp4' })
    )

    await expect(
      adapter.generateVideo!(createContext(), {
        prompt: '让图中的角色转身',
        image: 'data:image/png;base64,AA=='
      })
    ).resolves.toBeTruthy()
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.image).toBe('data:image/png;base64,AA==')
    expect(body.n).toBeUndefined()
  })

  it('returns the url directly when the submit response is already completed', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task_id: 'task-now', status: 'completed', url: 'https://cdn.video.example/done.mp4' })
    )

    const result = await adapter.generateVideo!(createContext(), { prompt: 'x' })
    expect(result.outputs).toEqual([
      { url: 'https://cdn.video.example/done.mp4', mimeType: 'video/mp4' }
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces http-level failures with the server error message', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: '模型不存在' } }, 400)
    )

    await expect(adapter.generateVideo!(createContext(), { prompt: 'x' })).rejects.toThrow(
      '视频生成失败: 模型不存在'
    )
  })
})
