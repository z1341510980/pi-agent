import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaModalityContext } from '../adapter.js'
import { mediaDiag } from '../../../../core/config/media-diag.js'
import { clearAimanplayOssCaches } from '../aimanplay-oss.js'
import {
  NEWAPI_VIDEO_DEFAULT_MODEL,
  NEWAPI_VIDEO_DEFAULTS,
  NEWAPI_VIDEO_MAX_REF_IMAGES,
  NEWAPI_VIDEO_MAX_REF_AUDIOS,
  newapiVideoAdapter,
  resolveAimanplayVideoProfile
} from '../adapters/newapi-video.js'

/**
 * newapi-video adapter 用例：提交 payload、任务轮询序列（queued → in_progress →
 * completed+url）、失败路径透出 error.message、参数默认值与图生视频透传；
 * 以及 NewAPI 兼容网关（aimanplay 等）的真实包裹层响应形状
 * （SUCCESS + result_url + 嵌套 results）与 ref_image_N 多参考协议（/v1/videos）。
 * aimanplay 四模型档案（first-last/ref-media/text-only）的分流、duration/resolution
 * 钳制与参考素材 OSS URL 化（含内容缓存）单独成组。
 */

/** 模拟站点 STS 接口响应（api.md §3.1）。 */
const OSS_STS_RESPONSE = {
  success: true,
  enabled: true,
  message: '',
  host: 'https://video-bucket.oss-cn-hangzhou.aliyuncs.com',
  region: 'oss-cn-hangzhou',
  bucket: 'video-bucket',
  dir: 'canvas/2026',
  accessKeyId: 'STS_AK',
  accessKeySecret: 'STS_SK',
  securityToken: 'STS_TOKEN',
  expiration: new Date(Date.now() + 3600_000).toISOString(),
  maxImageBytes: 10 * 1024 * 1024,
  maxAudioBytes: 20 * 1024 * 1024
}

