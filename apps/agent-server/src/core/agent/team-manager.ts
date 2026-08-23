/**
 * TeamManager：Agent 团队执行引擎
 *
 * 参考 MULTI_AGENT_DESIGN.md §3.5，实现：
 * - Team CRUD（注册 + 持久化）
 * - 核心执行：sequential / parallel / pipeline 三种策略
 * - 与 ConcurrencyLimiter 协调（避免双重限流死等）
 * - Team Lead 汇总结果
 *
 * TeamManager 内部通过 AgentManager.dispatchToAgent() 执行每个成员任务，
 * 不重复造轮子。ConcurrencyLimiter 在 Team 层面表现为 maxParallel 参数。
 */

import { randomUUID } from 'node:crypto'
import { AppError, ErrorCode } from '@repo/shared/errors'
import type {
  TeamConfig,
  TeamResult,
  TeamMemberResult,
  ExecutionStrategy,
  TeamExecution,
} from '@repo/shared/agent'
import type { AgentManager, SubagentProgress } from './subagent-tool.js'
import type { AgentChannel } from './agent-channel.js'
import type { TeamPersistenceStore } from './team-persistence.js'

/** 任务分配（单个成员的子任务） */
export interface TeamAssignment {
  agentId: string
  subtask: string
  role?: string
}

/** 执行计划 */
export interface ExecutionPlan {
  assignments: TeamAssignment[]
  timeoutPerMember?: number
}

/** Team 执行选项 */
export interface TeamExecuteOptions {
  /** 显式指定成员分配（不指定则使用 Team 配置中的成员） */
  members?: Array<{
    agentId: string
    role?: string
    subtask: string
  }>
  /** 执行策略（不指定则使用 Team 默认策略） */
  strategy?: ExecutionStrategy
  /** 整个团队任务的总超时毫秒数 */
  timeoutMs?: number
  /** 取消信号 */
  signal?: AbortSignal
  /** 流式进度回调 */
  onProgress?: (progress: SubagentProgress) => void
}

/**
 * TeamManager：管理 Team 注册与团队任务执行
 *
 * 关键不变量：
 * 1. 每个 Team ID 唯一，重复注册会覆盖
 * 2. execute 通过 AgentManager.dispatchToAgent 执行成员任务
 * 3. parallel 策略与 ConcurrencyLimiter 协调，取 min(maxParallel, availableSlots)
 * 4. pipeline 策略中前一个成员的输出作为后一个的输入
 */
export class TeamManager {
  private readonly teams = new Map<string, TeamConfig>()
  private readonly activeExecutions = new Map<string, TeamExecution>()

  constructor(
    private readonly agentManager: AgentManager,
    private readonly channel: AgentChannel,
    private readonly store?: TeamPersistenceStore,
  ) {}

  // ─── Team CRUD ───

  /** 从持久化存储加载所有 Team */
  loadPersistedTeams(): void {
    if (!this.store) return
    const teams = this.store.loadAll()
    for (const team of teams) {
      this.teams.set(team.id, team)
    }
  }

  /** 注册 Team（仅内存） */
  registerTeam(config: TeamConfig): void {
    this.teams.set(config.id, config)
  }

  /** 创建 Team（注册 + 持久化） */
  async createTeam(config: TeamConfig): Promise<TeamConfig> {
    // 验证 leadAgentId 存在
    if (!this.agentManager.getAgent(config.leadAgentId)) {
      throw new AppError(
        ErrorCode.CONFIG_ERROR,
        `Team Lead Agent 不存在: ${config.leadAgentId}`,
        400,
      )
    }
    // 验证所有成员 Agent 存在
    for (const member of config.members) {
      if (!this.agentManager.getAgent(member.agentId)) {
        throw new AppError(
          ErrorCode.CONFIG_ERROR,
          `Team 成员 Agent 不存在: ${member.agentId}`,
          400,
        )
      }
    }
    this.teams.set(config.id, config)
    this.store?.save(config)
    return config
  }

