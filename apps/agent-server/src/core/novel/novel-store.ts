/**
 * NovelStore：小说创作系统统一存储
 *
 * 管理所有小说相关表的 CRUD 操作。
 * 实现 NovelPromptStores 接口，供 NovelPromptBuilder 读取数据。
 *
 * 设计模式（与 ProviderConfigStore 一致）：
 * - 构造时预编译 SQL
 * - 内存 Map 作为读缓存
 * - 同步写入（写操作同时更新内存和 SQLite）
 *
 * 所有查询按 projectId 过滤，项目删除时级联删除所有关联数据。
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
  NovelAuthorIntent,
  NovelChapterReview,
} from './types.js'

// ── 行类型（SQLite snake_case → TypeScript camelCase 映射）──

interface ProjectRow {
  id: string; title: string; genre: string; synopsis: string
  target_words: number; current_volume: number; current_chapter: number
  current_stage: string; status: string; created_at: number; updated_at: number
}

interface ChapterRow {
  id: string; project_id: string; volume: number; chapter_number: number
  title: string; content: string; word_count: number; status: string
  narrative_task: string; acceptance_result: string | null
  created_at: number; updated_at: number
}

interface CharacterRow {
  id: string; project_id: string; name: string; description: string
  identity: string; personality: string; appearance: string
  current_state: string; current_goal: string; current_pressure: string
  secret: string; arc_stage: string; arc_history: string; speech_style: string
  created_at: number; updated_at: number
}

interface RelationshipRow {
  id: string; project_id: string; character_a: string; character_b: string
  relation_type: string; current_stage: string; stage_history: string
  created_at: number; updated_at: number
}

interface ForeshadowRow {
  id: string; project_id: string; description: string; category: string
  status: string; first_chapter: number | null; last_chapter: number | null
  recover_by_chapter: number | null; linked_characters: string; linked_clues: string
  created_at: number; updated_at: number
}

interface ClueRow {
  id: string; project_id: string; description: string; points_to: string
  progress: number; current_step: string; next_step: string
  is_misleading: number; linked_foreshadow: string | null
  created_at: number; updated_at: number
}

interface ConflictRow {
  id: string; project_id: string; description: string; type: string
  intensity: number; stage: string; participants: string
  created_at: number; updated_at: number
}

interface WorldRuleRow {
  id: string; project_id: string; category: string; rule: string
  cost: string | null; is_fixed: number; created_at: number; updated_at: number
}

interface ConstraintRow {
  id: string; project_id: string; type: string; scope: string; rule: string
  is_active: number; related_entity_id: string | null
  created_at: number; updated_at: number
}

interface InfoLayerRow {
  id: string; project_id: string; info_description: string
  author_knows: number; reader_knows: number; character_knowledge: string
  reveal_stage: string | null; reveal_chapter: number | null; is_revealed: number
  created_at: number; updated_at: number
}

interface StyleGuideRow {
  id: string; project_id: string; category: string; rule: string
  example: string | null; created_at: number; updated_at: number
}

interface AuthorIntentRow {
  id: string; project_id: string; chapter_id: string | null
  intent_type: string; description: string; target_entity_id: string | null
  created_at: number
}

interface ChapterReviewRow {
  id: string; project_id: string; chapter_id: string
  consistency_score: number | null; character_score: number | null
  task_completion_score: number | null; clue_progress_score: number | null
  foreshadow_status_score: number | null; conflict_change_score: number | null
  pacing_score: number | null; info_control_score: number | null
  reader_hook_score: number | null; style_score: number | null
  overall_score: number | null; verdict: string | null
  issues: string | null; suggestions: string | null
  reviewed_by: string | null; created_at: number
}

// ── 工具函数 ──

function parseJSON<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T } catch { return fallback }
}

function now(): number {
  return Math.floor(Date.now() / 1000)
}

// ── NovelStore ──

export class NovelStore implements NovelPromptStores {
  // 预编译语句
  private readonly stmtGetProject: Database.Statement
  private readonly stmtListChapters: Database.Statement
  private readonly stmtGetChapter: Database.Statement
  private readonly stmtListCharacters: Database.Statement
  private readonly stmtListRelationships: Database.Statement
  private readonly stmtListForeshadowing: Database.Statement
  private readonly stmtListClues: Database.Statement
  private readonly stmtListConflicts: Database.Statement
  private readonly stmtListWorldRules: Database.Statement
  private readonly stmtListStyleGuides: Database.Statement
  private readonly stmtListConstraints: Database.Statement
  private readonly stmtListInfoLayers: Database.Statement
  private readonly stmtListRecentChapters: Database.Statement

  constructor(private db: Database.Database) {
    this.stmtGetProject = db.prepare('SELECT * FROM novel_projects WHERE id = ?')
    this.stmtListChapters = db.prepare('SELECT * FROM novel_chapters WHERE project_id = ? ORDER BY chapter_number ASC')
    this.stmtGetChapter = db.prepare('SELECT * FROM novel_chapters WHERE project_id = ? AND chapter_number = ?')
    this.stmtListCharacters = db.prepare('SELECT * FROM novel_characters WHERE project_id = ? ORDER BY created_at ASC')
    this.stmtListRelationships = db.prepare('SELECT * FROM novel_relationships WHERE project_id = ? ORDER BY created_at ASC')
    this.stmtListForeshadowing = db.prepare('SELECT * FROM novel_foreshadowing WHERE project_id = ? ORDER BY created_at ASC')
    this.stmtListClues = db.prepare('SELECT * FROM novel_clues WHERE project_id = ? ORDER BY created_at ASC')
    this.stmtListConflicts = db.prepare('SELECT * FROM novel_conflicts WHERE project_id = ? ORDER BY created_at ASC')
    this.stmtListWorldRules = db.prepare('SELECT * FROM novel_world_rules WHERE project_id = ? ORDER BY created_at ASC')
    this.stmtListStyleGuides = db.prepare('SELECT * FROM novel_style_guides WHERE project_id = ? ORDER BY created_at ASC')
    this.stmtListConstraints = db.prepare('SELECT * FROM novel_constraints WHERE project_id = ? AND is_active = 1 ORDER BY created_at ASC')
    this.stmtListInfoLayers = db.prepare('SELECT * FROM novel_information_layers WHERE project_id = ? ORDER BY created_at ASC')
    this.stmtListRecentChapters = db.prepare('SELECT * FROM novel_chapters WHERE project_id = ? AND status = ? ORDER BY chapter_number DESC LIMIT ?')
  }

  // ═══════════════════════════════════════════════════════════════
  // NovelPromptStores 接口实现（供 NovelPromptBuilder 使用）
  // ═══════════════════════════════════════════════════════════════

  getProject(projectId: string): NovelProject | undefined {
    const row = this.stmtGetProject.get(projectId) as ProjectRow | undefined
    return row ? this.rowToProject(row) : undefined
  }

  listWorldRules(projectId: string): NovelWorldRule[] {
    return (this.stmtListWorldRules.all(projectId) as WorldRuleRow[]).map((r) => this.rowToWorldRule(r))
  }

  listStyleGuide(projectId: string): NovelStyleGuide[] {
    return (this.stmtListStyleGuides.all(projectId) as StyleGuideRow[]).map((r) => this.rowToStyleGuide(r))
  }

  listCharacters(projectId: string): NovelCharacter[] {
    return (this.stmtListCharacters.all(projectId) as CharacterRow[]).map((r) => this.rowToCharacter(r))
  }

  listRelationships(projectId: string): NovelRelationship[] {
    return (this.stmtListRelationships.all(projectId) as RelationshipRow[]).map((r) => this.rowToRelationship(r))
  }

  listConflicts(projectId: string): NovelConflict[] {
    return (this.stmtListConflicts.all(projectId) as ConflictRow[]).map((r) => this.rowToConflict(r))
  }

  listForeshadowing(projectId: string): NovelForeshadow[] {
    return (this.stmtListForeshadowing.all(projectId) as ForeshadowRow[]).map((r) => this.rowToForeshadow(r))
  }

  listClues(projectId: string): NovelClue[] {
    return (this.stmtListClues.all(projectId) as ClueRow[]).map((r) => this.rowToClue(r))
  }

  listInformationLayers(projectId: string): NovelInformationLayer[] {
    return (this.stmtListInfoLayers.all(projectId) as InfoLayerRow[]).map((r) => this.rowToInfoLayer(r))
  }

  listConstraints(projectId: string): NovelConstraint[] {
    return (this.stmtListConstraints.all(projectId) as ConstraintRow[]).map((r) => this.rowToConstraint(r))
  }

  listRecentChapters(projectId: string, limit: number): NovelChapter[] {
    const rows = this.stmtListRecentChapters.all(projectId, 'published', limit) as ChapterRow[]
    return rows.map((r) => this.rowToChapter(r)).reverse()
  }

  getChapter(projectId: string, chapterNumber: number): NovelChapter | undefined {
    const row = this.stmtGetChapter.get(projectId, chapterNumber) as ChapterRow | undefined
    return row ? this.rowToChapter(row) : undefined
  }

  /** 按 ID 获取章节 */
  getChapterById(chapterId: string): NovelChapter | undefined {
    const row = this.db.prepare('SELECT * FROM novel_chapters WHERE id = ?').get(chapterId) as ChapterRow | undefined
    return row ? this.rowToChapter(row) : undefined
  }

  /** 按 ID 获取角色 */
  getCharacter(characterId: string): NovelCharacter | undefined {
    const row = this.db.prepare('SELECT * FROM novel_characters WHERE id = ?').get(characterId) as CharacterRow | undefined
    return row ? this.rowToCharacter(row) : undefined
  }

  /** 按 ID 获取伏笔 */
  getForeshadow(foreshadowId: string): NovelForeshadow | undefined {
    const row = this.db.prepare('SELECT * FROM novel_foreshadowing WHERE id = ?').get(foreshadowId) as ForeshadowRow | undefined
    return row ? this.rowToForeshadow(row) : undefined
  }

  /** 按 ID 获取冲突 */
  getConflict(conflictId: string): NovelConflict | undefined {
    const row = this.db.prepare('SELECT * FROM novel_conflicts WHERE id = ?').get(conflictId) as ConflictRow | undefined
    return row ? this.rowToConflict(row) : undefined
  }

  /** 按 ID 获取线索 */
  getClue(clueId: string): NovelClue | undefined {
    const row = this.db.prepare('SELECT * FROM novel_clues WHERE id = ?').get(clueId) as ClueRow | undefined
    return row ? this.rowToClue(row) : undefined
  }

  /** 按 ID 获取关系 */
  getRelationship(relationshipId: string): NovelRelationship | undefined {
    const row = this.db.prepare('SELECT * FROM novel_relationships WHERE id = ?').get(relationshipId) as RelationshipRow | undefined
    return row ? this.rowToRelationship(row) : undefined
  }

  // ═══════════════════════════════════════════════════════════════
  // 项目 CRUD
  // ═══════════════════════════════════════════════════════════════

  createProject(project: Omit<NovelProject, 'createdAt' | 'updatedAt'>): NovelProject {
    const ts = now()
    const full: NovelProject = { ...project, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_projects (id, title, genre, synopsis, target_words, current_volume, current_chapter, current_stage, status, created_at, updated_at)
      VALUES (@id, @title, @genre, @synopsis, @target_words, @current_volume, @current_chapter, @current_stage, @status, @created_at, @updated_at)
    `).run({
      id: full.id, title: full.title, genre: full.genre, synopsis: full.synopsis,
      target_words: full.targetWords, current_volume: full.currentVolume,
      current_chapter: full.currentChapter, current_stage: full.currentStage,
      status: full.status, created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateProject(id: string, patch: Partial<NovelProject>): NovelProject | undefined {
    const existing = this.getProject(id)
    if (!existing) return undefined
    const updated = { ...existing, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_projects SET title=@title, genre=@genre, synopsis=@synopsis,
      target_words=@target_words, current_volume=@current_volume, current_chapter=@current_chapter,
      current_stage=@current_stage, status=@status, updated_at=@updated_at WHERE id=@id
    `).run({
      id, title: updated.title, genre: updated.genre, synopsis: updated.synopsis,
      target_words: updated.targetWords, current_volume: updated.currentVolume,
      current_chapter: updated.currentChapter, current_stage: updated.currentStage,
      status: updated.status, updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteProject(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_projects WHERE id = ?').run(id)
    return result.changes > 0
  }

  listProjects(): NovelProject[] {
    const rows = this.db.prepare('SELECT * FROM novel_projects ORDER BY updated_at DESC').all() as ProjectRow[]
    return rows.map((r) => this.rowToProject(r))
  }

  // ═══════════════════════════════════════════════════════════════
  // 章节 CRUD
  // ═══════════════════════════════════════════════════════════════

  createChapter(chapter: Omit<NovelChapter, 'createdAt' | 'updatedAt'>): NovelChapter {
    const ts = now()
    const full: NovelChapter = { ...chapter, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_chapters (id, project_id, volume, chapter_number, title, content, word_count, status, narrative_task, acceptance_result, created_at, updated_at)
      VALUES (@id, @project_id, @volume, @chapter_number, @title, @content, @word_count, @status, @narrative_task, @acceptance_result, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, volume: full.volume,
      chapter_number: full.chapterNumber, title: full.title, content: full.content,
      word_count: full.wordCount, status: full.status, narrative_task: full.narrativeTask,
      acceptance_result: full.acceptanceResult, created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateChapter(id: string, patch: Partial<NovelChapter>): NovelChapter | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_chapters WHERE id = ?').get(id) as ChapterRow | undefined
    if (!existing) return undefined
    const current = this.rowToChapter(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_chapters SET title=@title, content=@content, word_count=@word_count,
      status=@status, narrative_task=@narrative_task, acceptance_result=@acceptance_result, updated_at=@updated_at
      WHERE id=@id
    `).run({
      id, title: updated.title, content: updated.content, word_count: updated.wordCount,
      status: updated.status, narrative_task: updated.narrativeTask,
      acceptance_result: updated.acceptanceResult, updated_at: updated.updatedAt,
    })
    return updated
  }

  /** 更新章节内容（仅 content 和 wordCount） */
  updateChapterContent(id: string, content: string, wordCount: number): NovelChapter | undefined {
    this.db.prepare('UPDATE novel_chapters SET content = ?, word_count = ?, updated_at = unixepoch() WHERE id = ?').run(content, wordCount, id)
    return this.getChapterById(id) ?? undefined
  }

  listChapters(projectId: string): NovelChapter[] {
    return (this.stmtListChapters.all(projectId) as ChapterRow[]).map((r) => this.rowToChapter(r))
  }

  // ═══════════════════════════════════════════════════════════════
  // 角色 CRUD
  // ═══════════════════════════════════════════════════════════════

  createCharacter(character: Omit<NovelCharacter, 'createdAt' | 'updatedAt'>): NovelCharacter {
    const ts = now()
    const full: NovelCharacter = { ...character, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_characters (id, project_id, name, description, identity, personality, appearance,
      current_state, current_goal, current_pressure, secret, arc_stage, arc_history, speech_style, created_at, updated_at)
      VALUES (@id, @project_id, @name, @description, @identity, @personality, @appearance,
      @current_state, @current_goal, @current_pressure, @secret, @arc_stage, @arc_history, @speech_style, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, name: full.name, description: full.description,
      identity: full.identity, personality: full.personality, appearance: full.appearance,
      current_state: full.currentState, current_goal: full.currentGoal, current_pressure: full.currentPressure,
      secret: full.secret, arc_stage: full.arcStage, arc_history: full.arcHistory,
      speech_style: full.speechStyle, created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateCharacter(id: string, patch: Partial<NovelCharacter>): NovelCharacter | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_characters WHERE id = ?').get(id) as CharacterRow | undefined
    if (!existing) return undefined
    const current = this.rowToCharacter(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_characters SET name=@name, description=@description, identity=@identity, personality=@personality,
      appearance=@appearance, current_state=@current_state, current_goal=@current_goal, current_pressure=@current_pressure,
      secret=@secret, arc_stage=@arc_stage, arc_history=@arc_history, speech_style=@speech_style, updated_at=@updated_at
      WHERE id=@id
    `).run({
      id, name: updated.name, description: updated.description, identity: updated.identity,
      personality: updated.personality, appearance: updated.appearance,
      current_state: updated.currentState, current_goal: updated.currentGoal,
      current_pressure: updated.currentPressure, secret: updated.secret,
      arc_stage: updated.arcStage, arc_history: updated.arcHistory,
      speech_style: updated.speechStyle, updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteCharacter(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_characters WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ═══════════════════════════════════════════════════════════════
  // 伏笔 CRUD
  // ═══════════════════════════════════════════════════════════════

  createForeshadow(foreshadow: Omit<NovelForeshadow, 'createdAt' | 'updatedAt'>): NovelForeshadow {
    const ts = now()
    const full: NovelForeshadow = { ...foreshadow, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_foreshadowing (id, project_id, description, category, status, first_chapter, last_chapter,
      recover_by_chapter, linked_characters, linked_clues, created_at, updated_at)
      VALUES (@id, @project_id, @description, @category, @status, @first_chapter, @last_chapter,
      @recover_by_chapter, @linked_characters, @linked_clues, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, description: full.description,
      category: full.category, status: full.status, first_chapter: full.firstChapter,
      last_chapter: full.lastChapter, recover_by_chapter: full.recoverByChapter,
      linked_characters: full.linkedCharacters, linked_clues: full.linkedClues,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateForeshadow(id: string, patch: Partial<NovelForeshadow>): NovelForeshadow | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_foreshadowing WHERE id = ?').get(id) as ForeshadowRow | undefined
    if (!existing) return undefined
    const current = this.rowToForeshadow(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_foreshadowing SET description=@description, category=@category, status=@status,
      first_chapter=@first_chapter, last_chapter=@last_chapter, recover_by_chapter=@recover_by_chapter,
      linked_characters=@linked_characters, linked_clues=@linked_clues, updated_at=@updated_at WHERE id=@id
    `).run({
      id, description: updated.description, category: updated.category, status: updated.status,
      first_chapter: updated.firstChapter, last_chapter: updated.lastChapter,
      recover_by_chapter: updated.recoverByChapter, linked_characters: updated.linkedCharacters,
      linked_clues: updated.linkedClues, updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteForeshadow(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_foreshadowing WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ═══════════════════════════════════════════════════════════════
  // 冲突 CRUD
  // ═══════════════════════════════════════════════════════════════

  createConflict(conflict: Omit<NovelConflict, 'createdAt' | 'updatedAt'>): NovelConflict {
    const ts = now()
    const full: NovelConflict = { ...conflict, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_conflicts (id, project_id, description, type, intensity, stage, participants, created_at, updated_at)
      VALUES (@id, @project_id, @description, @type, @intensity, @stage, @participants, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, description: full.description,
      type: full.type, intensity: full.intensity, stage: full.stage,
      participants: full.participants, created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateConflict(id: string, patch: Partial<NovelConflict>): NovelConflict | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_conflicts WHERE id = ?').get(id) as ConflictRow | undefined
    if (!existing) return undefined
    const current = this.rowToConflict(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_conflicts SET description=@description, type=@type, intensity=@intensity,
      stage=@stage, participants=@participants, updated_at=@updated_at WHERE id=@id
    `).run({
      id, description: updated.description, type: updated.type, intensity: updated.intensity,
      stage: updated.stage, participants: updated.participants, updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteConflict(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_conflicts WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ═══════════════════════════════════════════════════════════════
  // 线索 CRUD
  // ═══════════════════════════════════════════════════════════════

  createClue(clue: Omit<NovelClue, 'createdAt' | 'updatedAt'>): NovelClue {
    const ts = now()
    const full: NovelClue = { ...clue, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_clues (id, project_id, description, points_to, progress, current_step, next_step, is_misleading, linked_foreshadow, created_at, updated_at)
      VALUES (@id, @project_id, @description, @points_to, @progress, @current_step, @next_step, @is_misleading, @linked_foreshadow, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, description: full.description,
      points_to: full.pointsTo, progress: full.progress, current_step: full.currentStep,
      next_step: full.nextStep, is_misleading: full.isMisleading ? 1 : 0,
      linked_foreshadow: full.linkedForeshadow, created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateClue(id: string, patch: Partial<NovelClue>): NovelClue | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_clues WHERE id = ?').get(id) as ClueRow | undefined
    if (!existing) return undefined
    const current = this.rowToClue(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_clues SET description=@description, points_to=@points_to, progress=@progress,
      current_step=@current_step, next_step=@next_step, is_misleading=@is_misleading,
      linked_foreshadow=@linked_foreshadow, updated_at=@updated_at WHERE id=@id
    `).run({
      id, description: updated.description, points_to: updated.pointsTo, progress: updated.progress,
      current_step: updated.currentStep, next_step: updated.nextStep,
      is_misleading: updated.isMisleading ? 1 : 0, linked_foreshadow: updated.linkedForeshadow,
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteClue(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_clues WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ═══════════════════════════════════════════════════════════════
  // 关系 CRUD
  // ═══════════════════════════════════════════════════════════════

  createRelationship(rel: Omit<NovelRelationship, 'createdAt' | 'updatedAt'>): NovelRelationship {
    const ts = now()
    const full: NovelRelationship = { ...rel, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_relationships (id, project_id, character_a, character_b, relation_type, current_stage, stage_history, created_at, updated_at)
      VALUES (@id, @project_id, @character_a, @character_b, @relation_type, @current_stage, @stage_history, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, character_a: full.characterA,
      character_b: full.characterB, relation_type: full.relationType,
      current_stage: full.currentStage, stage_history: full.stageHistory,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateRelationship(id: string, patch: Partial<NovelRelationship>): NovelRelationship | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_relationships WHERE id = ?').get(id) as RelationshipRow | undefined
    if (!existing) return undefined
    const current = this.rowToRelationship(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_relationships SET character_a=@character_a, character_b=@character_b,
      relation_type=@relation_type, current_stage=@current_stage, stage_history=@stage_history, updated_at=@updated_at WHERE id=@id
    `).run({
      id, character_a: updated.characterA, character_b: updated.characterB,
      relation_type: updated.relationType, current_stage: updated.currentStage,
      stage_history: updated.stageHistory, updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteRelationship(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_relationships WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ═══════════════════════════════════════════════════════════════
  // 世界规则 CRUD
  // ═══════════════════════════════════════════════════════════════

  createWorldRule(rule: Omit<NovelWorldRule, 'createdAt' | 'updatedAt'>): NovelWorldRule {
    const ts = now()
    const full: NovelWorldRule = { ...rule, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_world_rules (id, project_id, category, rule, cost, is_fixed, created_at, updated_at)
      VALUES (@id, @project_id, @category, @rule, @cost, @is_fixed, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, category: full.category, rule: full.rule,
      cost: full.cost, is_fixed: full.isFixed ? 1 : 0, created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateWorldRule(id: string, updates: Partial<Omit<NovelWorldRule, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>): NovelWorldRule | undefined {
    const fields: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(updates)) {
      const dbKey = this.camelToSnake(key)
      fields.push(`${dbKey} = ?`)
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
    }
    if (fields.length === 0) {
      const row = this.db.prepare('SELECT * FROM novel_world_rules WHERE id = ?').get(id) as WorldRuleRow | undefined
      return row ? this.rowToWorldRule(row) : undefined
    }
    fields.push('updated_at = unixepoch()')
    values.push(id)
    this.db.prepare(`UPDATE novel_world_rules SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    const row = this.db.prepare('SELECT * FROM novel_world_rules WHERE id = ?').get(id) as WorldRuleRow | undefined
    return row ? this.rowToWorldRule(row) : undefined
  }

  deleteWorldRule(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_world_rules WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ═══════════════════════════════════════════════════════════════
  // 风格指南 CRUD
  // ═══════════════════════════════════════════════════════════════

  createStyleGuide(style: Omit<NovelStyleGuide, 'createdAt' | 'updatedAt'>): NovelStyleGuide {
    const ts = now()
    const full: NovelStyleGuide = { ...style, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_style_guides (id, project_id, category, rule, example, created_at, updated_at)
      VALUES (@id, @project_id, @category, @rule, @example, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, category: full.category, rule: full.rule,
      example: full.example, created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateStyleGuide(id: string, updates: Partial<Omit<NovelStyleGuide, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>): NovelStyleGuide | undefined {
    const fields: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(updates)) {
      const dbKey = this.camelToSnake(key)
      fields.push(`${dbKey} = ?`)
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
    }
    if (fields.length === 0) {
      const row = this.db.prepare('SELECT * FROM novel_style_guides WHERE id = ?').get(id) as StyleGuideRow | undefined
      return row ? this.rowToStyleGuide(row) : undefined
    }
    fields.push('updated_at = unixepoch()')
    values.push(id)
    this.db.prepare(`UPDATE novel_style_guides SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    const row = this.db.prepare('SELECT * FROM novel_style_guides WHERE id = ?').get(id) as StyleGuideRow | undefined
    return row ? this.rowToStyleGuide(row) : undefined
  }

  deleteStyleGuide(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_style_guides WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ═══════════════════════════════════════════════════════════════
  // 创作约束 CRUD
  // ═══════════════════════════════════════════════════════════════

  createConstraint(constraint: Omit<NovelConstraint, 'createdAt' | 'updatedAt'>): NovelConstraint {
    const ts = now()
    const full: NovelConstraint = { ...constraint, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_constraints (id, project_id, type, scope, rule, is_active, related_entity_id, created_at, updated_at)
      VALUES (@id, @project_id, @type, @scope, @rule, @is_active, @related_entity_id, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, type: full.type, scope: full.scope,
      rule: full.rule, is_active: full.isActive ? 1 : 0, related_entity_id: full.relatedEntityId,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateConstraint(id: string, updates: Partial<Omit<NovelConstraint, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>): NovelConstraint | undefined {
    const fields: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(updates)) {
      const dbKey = this.camelToSnake(key)
      fields.push(`${dbKey} = ?`)
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
    }
    if (fields.length === 0) {
      const row = this.db.prepare('SELECT * FROM novel_constraints WHERE id = ?').get(id) as ConstraintRow | undefined
      return row ? this.rowToConstraint(row) : undefined
    }
    fields.push('updated_at = unixepoch()')
    values.push(id)
    this.db.prepare(`UPDATE novel_constraints SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    const row = this.db.prepare('SELECT * FROM novel_constraints WHERE id = ?').get(id) as ConstraintRow | undefined
    return row ? this.rowToConstraint(row) : undefined
  }

  deleteConstraint(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_constraints WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ═══════════════════════════════════════════════════════════════
  // 信息差 CRUD
  // ═══════════════════════════════════════════════════════════════

  createInformationLayer(layer: Omit<NovelInformationLayer, 'createdAt' | 'updatedAt'>): NovelInformationLayer {
    const ts = now()
    const full: NovelInformationLayer = { ...layer, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_information_layers (id, project_id, info_description, author_knows, reader_knows, character_knowledge, reveal_stage, reveal_chapter, is_revealed, created_at, updated_at)
      VALUES (@id, @project_id, @info_description, @author_knows, @reader_knows, @character_knowledge, @reveal_stage, @reveal_chapter, @is_revealed, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, info_description: full.infoDescription,
      author_knows: full.authorKnows ? 1 : 0, reader_knows: full.readerKnows ? 1 : 0,
      character_knowledge: full.characterKnowledge, reveal_stage: full.revealStage,
      reveal_chapter: full.revealChapter, is_revealed: full.isRevealed ? 1 : 0,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateInfoLayer(id: string, updates: Partial<Omit<NovelInformationLayer, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>): NovelInformationLayer | undefined {
    const fields: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(updates)) {
      const dbKey = this.camelToSnake(key)
      fields.push(`${dbKey} = ?`)
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
    }
    if (fields.length === 0) {
      const row = this.db.prepare('SELECT * FROM novel_information_layers WHERE id = ?').get(id) as InfoLayerRow | undefined
      return row ? this.rowToInfoLayer(row) : undefined
    }
    fields.push('updated_at = unixepoch()')
    values.push(id)
    this.db.prepare(`UPDATE novel_information_layers SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    const row = this.db.prepare('SELECT * FROM novel_information_layers WHERE id = ?').get(id) as InfoLayerRow | undefined
    return row ? this.rowToInfoLayer(row) : undefined
  }

  deleteInfoLayer(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_information_layers WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ═══════════════════════════════════════════════════════════════
  // 作者意图 CRUD
  // ═══════════════════════════════════════════════════════════════

  createAuthorIntent(intent: Omit<NovelAuthorIntent, 'createdAt'>): NovelAuthorIntent {
    const ts = now()
    const full: NovelAuthorIntent = { ...intent, createdAt: ts }
    this.db.prepare(`
      INSERT INTO novel_author_intents (id, project_id, chapter_id, intent_type, description, target_entity_id, created_at)
      VALUES (@id, @project_id, @chapter_id, @intent_type, @description, @target_entity_id, @created_at)
    `).run({
      id: full.id, project_id: full.projectId, chapter_id: full.chapterId,
      intent_type: full.intentType, description: full.description,
      target_entity_id: full.targetEntityId, created_at: full.createdAt,
    })
    return full
  }

  // ═══════════════════════════════════════════════════════════════
  // 章节验收 CRUD
  // ═══════════════════════════════════════════════════════════════

  createChapterReview(review: Omit<NovelChapterReview, 'createdAt'>): NovelChapterReview {
    const ts = now()
    const full: NovelChapterReview = { ...review, createdAt: ts }
    this.db.prepare(`
      INSERT INTO novel_chapter_reviews (id, project_id, chapter_id, consistency_score, character_score,
      task_completion_score, clue_progress_score, foreshadow_status_score, conflict_change_score,
      pacing_score, info_control_score, reader_hook_score, style_score, overall_score, verdict,
      issues, suggestions, reviewed_by, created_at)
      VALUES (@id, @project_id, @chapter_id, @consistency_score, @character_score,
      @task_completion_score, @clue_progress_score, @foreshadow_status_score, @conflict_change_score,
      @pacing_score, @info_control_score, @reader_hook_score, @style_score, @overall_score, @verdict,
      @issues, @suggestions, @reviewed_by, @created_at)
    `).run({
      id: full.id, project_id: full.projectId, chapter_id: full.chapterId,
      consistency_score: full.consistencyScore, character_score: full.characterScore,
      task_completion_score: full.taskCompletionScore, clue_progress_score: full.clueProgressScore,
      foreshadow_status_score: full.foreshadowStatusScore, conflict_change_score: full.conflictChangeScore,
      pacing_score: full.pacingScore, info_control_score: full.infoControlScore,
      reader_hook_score: full.readerHookScore, style_score: full.styleScore,
      overall_score: full.overallScore, verdict: full.verdict,
      issues: full.issues, suggestions: full.suggestions, reviewed_by: full.reviewedBy,
      created_at: full.createdAt,
    })
    return full
  }

  getChapterReview(chapterId: string): NovelChapterReview | undefined {
    const row = this.db.prepare('SELECT * FROM novel_chapter_reviews WHERE chapter_id = ? ORDER BY created_at DESC LIMIT 1').get(chapterId) as ChapterReviewRow | undefined
    return row ? this.rowToChapterReview(row) : undefined
  }

  // ═══════════════════════════════════════════════════════════════
  // 行 → 对象 转换方法
  // ═══════════════════════════════════════════════════════════════

  private rowToProject(row: ProjectRow): NovelProject {
    return {
      id: row.id, title: row.title, genre: row.genre, synopsis: row.synopsis,
      targetWords: row.target_words, currentVolume: row.current_volume,
      currentChapter: row.current_chapter, currentStage: row.current_stage as NovelProject['currentStage'],
      status: row.status as NovelProject['status'],
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToChapter(row: ChapterRow): NovelChapter {
    return {
      id: row.id, projectId: row.project_id, volume: row.volume,
      chapterNumber: row.chapter_number, title: row.title, content: row.content,
      wordCount: row.word_count, status: row.status as NovelChapter['status'],
      narrativeTask: row.narrative_task, acceptanceResult: row.acceptance_result,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToCharacter(row: CharacterRow): NovelCharacter {
    return {
      id: row.id, projectId: row.project_id, name: row.name, description: row.description,
      identity: row.identity, personality: row.personality, appearance: row.appearance,
      currentState: row.current_state, currentGoal: row.current_goal,
      currentPressure: row.current_pressure, secret: row.secret,
      arcStage: row.arc_stage, arcHistory: row.arc_history, speechStyle: row.speech_style,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToRelationship(row: RelationshipRow): NovelRelationship {
    return {
      id: row.id, projectId: row.project_id, characterA: row.character_a,
      characterB: row.character_b, relationType: row.relation_type,
      currentStage: row.current_stage, stageHistory: row.stage_history,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToForeshadow(row: ForeshadowRow): NovelForeshadow {
    return {
      id: row.id, projectId: row.project_id, description: row.description,
      category: row.category, status: row.status as NovelForeshadow['status'],
      firstChapter: row.first_chapter, lastChapter: row.last_chapter,
      recoverByChapter: row.recover_by_chapter, linkedCharacters: row.linked_characters,
      linkedClues: row.linked_clues, createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToClue(row: ClueRow): NovelClue {
    return {
      id: row.id, projectId: row.project_id, description: row.description,
      pointsTo: row.points_to, progress: row.progress, currentStep: row.current_step,
      nextStep: row.next_step, isMisleading: row.is_misleading === 1,
      linkedForeshadow: row.linked_foreshadow, createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToConflict(row: ConflictRow): NovelConflict {
    return {
      id: row.id, projectId: row.project_id, description: row.description,
      type: row.type as NovelConflict['type'], intensity: row.intensity,
      stage: row.stage as NovelConflict['stage'], participants: row.participants,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToWorldRule(row: WorldRuleRow): NovelWorldRule {
    return {
      id: row.id, projectId: row.project_id, category: row.category, rule: row.rule,
      cost: row.cost, isFixed: row.is_fixed === 1, createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToConstraint(row: ConstraintRow): NovelConstraint {
    return {
      id: row.id, projectId: row.project_id, type: row.type as NovelConstraint['type'],
      scope: row.scope as NovelConstraint['scope'], rule: row.rule,
      isActive: row.is_active === 1, relatedEntityId: row.related_entity_id,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToInfoLayer(row: InfoLayerRow): NovelInformationLayer {
    return {
      id: row.id, projectId: row.project_id, infoDescription: row.info_description,
      authorKnows: row.author_knows === 1, readerKnows: row.reader_knows === 1,
      characterKnowledge: row.character_knowledge, revealStage: row.reveal_stage,
      revealChapter: row.reveal_chapter, isRevealed: row.is_revealed === 1,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToStyleGuide(row: StyleGuideRow): NovelStyleGuide {
    return {
      id: row.id, projectId: row.project_id, category: row.category, rule: row.rule,
      example: row.example, createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToChapterReview(row: ChapterReviewRow): NovelChapterReview {
    return {
      id: row.id, projectId: row.project_id, chapterId: row.chapter_id,
      consistencyScore: row.consistency_score, characterScore: row.character_score,
      taskCompletionScore: row.task_completion_score, clueProgressScore: row.clue_progress_score,
      foreshadowStatusScore: row.foreshadow_status_score, conflictChangeScore: row.conflict_change_score,
      pacingScore: row.pacing_score, infoControlScore: row.info_control_score,
      readerHookScore: row.reader_hook_score, styleScore: row.style_score,
      overallScore: row.overall_score, verdict: row.verdict as NovelChapterReview['verdict'],
      issues: row.issues, suggestions: row.suggestions, reviewedBy: row.reviewed_by,
      createdAt: row.created_at,
    }
  }

  private camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
  }
}
