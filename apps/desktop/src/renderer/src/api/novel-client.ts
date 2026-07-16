/**
 * 小说创作系统 API 客户端
 *
 * 所有端点位于 /api/plugins/novel 下，返回 ApiResponse 包装格式
 * （由 http-client 自动解包为 data）。
 *
 * 实体类型从 @repo/shared/novel 共享包引入（与后端共用同一份类型定义）。
 */

import { getApi, postApi, putApi, patchApi, deleteApi } from './http-client'
import { browserConfig } from '@repo/config/browser'
import { parseSseStream } from './agui-client'
import type { BaseEvent } from '@repo/protocol/events'

// ── 共享类型（re-export + 本地引用）──

import type {
  NovelProject, NovelChapter, NovelVolume, NovelCharacter,
  NovelRelationship, NovelForeshadow, NovelConflict, NovelClue,
  NovelWorldRule, NovelStyleGuide, NovelWritingStyleProfile, NovelWritingStyleProfileInput, NovelConstraint, NovelInformationLayer,
  NovelFaction, NovelLocation, NovelWorldElement,
  NovelNodePosition, NovelEdge,
  NovelCharacterHistory, NovelMarker,
  NovelHook, NovelCharacterArc,
  NovelAgentLog, NovelAgentLogSummary,
  RhythmModel, RhythmSuggestion,
  StoryStage, ChapterStatus, ChapterRhythm,
  TargetPlatform,
  NovelCharacterPlotRole,
  NovelForeshadowCategory, ForeshadowStatus, ForeshadowPlantMethod, ForeshadowRecoverMethod,
  ConflictType, ConflictStage, ConflictTier, ClimaxType, ConflictProgressionMode,
  RelationshipAlignment, RelationshipTrend,
  ConstraintType,
  NovelFactionType, NovelFactionStrength, NovelFactionStatus,
  NovelLocationType, NovelLocationSignificance, NovelLocationStatus,
  NovelWorldElementCategory, NovelEdgeType,
  CharacterHistoryField, NovelMarkerType, NovelMarkerColor,
  SimilarityGroup,
  ChapterVersion, ChapterVersionSummary, ChapterVersionDiff, ChapterVersionPhase, RollbackResult,
} from '@repo/shared/novel'

// re-export 共享类型供外部消费者使用
export * from '@repo/shared/novel'

// ── 基础路径 ──

const BASE = '/api/plugins/novel'

// ── 前端独有类型 ──

/** 冲突剧情功能位（前端别名，与后端 PlotFunction 七值枚举同义） */
export type ConflictPlotFunction =
  | 'provide_resource' | 'create_obstacle' | 'amplify_conflict'
  | 'open_phase' | 'change_judgment' | 'advance_relationship' | 'reveal_world_rule'

// ── 创建/更新载荷类型 ──

export interface CreateVolumeInput {
  volumeNumber: number
  title?: string
  outline?: string
  sortOrder?: number
}

export type UpdateVolumeInput = Partial<CreateVolumeInput>

export interface CreateProjectInput {
  title: string
  genre: string
  synopsis?: string
  targetWords?: number
  targetPlatform?: TargetPlatform
}

export type UpdateProjectInput = Partial<CreateProjectInput> & {
  currentVolume?: number
  currentChapter?: number
  currentStage?: StoryStage
  status?: 'active' | 'paused' | 'completed'
  outline?: string
  rhythmModelId?: string
  targetPlatform?: TargetPlatform | null
}

export interface CreateChapterInput {
  chapterNumber: number
  narrativeTask: {
    description: string
    type: string
    targetEntity?: string | null
    priority?: 'high' | 'medium' | 'low'
  }
  // 可选卷归属：传入则新建章节直接挂在该卷下，避免章节游离在所有卷之外
  volumeId?: string | null
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
  // ── 四层逻辑补全字段 ──
  /** 长期欲望：跨章节稳定的发动机 */
  longTermDesire?: string
  /** 角色层级：protagonist/main_opponent/supporting/function/background */
  plotRole?: NovelCharacterPlotRole
  /** 删掉影响：一句话描述"删掉这个角色哪段剧情会受影响" */
  removalImpact?: string
}

export type UpdateCharacterInput = Partial<CreateCharacterInput>

