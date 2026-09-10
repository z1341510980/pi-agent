/**
 * 媒体生成 facade：infinite-canvas 插件内部的「按模态 resolve Registry → 委托 adapter」
 * 入口（spec §6；自宿主 core/config/media-generator.ts 迁入，插件使用自有 Registry）。
 *
 * 职责收敛为「按模态 resolve Registry → 委托 adapter」：
 * - generateImage/editImage：input.providerId 优先（画布透传）→ 模态 enabled 默认，
 *   未配置时由 Registry 抛「图片尚未配置生成 Provider…」引导文案；
 * - analyzeImage：反推提示词是「视觉理解聊天」，走 Registry text 分支
 *   （宿主 textBridge → LLM Provider 的 /chat/completions 多模态消息），
 *   不再 resolve('image')——图片模型（gpt-image 等）打 chat 端点会被上游拒绝；
 *   模型按「画布 input.model → 偏好 analyzeModel（infinite_canvas_media_prefs，
 *   迁移 019）→ 默认文字 Provider 首个模型」三级优先解析；
 * - generateAudio/generateVideo：resolve('audio'/'video') 后委托 adapter
 *   （openai-audio / newapi-video 落位后即为真实生成链路）。
 *
 * 配置来源统一为 infinite_canvas_media_providers 表
 * （存量迁移见 018_create_infinite_canvas_media_providers，旧 media-config 路由兼容读写 image 默认行）；
 * 文字模型配置来源为宿主 provider-config-store（经 PluginContext.textBridge 注入）。
 */

import type { FastifyBaseLogger } from 'fastify'
import { TEXT_PROVIDER_UNCONFIGURED_MESSAGE, type MediaProviderRegistry } from './registry.js'
import type { MediaModalityContext, MediaProviderAdapter } from './adapter.js'
import { MEDIA_PREF_ANALYZE_MODEL } from './media-prefs-store.js'
import { normalizeImageBaseUrl, withAbortGuard } from './shared.js'

export interface MediaGenerator {
  generateImage(input: {
    /** 画布透传的 Provider 提示；缺省时解析 image 模态默认。 */
    providerId?: string
    prompt: string
    references?: string[]
    model?: string
    size?: string
    count?: number
    traceId?: string
    signal?: AbortSignal
  }): Promise<{ images: string[] }>
  generateAudio(input: {
    /** 画布透传的 Provider 提示；缺省时解析 audio 模态默认。 */
    providerId?: string
    prompt: string
    model?: string
    voice?: string
    format?: string
    speed?: number
    traceId?: string
    signal?: AbortSignal
  }): Promise<{ outputs: Array<{ url: string; mimeType: string }> }>
  generateVideo(input: {
    /** 画布透传的 Provider 提示；缺省时解析 video 模态默认。 */
    providerId?: string
    prompt: string
    model?: string
    image?: string
    duration?: number
    width?: number
    height?: number
    fps?: number
    traceId?: string
    signal?: AbortSignal
  }): Promise<{ outputs: Array<{ url: string; mimeType: string }> }>
  /** 图像编辑（图生图/蒙版局部重绘）：委托解析出的 adapter.editImage。 */
  editImage?(input: {
    /** 画布透传的 Provider 提示；缺省时解析 image 模态默认。 */
    providerId?: string
    prompt: string
    image: string
    images?: string[]
    mask?: string
    model?: string
    size?: string
    traceId?: string
    signal?: AbortSignal
  }): Promise<{ images: string[] }>
  /** 视觉理解（反推提示词等）：走宿主文字模型桥接（LLM Provider 聊天端点）。 */
  analyzeImage(input: {
    image: string
    instruction?: string
    model?: string
    signal?: AbortSignal
  }): Promise<{ text: string }>
}

export interface MediaPrefsReader {
  /** 按 key 读取偏好；缺失返回 null（实现见 media-prefs-store.ts）。 */
  getPref(key: string): string | null
}

export interface MediaGeneratorOptions {
  logger?: FastifyBaseLogger
  /** 媒体偏好（analyzeModel 等）：反推提示词模型的第二优先级来源。 */
  prefs?: MediaPrefsReader
}

/** 反推提示词默认指令（与迁移前 openai-images adapter 的 analyzeImage 一致）。 */
const DEFAULT_ANALYZE_INSTRUCTION =
  '请反推这张图片的生成提示词：输出一段可直接用于图像生成模型的中文描述，涵盖主体、场景、风格、构图与光线，不要解释。'

/**
 * input.model 的 'provider:model' 语义（恢复自旧 resolveRequestContext.splitModel
 * 的冒号形式）：冒号前缀作为 LLM Provider 提示传给 textBridge，其余作为模型名覆盖。
 * 仅按冒号拆分：聊天模型 id 常含 '/'（如 deepseek-ai/xx），不能当分隔符。
 */
function splitTextModel(model: string | undefined): { providerId?: string; model?: string } {
  const value = model?.trim()
  if (!value) return {}
  const index = value.indexOf(':')
  if (index <= 0) return { model: value }
  return { providerId: value.slice(0, index), model: value.slice(index + 1) }
}

/**
 * 反推模型偏好解析：偏好值只认 'provider:model'（写入路由已按此校验），
 * 拆不出两段非空（缺失/裸 model id/残缺）一律视为未设置，回落默认文字模型。
 */
