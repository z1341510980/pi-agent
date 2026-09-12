/**
 * newapi-video adapter：NewAPI 视频任务协议 + 多参考图协议。
 *
 * 文档口径（docs/new-api/openapi/generated/ai-model/视频（Videos））：
 * - POST {base}/video/generations：{ model, prompt, image?, duration?, width?,
 *   height?, fps?, n?, response_format:'url' } → { task_id, status }（queued）；
 * - GET {base}/video/generations/{task_id}：status queued/in_progress 继续、
 *   completed → url 字段、failed → error.message。
 *
 * 实测 NewAPI 兼容网关（aimanplay 等）的轮询响应不是文档的扁平形状，而是包裹层
 * {code,message,data:{status:'SUCCESS',fail_reason,result_url,progress,data:{results:[{url}]}}}；
 * 视频 URL 经 extractVideoUrls 提取（submit/poll 两条路径共用），失败原因优先取
 * data.fail_reason —— 均通过 ImageJobPollSource 的 extractUrls/failureText 覆盖注入，
 * 不改动 shared.parseImages 的图片语义。
 *
 * 多参考图协议（ComfyUI 类频道）：refImages 存在时提交 POST {base}/v1/videos，
 * 请求体为扁平 ref_image_0..N 字段 + duration/resolution（不带 width/height/fps/
 * n/response_format），轮询端点切换为 GET {base}/v1/videos/{task_id}。
 *
 * 异步任务拆分（设计 Task 2）：submitVideoTask（提交即返回 task_id）与
 * pollVideoTask（单次状态查询，归一化 queued/in_progress/success/failed）供
 * 服务端任务队列使用；generateVideo 保留同步实现，内部复用同一 submit/poll
 * 原语（提交响应已有成品 URL 直接返回，否则按图片任务的退避节奏轮询）。
 */

import type {
  MediaModalityContext,
  MediaProviderAdapter,
  VideoGenerationInput,
  VideoTaskPollInput,
  VideoTaskPollResult,
  VideoTaskProtocol,
  VideoTaskSubmission
} from '../adapter.js'
import {
  IMAGE_POLL_INITIAL_DELAY_MS,
  VIDEO_JOB_TIMEOUT_MS,
  delay,
  errorText,
  imageErrorMessage,
  imageJob,
  imageJobFailure,
  isCompletedStatus,
  isFailedStatus,
  isRecord,
  nextImagePollDelayMs,
  normalizeImageBaseUrl,
  readImageResponse,
  recordCandidates,
  safeBaseUrl,
  taskStatus,
  withAbortGuard,
  type ImageJobPollSource
} from '../shared.js'

/** Provider 行 model 留空时的文档示例模型（kling-v1）。 */
export const NEWAPI_VIDEO_DEFAULT_MODEL = 'kling-v1'

/** adapter 参数缺省值（formSchema 声明同源）。 */
export const NEWAPI_VIDEO_DEFAULTS = { duration: 5, width: 1280, height: 720, fps: 30 } as const

/** ref_image_N 多参考协议的参考图上限（路由层入参校验与此同源）。 */
export const NEWAPI_VIDEO_MAX_REF_IMAGES = 8

/** 上游「排队中」状态词（其余非终态一律按 in_progress 继续轮询）。 */
const VIDEO_POLL_QUEUED_STATUSES = new Set(['queued', 'pending', 'created', 'waiting'])

/**
 * NewAPI 兼容网关的视频 URL 提取。实测包裹链是 data → data.data → data.data.data
 * （results 数组最深一层），优先级回落：result_url → results[].url → 任意层的 url
 * （文档扁平形状的顶层 url 兜底）。同一产物的多路编码（result_url 与嵌套 results
 * 并存）只取首个命中源，避免重复输出。submit/poll 两条路径共用。
 */
