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
  NovelFaction, NovelLocation, NovelWorldElement, NovelItem, NovelNarrative,
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
  NovelItemType, NovelItemStatus,
  CharacterHistoryField, NovelMarkerType, NovelMarkerColor,
  SimilarityGroup,
  ChapterVersion, ChapterVersionSummary, ChapterVersionDiff, RollbackResult,
  ContentRevisionSummary,
  NovelEntityCandidate, EntityCandidateStatus,
  // 次级类型（PR-1 迁移）
  NovelNodeType, PlotFunction,
  CharacterGenerationProgressEvent,
  GraphNode, GraphEdge, GraphPath, EntityChapterPresence,
  ConsistencyReport,
  ChapterChatRole, ChapterChatPhase, ChapterChatMessage,
  ChapterStoryContext, ChangeValueType, NovelAnnotation, NovelAnnotationKind, NovelAnnotationScope,
  NovelChangeRecord, NovelStoryEntityType, NovelStoryEvent, StoryEventEntityRef,
  StoryEventSource, StoryEventStatus,
  ChapterOutlineGenerationResult, GenerateChapterOutlineInput,
  NovelInterjectTargetAgent,
} from '@repo/shared/novel'

// re-export 共享类型供外部消费者使用
export * from '@repo/shared/novel'

// ── 基础路径 ──

const BASE = '/api/plugins/novel'

// ── 前端独有类型 ──

/** 冲突剧情功能位（转发别名，等同于共享包 PlotFunction 七值枚举） */
export type ConflictPlotFunction = PlotFunction

/** V2 双写对账报告（与后端 core/v2-reconciliation.ts 的 ReconciliationReport 同构） */
export interface ReconciliationReport {
  projectId: string
  projectTitle: string
  chapterRange: [number, number] | null
  wordBudget: { matched: number; mismatched: number; items: Array<{ chapterNumber: number; v1Target: number; v2Target: number | null; matched: boolean }> }
  sceneCount: { matched: number; mismatched: number; items: Array<{ chapterNumber: number; v1Scenes: number | null; v2Scenes: number | null; matched: boolean }> }
  eventSceneFields: { totalEvents: number; eventsWithSceneId: number }
  overallMatched: boolean
}

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

export type UpdateProjectInput = Omit<Partial<CreateProjectInput>, 'targetPlatform'> & {
  currentVolume?: number
  currentChapter?: number
  currentStage?: StoryStage
  status?: 'active' | 'paused' | 'completed'
  outline?: string
  rhythmModelId?: string
  /** 项目级创作主模型：null/undefined = 各 Agent 各自配置；非空 = 创作流程统一使用 */
  novelModelId?: string | null
  targetPlatform?: TargetPlatform | null
}

export type CreateStoryEventInput = Omit<NovelStoryEvent, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>
export type CreateStoryEventEntityRefInput = Omit<StoryEventEntityRef, 'id' | 'eventId'>
export type CreateStoryEventChangeInput = Omit<
  NovelChangeRecord,
  'id' | 'projectId' | 'storyEventId' | 'chapterNumber' | 'sceneOrder' | 'cause' | 'effectIds' | 'createdAt'
> & { cause?: string | null; effectIds?: string[] }

export interface CreateStoryEventPayload {
  event: CreateStoryEventInput
  entityRefs?: CreateStoryEventEntityRefInput[]
  changes?: CreateStoryEventChangeInput[]
}

export interface StoryEventDetails {
  event: NovelStoryEvent
  entityRefs: StoryEventEntityRef[]
  changes: NovelChangeRecord[]
}

export type CreateAnnotationInput = Omit<NovelAnnotation, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>
export type UpdateAnnotationInput = Partial<CreateAnnotationInput>

export interface CreateChangeRecordInput {
  storyEventId?: string | null
  chapterNumber: number
  sceneOrder?: number
  subjectType: NovelStoryEntityType
  subjectId: string
  dimension: string
  targetType?: NovelStoryEntityType | null
  targetId?: string | null
  valueType: ChangeValueType
  beforeValue?: unknown
  afterValue?: unknown
  reason?: string
  significance?: number
  source?: StoryEventSource
  cause?: string | null
  effectIds?: string[]
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
  /** AI 草稿来源版本；提供后后端会在同一次 PATCH 中执行乐观并发校验。 */
  expectedOutlineHash?: string
  expectedContentRevisionId?: string | null
  outlineGenerationId?: string
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
  // ── 子甘特图轨道数据（复合片段展开用）──
  resolutionPoints?: Array<{ chapter: number; label: string }>
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
  // ── 071：推进粒度（类比 clue.currentStep/nextStep，让 Writer 看到冲突真实推进点）──
  currentStep?: string
  nextStep?: string
  // ── 子甘特图轨道数据（复合片段展开用）──
  intensityPoints?: Array<{ chapter: number; value: number }>
  participantSpans?: Array<{ characterId: string; startCh: number; endCh: number }>
  turningPoints?: Array<{ chapter: number; label: string }>
  resolutionProgress?: Array<{ chapter: number; percent: number }>
}

export interface CreateClueInput {
  description: string
  pointsTo?: string
  progress?: number
  currentStep?: string
  nextStep?: string
  isMisleading?: boolean
  chapterSpans?: Array<[number, number]>
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

export interface CreateItemInput {
  name: string
  description?: string
  type?: NovelItemType
  ownerId?: string | null
  status?: NovelItemStatus
  abilities?: string
  origin?: string
  firstChapter?: number | null
  chapterSpans?: Array<[number, number]>
}

export type UpdateItemInput = Partial<CreateItemInput>

export interface CreateWorldElementInput {
  category: NovelWorldElementCategory
  name: string
  description?: string
  parentId?: string | null
  attributes?: Record<string, unknown>
}

export type UpdateWorldElementInput = Partial<CreateWorldElementInput>

// ── 节点位置 ──

/** 节点类型名（转发别名，等同于共享包 NovelNodeType 10 值枚举） */
export type NovelNodeTypeName = NovelNodeType

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
  modelId?: { provider: string; modelId: string; thinkingLevel?: import('../stores/session-store').ThinkingLevel | null }
}

// CharacterGenerationProgressEvent 已迁入 @repo/shared/novel 共享包（顶部 import）

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

export function updateChapter(id: string, input: UpdateChapterInput): Promise<ChapterSaveResult> {
  return patchApi<ChapterSaveResult>(`${BASE}/chapters/${id}`, input)
}

/** 生成无副作用的章纲草稿；只有后续 updateChapter 才会持久化 outline。 */
export function generateChapterOutline(
  projectId: string,
  chapterNumber: number,
  input: GenerateChapterOutlineInput,
  signal?: AbortSignal,
): Promise<ChapterOutlineGenerationResult> {
  return postApi<ChapterOutlineGenerationResult>(
    `${BASE}/projects/${projectId}/chapters/${chapterNumber}/outline/generate`,
    input,
    { signal },
  )
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
}export function getChapterVersion(chapterId: string, versionId: string): Promise<ChapterVersion> {
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

/**
 * 将历史版本应用到当前正文。复用安全回滚接口，服务端会先保存当前正文快照。
 */
export function applyChapterVersion(
  chapterId: string,
  versionId: string
): Promise<RollbackResult> {
  return rollbackChapter(chapterId, versionId)
}

export function createChapterSnapshot(chapterId: string, trigger?: string): Promise<ChapterVersion> {
  return postApi<ChapterVersion>(`${BASE}/chapters/${chapterId}/versions`, { trigger })
}

// ── 不可变正文版本链（V2 content revision，T04）──

export function listContentRevisions(chapterId: string): Promise<ContentRevisionSummary[]> {
  return getApi<ContentRevisionSummary[]>(`${BASE}/chapters/${chapterId}/content-revisions`)
}

export function rollbackToContentRevision(
  chapterId: string,
  revisionId: string,
): Promise<{ appliedRevisionId: string; content: string; wordCount: number }> {
  return postApi(`${BASE}/chapters/${chapterId}/content-revisions/${revisionId}/rollback`, {})
}

// ── Memory 实体候选审核（V2 决策 3，T04）──

export function listEntityCandidates(
  projectId: string,
  status?: EntityCandidateStatus,
): Promise<{ candidates: NovelEntityCandidate[]; pendingCount: number }> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : ''
  return getApi(`${BASE}/projects/${projectId}/entity-candidates${qs}`)
}

