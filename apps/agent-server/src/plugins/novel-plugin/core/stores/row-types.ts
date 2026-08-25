/**
 * NovelStore 所有 SQLite snake_case 行类型定义
 *
 * 从原 novel-store.ts 抽取，供 9 个子 Store 共用。
 */

// ── 项目 ──

export interface ProjectRow {
  id: string
  title: string
  genre: string
  synopsis: string
  outline: string
  target_words: number
  current_volume: number
  current_chapter: number
  current_stage: string
  status: string
  created_at: number
  updated_at: number
  deleted_at: number | null
  target_platform: string | null
  novel_ask_story_policy: string | null
  feature_flags: string
  novel_model_id: string | null
}

// ── 章节 ──

export interface ChapterRow {
  id: string
  project_id: string
  volume: number
  chapter_number: number
  title: string
  content: string
  word_count: number
  status: string
  narrative_task: string
  outline: string
  volume_id: string | null
  acceptance_result: string | null
  tension: number | null
  positioning: string | null
  time_offset: number | null
  chapter_ending_hook: string | null
  recap: string | null
  created_at: number
  updated_at: number
}

export interface VolumeRow {
  id: string
  project_id: string
  volume_number: number
  title: string
  outline: string
  sort_order: number
  created_at: number
  updated_at: number
}

export interface ChapterVersionRow {
  id: string
  chapter_id: string
  project_id: string
  content: string
  word_count: number
  phase: string | null
  agent_type: string | null
  trigger: string | null
  sequence: number
  created_at: number
}

/** novel_chapter_content_revisions 行（不可变正文版本链） */
export interface ContentRevisionRow {
  id: string
  chapter_id: string
  project_id: string
  parent_revision_id: string | null
  revision: number
  content: string
  word_count: number
  phase: string | null
  agent_type: string | null
  trigger: string | null
  status: string
  created_at: number
}

export interface HookRow {
  id: string
  project_id: string
  chapter_number: number
  hook_type: string
  description: string
  status: string
  fulfilled_at_chapter: number | null
  fulfilled_description: string | null
  created_at: number
  updated_at: number
}