export interface CreateForeshadowInput {
  description: string
  category?: NovelForeshadowCategory
  status?: ForeshadowStatus
  firstChapter?: number | null
  lastChapter?: number | null
  recoverByChapter?: number | null
  // ── P2-2：埋设/回收方式 ──
  plantMethod?: ForeshadowPlantMethod
  recoverMethod?: ForeshadowRecoverMethod
  // ── 迁移 055：多段章节跨度 ──
  chapterSpans?: Array<[number, number]>
  /** 离散伏笔事件链（埋设/强化/揭示/回收） */
  beats?: NonNullable<NovelForeshadow['beats']>
}

export interface CreateConflictInput {
  description: string
  type: ConflictType
  intensity?: number
  stage?: ConflictStage
  /** 参与者角色 ID 列表（前端传数组，后端 JSON.stringify 后落库） */
  participants?: string[]
  chapterSpans?: Array<[number, number]>
  tier?: ConflictTier
  climaxChapter?: number | null
  climaxType?: ClimaxType | null
  relatedConflicts?: string
  stakes?: string | null
  twistPotential?: number
  // ── P2-1：冲突功能位 + 非线性推进 ──
  plotFunction?: ConflictPlotFunction
  progressionMode?: ConflictProgressionMode
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
  // ── 四层逻辑②：关系层动态字段（创建时可选，更新时单独 PATCH）──
  /** 动态功能位（本章关系承载的剧情功能） */
  dynamicRole?: string
  /** 阵营关系 */
  alignment?: RelationshipAlignment
  /** 走向 */
  trend?: RelationshipTrend
  /** 本章约束提示 */
  chapterHint?: string
}

/** 更新关系输入：所有字段可选，与后端 PATCH /relationships/:id 路由对齐
 *
 * 注意：路由层不提供 stageHistory 自动追加（那是工具层 novel_update_relationship
 * 的便捷功能，供 Memory Agent LLM 使用）。前端如需追加阶段历史，需读取
 * 当前 stageHistory JSON → push RelationChange → 整体覆盖写入。
 */
