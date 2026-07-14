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
  /** 最终章节审查时使用的完整审稿 prompt；未提供时复用 buildSystemPrompt */
  buildFinalReviewSystemPrompt?: () => string
}

/** 群聊目标 */
export interface DiscussionGoal {
  /** 高层任务描述（如"创作第3章"） */
  task: string
  /** 上下文（SEMI 层 shared 前缀，跨成员复用 prompt cache） */
  context: string
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
}

/** 群聊运行结果 */
export interface DiscussionResult {
  status: 'completed' | 'cancelled' | 'error'
  content?: string
  transcript: DiscussionMessage[]
  scenes: SceneDefinition[]
  stateChanges?: Array<{ type: string; description: string }>
  error?: string
}

/** 群聊引擎常量 */
export const DISCUSSION_LIMITS = {
  MAX_ROUNDS: 20,
  MAX_ROUNDS_PER_SCENE: 10,
  MAX_OBSERVE_ROUNDS: 3,
  MAX_PUSHBACK_PER_SCENE: 2,
  MAX_SCENE_REPLAYS: 2,
} as const
