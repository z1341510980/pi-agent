/**
 * 小说创作系统核心类型定义
 *
 * 对应 docs/ai_novel_creation_workbench_core_systems.md 中的 15 大系统
 */

// ── 项目 ──

export interface NovelProject {
  id: string
  title: string
  genre: string // 玄幻/科幻/悬疑/都市...
  synopsis: string
  /** 全书大纲（一段文本） */
  outline?: string
  targetWords: number
  currentVolume: number
  currentChapter: number
  currentStage: StoryStage
  status: 'active' | 'paused' | 'completed'
  /** 节奏模型 ID（缺省时使用 RhythmController.DEFAULT_MODEL） */
  rhythmModelId?: string
  createdAt: number
  updatedAt: number
}

export type StoryStage = 'setup' | 'rising' | 'climax' | 'falling' | 'resolution'

// ── 章节节奏 ──

/** 章节节奏类型 */
export type ChapterRhythm =
  | 'setup'      // 铺垫：介绍背景、人物、设定
  | 'rising'     // 上升：推进冲突，加剧紧张
  | 'climax'     // 高潮：冲突爆发，转折点
  | 'falling'    // 下降：高潮后回落，处理后果
  | 'resolution' // 收束：解决线索，回到平衡
  | 'twist'      // 转折：意料之外的走向
  | 'breather'   // 舒缓：紧张之间的缓冲

/** 节奏模型：定义故事弧的理想节奏序列 */
export interface RhythmModel {
  id: string
  name: string
  description: string
  /** 理想节奏序列（循环执行，如果章节数超过序列长度） */
  sequence: ChapterRhythm[]
}

/** 节奏建议 */
export interface RhythmSuggestion {
  /** 建议的节奏 */
  rhythm: ChapterRhythm
  /** 在弧中的位置（0-1） */
  arcPosition: number
  /** 建议原因 */
  reason: string
  /** 节奏描述（供 LLM 参考） */
  description: string
}

/** 节奏历史记录 */
export interface RhythmHistoryEntry {
  chapterNumber: number
  rhythm: ChapterRhythm
  effectiveness: 'low' | 'medium' | 'high'  // 节奏效果评估
}

// ── 章节 ──

export interface NovelChapter {
  id: string
  projectId: string
  volume: number
  chapterNumber: number
  title: string
  content: string
  wordCount: number
  status: ChapterStatus
  narrativeTask: string
  /** 章纲（用户编写，作为生成统一起点） */
  outline?: string
  /** 所属卷 ID（指向 novel_volumes.id，兼容旧数据可空） */
  volumeId?: string | null
  acceptanceResult: string | null // JSON
  /** 章节节奏（由 RhythmController 建议，可手动覆盖） */
  rhythm?: ChapterRhythm
  createdAt: number
  updatedAt: number
}

export type ChapterStatus = 'planned' | 'drafting' | 'review' | 'published' | 'rejected'

// ── 卷 ──

export interface NovelVolume {
  id: string
  projectId: string
  volumeNumber: number
  title: string
  outline: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}

// ── 角色 ──

export interface NovelCharacter {
  id: string
  projectId: string
  name: string
  description: string
  // 静态设定
  identity: string
  personality: string
  appearance: string
  // 动态状态
  currentState: string
  currentGoal: string
  currentPressure: string
  secret: string
  // 角色弧光
  arcStage: string
  arcHistory: string // JSON: ArcChange[]
  // 说话风格
  speechStyle: string
  isProtagonist: boolean // 是否主角
  createdAt: number
  updatedAt: number
}

export interface ArcChange {
  fromStage: string
  toStage: string
  reason: string
  chapter: number
  timestamp: number
}

// ── 关系 ──

export interface NovelRelationship {
  id: string
  projectId: string
  characterA: string
  characterB: string
  relationType: string // 敌对/合作/师徒/恋人/亲属...
  currentStage: string
  stageHistory: string // JSON: RelationChange[]
  createdAt: number
  updatedAt: number
}

// ── 伏笔 ──

