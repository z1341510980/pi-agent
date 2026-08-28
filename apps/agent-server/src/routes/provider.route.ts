/**
 * Provider 配置 API 路由
 *
 * 端点：
 * - GET    /api/providers              — 列出所有已注册 Provider
 * - POST   /api/providers              — 注册/更新 Provider（同步注册到 ModelRegistry）
 * - DELETE /api/providers/:id          — 删除 Provider
 * - GET    /api/providers/:id/models   — 拉取远端 Provider 可用模型列表
 *
 * 前端设置中心保存 Provider 配置时调用此 API，
 * 后端将配置注册到 ModelRegistry 和 ProviderConfigStore，
 * 使后续 Agent 调用能使用前端配置的 API Key。
 */

import type { FastifyPluginAsync } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { success } from '../lib/api-response.js'
import { validateBody } from '../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { buildProviderModelsUrl, normalizeProviderBaseUrl } from '../core/config/provider-base-url.js'
import { MEDIA_PROTOCOLS } from '../core/config/provider-config-store.js'

// Pi-ai SDK 原生思考强度档位（与 pi-ai 的 ThinkingLevel 对齐）
const REASONING_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const
// Pi-ai SDK thinkingFormat 枚举
const THINKING_FORMATS = [
  'openai',
  'openrouter',
  'deepseek',
  'together',
  'zai',
  'qwen',
  'qwen-chat-template',
  'string-thinking',
  'ant-ling',
] as const

const providerModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  reasoning: z.boolean().optional(),
  // 能力开关
  vision: z.boolean().optional(),
  toolCalling: z.boolean().optional(),
  onlyThinking: z.boolean().optional(),
  allowDisableThinking: z.boolean().optional(),
  customProtocol: z.boolean().optional(),
  // 思考参数
  thinkingFormat: z.enum(THINKING_FORMATS).optional(),
  supportedReasoningEfforts: z.array(z.enum(REASONING_EFFORT_LEVELS)).optional(),
  defaultReasoningEffort: z
    .union([z.literal('auto'), z.enum(REASONING_EFFORT_LEVELS)])
    .optional(),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number().optional(),
    cacheWrite: z.number().optional(),
  }).optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
})

const providerConfigSchema = z.object({
  /** 创建时可省略，由后端分配与名称无关的稳定唯一 ID。 */
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  // 编辑已有 Provider 时允许前端留空，后端会保留数据库中的旧 Key；新增仍由下方显式校验。
  apiKey: z.string(),
  api: z.string().min(1),
  authHeader: z.boolean().optional(),
  models: z.array(providerModelSchema).min(1),
  /** 图片生成协议；省略时保持 OpenAI Images 兼容协议。 */
  mediaProtocol: z.enum(MEDIA_PROTOCOLS).optional(),
  mediaModel: z.string().trim().optional(),
  mediaResolution: z.string().trim().optional(),
  mediaLanguage: z.string().trim().min(2).max(16).optional(),
  /**
   * 新增模式标记：为 true 时若 id 已存在则拒绝写入（返回 409），
   * 防止"新增 Provider"因 id 与已有 Provider（如默认 Provider）冲突而意外覆盖其数据。
   * 编辑模式不传此字段。
   */
  createOnly: z.boolean().optional(),
})

