/**
 * 设置 API 路由
 *
 * 端点：
 * - GET /api/settings/proxy  — 获取当前代理配置（密码字段脱敏）
 * - PUT /api/settings/proxy  — 更新代理配置（持久化 + 立即应用）
 * - POST /api/settings/proxy/test — 测试代理连通性
 * - GET /api/settings/llm — 获取 LLM 请求超时
 * - PUT /api/settings/llm — 更新 LLM 请求超时
 * - GET /api/settings/stream-options — 获取 stream_options 屏蔽开关
 * - PUT /api/settings/stream-options — 更新 stream_options 屏蔽开关
 *
 * 前端设置中心保存代理配置时调用此 API，
 * 后端将配置持久化到 proxy.json 并应用到全局 HTTP 客户端（undici）。
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { success } from '../lib/api-response.js'
import { validateBody } from '../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { setRuntimeLlmTimeoutMs } from '../config/performance.js'

const proxyConfigSchema = z.object({
  mode: z.enum(['none', 'system', 'manual']),
  host: z.string(),
  port: z.string(),
  username: z.string(),
  password: z.string(),
})

const llmConfigSchema = z.object({
  /** LLM 请求超时（毫秒），范围 1 秒到 1 小时 */
  timeoutMs: z.number().int().min(1_000).max(3_600_000),
})

const streamOptionsSchema = z.object({
  /** 是否屏蔽 stream_options.include_usage 字段（兼容不完整的中转网关） */
  stripStreamOptions: z.boolean(),
})

export const settingsRoute: FastifyPluginAsync = async (app) => {
  const store = app.proxyConfigStore
  const manager = app.proxyManager

  // GET /api/settings/llm — 获取 LLM 请求超时
  app.get('/api/settings/llm', async (request) => {
    return success({ timeoutMs: app.settingsManager.getHttpIdleTimeoutMs() }, request.traceId)
  })

  // PUT /api/settings/llm — 更新 LLM 请求超时
  app.put('/api/settings/llm', async (request, reply) => {
    const input = validateBody(llmConfigSchema, request, reply)
    if (!input) return

    app.settingsManager.setHttpIdleTimeoutMs(input.timeoutMs)
    await app.settingsManager.flush()
    setRuntimeLlmTimeoutMs(input.timeoutMs)
    app.log.info({ traceId: request.traceId, timeoutMs: input.timeoutMs }, 'LLM 请求超时已更新')
    return success({ timeoutMs: input.timeoutMs }, request.traceId)
  })

  // GET /api/settings/stream-options — 获取 stream_options 屏蔽开关
  app.get('/api/settings/stream-options', async (request) => {
    return success(
      { stripStreamOptions: app.providerConfigStore.getStripStreamOptions() },
      request.traceId,
    )
  })

  // PUT /api/settings/stream-options — 更新 stream_options 屏蔽开关
  app.put('/api/settings/stream-options', async (request, reply) => {
    const input = validateBody(streamOptionsSchema, request, reply)
    if (!input) return

    app.providerConfigStore.setStripStreamOptions(input.stripStreamOptions)
    // 清除 Session 缓存：让后续请求重建 Session 时使用新配置
    app.piSessionStore.clear()
    app.log.info(
      { traceId: request.traceId, stripStreamOptions: input.stripStreamOptions },
      'stream_options 屏蔽开关已更新，Session 缓存已清除',
    )
    return success({ stripStreamOptions: input.stripStreamOptions }, request.traceId)
  })

  // GET /api/settings/proxy — 获取当前代理配置（密码脱敏）
  app.get('/api/settings/proxy', async (request) => {
    const config = store.get()
    // 返回时隐藏密码
    const safeConfig = {
      mode: config.mode,
      host: config.host,
      port: config.port,
      username: config.username,
      hasPassword: config.password.length > 0,
    }
    return success(safeConfig, request.traceId)
  })

  // PUT /api/settings/proxy — 更新代理配置
  app.put('/api/settings/proxy', async (request, reply) => {
    const input = validateBody(proxyConfigSchema, request, reply)
    if (!input) return

    // 如果前端没传密码且为 manual 模式，保留已有密码
    let config = input
    if (input.mode === 'manual' && !input.password) {
      const existing = store.get()
      if (existing.password) {
        config = { ...input, password: existing.password }
      }
    }

    // 持久化（set 内部同步写入 SQLite）
    store.set(config)

    // 应用到全局 HTTP 客户端
    const result = manager.apply(config)

    if (!result.applied) {
      app.log.warn(
        { traceId: request.traceId, mode: config.mode, error: result.error },
        '代理配置应用失败'
      )
      throw new AppError(
        ErrorCode.CONFIG_ERROR,
        `代理配置应用失败: ${result.error ?? '未知错误'}`,
        400,
        `代理配置应用失败: mode=${config.mode}, error=${result.error ?? '未知错误'}`
      )
    }

    app.log.info(
      {
        traceId: request.traceId,
        mode: config.mode,
        effectiveProxyUrl: result.effectiveProxyUrl,
      },
      '代理配置已更新并应用'
    )

    // 返回时隐藏密码
    const safeConfig = {
      mode: config.mode,
      host: config.host,
      port: config.port,
      username: config.username,
      hasPassword: config.password.length > 0,
      effectiveProxyUrl: result.effectiveProxyUrl,
    }
    return success(safeConfig, request.traceId)
  })

  // POST /api/settings/proxy/test — 测试代理连通性
  app.post('/api/settings/proxy/test', async (request, reply) => {
    const input = validateBody(proxyConfigSchema, request, reply)
    if (!input) return

    // 如果前端没传密码且为 manual 模式，保留已有密码
    let config = input
    if (input.mode === 'manual' && !input.password) {
      const existing = store.get()
      if (existing.password) {
        config = { ...input, password: existing.password }
      }
    }

    app.log.info(
      { traceId: request.traceId, mode: config.mode },
      '开始测试代理连通性'
    )

    const result = await manager.testConnectivity(config)

    app.log.info(
      { traceId: request.traceId, mode: config.mode, ok: result.ok, message: result.message },
      '代理连通性测试完成'
    )

    return success(result, request.traceId)
  })
}
