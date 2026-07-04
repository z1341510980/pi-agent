/**
 * 小说创作系统 API 客户端
 *
 * 所有端点位于 /api/plugins/novel 下，返回 ApiResponse 包装格式
 * （由 http-client 自动解包为 data）。
 *
 * 类型镜像后端 apps/agent-server/src/core/novel/types.ts
 */

import { getApi, postApi, putApi, patchApi, deleteApi } from './http-client'
import { browserConfig } from '@repo/config/browser'

// ── 基础路径 ──

const BASE = '/api/plugins/novel'

// ── 通用类型 ──

export type StoryStage = 'setup' | 'rising' | 'climax' | 'falling' | 'resolution'
export type ChapterStatus = 'planned' | 'drafting' | 'review' | 'published' | 'rejected'
export type ForeshadowStatus =
  | 'planned' | 'planted' | 'reinforced' | 'partially_revealed'
  | 'recovering' | 'recovered' | 'abandoned'
export type ConflictType =
  | 'inner' | 'relationship' | 'faction' | 'interest'
  | 'moral' | 'identity' | 'emotional' | 'world_rule' | 'survival'
export type ConflictStage =
  | 'latent' | 'emerging' | 'escalating' | 'erupting'
  | 'reversing' | 'resolved' | 'transformed'
export type ConflictTier = 'main' | 'secondary' | 'goal'
export type ConstraintType = 'fact' | 'cognitive' | 'stage' | 'debt' | 'arc'

// ── 节奏 / 高潮 / 悬念 类型（与后端 types.ts 对齐）──

/** 章节节奏类型 */
export type ChapterRhythm =
  | 'setup' | 'rising' | 'climax' | 'falling' | 'resolution'
  | 'twist' | 'breather' | 'suspense'

/** 高潮强度等级 */
export type ClimaxIntensity = 'minor' | 'medium' | 'major'

/** 高潮类型（五种主要高潮 + 复合高潮） */
export type ClimaxType =
  | 'emotional' | 'fate' | 'character' | 'combat' | 'theme' | 'composite'

/** 节奏序列条目（带高潮强度标注） */
export interface RhythmSequenceEntry {
  rhythm: ChapterRhythm
  climaxIntensity?: ClimaxIntensity
  climaxType?: ClimaxType
}

/** 节奏模型：定义故事弧的理想节奏序列 */
export interface RhythmModel {
  id: string
  name: string
  description: string
  sequence: RhythmSequenceEntry[]
}

/** 节奏建议 */
export interface RhythmSuggestion {
  rhythm: ChapterRhythm
  arcPosition: number
  reason: string
  description: string
  climaxIntensity?: ClimaxIntensity
  climaxType?: ClimaxType
}

/** 节奏历史记录 */
export interface RhythmHistoryEntry {
  chapterNumber: number
  rhythm: ChapterRhythm
  effectiveness: 'low' | 'medium' | 'high'
}

/** 叙事任务类型（14 种） */
export type NarrativeTaskType =
  | 'advance_mainline' | 'advance_subline' | 'create_conflict' | 'escalate_conflict'
  | 'release_info' | 'hide_info' | 'reinforce_foreshadow' | 'recover_foreshadow'
  | 'change_relationship' | 'change_cognition' | 'create_reversal' | 'create_suspense'
  | 'phase_closure' | 'introduce_problem'

/** 结构化叙事任务 */
export interface NarrativeTask {
  description: string
  type: NarrativeTaskType
  targetEntity: string | null
  priority: 'high' | 'medium' | 'low'
  expectedIntensityDelta?: number
  climaxTarget?: { type: ClimaxType; intensity: ClimaxIntensity }
  suspenseDuration?: number
}

/** 冲突推进目标 */
export interface ConflictTarget {
  conflict: NovelConflict
  targetStage: ConflictStage
  intensityDelta: number
  isClimax: boolean
}

/** 节奏约束 */
export interface RhythmConstraint {
  rhythm: ChapterRhythm
  climaxIntensity?: ClimaxIntensity
  climaxType?: ClimaxType
  description: string
  reason: string
}

/** 悬念钩子 */
export interface SuspenseHook {
  infoLayerId: string | null
  description: string
  status: 'planting' | 'sustaining' | 'releasing'
  sustainedChapters: number
  releaseByChapter: number | null
}

/** 章节约束 */
export interface ChapterConstraints {
  facts: NovelConstraint[]
  cognitive: NovelConstraint[]
  stage: NovelConstraint[]
  narrativeDebts: NovelForeshadow[]
  characterArcs: Array<{ character: NovelCharacter; allowedNextStage: string | null }>
  conflictTargets: ConflictTarget[]
  rhythmConstraint?: RhythmConstraint
  suspenseHooks: SuspenseHook[]
}

/** 本章已编排的实体约束 */
export interface ArrangedEntity {
  characterIds: string[]
  conflictIds: string[]
  foreshadowIds: string[]
  factionIds: string[]
  locationIds: string[]
}

// ── 实体类型 ──