const isStsRequest = (url: unknown): boolean => String(url).includes('/api/video-upload/oss-sts')
const isOssPut = (url: unknown): boolean => String(url).includes('.aliyuncs.com')

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

  /**
   * OSS 链路 fetch 桩：按 URL 分流 —— STS/PUT 走固定响应，视频网关（提交/轮询）
   * 按 push 入队顺序消费，不受素材上传次数（缓存命中与否）影响。
   */
  const stubVideoFetch = (
    fetchMock: ReturnType<typeof vi.fn>
  ): {
    push: (response: () => Response) => void
  } => {
    const queue: Array<() => Response> = []
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (isStsRequest(url)) return jsonResponse(OSS_STS_RESPONSE)
      if (isOssPut(url)) return new Response('', { status: 200 })
      const next = queue.shift()
      if (!next) throw new Error(`视频网关收到未预期的请求：${url}`)
      return next()
    })
    return { push: (response) => queue.push(response) }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    clearAimanplayOssCaches()
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
    const gateway = stubVideoFetch(fetchMock)
    gateway.push(() =>
      jsonResponse({
        code: 'success',
        message: '',
        data: { task_id: 'v-ref-1', status: 'PENDING' }
      })
    )
    gateway.push(() =>
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

      // 未知模型（kling-v1）：data URL 先经 OSS 桥 URL 化（1 次 STS + 2 次 PUT），
      // http(s) 引用原样透传；共 STS + PUT×2 + 提交 + 轮询 = 5 次
      expect(fetchMock).toHaveBeenCalledTimes(5)
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.video.example/api/video-upload/oss-sts')
      const putUrls = fetchMock.mock.calls
        .filter(([url]) => isOssPut(url))
        .map(([url]) => String(url))
      expect(putUrls).toHaveLength(2)
      for (const url of putUrls) {
        expect(url.startsWith(`${OSS_STS_RESPONSE.host}/${OSS_STS_RESPONSE.dir}/`)).toBe(true)
        expect(url.endsWith('.png')).toBe(true)
      }
      const putInit = fetchMock.mock.calls[1][1] as RequestInit
      expect(putInit.method).toBe('PUT')
      expect(putInit.headers as Record<string, string>).toMatchObject({
        'x-oss-object-acl': 'public-read',
        'x-oss-security-token': OSS_STS_RESPONSE.securityToken
      })
      expect(
        (putInit.headers as Record<string, string>).Authorization?.startsWith(
          `OSS ${OSS_STS_RESPONSE.accessKeyId}:`
        )
      ).toBe(true)

      // 多参考协议：提交 POST {base}/v1/videos
      expect(fetchMock.mock.calls[3][0]).toBe('https://api.video.example/v1/videos')
      const submit = JSON.parse(String((fetchMock.mock.calls[3][1] as RequestInit).body))
      expect(submit).toMatchObject({
        model: NEWAPI_VIDEO_DEFAULT_MODEL,
        prompt: '多图参考生成',
        ref_image_0: putUrls[0],
        ref_image_1: putUrls[1],
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
      expect(fetchMock.mock.calls[4][0]).toBe('https://api.video.example/v1/videos/v-ref-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes resolution through on the ref protocol and omits it when unset', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const gateway = stubVideoFetch(fetchMock)
    const immediateDone = (): Response =>
      jsonResponse({ task_id: 'v-res', status: 'completed', url: 'https://cdn.video.com/v.mp4' })
    ;[1, 2, 3].forEach(() => gateway.push(immediateDone))
    const submitBodies = (): Record<string, unknown>[] =>
      fetchMock.mock.calls
        .filter(([url]) => String(url).endsWith('/v1/videos'))
        .map(([, init]) => JSON.parse(String((init as RequestInit).body)))

    await expect(
      adapter.generateVideo!(createContext(), {
        prompt: 'x',
        refImages: ['data:image/png;base64,AA=='],
        resolution: '768p竖'
      })
    ).resolves.toBeTruthy()
    expect(submitBodies()[0]?.resolution).toBe('768p竖')

    // 输入未传 → 不带 resolution 字段（内容缓存命中，第二次提交不再触发 OSS 上传）
    await expect(
      adapter.generateVideo!(createContext(), {
        prompt: 'x',
        refImages: ['data:image/png;base64,AA==']
      })
    ).resolves.toBeTruthy()
    expect(submitBodies()[1]?.resolution).toBeUndefined()

    // Provider 行 params.resolution 作为频道级默认兜底
    await expect(
      adapter.generateVideo!(createContext({ params: { resolution: '768p横' } }), {
        prompt: 'x',
        refImages: ['data:image/png;base64,AA==']
      })
    ).resolves.toBeTruthy()
    expect(submitBodies()[2]?.resolution).toBe('768p横')
  })

  it('caps refImages at the adapter limit and ignores an empty list', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const gateway = stubVideoFetch(fetchMock)
    gateway.push(() =>
      jsonResponse({ task_id: 'v-cap', status: 'completed', url: 'https://cdn.video.com/v.mp4' })
    )
    const manyRefs = Array.from({ length: NEWAPI_VIDEO_MAX_REF_IMAGES + 2 }, (_, index) =>
      Buffer.from(`ref-${index}`).toString('base64')
    ).map((payload) => `data:image/png;base64,${payload}`)

    await expect(
      adapter.generateVideo!(createContext(), { prompt: 'x', refImages: manyRefs })
    ).resolves.toBeTruthy()
    const submitBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/v1/videos'))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
    const submit = submitBodies[0] as Record<string, string>
    expect(Object.keys(submit).filter((key) => key.startsWith('ref_image_'))).toHaveLength(
      NEWAPI_VIDEO_MAX_REF_IMAGES
    )
    // 每张 data URL 都被 URL 化成 OSS 公开地址
    const putUrls = fetchMock.mock.calls
      .filter(([url]) => isOssPut(url))
      .map(([url]) => String(url))
    expect(putUrls).toHaveLength(NEWAPI_VIDEO_MAX_REF_IMAGES)
    expect(submit[`ref_image_${NEWAPI_VIDEO_MAX_REF_IMAGES - 1}`]).toBe(
      putUrls[NEWAPI_VIDEO_MAX_REF_IMAGES - 1]
    )
    expect(submit[`ref_image_${NEWAPI_VIDEO_MAX_REF_IMAGES}`]).toBeUndefined()

    // 空数组视为未传：回落文档协议 POST /video/generations（无 OSS 上传）
    gateway.push(() =>
      jsonResponse({ task_id: 't', status: 'completed', url: 'https://cdn.video.com/v.mp4' })
    )
    await expect(
      adapter.generateVideo!(createContext(), { prompt: 'x', refImages: [] })
    ).resolves.toBeTruthy()
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/video/generations'))
    ).toHaveLength(1)
  })
})

