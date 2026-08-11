/**
 * NovelStore - PR-5b 重构后的 Facade
 *
 * 原本 3457 行的上帝类已拆分为 8 个子 Store + 2 个 Service：
 * - ProjectStore：项目 CRUD + 软删除/回收站
 * - ChapterStore：章节/卷/钩子/角色弧/版本
 * - CharacterStore：角色/关系/历史
 * - ConflictStore：冲突（含反向索引同步）
 * - ForeshadowStore：伏笔/线索/信息层（含双向关联）
 * - WorldStore：世界规则/风格指南/写作风格档案/约束/世界要素
 * - FactionStore：势力/地点
 * - GraphStore：节点位置/标记/边/Agent 日志/作者意图/章节评审（拥有 deleteEdgesByEntity）
 * - ChapterRenumberService：章节删除后的引用重排
 * - DeduplicateService：实体去重 + 相似度合并
 *
 * 本 Facade 仅做方法转发，保持原有 API 不变，调用方（novel-routes.ts / 测试）无需修改。
 */

import type Database from 'better-sqlite3'
import type { NovelPromptStores } from './prompt-builder.js'
import type {
  NovelProject,
  NovelChapter,
  NovelCharacter,
  NovelRelationship,
  NovelForeshadow,
  NovelClue,
  NovelConflict,
  NovelWorldRule,
  NovelConstraint,
  NovelInformationLayer,
  NovelStyleGuide,
  NovelWritingStyleProfile,
  NovelWritingStyleProfileInput,
  NovelAuthorIntent,
  NovelChapterReview,
  NovelCharacterHistory,
  NovelNodePosition,
  NovelNodeType,
  NovelFaction,
  NovelLocation,
  NovelItem,
  NovelWorldElement,
  NovelEdge,
  NovelAgentLog,
  NovelAgentLogSummary,
  NovelMarker,
  NovelVolume,
  NovelHook,
  NovelCharacterArc,
  ChapterVersion,
  ChapterVersionSummary,
  ContentRevision,
  ContentRevisionSummary,
  ChapterPlanRevision,
  PlanRevisionStatus,
  NovelScene,
  NovelSceneRevision,
  NovelStoryline,
  NovelNarrative,
  StorylineLifecycle,
  StorylineMaturity,
  NovelStorylineProgress,
  ProgressStatus,
  NovelEntityCandidate,
  EntityCandidateStatus,
  NovelEntityCandidateReview,
  VersionSource,
  DeduplicateReport,
  SimilarityGroup,
} from './types.js'
import { ProjectStore } from './stores/project-store.js'
import { ChapterStore } from './stores/chapter-store.js'
import { ScenePlanStore } from './stores/scene-plan-store.js'
import { NarrativeLedgerStore } from './stores/narrative-ledger-store.js'
import { EntityCandidateStore } from './stores/entity-candidate-store.js'
import { EntityAppearanceStore, type AppearanceRole, type AppearanceSource } from './stores/entity-appearance-store.js'
import { NarrativeStore } from './stores/narrative-store.js'
import { reconcileV2 } from './v2-reconciliation.js'
import { buildNarrativeMatrix } from './narrative-matrix-projection.js'
import { CharacterStore } from './stores/character-store.js'
import { ConflictStore } from './stores/conflict-store.js'
import { ForeshadowStore } from './stores/foreshadow-store.js'
import { WorldStore } from './stores/world-store.js'
import { FactionStore } from './stores/faction-store.js'
import { ItemStore } from './stores/item-store.js'
import { GraphStore } from './stores/graph-store.js'
import { ChapterRenumberService } from './stores/chapter-renumber-service.js'
import { DeduplicateService } from './stores/deduplicate-service.js'
import {
  chaptersOfClue,
  chaptersOfConflict,
  chaptersOfFaction,
  chaptersOfForeshadow,
  chaptersOfItem,
  chaptersOfLocation,
  diffChapters,
  expandChapterSpans,
  type ProjectionEntityType,
} from './chapter-projection-fields.js'
import { isNovelFeatureEnabled } from './novel-feature-flags.js'

/**
 * 实体章节投影发生变化的通知。
 *
 * "某实体在哪些章出场"是矩阵与编排的核心事实，但它分散在 6 类实体的不同字段里
 * （chapterSpans / appearChapters / beats / character_history）。任何路径改动这些字段
 * 都应该在事件账本留痕，否则账本与矩阵会持续漂移（S4-1 对账实测一致率仅 38.6%）。
 *
 * 与逐个路由插桩相比，在 NovelStore 门面上挂一个观察者是唯一的收口点：
 * 路由、Memory Agent 工具、编排器、前端拖拽全部经由这里。
 */
export interface ChapterProjectionChange {
  entityType: ProjectionEntityType
  entityId: string
  /** 新增出场的章节（升序） */
  addedChapters: number[]
  /** 不再出场的章节（升序） */
  removedChapters: number[]
  /** 触发来源，用于账本 reason */
  origin: string
}

export type ChapterProjectionObserver = (
  projectId: string,
  change: ChapterProjectionChange,
) => void

/**
 * 实体被删除的通知。
 *
 * 账本对实体的引用（story_event_entities.entity_id / memory_events.subject_id）
 * 是多态的，没有外键，删除实体不会级联清理。真实项目因此积累了 11 条悬空引用。
 * 观察者让 novel-services 把删除动作接到账本清理上。
 */
export interface EntityDeletedEvent {
  entityType: ProjectionEntityType
  entityId: string
}

export type EntityDeletedObserver = (projectId: string, event: EntityDeletedEvent) => void

export class NovelStore implements NovelPromptStores {
  private readonly project: ProjectStore
  private readonly chapter: ChapterStore
  private readonly character: CharacterStore
  private readonly conflict: ConflictStore
  private readonly foreshadow: ForeshadowStore
  private readonly world: WorldStore
  private readonly faction: FactionStore
  private readonly item: ItemStore
  private readonly graph: GraphStore
  private readonly scenePlan: ScenePlanStore
  private readonly ledger: NarrativeLedgerStore
  private readonly candidates: EntityCandidateStore
  private readonly narratives: NarrativeStore
  private readonly deduplicator: DeduplicateService
  private readonly entityAppearances: EntityAppearanceStore
  private chapterProjectionObserver: ChapterProjectionObserver | null = null
  private entityDeletedObserver: EntityDeletedObserver | null = null
  private observerSuppressed = false

