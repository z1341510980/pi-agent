/**
 * Team 协作插件
 *
 * 参考 MULTI_AGENT_DESIGN.md §3，初始化 Team 管理核心组件：
 * - SqliteTeamStore：Team 配置持久化到 SQLite
 * - TeamManager：Team 注册与团队任务执行
 *
 * 通过 fastify.teamManager 暴露给路由和其他插件使用。
 * 必须在 subagentPlugin 之后注册（依赖 app.subagentManager 和 app.db）。
 */

import fp from 'fastify-plugin'
import { TeamManager } from '../core/agent/team-manager.js'
import { SqliteTeamStore } from '../core/agent/team-persistence.js'

export const teamPlugin = fp(async (app) => {
  // 1. 创建 SQLite 持久化存储
  const store = new SqliteTeamStore(app.db)

  // 2. 创建 TeamManager（依赖 AgentManager 和 AgentChannel）
  const manager = new TeamManager(
    app.subagentManager,
    app.subagentManager.getChannel(),
    store,
  )

  // 3. 从数据库加载已持久化的 Team
  manager.loadPersistedTeams()

  // 4. 挂载到 Fastify 实例
  app.decorate('teamManager', manager)

  app.log.info(
    { teamCount: manager.listTeams().length },
    'Team 协作插件已初始化',
  )
})
