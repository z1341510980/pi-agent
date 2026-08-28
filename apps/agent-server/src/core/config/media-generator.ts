import type { FastifyBaseLogger } from 'fastify'
import type { ProviderConfigStore } from './provider-config-store.js'
import { normalizeMediaProtocol, type MediaProtocol } from './provider-config-store.js'
import { normalizeProviderBaseUrl } from './provider-base-url.js'

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

function dataUrlToBlob(value: string): Blob {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value)
  if (!match) throw new Error('图片必须是 dataURL 格式')
  const mime = match[1] || 'application/octet-stream'
  const payload = match[3]
  const buffer = match[2]
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8')
  return new Blob([buffer], { type: mime })
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

/** Canvas settings accept either the service root or an explicit OpenAI-style /v1 root. */
export function normalizeImageBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  return normalized.toLowerCase().endsWith('/v1') ? normalized : `${normalized}/v1`
}

const IMAGE_JOB_TIMEOUT_MS = 5 * 60_000
const IMAGE_POLL_INITIAL_DELAY_MS = 2_000
const IMAGE_POLL_MAX_DELAY_MS = 10_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isXKiroBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase().endsWith('.xkiro.com')
  } catch {
    return false
  }
}

/** xKiro has no account-level image model default and documents `gpt-image`. */
export function defaultImageModelForBaseUrl(baseUrl: string): string {
  return isXKiroBaseUrl(baseUrl) ? 'gpt-image' : 'dall-e-3'
}

export function defaultImageModelForProtocol(protocol: MediaProtocol | undefined, baseUrl: string): string {
  return normalizeMediaProtocol(protocol) === 'apimart'
    ? 'gpt-image-2'
    : defaultImageModelForBaseUrl(baseUrl)
}

function recordCandidates(value: unknown): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = []
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new Set<object>()
  while (queue.length) {
    const item = queue.shift()
    if (!item || item.depth > 5 || !isRecord(item.value) || seen.has(item.value)) continue
    seen.add(item.value)
    candidates.push(item.value)
    for (const key of ['data', 'result', 'task', 'output', 'response']) {
      const nested = item.value[key]
      if (isRecord(nested)) queue.push({ value: nested, depth: item.depth + 1 })
      else if (Array.isArray(nested)) {
        for (const child of nested) queue.push({ value: child, depth: item.depth + 1 })
      }
    }
  }
  return candidates
}

function imageErrorMessage(value: unknown): string {
  for (const candidate of recordCandidates(value)) {
    const error = candidate.error
    if (typeof error === 'string') return error
    if (isRecord(error) && typeof error.message === 'string') return error.message
    for (const key of ['message', 'msg', 'detail']) {
      if (typeof candidate[key] === 'string') return candidate[key] as string
    }
  }
  return typeof value === 'string' ? value : ''
}

function imageUrlValues(value: unknown): string[] {
  if (typeof value === 'string' && value.length > 0) return [value]
  if (Array.isArray(value)) return value.flatMap((item) => imageUrlValues(item))
  if (!isRecord(value)) return []
  if (typeof value.b64_json === 'string' && value.b64_json.length > 0) {
    return [`data:image/png;base64,${value.b64_json}`]
  }
  if ('url' in value) return imageUrlValues(value.url)
  if ('image_url' in value) return imageUrlValues(value.image_url)
  return []
}

/** Parse both OpenAI `data[].url/b64_json` and nested APIMart task results. */
export function parseImages(value: unknown): string[] {
  const urls: string[] = []
  const add = (candidate: unknown): void => {
    for (const url of imageUrlValues(candidate)) {
      if (url && !urls.includes(url)) urls.push(url)
    }
  }

  for (const candidate of recordCandidates(value)) {
    add(candidate.data)
    add(candidate.images)
    add(candidate.result)
    add(candidate.output)
    add(candidate.url)
    add(candidate.image_url)
  }
  return urls
}