  constructor(private db: Database.Database) {
    // GraphStore 拥有 deleteEdgesByEntity，先实例化供其他 Store 注入
    // flags 源为 NovelStore 自身（实现 FeatureFlagProjectSource.getProject），
    // 仅在运行时按 projectId 惰性读取，构造顺序不影响。
    this.graph = new GraphStore(db, this)
    const deleteEdges = (id: string) => this.graph.deleteEdgesByEntity(id)
    const renumberService = new ChapterRenumberService(db)

    this.project = new ProjectStore(db)
    this.chapter = new ChapterStore(db, deleteEdges, renumberService, this)
    this.character = new CharacterStore(db, deleteEdges)
    this.conflict = new ConflictStore(db, deleteEdges)
    this.foreshadow = new ForeshadowStore(db, deleteEdges)
    this.world = new WorldStore(db, deleteEdges)
    this.faction = new FactionStore(db, deleteEdges)
    this.item = new ItemStore(db, deleteEdges)
    this.scenePlan = new ScenePlanStore(db, this)
    this.ledger = new NarrativeLedgerStore(db)
    this.candidates = new EntityCandidateStore(db)
    this.entityAppearances = new EntityAppearanceStore(db)
    this.narratives = new NarrativeStore(db)

    this.deduplicator = new DeduplicateService({
      db,
      deleteEdgesByEntity: deleteEdges,
      getCharacter: (id) => this.character.getCharacter(id),
      getConflict: (id) => this.conflict.getConflict(id),
      getForeshadow: (id) => this.foreshadow.getForeshadow(id),
      getFaction: (id) => this.faction.getFaction(id),
      getLocation: (id) => this.faction.getLocation(id),
      getWorldElement: (id) => this.world.getWorldElement(id),
      listCharacters: (pid) => this.character.listCharacters(pid),
      listConflicts: (pid) => this.conflict.listConflicts(pid),
      listForeshadowing: (pid) => this.foreshadow.listForeshadowing(pid),
      listFactions: (pid) => this.faction.listFactions(pid),
      listLocations: (pid) => this.faction.listLocations(pid),
      updateCharacter: (id, patch) => this.character.updateCharacter(id, patch),
      updateConflict: (id, patch) => this.conflict.updateConflict(id, patch),
      updateForeshadow: (id, patch) => this.foreshadow.updateForeshadow(id, patch),
      updateFaction: (id, patch) => this.faction.updateFaction(id, patch),
      updateLocation: (id, patch) => this.faction.updateLocation(id, patch),
      updateWorldElement: (id, patch) => this.world.updateWorldElement(id, patch),
      deleteCharacter: (id) => this.character.deleteCharacter(id),
      deleteConflict: (id) => this.conflict.deleteConflict(id),
      deleteForeshadow: (id) => this.foreshadow.deleteForeshadow(id),
      deleteFaction: (id) => this.faction.deleteFaction(id),
      deleteLocation: (id) => this.faction.deleteLocation(id),
      deleteWorldElement: (id) => this.world.deleteWorldElement(id),
      deleteCharacterHistoryByCharacter: (cid) => this.character.deleteCharacterHistoryByCharacter(cid),
    })
  }

  // ── NovelPromptStores 接口（27 个读方法，供 NovelPromptBuilder 使用）──

  getProject(projectId: string): NovelProject | undefined { return this.project.getProject(projectId) }
  listWorldRules(projectId: string): NovelWorldRule[] { return this.world.listWorldRules(projectId) }
  listStyleGuide(projectId: string): NovelStyleGuide[] { return this.world.listStyleGuide(projectId) }
  getWritingStyleProfile(projectId: string): NovelWritingStyleProfile | undefined { return this.world.getWritingStyleProfile(projectId) }
  listCharacters(projectId: string): NovelCharacter[] { return this.character.listCharacters(projectId) }
  listRelationships(projectId: string): NovelRelationship[] { return this.character.listRelationships(projectId) }
  listConflicts(projectId: string): NovelConflict[] { return this.conflict.listConflicts(projectId) }
  listForeshadowing(projectId: string): NovelForeshadow[] { return this.foreshadow.listForeshadowing(projectId) }
  listClues(projectId: string): NovelClue[] { return this.foreshadow.listClues(projectId) }
  getClue(clueId: string): NovelClue | undefined { return this.foreshadow.getClue(clueId) }
  listInformationLayers(projectId: string): NovelInformationLayer[] { return this.foreshadow.listInformationLayers(projectId) }
  getInformationLayer(infoLayerId: string): NovelInformationLayer | undefined { return this.foreshadow.getInformationLayer(infoLayerId) }
  listConstraints(projectId: string): NovelConstraint[] { return this.world.listConstraints(projectId) }
  listRecentChapters(projectId: string, limit: number): NovelChapter[] { return this.chapter.listRecentChapters(projectId, limit) }
  getChapter(projectId: string, chapterNumber: number): NovelChapter | undefined { return this.chapter.getChapter(projectId, chapterNumber) }
  listUnfulfilledHooksBefore(projectId: string, beforeChapter: number): NovelHook[] { return this.chapter.listUnfulfilledHooksBefore(projectId, beforeChapter) }
  listEdges(projectId: string): NovelEdge[] { return this.graph.listEdges(projectId) }
  listFactions(projectId: string): NovelFaction[] { return this.faction.listFactions(projectId) }
  listLocations(projectId: string): NovelLocation[] { return this.faction.listLocations(projectId) }
  listItems(projectId: string): NovelItem[] { return this.item.listItems(projectId) }
  listWorldElements(projectId: string): NovelWorldElement[] { return this.world.listWorldElements(projectId) }
  getCharacter(characterId: string): NovelCharacter | undefined { return this.character.getCharacter(characterId) }
  getConflict(conflictId: string): NovelConflict | undefined { return this.conflict.getConflict(conflictId) }
  getForeshadow(foreshadowId: string): NovelForeshadow | undefined { return this.foreshadow.getForeshadow(foreshadowId) }
  getFaction(factionId: string): NovelFaction | undefined { return this.faction.getFaction(factionId) }
  getLocation(locationId: string): NovelLocation | undefined { return this.faction.getLocation(locationId) }
  getItem(itemId: string): NovelItem | undefined { return this.item.getItem(itemId) }
  listItemsByOwner(ownerId: string): NovelItem[] { return this.item.listItemsByOwner(ownerId) }
  listVolumes(projectId: string): NovelVolume[] { return this.chapter.listVolumes(projectId) }
  listAgentLogsByProject(projectId: string, limit: number): NovelAgentLog[] { return this.graph.listAgentLogsByProject(projectId, limit) }