export interface NovelProject {
  id: string
  title: string
  genre: string
  synopsis: string
  /** 全书大纲（一段文本） */
  outline?: string
  targetWords: number
  currentVolume: number
  currentChapter: number
  currentStage: StoryStage
  status: 'active' | 'paused' | 'completed'
  /** 节奏模型 ID（缺省时使用后端 RhythmController.DEFAULT_MODEL） */
  rhythmModelId?: string
  /** 移入回收站的时间戳（null 表示正常项目，非 null 表示已软删除） */
  deletedAt?: number | null
  createdAt: number
  updatedAt: number
}

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
  acceptanceResult: string | null
  /** 章节张力等级（1-10，NULL 表示未设定） */
  tension?: number | null
  /** 章节节奏（由 RhythmController 建议，可手动覆盖） */
  rhythm?: ChapterRhythm
  createdAt: number
  updatedAt: number
}

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

export interface CreateVolumeInput {
  volumeNumber: number
  title?: string
  outline?: string
  sortOrder?: number
}

export type UpdateVolumeInput = Partial<CreateVolumeInput>

export interface NovelCharacter {
  id: string
  projectId: string
  name: string
  description: string
  identity: string
  personality: string
  appearance: string
  currentState: string
  currentGoal: string
  currentPressure: string
  secret: string
  arcStage: string
  arcHistory: string
  speechStyle: string
  isProtagonist: boolean
  createdAt: number
  updatedAt: number
}

export interface NovelRelationship {
  id: string
  projectId: string
  characterA: string
  characterB: string
  relationType: string
  currentStage: string
  stageHistory: string
  createdAt: number
  updatedAt: number
}

export interface NovelForeshadow {
  id: string
  projectId: string
  description: string
  category: string
  status: ForeshadowStatus
  firstChapter: number | null
  lastChapter: number | null
  recoverByChapter: number | null
  linkedCharacters: string
  linkedClues: string
  createdAt: number
  updatedAt: number
}

export interface NovelClue {
  id: string
  projectId: string
  description: string
  pointsTo: string
  progress: number
  currentStep: string
  nextStep: string
  isMisleading: boolean
  linkedForeshadow: string | null
  createdAt: number
  updatedAt: number
}

export interface NovelConflict {
  id: string
  projectId: string
  description: string
  type: ConflictType
  intensity: number
  stage: ConflictStage
  participants: string
  chapterSpans: Array<[number, number]>
  tier: ConflictTier
  /** 预计爆发章节（高潮目标章节） */
  climaxChapter?: number | null
  /** 高潮类型建议（该冲突推向高潮时的预期高潮种类） */
  climaxType?: ClimaxType | null
  /** 关联冲突 ID 列表（冲突网编织，JSON: string[]） */
  relatedConflicts?: string
  /** 赌注/代价（冲突失败或成功后的代价） */
  stakes?: string | null
  /** 突转潜力（0-10，越高越适合安排突转） */
  twistPotential?: number
  createdAt: number
  updatedAt: number
}

export interface NovelWorldRule {
  id: string
  projectId: string
  category: string
  rule: string
  cost: string | null
  isFixed: boolean
  createdAt: number
  updatedAt: number
}

export interface NovelStyleGuide {
  id: string
  projectId: string
  category: string
  rule: string
  example: string | null
  createdAt: number
  updatedAt: number
}

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

export interface NovelInformationLayer {
  id: string
  projectId: string
  infoDescription: string
  authorKnows: boolean
  readerKnows: boolean
  characterKnowledge: string
  revealStage: string | null
  revealChapter: number | null
  isRevealed: boolean
  createdAt: number
  updatedAt: number
}

// ── 势力 / 地点 / 世界观要素 ──

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
  allies: string[]
  enemies: string[]
  status: NovelFactionStatus
  chapterSpans: Array<[number, number]>
  createdAt: number
  updatedAt: number
}

export type NovelLocationType =
  | 'continent' | 'country' | 'city' | 'building'
  | 'dungeon' | 'region' | 'wilderness'
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
  appearChapters: number[]
  status: NovelLocationStatus
  createdAt: number
  updatedAt: number
}

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

// ── 创建/更新载荷类型 ──

export interface CreateProjectInput {
  title: string
  genre: string
  synopsis?: string
  targetWords?: number
}

export type UpdateProjectInput = Partial<CreateProjectInput> & {
  currentVolume?: number
  currentChapter?: number
  currentStage?: StoryStage
  status?: 'active' | 'paused' | 'completed'
  outline?: string
  rhythmModelId?: string
}

export interface CreateChapterInput {
  chapterNumber: number
  narrativeTask: {
    description: string
    type: string
    targetEntity?: string | null
    priority?: 'high' | 'medium' | 'low'
  }
}

export interface UpdateChapterInput {
  title?: string
  content?: string
  status?: ChapterStatus
  outline?: string
  volumeId?: string | null
  rhythm?: ChapterRhythm
}

export interface CompleteChapterInput {
  content: string
  title?: string
}

export interface CreateCharacterInput {
  name: string
  description?: string
  identity?: string
  personality?: string
  appearance?: string
  currentState?: string
  currentGoal?: string
  currentPressure?: string
  secret?: string
  arcStage?: string
  speechStyle?: string
  isProtagonist?: boolean
}

export type UpdateCharacterInput = Partial<CreateCharacterInput>

export interface CreateForeshadowInput {
  description: string
  category?: string
  status?: ForeshadowStatus
  firstChapter?: number | null
  lastChapter?: number | null
  recoverByChapter?: number | null
}

