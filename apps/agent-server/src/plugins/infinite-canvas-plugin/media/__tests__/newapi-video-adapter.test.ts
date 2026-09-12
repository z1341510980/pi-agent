import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaModalityContext } from '../adapter.js'
import {
  NEWAPI_VIDEO_DEFAULT_MODEL,
  NEWAPI_VIDEO_DEFAULTS,
  NEWAPI_VIDEO_MAX_REF_IMAGES,
  newapiVideoAdapter
} from '../adapters/newapi-video.js'

/**
 * newapi-video adapter 用例：提交 payload、任务轮询序列（queued → in_progress →
 * completed+url）、失败路径透出 error.message、参数默认值与图生视频透传；
 * 以及 NewAPI 兼容网关（aimanplay 等）的真实包裹层响应形状
 * （SUCCESS + result_url + 嵌套 results）与 ref_image_N 多参考协议（/v1/videos）。
 */

/** NewAPI 兼容网关的真实完成响应：status 大写、url 藏在 data.result_url / 嵌套 results。 */
const LIVE_COMPLETED_BODY = {
  code: 'success',
  message: '',
  data: {
    id: 1297,
    task_id: 'task_live_1297',
    status: 'SUCCESS',
    fail_reason: '',
    result_url: 'https://cdn.video.example/live/result.mp4?Signature=abc',
    progress: '100%',
    data: {
      msg: '任务完成',
      code: 'Success',
      data: {
        status: 'SUCCESS',
        results: [{ url: 'https://cdn.video.example/live/nested.mp4' }]
      }
    },
    properties: { duration: 5, resolution: '768x1360' }
  }
}

