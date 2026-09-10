/**
 * MediaProviderRegistry：媒体 Provider 解析入口（spec §3）。
 *
 * - register/listAdapters：适配器注册与按模态查询（驱动路由元数据与设置页表单）。
 * - resolve：image/audio/video 走 media_providers 表（providerId 精确命中 →
 *   模态 enabled 默认 → 未配置引导文案）；text 不走 store（spec §4：复用 LLM
 *   Provider 体系），经 textBridge 桥接（Task 4 接 provider-config-store）。
 * - createMediaProviderRegistry：宿主装配入口，默认注册内置 adapter 清单；
 *   类本身不带默认注册，保持直接构造时为空。
 */

import type { FastifyBaseLogger } from 'fastify'
import type {
  MediaModality,
  MediaModalityContext,
  MediaProviderAdapter,
  MediaProviderRow,
  ResolvedMediaProvider
} from './adapter.js'
import { apimartAdapter } from './adapters/apimart.js'
import { openaiImagesAdapter } from './adapters/openai-images.js'
import type { MediaProviderStore } from './media-provider-store.js'

/** text 模态桥接契约：由宿主接 provider-config-store（Task 4），本阶段仅定义。 */
export type MediaTextBridge = (providerId?: string) => Promise<ResolvedMediaProvider>

export interface MediaProviderRegistryOptions {
  textBridge?: MediaTextBridge
  /** 宿主日志器：注入 resolve 出的 MediaModalityContext，供 adapter 记录诊断日志。 */
  logger?: FastifyBaseLogger
}

/** 内置 adapter 清单：工厂默认注册 + 路由 adapters 元数据共用。 */
export const MEDIA_PROVIDER_ADAPTERS: readonly MediaProviderAdapter[] = [
  openaiImagesAdapter,
  apimartAdapter
]

/** 未配置引导文案中的模态名：按模态给出准确指代（音频/视频等）。 */
const MODALITY_LABELS: Record<MediaModality, string> = {
  text: '文字',
  image: '图片',
  audio: '音频',
  video: '视频'
}

function unconfiguredProviderError(modality: MediaModality): Error {
  return new Error(
    `${MODALITY_LABELS[modality]}尚未配置生成 Provider，请到 设置 → 媒体生成 配置`
  )
}

function contextFromRow(row: MediaProviderRow, logger?: FastifyBaseLogger): MediaModalityContext {
  return {
    providerId: row.id,
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    model: row.model,
    params: row.params,
    ...(logger ? { logger } : {})
  }
}

export class MediaProviderRegistry {
  private readonly adapters = new Map<string, MediaProviderAdapter>()
  private readonly store: MediaProviderStore
  private readonly options: MediaProviderRegistryOptions

  constructor(store: MediaProviderStore, options: MediaProviderRegistryOptions = {}) {
    this.store = store
    this.options = options
  }

  /** 注册适配器；重复 id 视为装配错误直接抛出。 */
  register(adapter: MediaProviderAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`媒体适配器 "${adapter.id}" 已注册`)
    }
    this.adapters.set(adapter.id, adapter)
  }

  listAdapters(modality: MediaModality): MediaProviderAdapter[] {
    return [...this.adapters.values()].filter((adapter) => adapter.modality === modality)
  }

  /** 解析：providerId 精确命中 → 模态 enabled 默认 → 未配置引导文案。 */
  async resolve(
    modality: MediaModality,
    opts?: { providerId?: string }
  ): Promise<ResolvedMediaProvider> {
    if (modality === 'text') {
      if (!this.options.textBridge) throw unconfiguredProviderError(modality)
      return this.options.textBridge(opts?.providerId)
    }
    const row = this.findRow(modality, opts?.providerId)
    if (!row) throw unconfiguredProviderError(modality)
    const adapter = this.adapters.get(row.adapter)
    if (!adapter) {
      throw new Error(`媒体 Provider "${row.id}" 的适配器 "${row.adapter}" 未注册`)
    }
    return { providerId: row.id, adapter, ctx: contextFromRow(row, this.options.logger) }
  }

  /** providerId 精确命中（modality 匹配 + enabled）→ 模态 enabled 默认 → null。 */
  private findRow(
    modality: Exclude<MediaModality, 'text'>,
    providerId?: string
  ): MediaProviderRow | null {
    if (providerId) {
      const row = this.store.get(providerId)
      if (row && row.modality === modality && row.enabled) return row
    }
    return this.store.resolveDefault(modality)
  }
}

/** 宿主装配入口：默认注册内置 adapter 清单（openai-images / apimart）。 */
export function createMediaProviderRegistry(
  store: MediaProviderStore,
  opts?: MediaProviderRegistryOptions
): MediaProviderRegistry {
  const registry = new MediaProviderRegistry(store, opts)
  for (const adapter of MEDIA_PROVIDER_ADAPTERS) registry.register(adapter)
  return registry
}