export interface CreateConflictInput {
  description: string
  type: ConflictType
  intensity?: number
  stage?: ConflictStage
  chapterSpans?: Array<[number, number]>
  tier?: ConflictTier
  climaxChapter?: number | null
  climaxType?: ClimaxType | null
  relatedConflicts?: string
  stakes?: string | null
  twistPotential?: number
}

export interface CreateClueInput {
  description: string
  pointsTo?: string
  progress?: number
  currentStep?: string
  nextStep?: string
  isMisleading?: boolean
  linkedForeshadow?: string | null
}

export interface CreateRelationshipInput {
  characterA: string
  characterB: string
  relationType: string
  currentStage?: string
}

export interface CreateWorldRuleInput {
  category: string
  rule: string
  cost?: string | null
  isFixed?: boolean
}

export interface CreateStyleGuideInput {
  category: string
  rule: string
  example?: string | null
}

export interface CreateConstraintInput {
  type: ConstraintType
  scope?: 'global' | 'volume' | 'chapter'
  rule: string
  relatedEntityId?: string | null
}

export interface CreateInfoLayerInput {
  infoDescription: string
  authorKnows?: boolean
  readerKnows?: boolean
  revealStage?: string | null
  revealChapter?: number | null
}

export interface CreateFactionInput {
  name: string
  description?: string
  type?: NovelFactionType
  leaderId?: string | null
  ideology?: string
  strength?: NovelFactionStrength
  resources?: string[]
  allies?: string[]
  enemies?: string[]
  status?: NovelFactionStatus
  chapterSpans?: Array<[number, number]>
}

export type UpdateFactionInput = Partial<CreateFactionInput>

export interface CreateLocationInput {
  name: string
  description?: string
  type?: NovelLocationType
  parentId?: string | null
  factionId?: string | null
  significance?: NovelLocationSignificance
  firstChapter?: number | null
  appearChapters?: number[]
  status?: NovelLocationStatus
}

export type UpdateLocationInput = Partial<CreateLocationInput>

export interface CreateWorldElementInput {
  category: NovelWorldElementCategory
  name: string
  description?: string
  parentId?: string | null
  attributes?: Record<string, unknown>
}

export type UpdateWorldElementInput = Partial<CreateWorldElementInput>

// ── 节点位置 ──

export type NovelNodeTypeName =
  | 'project' | 'character' | 'chapter'
  | 'conflict' | 'foreshadow' | 'group'
  | 'faction' | 'location' | 'world_element'

export interface NovelNodePosition {
  id: string
  projectId: string
  nodeType: NovelNodeTypeName
  entityId: string
  posX: number
  posY: number
  updatedAt: number
}

export interface NodePositionInput {
  nodeType: NovelNodeTypeName
  entityId: string
  posX: number
  posY: number
}

// ── 画布连线 ──

export type NovelEdgeType =
  | 'appearance' | 'relationship' | 'involvement' | 'foreshadow'
  | 'base' | 'member' | 'hierarchy' | 'association'
  | 'mentor' | 'kinship' | 'rivalry' | 'alliance' | 'subordinate' | 'trigger' | 'causality'

export interface NovelEdge {
  id: string
  projectId: string
  sourceId: string
  sourceType: NovelNodeTypeName
  targetId: string
  targetType: NovelNodeTypeName
  edgeType: NovelEdgeType
  label: string
  /** true=自动生成, false=手动创建 */
  auto: boolean
  createdAt: number
  updatedAt: number
}

export interface CreateEdgeInput {
  sourceId: string
  sourceType: NovelNodeTypeName
  targetId: string
  targetType: NovelNodeTypeName
  edgeType: NovelEdgeType
  label?: string
  auto?: boolean
}

// ── 角色历史 ──

export type CharacterHistoryField =
  | 'currentState' | 'currentGoal' | 'currentPressure'
  | 'secret' | 'arcStage'

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

export interface CreateCharacterHistoryInput {
  fieldName: CharacterHistoryField
  oldValue: string | null
  newValue: string | null
  reason: string | null
  chapterNumber?: number | null
}

// ── 时间轴标记 ──

export type NovelMarkerType =
  | 'bookmark' | 'turning-point' | 'foreshadow' | 'climax' | 'note'
  | 'clip-note'

export type NovelMarkerColor = 'blue' | 'yellow' | 'green' | 'red' | 'purple'

export interface NovelMarker {
  id: string
  projectId: string
  chapter: number
  title: string
  note: string
  type: NovelMarkerType
  color: NovelMarkerColor
  entityType: string | null
  entityId: string | null
  createdAt: number
  updatedAt: number
}

export interface CreateMarkerInput {
  chapter: number
  title?: string
  note?: string
  type?: NovelMarkerType
  color?: NovelMarkerColor
  entityType?: string | null
  entityId?: string | null
}

export type UpdateMarkerInput = Partial<CreateMarkerInput>

// ── AI 角色生成 ──

export interface AiGenerateCharacterInput {
  coreStyle: string
}

/** 角色生成进度事件（镜像后端 CharacterGenerationProgressEvent） */
export interface CharacterGenerationProgressEvent {
  phase: 'preparing' | 'generating' | 'parsing' | 'completed' | 'fallback'
  message: string
  data?: unknown
}

