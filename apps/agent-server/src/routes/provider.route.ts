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
import { z } from 'zod'
import { success } from '../lib/api-response.js'
import { validateBody } from '../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

const providerModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  reasoning: z.boolean().optional(),
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
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  api: z.string().min(1),
  authHeader: z.boolean().optional(),
  models: z.array(providerModelSchema).min(1),
})

export const providerRoute: FastifyPluginAsync = async (app) => {
  const store = app.providerConfigStore
  const modelRegistry = app.modelRegistry
  const authStorage = app.authStorage
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

    // 1. 存入 ProviderConfigStore（供 fallback resolver 读取 API Key）
    store.upsert(config)

    // 2. 注册到 ModelRegistry（供 Agent Session 使用）
    modelRegistry.registerProvider(config.id, {
      name: config.name,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      api: config.api,
      authHeader: config.authHeader ?? true,
      models: config.models.map((m) => ({
        id: m.id,
        name: m.name,
        reasoning: m.reasoning ?? false,
        input: ['text'],
        cost: m.cost ?? { input: 0, output: 0 },
        contextWindow: m.contextWindow ?? 32768,
        maxTokens: m.maxTokens ?? 8192,
      })),
    })

    // 3. 注入 API Key 到 AuthStorage（runtime override）
    //    使 getAvailable() 能返回此 Provider 的模型，且 LLM 调用能直接使用此 Key
    authStorage.setRuntimeApiKey(config.id, config.apiKey)

    // 4. 清除 Session 缓存：使下次请求创建新 Session（使用新配置）
    //    正在执行的 run 不受影响，但新的请求会重建 Session
    sessionStore.clear()

    app.log.info(
      `Provider "${config.id}" 已注册（${config.models.length} 个模型，API Key 已注入，Session 缓存已清除）`
    )

    // 返回时隐藏 apiKey
    const { apiKey: _unused, ...safeConfig } = config
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

    // 移除 runtime API Key 注入
    authStorage.removeRuntimeApiKey(id)

    // 清除 Session 缓存
    sessionStore.clear()

    app.log.info(`Provider "${id}" 已删除（API Key 已移除，Session 缓存已清除）`)
    return success({ deleted: true }, request.traceId)
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

    // 拼接远端 /v1/models URL（避免 baseUrl 已包含 /v1 时重复添加）
    const normalizedBase = config.baseUrl.replace(/\/+$/, '')
    const modelsUrl = normalizedBase.endsWith('/v1')
      ? `${normalizedBase}/models`
      : `${normalizedBase}/v1/models`

    // 调用远端 /v1/models
    let response: Response
    try {
      const headers: Record<string, string> = {}
      if (config.authHeader !== false) {
        headers['Authorization'] = `Bearer ${config.apiKey}`
      }
      response = await fetch(modelsUrl, { headers })
    } catch (err) {
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

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      app.log.error(
        { traceId: request.traceId, providerId: id, modelsUrl, status: response.status, body },
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
