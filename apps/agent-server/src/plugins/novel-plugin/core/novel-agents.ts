/**
 * 小说多 Agent 编排系统 - Agent 配置定义
 *
 * 定义 4 个 Agent 的身份、工具和角色模板：
 * - director：分析故事状态，规划章节叙事任务
 * - writer：根据叙事任务创作章节正文，并在审稿后根据意见修订局部内容
 * - reviewer：检查章节的一致性、节奏和可读性
 * - memory：从章节中提取状态变更并更新故事状态系统
 *
 * 创作流程：Director → Writer → Reviewer → (Writer 修订) → Memory
 * 检查点：narrative_task（叙事任务确认）、review（验收报告确认）
 */

/** Agent 类型 */
export type NovelAgentType = 'director' | 'writer' | 'reviewer' | 'memory'

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
    tools: ['novel_query_state', 'novel_query_factions', 'novel_query_locations'],
    roleTemplate: 'role-director',
  },
  writer: {
    type: 'writer',
    id: 'novel-writer',
    name: '写作 Agent',
    identity: '你是一个专业的小说作家，根据叙事任务和约束创作章节正文。审稿后可根据意见修订局部内容。',
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
  memory: {
    type: 'memory',
    id: 'novel-memory',
    name: '记忆 Agent',
    identity: '你是一个记忆管理 Agent，负责从章节中提取状态变更并更新故事状态系统。',
    tools: [
      'novel_query_state',
      'novel_update_character', 'novel_update_foreshadow', 'novel_update_conflict', 'novel_update_clue', 'novel_update_relationship',
      'novel_create_character', 'novel_create_foreshadow', 'novel_create_conflict', 'novel_create_clue',
      // 势力/地点/世界观要素工具
      'novel_query_factions', 'novel_create_faction', 'novel_update_faction',
      'novel_query_locations', 'novel_create_location', 'novel_update_location',
      'novel_create_world_element', 'novel_update_world_element',
    ],
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
  type: 'phase_change' | 'agent_output' | 'checkpoint' | 'error' | 'completed' | 'cancelled'
  phase: CreationPhase
  data?: unknown
  timestamp: number
}

/** Agent 输出事件数据 */
export interface AgentOutputData {
  /** Agent 类型 */
  agentType: 'director' | 'writer' | 'reviewer' | 'reviser' | 'memory'
  /** Agent 名称（中文） */
  agentName: string
  /** Agent 的完整输出文本 */
  content: string
  /** 输出预览（前 500 字符，供 UI 折叠展示） */
  preview: string
  /** 标记为数据变更通知（Memory Agent 写入完成后推送，前端据此刷新画布，不展示在时间线） */
  dataChanged?: boolean
}