// ── Projects ──

export function listProjects(): Promise<NovelProject[]> {
  return getApi<NovelProject[]>(`${BASE}/projects`)
}

export function getProject(id: string): Promise<NovelProject> {
  return getApi<NovelProject>(`${BASE}/projects/${id}`)
}

export function createProject(input: CreateProjectInput): Promise<NovelProject> {
  return postApi<NovelProject>(`${BASE}/projects`, input)
}

export function updateProject(id: string, input: UpdateProjectInput): Promise<NovelProject> {
  return patchApi<NovelProject>(`${BASE}/projects/${id}`, input)
}

/** 删除项目（软删除，移入回收站，可恢复） */
export function deleteProject(id: string): Promise<{ id: string; trashed: boolean }> {
  return deleteApi<{ id: string; trashed: boolean }>(`${BASE}/projects/${id}`)
}

/** 列出回收站中的项目 */
export function listTrashedProjects(): Promise<NovelProject[]> {
  return getApi<{ projects: NovelProject[] }>(`${BASE}/projects/trash`).then((r) => r.projects)
}

/** 恢复项目（从回收站移回正常列表） */
export function restoreProject(id: string): Promise<{ id: string; restored: boolean }> {
  return postApi<{ id: string; restored: boolean }>(`${BASE}/projects/${id}/restore`, {})
}

/** 永久删除项目（不可恢复） */
export function purgeProject(id: string): Promise<{ id: string; purged: boolean }> {
  return deleteApi<{ id: string; purged: boolean }>(`${BASE}/projects/${id}/purge`)
}

/** 清空回收站（永久删除所有已删除项目） */
export function emptyTrash(): Promise<{ emptied: boolean; count: number }> {
  return deleteApi<{ emptied: boolean; count: number }>(`${BASE}/projects/trash/empty`)
}

// ── Chapters ──

export function listChapters(projectId: string): Promise<NovelChapter[]> {
  return getApi<NovelChapter[]>(`${BASE}/projects/${projectId}/chapters`)
}

export function getChapter(id: string): Promise<NovelChapter> {
  return getApi<NovelChapter>(`${BASE}/chapters/${id}`)
}

export function createChapter(projectId: string, input: CreateChapterInput): Promise<NovelChapter> {
  return postApi<NovelChapter>(`${BASE}/projects/${projectId}/chapters`, input)
}

export function updateChapter(id: string, input: UpdateChapterInput): Promise<NovelChapter> {
  return patchApi<NovelChapter>(`${BASE}/chapters/${id}`, input)
}

export function completeChapter(id: string, input: CompleteChapterInput): Promise<NovelChapter> {
  return postApi<NovelChapter>(`${BASE}/chapters/${id}/complete`, input)
}

export function publishChapter(id: string): Promise<NovelChapter> {
  return postApi<NovelChapter>(`${BASE}/chapters/${id}/publish`, {})
}

export function deleteChapter(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/chapters/${id}`)
}

// ── Volumes ──

export function listVolumes(projectId: string): Promise<NovelVolume[]> {
  return getApi<NovelVolume[]>(`${BASE}/projects/${projectId}/volumes`)
}

export function createVolume(projectId: string, input: CreateVolumeInput): Promise<NovelVolume> {
  return postApi<NovelVolume>(`${BASE}/projects/${projectId}/volumes`, input)
}

export function updateVolume(id: string, input: UpdateVolumeInput): Promise<NovelVolume> {
  return patchApi<NovelVolume>(`${BASE}/volumes/${id}`, input)
}

export function deleteVolume(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/volumes/${id}`)
}

// ── Characters ──

export function listCharacters(projectId: string): Promise<NovelCharacter[]> {
  return getApi<NovelCharacter[]>(`${BASE}/projects/${projectId}/characters`)
}

export function createCharacter(projectId: string, input: CreateCharacterInput): Promise<NovelCharacter> {
  return postApi<NovelCharacter>(`${BASE}/projects/${projectId}/characters`, input)
}

export function updateCharacter(id: string, input: UpdateCharacterInput): Promise<NovelCharacter> {
  return patchApi<NovelCharacter>(`${BASE}/characters/${id}`, input)
}

export function deleteCharacter(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/characters/${id}`)
}

// ── Relationships ──

export function listRelationships(projectId: string): Promise<NovelRelationship[]> {
  return getApi<NovelRelationship[]>(`${BASE}/projects/${projectId}/relationships`)
}

export function createRelationship(projectId: string, input: CreateRelationshipInput): Promise<NovelRelationship> {
  return postApi<NovelRelationship>(`${BASE}/projects/${projectId}/relationships`, input)
}

export function deleteRelationship(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/relationships/${id}`)
}

// ── Foreshadowing ──

export function listForeshadowing(projectId: string): Promise<NovelForeshadow[]> {
  return getApi<NovelForeshadow[]>(`${BASE}/projects/${projectId}/foreshadowing`)
}

export function createForeshadow(projectId: string, input: CreateForeshadowInput): Promise<NovelForeshadow> {
  return postApi<NovelForeshadow>(`${BASE}/projects/${projectId}/foreshadowing`, input)
}

