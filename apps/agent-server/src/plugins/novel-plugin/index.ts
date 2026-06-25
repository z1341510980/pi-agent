/**
 * 小说创作系统插件入口
 *
 * 将原分散在 core/novel/ + plugins/novel.plugin.ts + routes/novel.route.ts
 * 的小说系统整合为独立插件目录。
 *
 * setup 流程：
 * 1. 注册数据库迁移（013-026）
 * 2. 初始化服务（NovelStore / PromptManager / NovelPromptBuilder / NovelSessionFactory / NovelEngine / tools）
 * 3. 装饰 Fastify 实例（供其他插件和路由使用）
 * 4. 注册 Pi Session 工具（注入到 customTools）
 * 5. 注册 REST API 路由（自动加 /api/plugins/novel 前缀）
 * 6. 注册前端面板（NovelCanvas）
 *
 * 必须在 databasePlugin 和 pluginLoaderPlugin 之后加载（依赖 app.db）。
 */

import type { Plugin, PluginContext } from '../../core/plugin/plugin-types.js'
import { novelMigrations } from './novel-migrations.js'
import { createNovelServices } from './novel-services.js'
import { createNovelRoutes } from './novel-routes.js'

export function createNovelPlugin(): Plugin {
  return {
    manifest: {
      name: 'novel',
      version: '1.0.0',
      description: 'AI 小说创作工作台',
      builtin: true,
    },

    async setup(context: PluginContext) {
      // 1. 注册数据库迁移
      for (const migration of novelMigrations) {
        context.registerMigration(migration)
      }

      // 2. 初始化服务
      const services = createNovelServices(context.db, context.cwd)

      // 3. 装饰 Fastify 实例（与原 novel.plugin.ts 保持一致的装饰器名）
      context.registerService('novelStore', services.store)
      context.registerService('promptManager', services.promptManager)
      context.registerService('novelPromptBuilder', services.promptBuilder)
      context.registerService('novelSessionFactory', services.sessionFactory)
      context.registerService('novelEngine', services.engine)
      context.registerService('novelOrchestrator', services.orchestrator)

      // 4. 注册 Pi Session 工具（注入到 customTools）
      // 注：services.tools 为 pi-coding-agent 的 ToolDefinition（含 TSchema 泛型），
      // 与 plugin-types 的 ToolDefinition 结构不同，需类型转换绕过编译期检查。
      // 运行时由 pi-session.ts 的 customTools 统一消费，结构兼容。
      context.registerSessionTools(services.tools as unknown as Parameters<typeof context.registerSessionTools>[0])

      // 5. 注册 REST API 路由（路径自动加 /api/plugins/novel 前缀）
      const routes = createNovelRoutes(services)
      for (const route of routes) {
        context.registerRoute(route)
      }

      // 6. 注册前端面板
      context.registerPanel({
        id: 'novel-canvas',
        title: '小说工作台',
        component: 'NovelCanvas',
        position: 'main',
      })

      context.logger.info('小说创作系统插件已初始化')
    },
  }
}

export default createNovelPlugin
