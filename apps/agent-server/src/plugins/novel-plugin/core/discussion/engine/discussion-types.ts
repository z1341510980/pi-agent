/**
 * 群聊共创模式类型定义
 *
 * 通用类型，不依赖 novel 业务领域。
 * NovelDiscussionRunner 负责把 novel 概念翻译为这些类型。
 */

import type { AgUiEventSink } from '@repo/protocol/events'
import type { PluginSessionOptions } from '../../../../../core/plugin/plugin-types.js'

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
  /**
   * 角色 Agent 在各信息层上的认知状态（key = 信息层 ID）。
   *
   * 仅用于判断哪些角色**信息对称**、可合并为一次 LLM 调用（演出阶段逐角色
   * 轮询的固定开销远大于产出：ch10 实测 20 次调用只换回 3.7k token）。
   *
   * 必须逐层比对而不能凭"同场"就合并：认知不同的角色可见上下文不同，
   * 合并会把秘密泄露给不该知道的角色，后续台词会出现
   * "他明明不知道却提到了那件事"。
   *
   * 由业务层填充，口径需与 buildContextPrompt 的裁剪一致。缺失时该角色
   * 不参与合并，退回逐个调用。
   */
  knowledge?: Record<string, { knows?: boolean; suspects?: boolean; misunderstands?: string }>
  /**
   * 是否允许把该角色与其他角色放进同一次 LLM 调用。
   *
   * 设为 false 表示身份提示中含不可暴露给其他角色的私密信息。即使角色的
   * knowledge 指纹和可见上下文相同，也必须逐个调用，不能依赖提示词做软隔离。
   * 未设置时保持通用引擎的向后兼容行为。
   */
  allowMergedInvocation?: boolean
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
  /**
   * 合并演出（多角色同一次 LLM 调用）使用的身份提示词。
   *
   * 合并调用不走 Skill 展开（invocationOverrides 派生），因此若主身份走
   * Skill 薄壳，本字段必须内联完整角色方法正文，避免合并推演丢失演出格式规则。
   * 未提供时回退到 buildIdentityPrompt。
   */
  buildMergedActorIdentityPrompt?: () => string
  /** 最终章节审查时使用的完整审稿 prompt；未提供时复用 buildSystemPrompt */
  buildFinalReviewSystemPrompt?: () => string
  /** 最终章节审查时使用的成员专属身份提示词。 */
  buildFinalReviewIdentityPrompt?: () => string
  /** 最终审查前的盲审文字编辑身份提示词。 */
  buildProseEditorIdentityPrompt?: () => string
  /**
   * 显式授权给成员主身份路径的 Skill（/skill: 展开提供角色方法）。
   *
   * 仅在不走 invocationOverrides 的常规调用中生效；盲审/特殊覆盖派生成员应
   * 显式置为 undefined，避免从原成员 spread 继承。未提供时沿用旧模板身份路径。
   */
  skill?: { name: string; path: string }
  /**
   * 最终章节验收（final review）时使用的 Skill。
   *
   * Reviewer 的最终验收走标准角色方法（而非群聊审查角色），因此与主身份
   * 的 discussion Skill 不同。未提供时回退到 member.skill。
   */
  finalReviewSkill?: { name: string; path: string }
  /**
   * 该成员使用的 LLM 模型（可选，未配置则走默认 Provider）
   *
   * 工种成员默认从 AgentManager 中读取；业务适配层也可以为本次运行统一覆盖
   * 工种和角色成员的模型。
   */
  modelId?: PluginSessionOptions['modelId']
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
  /**
   * 点名发言。
   *
   * `agentIds` 是可选的**多角色点名**：演出阶段主持人可以一次点名同场的多个角色，
   * 引擎会把其中信息对称的合并为一次 LLM 调用（见 discussion-actor-batching）。
   * 逐角色轮询的固定开销远大于产出 —— ch10 实测 20 次调用 × 15.9s 只换回 3.7k token。
   *
   * 兼容旧协议：`agentId` 始终存在（多角色时为首个），未提供 `agentIds` 的决策
   * 按单角色处理，行为与合并前完全一致。
   */
  | { type: 'invite'; agentId: string; prompt: string; reason: string; agentIds?: string[] }
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
  /**
   * 结构化渲染载荷（2026-08-24 空检查点修复）：前端 renderCheckpointContent
   * 读 checkpoint.data；此前 pause 只有 question 字段，前端内容区为空。
   * discussion_pause 的 data 形如 { message, choices? }。
   */
  data?: unknown
}

