/**
 * apimart adapter：APIMart 异步任务图片协议。
 *
 * 从 core/config/media-generator.ts 的 apimart 分支整体迁移，行为等价为硬约束：
 * /images/generations 提交（比例 size/resolution/image_urls 均进 JSON，不走
 * multipart /images/edits）、/tasks/{task_id}?language= 轮询、mask 局部重绘
 * 不支持（editImage 直接抛错）、默认模型 gpt-image-2（APIMART_DEFAULT_IMAGE_MODEL）。
 *
 * 与迁移前的口径对齐（等价性不受影响）：
 * - ctx.baseUrl 经 normalizeImageBaseUrl 归一（原依赖 resolveRequestContext
 *   上游归一；此处幂等，已含 /v1 的 URL 原样保留）。
 * - ctx.params.resolution/language 取代 ImageRequestContext.mediaResolution/
 *   mediaLanguage（由 Registry 从 media_providers 行解析）。
 * - size 无值时 payload 不携带该字段（formSchema 未声明 size 参数，
 *   旧 facade 的 '1:1' 兜底随旧双路一并移除，由服务端默认兜底）。
 */

import type { FastifyBaseLogger } from 'fastify'
import { mediaDiag } from '../../config/media-diag.js'
import type {
  ImageEditInput,
  ImageGenerationInput,
  MediaModalityContext,
  MediaProviderAdapter
} from '../adapter.js'
import {
  IMAGE_JOB_TIMEOUT_MS,
  errorText,
  imageJob,
  imageResponseShape,
  normalizeImageBaseUrl,
  readImageResponse,
  referenceStats,
  resolveImageResponse,
  safeBaseUrl,
  withAbortGuard,
  type ImageJobPollSource
} from '../shared.js'

/** APIMart 图片任务默认模型（文档口径，与迁移前 defaultImageModelForProtocol 一致）。 */
export const APIMART_DEFAULT_IMAGE_MODEL = 'gpt-image-2'

const APIMART_SIZE_ALIASES: Record<string, string> = {
  '1024x1024': '1:1',
  '512x512': '1:1',
  '1536x1024': '3:2',
  '1024x1536': '2:3',
  '1792x1024': '16:9',
  '1280x720': '16:9',
  '1920x1080': '16:9'
}

/** Convert the canvas' legacy pixel-size options to APIMart's aspect-ratio values. */
export function normalizeApimartSize(size: string | undefined): string | undefined {
  const value = size?.trim()
  if (!value || value === 'auto') return undefined
  return APIMART_SIZE_ALIASES[value] || (/^\d+:\d+$/.test(value) ? value : value)
}

/** adapter 内部请求运行时：ctx 归一化后的 baseUrl + 由 apiKey 构造的鉴权头。 */
interface AdapterRuntime {
  providerId: string
  baseUrl: string
  model: string
  headers: Record<string, string>
  logger?: FastifyBaseLogger
}

function createRuntime(ctx: MediaModalityContext): AdapterRuntime {
  return {
    providerId: ctx.providerId,
    baseUrl: normalizeImageBaseUrl(ctx.baseUrl),
    // 行内默认：Provider 行 model 留空时回退文档默认模型（与迁移前
    // resolveRequestContext 的 defaultImageModelForProtocol 兜底一致）
    model: ctx.model || APIMART_DEFAULT_IMAGE_MODEL,
    // 与迁移前等价：空 Key 时不携带 Authorization 头
    headers: ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {},
    logger: ctx.logger
  }
}

function providerLabel(rt: AdapterRuntime): string {
  return rt.providerId || safeBaseUrl(rt.baseUrl)
}

/** 轮询源：任务状态端点附语言参数（与迁移前 taskEndpoint 一致）。 */
function pollSource(rt: AdapterRuntime, language: string): ImageJobPollSource {
  return {
    providerId: rt.providerId,
    baseUrl: rt.baseUrl,
    headers: rt.headers,
    buildEndpoint: (jobId) =>
      `${rt.baseUrl}/tasks/${encodeURIComponent(jobId)}?language=${encodeURIComponent(language)}`,
    endpointLabel: '/tasks/{task_id}'
  }
}

function apimartPayload(input: {
  model: string
  prompt: string
  references?: string[]
  size?: string
  resolution?: string
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: input.model,
    prompt: input.prompt,
    // APIMart 当前任务协议一次只返回一个结果；保留 count 仅供统一接口兼容。
    n: 1
  }
  const size = normalizeApimartSize(input.size)
  if (size) payload.size = size
  const resolution = input.resolution?.trim()
  if (resolution) payload.resolution = resolution
  if (input.references?.length) payload.image_urls = input.references
  return payload
}