  // ── Project CRUD ──

  createProject(project: Omit<NovelProject, 'createdAt' | 'updatedAt'>): NovelProject { return this.project.createProject(project) }
  updateProject(id: string, patch: Partial<NovelProject>): NovelProject | undefined { return this.project.updateProject(id, patch) }
  /** 项目级「创作主模型」：设置后创作流程所有 Agent 统一使用该模型（见 NovelProject.novelModelId） */
  getNovelModelId(projectId: string): string | undefined { return this.project.getNovelModelId(projectId) }
  updateNovelModelId(projectId: string, modelId: string | null): boolean { return this.project.updateNovelModelId(projectId, modelId) }

  // ── P2：实体出场关系统一（novel_entity_appearances）──
  /** 记录一批实体在本章的出场（幂等；仅在 appearanceV2Write 开启时由双写入口调用） */
  addChapterAppearances(input: {
    projectId: string
    chapterId: string
    entityType: string
    entityIds: string[]
    role?: AppearanceRole
    source?: AppearanceSource
  }): number { return this.entityAppearances.addChapterAppearances(input) }
  /** 某章的所有出场实体 */
  listAppearancesByChapter(projectId: string, chapterId: string): ReturnType<EntityAppearanceStore['listByChapter']> {
    return this.entityAppearances.listByChapter(projectId, chapterId)
  }
  /** 某实体的出场章节列表 */
  listAppearancesByEntity(projectId: string, entityType: string, entityId: string): string[] {
    return this.entityAppearances.listByEntity(projectId, entityType, entityId)
  }
  removeChapterAppearances(projectId: string, chapterId: string): number {
    return this.entityAppearances.removeChapterAppearances(projectId, chapterId)
  }
  removeEntityAppearances(projectId: string, entityType: string, entityId: string): number {
    return this.entityAppearances.removeEntityAppearances(projectId, entityType, entityId)
  }
  /**
   * P2 读切统一函数：某章出场实体 ID（仅 appearanceV2Read 开启时走 appearance 表）。
   * 关闭时返回 null —— 调用方回退到各自的 chapterSpans/appearChapters 过滤（零行为变化）。
   * 开启时返回 appearance 记录中的 entityId 列表（用于替换"union 多表"的按章查询）。
   */
  listChapterAppearanceIds(input: {
    projectId: string
    chapterNumber: number
    entityType: string
  }): string[] | null {
    if (!isNovelFeatureEnabled(this, input.projectId, 'appearanceV2Read')) return null
    const chapterId = this.getChapter(input.projectId, input.chapterNumber)?.id
    if (!chapterId) return []
    return this.entityAppearances
      .listByChapter(input.projectId, chapterId)
      .filter((r) => r.entityType === input.entityType)
      .map((r) => r.entityId)
  }
  /**
   * 三入口双写便捷方法（ai-arrange 落库 / Memory applyChanges / syncChapterDimensions）：
   * 仅 appearanceV2Write 开启且能解析到 chapterId 时写入 appearance 表；否则 no-op。
   */
  recordAppearancesIfEnabled(input: {
    projectId: string
    chapterNumber: number
    /** 可选：调用方已解析出 chapterId 时直接传入，避免重复查询 */
    chapterId?: string
    entityType: string
    entityIds: string[]
    role?: AppearanceRole
    source?: AppearanceSource
  }): void {
    if (!isNovelFeatureEnabled(this, input.projectId, 'appearanceV2Write')) return
    if (input.entityIds.length === 0) return
    const chapterId = input.chapterId
      ?? this.getChapter(input.projectId, input.chapterNumber)?.id
    if (!chapterId) return
    this.addChapterAppearances({ ...input, chapterId })
  }

  /**
   * P2 收官：chapter_spans / appear_chapters 旧列冻结（chapterSpansFrozen flag）。
   *
   * 实体 update patch 携带出场字段时：
   * - flag 关（默认）：原样返回，现状不变（双写期间行为）。
   * - flag 开：剥离旧列字段不落库，展开为章节号后**直接写 appearance**
   *   （绕过 appearanceV2Write——冻结后 appearance 是唯一权威出场记录，
   *   不依赖双写开关），source='frozen-redirect'。
   *
   * 覆盖全部写入路径（ai-arrange / Memory / sync / 工具编辑），一处收口。
   */
  private stripFrozenSpans<T extends Record<string, unknown>>(
    entityType: ProjectionEntityType,
    entityId: string,
    patch: T,
    spanKey: 'chapterSpans' | 'appearChapters',
  ): T {
    if (patch[spanKey] === undefined) return patch
    const projectId = this.getEntityProjectId(entityType, entityId)
    if (!projectId) return patch
    if (!isNovelFeatureEnabled(this, projectId, 'chapterSpansFrozen')) return patch

    const chapterNumbers =
      spanKey === 'appearChapters'
        ? (patch[spanKey] as unknown as number[]).filter((n) => typeof n === 'number')
        : expandChapterSpans(patch[spanKey] as unknown as Array<[number, number]>)
    if (chapterNumbers.length > 0) {
      for (const ch of chapterNumbers) {
        const chapterId = this.getChapter(projectId, ch)?.id
        if (!chapterId) continue
        this.addChapterAppearances({
          projectId,
          chapterId,
          entityType,
          entityIds: [entityId],
          role: 'present',
          source: 'frozen-redirect',
        })
      }
    }
    const next = { ...patch }
    delete next[spanKey]
    return next
  }