export const providerRoute: FastifyPluginAsync = async (app) => {
  const store = app.providerConfigStore
  const modelRegistry = app.modelRegistry
  const modelRuntime = app.modelRuntime
  const sessionStore = app.piSessionStore

  // GET /api/providers — 列出所有已注册 Provider
  app.get('/api/providers', async (request) => {
    const providers = store.list().map(({ apiKey: _, ...rest }) => rest)
    return success(providers, request.traceId)
  })

  // POST /api/providers — 注册/更新 Provider
  app.post('/api/providers', async (request, reply) => {
    const config = validateBody(providerConfigSchema, request, reply)
    if (!config) return

    const id = config.id ?? `provider-${randomUUID()}`
    const existing = store.get(id)

    // 新增模式（createOnly）下，若 id 已存在则拒绝写入。
    // 这是后端兜底防线：即使前端 id 派生/去重逻辑有遗漏，
    // 也不会让"新增 Provider"意外覆盖已有 Provider（如默认 Provider）的数据。
    if (config.createOnly && existing) {
      throw new AppError(
        ErrorCode.CONFLICT,
        `Provider "${id}" 已存在，新增被拒绝。请更换名称，或直接编辑该 Provider`,
        409
      )
    }

    // 编辑已有 Provider 时，前端不会回传脱敏后的 Key；空值表示沿用旧 Key。
    // 新增 Provider 仍必须提供 Key，避免把不可用凭据写入运行时注册表。
    const apiKey = config.apiKey.trim() || existing?.apiKey
    if (!apiKey) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'API Key 不能为空（编辑已有 Provider 时可留空以保留原 Key）',
        400
      )
    }

    // createOnly 仅用于请求语义，不持久化到 store。媒体字段同样采用部分更新语义，
    // 省略字段时保留已有配置，避免编辑聊天模型时重置图片协议。
    const { createOnly: _createOnly, ...persistConfig } = {
      ...config,
      id,
      apiKey,
      mediaProtocol: config.mediaProtocol ?? existing?.mediaProtocol,
      mediaModel: config.mediaModel ?? existing?.mediaModel,
      mediaResolution: config.mediaResolution ?? existing?.mediaResolution,
      mediaLanguage: config.mediaLanguage ?? existing?.mediaLanguage
    }

    // 1. 存入 ProviderConfigStore（供 fallback resolver 读取 API Key）
    store.upsert(persistConfig)

    // 2. 注册到 ModelRegistry（供 Agent Session 使用）
    modelRegistry.registerProvider(id, {
      name: config.name,
      baseUrl: normalizeProviderBaseUrl(config.api, config.baseUrl),
      apiKey,
      api: config.api,
      authHeader: config.authHeader ?? true,
      models: config.models.map(mapToSdkModel),
    })

    // 3. 注入 API Key 到 ModelRuntime（runtime override，异步）
    //    使 getAvailable() 能返回此 Provider 的模型，且 LLM 调用能直接使用此 Key
    await modelRuntime.setRuntimeApiKey(id, apiKey)

    // 4. 使 Session 缓存失效：空闲会话立即重建，正在跑的 run 标记为 stale，
    //    等本轮结束后按新配置重建（不打断用户对话）。
    const invalidation = sessionStore.invalidate({
      scope: 'all',
      reason: `provider upsert: ${id}`,
    })

    app.log.info(
      { ...invalidation },
      `Provider "${id}" 已注册（${config.models.length} 个模型，API Key 已注入，Session 缓存已失效）`
    )

    // 返回时隐藏 apiKey
    const { apiKey: _unused, ...safeConfig } = { ...config, id }
    return success(safeConfig, request.traceId)
  })

  // DELETE /api/providers/:id — 删除 Provider
  app.delete('/api/providers/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!id || id.trim().length === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Provider ID 不能为空', 400)
    }

    const existed = store.delete(id)
    if (!existed) {
      throw new AppError(ErrorCode.NOT_FOUND, `Provider "${id}" 不存在`, 404)
    }

    // ProviderConfigStore 只负责持久化；同时从运行时注册表移除，
    // 否则删除后旧模型仍可能继续出现在模型列表中。
    modelRegistry.unregisterProvider(id)

    // 移除 runtime API Key 注入
    await modelRuntime.removeRuntimeApiKey(id)

    // Provider 被删除：正在跑的 run 已经没有可用凭证，必须 abort 而不是让它继续。
    const invalidation = sessionStore.invalidate({
      scope: 'all',
      reason: `provider deleted: ${id}`,
      abortActive: true,
    })

    app.log.info({ ...invalidation }, `Provider "${id}" 已删除（API Key 已移除，Session 已失效）`)
    return success({ deleted: true }, request.traceId)
  })

  // GET /api/providers/default — 获取默认 Provider ID
  app.get('/api/providers/default', async (request) => {
    const id = store.getDefaultProviderId()
    return success({ id: id ?? null }, request.traceId)
  })

  // POST /api/providers/default — 设置默认 Provider
  app.post('/api/providers/default', async (request, reply) => {
    const body = request.body as { id?: string } | null
    const id = body?.id
    if (!id || typeof id !== 'string') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'id 字段不能为空', 400)
    }
    if (!store.get(id)) {
      throw new AppError(ErrorCode.NOT_FOUND, `Provider "${id}" 不存在`, 404)
    }
    store.setDefaultProviderId(id)
    // 使 Session 缓存失效：让后续 createPiSession 重新选择默认 Provider 的模型，
    // 否则已缓存的 session 会继续使用旧 Provider（如从 DeepSeek 切到 OpenAI 时不生效）。
    // 正在跑的 run 不打断，只标 stale，结束后重建。
    const invalidation = sessionStore.invalidate({
      scope: 'all',
      reason: `default provider: ${id}`,
    })
    app.log.info({ ...invalidation }, `默认 Provider 已设置为 "${id}"，Session 缓存已失效`)
    return success({ id }, request.traceId)
  })

  // GET /api/providers/:id/models — 拉取远端 Provider 可用模型列表
  // 代理调用 Provider 的 /v1/models（OpenAI 兼容格式），返回 [{ id, name }]
  app.get('/api/providers/:id/models', async (request) => {
    const { id } = request.params as { id: string }
    if (!id || id.trim().length === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Provider ID 不能为空', 400)
    }

    const config = store.get(id)
    if (!config) {
      throw new AppError(ErrorCode.NOT_FOUND, `Provider "${id}" 不存在`, 404)
    }

    const modelsUrl = buildProviderModelsUrl(config.api, config.baseUrl)

    // 调用远端 /v1/models
    let response: Response
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const headers: Record<string, string> = {}
      if (config.authHeader !== false) {
        headers['Authorization'] = `Bearer ${config.apiKey}`
      }
      response = await fetch(modelsUrl, { headers, signal: controller.signal })
    } catch (err) {
      clearTimeout(timeout)
      app.log.error(
        { traceId: request.traceId, providerId: id, modelsUrl, err },
        '拉取远端模型列表失败（网络错误）'
      )
      throw new AppError(
        ErrorCode.INTERNAL_SERVER_ERROR,
        `无法连接到 Provider 远端服务: ${(err as Error).message}`,
        502,
        `拉取远端模型列表网络错误: ${(err as Error).message}`
      )
    }
    clearTimeout(timeout)

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      const safeBody = body.length > 200 ? body.slice(0, 200) + '...(已截断)' : body
      app.log.error(
        { traceId: request.traceId, providerId: id, modelsUrl, status: response.status, body: safeBody },
        '拉取远端模型列表失败（HTTP 错误）'
      )
      throw new AppError(
        ErrorCode.INTERNAL_SERVER_ERROR,
        `Provider 远端服务返回错误（HTTP ${response.status}）`,
        502,
        `远端 /v1/models 返回 HTTP ${response.status}: ${body}`
      )
    }

    let json: unknown
    try {
      json = await response.json()
    } catch (err) {
      throw new AppError(
        ErrorCode.INTERNAL_SERVER_ERROR,
        'Provider 远端服务返回的响应不是有效的 JSON',
        502,
        `远端 /v1/models 响应 JSON 解析失败: ${(err as Error).message}`
      )
    }

    // 兼容多种 OpenAI 中转服务的响应格式：
    //  - 标准 OpenAI:  { data: [{ id, ... }] }
    //  - 部分中转:     { models: [{ id, ... }] }
    //  - 直接数组:     [{ id, ... }]
    let rawModels: unknown[]
    if (Array.isArray(json)) {
      rawModels = json
    } else if (json && typeof json === 'object') {
      const obj = json as { data?: unknown; models?: unknown }
      if (Array.isArray(obj.data)) {
        rawModels = obj.data
      } else if (Array.isArray(obj.models)) {
        rawModels = obj.models
      } else {
        rawModels = []
      }
    } else {
      rawModels = []
    }

    if (rawModels.length === 0) {
      throw new AppError(
        ErrorCode.INTERNAL_SERVER_ERROR,
        'Provider 远端服务返回的模型列表为空或格式无效（中转服务可能不支持 /v1/models 接口，请手动添加模型）',
        502,
        '远端 /v1/models 响应未包含可识别的模型数组（已尝试 data / models / 顶层数组 三种格式）'
      )
    }

    // 前端只需要 id 和 name 字段；name 缺失时回退为 id
    const models = rawModels
      .filter(
        (m): m is { id: string; name?: unknown } =>
          typeof m === 'object' && m !== null && typeof (m as { id?: unknown }).id === 'string'
      )
      .map((m) => ({
        id: m.id,
        name: typeof m.name === 'string' && m.name.length > 0 ? m.name : m.id
      }))

    if (models.length === 0) {
      throw new AppError(
        ErrorCode.INTERNAL_SERVER_ERROR,
        'Provider 远端服务返回的模型列表中无有效模型（缺少 id 字段）',
        502,
        '远端 /v1/models 响应的模型数组中没有任何包含字符串 id 的条目'
      )
    }

    return success(models, request.traceId)
  })
}