export function deleteForeshadow(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/foreshadowing/${id}`)
}

export function updateForeshadow(id: string, input: Partial<CreateForeshadowInput>): Promise<NovelForeshadow> {
  return patchApi<NovelForeshadow>(`${BASE}/foreshadowing/${id}`, input)
}

// ── Conflicts ──

export function listConflicts(projectId: string): Promise<NovelConflict[]> {
  return getApi<NovelConflict[]>(`${BASE}/projects/${projectId}/conflicts`)
}

export function createConflict(projectId: string, input: CreateConflictInput): Promise<NovelConflict> {
  return postApi<NovelConflict>(`${BASE}/projects/${projectId}/conflicts`, input)
}

export function deleteConflict(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/conflicts/${id}`)
}

export function updateConflict(id: string, input: Partial<CreateConflictInput>): Promise<NovelConflict> {
  return patchApi<NovelConflict>(`${BASE}/conflicts/${id}`, input)
}

// ── Clues ──

export function listClues(projectId: string): Promise<NovelClue[]> {
  return getApi<NovelClue[]>(`${BASE}/projects/${projectId}/clues`)
}

export function createClue(projectId: string, input: CreateClueInput): Promise<NovelClue> {
  return postApi<NovelClue>(`${BASE}/projects/${projectId}/clues`, input)
}

export function deleteClue(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/clues/${id}`)
}

// ── World Rules ──

export function listWorldRules(projectId: string): Promise<NovelWorldRule[]> {
  return getApi<NovelWorldRule[]>(`${BASE}/projects/${projectId}/world-rules`)
}

export function createWorldRule(projectId: string, input: CreateWorldRuleInput): Promise<NovelWorldRule> {
  return postApi<NovelWorldRule>(`${BASE}/projects/${projectId}/world-rules`, input)
}

export function deleteWorldRule(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/world-rules/${id}`)
}

// ── Style Guides ──

export function listStyleGuides(projectId: string): Promise<NovelStyleGuide[]> {
  return getApi<NovelStyleGuide[]>(`${BASE}/projects/${projectId}/style-guides`)
}

export function createStyleGuide(projectId: string, input: CreateStyleGuideInput): Promise<NovelStyleGuide> {
  return postApi<NovelStyleGuide>(`${BASE}/projects/${projectId}/style-guides`, input)
}

export function deleteStyleGuide(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/style-guides/${id}`)
}

// ── Constraints ──

export function listConstraints(projectId: string): Promise<NovelConstraint[]> {
  return getApi<NovelConstraint[]>(`${BASE}/projects/${projectId}/constraints`)
}

export function createConstraint(projectId: string, input: CreateConstraintInput): Promise<NovelConstraint> {
  return postApi<NovelConstraint>(`${BASE}/projects/${projectId}/constraints`, input)
}

export function deleteConstraint(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/constraints/${id}`)
}

// ── Info Layers ──

export function listInfoLayers(projectId: string): Promise<NovelInformationLayer[]> {
  return getApi<NovelInformationLayer[]>(`${BASE}/projects/${projectId}/info-layers`)
}

export function createInfoLayer(projectId: string, input: CreateInfoLayerInput): Promise<NovelInformationLayer> {
  return postApi<NovelInformationLayer>(`${BASE}/projects/${projectId}/info-layers`, input)
}

export function deleteInfoLayer(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/info-layers/${id}`)
}

// ── Factions ──

export function listFactions(projectId: string): Promise<NovelFaction[]> {
  return getApi<NovelFaction[]>(`${BASE}/projects/${projectId}/factions`)
}

export function createFaction(projectId: string, input: CreateFactionInput): Promise<NovelFaction> {
  return postApi<NovelFaction>(`${BASE}/projects/${projectId}/factions`, input)
}

export function updateFaction(id: string, input: UpdateFactionInput): Promise<NovelFaction> {
  return patchApi<NovelFaction>(`${BASE}/factions/${id}`, input)
}

export function deleteFaction(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/factions/${id}`)
}

// ── Locations ──

export function listLocations(projectId: string): Promise<NovelLocation[]> {
  return getApi<NovelLocation[]>(`${BASE}/projects/${projectId}/locations`)
}

export function createLocation(projectId: string, input: CreateLocationInput): Promise<NovelLocation> {
  return postApi<NovelLocation>(`${BASE}/projects/${projectId}/locations`, input)
}

export function updateLocation(id: string, input: UpdateLocationInput): Promise<NovelLocation> {
  return patchApi<NovelLocation>(`${BASE}/locations/${id}`, input)
}

export function deleteLocation(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/locations/${id}`)
}

// ── World Elements ──

export function listWorldElements(projectId: string): Promise<NovelWorldElement[]> {
  return getApi<NovelWorldElement[]>(`${BASE}/projects/${projectId}/world-elements`)
}

export function createWorldElement(projectId: string, input: CreateWorldElementInput): Promise<NovelWorldElement> {
  return postApi<NovelWorldElement>(`${BASE}/projects/${projectId}/world-elements`, input)
}

export function updateWorldElement(id: string, input: UpdateWorldElementInput): Promise<NovelWorldElement> {
  return patchApi<NovelWorldElement>(`${BASE}/world-elements/${id}`, input)
}

export function deleteWorldElement(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/world-elements/${id}`)
}

// ── Node Positions ──