  /** 更新 Team 配置 */
  async updateTeam(id: string, patch: Partial<TeamConfig>): Promise<TeamConfig> {
    const existing = this.teams.get(id)
    if (!existing) {
      throw new AppError(ErrorCode.NOT_FOUND, `Team 不存在: ${id}`, 404)
    }
    const updated = { ...existing, ...patch, id }
    this.teams.set(id, updated)
    this.store?.save(updated)
    return updated
  }

  /** 删除 Team */
  async deleteTeam(id: string): Promise<void> {
    this.teams.delete(id)
    this.store?.delete(id)
  }

  /**
   * Remove a plugin-owned in-memory team without touching persistence.
   * The expected object check prevents a later activation from removing a
   * replacement team that happens to reuse the same id.
   */
  unregisterEphemeralTeam(id: string, expected?: TeamConfig): boolean {
    const current = this.teams.get(id)
    if (!current || (expected && current !== expected)) return false
    this.teams.delete(id)
    return true
  }

  /** 获取 Team 配置 */
  getTeam(id: string): TeamConfig | undefined {
    return this.teams.get(id)
  }

  /** 列出所有 Team */
  listTeams(): TeamConfig[] {
    return Array.from(this.teams.values())
  }

  /** 获取活跃执行 */
  getActiveExecutions(): TeamExecution[] {
    return Array.from(this.activeExecutions.values())
  }

  /** 获取单次执行详情 */
  getExecution(executionId: string): TeamExecution | undefined {
    return this.activeExecutions.get(executionId)
  }

  // ─── 核心执行 ───

  /**
   * 执行 Team 任务
   *
   * 流程：
   * 1. 创建 Team 专属频道
   * 2. 构建执行计划（显式分配或使用 Team 默认成员）
   * 3. 根据策略执行（sequential/parallel/pipeline）
   * 4. Team Lead 汇总结果
   * 5. 清理频道
   */
  async execute(
    teamId: string,
    task: string,
    options: TeamExecuteOptions = {},
  ): Promise<TeamResult> {
    const team = this.teams.get(teamId)
    if (!team) {
      throw new AppError(ErrorCode.NOT_FOUND, `Team 不存在: ${teamId}`, 404)
    }

    const executionId = randomUUID()
    const startedAt = Date.now()
    const strategy = options.strategy ?? team.defaultStrategy

    // 记录执行状态
    const execution: TeamExecution = {
      executionId,
      teamId,
      task,
      strategy,
      phase: 'planning',
      memberResults: {},
      startedAt,
    }
    this.activeExecutions.set(executionId, execution)

    // 1. 创建 Team 专属频道（用于成员间通信）
    const teamChannel = `team:${teamId}:${executionId}`
    for (const member of team.members) {
      this.channel.subscribe(teamChannel, member.agentId)
    }

    try {
      // 2. 构建执行计划
      const plan = this.buildExecutionPlan(team, task, options)
      execution.phase = 'executing'

      // 3. 根据策略执行
      let memberResults: Record<string, TeamMemberResult>
      switch (strategy) {
        case 'parallel':
          memberResults = await this.executeParallel(team, plan, teamChannel, options)
          break
        case 'sequential':
          memberResults = await this.executeSequential(team, plan, teamChannel, options)
          break
        case 'pipeline':
          memberResults = await this.executePipeline(team, plan, teamChannel, options)
          break
        case 'coordinated':
          memberResults = await this.executeCoordinated(team, plan, teamChannel, options)
          break
        default:
          memberResults = await this.executeParallel(team, plan, teamChannel, options)
      }

      execution.memberResults = memberResults

      // 4. Summarizing 阶段：Team Lead 汇总
      execution.phase = 'summarizing'
      const summary = await this.summarizeResults(team, task, memberResults, options)
      execution.summary = summary
      execution.phase = 'completed'
      execution.finishedAt = Date.now()

      const allSuccess = Object.values(memberResults).every((r) => r.success)

      return {
        executionId,
        teamId,
        task,
        success: allSuccess,
        memberResults,
        summary,
        durationMs: Date.now() - startedAt,
      }
    } catch (error) {
      execution.phase = 'failed'
      execution.finishedAt = Date.now()
      execution.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      // 5. 清理频道订阅
      for (const member of team.members) {
        this.channel.unsubscribe(teamChannel, member.agentId)
      }
    }
  }

