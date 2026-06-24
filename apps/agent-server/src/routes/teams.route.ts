/**
 * Team 协作 API 路由
 *
 * 端点：
 * - GET    /api/teams                — 列出所有 Team
 * - POST   /api/teams                — 创建 Team（持久化到 SQLite）
 * - GET    /api/teams/:id            — 获取 Team 详情
 * - PUT    /api/teams/:id            — 更新 Team 配置
 * - DELETE /api/teams/:id            — 删除 Team
 * - POST   /api/teams/:id/execute    — 执行 Team 任务
 * - GET    /api/teams/executions     — 获取所有活跃执行
 * - GET    /api/teams/executions/:eid — 获取单次执行详情
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { success } from '../lib/api-response.js'
import { validateBody } from '../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

export const teamsRoute: FastifyPluginAsync = async (app) => {
  const manager = app.teamManager

  /**
   * GET /api/teams
   * 列出所有 Team
   */
  app.get('/api/teams', async (req) => {
    const teams = manager.listTeams()
    return success(teams, req.traceId)
  })

  /**
   * POST /api/teams
   * 创建 Team（持久化到 SQLite）
   */
  const memberSchema = z.object({
    agentId: z.string().min(1).max(64),
    role: z.enum(['researcher', 'coder', 'reviewer', 'tester', 'writer', 'analyst', 'custom']),
    roleDescription: z.string().max(500).optional(),
    sortOrder: z.number().int().min(0).optional(),
  })

  const createTeamSchema = z.object({
    id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/).describe('Team ID'),
    name: z.string().min(1).max(128).describe('Team 名称'),
    description: z.string().max(1000).default('').describe('Team 描述'),
    leadAgentId: z.string().min(1).max(64).describe('Team Lead 的 Agent ID'),
    members: z.array(memberSchema).min(1).describe('Team 成员列表'),
    defaultStrategy: z.enum(['sequential', 'parallel', 'pipeline', 'coordinated']).default('parallel'),
    maxParallel: z.number().int().min(1).max(20).default(2),
  })

  app.post('/api/teams', async (req, reply) => {
    const input = validateBody(createTeamSchema, req, reply)
    if (!input) return reply

    // 检查 ID 是否已存在
    if (manager.getTeam(input.id)) {
      throw new AppError(ErrorCode.CONFLICT, `Team ID 已存在: ${input.id}`, 409)
    }

    const team = await manager.createTeam(input)
    return success(team, req.traceId)
  })

  /**
   * GET /api/teams/executions
   * 获取所有活跃执行
   */
  app.get('/api/teams/executions', async (req) => {
    const executions = manager.getActiveExecutions()
    return success(executions, req.traceId)
  })

  /**
   * GET /api/teams/executions/:eid
   * 获取单次执行详情
   */
  app.get<{ Params: { eid: string } }>(
    '/api/teams/executions/:eid',
    async (req) => {
      const execution = manager.getExecution(req.params.eid)
      if (!execution) {
        throw new AppError(ErrorCode.NOT_FOUND, `执行不存在: ${req.params.eid}`, 404)
      }
      return success(execution, req.traceId)
    },
  )

  /**
   * GET /api/teams/:id
   * 获取 Team 详情
   */
  app.get<{ Params: { id: string } }>(
    '/api/teams/:id',
    async (req) => {
      const team = manager.getTeam(req.params.id)
      if (!team) {
        throw new AppError(ErrorCode.NOT_FOUND, `Team 不存在: ${req.params.id}`, 404)
      }
      return success(team, req.traceId)
    },
  )

  /**
   * PUT /api/teams/:id
   * 更新 Team 配置
   */
  const updateTeamSchema = createTeamSchema.partial()

  app.put<{ Params: { id: string } }>(
    '/api/teams/:id',
    async (req, reply) => {
      const input = validateBody(updateTeamSchema, req, reply)
      if (!input) return reply

      const teamId = req.params.id
      if (!manager.getTeam(teamId)) {
        throw new AppError(ErrorCode.NOT_FOUND, `Team 不存在: ${teamId}`, 404)
      }

      const updated = await manager.updateTeam(teamId, input)
      return success(updated, req.traceId)
    },
  )

  /**
   * DELETE /api/teams/:id
   * 删除 Team
   */
  app.delete<{ Params: { id: string } }>(
    '/api/teams/:id',
    async (req) => {
      const teamId = req.params.id
      if (!manager.getTeam(teamId)) {
        throw new AppError(ErrorCode.NOT_FOUND, `Team 不存在: ${teamId}`, 404)
      }

      await manager.deleteTeam(teamId)
      return success({ id: teamId, deleted: true }, req.traceId)
    },
  )

  /**
   * POST /api/teams/:id/execute
   * 执行 Team 任务
   *
   * Body: { task, members?, strategy?, timeout? }
   */
  const executeTeamSchema = z.object({
    task: z.string().min(1).describe('团队要执行的总任务描述'),
    members: z.array(z.object({
      agentId: z.string().min(1),
      role: z.string().optional(),
      subtask: z.string().min(1),
    })).optional().describe('显式指定成员分配'),
    strategy: z.enum(['sequential', 'parallel', 'pipeline']).optional().describe('执行策略'),
    timeout: z.number().min(1000).max(600000).optional().describe('总超时毫秒数'),
  })

  app.post<{ Params: { id: string } }>(
    '/api/teams/:id/execute',
    async (req, reply) => {
      const input = validateBody(executeTeamSchema, req, reply)
      if (!input) return reply

      const teamId = req.params.id
      if (!manager.getTeam(teamId)) {
        throw new AppError(ErrorCode.NOT_FOUND, `Team 不存在: ${teamId}`, 404)
      }

      const result = await manager.execute(teamId, input.task, {
        members: input.members,
        strategy: input.strategy,
        timeoutMs: input.timeout,
      })
      return success(result, req.traceId)
    },
  )
}