export function confirmEntityCandidate(id: string): Promise<{ candidate: NovelEntityCandidate; entityId: string | null }> {
  return postApi(`${BASE}/entity-candidates/${id}/confirm`, {})
}

export function rejectEntityCandidate(id: string, reason: string): Promise<NovelEntityCandidate> {
  return postApi(`${BASE}/entity-candidates/${id}/reject`, { reason })
}

// ── V2 双写对账（T05）──

export function getV2Reconciliation(projectId: string): Promise<ReconciliationReport> {
  return getApi(`${BASE}/projects/${projectId}/v2-reconciliation`)
}

// ── 剧情推进轨道（第二轮）──

export interface NarrativeMatrixProgressLink {
  progressId: string
  storylineId: string
  sceneRevisionId: string
  chapterNumber: number | null
  type: 'setup' | 'advance' | 'turn' | 'reveal' | 'resolve' | 'pause'
  primary: boolean
  beforeState: string
  afterState: string
  summary: string
  status: string
  createdAt: number
}

export interface NarrativeMatrixRow {
  storylineId: string
  name: string
  kind: string
  lifecycle: 'active' | 'paused' | 'resolved' | 'abandoned'
  maturity: 'candidate' | 'established'
  progresses: NarrativeMatrixProgressLink[]
}

export interface NarrativeMatrixReport {
  projectId: string
  source: 'v2-ledger'
  sourceRevision: string
  projectionLag: number
  stale: boolean
  generatedAt: number
  rows: NarrativeMatrixRow[]
  sceneNodes: Array<{ sceneRevisionId: string; sceneId: string; sceneKey: string; chapterId: string; chapterNumber: number | null; order: number | null; title: string }>
  staleCount: number
}

export function getNarrativeMatrix(projectId: string, asOfRevision?: string): Promise<NarrativeMatrixReport> {
  const query = asOfRevision ? `?asOfRevision=${encodeURIComponent(asOfRevision)}` : ''
  return getApi(`${BASE}/projects/${projectId}/narrative-matrix${query}`)
}

// ── P4/P5：远端分析 run 与参考档案审核（M3）──

export type ReferenceRunStage =
  | 'validating_source' | 'parsing_text' | 'deterministic_analysis' | 'scene_analysis'
  | 'chapter_aggregation' | 'book_aggregation' | 'safety_scan' | 'awaiting_review'
  | 'completed' | 'failed' | 'cancelled'

export interface ReferenceAnalysisRun {
  id: string
  sourceId: string
  status: 'queued' | 'running' | 'awaiting_review' | 'completed' | 'failed' | 'cancelled'
  currentStage: ReferenceRunStage | null
  providerId: string | null
  modelId: string | null
  includedSectionIds: string[]
  estimateSnapshot: Record<string, unknown>
  actualUsage: Record<string, unknown>
  highCostConfirmed: boolean
  checkpoint: Record<string, unknown> | null
  error: string | null
  profileId: string | null
  attempt: number
  parentAttemptId: string | null
  createdAt: number
  updatedAt: number
  workerRunning?: boolean
  eventsUrl?: string
}

export interface ReferenceRunObservation {
  id: string
  analysisRunId: string
  sectionId: string | null
  level: 'measurement' | 'scene' | 'chapter' | 'book'
  metric: string
  value: unknown
  measurementMethod: string | null
  confidence: number | null
  evidenceOffsets: unknown[]
  counterexampleOffsets: unknown[]
  safetyFlags: unknown[]
  createdAt: number
}

export interface ReferenceRunEvent {
  id: string
  sequence: number
  type: string
  stage: string | null
  summary: string
  createdAt: number
}

export interface ReferenceFindingItem {
  key: string
  category: 'spirit' | 'technique' | 'power' | 'pacing'
  observation: string
  rule: string
  strength: 'hard' | 'soft' | 'reference'
  confidence: number | null
  evidence: string[]
  promptEnabled: boolean
  agentTargets: string[]
  chapterScope: string[]
  review: {
    decision: 'accepted' | 'rejected' | 'edited' | null
    editedObservation: string | null
    editedRule: string | null
    strength: 'hard' | 'soft' | 'reference' | null
    promptEnabled: boolean
    agentTargets: string[]
    chapterScope: string[]
    note: string | null
    reviewer: string | null
    reviewedAt: number | null
  } | null
}

export interface ReferenceProfileDetail {
  id: string
  analysisRunId: string
  status: string
  version: number
  parentVersionId: string | null
  profileHash: string
  spirit: { summary: string; rules: string[] }
  technique: { summary: string; rules: string[] }
  power: { summary: string; rules: string[] }
  pacing: { summary: string; rules: string[] }
  findings: ReferenceFindingItem[]
  safetyReport: {
    directQuotes: Array<{ prefix: string; length: number }>
    properNouns: string[]
    plotSequences: string[]
    uniqueScenes: string[]
    blockers: string[]
    degraded: boolean
    generatedAt: number
  }
  coverage: Record<string, unknown>
  changeSummary: string | null
  createdAt: number
  updatedAt: number
  activatedAt: number | null
}

export function startReferenceAnalysisRun(sourceId: string, input: {
  providerId: string; modelId: string; includedSectionIds?: string[]; estimateHash: string; highCostConfirmed: boolean
}): Promise<ReferenceAnalysisRun> {
  return postApi(`${BASE}/reference-sources/${sourceId}/analysis-runs`, input)
}

export function getReferenceAnalysisRun(runId: string): Promise<ReferenceAnalysisRun> {
  return getApi(`${BASE}/reference-analysis-runs/${runId}`)
}

export function listReferenceRunObservations(runId: string, query: { level?: string; metric?: string; cursor?: number; limit?: number } = {}): Promise<{
  observations: ReferenceRunObservation[]; nextCursor: number | null; total: number
}> {
  const params = new URLSearchParams()
  if (query.level) params.set('level', query.level)
  if (query.metric) params.set('metric', query.metric)
  if (query.cursor) params.set('cursor', String(query.cursor))
  if (query.limit) params.set('limit', String(query.limit))
  const qs = params.toString()
  return getApi(`${BASE}/reference-analysis-runs/${runId}/observations${qs ? `?${qs}` : ''}`)
}

export function cancelReferenceAnalysisRun(runId: string, reason = ''): Promise<ReferenceAnalysisRun> {
  return postApi(`${BASE}/reference-analysis-runs/${runId}/cancel`, { reason })
}

export function retryReferenceAnalysisRun(runId: string, highCostConfirmed: boolean, fromCheckpoint = true): Promise<ReferenceAnalysisRun> {
  return postApi(`${BASE}/reference-analysis-runs/${runId}/retry`, { fromCheckpoint, highCostConfirmed })
}

export function resumeReferenceAnalysisRun(runId: string, highCostConfirmed: boolean): Promise<ReferenceAnalysisRun> {
  return postApi(`${BASE}/reference-analysis-runs/${runId}/resume`, { highCostConfirmed })
}

export function getReferenceProfile(profileId: string): Promise<ReferenceProfileDetail> {
  return getApi(`${BASE}/reference-profiles/${profileId}`)
}

export function listReferenceFindings(profileId: string, query: { category?: string; decision?: string } = {}): Promise<{
  findings: ReferenceFindingItem[]
  counts: {
    total: number; pending: number; accepted: number; rejected: number; edited: number
    byCategory: { spirit: number; technique: number; power: number; pacing: number }
  }
  nextCursor: number | null
}> {
  const params = new URLSearchParams()
  if (query.category) params.set('category', query.category)
  if (query.decision) params.set('decision', query.decision)
  const qs = params.toString()
  return getApi(`${BASE}/reference-profiles/${profileId}/findings${qs ? `?${qs}` : ''}`)
}

export function getReferenceFindingEvidence(profileId: string, findingKey: string): Promise<{
  findingKey: string
  evidence: Array<{ quote: string; available: boolean; sectionId: string | null; sectionTitle: string | null; start: number | null; end: number | null; contentHash: string | null }>
  counterexamples: unknown[]
  degraded: boolean
  note: string
}> {
  return getApi(`${BASE}/reference-profiles/${profileId}/findings/${findingKey}/evidence`)
}