  /** 按实体类型反查 projectId（供 stripFrozenSpans 判断项目级 flag） */
  private getEntityProjectId(entityType: ProjectionEntityType, entityId: string): string | undefined {
    switch (entityType) {
      case 'conflict': return this.conflict.getConflict(entityId)?.projectId
      case 'foreshadow': return this.foreshadow.getForeshadow(entityId)?.projectId
      case 'clue': return this.foreshadow.getClue(entityId)?.projectId
      case 'faction': return this.faction.getFaction(entityId)?.projectId
      case 'location': return this.faction.getLocation(entityId)?.projectId
      case 'item': return this.item.getItem(entityId)?.projectId
      default: return undefined
    }
  }
  deleteProject(id: string): boolean { return this.project.deleteProject(id) }
  listTrashedProjects(): NovelProject[] { return this.project.listTrashedProjects() }
  restoreProject(id: string): boolean { return this.project.restoreProject(id) }
  purgeProject(id: string): boolean { return this.project.purgeProject(id) }
  emptyTrash(): number { return this.project.emptyTrash() }
  listProjects(): NovelProject[] { return this.project.listProjects() }

  // ── Chapter / Volume / Hook / CharacterArc / ChapterVersion ──

  listChapters(projectId: string): NovelChapter[] { return this.chapter.listChapters(projectId) }
  getChapterById(chapterId: string): NovelChapter | undefined { return this.chapter.getChapterById(chapterId) }
  createChapter(chapter: Omit<NovelChapter, 'createdAt' | 'updatedAt'>): NovelChapter { return this.chapter.createChapter(chapter) }
  updateChapter(id: string, patch: Partial<NovelChapter>, versionSource?: VersionSource): NovelChapter | undefined { return this.chapter.updateChapter(id, patch, versionSource) }
  updateChapterContent(id: string, content: string, wordCount: number, versionSource?: VersionSource): NovelChapter | undefined { return this.chapter.updateChapterContent(id, content, wordCount, versionSource) }
  listChapterVersions(chapterId: string): ChapterVersionSummary[] { return this.chapter.listChapterVersions(chapterId) }
  getChapterVersion(versionId: string): ChapterVersion | undefined { return this.chapter.getChapterVersion(versionId) }
  createVersionSnapshot(chapterId: string, source: VersionSource): ChapterVersion | undefined { return this.chapter.createVersionSnapshot(chapterId, source) }
  getLatestVersion(chapterId: string): ChapterVersion | undefined { return this.chapter.getLatestVersion(chapterId) }
  rollbackToVersion(chapterId: string, targetVersionId: string): { savedVersionId: string; currentContent: string; currentWordCount: number } { return this.chapter.rollbackToVersion(chapterId, targetVersionId) }
  appendContentRevision(chapter: NovelChapter, source: VersionSource | null): ContentRevision | undefined { return this.chapter.appendContentRevision(chapter, source) }
  listContentRevisions(chapterId: string): ContentRevisionSummary[] { return this.chapter.listContentRevisions(chapterId) }
  getContentRevision(revisionId: string): ContentRevision | undefined { return this.chapter.getContentRevision(revisionId) }
  getCurrentContentRevision(chapterId: string): ContentRevision | undefined { return this.chapter.getCurrentContentRevision(chapterId) }
  rollbackToContentRevision(chapterId: string, revisionId: string): { appliedRevisionId: string; content: string; wordCount: number } { return this.chapter.rollbackToContentRevision(chapterId, revisionId) }
  reconcileVersionChains(projectId: string): import('./migration-acceptance.js').VersionChainReconcileReport { return this.chapter.reconcileVersionChains(projectId) }
  deleteChapter(id: string): boolean { return this.chapter.deleteChapter(id) }

  // ── 场景计划（V2）──
  createPlanRevision(input: Parameters<ScenePlanStore['createPlanRevision']>[0]): ChapterPlanRevision { return this.scenePlan.createPlanRevision(input) }
  getPlanRevision(id: string): ChapterPlanRevision | undefined { return this.scenePlan.getPlanRevision(id) }
  getCurrentPlan(chapterId: string): ChapterPlanRevision | undefined { return this.scenePlan.getCurrentPlan(chapterId) }
  listPlanRevisions(chapterId: string): ChapterPlanRevision[] { return this.scenePlan.listPlanRevisions(chapterId) }
  transitionPlan(id: string, to: PlanRevisionStatus, expectedStatus?: PlanRevisionStatus): ChapterPlanRevision { return this.scenePlan.transitionPlan(id, to, expectedStatus) }
  supersedeActivePlans(chapterId: string): void { return this.scenePlan.supersedeActivePlans(chapterId) }
  submitPlanWithScenes(input: Parameters<ScenePlanStore['submitPlanWithScenes']>[0]): { plan: ChapterPlanRevision; scenes: NovelSceneRevision[] } { return this.scenePlan.submitPlanWithScenes(input) }
  createSceneRevisions(plan: ChapterPlanRevision, scenes: Parameters<ScenePlanStore['createSceneRevisions']>[1], contentRevisionId?: string | null): NovelSceneRevision[] { return this.scenePlan.createSceneRevisions(plan, scenes, contentRevisionId) }
  listSceneRevisionsByPlan(planRevisionId: string): NovelSceneRevision[] { return this.scenePlan.listSceneRevisionsByPlan(planRevisionId) }
  getSceneRevision(id: string): NovelSceneRevision | undefined { return this.scenePlan.getSceneRevision(id) }
  getSceneById(sceneId: string): NovelScene | undefined { return this.scenePlan.getSceneById(sceneId) }
  getSceneByRevision(sceneRevisionId: string): NovelScene | undefined { return this.scenePlan.getSceneByRevision(sceneRevisionId) }
  getSceneRevisionCast(sceneRevisionId: string): ReturnType<ScenePlanStore['getSceneRevisionCast']> { return this.scenePlan.getSceneRevisionCast(sceneRevisionId) }
  getSceneCast(sceneRevisionId: string): ReturnType<ScenePlanStore['getSceneCast']> { return this.scenePlan.getSceneCast(sceneRevisionId) }
  reconcileSceneCast(projectId?: string): ReturnType<ScenePlanStore['reconcileSceneCast']> { return this.scenePlan.reconcileSceneCast(projectId) }
  confirmSceneRevision(id: string, contentRevisionId?: string): NovelSceneRevision { return this.scenePlan.confirmSceneRevision(id, contentRevisionId) }

