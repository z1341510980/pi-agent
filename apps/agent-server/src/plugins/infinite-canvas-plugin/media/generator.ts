/**
 * 媒体生成 facade：infinite-canvas 插件内部的「按模态 resolve Registry → 委托 adapter」
 * 入口（spec §6；自宿主 core/config/media-generator.ts 迁入，插件使用自有 Registry）。
 *
 * 职责收敛为「按模态 resolve Registry → 委托 adapter」：
 * - generateImage/editImage：input.providerId 优先（画布透传）→ 模态 enabled 默认，
 *   未配置时由 Registry 抛「图片尚未配置生成 Provider…」引导文案；
 * - analyzeImage：capabilities.analyze 门禁（方案 A）——不支持视觉理解的
 *   Provider 直接引导到设置页更换，而不是让上游报一条晦涩的协议错误；
 * - generateAudio/generateVideo：resolve('audio'/'video') 后委托 adapter
 *   （openai-audio / newapi-video 落位后即为真实生成链路）。
 *
 * 配置来源统一为 infinite_canvas_media_providers 表
 * （存量迁移见 018_create_infinite_canvas_media_providers，旧 media-config 路由兼容读写 image 默认行）。
 */

import type { FastifyBaseLogger } from 'fastify'
import type { MediaProviderRegistry } from './registry.js'
import type { MediaModalityContext, MediaProviderAdapter } from './adapter.js'

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
  /** 视觉理解（反推提示词等）：受 capabilities.analyze 门禁约束。 */
  analyzeImage?(input: {
    image: string
    instruction?: string
    model?: string
    signal?: AbortSignal
  }): Promise<{ text: string }>
}

export interface MediaGeneratorOptions {
  logger?: FastifyBaseLogger
}

/** 图片 Provider 不支持视觉理解时的统一引导文案（reverse-prompt 链路门禁）。 */
export const IMAGE_ANALYZE_UNSUPPORTED_MESSAGE =
  '该图片 Provider 不支持图像反推提示词，请到 设置 → 媒体生成 更换支持视觉理解的 Provider'

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
      const { adapter, ctx } = await resolveImage(undefined, model)
      if (adapter.capabilities.analyze !== true || !adapter.analyzeImage) {
        throw new Error(IMAGE_ANALYZE_UNSUPPORTED_MESSAGE)
      }
      return adapter.analyzeImage(ctx, { image, instruction, signal })
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