describe('aimanplay 模型档案（first-last / ref-media / text-only）', () => {
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

  const stubVideoFetch = (
    fetchMock: ReturnType<typeof vi.fn>
  ): {
    push: (response: () => Response) => void
  } => {
    const queue: Array<() => Response> = []
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (isStsRequest(url)) return jsonResponse(OSS_STS_RESPONSE)
      if (isOssPut(url)) return new Response('', { status: 200 })
      const next = queue.shift()
      if (!next) throw new Error(`视频网关收到未预期的请求：${url}`)
      return next()
    })
    return { push: (response) => queue.push(response) }
  }

  const ossPutUrls = (fetchMock: ReturnType<typeof vi.fn>): string[] =>
    fetchMock.mock.calls.filter(([url]) => isOssPut(url)).map(([url]) => String(url))

  afterEach(() => {
    vi.unstubAllGlobals()
    clearAimanplayOssCaches()
  })

  it('resolves the four aimanplay profiles and returns null for unknown models', () => {
    expect(resolveAimanplayVideoProfile('minimax_h3_lightx2v')).toMatchObject({
      kind: 'first-last',
      durationRange: [1, 10],
      defaultDuration: 5,
      defaultResolution: '480p竖'
    })
    expect(resolveAimanplayVideoProfile('minimax_h3_lightx2v')?.resolutions).toEqual([
      '480p竖',
      '480p横',
      '768p竖',
      '768p横',
      '480p(1:1)',
      '768p(1:1)'
    ])
    expect(resolveAimanplayVideoProfile('minimax_h3_image_audio_to_video_v2_15s')).toMatchObject({
      kind: 'ref-media',
      durationRange: [1, 15],
      defaultDuration: 15
    })
    expect(resolveAimanplayVideoProfile('minimax_h3_zm_u24')).toMatchObject({
      kind: 'ref-media',
      durationRange: [1, 15],
      defaultDuration: 5
    })
    expect(resolveAimanplayVideoProfile('minimax_h3_lightx2v_no_pic')).toMatchObject({
      kind: 'text-only',
      durationRange: [1, 10],
      defaultDuration: 5
    })
    expect(resolveAimanplayVideoProfile('kling-v1')).toBeNull()
    expect(resolveAimanplayVideoProfile('')).toBeNull()
  })

  it('first-last 档案：前两张参考图 → first_frame/last_frame，档案 duration/resolution 兜底', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const gateway = stubVideoFetch(fetchMock)
    gateway.push(() => jsonResponse({ task_id: 'fl-1', status: 'queued' }))

    await adapter.submitVideoTask!(createContext({ model: 'minimax_h3_lightx2v' }), {
      prompt: '首尾帧生成',
      refImages: [
        'data:image/png;base64,AA==',
        'data:image/png;base64,BB==',
        'data:image/png;base64,CC=='
      ]
    })

    // 只物化前两张（第三张不参与首尾帧协议）
    expect(ossPutUrls(fetchMock)).toHaveLength(2)
    const submit = JSON.parse(
      String(
        (
          fetchMock.mock.calls.find(
            ([url]) => String(url) === 'https://api.video.example/v1/videos'
          )?.[1] as RequestInit
        ).body
      )
    )
    expect(submit).toEqual({
      model: 'minimax_h3_lightx2v',
      prompt: '首尾帧生成',
      first_frame: ossPutUrls(fetchMock)[0],
      last_frame: ossPutUrls(fetchMock)[1],
      duration: 5,
      resolution: '480p竖'
    })
  })

  it('first-last 档案：只有 1 张参考图时报可读错误且不发起任何请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      adapter.submitVideoTask!(createContext({ model: 'minimax_h3_lightx2v' }), {
        prompt: 'x',
        refImages: ['data:image/png;base64,AA==']
      })
    ).rejects.toThrow('首尾帧模型 minimax_h3_lightx2v 需要 2 张参考图（首帧与尾帧）')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ref-media 档案：ref_image_N + ref_audio_N 展开，duration/resolution 取档案默认', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const gateway = stubVideoFetch(fetchMock)
    gateway.push(() => jsonResponse({ task_id: 'rm-1', status: 'queued' }))

    await adapter.submitVideoTask!(
      createContext({ model: 'minimax_h3_image_audio_to_video_v2_15s' }),
      {
        prompt: '图音参考生成',
        refImages: ['data:image/png;base64,AA==', 'data:image/png;base64,BB=='],
        refAudios: ['data:audio/mpeg;base64,CC==']
      }
    )

    const puts = ossPutUrls(fetchMock)
    expect(puts.filter((url) => url.endsWith('.png'))).toHaveLength(2)
    const audioUrl = puts.find((url) => url.endsWith('.mp3'))
    expect(audioUrl).toBeTruthy()
    const submit = JSON.parse(
      String(
        (
          fetchMock.mock.calls.find(
            ([url]) => String(url) === 'https://api.video.example/v1/videos'
          )?.[1] as RequestInit
        ).body
      )
    )
    expect(submit).toEqual({
      model: 'minimax_h3_image_audio_to_video_v2_15s',
      prompt: '图音参考生成',
      ref_image_0: puts[0],
      ref_image_1: puts[1],
      ref_audio_0: audioUrl,
      duration: 15,
      resolution: '480p竖'
    })
    expect(submit.width).toBeUndefined()
    expect(submit.height).toBeUndefined()
    expect(submit.fps).toBeUndefined()
    expect(submit.n).toBeUndefined()
    expect(submit.response_format).toBeUndefined()
  })

  it('ref-media 档案：图片封顶 9 张、音频封顶 3 段', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const gateway = stubVideoFetch(fetchMock)
    gateway.push(() => jsonResponse({ task_id: 'rm-cap', status: 'queued' }))

    await adapter.submitVideoTask!(createContext({ model: 'minimax_h3_zm_u24' }), {
      prompt: '封顶',
      refImages: Array.from({ length: NEWAPI_VIDEO_MAX_REF_IMAGES + 1 }, (_, index) =>
        Buffer.from(`img-${index}`).toString('base64')
      ).map((payload) => `data:image/png;base64,${payload}`),
      refAudios: Array.from({ length: NEWAPI_VIDEO_MAX_REF_AUDIOS + 2 }, (_, index) =>
        Buffer.from(`aud-${index}`).toString('base64')
      ).map((payload) => `data:audio/mpeg;base64,${payload}`)
    })

    const submit = JSON.parse(
      String(
        (
          fetchMock.mock.calls.find(
            ([url]) => String(url) === 'https://api.video.example/v1/videos'
          )?.[1] as RequestInit
        ).body
      )
    )
    expect(Object.keys(submit).filter((key) => key.startsWith('ref_image_'))).toHaveLength(
      NEWAPI_VIDEO_MAX_REF_IMAGES
    )
    expect(Object.keys(submit).filter((key) => key.startsWith('ref_audio_'))).toHaveLength(
      NEWAPI_VIDEO_MAX_REF_AUDIOS
    )
    expect(ossPutUrls(fetchMock)).toHaveLength(
      NEWAPI_VIDEO_MAX_REF_IMAGES + NEWAPI_VIDEO_MAX_REF_AUDIOS
    )
  })

  it('duration 钳制：20 → 15（v2_15s）、缺省 → 档案默认 15/5、首尾帧 20 → 10', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const gateway = stubVideoFetch(fetchMock)
    for (const taskId of ['d1', 'd2', 'd3', 'd4']) {
      gateway.push(() => jsonResponse({ task_id: taskId, status: 'queued' }))
    }

    await adapter.submitVideoTask!(
      createContext({ model: 'minimax_h3_image_audio_to_video_v2_15s' }),
      { prompt: 'x', duration: 20 }
    )
    await adapter.submitVideoTask!(
      createContext({ model: 'minimax_h3_image_audio_to_video_v2_15s' }),
      { prompt: 'x' }
    )
    await adapter.submitVideoTask!(createContext({ model: 'minimax_h3_zm_u24' }), { prompt: 'x' })
    await adapter.submitVideoTask!(createContext({ model: 'minimax_h3_lightx2v' }), {
      prompt: 'x',
      duration: 20,
      refImages: ['data:image/png;base64,AA==', 'data:image/png;base64,BB==']
    })

    const bodies = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/v1/videos'))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
    expect(bodies.map((body) => body.duration)).toEqual([15, 15, 5, 10])
  })

  it('resolution 校验：枚举外值报可读错误（不发起请求）；params 兜底与档案默认', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const gateway = stubVideoFetch(fetchMock)
    gateway.push(() => jsonResponse({ task_id: 'r1', status: 'queued' }))
    gateway.push(() => jsonResponse({ task_id: 'r2', status: 'queued' }))

    // 枚举外值：参数与素材校验先行，未触发任何 OSS/网关请求
    await expect(
      adapter.submitVideoTask!(createContext({ model: 'minimax_h3_lightx2v' }), {
        prompt: 'x',
        resolution: '1080p竖',
        refImages: ['data:image/png;base64,AA==', 'data:image/png;base64,BB==']
      })
    ).rejects.toThrow('不是模型 minimax_h3_lightx2v 支持的档位')
    expect(fetchMock).not.toHaveBeenCalled()

    // params.resolution 命中枚举 → 兜底生效；都缺省 → 档案默认 480p竖
    await adapter.submitVideoTask!(
      createContext({ model: 'minimax_h3_lightx2v', params: { resolution: '768p横' } }),
      {
        prompt: 'x',
        refImages: ['data:image/png;base64,AA==', 'data:image/png;base64,BB==']
      }
    )
    await adapter.submitVideoTask!(createContext({ model: 'minimax_h3_zm_u24' }), {
      prompt: 'x',
      refImages: ['data:image/png;base64,CC==']
    })
    const bodies = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/v1/videos'))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
    expect(bodies.map((body) => body.resolution)).toEqual(['768p横', '480p竖'])
  })

  it('text-only 档案：不带媒体字段，带参考素材时落 video-references-ignored 诊断', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const gateway = stubVideoFetch(fetchMock)
    gateway.push(() => jsonResponse({ task_id: 't1', status: 'queued' }))
    const diagSpy = vi.spyOn(mediaDiag, 'event')

    try {
      await adapter.submitVideoTask!(createContext({ model: 'minimax_h3_lightx2v_no_pic' }), {
        prompt: '纯文生视频',
        refImages: ['data:image/png;base64,AA=='],
        refAudios: ['data:audio/mpeg;base64,BB==']
      })

      const submit = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
      expect(submit).toEqual({
        model: 'minimax_h3_lightx2v_no_pic',
        prompt: '纯文生视频',
        duration: 5,
        resolution: '480p竖'
      })
      expect(ossPutUrls(fetchMock)).toHaveLength(0)
      expect(diagSpy).toHaveBeenCalledWith('video-references-ignored', {
        model: 'minimax_h3_lightx2v_no_pic',
        refImageCount: 1,
        refAudioCount: 1
      })
    } finally {
      diagSpy.mockRestore()
    }
  })

  it('URL 化内容缓存：同一 data URL 重复提交只 PUT 一次，ref_image 指向同一 OSS URL', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const gateway = stubVideoFetch(fetchMock)
    gateway.push(() => jsonResponse({ task_id: 'c1', status: 'queued' }))
    gateway.push(() => jsonResponse({ task_id: 'c2', status: 'queued' }))
    const input = { prompt: '缓存复用', refImages: ['data:image/png;base64,AA=='] }

    await adapter.submitVideoTask!(createContext(), input)
    await adapter.submitVideoTask!(createContext(), input)

    const putUrls = ossPutUrls(fetchMock)
    expect(putUrls).toHaveLength(1)
    const submitCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/videos'))
    expect(submitCalls).toHaveLength(2)
    const first = JSON.parse(String((submitCalls[0][1] as RequestInit).body))
    const second = JSON.parse(String((submitCalls[1][1] as RequestInit).body))
    expect(first.ref_image_0).toBe(putUrls[0])
    expect(second.ref_image_0).toBe(putUrls[0])
  })
})
