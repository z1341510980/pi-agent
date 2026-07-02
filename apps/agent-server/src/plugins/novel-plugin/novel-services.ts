/**
 * 小说创作系统服务初始化
 *
 * 集中创建小说系统的所有核心组件，供 novel-plugin 的 setup 调用：
 * - NovelStore：统一存储（SQLite CRUD）
 * - NovelMemoryStore：长期记忆分层存储（事件 + 快照 + 因果链）
 * - PromptManager：提示词模板管理器（三级覆盖）
 * - NovelPromptBuilder：缓存优化的提示词构建器
 * - NovelSessionFactory：Session 工厂（集成 Pi SDK）
 * - NovelEngine：核心引擎（流程编排）
 * - NovelOrchestrator：多 Agent 编排引擎（Director → Writer → Reviewer → Reviser → Memory）
 * - NovelCharacterGenerator：AI 角色生成器
 * - tools：Pi Session 自定义工具集
 *
 * 依赖关系（与原 novel.plugin.ts 保持一致）：
 * - NovelStore 依赖 db
 * - NovelMemoryStore 依赖 db
 * - PromptManager 依赖 db + cwd
 * - NovelPromptBuilder 依赖 PromptManager + NovelStore
 * - NovelSessionFactory 依赖 NovelStore + PromptManager
 * - NovelEngine 依赖 NovelStore + NovelSessionFactory
 * - NovelOrchestrator 依赖 NovelStore + NovelMemoryStore + NovelSessionFactory + NovelPromptBuilder + NovelEngine + PluginContext
 * - NovelCharacterGenerator 依赖 NovelPromptBuilder + PromptManager + PluginContext
 * - createNovelTools 依赖 NovelStore
 */

import { NovelStore } from './core/novel-store.js'
import { PromptManager } from './core/prompt-manager.js'
import { NovelPromptBuilder } from './core/prompt-builder.js'
import { NovelSessionFactory } from './core/novel-session.js'
import { NovelEngine } from './core/novel-engine.js'
import { createNovelTools } from './core/novel-tools.js'
import { NovelOrchestrator } from './core/novel-orchestrator.js'
import { NovelCharacterGenerator } from './core/novel-character-generator.js'
import { NovelEntityGenerator } from './core/novel-entity-generator.js'
import { NovelMemoryGenerator } from './core/novel-memory-generator.js'
import { NovelMemoryStore } from './core/novel-memory-store.js'
import { NovelAgentConfigStore } from './core/novel-agent-config-store.js'
import type { PluginContext } from '../../core/plugin/plugin-types.js'
import type { TeamManager } from '../../core/agent/team-manager.js'
import type { AgentManager } from '../../core/agent/subagent-tool.js'
import type { ConfirmationManager } from '../../core/tool/confirmation-manager.js'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

export interface NovelServices {
  store: NovelStore
  memoryStore: NovelMemoryStore
  promptManager: PromptManager
  promptBuilder: NovelPromptBuilder
  sessionFactory: NovelSessionFactory
  engine: NovelEngine
  orchestrator: NovelOrchestrator
  characterGenerator: NovelCharacterGenerator
  entityGenerator: NovelEntityGenerator
  tools: ToolDefinition[]
  /** 小说角色温度配置存储 */
  agentConfigStore: NovelAgentConfigStore
  /**
   * TeamManager（可选，由 teamPlugin 提供）
   * 当 teamPlugin 已注册且 plugin-loader 完成注入时可用，
   * 供 novel-routes 的 create-team 路由触发统一团队执行。
   */
  teamManager?: TeamManager
  /**
   * AgentManager（可选，由 subagentPlugin 提供）
   * 当用户通过 PUT /agent-config 调整温度时，需同步到 AgentManager
   * 让 subagent / team_execute 路径也能拿到最新温度。
   */
  agentManager?: AgentManager
  /**
   * ConfirmationManager（chat 底座共享，由 PluginContext 注入）
   *
   * 供 novel checkpoint 流程复用 chat 的统一确认/决策机制：
   * - 默认 120s 超时，避免 checkpoint 用户不响应导致永久 pending
   * - 复用 pending 列表与 'confirmation:request' / 'confirmation:resolved' 事件
   * - 调用 requestDecision/respondDecision 处理 'approve'/'reject'/'revise'/'rewrite' 等多决策
   */
  confirmationManager: ConfirmationManager
}

