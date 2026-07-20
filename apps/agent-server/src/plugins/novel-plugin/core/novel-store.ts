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
  VersionSource,
  DeduplicateReport,
  SimilarityGroup,
} from './types.js'
import { ProjectStore } from './stores/project-store.js'
import { ChapterStore } from './stores/chapter-store.js'
import { CharacterStore } from './stores/character-store.js'
import { ConflictStore } from './stores/conflict-store.js'
import { ForeshadowStore } from './stores/foreshadow-store.js'
import { WorldStore } from './stores/world-store.js'
import { FactionStore } from './stores/faction-store.js'
import { ItemStore } from './stores/item-store.js'
import { GraphStore } from './stores/graph-store.js'
import { ChapterRenumberService } from './stores/chapter-renumber-service.js'
import { DeduplicateService } from './stores/deduplicate-service.js'

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
  private readonly deduplicator: DeduplicateService

  constructor(private db: Database.Database) {
    // GraphStore 拥有 deleteEdgesByEntity，先实例化供其他 Store 注入
    this.graph = new GraphStore(db)
    const deleteEdges = (id: string) => this.graph.deleteEdgesByEntity(id)
    const renumberService = new ChapterRenumberService(db)

    this.project = new ProjectStore(db)
    this.chapter = new ChapterStore(db, deleteEdges, renumberService)
    this.character = new CharacterStore(db, deleteEdges)
    this.conflict = new ConflictStore(db, deleteEdges)
    this.foreshadow = new ForeshadowStore(db, deleteEdges)
    this.world = new WorldStore(db, deleteEdges)
    this.faction = new FactionStore(db, deleteEdges)
    this.item = new ItemStore(db, deleteEdges)

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
  deleteChapter(id: string): boolean { return this.chapter.deleteChapter(id) }

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

  // ── Character / Relationship / History ──

  createCharacter(character: Omit<NovelCharacter, 'createdAt' | 'updatedAt' | 'participatingConflicts'> & { participatingConflicts?: string }): NovelCharacter { return this.character.createCharacter(character) }
  updateCharacter(id: string, patch: Partial<NovelCharacter>): NovelCharacter | undefined { return this.character.updateCharacter(id, patch) }
  deleteCharacter(id: string): boolean { return this.character.deleteCharacter(id) }
  deleteCharacterHistoryByCharacter(characterId: string): number { return this.character.deleteCharacterHistoryByCharacter(characterId) }
  deleteCharacterHistory(historyId: string, projectId?: string): boolean { return this.character.deleteCharacterHistory(historyId, projectId) }
  createCharacterHistory(history: Omit<NovelCharacterHistory, 'id' | 'createdAt'>): NovelCharacterHistory { return this.character.createCharacterHistory(history) }
  batchCreateCharacterHistory(entries: Array<Omit<NovelCharacterHistory, 'id' | 'createdAt'>>): NovelCharacterHistory[] { return this.character.batchCreateCharacterHistory(entries) }
  listCharacterHistory(projectId: string, characterId?: string): NovelCharacterHistory[] { return this.character.listCharacterHistory(projectId, characterId) }
  getRelationship(relationshipId: string): NovelRelationship | undefined { return this.character.getRelationship(relationshipId) }
  createRelationship(rel: Omit<NovelRelationship, 'createdAt' | 'updatedAt'>): NovelRelationship { return this.character.createRelationship(rel) }
  updateRelationship(id: string, patch: Partial<NovelRelationship>): NovelRelationship | undefined { return this.character.updateRelationship(id, patch) }
  deleteRelationship(id: string): boolean { return this.character.deleteRelationship(id) }

  // ── Conflict ──

  createConflict(conflict: Omit<NovelConflict, 'createdAt' | 'updatedAt'>): NovelConflict { return this.conflict.createConflict(conflict) }
  updateConflict(id: string, patch: Partial<NovelConflict>): NovelConflict | undefined { return this.conflict.updateConflict(id, patch) }
  deleteConflict(id: string): boolean { return this.conflict.deleteConflict(id) }

  // ── Foreshadow / Clue / InfoLayer ──

  createForeshadow(foreshadow: Omit<NovelForeshadow, 'createdAt' | 'updatedAt'>): NovelForeshadow { return this.foreshadow.createForeshadow(foreshadow) }
  updateForeshadow(id: string, patch: Partial<NovelForeshadow>): NovelForeshadow | undefined { return this.foreshadow.updateForeshadow(id, patch) }
  deleteForeshadow(id: string): boolean { return this.foreshadow.deleteForeshadow(id) }
  createClue(clue: Omit<NovelClue, 'createdAt' | 'updatedAt'>): NovelClue { return this.foreshadow.createClue(clue) }
  updateClue(id: string, patch: Partial<NovelClue>): NovelClue | undefined { return this.foreshadow.updateClue(id, patch) }
  deleteClue(id: string): boolean { return this.foreshadow.deleteClue(id) }
  createInformationLayer(layer: Omit<NovelInformationLayer, 'createdAt' | 'updatedAt'>): NovelInformationLayer { return this.foreshadow.createInformationLayer(layer) }
  updateInfoLayer(id: string, updates: Partial<Omit<NovelInformationLayer, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>): NovelInformationLayer | undefined { return this.foreshadow.updateInfoLayer(id, updates) }
  deleteInfoLayer(id: string): boolean { return this.foreshadow.deleteInfoLayer(id) }
  linkForeshadowToInfoLayer(foreshadowId: string, infoLayerId: string): void { return this.foreshadow.linkForeshadowToInfoLayer(foreshadowId, infoLayerId) }
  unlinkForeshadowFromInfoLayer(foreshadowId: string, infoLayerId: string): void { return this.foreshadow.unlinkForeshadowFromInfoLayer(foreshadowId, infoLayerId) }

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

  createFaction(faction: Omit<NovelFaction, 'createdAt' | 'updatedAt'>): NovelFaction { return this.faction.createFaction(faction) }
  updateFaction(id: string, patch: Partial<NovelFaction>): NovelFaction | undefined { return this.faction.updateFaction(id, patch) }
  deleteFaction(id: string): boolean { return this.faction.deleteFaction(id) }
  createLocation(location: Omit<NovelLocation, 'createdAt' | 'updatedAt'>): NovelLocation { return this.faction.createLocation(location) }
  updateLocation(id: string, patch: Partial<NovelLocation>): NovelLocation | undefined { return this.faction.updateLocation(id, patch) }
  deleteLocation(id: string): boolean { return this.faction.deleteLocation(id) }

  // ── Item ──

  createItem(item: Omit<NovelItem, 'createdAt' | 'updatedAt'>): NovelItem { return this.item.createItem(item) }
  updateItem(id: string, patch: Partial<NovelItem>): NovelItem | undefined { return this.item.updateItem(id, patch) }
  deleteItem(id: string): boolean { return this.item.deleteItem(id) }

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

  insertAgentLog(input: Omit<NovelAgentLog, 'id' | 'createdAt'>): NovelAgentLog { return this.graph.insertAgentLog(input) }
  getAgentLog(id: string): NovelAgentLog | undefined { return this.graph.getAgentLog(id) }
  listAgentLogs(projectId: string, filter?: { chapterNumber?: number; agentType?: string }, limit?: number): NovelAgentLogSummary[] { return this.graph.listAgentLogs(projectId, filter, limit) }
  deleteAgentLogsByProject(projectId: string): number { return this.graph.deleteAgentLogsByProject(projectId) }

  // ── Review（AuthorIntent / ChapterReview）──

  createAuthorIntent(intent: Omit<NovelAuthorIntent, 'createdAt'>): NovelAuthorIntent { return this.graph.createAuthorIntent(intent) }
  createChapterReview(review: Omit<NovelChapterReview, 'createdAt'>): NovelChapterReview { return this.graph.createChapterReview(review) }
  getChapterReview(chapterId: string): NovelChapterReview | undefined { return this.graph.getChapterReview(chapterId) }

  // ── DeduplicateService ──

  deduplicateEntities(projectId: string, options?: { dryRun?: boolean }): DeduplicateReport { return this.deduplicator.deduplicateEntities(projectId, options) }
  mergeWithPlan(projectId: string, groups: SimilarityGroup[]): { totalMerged: number } { return this.deduplicator.mergeWithPlan(projectId, groups) }
}