export function extractVideoUrls(body: unknown): string[] {
  if (!isRecord(body)) return []
  const layers = recordCandidates(body)
  for (const layer of layers) {
    if (typeof layer.result_url === 'string' && layer.result_url.length > 0) {
      return [layer.result_url]
    }
  }
  for (const layer of layers) {
    if (!Array.isArray(layer.results)) continue
    const urls: string[] = []
    for (const item of layer.results) {
      const url = isRecord(item) ? item.url : undefined
      if (typeof url === 'string' && url.length > 0 && !urls.includes(url)) urls.push(url)
    }
    if (urls.length) return urls
  }
  for (const layer of layers) {
    if (typeof layer.url === 'string' && layer.url.length > 0) return [layer.url]
  }
  return []
}

/** 视频任务失败文本：data.fail_reason 非空即失败（包裹层字段，status 可能只写 FAIL）。 */
export function videoFailureText(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.data)) return undefined
  const reason = body.data.fail_reason
  return typeof reason === 'string' && reason.trim() ? reason.trim() : undefined
}

/** 轮询响应里的进度文本（如 '42%'）：取包裹链任意层的 progress 字符串。 */
export function videoProgress(body: unknown): string | undefined {
  for (const candidate of recordCandidates(body)) {
    const progress = candidate.progress
    if (typeof progress === 'string' && progress.trim()) return progress.trim()
  }
  return undefined
}

interface VideoRuntime {
  providerId: string
  baseUrl: string
  model: string
  headers: Record<string, string>
}

function createRuntime(ctx: MediaModalityContext): VideoRuntime {
  return {
    providerId: ctx.providerId,
    baseUrl: normalizeImageBaseUrl(ctx.baseUrl),
    model: ctx.model || NEWAPI_VIDEO_DEFAULT_MODEL,
    headers: ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}
  }
}

function providerLabel(rt: VideoRuntime): string {
  return rt.providerId || safeBaseUrl(rt.baseUrl)
}

function pollSource(rt: VideoRuntime, useRefProtocol: boolean): ImageJobPollSource {
  return {
    providerId: rt.providerId,
    baseUrl: rt.baseUrl,
    headers: rt.headers,
    buildEndpoint: (jobId) =>
      useRefProtocol
        ? `${rt.baseUrl}/videos/${encodeURIComponent(jobId)}`
        : `${rt.baseUrl}/video/generations/${encodeURIComponent(jobId)}`,
    endpointLabel: useRefProtocol ? '/v1/videos/{task_id}' : '/video/generations/{task_id}',
    extractUrls: extractVideoUrls,
    failureText: videoFailureText
  }
}

/** 多参考协议载荷：refImages 按发送顺序展开成扁平 ref_image_0..N 字段。 */
function refImageFields(refImages: string[]): Record<string, string> {
  const fields: Record<string, string> = {}
  refImages.forEach((value, index) => {
    fields[`ref_image_${index}`] = value
  })
  return fields
}

function numberParam(
  value: number | undefined,
  param: string | undefined,
  fallback: number
): number {
  if (value !== undefined && Number.isFinite(value) && value > 0) return value
  const parsed = Number(param)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return fallback
}

interface VideoSubmitPlan {
  body: Record<string, unknown>
  submitEndpoint: string
  protocol: VideoTaskProtocol
}

/** 组装提交载荷：带参考图 → /v1/videos（ref_image_N）；否则文档协议 /video/generations。 */
function buildSubmitPlan(
  rt: VideoRuntime,
  ctx: MediaModalityContext,
  input: VideoGenerationInput
): VideoSubmitPlan {
  const refImages = input.refImages
    ?.filter((value) => value.length > 0)
    .slice(0, NEWAPI_VIDEO_MAX_REF_IMAGES)
  const useRefProtocol = Boolean(refImages?.length)
  const resolution = input.resolution?.trim() || ctx.params.resolution?.trim() || ''
  const body = useRefProtocol
    ? {
        model: input.model || rt.model,
        prompt: input.prompt,
        ...refImageFields(refImages!),
        duration: numberParam(input.duration, ctx.params.duration, NEWAPI_VIDEO_DEFAULTS.duration),
        ...(resolution ? { resolution } : {})
      }
    : {
        model: input.model || rt.model,
        prompt: input.prompt,
        ...(input.image ? { image: input.image } : {}),
        duration: numberParam(input.duration, ctx.params.duration, NEWAPI_VIDEO_DEFAULTS.duration),
        width: numberParam(input.width, ctx.params.width, NEWAPI_VIDEO_DEFAULTS.width),
        height: numberParam(input.height, ctx.params.height, NEWAPI_VIDEO_DEFAULTS.height),
        fps: numberParam(input.fps, ctx.params.fps, NEWAPI_VIDEO_DEFAULTS.fps),
        ...(input.n !== undefined && Number.isFinite(input.n) ? { n: Math.floor(input.n) } : {}),
        response_format: 'url'
      }
  return {
    body,
    submitEndpoint: useRefProtocol ? `${rt.baseUrl}/videos` : `${rt.baseUrl}/video/generations`,
    protocol: useRefProtocol ? 'videos' : 'generations'
  }
}