/** NewAPI 兼容网关的真实失败响应：status FAIL + data.fail_reason 携带失败原因。 */
const LIVE_FAILED_BODY = {
  code: 'success',
  message: '',
  data: {
    id: 1298,
    task_id: 'task_live_1298',
    status: 'FAIL',
    fail_reason: '队列超时，任务已取消',
    result_url: '',
    progress: '0%',
    data: { msg: '', code: 'Fail', data: { status: 'FAIL', results: [] } }
  }
}

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
      expect(fetchMock.mock.calls[1][0]).toBe(
        'https://api.video.example/v1/video/generations/task-9'
      )
      expect(fetchMock.mock.calls[2][0]).toBe(
        'https://api.video.example/v1/video/generations/task-9'
      )
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
    expect(JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body)).duration).toBe(3)
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
      jsonResponse({
        task_id: 'task-now',
        status: 'completed',
        url: 'https://cdn.video.example/done.mp4'
      })
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
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: '模型不存在' } }, 400))

    await expect(adapter.generateVideo!(createContext(), { prompt: 'x' })).rejects.toThrow(
      '视频生成失败: 模型不存在'
    )
  })

  it('recognizes the live gateway shape: uppercase SUCCESS resolves data.result_url', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          code: 'success',
          message: '',
          data: { id: 1296, task_id: 'task_live_1297', status: 'QUEUED' }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 'success',
          message: '',
          data: { task_id: 'task_live_1297', status: 'IN_PROGRESS', progress: '10%' }
        })
      )
      .mockResolvedValueOnce(jsonResponse(LIVE_COMPLETED_BODY))

    try {
      const resultPromise = adapter.generateVideo!(createContext(), { prompt: '延时摄影' })
      // 轮询退避：首个间隔 2s，其后 1.5 倍 → 3s
      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(3_000)
      await expect(resultPromise).resolves.toEqual({
        outputs: [
          { url: 'https://cdn.video.example/live/result.mp4?Signature=abc', mimeType: 'video/mp4' }
        ]
      })

      expect(fetchMock).toHaveBeenCalledTimes(3)
      // 大写 QUEUED 提交响应里的 task_id 驱动轮询端点
      expect(fetchMock.mock.calls[1][0]).toBe(
        'https://api.video.example/v1/video/generations/task_live_1297'
      )
      expect(fetchMock.mock.calls[2][0]).toBe(
        'https://api.video.example/v1/video/generations/task_live_1297'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to the nested data.data.results[] url when result_url is missing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // 提交响应即完成（混合大小写 Success）：直接从嵌套 results 取 url，不再轮询
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        code: 'success',
        data: {
          task_id: 'task-nested',
          status: 'Success',
          fail_reason: '',
          data: {
            msg: 'done',
            code: 'Success',
            data: { status: 'SUCCESS', results: [{ url: 'https://cdn.video.example/nested.mp4' }] }
          }
        }
      })
    )

    const result = await adapter.generateVideo!(createContext(), { prompt: 'x' })
    expect(result.outputs).toEqual([
      { url: 'https://cdn.video.example/nested.mp4', mimeType: 'video/mp4' }
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces data.fail_reason as the failure message on the live failed shape', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ data: { task_id: 'task_live_1298', status: 'QUEUED' } })
      )
      .mockResolvedValueOnce(jsonResponse(LIVE_FAILED_BODY))

    try {
      // 先挂上 rejects 断言（拒绝发生在假计时器推进期间，晚挂会触发 unhandled rejection）
      const expectation = expect(
        adapter.generateVideo!(createContext(), { prompt: 'x' })
      ).rejects.toThrow('视频生成失败: 队列超时，任务已取消')
      await vi.advanceTimersByTimeAsync(2_000)
      await expectation
    } finally {
      vi.useRealTimers()
    }
  })

  it('submits ref_image_N fields to /v1/videos and polls the videos task endpoint', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          code: 'success',
          message: '',
          data: { task_id: 'v-ref-1', status: 'PENDING' }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 'success',
          message: '',
          data: {
            task_id: 'v-ref-1',
            status: 'SUCCESS',
            fail_reason: '',
            result_url: 'https://cdn.video.example/ref/out.mp4'
          }
        })
      )

    try {
      const resultPromise = adapter.generateVideo!(createContext(), {
        prompt: '多图参考生成',
        refImages: [
          'data:image/png;base64,AA==',
          'data:image/png;base64,BB==',
          'https://cdn.video.example/up/ref.png'
        ],
        duration: 5
      })
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(resultPromise).resolves.toEqual({
        outputs: [{ url: 'https://cdn.video.example/ref/out.mp4', mimeType: 'video/mp4' }]
      })

      expect(fetchMock).toHaveBeenCalledTimes(2)
      // 多参考协议：提交 POST {base}/v1/videos
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.video.example/v1/videos')
      const submit = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
      expect(submit).toMatchObject({
        model: NEWAPI_VIDEO_DEFAULT_MODEL,
        prompt: '多图参考生成',
        ref_image_0: 'data:image/png;base64,AA==',
        ref_image_1: 'data:image/png;base64,BB==',
        ref_image_2: 'https://cdn.video.example/up/ref.png',
        duration: 5
      })
      // 该协议不带文档协议的分辨率/条数字段
      expect(submit.width).toBeUndefined()
      expect(submit.height).toBeUndefined()
      expect(submit.fps).toBeUndefined()
      expect(submit.n).toBeUndefined()
      expect(submit.response_format).toBeUndefined()
      // 轮询端点按协议切换为 GET {base}/v1/videos/{task_id}
      expect(fetchMock.mock.calls[1][0]).toBe('https://api.video.example/v1/videos/v-ref-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes resolution through on the ref protocol and omits it when unset', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const immediateDone = (): Response =>
      jsonResponse({ task_id: 'v-res', status: 'completed', url: 'https://cdn.video.com/v.mp4' })
    fetchMock.mockResolvedValueOnce(immediateDone())

    await expect(
      adapter.generateVideo!(createContext(), {
        prompt: 'x',
        refImages: ['data:image/png;base64,AA=='],
        resolution: '768p竖'
      })
    ).resolves.toBeTruthy()
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).resolution).toBe(
      '768p竖'
    )

    // 输入未传 → 不带 resolution 字段
    fetchMock.mockResolvedValueOnce(immediateDone())
    await expect(
      adapter.generateVideo!(createContext(), {
        prompt: 'x',
        refImages: ['data:image/png;base64,AA==']
      })
    ).resolves.toBeTruthy()
    expect(
      JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body)).resolution
    ).toBeUndefined()

    // Provider 行 params.resolution 作为频道级默认兜底
    fetchMock.mockResolvedValueOnce(immediateDone())
    await expect(
      adapter.generateVideo!(createContext({ params: { resolution: '768p横' } }), {
        prompt: 'x',
        refImages: ['data:image/png;base64,AA==']
      })
    ).resolves.toBeTruthy()
    expect(JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body)).resolution).toBe(
      '768p横'
    )
  })

  it('caps refImages at the adapter limit and ignores an empty list', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task_id: 'v-cap', status: 'completed', url: 'https://cdn.video.com/v.mp4' })
    )
    const manyRefs = Array.from(
      { length: NEWAPI_VIDEO_MAX_REF_IMAGES + 2 },
      (_, index) => `data:image/png;base64,${index}`
    )

    await expect(
      adapter.generateVideo!(createContext(), { prompt: 'x', refImages: manyRefs })
    ).resolves.toBeTruthy()
    const submit = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(Object.keys(submit).filter((key) => key.startsWith('ref_image_'))).toHaveLength(
      NEWAPI_VIDEO_MAX_REF_IMAGES
    )
    expect(submit[`ref_image_${NEWAPI_VIDEO_MAX_REF_IMAGES - 1}`]).toBe(
      `data:image/png;base64,${NEWAPI_VIDEO_MAX_REF_IMAGES - 1}`
    )
    expect(submit[`ref_image_${NEWAPI_VIDEO_MAX_REF_IMAGES}`]).toBeUndefined()

    // 空数组视为未传：回落文档协议 POST /video/generations
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task_id: 't', status: 'completed', url: 'https://cdn.video.com/v.mp4' })
    )
    await expect(
      adapter.generateVideo!(createContext(), { prompt: 'x', refImages: [] })
    ).resolves.toBeTruthy()
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.video.example/v1/video/generations')
  })
})
