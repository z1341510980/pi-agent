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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createModuleLogger } from '../lib/logger.js'
import { PluginManager } from '../core/plugin/plugin-manager.js'
import {
  ALL_PLUGIN_CAPABILITIES,
  parsePluginCatalog,
  type PluginCatalogItem
} from '../core/plugin/plugin-catalog.js'
import { verifyPackageIntegrity } from '../core/plugin/plugin-integrity.js'
import { PolicyHookManager } from '../core/policy/policy-hook-manager.js'
import {
  normalizeToHookDefinitions,
  parsePiHookConfigDetailed,
  type PiHookConfig
} from '../core/policy/hook-adapter.js'
import { createHelloPlugin } from './examples/hello-plugin/index.js'
import { createNovelPlugin } from './novel-plugin/index.js'
import { createWebSearchPlugin } from './web-search-plugin/index.js'
import { applyMigrations } from '../core/db/migrations.js'
import yaml from 'js-yaml'
import type { Plugin, PluginCapability } from '../core/plugin/plugin-types.js'

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
    'web-search-plugin': createWebSearchPlugin
  }

  // 默认内置插件列表（没有 plugins.yml 时的兼容行为）；catalogId 与工厂键一致
  const defaultBuiltinPlugins = [
    ...(enableExamples ? [{ plugin: createHelloPlugin(), catalogId: 'hello-plugin' }] : []),
    { plugin: createNovelPlugin(), catalogId: 'novel-plugin' },
    { plugin: createWebSearchPlugin(), catalogId: 'web-search-plugin' }
  ]

  // 尝试从配置文件加载插件列表
  // 存储所有插件的配置信息（包括 disabled 的），供管理界面展示
  const allPluginConfigs: PluginCatalogItem[] = []

  const builtinPlugins: Array<{
    plugin: Plugin
    source: 'builtin'
    catalogId: string
    config?: Record<string, unknown>
    isolate?: boolean
  }> = []
  const configRoot = process.env.PI_CONFIG_DIR ?? join(cwd, 'config')
  const configPath = resolve(configRoot, 'plugins.yml')
  const persistCatalog = (): void => {
    try {
      const lines = ['# Generated plugin catalog state. Changes require restart.', 'plugins:']
      for (const item of manager.getCatalogConfigs()) {
        lines.push(
          `  - id: ${item.catalogId}`,
          `    source: ${item.source}`,
          `    enabled: ${item.enabled}`
        )
        if (item.isolate !== undefined) lines.push(`    isolate: ${item.isolate}`)
        if (item.sourceRef) lines.push(`    sourceRef: ${JSON.stringify(item.sourceRef)}`)
        // 锁定字段原样保留：它们是安装侧写入的信任锚，不能在回写时丢失
        if (item.resolvedVersion) lines.push(`    resolvedVersion: ${JSON.stringify(item.resolvedVersion)}`)
        if (item.integrity) lines.push(`    integrity: ${JSON.stringify(item.integrity)}`)
        if (item.grants?.length)
          lines.push(
            `    grants: [${item.grants.map((grant) => JSON.stringify(grant)).join(', ')}]`
          )
        if (item.config) lines.push(`    config: ${JSON.stringify(item.config)}`)
      }
      writeFileSync(configPath, `${lines.join('\n')}\n`, 'utf-8')
    } catch (error) {
      log.warn({ error, configPath }, '插件目录状态持久化失败')
    }
  }

  if (existsSync(configPath)) {
    try {
      const configContent = readFileSync(configPath, 'utf-8')
      // 统一由 plugin-catalog 解析：结构校验、环境变量引用与未知 capability
      // 都在这里拒绝并给出诊断，不把半解析的配置交给插件。
      const parsed = parsePluginCatalog(
        (yaml.load(configContent) ?? {}) as { plugins?: unknown }
      )
      for (const diagnostic of parsed.diagnostics) {
        const payload = {
          configPath,
          catalogId: diagnostic.catalogId,
          index: diagnostic.index
        }
        if (diagnostic.level === 'error') log.error(payload, diagnostic.message)
        else log.warn(payload, diagnostic.message)
      }

      for (const item of parsed.items) {
        allPluginConfigs.push(item)

        if (item.source !== 'builtin') {
          // local/npm 的代码在禁用时不 import：执行第三方模块的顶层代码
          // 本身就是副作用。它们仍通过 /api/plugins/catalog 可见。
          continue
        }
        const factory = pluginFactories[item.catalogId]
        if (!factory) {
          log.warn({ catalogId: item.catalogId }, '未找到内置插件工厂，跳过')
          continue
        }
        // 内置插件即使 enabled: false 也进 catalog：代码已随仓库编译，
        // 实例化没有额外副作用，而"用户关着它"必须区别于"我们没找到它"，
        // 否则 POST /enable 找不到目标（研究文档 §10.2）。
        builtinPlugins.push({
          plugin: factory(),
          source: 'builtin',
          catalogId: item.catalogId,
          config: item.config,
          isolate: item.isolate
        })
      }
      log.info(
        {
          count: allPluginConfigs.length,
          enabled: allPluginConfigs.filter((item) => item.enabled).length,
          diagnostics: parsed.diagnostics.length,
          configPath
        },
        '从配置文件加载插件清单'
      )
    } catch (err) {
      log.warn({ err, configPath }, '解析 plugins.yml 失败，回退到默认插件列表')
    }
  }

  // 如果没有从配置文件加载到任何插件，回退到默认列表
  const finalBuiltinPlugins = builtinPlugins.length > 0 ? builtinPlugins : defaultBuiltinPlugins

  log.info(
    {
      localPluginsDir: localPluginsDir ?? '(未配置)',
      enableNpmPlugins,
      enableExamples,
      builtinCount: builtinPlugins.length,
      cwd,
      dataDir
    },
    '初始化插件系统'
  )

  // 创建 PluginManager
  const manager = new PluginManager(log, app.eventBus, app.db, cwd, dataDir, {
    localPluginsDir,
    enableNpmPlugins,
    builtinPlugins: finalBuiltinPlugins
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

  // 保存插件目录配置（供管理界面展示，包括 disabled 插件）
  // 必须在 init() 之前：loadPluginEntry 会按 catalogId 查 desiredEnabled 与 grants，
  // 晚注入会让所有插件默认 desiredEnabled=true 且拿不到持久化的 grants。
  manager.setCatalogConfigs(allPluginConfigs)

  // 初始化（扫描并加载插件）
  await manager.init()

  // 加载 local 和 npm 类型的插件（从 YAML 配置中读取）
  // 这些插件在 init() 中未被加载，需要显式加载
  const localAndNpmConfigs = allPluginConfigs.filter(
    (c) => c.enabled && (c.source === 'local' || c.source === 'npm')
  )

  for (const config of localAndNpmConfigs) {
    try {
      let filePath: string | undefined
      let packageDir: string | undefined

      if (config.source === 'local') {
        // local 类型：使用 sourceRef 作为文件路径
        if (!config.sourceRef) {
          log.warn({ catalogId: config.catalogId }, 'local 插件缺少 sourceRef，跳过加载')
          continue
        }
        // 如果是相对路径，相对于 cwd 解析
        filePath = resolve(cwd, config.sourceRef)
        packageDir = resolve(filePath, '..')
      } else if (config.source === 'npm') {
        // npm 类型：从 node_modules 解析包入口
        if (!config.sourceRef) {
          log.warn({ catalogId: config.catalogId }, 'npm 插件缺少 sourceRef（包名），跳过加载')
          continue
        }
        const packageName = config.sourceRef
        const nodeModulesDir = resolve(cwd, 'node_modules')
        // 只允许 npm 包名（含 scoped package），禁止绝对路径和 .. 逃逸。
        if (!/^(@[^/]+\/)?[A-Za-z0-9._-]+$/.test(packageName)) {
          log.warn({ catalogId: config.catalogId, packageName }, '拒绝不安全的 npm 插件 sourceRef')
          continue
        }
        const packageDirResolved = resolve(nodeModulesDir, packageName)
        if (!packageDirResolved.startsWith(nodeModulesDir + '\\')) {
          log.warn(
            { catalogId: config.catalogId, packageName },
            '拒绝逃逸 node_modules 的 npm 插件路径'
          )
          continue
        }
        if (!existsSync(packageDirResolved)) {
          log.warn(
            { catalogId: config.catalogId, packageName, packageDir: packageDirResolved },
            'npm 包未找到，跳过加载'
          )
          continue
        }
        packageDir = packageDirResolved
        // 解析入口文件
        const pkgJsonPath = resolve(packageDir, 'package.json')
        let mainFile = 'index.js'
        if (existsSync(pkgJsonPath)) {
          try {
            const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
            if (typeof pkg.main === 'string' && pkg.main.length > 0) {
              mainFile = pkg.main
            }
          } catch {
            // 忽略 package.json 解析错误，使用默认入口
          }
        }
        filePath = resolve(packageDir, mainFile)
        if (!existsSync(filePath)) {
          // 尝试 index.js 作为备选
          const fallback = resolve(packageDir, 'index.js')
          if (existsSync(fallback)) {
            filePath = fallback
          } else {
            log.warn(
              { catalogId: config.catalogId, packageName, filePath },
              'npm 插件入口文件未找到，跳过加载'
            )
            continue
          }
        }
      }

      if (!filePath) {
        log.warn(
          { catalogId: config.catalogId, source: config.source },
          '无法解析插件文件路径，跳过加载'
        )
        continue
      }

      // 完整性校验（研究文档 §6.3）：锁定版本/摘要的插件必须在 import 之前通过校验。
      // 校验失败不加载、不降级 —— 未经校验的代码不能因为"已经在磁盘上"就被信任。
      let integrityStatus: 'verified' | 'unverified' = 'unverified'
      if (config.integrity !== undefined || config.resolvedVersion !== undefined) {
        const verification = verifyPackageIntegrity({
          packageDir: packageDir ?? resolve(filePath, '..'),
          ...(config.integrity !== undefined ? { integrity: config.integrity } : {}),
          ...(config.resolvedVersion !== undefined
            ? { resolvedVersion: config.resolvedVersion }
            : {})
        })
        if (!verification.ok) {
          log.error(
            {
              catalogId: config.catalogId,
              source: config.source,
              reason: verification.reason,
              computedSri: verification.computedSri,
              actualVersion: verification.actualVersion
            },
            '插件完整性校验失败，拒绝加载；请重新安装并更新 plugins.yml 的锁定信息'
          )
          continue
        }
        integrityStatus = 'verified'
        log.info(
          {
            catalogId: config.catalogId,
            source: config.source,
            fileCount: verification.fileCount,
            version: verification.actualVersion
          },
          '插件完整性校验通过'
        )
      } else {
        log.warn(
          { catalogId: config.catalogId, source: config.source },
          '插件未声明 integrity/resolvedVersion，将以 unverified 状态加载；' +
            '生产环境应先运行 scripts/seal-plugin.ts 并把锁定信息写入 plugins.yml'
        )
      }

      log.info(
        { catalogId: config.catalogId, source: config.source, filePath },
        '加载 local/npm 插件'
      )
      // config.source 此时一定是 'local' 或 'npm'（已在过滤中限定）
      await manager.loadFromFile(
        filePath,
        config.source as 'local' | 'npm',
        false,
        config.config,
        config.isolate,
        config.catalogId,
        integrityStatus
      )
    } catch (err) {
      log.error(
        { catalogId: config.catalogId, source: config.source, err },
        `加载 ${config.source} 插件失败`
      )
    }
  }

  // ============ 加载 Hook 配置 ============
  // Hook 配置使用自有格式（PiHookConfig），由 hook-adapter 统一解析：
  // 结构非法的条目会被拒绝并如实上报，不会带着空命令进入运行时。
  const hookManager = new PolicyHookManager()
  const hookConfigPath = resolve(configRoot, 'hooks.yml')

  if (existsSync(hookConfigPath)) {
    try {
      const hookConfigContent = readFileSync(hookConfigPath, 'utf-8')
      const hookConfig = (yaml.load(hookConfigContent) ?? {}) as PiHookConfig
      const parsed = parsePiHookConfigDetailed(hookConfig)

      for (const item of parsed.rejected) {
        log.warn(
          { configPath: hookConfigPath, index: item.index, reason: item.reason },
          'Hook 配置条目被拒绝'
        )
      }

      hookManager.setSecurity(parsed.security)
      const definitions = normalizeToHookDefinitions(parsed.hooks)
      hookManager.setHooks(definitions)
      const enabledCount = definitions.filter((hook) => hook.enabled).length
      if (enabledCount > 0) {
        log.info(
          {
            count: enabledCount,
            rejected: parsed.rejected.length,
            trusted: parsed.security.trusted === true,
            configPath: hookConfigPath
          },
          '已加载 Hook 配置'
        )
      } else {
        log.info({ rejected: parsed.rejected.length }, '未在 hooks.yml 中找到启用的 Hook')
      }
    } catch (err) {
      log.warn({ err, configPath: hookConfigPath }, '解析 hooks.yml 失败，将不启用任何 Hook')
    }
  } else {
    log.info('未找到 hooks.yml，将不启用任何 Hook')
  }

  // 将 hookManager 注入到 manager，供 createPiSession 使用
  manager.setHookManager(hookManager)
  // ========================================

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
        ...(route.bodyLimit ? { bodyLimit: route.bodyLimit } : {})
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

  // 启动期挂载完成：此后 enable 的插件，其 route/service 不会再被宿主挂载，
  // manager 会把 effectiveAfterRestart 置为 true，API 据此如实告知用户需要重启。
  manager.markHostMounted()

  // ============ 插件管理 API ============
  // 获取插件列表
  app.get('/api/plugins', async (request, reply) => {
    try {
      const plugins = manager.list()
      // schemaVersion 与 inspect / ui-contributions 一致：所有插件管理响应都带版本号，
      // 桌面端才能在契约演进时做兼容判定。
      return reply.send({
        ok: true,
        data: { schemaVersion: 1, plugins, total: plugins.length }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.status(500).send({ ok: false, error: { message, code: 'PLUGIN_LIST_ERROR' } })
    }
  })

  // 获取插件详情
  app.get('/api/plugins/:pluginId', async (request, reply) => {
    try {
      const { pluginId } = request.params as { pluginId: string }
      const entry = manager.get(pluginId)
      if (!entry) {
        return reply.status(404).send({
          ok: false,
          error: { message: `插件 ${pluginId} 不存在`, code: 'PLUGIN_NOT_FOUND' }
        })
      }
      const detail = {
        ...entry.manifest,
        schemaVersion: 1,
        pluginId: entry.pluginId,
        catalogId: entry.catalogId,
        status: entry.status,
        source: entry.source,
        integrityStatus: entry.integrityStatus,
        error: entry.error,
        lifecycle: entry.lifecycle,
        desiredEnabled: entry.desiredEnabled,
        dependencyDiagnostics: entry.dependencyDiagnostics ?? [],
        activationGeneration: entry.activationGeneration,
        runId: entry.runId,
        effectCount: entry.effects.length,
        activeEffectCount: entry.effects.filter((effect) => effect.state === 'active').length,
        effectiveAfterRestart: entry.effectiveAfterRestart,
        lastStop: entry.lastStop,
        restartRequired: entry.restartRequired,
        unloadScope: entry.unloadScope,
        grants: Array.from(entry.grants),
        permissions: entry.manifest.permissions ?? [],
        config: entry.config,
        tools: entry.tools.map((tool) => ({ name: tool.name, description: tool.description })),
        routes: entry.routes.map((route) => ({ method: route.method, path: route.path })),
        panels: entry.panels.map((panel) => ({
          id: panel.id,
          title: panel.title,
          component: panel.component,
          position: panel.position
        })),
        toolNames: entry.tools.map((t) => t.name),
        routePaths: entry.routes.map((r) => r.path),
        panelIds: entry.panels.map((p) => p.id),
        uiContributions: entry.uiContributions,
        dependencies: entry.manifest.dependencies ?? [],
        filePath: entry.filePath,
        reloadable: entry.source !== 'builtin'
      }
      return reply.send({ ok: true, data: detail })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.status(500).send({ ok: false, error: { message, code: 'PLUGIN_DETAIL_ERROR' } })
    }
  })

  // P2-4 Inspect：返回稳定的诊断投影，不暴露 effect disposer。
  app.get('/api/plugins/:pluginId/inspect', async (request, reply) => {
    const { pluginId } = request.params as { pluginId: string }
    const entry = manager.get(pluginId)
    if (!entry) {
      return reply.status(404).send({
        ok: false,
        error: { message: `插件 ${pluginId} 不存在`, code: 'PLUGIN_NOT_FOUND' }
      })
    }
    const diagnostics: string[] = []
    if (entry.error) diagnostics.push(entry.error)
    if (entry.restartRequired) diagnostics.push('存在需要重启才能完全卸载的路由或服务')
    // 未经完整性校验的插件必须在诊断里说出来，不能只体现在启动日志
    if (entry.integrityStatus === 'unverified') {
      diagnostics.push('插件包未经完整性校验（plugins.yml 缺少 integrity/resolvedVersion）')
    }
    // 运行期 enable 的插件：setup 成功但宿主已过挂载阶段，route/service 打不到
    if (entry.effectiveAfterRestart) {
      diagnostics.push('本次启用注册的路由或服务需要重启服务后才会生效')
    }
    for (const item of entry.dependencyDiagnostics ?? []) diagnostics.push(item)
    for (const effect of entry.effects) {
      if (effect.state === 'failed' && effect.lastError)
        diagnostics.push(`${effect.kind}: ${effect.lastError}`)
      if (effect.state === 'residual')
        diagnostics.push(`${effect.kind}:${effect.resourceId} 仍残留`)
    }
    return reply.send({
      ok: true,
      data: {
        schemaVersion: 1,
        plugin: {
          pluginId: entry.pluginId,
          catalogId: entry.catalogId,
          packageName: entry.manifest.name,
          version: entry.manifest.version,
          status: entry.status,
          lifecycle: entry.lifecycle,
          integrityStatus: entry.integrityStatus,
          desiredEnabled: entry.desiredEnabled,
          activationGeneration: entry.activationGeneration,
          runId: entry.runId,
          restartRequired: entry.restartRequired,
          effectiveAfterRestart: entry.effectiveAfterRestart,
          unloadScope: entry.unloadScope,
          error: entry.error,
          dependencyDiagnostics: entry.dependencyDiagnostics ?? [],
          lastStop: entry.lastStop
        },
        effects: entry.effects.map(({ dispose: _dispose, ...effect }) => effect),
        slots: entry.uiContributions.map((contribution) => ({
          contributionId: contribution.contributionId,
          slot: contribution.slot,
          scope: contribution.scope,
          priority: contribution.priority,
          rendererKey: contribution.rendererKey,
          state: contribution.state
        })),
        diagnostics: [...new Set(diagnostics)]
      }
    })
  })

  // 启用插件
  app.post('/api/plugins/:pluginId/enable', async (request, reply) => {
    try {
      const { pluginId } = request.params as { pluginId: string }

      // disabled 的 local/npm 插件没有运行时 entry（禁用时不 import 第三方代码）。
      // 此时 enable 的正确语义是"记录期望状态，重启后生效"，而不是谎报 404 未发现。
      if (!manager.get(pluginId)) {
        const catalogItem = manager
          .getCatalogConfigs()
          .find((item) => item.catalogId === pluginId)
        if (catalogItem && !catalogItem.enabled) {
          catalogItem.enabled = true
          persistCatalog()
          return reply.send({
            ok: true,
            data: {
              pluginId,
              status: 'pending-restart',
              desiredEnabled: true,
              effectiveAfterRestart: true,
              restartRequired: false
            }
          })
        }
      }

      await manager.enable(pluginId)
      // 期望状态已改：写回 YAML，使重启后保持启用
      persistCatalog()
      const entry = manager.get(pluginId)
      return reply.send({
        ok: true,
        data: {
          pluginId,
          status: entry?.status ?? 'enabled',
          desiredEnabled: entry?.desiredEnabled ?? true,
          // setup 成功不代表 route/service 已挂到宿主：运行期 enable 需重启才生效
          effectiveAfterRestart: entry?.effectiveAfterRestart ?? false,
          restartRequired: entry?.restartRequired ?? false
        }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = message.includes('不存在')
        ? 'PLUGIN_NOT_FOUND'
        : message.includes('依赖不满足')
          ? 'PLUGIN_DEPENDENCY_UNMET'
          : 'PLUGIN_ENABLE_ERROR'
      const status = message.includes('不存在') ? 404 : message.includes('依赖不满足') ? 409 : 500
      return reply.status(status).send({ ok: false, error: { message, code } })
    }
  })

  // 禁用插件
  app.post('/api/plugins/:pluginId/disable', async (request, reply) => {
    try {
      const { pluginId } = request.params as { pluginId: string }
      await manager.disable(pluginId)
      persistCatalog()
      const entry = manager.get(pluginId)
      return reply.send({
        ok: true,
        data: {
          pluginId,
          status: entry?.status ?? 'disabled',
          desiredEnabled: entry?.desiredEnabled ?? false,
          effectiveAfterRestart: entry?.effectiveAfterRestart ?? false,
          restartRequired: entry?.restartRequired ?? false
        }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = message.includes('不存在') ? 'PLUGIN_NOT_FOUND' : 'PLUGIN_DISABLE_ERROR'
      return reply
        .status(message.includes('不存在') ? 404 : 500)
        .send({ ok: false, error: { message, code } })
    }
  })

  // 更新插件授权（全量替换）
  app.put('/api/plugins/:pluginId/grants', async (request, reply) => {
    try {
      const { pluginId } = request.params as { pluginId: string }
      const body = request.body as { grants?: string[] }
      if (!body.grants || !Array.isArray(body.grants)) {
        return reply.status(400).send({
          ok: false,
          error: { message: 'grants 字段必须为字符串数组', code: 'INVALID_GRANTS' }
        })
      }
      const entry = manager.get(pluginId)
      if (!entry) {
        return reply.status(404).send({
          ok: false,
          error: { message: `插件 ${pluginId} 不存在`, code: 'PLUGIN_NOT_FOUND' }
        })
      }
      // 单一事实源：直接用 catalog 的 ALL_PLUGIN_CAPABILITIES，
      // 不再在路由里维护第二份手写清单（否则新增 capability 必漏改一处）。
      const allCapabilities = new Set<string>(ALL_PLUGIN_CAPABILITIES)
      const invalid = body.grants.filter((g) => !allCapabilities.has(g))
      if (invalid.length > 0) {
        return reply.status(400).send({
          ok: false,
          error: { message: `无效的能力: ${invalid.join(', ')}`, code: 'INVALID_CAPABILITY' }
        })
      }
      manager.updateCatalogConfig(pluginId, { grants: body.grants as PluginCapability[] })
      persistCatalog()
      // restartRequired 与 enable/disable/config 一致地回执：授权变更只在下次
      // activation 生效，响应里不说会让 UI 误以为已经起作用。
      return reply.send({
        ok: true,
        data: {
          pluginId,
          grants: Array.from(entry.grants),
          restartRequired: entry.restartRequired
        }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.status(500).send({ ok: false, error: { message, code: 'GRANT_UPDATE_ERROR' } })
    }
  })

  // 更新插件配置
  app.patch('/api/plugins/:pluginId/config', async (request, reply) => {
    try {
      const { pluginId } = request.params as { pluginId: string }
      const body = request.body as { config?: Record<string, unknown>; enabled?: boolean }
      if (!body.config && body.enabled === undefined) {
        return reply.status(400).send({
          ok: false,
          error: { message: '至少需要提供 config 或 enabled 字段', code: 'INVALID_CONFIG' }
        })
      }
      const entry = manager.get(pluginId)
      if (!entry) {
        return reply.status(404).send({
          ok: false,
          error: { message: `插件 ${pluginId} 不存在`, code: 'PLUGIN_NOT_FOUND' }
        })
      }
      if (body.config) {
        manager.updateCatalogConfig(pluginId, { config: body.config })
      }
      if (body.enabled !== undefined) {
        if (body.enabled && entry.status !== 'enabled') {
          await manager.enable(pluginId)
        } else if (!body.enabled && entry.status === 'enabled') {
          await manager.disable(pluginId)
        } else {
          // 状态已一致，但期望状态仍要落定（例如对 loaded/error 插件设 enabled: false）
          manager.updateCatalogConfig(pluginId, { enabled: body.enabled })
        }
      }
      // enable/disable 会改 desiredEnabled，必须在它们之后统一写回，
      // 否则重启后 YAML 里还是旧的 enabled 值，用户的开关意图丢失。
      persistCatalog()
      entry.restartRequired = true
      const updated = manager.get(pluginId)
      return reply.send({
        ok: true,
        data: {
          pluginId,
          status: updated?.status,
          config: updated?.config,
          restartRequired: true
        }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = message.includes('不存在') ? 'PLUGIN_NOT_FOUND' : 'CONFIG_UPDATE_ERROR'
      return reply
        .status(message.includes('不存在') ? 404 : 500)
        .send({ ok: false, error: { message, code } })
    }
  })

  // 重载插件
  app.post('/api/plugins/:pluginId/reload', async (request, reply) => {
    try {
      const { pluginId } = request.params as { pluginId: string }
      await manager.reload(pluginId)
      const entry = manager.get(pluginId)
      return reply.send({
        ok: true,
        data: { pluginId, status: entry?.status ?? 'reloaded' }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = message.includes('不存在')
        ? 'PLUGIN_NOT_FOUND'
        : message.includes('不支持重载')
          ? 'RELOAD_NOT_SUPPORTED'
          : 'RELOAD_ERROR'
      const status = message.includes('不支持重载') ? 400 : message.includes('不存在') ? 404 : 500
      return reply.status(status).send({ ok: false, error: { message, code } })
    }
  })

  // P2 受信 UI manifest：只返回 rendererKey/slot 等声明，不返回可执行源码。
  app.get('/api/plugins/ui-contributions', async (_request, reply) => {
    const contributions = manager.getAllUiContributions()
    return reply.send({
      ok: true,
      data: { schemaVersion: 1, contributions }
    })
  })

  // 获取插件目录配置（包括 disabled 插件）
  app.get('/api/plugins/catalog', async (request, reply) => {
    try {
      const catalog = manager.getCatalogConfigs()
      return reply.send({ ok: true, data: catalog })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.status(500).send({ ok: false, error: { message, code: 'CATALOG_ERROR' } })
    }
  })

  // Fastify 关闭时停止所有插件
  app.addHook('onClose', async () => {
    log.info('正在停止插件系统')
    await manager.stop()
    log.info('插件系统已停止')
  })

  // 兼容已有管理 API：详细工具、面板和插件路由查询由 loader 统一提供。
  app.get('/api/plugins/:pluginId/tools', async (request, reply) => {
    const { pluginId } = request.params as { pluginId: string }
    const entry = manager.get(pluginId)
    if (!entry)
      return reply.status(404).send({
        ok: false,
        error: { message: `插件 ${pluginId} 不存在`, code: 'PLUGIN_NOT_FOUND' }
      })
    return reply.send({
      ok: true,
      data: {
        tools: entry.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }))
      }
    })
  })
  app.get('/api/plugins/panels/all', async (_request, reply) => {
    return reply.send({ ok: true, data: { panels: manager.getAllPanels() } })
  })

  log.info(
    {
      totalPlugins: manager.list().length,
      enabledPlugins: manager.list().filter((p) => p.status === 'enabled').length,
      totalTools: manager.getAllTools().length,
      totalRoutes: routes.length,
      totalMigrations: staticMigrations.length + dynamicMigrations.length,
      totalServices: services.length
    },
    '插件系统初始化完成'
  )
})

/** 工具函数：拼接插件数据目录路径（供插件使用） */
export function getPluginDataDir(dataDir: string, pluginName: string): string {
  return join(dataDir, 'plugins', pluginName)
}
