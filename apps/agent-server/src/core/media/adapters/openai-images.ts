/**
 * openai-images adapter：OpenAI Images 兼容协议（含 xKiro 厂商变体）。
 *
 * 从 core/config/media-generator.ts 的 openai-images 分支整体迁移，行为等价为
 * 硬约束：/images/generations 提交、编辑三级回退（JSON → multipart →
 * generations+image_urls）、/images/generations/{id} 轮询、size 白名单吸附、
 * xKiro 判定（归一化 URL 后）与默认模型 gpt-image / n=1。
 *
 * 探测缓存（原 media-generator 模块级 Set）改为本模块内按
 * `${providerId}:${归一化 baseUrl}` 键控的 Map，避免不同 Provider 实例互相污染。
 */

import type { FastifyBaseLogger } from 'fastify'
import { mediaDiag } from '../../config/media-diag.js'
import type {
  ImageAnalysisInput,
  ImageEditInput,
  ImageGenerationInput,
  MediaModalityContext,
  MediaProviderAdapter
} from '../adapter.js'
import {
  IMAGE_JOB_TIMEOUT_MS,
  dataUrlToBlob,
  errorText,
  imageJob,
  imageResponseShape,
  normalizeImageBaseUrl,
  normalizeOpenAiCompatibleSize,
  readImageResponse,
  referenceStats,
  resolveImageResponse,
  safeBaseUrl,
  withAbortGuard,
  type ImageJobPollSource
} from '../shared.js'