export function reviewReferenceFinding(profileId: string, findingKey: string, input: {
  decision: 'accepted' | 'rejected' | 'edited'
  editedObservation?: string; editedRule?: string
  strength?: 'hard' | 'soft' | 'reference'
  promptEnabled?: boolean
  agentTargets?: string[]
  chapterScope?: string[]
  note?: string
}): Promise<ReferenceFindingItem> {
  return patchApi(`${BASE}/reference-profiles/${profileId}/findings/${findingKey}/review`, input)
}

export function batchReviewReferenceFindings(profileId: string, version: number, reviews: Array<{
  findingKey: string
  decision: 'accepted' | 'rejected' | 'edited'
  editedObservation?: string; editedRule?: string
  strength?: 'hard' | 'soft' | 'reference'
  promptEnabled?: boolean
  agentTargets?: string[]
  chapterScope?: string[]
}>, note?: string): Promise<{ profile: ReferenceProfileDetail; reviewed: number; newVersion: number }> {
  return postApi(`${BASE}/reference-profiles/${profileId}/finding-reviews/batch`, { version, reviews, note })
}

export function getReferenceSafetyReport(profileId: string): Promise<{
  directQuotes: Array<{ prefix: string; length: number }>
  properNouns: string[]
  plotSequences: string[]
  uniqueScenes: string[]
  blockers: string[]
  degraded: boolean
  blocking: boolean
  findingSafetyFlags: number
}> {
  return getApi(`${BASE}/reference-profiles/${profileId}/safety-report`)
}

export function listReferenceProfileVersions(profileId: string): Promise<Array<{
  id: string; version: number; parentVersionId: string | null; profileHash: string
  status: string; changeSummary: string | null; createdAt: number; activatedAt: number | null
  findingCounts: { total: number; promptEnabled: number }
}>> {
  return getApi(`${BASE}/reference-profiles/${profileId}/versions`)
}

export function compareReferenceProfileVersions(profileId: string, fromVersionId: string, toVersionId: string): Promise<{
  from: { id: string; version: number } | null
  to: { id: string; version: number } | null
  profileChanges: Array<{ category: string; fromSummary: string; toSummary: string; ruleCountDelta: number }>
  findingChanges: Array<{ key: string; category: string; from: string; to: string }>
  safetyChanges: { directQuoteCountDelta: number; blockersDelta: number }
}> {
  return getApi(`${BASE}/reference-profiles/${profileId}/compare?fromVersionId=${fromVersionId}&toVersionId=${toVersionId}`)
}

// ── Storyline/Scene 人工 revision 与剧情矩阵重投影（M2）──

export interface StorylineRevisionItem {
  id: string
  storylineId: string
  projectId: string
  supersedesId: string | null
  revision: number
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'superseded'
  summary: string
  goal: string
  stakes: string
  actor: string
  note: string
  decisionNote: string
  reviewer: string
  expectedVersion: number
  createdAt: number
  updatedAt: number
  supersededAt: number | null
}

export interface StorylineDetail {
  id: string
  projectId: string
  name: string
  kind: string
  lifecycle: string
  maturity: string
  description: string
  createdAt: number
  updatedAt: number
  currentRevisionId: string | null
  version: number
  status: string
  summary: string
  goal: string
  stakes: string
  actor: string
}

export interface SceneReviewItem {
  id: string
  sceneId: string
  chapterId: string
  projectId: string
  planRevisionId: string
  order: number
  title: string
  summary: string
  pov: string
  positioning: string | null
  rhythm: string | null
  narrativeTaskTypes: string[]
  status: string
  reviewStatus: 'draft' | 'submitted' | 'approved' | 'rejected' | null
  reviewNote: string
  reviewer: string
  createdAt: number
  focus: string[]
  present: string[]
  cast: Array<{ characterId: string; function: string; prominence: string }>
}

export interface SceneReviewDetail {
  sceneId: string
  currentRevision: SceneReviewItem | null
  revisions: SceneReviewItem[]
}

export interface NarrativeMatrixRebuild {
  id: string
  projectId: string
  status: string
  revisionIds: string[]
  idempotencyKey: string | null
  sourceRevision: string | null
  projectionLag: number
  stale: boolean
  failedNodes: string[]
  error: string | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
}

export function listStorylines(projectId: string): Promise<StorylineDetail[]> {
  return getApi(`${BASE}/projects/${projectId}/storylines`)
}

export function getStoryline(storylineId: string): Promise<StorylineDetail & { revisions: StorylineRevisionItem[] }> {
  return getApi(`${BASE}/storylines/${storylineId}`)
}

export function createStorylineRevision(storylineId: string, input: { expectedRevision: number; summary: string; goal: string; stakes: string; actor: string; note?: string }): Promise<StorylineRevisionItem> {
  return postApi(`${BASE}/storylines/${storylineId}/revisions`, input)
}

export function submitStorylineRevision(revisionId: string): Promise<StorylineRevisionItem> {
  return postApi(`${BASE}/storyline-revisions/${revisionId}/submit`, {})
}

export function approveStorylineRevision(revisionId: string, note = ''): Promise<StorylineRevisionItem> {
  return postApi(`${BASE}/storyline-revisions/${revisionId}/approve`, { decision: 'approve', note })
}

export function rejectStorylineRevision(revisionId: string, note = ''): Promise<StorylineRevisionItem> {
  return postApi(`${BASE}/storyline-revisions/${revisionId}/reject`, { decision: 'reject', note })
}

export function compareStorylineRevisions(storylineId: string, fromRevision: number, toRevision: number): Promise<{ from: StorylineRevisionItem | null; to: StorylineRevisionItem | null; fields: Array<{ field: string; before: string; after: string }> }> {
  return getApi(`${BASE}/storylines/${storylineId}/revisions/compare?fromRevision=${fromRevision}&toRevision=${toRevision}`)
}

export function rollbackStorylineRevision(storylineId: string, targetRevisionId: string, note = ''): Promise<StorylineRevisionItem> {
  return postApi(`${BASE}/storylines/${storylineId}/revisions/rollback`, { targetRevisionId, note })
}

export function listScenes(projectId: string): Promise<SceneReviewItem[]> {
  return getApi(`${BASE}/projects/${projectId}/scenes`)
}

export function getScene(sceneId: string): Promise<SceneReviewDetail> {
  return getApi(`${BASE}/scenes/${sceneId}`)
}

export function createSceneRevision(sceneId: string, input: { expectedRevision: string; summary: string; pov: string; positioning?: string; rhythm?: string; narrativeTaskTypes?: string[]; focus?: string[]; present?: string[]; cast?: Array<{ characterId: string; function: string; prominence: string }> }): Promise<SceneReviewItem> {
  return postApi(`${BASE}/scenes/${sceneId}/revisions`, input)
}

export function submitSceneRevision(revisionId: string): Promise<SceneReviewItem> {
  return postApi(`${BASE}/scene-revisions/${revisionId}/submit`, {})
}

export function approveSceneRevision(revisionId: string, note = ''): Promise<SceneReviewItem> {
  return postApi(`${BASE}/scene-revisions/${revisionId}/approve`, { decision: 'approve', note })
}

export function rejectSceneRevision(revisionId: string, note = ''): Promise<SceneReviewItem> {
  return postApi(`${BASE}/scene-revisions/${revisionId}/reject`, { decision: 'reject', note })
}

export function compareSceneRevisions(sceneId: string, fromRevisionId: string, toRevisionId: string): Promise<{ from: SceneReviewItem | null; to: SceneReviewItem | null; fields: Array<{ field: string; before: string; after: string }> }> {
  return getApi(`${BASE}/scenes/${sceneId}/revisions/compare?fromRevisionId=${fromRevisionId}&toRevisionId=${toRevisionId}`)
}

export function rollbackSceneRevision(sceneId: string, targetRevisionId: string, note = ''): Promise<SceneReviewItem> {
  return postApi(`${BASE}/scenes/${sceneId}/revisions/rollback`, { targetRevisionId, note })
}

export function rebuildNarrativeMatrix(projectId: string, input: { revisionIds?: string[]; idempotencyKey?: string } = {}): Promise<NarrativeMatrixRebuild> {
  return postApi(`${BASE}/projects/${projectId}/narrative-matrix/rebuild`, input)
}

export function getNarrativeMatrixRebuild(projectId: string, jobId: string): Promise<NarrativeMatrixRebuild> {
  return getApi(`${BASE}/projects/${projectId}/narrative-matrix/rebuild/${jobId}`)
}

// ── 剧情（narrative）实体轨道 ──

