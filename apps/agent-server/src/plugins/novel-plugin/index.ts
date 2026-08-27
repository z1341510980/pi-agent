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
 * 1. 初始化服务（NovelStore / PromptManager / NovelPromptBuilder / NovelEngine / tools）
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
import { NOVEL_AGENT_CONFIGS, type NovelAgentType, getNovelAgentTemperature } from './core/domain/novel-agents.js'
import { activeNovelChapterTasks } from './utils/chapter-task-registry.js'
import type { TeamConfig } from '@repo/shared/agent'

/** Novel Team ID（全局唯一，避免重复创建） */
const NOVEL_TEAM_ID = 'novel-team'

/**
 * 从 subagent / team_execute 的 task 文本中解析 projectId。
 *
 * dispatchToAgent 的 task 是自由文本，无法结构化传递 projectId，
 * 这里通过正则匹配常见前缀（"项目" / "projectId" / "project_id"）尽力提取。
 * 命中时 systemPromptBuilder 可构建完整三层缓存 prompt；未命中则回退到 identity。
 */
function extractProjectId(task: string): string | undefined {
  const match = task.match(/(?:项目ID|项目|projectId|project_id)\s*[:：]\s*([a-zA-Z0-9_-]+)/i)
  return match?.[1]
}

export function createNovelPlugin(): Plugin {
  let ownedAgentIds: string[] = []
  let ownedTeam: TeamConfig | undefined
  let pluginLogger: PluginContext['logger'] | undefined
  return {
    manifest: {
      name: 'novel',
      version: '1.0.0',
      description: 'AI 小说创作工作台',
      permissions: [
        'tools.register',
        'routes.register',
        'storage.plugin',
        'ui.contribute',
        'session.create',
        'agent.orchestrate',
        'confirmation.request',
      ],
      builtin: true,
    },

    // 静态数据库迁移：在 setup 之前执行，确保 NovelStore 构造时表已存在
    migrations: novelMigrations,

    async setup(context: PluginContext) {
      pluginLogger = context.logger
      ownedAgentIds = []
      ownedTeam = undefined
      // 1. 初始化服务（迁移已执行，表已存在）
      //    传入 context 供 NovelOrchestrator/NovelCharacterGenerator 调用 createSession API
      //    context.teamManager 由 plugin-loader 注入（teamPlugin 已在 pluginLoaderPlugin 之前注册）
      const services = createNovelServices(context)

      // 1.5 一次性回填：为历史 dimension IS NULL 的记忆事件补 dimension + value_type
      //     幂等——已回填的项目返回 scanned=0，每次启动安全调用。
      //     设计文档第 5 节：打通 recordEvent → listChangeRecords 的过滤陷阱，
      //     让 AI 自动写入的历史事件也能被矩阵账本视图查到。
      try {
        const stats = services.memoryStore.backfillMissingDimensions()
        if (stats.scanned > 0) {
          context.logger.info(
            { scanned: stats.scanned, updated: stats.updated, uninferable: stats.uninferable, backupTable: stats.backupTable },
            '记忆事件 dimension 回填完成',
          )
        }
      } catch (err) {
        context.logger.error({ err }, '记忆事件 dimension 回填失败，不影响主流程')
      }

      // 2. 装饰 Fastify 实例（与原 novel.plugin.ts 保持一致的装饰器名）
      context.registerService('novelStore', services.store)
      context.registerService('promptManager', services.promptManager)
      context.registerService('novelPromptBuilder', services.promptBuilder)
      context.registerService('novelEngine', services.engine)
      context.registerService('novelOrchestrator', services.orchestrator)

      // 3. 注册 Novel Agent 到 AgentManager
      //    使小说 Agent 可通过统一的 subagent / team_execute 工具触发。
      //    字段对齐：temperature / tools / identity / personality 全部填入，
      //    保证 create-team 路径（走 AgentManager + subagent-plugin）与 create-flow 路径
      //    （走 NovelOrchestrator + createAgUiSession）行为一致。
      //
      //    A4 扩展：注入 systemPromptBuilder 和 toolFilter 回调，
      //    使 subagent / team_execute 路径也能调用 NovelPromptBuilder 构建完整三层缓存
      //    系统提示词（世界规则+风格+Agent 身份），并按 Agent 角色过滤工具权限。
      //    - systemPromptBuilder 尝试从 task 文本解析 projectId，命中则构建完整 prompt；
      //      未命中则回退到 config.identity（基础身份提示词）。
      //    - toolFilter 直接返回 config.tools（声明即权限）。
      //    dispatchFn 会在创建 session 前执行这两个回调，覆盖静态 systemPrompt / tools，
      //    createPiSession 中的 buildSystemPrompt 和 customTools 过滤据此拿到最新值。
      const agentManager = context.subagentManager
      if (agentManager) {
        let registeredCount = 0
        for (const [agentType, config] of Object.entries(NOVEL_AGENT_CONFIGS)) {
          // 动态系统提示词构造器：
          // - 尝试从 task 文本解析 projectId（如 "项目: xxx" / "projectId: xxx"）
          // - 命中则调用 promptBuilder.buildSystemPrompt 构建完整三层缓存 prompt
          // - 未命中或构建失败则回退到 config.identity（基础身份）
          const systemPromptBuilder = ({ task }: { task: string; [key: string]: unknown }): string => {
            const projectId = extractProjectId(task)
            if (projectId) {
              try {
                return services.promptBuilder.buildSystemPrompt(projectId, agentType)
              } catch (err) {
                context.logger.warn(
                  { agentId: config.id, agentType, projectId, err },
                  'systemPromptBuilder 构建失败，回退到 identity',
                )
              }
            }
            return config.identity
          }
          // 工具过滤器：返回该 Agent 角色允许使用的工具名列表
          const toolFilter = (): string[] => config.tools

          // 跳过已注册的 Agent（避免重启时重复注册）
          if (agentManager.getAgent(config.id)) {
            // 已注册则同步最新的 temperature（用户在 /agent-config 调整后需立即生效）
            // 同时重新注入 systemPromptBuilder / toolFilter：从持久化加载的 Agent 不含函数字段
            const temperature = getNovelAgentTemperature(agentType as NovelAgentType, services.agentManager)
            agentManager.updateAgent(config.id, { temperature, systemPromptBuilder, toolFilter })
            context.logger.debug({ agentId: config.id, agentType, temperature }, 'Novel Agent 已注册，同步温度与回调')
            continue
          }
          try {
            const temperature = getNovelAgentTemperature(agentType as NovelAgentType, services.agentManager)
            agentManager.registerAgent({
              id: config.id,
              name: config.name,
              description: config.identity,
              systemPrompt: config.identity,  // 兜底：无 builder 时使用
              identity: config.identity,
              tools: config.tools,
              temperature,
              systemPromptBuilder,
              toolFilter,
            })
            ownedAgentIds.push(config.id)
            context.effect(
              'agent.registration',
              { resourceId: config.id, unloadScope: 'immediate' },
              () => () => agentManager.unregisterAgent(config.id),
            )
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
      //    管道式执行：Director → Writer → Reviewer → (Writer 修订) → Memory
      //    与 NovelOrchestrator 的 SSE 流程并存，提供统一的 team_execute 触发方式。
      const teamManager = context.teamManager
      if (teamManager) {
        const existing = teamManager.listTeams().find((t) => t.id === NOVEL_TEAM_ID)
        if (existing) {
          context.logger.debug({ teamId: NOVEL_TEAM_ID }, 'Novel Team 已存在，跳过创建')
        } else {
          try {
            // 使用 registerTeam（仅内存注册）而非 createTeam（持久化）
            // 因为 AgentManager.registerAgent 只注册到内存，createTeam 持久化时外键约束会失败
            const team: TeamConfig = {
              id: NOVEL_TEAM_ID,
              name: '小说创作团队',
              description: '小说多 Agent 创作团队：导演→作家→审稿→(作家修订)→记忆',
              leadAgentId: 'novel-director',
              members: [
                { agentId: 'novel-director', role: 'analyst', roleDescription: '分析故事状态，生成叙事任务' },
                { agentId: 'novel-writer', role: 'writer', roleDescription: '根据叙事任务创作章节正文' },
                { agentId: 'novel-reviewer', role: 'reviewer', roleDescription: '检查章节质量，生成验收报告' },
                { agentId: 'novel-memory', role: 'analyst', roleDescription: '提取状态变更，更新故事记忆' },
              ],
              defaultStrategy: 'pipeline',
              maxParallel: 1,
            }
            teamManager.registerTeam(team)
            ownedTeam = team
            context.effect(
              'team.registration',
              { resourceId: NOVEL_TEAM_ID, unloadScope: 'immediate' },
              () => () => { teamManager.unregisterEphemeralTeam(NOVEL_TEAM_ID, team) },
            )
            context.logger.info({ teamId: NOVEL_TEAM_ID }, 'Novel Team 已注册到 TeamManager')
          } catch (err) {
            context.logger.error({ teamId: NOVEL_TEAM_ID, err }, '注册 Novel Team 失败')
          }
        }
      } else {
        context.logger.warn('teamManager 不可用，跳过 Novel Team 注册')
      }

      // The host consumes this provider for observation only. The disposer is
      // tracked by PluginManager and removes it before the next activation.
      context.registerBackgroundWork('novel-chapter-tasks', {
        listActive: () => Array.from(activeNovelChapterTasks.entries()).map(([lockKey, task]) => ({
          id: lockKey,
          chapterKey: lockKey,
          kind: task.kind,
          flowId: task.flowId,
          startedAt: task.startedAt,
        })),
      })

      // 5. 注册 Pi Session 工具（注入到 customTools）
      // services.tools 为 pi-coding-agent 的 ToolDefinition（由 defineTool 创建），
      // registerSessionTools 现已对齐为接受 pi-coding-agent 的 ToolDefinition[]，
      // 无需类型转换——运行时由 pi-session.ts 的 customTools 统一消费。
      context.registerSessionTools(services.tools)

      // 6. 注册 REST API 路由（路径自动加 /api/plugins/novel 前缀）
      const routes = createNovelRoutes(services)
      for (const route of routes) {
        context.registerRoute(route)
      }

      // 7. 注册前端面板
      context.registerPanel({
        id: 'novel-workspace',
        title: '小说工作台',
        component: 'NovelWorkspace',
        slot: 'workspace.main',
        scope: 'page',
        priority: 10,
        rendererKey: 'novel.workspace',
        entryKey: 'novel',
      })
      context.registerPanel({
        id: 'novel-navigation',
        title: '小说工作台',
        component: 'NovelNavigation',
        slot: 'app.navigation',
        scope: 'app',
        priority: 20,
        rendererKey: 'novel.navigation',
      })
      context.registerPanel({
        id: 'novel-home-showcase',
        title: '小说创作',
        component: 'NovelHomeShowcase',
        slot: 'home.showcase',
        scope: 'app',
        priority: 10,
        rendererKey: 'novel.home-showcase',
      })
      // 插件自己的设置面板：挂在桌面设置中心"插件设置"分区，
      // 群聊模式设置的 UI 归属随领域走，不再寄宿在宿主 Agent 管理页
      context.registerPanel({
        id: 'novel-discussion-settings',
        title: '群聊模式设置',
        component: 'NovelDiscussionSettingsPanel',
        slot: 'plugin-settings',
        scope: 'app',
        priority: 10,
        rendererKey: 'novel.discussion-settings',
      })

      context.logger.info('小说创作系统插件已初始化')
    },
    async teardown() {
      const active = Array.from(activeNovelChapterTasks.values())
      for (const task of active) task.controller.abort()
      if (active.length > 0) {
        const drain = Promise.allSettled(active.map((task) => task.donePromise))
        const drained = await Promise.race([
          drain,
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
        ])
        if (drained === 'timeout') {
          pluginLogger?.warn({ count: active.length }, 'Novel 插件停止时仍有任务未完成 drain')
        }
      }
      ownedAgentIds = []
      ownedTeam = undefined
    },
  }
}

export default createNovelPlugin