export function listNodePositions(projectId: string): Promise<NovelNodePosition[]> {
  return getApi<NovelNodePosition[]>(`${BASE}/projects/${projectId}/node-positions`)
}

export function upsertNodePositions(
  projectId: string,
  positions: NodePositionInput[],
): Promise<{ updated: number }> {
  return putApi<{ updated: number }>(`${BASE}/projects/${projectId}/node-positions`, { positions })
}

export function deleteNodePosition(
  projectId: string,
  nodeType: NovelNodeTypeName,
  entityId: string,
): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/projects/${projectId}/node-positions/${nodeType}/${entityId}`)
}

// ── Edges（画布连线持久化）──

export function listEdges(projectId: string): Promise<NovelEdge[]> {
  return getApi<NovelEdge[]>(`${BASE}/projects/${projectId}/edges`)
}

export function createEdge(projectId: string, input: CreateEdgeInput): Promise<NovelEdge> {
  return postApi<NovelEdge>(`${BASE}/projects/${projectId}/edges`, input)
}

export function deleteEdge(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/edges/${id}`)
}

// ── AI Character Generation ──

/**
 * AI 角色生成（SSE 流式）
 *
 * 后端端点 POST /api/plugins/novel/projects/:projectId/characters/ai-generate
 * 返回 text/event-stream，事件格式：
 *   - { type: 'progress', data: CharacterGenerationProgressEvent }  阶段进度
 *   - { type: 'result',   data: NovelCharacter }                   生成完成
 *   - { type: 'error',    error: string }                          错误
 *
 * SSE 消费参考 use-novel-creation-flow.ts 中的 consumeStream 实现。
 */
export async function aiGenerateCharacter(
  projectId: string,
  input: AiGenerateCharacterInput,
  onProgress?: (event: CharacterGenerationProgressEvent) => void,
): Promise<NovelCharacter> {
  const url = `${browserConfig.apiBaseUrl}${BASE}/projects/${projectId}/characters/ai-generate`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error(`AI 生成失败: HTTP ${response.status} ${response.statusText}`)
  }
  if (!response.body) {
    throw new Error('响应体为空，无法读取 SSE 流')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: NovelCharacter | null = null

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    // SSE 以双换行分隔事件块
    let newlineIdx: number
    while ((newlineIdx = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, newlineIdx)
      buffer = buffer.slice(newlineIdx + 2)

      // 解析事件块中的 data: 行（忽略注释行 ": keepalive"）
      const dataLines = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())

      if (dataLines.length === 0) continue

      let payload: { type: string; data?: unknown; error?: string } | null = null
      try {
        payload = JSON.parse(dataLines.join('\n')) as { type: string; data?: unknown; error?: string }
      } catch {
        continue
      }
      if (!payload) continue

      if (payload.type === 'progress') {
        onProgress?.(payload.data as CharacterGenerationProgressEvent)
      } else if (payload.type === 'result') {
        result = payload.data as NovelCharacter
      } else if (payload.type === 'error') {
        throw new Error(payload.error ?? 'AI 生成失败')
      }
    }
  }

  if (!result) {
    throw new Error('AI 生成未返回结果')
  }
  return result
}

// ── AI 通用实体生成 ──

export type EntityGenerationType = 'character' | 'conflict' | 'foreshadow' | 'faction' | 'location' | 'world_element'

export interface AiGenerateEntityInput {
  entityType: EntityGenerationType
  coreStyle: string
}

/** 实体生成进度事件（镜像后端 EntityGenerationProgressEvent） */
export interface EntityGenerationProgressEvent {
  phase: 'preparing' | 'generating' | 'parsing' | 'completed' | 'fallback'
  message: string
  data?: unknown
}

/** character 生成结果字段 */
export interface GeneratedCharacterFields {
  name: string
  description: string
  identity: string
  personality: string
  appearance: string
  currentState: string
  currentGoal: string
  currentPressure: string
  secret: string
  arcStage: string
  speechStyle: string
}

export interface GeneratedConflictFields {
  description: string
  type: ConflictType
  intensity: number
  stage: ConflictStage
  tier: ConflictTier
  participants: string
  climaxChapter?: number | null
  climaxType?: ClimaxType | null
  stakes?: string | null
  twistPotential?: number
}

export interface GeneratedForeshadowFields {
  description: string
  category: string
  status: ForeshadowStatus
  linkedCharacters: string
  linkedClues: string
}

export interface GeneratedFactionFields {
  name: string
  description: string
  type: NovelFactionType
  ideology: string
  strength: NovelFactionStrength
  resources: string[]
  allies: string[]
  enemies: string[]
  status: NovelFactionStatus
}

export interface GeneratedLocationFields {
  name: string
  description: string
  type: NovelLocationType
  significance: NovelLocationSignificance
  status: NovelLocationStatus
}

export interface GeneratedWorldElementFields {
  category: NovelWorldElementCategory
  name: string
  description: string
  attributes: Record<string, unknown>
}

/** 后端返回的生成结果联合（按 type 区分） */
export type GeneratedEntityResult =
  | { type: 'character'; data: GeneratedCharacterFields }
  | { type: 'conflict'; data: GeneratedConflictFields }
  | { type: 'foreshadow'; data: GeneratedForeshadowFields }
  | { type: 'faction'; data: GeneratedFactionFields }
  | { type: 'location'; data: GeneratedLocationFields }
  | { type: 'world_element'; data: GeneratedWorldElementFields }