export function listNarratives(projectId: string): Promise<NovelNarrative[]> {
  return getApi(`${BASE}/projects/${projectId}/narratives`)
}

export function createNarrative(projectId: string, input: { description: string; type?: string; status?: string; chapterSpans?: Array<[number, number]> }): Promise<NovelNarrative> {
  return postApi(`${BASE}/projects/${projectId}/narratives`, input)
}

export function updateNarrative(id: string, input: Partial<{ description: string; type: string; status: string; chapterSpans: Array<[number, number]> }>): Promise<NovelNarrative> {
  return patchApi(`${BASE}/narratives/${id}`, input)
}

export function deleteNarrative(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi(`${BASE}/narratives/${id}`)
}

// ── 中间章重写派生状态（决策 4，T04）──

export interface ChapterDerivedState {
  isMiddleRewrite: boolean
  invalidationId?: string
  startChapterNumber?: number
  staleMarked?: number
  staleCounts?: Record<string, number>
  affectedChapters?: number[]
  rebuildAvailable?: boolean
  rebuildBlockedReasons?: string[]
  message?: string
}

export interface ChapterSaveResult extends NovelChapter {
  derivedState?: ChapterDerivedState
}

export interface TimelineRebuildPreview extends ChapterDerivedState {
  id: string
  projectId: string
  startChapterId: string
  startChapterNumber: number
  sourceContentRevisionId: string | null
  status: 'pending' | 'rebuilding' | 'resolved'
  reason: 'chapter_rewrite'
  affectedChapters: number[]
  staleCounts: Record<string, number>
  estimatedLlmCalls: number
  automaticRebuildAvailable: boolean
  blockedReasons: string[]
  confirmationToken: string
  latestJob?: TimelineRebuildJob | null
}

export function getTimelineRebuildPreview(projectId: string): Promise<TimelineRebuildPreview> {
  return getApi<TimelineRebuildPreview>(`${BASE}/projects/${projectId}/timeline-rebuild/preview`)
}

export interface TimelineRebuildStep {
  jobId: string
  chapterId: string
  chapterNumber: number
  contentRevisionId: string
  status: 'pending' | 'replaying' | 'ready_to_apply' | 'applied' | 'failed' | 'blocked'
  error: string | null
  updatedAt: number
}

export interface TimelineRebuildJob {
  id: string
  invalidationId: string
  projectId: string
  startChapterNumber: number
  endChapterNumber: number
  status: 'queued' | 'running' | 'paused' | 'cancelling' | 'cancelled' | 'failed' | 'completed'
  estimatedLlmCalls: number
  processedChapterNumber: number | null
  error: string | null
  completed: number
  failed: number
  skipped: number
  checkpoint: number | null
  blockedReason: string | null
  modelId: { provider: string; modelId: string; thinkingLevel?: import('../stores/session-store').ThinkingLevel | null } | null
  steps: TimelineRebuildStep[]
}

export function startTimelineRebuild(
  projectId: string,
  confirmationToken: string,
  modelId?: { provider: string; modelId: string; thinkingLevel?: import('../stores/session-store').ThinkingLevel | null } | null,
): Promise<TimelineRebuildJob> {
  return postApi<TimelineRebuildJob>(`${BASE}/projects/${projectId}/timeline-rebuild/start`, {
    confirmationToken,
    confirmed: true,
    ...(modelId ? { modelId } : {}),
  })
}

export function getTimelineRebuildJob(projectId: string, jobId: string): Promise<TimelineRebuildJob> {
  return getApi<TimelineRebuildJob>(`${BASE}/projects/${projectId}/timeline-rebuild/jobs/${jobId}`)
}

export function cancelTimelineRebuildJob(projectId: string, jobId: string): Promise<TimelineRebuildJob> {
  return postApi<TimelineRebuildJob>(`${BASE}/projects/${projectId}/timeline-rebuild/jobs/${jobId}/cancel`, {})
}

export function resumeTimelineRebuildJob(projectId: string, jobId: string): Promise<TimelineRebuildJob> {
  return postApi<TimelineRebuildJob>(`${BASE}/projects/${projectId}/timeline-rebuild/jobs/${jobId}/resume`, {})
}

export function markTimelineRebuildStepReady(
  projectId: string,
  jobId: string,
  chapterId: string,
  expectedContentRevision: string,
): Promise<TimelineRebuildJob> {
  return postApi<TimelineRebuildJob>(`${BASE}/projects/${projectId}/timeline-rebuild/jobs/${jobId}/chapters/${chapterId}/ready`, {
    expectedContentRevision,
  })
}

export function applyTimelineRebuildStep(
  projectId: string,
  jobId: string,
  chapterId: string,
  expectedContentRevision: string,
): Promise<TimelineRebuildJob> {
  return postApi<TimelineRebuildJob>(`${BASE}/projects/${projectId}/timeline-rebuild/jobs/${jobId}/chapters/${chapterId}/apply`, {
    expectedContentRevision,
  })
}

export function completeTimelineRebuildJob(projectId: string, jobId: string): Promise<TimelineRebuildJob> {
  return postApi<TimelineRebuildJob>(`${BASE}/projects/${projectId}/timeline-rebuild/jobs/${jobId}/complete`, {})
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

export function updateClue(id: string, input: Partial<CreateClueInput>): Promise<NovelClue> {
  return patchApi<NovelClue>(`${BASE}/clues/${id}`, input)
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

export interface DistilledStyleExpertDraft {
  name: string
  sourceTitle: string
  sourceAuthor?: string
  description: string
  distilledPrompt: string
  enabled: boolean
}

export interface NovelStyleExpertApi {
  id: string
  projectId: string
  name: string
  sourceTitle: string
  sourceAuthor?: string
  description: string
  distilledPrompt: string
  customPrompt?: string
  enabled: boolean
  sortOrder: number
  version: number
  createdAt: number
  updatedAt: number
  metrics?: Record<string, unknown>
  techniques?: unknown[]
  exclusions?: string[]
  exemplarPassages?: unknown[]
}

export function listWritingStyleExperts(projectId: string): Promise<NovelStyleExpertApi[]> {
  return getApi<NovelStyleExpertApi[]>(`${BASE}/projects/${projectId}/writing-style-experts`)
}

export function createWritingStyleExpert(projectId: string, input: Omit<NovelStyleExpertApi, 'id' | 'projectId' | 'version' | 'createdAt' | 'updatedAt'>): Promise<NovelStyleExpertApi> {
  return postApi<NovelStyleExpertApi>(`${BASE}/projects/${projectId}/writing-style-experts`, input)
}

export function updateWritingStyleExpert(projectId: string, expertId: string, input: Partial<Pick<NovelStyleExpertApi, 'name' | 'sourceTitle' | 'sourceAuthor' | 'description' | 'customPrompt' | 'enabled' | 'sortOrder'>>): Promise<NovelStyleExpertApi> {
  return patchApi<NovelStyleExpertApi>(`${BASE}/projects/${projectId}/writing-style-experts/${expertId}`, input)
}

export function listWritingStyleExpertVersions(projectId: string, expertId: string): Promise<Array<{ id: string; version: number; name: string; description: string; customPrompt?: string; enabled: number; createdAt: number }>> {
  return getApi(`${BASE}/projects/${projectId}/writing-style-experts/${expertId}/versions`)
}

export function rollbackWritingStyleExpert(projectId: string, expertId: string, version: number): Promise<NovelStyleExpertApi> {
  return postApi<NovelStyleExpertApi>(`${BASE}/projects/${projectId}/writing-style-experts/${expertId}/rollback`, { version })
}

export function deleteWritingStyleExpert(projectId: string, expertId: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/projects/${projectId}/writing-style-experts/${expertId}`)
}

export function distillWritingStyleExpert(
  projectId: string,
  input: { sourceTitle: string; sourceAuthor?: string; sample: string; notes?: string; modelId?: { provider: string; modelId: string } },
): Promise<DistilledStyleExpertDraft> {
  return postApi<DistilledStyleExpertDraft>(`${BASE}/projects/${projectId}/writing-style-experts/distill`, input)
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

export interface ProseQualityReport {
  score: number
  metrics: {
    characterCount: number
    paragraphCount: number
    sentenceCount: number
    singleSentenceParagraphs: number
    shortParagraphs: number
    maxConsecutiveSingleSentenceParagraphs: number
    dialogueRatio: number
    patternCounts: Record<string, number>
  }
  issues: Array<{ code: string; severity: 'warning' | 'error'; message: string }>
}

export function getChapterProseQuality(
  projectId: string,
  chapterNumber: number,
): Promise<ProseQualityReport> {
  return getApi<ProseQualityReport>(`${BASE}/projects/${projectId}/chapters/${chapterNumber}/prose-quality`)
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

// ── Items ──

export function listItems(projectId: string): Promise<NovelItem[]> {
  return getApi<NovelItem[]>(`${BASE}/projects/${projectId}/items`)
}

export function createItem(projectId: string, input: CreateItemInput): Promise<NovelItem> {
  return postApi<NovelItem>(`${BASE}/projects/${projectId}/items`, input)
}

export function updateItem(id: string, input: UpdateItemInput): Promise<NovelItem> {
  return patchApi<NovelItem>(`${BASE}/items/${id}`, input)
}

export function deleteItem(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/items/${id}`)
}

// ── Story ledger（事件 + 变化 + 批注 + 章节时间切片）──

function buildStoryLedgerQuery<T extends object>(params?: T): string {
  if (!params) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value != null) search.set(key, String(value))
  }
  const query = search.toString()
  return query ? `?${query}` : ''
}

