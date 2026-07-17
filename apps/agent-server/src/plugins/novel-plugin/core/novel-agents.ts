/**
 * 小说多 Agent 编排系统 - Agent 配置定义
 *
 * 定义 5 个 Agent 的身份、工具和角色模板：
 * - director：分析故事状态，规划章节叙事任务
 * - writer：根据叙事任务创作章节正文
 * - reviser：根据审稿意见修订章节局部内容（最小改动原则）
 * - reviewer：检查章节的一致性、节奏和可读性
 * - memory：从章节中提取状态变更并更新故事状态系统
 *
 * 创作流程：Director → Writer → Reviewer → (Reviser 修订) → Memory
 * 检查点：narrative_task（叙事任务确认）、review（验收报告确认）
 */

/** Agent 类型 */
export type NovelAgentType = 'director' | 'writer' | 'reviser' | 'reviewer' | 'memory'

/** Agent 配置 */
export interface NovelAgentConfig {
  type: NovelAgentType
  id: string
  name: string
  identity: string
  tools: string[]
  roleTemplate: string
  temperature: number
}

export const NOVEL_AGENT_CONFIGS: Record<NovelAgentType, NovelAgentConfig> = {
  director: {
    type: 'director',
    id: 'novel-director',
    name: '导演 Agent',
    identity: '你是一个专业的小说导演，负责分析故事状态并规划章节叙事任务。',
    // ⚠️ Token 优化：Director 无需 query 工具。所有实体信息已通过 SEMI 层
    // chapterContext 一次性注入：
    //   - formatStoryState 输出所有角色动态状态、活跃冲突、伏笔、势力、地点
    //   - formatArrangedEntities 注入本章出场角色完整定义
    //   - formatEntityArchive 注入势力/地点/世界要素静态档案
    //   - formatInfoLayers 注入信息差
    //   - formatConstraints 注入创作约束
    //   - formatEdges 注入实体关联（画布连线）
    //   - formatRecentSummaries 注入最近章节摘要
    //   - formatRecentCausalChain 注入因果链
    // 给 Director 提供 query 工具反而会让 LLM 在规划前先调用工具重复查询已知
    // 状态，每次工具调用都会把完整对话历史重发，3 次工具调用 = 3 倍 system_prompt
    // + chapter_context 的 token 消耗。移除工具后 Director 单次调用完成，
    // 省 ~18K tokens。
    // A+B：给 Director 开放语义化查询工具 novel_ask_story，用于在规划前按需获取关键信息。
    // 不开放全量 query 工具，避免 token 爆炸和无效工具循环。
    tools: ['novel_ask_story'],
    roleTemplate: 'role-director',
    temperature: 0.5,
  },
  writer: {
    type: 'writer',
    id: 'novel-writer',
    name: '写作 Agent',
    identity: '你是一个专业的小说作家，根据叙事任务和约束创作章节正文。',
    // ⚠️ Token 优化：Writer 无需工具：状态已通过 SEMI 层 chapterContext 注入：
    //   - formatStoryState 输出所有角色动态状态、活跃冲突、伏笔、势力、地点
    //   - formatArrangedEntities 注入本章出场角色完整定义
    //   - formatInfoLayers 注入信息差
    //   - formatConstraints 注入创作约束
    //   - formatEdges 注入实体关联（画布连线）
    //
    // 给 Writer 提供 novel_query_state 反而会让 LLM 在生成正文前先调用工具
    // 重复查询已知状态，工具返回的 JSON（listCharacters 全表）会让上下文
    // 进一步膨胀，最终导致首 token 时间 = LLM 处理(原 prompt) + 工具调用 +
    // LLM 处理(原 prompt + 工具结果) + 生成正文，超过 300s 超时。
    //
    // tools=[] 让 LLM 直接基于 SEMI 层注入的状态生成正文，无工具循环。
    // 配合 pi-session.ts 的过滤逻辑（tools=[] 清空 customTools）确保
    // Writer 看不到任何工具，不会触发 tool_calls 导致的 messages 不一致。
    // A+B：给 Writer 开放语义化查询工具 novel_ask_story，用于创作中按需核对角色/伏笔/上文。
    // 状态仍通过 SEMI 层 chapterContext 完整注入，工具仅作为补充查询手段。
    tools: ['novel_ask_story'],
    roleTemplate: 'role-writer',
    temperature: 0.9,
  },
  reviser: {
    type: 'reviser',
    id: 'novel-reviser',
    name: '修订 Agent',
    identity: '你是小说的修订者，负责根据审稿人反馈精确修订章节中的问题段落，遵循最小改动原则。',
    // Reviser 复用 Writer 的工具集。原章节正文 + 审稿意见通过 user_message 注入，
    // 无需 query 工具。role-reviser.md 明确要求"只输出原文/修改后局部补丁"，
    // 禁止输出完整章节正文。代码层 applySafeRevision 优先解析补丁配对应用，
    // 仅在补丁解析失败且通过保留率校验时才回退到整体替换。
    // A+B：给 Reviser 开放语义化查询工具 novel_ask_story，用于修订时核对上下文和角色状态。
    tools: ['novel_ask_story'],
    roleTemplate: 'role-reviser',
    // 温度略低于 Writer：修订需要更精确地遵循审稿意见，减少发散
    temperature: 0.7,
  },
  reviewer: {
    type: 'reviewer',
    id: 'novel-reviewer',
    name: '审稿 Agent',
    identity: '你是一个严格的审稿编辑，检查章节的一致性、节奏和可读性。',
    // ⚠️ Token 优化：Reviewer 无需 query 工具。验收所需信息已通过 SEMI 层
    // shared + suffix 注入：
    //   - shared: formatChapterInfo + formatConstraints + formatArrangedEntities
    //             + formatStoryState + edges + infoLayers + summaries + causalChain
    //   - suffix: formatPreviousChapterEnding + formatSoundAnchor（衔接检查）
    // Writer 全文通过 user_message 注入。
    // 移除工具后 Reviewer 单次调用完成，省 ~5K tokens。
    // A+B：给 Reviewer 开放语义化查询工具 novel_ask_story，用于审稿时快速核对一致性。
    tools: ['novel_ask_story'],
    roleTemplate: 'role-reviewer',
    temperature: 0.3,
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
    temperature: 0.2,
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
  /**
   * 事件类型，与 data.type 保持一致（由调用方显式指定，不再靠 emitProgress 推断）。
   * - phase_change：阶段切换 / 心跳 / 准备中
   * - agent_start：Agent 开始调用（带 messageId，前端据此关联后续 TEXT_MESSAGE_*）
   * - agent_output：Agent 输出（全量，用于非流式场景或最终结果）
   * - data_changed：数据变更通知（Memory Agent 写入完成，前端刷新画布）
   * - checkpoint：检查点（已废弃，改用 CUSTOM(novel:checkpoint) 独立通道）
   * - error / completed / cancelled：流程终止
   */
  type: 'phase_change' | 'agent_start' | 'agent_output' | 'data_changed' | 'checkpoint' | 'error' | 'completed' | 'cancelled'
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
  /** 是否为流式增量推送（true 表示 Agent 仍在生成中，前端应更新最后一条同类型输出而非新增） */
  streaming?: boolean
}
