/**
 * 媒体生成 Provider 体系：适配器层类型定义（spec §2）。
 *
 * 数据模型见 core/db/migrations.ts 的 017_create_media_providers；
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
  type: 'text' | 'select' | 'number'
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
  /** 反推提示词（多模态） */
  analyze?: boolean
}

/** 适配器执行上下文：由 Registry 从 MediaProviderRow 解析而来。 */
export interface MediaModalityContext {
  providerId: string
  baseUrl: string
  apiKey: string
  model: string
  /** adapter 自有参数（size/resolution/language/voice/format 等） */
  params: Record<string, string>
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

/** 图片理解输入（反推提示词等）。 */
export interface ImageAnalysisInput {
  image: string
  instruction?: string
  model?: string
  signal?: AbortSignal
}

/** 音频生成输入：与 MediaGenerator.generateAudio 现签名对齐。 */
export interface AudioGenerationInput {
  prompt: string
  model?: string
  voice?: string
  format?: string
  speed?: number
  signal?: AbortSignal
}

/** 视频生成输入：与 MediaGenerator.generateVideo 现签名对齐。 */
export interface VideoGenerationInput {
  prompt: string
  model?: string
  size?: string
  seconds?: number
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
 * 阶段一实现 openai-images 与 apimart 两个适配器。
 */
export interface MediaProviderAdapter {
  /** 与 media_providers.adapter 列对应 */
  id: MediaAdapterId
  label: string
  modality: Exclude<MediaModality, 'text'>
  capabilities: MediaAdapterCapabilities
  /** 声明式表单：驱动设置页动态渲染（含模态特有参数） */
  formSchema: MediaAdapterFormField[]
  generateImage?(
    ctx: MediaModalityContext,
    input: ImageGenerationInput
  ): Promise<{ images: string[] }>
  editImage?(ctx: MediaModalityContext, input: ImageEditInput): Promise<{ images: string[] }>
  analyzeImage?(ctx: MediaModalityContext, input: ImageAnalysisInput): Promise<{ text: string }>
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