export interface ListStoryEventsParams {
  chapterNumber?: number
  chapterStart?: number
  chapterEnd?: number
  status?: StoryEventStatus
  entityType?: NovelStoryEntityType
  entityId?: string
}

export function listStoryEvents(projectId: string, params?: ListStoryEventsParams): Promise<NovelStoryEvent[]> {
  return getApi<NovelStoryEvent[]>(`${BASE}/projects/${projectId}/story-events${buildStoryLedgerQuery(params)}`)
}

export function getStoryEvent(projectId: string, eventId: string): Promise<StoryEventDetails> {
  return getApi<StoryEventDetails>(`${BASE}/projects/${projectId}/story-events/${eventId}`)
}

export function createStoryEvent(projectId: string, payload: CreateStoryEventPayload): Promise<StoryEventDetails> {
  return postApi<StoryEventDetails>(`${BASE}/projects/${projectId}/story-events`, payload)
}

export function updateStoryEvent(eventId: string, patch: Partial<CreateStoryEventInput>): Promise<NovelStoryEvent> {
  return patchApi<NovelStoryEvent>(`${BASE}/story-events/${eventId}`, patch)
}

export function deleteStoryEvent(eventId: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/story-events/${eventId}`)
}

export interface ListChangeRecordsParams {
  storyEventId?: string
  chapterNumber?: number
  beforeChapter?: number
  afterChapter?: number
  subjectType?: NovelStoryEntityType
  subjectId?: string
  dimension?: string
}

export function listChangeRecords(projectId: string, params?: ListChangeRecordsParams): Promise<NovelChangeRecord[]> {
  return getApi<NovelChangeRecord[]>(`${BASE}/projects/${projectId}/change-records${buildStoryLedgerQuery(params)}`)
}

export function createChangeRecord(projectId: string, input: CreateChangeRecordInput): Promise<NovelChangeRecord> {
  return postApi<NovelChangeRecord>(`${BASE}/projects/${projectId}/change-records`, input)
}

export function updateChangeRecord(changeId: string, patch: Partial<CreateChangeRecordInput>): Promise<NovelChangeRecord> {
  return patchApi<NovelChangeRecord>(`${BASE}/change-records/${changeId}`, patch)
}

export function deleteChangeRecord(changeId: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/change-records/${changeId}`)
}

export interface EntityStoryTimeline {
  entityType: NovelStoryEntityType
  entityId: string
  changes: NovelChangeRecord[]
  events: NovelStoryEvent[]
  annotations: NovelAnnotation[]
}

export function getEntityStoryTimeline(
  projectId: string,
  entityType: NovelStoryEntityType,
  entityId: string,
): Promise<EntityStoryTimeline> {
  return getApi<EntityStoryTimeline>(`${BASE}/projects/${projectId}/entities/${entityType}/${entityId}/timeline`)
}

/**
 * 矩阵级聚合：一次返回全实体 × 全章节的账本投影。
 *
 * 设计文档第 6 节"统一数据源"：折叠态总览废弃实体快照字段，改用账本投影。
 * 前端按 (entityType, entityId, dimension) 分组组装行，每个 dimension 一条子轨道。
 *
 * - `chapterRange`：从 chapters 表推导的章节范围（min/max chapter_number）
 * - `changes`：带 dimension 的全量 ChangeRecord（已按章节排序，已过滤 dimension IS NULL）
 *
 * 支持 `chapterStart` / `chapterEnd` 裁剪，防止百章 × 数十实体聚合爆炸。
 */
export interface MatrixAggregation {
  projectId: string
  chapterRange: { start: number; end: number }
  changes: NovelChangeRecord[]
  /** T02-6 事件参与派生边：同一 StoryEvent 内参与实体两两成对（按章节关系投影） */
  eventEdges?: Array<{ eventId: string; chapterNumber: number; from: string; to: string }>
}

export interface MatrixAggregationParams {
  /** 闭区间起始章节（含） */
  chapterStart?: number
  /** 闭区间结束章节（含） */
  chapterEnd?: number
}

export function getMatrixAggregation(
  projectId: string,
  params?: MatrixAggregationParams,
): Promise<MatrixAggregation> {
  const query = new URLSearchParams()
  if (params?.chapterStart !== undefined) query.set('chapterStart', String(params.chapterStart))
  if (params?.chapterEnd !== undefined) query.set('chapterEnd', String(params.chapterEnd))
  const qs = query.toString()
  return getApi<MatrixAggregation>(`${BASE}/projects/${projectId}/matrix-aggregation${qs ? `?${qs}` : ''}`)
}

export function getChapterStoryContext(projectId: string, chapterNumber: number): Promise<ChapterStoryContext> {
  return getApi<ChapterStoryContext>(`${BASE}/projects/${projectId}/chapters/${chapterNumber}/story-context`)
}

/** 章节投影的事实源（S4-2） */
export type ProjectionSource = 'entity-fields' | 'ledger'

/**
 * 章节投影读接口的返回体（S4-2）。
 *
 * "本章有哪些实体出场"以前在前端也算一份（collectArrangedEntities），
 * 与后端派生规则、矩阵派生规则并列三份，字段增删就漂移 ——
 * itemIds / characterFunctions 长期丢失即由此而来。现在统一由后端给出。
 */
export interface ChapterArrangedEntitiesResponse {
  projectId: string
  chapterNumber: number
  source: ProjectionSource
  arrangedEntities: {
    characterIds: string[]
    conflictIds: string[]
    foreshadowIds: string[]
    clueIds: string[]
    factionIds: string[]
    locationIds: string[]
    itemIds: string[]
  }
  /** 另一种事实源的结果，仅用于对比展示 */
  alternativeSource: ProjectionSource
  alternative: ChapterArrangedEntitiesResponse['arrangedEntities']
  /** 两种来源的差异（按字段），为空表示一致 */
  divergence: Record<string, { onlyInSelected: string[]; onlyInAlternative: string[] }>
}

export function getChapterArrangedEntities(
  projectId: string,
  chapterNumber: number,
  source?: ProjectionSource,
): Promise<ChapterArrangedEntitiesResponse> {
  const qs = source ? `?source=${source}` : ''
  return getApi<ChapterArrangedEntitiesResponse>(
    `${BASE}/projects/${projectId}/chapters/${chapterNumber}/arranged-entities${qs}`,
  )
}

export interface ListAnnotationsParams {
  chapterNumber?: number
  scopeType?: NovelAnnotationScope
  scopeId?: string
  entityType?: NovelStoryEntityType
  entityId?: string
  kind?: NovelAnnotationKind
  resolved?: boolean
  includeInPrompt?: boolean
}

export function listAnnotations(projectId: string, params?: ListAnnotationsParams): Promise<NovelAnnotation[]> {
  return getApi<NovelAnnotation[]>(`${BASE}/projects/${projectId}/annotations${buildStoryLedgerQuery(params)}`)
}

export function createAnnotation(projectId: string, input: CreateAnnotationInput): Promise<NovelAnnotation> {
  return postApi<NovelAnnotation>(`${BASE}/projects/${projectId}/annotations`, input)
}

export function updateAnnotation(annotationId: string, patch: UpdateAnnotationInput): Promise<NovelAnnotation> {
  return patchApi<NovelAnnotation>(`${BASE}/annotations/${annotationId}`, patch)
}