export interface NovelForeshadow {
  id: string
  projectId: string
  description: string
  category: string // 物品/身份/事件/承诺/台词...
  status: ForeshadowStatus
  firstChapter: number | null
  lastChapter: number | null
  recoverByChapter: number | null
  linkedCharacters: string // JSON: string[]
  linkedClues: string // JSON: string[]
  createdAt: number
  updatedAt: number
}

export type ForeshadowStatus =
  | 'planned' | 'planted' | 'reinforced' | 'partially_revealed'
  | 'recovering' | 'recovered' | 'abandoned'

// ── 线索 ──

export interface NovelClue {
  id: string
  projectId: string
  description: string
  pointsTo: string
  progress: number // 0-100
  currentStep: string
  nextStep: string
  isMisleading: boolean
  linkedForeshadow: string | null
  createdAt: number
  updatedAt: number
}

// ── 冲突 ──

export interface NovelConflict {
  id: string
  projectId: string
  description: string
  type: ConflictType
  intensity: number // 1-10
  stage: ConflictStage
  participants: string // JSON: string[]
  firstChapter: number | null // 冲突开始的章节
  lastChapter: number | null // 冲突结束的章节
  tier: ConflictTier // 冲突层级
  createdAt: number
  updatedAt: number
}

export type ConflictType =
  | 'inner' | 'relationship' | 'faction' | 'interest'
  | 'moral' | 'identity' | 'emotional' | 'world_rule' | 'survival'

export type ConflictStage =
  | 'latent' | 'emerging' | 'escalating' | 'erupting'
  | 'reversing' | 'resolved' | 'transformed'

export type ConflictTier = 'main' | 'secondary' | 'goal'

// ── 世界规则 ──

export interface NovelWorldRule {
  id: string
  projectId: string
  category: string // 力量体系/魔法/科技/政治/经济/地理/禁忌/代价...
  rule: string
  cost: string | null
  isFixed: boolean
  createdAt: number
  updatedAt: number
}

// ── 势力 ──

export type NovelFactionType =
  | 'organization' | 'sect' | 'kingdom' | 'family' | 'guild' | 'cult'
export type NovelFactionStrength = 'weak' | 'medium' | 'strong' | 'overwhelming'
export type NovelFactionStatus = 'active' | 'declined' | 'destroyed' | 'hidden'

export interface NovelFaction {
  id: string
  projectId: string
  name: string
  description: string
  type: NovelFactionType
  leaderId: string | null
  ideology: string
  strength: NovelFactionStrength
  resources: string[]
  allies: string[] // factionId[]
  enemies: string[] // factionId[]
  status: NovelFactionStatus
  firstChapter: number | null // 势力登场的章节
  lastChapter: number | null // 势力退场的章节
  createdAt: number
  updatedAt: number
}

// ── 地点 ──

export type NovelLocationType =
  | 'continent' | 'country' | 'city' | 'building' | 'dungeon' | 'region' | 'wilderness'
export type NovelLocationSignificance = 'minor' | 'moderate' | 'major' | 'critical'
export type NovelLocationStatus = 'normal' | 'destroyed' | 'changed' | 'hidden'

export interface NovelLocation {
  id: string
  projectId: string
  name: string
  description: string
  type: NovelLocationType
  parentId: string | null
  factionId: string | null
  significance: NovelLocationSignificance
  firstChapter: number | null
  status: NovelLocationStatus
  appearChapters: number[] // 地点出现的章节列表
  createdAt: number
  updatedAt: number
}

// ── 世界观要素 ──

export type NovelWorldElementCategory =
  | 'power_system' | 'history' | 'culture' | 'religion'
  | 'technology' | 'economy' | 'geography'

