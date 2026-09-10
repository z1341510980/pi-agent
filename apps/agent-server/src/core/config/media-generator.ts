import type { FastifyBaseLogger } from 'fastify'
import type { ProviderConfigStore } from './provider-config-store.js'
import { normalizeMediaProtocol, type MediaProtocol } from './provider-config-store.js'
import { normalizeProviderBaseUrl } from './provider-base-url.js'
import { mediaDiag } from './media-diag.js'
import { defaultImageModelForBaseUrl, isXKiroBaseUrl, openaiImagesAdapter } from '../media/adapters/openai-images.js'
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
  safeProviderLabel,
  withAbortGuard,
  type ImageJobPollSource
} from '../media/shared.js'
import type { MediaModalityContext } from '../media/adapter.js'

// 过渡期 re-export：公共工具已迁移至 core/media/shared.ts 与 openai-images
// adapter，保持既有导出签名防外部引用断裂（Task 4 切换调用链后清理）。
export { normalizeImageBaseUrl, normalizeOpenAiCompatibleSize, parseImages } from '../media/shared.js'
export { defaultImageModelForBaseUrl } from '../media/adapters/openai-images.js'

export interface MediaGenerator {
  generateImage(input: {
    prompt: string
    references?: string[]
    model?: string
    size?: string
    count?: number
    traceId?: string
    signal?: AbortSignal
  }): Promise<{ images: string[] }>
  generateAudio(input: {
    prompt: string
    model?: string
    voice?: string
    format?: string
    speed?: number
    signal?: AbortSignal
  }): Promise<{ outputs: Array<{ url: string; mimeType: string }> }>
  generateVideo(input: {
    prompt: string
    model?: string
    size?: string
    seconds?: number
    signal?: AbortSignal
  }): Promise<{ outputs: Array<{ url: string; mimeType: string }> }>
  /** 图像编辑（蒙版局部重绘）：OpenAI 兼容 /images/edits。 */
  editImage?(input: {
    prompt: string
    image: string
    images?: string[]
    mask?: string
    model?: string
    size?: string
    traceId?: string
    signal?: AbortSignal
  }): Promise<{ images: string[] }>
  /** 视觉理解（反推提示词等）：OpenAI 兼容 /chat/completions 多模态消息。 */
  analyzeImage?(input: {
    image: string
    instruction?: string
    model?: string
    signal?: AbortSignal
  }): Promise<{ text: string }>
}

export interface ImageRequestContext {
  providerId?: string
  providerApi?: string
  baseUrl: string
  headers: Record<string, string>
  modelId: string
  /** Explicit image protocol; omitted values remain OpenAI-compatible. */
  mediaProtocol?: MediaProtocol
  /** APIMart-style asynchronous image resolution, e.g. 1k/2k/4k. */
  mediaResolution?: string
  /** Locale sent to asynchronous media task status endpoints. */
  mediaLanguage?: string
}

export interface MediaGeneratorOptions {
  logger?: FastifyBaseLogger
}

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

function apimartPayload(input: {
  context: ImageRequestContext
  prompt: string
  references?: string[]
  size?: string
  count: number
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: input.context.modelId,
    prompt: input.prompt,
    // APIMart 当前任务协议一次只返回一个结果；保留 count 仅供统一接口兼容。
    n: 1
  }
  const size = normalizeApimartSize(input.size)
  if (size) payload.size = size
  if (input.context.mediaResolution?.trim()) payload.resolution = input.context.mediaResolution.trim()
  if (input.references?.length) payload.image_urls = input.references
  return payload
}

function protocolFor(context: ImageRequestContext): MediaProtocol {
  return normalizeMediaProtocol(context.mediaProtocol)
}

function taskEndpoint(context: ImageRequestContext, jobId: string): string {
  if (protocolFor(context) === 'apimart') {
    const language = encodeURIComponent(context.mediaLanguage?.trim() || 'en')
    return `${context.baseUrl}/tasks/${encodeURIComponent(jobId)}?language=${language}`
  }
  return `${context.baseUrl}/images/generations/${encodeURIComponent(jobId)}`
}

