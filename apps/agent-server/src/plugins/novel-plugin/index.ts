/**
 * 小说创作系统插件入口
 *
 * 将原分散在 core/novel/ + plugins/novel.plugin.ts + routes/novel.route.ts
 * 的小说系统整合为独立插件目录。
 *
 * 迁移策略：
 * - migrations 作为静态属性声明，在 setup 之前执行（确保 setup 时表已存在）
 * - setup 中不再调用 registerMigration（静态迁移已涵盖全部 013-026）
 *
 * setup 流程：
 * 1. 初始化服务（NovelStore / PromptManager / NovelPromptBuilder / NovelSessionFactory / NovelEngine / tools）
 * 2. 装饰 Fastify 实例（供其他插件和路由使用）
 * 3. 注册 Pi Session 工具（注入到 customTools）
 * 4. 注册 REST API 路由（自动加 /api/plugins/novel 前缀）
 * 5. 注册前端面板（NovelCanvas）
 *
 * 必须在 databasePlugin 和 pluginLoaderPlugin 之后加载（依赖 app.db）。
 */

import type { Plugin, PluginContext } from '../../core/plugin/plugin-types.js'
import { novelMigrations } from './novel-migrations.js'
import { createNovelServices } from './novel-services.js'
import { createNovelRoutes } from './novel-routes.js'
import { NOVEL_AGENT_CONFIGS } from './core/novel-agents.js'

/** Novel Team ID（全局唯一，避免重复创建） */
const NOVEL_TEAM_ID = 'novel-team'

export function createNovelPlugin(): Plugin {
  return {
    manifest: {
      name: 'novel',
      version: '1.0.0',
      description: 'AI 小说创作工作台',
      builtin: true,
    },

    // 静态数据库迁移：在 setup 之前执行，确保 NovelStore 构造时表已存在
    migrations: novelMigrations,

    async setup(context: PluginContext) {
      // 1. 初始化服务（迁移已执行，表已存在）
      //    传入 context 供 NovelOrchestrator/NovelCharacterGenerator 调用 createSession API
      //    context.teamManager 由 plugin-loader 注入（teamPlugin 已在 pluginLoaderPlugin 之前注册）
      const services = createNovelServices(context)

      // 2. 装饰 Fastify 实例（与原 novel.plugin.ts 保持一致的装饰器名）
      context.registerService('novelStore', services.store)
      context.registerService('promptManager', services.promptManager)
      context.registerService('novelPromptBuilder', services.promptBuilder)
      context.registerService('novelSessionFactory', services.sessionFactory)
      context.registerService('novelEngine', services.engine)
      context.registerService('novelOrchestrator', services.orchestrator)

      // 3. 注册 Novel Agent 到 AgentManager
      //    使小说 Agent 可通过统一的 subagent / team_execute 工具触发。
      //    不限制 tools，让小说 Agent 能使用所有可用工具。
      //    注：AgentConfig.systemPrompt 在此使用 identity 作为基础身份提示词；
      //    NovelOrchestrator 的 createChapterWithFlow 仍通过 promptBuilder.buildSystemPrompt
      //    构建 per-project 的完整系统提示词，二者互不影响。
      const agentManager = context.subagentManager
      if (agentManager) {
        let registeredCount = 0
        for (const [agentType, config] of Object.entries(NOVEL_AGENT_CONFIGS)) {
          // 跳过已注册的 Agent（避免重启时重复注册）
          if (agentManager.getAgent(config.id)) {
            context.logger.debug({ agentId: config.id, agentType }, 'Novel Agent 已注册，跳过')
            continue
          }
          try {
            agentManager.registerAgent({
              id: config.id,
              name: config.name,
              description: config.identity,
              systemPrompt: config.identity,
            })
            registeredCount++
          } catch (err) {
            context.logger.error({ agentId: config.id, err }, '注册 Novel Agent 失败')
          }
        }
        context.logger.info({ count: registeredCount }, 'Novel Agent 已注册到 AgentManager')
      } else {
        context.logger.warn('subagentManager 不可用，跳过 Novel Agent 注册')
      }

      // 4. 注册 Novel Team 到 TeamManager
      //    管道式执行：Director → Writer → Reviewer → Reviser → Memory
      //    与 NovelOrchestrator 的 SSE 流程并存，提供统一的 team_execute 触发方式。
      const teamManager = context.teamManager
      if (teamManager) {
        const existing = teamManager.listTeams().find((t) => t.id === NOVEL_TEAM_ID)
        if (existing) {
          context.logger.debug({ teamId: NOVEL_TEAM_ID }, 'Novel Team 已存在，跳过创建')
        } else {
          try {
            await teamManager.createTeam({
              id: NOVEL_TEAM_ID,
              name: '小说创作团队',
              description: '小说多 Agent 创作团队：导演→作家→审稿→修订→记忆',
              leadAgentId: 'novel-director',
              members: [
                { agentId: 'novel-director', role: 'analyst', roleDescription: '分析故事状态，生成叙事任务' },
                { agentId: 'novel-writer', role: 'writer', roleDescription: '根据叙事任务创作章节正文' },
                { agentId: 'novel-reviewer', role: 'reviewer', roleDescription: '检查章节质量，生成验收报告' },
                { agentId: 'novel-reviser', role: 'writer', roleDescription: '根据审稿意见修订章节' },
                { agentId: 'novel-memory', role: 'analyst', roleDescription: '提取状态变更，更新故事记忆' },
              ],
              defaultStrategy: 'pipeline',
              maxParallel: 1,
            })
            context.logger.info({ teamId: NOVEL_TEAM_ID }, 'Novel Team 已注册到 TeamManager')
          } catch (err) {
            context.logger.error({ teamId: NOVEL_TEAM_ID, err }, '注册 Novel Team 失败')
          }
        }
      } else {
        context.logger.warn('teamManager 不可用，跳过 Novel Team 注册')
      }

      // 5. 注册 Pi Session 工具（注入到 customTools）
      // 注：services.tools 为 pi-coding-agent 的 ToolDefinition（含 TSchema 泛型），
      // 与 plugin-types 的 ToolDefinition 结构不同，需类型转换绕过编译期检查。
      // 运行时由 pi-session.ts 的 customTools 统一消费，结构兼容。
      context.registerSessionTools(services.tools as unknown as Parameters<typeof context.registerSessionTools>[0])

      // 6. 注册 REST API 路由（路径自动加 /api/plugins/novel 前缀）
      const routes = createNovelRoutes(services)
      for (const route of routes) {
        context.registerRoute(route)
      }

      // 7. 注册前端面板
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