  // ── 叙事账本（V2）──
  ensureStoryline(projectId: string, name: string, kind?: string, description?: string): NovelStoryline { return this.ledger.ensureStoryline(projectId, name, kind, description) }
  getStoryline(id: string): NovelStoryline | undefined { return this.ledger.getStoryline(id) }
  listStorylines(projectId: string): NovelStoryline[] { return this.ledger.listStorylines(projectId) }
  updateStoryline(id: string, patch: { lifecycle?: StorylineLifecycle; maturity?: StorylineMaturity; description?: string }): NovelStoryline | undefined { return this.ledger.updateStoryline(id, patch) }
  maybePromoteMaturity(storylineId: string): NovelStoryline { return this.ledger.maybePromoteMaturity(storylineId) }
  recordProgressForScene(projectId: string, sceneRevisionId: string, intents: Parameters<NarrativeLedgerStore['recordProgressForScene']>[2], status?: ProgressStatus): NovelStorylineProgress[] { return this.ledger.recordProgressForScene(projectId, sceneRevisionId, intents, status) }
  listProgressByStoryline(storylineId: string, statuses?: ProgressStatus[]): NovelStorylineProgress[] { return this.ledger.listProgressByStoryline(storylineId, statuses) }
  listProgressByScene(sceneRevisionId: string): NovelStorylineProgress[] { return this.ledger.listProgressByScene(sceneRevisionId) }
  getProgress(id: string): NovelStorylineProgress | undefined { return this.ledger.getProgress(id) }
  confirmProgress(id: string): NovelStorylineProgress { return this.ledger.confirmProgress(id) }
  markStaleFromChapter(projectId: string, chapterId: string): number { return this.ledger.markStaleFromChapter(projectId, chapterId) }

  // ── V2 双写对账（T05）──
  reconcileV2(projectId: string): import('./v2-reconciliation.js').ReconciliationReport {
    return reconcileV2(this.db, this, projectId)
  }

  // ── 剧情推进轨道投影（第二轮）──
  narrativeMatrix(
    projectId: string,
    options?: import('./narrative-matrix-projection.js').NarrativeMatrixOptions,
  ): import('./narrative-matrix-projection.js').NarrativeMatrixReport {
    return buildNarrativeMatrix(this, projectId, options)
  }

  // ── 实体候选与审核（V2 决策 3）──
  createEntityCandidate(input: Parameters<EntityCandidateStore['createCandidate']>[0]): NovelEntityCandidate { return this.candidates.createCandidate(input) }
  getEntityCandidate(id: string): NovelEntityCandidate | undefined { return this.candidates.getCandidate(id) }
  listEntityCandidates(projectId: string, status?: EntityCandidateStatus): NovelEntityCandidate[] { return this.candidates.listCandidates(projectId, status) }
  countPendingEntityCandidates(projectId: string): number { return this.candidates.countPending(projectId) }
  confirmEntityCandidate(id: string, actorId?: string): NovelEntityCandidate { return this.candidates.confirmCandidate(id, actorId) }
  confirmEntityCandidateWithPromotion(
    id: string,
    actorId: string,
    promote: (candidate: NovelEntityCandidate) => string | null,
  ): { candidate: NovelEntityCandidate; entityId: string | null } {
    return this.candidates.confirmCandidateWithPromotion(id, actorId, promote)
  }
  rejectEntityCandidate(id: string, reason: string, actorId?: string): NovelEntityCandidate { return this.candidates.rejectCandidate(id, reason, actorId) }
  listEntityCandidateReviews(candidateId: string): NovelEntityCandidateReview[] { return this.candidates.listReviews(candidateId) }

  // ── 剧情（narrative）实体轨道 ──
  listNarratives(projectId: string): NovelNarrative[] { return this.narratives.listNarratives(projectId) }
  getNarrative(id: string): NovelNarrative | undefined { return this.narratives.getNarrative(id) }
  createNarrative(input: Omit<NovelNarrative, 'id' | 'createdAt' | 'updatedAt'>): NovelNarrative { return this.narratives.createNarrative(input) }
  updateNarrative(id: string, patch: Partial<NovelNarrative>): NovelNarrative | undefined { return this.narratives.updateNarrative(id, patch) }
  deleteNarrative(id: string): boolean { return this.narratives.deleteNarrative(id) }

  getVolume(id: string): NovelVolume | undefined { return this.chapter.getVolume(id) }
  createVolume(volume: Omit<NovelVolume, 'createdAt' | 'updatedAt'>): NovelVolume { return this.chapter.createVolume(volume) }
  updateVolume(id: string, patch: Partial<NovelVolume>): NovelVolume | undefined { return this.chapter.updateVolume(id, patch) }
  deleteVolume(id: string): boolean { return this.chapter.deleteVolume(id) }

  listHooks(projectId: string): NovelHook[] { return this.chapter.listHooks(projectId) }
  listHooksByChapter(projectId: string, chapterNumber: number): NovelHook[] { return this.chapter.listHooksByChapter(projectId, chapterNumber) }
  getHook(id: string): NovelHook | undefined { return this.chapter.getHook(id) }
  createHook(hook: Omit<NovelHook, 'createdAt' | 'updatedAt'>): NovelHook { return this.chapter.createHook(hook) }
  updateHook(id: string, patch: Partial<NovelHook>): NovelHook | undefined { return this.chapter.updateHook(id, patch) }
  deleteHook(id: string): boolean { return this.chapter.deleteHook(id) }

