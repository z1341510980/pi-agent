/**
 * 插件管理 API 路由
 *
 * 端点：
 * - GET    /api/plugins                — 列出所有已加载插件
 * - GET    /api/plugins/:name          — 获取指定插件详情
 * - POST   /api/plugins/:name/reload   — 重载指定插件
 * - POST   /api/plugins/:name/enable   — 启用指定插件
 * - POST   /api/plugins/:name/disable  — 禁用指定插件
 * - GET    /api/plugins/:name/tools    — 列出指定插件注册的工具
 * - GET    /api/plugins/:name/panels   — 列出指定插件注册的面板
 * - GET    /api/plugins/panels/all     — 列出所有插件注册的面板
 */

import type { FastifyPluginAsync } from 'fastify'
import { success } from '../lib/api-response.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import type { ToolDefinition, PanelDefinition } from '../core/plugin/plugin-types.js'

export const pluginsRoute: FastifyPluginAsync = async (app) => {
  const manager = app.pluginManager

  // GET /api/plugins — 列出所有插件
  app.get('/api/plugins', async (request) => {
    const list = manager.list()
    return success(
      {
        plugins: list,
        total: list.length,
      },
      request.traceId,
    )
  })

  // GET /api/plugins/panels/all — 列出所有插件注册的面板（供前端聚合使用）
  // 注意：此路由必须在 /:name 之前注册，否则会被 :name 匹配
  app.get('/api/plugins/panels/all', async (request) => {
    return success(
      {
        panels: manager.getAllPanels(),
      },
      request.traceId,
    )
  })

  // GET /api/plugins/:name — 获取插件详情
  app.get('/api/plugins/:name', async (request) => {
    const { name } = request.params as { name: string }
    const entry = manager.get(name)
    if (!entry) {
      throw new AppError(ErrorCode.NOT_FOUND, `插件不存在: ${name}`, 404)
    }

    return success(
      {
        name: entry.manifest.name,
        version: entry.manifest.version,
        description: entry.manifest.description,
        author: entry.manifest.author,
        status: entry.status,
        source: entry.source,
        error: entry.error,
        dependencies: entry.manifest.dependencies ?? [],
        permissions: entry.manifest.permissions ?? [],
        tools: entry.tools.map((t: ToolDefinition) => ({
          name: t.name,
          description: t.description,
        })),
        routes: entry.routes.map((r) => ({
          method: r.method,
          path: `/api/plugins/${entry.manifest.name}${r.path}`,
        })),
        panels: entry.panels.map((p: PanelDefinition) => ({
          id: p.id,
          title: p.title,
          component: p.component,
          position: p.position,
        })),
        eventHandlerCount: entry.eventHandlers.length,
      },
      request.traceId,
    )
  })

  // POST /api/plugins/:name/reload — 重载插件
  app.post('/api/plugins/:name/reload', async (request) => {
    const { name } = request.params as { name: string }
    if (!manager.get(name)) {
      throw new AppError(ErrorCode.NOT_FOUND, `插件不存在: ${name}`, 404)
    }

    try {
      await manager.reload(name)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, `插件重载失败: ${msg}`, 500, msg)
    }

    // 重载后需要重新注册路由到 Fastify
    // 注意：Fastify 不支持动态注销路由，重载后的新路由需要重启服务才能完全生效
    // 此处仅返回重载结果，新路由在下次启动时生效
    const entry = manager.get(name)
    return success(
      {
        name,
        status: entry?.status,
        message: '插件已重载。注意：路由变更需要重启服务才能完全生效。',
      },
      request.traceId,
    )
  })

  // POST /api/plugins/:name/enable — 启用插件
  app.post('/api/plugins/:name/enable', async (request) => {
    const { name } = request.params as { name: string }
    if (!manager.get(name)) {
      throw new AppError(ErrorCode.NOT_FOUND, `插件不存在: ${name}`, 404)
    }

    try {
      await manager.enable(name)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, `插件启用失败: ${msg}`, 500, msg)
    }

    const entry = manager.get(name)
    return success(
      {
        name,
        status: entry?.status,
      },
      request.traceId,
    )
  })

  // POST /api/plugins/:name/disable — 禁用插件
  app.post('/api/plugins/:name/disable', async (request) => {
    const { name } = request.params as { name: string }
    if (!manager.get(name)) {
      throw new AppError(ErrorCode.NOT_FOUND, `插件不存在: ${name}`, 404)
    }

    try {
      await manager.disable(name)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, `插件禁用失败: ${msg}`, 500, msg)
    }

    const entry = manager.get(name)
    return success(
      {
        name,
        status: entry?.status,
      },
      request.traceId,
    )
  })

  // GET /api/plugins/:name/tools — 列出插件注册的工具
  app.get('/api/plugins/:name/tools', async (request) => {
    const { name } = request.params as { name: string }
    const entry = manager.get(name)
    if (!entry) {
      throw new AppError(ErrorCode.NOT_FOUND, `插件不存在: ${name}`, 404)
    }

    return success(
      {
        tools: entry.tools.map((t: ToolDefinition) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
      request.traceId,
    )
  })

  // GET /api/plugins/:name/panels — 列出插件注册的面板
  app.get('/api/plugins/:name/panels', async (request) => {
    const { name } = request.params as { name: string }
    const entry = manager.get(name)
    if (!entry) {
      throw new AppError(ErrorCode.NOT_FOUND, `插件不存在: ${name}`, 404)
    }

    return success(
      {
        panels: entry.panels,
      },
      request.traceId,
    )
  })
}
