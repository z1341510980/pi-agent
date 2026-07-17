/**
 * 群聊共创模式类型定义
 *
 * 通用类型，不依赖 novel 业务领域。
 * NovelDiscussionRunner 负责把 novel 概念翻译为这些类型。
 */

import type { AgUiEventSink } from '@repo/protocol/events'

/** 群聊成员类型 */
export type DiscussionMemberType = 'role' | 'character'

/** 群聊成员 */
export interface DiscussionMember {
  /** 成员 ID（工种用 agentId 如 'novel-director'，角色用 'char-{characterId}'） */
  id: string
  /** 成员类型 */
  type: DiscussionMemberType
  /** 展示名（如"导演"/"赵岩"） */
  name: string
  /** 专长/性格概要（供 Moderator 决策参考） */
  expertise: string
  /** 是否能收敛产出成品（仅 Writer/Reviser 为 true） */
  canConverge: boolean
  /** 角色 Agent：出现在哪些场景（sceneId 序号），工种 Agent 不填 */
  scenePresence?: number[]
  /** 角色 Agent：人设快照 */
  characterProfile?: {
    personality: string
    currentState: string
    currentGoal: string
    secret: string
    arcStage: string
    participatingConflicts: string[]
  }
  /** 构建该成员 system prompt 的工厂函数 */
  buildSystemPrompt: () => string
  /**
   * 成员可见的章节上下文。未提供时使用 DiscussionGoal.context。
   * 角色成员应提供只含本人已知信息的私有上下文，避免共享全知视角。
   */
  buildContextPrompt?: () => string
  /**
   * 构建成员专属身份提示词。
   *
   * 身份放在共享章节上下文之后、动态任务之前，避免它污染 system/shared
   * 缓存前缀。未提供时表示 buildSystemPrompt 已包含完整身份（向后兼容）。
   */
  buildIdentityPrompt?: () => string
  /** 最终章节审查时使用的完整审稿 prompt；未提供时复用 buildSystemPrompt */
  buildFinalReviewSystemPrompt?: () => string
  /** 最终章节审查时使用的成员专属身份提示词。 */
  buildFinalReviewIdentityPrompt?: () => string
  /** 最终审查前的盲审文字编辑身份提示词。 */
  buildProseEditorIdentityPrompt?: () => string
  /**
   * 该成员使用的 LLM 模型（可选，未配置则走默认 Provider）
   *
   * 工种成员（director/writer/reviewer/reviser）从 AgentManager 中该 Agent 的
   * model 配置读取，角色成员不填（走默认 Provider）。
   */
  modelId?: { provider: string; modelId: string }
  /**
   * 该成员使用的 LLM 温度（可选，未配置时工种成员回退到 0.7，角色成员回退到 characterTemperature）
   *
   * 工种成员从 AgentManager 中该 Agent 的 temperature 配置读取（即 AgentPage 角色温度配置），
   * 角色成员不填（由引擎用 characterTemperature）。
   */
  temperature?: number
}

/** 群聊目标 */
export interface DiscussionGoal {
  /** 高层任务描述（如"创作第3章"） */
  task: string
  /** 上下文（SEMI 层 shared 前缀，跨成员复用 prompt cache） */
  context: string
  /** Writer 必须遵守的单章目标字数，按正文非空白字符计。 */
  targetWords?: number
  /** 正文必须直接出现的矩阵实体名称（角色/势力/地点）。 */
  requiredMentions?: string[]
  /** 约束（序列化对象，供 Moderator 参考） */
  constraints?: unknown
}

/** 场景定义（Director 拆场后产出） */
export interface SceneDefinition {
  sceneId: number
  title: string
  location: string
  time: string
  /** 在场角色成员 ID 列表（格式与 DiscussionMember.id 一致） */
  presentCharacters: string[]
  /** Director 输出的原始角色名，用于动态解析与诊断 */
  presentCharacterNames?: string[]
  /** 当前未能解析为成员的角色名 */
  unresolvedCharacterNames?: string[]
  conflict?: string
  goal: string
  /** 本场景的情绪走向（如"从警惕转向震惊"），角色 Agent 演出时承载，Writer 编织时呼应 */
  emotion?: string
}

/** 群聊消息 */
export interface DiscussionMessage {
  id: string
  /** 发送者 ID（'system' | 'moderator' | 'user' | member.id） */
  fromId: string
  fromName: string
  content: string
  timestamp: number
  /** 当前场景序号 */
  sceneId?: number
  type: 'system' | 'moderator' | 'member' | 'user' | 'error'
}