/** 群聊流程事件 */
export interface DiscussionFlowEvent {
  type: 'phase_change' | 'agent_start' | 'agent_output' | 'scene_change' | 'pause' | 'completed' | 'error' | 'cancelled' | 'data_changed'
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
  /**
   * 本次运行的成员模型覆盖。优先级高于工种 Agent 配置；角色成员也使用该模型。
   * Moderator 保持使用 moderatorModel，避免协调模型被正文创作模型意外替换。
   */
  memberModel?: PluginSessionOptions['modelId']
  /** 本次群聊运行唯一插话隔离键。 */
  flowKey?: string
  /** 本轮召集的独立蒸馏文风专家 ID；只作用于正文工种成员。 */
  styleExpertIds?: string[]
  /**
   * 本次运行启动时冻结的项目主模型；null 表示启动时明确未配置。
   * 断点续跑必须沿用该状态，不能因项目设置后来改变而换模型。
   */
  projectModel?: { provider: string; modelId: string } | null
  /** 根据 Director 输出的未知角色名动态创建本次运行使用的角色 Agent */
  resolveCharacterMembers?: (
    characterNames: string[],
  ) => DiscussionMember[] | Promise<DiscussionMember[]>
  /**
   * 出场角色白名单（2026-08-24 编排外角色修复）：业务层编排了角色清单时传入
   * （成员 ID 形如 `char-{characterId}`）。设置后：
   * - 场景 presentCharacters 只保留白名单内的成员；
   * - Director 提到白名单外的名字不再动态建临时角色，而是丢弃并写入 system 警告。
   * 未设置（未编排）时保持旧行为：未知名字走 resolveCharacterMembers 动态解析。
   */
  allowedCharacterMemberIds?: string[]
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
  /**
   * 业务层为 Reviser 提供"工具化修订"能力。
   *
   * ⚠️ 工具化方案：旧 applyRevision 回调让 Reviser 输出"原文/修改后"配对文本，
   * 再由引擎用正则解析，LLM 不严格遵守格式时解析失败会走 full 兜底把"修改意见"
   * 当作完整正文落库。新方案：业务层在工厂里创建 draft（持有当前章节正文）+ 工具，
   * 引擎把工具注入 Reviser 的 LLM 调用，Reviser 必须调用工具才能修改正文，
   * 工具内部用 String.replace 做精确替换，完全绕开自然语言解析。
   * Reviser 返回后引擎调用 extractResult() 得到最终正文。
   */
  buildReviserToolset?: (originalContent: string) => ReviserToolset
  /**
   * 业务层为 Reviewer 提供"工具化验收"能力。
   *
   * ⚠️ 工具化方案：旧路径让 Reviewer 输出 Markdown 报告（十维评分表 + Findings 表格 + 结论），
   * 再由 discussion runner 用 parseChapterReviewReport 正则解析 11 个评分 + verdict + issues + suggestions。
   * LLM 不严格遵守格式时正则解析失败，评分/结论降级为 null，Reviewer 的真实判断丢失。
   * 新方案：业务层在工厂里创建 draft + 工具，引擎把工具注入 Reviewer 的 LLM 调用，
   * Reviewer 必须调用工具才能提交结构化验收对象，工具参数 schema 强制校验。
   * Reviewer 返回后引擎调用 extractResult() 得到结构化验收对象。
   */
  buildReviewerToolset?: () => ReviewerToolset
  /**
   * 业务层为 Director 提供"工具化场景计划"能力（2026-08-24 演绎链路修复）。
   *
   * 引擎在规划阶段调用 Director 时把工具集注入 LLM 调用；converge(chapter) 后
   * 优先读 extractResult()，未提交时回退 Markdown 解析并显式告警。
   */
  buildScenePlanToolset?: () => ScenePlanToolset
  /**
   * 插话被 Moderator 消费（写入群聊 history）后回调（对话化交互形态 §3.1，
   * 供端点沿 SSE 推 status='injected' 事件）。
   */
  onInterjectInjected?: (ids: string[]) => void
  /** flow 收尾时仍未被消费的插话回调（供端点推 status='dropped' 事件）。 */
  onInterjectDropped?: (ids: string[]) => void
}

