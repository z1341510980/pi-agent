/**
 * newapi-video adapter：NewAPI 视频任务协议（/video/generations）。
 *
 * 文档口径（docs/new-api/openapi/generated/ai-model/视频（Videos））：
 * - POST {base}/video/generations：{ model, prompt, image?, duration?, width?,
 *   height?, fps?, n?, response_format:'url' } → { task_id, status }（queued）；
 * - GET {base}/video/generations/{task_id}：status queued/in_progress 继续、
 *   completed → url 字段、failed → error.message。
 *
 * 轮询复用 shared 的 ImageJobPollSource / resolveImageResponse 机制（与图片任务
 *   同一套退避与状态判定：completed+url 被 parseImages 命中直接返回；failed 走
 *   imageJobFailure 带出服务端 error.message）。视频更慢，超时预算用专用
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

function pollSource(rt: VideoRuntime): ImageJobPollSource {
  return {
    providerId: rt.providerId,
    baseUrl: rt.baseUrl,
    headers: rt.headers,
    buildEndpoint: (jobId) =>
      `${rt.baseUrl}/video/generations/${encodeURIComponent(jobId)}`,
    endpointLabel: '/video/generations/{task_id}'
  }
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
    { key: 'fps', label: '帧率', type: 'number', placeholder: '30' }
  ],
  async generateVideo(
    ctx: MediaModalityContext,
    input: VideoGenerationInput
  ): Promise<{ outputs: Array<{ url: string; mimeType: string }> }> {
    const rt = createRuntime(ctx)
    const body = {
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
    const guard = withAbortGuard(input.signal, VIDEO_JOB_TIMEOUT_MS)
    try {
      const response = await fetch(`${rt.baseUrl}/video/generations`, {
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
        pollSource(rt),
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
          endpoint: '/video/generations',
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
