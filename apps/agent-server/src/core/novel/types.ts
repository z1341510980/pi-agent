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
  targetWords: number
  currentVolume: number
  currentChapter: number
  currentStage: StoryStage
  status: 'active' | 'paused' | 'completed'
  createdAt: number
  updatedAt: number
}

export type StoryStage = 'setup' | 'rising' | 'climax' | 'falling' | 'resolution'

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
  acceptanceResult: string | null // JSON
  createdAt: number
  updatedAt: number
}

export type ChapterStatus = 'planned' | 'drafting' | 'review' | 'published' | 'rejected'

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
  createdAt: number
  updatedAt: number
}

export type ConflictType =
  | 'inner' | 'relationship' | 'faction' | 'interest'
  | 'moral' | 'identity' | 'emotional' | 'world_rule' | 'survival'

export type ConflictStage =
  | 'latent' | 'emerging' | 'escalating' | 'erupting'
  | 'reversing' | 'resolved' | 'transformed'

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

export interface NovelNodePosition {
  id: string
  projectId: string
  nodeType: NovelNodeType
  entityId: string
  posX: number
  posY: number
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