/** 群聊运行中用户插话（对话化交互形态 §3.1）：由端点入队，Moderator 每轮 decide 前 drain。 */
export interface DiscussionInterjectMessage {
  /** 唯一 id（端点生成，供 SSE queued/injected/dropped 状态流转对齐） */
  id: string
  content: string
  createdAt: number
}

/**
 * Reviser 工具集：业务层创建的 draft + 工具，引擎在调用 Reviser 前取得。
 *
 * 工具集通过闭包引用 draft 对象，Reviser 调用工具时直接修改 draft.content，
 * 引擎在 Reviser 结束后通过 extractResult() 读取 draft 状态，无需解析 Reviser 输出。
 */
export interface ReviserToolset {
  /** 注入 Reviser LLM 调用的工具列表（工具内部已绑定 draft） */
  tools: unknown[]
  /** Reviser 结束后调用，返回最终正文 + 应用情况 */
  extractResult: () => ReviserOutcome
}

/** Reviser 工具化修订结果 */
export interface ReviserOutcome {
  /** 最终正文（已应用所有成功 patch） */
  content: string
  /** 总 patch 数 */
  appliedPatchCount: number
  /** 成功 patch 数（0 表示 Reviser 未调用工具或全部定位失败） */
  successCount: number
  /** 修订模式：patch=通过工具应用，rejected=未应用任何修订（保留原正文） */
  mode: 'patch' | 'rejected'
  /** 未应用原因（mode=rejected 时填写） */
  reason?: string
}

/**
 * Director 场景计划工具集：业务层创建的 draft + 工具，引擎在规划阶段调用 Director 前取得。
 *
 * ⚠️ 工具化方案（2026-08-24 群聊演绎链路修复）：旧路径让 Director 输出 Markdown 场景拆分，
 * 引擎用正则解析 `### 场景N` 与 `- 字段：` 行。实测 Director 输出中文数字/表格变体时解析
 * 全部失败，scenes=[] 导致整章静默跳过演出、Writer 盲写。
 * 新方案：Director 必须调用 novel_submit_scene_plan 工具提交结构化场景计划，
 * 工具参数 schema 强制校验；Markdown 解析降级为兼容回退，且回退时必须显式告警。
 */
export interface ScenePlanToolset {
  /** 注入 Director 规划 LLM 调用的工具列表（工具内部已绑定 draft） */
  tools: unknown[]
  /** Director 结束后调用，返回提交的场景计划；未调用工具时返回 null */
  extractResult: () => { scenes: SubmittedSceneInput[] } | null
}

/** 工具提交的原始场景：presentCharacters 是角色名，由引擎映射为成员 ID */
export interface SubmittedSceneInput {
  title: string
  location: string
  time: string
  conflict?: string
  goal: string
  emotion?: string
  presentCharacters: string[]
}

/**
 * Reviewer 工具集：业务层创建的 draft + 工具，引擎在调用 Reviewer 前取得。
 *
 * 工具集通过闭包引用 draft 对象，Reviewer 调用工具时直接写入 draft.review，
 * 引擎在 Reviewer 结束后通过 extractResult() 读取 draft 状态，无需解析 Reviewer 输出。
 */
export interface ReviewerToolset {
  /** 注入 Reviewer LLM 调用的工具列表（工具内部已绑定 draft） */
  tools: unknown[]
  /** Reviewer 结束后调用，返回结构化验收结果 */
  extractResult: () => ReviewerOutcome
}

/** Reviewer 工具化验收结果 */
export interface ReviewerOutcome {
  /** Reviewer 是否调用了工具提交验收报告 */
  toolCalled: boolean
  /**
   * Reviewer 提交的验收对象（未调用工具时为 null）。
   * 引擎不感知其内部结构，由业务层（如 novel-discussion-runner）做类型断言。
   */
  review: unknown | null
  styleTechniqueChecks?: Array<{
    expertId: string
    expertName: string
    techniqueId: string
    techniqueName: string
    dimension: string
    verdict: 'present' | 'absent' | 'not_applicable'
    evidence?: string
    note?: string
  }>
}

