/**
 * Agent Team 数据模型
 *
 * 定义 Team 配置、成员、执行策略等共享类型。
 * 参考 MULTI_AGENT_DESIGN.md §3.2。
 */

/** 执行策略 */
export type ExecutionStrategy =
  | 'sequential'  // 串行：按顺序执行
  | 'parallel'    // 并行：同时执行
  | 'pipeline'    // 管道：前一个的输出是后一个的输入
  | 'coordinated' // 协调：由 Team Lead 动态决策（当前阶段未实现）

/** Team 成员角色 */
export type TeamMemberRole =
  | 'researcher'
  | 'coder'
  | 'reviewer'
  | 'tester'
  | 'writer'
  | 'analyst'
  | 'custom'

/** Team 成员配置 */
export interface TeamMemberConfig {
  /** 引用的 Agent ID（必须已注册的 Agent） */
  agentId: string
  /** 在 Team 中的角色 */
  role: TeamMemberRole
  /** 自定义角色描述 */
  roleDescription?: string
  /** 排序序号（用于 sequential/pipeline 策略） */
  sortOrder?: number
}

/** Team 配置 */
export interface TeamConfig {
  /** Team ID */
  id: string
  /** Team 名称 */
  name: string
  /** Team 描述 */
  description: string
  /** Team Lead 的 Agent ID（必须已注册的 Agent） */
  leadAgentId: string
  /** Team 成员配置 */
  members: TeamMemberConfig[]
  /** 默认执行策略 */
  defaultStrategy: ExecutionStrategy
  /** 最大并发成员数 */
  maxParallel: number
}

/** Team 执行阶段 */
export type TeamExecutionPhase =
  | 'planning'
  | 'executing'
  | 'summarizing'
  | 'completed'
  | 'failed'

/** Team 成员执行结果（复用 SubagentResult 的子集） */
export interface TeamMemberResult {
  /** 成员 Agent ID */
  agentId: string
  /** 执行结果文本 */
  result: string
  /** 是否成功 */
  success: boolean
  /** 错误信息（失败时） */
  error?: string
  /** 执行耗时（毫秒） */
  durationMs: number
}

/** Team 执行状态 */
export interface TeamExecution {
  /** 执行 ID */
  executionId: string
  /** Team ID */
  teamId: string
  /** 初始任务描述 */
  task: string
  /** 执行策略 */
  strategy: ExecutionStrategy
  /** 当前阶段 */
  phase: TeamExecutionPhase
  /** 成员执行结果（使用 Record 而非 Map，确保 JSON 序列化正确） */
  memberResults: Record<string, TeamMemberResult>
  /** 开始时间 */
  startedAt: number
  /** 结束时间（完成或失败后） */
  finishedAt?: number
  /** 汇总结果 */
  summary?: string
  /** 错误信息（失败时） */
  error?: string
}

/** Team 执行最终结果 */
export interface TeamResult {
  /** 执行 ID */
  executionId: string
  /** Team ID */
  teamId: string
  /** 初始任务描述 */
  task: string
  /** 是否全部成功 */
  success: boolean
  /** 成员执行结果 */
  memberResults: Record<string, TeamMemberResult>
  /** 汇总结果文本 */
  summary: string
  /** 执行耗时（毫秒） */
  durationMs: number
}