/**
 * 初始化小说系统所有服务
 *
 * @param context PluginContext（提供 db / cwd / logger / createSession 等）
 */
export function createNovelServices(context: PluginContext): NovelServices {
  const { db, cwd, teamManager, subagentManager: agentManager, confirmationManager } = context

  // 1. 创建 NovelStore（依赖 db）
  const store = new NovelStore(db)

  // 2. 创建 NovelMemoryStore（依赖 db，长期记忆分层存储）
  const memoryStore = new NovelMemoryStore(db)

  // 3. 创建 PromptManager（依赖 db + cwd）
  const promptManager = new PromptManager(db, cwd)

  // 4. 创建 NovelPromptBuilder（依赖 PromptManager + NovelStore）
  const promptBuilder = new NovelPromptBuilder(promptManager, store)

  // 5. 创建 NovelSessionFactory（复用共享的 store 和 promptManager）
  const sessionFactory = new NovelSessionFactory(store, promptManager)

  // 6. 创建 NovelEngine（依赖 NovelStore + NovelSessionFactory）
  const engine = new NovelEngine(store, sessionFactory)

  // 6.5 创建小说角色温度配置存储（薄封装 AgentManager，依赖 db + agentManager）
  //     先于 orchestrator 创建：orchestrator 在 runAgent 中读取它以合并温度
  //     注：agentManager 可能为 undefined（subagentPlugin 未注册时），
  //         NovelAgentConfigStore 内部会回退到 NOVEL_AGENT_CONFIGS 默认值
  const agentConfigStore = new NovelAgentConfigStore(db, agentManager)

  // 7. 创建 NovelOrchestrator（依赖 NovelStore + NovelMemoryStore + NovelSessionFactory + NovelPromptBuilder + NovelEngine + PluginContext + NovelAgentConfigStore + NovelMemoryGenerator）
  //    PluginContext.createSession 用于 runAgent 调用 LLM
  //    agentConfigStore 用于 runAgent 中按角色合并温度并传入 createSession
  //    memoryGenerator 用于 Memory 阶段的结构化 LLM 调用（替代原工具循环模式）
  // 7.5 先创建 NovelMemoryGenerator（orchestrator 依赖它）
  const memoryGenerator = new NovelMemoryGenerator(promptBuilder, promptManager, context, store, engine)
  const orchestrator = new NovelOrchestrator(store, memoryStore, sessionFactory, promptBuilder, engine, context, agentConfigStore, memoryGenerator)

  // 8. 创建 NovelCharacterGenerator（依赖 NovelPromptBuilder + PromptManager + PluginContext）
  //    PluginContext.createSession 用于 generate 调用 LLM
  const characterGenerator = new NovelCharacterGenerator(promptBuilder, promptManager, context)

  // 9. 创建 NovelEntityGenerator（通用实体生成器，character 分支委托给 characterGenerator）
  //    依赖 NovelStore 用于 generateAndArrange 落库（角色/冲突/伏笔 + 角色历史）
  const entityGenerator = new NovelEntityGenerator(promptBuilder, promptManager, context, characterGenerator, store)

  // 10. 创建 Pi Session 工具集（依赖 NovelStore）
  const tools = createNovelTools(store)

  return { store, memoryStore, promptManager, promptBuilder, sessionFactory, engine, orchestrator, characterGenerator, entityGenerator, tools, agentConfigStore, teamManager, agentManager, confirmationManager }
}
