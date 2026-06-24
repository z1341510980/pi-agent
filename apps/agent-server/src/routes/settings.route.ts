/**
 * 设置 API 路由
 *
 * 端点：
 * - GET /api/settings/proxy  — 获取当前代理配置（密码字段脱敏）
 * - PUT /api/settings/proxy  — 更新代理配置（持久化 + 立即应用）
 * - POST /api/settings/proxy/test — 测试代理连通性
 *
 * 前端设置中心保存代理配置时调用此 API，
 * 后端将配置持久化到 proxy.json 并应用到全局 HTTP 客户端（undici）。
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { success } from '../lib/api-response.js'
import { validateBody } from '../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

const proxyConfigSchema = z.object({
  mode: z.enum(['none', 'system', 'manual']),
  host: z.string(),
  port: z.string(),
  username: z.string(),
  password: z.string(),
})

export const settingsRoute: FastifyPluginAsync = async (app) => {
  const store = app.proxyConfigStore
  const manager = app.proxyManager

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
