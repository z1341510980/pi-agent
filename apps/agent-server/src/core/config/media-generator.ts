import type { FastifyBaseLogger } from 'fastify'
import type { ProviderConfigStore } from './provider-config-store.js'
import { normalizeMediaProtocol, type MediaProtocol } from './provider-config-store.js'
import { normalizeProviderBaseUrl } from './provider-base-url.js'
import {
  defaultImageModelForBaseUrl,
  isXKiroBaseUrl,
  openaiImagesAdapter
} from '../media/adapters/openai-images.js'
import { APIMART_DEFAULT_IMAGE_MODEL, apimartAdapter } from '../media/adapters/apimart.js'
import { normalizeImageBaseUrl, safeBaseUrl } from '../media/shared.js'
import type { MediaModalityContext } from '../media/adapter.js'

// 过渡期 re-export：公共工具已迁移至 core/media/shared.ts 与两个图片 adapter，
// 保持既有导出签名防外部引用断裂（Task 4 切换调用链后清理）。
export {
  normalizeImageBaseUrl,
  normalizeOpenAiCompatibleSize,
  parseImages
} from '../media/shared.js'
export { defaultImageModelForBaseUrl } from '../media/adapters/openai-images.js'
export { normalizeApimartSize } from '../media/adapters/apimart.js'

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

function protocolFor(context: ImageRequestContext): MediaProtocol {
  return normalizeMediaProtocol(context.mediaProtocol)
}

/**
 * 过渡期桥接：把 ImageRequestContext 适配为 adapter 的 MediaModalityContext。
 * providerId 缺省时以 providerApi/安全化 baseUrl 兜底，使诊断 provider 标签与
 * adapter 探测缓存键（providerId:baseUrl）同迁移前一一对应；
 * mediaResolution/mediaLanguage 映射为 apimart adapter 的 params.resolution/language。
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
    params: {
      ...(context.mediaResolution?.trim() ? { resolution: context.mediaResolution.trim() } : {}),
      ...(context.mediaLanguage?.trim() ? { language: context.mediaLanguage.trim() } : {})
    },
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
  // 协议分支整体委托对应 adapter（Task 2/3 迁移），此处仅保留协议判定与上下文桥接
  const ctx = toMediaModalityContext(input.context, input.logger)
  const adapterInput = {
    prompt: input.prompt,
    references: input.references,
    size: input.size,
    count: input.count,
    traceId: input.traceId,
    signal: input.signal
  }
  if (protocolFor(input.context) === 'apimart') {
    return apimartAdapter.generateImage!(ctx, adapterInput)
  }
  return openaiImagesAdapter.generateImage!(ctx, adapterInput)
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
  const ctx = toMediaModalityContext(input.context, input.logger)
  if (protocolFor(input.context) === 'apimart') {
    // mask 校验与「参考图走 generations+image_urls」语义均在 apimart adapter 内
    return apimartAdapter.editImage!(ctx, {
      prompt: input.prompt,
      image: input.image,
      images: input.images,
      mask: input.mask,
      size: input.size,
      signal: input.signal,
      traceId: input.traceId
    })
  }

  // openai-images 协议整体委托 adapter（编辑三级回退/轮询/探测缓存均在 adapter 内）
  return openaiImagesAdapter.editImage!(ctx, {
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

export function defaultImageModelForProtocol(
  protocol: MediaProtocol | undefined,
  baseUrl: string
): string {
  return normalizeMediaProtocol(protocol) === 'apimart'
    ? APIMART_DEFAULT_IMAGE_MODEL
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
      model || canvasOverride.imageModel || defaultImageModelForProtocol(mediaProtocol, baseUrl)
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
        size || override?.imageSize || (protocolFor(context) === 'apimart' ? '1:1' : '1024x1024')
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