export interface UpdateRelationshipInput {
  /** 角色对（变更角色对时需保证无向匹配，避免重复创建） */
  characterA?: string
  characterB?: string
  relationType?: string
  currentStage?: string
  /** 阶段历史（JSON: RelationChange[]，整体覆盖） */
  stageHistory?: string
  // ── 动态字段 ──
  dynamicRole?: string
  alignment?: RelationshipAlignment
  trend?: RelationshipTrend
  chapterHint?: string
  /** 最后更新章节号（前端需手动维护，路由不会自动追加 stageHistory） */
  lastUpdatedChapter?: number | null
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

export type UpdateInfoLayerInput = Partial<CreateInfoLayerInput> & {
  isRevealed?: boolean
  linkedForeshadows?: string
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
  | 'info_layer'

export interface NodePositionInput {
  nodeType: NovelNodeTypeName
  entityId: string
  posX: number
  posY: number
}

// ── 画布连线 ──

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

export interface CreateCharacterHistoryInput {
  fieldName: CharacterHistoryField
  oldValue: string | null
  newValue: string | null
  reason: string | null
  chapterNumber?: number | null
}

// ── 时间轴标记 ──

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
  modelId?: string
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

// ── 章节正文版本历史 ──

export function listChapterVersions(chapterId: string): Promise<ChapterVersionSummary[]> {
  return getApi<ChapterVersionSummary[]>(`${BASE}/chapters/${chapterId}/versions`)
}

export function getChapterVersion(chapterId: string, versionId: string): Promise<ChapterVersion> {
  return getApi<ChapterVersion>(`${BASE}/chapters/${chapterId}/versions/${versionId}`)
}

export function diffChapterVersions(
  chapterId: string,
  fromVersionId: string,
  toVersionId: string,
): Promise<ChapterVersionDiff> {
  return getApi<ChapterVersionDiff>(
    `${BASE}/chapters/${chapterId}/versions/diff?from=${encodeURIComponent(fromVersionId)}&to=${encodeURIComponent(toVersionId)}`,
  )
}

export function rollbackChapter(chapterId: string, versionId: string): Promise<RollbackResult> {
  return postApi<RollbackResult>(`${BASE}/chapters/${chapterId}/versions/${versionId}/rollback`, {})
}

export function createChapterSnapshot(chapterId: string, trigger?: string): Promise<ChapterVersion> {
  return postApi<ChapterVersion>(`${BASE}/chapters/${chapterId}/versions`, { trigger })
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

/** 更新关系（PATCH /relationships/:id）
 *  与后端 updateRelationshipSchema 对齐，所有字段 optional 不覆盖未传字段 */
export function updateRelationship(id: string, input: UpdateRelationshipInput): Promise<NovelRelationship> {
  return patchApi<NovelRelationship>(`${BASE}/relationships/${id}`, input)
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

export function getWritingStyleProfile(projectId: string): Promise<NovelWritingStyleProfile | null> {
  return getApi<NovelWritingStyleProfile | null>(`${BASE}/projects/${projectId}/writing-style-profile`)
}

export function saveWritingStyleProfile(
  projectId: string,
  input: NovelWritingStyleProfileInput,
): Promise<NovelWritingStyleProfile> {
  return putApi<NovelWritingStyleProfile>(`${BASE}/projects/${projectId}/writing-style-profile`, input)
}

export interface WritingStylePromptPreview {
  profileId: string
  profileVersion: number
  profileHash: string
  target: 'writer' | 'reviser' | 'reviewer'
  content: string
}

export function getWritingStylePromptPreview(
  projectId: string,
  target: 'writer' | 'reviser' | 'reviewer' = 'writer',
): Promise<WritingStylePromptPreview | null> {
  return getApi<WritingStylePromptPreview | null>(`${BASE}/projects/${projectId}/writing-style-profile/preview?target=${target}`)
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

export function updateInfoLayer(id: string, input: UpdateInfoLayerInput): Promise<NovelInformationLayer> {
  return patchApi<NovelInformationLayer>(`${BASE}/info-layers/${id}`, input)
}

// ── P3-2：伏笔↔信息差双向关联 ──

export function linkForeshadowToInfoLayer(
  projectId: string,
  foreshadowId: string,
  infoLayerId: string,
): Promise<{ foreshadowId: string; infoLayerId: string; linked: boolean }> {
  return postApi<{ foreshadowId: string; infoLayerId: string; linked: boolean }>(
    `${BASE}/projects/${projectId}/foreshadow-info-layer-links`,
    { foreshadowId, infoLayerId },
  )
}

export function unlinkForeshadowFromInfoLayer(
  projectId: string,
  foreshadowId: string,
  infoLayerId: string,
): Promise<{ foreshadowId: string; infoLayerId: string; linked: boolean }> {
  return deleteApi<{ foreshadowId: string; infoLayerId: string; linked: boolean }>(
    `${BASE}/projects/${projectId}/foreshadow-info-layer-links?foreshadowId=${foreshadowId}&infoLayerId=${infoLayerId}`,
  )
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
 * 返回 text/event-stream，AG-UI 标准事件格式：
 *   - { type: 'CUSTOM', name: 'novel:progress', value: CharacterGenerationProgressEvent }  阶段进度
 *   - { type: 'CUSTOM', name: 'novel:result',   value: NovelCharacter }                    生成完成
 *   - { type: 'RUN_ERROR', message: string }                                              错误
 *   - { type: 'RUN_FINISHED', threadId, runId }                                           流结束
 *
 * SSE 解析复用 parseSseStream（与 chat / 创作流程统一），与 use-novel-creation-flow.ts 对齐。
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

  let result: NovelCharacter | null = null
  let streamError: string | null = null

  await parseSseStream(response.body, (event) => {
    if (event.type === 'CUSTOM') {
      const custom = event as { type: 'CUSTOM'; name: string; value: unknown }
      if (custom.name === 'novel:progress') {
        onProgress?.(custom.value as CharacterGenerationProgressEvent)
      } else if (custom.name === 'novel:result') {
        result = custom.value as NovelCharacter
      }
    } else if (event.type === 'RUN_ERROR') {
      const errEvent = event as { type: 'RUN_ERROR'; message: string }
      streamError = errEvent.message ?? 'AI 生成失败'
    }
  })

  if (streamError) {
    throw new Error(streamError)
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
  // ── P2-1：冲突功能位 + 非线性推进 ──
  plotFunction?: ConflictPlotFunction
  progressionMode?: ConflictProgressionMode
}

export interface GeneratedForeshadowFields {
  description: string
  category: NovelForeshadowCategory
  status: ForeshadowStatus
  linkedCharacters: string
  linkedClues: string
  // ── P2-2：埋设/回收方式 ──
  plantMethod?: ForeshadowPlantMethod
  recoverMethod?: ForeshadowRecoverMethod
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
 * 返回 text/event-stream，AG-UI 标准事件格式：
 *   - { type: 'CUSTOM', name: 'novel:progress', value: EntityGenerationProgressEvent }  阶段进度
 *   - { type: 'CUSTOM', name: 'novel:result',   value: GeneratedEntityResult }          生成完成（不落库）
 *   - { type: 'RUN_ERROR', message: string }                                            错误
 *   - { type: 'RUN_FINISHED', threadId, runId }                                         流结束
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

  let result: GeneratedEntityResult | null = null
  let streamError: string | null = null

  await parseSseStream(response.body, (event) => {
    if (event.type === 'CUSTOM') {
      const custom = event as { type: 'CUSTOM'; name: string; value: unknown }
      if (custom.name === 'novel:progress') {
        onProgress?.(custom.value as EntityGenerationProgressEvent)
      } else if (custom.name === 'novel:result') {
        result = custom.value as GeneratedEntityResult
      }
    } else if (event.type === 'RUN_ERROR') {
      const errEvent = event as { type: 'RUN_ERROR'; message: string }
      streamError = errEvent.message ?? 'AI 生成失败'
    }
  })

  if (streamError) {
    throw new Error(streamError)
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

// ── AI 编排（模式2：按章纲 AI 编排实体到矩阵，不生成正文） ──

/**
 * AI 编排（SSE 流式）
 *
 * 后端端点 POST /api/plugins/novel/projects/:projectId/chapters/:chapterNumber/ai-arrange
 * SSE 流内只推送 AI 编排阶段事件：
 *   - { type: 'progress', data: { type: 'arrange_start' | 'arrange_progress' | 'arrange_done', ... } }
 *   - { type: 'result', data: { status: 'completed', data: ArrangedEntities, content: '' } }
 *   - { type: 'error', error: string }
 *
 * 与 createFlow 不同，本接口不生成正文；用户确认矩阵后再单独触发 create-flow。
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

/**
 * 从正文反推实体到矩阵（SSE 流式）
 *
 * 后端端点 POST /api/plugins/novel/projects/:projectId/chapters/:chapterNumber/reverse-arrange
 * 用户手写章节正文后，调用此接口从正文提取实体并落库到矩阵。
 * SSE 事件格式与 aiArrangeFlow 一致（progress/result/error），无 checkpoint。
 */
export async function reverseArrangeFlow(
  projectId: string,
  chapterNumber: number,
  options: AiArrangeFlowOptions,
): Promise<void> {
  const url = `${browserConfig.apiBaseUrl}${BASE}/projects/${projectId}/chapters/${chapterNumber}/reverse-arrange`
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
    throw new Error(`反推实体启动失败: HTTP ${response.status} ${response.statusText}`)
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
          options.onProgress?.(payload.data)
        } else if (payload.type === 'result') {
          options.onResult?.(payload.data)
        } else if (payload.type === 'error') {
          options.onError?.(payload.error ?? '反推实体失败')
        }
      }
    }
  } catch (err) {
    if (options?.signal?.aborted) return
    throw err
  } finally {
    try {
      await reader.cancel()
    } catch { /* reader 已关闭则忽略 */ }
  }
}

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

// ── LLM 相似度扫描（SSE 流式扫描 + 独立 REST 合并）──

/**
 * 执行相似实体合并（用户在弹框中勾选的组）
 * @param projectId 项目 ID
 * @param groups 用户勾选的相似组（未勾选的不传）
 */
export function mergeSimilarityEntities(
  projectId: string,
  groups: SimilarityGroup[],
): Promise<{ totalMerged: number }> {
  return postApi<{ totalMerged: number }>(`${BASE}/projects/${projectId}/entities/merge-similarity`, { groups })
}

// ── v0.2：钩子（章尾钩子实体化，支持兑现状态追踪） ──

export function listHooks(projectId: string): Promise<NovelHook[]> {
  return getApi<NovelHook[]>(`${BASE}/projects/${projectId}/hooks`)
}

export function createHook(
  projectId: string,
  hook: Omit<NovelHook, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>,
): Promise<NovelHook> {
  return postApi<NovelHook>(`${BASE}/projects/${projectId}/hooks`, hook)
}

export function updateHook(id: string, patch: Partial<NovelHook>): Promise<NovelHook> {
  return putApi<NovelHook>(`${BASE}/hooks/${id}`, patch)
}

export function deleteHook(id: string): Promise<void> {
  return deleteApi(`${BASE}/hooks/${id}`)
}

// ── v0.2：角色弧光（独立实体，追踪角色成长/堕落/救赎/转变轨迹） ──

export function listCharacterArcs(projectId: string): Promise<NovelCharacterArc[]> {
  return getApi<NovelCharacterArc[]>(`${BASE}/projects/${projectId}/character-arcs`)
}

// ── 章节聊天（按章节持久化用户输入 + 自由聊天） ──

/** 章节聊天消息阶段 */
export type ChapterChatPhase = 'pre_creation' | 'checkpoint' | 'discussion' | 'free_chat' | 'review'

/** 章节聊天消息角色 */
export type ChapterChatRole = 'user' | 'agent' | 'system'

/** 章节聊天消息（与后端 ChapterChatMessage 对齐） */
export interface ChapterChatMessage {
  id: string
  projectId: string
  chapterNumber: number
  role: ChapterChatRole
  fromId: string
  fromName: string
  content: string
  phase: ChapterChatPhase
  metadata?: {
    checkpointId?: string
    decision?: string
    agentType?: string
    mentionedAgents?: string[]
    flowMode?: 'workflow' | 'discussion'
    discussionRunId?: string
    discussionMessageType?: string
    discussionRunStatus?: 'completed' | 'cancelled' | 'error'
    discussionCanResume?: boolean
    sceneId?: number
  }
  createdAt: number
}

/** 获取章节聊天历史（按时间升序） */
export function listChapterChat(
  projectId: string,
  chapterNumber: number,
): Promise<ChapterChatMessage[]> {
  return getApi<ChapterChatMessage[]>(`${BASE}/projects/${projectId}/chapters/${chapterNumber}/chat`)
}

/** 清空章节聊天历史 */
export function clearChapterChat(
  projectId: string,
  chapterNumber: number,
): Promise<{ cleared: boolean }> {
  return deleteApi<{ cleared: boolean }>(`${BASE}/projects/${projectId}/chapters/${chapterNumber}/chat`)
}

/** 持久化创作流程中的用户输入（启动指令/检查点反馈/群聊发言/回看聊天） */
export function persistChapterChat(
  projectId: string,
  chapterNumber: number,
  input: {
    phase: Exclude<ChapterChatPhase, 'free_chat'>
    content: string
    role?: ChapterChatRole
    fromId?: string
    fromName?: string
    metadata?: Record<string, unknown>
  },
): Promise<ChapterChatMessage> {
  return postApi<ChapterChatMessage>(`${BASE}/projects/${projectId}/chapters/${chapterNumber}/chat/persist`, {
    phase: input.phase,
    role: input.role ?? 'user',
    content: input.content,
    fromId: input.fromId ?? 'user',
    fromName: input.fromName ?? '用户',
    metadata: input.metadata,
  })
}

/** 自由聊天的 SSE 回调选项 */
export interface ChapterChatFlowOptions {
  /** AG-UI 事件回调（TEXT_MESSAGE_* / CUSTOM / RUN_FINISHED / RUN_ERROR 等） */
  onEvent: (event: BaseEvent) => void
  signal?: AbortSignal
}

/**
 * 发起章节自由聊天（SSE 流式）
 *
 * 后端端点 POST /api/plugins/novel/projects/:projectId/chapters/:chapterNumber/chat
 * - mentionedAgents 非空时，依次让被 @ 的 Agent 回复
 * - 否则由 Moderator 单轮决策选一个 Agent 回复
 *
 * 复用共享的 parseSseStream 解析 SSE 流，通过 onEvent 回调暴露所有 AG-UI 事件，
 * 与 use-novel-creation-flow 的 runFlow 模式一致：
 *   - TEXT_MESSAGE_START / CONTENT / END：Agent 流式发言
 *   - CUSTOM(novel:progress)：Agent 开始/结束发言元数据
 *   - CUSTOM(novel:result)：流程完成，含最终 replies
 *   - RUN_FINISHED / RUN_ERROR：流结束/错误
 */
export async function sendChapterChat(
  projectId: string,
  chapterNumber: number,
  message: string,
  mentionedAgents: string[] | undefined,
  options: ChapterChatFlowOptions,
): Promise<void> {
  const url = `${browserConfig.apiBaseUrl}${BASE}/projects/${projectId}/chapters/${chapterNumber}/chat`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ message, mentionedAgents }),
    signal: options.signal,
  })

  if (!response.ok) {
    throw new Error(`章节聊天启动失败: HTTP ${response.status} ${response.statusText}`)
  }
  if (!response.body) {
    throw new Error('响应体为空，无法读取 SSE 流')
  }

  await parseSseStream(response.body, options.onEvent)
}
