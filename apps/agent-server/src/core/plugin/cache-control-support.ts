/**
 * Anthropic 风格 `cache_control` 的适用性判定。
 *
 * ## 为什么需要这个判定
 *
 * `plugin-manager` 的 `applyCacheBreakpoints` 会把消息内容从 `content: "字符串"`
 * 改写成 `content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]`，
 * 用来显式声明缓存断点。这套协议**只有 Anthropic 系认**。
 *
 * 对照 pi-ai 的实现（`providers/openai-completions.js`）：它自己只在
 * `provider === 'openrouter' && model.id.startsWith('anthropic/')` 时才把
 * `cacheControlFormat` 置为 `'anthropic'`，其余 OpenAI 兼容 provider 一律不加
 * `cache_control` —— 因为它们用的是**自动前缀缓存**（服务端按 prompt 前缀
 * 自行命中），不需要也不认这个字段。
 *
 * 我们无条件改写带来两个后果，正好对应实测的两个症状：
 *
 * 1. **缓存命中极低**。DeepSeek 等自动前缀缓存要求请求前缀**逐字节稳定**。
 *    把 `content` 从字符串换成数组、并塞入一个它不认识的 `cache_control` 字段，
 *    改变了参与缓存键计算的序列化形态；本来能命中的自动缓存反而被打掉。
 *    我们以为在"提升命中率"，实际是在"破坏命中率"。
 * 2. **偶发 400**。实测 Director 失败里有
 *    `400 Failed to deserialize the JSON body：missing field 'messages'`，
 *    与"网关无法解析被改写过的 messages 结构"一致。
 *
 * 所以：只对真正认这套协议的 provider 打断点，其余保持字符串原样，
 * 把命中交回给服务端的自动前缀缓存。
 *
 * ## 边界
 *
 * 纯函数，只做判定。改写逻辑仍在 plugin-manager。
 */

/** 解析出的目标模型标识（provider + baseUrl + modelId 任一可缺） */
export interface CacheControlTarget {
  provider?: string
  modelId?: string
  baseUrl?: string
}

/** Anthropic 原生 provider 标识 */
const ANTHROPIC_PROVIDERS = new Set(['anthropic', 'anthropic-vertex', 'anthropic-bedrock'])

/**
 * 该目标是否接受 Anthropic 风格的显式 `cache_control` 断点。
 *
 * 判定与 pi-ai 的 `detectCompat` 保持一致，避免两处口径分叉：
 * - Anthropic 原生 API（含 Vertex / Bedrock 变体）
 * - OpenRouter 转发的 anthropic/* 模型
 *
 * 其余（DeepSeek / OpenAI / 各类中转网关）返回 false —— 它们用自动前缀缓存。
 */
export function supportsAnthropicCacheControl(target: CacheControlTarget): boolean {
  const provider = target.provider?.toLowerCase() ?? ''
  const baseUrl = target.baseUrl?.toLowerCase() ?? ''
  const modelId = target.modelId?.toLowerCase() ?? ''

  if (ANTHROPIC_PROVIDERS.has(provider)) return true
  // baseUrl 兜底：provider 名可能是用户自定义的，但指向 Anthropic 官方端点
  if (baseUrl.includes('api.anthropic.com')) return true

  // OpenRouter 仅在转发 Anthropic 模型时支持
  const isOpenRouter = provider === 'openrouter' || baseUrl.includes('openrouter.ai')
  if (isOpenRouter && modelId.startsWith('anthropic/')) return true

  return false
}

/**
 * 该目标是否使用 OpenAI 的 `prompt_cache_key` 路由。
 *
 * OpenAI 的自动前缀缓存把 `prompt_cache_key` 当作**路由提示**：
 * 相同 key 的请求会被尽量导到同一台机器，从而命中那台机器上的前缀缓存。
 * key 不同则很可能落到不同机器 → 前缀再一致也命中不了。
 *
 * pi-ai 只在 `baseUrl` 含 `api.openai.com` 时才发这个字段
 * （`providers/openai-completions.js` 的 `buildParams`），
 * 所以判定口径与它保持一致，避免给不认识该字段的网关发多余参数。
 */
export function usesOpenAiPromptCacheKey(target: CacheControlTarget): boolean {
  return (target.baseUrl?.toLowerCase() ?? '').includes('api.openai.com')
}

/**
 * 生成稳定的 prompt 缓存路由键。
 *
 * ## 为什么需要
 *
 * 每次 `runAgent` 都用 `plugin:${name}:${randomUUID()}` 新建 threadId → 新 Pi Session
 * → 新 sessionId，而 pi-ai 把 sessionId 直接当 `prompt_cache_key` 用。
 * 结果是同一章的 Director / Writer / Reviewer 三次调用各拿一个随机 key，
 * 明明共享 system + shared 前缀，却被路由到不同机器，缓存全落空。
 *
 * 改为按「同一批要共享前缀的调用」给同一个 key。对小说创作流程就是
 * (projectId, chapterNumber)：这一组调用的 system + shared 段逐字一致。
 *
 * @param scope 调用方定义的共享域（如 `novel:${projectId}:${chapterNumber}`）
 */
export function buildPromptCacheKey(scope: string): string {
  // OpenAI 要求 key 长度 ≤ 64；超长时截断而非哈希，保留可读前缀便于排查
  const normalized = scope.replace(/[^a-zA-Z0-9_:-]/g, '_')
  return normalized.length > 64 ? normalized.slice(0, 64) : normalized
}