function parseAnalyzeModelPref(value: string | null): { providerId?: string; model?: string } {
  if (!value) return {}
  const index = value.indexOf(':')
  if (index <= 0 || index === value.length - 1) return {}
  return { providerId: value.slice(0, index), model: value.slice(index + 1) }
}

/**
 * 多模态聊天反推：/chat/completions 请求体与迁移前 openai-images.analyzeImage
 * 逐字等价（max_tokens 800、instruction 拼接、image_url 透传）。
 * 失败包装为可读文案：模型可能不支持视觉输入（上游 4xx 语义用户可读化）。
 */
async function analyzeWithChat(
  ctx: MediaModalityContext,
  input: { image: string; instruction?: string; signal?: AbortSignal }
): Promise<{ text: string }> {
  const baseUrl = normalizeImageBaseUrl(ctx.baseUrl)
  // text 桥接链路携带宿主 authHeader 语义；媒体行回退 apiKey 推导（旧约定）
  const headers: Record<string, string> =
    ctx.headers ?? (ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {})
  const guard = withAbortGuard(input.signal)
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ctx.model,
        max_tokens: 800,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: input.instruction?.trim() || DEFAULT_ANALYZE_INSTRUCTION
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
      throw new Error(`图片理解失败（模型 ${ctx.model} 可能不支持视觉输入）：${message}`)
    }
    const content = body?.choices?.[0]?.message?.content
    const text = typeof content === 'string' ? content.trim() : ''
    if (!text) throw new Error('模型没有返回图片描述')
    return { text }
  } finally {
    guard.dispose()
  }
}

export function createMediaGenerator(
  registry: MediaProviderRegistry,
  options?: MediaGeneratorOptions
): MediaGenerator {
  /**
   * 解析 image 模态执行上下文：providerId 精确命中 → 模态默认；
   * 调用方显式 model 覆盖 Provider 行配置，logger 由 Registry 注入（兜底 options）。
   */
  const resolveImage = async (
    providerId?: string,
    model?: string
  ): Promise<{ adapter: MediaProviderAdapter; ctx: MediaModalityContext }> => {
    const resolved = await registry.resolve('image', { providerId })
    return {
      adapter: resolved.adapter,
      ctx: {
        ...resolved.ctx,
        model: model || resolved.ctx.model,
        logger: resolved.ctx.logger ?? options?.logger
      }
    }
  }

  return {
    async generateImage({ providerId, prompt, references, model, size, count, traceId, signal }) {
      const { adapter, ctx } = await resolveImage(providerId, model)
      if (!adapter.generateImage) {
        throw new Error(`媒体适配器 "${adapter.id}" 未实现图片生成`)
      }
      return adapter.generateImage(ctx, {
        prompt,
        references,
        size,
        count: count ?? 1,
        traceId,
        signal
      })
    },
    async editImage({ providerId, prompt, image, images, mask, model, size, traceId, signal }) {
      const { adapter, ctx } = await resolveImage(providerId, model)
      if (!adapter.editImage) {
        throw new Error(`媒体适配器 "${adapter.id}" 未实现图片编辑`)
      }
      return adapter.editImage(ctx, {
        prompt,
        image,
        images,
        mask,
        size,
        traceId,
        signal
      })
    },
    async analyzeImage({ image, instruction, model, signal }) {
      // 反推是视觉理解聊天：经 Registry text 分支走宿主文字模型桥接，
      // 不再 resolve('image')（旧实现把图片模型打到 chat 端点被上游拒绝）。
      // 模型优先级：input.model（画布透传，支持 'provider:model' 与裸 model id）
      //   → 偏好 analyzeModel（'provider:model'）→ 默认文字 Provider 首个模型。
      const fromInput = splitTextModel(model)
      const resolved =
        fromInput.providerId || fromInput.model
          ? fromInput
          : parseAnalyzeModelPref(options?.prefs?.getPref(MEDIA_PREF_ANALYZE_MODEL) ?? null)
      let ctx: MediaModalityContext
      try {
        const bridged = await registry.resolve('text', { providerId: resolved.providerId })
        ctx = {
          ...bridged.ctx,
          ...(resolved.model ? { model: resolved.model } : {}),
          logger: bridged.ctx.logger ?? options?.logger
        }
      } catch {
        // textBridge 缺失 / 返回 null / 解析抛错 → 统一引导到文字模型配置
        throw new Error(TEXT_PROVIDER_UNCONFIGURED_MESSAGE)
      }
      return analyzeWithChat(ctx, { image, instruction, signal })
    },
    async generateAudio(input) {
      const { adapter, ctx } = await registry.resolve('audio', { providerId: input.providerId })
      if (!adapter.generateAudio) {
        throw new Error(`媒体适配器 "${adapter.id}" 未实现音频生成`)
      }
      return adapter.generateAudio(ctx, input)
    },
    async generateVideo(input) {
      const { adapter, ctx } = await registry.resolve('video', { providerId: input.providerId })
      if (!adapter.generateVideo) {
        throw new Error(`媒体适配器 "${adapter.id}" 未实现视频生成`)
      }
      return adapter.generateVideo(ctx, input)
    }
  }
}