/**
 * 提交视频任务（submitVideoTask 与 generateVideo 共用）：POST 提交端点并解析
 * task_id。语义与同步实现的 resolveImageResponse 逐条对齐 —— 成品 URL 优先、
 * data.fail_reason 次之、再按状态判定 failed/completed，均直接抛错。
 * 同步形状网关（响应带成品 URL 无 task_id）返回 urls + 空串 taskId。
 */
async function submitVideoRequest(
  rt: VideoRuntime,
  plan: VideoSubmitPlan,
  signal: AbortSignal | undefined
): Promise<VideoTaskSubmission> {
  const guard = withAbortGuard(signal, VIDEO_JOB_TIMEOUT_MS)
  try {
    const response = await fetch(plan.submitEndpoint, {
      method: 'POST',
      headers: { ...rt.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(plan.body),
      signal: guard.signal
    })
    const responseBody = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(
        `视频生成失败: ${imageErrorMessage(responseBody) || `HTTP ${response.status}`}`
      )
    }
    const urls = extractVideoUrls(responseBody)
    if (urls.length) {
      // 提交响应已携带成品 URL（提交即完成 / 同步形状网关）：无需任务轮询
      return {
        taskId: imageJob(responseBody)?.id ?? '',
        protocol: plan.protocol,
        status: 'success',
        urls
      }
    }
    const failureText = videoFailureText(responseBody)
    if (failureText) throw new Error(`视频生成失败: ${failureText}`)
    const job = imageJob(responseBody)
    if (!job?.id) throw new Error('视频 Provider 返回中没有视频数据')
    const status = taskStatus(job.status)
    if (isFailedStatus(status)) throw imageJobFailure(responseBody, '视频生成失败')
    if (isCompletedStatus(status)) throw new Error('视频 Provider 返回中没有视频数据')
    return { taskId: job.id, protocol: plan.protocol, status: status || 'queued' }
  } finally {
    guard.dispose()
  }
}

/**
 * 单次任务状态查询（pollVideoTask 与 generateVideo 轮询循环共用）：GET 任务端点
 * 一次，把上游形状归一化成 queued/in_progress/success/failed；HTTP 层错误直接
 * 抛出（worker 记日志后下轮重试，refresh 路由按 502 透出）。
 */
async function pollVideoTaskOnce(
  rt: VideoRuntime,
  input: VideoTaskPollInput
): Promise<VideoTaskPollResult> {
  const source = pollSource(rt, input.protocol === 'videos')
  const guard = withAbortGuard(input.signal)
  try {
    const response = await fetch(source.buildEndpoint(input.taskId), {
      headers: source.headers,
      signal: guard.signal
    })
    const body = await readImageResponse(response, '视频任务查询失败')
    const progress = videoProgress(body)
    const withProgress = (result: VideoTaskPollResult): VideoTaskPollResult =>
      progress ? { ...result, progress } : result
    const urls = extractVideoUrls(body)
    if (urls.length) return withProgress({ status: 'success', url: urls[0] })
    const failureText = source.failureText?.(body)
    if (failureText) return withProgress({ status: 'failed', error: failureText })
    const statusCandidate = recordCandidates(body).find(
      (candidate) => typeof candidate.status === 'string' || typeof candidate.state === 'string'
    )
    const fallbackStatus = statusCandidate?.status ?? statusCandidate?.state
    const job = imageJob(body)
    const rawStatus = job?.status ?? (typeof fallbackStatus === 'string' ? fallbackStatus : '')
    const status = taskStatus(rawStatus)
    if (isFailedStatus(status)) {
      return withProgress({
        status: 'failed',
        error: imageErrorMessage(body) || rawStatus || '视频任务失败'
      })
    }
    if (isCompletedStatus(status)) {
      // 上游判定完成但提取不出 URL：无法本地化，按失败透出可读原因
      return withProgress({ status: 'failed', error: '视频 Provider 返回中没有视频数据' })
    }
    if (!job && !status) {
      return withProgress({ status: 'failed', error: '视频 Provider 返回中没有视频数据' })
    }
    return withProgress({
      status: VIDEO_POLL_QUEUED_STATUSES.has(status) ? 'queued' : 'in_progress'
    })
  } finally {
    guard.dispose()
  }
}

