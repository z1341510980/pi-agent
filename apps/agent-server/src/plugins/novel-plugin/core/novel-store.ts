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
import {
  createChapterRenumberSpec,
  shiftChapterSpans,
  shiftChapterList,
  CHAPTER_RENUMBER_FIELDS,
} from './chapter-renumber.js'
import type { ChapterRenumberSpec } from './chapter-renumber.js'
import type {
  NovelProject,
  NovelChapter,
  NovelCharacter,
  NovelRelationship,
  NovelForeshadow,
  NovelClue,
  NovelConflict,
  ConflictTier,
  ConflictProgressionMode,
  PlotFunction,
  NovelForeshadowCategory,
  ForeshadowPlantMethod,
  ForeshadowRecoverMethod,
  ChapterSpan,
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
  NovelHook,
  HookStatus,
  NovelCharacterArc,
  ArcType,
  ArcStageHistoryEntry,
  DeduplicateEntityKind,
  DeduplicateGroup,
  DeduplicateReport,
  SimilarityGroup,
} from './types.js'

// ── 行类型（SQLite snake_case → TypeScript camelCase 映射）──

interface ProjectRow {
  id: string; title: string; genre: string; synopsis: string; outline: string
  target_words: number; current_volume: number; current_chapter: number
  current_stage: string; status: string; created_at: number; updated_at: number
  deleted_at: number | null
}

interface ChapterRow {
  id: string; project_id: string; volume: number; chapter_number: number
  title: string; content: string; word_count: number; status: string
  narrative_task: string; outline: string; volume_id: string | null
  acceptance_result: string | null
  tension: number | null
  time_offset: number | null
  chapter_ending_hook: string | null
  recap: string | null
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
  long_term_desire: string; plot_role: string; removal_impact: string
  participating_conflicts: string
  created_at: number; updated_at: number
}

interface RelationshipRow {
  id: string; project_id: string; character_a: string; character_b: string
  relation_type: string; current_stage: string; stage_history: string
  dynamic_role: string; alignment: string; trend: string
  chapter_hint: string; last_updated_chapter: number | null
  created_at: number; updated_at: number
}

interface ForeshadowRow {
  id: string; project_id: string; description: string; category: string
  status: string; first_chapter: number | null; last_chapter: number | null
  recover_by_chapter: number | null; linked_characters: string; linked_clues: string
  plant_method: string | null; recover_method: string | null
  linked_info_layers: string
  chapter_spans: string | null
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
  chapter_spans: string | null
  plot_function: string | null
  progression_mode: string | null
  created_at: number; updated_at: number
}

interface HookRow {
  id: string
  project_id: string
  chapter_number: number
  hook_type: string
  description: string
  status: string
  fulfilled_at_chapter: number | null
  fulfilled_description: string | null
  linked_foreshadow_id: string | null
  linked_conflict_id: string | null
  created_at: number
  updated_at: number
}

interface CharacterArcRow {
  id: string
  project_id: string
  character_id: string
  arc_type: string
  current_stage: string
  stage_history: string
  description: string | null
  created_at: number
  updated_at: number
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
  linked_foreshadows: string
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
  chapter_spans: string | null
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
  input_tokens: number; output_tokens: number
  cache_read_tokens: number; cache_write_tokens: number
  llm_provider: string; llm_model: string
}

// ── 工具函数 ──

function parseJSON<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T } catch { return fallback }
}

/** 解析 chapter_spans JSON 字段为 ChapterSpan[]，容错处理 null/异常/非数组 */
function parseChapterSpans(raw: string | null | undefined): ChapterSpan[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((s): s is [number, number] =>
        Array.isArray(s) && s.length === 2 &&
        typeof s[0] === 'number' && typeof s[1] === 'number'
      )
      .map(([s, e]) => [s, e] as ChapterSpan)
  } catch {
    return []
  }
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

// ── 四层逻辑③：枚举值容错转换（row → NovelXxx 类型）──
// 目的：旧数据 / LLM 输出的非法值不阻塞主流程，统一回退到默认值

const VALID_PLOT_FUNCTIONS: PlotFunction[] = [
  'provide_resource', 'create_obstacle', 'amplify_conflict',
  'open_phase', 'change_judgment', 'advance_relationship', 'reveal_world_rule',
]

const VALID_PROGRESSION_MODES: ConflictProgressionMode[] = [
  'linear', 'mutation', 'stagnation', 'regression', 'reversal',
]

const VALID_FORESHADOW_CATEGORIES: NovelForeshadowCategory[] = [
  'item', 'spoken', 'event', 'identity', 'secret', 'prophecy', 'promise', 'quote',
]

const VALID_PLANT_METHODS: ForeshadowPlantMethod[] = ['explicit', 'implicit', 'indirect']

const VALID_RECOVER_METHODS: ForeshadowRecoverMethod[] = [
  'explicit', 'implicit', 'reverse', 'progressive',
]

/** 中文 → 英文 category 映射（兼容旧数据可能存的中文枚举值） */
const FORESHADOW_CATEGORY_CN_MAP: Record<string, NovelForeshadowCategory> = {
  '物品': 'item', '言语': 'spoken', '事件': 'event', '身份': 'identity',
  '秘密': 'secret', '预言': 'prophecy', '承诺': 'promise', '台词': 'quote',
}

function normalizeConflictPlotFunction(raw: string | null | undefined): PlotFunction | undefined {
  if (!raw) return undefined
  if (VALID_PLOT_FUNCTIONS.includes(raw as PlotFunction)) return raw as PlotFunction
  return undefined
}

function normalizeConflictProgressionMode(raw: string | null | undefined): ConflictProgressionMode {
  if (!raw) return 'linear'
  if (VALID_PROGRESSION_MODES.includes(raw as ConflictProgressionMode)) return raw as ConflictProgressionMode
  return 'linear'
}

function normalizeForeshadowCategory(raw: string | null | undefined): NovelForeshadowCategory {
  if (!raw) return 'item'
  // 优先匹配英文枚举
  if (VALID_FORESHADOW_CATEGORIES.includes(raw as NovelForeshadowCategory)) {
    return raw as NovelForeshadowCategory
  }
  // 兼容中文旧数据
  if (FORESHADOW_CATEGORY_CN_MAP[raw]) return FORESHADOW_CATEGORY_CN_MAP[raw]
  // 大小写容错（Item/ITEM → item）
  const lower = raw.toLowerCase()
  if (VALID_FORESHADOW_CATEGORIES.includes(lower as NovelForeshadowCategory)) {
    return lower as NovelForeshadowCategory
  }
  return 'item'
}

function normalizeForeshadowPlantMethod(raw: string | null | undefined): ForeshadowPlantMethod | undefined {
  if (!raw) return undefined
  if (VALID_PLANT_METHODS.includes(raw as ForeshadowPlantMethod)) return raw as ForeshadowPlantMethod
  return undefined
}

