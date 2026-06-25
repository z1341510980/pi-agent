/**
 * 小说多 Agent 编排系统 - Agent 配置定义
 *
 * 定义 5 个 Agent 的身份、工具和角色模板：
 * - director：分析故事状态，规划章节叙事任务
 * - writer：根据叙事任务和约束创作章节正文
 * - reviewer：检查章节的一致性、节奏和可读性
 * - reviser：根据审稿问题重写章节局部内容
 * - memory：从章节中提取状态变更并更新故事状态系统
 *
 * 创作流程：Director → Writer → Reviewer → (Reviser) → Memory
 * 检查点：narrative_task（叙事任务确认）、review（验收报告确认）
 */

/** Agent 类型 */
export type NovelAgentType = 'director' | 'writer' | 'reviewer' | 'reviser' | 'memory'

/** Agent 配置 */
export interface NovelAgentConfig {
  type: NovelAgentType
  id: string
  name: string
  identity: string
  tools: string[]
  roleTemplate: string
}

export const NOVEL_AGENT_CONFIGS: Record<NovelAgentType, NovelAgentConfig> = {
  director: {
    type: 'director',
    id: 'novel-director',
    name: '导演 Agent',
    identity: '你是一个专业的小说导演，负责分析故事状态并规划章节叙事任务。',
    tools: ['novel_query_state'],
    roleTemplate: 'role-director',
  },
  writer: {
    type: 'writer',
    id: 'novel-writer',
    name: '写作 Agent',
    identity: '你是一个专业的小说作家，根据叙事任务和约束创作章节正文。',
    tools: ['novel_query_state'],
    roleTemplate: 'role-writer',
  },
  reviewer: {
    type: 'reviewer',
    id: 'novel-reviewer',
    name: '审稿 Agent',
    identity: '你是一个严格的审稿编辑，检查章节的一致性、节奏和可读性。',
    tools: ['novel_query_state'],
    roleTemplate: 'role-reviewer',
  },
  reviser: {
    type: 'reviser',
    id: 'novel-reviser',
    name: '修订 Agent',
    identity: '你是一个修订专家，根据审稿问题重写章节局部内容。',
    tools: ['novel_query_state'],
    roleTemplate: 'role-reviser',
  },
  memory: {
    type: 'memory',
    id: 'novel-memory',
    name: '记忆 Agent',
    identity: '你是一个记忆管理 Agent，负责从章节中提取状态变更并更新故事状态系统。',
    tools: ['novel_query_state', 'novel_update_character', 'novel_update_foreshadow', 'novel_update_conflict', 'novel_update_clue', 'novel_update_relationship'],
    roleTemplate: 'role-memory',
  },
}

export type CreationPhase = 'idle' | 'directing' | 'checkpoint_narrative' | 'writing' | 'reviewing' | 'checkpoint_review' | 'revising' | 'rewriting' | 'memory' | 'completed' | 'cancelled' | 'error'

export type CheckpointType = 'narrative_task' | 'review'

export interface CheckpointData {
  type: CheckpointType
  phase: CreationPhase
  data: unknown
  decision?: 'approve' | 'reject' | 'revise' | 'rewrite'
}

export interface CreationFlowEvent {
  type: 'phase_change' | 'agent_event' | 'checkpoint' | 'error' | 'completed' | 'cancelled'
  phase: CreationPhase
  data?: unknown
  timestamp: number
}