  listCharacterArcs(projectId: string): NovelCharacterArc[] { return this.chapter.listCharacterArcs(projectId) }
  getCharacterArc(id: string): NovelCharacterArc | undefined { return this.chapter.getCharacterArc(id) }
  getCharacterArcByCharacter(projectId: string, characterId: string): NovelCharacterArc | undefined { return this.chapter.getCharacterArcByCharacter(projectId, characterId) }
  createCharacterArc(arc: Omit<NovelCharacterArc, 'createdAt' | 'updatedAt'>): NovelCharacterArc { return this.chapter.createCharacterArc(arc) }
  updateCharacterArc(id: string, patch: Partial<NovelCharacterArc>): NovelCharacterArc | undefined { return this.chapter.updateCharacterArc(id, patch) }
  deleteCharacterArc(id: string): boolean { return this.chapter.deleteCharacterArc(id) }

  // ── 章节投影观察者 ──

  /**
   * 注册章节投影变更观察者（由 novel-services 接到事件账本记录器）。
   *
   * 只支持单个观察者：这是一个基础设施收口点，不是通用事件总线。
   */
  setChapterProjectionObserver(observer: ChapterProjectionObserver | null): void {
    this.chapterProjectionObserver = observer
  }

  /** 注册实体删除观察者（由 novel-services 接到账本引用清理） */
  setEntityDeletedObserver(observer: EntityDeletedObserver | null): void {
    this.entityDeletedObserver = observer
  }

  /** 删除成功后通知观察者清理账本引用 */
  private notifyEntityDeleted(
    entityType: ProjectionEntityType,
    entityId: string,
    projectId: string | undefined,
    deleted: boolean,
  ): boolean {
    if (deleted && projectId && this.entityDeletedObserver && !this.observerSuppressed) {
      this.entityDeletedObserver(projectId, { entityType, entityId })
    }
    return deleted
  }

  /**
   * 在回调期间临时关闭观察者。
   *
   * 用于 generateAndArrange 这类"自己已经写了一条完整账本事件"的批量流程：
   * 让它们保留语义完整的 story event，而不是被逐字段变更拆成一堆碎片记录。
   */
  runWithoutChapterProjectionObserver<T>(fn: () => T): T {
    const previous = this.observerSuppressed
    this.observerSuppressed = true
    try {
      return fn()
    } finally {
      this.observerSuppressed = previous
    }
  }

  /** 比对更新前后的章节集合，有变化则通知观察者 */
  private notifyChapterProjection<T>(
    entityType: ProjectionEntityType,
    entityId: string,
    projectId: string | undefined,
    before: T | undefined,
    after: T | undefined,
    chaptersOf: (entity: T) => number[],
    origin: string,
  ): void {
    const observer = this.chapterProjectionObserver
    if (!observer || this.observerSuppressed || !projectId) return
    const { added, removed } = diffChapters(
      before ? chaptersOf(before) : [],
      after ? chaptersOf(after) : [],
    )
    if (added.length === 0 && removed.length === 0) return
    observer(projectId, {
      entityType,
      entityId,
      addedChapters: added,
      removedChapters: removed,
      origin,
    })
  }

  // ── Character / Relationship / History ──

  createCharacter(character: Omit<NovelCharacter, 'createdAt' | 'updatedAt'>): NovelCharacter { return this.character.createCharacter(character) }
  updateCharacter(id: string, patch: Partial<NovelCharacter>): NovelCharacter | undefined { return this.character.updateCharacter(id, patch) }
  deleteCharacter(id: string): boolean {
    const projectId = this.character.getCharacter(id)?.projectId
    // character_history 没有外键级联，不清理会留下指向已删角色的悬空出场记录
    // （S4-1 对账在真实库里发现了这样一行）。
    this.character.deleteCharacterHistoryByCharacter(id)
    return this.notifyEntityDeleted('character', id, projectId, this.character.deleteCharacter(id))
  }
  deleteCharacterHistoryByCharacter(characterId: string): number { return this.character.deleteCharacterHistoryByCharacter(characterId) }
  deleteCharacterHistory(historyId: string, projectId?: string): boolean { return this.character.deleteCharacterHistory(historyId, projectId) }
  createCharacterHistory(history: Omit<NovelCharacterHistory, 'id' | 'createdAt'>): NovelCharacterHistory {
    const created = this.character.createCharacterHistory(history)
    this.notifyCharacterAppearance(created.projectId, created.characterId, created.chapterNumber, 'createCharacterHistory')
    return created
  }
  batchCreateCharacterHistory(entries: Array<Omit<NovelCharacterHistory, 'id' | 'createdAt'>>): NovelCharacterHistory[] {
    const created = this.character.batchCreateCharacterHistory(entries)
    for (const entry of created) {
      this.notifyCharacterAppearance(entry.projectId, entry.characterId, entry.chapterNumber, 'batchCreateCharacterHistory')
    }
    return created
  }

  /** 角色没有 chapterSpans，出场由 character_history 的新增行表达 */
  private notifyCharacterAppearance(
    projectId: string,
    characterId: string,
    chapterNumber: number | null,
    origin: string,
  ): void {
    const observer = this.chapterProjectionObserver
    if (!observer || this.observerSuppressed || chapterNumber == null) return
    observer(projectId, {
      entityType: 'character',
      entityId: characterId,
      addedChapters: [chapterNumber],
      removedChapters: [],
      origin,
    })
  }
  listCharacterHistory(projectId: string, characterId?: string): NovelCharacterHistory[] { return this.character.listCharacterHistory(projectId, characterId) }
  getRelationship(relationshipId: string): NovelRelationship | undefined { return this.character.getRelationship(relationshipId) }
  createRelationship(rel: Omit<NovelRelationship, 'createdAt' | 'updatedAt'>): NovelRelationship { return this.character.createRelationship(rel) }
  updateRelationship(id: string, patch: Partial<NovelRelationship>): NovelRelationship | undefined { return this.character.updateRelationship(id, patch) }
  deleteRelationship(id: string): boolean { return this.character.deleteRelationship(id) }

  // ── Conflict ──