/** Moderator 决策类型 */
export type ModeratorDecision =
  | { type: 'invite'; agentId: string; prompt: string; reason: string }
  | { type: 'pause'; question: string; options?: string[]; reason: string }
  | { type: 'converge'; agentId: string; scope: 'scene' | 'chapter'; reason: string }
  | { type: 'next_scene'; reason: string }
  | { type: 'observe'; reason: string }

/** Moderator 看到的引擎状态 */
export interface ModeratorState {
  phase: DiscussionPhase
  round: number
  currentScene?: SceneDefinition
  scenesRemaining?: number
  scenesDefined: boolean
}

/** 群聊阶段 */
export type DiscussionPhase =
  | 'free_chat'
  | 'planning'
  | 'scene_setup'
  | 'acting'
  | 'scene_weaving'
  | 'chapter_weaving'
  | 'reviewing'
  | 'memory'
  | 'completed'
  | 'error'
  | 'cancelled'

/** 群聊检查点 */
export interface DiscussionCheckpoint {
  type: 'discussion_pause' | 'review'
  phase: string
  question: string
  options?: string[]
  context?: string
}

/** 群聊流程事件 */
export interface DiscussionFlowEvent {
  type: 'phase_change' | 'agent_start' | 'scene_change' | 'pause' | 'completed' | 'error' | 'cancelled' | 'data_changed'
  phase: DiscussionPhase
  data: unknown
  timestamp: number
}

/** 群聊运行选项 */
export interface DiscussionOptions {
  emit: AgUiEventSink
  onCheckpoint: (checkpoint: DiscussionCheckpoint) => Promise<'approve' | 'reject' | 'revise' | string>
  onProgress: (event: DiscussionFlowEvent) => void
  signal?: AbortSignal
  /** Moderator 使用的模型配置（未配置时用最便宜模型） */
  moderatorModel?: { provider: string; modelId: string }
  /** 根据 Director 输出的未知角色名动态创建本次运行使用的角色 Agent */
  resolveCharacterMembers?: (
    characterNames: string[],
  ) => DiscussionMember[] | Promise<DiscussionMember[]>
  /** 引擎运行时限制（覆盖默认 DISCUSSION_LIMITS，来自 DiscussionSettingsStore） */
  limits?: {
    maxRounds?: number
    maxRoundsPerScene?: number
    characterTemperature?: number
  }
  /** 是否在每次角色发言后额外调用 Reviewer。Novel runner 默认关闭，避免角色数 × 轮数的 token 放大。 */
  reviewCharacterSpeech?: boolean
  /** 成员 LLM 调用完成后的审计回调，由业务适配层决定如何持久化。 */
  onMemberInvocation?: (invocation: DiscussionMemberInvocation) => void
  /** 业务层提供的正文形态扫描，用于最终 Reviewer 复核。 */
  buildProseQualityReport?: (content: string) => string
  /** 业务层提供的安全修订应用器；拒绝危险修订时返回原文。 */
  applyRevision?: (
    original: string,
    rawRevision: string,
  ) => { content: string; accepted: boolean; mode: 'full' | 'patch' | 'rejected'; reason?: string }
}

/** 单次群聊成员 LLM 调用的审计信息。 */
export interface DiscussionMemberInvocation {
  member: DiscussionMember
  phase: DiscussionPhase
  systemPrompt: string
  chapterContext: string
  userMessage: string
  result: string
  durationMs: number
  status: 'success' | 'error' | 'cancelled'
  error: string
  sessionId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  llmProvider: string
  llmModel: string
}

/** 群聊运行结果 */
export interface DiscussionResult {
  status: 'completed' | 'cancelled' | 'error'
  content?: string
  transcript: DiscussionMessage[]
  scenes: SceneDefinition[]
  stateChanges?: Array<{ type: string; description: string }>
  error?: string
  /** 异常终止时所在阶段；chapter_weaving 可直接从 Writer 断点续跑。 */
  failedPhase?: DiscussionPhase
}

/** 从已持久化群聊快照恢复 Writer 编织阶段所需的最小状态。 */
export interface DiscussionResumeState {
  phase: 'chapter_weaving'
  transcript: DiscussionMessage[]
  scenes: SceneDefinition[]
}

/** 群聊引擎常量 */
export const DISCUSSION_LIMITS = {
  MAX_ROUNDS: 20,
  MAX_ROUNDS_PER_SCENE: 10,
  MAX_OBSERVE_ROUNDS: 3,
  MAX_PUSHBACK_PER_SCENE: 2,
  MAX_SCENE_REPLAYS: 2,
} as const