export interface CharacterArcRow {
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

// ── 角色 / 关系 / 历史 ──

export interface CharacterRow {
  id: string
  project_id: string
  name: string
  description: string
  identity: string
  personality: string
  appearance: string
  current_state: string
  current_goal: string
  current_pressure: string
  secret: string
  arc_stage: string
  arc_history: string
  speech_style: string
  is_protagonist: number
  long_term_desire: string
  plot_role: string
  removal_impact: string
  created_at: number
  updated_at: number
}

export interface RelationshipRow {
  id: string
  project_id: string
  character_a: string
  character_b: string
  relation_type: string
  current_stage: string
  stage_history: string
  dynamic_role: string
  alignment: string
  trend: string
  chapter_hint: string
  last_updated_chapter: number | null
  created_at: number
  updated_at: number
}

export interface CharacterHistoryRow {
  id: string
  project_id: string
  character_id: string
  chapter_id: string | null
  chapter_number: number | null
  field_name: string
  old_value: string | null
  new_value: string | null
  reason: string | null
  created_at: number
}

// ── 冲突 / 伏笔 / 线索 / 信息差 ──

export interface ConflictRow {
  id: string
  project_id: string
  description: string
  type: string
  intensity: number
  stage: string
  participants: string
  tier: string
  chapter_spans: string | null
  plot_function: string | null
  progression_mode: string | null
  // 071: 推进粒度（类比 novel_clues.current_step/next_step）
  current_step: string
  next_step: string
  created_at: number
  updated_at: number
}

export interface ForeshadowRow {
  id: string
  project_id: string
  description: string
  category: string
  status: string
  first_chapter: number | null
  last_chapter: number | null
  recover_by_chapter: number | null
  plant_method: string | null
  recover_method: string | null
  chapter_spans: string | null
  beats: string | null
  created_at: number
  updated_at: number
}

export interface ClueRow {
  id: string
  project_id: string
  description: string
  points_to: string
  progress: number
  current_step: string
  next_step: string
  is_misleading: number
  chapter_spans: string | null
  created_at: number
  updated_at: number
}

export interface InfoLayerRow {
  id: string
  project_id: string
  info_description: string
  author_knows: number
  reader_knows: number
  character_knowledge: string
  reveal_stage: string | null
  reveal_chapter: number | null
  is_revealed: number
  created_at: number
  updated_at: number
}

// ── 世界规则 / 风格指南 / 写作风格档案 / 约束 / 世界要素 ──

export interface WorldRuleRow {
  id: string
  project_id: string
  category: string
  rule: string
  cost: string | null
  is_fixed: number
  created_at: number
  updated_at: number
}

export interface StyleGuideRow {
  id: string
  project_id: string
  category: string
  rule: string
  example: string | null
  created_at: number
  updated_at: number
}

export interface WritingStyleProfileRow {
  id: string
  project_id: string
  name: string
  preset: string
  narrative_person: string
  narrative_distance: string
  sentence_rhythm: string
  dialogue_ratio: number
  emotional_temperature: number
  imagery_density: number
  vocabulary_register: string
  hard_rules: string
  soft_rules: string
  positive_examples: string
  negative_examples: string
  notes: string
  style_experts: string
  version: number
  created_at: number
  updated_at: number
}

export interface StyleExpertRow {
  id: string
  project_id: string
  name: string
  source_title: string
  source_author: string | null
  description: string
  distilled_prompt: string
  metrics_json: string | null
  techniques_json: string | null
  exclusions_json: string | null
  exemplars_json: string | null
  /** 迁移 118：语言指纹（六项） */
  expression_dna_json: string | null
  /** 迁移 118：内在张力（含取舍原则） */
  tensions_json: string | null
  /** 迁移 118：该文风明确避免的写法 */
  anti_patterns_json: string | null
  /** 迁移 118：这套能力覆盖不到的场景 */
  boundaries_json: string | null
  custom_prompt: string | null
  enabled: number
  sort_order: number
  distill_meta: string | null
  version: number
  created_at: number
  updated_at: number
}

export interface ConstraintRow {
  id: string
  project_id: string
  type: string
  scope: string
  rule: string
  is_active: number
  related_entity_id: string | null
  created_at: number
  updated_at: number
}

export interface WorldElementRow {
  id: string
  project_id: string
  category: string
  name: string
  description: string
  parent_id: string | null
  attributes: string
  created_at: number
  updated_at: number
}

// ── 势力 / 地点 ──

export interface FactionRow {
  id: string
  project_id: string
  name: string
  description: string
  type: string
  leader_id: string | null
  ideology: string
  strength: string
  resources: string
  allies: string
  enemies: string
  status: string
  chapter_spans: string | null
  created_at: number
  updated_at: number
}

export interface LocationRow {
  id: string
  project_id: string
  name: string
  description: string
  type: string
  parent_id: string | null
  faction_id: string | null
  significance: string
  first_chapter: number | null
  status: string
  appear_chapters: string
  created_at: number
  updated_at: number
}

export interface ItemRow {
  id: string
  project_id: string
  name: string
  description: string
  type: string
  owner_id: string | null
  status: string
  abilities: string
  origin: string
  first_chapter: number | null
  chapter_spans: string
  created_at: number
  updated_at: number
}

// ── 图相关：节点位置 / 标记 / 边 ──

export interface NodePositionRow {
  id: string
  project_id: string
  node_type: string
  entity_id: string
  pos_x: number
  pos_y: number
  updated_at: number
}

export interface MarkerRow {
  id: string
  project_id: string
  chapter: number
  title: string
  note: string
  type: string
  color: string
  entity_type: string | null
  entity_id: string | null
  created_at: number
  updated_at: number
}

export interface EdgeRow {
  id: string
  project_id: string
  source_id: string
  source_type: string
  target_id: string
  target_type: string
  edge_type: string
  label: string
  auto: number
  created_at: number
  updated_at: number
}

// ── Review / AgentLog / AuthorIntent ──

export interface AuthorIntentRow {
  id: string
  project_id: string
  chapter_id: string | null
  intent_type: string
  description: string
  target_entity_id: string | null
  created_at: number
}

export interface ChapterReviewRow {
  id: string
  project_id: string
  chapter_id: string
  content_revision_id: string | null
  content_hash: string
  consistency_score: number | null
  character_score: number | null
  task_completion_score: number | null
  clue_progress_score: number | null
  foreshadow_status_score: number | null
  conflict_change_score: number | null
  pacing_score: number | null
  info_control_score: number | null
  reader_hook_score: number | null
  style_score: number | null
  overall_score: number | null
  verdict: string | null
  issues: string | null
  suggestions: string | null
  reviewed_by: string | null
  created_at: number
}

export interface AgentLogRow {
  id: string
  project_id: string
  chapter_number: number
  agent_type: string
  agent_name: string
  display_agent_type: string
  display_agent_name: string
  phase: string
  system_prompt: string
  chapter_context: string
  user_message: string
  task_input: string
  user_instructions: string
  tools: string
  tool_names: string
  result: string
  result_length: number
  duration_ms: number
  status: string
  error: string
  session_id: string
  parent_log_id: string | null
  operation: string | null
  created_at: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  llm_provider: string
  llm_model: string
  /** 真正发往 provider 的 payload 体积（迁移 077 新增，旧行为 0） */
  payload_messages_chars: number | null
  payload_tools_chars: number | null
  payload_tool_count: number | null
  payload_total_chars: number | null
  /** 一次 Agent 调用内部的 LLM 往返次数（工具调用会导致多次） */
  llm_round_trips: number | null
  /** 078: per-run normalized novel_ask_story policy; legacy for pre-078 rows. */
  ask_story_policy: string | null
  /** 078: 1 when this invocation may use novel_ask_story; true for pre-078 rows. */
  ask_story_enabled: number | null
  /** 087: 大文本外置时的 payload 主键（NULL = 全量存主表） */
  payload_id: string | null
  /** 100: 稳定缓存域（如 novel:proj-1:10），OpenAI 路由用作 prompt_cache_key */
  cache_key: string | null
  /** 100: anthropic-cache-control | openai-prompt-cache-key | automatic-prefix | unknown */
  cache_protocol: string | null
  /** 100: 分层内容 sha256 摘要（16 hex），诊断前缀漂移，不存原文 */
  request_fingerprint: string | null
  /** 100: system+shared+identity 字符数（覆盖率先行条件） */
  cacheable_prefix_chars: number | null
  /** 100: complete | partial | no_data（区分未命中与未上报） */
  data_quality: string | null
  /** 100: llm-error-policy 归一化错误码 */
  error_code: string | null
}
