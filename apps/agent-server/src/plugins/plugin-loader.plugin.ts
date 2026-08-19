/**
 * 插件加载器 Fastify 插件
 *
 * 职责：
 * 1. 在 Fastify 启动时初始化 PluginManager
 * 2. 扫描并加载所有插件
 * 3. 将插件注册的路由集成到 Fastify
 * 4. 通过 fastify.pluginManager 暴露 PluginManager 实例
 * 5. 在 Fastify 关闭时调用 PluginManager.stop()
 *
 * 环境变量：
 * - PI_PLUGINS_DIR：本地插件目录（绝对路径），未设置则不扫描
 * - PI_PLUGINS_ENABLE_NPM：是否启用 npm 插件扫描（'true' / '1' 启用）
 * - PI_PLUGINS_ENABLE_EXAMPLES：是否启用内置示例插件（'true' / '1' 启用，默认启用）
 */

import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createModuleLogger } from '../lib/logger.js'
import { PluginManager } from '../core/plugin/plugin-manager.js'
import { createHelloPlugin } from './examples/hello-plugin/index.js'
import { createNovelPlugin } from './novel-plugin/index.js'
import { createWebSearchPlugin } from './web-search-plugin/index.js'
import { applyMigrations } from '../core/db/migrations.js'
import yaml from 'js-yaml'