export function isXKiroBaseUrl(baseUrl: string): boolean {
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

/**
 * 只有这些状态码能证明该 Provider 没有 multipart 编辑端点，才允许改走 JSON 端点。
 *
 * 超时/网络错误一律不算：多数平台的图生图本来就要几十秒，把超时当"端点不存在"
 * 会把请求悄悄降级到不带参考图的生成，用户看到的是"参考图没生效"。
 */
function isUnusableEditEndpoint(status: number): boolean {
  return status === 404 || status === 405 || status === 415 || status === 501
}

/** 已确认返回"端点不存在"的键（providerId:baseUrl）：仅由上述状态码写入，避免重复白等一轮。 */
const jsonOnlyImageEndpoints = new Map<string, true>()

/**
 * 已确认 JSON 图生图被 400/415 拒绝的键（providerId:baseUrl，部分聚合平台只认
 * multipart 文件上传，尽管文档宣称支持 JSON）：进程内记忆，后续直接走 multipart，
 * 省掉一轮注定失败的 JSON 请求。
 */
const multipartOnlyEditEndpoints = new Map<string, true>()

/** adapter 内部请求运行时：ctx 归一化后的 baseUrl + 由 apiKey 构造的鉴权头。 */
interface AdapterRuntime {
  providerId: string
  baseUrl: string
  model: string
  headers: Record<string, string>
  logger?: FastifyBaseLogger
}

function createRuntime(ctx: MediaModalityContext): AdapterRuntime {
  const baseUrl = normalizeImageBaseUrl(ctx.baseUrl)
  return {
    providerId: ctx.providerId,
    baseUrl,
    // 行内默认：Provider 行 model 留空时回退厂商默认（与迁移前
    // resolveRequestContext 的 modelId 兜底链末端一致）
    model: ctx.model || defaultImageModelForBaseUrl(baseUrl),
    // 与迁移前等价：空 Key 时不携带 Authorization 头
    headers: ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {},
    logger: ctx.logger
  }
}

function providerLabel(rt: AdapterRuntime): string {
  return rt.providerId || safeBaseUrl(rt.baseUrl)
}

function pollSource(rt: AdapterRuntime): ImageJobPollSource {
  return {
    providerId: rt.providerId,
    baseUrl: rt.baseUrl,
    headers: rt.headers,
    buildEndpoint: (jobId) => `${rt.baseUrl}/images/generations/${encodeURIComponent(jobId)}`,
    endpointLabel: '/images/generations/{id}'
  }
}

interface JsonGenerationInput {
  prompt: string
  size?: string
  count: number
  /** 仅在 referencesInJson 时随 JSON 的 image_urls 提交 */
  references?: string[]
  referencesInJson?: boolean
  signal?: AbortSignal
  traceId?: string
}

/** Submit the JSON /images/generations request and resolve synchronous or async results. */
async function submitJsonGeneration(
  rt: AdapterRuntime,
  input: JsonGenerationInput
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
      protocol: 'openai-images',
      baseUrl: safeBaseUrl(rt.baseUrl),
      endpoint: hasReferences ? '/images/edits' : endpoint,
      model: rt.model,
      size: input.size,
      count: input.count,
      referenceCount: input.references?.length ?? 0,
      operation
    },
    '图片请求开始'
  )

  const guard = withAbortGuard(input.signal, IMAGE_JOB_TIMEOUT_MS)
  try {
    const n = Math.min(4, Math.max(1, input.count))
    const body = {
      model: rt.model,
      prompt: input.prompt,
      n: isXKiroBaseUrl(rt.baseUrl) ? 1 : n,
      ...(normalizeOpenAiCompatibleSize(input.size)
        ? { size: normalizeOpenAiCompatibleSize(input.size) }
        : {}),
      response_format: 'url',
      ...(input.referencesInJson && input.references?.length
        ? { image_urls: input.references }
        : {})
    }
    mediaDiag.event('generation-submit', {
      traceId: input.traceId,
      provider: providerLabel(rt),
      protocol: 'openai-images',
      endpoint,
      model: rt.model,
      size: input.size,
      count: n,
      referencesInJson: Boolean(input.referencesInJson && input.references?.length),
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
        protocol: 'openai-images',
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
      pollSource(rt),
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
        protocol: 'openai-images',
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
        protocol: 'openai-images',
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

interface EditFlowInput {
  prompt: string
  image: string
  images?: string[]
  mask?: string
  size?: string
  signal?: AbortSignal
  traceId?: string
}

/** Submit an OpenAI-compatible image edit request with the three-tier fallback. */
async function editImageFlow(rt: AdapterRuntime, input: EditFlowInput): Promise<{ images: string[] }> {
  const startedAt = Date.now()
  const cacheKey = `${rt.providerId}:${rt.baseUrl}`
  const jsonOnly = !input.mask && jsonOnlyImageEndpoints.has(cacheKey)
  if (jsonOnly) {
    mediaDiag.event('edit-cached-json-only', {
      traceId: input.traceId,
      provider: providerLabel(rt)
    })
    return submitJsonGeneration(rt, {
      prompt: input.prompt,
      references: [input.image, ...(input.images ?? [])].filter(Boolean),
      size: input.size,
      count: 1,
      signal: input.signal,
      traceId: input.traceId,
      referencesInJson: true
    })
  }
  rt.logger?.info(
    {
      traceId: input.traceId,
      providerId: rt.providerId,
      provider: providerLabel(rt),
      baseUrl: safeBaseUrl(rt.baseUrl),
      endpoint: '/images/edits',
      model: rt.model,
      size: input.size,
      imageCount: 1 + (input.images?.length ?? 0),
      hasMask: Boolean(input.mask),
      operation: 'edit'
    },
    '图片编辑请求开始'
  )
  const guard = withAbortGuard(input.signal, IMAGE_JOB_TIMEOUT_MS)
  try {
    const sourceImages = [input.image, ...(input.images ?? [])].filter(Boolean)
    const effectivePrompt =
      sourceImages.length > 1
        ? `${input.prompt}\n\n第一张上传图片是需要修改的原图，后续上传图片仅作为视觉风格参考。`
        : input.prompt
    const size = normalizeOpenAiCompatibleSize(input.size)
    // 关键证据行：编辑请求实际携带的参考图数量与字节数
    mediaDiag.event('edit-submit', {
      traceId: input.traceId,
      provider: providerLabel(rt),
      endpoint: '/images/edits',
      model: rt.model,
      size,
      hasMask: Boolean(input.mask),
      ...referenceStats(sourceImages)
    })
    // 严格 OpenAI 官方端点/部分聚合平台只认 multipart 文件上传
    const sendMultipart = async (): Promise<Response> => {
      const form = new FormData()
      for (const [index, sourceImage] of sourceImages.entries()) {
        form.append('image', dataUrlToBlob(sourceImage), `image-${index + 1}.png`)
      }
      if (input.mask) form.append('mask', dataUrlToBlob(input.mask), 'mask.png')
      form.append('prompt', effectivePrompt)
      form.append('model', rt.model)
      form.append('n', '1')
      form.append('response_format', 'url')
      if (size) form.append('size', size)
      return fetch(`${rt.baseUrl}/images/edits`, {
        method: 'POST',
        headers: rt.headers,
        body: form,
        signal: guard.signal
      })
    }

    let response: Response
    if (multipartOnlyEditEndpoints.has(cacheKey)) {
      // 已确认该平台 JSON 图生图被拒：直接 multipart，省一轮注定失败的 400
      mediaDiag.event('edit-multipart-only', {
        traceId: input.traceId,
        provider: providerLabel(rt)
      })
      response = await sendMultipart()
    } else {
      // 文档契约（JSON）：image 为 URL/data URL/数组，response_format=url。
      // 参考图用 data URL——本地资产地址服务商访问不到。
      response = await fetch(`${rt.baseUrl}/images/edits`, {
        method: 'POST',
        headers: { ...rt.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: rt.model,
          prompt: effectivePrompt,
          image: sourceImages.length === 1 ? sourceImages[0] : sourceImages,
          n: 1,
          ...(size ? { size } : {}),
          response_format: 'url',
          ...(input.mask ? { mask: input.mask } : {})
        }),
        signal: guard.signal
      })
      if (response.status === 400 || response.status === 415) {
        multipartOnlyEditEndpoints.set(cacheKey, true)
        mediaDiag.event('edit-json-rejected', {
          traceId: input.traceId,
          provider: providerLabel(rt),
          status: response.status
        })
        response = await sendMultipart()
      }
    }
    // 只有明确的"端点不存在"才改走 JSON /images/generations + image_urls：
    // 参考图必须要么真的送达，要么如实报错，不能悄悄丢掉。
    if (isUnusableEditEndpoint(response.status)) {
      mediaDiag.event('edit-endpoint-missing', {
        traceId: input.traceId,
        provider: providerLabel(rt),
        status: response.status
      })
      rt.logger?.warn(
        {
          traceId: input.traceId,
          providerId: rt.providerId,
          provider: providerLabel(rt),
          baseUrl: safeBaseUrl(rt.baseUrl),
          endpoint: '/images/edits',
          status: response.status
        },
        'multipart 图片编辑端点不存在，回退到 /images/generations 携带 image_urls'
      )
      if (input.mask) {
        throw new Error('当前图片 Provider 不支持 /images/edits，无法执行蒙版局部重绘')
      }
      jsonOnlyImageEndpoints.set(cacheKey, true)
      return submitJsonGeneration(rt, {
        prompt: input.prompt,
        references: sourceImages,
        size: input.size,
        count: 1,
        signal: input.signal,
        traceId: input.traceId,
        referencesInJson: true
      })
    }
    const responseBody = await readImageResponse(response, '图片编辑失败')
    const job = imageJob(responseBody)
    rt.logger?.info(
      {
        traceId: input.traceId,
        providerId: rt.providerId,
        provider: providerLabel(rt),
        baseUrl: safeBaseUrl(rt.baseUrl),
        endpoint: '/images/edits',
        status: response.status,
        responseShape: imageResponseShape(responseBody),
        jobId: job?.id,
        jobStatus: job?.status
      },
      '图片编辑请求已提交'
    )
    const images = await resolveImageResponse(
      pollSource(rt),
      responseBody,
      guard.signal,
      '图片编辑失败',
      '图片 Provider 返回中没有编辑结果',
      rt.logger,
      input.traceId
    )
    rt.logger?.info(
      {
        traceId: input.traceId,
        providerId: rt.providerId,
        provider: providerLabel(rt),
        endpoint: '/images/edits',
        outputCount: images.length,
        durationMs: Date.now() - startedAt
      },
      '图片编辑请求完成'
    )
    mediaDiag.event('edit-done', {
      traceId: input.traceId,
      provider: providerLabel(rt),
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
        endpoint: '/images/edits',
        durationMs: Date.now() - startedAt,
        error: errorText(error)
      },
      '图片编辑请求失败'
    )
    mediaDiag.event('edit-error', {
      traceId: input.traceId,
      provider: providerLabel(rt),
      durationMs: Date.now() - startedAt,
      error: errorText(error)
    })
    throw error
  } finally {
    guard.dispose()
  }
}

/**
 * OpenAI Images 兼容 adapter。
 * 约定：formSchema 只声明 adapter 特有参数（size）；baseUrl/apiKey/model 为
 * 所有 adapter 通用列，由设置页固定渲染。
 */
export const openaiImagesAdapter: MediaProviderAdapter = {
  id: 'openai-images',
  label: 'OpenAI Images 兼容',
  modality: 'image',
  capabilities: { generate: true, edit: true, mask: true, analyze: true },
  formSchema: [
    {
      key: 'size',
      label: '尺寸',
      type: 'select',
      options: [
        { value: '1024x1024', label: '1024x1024' },
        { value: '1792x1024', label: '1792x1024' },
        { value: '1024x1792', label: '1024x1792' },
        { value: '512x512', label: '512x512' }
      ]
    }
  ],
  async generateImage(ctx: MediaModalityContext, input: ImageGenerationInput): Promise<{ images: string[] }> {
    const rt = createRuntime(ctx)
    // size 优先级与迁移前一致：调用方显式 size > Provider params.size > 1024x1024 兜底
    const size = input.size || ctx.params.size || '1024x1024'
    const count = input.count ?? 1
    if (input.references?.length) {
      rt.logger?.info(
        {
          traceId: input.traceId,
          providerId: rt.providerId,
          provider: providerLabel(rt),
          protocol: 'openai-images',
          baseUrl: safeBaseUrl(rt.baseUrl),
          endpoint: '/images/edits',
          model: rt.model,
          size,
          count,
          referenceCount: input.references.length,
          operation: 'edit'
        },
        '图片请求开始'
      )
      const [image, ...images] = input.references
      return editImageFlow(rt, {
        prompt: input.prompt,
        image,
        images,
        size,
        signal: input.signal,
        traceId: input.traceId
      })
    }
    return submitJsonGeneration(rt, {
      prompt: input.prompt,
      size,
      count,
      signal: input.signal,
      traceId: input.traceId
    })
  },
  async editImage(ctx: MediaModalityContext, input: ImageEditInput): Promise<{ images: string[] }> {
    const rt = createRuntime(ctx)
    return editImageFlow(rt, {
      prompt: input.prompt,
      image: input.image,
      images: input.images,
      mask: input.mask,
      size: input.size || ctx.params.size,
      signal: input.signal,
      traceId: input.traceId
    })
  },
  async analyzeImage(ctx: MediaModalityContext, input: ImageAnalysisInput): Promise<{ text: string }> {
    const baseUrl = normalizeImageBaseUrl(ctx.baseUrl)
    const headers: Record<string, string> = ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}
    const guard = withAbortGuard(input.signal)
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: input.model || ctx.model,
          max_tokens: 800,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    input.instruction?.trim() ||
                    '请反推这张图片的生成提示词：输出一段可直接用于图像生成模型的中文描述，涵盖主体、场景、风格、构图与光线，不要解释。'
                },
                { type: 'image_url', image_url: { url: input.image } }
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
  }
}