  // ─── 内部方法 ───

  /** 构建执行计划 */
  private buildExecutionPlan(
    team: TeamConfig,
    task: string,
    options: TeamExecuteOptions,
  ): ExecutionPlan {
    // 如果显式指定了成员分配，使用它
    if (options.members && options.members.length > 0) {
      return {
        assignments: options.members.map((m) => ({
          agentId: m.agentId,
          subtask: m.subtask,
          role: m.role,
        })),
        timeoutPerMember: options.timeoutMs ? Math.floor(options.timeoutMs / options.members.length) : undefined,
      }
    }

    // 否则使用 Team 配置中的成员，将总任务分配给每个成员
    const assignments: TeamAssignment[] = team.members.map((member) => ({
      agentId: member.agentId,
      subtask: task,
      role: member.roleDescription ?? member.role,
    }))

    return {
      assignments,
      timeoutPerMember: options.timeoutMs ? Math.floor(options.timeoutMs / Math.max(assignments.length, 1)) : undefined,
    }
  }

  /** 并行执行 */
  private async executeParallel(
    team: TeamConfig,
    plan: ExecutionPlan,
    teamChannel: string,
    options: TeamExecuteOptions,
  ): Promise<Record<string, TeamMemberResult>> {
    const results: Record<string, TeamMemberResult> = {}

    // 向 ConcurrencyLimiter 查询剩余可用槽位，避免双重限流死等
    const limiter = this.agentManager.getLimiter()
    const availableSlots = limiter.getAvailableSlots()
    const effectiveBatchSize = Math.max(1, Math.min(team.maxParallel, availableSlots))
    const batches = this.chunkArray(plan.assignments, effectiveBatchSize)

    options.onProgress?.({
      text: `并行执行：${plan.assignments.length} 个成员，分 ${batches.length} 批，每批 ${effectiveBatchSize} 个`,
      phase: 'output',
    })

    for (const batch of batches) {
      // 检查取消信号
      if (options.signal?.aborted) {
        throw new Error('团队任务已被取消')
      }

      const batchPromises = batch.map(async (assignment) => {
        const startedAt = Date.now()
        const result = await this.agentManager.dispatchToAgent(
          assignment.agentId,
          assignment.subtask,
          {
            timeoutMs: plan.timeoutPerMember,
            signal: options.signal,
            onProgress: options.onProgress,
          },
        )

        const memberResult: TeamMemberResult = {
          agentId: assignment.agentId,
          result: result.result,
          success: result.success,
          error: result.error,
          durationMs: result.durationMs,
        }

        // 通过 Team 频道广播进展
        this.channel.broadcast(teamChannel, assignment.agentId, {
          type: 'member_result',
          agentId: assignment.agentId,
          success: result.success,
        })

        return { agentId: assignment.agentId, result: memberResult }
      })

      const batchResults = await Promise.all(batchPromises)
      for (const { agentId, result } of batchResults) {
        results[agentId] = result
      }
    }

    return results
  }

  /** 串行执行 */
  private async executeSequential(
    team: TeamConfig,
    plan: ExecutionPlan,
    teamChannel: string,
    options: TeamExecuteOptions,
  ): Promise<Record<string, TeamMemberResult>> {
    const results: Record<string, TeamMemberResult> = {}

    options.onProgress?.({
      text: `串行执行：${plan.assignments.length} 个成员`,
      phase: 'output',
    })

    for (const assignment of plan.assignments) {
      // 检查取消信号
      if (options.signal?.aborted) {
        throw new Error('团队任务已被取消')
      }

      const startedAt = Date.now()
      const result = await this.agentManager.dispatchToAgent(
        assignment.agentId,
        assignment.subtask,
        {
          timeoutMs: plan.timeoutPerMember,
          signal: options.signal,
          onProgress: options.onProgress,
        },
      )

      results[assignment.agentId] = {
        agentId: assignment.agentId,
        result: result.result,
        success: result.success,
        error: result.error,
        durationMs: result.durationMs,
      }

      // 通过 Team 频道广播进展
      this.channel.broadcast(teamChannel, assignment.agentId, {
        type: 'member_result',
        agentId: assignment.agentId,
        success: result.success,
      })

      // 串行模式下，如果某成员失败，继续执行后续成员（不中断）
      if (!result.success) {
        options.onProgress?.({
          text: `成员 ${assignment.agentId} 执行失败: ${result.error ?? '未知错误'}，继续执行下一个`,
          phase: 'output',
        })
      }
    }

    return results
  }