function imageJob(value: unknown): { id: string; status: string } | undefined {
  for (const candidate of recordCandidates(value)) {
    const id = candidate.task_id ?? candidate.id
    if (typeof id !== 'string' || !id) continue
    const rawStatus = candidate.status ?? candidate.state
    return { id, status: typeof rawStatus === 'string' ? rawStatus : '' }
  }
  return undefined
}

function imageHttpError(body: unknown, status: number, operation: string): Error {
  return new Error(`${operation}: ${imageErrorMessage(body) || `HTTP ${status}`}`)
}

function imageResponseShape(body: unknown): 'images' | 'job' | 'empty' {
  if (parseImages(body).length) return 'images'
  return imageJob(body) ? 'job' : 'empty'
}

function protocolFor(context: ImageRequestContext): MediaProtocol {
  return normalizeMediaProtocol(context.mediaProtocol)
}

function safeProviderLabel(context: ImageRequestContext): string {
  return context.providerId || context.providerApi || safeBaseUrl(context.baseUrl)
}

function safeBaseUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`.replace(/\/$/, '')
  } catch {
    return value.replace(/[?#].*$/, '').replace(/\/$/, '')
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readImageResponse(response: Response, operation: string): Promise<unknown> {
  const body = await response.json().catch(() => null)
  if (!response.ok) throw imageHttpError(body, response.status, operation)
  return body
}

function imageJobFailure(body: unknown, operation: string): Error {
  const job = imageJob(body)
  return new Error(`${operation}: ${imageErrorMessage(body) || job?.status || '任务失败'}`)
}

function taskStatus(value: string | undefined): string {
  return (value || '').trim().toLowerCase()
}

function isFailedStatus(status: string): boolean {
  return ['failed', 'failure', 'error', 'blocked', 'cancelled', 'canceled'].includes(status)
}

function isCompletedStatus(status: string): boolean {
  return ['succeeded', 'success', 'completed', 'done'].includes(status)
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

async function pollImageJob(
  context: ImageRequestContext,
  jobId: string,
  signal: AbortSignal,
  operation: string,
  noImageMessage: string,
  logger?: FastifyBaseLogger,
  traceId?: string
): Promise<string[]> {
  let waitMs = IMAGE_POLL_INITIAL_DELAY_MS
  for (;;) {
    await delay(waitMs, signal)
    const response = await fetch(taskEndpoint(context, jobId), {
      headers: context.headers,
      signal
    })
    const body = await readImageResponse(response, operation)
    const images = parseImages(body)
    const statusCandidate = recordCandidates(body).find(
      (candidate) => typeof candidate.status === 'string' || typeof candidate.state === 'string'
    )
    const fallbackStatus = statusCandidate?.status ?? statusCandidate?.state
    const job = imageJob(body) ?? {
      id: jobId,
      status: typeof fallbackStatus === 'string' ? fallbackStatus : ''
    }
    const status = taskStatus(job.status)
    logger?.debug(
      {
        traceId,
        providerId: context.providerId,
        provider: safeProviderLabel(context),
        endpoint: taskEndpointLabel(context),
        jobId,
        status: response.status,
        responseShape: imageResponseShape(body),
        jobStatus: job?.status,
        nextDelayMs: images.length || isCompletedStatus(status) ? undefined : waitMs
      },
      '图片任务轮询'
    )
    if (images.length) return images
    if (!job) throw new Error(noImageMessage)
    if (isFailedStatus(status)) throw imageJobFailure(body, operation)
    if (isCompletedStatus(status)) throw new Error(noImageMessage)
    waitMs = Math.min(Math.ceil(waitMs * 1.5), IMAGE_POLL_MAX_DELAY_MS)
  }
}

async function resolveImageResponse(
  context: ImageRequestContext,
  body: unknown,
  signal: AbortSignal,
  operation: string,
  noImageMessage: string,
  logger?: FastifyBaseLogger,
  traceId?: string
): Promise<string[]> {
  const images = parseImages(body)
  if (images.length) return images

  const job = imageJob(body)
  if (!job) throw new Error(noImageMessage)
  const status = taskStatus(job.status)
  if (isFailedStatus(status)) throw imageJobFailure(body, operation)
  if (isCompletedStatus(status)) throw new Error(noImageMessage)
  return pollImageJob(context, job.id, signal, operation, noImageMessage, logger, traceId)
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
}): Promise<{ images: string[] }> {
  const startedAt = Date.now()
  const protocol = protocolFor(input.context)
  const hasReferences = Boolean(input.references?.length)
  const operation = hasReferences ? 'edit' : 'generate'
  const endpoint = '/images/generations'
  input.logger?.info(
    {
      traceId: input.traceId,
      providerId: input.context.providerId,
      providerApi: input.context.providerApi,
      provider: safeProviderLabel(input.context),
      protocol,
      baseUrl: safeBaseUrl(input.context.baseUrl),
      endpoint: hasReferences && protocol === 'openai-images' ? '/images/edits' : endpoint,
      model: input.context.modelId,
      size: input.size,
      resolution: input.context.mediaResolution,
      count: input.count,
      referenceCount: input.references?.length ?? 0,
      operation
    },
    '图片请求开始'
  )

  // OpenAI-compatible edit uses multipart /images/edits. APIMart accepts references
  // on its JSON generation endpoint as image_urls instead, so it stays on one path.
  if (hasReferences && protocol === 'openai-images') {
    const [image, ...images] = input.references as string[]
    return requestImageEdit({
      context: input.context,
      prompt: input.prompt,
      image,
      images,
      size: input.size,
      signal: input.signal,
      logger: input.logger,
      traceId: input.traceId
    })
  }

  const guard = withAbortGuard(input.signal, IMAGE_JOB_TIMEOUT_MS)
  try {
    const n = protocol === 'apimart' || isXKiroBaseUrl(input.context.baseUrl)
      ? Math.min(4, Math.max(1, input.count))
      : Math.min(4, Math.max(1, input.count))
    const body = protocol === 'apimart'
      ? apimartPayload({
          context: input.context,
          prompt: input.prompt,
          references: input.references,
          size: input.size,
          count: n
        })
      : {
          model: input.context.modelId,
          prompt: input.prompt,
          n: isXKiroBaseUrl(input.context.baseUrl) ? 1 : n,
          ...(input.size && input.size !== 'auto' ? { size: input.size } : {})
        }
    const response = await fetch(`${input.context.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { ...input.context.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: guard.signal
    })
    const responseBody = await readImageResponse(response, '图片生成失败')
    const job = imageJob(responseBody)
    input.logger?.info(
      {
        traceId: input.traceId,
        providerId: input.context.providerId,
        provider: safeProviderLabel(input.context),
        protocol,
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
      input.context,
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
        protocol,
        endpoint,
        outputCount: images.length,
        durationMs: Date.now() - startedAt
      },
      '图片请求完成'
    )
    return { images }
  } catch (error) {
    input.logger?.error(
      {
        traceId: input.traceId,
        providerId: input.context.providerId,
        provider: safeProviderLabel(input.context),
        protocol,
        endpoint,
        durationMs: Date.now() - startedAt,
        error: errorText(error)
      },
      '图片请求失败'
    )
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

  const startedAt = Date.now()
  input.logger?.info(
    {
      traceId: input.traceId,
      providerId: input.context.providerId,
      providerApi: input.context.providerApi,
      provider: safeProviderLabel(input.context),
      baseUrl: safeBaseUrl(input.context.baseUrl),
      endpoint: '/images/edits',
      model: input.context.modelId,
      size: input.size,
      imageCount: 1 + (input.images?.length ?? 0),
      hasMask: Boolean(input.mask),
      operation: 'edit'
    },
    '图片编辑请求开始'
  )
  const guard = withAbortGuard(input.signal, IMAGE_JOB_TIMEOUT_MS)
  try {
    const form = new FormData()
    const sourceImages = [input.image, ...(input.images ?? [])].filter(Boolean)
    for (const [index, sourceImage] of sourceImages.entries()) {
      form.append('image', dataUrlToBlob(sourceImage), `image-${index + 1}.png`)
    }
    if (input.mask) form.append('mask', dataUrlToBlob(input.mask), 'mask.png')
    form.append(
      'prompt',
      sourceImages.length > 1
        ? `${input.prompt}\n\n第一张上传图片是需要修改的原图，后续上传图片仅作为视觉风格参考。`
        : input.prompt
    )
    form.append('model', input.context.modelId)
    form.append('n', '1')
    if (input.size && input.size !== 'auto') form.append('size', input.size)
    const response = await fetch(`${input.context.baseUrl}/images/edits`, {
      method: 'POST',
      headers: input.context.headers,
      body: form,
      signal: guard.signal
    })
    const responseBody = await readImageResponse(response, '图片编辑失败')
    const job = imageJob(responseBody)
    input.logger?.info(
      {
        traceId: input.traceId,
        providerId: input.context.providerId,
        provider: safeProviderLabel(input.context),
        baseUrl: safeBaseUrl(input.context.baseUrl),
        endpoint: '/images/edits',
        status: response.status,
        responseShape: imageResponseShape(responseBody),
        jobId: job?.id,
        jobStatus: job?.status
      },
      '图片编辑请求已提交'
    )
    const images = await resolveImageResponse(
      input.context,
      responseBody,
      guard.signal,
      '图片编辑失败',
      '图片 Provider 返回中没有编辑结果',
      input.logger,
      input.traceId
    )
    input.logger?.info(
      {
        traceId: input.traceId,
        providerId: input.context.providerId,
        provider: safeProviderLabel(input.context),
        endpoint: '/images/edits',
        outputCount: images.length,
        durationMs: Date.now() - startedAt
      },
      '图片编辑请求完成'
    )
    return { images }
  } catch (error) {
    input.logger?.error(
      {
        traceId: input.traceId,
        providerId: input.context.providerId,
        provider: safeProviderLabel(input.context),
        endpoint: '/images/edits',
        durationMs: Date.now() - startedAt,
        error: errorText(error)
      },
      '图片编辑请求失败'
    )
    throw error
  } finally {
    guard.dispose()
  }
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

function withAbortGuard(signal: AbortSignal | undefined, timeoutMs = 120_000): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const abortFromCaller = (): void => controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortFromCaller)
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true }
    )
  })
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
      const { modelId, baseUrl, headers } = context
      const guard = withAbortGuard(signal)
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelId,
            max_tokens: 800,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text:
                      instruction?.trim() ||
                      '请反推这张图片的生成提示词：输出一段可直接用于图像生成模型的中文描述，涵盖主体、场景、风格、构图与光线，不要解释。'
                  },
                  { type: 'image_url', image_url: { url: image } }
                ]
              }
            ]
          }),
          signal: guard.signal
        })
        const body = (await response.json().catch(() => null)) as {
          choices?: Array<{ message?: { content?: unknown } }>
          error?: unknown
        } | null
        if (!response.ok) {
          const message = body?.error ? JSON.stringify(body.error) : `HTTP ${response.status}`
          throw new Error(`图片理解失败: ${message}`)
        }
        const content = body?.choices?.[0]?.message?.content
        const text = typeof content === 'string' ? content.trim() : ''
        if (!text) throw new Error('模型没有返回图片描述')
        return { text }
      } finally {
        guard.dispose()
      }
    },
    async generateAudio() {
      throw new Error('当前 Provider 未声明统一音频生成协议')
    },
    async generateVideo() {
      throw new Error('当前 Provider 未声明统一视频生成协议')
    }
  }
}
