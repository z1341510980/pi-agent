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
import { randomUUID } from 'node:crypto'
import type { NovelPromptStores } from './prompt-builder.js'
import type {
  NovelProject,
  NovelChapter,
  NovelCharacter,
  NovelRelationship,
  NovelForeshadow,
  NovelClue,
  NovelConflict,
  ConflictTier,
  NovelWorldRule,
  NovelConstraint,
  NovelInformationLayer,
  NovelStyleGuide,
  NovelAuthorIntent,
  NovelChapterReview,
  NovelCharacterHistory,
  NovelNodePosition,
  NovelNodeType,
  NovelFaction,
  NovelLocation,
  NovelWorldElement,
  NovelEdge,
  NovelAgentLog,
  NovelAgentLogSummary,
  NovelAgentLogStatus,
  NovelMarker,
  NovelVolume,
} from './types.js'

// ── 行类型（SQLite snake_case → TypeScript camelCase 映射）──

interface ProjectRow {
  id: string; title: string; genre: string; synopsis: string; outline: string
  target_words: number; current_volume: number; current_chapter: number
  current_stage: string; status: string; created_at: number; updated_at: number
}

interface ChapterRow {
  id: string; project_id: string; volume: number; chapter_number: number
  title: string; content: string; word_count: number; status: string
  narrative_task: string; outline: string; volume_id: string | null
  acceptance_result: string | null
  created_at: number; updated_at: number
}

interface VolumeRow {
  id: string; project_id: string; volume_number: number; title: string
  outline: string; sort_order: number; created_at: number; updated_at: number
}

interface CharacterRow {
  id: string; project_id: string; name: string; description: string
  identity: string; personality: string; appearance: string
  current_state: string; current_goal: string; current_pressure: string
  secret: string; arc_stage: string; arc_history: string; speech_style: string
  is_protagonist: number
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
  first_chapter: number | null; last_chapter: number | null; tier: string
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

interface NodePositionRow {
  id: string; project_id: string; node_type: string; entity_id: string
  pos_x: number; pos_y: number; updated_at: number
}

interface CharacterHistoryRow {
  id: string; project_id: string; character_id: string
  chapter_id: string | null; chapter_number: number | null
  field_name: string; old_value: string | null; new_value: string | null
  reason: string | null; created_at: number
}

interface FactionRow {
  id: string; project_id: string; name: string; description: string
  type: string; leader_id: string | null; ideology: string; strength: string
  resources: string; allies: string; enemies: string; status: string
  first_chapter: number | null; last_chapter: number | null
  created_at: number; updated_at: number
}

interface LocationRow {
  id: string; project_id: string; name: string; description: string
  type: string; parent_id: string | null; faction_id: string | null
  significance: string; first_chapter: number | null; status: string
  appear_chapters: string
  created_at: number; updated_at: number
}

interface WorldElementRow {
  id: string; project_id: string; category: string; name: string
  description: string; parent_id: string | null; attributes: string
  created_at: number; updated_at: number
}

interface MarkerRow {
  id: string; project_id: string; chapter: number; title: string; note: string
  type: string; color: string; entity_type: string | null; entity_id: string | null
  created_at: number; updated_at: number
}

interface EdgeRow {
  id: string; project_id: string
  source_id: string; source_type: string
  target_id: string; target_type: string
  edge_type: string; label: string; auto: number
  created_at: number; updated_at: number
}

interface AgentLogRow {
  id: string; project_id: string; chapter_number: number
  agent_type: string; agent_name: string
  display_agent_type: string; display_agent_name: string
  phase: string
  system_prompt: string; chapter_context: string; user_message: string
  task_input: string; user_instructions: string
  tools: string; tool_names: string
  result: string; result_length: number
  duration_ms: number; status: string; error: string
  session_id: string; created_at: number
}

// ── 工具函数 ──

function parseJSON<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T } catch { return fallback }
}

function now(): number {
  return Math.floor(Date.now() / 1000)
}

