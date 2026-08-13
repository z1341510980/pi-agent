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
import { canTransitionChapterStatus } from '@repo/shared/novel'
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
import { ChapterStore, hashChapterContent } from './stores/chapter-store.js'
import { ScenePlanStore } from './stores/scene-plan-store.js'
import { NarrativeLedgerStore } from './stores/narrative-ledger-store.js'
import { EntityCandidateStore } from './stores/entity-candidate-store.js'
import { EntityAppearanceStore, type AppearanceRole, type AppearanceSource } from './stores/entity-appearance-store.js'
import type { AppearanceReconcileReport } from './migration-acceptance.js'
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
    this.graph = new GraphStore(db)
    const deleteEdges = (id: string): number => this.graph.deleteEdgesByEntity(id)
    const renumberService = new ChapterRenumberService(db)
    // novel_entity_appearances 对 chapter_id 无外键，删章必须在事务内手动清理，
    // 否则留下孤儿出场行（reconcile orphanRows 来源）。闭包惰性求值，
    // 与 deleteEdges 相同模式，构造顺序不影响。
    const removeChapterAppearances = (projectId: string, chapterId: string): number =>
      this.entityAppearances.removeChapterAppearances(projectId, chapterId)

    this.project = new ProjectStore(db)
    this.chapter = new ChapterStore(db, deleteEdges, renumberService, removeChapterAppearances)
    this.character = new CharacterStore(db, deleteEdges)
    this.conflict = new ConflictStore(db, deleteEdges)
    this.foreshadow = new ForeshadowStore(db, deleteEdges)
    this.world = new WorldStore(db, deleteEdges)
    this.faction = new FactionStore(db, deleteEdges)
    this.item = new ItemStore(db, deleteEdges)
    this.scenePlan = new ScenePlanStore(db)
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

  /**
   * 在单个事务中执行一组写操作（better-sqlite3 嵌套事务走 SAVEPOINT，
   * 内部各 Store 自开的 db.transaction 不受影响）。
   * 用于跨实体批量写入（如 Memory applyChanges）：任一写入失败整体回滚，
   * 避免半成品记忆变更留在库里。
   */
  withTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  /** 底层数据库连接（审计/迁移等基础能力需要；只读引用，禁止外部 close） */
  get database(): Database.Database {
    return this.db
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

  // ── P2：实体出场关系统一（novel_entity_appearances，唯一出场写面）──
  /** 记录一批实体在本章的出场（幂等：UNIQUE 约束防重） */
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
  removeChapterEntityAppearances(projectId: string, chapterId: string, entityType: string, entityId: string): number {
    return this.entityAppearances.removeChapterEntityAppearances(projectId, chapterId, entityType, entityId)
  }
  /** P2 对账（store 层，MigrationAcceptance 形态）：spans 展开 vs appearance 记录 */
  reconcileEntityAppearances(projectId: string): AppearanceReconcileReport {
    return this.entityAppearances.reconcileAppearances(projectId)
  }
  /**
   * 某章出场实体 ID（appearance 表为唯一来源，2026-08-12 逻辑统一）。
   */
  listChapterAppearanceIds(input: {
    projectId: string
    chapterNumber: number
    entityType: string
  }): string[] {
    const chapterId = this.getChapter(input.projectId, input.chapterNumber)?.id
    if (!chapterId) return []
    return this.entityAppearances
      .listByChapter(input.projectId, chapterId)
      .filter((r) => r.entityType === input.entityType)
      .map((r) => r.entityId)
  }
  /**
   * 三入口统一写点（ai-arrange 落库 / Memory applyChanges / syncChapterDimensions）：
   * appearance 表为唯一出场写面（2026-08-12 逻辑统一，原 appearanceV2Write 门控移除）。
   * 写入后把新增出场通知投影观察者（账本记录器依赖该触发写 `<类型>.arranged`）。
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
    if (input.entityIds.length === 0) return
    const chapterId = input.chapterId
      ?? this.getChapter(input.projectId, input.chapterNumber)?.id
    if (!chapterId) return
    const observer = this.chapterProjectionObserver
    const numberByChapterId = new Map(
      this.listChapters(input.projectId).map((c) => [c.id, c.chapterNumber] as const),
    )
    // 逐实体记录前快照（差集判定）
    const beforeByEntity = new Map<string, Set<string>>()
    for (const entityId of input.entityIds) {
      beforeByEntity.set(entityId, new Set(
        this.entityAppearances.listByEntity(input.projectId, input.entityType, entityId),
      ))
    }
    this.addChapterAppearances({ ...input, chapterId })
    if (!observer || this.observerSuppressed) return
    // 差集：本次新增的章节（同章已记录过的实体不再重复通知）
    for (const entityId of input.entityIds) {
      const after = new Set(
        this.entityAppearances.listByEntity(input.projectId, input.entityType, entityId),
      )
      const before = beforeByEntity.get(entityId) ?? new Set<string>()
      const added: number[] = []
      for (const cid of after) {
        if (before.has(cid)) continue
        const num = numberByChapterId.get(cid)
        if (num != null && !added.includes(num)) added.push(num)
      }
      if (added.length === 0) continue
      observer(input.projectId, {
        entityType: input.entityType as ProjectionEntityType,
        entityId,
        addedChapters: added.sort((a, b) => a - b),
        removedChapters: [],
        origin: input.source ?? 'arranged-appearance',
      })
    }
  }

  /**
   * 实体 update patch 携带出场字段时：剥离旧列不落库，按新旧章节集合做差同步 appearance
   * （2026-08-12 逻辑统一：chapterSpansFrozen 转正，旧列冻结、appearance 唯一权威）。
   * 新增章写入（source='frozen-redirect'）；移除章删除该实体对应 appearance 行；
   * 同时把差集通知投影观察者（账本记录器从 appearance 差集触发）。
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

    const nextChapters = new Set(
      spanKey === 'appearChapters'
        ? (patch[spanKey] as unknown as number[]).filter((n) => Number.isInteger(n) && n >= 1)
        : expandChapterSpans(patch[spanKey] as unknown as Array<[number, number]>),
    )

    const chapters = this.listChapters(projectId)
    const numberById = new Map(chapters.map((c) => [c.id, c.chapterNumber] as const))
    const idByNumber = new Map(chapters.map((c) => [c.chapterNumber, c.id] as const))

    const currentChapters = new Set<number>()
    for (const cid of this.entityAppearances.listByEntity(projectId, entityType, entityId)) {
      const num = numberById.get(cid)
      if (num !== undefined) currentChapters.add(num)
    }

    const added: number[] = []
    for (const ch of nextChapters) {
      if (currentChapters.has(ch)) continue
      const chapterId = idByNumber.get(ch)
      if (!chapterId) continue // 章节未落库（规划超前）不写 appearance
      this.addChapterAppearances({
        projectId,
        chapterId,
        entityType,
        entityIds: [entityId],
        role: 'present',
        source: 'frozen-redirect',
      })
      added.push(ch)
    }
    const removed: number[] = []
    for (const ch of currentChapters) {
      if (nextChapters.has(ch)) continue
      const chapterId = idByNumber.get(ch)
      if (!chapterId) continue
      this.entityAppearances.removeChapterEntityAppearances(projectId, chapterId, entityType, entityId)
      removed.push(ch)
    }
    // 投影观察者：账本记录器依赖"新增出场"触发（spans 已剥离，实体字段不再变化，
    // 必须在这里直接通知，否则 chapter-projection-recorder 收不到）。
    if ((added.length > 0 || removed.length > 0) && this.chapterProjectionObserver && !this.observerSuppressed) {
      this.chapterProjectionObserver(projectId, {
        entityType,
        entityId,
        addedChapters: added.sort((a, b) => a - b),
        removedChapters: removed.sort((a, b) => a - b),
        origin: 'frozen-redirect',
      })
    }

    const next = { ...patch }
    delete next[spanKey]
    return next
  }

  /**
   * 实体 create 时携带出场字段 → 写 appearance（2026-08-12 逻辑统一：
   * appearance 表为唯一出场写面，create 路径一并收口）。
   */
  private recordCreateAppearances<T extends { projectId: string; id: string; chapterSpans?: Array<[number, number]>; appearChapters?: number[] }>(
    entityType: ProjectionEntityType,
    entity: T,
  ): void {
    const spans = entity.chapterSpans ?? []
    const flat = entity.appearChapters ?? []
    const chapterNumbers = new Set<number>([
      ...spans.flatMap(([s, e]) => {
        const out: number[] = []
        for (let ch = s; ch <= e; ch += 1) out.push(ch)
        return out
      }),
      ...flat.filter((n) => Number.isInteger(n) && n >= 1),
    ])
    if (chapterNumbers.size === 0) return
    for (const ch of chapterNumbers) {
      const chapterId = this.getChapter(entity.projectId, ch)?.id
      if (!chapterId) continue
      this.addChapterAppearances({
        projectId: entity.projectId,
        chapterId,
        entityType,
        entityIds: [entity.id],
        role: 'present',
        source: 'create',
      })
    }
  }

  /** 按实体类型反查 projectId（供 stripFrozenSpans / syncManualSpanAppearances 判断项目级 flag） */
  private getEntityProjectId(entityType: ProjectionEntityType, entityId: string): string | undefined {
    switch (entityType) {
      case 'conflict': return this.conflict.getConflict(entityId)?.projectId
      case 'foreshadow': return this.foreshadow.getForeshadow(entityId)?.projectId
      case 'clue': return this.foreshadow.getClue(entityId)?.projectId
      case 'faction': return this.faction.getFaction(entityId)?.projectId
      case 'location': return this.faction.getLocation(entityId)?.projectId
      case 'item': return this.item.getItem(entityId)?.projectId
      case 'narrative': return this.narratives.getNarrative(entityId)?.projectId
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
  updateChapter(id: string, patch: Partial<NovelChapter>, versionSource?: VersionSource): NovelChapter | undefined {
    return this.withTransaction(() => {
      const before = this.chapter.getChapterById(id)
      if (before) {
        const contentChanges = patch.content !== undefined && patch.content !== before.content
        if (before.status === 'published' && contentChanges) {
          throw new Error('已发布章节不能修改正文，请先进入修订流程')
        }
        if (patch.status !== undefined && !canTransitionChapterStatus(before.status, patch.status)) {
          throw new Error(`章节状态不能从 ${before.status} 变更为 ${patch.status}`)
        }
      }
      const updated = this.chapter.updateChapter(id, patch, versionSource)
      if (before && updated && patch.content !== undefined && patch.content !== before.content) {
        this.markDerivedStateStaleForRewrite(updated)
        this.bindReviewsToCurrentRevision(updated)
      }
      return updated
    })
  }
  updateChapterContent(id: string, content: string, wordCount: number, versionSource?: VersionSource): NovelChapter | undefined {
    return this.withTransaction(() => {
      const before = this.chapter.getChapterById(id)
      if (before?.status === 'published' && content !== before.content) {
        throw new Error('已发布章节不能修改正文，请先进入修订流程')
      }
      const updated = this.chapter.updateChapterContent(id, content, wordCount, versionSource)
      if (before && updated && content !== before.content) {
        this.markDerivedStateStaleForRewrite(updated)
        this.bindReviewsToCurrentRevision(updated)
      }
      return updated
    })
  }
  /** 正式创作/群聊/完成命令的统一落库入口：正文变化后进入待审。 */
  completeChapterForReview(
    id: string,
    patch: Omit<Partial<NovelChapter>, 'id' | 'status'>,
    versionSource?: VersionSource,
  ): NovelChapter | undefined {
    return this.withTransaction(() => {
      const before = this.chapter.getChapterById(id)
      if (!before) return undefined
      if (before.status === 'published') {
        throw new Error('已发布章节不能修改正文，请先进入修订流程')
      }
      const updated = this.chapter.updateChapter(id, { ...patch, status: 'review' }, versionSource)
      if (updated && patch.content !== undefined && patch.content !== before.content) {
        this.markDerivedStateStaleForRewrite(updated)
        this.bindReviewsToCurrentRevision(updated)
      }
      return updated
    })
  }
  /** 仅供 NovelEngine 在完成审稿、版本和前序章节校验后执行发布。 */
  publishReviewedChapter(id: string): NovelChapter | undefined {
    return this.withTransaction(() => {
      const chapter = this.chapter.getChapterById(id)
      if (!chapter) return undefined
      if (chapter.status !== 'review') {
        throw new Error(`只有待审章节可以发布，当前状态为 ${chapter.status}`)
      }
      return this.chapter.updateChapter(id, { status: 'published' })
    })
  }
  listChapterVersions(chapterId: string): ChapterVersionSummary[] { return this.chapter.listChapterVersions(chapterId) }
  getChapterVersion(versionId: string): ChapterVersion | undefined { return this.chapter.getChapterVersion(versionId) }
  createVersionSnapshot(chapterId: string, source: VersionSource): ChapterVersion | undefined { return this.chapter.createVersionSnapshot(chapterId, source) }
  getLatestVersion(chapterId: string): ChapterVersion | undefined { return this.chapter.getLatestVersion(chapterId) }
  rollbackToVersion(chapterId: string, targetVersionId: string): { savedVersionId: string; currentContent: string; currentWordCount: number } {
    return this.withTransaction(() => {
      const before = this.chapter.getChapterById(chapterId)
      if (before?.status === 'published') throw new Error('已发布章节不能回滚正文，请先进入修订流程')
      const result = this.chapter.rollbackToVersion(chapterId, targetVersionId)
      let chapter = this.chapter.getChapterById(chapterId)
      if (chapter) {
        chapter = this.chapter.updateChapter(chapterId, { status: 'drafting' }) ?? chapter
        this.markDerivedStateStaleForRewrite(chapter)
        this.bindReviewsToCurrentRevision(chapter)
      }
      return result
    })
  }
  appendContentRevision(chapter: NovelChapter, source: VersionSource | null): ContentRevision | undefined { return this.chapter.appendContentRevision(chapter, source) }
  listContentRevisions(chapterId: string): ContentRevisionSummary[] { return this.chapter.listContentRevisions(chapterId) }
  getContentRevision(revisionId: string): ContentRevision | undefined { return this.chapter.getContentRevision(revisionId) }
  getCurrentContentRevision(chapterId: string): ContentRevision | undefined { return this.chapter.getCurrentContentRevision(chapterId) }
  rollbackToContentRevision(chapterId: string, revisionId: string): { appliedRevisionId: string; content: string; wordCount: number } {
    return this.withTransaction(() => {
      const before = this.chapter.getChapterById(chapterId)
      if (before?.status === 'published') throw new Error('已发布章节不能回滚正文，请先进入修订流程')
      const result = this.chapter.rollbackToContentRevision(chapterId, revisionId)
      let chapter = this.chapter.getChapterById(chapterId)
      if (chapter) {
        chapter = this.chapter.updateChapter(chapterId, { status: 'drafting' }) ?? chapter
        this.markDerivedStateStaleForRewrite(chapter)
        this.bindReviewsToCurrentRevision(chapter)
      }
      return result
    })
  }
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

  private markDerivedStateStaleForRewrite(chapter: NovelChapter): number {
    const hasLaterContent = this.chapter.listChapters(chapter.projectId)
      .some(candidate => candidate.chapterNumber > chapter.chapterNumber && candidate.content?.trim().length > 0)
    return hasLaterContent
      ? this.ledger.markStaleFromChapter(chapter.projectId, chapter.id)
      : 0
  }

  private bindReviewsToCurrentRevision(chapter: NovelChapter): void {
    const revision = this.chapter.getCurrentContentRevision(chapter.id)
    if (!revision || revision.content !== chapter.content) return
    this.graph.bindChapterReviewsToRevision(chapter.id, hashChapterContent(chapter.content), revision.id)
  }

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
  createNarrative(input: Omit<NovelNarrative, 'id' | 'createdAt' | 'updatedAt'>): NovelNarrative {
    const created = this.narratives.createNarrative(input)
    this.recordCreateAppearances('narrative', created)
    return created
  }
  updateNarrative(id: string, patch: Partial<NovelNarrative>): NovelNarrative | undefined {
    patch = this.stripFrozenSpans('narrative', id, patch, 'chapterSpans')
    return this.narratives.updateNarrative(id, patch)
  }
  deleteNarrative(id: string): boolean {
    const projectId = this.narratives.getNarrative(id)?.projectId
    const deleted = this.narratives.deleteNarrative(id)
    if (deleted && projectId) this.entityAppearances.removeEntityAppearances(projectId, 'narrative', id)
    return deleted
  }

  getVolume(id: string): NovelVolume | undefined { return this.chapter.getVolume(id) }
  createVolume(volume: Omit<NovelVolume, 'createdAt' | 'updatedAt'>): NovelVolume { return this.chapter.createVolume(volume) }
  updateVolume(id: string, patch: Partial<NovelVolume>): NovelVolume | undefined { return this.chapter.updateVolume(id, patch) }
  deleteVolume(id: string): boolean { return this.chapter.deleteVolume(id) }

  listHooks(projectId: string): NovelHook[] { return this.chapter.listHooks(projectId) }
  listHooksByChapter(projectId: string, chapterNumber: number): NovelHook[] { return this.chapter.listHooksByChapter(projectId, chapterNumber) }
  getHook(id: string): NovelHook | undefined { return this.chapter.getHook(id) }

  /** P4 chunk versionKey：前后章锚点与信息差的统一更新时间指纹。 */
  getContextAnchorVersion(projectId: string): number | null {
    const timestamps = [
      ...this.listHooks(projectId).map((h) => h.updatedAt),
      ...this.listInformationLayers(projectId).map((l) => l.updatedAt),
    ]
    return timestamps.length > 0 ? Math.max(...timestamps) : null
  }
  createHook(hook: Omit<NovelHook, 'createdAt' | 'updatedAt'>): NovelHook { return this.chapter.createHook(hook) }
  updateHook(id: string, patch: Partial<NovelHook>): NovelHook | undefined { return this.chapter.updateHook(id, patch) }
  deleteHook(id: string): boolean { return this.chapter.deleteHook(id) }

  listCharacterArcs(projectId: string): NovelCharacterArc[] { return this.chapter.listCharacterArcs(projectId) }
  getCharacterArc(id: string): NovelCharacterArc | undefined { return this.chapter.getCharacterArc(id) }
  getCharacterArcByCharacter(projectId: string, characterId: string): NovelCharacterArc | undefined { return this.chapter.getCharacterArcByCharacter(projectId, characterId) }
  createCharacterArc(arc: Omit<NovelCharacterArc, 'createdAt' | 'updatedAt'>): NovelCharacterArc {
    const character = this.character.getCharacter(arc.characterId)
    if (!character || character.projectId !== arc.projectId) {
      throw new Error(`Character ${arc.characterId} does not belong to project ${arc.projectId}`)
    }
    if (this.chapter.getCharacterArcByCharacter(arc.projectId, arc.characterId)) {
      throw new Error(`Character ${arc.characterId} already has an arc in project ${arc.projectId}`)
    }

    return this.withTransaction(() => {
      const created = this.chapter.createCharacterArc(arc)
      if (character.arcStage !== created.currentStage) {
        this.character.updateCharacter(character.id, { arcStage: created.currentStage })
      }
      return created
    })
  }
  updateCharacterArc(id: string, patch: Partial<NovelCharacterArc>): NovelCharacterArc | undefined {
    const existing = this.chapter.getCharacterArc(id)
    if (!existing) return undefined
    if (patch.projectId !== undefined && patch.projectId !== existing.projectId) {
      throw new Error(`Character arc ${id} cannot change project`)
    }
    if (patch.characterId !== undefined && patch.characterId !== existing.characterId) {
      throw new Error(`Character arc ${id} cannot change character`)
    }

    const character = this.character.getCharacter(existing.characterId)
    if (!character || character.projectId !== existing.projectId) {
      throw new Error(
        `Character ${existing.characterId} does not belong to project ${existing.projectId}`
      )
    }

    return this.withTransaction(() => {
      const updated = this.chapter.updateCharacterArc(id, {
        ...patch,
        projectId: existing.projectId,
        characterId: existing.characterId
      })
      if (updated && character.arcStage !== updated.currentStage) {
        this.character.updateCharacter(character.id, { arcStage: updated.currentStage })
      }
      return updated
    })
  }
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
    return this.withTransaction(() => {
      const projectId = this.character.getCharacter(id)?.projectId
      // character_history 没有外键级联，不清理会留下指向已删角色的悬空出场记录
      // （S4-1 对账在真实库里发现了这样一行）。
      this.character.deleteCharacterHistoryByCharacter(id)
      this.character.deleteRelationshipsByCharacter(id)
      const deleted = this.notifyEntityDeleted('character', id, projectId, this.character.deleteCharacter(id))
      // P2 级联：character 是出场高频实体，删除后不清理 appearance 会留孤儿行
      if (deleted && projectId) this.entityAppearances.removeEntityAppearances(projectId, 'character', id)
      return deleted
    })
  }
  deleteCharacterHistoryByCharacter(characterId: string): number { return this.character.deleteCharacterHistoryByCharacter(characterId) }
  deleteCharacterHistory(historyId: string, projectId?: string): boolean { return this.character.deleteCharacterHistory(historyId, projectId) }
  createCharacterHistory(history: Omit<NovelCharacterHistory, 'id' | 'createdAt'>): NovelCharacterHistory {
    this.assertCharacterBelongsToProject(history.characterId, history.projectId)
    const created = this.character.createCharacterHistory(history)
    this.notifyCharacterAppearance(created.projectId, created.characterId, created.chapterNumber, 'createCharacterHistory')
    return created
  }
  batchCreateCharacterHistory(entries: Array<Omit<NovelCharacterHistory, 'id' | 'createdAt'>>): NovelCharacterHistory[] {
    for (const entry of entries) {
      this.assertCharacterBelongsToProject(entry.characterId, entry.projectId)
    }
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
  createRelationship(rel: Omit<NovelRelationship, 'createdAt' | 'updatedAt'>): NovelRelationship {
    this.assertCharacterBelongsToProject(rel.characterA, rel.projectId)
    this.assertCharacterBelongsToProject(rel.characterB, rel.projectId)
    return this.character.createRelationship(rel)
  }
  updateRelationship(id: string, patch: Partial<NovelRelationship>): NovelRelationship | undefined {
    const existing = this.character.getRelationship(id)
    if (!existing) return undefined
    if (patch.projectId !== undefined && patch.projectId !== existing.projectId) {
      throw new Error(`Relationship ${id} cannot change project`)
    }
    this.assertCharacterBelongsToProject(patch.characterA ?? existing.characterA, existing.projectId)
    this.assertCharacterBelongsToProject(patch.characterB ?? existing.characterB, existing.projectId)
    return this.character.updateRelationship(id, { ...patch, projectId: existing.projectId })
  }
  deleteRelationship(id: string): boolean { return this.character.deleteRelationship(id) }

  private assertCharacterBelongsToProject(characterId: string, projectId: string): NovelCharacter {
    const character = this.character.getCharacter(characterId)
    if (!character || character.projectId !== projectId) {
      throw new Error(`Character ${characterId} does not belong to project ${projectId}`)
    }
    return character
  }

  // ── Conflict ──

  createConflict(conflict: Omit<NovelConflict, 'createdAt' | 'updatedAt'>): NovelConflict {
    const created = this.conflict.createConflict(conflict)
    this.recordCreateAppearances('conflict', created)
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
    const deleted = this.notifyEntityDeleted('conflict', id, projectId, this.conflict.deleteConflict(id))
    if (deleted && projectId) this.entityAppearances.removeEntityAppearances(projectId, 'conflict', id)
    return deleted
  }

  // ── Foreshadow / Clue / InfoLayer ──

  createForeshadow(foreshadow: Omit<NovelForeshadow, 'createdAt' | 'updatedAt'>): NovelForeshadow {
    const created = this.foreshadow.createForeshadow(foreshadow)
    this.recordCreateAppearances('foreshadow', created)
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
    const deleted = this.notifyEntityDeleted('foreshadow', id, projectId, this.foreshadow.deleteForeshadow(id))
    if (deleted && projectId) this.entityAppearances.removeEntityAppearances(projectId, 'foreshadow', id)
    return deleted
  }
  createClue(clue: Omit<NovelClue, 'createdAt' | 'updatedAt'>): NovelClue {
    const created = this.foreshadow.createClue(clue)
    this.recordCreateAppearances('clue', created)
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
    const deleted = this.notifyEntityDeleted('clue', id, projectId, this.foreshadow.deleteClue(id))
    if (deleted && projectId) this.entityAppearances.removeEntityAppearances(projectId, 'clue', id)
    return deleted
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
    this.recordCreateAppearances('faction', created)
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
    const deleted = this.notifyEntityDeleted('faction', id, projectId, this.faction.deleteFaction(id))
    if (deleted && projectId) this.entityAppearances.removeEntityAppearances(projectId, 'faction', id)
    return deleted
  }
  createLocation(location: Omit<NovelLocation, 'createdAt' | 'updatedAt'>): NovelLocation {
    const created = this.faction.createLocation(location)
    this.recordCreateAppearances('location', created)
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
    const deleted = this.notifyEntityDeleted('location', id, projectId, this.faction.deleteLocation(id))
    if (deleted && projectId) this.entityAppearances.removeEntityAppearances(projectId, 'location', id)
    return deleted
  }

  // ── Item ──

  createItem(item: Omit<NovelItem, 'createdAt' | 'updatedAt'>): NovelItem {
    const created = this.item.createItem(item)
    this.recordCreateAppearances('item', created)
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
    const deleted = this.notifyEntityDeleted('item', id, projectId, this.item.deleteItem(id))
    if (deleted && projectId) this.entityAppearances.removeEntityAppearances(projectId, 'item', id)
    return deleted
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
  getAcceptedChapterReviewForContent(chapterId: string, contentHash: string): NovelChapterReview | undefined { return this.graph.getAcceptedChapterReviewForContent(chapterId, contentHash) }

  // ── DeduplicateService ──

  deduplicateEntities(projectId: string, options?: { dryRun?: boolean }): DeduplicateReport { return this.deduplicator.deduplicateEntities(projectId, options) }
  mergeWithPlan(projectId: string, groups: SimilarityGroup[]): { totalMerged: number } { return this.deduplicator.mergeWithPlan(projectId, groups) }
}
