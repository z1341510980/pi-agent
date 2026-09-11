/**
 * 媒体生成 Provider 体系：适配器层类型定义（spec §2）。
 *
 * 数据模型见本插件 migrations.ts 的 018_create_infinite_canvas_media_providers
 * （体系归属 infinite-canvas 插件，宿主 017 建的临时表由 018 搬迁后删除）；
 * 本文件只声明类型，不包含任何运行时行为。
 */

import type { FastifyBaseLogger } from 'fastify'

/** 媒体模态；text 复用现有 LLM Provider 体系（spec §4），不落 media_providers 表。 */
export type MediaModality = 'text' | 'image' | 'audio' | 'video'

/** 适配器 id：阶段一落地 openai-images / apimart；(string & {}) 保持新增适配器免改类型。 */
export type MediaAdapterId = 'openai-images' | 'apimart' | (string & {})

/** 声明式表单字段：驱动设置页按 adapter 动态渲染配置表单。 */
export interface MediaAdapterFormField {
  key: string
  label: string
  type: 'text' | 'select' | 'number' | 'textarea'
  options?: Array<{ value: string; label: string }>
  placeholder?: string
  required?: boolean
}

/** 适配器能力声明：驱动 UI 展示与调用前校验（如 apimart 无 mask）。 */
export interface MediaAdapterCapabilities {
  generate: boolean
  /** 图生图 */
  edit?: boolean
  /** 蒙版局部重绘 */
  mask?: boolean
}

/** 适配器执行上下文：由 Registry 从 MediaProviderRow 解析而来。 */
export interface MediaModalityContext {
  providerId: string
  baseUrl: string
  apiKey: string
  model: string
  /** adapter 自有参数（size/resolution/language/voice/format 等） */
  params: Record<string, string>
  /**
   * 显式鉴权头（text 桥接链路携带宿主 authHeader 语义）；缺省时 adapter
   * 按旧约定从 apiKey 推导 Bearer 头（空 Key 不携带）。
   */
  headers?: Record<string, string>
  logger?: FastifyBaseLogger
}

/** media_providers 表行（由 MediaProviderStore 映射）。 */
export interface MediaProviderRow {
  id: string
  name: string
  modality: Exclude<MediaModality, 'text'>
  adapter: string
  baseUrl: string
  apiKey: string
  model: string
  params: Record<string, string>
  enabled: boolean
  isDefault: boolean
  createdAt: number
  updatedAt: number
}

/** 图片生成输入：与 MediaGenerator.generateImage 现签名对齐（含 traceId）。 */
export interface MediaGenerationInput {
  /** 画布透传的 Provider 提示：Registry resolve 时优先于模态默认（spec §6）。 */
  providerId?: string
  prompt: string
  references?: string[]
  model?: string
  size?: string
  /** 画面质量档：auto/high/medium/low（adapter 按白名单归一，auto/非法值不透传）。 */
  quality?: string
  /** 背景透明：transparent/opaque（adapter 按白名单归一，非法值不透传）。 */
  background?: string
  count?: number
  traceId?: string
  signal?: AbortSignal
}

/** 图片编辑输入（图生图/蒙版局部重绘）。 */
export interface MediaEditInput extends MediaGenerationInput {
  image: string
  images?: string[]
  mask?: string
}

/** 音频生成输入：openai-audio adapter（/audio/speech）的载荷来源。 */
export interface AudioGenerationInput {
  /** 画布透传的 Provider 提示；缺省时解析 audio 模态默认。 */
  providerId?: string
  prompt: string
  model?: string
  voice?: string
  format?: string
  speed?: number
  traceId?: string
  signal?: AbortSignal
}

/** 视频生成输入：newapi-video adapter（/video/generations）的载荷来源。 */
export interface VideoGenerationInput {
  /** 画布透传的 Provider 提示；缺省时解析 video 模态默认。 */
  providerId?: string
  prompt: string
  /** 图生视频的参考图（URL 或 base64/data URL，协议原样透传）。 */
  image?: string
  model?: string
  /** 视频时长（秒） */
  duration?: number
  width?: number
  height?: number
  fps?: number
  /** 生成条数（协议可选，默认 1） */
  n?: number
  traceId?: string
  signal?: AbortSignal
}

/** 音频/视频产物。 */
export interface MediaOutput {
  url: string
  mimeType: string
}

/** spec §2 命名别名：图片模态输入与通用媒体输入同构。 */
export type ImageGenerationInput = MediaGenerationInput
export type ImageEditInput = MediaEditInput

/**
 * 媒体 Provider 适配器：按模态收敛协议差异（payload/端点/轮询/错误处理）。
 * 阶段一实现 openai-images 与 apimart 两个适配器；text 模态不走协议 adapter，
 * 仅由 Registry 的 textBridge 占位（见 registry.ts 的 TEXT_BRIDGE_ADAPTER）。
 */
export interface MediaProviderAdapter {
  /** 与 media_providers.adapter 列对应 */
  id: MediaAdapterId
  label: string
  modality: MediaModality
  capabilities: MediaAdapterCapabilities
  /** 声明式表单：驱动设置页动态渲染（含模态特有参数） */
  formSchema: MediaAdapterFormField[]
  generateImage?(
    ctx: MediaModalityContext,
    input: ImageGenerationInput
  ): Promise<{ images: string[] }>
  editImage?(ctx: MediaModalityContext, input: ImageEditInput): Promise<{ images: string[] }>
  generateAudio?(
    ctx: MediaModalityContext,
    input: AudioGenerationInput
  ): Promise<{ outputs: MediaOutput[] }>
  generateVideo?(
    ctx: MediaModalityContext,
    input: VideoGenerationInput
  ): Promise<{ outputs: MediaOutput[] }>
  /** 连接测试（阶段三实现，先声明） */
  testConnection?(ctx: MediaModalityContext): Promise<{ ok: boolean; message?: string }>
}

/** Registry.resolve 的结果：providerId 精确命中或模态默认。 */
export interface ResolvedMediaProvider {
  providerId: string
  adapter: MediaProviderAdapter
  ctx: MediaModalityContext
}
