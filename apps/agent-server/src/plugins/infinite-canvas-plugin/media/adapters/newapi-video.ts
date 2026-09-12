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
 * {code,message,data:{status:'SUCCESS',fail_reason,result_url,data:{data:{results:[{url}]}}}}；
 * 视频 URL 经 extractVideoUrls 提取（submit/poll 两条路径共用），失败原因优先取
 * data.fail_reason —— 均通过 ImageJobPollSource 的 extractUrls/failureText 覆盖注入，
 * 不改动 shared.parseImages 的图片语义。
 *
 * 多参考图协议（ComfyUI 类频道）：refImages 存在时提交 POST {base}/v1/videos，
 * 请求体为扁平 ref_image_0..N 字段 + duration/resolution（不带 width/height/fps/
 * n/response_format），轮询端点切换为 GET {base}/v1/videos/{task_id}。
 *
 * 轮询复用 shared 的 ImageJobPollSource / resolveImageResponse 机制（与图片任务
 *   同一套退避与状态判定）。视频更慢，超时预算用专用
 *   VIDEO_JOB_TIMEOUT_MS（30min，实测存在 15min+ 才完成的任务）。
 */

import type {
  MediaModalityContext,
  MediaProviderAdapter,
  VideoGenerationInput
} from '../adapter.js'
import {
  VIDEO_JOB_TIMEOUT_MS,
  errorText,
  imageErrorMessage,
  isRecord,
  normalizeImageBaseUrl,
  resolveImageResponse,
  safeBaseUrl,
  withAbortGuard,
  type ImageJobPollSource
} from '../shared.js'

/** Provider 行 model 留空时的文档示例模型（kling-v1）。 */
export const NEWAPI_VIDEO_DEFAULT_MODEL = 'kling-v1'

/** adapter 参数缺省值（formSchema 声明同源）。 */
export const NEWAPI_VIDEO_DEFAULTS = { duration: 5, width: 1280, height: 720, fps: 30 } as const

/** ref_image_N 多参考协议的参考图上限（路由层入参校验与此同源）。 */
export const NEWAPI_VIDEO_MAX_REF_IMAGES = 8

/**
 * NewAPI 兼容网关的视频 URL 提取。实测包裹链是 data → data.data → data.data.data
 * （results 数组最深一层），优先级回落：result_url → results[].url → 任意层的 url
 * （文档扁平形状的顶层 url 兜底）。同一产物的多路编码（result_url 与嵌套 results
 * 并存）只取首个命中源，避免重复输出。submit/poll 两条路径共用。
 */
export function extractVideoUrls(body: unknown): string[] {
  if (!isRecord(body)) return []
  // data 包裹链逐层展开（live 形状最深 3 层，留 1 层余量）
  const layers: Record<string, unknown>[] = [body]
  let current: unknown = body.data
  for (let depth = 0; depth < 4 && isRecord(current); depth += 1) {
    layers.push(current)
    current = current.data
  }
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
    // 协议切换：带参考图 → /v1/videos（ref_image_N）；否则保持文档协议 /video/generations。
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
          duration: numberParam(
            input.duration,
            ctx.params.duration,
            NEWAPI_VIDEO_DEFAULTS.duration
          ),
          ...(resolution ? { resolution } : {})
        }
      : {
          model: input.model || rt.model,
          prompt: input.prompt,
          ...(input.image ? { image: input.image } : {}),
          duration: numberParam(
            input.duration,
            ctx.params.duration,
            NEWAPI_VIDEO_DEFAULTS.duration
          ),
          width: numberParam(input.width, ctx.params.width, NEWAPI_VIDEO_DEFAULTS.width),
          height: numberParam(input.height, ctx.params.height, NEWAPI_VIDEO_DEFAULTS.height),
          fps: numberParam(input.fps, ctx.params.fps, NEWAPI_VIDEO_DEFAULTS.fps),
          ...(input.n !== undefined && Number.isFinite(input.n) ? { n: Math.floor(input.n) } : {}),
          response_format: 'url'
        }
    const submitEndpoint = useRefProtocol
      ? `${rt.baseUrl}/videos`
      : `${rt.baseUrl}/video/generations`
    const guard = withAbortGuard(input.signal, VIDEO_JOB_TIMEOUT_MS)
    try {
      const response = await fetch(submitEndpoint, {
        method: 'POST',
        headers: { ...rt.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: guard.signal
      })
      const responseBody = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(
          `视频生成失败: ${imageErrorMessage(responseBody) || `HTTP ${response.status}`}`
        )
      }
      const urls = await resolveImageResponse(
        pollSource(rt, useRefProtocol),
        responseBody,
        guard.signal,
        '视频生成失败',
        '视频 Provider 返回中没有视频数据',
        ctx.logger,
        input.traceId
      )
      return {
        outputs: urls.map((url) => ({ url, mimeType: 'video/mp4' }))
      }
    } catch (error) {
      ctx.logger?.error?.(
        {
          providerId: rt.providerId,
          provider: providerLabel(rt),
          endpoint: useRefProtocol ? '/v1/videos' : '/video/generations',
          error: errorText(error)
        },
        '视频请求失败'
      )
      throw error
    } finally {
      guard.dispose()
    }
  }
}