  createConflict(conflict: Omit<NovelConflict, 'createdAt' | 'updatedAt'>): NovelConflict {
    const created = this.conflict.createConflict(conflict)
    this.notifyChapterProjection('conflict', created.id, created.projectId, undefined, created, chaptersOfConflict, 'createConflict')
    return created
  }
  updateConflict(id: string, patch: Partial<NovelConflict>): NovelConflict | undefined {
    patch = this.stripFrozenSpans('conflict', id, patch, 'chapterSpans')
    const before = this.conflict.getConflict(id)
    const after = this.conflict.updateConflict(id, patch)
    this.notifyChapterProjection('conflict', id, after?.projectId ?? before?.projectId, before, after, chaptersOfConflict, 'updateConflict')
    return after
  }
  deleteConflict(id: string): boolean {
    const projectId = this.conflict.getConflict(id)?.projectId
    return this.notifyEntityDeleted('conflict', id, projectId, this.conflict.deleteConflict(id))
  }

  // ── Foreshadow / Clue / InfoLayer ──

  createForeshadow(foreshadow: Omit<NovelForeshadow, 'createdAt' | 'updatedAt'>): NovelForeshadow {
    const created = this.foreshadow.createForeshadow(foreshadow)
    this.notifyChapterProjection('foreshadow', created.id, created.projectId, undefined, created, chaptersOfForeshadow, 'createForeshadow')
    return created
  }
  updateForeshadow(id: string, patch: Partial<NovelForeshadow>): NovelForeshadow | undefined {
    patch = this.stripFrozenSpans('foreshadow', id, patch, 'chapterSpans')
    const before = this.foreshadow.getForeshadow(id)
    const after = this.foreshadow.updateForeshadow(id, patch)
    this.notifyChapterProjection('foreshadow', id, after?.projectId ?? before?.projectId, before, after, chaptersOfForeshadow, 'updateForeshadow')
    return after
  }
  deleteForeshadow(id: string): boolean {
    const projectId = this.foreshadow.getForeshadow(id)?.projectId
    return this.notifyEntityDeleted('foreshadow', id, projectId, this.foreshadow.deleteForeshadow(id))
  }
  createClue(clue: Omit<NovelClue, 'createdAt' | 'updatedAt'>): NovelClue {
    const created = this.foreshadow.createClue(clue)
    this.notifyChapterProjection('clue', created.id, created.projectId, undefined, created, chaptersOfClue, 'createClue')
    return created
  }
  updateClue(id: string, patch: Partial<NovelClue>): NovelClue | undefined {
    patch = this.stripFrozenSpans('clue', id, patch, 'chapterSpans')
    const before = this.foreshadow.getClue(id)
    const after = this.foreshadow.updateClue(id, patch)
    this.notifyChapterProjection('clue', id, after?.projectId ?? before?.projectId, before, after, chaptersOfClue, 'updateClue')
    return after
  }
  deleteClue(id: string): boolean {
    const projectId = this.foreshadow.getClue(id)?.projectId
    return this.notifyEntityDeleted('clue', id, projectId, this.foreshadow.deleteClue(id))
  }
  createInformationLayer(layer: Omit<NovelInformationLayer, 'createdAt' | 'updatedAt'>): NovelInformationLayer { return this.foreshadow.createInformationLayer(layer) }
  updateInfoLayer(id: string, updates: Partial<Omit<NovelInformationLayer, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>): NovelInformationLayer | undefined { return this.foreshadow.updateInfoLayer(id, updates) }
  deleteInfoLayer(id: string): boolean { return this.foreshadow.deleteInfoLayer(id) }

  // ── WorldRule / StyleGuide / WritingStyleProfile / Constraint / WorldElement ──

  createWorldRule(rule: Omit<NovelWorldRule, 'createdAt' | 'updatedAt'>): NovelWorldRule { return this.world.createWorldRule(rule) }
  updateWorldRule(id: string, updates: Partial<Omit<NovelWorldRule, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>): NovelWorldRule | undefined { return this.world.updateWorldRule(id, updates) }
  deleteWorldRule(id: string): boolean { return this.world.deleteWorldRule(id) }
  createStyleGuide(style: Omit<NovelStyleGuide, 'createdAt' | 'updatedAt'>): NovelStyleGuide { return this.world.createStyleGuide(style) }
  updateStyleGuide(id: string, updates: Partial<Omit<NovelStyleGuide, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>): NovelStyleGuide | undefined { return this.world.updateStyleGuide(id, updates) }
  deleteStyleGuide(id: string): boolean { return this.world.deleteStyleGuide(id) }
  upsertWritingStyleProfile(projectId: string, input: NovelWritingStyleProfileInput): NovelWritingStyleProfile { return this.world.upsertWritingStyleProfile(projectId, input) }
  createConstraint(constraint: Omit<NovelConstraint, 'createdAt' | 'updatedAt'>): NovelConstraint { return this.world.createConstraint(constraint) }
  updateConstraint(id: string, updates: Partial<Omit<NovelConstraint, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>): NovelConstraint | undefined { return this.world.updateConstraint(id, updates) }
  deleteConstraint(id: string): boolean { return this.world.deleteConstraint(id) }
  getWorldElement(worldElementId: string): NovelWorldElement | undefined { return this.world.getWorldElement(worldElementId) }
  createWorldElement(element: Omit<NovelWorldElement, 'createdAt' | 'updatedAt'>): NovelWorldElement { return this.world.createWorldElement(element) }
  updateWorldElement(id: string, patch: Partial<NovelWorldElement>): NovelWorldElement | undefined { return this.world.updateWorldElement(id, patch) }
  deleteWorldElement(id: string): boolean { return this.world.deleteWorldElement(id) }

  // ── Faction / Location ──

