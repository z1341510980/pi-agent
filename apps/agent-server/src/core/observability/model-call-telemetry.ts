/**
 * 模型调用遥测纯函数：协议判定、请求指纹、命中率、覆盖率、数据质量。
 * 纯函数，不碰数据库。
 *
 * ## 为什么需要
 *
 * 「缓存与监控一体化」要求区分"真正的缓存未命中"与"Provider 没上报缓存数据"，
 * 并且请求指纹只存摘要、不存原文。本模块把这些口径收敛成可单测的纯函数，
 * 供遥测落库与监控聚合层复用。
 *
 * ## 边界
 *
 * - 协议判定复用 `cache-control-support`，避免两处口径分叉。
 * - Token 缺失一律用 `null` 表示，不用 `0` 冒充未命中。
 */
import { createHash } from 'node:crypto'
import {
  supportsAnthropicCacheControl,
  usesOpenAiPromptCacheKey,
  type CacheControlTarget,
} from '../plugin/cache-control-support.js'

export type CacheProtocol =
  | 'anthropic-cache-control'
  | 'openai-prompt-cache-key'
  | 'automatic-prefix'
  | 'none'
  | 'unknown'

export type TelemetryDataQuality = 'complete' | 'partial' | 'no_data'

/** 判定目标使用的缓存协议（口径复用 cache-control-support，避免分叉） */
export function resolveCacheProtocol(target: CacheControlTarget): CacheProtocol {
  const hasInfo = target.provider || target.baseUrl || target.modelId
  if (!hasInfo) return 'unknown'
  if (supportsAnthropicCacheControl(target)) return 'anthropic-cache-control'
  if (usesOpenAiPromptCacheKey(target)) return 'openai-prompt-cache-key'
  return 'automatic-prefix'
}

export interface RequestLayers {
  system: string
  shared: string
  identity: string
  dynamic: string
}

/** 请求指纹：分层规范化文本的 sha256 前 16 位。只存摘要不存原文 */
export function buildRequestFingerprint(layers: RequestLayers): string {
  const h = createHash('sha256')
  h.update(`system:${layers.system.length}:`)
  h.update(layers.system)
  h.update(`shared:${layers.shared.length}:`)
  h.update(layers.shared)
  h.update(`identity:${layers.identity.length}:`)
  h.update(layers.identity)
  h.update(`dynamic:${layers.dynamic.length}:`)
  h.update(layers.dynamic)
  return h.digest('hex').slice(0, 16)
}

/** 实际缓存读取率；输入数据缺失返回 null */
export function cacheHitRate(cacheReadTokens: number | null, inputTokens: number | null): number | null {
  if (inputTokens == null || cacheReadTokens == null) return null
  const prompt = cacheReadTokens + inputTokens
  if (prompt <= 0) return null
  return cacheReadTokens / prompt
}

/** 缓存前缀覆盖率 = 实测 cacheRead / 期望前缀 token */
export function prefixCoverage(cacheReadTokens: number | null, expectedTokens: number | null): number | null {
  if (expectedTokens == null || expectedTokens <= 0 || cacheReadTokens == null) return null
  return cacheReadTokens / expectedTokens
}

export interface UsageFields {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
}

/** 数据质量：四项齐备 complete；有 input 但其余缺 partial；输入侧无任何非零证据 no_data */
export function classifyDataQuality(u: UsageFields): TelemetryDataQuality {
  // 输入侧证据 = 正数 input，或非 0 的 cacheRead（Provider 把全部输入计入缓存读）。
  // 失败调用常拿不到 usage，落库 ?? 0 后四项全 0 —— 那是"没上报"，不是"真实为 0"，
  // 判 no_data 以免高估数据完备率
  const noInputEvidence =
    u.inputTokens == null ||
    (u.inputTokens === 0 && (u.cacheReadTokens == null || u.cacheReadTokens === 0))
  const allZero =
    (u.inputTokens ?? 0) === 0 && (u.outputTokens ?? 0) === 0 &&
    (u.cacheReadTokens ?? 0) === 0 && (u.cacheWriteTokens ?? 0) === 0
  if (noInputEvidence || allZero) return 'no_data'
  if (u.outputTokens == null && u.cacheReadTokens == null && u.cacheWriteTokens == null) return 'partial'
  return 'complete'
}