export interface NovelWorldElement {
  id: string
  projectId: string
  category: NovelWorldElementCategory
  name: string
  description: string
  parentId: string | null
  attributes: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

// ── 创作约束 ──

export interface NovelConstraint {
  id: string
  projectId: string
  type: ConstraintType
  scope: 'global' | 'volume' | 'chapter'
  rule: string
  isActive: boolean
  relatedEntityId: string | null
  createdAt: number
  updatedAt: number
}

export type ConstraintType = 'fact' | 'cognitive' | 'stage' | 'debt' | 'arc'

// ── 信息差 ──

export interface NovelInformationLayer {
  id: string
  projectId: string
  infoDescription: string
  authorKnows: boolean
  readerKnows: boolean
  characterKnowledge: string // JSON: { [characterId]: { knows, suspects, misunderstands } }
  revealStage: string | null
  revealChapter: number | null
  isRevealed: boolean
  createdAt: number
  updatedAt: number
}

// ── 风格指南 ──

export interface NovelStyleGuide {
  id: string
  projectId: string
  category: string
  rule: string
  example: string | null
  createdAt: number
  updatedAt: number
}

// ── 作者意图 ──

export interface NovelAuthorIntent {
  id: string
  projectId: string
  chapterId: string | null
  intentType: 'plot' | 'foreshadow' | 'character' | 'scene' | 'dialogue'
  description: string
  targetEntityId: string | null
  createdAt: number
}

// ── 章节验收 ──

export interface NovelChapterReview {
  id: string
  projectId: string
  chapterId: string
  consistencyScore: number | null
  characterScore: number | null
  taskCompletionScore: number | null
  clueProgressScore: number | null
  foreshadowStatusScore: number | null
  conflictChangeScore: number | null
  pacingScore: number | null
  infoControlScore: number | null
  readerHookScore: number | null
  styleScore: number | null
  overallScore: number | null
  verdict: 'accept' | 'revise' | 'reject' | null
  issues: string | null // JSON
  suggestions: string | null // JSON
  reviewedBy: string | null
  createdAt: number
}

// ── 角色状态变更历史 ──

export type CharacterHistoryField =
  | 'currentState' | 'currentGoal' | 'currentPressure' | 'secret' | 'arcStage'

export interface NovelCharacterHistory {
  id: string
  projectId: string
  characterId: string
  chapterId: string | null
  chapterNumber: number | null
  fieldName: CharacterHistoryField
  oldValue: string | null
  newValue: string | null
  reason: string | null
  createdAt: number
}

// ── 节点位置（前端画布节点坐标持久化）──

export type NovelNodeType =
  | 'project' | 'character' | 'chapter' | 'conflict' | 'foreshadow' | 'group'
  | 'faction' | 'location' | 'world_element'

export interface NovelNodePosition {
  id: string
  projectId: string
  nodeType: NovelNodeType
  entityId: string
  posX: number
  posY: number
  updatedAt: number
}

// ── 画布连线（手动连线持久化 + 自动边存储）──

/**
 * 边类型语义：
 * - appearance    角色 ↔ 章节（出场）
 * - relationship  角色 ↔ 角色（关系）
 * - involvement   冲突 → 角色（参与）
 * - foreshadow    伏笔 → 章节（埋设/回收）
 * - base          地点 ↔ 章节（场景）
 * - member        势力 ↔ 角色（成员/首领）
 * - hierarchy     地点 ↔ 地点 / 世界观要素 ↔ 世界观要素（层级）
 * - association   其他关联（兜底）
 * - mentor        师徒
 * - kinship       亲属
 * - rivalry       敌对
 * - alliance      同盟
 * - subordinate   隶属
 * - trigger       触发
 * - causality     因果
 */
export type NovelEdgeType =
  | 'appearance' | 'relationship' | 'involvement' | 'foreshadow'
  | 'base' | 'member' | 'hierarchy' | 'association'
  | 'mentor' | 'kinship' | 'rivalry' | 'alliance' | 'subordinate' | 'trigger' | 'causality'

export interface NovelEdge {
  id: string
  projectId: string
  sourceId: string
  sourceType: NovelNodeType
  targetId: string
  targetType: NovelNodeType
  edgeType: NovelEdgeType
  label: string
  /** true=自动生成, false=手动创建 */
  auto: boolean
  createdAt: number
  updatedAt: number
}

// ── 提示词模板 ──

export interface NovelPromptTemplate {
  id: string
  projectId: string | null // null = 全局默认
  name: string // 模板名称（如 writer, director, reviewer...）
  content: string // 模板内容，支持 {{variable}} 占位符
  description: string | null
  createdAt: number
  updatedAt: number
}

// ── 故事状态快照 ──

export interface StoryState {
  project: NovelProject
  characters: NovelCharacter[]
  relationships: NovelRelationship[]
  activeConflicts: NovelConflict[]
  pendingForeshadowing: NovelForeshadow[]
  activeClues: NovelClue[]
  activeFactions: NovelFaction[]
  activeLocations: NovelLocation[]
  currentStage: StoryStage
  currentChapter: number
}

// ── 叙事任务 ──

export interface NarrativeTask {
  description: string
  type: NarrativeTaskType
  targetEntity: string | null
  priority: 'high' | 'medium' | 'low'
}

export type NarrativeTaskType =
  | 'advance_mainline' | 'advance_subline' | 'create_conflict' | 'escalate_conflict'
  | 'release_info' | 'hide_info' | 'reinforce_foreshadow' | 'recover_foreshadow'
  | 'change_relationship' | 'change_cognition' | 'create_reversal' | 'create_suspense'
  | 'phase_closure' | 'introduce_problem'

// ── 章节约束 ──

export interface ChapterConstraints {
  facts: NovelConstraint[]
  cognitive: NovelConstraint[]
  stage: NovelConstraint[]
  narrativeDebts: NovelForeshadow[]
  characterArcs: Array<{
    character: NovelCharacter
    allowedNextStage: string | null
  }>
}

// ── 本章已编排的实体约束 ──

/** 本章已编排的实体约束（手动编排或 AI 编排产出，注入 Writer SEMI 提示词层） */
export interface ArrangedEntity {
  characterIds: string[]
  conflictIds: string[]
  foreshadowIds: string[]
  factionIds: string[]
  locationIds: string[]
}

// ── 缓存层标记 ──

/**
 * 提示词缓存层级
 *
 * 缓存命中率是小说创作的关键成本指标。
 * 提示词按缓存稳定性从高到低分层：
 *
 * STATIC    - 系统提示词中的静态部分（世界规则、风格、角色定义）
 *             跨章节不变，缓存命中率最高
 * SEMI      - 章节上下文（当前状态、叙事任务）
 *             单章内不变，跨章失效
 * DYNAMIC   - 对话消息（工具调用结果、生成内容）
 *             每次调用都变，不缓存
 */
export type CacheLayer = 'static' | 'semi' | 'dynamic'

// ── Agent 调用日志 ──

export type NovelAgentLogStatus = 'success' | 'error' | 'cancelled'

export interface NovelAgentLog {
  id: string
  projectId: string
  chapterNumber: number
  agentType: string
  agentName: string
  displayAgentType: string
  displayAgentName: string
  phase: string
  systemPrompt: string
  chapterContext: string
  userMessage: string
  taskInput: string
  userInstructions: string[]
  tools: unknown[]
  toolNames: string[]
  result: string
  resultLength: number
  durationMs: number
  status: NovelAgentLogStatus
  error: string
  sessionId: string
  createdAt: number
}

/** 列表查询时返回的精简记录（不含完整 prompt 内容，避免传输过大） */
export interface NovelAgentLogSummary {
  id: string
  projectId: string
  chapterNumber: number
  agentType: string
  agentName: string
  displayAgentType: string
  displayAgentName: string
  phase: string
  systemPromptLength: number
  userMessageLength: number
  toolNames: string[]
  resultLength: number
  durationMs: number
  status: NovelAgentLogStatus
  error: string
  createdAt: number
}

// ── 时间轴标记 ──

export type NovelMarkerType =
  | 'bookmark' | 'turning-point' | 'foreshadow' | 'climax' | 'note'
  | 'clip-note'

export type NovelMarkerColor = 'blue' | 'yellow' | 'green' | 'red' | 'purple'

/** 时间轴标记：用户在时间轴上手动创建的章节标记 */
export interface NovelMarker {
  id: string
  projectId: string
  /** 标记所在章节号 */
  chapter: number
  title: string
  /** 可选备注 */
  note: string
  /** 标记类型：书签/转折/伏笔/高潮/备注 */
  type: NovelMarkerType
  /** 标记颜色 */
  color: NovelMarkerColor
  /** clip-note 关联的实体类型（仅 type='clip-note' 时有效） */
  entityType: string | null
  /** clip-note 关联的实体 ID */
  entityId: string | null
  createdAt: number
  updatedAt: number
}
