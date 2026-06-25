/**
 * 小说创作系统服务初始化
 *
 * 集中创建小说系统的所有核心组件，供 novel-plugin 的 setup 调用：
 * - NovelStore：统一存储（SQLite CRUD）
 * - PromptManager：提示词模板管理器（三级覆盖）
 * - NovelPromptBuilder：缓存优化的提示词构建器
 * - NovelSessionFactory：Session 工厂（集成 Pi SDK）
 * - NovelEngine：核心引擎（流程编排）
 * - tools：Pi Session 自定义工具集
 *
 * 依赖关系（与原 novel.plugin.ts 保持一致）：
 * - NovelStore 依赖 db
 * - PromptManager 依赖 db + cwd
 * - NovelPromptBuilder 依赖 PromptManager + NovelStore
 * - NovelSessionFactory 依赖 NovelStore + PromptManager
 * - NovelEngine 依赖 NovelStore + NovelSessionFactory
 * - createNovelTools 依赖 NovelStore
 */

import type Database from 'better-sqlite3'
import { NovelStore } from '../../core/novel/novel-store.js'
import { PromptManager } from '../../core/novel/prompt-manager.js'
import { NovelPromptBuilder } from '../../core/novel/prompt-builder.js'
import { NovelSessionFactory } from '../../core/novel/novel-session.js'
import { NovelEngine } from '../../core/novel/novel-engine.js'
import { createNovelTools } from '../../core/novel/novel-tools.js'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

export interface NovelServices {
  store: NovelStore
  promptManager: PromptManager
  promptBuilder: NovelPromptBuilder
  sessionFactory: NovelSessionFactory
  engine: NovelEngine
  tools: ToolDefinition[]
}

/** 初始化小说系统所有服务 */
export function createNovelServices(db: Database.Database, cwd: string): NovelServices {
  // 1. 创建 NovelStore（依赖 db）
  const store = new NovelStore(db)

  // 2. 创建 PromptManager（依赖 db + cwd）
  const promptManager = new PromptManager(db, cwd)

  // 3. 创建 NovelPromptBuilder（依赖 PromptManager + NovelStore）
  const promptBuilder = new NovelPromptBuilder(promptManager, store)

  // 4. 创建 NovelSessionFactory（复用共享的 store 和 promptManager）
  const sessionFactory = new NovelSessionFactory(store, promptManager)

  // 5. 创建 NovelEngine（依赖 NovelStore + NovelSessionFactory）
  const engine = new NovelEngine(store, sessionFactory)

  // 6. 创建 Pi Session 工具集（依赖 NovelStore）
  const tools = createNovelTools(store)

  return { store, promptManager, promptBuilder, sessionFactory, engine, tools }
}