export const newapiVideoAdapter: MediaProviderAdapter = {
  id: 'newapi-video',
  label: 'NewAPI 视频任务',
  modality: 'video',
  capabilities: { generate: true },
  formSchema: [
    { key: 'duration', label: '时长（秒）', type: 'number', placeholder: '5' },
    { key: 'width', label: '宽度', type: 'number', placeholder: '1280' },
    { key: 'height', label: '高度', type: 'number', placeholder: '720' },
    { key: 'fps', label: '帧率', type: 'number', placeholder: '30' },
    { key: 'resolution', label: '分辨率', type: 'text', placeholder: '如 768p竖（多参考协议透传）' }
  ],
  async generateVideo(
    ctx: MediaModalityContext,
    input: VideoGenerationInput
  ): Promise<{ outputs: Array<{ url: string; mimeType: string }> }> {
    const rt = createRuntime(ctx)
    const plan = buildSubmitPlan(rt, ctx, input)
    const guard = withAbortGuard(input.signal, VIDEO_JOB_TIMEOUT_MS)
    try {
      // 提交：拿 task_id 或提交即完成的成品 URL（与队列链路 submitVideoTask 同一实现）
      const submission = await submitVideoRequest(rt, plan, input.signal)
      if (submission.urls?.length) {
        return {
          outputs: submission.urls.map((url) => ({ url, mimeType: 'video/mp4' }))
        }
      }
      // 轮询：与 pollVideoTask 同一单次查询实现，退避节奏与图片任务一致
      // （首个间隔 2s，其后 1.5 倍递增封顶 10s）
      let waitMs = IMAGE_POLL_INITIAL_DELAY_MS
      for (;;) {
        await delay(waitMs, guard.signal)
        const poll = await pollVideoTaskOnce(rt, {
          taskId: submission.taskId,
          protocol: submission.protocol,
          signal: guard.signal
        })
        if (poll.status === 'success') {
          return { outputs: [{ url: poll.url!, mimeType: 'video/mp4' }] }
        }
        if (poll.status === 'failed') {
          throw new Error(`视频生成失败: ${poll.error ?? '任务失败'}`)
        }
        waitMs = nextImagePollDelayMs(waitMs)
      }
    } catch (error) {
      ctx.logger?.error?.(
        {
          providerId: rt.providerId,
          provider: providerLabel(rt),
          endpoint: plan.protocol === 'videos' ? '/v1/videos' : '/video/generations',
          error: errorText(error)
        },
        '视频请求失败'
      )
      throw error
    } finally {
      guard.dispose()
    }
  },
  async submitVideoTask(
    ctx: MediaModalityContext,
    input: VideoGenerationInput
  ): Promise<VideoTaskSubmission> {
    const rt = createRuntime(ctx)
    return submitVideoRequest(rt, buildSubmitPlan(rt, ctx, input), input.signal)
  },
  async pollVideoTask(
    ctx: MediaModalityContext,
    input: VideoTaskPollInput
  ): Promise<VideoTaskPollResult> {
    return pollVideoTaskOnce(createRuntime(ctx), input)
  }
}
