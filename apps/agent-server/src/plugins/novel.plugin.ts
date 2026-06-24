/**
 * 小说创作系统插件
 *
 * 初始化小说创作系统的所有核心组件，挂载到 Fastify 实例：
 * - NovelStore：统一存储（SQLite CRUD）
 * - PromptManager：提示词模板管理器（三级覆盖）
 * - NovelPromptBuilder：缓存优化的提示词构建器
 * - NovelSessionFactory：Session 工厂（集成 Pi SDK）
 * - NovelEngine：核心引擎（流程编排）
 *
 * 必须在 databasePlugin 之后注册（依赖 app.db）。
 */

import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { NovelStore } from '../core/novel/novel-store.js'
import { PromptManager } from '../core/novel/prompt-manager.js'
import { NovelPromptBuilder } from '../core/novel/prompt-builder.js'
import { NovelSessionFactory } from '../core/novel/novel-session.js'
import { NovelEngine } from '../core/novel/novel-engine.js'

export const novelPlugin: FastifyPluginAsync = fp(async (app) => {
  const cwd = process.env.PI_CWD ?? process.cwd()

  // 1. 创建 NovelStore（依赖 app.db）
  const novelStore = new NovelStore(app.db)

  // 2. 创建 PromptManager（依赖 app.db + cwd）
  const promptManager = new PromptManager(app.db, cwd)

  // 3. 创建 NovelPromptBuilder（依赖 PromptManager + NovelStore）
  const novelPromptBuilder = new NovelPromptBuilder(promptManager, novelStore)

  // 4. 创建 NovelSessionFactory（复用共享的 store 和 promptManager）
  const novelSessionFactory = new NovelSessionFactory(novelStore, promptManager)

  // 5. 创建 NovelEngine（依赖 NovelStore + NovelSessionFactory）
  const novelEngine = new NovelEngine(novelStore, novelSessionFactory)

  // 6. 挂载到 Fastify 实例
  app.decorate('novelStore', novelStore)
  app.decorate('promptManager', promptManager)
  app.decorate('novelPromptBuilder', novelPromptBuilder)
  app.decorate('novelSessionFactory', novelSessionFactory)
  app.decorate('novelEngine', novelEngine)

  app.log.info('小说创作系统插件已初始化')
})