/**
 * AI 通用实体生成（SSE 流式）
 *
 * 后端端点 POST /api/plugins/novel/projects/:projectId/entities/ai-generate
 * 返回 text/event-stream，事件格式：
 *   - { type: 'progress', data: EntityGenerationProgressEvent }  阶段进度
 *   - { type: 'result',   data: GeneratedEntityResult }          生成完成（不落库）
 *   - { type: 'error',    error: string }                       错误
 *
 * 注意：与 aiGenerateCharacter 不同，本接口返回字段不落库，
 * 前端 review 后调对应的 createXxx 落库。
 */
export async function aiGenerateEntity(
  projectId: string,
  input: AiGenerateEntityInput,
  onProgress?: (event: EntityGenerationProgressEvent) => void,
): Promise<GeneratedEntityResult> {
  const url = `${browserConfig.apiBaseUrl}${BASE}/projects/${projectId}/entities/ai-generate`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error(`AI 生成失败: HTTP ${response.status} ${response.statusText}`)
  }
  if (!response.body) {
    throw new Error('响应体为空，无法读取 SSE 流')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: GeneratedEntityResult | null = null

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    let newlineIdx: number
    while ((newlineIdx = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, newlineIdx)
      buffer = buffer.slice(newlineIdx + 2)

      const dataLines = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())

      if (dataLines.length === 0) continue

      let payload: { type: string; data?: unknown; error?: string } | null = null
      try {
        payload = JSON.parse(dataLines.join('\n')) as { type: string; data?: unknown; error?: string }
      } catch {
        continue
      }
      if (!payload) continue

      if (payload.type === 'progress') {
        onProgress?.(payload.data as EntityGenerationProgressEvent)
      } else if (payload.type === 'result') {
        result = payload.data as GeneratedEntityResult
      } else if (payload.type === 'error') {
        throw new Error(payload.error ?? 'AI 生成失败')
      }
    }
  }

  if (!result) {
    throw new Error('AI 生成未返回结果')
  }
  return result
}

// ── Character History ──

export function listCharacterHistory(
  projectId: string,
  characterId: string,
): Promise<NovelCharacterHistory[]> {
  return getApi<NovelCharacterHistory[]>(`${BASE}/projects/${projectId}/characters/${characterId}/history`)
}

/** 项目级角色历史：用于 data_changed SSE 事件后全量刷新 */
export function listProjectCharacterHistory(
  projectId: string,
): Promise<NovelCharacterHistory[]> {
  return getApi<NovelCharacterHistory[]>(`${BASE}/projects/${projectId}/character-history`)
}

export function createCharacterHistory(
  projectId: string,
  characterId: string,
  input: CreateCharacterHistoryInput,
): Promise<NovelCharacterHistory> {
  return postApi<NovelCharacterHistory>(`${BASE}/projects/${projectId}/characters/${characterId}/history`, input)
}

/** 删除单条角色历史记录 */
export function deleteCharacterHistory(
  projectId: string,
  historyId: string,
): Promise<void> {
  return deleteApi(`${BASE}/projects/${projectId}/character-history/${historyId}`)
}

/** 批量创建角色历史（用于时间轴补全功能） */
export function batchCreateCharacterHistory(
  projectId: string,
  records: Array<{ characterId: string; chapterNumber: number }>,
): Promise<NovelCharacterHistory[]> {
  return postApi<NovelCharacterHistory[]>(`${BASE}/projects/${projectId}/character-history/batch`, { records })
}

// ── Checkpoint Decision（多 Agent 创作流程检查点） ──

/**
 * 提交检查点决策。
 * @param checkpointId 后端 ConfirmationManager 生成的决策请求 ID（UUID），
 *                     由 novel:checkpoint 事件的 checkpointId 字段提供。
 *                     早期实现误用 checkpoint.type（如 'narrative_task'），
 *                     后端路由期望的是 UUID，会返回 404。
 */
export function submitCheckpointDecision(
  projectId: string,
  checkpointId: string,
  decision: string,
  userMessages?: string[],
): Promise<{ ok: boolean }> {
  return postApi<{ ok: boolean }>(`${BASE}/projects/${projectId}/checkpoint/${checkpointId}/decision`, {
    decision,
    userMessages,
  })
}

// ── AI 编排生成（模式2：按章纲 AI 编排实体 + 衔接 create-flow 生成正文） ──

/**
 * AI 编排生成（SSE 流式）
 *
 * 后端端点 POST /api/plugins/novel/projects/:projectId/chapters/:chapterNumber/ai-arrange
 * 同一 SSE 流内依次推送：
 *   阶段1（AI 编排）:
 *     - { type: 'progress', data: { type: 'arrange_start' | 'arrange_progress' | 'arrange_done', ... } }
 *   阶段2（create-flow 衔接）:
 *     - { type: 'progress',  data: CreationFlowEvent }   阶段变更/Agent 事件
 *     - { type: 'checkpoint', data: CheckpointData }      等待用户决策
 *     - { type: 'result',     data: CreationResult }      流程结束
 *     - { type: 'error',      error: string }             错误
 *
 * 与 createFlow 不同，本接口不需要前端传 arrangedEntities（由后端 AI 编排产出），
 * SSE 事件格式与 createFlow 兼容（progress/checkpoint/result/error），前端可复用同一 handleMessage。
 */