  /** 管道执行：前一个的输出是后一个的输入 */
  private async executePipeline(
    team: TeamConfig,
    plan: ExecutionPlan,
    teamChannel: string,
    options: TeamExecuteOptions,
  ): Promise<Record<string, TeamMemberResult>> {
    const results: Record<string, TeamMemberResult> = {}

    options.onProgress?.({
      text: `管道执行：${plan.assignments.length} 个阶段`,
      phase: 'output',
    })

    let pipelineInput = plan.assignments[0]?.subtask ?? ''

    for (let i = 0; i < plan.assignments.length; i++) {
      const assignment = plan.assignments[i]

      // 检查取消信号
      if (options.signal?.aborted) {
        throw new Error('团队任务已被取消')
      }

      options.onProgress?.({
        text: `管道阶段 ${i + 1}/${plan.assignments.length}：${assignment.agentId}`,
        phase: 'output',
      })

      const result = await this.agentManager.dispatchToAgent(
        assignment.agentId,
        pipelineInput,
        {
          timeoutMs: plan.timeoutPerMember,
          signal: options.signal,
          onProgress: options.onProgress,
        },
      )

      results[assignment.agentId] = {
        agentId: assignment.agentId,
        result: result.result,
        success: result.success,
        error: result.error,
        durationMs: result.durationMs,
      }

      // 通过 Team 频道广播进展
      this.channel.broadcast(teamChannel, assignment.agentId, {
        type: 'member_result',
        agentId: assignment.agentId,
        success: result.success,
        pipelineStage: i,
      })

      // 管道模式下，如果某阶段失败，中止后续阶段
      if (!result.success) {
        options.onProgress?.({
          text: `管道阶段 ${i + 1} 失败: ${result.error ?? '未知错误'}，中止后续阶段`,
          phase: 'output',
        })
        // 为剩余阶段填充失败结果
        for (let j = i + 1; j < plan.assignments.length; j++) {
          const remaining = plan.assignments[j]
          results[remaining.agentId] = {
            agentId: remaining.agentId,
            result: '',
            success: false,
            error: `管道上游阶段 ${i + 1} 失败，已跳过`,
            durationMs: 0,
          }
        }
        break
      }

      // 前一个的输出作为后一个的输入（限制大小避免上下文膨胀）
      const MAX_PIPELINE_INPUT = 50_000
      pipelineInput = result.result.length > MAX_PIPELINE_INPUT
        ? result.result.slice(0, MAX_PIPELINE_INPUT) + '\n...[输出已截断]'
        : result.result
    }

    return results
  }

