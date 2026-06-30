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

// ── 实体类型 ──

export interface NovelProject {
  id: string
  title: string
  genre: string
  synopsis: string
  targetWords: number
  currentVolume: number
  currentChapter: number
  currentStage: StoryStage
  status: 'active' | 'paused' | 'completed'
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
  acceptanceResult: string | null
  createdAt: number
  updatedAt: number
}

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
  firstChapter: number | null
  lastChapter: number | null
  tier: ConflictTier
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
  firstChapter: number | null
  lastChapter: number | null
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
  firstChapter?: number | null
  lastChapter?: number | null
  tier?: ConflictTier
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
  firstChapter?: number | null
  lastChapter?: number | null
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
  | 'in' | 'out'

export type NovelMarkerColor = 'blue' | 'yellow' | 'green' | 'red' | 'purple'

export interface NovelMarker {
  id: string
  projectId: string
  chapter: number
  title: string
  note: string
  type: NovelMarkerType
  color: NovelMarkerColor
  createdAt: number
  updatedAt: number
}

export interface CreateMarkerInput {
  chapter: number
  title?: string
  note?: string
  type?: NovelMarkerType
  color?: NovelMarkerColor
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

export function deleteProject(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/projects/${id}`)
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

// ── Character History ──

export function listCharacterHistory(
  projectId: string,
  characterId: string,
): Promise<NovelCharacterHistory[]> {
  return getApi<NovelCharacterHistory[]>(`${BASE}/projects/${projectId}/characters/${characterId}/history`)
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

export function submitCheckpointDecision(
  projectId: string,
  type: string,
  decision: string,
  userMessages?: string[],
): Promise<{ ok: boolean }> {
  return postApi<{ ok: boolean }>(`${BASE}/projects/${projectId}/checkpoint/${type}/decision`, {
    decision,
    userMessages,
  })
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