/** Submit the APIMart task request and resolve synchronous or asynchronous results. */
async function submitTaskGeneration(
  rt: AdapterRuntime,
  input: {
    prompt: string
    references?: string[]
    size?: string
    count: number
    resolution?: string
    language: string
    signal?: AbortSignal
    traceId?: string
  }
): Promise<{ images: string[] }> {
  const startedAt = Date.now()
  const hasReferences = Boolean(input.references?.length)
  const operation = hasReferences ? 'edit' : 'generate'
  const endpoint = '/images/generations'
  rt.logger?.info(
    {
      traceId: input.traceId,
      providerId: rt.providerId,
      provider: providerLabel(rt),
      protocol: 'apimart',
      baseUrl: safeBaseUrl(rt.baseUrl),
      endpoint,
      model: rt.model,
      size: input.size,
      resolution: input.resolution,
      count: input.count,
      referenceCount: input.references?.length ?? 0,
      operation
    },
    '图片请求开始'
  )

  const guard = withAbortGuard(input.signal, IMAGE_JOB_TIMEOUT_MS)
  try {
    const n = Math.min(4, Math.max(1, input.count))
    const body = apimartPayload({
      model: rt.model,
      prompt: input.prompt,
      references: input.references,
      size: input.size,
      resolution: input.resolution
    })
    mediaDiag.event('generation-submit', {
      traceId: input.traceId,
      provider: providerLabel(rt),
      protocol: 'apimart',
      endpoint,
      model: rt.model,
      size: input.size,
      count: n,
      referencesInJson: hasReferences,
      ...referenceStats(input.references)
    })
    const response = await fetch(`${rt.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { ...rt.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: guard.signal
    })
    const responseBody = await readImageResponse(response, '图片生成失败')
    const job = imageJob(responseBody)
    mediaDiag.event('generation-response', {
      traceId: input.traceId,
      provider: providerLabel(rt),
      endpoint,
      status: response.status,
      responseShape: imageResponseShape(responseBody),
      jobId: job?.id,
      jobStatus: job?.status
    })
    rt.logger?.info(
      {
        traceId: input.traceId,
        providerId: rt.providerId,
        provider: providerLabel(rt),
        protocol: 'apimart',
        baseUrl: safeBaseUrl(rt.baseUrl),
        endpoint,
        status: response.status,
        responseShape: imageResponseShape(responseBody),
        jobId: job?.id,
        jobStatus: job?.status
      },
      '图片请求已提交'
    )
    const images = await resolveImageResponse(
      pollSource(rt, input.language),
      responseBody,
      guard.signal,
      '图片生成失败',
      '图片 Provider 返回中没有图片数据',
      rt.logger,
      input.traceId
    )
    rt.logger?.info(
      {
        traceId: input.traceId,
        providerId: rt.providerId,
        provider: providerLabel(rt),
        protocol: 'apimart',
        endpoint,
        outputCount: images.length,
        durationMs: Date.now() - startedAt
      },
      '图片请求完成'
    )
    mediaDiag.event('generation-done', {
      traceId: input.traceId,
      provider: providerLabel(rt),
      endpoint,
      outputCount: images.length,
      durationMs: Date.now() - startedAt
    })
    return { images }
  } catch (error) {
    rt.logger?.error(
      {
        traceId: input.traceId,
        providerId: rt.providerId,
        provider: providerLabel(rt),
        protocol: 'apimart',
        endpoint,
        durationMs: Date.now() - startedAt,
        error: errorText(error)
      },
      '图片请求失败'
    )
    mediaDiag.event('generation-error', {
      traceId: input.traceId,
      provider: providerLabel(rt),
      endpoint,
      durationMs: Date.now() - startedAt,
      error: errorText(error)
    })
    throw error
  } finally {
    guard.dispose()
  }
}

/**
 * APIMart 异步任务 adapter。
 * 约定：formSchema 只声明 adapter 特有参数（resolution/language）；baseUrl/
 * apiKey/model 为所有 adapter 通用列，由设置页固定渲染。
 */
export const apimartAdapter: MediaProviderAdapter = {
  id: 'apimart',
  label: 'APIMart 异步任务',
  modality: 'image',
  capabilities: { generate: true, edit: true, mask: false, analyze: false },
  formSchema: [
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
  ],
  async generateImage(
    ctx: MediaModalityContext,
    input: ImageGenerationInput
  ): Promise<{ images: string[] }> {
    const rt = createRuntime(ctx)
    return submitTaskGeneration(rt, {
      prompt: input.prompt,
      references: input.references,
      // 与迁移前一致：调用方显式 size > Provider params.size；无值时不携带该字段
      size: input.size || ctx.params.size,
      count: input.count ?? 1,
      resolution: ctx.params.resolution,
      language: ctx.params.language?.trim() || 'en',
      signal: input.signal,
      traceId: input.traceId
    })
  },
  async editImage(ctx: MediaModalityContext, input: ImageEditInput): Promise<{ images: string[] }> {
    // 与迁移前一致：APIMart 无蒙版能力，编辑走 generations+image_urls
    if (input.mask) throw new Error('APIMart 图片协议不支持 mask 局部重绘')
    return apimartAdapter.generateImage!(ctx, {
      prompt: input.prompt,
      references: [input.image, ...(input.images ?? [])],
      size: input.size,
      count: 1,
      signal: input.signal,
      traceId: input.traceId
    })
  }
}