/** 防御性：将任意值安全转为 SQLite 可绑定的 string */
function bindString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v
  if (v == null) return fallback
  if (Array.isArray(v)) return JSON.stringify(v)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
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
  private readonly stmtListNodePositions: Database.Statement
  private readonly stmtUpsertNodePosition: Database.Statement
  private readonly stmtDeleteNodePosition: Database.Statement
  private readonly stmtListCharacterHistoryByProject: Database.Statement
  private readonly stmtListCharacterHistoryByCharacter: Database.Statement
  private readonly stmtListFactions: Database.Statement
  private readonly stmtListLocations: Database.Statement
  private readonly stmtListWorldElements: Database.Statement
  private readonly stmtListMarkers: Database.Statement
  private readonly stmtListEdges: Database.Statement
  private readonly stmtDeleteEdge: Database.Statement
  private readonly stmtDeleteEdgesByEntity: Database.Statement
  private readonly stmtInsertAgentLog: Database.Statement
  private readonly stmtGetAgentLog: Database.Statement
  private readonly stmtListAgentLogsByProject: Database.Statement
  private readonly stmtListAgentLogsByChapter: Database.Statement
  private readonly stmtListAgentLogsByAgent: Database.Statement
  private readonly stmtDeleteAgentLogsByProject: Database.Statement

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
    this.stmtListNodePositions = db.prepare('SELECT * FROM novel_node_positions WHERE project_id = ? ORDER BY updated_at ASC')
    this.stmtUpsertNodePosition = db.prepare(`
      INSERT INTO novel_node_positions (id, project_id, node_type, entity_id, pos_x, pos_y, updated_at)
      VALUES (@id, @project_id, @node_type, @entity_id, @pos_x, @pos_y, @updated_at)
      ON CONFLICT(project_id, node_type, entity_id) DO UPDATE SET
        id = @id,
        pos_x = @pos_x,
        pos_y = @pos_y,
        updated_at = @updated_at
    `)
    this.stmtDeleteNodePosition = db.prepare('DELETE FROM novel_node_positions WHERE project_id = ? AND node_type = ? AND entity_id = ?')
    this.stmtListCharacterHistoryByProject = db.prepare('SELECT * FROM novel_character_history WHERE project_id = ? ORDER BY created_at DESC')
    this.stmtListCharacterHistoryByCharacter = db.prepare('SELECT * FROM novel_character_history WHERE project_id = ? AND character_id = ? ORDER BY created_at DESC')
    this.stmtListFactions = db.prepare('SELECT * FROM novel_factions WHERE project_id = ? ORDER BY created_at ASC')
    this.stmtListLocations = db.prepare('SELECT * FROM novel_locations WHERE project_id = ? ORDER BY created_at ASC')
    this.stmtListWorldElements = db.prepare('SELECT * FROM novel_world_elements WHERE project_id = ? ORDER BY created_at ASC')
    this.stmtListMarkers = db.prepare('SELECT * FROM novel_markers WHERE project_id = ? ORDER BY chapter ASC, created_at ASC')
    this.stmtListEdges = db.prepare('SELECT * FROM novel_edges WHERE project_id = ? ORDER BY created_at ASC')
    this.stmtDeleteEdge = db.prepare('DELETE FROM novel_edges WHERE id = ?')
    this.stmtDeleteEdgesByEntity = db.prepare(
      'DELETE FROM novel_edges WHERE source_id = ? OR target_id = ?',
    )

    // Agent 调用日志
    this.stmtInsertAgentLog = db.prepare(`
      INSERT INTO novel_agent_logs (
        id, project_id, chapter_number, agent_type, agent_name,
        display_agent_type, display_agent_name, phase,
        system_prompt, chapter_context, user_message,
        task_input, user_instructions, tools, tool_names,
        result, result_length, duration_ms, status, error,
        session_id, created_at
      ) VALUES (
        @id, @project_id, @chapter_number, @agent_type, @agent_name,
        @display_agent_type, @display_agent_name, @phase,
        @system_prompt, @chapter_context, @user_message,
        @task_input, @user_instructions, @tools, @tool_names,
        @result, @result_length, @duration_ms, @status, @error,
        @session_id, @created_at
      )
    `)
    this.stmtGetAgentLog = db.prepare('SELECT * FROM novel_agent_logs WHERE id = ?')
    this.stmtListAgentLogsByProject = db.prepare(
      'SELECT * FROM novel_agent_logs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
    )
    this.stmtListAgentLogsByChapter = db.prepare(
      'SELECT * FROM novel_agent_logs WHERE project_id = ? AND chapter_number = ? ORDER BY created_at DESC LIMIT ?',
    )
    this.stmtListAgentLogsByAgent = db.prepare(
      'SELECT * FROM novel_agent_logs WHERE project_id = ? AND agent_type = ? ORDER BY created_at DESC LIMIT ?',
    )
    this.stmtDeleteAgentLogsByProject = db.prepare(
      'DELETE FROM novel_agent_logs WHERE project_id = ?',
    )
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
    const full: NovelProject = { outline: '', ...project, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_projects (id, title, genre, synopsis, outline, target_words, current_volume, current_chapter, current_stage, status, created_at, updated_at)
      VALUES (@id, @title, @genre, @synopsis, @outline, @target_words, @current_volume, @current_chapter, @current_stage, @status, @created_at, @updated_at)
    `).run({
      id: full.id, title: full.title, genre: full.genre, synopsis: full.synopsis,
      outline: full.outline ?? '',
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
      UPDATE novel_projects SET title=@title, genre=@genre, synopsis=@synopsis, outline=@outline,
      target_words=@target_words, current_volume=@current_volume, current_chapter=@current_chapter,
      current_stage=@current_stage, status=@status, updated_at=@updated_at WHERE id=@id
    `).run({
      id, title: updated.title, genre: updated.genre, synopsis: updated.synopsis, outline: updated.outline ?? '',
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
    const full: NovelChapter = { outline: '', volumeId: null, ...chapter, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_chapters (id, project_id, volume, chapter_number, title, content, word_count, status, narrative_task, outline, volume_id, acceptance_result, created_at, updated_at)
      VALUES (@id, @project_id, @volume, @chapter_number, @title, @content, @word_count, @status, @narrative_task, @outline, @volume_id, @acceptance_result, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, volume: full.volume,
      chapter_number: full.chapterNumber, title: full.title, content: full.content,
      word_count: full.wordCount, status: full.status, narrative_task: full.narrativeTask,
      outline: full.outline ?? '', volume_id: full.volumeId ?? null,
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
      status=@status, narrative_task=@narrative_task, outline=@outline, volume_id=@volume_id,
      acceptance_result=@acceptance_result, updated_at=@updated_at
      WHERE id=@id
    `).run({
      id, title: updated.title, content: updated.content, word_count: updated.wordCount,
      status: updated.status, narrative_task: updated.narrativeTask,
      outline: updated.outline ?? '', volume_id: updated.volumeId ?? null,
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

  deleteChapter(id: string): boolean {
    this.deleteEdgesByEntity(id)
    const result = this.db.prepare('DELETE FROM novel_chapters WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ═══════════════════════════════════════════════════════════════
  // 卷 CRUD
  // ═══════════════════════════════════════════════════════════════

  listVolumes(projectId: string): NovelVolume[] {
    const rows = this.db.prepare('SELECT * FROM novel_volumes WHERE project_id = ? ORDER BY sort_order ASC, volume_number ASC').all(projectId) as VolumeRow[]
    return rows.map((r) => this.rowToVolume(r))
  }

  getVolume(id: string): NovelVolume | undefined {
    const row = this.db.prepare('SELECT * FROM novel_volumes WHERE id = ?').get(id) as VolumeRow | undefined
    return row ? this.rowToVolume(row) : undefined
  }

  createVolume(volume: Omit<NovelVolume, 'createdAt' | 'updatedAt'>): NovelVolume {
    const ts = now()
    const full: NovelVolume = { ...volume, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_volumes (id, project_id, volume_number, title, outline, sort_order, created_at, updated_at)
      VALUES (@id, @project_id, @volume_number, @title, @outline, @sort_order, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, volume_number: full.volumeNumber,
      title: full.title, outline: full.outline, sort_order: full.sortOrder,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateVolume(id: string, patch: Partial<NovelVolume>): NovelVolume | undefined {
    const existing = this.getVolume(id)
    if (!existing) return undefined
    const updated = { ...existing, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_volumes SET title=@title, outline=@outline, sort_order=@sort_order,
      volume_number=@volume_number, updated_at=@updated_at WHERE id=@id
    `).run({
      id, title: updated.title, outline: updated.outline, sort_order: updated.sortOrder,
      volume_number: updated.volumeNumber, updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteVolume(id: string): boolean {
    // 删卷时把章节的 volume_id 置空，不级联删章
    // 用事务包裹：避免两条 SQL 中间失败导致"章节 volume_id 已置空但卷仍存在"的脏状态
    return this.db.transaction(() => {
      this.db.prepare('UPDATE novel_chapters SET volume_id = NULL WHERE volume_id = ?').run(id)
      const result = this.db.prepare('DELETE FROM novel_volumes WHERE id = ?').run(id)
      return result.changes > 0
    })()
  }

  // ═══════════════════════════════════════════════════════════════
  // 角色 CRUD
  // ═══════════════════════════════════════════════════════════════

  createCharacter(character: Omit<NovelCharacter, 'createdAt' | 'updatedAt'>): NovelCharacter {
    const ts = now()
    const full: NovelCharacter = { ...character, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_characters (id, project_id, name, description, identity, personality, appearance,
      current_state, current_goal, current_pressure, secret, arc_stage, arc_history, speech_style, is_protagonist, created_at, updated_at)
      VALUES (@id, @project_id, @name, @description, @identity, @personality, @appearance,
      @current_state, @current_goal, @current_pressure, @secret, @arc_stage, @arc_history, @speech_style, @is_protagonist, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId,
      name: bindString(full.name, '未命名'), description: bindString(full.description),
      identity: bindString(full.identity), personality: bindString(full.personality), appearance: bindString(full.appearance),
      current_state: bindString(full.currentState), current_goal: bindString(full.currentGoal), current_pressure: bindString(full.currentPressure),
      secret: bindString(full.secret), arc_stage: bindString(full.arcStage, 'introduction'), arc_history: bindString(full.arcHistory, '[]'),
      speech_style: bindString(full.speechStyle), is_protagonist: full.isProtagonist ? 1 : 0,
      created_at: full.createdAt, updated_at: full.updatedAt,
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
      secret=@secret, arc_stage=@arc_stage, arc_history=@arc_history, speech_style=@speech_style, is_protagonist=@is_protagonist,
      updated_at=@updated_at
      WHERE id=@id
    `).run({
      id, name: bindString(updated.name, '未命名'), description: bindString(updated.description),
      identity: bindString(updated.identity), personality: bindString(updated.personality), appearance: bindString(updated.appearance),
      current_state: bindString(updated.currentState), current_goal: bindString(updated.currentGoal),
      current_pressure: bindString(updated.currentPressure), secret: bindString(updated.secret),
      arc_stage: bindString(updated.arcStage, 'introduction'), arc_history: bindString(updated.arcHistory, '[]'),
      speech_style: bindString(updated.speechStyle), is_protagonist: updated.isProtagonist ? 1 : 0,
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteCharacter(id: string): boolean {
    this.deleteEdgesByEntity(id)
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
    this.deleteEdgesByEntity(id)
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
      INSERT INTO novel_conflicts (id, project_id, description, type, intensity, stage, participants,
      first_chapter, last_chapter, tier, created_at, updated_at)
      VALUES (@id, @project_id, @description, @type, @intensity, @stage, @participants,
      @first_chapter, @last_chapter, @tier, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, description: full.description,
      type: full.type, intensity: full.intensity, stage: full.stage,
      participants: full.participants, first_chapter: full.firstChapter,
      last_chapter: full.lastChapter, tier: full.tier,
      created_at: full.createdAt, updated_at: full.updatedAt,
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
      stage=@stage, participants=@participants, first_chapter=@first_chapter, last_chapter=@last_chapter,
      tier=@tier, updated_at=@updated_at WHERE id=@id
    `).run({
      id, description: updated.description, type: updated.type, intensity: updated.intensity,
      stage: updated.stage, participants: updated.participants,
      first_chapter: updated.firstChapter, last_chapter: updated.lastChapter, tier: updated.tier,
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteConflict(id: string): boolean {
    this.deleteEdgesByEntity(id)
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
  // 节点位置 CRUD（前端画布节点坐标持久化）
  // ═══════════════════════════════════════════════════════════════

  listNodePositions(projectId: string): NovelNodePosition[] {
    return (this.stmtListNodePositions.all(projectId) as NodePositionRow[]).map((r) => this.rowToNodePosition(r))
  }

  upsertNodePosition(
    projectId: string,
    nodeType: NovelNodeType,
    entityId: string,
    posX: number,
    posY: number,
  ): NovelNodePosition {
    const id = `${nodeType}:${entityId}`
    const updatedAt = now()
    this.stmtUpsertNodePosition.run({
      id, project_id: projectId, node_type: nodeType, entity_id: entityId,
      pos_x: posX, pos_y: posY, updated_at: updatedAt,
    })
    return { id, projectId, nodeType, entityId, posX, posY, updatedAt }
  }

  deleteNodePosition(projectId: string, nodeType: NovelNodeType, entityId: string): boolean {
    const result = this.stmtDeleteNodePosition.run(projectId, nodeType, entityId)
    return result.changes > 0
  }

  // ═══════════════════════════════════════════════════════════════
  // 角色状态变更历史 CRUD
  // ═══════════════════════════════════════════════════════════════

  createCharacterHistory(
    entry: Omit<NovelCharacterHistory, 'id' | 'createdAt'>,
  ): NovelCharacterHistory {
    const id = randomUUID()
    const ts = now()
    const full: NovelCharacterHistory = { ...entry, id, createdAt: ts }
    this.db.prepare(`
      INSERT INTO novel_character_history (id, project_id, character_id, chapter_id, chapter_number,
      field_name, old_value, new_value, reason, created_at)
      VALUES (@id, @project_id, @character_id, @chapter_id, @chapter_number,
      @field_name, @old_value, @new_value, @reason, @created_at)
    `).run({
      id, project_id: full.projectId, character_id: full.characterId,
      chapter_id: full.chapterId, chapter_number: full.chapterNumber,
      field_name: full.fieldName, old_value: full.oldValue,
      new_value: full.newValue, reason: full.reason, created_at: full.createdAt,
    })
    return full
  }

  batchCreateCharacterHistory(
    entries: Array<Omit<NovelCharacterHistory, 'id' | 'createdAt'>>,
  ): NovelCharacterHistory[] {
    const ts = now()
    const stmt = this.db.prepare(`
      INSERT INTO novel_character_history (id, project_id, character_id, chapter_id, chapter_number,
      field_name, old_value, new_value, reason, created_at)
      VALUES (@id, @project_id, @character_id, @chapter_id, @chapter_number,
      @field_name, @old_value, @new_value, @reason, @created_at)
    `)
    const results: NovelCharacterHistory[] = []
    const tx = this.db.transaction((items: typeof entries) => {
      for (const entry of items) {
        const id = randomUUID()
        const full: NovelCharacterHistory = { ...entry, id, createdAt: ts }
        stmt.run({
          id, project_id: full.projectId, character_id: full.characterId,
          chapter_id: full.chapterId, chapter_number: full.chapterNumber,
          field_name: full.fieldName, old_value: full.oldValue,
          new_value: full.newValue, reason: full.reason, created_at: full.createdAt,
        })
        results.push(full)
      }
    })
    tx(entries)
    return results
  }

  listCharacterHistory(projectId: string, characterId?: string): NovelCharacterHistory[] {
    const rows = characterId
      ? this.stmtListCharacterHistoryByCharacter.all(projectId, characterId) as CharacterHistoryRow[]
      : this.stmtListCharacterHistoryByProject.all(projectId) as CharacterHistoryRow[]
    return rows.map((r) => this.rowToCharacterHistory(r))
  }

  // ═══════════════════════════════════════════════════════════════
  // 势力 CRUD
  // ═══════════════════════════════════════════════════════════════

  listFactions(projectId: string): NovelFaction[] {
    return (this.stmtListFactions.all(projectId) as FactionRow[]).map((r) => this.rowToFaction(r))
  }

  getFaction(factionId: string): NovelFaction | undefined {
    const row = this.db.prepare('SELECT * FROM novel_factions WHERE id = ?').get(factionId) as FactionRow | undefined
    return row ? this.rowToFaction(row) : undefined
  }

  createFaction(faction: Omit<NovelFaction, 'createdAt' | 'updatedAt'>): NovelFaction {
    const ts = now()
    const full: NovelFaction = { ...faction, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_factions (id, project_id, name, description, type, leader_id, ideology,
      strength, resources, allies, enemies, status, first_chapter, last_chapter, created_at, updated_at)
      VALUES (@id, @project_id, @name, @description, @type, @leader_id, @ideology,
      @strength, @resources, @allies, @enemies, @status, @first_chapter, @last_chapter, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, name: full.name, description: full.description,
      type: full.type, leader_id: full.leaderId, ideology: full.ideology,
      strength: full.strength, resources: JSON.stringify(full.resources),
      allies: JSON.stringify(full.allies), enemies: JSON.stringify(full.enemies),
      status: full.status, first_chapter: full.firstChapter, last_chapter: full.lastChapter,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateFaction(id: string, patch: Partial<NovelFaction>): NovelFaction | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_factions WHERE id = ?').get(id) as FactionRow | undefined
    if (!existing) return undefined
    const current = this.rowToFaction(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_factions SET name=@name, description=@description, type=@type, leader_id=@leader_id,
      ideology=@ideology, strength=@strength, resources=@resources, allies=@allies, enemies=@enemies,
      status=@status, first_chapter=@first_chapter, last_chapter=@last_chapter, updated_at=@updated_at WHERE id=@id
    `).run({
      id, name: updated.name, description: updated.description, type: updated.type,
      leader_id: updated.leaderId, ideology: updated.ideology, strength: updated.strength,
      resources: JSON.stringify(updated.resources), allies: JSON.stringify(updated.allies),
      enemies: JSON.stringify(updated.enemies), status: updated.status,
      first_chapter: updated.firstChapter, last_chapter: updated.lastChapter, updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteFaction(id: string): boolean {
    this.deleteEdgesByEntity(id)
    const result = this.db.prepare('DELETE FROM novel_factions WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ═══════════════════════════════════════════════════════════════
  // 时间轴标记 CRUD
  // ═══════════════════════════════════════════════════════════════

  listMarkers(projectId: string): NovelMarker[] {
    return (this.stmtListMarkers.all(projectId) as MarkerRow[]).map((r) => this.rowToMarker(r))
  }

  getMarker(markerId: string): NovelMarker | undefined {
    const row = this.db.prepare('SELECT * FROM novel_markers WHERE id = ?').get(markerId) as MarkerRow | undefined
    return row ? this.rowToMarker(row) : undefined
  }

  createMarker(marker: Omit<NovelMarker, 'createdAt' | 'updatedAt'>): NovelMarker {
    const ts = now()
    const full: NovelMarker = { ...marker, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_markers (id, project_id, chapter, title, note, type, color, entity_type, entity_id, created_at, updated_at)
      VALUES (@id, @project_id, @chapter, @title, @note, @type, @color, @entity_type, @entity_id, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, chapter: full.chapter,
      title: bindString(full.title), note: bindString(full.note),
      type: full.type, color: full.color,
      entity_type: full.entityType ?? null, entity_id: full.entityId ?? null,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateMarker(id: string, patch: Partial<NovelMarker>): NovelMarker | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_markers WHERE id = ?').get(id) as MarkerRow | undefined
    if (!existing) return undefined
    const current = this.rowToMarker(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_markers SET chapter=@chapter, title=@title, note=@note,
      type=@type, color=@color, entity_type=@entity_type, entity_id=@entity_id, updated_at=@updated_at WHERE id=@id
    `).run({
      id, chapter: updated.chapter, title: bindString(updated.title), note: bindString(updated.note),
      type: updated.type, color: updated.color,
      entity_type: updated.entityType ?? null, entity_id: updated.entityId ?? null,
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteMarker(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_markers WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ═══════════════════════════════════════════════════════════════
  // 地点 CRUD
  // ═══════════════════════════════════════════════════════════════

  listLocations(projectId: string): NovelLocation[] {
    return (this.stmtListLocations.all(projectId) as LocationRow[]).map((r) => this.rowToLocation(r))
  }

  getLocation(locationId: string): NovelLocation | undefined {
    const row = this.db.prepare('SELECT * FROM novel_locations WHERE id = ?').get(locationId) as LocationRow | undefined
    return row ? this.rowToLocation(row) : undefined
  }

  createLocation(location: Omit<NovelLocation, 'createdAt' | 'updatedAt'>): NovelLocation {
    const ts = now()
    const full: NovelLocation = { ...location, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_locations (id, project_id, name, description, type, parent_id, faction_id,
      significance, first_chapter, status, appear_chapters, created_at, updated_at)
      VALUES (@id, @project_id, @name, @description, @type, @parent_id, @faction_id,
      @significance, @first_chapter, @status, @appear_chapters, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, name: full.name, description: full.description,
      type: full.type, parent_id: full.parentId, faction_id: full.factionId,
      significance: full.significance, first_chapter: full.firstChapter, status: full.status,
      appear_chapters: JSON.stringify(full.appearChapters),
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateLocation(id: string, patch: Partial<NovelLocation>): NovelLocation | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_locations WHERE id = ?').get(id) as LocationRow | undefined
    if (!existing) return undefined
    const current = this.rowToLocation(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_locations SET name=@name, description=@description, type=@type, parent_id=@parent_id,
      faction_id=@faction_id, significance=@significance, first_chapter=@first_chapter, status=@status,
      appear_chapters=@appear_chapters, updated_at=@updated_at WHERE id=@id
    `).run({
      id, name: updated.name, description: updated.description, type: updated.type,
      parent_id: updated.parentId, faction_id: updated.factionId, significance: updated.significance,
      first_chapter: updated.firstChapter, status: updated.status,
      appear_chapters: JSON.stringify(updated.appearChapters), updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteLocation(id: string): boolean {
    this.deleteEdgesByEntity(id)
    const result = this.db.prepare('DELETE FROM novel_locations WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ═══════════════════════════════════════════════════════════════
  // 世界观要素 CRUD
  // ═══════════════════════════════════════════════════════════════

  listWorldElements(projectId: string): NovelWorldElement[] {
    return (this.stmtListWorldElements.all(projectId) as WorldElementRow[]).map((r) => this.rowToWorldElement(r))
  }

  getWorldElement(worldElementId: string): NovelWorldElement | undefined {
    const row = this.db.prepare('SELECT * FROM novel_world_elements WHERE id = ?').get(worldElementId) as WorldElementRow | undefined
    return row ? this.rowToWorldElement(row) : undefined
  }

  createWorldElement(element: Omit<NovelWorldElement, 'createdAt' | 'updatedAt'>): NovelWorldElement {
    const ts = now()
    const full: NovelWorldElement = { ...element, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_world_elements (id, project_id, category, name, description, parent_id, attributes, created_at, updated_at)
      VALUES (@id, @project_id, @category, @name, @description, @parent_id, @attributes, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, category: full.category, name: full.name,
      description: full.description, parent_id: full.parentId,
      attributes: JSON.stringify(full.attributes), created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateWorldElement(id: string, patch: Partial<NovelWorldElement>): NovelWorldElement | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_world_elements WHERE id = ?').get(id) as WorldElementRow | undefined
    if (!existing) return undefined
    const current = this.rowToWorldElement(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_world_elements SET category=@category, name=@name, description=@description,
      parent_id=@parent_id, attributes=@attributes, updated_at=@updated_at WHERE id=@id
    `).run({
      id, category: updated.category, name: updated.name, description: updated.description,
      parent_id: updated.parentId, attributes: JSON.stringify(updated.attributes),
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteWorldElement(id: string): boolean {
    this.deleteEdgesByEntity(id)
    const result = this.db.prepare('DELETE FROM novel_world_elements WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ═══════════════════════════════════════════════════════════════
  // 画布连线 CRUD（手动连线持久化 + 自动边存储）
  // ═══════════════════════════════════════════════════════════════

  listEdges(projectId: string): NovelEdge[] {
    return (this.stmtListEdges.all(projectId) as EdgeRow[]).map((r) => this.rowToEdge(r))
  }

  createEdge(
    projectId: string,
    data: Omit<NovelEdge, 'id' | 'projectId' | 'createdAt' | 'updatedAt' | 'auto'> & { auto?: boolean },
  ): NovelEdge {
    const id = randomUUID()
    const ts = now()
    const auto = data.auto ? 1 : 0
    const full: NovelEdge = {
      id,
      projectId,
      sourceId: data.sourceId,
      sourceType: data.sourceType,
      targetId: data.targetId,
      targetType: data.targetType,
      edgeType: data.edgeType,
      label: data.label ?? '',
      auto: auto === 1,
      createdAt: ts,
      updatedAt: ts,
    }
    this.db.prepare(`
      INSERT INTO novel_edges (id, project_id, source_id, source_type, target_id, target_type,
      edge_type, label, auto, created_at, updated_at)
      VALUES (@id, @project_id, @source_id, @source_type, @target_id, @target_type,
      @edge_type, @label, @auto, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId,
      source_id: full.sourceId, source_type: full.sourceType,
      target_id: full.targetId, target_type: full.targetType,
      edge_type: full.edgeType, label: full.label, auto,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  deleteEdge(id: string): boolean {
    const result = this.stmtDeleteEdge.run(id)
    return result.changes > 0
  }

  /** 删除与某实体相关的所有边（实体被删除时调用） */
  deleteEdgesByEntity(entityId: string): number {
    const result = this.stmtDeleteEdgesByEntity.run(entityId, entityId)
    return result.changes
  }

  // ═══════════════════════════════════════════════════════════════
  // Agent 调用日志 CRUD
  // ═══════════════════════════════════════════════════════════════

  /**
   * 写入一条 Agent 调用日志
   *
   * 在 orchestrator.runAgent 调用 LLM 前后采集完整上下文（STATIC/SEMI/DYNAMIC 三层 + 结果），
   * 持久化到数据库供事后排查与审计。写入采用 fire-and-forget 模式不影响主流程。
   */
  insertAgentLog(input: Omit<NovelAgentLog, 'id' | 'createdAt'>): NovelAgentLog {
    const id = randomUUID()
    const createdAt = now()
    const full: NovelAgentLog = { ...input, id, createdAt }
    this.stmtInsertAgentLog.run({
      id: full.id,
      project_id: full.projectId,
      chapter_number: full.chapterNumber,
      agent_type: full.agentType,
      agent_name: full.agentName,
      display_agent_type: full.displayAgentType,
      display_agent_name: full.displayAgentName,
      phase: full.phase,
      system_prompt: full.systemPrompt,
      chapter_context: full.chapterContext,
      user_message: full.userMessage,
      task_input: full.taskInput,
      user_instructions: JSON.stringify(full.userInstructions ?? []),
      tools: JSON.stringify(full.tools ?? []),
      tool_names: JSON.stringify(full.toolNames ?? []),
      result: full.result,
      result_length: full.resultLength,
      duration_ms: full.durationMs,
      status: full.status,
      error: full.error,
      session_id: full.sessionId,
      created_at: full.createdAt,
    })
    return full
  }

  /** 按 ID 获取完整日志（含 prompt 全文） */
  getAgentLog(id: string): NovelAgentLog | undefined {
    const row = this.stmtGetAgentLog.get(id) as AgentLogRow | undefined
    return row ? this.rowToAgentLog(row) : undefined
  }

  /**
   * 列出日志（精简字段，不含 prompt 全文，避免传输过大）
   *
   * @param projectId  项目 ID
   * @param filter     可选过滤：按章节号 / Agent 类型
   * @param limit      最大返回数量，默认 100
   */
  listAgentLogs(
    projectId: string,
    filter?: { chapterNumber?: number; agentType?: string },
    limit = 100,
  ): NovelAgentLogSummary[] {
    const effectiveLimit = Math.min(Math.max(limit, 1), 500)
    let rows: AgentLogRow[]
    if (filter?.chapterNumber != null) {
      rows = this.stmtListAgentLogsByChapter.all(projectId, filter.chapterNumber, effectiveLimit) as AgentLogRow[]
    } else if (filter?.agentType) {
      rows = this.stmtListAgentLogsByAgent.all(projectId, filter.agentType, effectiveLimit) as AgentLogRow[]
    } else {
      rows = this.stmtListAgentLogsByProject.all(projectId, effectiveLimit) as AgentLogRow[]
    }
    return rows.map((r) => this.rowToAgentLogSummary(r))
  }

  /** 删除项目下所有日志（项目删除时级联调用） */
  deleteAgentLogsByProject(projectId: string): number {
    const result = this.stmtDeleteAgentLogsByProject.run(projectId)
    return result.changes
  }

  // ═══════════════════════════════════════════════════════════════
  // 行 → 对象 转换方法
  // ═══════════════════════════════════════════════════════════════

  private rowToProject(row: ProjectRow): NovelProject {
    return {
      id: row.id, title: row.title, genre: row.genre, synopsis: row.synopsis,
      outline: row.outline,
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
      narrativeTask: row.narrative_task, outline: row.outline, volumeId: row.volume_id,
      acceptanceResult: row.acceptance_result,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToVolume(row: VolumeRow): NovelVolume {
    return {
      id: row.id, projectId: row.project_id, volumeNumber: row.volume_number,
      title: row.title, outline: row.outline, sortOrder: row.sort_order,
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
      isProtagonist: row.is_protagonist === 1,
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
      firstChapter: row.first_chapter, lastChapter: row.last_chapter,
      tier: (row.tier as ConflictTier) ?? 'secondary',
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

  private rowToNodePosition(row: NodePositionRow): NovelNodePosition {
    return {
      id: row.id, projectId: row.project_id,
      nodeType: row.node_type as NovelNodePosition['nodeType'],
      entityId: row.entity_id, posX: row.pos_x, posY: row.pos_y,
      updatedAt: row.updated_at,
    }
  }

  private rowToCharacterHistory(row: CharacterHistoryRow): NovelCharacterHistory {
    return {
      id: row.id, projectId: row.project_id, characterId: row.character_id,
      chapterId: row.chapter_id, chapterNumber: row.chapter_number,
      fieldName: row.field_name as NovelCharacterHistory['fieldName'],
      oldValue: row.old_value, newValue: row.new_value,
      reason: row.reason, createdAt: row.created_at,
    }
  }

  private rowToFaction(row: FactionRow): NovelFaction {
    return {
      id: row.id, projectId: row.project_id, name: row.name, description: row.description,
      type: row.type as NovelFaction['type'], leaderId: row.leader_id, ideology: row.ideology,
      strength: row.strength as NovelFaction['strength'],
      resources: parseJSON<string[]>(row.resources, []),
      allies: parseJSON<string[]>(row.allies, []),
      enemies: parseJSON<string[]>(row.enemies, []),
      status: row.status as NovelFaction['status'],
      firstChapter: row.first_chapter, lastChapter: row.last_chapter,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToMarker(row: MarkerRow): NovelMarker {
    return {
      id: row.id, projectId: row.project_id, chapter: row.chapter,
      title: row.title, note: row.note,
      type: row.type as NovelMarker['type'],
      color: row.color as NovelMarker['color'],
      entityType: row.entity_type ?? null,
      entityId: row.entity_id ?? null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToLocation(row: LocationRow): NovelLocation {
    return {
      id: row.id, projectId: row.project_id, name: row.name, description: row.description,
      type: row.type as NovelLocation['type'], parentId: row.parent_id, factionId: row.faction_id,
      significance: row.significance as NovelLocation['significance'],
      firstChapter: row.first_chapter, status: row.status as NovelLocation['status'],
      appearChapters: parseJSON<number[]>(row.appear_chapters, []),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToWorldElement(row: WorldElementRow): NovelWorldElement {
    return {
      id: row.id, projectId: row.project_id, category: row.category as NovelWorldElement['category'],
      name: row.name, description: row.description, parentId: row.parent_id,
      attributes: parseJSON<Record<string, unknown>>(row.attributes, {}),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToEdge(row: EdgeRow): NovelEdge {
    return {
      id: row.id, projectId: row.project_id,
      sourceId: row.source_id, sourceType: row.source_type as NovelEdge['sourceType'],
      targetId: row.target_id, targetType: row.target_type as NovelEdge['targetType'],
      edgeType: row.edge_type as NovelEdge['edgeType'],
      label: row.label, auto: row.auto === 1,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
  }

  private rowToAgentLog(row: AgentLogRow): NovelAgentLog {
    return {
      id: row.id,
      projectId: row.project_id,
      chapterNumber: row.chapter_number,
      agentType: row.agent_type,
      agentName: row.agent_name,
      displayAgentType: row.display_agent_type,
      displayAgentName: row.display_agent_name,
      phase: row.phase,
      systemPrompt: row.system_prompt,
      chapterContext: row.chapter_context,
      userMessage: row.user_message,
      taskInput: row.task_input,
      userInstructions: parseJSON<string[]>(row.user_instructions, []),
      tools: parseJSON<unknown[]>(row.tools, []),
      toolNames: parseJSON<string[]>(row.tool_names, []),
      result: row.result,
      resultLength: row.result_length,
      durationMs: row.duration_ms,
      status: row.status as NovelAgentLogStatus,
      error: row.error,
      sessionId: row.session_id,
      createdAt: row.created_at,
    }
  }

  private rowToAgentLogSummary(row: AgentLogRow): NovelAgentLogSummary {
    return {
      id: row.id,
      projectId: row.project_id,
      chapterNumber: row.chapter_number,
      agentType: row.agent_type,
      agentName: row.agent_name,
      displayAgentType: row.display_agent_type,
      displayAgentName: row.display_agent_name,
      phase: row.phase,
      systemPromptLength: row.system_prompt.length,
      userMessageLength: row.user_message.length,
      toolNames: parseJSON<string[]>(row.tool_names, []),
      resultLength: row.result_length,
      durationMs: row.duration_ms,
      status: row.status as NovelAgentLogStatus,
      error: row.error,
      createdAt: row.created_at,
    }
  }
}