function taskEndpointLabel(context: ImageRequestContext): string {
  return protocolFor(context) === 'apimart'
    ? '/tasks/{task_id}'
    : '/images/generations/{id}'
}

function apimartPollSource(context: ImageRequestContext): ImageJobPollSource {
  return {
    providerId: context.providerId,
    providerApi: context.providerApi,
    baseUrl: context.baseUrl,
    headers: context.headers,
    buildEndpoint: (jobId) => taskEndpoint(context, jobId),
    endpointLabel: taskEndpointLabel(context)
  }
}

/**
 * 过渡期桥接：把 ImageRequestContext 适配为 adapter 的 MediaModalityContext。
 * providerId 缺省时以 providerApi/安全化 baseUrl 兜底，使诊断 provider 标签与
 * adapter 探测缓存键（providerId:baseUrl）同迁移前一一对应。
 */
function toMediaModalityContext(
  context: ImageRequestContext,
  logger?: FastifyBaseLogger
): MediaModalityContext {
  const authorization = context.headers.Authorization
  const apiKey = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
  return {
    providerId: context.providerId || context.providerApi || safeBaseUrl(context.baseUrl),
    baseUrl: context.baseUrl,
    apiKey,
    model: context.modelId,
    params: {},
    logger
  }
}

/** Submit an image generation request and resolve synchronous or asynchronous results. */
export async function requestImageGeneration(input: {
  context: ImageRequestContext
  prompt: string
  references?: string[]
  size?: string
  count: number
  signal?: AbortSignal
  logger?: FastifyBaseLogger
  traceId?: string
  /**
   * 参考图随 JSON 的 image_urls 提交，而不是走 multipart /images/edits。
   * 该路径原仅由 requestImageEdit 的编辑回退使用，现已是 openai-images
   * adapter 的内部实现；参数保留仅为导出签名兼容，外部无调用方。
   */
  referencesInJson?: boolean
}): Promise<{ images: string[] }> {
  if (protocolFor(input.context) !== 'apimart') {
    // openai-images 协议整体委托 adapter（含参考图 → 编辑三级回退与轮询）
    return openaiImagesAdapter.generateImage!(toMediaModalityContext(input.context, input.logger), {
      prompt: input.prompt,
      references: input.references,
      size: input.size,
      count: input.count,
      traceId: input.traceId,
      signal: input.signal
    })
  }

  const startedAt = Date.now()
  const hasReferences = Boolean(input.references?.length)
  const operation = hasReferences ? 'edit' : 'generate'
  const endpoint = '/images/generations'
  input.logger?.info(
    {
      traceId: input.traceId,
      providerId: input.context.providerId,
      providerApi: input.context.providerApi,
      provider: safeProviderLabel(input.context),
      protocol: 'apimart',
      baseUrl: safeBaseUrl(input.context.baseUrl),
      endpoint,
      model: input.context.modelId,
      size: input.size,
      resolution: input.context.mediaResolution,
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
      context: input.context,
      prompt: input.prompt,
      references: input.references,
      size: input.size,
      count: n
    })
    mediaDiag.event('generation-submit', {
      traceId: input.traceId,
      provider: safeProviderLabel(input.context),
      protocol: 'apimart',
      endpoint,
      model: input.context.modelId,
      size: input.size,
      count: n,
      referencesInJson: Boolean(input.referencesInJson && input.references?.length),
      ...referenceStats(input.references)
    })
    const response = await fetch(`${input.context.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { ...input.context.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: guard.signal
    })
    const responseBody = await readImageResponse(response, '图片生成失败')
    const job = imageJob(responseBody)
    mediaDiag.event('generation-response', {
      traceId: input.traceId,
      provider: safeProviderLabel(input.context),
      endpoint,
      status: response.status,
      responseShape: imageResponseShape(responseBody),
      jobId: job?.id,
      jobStatus: job?.status
    })
    input.logger?.info(
      {
        traceId: input.traceId,
        providerId: input.context.providerId,
        provider: safeProviderLabel(input.context),
        protocol: 'apimart',
        baseUrl: safeBaseUrl(input.context.baseUrl),
        endpoint,
        status: response.status,
        responseShape: imageResponseShape(responseBody),
        jobId: job?.id,
        jobStatus: job?.status
      },
      '图片请求已提交'
    )
    const images = await resolveImageResponse(
      apimartPollSource(input.context),
      responseBody,
      guard.signal,
      '图片生成失败',
      '图片 Provider 返回中没有图片数据',
      input.logger,
      input.traceId
    )
    input.logger?.info(
      {
        traceId: input.traceId,
        providerId: input.context.providerId,
        provider: safeProviderLabel(input.context),
        protocol: 'apimart',
        endpoint,
        outputCount: images.length,
        durationMs: Date.now() - startedAt
      },
      '图片请求完成'
    )
    mediaDiag.event('generation-done', {
      traceId: input.traceId,
      provider: safeProviderLabel(input.context),
      endpoint,
      outputCount: images.length,
      durationMs: Date.now() - startedAt
    })
    return { images }
  } catch (error) {
    input.logger?.error(
      {
        traceId: input.traceId,
        providerId: input.context.providerId,
        provider: safeProviderLabel(input.context),
        protocol: 'apimart',
        endpoint,
        durationMs: Date.now() - startedAt,
        error: errorText(error)
      },
      '图片请求失败'
    )
    mediaDiag.event('generation-error', {
      traceId: input.traceId,
      provider: safeProviderLabel(input.context),
      endpoint,
      durationMs: Date.now() - startedAt,
      error: errorText(error)
    })
    throw error
  } finally {
    guard.dispose()
  }
}

/** Submit an OpenAI-compatible image edit request and resolve async image jobs. */
export async function requestImageEdit(input: {
  context: ImageRequestContext
  prompt: string
  image: string
  images?: string[]
  mask?: string
  size?: string
  signal?: AbortSignal
  logger?: FastifyBaseLogger
  traceId?: string
}): Promise<{ images: string[] }> {
  if (protocolFor(input.context) === 'apimart') {
    if (input.mask) throw new Error('APIMart 图片协议不支持 mask 局部重绘')
    return requestImageGeneration({
      context: input.context,
      prompt: input.prompt,
      references: [input.image, ...(input.images ?? [])],
      size: input.size,
      count: 1,
      signal: input.signal,
      logger: input.logger,
      traceId: input.traceId
    })
  }

  // openai-images 协议整体委托 adapter（编辑三级回退/轮询/探测缓存均在 adapter 内）
  return openaiImagesAdapter.editImage!(toMediaModalityContext(input.context, input.logger), {
    prompt: input.prompt,
    image: input.image,
    images: input.images,
    mask: input.mask,
    size: input.size,
    signal: input.signal,
    traceId: input.traceId
  })
}

export function splitModel(
  model: string | undefined,
  fallbackProvider: string | undefined
): { providerId?: string; modelId?: string } {
  if (!model) return { providerId: fallbackProvider }
  const separator = model.indexOf(':') >= 0 ? ':' : model.indexOf('/') >= 0 ? '/' : ''
  if (!separator) return { providerId: fallbackProvider, modelId: model }
  const index = model.indexOf(separator)
  return { providerId: model.slice(0, index), modelId: model.slice(index + 1) }
}

export function defaultImageModelForProtocol(protocol: MediaProtocol | undefined, baseUrl: string): string {
  return normalizeMediaProtocol(protocol) === 'apimart'
    ? 'gpt-image-2'
    : defaultImageModelForBaseUrl(baseUrl)
}

function resolveRequestContext(
  providerConfigStore: ProviderConfigStore,
  model: string | undefined,
  canvasOverride?: CanvasMediaOverride
): { context: ImageRequestContext } {
  // 画布独立配置优先：生图平台的 Key/Base URL 通常与 LLM Provider 不同。
  if (canvasOverride?.imageBaseUrl && canvasOverride.imageApiKey) {
    const baseUrl = normalizeImageBaseUrl(canvasOverride.imageBaseUrl)
    const mediaProtocol = normalizeMediaProtocol(canvasOverride.imageProtocol)
    const modelId =
      model ||
      canvasOverride.imageModel ||
      defaultImageModelForProtocol(mediaProtocol, baseUrl)
    return {
      context: {
        modelId,
        baseUrl,
        mediaProtocol,
        mediaResolution: canvasOverride.imageResolution,
        mediaLanguage: canvasOverride.imageLanguage,
        headers: { Authorization: `Bearer ${canvasOverride.imageApiKey}` }
      }
    }
  }

  const defaultProvider =
    providerConfigStore.getDefaultProviderId() ?? providerConfigStore.list()[0]?.id
  const parsed = splitModel(model, defaultProvider)
  if (!parsed.providerId) {
    throw new Error('未配置图片 Provider，请先在设置中添加 Provider 或在画布中配置生图 API')
  }
  const provider = providerConfigStore.get(parsed.providerId)
  if (!provider) throw new Error(`Provider 不存在: ${parsed.providerId}`)
  const baseUrl = normalizeProviderBaseUrl(provider.api, provider.baseUrl).replace(/\/$/, '')
  const mediaProtocol = normalizeMediaProtocol(provider.mediaProtocol)
  const modelId =
    parsed.modelId ||
    provider.mediaModel ||
    (mediaProtocol === 'apimart'
      ? defaultImageModelForProtocol(mediaProtocol, baseUrl)
      : isXKiroBaseUrl(baseUrl)
        ? defaultImageModelForBaseUrl(baseUrl)
        : provider.models[0]?.id) ||
    defaultImageModelForProtocol(mediaProtocol, baseUrl)
  if (!modelId) throw new Error(`Provider ${provider.id} 未配置模型`)
  const headers: Record<string, string> = {}
  if (provider.authHeader !== false) headers.Authorization = `Bearer ${provider.apiKey}`
  return {
    context: {
      providerId: provider.id,
      providerApi: provider.api,
      modelId,
      baseUrl,
      mediaProtocol,
      mediaResolution: provider.mediaResolution,
      mediaLanguage: provider.mediaLanguage,
      headers
    }
  }
}

/** 画布独立生图配置（与 LLM Provider 的 Key/Base URL 分离）。 */
export interface CanvasMediaOverride {
  imageBaseUrl: string
  imageApiKey: string
  imageModel: string
  imageSize: string
  imageProtocol?: MediaProtocol
  imageResolution?: string
  imageLanguage?: string
}

export function createMediaGenerator(
  providerConfigStore: ProviderConfigStore,
  /** 返回画布独立配置；非空时优先于 LLM Provider 默认值。 */
  getCanvasOverride?: () => CanvasMediaOverride | undefined,
  options?: MediaGeneratorOptions
): MediaGenerator {
  return {
    async generateImage({ prompt, references, model, size, count = 1, traceId, signal }) {
      const override = getCanvasOverride?.()
      const { context } = resolveRequestContext(providerConfigStore, model, override)
      const effectiveSize =
        size ||
        override?.imageSize ||
        (protocolFor(context) === 'apimart' ? '1:1' : '1024x1024')
      return requestImageGeneration({
        context,
        prompt,
        references,
        size: effectiveSize,
        count,
        traceId,
        signal,
        logger: options?.logger
      })
    },
    async editImage({ prompt, image, images, mask, model, size, traceId, signal }) {
      const override = getCanvasOverride?.()
      const { context } = resolveRequestContext(providerConfigStore, model, override)
      return requestImageEdit({
        context,
        prompt,
        image,
        images,
        mask,
        size: size || override?.imageSize,
        traceId,
        signal,
        logger: options?.logger
      })
    },
    async analyzeImage({ image, instruction, model, signal }) {
      const { context } = resolveRequestContext(providerConfigStore, model, getCanvasOverride?.())
      return openaiImagesAdapter.analyzeImage!(toMediaModalityContext(context, options?.logger), {
        image,
        instruction,
        signal
      })
    },
    async generateAudio() {
      throw new Error('当前 Provider 未声明统一音频生成协议')
    },
    async generateVideo() {
      throw new Error('当前 Provider 未声明统一视频生成协议')
    }
  }
}