  createFaction(faction: Omit<NovelFaction, 'createdAt' | 'updatedAt'>): NovelFaction {
    const created = this.faction.createFaction(faction)
    this.notifyChapterProjection('faction', created.id, created.projectId, undefined, created, chaptersOfFaction, 'createFaction')
    return created
  }
  updateFaction(id: string, patch: Partial<NovelFaction>): NovelFaction | undefined {
    patch = this.stripFrozenSpans('faction', id, patch, 'chapterSpans')
    const before = this.faction.getFaction(id)
    const after = this.faction.updateFaction(id, patch)
    this.notifyChapterProjection('faction', id, after?.projectId ?? before?.projectId, before, after, chaptersOfFaction, 'updateFaction')
    return after
  }
  deleteFaction(id: string): boolean {
    const projectId = this.faction.getFaction(id)?.projectId
    return this.notifyEntityDeleted('faction', id, projectId, this.faction.deleteFaction(id))
  }
  createLocation(location: Omit<NovelLocation, 'createdAt' | 'updatedAt'>): NovelLocation {
    const created = this.faction.createLocation(location)
    this.notifyChapterProjection('location', created.id, created.projectId, undefined, created, chaptersOfLocation, 'createLocation')
    return created
  }
  updateLocation(id: string, patch: Partial<NovelLocation>): NovelLocation | undefined {
    patch = this.stripFrozenSpans('location', id, patch, 'appearChapters')
    const before = this.faction.getLocation(id)
    const after = this.faction.updateLocation(id, patch)
    this.notifyChapterProjection('location', id, after?.projectId ?? before?.projectId, before, after, chaptersOfLocation, 'updateLocation')
    return after
  }
  deleteLocation(id: string): boolean {
    const projectId = this.faction.getLocation(id)?.projectId
    return this.notifyEntityDeleted('location', id, projectId, this.faction.deleteLocation(id))
  }

  // ── Item ──

  createItem(item: Omit<NovelItem, 'createdAt' | 'updatedAt'>): NovelItem {
    const created = this.item.createItem(item)
    this.notifyChapterProjection('item', created.id, created.projectId, undefined, created, chaptersOfItem, 'createItem')
    return created
  }
  updateItem(id: string, patch: Partial<NovelItem>): NovelItem | undefined {
    patch = this.stripFrozenSpans('item', id, patch, 'chapterSpans')
    const before = this.item.getItem(id)
    const after = this.item.updateItem(id, patch)
    this.notifyChapterProjection('item', id, after?.projectId ?? before?.projectId, before, after, chaptersOfItem, 'updateItem')
    return after
  }
  deleteItem(id: string): boolean {
    const projectId = this.item.getItem(id)?.projectId
    return this.notifyEntityDeleted('item', id, projectId, this.item.deleteItem(id))
  }

  // ── NodePosition / Marker / Edge / AgentLog（GraphStore）──

  listNodePositions(projectId: string): NovelNodePosition[] { return this.graph.listNodePositions(projectId) }
  upsertNodePosition(
    projectId: string,
    nodeType: NovelNodeType,
    entityId: string,
    posX: number,
    posY: number,
  ): NovelNodePosition { return this.graph.upsertNodePosition(projectId, nodeType, entityId, posX, posY) }
  deleteNodePosition(projectId: string, nodeType: NovelNodeType, entityId: string): boolean { return this.graph.deleteNodePosition(projectId, nodeType, entityId) }

  listMarkers(projectId: string): NovelMarker[] { return this.graph.listMarkers(projectId) }
  getMarker(markerId: string): NovelMarker | undefined { return this.graph.getMarker(markerId) }
  createMarker(marker: Omit<NovelMarker, 'createdAt' | 'updatedAt'>): NovelMarker { return this.graph.createMarker(marker) }
  updateMarker(id: string, patch: Partial<NovelMarker>): NovelMarker | undefined { return this.graph.updateMarker(id, patch) }
  deleteMarker(id: string): boolean { return this.graph.deleteMarker(id) }

  createEdge(
    projectId: string,
    edge: Omit<NovelEdge, 'id' | 'projectId' | 'createdAt' | 'updatedAt' | 'auto'> & { auto?: boolean },
  ): NovelEdge { return this.graph.createEdge(projectId, edge) }
  deleteEdge(id: string): boolean { return this.graph.deleteEdge(id) }
  deleteEdgesByEntity(entityId: string): number { return this.graph.deleteEdgesByEntity(entityId) }
  listEdgesByEntity(entityId: string, opts?: { direction?: 'source' | 'target' | 'both'; edgeType?: string }): NovelEdge[] { return this.graph.listEdgesByEntity(entityId, opts) }
  updateEdgeLabel(edgeId: string, label: string): NovelEdge | undefined { return this.graph.updateEdgeLabel(edgeId, label) }

  insertAgentLog(input: Omit<NovelAgentLog, 'id' | 'createdAt'>): NovelAgentLog { return this.graph.insertAgentLog(input) }
  getAgentLog(id: string, opts?: { loadPayload?: boolean }): NovelAgentLog | undefined { return this.graph.getAgentLog(id, opts) }
  listAgentLogs(projectId: string, filter?: { chapterNumber?: number; agentType?: string }, limit?: number): NovelAgentLogSummary[] { return this.graph.listAgentLogs(projectId, filter, limit) }
  deleteAgentLogsByProject(projectId: string): number { return this.graph.deleteAgentLogsByProject(projectId) }
  cleanupExpiredPayloads(nowMs?: number): { deleted: number; scanned: number } { return this.graph.cleanupExpiredPayloads(nowMs) }
  insertContextSectionMetrics(rows: import('./context-section-metrics.js').ContextSectionMetricInput[]): void { return this.graph.insertContextSectionMetrics(rows) }
  listContextSectionMetrics(projectId: string, chapterNumber?: number): import('./context-section-metrics.js').ContextSectionMetric[] { return this.graph.listContextSectionMetrics(projectId, chapterNumber) }

  // ── Review（AuthorIntent / ChapterReview）──

  createAuthorIntent(intent: Omit<NovelAuthorIntent, 'createdAt'>): NovelAuthorIntent { return this.graph.createAuthorIntent(intent) }
  createChapterReview(review: Omit<NovelChapterReview, 'createdAt'>): NovelChapterReview { return this.graph.createChapterReview(review) }
  getChapterReview(chapterId: string): NovelChapterReview | undefined { return this.graph.getChapterReview(chapterId) }

  // ── DeduplicateService ──

  deduplicateEntities(projectId: string, options?: { dryRun?: boolean }): DeduplicateReport { return this.deduplicator.deduplicateEntities(projectId, options) }
  mergeWithPlan(projectId: string, groups: SimilarityGroup[]): { totalMerged: number } { return this.deduplicator.mergeWithPlan(projectId, groups) }
}