/** 单次群聊成员 LLM 调用的审计信息。 */
export interface DiscussionMemberInvocation {
  member: DiscussionMember
  /** 合并角色调用的全部参与者；普通调用不填，继续以 member 为准。 */
  participantIds?: string[]
  participantNames?: string[]
  phase: DiscussionPhase
  systemPrompt: string
  chapterContext: string
  userMessage: string
  result: string
  /**
   * 本次调用实际挂载的工具名。
   *
   * 加这个字段是因为群聊侧的 agent 日志原来把 `tools`/`toolNames` 硬编码成空数组，
   * 于是日志上看不出 Reviser 到底有没有拿到 `novel_apply_revision`。
   * 排查"修订没生效"时，"工具没挂上"和"工具挂了但模型没调"是两种完全不同的问题，
   * 必须能从日志区分。
   */
  toolNames: string[]
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
  /** 真实 payload 体积（各次 LLM 往返累加）与往返次数 */
  payloadMessagesChars: number
  payloadToolsChars: number
  payloadToolCount: number
  payloadTotalChars: number
  llmRoundTrips: number
}

/** 群聊运行结果 */
export interface DiscussionResult {
  status: 'completed' | 'cancelled' | 'error'
  content?: string
  transcript: DiscussionMessage[]
  scenes: SceneDefinition[]
  stateChanges?: Array<{ type: string; description: string }>
  error?: string
  /** 异常终止时所在阶段；chapter_weaving/acting/reviewing 等可断点续跑。 */
  failedPhase?: DiscussionPhase
  /** failedPhase='acting'/'scene_setup' 时中断的场景 ID（断点续跑从此场景继续）。 */
  failedSceneId?: number
  /**
   * Reviewer 工具化验收结果（仅 completed 状态且业务层提供 buildReviewerToolset 时存在）。
   * 业务层据此持久化结构化验收报告，无需再从 transcript 中正则解析 Reviewer 输出。
   */
  review?: ReviewerOutcome
  /**
   * 演绎链路健康度（2026-08-24）：让"演出是否真的发生、走了哪条解析路径、
   * 格式重试烧了多少调用"成为可查询数据，而不是只存在于服务端日志。
   */
  diagnostics?: DiscussionDiagnostics
}

/** 群聊演绎链路诊断统计 */
export interface DiscussionDiagnostics {
  /** 场景计划来源：工具提交 / Markdown 回退 / 无 */
  sceneSource: 'tool' | 'markdown' | 'none'
  scenesTotal: number
  /** 至少有一条角色发言的场景数 */
  scenesWithActing: number
  /** 角色发言总条数（不含合并调用的格式纠正重试） */
  characterSpeeches: number
  /** 角色发言未通过格式校验触发重试的次数 */
  formatCorrections: number
  /** 规划阶段因场景计划缺失触发的纠正性重试次数 */
  planningRetries: number
  /**
   * 台词复用率（P1-2）：正文对角色推演引号台词的命中率（0~1）。
   * 编织完成后写入；无推演台词（盲写降级）时不填。
   */
  transcriptReuseRate?: number
  /** Moderator 双次尝试均失败、退化为规则协调的轮数。>0 时对戏质量可能下降 */
  moderatorDegradedRounds?: number
}

/**
 * 从已持久化群聊快照恢复所需的最小状态。
 *
 * phase 语义（断点续跑入口）：
 * - 'scene_setup' / 'acting'：场景推演中断，从 failedSceneId（缺省第一个场景）继续场景循环
 * - 'chapter_weaving'：推演已完成，直接进入全章编织
 * - 'reviewing'：正文已织成（content 携带），从最终质量门复核继续
 */
export interface DiscussionResumeState {
  phase: 'chapter_weaving' | 'scene_setup' | 'acting' | 'reviewing'
  transcript: DiscussionMessage[]
  scenes: SceneDefinition[]
  /** phase='reviewing' 时的已织正文（跳过编织直接复核） */
  content?: string
  /** phase='scene_setup'/'acting' 时中断的场景 ID（缺省从第一个场景继续） */
  failedSceneId?: number
}

/** 群聊引擎常量 */
export const DISCUSSION_LIMITS = {
  MAX_ROUNDS: 20,
  MAX_ROUNDS_PER_SCENE: 10,
  MAX_OBSERVE_ROUNDS: 3,
  MAX_PUSHBACK_PER_SCENE: 2,
  MAX_SCENE_REPLAYS: 2,
  /** 台词复用率闸门（P1-2）：推演引号台词少于该数时不启用（样本太小无统计意义） */
  FIDELITY_MIN_QUOTED_LINES: 4,
  /** 台词复用率低于该阈值时触发一次定向补织重写 */
  FIDELITY_RATE_THRESHOLD: 0.4,
  /** 定向补织 prompt 中最多列出的未落地台词条数 */
  FIDELITY_MAX_LISTED: 12,
} as const