/**
 * 把 ProviderModelConfig 映射为 pi-ai SDK 的 Model 形状。
 *
 * 字段映射规则：
 * - vision: 是否在 input 数组中追加 'image'
 * - supportedReasoningEfforts: 映射为 thinkingLevelMap，键值都设为同一档位（默认值）
 * - allowDisableThinking: 是否在 thinkingLevelMap 中追加 'off' 键
 * - thinkingFormat: 透传到 compat.thinkingFormat
 * - toolCalling / onlyThinking / customProtocol / defaultReasoningEffort: 业务字段，暂不传给 SDK
 *   （defaultReasoningEffort 由调用方在请求层读取使用；其他均为 UI 业务概念）
 *
 * 导出供单元测试验证映射正确性。
 */
export function mapToSdkModel(m: z.infer<typeof providerModelSchema>): {
  id: string
  name: string
  reasoning: boolean
  input: ('text' | 'image')[]
  thinkingLevelMap?: Record<string, string | null>
  compat?: { thinkingFormat?: (typeof THINKING_FORMATS)[number] }
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow: number
  maxTokens: number
} {
  const input: ('text' | 'image')[] = ['text']
  if (m.vision) input.push('image')

  let thinkingLevelMap: Record<string, string | null> | undefined
  if (m.supportedReasoningEfforts && m.supportedReasoningEfforts.length > 0) {
    thinkingLevelMap = {}
    for (const level of m.supportedReasoningEfforts) {
      thinkingLevelMap[level] = level
    }
  }
  if (m.allowDisableThinking) {
    thinkingLevelMap ??= {}
    // pi-ai SDK 用 'off' 键表示"允许关闭思考"
    thinkingLevelMap['off'] = 'off'
  }

  const compat: { thinkingFormat?: (typeof THINKING_FORMATS)[number] } = {}
  if (m.thinkingFormat) compat.thinkingFormat = m.thinkingFormat

  const cost = m.cost ?? { input: 0, output: 0 }
  return {
    id: m.id,
    name: m.name,
    reasoning: m.reasoning ?? false,
    input,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(Object.keys(compat).length > 0 ? { compat } : {}),
    cost: {
      input: cost.input,
      output: cost.output,
      cacheRead: cost.cacheRead ?? 0,
      cacheWrite: cost.cacheWrite ?? 0,
    },
    contextWindow: m.contextWindow ?? 32768,
    maxTokens: m.maxTokens ?? 8192,
  }
}