function normalizeForeshadowRecoverMethod(raw: string | null | undefined): ForeshadowRecoverMethod | undefined {
  if (!raw) return undefined
  if (VALID_RECOVER_METHODS.includes(raw as ForeshadowRecoverMethod)) return raw as ForeshadowRecoverMethod
  return undefined
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
    // 排序键：category, id（双键排序）—— category 用于业务分组，id 作为稳定次序键
    // 避免「相同 category 下不同行因 created_at 相同/缺失导致顺序波动」破坏 system prompt 哈希
    // 进而破坏 prompt cache 前缀匹配。原 ORDER BY created_at 在并发写入或时间戳精度不足时
    // 可能产生顺序波动，导致同一项目跨次构建 system prompt 不一致。
    this.stmtListWorldRules = db.prepare('SELECT * FROM novel_world_rules WHERE project_id = ? ORDER BY category ASC, id ASC')
    this.stmtListStyleGuides = db.prepare('SELECT * FROM novel_style_guides WHERE project_id = ? ORDER BY category ASC, id ASC')
    this.stmtListConstraints = db.prepare('SELECT * FROM novel_constraints WHERE project_id = ? AND is_active = 1 ORDER BY created_at ASC')
    this.stmtListInfoLayers = db.prepare('SELECT * FROM novel_information_layers WHERE project_id = ? ORDER BY created_at ASC')
    // 返回所有"有内容"的章节：content 非空即纳入。不再依赖 status 字段，因为
    // 章节可能因异常中断而停留在 planned 状态但实际已有内容（如生成成功但状态
    // 未更新为 review）。按 status 过滤会漏掉这类章节，导致 Writer 看不到上一章
    // 内容，衔接断裂。
    this.stmtListRecentChapters = db.prepare('SELECT * FROM novel_chapters WHERE project_id = ? AND content IS NOT NULL AND length(content) > 0 ORDER BY chapter_number DESC LIMIT ?')
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
        session_id, created_at,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        llm_provider, llm_model
      ) VALUES (
        @id, @project_id, @chapter_number, @agent_type, @agent_name,
        @display_agent_type, @display_agent_name, @phase,
        @system_prompt, @chapter_context, @user_message,
        @task_input, @user_instructions, @tools, @tool_names,
        @result, @result_length, @duration_ms, @status, @error,
        @session_id, @created_at,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
        @llm_provider, @llm_model
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

  /** 按 ID 查询单个信息差（P3-2：供 prompt-builder 反向展示伏笔承载的信息差） */
  getInformationLayer(id: string): NovelInformationLayer | undefined {
    const row = this.db.prepare('SELECT * FROM novel_information_layers WHERE id = ?').get(id) as InfoLayerRow | undefined
    return row ? this.rowToInfoLayer(row) : undefined
  }

  listConstraints(projectId: string): NovelConstraint[] {
    return (this.stmtListConstraints.all(projectId) as ConstraintRow[]).map((r) => this.rowToConstraint(r))
  }

  listRecentChapters(projectId: string, limit: number): NovelChapter[] {
    const rows = this.stmtListRecentChapters.all(projectId, limit) as ChapterRow[]
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

  /**
   * 软删除：将项目移入回收站（设置 deleted_at 时间戳）
   * 项目数据保留，可在回收站中恢复或永久删除。
   */
  deleteProject(id: string): boolean {
    const result = this.db.prepare(
      'UPDATE novel_projects SET deleted_at = @ts, updated_at = @ts WHERE id = @id AND deleted_at IS NULL',
    ).run({ id, ts: now() })
    return result.changes > 0
  }

  /**
   * 列出回收站中的项目（deleted_at 非 NULL），按移入时间倒序。
   */
  listTrashedProjects(): NovelProject[] {
    const rows = this.db.prepare(
      'SELECT * FROM novel_projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC',
    ).all() as ProjectRow[]
    return rows.map((r) => this.rowToProject(r))
  }

  /**
   * 恢复项目：清除 deleted_at，项目回到正常列表。
   */
  restoreProject(id: string): boolean {
    const result = this.db.prepare(
      'UPDATE novel_projects SET deleted_at = NULL, updated_at = @ts WHERE id = @id AND deleted_at IS NOT NULL',
    ).run({ id, ts: now() })
    return result.changes > 0
  }

  /**
   * 永久删除：硬删除项目 + 清理无级联的关联表数据。
   * 18 张有 ON DELETE CASCADE 的表会自动清理；
   * 这里手动清理剩余 6 张无级联的表，避免孤儿数据。
   */
  purgeProject(id: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM novel_projects WHERE id = ? AND deleted_at IS NOT NULL',
    ).run(id)
    if (result.changes === 0) return false
    // 清理无 ON DELETE CASCADE 的关联表
    this.db.prepare('DELETE FROM novel_node_positions WHERE project_id = ?').run(id)
    this.db.prepare('DELETE FROM novel_character_history WHERE project_id = ?').run(id)
    this.db.prepare('DELETE FROM novel_memory_events WHERE project_id = ?').run(id)
    this.db.prepare('DELETE FROM novel_memory_snapshots WHERE project_id = ?').run(id)
    this.db.prepare('DELETE FROM novel_agent_logs WHERE project_id = ?').run(id)
    this.db.prepare('DELETE FROM novel_prompt_templates WHERE project_id = ?').run(id)
    return true
  }

  /**
   * 清空回收站：永久删除所有 deleted_at 非 NULL 的项目。
   * @returns 清理的项目数量
   */
  emptyTrash(): number {
    const trashed = this.listTrashedProjects()
    let count = 0
    for (const p of trashed) {
      if (this.purgeProject(p.id)) count++
    }
    return count
  }

  listProjects(): NovelProject[] {
    const rows = this.db.prepare(
      'SELECT * FROM novel_projects WHERE deleted_at IS NULL ORDER BY updated_at DESC',
    ).all() as ProjectRow[]
    return rows.map((r) => this.rowToProject(r))
  }

  // ═══════════════════════════════════════════════════════════════
  // 章节 CRUD
  // ═══════════════════════════════════════════════════════════════

  createChapter(chapter: Omit<NovelChapter, 'createdAt' | 'updatedAt'>): NovelChapter {
    const ts = now()
    const full: NovelChapter = { outline: '', volumeId: null, ...chapter, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_chapters (id, project_id, volume, chapter_number, title, content, word_count, status, narrative_task, outline, volume_id, acceptance_result, tension, time_offset, chapter_ending_hook, recap, created_at, updated_at)
      VALUES (@id, @project_id, @volume, @chapter_number, @title, @content, @word_count, @status, @narrative_task, @outline, @volume_id, @acceptance_result, @tension, @time_offset, @chapter_ending_hook, @recap, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, volume: full.volume,
      chapter_number: full.chapterNumber, title: full.title, content: full.content,
      word_count: full.wordCount, status: full.status, narrative_task: full.narrativeTask,
      outline: full.outline ?? '', volume_id: full.volumeId ?? null,
      acceptance_result: full.acceptanceResult, tension: full.tension ?? null,
      time_offset: full.timeOffset ?? null,
      chapter_ending_hook: full.chapterEndingHook ?? null,
      recap: full.recap ?? null,
      created_at: full.createdAt, updated_at: full.updatedAt,
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
      acceptance_result=@acceptance_result, tension=@tension,
      time_offset=@time_offset, chapter_ending_hook=@chapter_ending_hook, recap=@recap,
      updated_at=@updated_at
      WHERE id=@id
    `).run({
      id, title: updated.title, content: updated.content, word_count: updated.wordCount,
      status: updated.status, narrative_task: updated.narrativeTask,
      outline: updated.outline ?? '', volume_id: updated.volumeId ?? null,
      acceptance_result: updated.acceptanceResult, tension: updated.tension ?? null,
      time_offset: updated.timeOffset ?? null,
      chapter_ending_hook: updated.chapterEndingHook ?? null,
      recap: updated.recap ?? null,
      updated_at: updated.updatedAt,
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
    // 使用事务包裹整个删除+重排流程，保证原子性：
    //   - 读章节、删画布连线、删章节行、重排引用任一步失败 → 整体回滚
    //   - 与 deleteVolume 模式一致，避免 renumber 失败时留下"章节已删但引用未重排"的脏状态
    return this.db.transaction(() => {
      // 1. 读取章节信息（需要 projectId 和 chapterNumber 做重排）
      const chapter = this.getChapterById(id)
      if (!chapter) return false

      // 2. 删除与该章节关联的画布连线
      this.deleteEdgesByEntity(id)

      // 3. 删除章节行
      const result = this.db.prepare('DELETE FROM novel_chapters WHERE id = ?').run(id)
      if (result.changes === 0) return false

      // 4. 重排后续章节号（借鉴 PlotPilot ChapterRenumberSpec）
      //    调用方已在事务内，renumberChapterReferences 不再自行开事务
      const spec = createChapterRenumberSpec(chapter.chapterNumber)
      this.renumberChapterReferences(chapter.projectId, spec)

      return true
    })()
  }

  /**
   * 重排所有引用了 chapter_number 的字段
   * 按 CHAPTER_RENUMBER_FIELDS 常量遍历，逐表执行 UPDATE
   *
   * 注意：调用方（deleteChapter）已在外层开启事务，此处不再包裹。
   * JSON 解析失败会抛错，触发外层事务整体回滚（强一致优于静默跳过）。
   */
  private renumberChapterReferences(projectId: string, spec: ChapterRenumberSpec): void {
    for (const field of CHAPTER_RENUMBER_FIELDS) {
      if (field.kind === 'scalar') {
        // 标量字段：等于被删章的行需要处理（NOT NULL 列 DELETE，可空列 SET NULL）
        if (field.nullable) {
          this.db.prepare(
            `UPDATE ${field.table} SET ${field.column} = NULL WHERE ${field.column} = ? AND project_id = ?`,
          ).run(spec.deletedChapter, projectId)
        } else {
          // NOT NULL 列（如 markers.chapter, memory_events.chapter_number）无法置空，直接删除行
          // 注意：novel_chapters 的被删行已在 deleteChapter 中删除，此处 DELETE 为 no-op
          this.db.prepare(
            `DELETE FROM ${field.table} WHERE project_id = ? AND ${field.column} = ?`,
          ).run(projectId, spec.deletedChapter)
        }
        // 大于被删章的统一 -1
        this.db.prepare(
          `UPDATE ${field.table} SET ${field.column} = ${field.column} - 1 WHERE ${field.column} IS NOT NULL AND ${field.column} > ? AND project_id = ?`,
        ).run(spec.deletedChapter, projectId)
      } else if (field.kind === 'spans') {
        // JSON 跨度数组：读取所有行 → JS 处理 → 逐行 UPDATE
        const rows = this.db.prepare(
          `SELECT id, ${field.column} AS spans FROM ${field.table} WHERE project_id = ?`,
        ).all(projectId) as Array<{ id: string; spans: string | null }>
        for (const row of rows) {
          // NULL 行视为合法（未设置跨度），跳过；非 NULL 但损坏的 JSON 视为错误，抛错触发回滚
          if (!row.spans) continue
          const parsed = JSON.parse(row.spans)
          if (!Array.isArray(parsed)) {
            throw new Error(`非法 ${field.column} JSON: table=${field.table} id=${row.id}`)
          }
          if (!parsed.every((p) => Array.isArray(p) && p.length === 2
            && typeof p[0] === 'number' && typeof p[1] === 'number')) {
            throw new Error(`非法 ${field.column} 元素结构: table=${field.table} id=${row.id}`)
          }
          const shifted = shiftChapterSpans(parsed as Array<[number, number]>, spec)
          this.db.prepare(
            `UPDATE ${field.table} SET ${field.column} = ? WHERE id = ?`,
          ).run(JSON.stringify(shifted), row.id)
        }
      } else if (field.kind === 'list') {
        // JSON 列表：同样读取所有行 → JS 处理 → 逐行 UPDATE
        const rows = this.db.prepare(
          `SELECT id, ${field.column} AS list FROM ${field.table} WHERE project_id = ?`,
        ).all(projectId) as Array<{ id: string; list: string | null }>
        for (const row of rows) {
          // NULL 行视为合法（未设置列表），跳过；非 NULL 但损坏的 JSON 视为错误，抛错触发回滚
          if (!row.list) continue
          const parsed = JSON.parse(row.list)
          if (!Array.isArray(parsed)) {
            throw new Error(`非法 ${field.column} JSON: table=${field.table} id=${row.id}`)
          }
          if (!parsed.every((p) => typeof p === 'number')) {
            throw new Error(`非法 ${field.column} 元素结构: table=${field.table} id=${row.id}`)
          }
          const shifted = shiftChapterList(parsed as number[], spec)
          this.db.prepare(
            `UPDATE ${field.table} SET ${field.column} = ? WHERE id = ?`,
          ).run(JSON.stringify(shifted), row.id)
        }
      }
    }
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

  createCharacter(character: Omit<NovelCharacter, 'createdAt' | 'updatedAt' | 'participatingConflicts'> & { participatingConflicts?: string }): NovelCharacter {
    const ts = now()
    // participatingConflicts 默认 '[]'（反向索引由冲突 CRUD 自动同步，创建时一般为空）
    // 显式赋值在 spread 之前，character 提供的值会覆盖默认
    const full: NovelCharacter = { participatingConflicts: '[]', ...character, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_characters (id, project_id, name, description, identity, personality, appearance,
      current_state, current_goal, current_pressure, secret, arc_stage, arc_history, speech_style, is_protagonist,
      long_term_desire, plot_role, removal_impact, participating_conflicts, created_at, updated_at)
      VALUES (@id, @project_id, @name, @description, @identity, @personality, @appearance,
      @current_state, @current_goal, @current_pressure, @secret, @arc_stage, @arc_history, @speech_style, @is_protagonist,
      @long_term_desire, @plot_role, @removal_impact, @participating_conflicts, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId,
      name: bindString(full.name, '未命名'), description: bindString(full.description),
      identity: bindString(full.identity), personality: bindString(full.personality), appearance: bindString(full.appearance),
      current_state: bindString(full.currentState), current_goal: bindString(full.currentGoal), current_pressure: bindString(full.currentPressure),
      secret: bindString(full.secret), arc_stage: bindString(full.arcStage, 'introduction'), arc_history: bindString(full.arcHistory, '[]'),
      speech_style: bindString(full.speechStyle), is_protagonist: full.isProtagonist ? 1 : 0,
      long_term_desire: bindString(full.longTermDesire),
      plot_role: bindString(full.plotRole, 'supporting'),
      removal_impact: bindString(full.removalImpact),
      participating_conflicts: bindString(full.participatingConflicts ?? '[]', '[]'),
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
      long_term_desire=@long_term_desire, plot_role=@plot_role, removal_impact=@removal_impact,
      participating_conflicts=@participating_conflicts,
      updated_at=@updated_at
      WHERE id=@id
    `).run({
      id, name: bindString(updated.name, '未命名'), description: bindString(updated.description),
      identity: bindString(updated.identity), personality: bindString(updated.personality), appearance: bindString(updated.appearance),
      current_state: bindString(updated.currentState), current_goal: bindString(updated.currentGoal),
      current_pressure: bindString(updated.currentPressure), secret: bindString(updated.secret),
      arc_stage: bindString(updated.arcStage, 'introduction'), arc_history: bindString(updated.arcHistory, '[]'),
      speech_style: bindString(updated.speechStyle), is_protagonist: updated.isProtagonist ? 1 : 0,
      long_term_desire: bindString(updated.longTermDesire),
      plot_role: bindString(updated.plotRole, 'supporting'),
      removal_impact: bindString(updated.removalImpact),
      participating_conflicts: bindString(updated.participatingConflicts ?? '[]', '[]'),
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteCharacter(id: string): boolean {
    this.deleteEdgesByEntity(id)
    const result = this.db.prepare('DELETE FROM novel_characters WHERE id = ?').run(id)
    return result.changes > 0
  }

  /**
   * 删除指定角色的全部历史记录（回滚清理用，避免孤儿 history 行）。
   */
  deleteCharacterHistoryByCharacter(characterId: string): number {
    const result = this.db
      .prepare('DELETE FROM novel_character_history WHERE character_id = ?')
      .run(characterId)
    return result.changes
  }

  /**
   * 删除单条角色历史记录（矩阵视图取消角色出场用）。
   * 传 projectId 时附加项目级校验，避免跨项目误删。
   */
  deleteCharacterHistory(historyId: string, projectId?: string): boolean {
    const result = projectId != null
      ? this.db.prepare('DELETE FROM novel_character_history WHERE id = ? AND project_id = ?').run(historyId, projectId)
      : this.db.prepare('DELETE FROM novel_character_history WHERE id = ?').run(historyId)
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
      recover_by_chapter, linked_characters, linked_clues, plant_method, recover_method, linked_info_layers,
      chapter_spans, created_at, updated_at)
      VALUES (@id, @project_id, @description, @category, @status, @first_chapter, @last_chapter,
      @recover_by_chapter, @linked_characters, @linked_clues, @plant_method, @recover_method, @linked_info_layers,
      @chapter_spans, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, description: full.description,
      category: full.category, status: full.status, first_chapter: full.firstChapter,
      last_chapter: full.lastChapter, recover_by_chapter: full.recoverByChapter,
      linked_characters: full.linkedCharacters, linked_clues: full.linkedClues,
      plant_method: full.plantMethod ?? null,
      recover_method: full.recoverMethod ?? null,
      linked_info_layers: full.linkedInfoLayers ?? '[]',
      chapter_spans: JSON.stringify(full.chapterSpans ?? []),
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
      linked_characters=@linked_characters, linked_clues=@linked_clues,
      plant_method=@plant_method, recover_method=@recover_method,
      linked_info_layers=@linked_info_layers,
      chapter_spans=@chapter_spans,
      updated_at=@updated_at WHERE id=@id
    `).run({
      id, description: updated.description, category: updated.category, status: updated.status,
      first_chapter: updated.firstChapter, last_chapter: updated.lastChapter,
      recover_by_chapter: updated.recoverByChapter, linked_characters: updated.linkedCharacters,
      linked_clues: updated.linkedClues,
      plant_method: updated.plantMethod ?? null,
      recover_method: updated.recoverMethod ?? null,
      linked_info_layers: updated.linkedInfoLayers ?? '[]',
      chapter_spans: JSON.stringify(updated.chapterSpans ?? []),
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteForeshadow(id: string): boolean {
    this.deleteEdgesByEntity(id)
    // P3-2：清理信息差中 linkedForeshadows 的反向引用
    this.pruneForeshadowFromInfoLayers(id)
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
      first_chapter, last_chapter, chapter_spans, tier, plot_function, progression_mode, created_at, updated_at)
      VALUES (@id, @project_id, @description, @type, @intensity, @stage, @participants,
      @first_chapter, @last_chapter, @chapter_spans, @tier, @plot_function, @progression_mode, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, description: full.description,
      type: full.type, intensity: full.intensity, stage: full.stage,
      participants: full.participants,
      first_chapter: full.chapterSpans[0]?.[0] ?? null,
      last_chapter: full.chapterSpans[0]?.[1] ?? null,
      chapter_spans: JSON.stringify(full.chapterSpans),
      tier: full.tier,
      // plot_function 可选（旧数据 NULL）；progression_mode 默认 'linear'（向后兼容）
      plot_function: full.plotFunction ?? null,
      progression_mode: full.progressionMode ?? 'linear',
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    // 同步反向索引到角色（participating_conflicts）
    this.syncConflictParticipantsToCharacters(full.id, this.parseConflictParticipants(full.participants), [])
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
      chapter_spans=@chapter_spans, tier=@tier, plot_function=@plot_function, progression_mode=@progression_mode,
      updated_at=@updated_at WHERE id=@id
    `).run({
      id, description: updated.description, type: updated.type, intensity: updated.intensity,
      stage: updated.stage, participants: updated.participants,
      first_chapter: updated.chapterSpans[0]?.[0] ?? null,
      last_chapter: updated.chapterSpans[0]?.[1] ?? null,
      chapter_spans: JSON.stringify(updated.chapterSpans),
      tier: updated.tier,
      plot_function: updated.plotFunction ?? null,
      progression_mode: updated.progressionMode ?? 'linear',
      updated_at: updated.updatedAt,
    })
    // 同步反向索引：旧参与者中不在新列表的移除，新参与者中不在旧列表的追加
    if (patch.participants !== undefined) {
      const oldIds = this.parseConflictParticipants(current.participants)
      const newIds = this.parseConflictParticipants(updated.participants)
      this.syncConflictParticipantsToCharacters(id, newIds, oldIds)
    }
    return updated
  }

  deleteConflict(id: string): boolean {
    // 先取出旧参与者，删除后从他们的反向索引里移除该冲突 ID
    const existing = this.db.prepare('SELECT * FROM novel_conflicts WHERE id = ?').get(id) as ConflictRow | undefined
    const oldParticipantIds = existing ? this.parseConflictParticipants(existing.participants) : []
    this.deleteEdgesByEntity(id)
    const result = this.db.prepare('DELETE FROM novel_conflicts WHERE id = ?').run(id)
    if (result.changes > 0) {
      this.syncConflictParticipantsToCharacters(id, [], oldParticipantIds)
    }
    return result.changes > 0
  }

  /**
   * 解析 conflict.participants（JSON: string[]）为字符 ID 数组。
   * 容错：非 JSON / 解析失败时返回空数组（不抛错，避免阻塞主流程）。
   */
  private parseConflictParticipants(raw: string | null | undefined): string[] {
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0)
    } catch {
      // 旧数据可能是逗号分隔的名字串（entity-generator 历史遗留）
      // 这里不再做名字→ID 转换（让上游 entity-generator 统一处理），直接返回空
      return []
    }
  }

  /**
   * 同步冲突反向索引到角色的 participating_conflicts 字段。
   *
   * - 对新增的 participantIds（newIds 中有，oldIds 中无）：把 conflictId 追加到他们的 participating_conflicts
   * - 对移除的 participantIds（oldIds 中有，newIds 中无）：把 conflictId 从他们的 participating_conflicts 移除
   * - 对不变的 participantIds：不动
   *
   * 该方法被 createConflict / updateConflict / deleteConflict 调用，
   * 让 NovelCharacter.participatingConflicts 始终是 conflict.participants 的反向镜像，
   * 回答四层逻辑第四句"删掉这个角色哪段冲突线会断"。
   */
  private syncConflictParticipantsToCharacters(
    conflictId: string,
    newParticipantIds: string[],
    oldParticipantIds: string[],
  ): void {
    const added = newParticipantIds.filter((id) => !oldParticipantIds.includes(id))
    const removed = oldParticipantIds.filter((id) => !newParticipantIds.includes(id))
    if (added.length === 0 && removed.length === 0) return

    const updateOne = (characterId: string, mode: 'add' | 'remove') => {
      const row = this.db.prepare('SELECT participating_conflicts FROM novel_characters WHERE id = ?').get(characterId) as { participating_conflicts?: string } | undefined
      if (!row) return
      const current = this.parseConflictParticipants(row.participating_conflicts)
      let next: string[]
      if (mode === 'add') {
        if (current.includes(conflictId)) return
        next = [...current, conflictId]
      } else {
        next = current.filter((id) => id !== conflictId)
      }
      this.db.prepare('UPDATE novel_characters SET participating_conflicts = ? WHERE id = ?').run(
        JSON.stringify(next), characterId,
      )
    }

    for (const id of added) updateOne(id, 'add')
    for (const id of removed) updateOne(id, 'remove')
  }

  // ═══════════════════════════════════════════════════════════════
  // 钩子 CRUD（v0.2）
  // ═══════════════════════════════════════════════════════════════

  private rowToHook(row: HookRow): NovelHook {
    return {
      id: row.id,
      projectId: row.project_id,
      chapterNumber: row.chapter_number,
      hookType: row.hook_type as NovelHook['hookType'],
      description: row.description,
      status: row.status as NovelHook['status'],
      fulfilledAtChapter: row.fulfilled_at_chapter,
      fulfilledDescription: row.fulfilled_description,
      linkedForeshadowId: row.linked_foreshadow_id,
      linkedConflictId: row.linked_conflict_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  listHooks(projectId: string): NovelHook[] {
    const rows = this.db.prepare('SELECT * FROM novel_hooks WHERE project_id = ? ORDER BY chapter_number ASC, created_at ASC').all(projectId) as HookRow[]
    return rows.map(r => this.rowToHook(r))
  }

  /** 查询指定章节抛出的钩子 */
  listHooksByChapter(projectId: string, chapterNumber: number): NovelHook[] {
    const rows = this.db.prepare('SELECT * FROM novel_hooks WHERE project_id = ? AND chapter_number = ? ORDER BY created_at ASC').all(projectId, chapterNumber) as HookRow[]
    return rows.map(r => this.rowToHook(r))
  }

  /** 查询指定章节之前抛出且未兑现的钩子（供 Writer 承接） */
  listUnfulfilledHooksBefore(projectId: string, beforeChapter: number): NovelHook[] {
    const rows = this.db.prepare(
      'SELECT * FROM novel_hooks WHERE project_id = ? AND chapter_number < ? AND status = ? ORDER BY chapter_number DESC, created_at ASC'
    ).all(projectId, beforeChapter, 'thrown') as HookRow[]
    return rows.map(r => this.rowToHook(r))
  }

  getHook(id: string): NovelHook | undefined {
    const row = this.db.prepare('SELECT * FROM novel_hooks WHERE id = ?').get(id) as HookRow | undefined
    return row ? this.rowToHook(row) : undefined
  }

  createHook(hook: Omit<NovelHook, 'createdAt' | 'updatedAt'>): NovelHook {
    const ts = now()
    const full: NovelHook = { ...hook, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_hooks (id, project_id, chapter_number, hook_type, description, status,
      fulfilled_at_chapter, fulfilled_description, linked_foreshadow_id, linked_conflict_id,
      created_at, updated_at)
      VALUES (@id, @project_id, @chapter_number, @hook_type, @description, @status,
      @fulfilled_at_chapter, @fulfilled_description, @linked_foreshadow_id, @linked_conflict_id,
      @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, chapter_number: full.chapterNumber,
      hook_type: full.hookType, description: full.description, status: full.status,
      fulfilled_at_chapter: full.fulfilledAtChapter,
      fulfilled_description: full.fulfilledDescription,
      linked_foreshadow_id: full.linkedForeshadowId,
      linked_conflict_id: full.linkedConflictId,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateHook(id: string, patch: Partial<NovelHook>): NovelHook | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_hooks WHERE id = ?').get(id) as HookRow | undefined
    if (!existing) return undefined
    const current = this.rowToHook(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_hooks SET hook_type=@hook_type, description=@description, status=@status,
      fulfilled_at_chapter=@fulfilled_at_chapter, fulfilled_description=@fulfilled_description,
      linked_foreshadow_id=@linked_foreshadow_id, linked_conflict_id=@linked_conflict_id,
      updated_at=@updated_at WHERE id=@id
    `).run({
      id, hook_type: updated.hookType, description: updated.description, status: updated.status,
      fulfilled_at_chapter: updated.fulfilledAtChapter,
      fulfilled_description: updated.fulfilledDescription,
      linked_foreshadow_id: updated.linkedForeshadowId,
      linked_conflict_id: updated.linkedConflictId,
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteHook(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_hooks WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ═══════════════════════════════════════════════════════════════
  // 角色弧光 CRUD（v0.2）
  // ═══════════════════════════════════════════════════════════════

  private rowToArc(row: CharacterArcRow): NovelCharacterArc {
    let stageHistory: ArcStageHistoryEntry[] = []
    try { stageHistory = JSON.parse(row.stage_history) } catch { stageHistory = [] }
    return {
      id: row.id,
      projectId: row.project_id,
      characterId: row.character_id,
      arcType: row.arc_type as NovelCharacterArc['arcType'],
      currentStage: row.current_stage,
      stageHistory,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  listCharacterArcs(projectId: string): NovelCharacterArc[] {
    const rows = this.db.prepare('SELECT * FROM novel_character_arcs WHERE project_id = ? ORDER BY created_at ASC').all(projectId) as CharacterArcRow[]
    return rows.map(r => this.rowToArc(r))
  }

  getCharacterArc(id: string): NovelCharacterArc | undefined {
    const row = this.db.prepare('SELECT * FROM novel_character_arcs WHERE id = ?').get(id) as CharacterArcRow | undefined
    return row ? this.rowToArc(row) : undefined
  }

  getCharacterArcByCharacter(projectId: string, characterId: string): NovelCharacterArc | undefined {
    const row = this.db.prepare('SELECT * FROM novel_character_arcs WHERE project_id = ? AND character_id = ?').get(projectId, characterId) as CharacterArcRow | undefined
    return row ? this.rowToArc(row) : undefined
  }

  createCharacterArc(arc: Omit<NovelCharacterArc, 'createdAt' | 'updatedAt'>): NovelCharacterArc {
    const ts = now()
    const full: NovelCharacterArc = { ...arc, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_character_arcs (id, project_id, character_id, arc_type, current_stage,
      stage_history, description, created_at, updated_at)
      VALUES (@id, @project_id, @character_id, @arc_type, @current_stage,
      @stage_history, @description, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, character_id: full.characterId,
      arc_type: full.arcType, current_stage: full.currentStage,
      stage_history: JSON.stringify(full.stageHistory),
      description: full.description, created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateCharacterArc(id: string, patch: Partial<NovelCharacterArc>): NovelCharacterArc | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_character_arcs WHERE id = ?').get(id) as CharacterArcRow | undefined
    if (!existing) return undefined
    const current = this.rowToArc(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_character_arcs SET arc_type=@arc_type, current_stage=@current_stage,
      stage_history=@stage_history, description=@description, updated_at=@updated_at WHERE id=@id
    `).run({
      id, arc_type: updated.arcType, current_stage: updated.currentStage,
      stage_history: JSON.stringify(updated.stageHistory),
      description: updated.description, updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteCharacterArc(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_character_arcs WHERE id = ?').run(id)
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
      INSERT INTO novel_relationships (id, project_id, character_a, character_b, relation_type, current_stage, stage_history,
      dynamic_role, alignment, trend, chapter_hint, last_updated_chapter, created_at, updated_at)
      VALUES (@id, @project_id, @character_a, @character_b, @relation_type, @current_stage, @stage_history,
      @dynamic_role, @alignment, @trend, @chapter_hint, @last_updated_chapter, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, character_a: full.characterA,
      character_b: full.characterB, relation_type: full.relationType,
      current_stage: full.currentStage, stage_history: full.stageHistory,
      dynamic_role: full.dynamicRole ?? '',
      alignment: full.alignment ?? 'neutral',
      trend: full.trend ?? 'stable',
      chapter_hint: full.chapterHint ?? '',
      last_updated_chapter: full.lastUpdatedChapter ?? null,
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
      relation_type=@relation_type, current_stage=@current_stage, stage_history=@stage_history,
      dynamic_role=@dynamic_role, alignment=@alignment, trend=@trend,
      chapter_hint=@chapter_hint, last_updated_chapter=@last_updated_chapter,
      updated_at=@updated_at WHERE id=@id
    `).run({
      id, character_a: updated.characterA, character_b: updated.characterB,
      relation_type: updated.relationType, current_stage: updated.currentStage,
      stage_history: updated.stageHistory,
      dynamic_role: updated.dynamicRole ?? '',
      alignment: updated.alignment ?? 'neutral',
      trend: updated.trend ?? 'stable',
      chapter_hint: updated.chapterHint ?? '',
      last_updated_chapter: updated.lastUpdatedChapter ?? null,
      updated_at: updated.updatedAt,
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
      INSERT INTO novel_information_layers (id, project_id, info_description, author_knows, reader_knows, character_knowledge, reveal_stage, reveal_chapter, is_revealed, linked_foreshadows, created_at, updated_at)
      VALUES (@id, @project_id, @info_description, @author_knows, @reader_knows, @character_knowledge, @reveal_stage, @reveal_chapter, @is_revealed, @linked_foreshadows, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, info_description: full.infoDescription,
      author_knows: full.authorKnows ? 1 : 0, reader_knows: full.readerKnows ? 1 : 0,
      character_knowledge: full.characterKnowledge, reveal_stage: full.revealStage,
      reveal_chapter: full.revealChapter, is_revealed: full.isRevealed ? 1 : 0,
      linked_foreshadows: full.linkedForeshadows ?? '[]',
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
    this.deleteEdgesByEntity(id)
    // P3-2：清理伏笔中 linkedInfoLayers 的反向引用
    this.pruneInfoLayerFromForeshadows(id)
    const result = this.db.prepare('DELETE FROM novel_information_layers WHERE id = ?').run(id)
    return result.changes > 0
  }

  /**
   * P3-2：建立伏笔↔信息差双向关联
   *
   * - 在 foreshadow.linked_info_layers 数组追加 infoLayerId（去重）
   * - 在 infoLayer.linked_foreshadows 数组追加 foreshadowId（去重）
   * - 已存在则幂等返回
   * - 双向同步避免单端遗漏
   */
  linkForeshadowToInfoLayer(foreshadowId: string, infoLayerId: string): void {
    // 更新伏笔端
    const fRow = this.db.prepare('SELECT linked_info_layers FROM novel_foreshadowing WHERE id = ?').get(foreshadowId) as { linked_info_layers: string } | undefined
    if (fRow) {
      const ids = this.parseIdListSafe(fRow.linked_info_layers)
      if (!ids.includes(infoLayerId)) {
        ids.push(infoLayerId)
        this.db.prepare('UPDATE novel_foreshadowing SET linked_info_layers = ?, updated_at = unixepoch() WHERE id = ?').run(JSON.stringify(ids), foreshadowId)
      }
    }
    // 更新信息差端
    const iRow = this.db.prepare('SELECT linked_foreshadows FROM novel_information_layers WHERE id = ?').get(infoLayerId) as { linked_foreshadows: string } | undefined
    if (iRow) {
      const ids = this.parseIdListSafe(iRow.linked_foreshadows)
      if (!ids.includes(foreshadowId)) {
        ids.push(foreshadowId)
        this.db.prepare('UPDATE novel_information_layers SET linked_foreshadows = ?, updated_at = unixepoch() WHERE id = ?').run(JSON.stringify(ids), infoLayerId)
      }
    }
  }

  /**
   * P3-2：解除伏笔↔信息差双向关联（如果存在）
   * 用于测试或用户手动取消关联
   */
  unlinkForeshadowFromInfoLayer(foreshadowId: string, infoLayerId: string): void {
    const fRow = this.db.prepare('SELECT linked_info_layers FROM novel_foreshadowing WHERE id = ?').get(foreshadowId) as { linked_info_layers: string } | undefined
    if (fRow) {
      const ids = this.parseIdListSafe(fRow.linked_info_layers).filter(id => id !== infoLayerId)
      this.db.prepare('UPDATE novel_foreshadowing SET linked_info_layers = ?, updated_at = unixepoch() WHERE id = ?').run(JSON.stringify(ids), foreshadowId)
    }
    const iRow = this.db.prepare('SELECT linked_foreshadows FROM novel_information_layers WHERE id = ?').get(infoLayerId) as { linked_foreshadows: string } | undefined
    if (iRow) {
      const ids = this.parseIdListSafe(iRow.linked_foreshadows).filter(id => id !== foreshadowId)
      this.db.prepare('UPDATE novel_information_layers SET linked_foreshadows = ?, updated_at = unixepoch() WHERE id = ?').run(JSON.stringify(ids), infoLayerId)
    }
  }

  /** 删除伏笔时，从所有信息差的 linkedForeshadows 数组中移除该伏笔 ID */
  private pruneForeshadowFromInfoLayers(foreshadowId: string): void {
    const rows = this.db.prepare("SELECT id, linked_foreshadows FROM novel_information_layers WHERE linked_foreshadows LIKE ?").all(`%${foreshadowId}%`) as Array<{ id: string; linked_foreshadows: string }>
    for (const row of rows) {
      const ids = this.parseIdListSafe(row.linked_foreshadows).filter(id => id !== foreshadowId)
      this.db.prepare('UPDATE novel_information_layers SET linked_foreshadows = ?, updated_at = unixepoch() WHERE id = ?').run(JSON.stringify(ids), row.id)
    }
  }

  /** 删除信息差时，从所有伏笔的 linkedInfoLayers 数组中移除该信息差 ID */
  private pruneInfoLayerFromForeshadows(infoLayerId: string): void {
    const rows = this.db.prepare("SELECT id, linked_info_layers FROM novel_foreshadowing WHERE linked_info_layers LIKE ?").all(`%${infoLayerId}%`) as Array<{ id: string; linked_info_layers: string }>
    for (const row of rows) {
      const ids = this.parseIdListSafe(row.linked_info_layers).filter(id => id !== infoLayerId)
      this.db.prepare('UPDATE novel_foreshadowing SET linked_info_layers = ?, updated_at = unixepoch() WHERE id = ?').run(JSON.stringify(ids), row.id)
    }
  }

  /** 容错解析 JSON: string[]（与 parseIdList 一致，但用于 P3-2 双向字段） */
  private parseIdListSafe(raw: string | null | undefined): string[] {
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
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
      strength, resources, allies, enemies, status, first_chapter, last_chapter, chapter_spans, created_at, updated_at)
      VALUES (@id, @project_id, @name, @description, @type, @leader_id, @ideology,
      @strength, @resources, @allies, @enemies, @status, @first_chapter, @last_chapter, @chapter_spans, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, name: full.name, description: full.description,
      type: full.type, leader_id: full.leaderId, ideology: full.ideology,
      strength: full.strength, resources: JSON.stringify(full.resources),
      allies: JSON.stringify(full.allies), enemies: JSON.stringify(full.enemies),
      status: full.status,
      first_chapter: full.chapterSpans[0]?.[0] ?? null,
      last_chapter: full.chapterSpans[0]?.[1] ?? null,
      chapter_spans: JSON.stringify(full.chapterSpans),
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
      status=@status, first_chapter=@first_chapter, last_chapter=@last_chapter, chapter_spans=@chapter_spans, updated_at=@updated_at WHERE id=@id
    `).run({
      id, name: updated.name, description: updated.description, type: updated.type,
      leader_id: updated.leaderId, ideology: updated.ideology, strength: updated.strength,
      resources: JSON.stringify(updated.resources), allies: JSON.stringify(updated.allies),
      enemies: JSON.stringify(updated.enemies), status: updated.status,
      first_chapter: updated.chapterSpans[0]?.[0] ?? null,
      last_chapter: updated.chapterSpans[0]?.[1] ?? null,
      chapter_spans: JSON.stringify(updated.chapterSpans),
      updated_at: updated.updatedAt,
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
  // 实体去重（整理功能）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 扫描并合并重复实体。
   *
   * 判重规则：
   * - character / faction / location：按 name 完全相同（trim + 小写归一化）
   * - conflict / foreshadow：按 description 完全相同（trim）
   * - 不做模糊匹配，避免误判；用户如需合并相似但非完全相同的实体，可在画布上手动删除
   *
   * 合并策略：
   * - 每组保留 createdAt 最早的实体
   * - 删除前迁移关联数据（edges、character_history、relationships、JSON 反向引用等）
   * - 自环（合并后实体指向自身）的 edges / relationships 会被删除
   *
   * @param dryRun true 只扫描返回报告，不实际合并
   */
  deduplicateEntities(projectId: string, options?: { dryRun?: boolean }): DeduplicateReport {
    const dryRun = options?.dryRun ?? false
    const groups: DeduplicateGroup[] = []

    // 按 character → conflict → foreshadow → faction → location 顺序扫描
    groups.push(...this.findDuplicateGroups(projectId, 'character'))
    groups.push(...this.findDuplicateGroups(projectId, 'conflict'))
    groups.push(...this.findDuplicateGroups(projectId, 'foreshadow'))
    groups.push(...this.findDuplicateGroups(projectId, 'faction'))
    groups.push(...this.findDuplicateGroups(projectId, 'location'))

    if (dryRun || groups.length === 0) {
      return { groups, totalRemoved: groups.reduce((s, g) => s + g.removed.length, 0) }
    }

    // 执行合并：每组迁移关联 + 删除重复实体
    // 用事务包裹，保证原子性（任一失败回滚）
    this.db.transaction(() => {
      for (const g of groups) {
        this.mergeDuplicateGroup(g)
      }
    })()

    return { groups, totalRemoved: groups.reduce((s, g) => s + g.removed.length, 0) }
  }

  // ═══════════════════════════════════════════════════════════════
  // LLM 相似度合并（mergeWithPlan）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 按 LLM 给出的相似度合并方案执行字段级合并 + 关联迁移 + 删除重复实体。
   *
   * 与 deduplicateEntities 的差异：
   * - deduplicateEntities 按 createdAt 最早的保留（快速去重，处理"完全相同"的重复）
   * - mergeWithPlan 接受 LLM 的 SimilarityGroup 列表，保留 LLM 指定的 keptId
   *   （处理"语义相似但表述不同"的重复）
   * - 支持 fieldMerges：先把删除项的字段值迁移到保留项，再走 retargetEdges
   *   + merge*Associations + delete 流程
   *
   * 整体在事务中执行，保证原子性（任一组失败回滚全部）。
   *
   * @param projectId 当前项目 ID，用于执行合并前的实体归属校验
   * @param groups LLM 给出的相似度合并方案（由 NovelSimilarityScanner 产出，用户确认后传入）
   * @returns 合并统计：被合并（删除）的实体总数
   */
  mergeWithPlan(projectId: string, groups: SimilarityGroup[]): { totalMerged: number } {
    if (groups.length === 0) return { totalMerged: 0 }

    this.db.transaction(() => {
      for (const g of groups) {
        this.assertSimilarityGroupBelongsToProject(projectId, g)
        this.mergeSimilarityGroup(g)
      }
    })()

    return { totalMerged: groups.reduce((s, g) => s + g.removed.length, 0) }
  }

  private assertSimilarityGroupBelongsToProject(projectId: string, group: SimilarityGroup): void {
    const { kind, keptId, removed, fieldMerges } = group
    const ids = new Set<string>([keptId, ...removed.map((r) => r.id)])
    for (const fm of fieldMerges ?? []) {
      ids.add(fm.fromId)
    }
    for (const id of ids) {
      const entityProjectId = this.getEntityProjectId(kind, id)
      if (entityProjectId !== projectId) {
        throw new Error(`相似实体合并包含非当前项目实体：${kind}/${id}`)
      }
    }
  }

  private getEntityProjectId(kind: SimilarityGroup['kind'], id: string): string | undefined {
    switch (kind) {
      case 'character':
        return this.getCharacter(id)?.projectId
      case 'conflict':
        return this.getConflict(id)?.projectId
      case 'foreshadow':
        return this.getForeshadow(id)?.projectId
      case 'faction':
        return this.getFaction(id)?.projectId
      case 'location':
        return this.getLocation(id)?.projectId
      case 'world_element':
        return this.getWorldElement(id)?.projectId
    }
  }

  /** 执行单组相似度合并：字段级合并 → 迁移 edges → 迁移关联 → 删除重复实体 */
  private mergeSimilarityGroup(group: SimilarityGroup): void {
    const { kind, keptId, removed, fieldMerges } = group
    const removedIds = removed.map((r) => r.id)

    // 1. 字段级合并：先把 fieldMerges 中标注的字段值从 fromId 迁移到 keptId
    //    必须在 retargetEdges / delete 之前执行，否则 fromId 实体已被删除无法读取
    if (fieldMerges && fieldMerges.length > 0) {
      this.applyFieldMerges(kind, keptId, fieldMerges)
    }

    // 2. 通用：迁移 edges（source_id/target_id 替换为 keptId，自环删除）
    this.retargetEdges(keptId, removedIds)

    // 3. 按实体类型迁移关联表（world_element 没有关联表，只走 retargetEdges + delete）
    switch (kind) {
      case 'character':
        this.mergeCharacterAssociations(keptId, removedIds)
        break
      case 'conflict':
        this.mergeConflictAssociations(keptId, removedIds)
        break
      case 'foreshadow':
        this.mergeForeshadowAssociations(keptId, removedIds)
        break
      case 'faction':
        this.mergeFactionAssociations(keptId, removedIds)
        break
      case 'location':
        this.mergeLocationAssociations(keptId, removedIds)
        break
      case 'world_element':
        // world_element 无独立关联表（无 leader_id / parent_id 等外键反查）
        // edges 已通过 retargetEdges 迁移，直接进入删除阶段
        break
    }

    // 4. 删除 removedIds 对应的实体（edges 已迁移，deleteXxx 内部会再次尝试清理 edges，no-op）
    for (const id of removedIds) {
      switch (kind) {
        case 'character':
          // character 删除前需先清理 history（deleteCharacter 不自动级联）
          this.deleteCharacterHistoryByCharacter(id)
          this.deleteCharacter(id)
          break
        case 'conflict':
          this.deleteConflict(id)
          break
        case 'foreshadow':
          this.deleteForeshadow(id)
          break
        case 'faction':
          this.deleteFaction(id)
          break
        case 'location':
          this.deleteLocation(id)
          break
        case 'world_element':
          this.deleteWorldElement(id)
          break
      }
    }
  }

  /**
   * 字段级合并：按 fieldMerges 把 fromId 实体的字段值迁移到 keptId 实体的同名字段。
   *
   * 同一 fromId 的多个字段批量处理（一次 update 调用），避免多次写库。
   * 必须在删除 fromId 之前调用（依赖 get* 读取源实体的当前值）。
   */
  private applyFieldMerges(
    kind: SimilarityGroup['kind'],
    keptId: string,
    fieldMerges: NonNullable<SimilarityGroup['fieldMerges']>,
  ): void {
    // 按 fromId 分组：每个 fromId 的多个字段一次性 patch 到 keptId
    const byFromId = new Map<string, string[]>()
    for (const fm of fieldMerges) {
      const arr = byFromId.get(fm.fromId) ?? []
      arr.push(fm.field)
      byFromId.set(fm.fromId, arr)
    }

    for (const [fromId, fields] of byFromId) {
      switch (kind) {
        case 'character': {
          const patch = this.pickFields(this.getCharacter(fromId), fields)
          if (Object.keys(patch).length > 0) this.updateCharacter(keptId, patch)
          break
        }
        case 'conflict': {
          const patch = this.pickFields(this.getConflict(fromId), fields)
          if (Object.keys(patch).length > 0) this.updateConflict(keptId, patch)
          break
        }
        case 'foreshadow': {
          const patch = this.pickFields(this.getForeshadow(fromId), fields)
          if (Object.keys(patch).length > 0) this.updateForeshadow(keptId, patch)
          break
        }
        case 'faction': {
          const patch = this.pickFields(this.getFaction(fromId), fields)
          if (Object.keys(patch).length > 0) this.updateFaction(keptId, patch)
          break
        }
        case 'location': {
          const patch = this.pickFields(this.getLocation(fromId), fields)
          if (Object.keys(patch).length > 0) this.updateLocation(keptId, patch)
          break
        }
        case 'world_element': {
          const patch = this.pickFields(this.getWorldElement(fromId), fields)
          if (Object.keys(patch).length > 0) this.updateWorldElement(keptId, patch)
          break
        }
      }
    }
  }

  /**
   * 从源对象按字段名列表提取 patch（用于字段级合并）。
   * 只提取源对象实际存在的字段，避免 undefined 覆盖保留项的现有值。
   */
  private pickFields<T extends object>(src: T | undefined, fields: string[]): Partial<T> {
    const patch: Partial<T> = {}
    if (!src) return patch
    const srcRecord = src as Record<string, unknown>
    const patchRecord = patch as Record<string, unknown>
    for (const f of fields) {
      if (f in srcRecord) patchRecord[f] = srcRecord[f]
    }
    return patch
  }

  /** 扫描某种实体的重复组 */
  private findDuplicateGroups(projectId: string, kind: DeduplicateEntityKind): DeduplicateGroup[] {
    // 按 kind 取出实体列表，统一为 { id, name, createdAt } 形态
    type Unified = { id: string; name: string; createdAt: number }
    let entities: Unified[] = []
    switch (kind) {
      case 'character':
        entities = this.listCharacters(projectId).map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt }))
        break
      case 'conflict':
        entities = this.listConflicts(projectId).map((c) => ({ id: c.id, name: c.description, createdAt: c.createdAt }))
        break
      case 'foreshadow':
        entities = this.listForeshadowing(projectId).map((f) => ({ id: f.id, name: f.description, createdAt: f.createdAt }))
        break
      case 'faction':
        entities = this.listFactions(projectId).map((f) => ({ id: f.id, name: f.name, createdAt: f.createdAt }))
        break
      case 'location':
        entities = this.listLocations(projectId).map((l) => ({ id: l.id, name: l.name, createdAt: l.createdAt }))
        break
    }

    // 按 key 分组（character/faction/location 用 name 小写归一化，conflict/foreshadow 用 description trim）
    const byKey = new Map<string, Unified[]>()
    const isNamedKind = kind === 'character' || kind === 'faction' || kind === 'location'
    for (const e of entities) {
      const raw = e.name?.trim() ?? ''
      if (!raw) continue
      const key = isNamedKind ? raw.toLowerCase() : raw
      const arr = byKey.get(key) ?? []
      arr.push(e)
      byKey.set(key, arr)
    }

    const groups: DeduplicateGroup[] = []
    for (const [key, arr] of byKey) {
      if (arr.length < 2) continue
      // 按 createdAt 升序，保留最早的
      arr.sort((a, b) => a.createdAt - b.createdAt)
      const kept = arr[0]
      const removed = arr.slice(1)
      groups.push({
        kind,
        // 报告中展示原始 key（保留大小写），便于用户识别
        key: arr[0].name,
        keptId: kept.id,
        keptName: kept.name,
        removed: removed.map((e) => ({ id: e.id, name: e.name, createdAt: e.createdAt })),
      })
    }
    return groups
  }

  /** 执行单组合并：迁移关联数据 + 删除重复实体 */
  private mergeDuplicateGroup(group: DeduplicateGroup): void {
    const { kind, keptId, removed } = group
    const removedIds = removed.map((r) => r.id)

    // 通用：迁移 edges（source_id/target_id 替换为 keptId，自环删除）
    this.retargetEdges(keptId, removedIds)

    // 按实体类型迁移关联
    switch (kind) {
      case 'character':
        this.mergeCharacterAssociations(keptId, removedIds)
        break
      case 'conflict':
        this.mergeConflictAssociations(keptId, removedIds)
        break
      case 'foreshadow':
        this.mergeForeshadowAssociations(keptId, removedIds)
        break
      case 'faction':
        this.mergeFactionAssociations(keptId, removedIds)
        break
      case 'location':
        this.mergeLocationAssociations(keptId, removedIds)
        break
    }

    // 删除重复实体（edges 已迁移，deleteXxx 会再次尝试清理 edges，no-op）
    for (const id of removedIds) {
      switch (kind) {
        case 'character':
          // character 删除前需先清理 history（deleteCharacter 不自动级联）
          this.deleteCharacterHistoryByCharacter(id)
          this.deleteCharacter(id)
          break
        case 'conflict':
          this.deleteConflict(id)
          break
        case 'foreshadow':
          this.deleteForeshadow(id)
          break
        case 'faction':
          this.deleteFaction(id)
          break
        case 'location':
          this.deleteLocation(id)
          break
      }
    }
  }

  /**
   * 迁移 edges：把 removedIds 的 source_id/target_id 改为 keptId，删除自环。
   * 顺序很重要：
   * 1. 删除 source 和 target 都在 removedIds 中的边（合并后必然自环）
   * 2. 删除 source 或 target 是 keptId，另一个在 removedIds 中的边（合并后自环 keptId→keptId）
   * 3. UPDATE 其他边的 source_id/target_id
   */
  private retargetEdges(keptId: string, removedIds: string[]): void {
    if (removedIds.length === 0) return
    const placeholders = removedIds.map(() => '?').join(',')
    // 1. 删除 removedIds 内部的边
    this.db.prepare(
      `DELETE FROM novel_edges WHERE source_id IN (${placeholders}) AND target_id IN (${placeholders})`,
    ).run(...removedIds, ...removedIds)
    // 2. 删除 keptId ↔ removedIds 的边（合并后自环）
    this.db.prepare(
      `DELETE FROM novel_edges WHERE (source_id = ? AND target_id IN (${placeholders}))
       OR (source_id IN (${placeholders}) AND target_id = ?)`,
    ).run(keptId, ...removedIds, ...removedIds, keptId)
    // 3. UPDATE 其他边
    this.db.prepare(
      `UPDATE novel_edges SET source_id = ? WHERE source_id IN (${placeholders})`,
    ).run(keptId, ...removedIds)
    this.db.prepare(
      `UPDATE novel_edges SET target_id = ? WHERE target_id IN (${placeholders})`,
    ).run(keptId, ...removedIds)
  }

  /** character 关联迁移：character_history、relationships、conflicts.participants、factions.leader_id */
  private mergeCharacterAssociations(keptId: string, removedIds: string[]): void {
    if (removedIds.length === 0) return
    const placeholders = removedIds.map(() => '?').join(',')

    // 1. character_history：直接改 character_id
    this.db.prepare(
      `UPDATE novel_character_history SET character_id = ? WHERE character_id IN (${placeholders})`,
    ).run(keptId, ...removedIds)

    // 2. relationships：character_a/b 改为 keptId，自环（a==b）删除
    //    先删除自环（a 和 b 都在 removedIds 中，或 a==b 且都在合并集合）
    this.db.prepare(
      `DELETE FROM novel_relationships WHERE character_a IN (${placeholders}) AND character_b IN (${placeholders})`,
    ).run(...removedIds, ...removedIds)
    //    删除合并后自环（一方是 keptId，另一方在 removedIds 中）
    this.db.prepare(
      `DELETE FROM novel_relationships WHERE (character_a = ? AND character_b IN (${placeholders}))
       OR (character_a IN (${placeholders}) AND character_b = ?)`,
    ).run(keptId, ...removedIds, ...removedIds, keptId)
    //    UPDATE 其他关系的 a/b
    this.db.prepare(
      `UPDATE novel_relationships SET character_a = ? WHERE character_a IN (${placeholders})`,
    ).run(keptId, ...removedIds)
    this.db.prepare(
      `UPDATE novel_relationships SET character_b = ? WHERE character_b IN (${placeholders})`,
    ).run(keptId, ...removedIds)

    // 3. conflicts.participants (JSON: string[])：把 removedIds 替换为 keptId（去重）
    this.retargetJsonArrayField(
      'novel_conflicts', 'participants',
      keptId, removedIds,
    )

    // 4. factions.leader_id：直接改
    this.db.prepare(
      `UPDATE novel_factions SET leader_id = ? WHERE leader_id IN (${placeholders})`,
    ).run(keptId, ...removedIds)
  }

  /** conflict 关联迁移：characters.participating_conflicts（JSON 反向索引） */
  private mergeConflictAssociations(keptId: string, removedIds: string[]): void {
    if (removedIds.length === 0) return
    // 把 characters.participating_conflicts 中的 removedIds 替换为 keptId（去重）
    this.retargetJsonArrayField(
      'novel_characters', 'participating_conflicts',
      keptId, removedIds,
    )
  }

  /** foreshadow 关联迁移：clues.linked_foreshadow（单 ID）、info_layers.linked_foreshadows（JSON 数组） */
  private mergeForeshadowAssociations(keptId: string, removedIds: string[]): void {
    if (removedIds.length === 0) return
    const placeholders = removedIds.map(() => '?').join(',')

    // 1. clues.linked_foreshadow（单 ID，TEXT）：直接 UPDATE，但要避免与 keptId 冲突
    //    先删除指向 keptId 的重复线索（避免 UPDATE 后产生重复指向）
    //    实际上 linked_foreshadow 是单值，不会产生重复，直接 UPDATE 即可
    this.db.prepare(
      `UPDATE novel_clues SET linked_foreshadow = ? WHERE linked_foreshadow IN (${placeholders})`,
    ).run(keptId, ...removedIds)

    // 2. info_layers.linked_foreshadows (JSON: string[])：把 removedIds 替换为 keptId（去重）
    this.retargetJsonArrayField(
      'novel_information_layers', 'linked_foreshadows',
      keptId, removedIds,
    )
  }

  /** faction 关联迁移：locations.faction_id */
  private mergeFactionAssociations(keptId: string, removedIds: string[]): void {
    if (removedIds.length === 0) return
    const placeholders = removedIds.map(() => '?').join(',')
    this.db.prepare(
      `UPDATE novel_locations SET faction_id = ? WHERE faction_id IN (${placeholders})`,
    ).run(keptId, ...removedIds)
  }

  /** location 关联迁移：locations.parent_id（自引用层级） */
  private mergeLocationAssociations(keptId: string, removedIds: string[]): void {
    if (removedIds.length === 0) return
    const placeholders = removedIds.map(() => '?').join(',')
    // 把指向 removedIds 的 parent_id 改为 keptId
    // 注意：如果某个 location 的 parent_id 是自己（理论上不应该），不会受影响
    this.db.prepare(
      `UPDATE novel_locations SET parent_id = ? WHERE parent_id IN (${placeholders})`,
    ).run(keptId, ...removedIds)
  }

  /**
   * 通用 JSON 数组字段迁移：把表中某 JSON 数组字段里的 removedIds 替换为 keptId（去重）。
   * 用于 conflicts.participants / characters.participating_conflicts / info_layers.linked_foreshadows 等反向索引。
   *
   * 实现策略：
   * - 用 LIKE '%id%' 粗筛出可能包含任意 removedId 的行
   * - 逐行解析 JSON、替换、去重、回写
   *
   * @param table 表名（如 'novel_characters'）
   * @param field JSON 数组字段名（如 'participating_conflicts'）
   */
  private retargetJsonArrayField(
    table: string,
    field: string,
    keptId: string,
    removedIds: string[],
  ): void {
    if (removedIds.length === 0) return
    // 用 LIKE 粗筛出可能包含任意 removedId 的行（避免全表扫描）
    // 每个 removedId 单独 LIKE，OR 连接
    const likeClauses = removedIds.map(() => `${field} LIKE ?`).join(' OR ')
    const likeParams = removedIds.map((id) => `%"${id}"%`)
    const rows = this.db.prepare(
      `SELECT id, ${field} as arr FROM ${table} WHERE ${likeClauses}`,
    ).all(...likeParams) as Array<{ id: string; arr: string | null }>

    const updateStmt = this.db.prepare(
      `UPDATE ${table} SET ${field} = ? WHERE id = ?`,
    )
    for (const row of rows) {
      const ids = this.parseIdListSafe(row.arr)
      const next = ids.filter((id) => !removedIds.includes(id))
      if (ids.some((id) => removedIds.includes(id))) {
        // 只有确实命中 removedIds 时才加 keptId（避免无谓写入）
        if (!next.includes(keptId)) next.push(keptId)
        updateStmt.run(JSON.stringify(next), row.id)
      }
    }
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
      input_tokens: full.inputTokens ?? 0,
      output_tokens: full.outputTokens ?? 0,
      cache_read_tokens: full.cacheReadTokens ?? 0,
      cache_write_tokens: full.cacheWriteTokens ?? 0,
      llm_provider: full.llmProvider ?? '',
      llm_model: full.llmModel ?? '',
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

  /** 查询项目级完整 Agent 日志（含 result 字段，供 prompt-builder 使用） */
  listAgentLogsByProject(projectId: string, limit: number): NovelAgentLog[] {
    const effectiveLimit = Math.min(Math.max(limit, 1), 500)
    const rows = this.stmtListAgentLogsByProject.all(projectId, effectiveLimit) as AgentLogRow[]
    return rows.map((r) => this.rowToAgentLog(r))
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
      deletedAt: row.deleted_at,
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
      tension: row.tension ?? null,
      timeOffset: row.time_offset ?? null,
      chapterEndingHook: (row.chapter_ending_hook as NovelChapter['chapterEndingHook']) ?? null,
      recap: row.recap ?? null,
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
    const validPlotRoles = ['protagonist', 'main_opponent', 'supporting', 'function', 'background']
    return {
      id: row.id, projectId: row.project_id, name: row.name, description: row.description,
      identity: row.identity, personality: row.personality, appearance: row.appearance,
      currentState: row.current_state, currentGoal: row.current_goal,
      currentPressure: row.current_pressure, secret: row.secret,
      arcStage: row.arc_stage, arcHistory: row.arc_history, speechStyle: row.speech_style,
      isProtagonist: row.is_protagonist === 1,
      longTermDesire: row.long_term_desire,
      plotRole: (validPlotRoles.includes(row.plot_role) ? row.plot_role : 'supporting') as NovelCharacter['plotRole'],
      removalImpact: row.removal_impact,
      participatingConflicts: row.participating_conflicts ?? '[]',
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToRelationship(row: RelationshipRow): NovelRelationship {
    const validAlignments = ['ally', 'temporary_ally', 'opponent', 'temporary_opponent', 'neutral', 'pending_shift']
    const validTrends = ['stable', 'warming', 'cooling', 'breaking', 'reconciling']
    return {
      id: row.id, projectId: row.project_id, characterA: row.character_a,
      characterB: row.character_b, relationType: row.relation_type,
      currentStage: row.current_stage, stageHistory: row.stage_history,
      dynamicRole: row.dynamic_role ?? '',
      alignment: (validAlignments.includes(row.alignment) ? row.alignment : 'neutral') as NovelRelationship['alignment'],
      trend: (validTrends.includes(row.trend) ? row.trend : 'stable') as NovelRelationship['trend'],
      chapterHint: row.chapter_hint ?? '',
      lastUpdatedChapter: row.last_updated_chapter ?? null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToForeshadow(row: ForeshadowRow): NovelForeshadow {
    return {
      id: row.id, projectId: row.project_id, description: row.description,
      // category 容错转换：旧数据可能是自由字符串（如 "物品"/"身份"），
      // 通过 normalizeForeshadowCategory 解析为新枚举，未匹配的回退到 'item'
      category: normalizeForeshadowCategory(row.category),
      status: row.status as NovelForeshadow['status'],
      firstChapter: row.first_chapter, lastChapter: row.last_chapter,
      recoverByChapter: row.recover_by_chapter, linkedCharacters: row.linked_characters,
      linkedClues: row.linked_clues,
      plantMethod: normalizeForeshadowPlantMethod(row.plant_method),
      recoverMethod: normalizeForeshadowRecoverMethod(row.recover_method),
      // P3-2：双向关联字段（NULL 容错，迁移前的行可能未填默认 '[]'）
      linkedInfoLayers: row.linked_info_layers ?? '[]',
      // 迁移 055：多段章节跨度（NULL 容错，迁移前的行 chapterSpans 为 []）
      chapterSpans: parseChapterSpans(row.chapter_spans),
      createdAt: row.created_at, updatedAt: row.updated_at,
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
      chapterSpans: parseChapterSpans(row.chapter_spans),
      tier: (row.tier as ConflictTier) ?? 'secondary',
      // 四层逻辑③：功能层 + 推进模式（NULL/无效值回退到默认）
      plotFunction: normalizeConflictPlotFunction(row.plot_function),
      progressionMode: normalizeConflictProgressionMode(row.progression_mode),
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
      // P3-2：双向关联字段（NULL 容错）
      linkedForeshadows: row.linked_foreshadows ?? '[]',
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
      chapterSpans: parseChapterSpans(row.chapter_spans),
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
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      cacheReadTokens: row.cache_read_tokens ?? 0,
      cacheWriteTokens: row.cache_write_tokens ?? 0,
      llmProvider: row.llm_provider ?? '',
      llmModel: row.llm_model ?? '',
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
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      cacheReadTokens: row.cache_read_tokens ?? 0,
      cacheWriteTokens: row.cache_write_tokens ?? 0,
      llmProvider: row.llm_provider ?? '',
      llmModel: row.llm_model ?? '',
      createdAt: row.created_at,
    }
  }
}