export const pluginLoaderPlugin: FastifyPluginAsync = fp(async (app) => {
  const log = createModuleLogger(app.log, 'plugin-loader')

  // 解析配置
  const localPluginsDir = process.env.PI_PLUGINS_DIR
  const enableNpmPlugins =
    process.env.PI_PLUGINS_ENABLE_NPM === 'true' || process.env.PI_PLUGINS_ENABLE_NPM === '1'
  const enableExamples =
    process.env.PI_PLUGINS_ENABLE_EXAMPLES !== 'false' &&
    process.env.PI_PLUGINS_ENABLE_EXAMPLES !== '0'

  // 工作目录与数据目录（与 app.ts 保持一致）
  const cwd = process.env.PI_CWD ?? process.cwd()
  const dataDir = process.env.PI_DATA_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE}/.pi`

  // 插件工厂映射表：用于 builtin 插件的创建
  const pluginFactories: Record<string, () => Plugin> = {
    'hello-plugin': createHelloPlugin,
    'novel-plugin': createNovelPlugin,
    'web-search-plugin': createWebSearchPlugin,
  }

  // 默认内置插件列表（兼容旧行为）
  const defaultBuiltinPlugins = [
    ...(enableExamples ? [{ plugin: createHelloPlugin() }] : []),
    { plugin: createNovelPlugin() },
    { plugin: createWebSearchPlugin() },
  ]

  // 尝试从配置文件加载插件列表
  let builtinPlugins = defaultBuiltinPlugins
  const configPath = resolve(process.cwd(), 'config/plugins.yml')

  if (existsSync(configPath)) {
    try {
      const configContent = readFileSync(configPath, 'utf-8')
      const config = yaml.load(configContent) as { plugins?: Array<{
        id: string
        source: 'builtin' | 'local' | 'npm'
        enabled: boolean
        isolate?: boolean
        config?: Record<string, unknown>
      }> }

      if (config?.plugins && config.plugins.length > 0) {
        const loadedPlugins: Array<{ plugin: Plugin; source: 'builtin'; config?: Record<string, unknown>; isolate?: boolean }> = []
        for (const pluginConfig of config.plugins) {
          if (!pluginConfig.enabled) continue
          if (pluginConfig.source === 'builtin') {
            const factory = pluginFactories[pluginConfig.id]
            if (!factory) {
              log.warn({ pluginId: pluginConfig.id }, '未找到内置插件工厂，跳过')
              continue
            }
            loadedPlugins.push({
              plugin: factory(),
              source: 'builtin',
              config: pluginConfig.config,
              isolate: pluginConfig.isolate,
            })
          } else {
            log.warn({ pluginId: pluginConfig.id, source: pluginConfig.source }, '当前仅支持 builtin 插件，其他类型待实现')
          }
        }
        if (loadedPlugins.length > 0) {
          builtinPlugins = loadedPlugins
          log.info({ count: loadedPlugins.length, configPath }, '从配置文件加载插件')
        }
      }
    } catch (err) {
      log.warn({ err, configPath }, '解析 plugins.yml 失败，回退到默认插件列表')
    }
  }

  log.info(
    {
      localPluginsDir: localPluginsDir ?? '(未配置)',
      enableNpmPlugins,
      enableExamples,
      builtinCount: builtinPlugins.length,
      cwd,
      dataDir,
    },
    '初始化插件系统',
  )

  // 创建 PluginManager
  const manager = new PluginManager(log, app.eventBus, app.db, cwd, dataDir, {
    localPluginsDir,
    enableNpmPlugins,
    builtinPlugins,
  })

  // 注入 subagentPlugin / teamPlugin 已装饰的 Manager
  // subagentPlugin 与 teamPlugin 在 pluginLoaderPlugin 之前注册，
  // 因此 app.subagentManager / app.teamManager 此时已可用。
  // 在 manager.start()（调用插件 setup）之前注入，
  // 使插件 setup 可通过 context.subagentManager / context.teamManager 访问。
  if (app.subagentManager) {
    manager.setAgentManager(app.subagentManager)
  } else {
    log.warn('subagentPlugin 未注册，插件 context.subagentManager 将不可用')
  }
  if (app.teamManager) {
    manager.setTeamManager(app.teamManager)
  } else {
    log.warn('teamPlugin 未注册，插件 context.teamManager 将不可用')
  }
  // 注入 ConfirmationManager（app.ts 已在 pluginLoaderPlugin 之前创建并 decorate）
  // 使插件 setup 可通过 context.confirmationManager 复用 chat 的确认/决策流程
  // （超时机制 + pending 列表 + 'confirmation:request' / 'confirmation:resolved' 事件）
  manager.setConfirmationManager(app.confirmationManager)

  // 注入 AgentCallLogger（subagentPlugin 已 decorate app.agentCallLogger）
  // 使插件 setup 可通过 context.agentCallLogger 记录 Agent 调用日志（含领域扩展字段）
  if (app.agentCallLogger) {
    manager.setAgentCallLogger(app.agentCallLogger)
  } else {
    log.warn('subagentPlugin 未注册，插件 context.agentCallLogger 将不可用')
  }

  // 初始化（扫描并加载插件）
  await manager.init()

  // 执行插件静态声明的数据库迁移（在 start/setup 之前）
  // 这确保依赖数据库表的插件 setup 能成功执行
  const staticMigrations = manager.getLoadedMigrations()
  if (staticMigrations.length > 0) {
    log.info({ count: staticMigrations.length }, '开始执行插件静态数据库迁移')
    for (const migration of staticMigrations) {
      try {
        applyMigrations(app.db, [migration])
        log.info({ id: migration.id }, '迁移已执行')
      } catch (err) {
        log.error({ id: migration.id, err }, '迁移执行失败')
      }
    }
  }

  // 启动所有插件（调用 setup）
  await manager.start()

  // 执行 setup 中动态注册的数据库迁移（通过 context.registerMigration 注册）
  // 静态迁移已在上一步执行，此处只会执行 setup 中新增的迁移
  const dynamicMigrations = manager.getAllMigrations()
  if (dynamicMigrations.length > 0) {
    log.info({ count: dynamicMigrations.length }, '开始执行插件动态数据库迁移')
    for (const migration of dynamicMigrations) {
      try {
        applyMigrations(app.db, [migration])
        log.info({ id: migration.id }, '迁移已执行')
      } catch (err) {
        log.error({ id: migration.id, err }, '迁移执行失败')
      }
    }
  }

  // 装饰 Fastify 实例（插件注册的服务）
  const services = manager.getAllServices()
  for (const { pluginName, name, service } of services) {
    try {
      app.decorate(name, service)
      log.info({ pluginName, serviceName: name }, '已装饰 Fastify 服务')
    } catch (err) {
      log.error({ pluginName, serviceName: name, err }, '装饰 Fastify 服务失败')
    }
  }

  // 将插件注册的路由集成到 Fastify
  // 路由路径格式：/api/plugins/:pluginName + route.path
  const routes = manager.getAllRoutes()
  for (const { pluginName, route } of routes) {
    const fullPath = `/api/plugins/${pluginName}${route.path}`
    try {
      // 根据方法调用对应的 Fastify 注册函数
      const opts = {
        handler: route.handler,
        ...(route.bodyLimit ? { bodyLimit: route.bodyLimit } : {}),
      }
      switch (route.method) {
        case 'GET':
          app.get(fullPath, opts)
          break
        case 'POST':
          app.post(fullPath, opts)
          break
        case 'PUT':
          app.put(fullPath, opts)
          break
        case 'DELETE':
          app.delete(fullPath, opts)
          break
        case 'PATCH':
          app.patch(fullPath, opts)
          break
        default:
          log.warn({ method: route.method, path: fullPath }, '不支持的路由方法，跳过')
          continue
      }
      log.info({ method: route.method, path: fullPath }, '已注册插件路由')
    } catch (err) {
      log.error({ method: route.method, path: fullPath, err }, '注册插件路由失败')
    }
  }

  // 暴露 PluginManager 到 Fastify 实例
  app.decorate('pluginManager', manager)

  // Fastify 关闭时停止所有插件
  app.addHook('onClose', async () => {
    log.info('正在停止插件系统')
    await manager.stop()
    log.info('插件系统已停止')
  })

  log.info(
    {
      totalPlugins: manager.list().length,
      enabledPlugins: manager.list().filter((p) => p.status === 'enabled').length,
      totalTools: manager.getAllTools().length,
      totalRoutes: routes.length,
      totalMigrations: staticMigrations.length + dynamicMigrations.length,
      totalServices: services.length,
    },
    '插件系统初始化完成',
  )
})

/** 工具函数：拼接插件数据目录路径（供插件使用） */
export function getPluginDataDir(dataDir: string, pluginName: string): string {
  return join(dataDir, 'plugins', pluginName)
}
