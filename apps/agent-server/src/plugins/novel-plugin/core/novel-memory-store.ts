/**
 * NovelMemoryStore：小说系统长期记忆分层存储
 *
 * 在"当前状态"存储（novel_characters / novel_chapters / novel_conflicts 等）
 * 之上提供 3 层记忆能力：
 *
 * 1. 工作记忆（Working）：当前章节生成期间的临时上下文（已在 prompt-builder 中实现）
 * 2. 情景记忆（Episodic）：按章节存储的事件/状态快照（本 Store 实现）
 * 3. 语义记忆（Semantic）：跨章节的实体关系和因果链（本 Store 实现）
 *
 * 提供能力：
 * - 跨章节的伏笔状态追踪（从埋设到回收的完整生命周期）
 * - 冲突演化时间线（从潜伏到解决的阶段变化）
 * - 章节间因果关系（事件 A 导致事件 B）
 * - 时间线查询（"第 N 章时所有角色的状态快照"）
 *
 * 行映射遵循 snake_case（SQLite）→ camelCase（TypeScript）。
 */

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  ChapterStoryContext,
  ChangeValueType,
  NovelAnnotation,
  NovelAnnotationKind,
  NovelAnnotationScope,
  NovelChangeRecord,
  NovelStoryEntityType,
  NovelStoryEvent,
  PromptDimensionContext,
  StoryEventEntityRef,
  StoryEventEntityRole,
  StoryEventSource,
  StoryEventStatus,
  StoryEventType,
} from '@repo/shared/novel'
import { buildPromptDimensionContext } from './story-dimension-semantics.js'

/** 记忆事件类型 */
export type MemoryEventType =
  | 'character_change'
  | 'conflict_change'
  | 'foreshadow_change'
  | 'clue_change'
  | 'faction_change'
  | 'location_change'
  | 'relationship_change'
  | 'info_layer_change'
  | 'item_change'
  | 'plot_event'
  | 'world_change'

/** 实体类型 */
export type MemoryEntityType =
  | 'character'
  | 'conflict'
  | 'foreshadow'
  | 'clue'
  | 'faction'
  | 'location'
  | 'relationship'
  | 'info_layer'
  | 'item'
  | 'chapter'
  | 'world_element'
  | 'world_rule'

/** 快照类型 */
export type MemorySnapshotType = 'character' | 'conflict' | 'foreshadow' | 'full'

/** 记忆事件 */
export interface MemoryEvent {
  id: string
  projectId: string
  chapterId: string | null
  chapterNumber: number
  eventType: MemoryEventType
  entityId: string
  entityType: MemoryEntityType
  description: string
  oldValue: string | null  // JSON
  newValue: string | null   // JSON
  cause: string | null      // 导致此事件的事件 ID 或描述
  effectIds: string[]       // 此事件导致的事件 ID 列表
  significance: number      // 1-10
  storyEventId?: string | null
  sceneOrder?: number
  dimension?: string | null
  targetEntityType?: MemoryEntityType | null
  targetEntityId?: string | null
  valueType?: ChangeValueType | null
  source?: StoryEventSource
  /** 文风提示：该变化的写作风格建议。prompt-builder 读取后附加到写作提示。 */
  styleNote?: string | null
  /** T02-6 AI 确认队列状态：confirmed（默认）/ pending / rejected（驳回，消费查询排除） */
  status?: 'confirmed' | 'pending' | 'rejected'
  /** 确认/驳回时间戳 */
  confirmedAt?: number | null
  createdAt: number
}

/** 记忆快照 */
export interface MemorySnapshot {
  id: string
  projectId: string
  chapterNumber: number
  snapshotType: MemorySnapshotType
  entityId: string | null
  snapshotData: string  // JSON
  createdAt: number
}

/** listEvents 查询选项 */
export interface ListEventsOptions {
  chapterNumber?: number
  entityType?: MemoryEntityType
  entityId?: string
  eventType?: MemoryEventType
  minSignificance?: number
  limit?: number
}

/** listSnapshots 查询选项 */
export interface ListSnapshotsOptions {
  chapterNumber?: number
  snapshotType?: MemorySnapshotType
}

/** getSnapshot 查询选项 */
export interface GetSnapshotOptions {
  snapshotType?: MemorySnapshotType
  entityId?: string
}

export type CreateStoryEventInput = Omit<NovelStoryEvent, 'id' | 'createdAt' | 'updatedAt'>
export type CreateStoryEventEntityRefInput = Omit<StoryEventEntityRef, 'id' | 'eventId'>
export type CreateChangeRecordInput = Omit<NovelChangeRecord, 'id' | 'createdAt'>
export type CreateEventChangeInput = Omit<
  NovelChangeRecord,
  'id' | 'projectId' | 'storyEventId' | 'chapterNumber' | 'sceneOrder' | 'cause' | 'effectIds' | 'createdAt'
> & { cause?: string | null; effectIds?: string[] }
export type CreateAnnotationInput = Omit<NovelAnnotation, 'id' | 'createdAt' | 'updatedAt'>

export interface CreateStoryEventWithChangesInput {
  event: CreateStoryEventInput
  entityRefs: CreateStoryEventEntityRefInput[]
  changes: CreateEventChangeInput[]
}

export interface ListStoryEventsOptions {
  chapterNumber?: number
  chapterStart?: number
  chapterEnd?: number
  status?: StoryEventStatus
  source?: StoryEventSource
  entityType?: NovelStoryEntityType
  entityId?: string
}

export interface ListChangeRecordsOptions {
  storyEventId?: string
  chapterNumber?: number
  beforeChapter?: number
  afterChapter?: number
  subjectType?: NovelStoryEntityType
  subjectId?: string
  dimension?: string
  /** T02-6 确认队列：pending = 待确认（未确认/未驳回）；confirmed = 已确认 */
  status?: 'pending' | 'confirmed' | 'rejected'
}

export interface ListAnnotationsOptions {
  chapterNumber?: number
  scopeType?: NovelAnnotationScope
  scopeId?: string
  entityType?: NovelStoryEntityType
  entityId?: string
  kind?: NovelAnnotationKind
  resolved?: boolean
  includeInPrompt?: boolean
}

// ── 行类型（SQLite snake_case → TypeScript camelCase 映射）──

interface MemoryEventRow {
  id: string
  project_id: string
  chapter_id: string | null
  chapter_number: number
  event_type: string
  entity_id: string
  entity_type: string
  description: string
  old_value: string | null
  new_value: string | null
  cause: string | null
  effect_ids: string | null
  significance: number
  story_event_id: string | null
  scene_order: number
  dimension: string | null
  target_entity_type: string | null
  target_entity_id: string | null
  value_type: string | null
  source: string
  style_note: string | null
  status: string
  confirmed_at: number | null
  created_at: number
}

interface StoryEventRow {
  id: string
  project_id: string
  chapter_number: number
  scene_id: string | null
  scene_order: number
  type: string
  title: string
  summary: string
  outcome: string
  status: string
  parent_event_id: string | null
  source: string
  created_at: number
  updated_at: number
}

interface StoryEventEntityRow {
  id: string
  event_id: string
  entity_type: string
  entity_id: string
  role: string
  note: string
}

interface AnnotationRow {
  id: string
  project_id: string
  scope_type: string
  scope_id: string | null
  entity_type: string | null
  entity_id: string | null
  chapter_start: number | null
  chapter_end: number | null
  kind: string
  content: string
  color: string
  include_in_prompt: number
  resolved: number
  created_at: number
  updated_at: number
}

interface MemorySnapshotRow {
  id: string
  project_id: string
  chapter_number: number
  snapshot_type: string
  entity_id: string | null
  snapshot_data: string
  created_at: number
}

// ── 工具函数 ──

function now(): number {
  return Math.floor(Date.now() / 1000)
}