  /**
   * 协调执行：串行执行，每个成员接收原始任务 + 前序成员的结果摘要
   *
   * 与 pipeline 的区别：pipeline 只传上一个阶段的输出，
   * coordinated 传入所有前序成员的结果（附带上下文），让成员能感知全局进展。
   */
  private async executeCoordinated(
    team: TeamConfig,
    plan: ExecutionPlan,
    teamChannel: string,
    options: TeamExecuteOptions,
  ): Promise<Record<string, TeamMemberResult>> {
    const results: Record<string, TeamMemberResult> = {}
    /** 前序成员结果摘要（限制数量避免上下文膨胀） */
    const priorContext: string[] = []

    options.onProgress?.({
      text: `协调执行：${plan.assignments.length} 个成员`,
      phase: 'output',
    })

    for (let i = 0; i < plan.assignments.length; i++) {
      const assignment = plan.assignments[i]

      if (options.signal?.aborted) {
        throw new Error('团队任务已被取消')
      }

      // 构建包含前序上下文的任务描述
      let coordinatedTask = assignment.subtask
      if (priorContext.length > 0) {
        const contextBlock = priorContext.join('\n\n')
        coordinatedTask = `${assignment.subtask}\n\n## 前序成员工作结果\n以下是你之前的团队成员已完成的工作，请参考并协调你的工作：\n\n${contextBlock}`
      }

      options.onProgress?.({
        text: `协调阶段 ${i + 1}/${plan.assignments.length}：${assignment.agentId}`,
        phase: 'output',
      })

      const startedAt = Date.now()
      const result = await this.agentManager.dispatchToAgent(
        assignment.agentId,
        coordinatedTask,
        {
          timeoutMs: plan.timeoutPerMember,
          signal: options.signal,
          onProgress: options.onProgress,
        },
      )

      results[assignment.agentId] = {
        agentId: assignment.agentId,
        result: result.result,
        success: result.success,
        error: result.error,
        durationMs: result.durationMs,
      }

      // 通过 Team 频道广播进展
      this.channel.broadcast(teamChannel, assignment.agentId, {
        type: 'member_result',
        agentId: assignment.agentId,
        success: result.success,
        coordinatedStage: i,
      })

      if (!result.success) {
        options.onProgress?.({
          text: `成员 ${assignment.agentId} 执行失败: ${result.error ?? '未知错误'}，继续执行下一个`,
          phase: 'output',
        })
      }

      // 将结果摘要加入前序上下文（限制大小和数量）
      if (result.success && result.result) {
        const MAX_CONTEXT_ENTRY = 5_000
        const summary = result.result.length > MAX_CONTEXT_ENTRY
          ? result.result.slice(0, MAX_CONTEXT_ENTRY) + '\n...[结果已截断]'
          : result.result
        priorContext.push(`### ${assignment.agentId} 的结果\n${summary}`)
        // 最多保留最近5条上下文，避免上下文膨胀
        if (priorContext.length > 5) {
          priorContext.shift()
        }
      }
    }

    return results
  }

  /** Team Lead 汇总结果 */
  private async summarizeResults(
    team: TeamConfig,
    task: string,
    memberResults: Record<string, TeamMemberResult>,
    options: TeamExecuteOptions,
  ): Promise<string> {
    // 构建汇总请求
    const resultSummaries = Object.entries(memberResults)
      .map(([agentId, result]) => {
        const status = result.success ? '成功' : '失败'
        const output = result.success ? result.result : (result.error ?? '未知错误')
        return `### ${agentId}（${status}）\n${output}`
      })
      .join('\n\n')

    const summaryTask = [
      '你是 Team Lead，请汇总以下团队成员的执行结果。',
      '',
      '## 原始任务',
      task,
      '',
      '## 成员执行结果',
      resultSummaries,
      '',
      '请提供一份简洁的汇总报告，包括：',
      '1. 整体完成情况',
      '2. 各成员的关键产出',
      '3. 如有失败，说明影响和建议',
    ].join('\n')

    try {
      const result = await this.agentManager.dispatchToAgent(
        team.leadAgentId,
        summaryTask,
        {
          timeoutMs: options.timeoutMs ? Math.min(options.timeoutMs, 120000) : 120000,
          signal: options.signal,
        },
      )

      if (result.success) {
        return result.result
      }
      // 汇总失败时，返回简单的拼接结果
      return `团队执行完成（汇总失败: ${result.error}）。\n\n${resultSummaries}`
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return `团队执行完成（汇总异常: ${errorMsg}）。\n\n${resultSummaries}`
    }
  }

  /** 将数组分成指定大小的批次 */
  private chunkArray<T>(arr: T[], size: number): T[][] {
    if (size <= 0) return [arr]
    const chunks: T[][] = []
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size))
    }
    return chunks
  }
}