export interface AiArrangeFlowOptions {
  onProgress?: (event: unknown) => void
  onCheckpoint?: (checkpoint: unknown) => void
  onResult?: (result: unknown) => void
  onError?: (error: string) => void
  signal?: AbortSignal
}

export async function aiArrangeFlow(
  projectId: string,
  chapterNumber: number,
  options: AiArrangeFlowOptions,
): Promise<void> {
  const url = `${browserConfig.apiBaseUrl}${BASE}/projects/${projectId}/chapters/${chapterNumber}/ai-arrange`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({}),
    signal: options.signal,
  })

  if (!response.ok) {
    throw new Error(`AI 编排启动失败: HTTP ${response.status} ${response.statusText}`)
  }
  if (!response.body) {
    throw new Error('响应体为空，无法读取 SSE 流')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // SSE 以双换行分隔事件块
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 2)

        // 解析事件块中的 data: 行（忽略注释行 ": keepalive"）
        const dataLines = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())

        if (dataLines.length === 0) continue

        let payload: { type: string; data?: unknown; error?: string } | null = null
        try {
          payload = JSON.parse(dataLines.join('\n')) as { type: string; data?: unknown; error?: string }
        } catch {
          continue
        }
        if (!payload) continue

        if (payload.type === 'progress') {
          options.onProgress?.(payload.data)
        } else if (payload.type === 'checkpoint') {
          options.onCheckpoint?.(payload.data)
        } else if (payload.type === 'result') {
          options.onResult?.(payload.data)
        } else if (payload.type === 'error') {
          options.onError?.(payload.error ?? 'AI 编排失败')
        }
      }
    }
  } catch (err) {
    // 用户主动取消（abort）静默处理，不抛出
    if (options?.signal?.aborted) return
    throw err
  } finally {
    try {
      await reader.cancel()
    } catch { /* reader 已关闭则忽略 */ }
  }
}

// ── 缓存诊断 ──

export interface CacheDiagnostics {
  systemPromptHashes: Record<string, string>
  chapterContextHash?: string
  agentTypes: string[]
  timestamp: number
}

export function getCacheDiagnostics(
  projectId: string,
  chapterNumber?: number,
): Promise<CacheDiagnostics> {
  const query = chapterNumber != null ? `?chapterNumber=${chapterNumber}` : ''
  return getApi<CacheDiagnostics>(`${BASE}/projects/${projectId}/cache-diagnostics${query}`)
}

// ── Agent 调用日志 ──

export type NovelAgentLogStatus = 'success' | 'error' | 'cancelled'

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

export interface ListAgentLogsParams {
  chapterNumber?: number
  agentType?: string
  limit?: number
}

export function listAgentLogs(
  projectId: string,
  params?: ListAgentLogsParams,
): Promise<NovelAgentLogSummary[]> {
  const qs: string[] = []
  if (params?.chapterNumber != null) qs.push(`chapterNumber=${params.chapterNumber}`)
  if (params?.agentType) qs.push(`agentType=${encodeURIComponent(params.agentType)}`)
  if (params?.limit != null) qs.push(`limit=${params.limit}`)
  const query = qs.length > 0 ? `?${qs.join('&')}` : ''
  return getApi<NovelAgentLogSummary[]>(`${BASE}/projects/${projectId}/agent-logs${query}`)
}

export function getAgentLog(id: string): Promise<NovelAgentLog> {
  return getApi<NovelAgentLog>(`${BASE}/agent-logs/${id}`)
}

export function deleteAgentLogs(projectId: string): Promise<{ projectId: string; deleted: number }> {
  return deleteApi<{ projectId: string; deleted: number }>(`${BASE}/projects/${projectId}/agent-logs`)
}

// ── 节奏模型与建议 ──

/** 列出所有可用节奏模型（后端 RhythmController.MODELS） */
export function listRhythmModels(): Promise<RhythmModel[]> {
  return getApi<RhythmModel[]>(`${BASE}/rhythm-models`)
}

/** 获取下一章节奏建议（不传 chapterNumber 时默认下一章） */
export function getRhythmSuggestion(
  projectId: string,
  chapterNumber?: number,
): Promise<RhythmSuggestion> {
  const query = chapterNumber != null ? `?chapterNumber=${chapterNumber}` : ''
  return getApi<RhythmSuggestion>(`${BASE}/projects/${projectId}/rhythm-suggestion${query}`)
}

// ── Markers ──

export function listMarkers(projectId: string): Promise<NovelMarker[]> {
  return getApi<NovelMarker[]>(`${BASE}/projects/${projectId}/markers`)
}

export function createMarker(projectId: string, input: CreateMarkerInput): Promise<NovelMarker> {
  return postApi<NovelMarker>(`${BASE}/projects/${projectId}/markers`, input)
}

export function updateMarker(id: string, input: UpdateMarkerInput): Promise<NovelMarker> {
  return patchApi<NovelMarker>(`${BASE}/markers/${id}`, input)
}

export function deleteMarker(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/markers/${id}`)
}