function parseEffectIds(s: string | null): string[] {
  if (!s) return []
  try {
    const parsed = JSON.parse(s)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function serializeValue(value: unknown): string | null {
  if (value === undefined) return null
  return JSON.stringify(value)
}

function parseValue(value: string | null): unknown {
  if (value == null) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function stateKey(change: Pick<NovelChangeRecord, 'subjectType' | 'subjectId' | 'dimension' | 'targetType' | 'targetId'>): string {
  return `${change.subjectType}:${change.subjectId}|${change.dimension}|${change.targetType ?? ''}:${change.targetId ?? ''}`
}

function eventTypeForEntity(entityType: NovelStoryEntityType): MemoryEventType {
  switch (entityType) {
    case 'character': return 'character_change'
    case 'relationship': return 'relationship_change'
    case 'conflict': return 'conflict_change'
    case 'foreshadow': return 'foreshadow_change'
    case 'clue': return 'clue_change'
    case 'faction': return 'faction_change'
    case 'location': return 'location_change'
    case 'info_layer': return 'info_layer_change'
    case 'item': return 'item_change'
    case 'world_element':
    case 'world_rule': return 'world_change'
    case 'chapter': return 'plot_event'
  }
}

// ═══════════════════════════════════════════════════════════════
// dimension 集中推断（让 recordEvent 写入的事件也能被 listChangeRecords 查到）
// ═══════════════════════════════════════════════════════════════

/**
 * dimension 推断规则。按 eventType 分组，每组内按顺序匹配。
 *
 * - `matchFields` 非空：newValue 含任一字段即匹配（变更事件）
 * - `matchFields` 为空：作为 fallback（如 faction_change 的 activity）
 * - `isCreate: true`：仅当 oldValue 为 null（创建事件）且 matchFields 全部都在 newValue 中时匹配
 *
 * 规则基于 chapter-finalizer.ts 实际写入的 newValue 字段名，确保 AI 自动写入的事件
 * 也能拿到 dimension，从而穿过 listChangeRecords 的 `dimension IS NOT NULL` 过滤。
 */
interface DimensionRule {
  dimension: string
  valueType: ChangeValueType
  matchFields: string[]
  isCreate?: boolean
}

const DIMENSION_RULES: Record<MemoryEventType, DimensionRule[]> = {
  character_change: [
    { dimension: 'character.arc_stage', valueType: 'enum', matchFields: ['arcStage'] },
    { dimension: 'character.goal', valueType: 'text', matchFields: ['currentGoal'] },
    { dimension: 'character.pressure', valueType: 'level', matchFields: ['currentPressure'] },
    { dimension: 'character.state', valueType: 'text', matchFields: ['currentState'] },
    { dimension: 'character.cognition', valueType: 'text', matchFields: ['secret', 'longTermDesire'] },
    { dimension: 'character.conflict_link', valueType: 'set', matchFields: ['participatingConflicts'] },
    { dimension: 'character.created', valueType: 'reference', matchFields: ['name'], isCreate: true },
  ],
  conflict_change: [
    { dimension: 'conflict.stage', valueType: 'enum', matchFields: ['stage'] },
    { dimension: 'conflict.intensity', valueType: 'level', matchFields: ['intensity'] },
    { dimension: 'conflict.plot_function', valueType: 'enum', matchFields: ['plotFunction'] },
    { dimension: 'conflict.progression_mode', valueType: 'enum', matchFields: ['progressionMode'] },
    {
      dimension: 'conflict.created',
      valueType: 'reference',
      matchFields: ['stage', 'intensity', 'plotFunction', 'progressionMode'],
      isCreate: true,
    },
  ],
  foreshadow_change: [
    { dimension: 'foreshadow.beat', valueType: 'enum', matchFields: ['status'] },
    { dimension: 'foreshadow.payoff_chapter', valueType: 'number', matchFields: ['lastChapter'] },
    { dimension: 'foreshadow.plant_method', valueType: 'text', matchFields: ['plantMethod'] },
    { dimension: 'foreshadow.recover_method', valueType: 'text', matchFields: ['recoverMethod'] },
    {
      dimension: 'foreshadow.created',
      valueType: 'reference',
      matchFields: ['status', 'plantMethod', 'recoverMethod'],
      isCreate: true,
    },
  ],
  clue_change: [
    { dimension: 'clue.progress', valueType: 'number', matchFields: ['progress'] },
    { dimension: 'clue.step', valueType: 'text', matchFields: ['currentStep', 'nextStep'] },
    { dimension: 'clue.points_to', valueType: 'text', matchFields: ['pointsTo'] },
    { dimension: 'clue.misleading', valueType: 'enum', matchFields: ['isMisleading'] },
    {
      dimension: 'clue.created',
      valueType: 'reference',
      matchFields: ['pointsTo', 'progress', 'currentStep', 'nextStep', 'isMisleading'],
      isCreate: true,
    },
  ],
  faction_change: [
    { dimension: 'faction.status', valueType: 'enum', matchFields: ['status'] },
    { dimension: 'faction.strength', valueType: 'level', matchFields: ['strength'] },
    { dimension: 'faction.activity', valueType: 'text', matchFields: [] },
    { dimension: 'faction.created', valueType: 'reference', matchFields: ['name', 'status', 'strength'], isCreate: true },
  ],
  location_change: [
    { dimension: 'location.status', valueType: 'enum', matchFields: ['status'] },
    { dimension: 'location.appear', valueType: 'set', matchFields: ['appearChapters'] },
    { dimension: 'location.created', valueType: 'reference', matchFields: ['name', 'status'], isCreate: true },
  ],
  relationship_change: [
    { dimension: 'relationship.stage', valueType: 'enum', matchFields: ['currentStage'] },
    { dimension: 'relationship.role', valueType: 'text', matchFields: ['dynamicRole'] },
    { dimension: 'relationship.alignment', valueType: 'enum', matchFields: ['alignment'] },
    { dimension: 'relationship.trend', valueType: 'enum', matchFields: ['trend'] },
    { dimension: 'relationship.hint', valueType: 'text', matchFields: ['chapterHint'] },
    { dimension: 'relationship.updated', valueType: 'number', matchFields: ['lastUpdatedChapter'] },
    {
      dimension: 'relationship.created',
      valueType: 'reference',
      matchFields: ['relationType', 'currentStage', 'alignment', 'trend'],
      isCreate: true,
    },
  ],
  info_layer_change: [
    { dimension: 'info_layer.reader_knows', valueType: 'enum', matchFields: ['readerKnows'] },
    { dimension: 'info_layer.revealed', valueType: 'enum', matchFields: ['isRevealed'] },
    { dimension: 'info_layer.links', valueType: 'set', matchFields: ['linkedForeshadows'] },
    { dimension: 'info_layer.reveal_chapter', valueType: 'number', matchFields: ['revealChapter'] },
    {
      dimension: 'info_layer.created',
      valueType: 'reference',
      matchFields: ['readerKnows', 'isRevealed'],
      isCreate: true,
    },
  ],
  item_change: [
    { dimension: 'item.holder', valueType: 'reference', matchFields: ['holder'] },
    { dimension: 'item.status', valueType: 'enum', matchFields: ['status'] },
    { dimension: 'item.function', valueType: 'enum', matchFields: ['function'] },
    { dimension: 'item.appear', valueType: 'set', matchFields: ['appearChapters'] },
    { dimension: 'item.created', valueType: 'reference', matchFields: ['name', 'holder', 'status'], isCreate: true },
  ],
  plot_event: [],
  world_change: [
    { dimension: 'world_element.created', valueType: 'reference', matchFields: ['name', 'category'], isCreate: true },
  ],
}

/**
 * 推断记忆事件的 dimension 和 value_type。
 *
 * 在 recordEvent 内部调用，让 AI 自动写入的事件也带上 dimension，
 * 使其能穿过 listChangeRecords 的 `dimension IS NOT NULL` 过滤。
 *
 * 匹配顺序：创建规则（isCreate）→ 具体字段规则 → fallback 规则。
 * 无法匹配时返回 null（保持旧行为）。
 *
 * 独立纯函数，便于单测。
 */
export function inferDimension(
  eventType: MemoryEventType,
  newValue: string | null,
  oldValue: string | null = null,
): { dimension: string | null; valueType: ChangeValueType | null } {
  if (!newValue) return { dimension: null, valueType: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(newValue)
  } catch {
    return { dimension: null, valueType: null }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { dimension: null, valueType: null }
  }
  const keys = Object.keys(parsed as Record<string, unknown>)
  if (keys.length === 0) return { dimension: null, valueType: null }

  const rules = DIMENSION_RULES[eventType]
  if (!rules || rules.length === 0) return { dimension: null, valueType: null }

  const isCreate = oldValue === null
  const keysSet = new Set(keys)

  // 1. 创建事件优先匹配 isCreate 规则（matchFields 全部都在）
  if (isCreate) {
    for (const rule of rules) {
      if (!rule.isCreate) continue
      if (rule.matchFields.length > 0 && rule.matchFields.every((f) => keysSet.has(f))) {
        return { dimension: rule.dimension, valueType: rule.valueType }
      }
    }
  }

  // 2. 具体字段规则（matchFields 非空，任一字段命中）
  for (const rule of rules) {
    if (rule.isCreate) continue
    if (rule.matchFields.length === 0) continue
    if (rule.matchFields.some((f) => keysSet.has(f))) {
      return { dimension: rule.dimension, valueType: rule.valueType }
    }
  }

  // 3. fallback 规则（matchFields 为空）
  for (const rule of rules) {
    if (rule.isCreate) continue
    if (rule.matchFields.length === 0) {
      return { dimension: rule.dimension, valueType: rule.valueType }
    }
  }

  return { dimension: null, valueType: null }
}

export class NovelMemoryStore {
  constructor(private db: Database.Database) {}

  /** T05 停旧写：项目是否开启 legacyNarrativeWriteDisabled（sceneId/sceneOrder 不再重复写入） */
  private isLegacyNarrativeWriteDisabled(projectId: string): boolean {
    try {
      const row = this.db.prepare(
        'SELECT feature_flags FROM novel_projects WHERE id = ?',
      ).get(projectId) as { feature_flags: string } | undefined
      if (!row?.feature_flags) return false
      const flags = JSON.parse(row.feature_flags) as Record<string, boolean>
      return flags.legacyNarrativeWriteDisabled === true
    } catch {
      return false
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 事件记录（情景记忆 + 因果链）
  // ═══════════════════════════════════════════════════════════════

  /** 记录记忆事件 */
  recordEvent(event: Omit<MemoryEvent, 'id' | 'createdAt'>): MemoryEvent {
    // 集中推断 dimension + value_type：让 AI 自动写入的事件也能被 listChangeRecords
    // （含 `dimension IS NOT NULL` 过滤）查到。无法推断时保持 NULL（旧行为）。
    // 若调用方已显式传入 dimension，则尊重调用方，不覆盖。
    const inferred = event.dimension
      ? { dimension: event.dimension, valueType: event.valueType ?? null }
      : inferDimension(event.eventType, event.newValue, event.oldValue)
    const full: MemoryEvent = {
      ...event,
      dimension: event.dimension ?? inferred.dimension,
      valueType: event.valueType ?? inferred.valueType,
      id: randomUUID(),
      createdAt: now(),
    }
    this.db.prepare(`
      INSERT INTO novel_memory_events
      (id, project_id, chapter_id, chapter_number, event_type, entity_id, entity_type,
       description, old_value, new_value, cause, effect_ids, significance,
       dimension, value_type, source, style_note, status, created_at)
      VALUES (@id, @project_id, @chapter_id, @chapter_number, @event_type, @entity_id, @entity_type,
              @description, @old_value, @new_value, @cause, @effect_ids, @significance,
              @dimension, @value_type, @source, @style_note, @status, @created_at)
    `).run({
      id: full.id,
      project_id: full.projectId,
      chapter_id: full.chapterId,
      chapter_number: full.chapterNumber,
      event_type: full.eventType,
      entity_id: full.entityId,
      entity_type: full.entityType,
      description: full.description,
      old_value: full.oldValue,
      new_value: full.newValue,
      cause: full.cause,
      effect_ids: JSON.stringify(full.effectIds),
      significance: full.significance,
      dimension: full.dimension ?? null,
      value_type: full.valueType ?? null,
      // AI 自动写入的事件标记为 ai-extracted（schema 默认 'migration' 不符合实时写入语义）
      source: full.source ?? 'ai-extracted',
      style_note: full.styleNote ?? null,
      // T02-6：AI 自动写入的 change record 标记 pending（随事件待确认）；手动写入 confirmed
      status: (full.source === 'ai-extracted' || full.source === 'ai-planned') ? 'pending' : 'confirmed',
      created_at: full.createdAt,
    })
    return full
  }

  /**
   * 回填历史记忆事件的 dimension + value_type。
   *
   * 设计文档第 5 节"一次性回填迁移"：
   * - 遍历 `novel_memory_events` 中 `dimension IS NULL` 的行
   * - 复用 inferDimension 规则推断
   * - 幂等：已填 dimension 的行跳过；无法推断的保持 NULL
   * - dry-run 模式只统计不写入
   * - 非 dry-run 模式在写入前自动备份（CREATE TABLE ... AS SELECT）
   *
   * 在 plugin setup 中自动调用（幂等安全：已回填的项目返回 scanned=0）。
   */
  backfillMissingDimensions(options?: { dryRun?: boolean; backup?: boolean }): {
    scanned: number
    updated: number
    skipped: number
    uninferable: number
    backupTable?: string
  } {
    const dryRun = options?.dryRun ?? false
    const wantBackup = options?.backup ?? true

    // 1. 扫描待回填行（dimension IS NULL）
    const rows = this.db.prepare(`
      SELECT id, event_type, old_value, new_value
      FROM novel_memory_events
      WHERE dimension IS NULL
      ORDER BY created_at ASC
    `).all() as { id: string; event_type: string; old_value: string | null; new_value: string | null }[]

    if (rows.length === 0) {
      return { scanned: 0, updated: 0, skipped: 0, uninferable: 0 }
    }

    // 2. 逐行推断（纯函数，不触发 DB 写）
    const updates: Array<{ id: string; dimension: string; valueType: ChangeValueType }> = []
    let uninferable = 0
    for (const row of rows) {
      const inferred = inferDimension(
        row.event_type as MemoryEventType,
        row.new_value,
        row.old_value,
      )
      if (inferred.dimension && inferred.valueType) {
        updates.push({
          id: row.id,
          dimension: inferred.dimension,
          valueType: inferred.valueType,
        })
      } else {
        uninferable++
      }
    }

    if (dryRun) {
      return {
        scanned: rows.length,
        updated: 0,
        skipped: 0,
        uninferable,
      }
    }

    // 3. 备份（非 dry-run 且有更新）
    let backupTable: string | undefined
    if (wantBackup && updates.length > 0) {
      // SQLite 的 ? 占位符不能用于表名，用字符串拼接。
      // 表名格式固定为 novel_memory_events_backup_{timestamp}，只含字母数字下划线，安全。
      backupTable = `novel_memory_events_backup_${Math.floor(Date.now() / 1000)}`
      if (!/^[a-z0-9_]+$/i.test(backupTable)) {
        throw new Error(`Invalid backup table name: ${backupTable}`)
      }
      this.db.exec(`CREATE TABLE ${backupTable} AS SELECT * FROM novel_memory_events`)
    }

    // 4. 事务性批量回填
    const updateStmt = this.db.prepare(`
      UPDATE novel_memory_events
      SET dimension = ?, value_type = ?
      WHERE id = ? AND dimension IS NULL
    `)
    const transaction = this.db.transaction((items: typeof updates) => {
      let updated = 0
      for (const item of items) {
        const result = updateStmt.run(item.dimension, item.valueType, item.id)
        updated += result.changes
      }
      return updated
    })
    const updated = transaction(updates)

    return {
      scanned: rows.length,
      updated,
      skipped: rows.length - updated - uninferable,
      uninferable,
      backupTable,
    }
  }

  /** 查询项目所有记忆事件 */
  listEvents(projectId: string, options?: ListEventsOptions): MemoryEvent[] {
    // 构建 WHERE 子句
    const conditions = ['project_id = ?']
    const params: unknown[] = [projectId]
    if (options?.chapterNumber !== undefined) {
      conditions.push('chapter_number = ?')
      params.push(options.chapterNumber)
    }
    if (options?.entityType) {
      conditions.push('entity_type = ?')
      params.push(options.entityType)
    }
    if (options?.entityId) {
      conditions.push('entity_id = ?')
      params.push(options.entityId)
    }
    if (options?.eventType) {
      conditions.push('event_type = ?')
      params.push(options.eventType)
    }
    if (options?.minSignificance !== undefined) {
      conditions.push('significance >= ?')
      params.push(options.minSignificance)
    }
    const limit = options?.limit ?? 100
    const sql = `SELECT * FROM novel_memory_events WHERE ${conditions.join(' AND ')} ORDER BY chapter_number ASC, created_at ASC LIMIT ?`
    const rows = this.db.prepare(sql).all(...params, limit) as MemoryEventRow[]
    return rows.map((r) => this.rowToEvent(r))
  }

  /** 获取实体的事件历史（时间线） */
  getEntityTimeline(projectId: string, entityId: string): MemoryEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM novel_memory_events WHERE project_id = ? AND entity_id = ? ORDER BY chapter_number ASC, created_at ASC')
      .all(projectId, entityId) as MemoryEventRow[]
    return rows.map((r) => this.rowToEvent(r))
  }

  /** 获取因果关系链（向上追溯原因 + 向下追溯影响） */
  getCausalChain(eventId: string): { causes: MemoryEvent[]; effects: MemoryEvent[] } {
    const event = this.db
      .prepare('SELECT * FROM novel_memory_events WHERE id = ?')
      .get(eventId) as MemoryEventRow | undefined
    if (!event) return { causes: [], effects: [] }

    // 向上追溯原因（链式，防止循环引用导致死循环）
    const causes: MemoryEvent[] = []
    const visited = new Set<string>([event.id])
    let currentCauseId = event.cause
    while (currentCauseId) {
      if (visited.has(currentCauseId)) break
      visited.add(currentCauseId)
      const causeRow = this.db
        .prepare('SELECT * FROM novel_memory_events WHERE id = ?')
        .get(currentCauseId) as MemoryEventRow | undefined
      if (!causeRow) break
      causes.push(this.rowToEvent(causeRow))
      currentCauseId = causeRow.cause
    }

    // 向下追溯影响（BFS 递归，遍历所有 effect_ids 子树）
    const effects: MemoryEvent[] = []
    const queue: string[] = parseEffectIds(event.effect_ids)
    while (queue.length > 0) {
      const effectId = queue.shift()!
      if (visited.has(effectId)) continue
      visited.add(effectId)
      const effectRow = this.db
        .prepare('SELECT * FROM novel_memory_events WHERE id = ?')
        .get(effectId) as MemoryEventRow | undefined
      if (!effectRow) continue
      effects.push(this.rowToEvent(effectRow))
      // 把当前事件的下游继续入队，实现递归展开
      const childEffectIds = parseEffectIds(effectRow.effect_ids)
      for (const childId of childEffectIds) {
        if (!visited.has(childId)) queue.push(childId)
      }
    }

    return { causes: causes.reverse(), effects }
  }

  /**
   * 事后追加因果关系边：把 causeId 标记为 eventId 的上游原因
   * 同时在 causeId 的 effect_ids 数组里追加 eventId（双向维护）
   */
  linkCause(eventId: string, causeId: string): void {
    const event = this.db
      .prepare('SELECT * FROM novel_memory_events WHERE id = ?')
      .get(eventId) as MemoryEventRow | undefined
    if (!event) return
    // 已有 cause 则不覆盖（保留首次写入的因果）
    if (event.cause) return
    this.db.prepare('UPDATE novel_memory_events SET cause = ? WHERE id = ?').run(causeId, eventId)
    // 反向维护 causeId 的 effect_ids
    const causeEvent = this.db
      .prepare('SELECT * FROM novel_memory_events WHERE id = ?')
      .get(causeId) as MemoryEventRow | undefined
    if (causeEvent) {
      const existing = parseEffectIds(causeEvent.effect_ids)
      if (!existing.includes(eventId)) {
        existing.push(eventId)
        this.db
          .prepare('UPDATE novel_memory_events SET effect_ids = ? WHERE id = ?')
          .run(JSON.stringify(existing), causeId)
      }
    }
  }

  /**
   * 事后追加因果关系边：把 effectId 标记为 eventId 的下游影响
   * 同时在 effectId 的 cause 字段回填 eventId（双向维护）
   */
  linkEffect(eventId: string, effectId: string): void {
    const event = this.db
      .prepare('SELECT * FROM novel_memory_events WHERE id = ?')
      .get(eventId) as MemoryEventRow | undefined
    if (!event) return
    const existing = parseEffectIds(event.effect_ids)
    if (!existing.includes(effectId)) {
      existing.push(effectId)
      this.db
        .prepare('UPDATE novel_memory_events SET effect_ids = ? WHERE id = ?')
        .run(JSON.stringify(existing), eventId)
    }
    // 反向维护 effectId 的 cause（不覆盖已有值）
    const effectEvent = this.db
      .prepare('SELECT * FROM novel_memory_events WHERE id = ?')
      .get(effectId) as MemoryEventRow | undefined
    if (effectEvent && !effectEvent.cause) {
      this.db.prepare('UPDATE novel_memory_events SET cause = ? WHERE id = ?').run(eventId, effectId)
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 故事事件账本（事件 + 原子变化 + 批注）
  // ═══════════════════════════════════════════════════════════════

  createStoryEvent(input: CreateStoryEventInput): NovelStoryEvent {
    const timestamp = now()
    const event: NovelStoryEvent = {
      ...input,
      id: randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    // T05 停旧写（legacyNarrativeWriteDisabled）：V2 迁移后 sceneId/sceneOrder 由
    // scene_revision 派生，不再重复写入事件表。flag 按项目灰度，默认关闭。
    // 直接修改 event 本体，保证返回值与落库一致（调用方不会看到"已写但读不到"）。
    if (this.isLegacyNarrativeWriteDisabled(event.projectId)) {
      event.sceneId = null
      event.sceneOrder = 0
    }
    this.db.prepare(`
      INSERT INTO novel_story_events
        (id, project_id, chapter_number, scene_id, scene_order, type, title, summary,
         outcome, status, parent_event_id, source, created_at, updated_at)
      VALUES
        (@id, @project_id, @chapter_number, @scene_id, @scene_order, @type, @title, @summary,
         @outcome, @status, @parent_event_id, @source, @created_at, @updated_at)
    `).run({
      id: event.id,
      project_id: event.projectId,
      chapter_number: event.chapterNumber,
      scene_id: event.sceneId,
      scene_order: event.sceneOrder,
      type: event.type,
      title: event.title,
      summary: event.summary,
      outcome: event.outcome,
      status: event.status,
      parent_event_id: event.parentEventId,
      source: event.source,
      created_at: event.createdAt,
      updated_at: event.updatedAt,
    })
    return event
  }

  getStoryEvent(eventId: string): NovelStoryEvent | undefined {
    const row = this.db.prepare('SELECT * FROM novel_story_events WHERE id = ?').get(eventId) as StoryEventRow | undefined
    return row ? this.rowToStoryEvent(row) : undefined
  }

  /**
   * 最新事件 id（P4 §5.6 chunk versionKey 输入）。
   *
   * 单条 SQL，不构建实体对象——listStoryEvents 会全量映射 rowToStoryEvent，
   * 用来仅取一个 id 在每次 runAgent 都跑一遍代价过高。
   * 排序与 listStoryEvents 一致（chapter → scene_order → created_at），
   * 保证"最新"的口径不分叉。
   */
  getLatestStoryEventId(projectId: string): string | undefined {
    const row = this.db.prepare(`
      SELECT id FROM novel_story_events
      WHERE project_id = ?
      ORDER BY chapter_number DESC, scene_order DESC, created_at DESC
      LIMIT 1
    `).get(projectId) as { id: string } | undefined
    return row?.id
  }

  listStoryEvents(projectId: string, options?: ListStoryEventsOptions): NovelStoryEvent[] {
    const conditions = ['e.project_id = ?']
    const params: unknown[] = [projectId]
    if (options?.chapterNumber !== undefined) {
      conditions.push('e.chapter_number = ?')
      params.push(options.chapterNumber)
    }
    if (options?.chapterStart !== undefined) {
      conditions.push('e.chapter_number >= ?')
      params.push(options.chapterStart)
    }
    if (options?.chapterEnd !== undefined) {
      conditions.push('e.chapter_number <= ?')
      params.push(options.chapterEnd)
    }
    if (options?.status) {
      conditions.push('e.status = ?')
      params.push(options.status)
    }
    if (options?.source) {
      conditions.push('e.source = ?')
      params.push(options.source)
    }
    if (options?.entityType) {
      conditions.push(`EXISTS (
        SELECT 1 FROM novel_story_event_entities ref
        WHERE ref.event_id = e.id AND ref.entity_type = ?${options.entityId ? ' AND ref.entity_id = ?' : ''}
      )`)
      params.push(options.entityType)
      if (options.entityId) params.push(options.entityId)
    } else if (options?.entityId) {
      conditions.push('EXISTS (SELECT 1 FROM novel_story_event_entities ref WHERE ref.event_id = e.id AND ref.entity_id = ?)')
      params.push(options.entityId)
    }
    const rows = this.db.prepare(`
      SELECT e.* FROM novel_story_events e
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.chapter_number ASC, e.scene_order ASC, e.created_at ASC
    `).all(...params) as StoryEventRow[]
    return rows.map((row) => this.rowToStoryEvent(row))
  }

  listStoryEventEntityRefs(eventId: string): StoryEventEntityRef[] {
    const rows = this.db.prepare(`
      SELECT * FROM novel_story_event_entities WHERE event_id = ? ORDER BY rowid ASC
    `).all(eventId) as StoryEventEntityRow[]
    return rows.map((row) => this.rowToStoryEventEntityRef(row))
  }

  createStoryEventEntityRef(eventId: string, input: CreateStoryEventEntityRefInput): StoryEventEntityRef {
    const ref: StoryEventEntityRef = { ...input, id: randomUUID(), eventId }
    this.db.prepare(`
      INSERT INTO novel_story_event_entities (id, event_id, entity_type, entity_id, role, note)
      VALUES (@id, @event_id, @entity_type, @entity_id, @role, @note)
    `).run({
      id: ref.id,
      event_id: ref.eventId,
      entity_type: ref.entityType,
      entity_id: ref.entityId,
      role: ref.role,
      note: ref.note,
    })
    return ref
  }

  updateStoryEvent(
    eventId: string,
    patch: Partial<Pick<NovelStoryEvent, 'chapterNumber' | 'sceneId' | 'sceneOrder' | 'type' | 'title' | 'summary' | 'outcome' | 'status' | 'parentEventId' | 'source'>>,
  ): NovelStoryEvent | undefined {
    const existing = this.getStoryEvent(eventId)
    if (!existing) return undefined
    const updated: NovelStoryEvent = { ...existing, ...patch, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_story_events SET
        chapter_number=@chapter_number, scene_id=@scene_id, scene_order=@scene_order,
        type=@type, title=@title, summary=@summary, outcome=@outcome, status=@status,
        parent_event_id=@parent_event_id, source=@source, updated_at=@updated_at
      WHERE id=@id
    `).run({
      id: updated.id,
      chapter_number: updated.chapterNumber,
      scene_id: updated.sceneId,
      scene_order: updated.sceneOrder,
      type: updated.type,
      title: updated.title,
      summary: updated.summary,
      outcome: updated.outcome,
      status: updated.status,
      parent_event_id: updated.parentEventId,
      source: updated.source,
      updated_at: updated.updatedAt,
    })
    this.db.prepare(`
      UPDATE novel_memory_events SET chapter_number=?, scene_order=?
      WHERE story_event_id=?
    `).run(updated.chapterNumber, updated.sceneOrder, updated.id)
    return updated
  }

  deleteStoryEvent(eventId: string): boolean {
    const executeDelete = this.db.transaction((id: string) => {
      const result = this.db.prepare('DELETE FROM novel_memory_events WHERE story_event_id = ?').run(id)
      const eventResult = this.db.prepare('DELETE FROM novel_story_events WHERE id = ?').run(id)
      return eventResult.changes > 0 || result.changes > 0
    })
    return executeDelete(eventId)
  }

  // ── T02-6 AI 提取确认队列 ──

  /**
   * 事件参与关系边（按章节关系投影的数据源）：
   * 同一 StoryEvent 内的参与实体两两成边（如角色 A 与角色 B 同场出现），
   * 用于矩阵关系叠加层自动生成"事件派生边"（无需手动画线）。
   *
   * 为避免同事件多实体时 O(n²) 爆炸，每事件最多取 EDGE_MAX_REFS 个实体参与对。
   */
  listEventParticipationEdges(
    projectId: string,
    opts?: { chapterStart?: number; chapterEnd?: number; maxRefsPerEvent?: number },
  ): Array<{ eventId: string; chapterNumber: number; from: string; to: string }> {
    const maxRefs = opts?.maxRefsPerEvent ?? 8
    const chapterFilter: string[] = []
    const params: unknown[] = [projectId]
    if (opts?.chapterStart !== undefined) {
      chapterFilter.push('e.chapter_number >= ?')
      params.push(opts.chapterStart)
    }
    if (opts?.chapterEnd !== undefined) {
      chapterFilter.push('e.chapter_number <= ?')
      params.push(opts.chapterEnd)
    }
    const rows = this.db.prepare(`
      SELECT e.id AS event_id, e.chapter_number, r1.entity_id AS from_id, r2.entity_id AS to_id
      FROM novel_story_events e
      JOIN novel_story_event_entities r1 ON r1.event_id = e.id
      JOIN novel_story_event_entities r2 ON r2.event_id = e.id AND r2.entity_id > r1.entity_id
      WHERE e.project_id = ? ${chapterFilter.length > 0 ? `AND ${chapterFilter.join(' AND ')}` : ''}
      ORDER BY e.chapter_number ASC
    `).all(...params) as Array<{ event_id: string; chapter_number: number; from_id: string; to_id: string }>

    // 每事件去重 + 限制数量（按实体 ID 排序保证确定性）
    const byEvent = new Map<string, Array<{ event_id: string; chapter_number: number; from_id: string; to_id: string }>>()
    for (const row of rows) {
      const list = byEvent.get(row.event_id) ?? []
      list.push(row)
      byEvent.set(row.event_id, list)
    }
    const out: Array<{ eventId: string; chapterNumber: number; from: string; to: string }> = []
    for (const list of byEvent.values()) {
      // 按 from_id/to_id 排序取前 maxRefs（确定性 + 防超量）
      const sorted = list
        .sort((a, b) => (a.from_id + a.to_id).localeCompare(b.from_id + b.to_id))
        .slice(0, maxRefs)
      for (const r of sorted) {
        out.push({ eventId: r.event_id, chapterNumber: r.chapter_number, from: r.from_id, to: r.to_id })
      }
    }
    return out
  }

  /**
   * 待确认事件队列：AI 自动写入（ai-extracted / ai-planned）且尚未确认（planned）的
   * StoryEvent，连同其实体引用与关联 change record。驳回（superseded/rejected）项
   * 不进入队列，且 change record 已从消费查询（listChangeRecords）排除。
   */
  listPendingEvents(projectId: string): Array<{
    event: NovelStoryEvent
    entityRefs: StoryEventEntityRef[]
    changes: NovelChangeRecord[]
  }> {
    const events = this.listStoryEvents(projectId, {
      status: 'planned',
      source: 'ai-extracted',
    })
    // ai-planned 单独查一次，合并（listStoryEvents 的 source 过滤是单值）
    const planned = this.listStoryEvents(projectId, {
      status: 'planned',
      source: 'ai-planned',
    })
    const all = [...events, ...planned].filter(
      (e, i, arr) => arr.findIndex((x) => x.id === e.id) === i,
    )
    return all.map((event) => ({
      event,
      entityRefs: this.listStoryEventEntityRefs(event.id),
      changes: this.listChangeRecords(projectId, {
        storyEventId: event.id,
        status: 'pending',
      }),
    }))
  }

  /** 确认事件：事件 → confirmed；其 pending change record → confirmed */
  confirmEvent(eventId: string): boolean {
    const run = this.db.transaction((id: string) => {
      const ev = this.db.prepare('UPDATE novel_story_events SET status = ?, updated_at = ? WHERE id = ?')
        .run('confirmed', now(), id)
      this.db.prepare(
        "UPDATE novel_memory_events SET status = 'confirmed', confirmed_at = ? WHERE story_event_id = ? AND status = 'pending'",
      ).run(now(), id)
      return ev.changes > 0
    })
    return run(eventId)
  }

  /** 驳回事件：事件 → superseded（不参与承接）；其 change record → rejected（消费查询排除） */
  rejectEvent(eventId: string): boolean {
    const run = this.db.transaction((id: string) => {
      const ev = this.db.prepare('UPDATE novel_story_events SET status = ?, updated_at = ? WHERE id = ?')
        .run('superseded', now(), id)
      this.db.prepare(
        "UPDATE novel_memory_events SET status = 'rejected', confirmed_at = ? WHERE story_event_id = ?",
      ).run(now(), id)
      return ev.changes > 0
    })
    return run(eventId)
  }

  createChangeRecord(input: CreateChangeRecordInput): NovelChangeRecord {
    const record: NovelChangeRecord = { ...input, id: randomUUID(), createdAt: now() }
    this.db.prepare(`
      INSERT INTO novel_memory_events
        (id, project_id, chapter_id, chapter_number, event_type, entity_id, entity_type,
         description, old_value, new_value, cause, effect_ids, significance, story_event_id,
         scene_order, dimension, target_entity_type, target_entity_id, value_type, source, style_note, status, created_at)
      VALUES
        (@id, @project_id, NULL, @chapter_number, @event_type, @entity_id, @entity_type,
         @description, @old_value, @new_value, @cause, @effect_ids, @significance, @story_event_id,
         @scene_order, @dimension, @target_entity_type, @target_entity_id, @value_type, @source, @style_note, @status, @created_at)
    `).run({
      id: record.id,
      project_id: record.projectId,
      chapter_number: record.chapterNumber,
      event_type: eventTypeForEntity(record.subjectType),
      entity_id: record.subjectId,
      entity_type: record.subjectType,
      description: record.reason || record.dimension,
      old_value: serializeValue(record.beforeValue),
      new_value: serializeValue(record.afterValue),
      cause: record.cause,
      effect_ids: JSON.stringify(record.effectIds),
      significance: record.significance,
      story_event_id: record.storyEventId,
      scene_order: record.sceneOrder,
      dimension: record.dimension,
      target_entity_type: record.targetType,
      target_entity_id: record.targetId,
      value_type: record.valueType,
      source: record.source,
      style_note: record.styleNote ?? null,
      // T02-6：AI 自动写入的 change record 标记 pending（随事件待确认）；手动写入 confirmed
      status: (record.source === 'ai-extracted' || record.source === 'ai-planned') ? 'pending' : 'confirmed',
      created_at: record.createdAt,
    })
    return record
  }

  listChangeRecords(projectId: string, options?: ListChangeRecordsOptions): NovelChangeRecord[] {
    // 默认排除驳回项（rejected）；显式指定 status 查询时（审计/确认队列）不过滤
    const conditions = ['project_id = ?', 'dimension IS NOT NULL']
    if (!options?.status) conditions.push("status != 'rejected'")
    const params: unknown[] = [projectId]
    if (options?.storyEventId) {
      conditions.push('story_event_id = ?')
      params.push(options.storyEventId)
    }
    if (options?.chapterNumber !== undefined) {
      conditions.push('chapter_number = ?')
      params.push(options.chapterNumber)
    }
    if (options?.beforeChapter !== undefined) {
      conditions.push('chapter_number < ?')
      params.push(options.beforeChapter)
    }
    if (options?.afterChapter !== undefined) {
      conditions.push('chapter_number > ?')
      params.push(options.afterChapter)
    }
    if (options?.subjectType) {
      conditions.push('entity_type = ?')
      params.push(options.subjectType)
    }
    if (options?.subjectId) {
      conditions.push('entity_id = ?')
      params.push(options.subjectId)
    }
    if (options?.dimension) {
      conditions.push('dimension = ?')
      params.push(options.dimension)
    }
    if (options?.status) {
      conditions.push('status = ?')
      params.push(options.status)
    }
    const rows = this.db.prepare(`
      SELECT * FROM novel_memory_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY chapter_number ASC, scene_order ASC, created_at ASC
    `).all(...params) as MemoryEventRow[]
    return rows.map((row) => this.rowToChangeRecord(row))
  }

  getChangeRecord(changeId: string): NovelChangeRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM novel_memory_events WHERE id = ? AND dimension IS NOT NULL
    `).get(changeId) as MemoryEventRow | undefined
    return row ? this.rowToChangeRecord(row) : undefined
  }

  updateChangeRecord(
    changeId: string,
    patch: Partial<Pick<NovelChangeRecord, 'dimension' | 'targetType' | 'targetId' | 'valueType' | 'beforeValue' | 'afterValue' | 'reason' | 'significance' | 'source'>>,
  ): NovelChangeRecord | undefined {
    const existing = this.getChangeRecord(changeId)
    if (!existing) return undefined
    const updated = { ...existing, ...patch }
    this.db.prepare(`
      UPDATE novel_memory_events SET
        dimension=@dimension, target_entity_type=@target_entity_type, target_entity_id=@target_entity_id,
        value_type=@value_type, old_value=@old_value, new_value=@new_value,
        description=@description, significance=@significance, source=@source
      WHERE id=@id
    `).run({
      id: updated.id,
      dimension: updated.dimension,
      target_entity_type: updated.targetType,
      target_entity_id: updated.targetId,
      value_type: updated.valueType,
      old_value: serializeValue(updated.beforeValue),
      new_value: serializeValue(updated.afterValue),
      description: updated.reason,
      significance: updated.significance,
      source: updated.source,
    })
    return updated
  }

  deleteChangeRecord(changeId: string): boolean {
    return this.db.prepare('DELETE FROM novel_memory_events WHERE id = ? AND dimension IS NOT NULL').run(changeId).changes > 0
  }

  /**
   * 清理指向某个已删除实体的所有账本引用。
   *
   * `novel_story_event_entities.entity_id` 与 `novel_memory_events.entity_id/subject_id`
   * 是多态引用，没有外键，删除实体不会级联清理 —— 真实项目里因此积累了 11 条悬空引用
   * （S4-1 对账实测）。删实体时必须显式调用本方法。
   *
   * 只删引用，不删 story event 本身：事件可能还牵涉其他仍存在的实体。
   * 清理后可能出现"没有任何 entityRef 的空事件"，由 pruneEmptyStoryEvents 单独收尾。
   */
  deleteLedgerReferencesByEntity(projectId: string, entityId: string): {
    entityRefs: number
    changeRecords: number
    memoryEvents: number
  } {
    const entityRefs = this.db.prepare(`
      DELETE FROM novel_story_event_entities
      WHERE entity_id = ?
        AND event_id IN (SELECT id FROM novel_story_events WHERE project_id = ?)
    `).run(entityId, projectId).changes
    // 注意：ChangeRecord 的 subjectType/subjectId 在表里是 entity_type/entity_id 列
    // （dimension 非空的行才是变化记录，为空的是普通记忆事件）。
    const countBefore = this.db.prepare(`
      SELECT
        SUM(CASE WHEN dimension IS NOT NULL THEN 1 ELSE 0 END) AS changes,
        SUM(CASE WHEN dimension IS NULL THEN 1 ELSE 0 END) AS events
      FROM novel_memory_events
      WHERE project_id = ? AND (entity_id = ? OR target_entity_id = ?)
    `).get(projectId, entityId, entityId) as { changes: number | null; events: number | null }
    this.db.prepare(`
      DELETE FROM novel_memory_events
      WHERE project_id = ? AND (entity_id = ? OR target_entity_id = ?)
    `).run(projectId, entityId, entityId)
    return {
      entityRefs,
      changeRecords: countBefore.changes ?? 0,
      memoryEvents: countBefore.events ?? 0,
    }
  }

  /** 删除清理后残留的空 story event（既无 entityRef 也无 changeRecord） */
  pruneEmptyStoryEvents(projectId: string): number {
    return this.db.prepare(`
      DELETE FROM novel_story_events
      WHERE project_id = ?
        AND id NOT IN (SELECT event_id FROM novel_story_event_entities)
        AND id NOT IN (
          SELECT story_event_id FROM novel_memory_events
          WHERE story_event_id IS NOT NULL
        )
    `).run(projectId).changes
  }

  createStoryEventWithChanges(input: CreateStoryEventWithChangesInput): {
    event: NovelStoryEvent
    entityRefs: StoryEventEntityRef[]
    changes: NovelChangeRecord[]
  } {
    const execute = this.db.transaction((payload: CreateStoryEventWithChangesInput) => {
      const event = this.createStoryEvent(payload.event)
      const entityRefs = payload.entityRefs.map((ref) => this.createStoryEventEntityRef(event.id, ref))
      const changes = payload.changes.map((change) => this.createChangeRecord({
        ...change,
        projectId: event.projectId,
        storyEventId: event.id,
        chapterNumber: event.chapterNumber,
        sceneOrder: event.sceneOrder,
        cause: change.cause ?? null,
        effectIds: change.effectIds ?? [],
      }))
      return { event, entityRefs, changes }
    })
    return execute(input)
  }

  createAnnotation(input: CreateAnnotationInput): NovelAnnotation {
    const timestamp = now()
    const annotation: NovelAnnotation = {
      ...input,
      id: randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.db.prepare(`
      INSERT INTO novel_annotations
        (id, project_id, scope_type, scope_id, entity_type, entity_id, chapter_start,
         chapter_end, kind, content, color, include_in_prompt, resolved, created_at, updated_at)
      VALUES
        (@id, @project_id, @scope_type, @scope_id, @entity_type, @entity_id, @chapter_start,
         @chapter_end, @kind, @content, @color, @include_in_prompt, @resolved, @created_at, @updated_at)
    `).run({
      id: annotation.id,
      project_id: annotation.projectId,
      scope_type: annotation.scopeType,
      scope_id: annotation.scopeId,
      entity_type: annotation.entityType,
      entity_id: annotation.entityId,
      chapter_start: annotation.chapterStart,
      chapter_end: annotation.chapterEnd,
      kind: annotation.kind,
      content: annotation.content,
      color: annotation.color,
      include_in_prompt: Number(annotation.includeInPrompt),
      resolved: Number(annotation.resolved),
      created_at: annotation.createdAt,
      updated_at: annotation.updatedAt,
    })
    return annotation
  }

  listAnnotations(projectId: string, options?: ListAnnotationsOptions): NovelAnnotation[] {
    const conditions = ['project_id = ?']
    const params: unknown[] = [projectId]
    if (options?.chapterNumber !== undefined) {
      conditions.push('(chapter_start IS NULL OR chapter_start <= ?)')
      params.push(options.chapterNumber)
      conditions.push('(chapter_end IS NULL OR chapter_end >= ?)')
      params.push(options.chapterNumber)
    }
    if (options?.scopeType) {
      conditions.push('scope_type = ?')
      params.push(options.scopeType)
    }
    if (options?.scopeId) {
      conditions.push('scope_id = ?')
      params.push(options.scopeId)
    }
    if (options?.entityType) {
      conditions.push('entity_type = ?')
      params.push(options.entityType)
    }
    if (options?.entityId) {
      conditions.push('entity_id = ?')
      params.push(options.entityId)
    }
    if (options?.kind) {
      conditions.push('kind = ?')
      params.push(options.kind)
    }
    if (options?.resolved !== undefined) {
      conditions.push('resolved = ?')
      params.push(Number(options.resolved))
    }
    if (options?.includeInPrompt !== undefined) {
      conditions.push('include_in_prompt = ?')
      params.push(Number(options.includeInPrompt))
    }
    const rows = this.db.prepare(`
      SELECT * FROM novel_annotations
      WHERE ${conditions.join(' AND ')}
      ORDER BY COALESCE(chapter_start, 0) ASC, created_at ASC
    `).all(...params) as AnnotationRow[]
    return rows.map((row) => this.rowToAnnotation(row))
  }

  getAnnotation(annotationId: string): NovelAnnotation | undefined {
    const row = this.db.prepare('SELECT * FROM novel_annotations WHERE id = ?').get(annotationId) as AnnotationRow | undefined
    return row ? this.rowToAnnotation(row) : undefined
  }

  updateAnnotation(
    annotationId: string,
    patch: Partial<Pick<NovelAnnotation, 'scopeType' | 'scopeId' | 'entityType' | 'entityId' | 'chapterStart' | 'chapterEnd' | 'kind' | 'content' | 'color' | 'includeInPrompt' | 'resolved'>>,
  ): NovelAnnotation | undefined {
    const existing = this.getAnnotation(annotationId)
    if (!existing) return undefined
    const updated: NovelAnnotation = { ...existing, ...patch, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_annotations SET
        scope_type=@scope_type, scope_id=@scope_id, entity_type=@entity_type, entity_id=@entity_id,
        chapter_start=@chapter_start, chapter_end=@chapter_end, kind=@kind, content=@content,
        color=@color, include_in_prompt=@include_in_prompt, resolved=@resolved, updated_at=@updated_at
      WHERE id=@id
    `).run({
      id: updated.id,
      scope_type: updated.scopeType,
      scope_id: updated.scopeId,
      entity_type: updated.entityType,
      entity_id: updated.entityId,
      chapter_start: updated.chapterStart,
      chapter_end: updated.chapterEnd,
      kind: updated.kind,
      content: updated.content,
      color: updated.color,
      include_in_prompt: Number(updated.includeInPrompt),
      resolved: Number(updated.resolved),
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteAnnotation(annotationId: string): boolean {
    return this.db.prepare('DELETE FROM novel_annotations WHERE id = ?').run(annotationId).changes > 0
  }

  getChapterStoryContext(projectId: string, chapterNumber: number): ChapterStoryContext {
    const priorChanges = this.listChangeRecords(projectId, { beforeChapter: chapterNumber })
    const latestByDimension = new Map<string, NovelChangeRecord>()
    const continuityWarnings: string[] = []

    for (const change of priorChanges) {
      const key = stateKey(change)
      const previous = latestByDimension.get(key)
      if (previous && !valuesEqual(previous.afterValue, change.beforeValue)) {
        continuityWarnings.push(
          `${change.dimension} 在第 ${change.chapterNumber} 章的前值与上一状态不一致`,
        )
      }
      latestByDimension.set(key, change)
    }

    const stateBeforeChapter = [...latestByDimension.values()].map((change) => ({
      subjectType: change.subjectType,
      subjectId: change.subjectId,
      dimension: change.dimension,
      targetType: change.targetType,
      targetId: change.targetId,
      value: change.afterValue,
      valueType: change.valueType,
      effectiveChapter: change.chapterNumber,
      effectiveSceneOrder: change.sceneOrder,
      sourceChangeId: change.id,
      reason: change.reason,
    }))

    const eventsThisChapter = this.listStoryEvents(projectId, { chapterNumber })
      .filter((event) => event.status !== 'superseded')
    const plannedChanges = this.listChangeRecords(projectId, { chapterNumber })
    const futureEvents = this.listStoryEvents(projectId, { chapterStart: chapterNumber + 1, status: 'planned' })
    const futureCommitments = futureEvents.map((event) => ({
      event,
      changes: this.listChangeRecords(projectId, { storyEventId: event.id }),
    }))

    const allEvents = this.listStoryEvents(projectId)
    const childrenByParent = new Map<string, NovelStoryEvent[]>()
    for (const event of allEvents) {
      if (!event.parentEventId) continue
      const children = childrenByParent.get(event.parentEventId) ?? []
      children.push(event)
      childrenByParent.set(event.parentEventId, children)
    }
    const activeThreads = allEvents.filter((event) => {
      const children = childrenByParent.get(event.id)
      if (!children?.length) return false
      const chapters = children.map((child) => child.chapterNumber)
      return Math.min(...chapters) <= chapterNumber && chapterNumber <= Math.max(...chapters)
    })

    const settledValues = new Set(['resolved', 'recovered', 'verified', 'disproved', 'destroyed', 'abandoned'])
    const unresolvedDebts = [...latestByDimension.values()].filter((change) =>
      ['conflict', 'foreshadow', 'clue'].includes(change.subjectType)
      && !(typeof change.afterValue === 'string' && settledValues.has(change.afterValue)),
    )

    const promptDimensions = [...latestByDimension.values()]
      .map((change) => buildPromptDimensionContext(
        change.dimension,
        change.afterValue,
        change.beforeValue,
        change.reason,
      ))
      .filter((context): context is PromptDimensionContext => context != null)

    const annotations = this.listAnnotations(projectId, { chapterNumber, resolved: false })
    const versionCandidates = [
      ...priorChanges.map((change) => change.createdAt),
      ...eventsThisChapter.map((event) => event.updatedAt),
      ...annotations.map((annotation) => annotation.updatedAt),
    ]

    return {
      projectId,
      chapterNumber,
      snapshotVersion: Math.max(0, ...versionCandidates),
      stateBeforeChapter,
      activeThreads,
      plannedEvents: eventsThisChapter.filter((event) => event.status === 'planned'),
      plannedChanges,
      unresolvedDebts,
      futureCommitments,
      promptDimensions,
      annotations,
      continuityWarnings,
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 快照（情景记忆：章节状态快照）
  // ═══════════════════════════════════════════════════════════════

  /** 保存章节快照 */
  saveSnapshot(snapshot: Omit<MemorySnapshot, 'id' | 'createdAt'>): MemorySnapshot {
    const full: MemorySnapshot = {
      ...snapshot,
      id: randomUUID(),
      createdAt: now(),
    }
    this.db.prepare(`
      INSERT INTO novel_memory_snapshots
      (id, project_id, chapter_number, snapshot_type, entity_id, snapshot_data, created_at)
      VALUES (@id, @project_id, @chapter_number, @snapshot_type, @entity_id, @snapshot_data, @created_at)
    `).run({
      id: full.id,
      project_id: full.projectId,
      chapter_number: full.chapterNumber,
      snapshot_type: full.snapshotType,
      entity_id: full.entityId,
      snapshot_data: full.snapshotData,
      created_at: full.createdAt,
    })
    return full
  }

  /** 获取某章的状态快照（按类型/实体过滤，返回最新一条） */
  getSnapshot(
    projectId: string,
    chapterNumber: number,
    options?: GetSnapshotOptions,
  ): MemorySnapshot | undefined {
    const conditions = ['project_id = ?', 'chapter_number = ?']
    const params: unknown[] = [projectId, chapterNumber]
    if (options?.snapshotType) {
      conditions.push('snapshot_type = ?')
      params.push(options.snapshotType)
    }
    if (options?.entityId) {
      conditions.push('entity_id = ?')
      params.push(options.entityId)
    }
    const sql = `SELECT * FROM novel_memory_snapshots WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 1`
    const row = this.db.prepare(sql).get(...params) as MemorySnapshotRow | undefined
    return row ? this.rowToSnapshot(row) : undefined
  }

  /** 获取所有快照 */
  listSnapshots(projectId: string, options?: ListSnapshotsOptions): MemorySnapshot[] {
    const conditions = ['project_id = ?']
    const params: unknown[] = [projectId]
    if (options?.chapterNumber !== undefined) {
      conditions.push('chapter_number = ?')
      params.push(options.chapterNumber)
    }
    if (options?.snapshotType) {
      conditions.push('snapshot_type = ?')
      params.push(options.snapshotType)
    }
    const sql = `SELECT * FROM novel_memory_snapshots WHERE ${conditions.join(' AND ')} ORDER BY chapter_number ASC`
    const rows = this.db.prepare(sql).all(...params) as MemorySnapshotRow[]
    return rows.map((r) => this.rowToSnapshot(r))
  }

  // ═══════════════════════════════════════════════════════════════
  // 行 → 对象 转换方法
  // ═══════════════════════════════════════════════════════════════

  private rowToEvent(row: MemoryEventRow): MemoryEvent {
    return {
      id: row.id,
      projectId: row.project_id,
      chapterId: row.chapter_id,
      chapterNumber: row.chapter_number,
      eventType: row.event_type as MemoryEventType,
      entityId: row.entity_id,
      entityType: row.entity_type as MemoryEntityType,
      description: row.description,
      oldValue: row.old_value,
      newValue: row.new_value,
      cause: row.cause,
      effectIds: parseEffectIds(row.effect_ids),
      significance: row.significance,
      storyEventId: row.story_event_id,
      sceneOrder: row.scene_order,
      dimension: row.dimension,
      targetEntityType: row.target_entity_type as MemoryEntityType | null,
      targetEntityId: row.target_entity_id,
      valueType: row.value_type as ChangeValueType | null,
      source: row.source as StoryEventSource,
      styleNote: row.style_note,
      status: row.status as MemoryEvent['status'],
      confirmedAt: row.confirmed_at,
      createdAt: row.created_at,
    }
  }

  private rowToStoryEvent(row: StoryEventRow): NovelStoryEvent {
    return {
      id: row.id,
      projectId: row.project_id,
      chapterNumber: row.chapter_number,
      sceneId: row.scene_id,
      sceneOrder: row.scene_order,
      type: row.type as StoryEventType,
      title: row.title,
      summary: row.summary,
      outcome: row.outcome,
      status: row.status as StoryEventStatus,
      parentEventId: row.parent_event_id,
      source: row.source as StoryEventSource,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private rowToStoryEventEntityRef(row: StoryEventEntityRow): StoryEventEntityRef {
    return {
      id: row.id,
      eventId: row.event_id,
      entityType: row.entity_type as NovelStoryEntityType,
      entityId: row.entity_id,
      role: row.role as StoryEventEntityRole,
      note: row.note,
    }
  }

  private rowToChangeRecord(row: MemoryEventRow): NovelChangeRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      storyEventId: row.story_event_id,
      chapterNumber: row.chapter_number,
      sceneOrder: row.scene_order,
      subjectType: row.entity_type as NovelStoryEntityType,
      subjectId: row.entity_id,
      dimension: row.dimension ?? '',
      targetType: row.target_entity_type as NovelStoryEntityType | null,
      targetId: row.target_entity_id,
      valueType: (row.value_type ?? 'text') as ChangeValueType,
      beforeValue: parseValue(row.old_value),
      afterValue: parseValue(row.new_value),
      reason: row.description,
      significance: row.significance,
      source: row.source as StoryEventSource,
      cause: row.cause,
      effectIds: parseEffectIds(row.effect_ids),
      styleNote: row.style_note,
      status: row.status as NovelChangeRecord['status'],
      confirmedAt: row.confirmed_at,
      createdAt: row.created_at,
    }
  }

  private rowToAnnotation(row: AnnotationRow): NovelAnnotation {
    return {
      id: row.id,
      projectId: row.project_id,
      scopeType: row.scope_type as NovelAnnotationScope,
      scopeId: row.scope_id,
      entityType: row.entity_type as NovelStoryEntityType | null,
      entityId: row.entity_id,
      chapterStart: row.chapter_start,
      chapterEnd: row.chapter_end,
      kind: row.kind as NovelAnnotationKind,
      content: row.content,
      color: row.color,
      includeInPrompt: row.include_in_prompt === 1,
      resolved: row.resolved === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private rowToSnapshot(row: MemorySnapshotRow): MemorySnapshot {
    return {
      id: row.id,
      projectId: row.project_id,
      chapterNumber: row.chapter_number,
      snapshotType: row.snapshot_type as MemorySnapshotType,
      entityId: row.entity_id,
      snapshotData: row.snapshot_data,
      createdAt: row.created_at,
    }
  }
}
