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
 *
 * 创作流程事件协议类型（CreationPhase/CheckpointType/CheckpointData/CheckpointDecision/
 * CreationFlowEvent/AgentOutput）已迁入 @repo/shared/novel，此处仅 re-export
 * 供本插件内部模块沿用 './novel-agents.js' 路径引入。
 */

// 创作流程事件协议类型 re-export（定义在 @repo/shared/novel）
export type {
  CreationPhase,
  CheckpointType,
  CheckpointData,
  CheckpointDecision,
  CreationFlowEvent,
  AgentOutput,
} from './types.js'

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
  /** 最大工具调用次数（可选，用于限制 LLM 的工具调用轮次，防止 token 翻倍） */
  maxToolCalls?: number
}

export const NOVEL_AGENT_CONFIGS: Record<NovelAgentType, NovelAgentConfig> = {
  director: {
    type: 'director',
    id: 'novel-director',
    name: '导演 Agent',
    identity: '你是一个专业的小说导演，负责分析故事状态并规划章节叙事任务。',
    // ⚠️ Token 优化：Director 无需 query 工具。所有实体信息已通过 SEMI 层
    // chapterContext 一次性注入：
    //   - formatArrangedEntities 注入本章出场实体（角色短卡/冲突/伏笔/线索/势力/地点/物品）
    //   - formatStoryState 仅在无编排时兜底，输出全量精简状态
    //   - formatStoryLedgerContext 注入账本承接（章前状态 + 本章计划）
    //   - formatInfoLayers 注入信息差
    //   - formatConstraints 注入创作约束
    //   - formatEdges 注入实体关联（画布连线 + 派生边）
    //   - formatRecentSummaries 注入最近章节摘要
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
    //   - formatArrangedEntities 注入本章出场实体（角色短卡/冲突/伏笔/线索/势力/地点/物品）
    //   - formatStoryState 仅在无编排时兜底，输出全量精简状态
    //   - formatInfoLayers 注入信息差
    //   - formatConstraints 注入创作约束
    //   - formatEdges 注入实体关联（画布连线 + 派生边）
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
    maxToolCalls: 2, // 限制工具调用次数，防止 token 翻倍
  },
  reviser: {
    type: 'reviser',
    id: 'novel-reviser',
    name: '修订 Agent',
    identity: '你是小说的修订者，负责根据审稿人反馈精确修订章节中的问题段落，遵循最小改动原则。',
    // 白名单只列全局工具（novel_ask_story 用于修订时核对上下文和角色状态）。
    // novel_apply_revision 不在全局 createNovelTools 列表里（因为工具通过闭包持有
    // draft 对象，每次 Reviser 调用都要重新创建），而是在 novel-orchestrator.ts
    // 调用 Reviser 时通过 runAgent 的 extraTools 参数动态注入。
    // 工具内部用 String.replace 做精确替换，完全绕开正则解析自然语言的歧义。
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
    //             + arrangedEntities + 账本承接 + edges + infoLayers + summaries
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

/** 小说角色温度配置（合并后，含全部 5 角色） */
export type NovelAgentTemperatures = Record<NovelAgentType, number>

/** AgentManager 类型（仅类型，避免运行时循环依赖） */
type AgentManagerLike = {
  getAgent(id: string): { temperature?: number } | undefined
  updateAgent(id: string, patch: { temperature?: number }): unknown
}

/**
 * 获取单个角色温度（AgentManager 覆盖 > NOVEL_AGENT_CONFIGS 默认值）
 *
 * 替代原 NovelAgentConfigStore.getByType，避免薄封装空壳类。
 * agentManager 不可用或 agent 未注册时回退到 NOVEL_AGENT_CONFIGS 默认值。
 */
export function getNovelAgentTemperature(
  agentType: NovelAgentType,
  agentManager?: AgentManagerLike,
): number {
  const config = NOVEL_AGENT_CONFIGS[agentType]
  if (agentManager) {
    const agent = agentManager.getAgent(config.id)
    if (agent?.temperature !== undefined) return agent.temperature
  }
  return config.temperature
}

/**
 * 获取全部角色温度（AgentManager 覆盖 > NOVEL_AGENT_CONFIGS 默认值）
 *
 * 替代原 NovelAgentConfigStore.getAll。
 */
export function getAllNovelAgentTemperatures(agentManager?: AgentManagerLike): NovelAgentTemperatures {
  return {
    director: getNovelAgentTemperature('director', agentManager),
    writer: getNovelAgentTemperature('writer', agentManager),
    reviser: getNovelAgentTemperature('reviser', agentManager),
    reviewer: getNovelAgentTemperature('reviewer', agentManager),
    memory: getNovelAgentTemperature('memory', agentManager),
  }
}

/**
 * 覆盖单个角色温度（写入 AgentManager）
 *
 * 替代原 NovelAgentConfigStore.upsert。
 * agentManager 不可用或 agent 未注册时为 no-op（保持与原实现一致的回退语义）。
 * 注：updateAgent 为 async，但内存更新在首个 await 前同步完成，
 * 后续 getAgent 立即可见新温度。持久化部分 fire-and-forget，保持同步签名。
 */
export function updateNovelAgentTemperature(
  agentType: NovelAgentType,
  temperature: number,
  agentManager?: AgentManagerLike,
): void {
  if (!agentManager) return
  const config = NOVEL_AGENT_CONFIGS[agentType]
  // agent 未注册时跳过（updateAgent 在 agent 不存在时会抛错）
  // 首次注册前调用不应报错，回退为 no-op
  if (!agentManager.getAgent(config.id)) return
  void agentManager.updateAgent(config.id, { temperature })
}

/**
 * 批量覆盖温度
 *
 * 替代原 NovelAgentConfigStore.upsertMany。
 */
export function updateNovelAgentTemperatures(
  items: Array<{ agentType: NovelAgentType; temperature: number }>,
  agentManager?: AgentManagerLike,
): void {
  for (const item of items) {
    updateNovelAgentTemperature(item.agentType, item.temperature, agentManager)
  }
}