export function deleteAnnotation(annotationId: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/annotations/${annotationId}`)
}

// ── T02-6 AI 提取确认队列 ──

export interface PendingEventItem {
  event: NovelStoryEvent
  entityRefs: StoryEventEntityRef[]
  changes: NovelChangeRecord[]
}

export function listPendingEvents(projectId: string): Promise<{ items: PendingEventItem[] }> {
  return getApi<{ items: PendingEventItem[] }>(`${BASE}/projects/${projectId}/ledger/pending-queue`)
}

export function confirmStoryEvent(projectId: string, eventId: string): Promise<{ confirmed: boolean }> {
  return postApi<{ confirmed: boolean }>(
    `${BASE}/projects/${projectId}/ledger/events/${eventId}/confirm`,
    {},
  )
}

export function rejectStoryEvent(projectId: string, eventId: string): Promise<{ rejected: boolean }> {
  return postApi<{ rejected: boolean }>(
    `${BASE}/projects/${projectId}/ledger/events/${eventId}/reject`,
    {},
  )
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

/** 更新画布连线标签 */
export function updateEdgeLabel(edgeId: string, label: string): Promise<void> {
  return patchApi(`${BASE}/edges/${edgeId}`, { label })
}

// ── Graph（统一关系查询层：聚合 edges + 派生边 + relationships）──
// GraphNode/GraphEdge/GraphPath/EntityChapterPresence 已迁入 @repo/shared/novel 共享包（顶部 import）。

export function listGraphNodes(projectId: string): Promise<GraphNode[]> {
  return getApi<GraphNode[]>(`${BASE}/projects/${projectId}/graph/nodes`)
}

export function listGraphEdges(projectId: string): Promise<GraphEdge[]> {
  return getApi<GraphEdge[]>(`${BASE}/projects/${projectId}/graph/edges`)
}

export function findGraphNeighbors(
  entityId: string,
  edgeTypes?: NovelEdgeType[],
): Promise<GraphEdge[]> {
  const qs = edgeTypes && edgeTypes.length > 0
    ? `?edgeTypes=${encodeURIComponent(edgeTypes.join(','))}`
    : ''
  return getApi<GraphEdge[]>(`${BASE}/graph/neighbors/${entityId}${qs}`)
}

export function findGraphPath(
  fromId: string,
  toId: string,
  maxDepth?: number,
): Promise<GraphPath> {
  const qs = maxDepth != null ? `?maxDepth=${maxDepth}` : ''
  return getApi<GraphPath>(`${BASE}/graph/path/${fromId}/${toId}${qs}`)
}

export function findEntityChapters(
  entityId: string,
  entityType?: NovelNodeTypeName,
): Promise<EntityChapterPresence> {
  const qs = entityType ? `?entityType=${entityType}` : ''
  return getApi<EntityChapterPresence>(`${BASE}/graph/entity-chapters/${entityId}${qs}`)
}

// ── Consistency Audit（跨章节一致性审计）──
// ForeshadowAudit/HookAudit/OrphanEntityAudit/TimelineAudit/ConsistencyReport
// 已迁入 @repo/shared/novel 共享包（顶部 import）。
// 旧别名 ForeshadowStatusKey 已删除，请直接使用 ForeshadowStatus。

export function getConsistencyReport(projectId: string): Promise<ConsistencyReport> {
  return getApi<ConsistencyReport>(`${BASE}/projects/${projectId}/consistency-report`)
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

export type EntityGenerationType = 'character' | 'conflict' | 'foreshadow' | 'faction' | 'location' | 'item' | 'world_element'

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
  // ── 071：推进粒度（AI 生成冲突时可初始化推进点）──
  currentStep?: string
  nextStep?: string
}

export interface GeneratedForeshadowFields {
  description: string
  category: NovelForeshadowCategory
  status: ForeshadowStatus
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

export interface GeneratedItemFields {
  name: string
  description: string
  type: NovelItemType
  ownerId: string | null
  status: NovelItemStatus
  abilities: string
  origin: string
}

/** 后端返回的生成结果联合（按 type 区分） */
export type GeneratedEntityResult =
  | { type: 'character'; data: GeneratedCharacterFields }
  | { type: 'conflict'; data: GeneratedConflictFields }
  | { type: 'foreshadow'; data: GeneratedForeshadowFields }
  | { type: 'faction'; data: GeneratedFactionFields }
  | { type: 'location'; data: GeneratedLocationFields }
  | { type: 'item'; data: GeneratedItemFields }
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

// ── 插话（对话化交互形态 §3.1：向运行中的创作流发送用户中途反馈） ──

/** 插话端点 201 响应体 */
export interface SendFlowMessageResult {
  flowId: string
  messageId: string
  status: 'queued'
}

interface SendFlowMessageResponse {
  ok?: boolean
  data?: SendFlowMessageResult
  error?: string | { message?: string }
}

/** 插话失败（statusCode 区分 409 无运行中 flow 等） */
export class FlowMessageError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message)
    this.name = 'FlowMessageError'
  }
}

/**
 * 向运行中的创作流（工作流/群聊）发送插话。
 *
 * flowId 是 SSE RUN_STARTED 发出的本次运行 ID；后端无运行中或 ID 过期时返回 409。
 * 不走 postApi：需要读取 HTTP 状态码（409 → 无运行中流程）与裸 error 字符串，
 * 而通用包装会把这些信息抹掉。
 */
export async function sendFlowMessage(
  projectId: string,
  flowId: string,
  input: { content: string; targetAgent?: NovelInterjectTargetAgent; chapterNumber?: number },
): Promise<SendFlowMessageResult> {
  const response = await fetch(`${browserConfig.apiBaseUrl}${BASE}/projects/${projectId}/flows/${flowId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })

  let payload: SendFlowMessageResponse | null = null
  try {
    payload = await response.json() as SendFlowMessageResponse
  } catch {
    // 非 JSON 响应保留 HTTP 状态兜底
  }

  if (!response.ok || !payload?.ok || !payload.data) {
    const message = typeof payload?.error === 'string'
      ? payload.error
      : payload?.error?.message ?? `插话发送失败: HTTP ${response.status}`
    throw new FlowMessageError(message, response.status)
  }

  return payload.data
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
  /** 本次编排模型覆盖；未传时由后端按项目主模型/Agent 默认解析。 */
  modelId?: { provider: string; modelId: string; thinkingLevel?: import('../stores/session-store').ThinkingLevel | null }
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
    body: JSON.stringify(options.modelId ? { modelId: options.modelId } : {}),
    signal: options.signal,
  })

  if (!response.ok) {
    throw new Error(`AI 编排启动失败: HTTP ${response.status} ${response.statusText}`)
  }
  if (!response.body) {
    throw new Error('响应体为空，无法读取 SSE 流')
  }

  // 后端发射 AG-UI 事件：CUSTOM(novel:progress/novel:checkpoint/novel:result) + RUN_ERROR
  // 与 aiGenerateCharacter/aiGenerateEntity/sendChapterChat 共用同一个 parseSseStream。
  try {
    await parseSseStream(response.body, (event) => {
      if (event.type === 'CUSTOM') {
        const custom = event as { type: 'CUSTOM'; name: string; value: unknown }
        if (custom.name === 'novel:progress') {
          options.onProgress?.(custom.value)
        } else if (custom.name === 'novel:checkpoint') {
          options.onCheckpoint?.(custom.value)
        } else if (custom.name === 'novel:result') {
          options.onResult?.(custom.value)
        }
      } else if (event.type === 'RUN_ERROR') {
        const errEvent = event as { type: 'RUN_ERROR'; message: string }
        options.onError?.(errEvent.message ?? 'AI 编排失败')
      }
    })
  } catch (err) {
    // 用户主动取消（abort）静默处理，不抛出
    if (options?.signal?.aborted) return
    throw err
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

  // 反推无 checkpoint 事件，其余 SSE 事件格式与 aiArrangeFlow 一致。
  try {
    await parseSseStream(response.body, (event) => {
      if (event.type === 'CUSTOM') {
        const custom = event as { type: 'CUSTOM'; name: string; value: unknown }
        if (custom.name === 'novel:progress') {
          options.onProgress?.(custom.value)
        } else if (custom.name === 'novel:result') {
          options.onResult?.(custom.value)
        }
      } else if (event.type === 'RUN_ERROR') {
        const errEvent = event as { type: 'RUN_ERROR'; message: string }
        options.onError?.(errEvent.message ?? '反推实体失败')
      }
    })
  } catch (err) {
    if (options?.signal?.aborted) return
    throw err
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

/**
 * 缓存分层命中报告。
 *
 * 与 CacheDiagnostics 是两件事：那个比对提示词哈希是否稳定（前提条件），
 * 这个量缓存是否真的被命中（实际效果）。哈希稳定但 cacheRead 为 0
 * 说明分层断点没生效，只看哈希看不出来。
 */
export interface CacheLayerCall {
  agentType: string
  order: number
  cacheablePrefixChars: number
  totalPromptChars: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  charsPerToken: number | null
  expectedCacheReadTokens: number | null
  coverage: number | null
}

export interface CacheLayerChapter {
  chapterNumber: number
  calls: CacheLayerCall[]
  verdict: 'healthy' | 'partial' | 'miss' | 'no_data'
  summary: string
  followUpCoverage: number | null
  allCacheWriteZero: boolean
}

export interface CacheLayerReport {
  chapters: CacheLayerChapter[]
  overallCoverage: number | null
  verdict: 'healthy' | 'partial' | 'miss' | 'no_data'
  /** 分层完全命中时可省下的 input token（上界估算） */
  potentialSavedTokens: number
  /** 需要人工判断的提示 */
  notes: string[]
  sampledLogs: number
  timestamp: number
}

export function getCacheLayerReport(
  projectId: string,
  params?: { chapterNumber?: number; limit?: number },
): Promise<CacheLayerReport> {
  const search = new URLSearchParams()
  if (params?.chapterNumber != null) search.set('chapterNumber', String(params.chapterNumber))
  if (params?.limit != null) search.set('limit', String(params.limit))
  const query = search.toString()
  return getApi<CacheLayerReport>(
    `${BASE}/projects/${projectId}/cache-layer-report${query ? `?${query}` : ''}`,
  )
}

// ── 观测 API（缓存与监控一体化）──

/**
 * 缓存分层判定结论（对应后端 cache-layer-diagnostics.ts 的 CacheVerdict）。
 */
export type ObservabilityCacheVerdict = 'healthy' | 'partial' | 'miss' | 'no_data'

/** 观测过滤参数（对应后端 ObservabilityFilter；from/to 均为含端点过滤） */
export interface ObservabilityFilterParams {
  /** 起始时间（unixepoch 秒，含） */
  from?: number
  /** 结束时间（unixepoch 秒，含） */
  to?: number
  chapterNumber?: number
  agentType?: string
  /** 返回条数上限；默认 100，最大 500 */
  limit?: number
}

/** 项目观测总览（GET /projects/:id/observability/overview） */
export interface ObservabilityOverview {
  /** 过滤范围内总调用数 */
  totalCalls: number
  /** 成功率 success/total；无调用时为 null（区分"全部失败"与"没数据"） */
  successRate: number | null
  /** 失败率 errors/total；无调用时为 0 */
  errorRate: number
  /** 超时率；本项目状态只有 success/error/cancelled，恒 0 */
  timeoutRate: number
  /** 输入 token 总量（不含 cacheRead） */
  inputTokens: number
  /** 输出 token 总量 */
  outputTokens: number
  /** 缓存读取 token 总量 */
  cacheReadTokens: number
  /** 缓存写入 token 总量 */
  cacheWriteTokens: number
  /** 总 cacheRead / (总 cacheRead + 总 input)；总 input+cacheRead 为 0 时为 null */
  cacheHitRate: number | null
  /** 平均耗时（ms），仅统计成功样本；无成功样本时为 null */
  avgDurationMs: number | null
  /** 总成本（USD）；未接入 cost-rates 单价前恒 0 */
  totalCostUsd: number
  /** 数据质量四桶；data_quality 列为 NULL（迁移前旧行）计入 unknownCalls */
  dataQuality: { completeCalls: number; partialCalls: number; noDataCalls: number; unknownCalls: number }
  /** 报告生成时间戳（ms） */
  timestamp: number
}

/** 缓存分层报告（GET /projects/:id/observability/cache） */
export interface ObservabilityCacheReport {
  /** 所有章节 followUpCoverage 的平均值；无有效章节数据时为 null */
  overallCoverage: number | null
  /** 整体分层判定 */
  verdict: ObservabilityCacheVerdict
  /** 若分层完全命中，本次统计范围内可省下的 input token 上界估算 */
  potentialSavedTokens: number
  /** 需要人工判断的提示 */
  notes: string[]
  /** 每章分层诊断摘要（按章节号升序）；followUpCoverage 无数据时为 null */
  chapters: Array<{ chapterNumber: number; verdict: ObservabilityCacheVerdict; followUpCoverage: number | null }>
  /** 按 Agent 分组的命中率；hitRate 分母（cacheRead+input）为 0 时为 null */
  byAgent: Array<{ agentType: string; hitRate: number | null; calls: number }>
  /** cache_protocol 分组计数；NULL/空串计入 'unknown' */
  protocolDistribution: Record<string, number>
  /** 指纹稳定性（仅统计 fingerprint 非空的行） */
  fingerprintStability: { totalCalls: number; distinctFingerprints: number }
  /** 参与分层诊断采样的日志条数（上限 500） */
  sampledLogs: number
  /** 报告生成时间戳（ms） */
  timestamp: number
}

/** 按 Agent 分组统计行（GET /projects/:id/observability/agents） */
export interface ObservabilityAgentRow {
  agentType: string
  /** 该 Agent 调用次数 */
  calls: number
  /** 成功率 success/calls；分组结果必非空，无调用分母时为 0（不为 null） */
  successRate: number
  inputTokens: number
  outputTokens: number
  /** cacheRead / (cacheRead + input)；分母为 0 时为 null */
  cacheHitRate: number | null
  /** 平均耗时（ms），仅统计成功样本；无成功样本时为 null */
  avgDurationMs: number | null
  /** 成本（USD）；未接入 cost-rates 单价前恒 0 */
  costUsd: number
  /** 该 Agent 最近一条非成功调用的错误信息前 200 字符（主表 error 为空时兜底 error_code）；无失败记录时为 null */
  lastError: string | null
}

/** 调用时间线行（GET /projects/:id/observability/timeline，created_at 倒序） */
export interface ObservabilityTimelineRow {
  id: string
  chapterNumber: number
  agentType: string
  phase: string
  status: string
  durationMs: number
  inputTokens: number
  cacheReadTokens: number
  /** 缓存协议（Provider 上报的 cache 类型）；未上报时为 null */
  cacheProtocol: string | null
  /** cacheRead / (cacheRead + input)；分母为 0 时为 null */
  cacheHitRate: number | null
  /** 调用时间（unixepoch 秒） */
  createdAt: number
}

function obsQuery(params?: ObservabilityFilterParams): string {
  const s = new URLSearchParams()
  if (params?.from != null) s.set('from', String(params.from))
  if (params?.to != null) s.set('to', String(params.to))
  if (params?.chapterNumber != null) s.set('chapterNumber', String(params.chapterNumber))
  if (params?.agentType) s.set('agentType', params.agentType)
  if (params?.limit != null) s.set('limit', String(params.limit))
  const q = s.toString()
  return q ? `?${q}` : ''
}

/** 项目观测总览（调用量/成功率/token 汇总/命中率/数据质量四桶） */
export function getObservabilityOverview(projectId: string, params?: ObservabilityFilterParams): Promise<ObservabilityOverview> {
  return getApi<ObservabilityOverview>(`${BASE}/projects/${projectId}/observability/overview${obsQuery(params)}`)
}

/** 缓存分层报告（每章 verdict + 协议分布 + 指纹稳定性） */
export function getObservabilityCache(projectId: string, params?: ObservabilityFilterParams): Promise<ObservabilityCacheReport> {
  return getApi<ObservabilityCacheReport>(`${BASE}/projects/${projectId}/observability/cache${obsQuery(params)}`)
}

/** 按 Agent 分组统计（含最近一条失败原因） */
export function getObservabilityAgents(projectId: string, params?: ObservabilityFilterParams): Promise<ObservabilityAgentRow[]> {
  return getApi<ObservabilityAgentRow[]>(`${BASE}/projects/${projectId}/observability/agents${obsQuery(params)}`)
}

/** 调用时间线（created_at 倒序 + limit + 每行命中率） */
export function getObservabilityTimeline(projectId: string, params?: ObservabilityFilterParams): Promise<ObservabilityTimelineRow[]> {
  return getApi<ObservabilityTimelineRow[]>(`${BASE}/projects/${projectId}/observability/timeline${obsQuery(params)}`)
}

// ── P3 灰度看板（T03-8）──

export interface P3ChunkEntry {
  chunkId: string
  title: string
  priority: string
  defaultMode: string
  layer: string
  charCount: number
  tokens: number
}

export interface P3ContextReport {
  projectId: string
  chapterNumber: number
  agentType?: string
  baseline: {
    sharedChars: number
    sharedTokens: number
    chunkCount: number
  }
  chunks: P3ChunkEntry[]
  rolePolicies: Array<{ agentType: string; policy: Array<{ chunkId: string; mode: string }> }>
  degradation?: {
    budgetTokens: number
    tokensBefore: number
    tokensAfter: number
    savedTokens: number
    savedPercent: number
    appliedSteps: string[]
    fits: boolean
  }
  identity?: { agentType: string; chars: number; tokens: number }
  roleAssembly?: { agentType: string; chars: number; tokens: number; savedTokens: number; savedPercent: number }
  catalog: Array<{ chunkId: string; title: string; priority: string; defaultMode: string }>
}

/** 拉取 P3 灰度看板报告（chunk 明细 / 角色策略 / 降级模拟 / 角色组装对照） */
export function getP3ContextReport(
  projectId: string,
  params: { chapterNumber: number; agentType?: string; budgetTokens?: number },
): Promise<P3ContextReport> {
  const search = new URLSearchParams()
  search.set('chapterNumber', String(params.chapterNumber))
  if (params.agentType) search.set('agentType', params.agentType)
  if (params.budgetTokens != null) search.set('budgetTokens', String(params.budgetTokens))
  return getApi<P3ContextReport>(
    `${BASE}/projects/${projectId}/p3/context-report?${search.toString()}`,
  )
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
// ChapterChatRole/ChapterChatPhase/ChapterChatMessage 已迁入 @repo/shared/novel 共享包（顶部 import）。

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
  options: ChapterChatFlowOptions & {
    /** per-call 模型覆盖（输入框旁选择器传入） */
    modelId?: { provider: string; modelId: string; thinkingLevel?: import('../stores/session-store').ThinkingLevel | null }
    styleExpertIds?: string[]
  },
): Promise<void> {
  const url = `${browserConfig.apiBaseUrl}${BASE}/projects/${projectId}/chapters/${chapterNumber}/chat`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ message, mentionedAgents, modelId: options.modelId, styleExpertIds: options.styleExpertIds }),
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

// ── 参考小说分析（阶段 1：本地分析 MVP）──

export interface ReferenceProviderSummary {
  id: string
  name: string
  models: Array<{
    id: string
    name: string
    contextWindow?: number
    maxTokens?: number
    cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  }>
}

export function listReferenceSources(
  projectId: string
): Promise<import('@repo/shared/novel').ReferenceSourceDetail[]> {
  return getApi(`${BASE}/projects/${projectId}/reference-sources`)
}

export function getReferenceSource(
  sourceId: string
): Promise<import('@repo/shared/novel').ReferenceSourceDetail> {
  return getApi(`${BASE}/reference-sources/${sourceId}`)
}

export function listReferenceProviders(): Promise<ReferenceProviderSummary[]> {
  return getApi('/api/providers')
}

export function preflightReferencePaste(
  projectId: string,
  input: { displayName: string; text: string; fileFormat?: 'txt' | 'markdown' }
): Promise<import('@repo/shared/novel').ReferencePreflightResult> {
  return postApi(`${BASE}/projects/${projectId}/reference-sources/preflight`, {
    inputKind: 'paste',
    ...input
  })
}

export function preflightReferenceFile(
  projectId: string,
  input: {
    displayName: string
    fileName: string
    bytes: Uint8Array
    fileFormat?: 'txt' | 'markdown'
  }
): Promise<import('@repo/shared/novel').ReferencePreflightResult> {
  return postApi(`${BASE}/projects/${projectId}/reference-sources/preflight`, {
    inputKind: 'file',
    displayName: input.displayName,
    fileName: input.fileName,
    fileFormat: input.fileFormat,
    bytesBase64: bytesToBase64(input.bytes)
  })
}

export function updateReferenceImportOptions(
  sourceId: string,
  input: {
    encoding: import('@repo/shared/novel').ReferenceTextEncoding
    retentionPolicy: import('@repo/shared/novel').ReferenceRetentionPolicy
    rightsConfirmed: boolean
    rightsStatement?: string
    cloudAnalysisConfirmed?: boolean
    version: number
  }
): Promise<{ source: import('@repo/shared/novel').ReferenceSourceDetail; warnings: string[] }> {
  return patchApi(`${BASE}/reference-sources/${sourceId}/import-options`, input)
}

export function parseReferenceSource(
  sourceId: string,
  version: number
): Promise<{
  source: import('@repo/shared/novel').ReferenceSourceDetail
  parseStatus: 'parsed'
  qualityReportId: string
  chapterCount: number
  sceneCount: number
  nextPage: 'quality'
}> {
  return postApi(`${BASE}/reference-sources/${sourceId}/parse`, { version })
}

export function getReferenceQualityReport(
  sourceId: string
): Promise<import('@repo/shared/novel').ReferenceQualityReport> {
  return getApi(`${BASE}/reference-sources/${sourceId}/quality-report`)
}

export function getReferenceLocalReport(
  sourceId: string
): Promise<import('@repo/shared/novel').ReferenceLocalAnalysisReport> {
  return getApi(`${BASE}/reference-sources/${sourceId}/local-analysis-report`)
}

export function listReferenceSections(
  sourceId: string
): Promise<import('@repo/shared/novel').ReferenceSection[]> {
  return getApi(`${BASE}/reference-sources/${sourceId}/sections`)
}

export interface StyleTechniqueDraftApi {
  id: string
  dimension: string
  name: string
  mechanism: string
  transfer: string
  evidence: Array<{ sectionId: string; quote: string }>
  metricAnchors: string[]
  confidence: 'verified' | 'unverified' | 'rejected'
  kept: boolean
}

export interface StyleDistillDraftApi {
  name: string
  sourceTitle: string
  description: string
  distilledPrompt: string
  exclusions: string[]
  techniques: StyleTechniqueDraftApi[]
  metrics: Record<string, unknown>
  exemplarPassages: Array<{ sectionId: string; text: string; reason: string }>
}

export function distillReferenceStyle(
  sourceId: string,
  input: { sectionIds: string[]; notes?: string; modelId?: { provider: string; modelId: string } },
): Promise<StyleDistillDraftApi> {
  return postApi<StyleDistillDraftApi>(`${BASE}/reference-sources/${sourceId}/style-distill`, input)
}

export function getReferenceTextPreview(
  sourceId: string,
  input: { sectionId?: string; start?: number; end?: number; contextChars?: number }
): Promise<import('@repo/shared/novel').ReferenceTextPreview> {
  const query = new URLSearchParams()
  if (input.sectionId) query.set('sectionId', input.sectionId)
  if (input.start !== undefined) query.set('start', String(input.start))
  if (input.end !== undefined) query.set('end', String(input.end))
  if (input.contextChars !== undefined) query.set('contextChars', String(input.contextChars))
  return getApi(`${BASE}/reference-sources/${sourceId}/text-preview?${query.toString()}`)
}

export function updateReferenceSection(
  sectionId: string,
  input: {
    title?: string
    start?: number
    end?: number
    included?: boolean
    exclusionReason?: string
    version: number
  }
): Promise<{
  source: import('@repo/shared/novel').ReferenceSourceDetail
  section: import('@repo/shared/novel').ReferenceSection
  sections: import('@repo/shared/novel').ReferenceSection[]
}> {
  return patchApi(`${BASE}/reference-sections/${sectionId}`, input)
}

export function estimateReferenceAnalysis(
  sourceId: string,
  input: {
    providerId: string
    modelId: string
    selectedSectionIds?: string[]
    outputReserveTokens?: number
    safetyMarginTokens?: number
  }
): Promise<import('@repo/shared/novel').ReferenceTokenBudgetEstimate> {
  return postApi(`${BASE}/reference-sources/${sourceId}/analysis-estimate`, input)
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}
