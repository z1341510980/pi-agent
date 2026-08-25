/**
 * NovelPromptBuilder：缓存优化的提示词构建器
 *
 * 核心设计原则（缓存命中率是小说创作的关键成本指标）：
 *
 * 1. 静态在前，动态在后
 *    LLM 提供商（Anthropic/OpenAI）的 prompt cache 基于前缀匹配。
 *    前缀越稳定，缓存命中率越高。
 *
 * 2. 系统提示词只包含静态数据（不含角色定义）
 *    世界规则、风格指南放在系统提示词中。这些数据跨章节不变，缓存命中率最高。
 *    ⚠️ 角色定义不放在系统提示词：角色数量可能很大（200+），全部塞会导致上下文爆炸。
 *    本章出场角色的完整定义放在章节上下文（SEMI 层），通过 arrangedEntities 注入。
 *
 * 3. 章节上下文放在首条用户消息中
 *    当前故事状态、叙事任务、约束、本章出场角色完整定义等半静态数据放在首条用户消息中。
 *    这些数据单章内不变，跨章失效。
 *
 * 4. 工具调用结果只追加到对话末尾
 *    工具返回的状态查询结果追加到对话消息中，不修改系统提示词。
 *    前缀（系统提示词 + 早期消息）保持不变 → 缓存命中。
 *
 * 5. 状态更新发生在章节完成后
 *    工具更新角色状态/伏笔/冲突等，只影响下一章的提示词，不影响当前章。
 *
 * ── 缓存层级结构 ──
 *
 * [系统提示词] (STATIC - 跨章节、跨 Agent 缓存命中)
 * ├── Layer 1: 世界规则（项目级，极少变）
 * ├── Layer 2: 风格指南（项目级，极少变）
 * └── 不含 Agent 身份，保证不同 Agent 的公共前缀完全一致
 *
 * [前缀用户消息] (SEMI - 单章内缓存命中)
 * ├── 章节信息（卷/章/叙事任务/约束）
 * ├── 本章出场角色完整定义（arrangedEntities，仅本章角色）
 * ├── 当前故事状态（所有角色的 name+动态状态，让 LLM 知道存在）
 * ├── 信息差（谁知道什么）
 * ├── 最近章节摘要
 * ├── Agent 身份（独立缓存断点）
 * └── Agent 专属后缀（Director 方案、Rubric 等，最易变化）
 *
 * [对话消息] (DYNAMIC - 不缓存)
 * ├── 工具调用 + 结果（追加到末尾，不破坏前缀缓存）
 * ├── 生成内容
 * └── 用户引导
 *
 * ── 角色定义注入策略（精准注入方案）──
 *
 * 问题：角色数量可能很大（200+），全部塞系统提示词会导致上下文爆炸。
 *
 * 解决：
 * 1. 系统提示词不含任何角色定义 → 跨章缓存命中最好
 * 2. 章节上下文注入 arrangedEntities 中角色的完整静态+动态定义 → 单章内缓存命中
 * 3. 其他角色通过 formatStoryState 输出 name+动态状态 → LLM 知道存在
 * 4. 需要其他角色详情时调用 query_state 工具 → DYNAMIC 层，不破坏前缀缓存
 *
 * ── 工具调用缓存问题解决方案 ──
 *
 * 问题：工具调用后上下文变化，导致缓存失效。
 *
 * 解决：
 * 1. 系统提示词不包含动态状态 → 工具更新状态不影响系统提示词
 * 2. 工具结果追加到对话末尾 → 前缀（系统提示词 + 早期消息）不变
 * 3. 状态更新只影响下一章 → 当前章的系统提示词在整个生成过程中不变
 * 4. systemPromptOverride 函数只读取静态数据 → 每次调用返回相同结果
 */

import { createHash } from 'node:crypto'
import type { PromptManager } from './prompt-manager.js'
import {
  SYSTEM_BUDGET,
  CHARACTER_CARD_BUDGET,
  STORY_STATE_LIMIT,
  RELATION_BUDGET,
  LEDGER_BUDGET,
  CHAPTER_ANCHOR_BUDGET,
  FINGERPRINT_TRUST
} from './prompt-budget.js'
import {
  measureStyleMetrics,
  formatStyleMetricsAsFingerprint,
} from '../analysis/style-measurement.js'
import {
  buildStyleDecisionPack,
  compileWritingStylePrompt,
  selectStyleExperts,
  inferSceneType,
  buildSceneSampleSection,
  type WritingStylePromptTarget
} from './writing-style-prompt-factory.js'
import { buildVoiceProfiles, formatVoiceContrastTable } from '../entities/character-voice.js'
import { evaluateProseQuality } from '../quality/prose-quality-evaluator.js'
import { isNovelFeatureEnabled } from '../domain/novel-feature-flags.js'
import { CHUNK_BY_ID, resolveChunkMode } from './context-chunk.js'
import { buildStoryStateSummary, chooseEntityChunkMode } from './entity-summary.js'
import { estimateChunkTokens } from './context-budget.js'
import { validateAgentIdentity } from '../domain/identity-contract.js'
import type { LazyChunkBuilder } from './chunk-cache.js'
import { baseTargetOf, resolveWordBudget } from '../chapters/word-budget-resolver.js'
import type { RelationshipGraph, GraphEdge } from '../analysis/novel-relationship-graph.js'
import type {
  NovelProject,
  NovelCharacter,
  NovelWorldRule,
  NovelStyleGuide,
  NovelWritingStyleProfile,
  NovelChapter,
  NovelConflict,
  NovelForeshadow,
  NovelHook,
  NovelClue,
  NovelInformationLayer,
  NovelConstraint,
  NovelRelationship,
  NovelFaction,
  NovelLocation,
  NovelItem,
  NovelWorldElement,
  NovelEdge,
  NovelVolume,
  StoryState,
  NarrativeTask,
  ChapterConstraints,
  ArrangedEntity,
  NovelAgentLog,
  ChapterStoryContext
} from '../types.js'
import type { MemoryEvent, MemoryEventType, MemorySnapshot } from '../novel-memory-store.js'
import { resolveChapterBoundaryEntity } from '../chapters/chapter-boundary-resolution.js'

/** 将持久化枚举翻译成创作语境中的自然语言，避免把实现细节交给模型理解。 */
const PROMPT_VALUE_LABELS: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
  rising: '上升期',
  latent: '潜伏',
  emerging: '初现',
  escalating: '升级中',
  erupting: '爆发',
  reversing: '反转中',
  resolved: '已解决',
  transformed: '已转化',
  denial: '否认',
  resistance: '抗拒',
  acceptance: '接纳',
  transformation: '蜕变',
  temptation: '诱惑',
  rationalization: '自我合理化',
  corruption: '堕落',
  point_of_no_return: '无法回头',
  guilt: '愧疚',
  atonement: '赎罪',
  sacrifice: '牺牲',
  redemption: '救赎',
  old_framework: '旧认知',
  disruption: '认知受冲击',
  exploration: '探索中',
  new_framework: '新认知',
  planted: '已埋下',
  reinforced: '已强化',
  partially_revealed: '部分揭示',
  recovered: '已回收',
  abandoned: '已弃用',
  planting: '埋下',
  sustaining: '维持',
  releasing: '释放',
  twist: '转折',
  climax: '高潮',
  rising_rhythm: '推进',
  breather: '缓冲',
  setup: '铺垫',
  relationship: '关系',
  world_rule: '世界规则',
  survival: '生存',
  inner: '内心',
  faction: '势力',
  interest: '利益',
  moral: '道德',
  identity: '身份',
  emotional: '情感',
  main: '主线',
  secondary: '支线',
  goal: '目标线',
  active: '活跃',
  declined: '衰落',
  destroyed: '毁灭',
  hidden: '隐匿',
  normal: '正常',
  changed: '已变化',
  organization: '组织',
  sect: '宗门',
  kingdom: '王国',
  family: '家族',
  guild: '行会',
  cult: '教派',
  weak: '弱',
  strong: '强',
  overwhelming: '碾压性',
  minor: '次要',
  moderate: '重要',
  major: '主要',
  critical: '关键',
  city: '城镇',
  building: '建筑',
  dungeon: '险地',
  region: '区域',
  wilderness: '野外',
  continent: '大陆',
  country: '国家',
  advance_mainline: '推进主线',
  advance_subline: '推进支线',
  create_conflict: '建立冲突',
  escalate_conflict: '升级冲突',
  release_info: '揭示信息',
  hide_info: '隐藏信息',
  reinforce_foreshadow: '强化伏笔',
  recover_foreshadow: '回收伏笔',
  change_relationship: '改变关系',
  change_cognition: '改变认知',
  create_reversal: '制造转折',
  create_suspense: '制造悬念',
  phase_closure: '阶段收束',
  introduce_problem: '引入问题',
  fate: '命运',
  character: '人物',
  combat: '战斗',
  theme: '主题',
  composite: '复合',
  // ── 节奏补充 ──
  falling: '回落',
  suspense: '悬念',
  // ── 冲突阶段补充 ──
  confrontation: '对峙',
  // ── 关系类型 ──
  allied: '同盟',
  hostile: '敌对',
  romantic: '恋爱',
  mentor: '师徒',
  rival: '对手',
  friendship: '友情',
  kinship: '亲情',
  // ── 角色弧阶段补充 ──
  crisis: '危机',
  // ── 边类型 ──
  related: '关联',
  involvement: '参与',
  belongs_to: '归属',
  hostility: '敌对关系',
  alliance: '同盟关系',
  hierarchy: '上下级',
  location_of: '所在地',
  // ── 实体类型（边格式化用）──
  conflict: '冲突',
  foreshadow: '伏笔',
  item: '物品',
  clue: '线索',
  info_layer: '信息差',
  world_element: '世界要素',
  // ── 钩子类型 ──
  cliffhanger: '断章悬念',
  mystery: '谜团',
  // ── 动态角色功能位 ──
  protagonist: '主角',
  antagonist: '对手',
  catalyst: '催化者',
  observer: '旁观者',
  mediator: '调停者',
  // ── 物品类型 ──
  weapon: '武器',
  armor: '防具',
  consumable: '消耗品',
  artifact: '神器',
  material: '材料',
  key_item: '关键道具',
  // ── 物品状态 ──
  owned: '持有中',
  lost: '遗失',
  sealed: '封印',
  upgraded: '已升级',
  // ── 卷级节拍戏剧功能（Beat Planner）──
  escalation: '递进加压',
  false_victory: '假胜利',
  false_defeat: '假失败',
  midpoint_turn: '中点反转',
  low_point: '低谷',
  payoff: '兑现爽点',
  aftermath: '余波'
}

function promptLabel(value: string): string {
  return PROMPT_VALUE_LABELS[value] ?? value
}

function compactPromptText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

/**
 * 中文正文的对话引号集合。
 *
 * 必须用 \u 转义书写：直接写弯引号时，格式化/编码转换会把 “ ” 变成 ASCII "，
 * 导致对话检测在真实正文上永远为 0（历史 bug）。
 */
const DIALOGUE_QUOTE_PATTERN = /["'\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f\uff02]/

/** 占位文本（生成器兜底写入的"待补充（占位）"之类）不应进 prompt，白占预算还会误导模型 */
const PLACEHOLDER_DETAIL = /待补充|待定|占位|未设定|^\(空\)$|^（空）$/

function usableDetail(value: string | undefined | null): value is string {
  const raw = (value ?? '').trim()
  if (!raw) return false
  return !PLACEHOLDER_DETAIL.test(raw)
}

/**
 * 角色档案的 personality / speechStyle 由生成器存为结构化 JSON。
 *
 * 早期实现只取"命中的前 2 个键"再截 120 字，结果是：
 * - personality 只剩「核心 + 优点」，全部缺点和座右铭被丢弃；
 * - speechStyle 只剩「基调 + 特点」，"典型句式示例"整块丢弃。
 * 缺点与句式示例恰好是让角色不趋同的部分，丢掉它们直接导致"人物性格单一"。
 *
 * 现在按 detailShape 指定的键序抽取，每个键各留一份配额，
 * 保证「优点 / 缺点」「基调 / 典型句式示例」成对出现。
 */
type CharacterDetailShape = 'personality' | 'speechStyle' | 'generic'

/** 各形态下必须成对保留的键，顺序即输出顺序 */
const CHARACTER_DETAIL_KEYS: Record<CharacterDetailShape, string[]> = {
  personality: ['核心', '优点', '缺点', '座右铭（内心独白）', '座右铭', '矛盾点', '禁忌'],
  speechStyle: ['基调', '典型句式示例', '特点', '口头禅'],
  generic: ['核心', '基调', '特点', '典型句式示例', '优点', '缺点']
}

/** 每个键最多取几个数组项（数组型值） */
const CHARACTER_DETAIL_ITEMS_PER_KEY: Record<CharacterDetailShape, number> = {
  personality: 2,
  speechStyle: 2,
  generic: 3
}

function compactCharacterDetail(
  value: string,
  maxLength: number,
  shape: CharacterDetailShape = 'generic'
): string {
  const raw = value.trim()
  if (!raw) return ''

  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return compactPromptText(
        parsed
          .filter((item): item is string => typeof item === 'string')
          .slice(0, 3)
          .join('；'),
        maxLength
      )
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      const itemsPerKey = CHARACTER_DETAIL_ITEMS_PER_KEY[shape]
      // 键序优先，但每个键都有独立配额；不再因为前 2 个键命中就提前退出。
      const orderedKeys = [
        ...CHARACTER_DETAIL_KEYS[shape],
        ...Object.keys(record).filter((key) => !CHARACTER_DETAIL_KEYS[shape].includes(key))
      ]
      const fragments: string[] = []
      for (const key of orderedKeys) {
        const item = record[key]
        if (typeof item === 'string' && item.trim()) {
          fragments.push(`${key}：${item.trim()}`)
        } else if (Array.isArray(item)) {
          const texts = item
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim())
            .filter(Boolean)
            .slice(0, itemsPerKey)
          if (texts.length > 0) fragments.push(`${key}：${texts.join('；')}`)
        }
        // 预算用尽即停，但至少已按键序覆盖了成对的关键项。
        if (fragments.join('｜').length >= maxLength) break
      }
      if (fragments.length > 0) return compactPromptText(fragments.join('｜'), maxLength)
    }
  } catch {
    // 普通文本直接压缩。
  }

  return compactPromptText(raw, maxLength)
}

/**
 * Store 接口：NovelPromptBuilder 只需要读取数据，不关心存储实现
 */
export interface NovelPromptStores {
  getProject(projectId: string): NovelProject | undefined
  listWorldRules(projectId: string): NovelWorldRule[]
  listStyleGuide(projectId: string): NovelStyleGuide[]
  getWritingStyleProfile?(projectId: string): NovelWritingStyleProfile | undefined
  listCharacters(projectId: string): NovelCharacter[]
  listRelationships(projectId: string): NovelRelationship[]
  listConflicts(projectId: string): NovelConflict[]
  listForeshadowing(projectId: string): NovelForeshadow[]
  listClues(projectId: string): NovelClue[]
  /** 按 ID 查询线索（供 arrangedEntities 注入时使用） */
  getClue(clueId: string): NovelClue | undefined
  listInformationLayers(projectId: string): NovelInformationLayer[]
  /** 按 ID 查询单个信息差（P3-2：供伏笔反向展示承载的信息差） */
  getInformationLayer(infoLayerId: string): NovelInformationLayer | undefined
  listConstraints(projectId: string): NovelConstraint[]
  listRecentChapters(projectId: string, limit: number): NovelChapter[]
  /**
   * 章节验收（P1-2 自池用，可选）：返回最新一次审稿报告。
   * 缺失时自池退化为"最近发布章节"，仍可用但不做分数排序。
   */
  getChapterReview?(chapterId: string): { overallScore?: number | null } | undefined
  /** 查询指定章节之前抛出且未兑现的钩子（v0.2：供 Writer 承接） */
  listUnfulfilledHooksBefore(projectId: string, beforeChapter: number): NovelHook[]
  getChapter(projectId: string, chapterNumber: number): NovelChapter | undefined
  listEdges(projectId: string): NovelEdge[]
  /** 按实体 ID 查询关联边（双向，供关联关系迁移后反向查询） */
  listEdgesByEntity(
    entityId: string,
    opts?: { direction?: 'source' | 'target' | 'both'; edgeType?: string }
  ): NovelEdge[]
  listFactions(projectId: string): NovelFaction[]
  listLocations(projectId: string): NovelLocation[]
  /** 列出项目内所有物品（供 StoryState 和 arrangedEntities 注入） */
  listItems(projectId: string): NovelItem[]
  listWorldElements(projectId: string): NovelWorldElement[]
  /** 按 ID 查询角色（供 arrangedEntities 注入时使用） */
  getCharacter(characterId: string): NovelCharacter | undefined
  /** 按 ID 查询冲突（供 arrangedEntities 注入时使用） */
  getConflict(conflictId: string): NovelConflict | undefined
  /** 按 ID 查询伏笔（供 arrangedEntities 注入时使用） */
  getForeshadow(foreshadowId: string): NovelForeshadow | undefined
  /** 按 ID 查询势力（供 arrangedEntities 注入时使用） */
  getFaction(factionId: string): NovelFaction | undefined
  /** 按 ID 查询地点（供 arrangedEntities 注入时使用） */
  getLocation(locationId: string): NovelLocation | undefined
  /** 按 ID 查询物品（供 arrangedEntities 注入时使用） */
  getItem(itemId: string): NovelItem | undefined
  /** 查询指定角色拥有的所有物品（供提示词注入"主角拥有什么"） */
  listItemsByOwner?(ownerId: string): NovelItem[]
  /** 查询项目的所有卷（供注入卷纲） */
  listVolumes(projectId: string): NovelVolume[]
  /** 查询项目级 Agent 调用日志（供 Reviewer 反馈回流 Director） */
  listAgentLogsByProject?(projectId: string, limit: number): NovelAgentLog[]
}

/**
 * 某章开篇时可用的全量实体快照。
 *
 * `state` 供通用故事状态格式化，`entities` 保留未经过“活跃”筛选的原始实体，
 * 因此本章编排的已解决冲突、已回收伏笔等也能准确读取 N-1 状态。
 */
export interface ChapterBoundaryEntities {
  characters: NovelCharacter[]
  relationships: NovelRelationship[]
  conflicts: NovelConflict[]
  foreshadowing: NovelForeshadow[]
  clues: NovelClue[]
  factions: NovelFaction[]
  locations: NovelLocation[]
  items: NovelItem[]
  worldElements: NovelWorldElement[]
  informationLayers: NovelInformationLayer[]
  edges: NovelEdge[]
}

export interface ChapterBoundaryContext {
  chapterNumber: number
  state: StoryState
  entities: ChapterBoundaryEntities
  /** true 表示严格读取第 N-1 章持久化快照，而非当前库的顺序生成回退。 */
  fromSnapshot: boolean
  /**
   * true 表示当前状态取自实体表「全书最新值」，且可能包含目标章节之后才发生的事实
   * （重写旧章节且无历史快照可用的回退场景）。注入上下文时必须附带越界警告，
   * 要求模型以用户章纲/叙事任务为准，禁止把本章之后的进展写入正文。
   * 可选：未判定（如测试桩或旁路构造）时不告警。
   */
  stateAheadOfBoundary?: boolean
}

/**
 * 上下文预览的单个 section 元数据（P1 可观测性）。
 *
 * 让开发者无需实际触发创作流即可审计 prompt-builder 注入了哪些内容、
 * 各 section 字符占比、以及 semi-shared 是否命中 N-1 快照。
 */
export interface ContextPreviewSection {
  /** section 标识，如 'system' / 'shared' / 'suffix' / 'agentIdentity' */
  key: string
  /** 中文标题，供前端展示 */
  title: string
  /** 来源类型：static=系统提示词，semi-shared=章前共享层，semi-suffix=Agent 专属后缀，agent-identity=Agent 身份 */
  source: 'static' | 'semi-shared' | 'semi-suffix' | 'agent-identity'
  /** 该 section 字符数 */
  charCount: number
  /** 仅 semi-shared 标注：是否来自 N-1 持久化快照（true）而非顺序生成回退（false） */
  fromSnapshot?: boolean
  /** 上下文模式：full=全量故事状态，diff=全局关键事实摘要 + 上一章变化 delta */
  mode?: 'full' | 'diff'
  /** 内容预览（前 200 字） */
  preview: string
  /** T03-2：semi-shared 层按 ContextChunk 下沉的明细（full 模式），供前端按 chunk 诊断 */
  chunks?: Array<{ chunkId: string; title: string; charCount: number; preview: string }>
}

/**
 * 上下文预览结果（P1 可观测性）。
 *
 * 聚合各 section 的字符数与预览，供 context-preview 端点返回结构化诊断数据。
 */
export interface ContextPreviewResult {
  projectId: string
  chapterNumber: number
  agentType?: string
  totalChars: number
  sections: ContextPreviewSection[]
}

export class NovelPromptBuilder {
  constructor(
    private promptManager: PromptManager,
    private stores: NovelPromptStores,
    /**
     * 长期记忆存储（可选）。
     *
     * 提供时：buildChapterContextShared 会注入"账本承接"section（章前状态 / 最近承接 /
     * 本章计划 / 后文边界 / 批注），让 Director/Writer/Reviewer 感知实体的真实推进进度。
     *
     * 不提供时（如 novel-session 的手动对话流）：跳过该 section，不影响其他部分。
     */
    private memoryStore?: {
      listEvents(
        projectId: string,
        options?: { minSignificance?: number; limit?: number }
      ): MemoryEvent[]
      getCausalChain(eventId: string): { causes: MemoryEvent[]; effects: MemoryEvent[] }
      getSnapshot?(
        projectId: string,
        chapterNumber: number,
        options?: { snapshotType?: 'full' }
      ): MemorySnapshot | undefined
      listSnapshots?(
        projectId: string,
        options?: { chapterNumber?: number; snapshotType?: 'full'; includeInactive?: boolean }
      ): MemorySnapshot[]
      getChapterStoryContext?(projectId: string, chapterNumber: number): ChapterStoryContext
      // diff 模式读取第 N-1 章的原子变化记录，用 ChapterStoryContext['plannedChanges']
      // （即 NovelChangeRecord[]）作为返回类型，避免新增 import。
      listChangeRecords?(
        projectId: string,
        options?: {
          storyEventId?: string
          chapterNumber?: number
          beforeChapter?: number
          afterChapter?: number
          subjectType?: string
          subjectId?: string
          dimension?: string
        }
      ): ChapterStoryContext['plannedChanges']
    },
    /**
     * 统一关系图查询层（可选，C3 prompt 增强）。
     *
     * 提供时：formatEdges 会调用 getAllGraphEdges 拿到派生边（冲突参与/势力敌对/盟友
     * /地点归属/世界要素层级等 7 类），让 LLM 显式看到这些关系，无需从 description 推断。
     *
     * 不提供时（如测试代码、novel-session 的手动对话流）：降级到 stores.listEdges，
     * 只看用户手动连线，无派生边。
     */
    private relationshipGraph?: RelationshipGraph
  ) {}

  /** P3 T03-6：identity-contract 守卫日志（可选，services 装配时注入） */
  private identityLogger?: { warn: (msg: string, ctx?: unknown) => void }

  /** 注入 identity-contract 守卫日志（services 装配时调用一次） */
  setIdentityLogger(logger: { warn: (msg: string, ctx?: unknown) => void }): void {
    this.identityLogger = logger
  }

  /** Resolve a bounded set of project-owned entity IDs or exact names into compact facts. */
  buildReferenceFactPack(
    projectId: string,
    references?: readonly string[],
    boundary?: ChapterBoundaryContext,
  ): string {
    const requested = [...new Set((references ?? []).map((value) => value.trim()).filter(Boolean))]
      .slice(0, 8)
    if (requested.length === 0) return ''

    type Fact = { id: string; name: string; projectId: string; detail: string; aliases?: string[] }
    type Resolved<T> = { entity: T; hasBoundaryState: boolean }
    const resolveCandidates = <T extends { id: string }>(
      boundaryEntities: readonly T[] | undefined,
      currentEntities: readonly T[],
    ): Resolved<T>[] => {
      if (!boundary) return currentEntities.map((entity) => ({ entity, hasBoundaryState: true }))
      const resolved: Resolved<T>[] = (boundaryEntities ?? [])
        .map((entity) => ({ entity, hasBoundaryState: true }))
      if (!boundary.fromSnapshot) return resolved
      const knownIds = new Set(resolved.map(({ entity }) => entity.id))
      for (const entity of currentEntities) {
        if (!knownIds.has(entity.id)) resolved.push({ entity, hasBoundaryState: false })
      }
      return resolved
    }
    const characters = resolveCandidates(
      boundary?.entities.characters,
      this.stores.listCharacters(projectId),
    )
    const characterNames = new Map(
      characters.map(({ entity }) => [entity.id, entity.name]),
    )
    const facts: Fact[] = [
      ...characters.map(({ entity, hasBoundaryState }) => ({
        id: entity.id, name: entity.name, projectId: entity.projectId,
        detail: hasBoundaryState
          ? `角色；身份：${entity.identity}；状态：${entity.currentState}；目标：${entity.currentGoal}；压力：${entity.currentPressure}；弧光：${entity.arcStage}`
          : `角色；身份：${entity.identity}；性格：${entity.personality}；说话风格：${entity.speechStyle}；章前动态状态未知`,
      })),
      ...resolveCandidates(boundary?.entities.conflicts, this.stores.listConflicts(projectId)).map(({ entity, hasBoundaryState }) => ({
        id: entity.id, name: entity.description, projectId: entity.projectId,
        detail: hasBoundaryState
          ? `冲突；阶段：${entity.stage}；强度：${entity.intensity}/10；当前：${entity.currentStep ?? ''}；下一步：${entity.nextStep ?? ''}`
          : `冲突；类型：${entity.type}；章前动态状态未知`,
      })),
      ...resolveCandidates(boundary?.entities.foreshadowing, this.stores.listForeshadowing(projectId)).map(({ entity, hasBoundaryState }) => ({
        id: entity.id, name: entity.description, projectId: entity.projectId,
        detail: hasBoundaryState
          ? `伏笔；状态：${entity.status}；计划回收章：${entity.recoverByChapter ?? '未定'}`
          : `伏笔；类别：${entity.category}；章前动态状态未知`,
      })),
      ...resolveCandidates(boundary?.entities.clues, this.stores.listClues(projectId)).map(({ entity, hasBoundaryState }) => ({
        id: entity.id, name: entity.description, projectId: entity.projectId,
        detail: hasBoundaryState
          ? `线索；指向：${entity.pointsTo}；进度：${entity.progress}%；当前：${entity.currentStep}；下一步：${entity.nextStep}`
          : `线索；指向：${entity.pointsTo}；章前动态状态未知`,
      })),
      ...resolveCandidates(boundary?.entities.factions, this.stores.listFactions(projectId)).map(({ entity, hasBoundaryState }) => ({
        id: entity.id, name: entity.name, projectId: entity.projectId,
        detail: hasBoundaryState
          ? `势力；状态：${entity.status}；理念：${entity.ideology}；实力：${entity.strength}`
          : `势力；理念：${entity.ideology}；章前动态状态未知`,
      })),
      ...resolveCandidates(boundary?.entities.locations, this.stores.listLocations(projectId)).map(({ entity, hasBoundaryState }) => ({
        id: entity.id, name: entity.name, projectId: entity.projectId,
        detail: hasBoundaryState
          ? `地点；状态：${entity.status}；${entity.description}`
          : `地点；${entity.description}；章前动态状态未知`,
      })),
      ...resolveCandidates(boundary?.entities.items, this.stores.listItems(projectId)).map(({ entity, hasBoundaryState }) => ({
        id: entity.id, name: entity.name, projectId: entity.projectId,
        detail: hasBoundaryState
          ? `物品；状态：${entity.status}；能力：${entity.abilities}；来源：${entity.origin}`
          : `物品；能力：${entity.abilities}；章前动态状态未知`,
      })),
      ...resolveCandidates(boundary?.entities.worldElements, this.stores.listWorldElements(projectId)).map(({ entity }) => ({
        id: entity.id, name: entity.name, projectId: entity.projectId,
        detail: `世界设定；类别：${entity.category}；${entity.description}`,
      })),
      ...resolveCandidates(boundary?.entities.informationLayers, this.stores.listInformationLayers(projectId)).map(({ entity, hasBoundaryState }) => ({
        id: entity.id, name: entity.infoDescription, projectId: entity.projectId,
        detail: hasBoundaryState
          ? `信息差；读者${entity.readerKnows ? '已知' : '未知'}；${entity.isRevealed ? '已揭示' : '未揭示'}`
          : '信息差；章前认知状态未知',
      })),
      ...resolveCandidates(boundary?.entities.relationships, this.stores.listRelationships(projectId)).map(({ entity, hasBoundaryState }) => {
        const characterA = characterNames.get(entity.characterA) ?? entity.characterA
        const characterB = characterNames.get(entity.characterB) ?? entity.characterB
        const reference = `${characterA}/${characterB}/${entity.relationType}`
        return {
          id: entity.id, name: reference, projectId: entity.projectId,
          aliases: [`${characterB}/${characterA}/${entity.relationType}`],
          detail: hasBoundaryState
            ? `角色关系；${characterA} ↔ ${characterB}；类型：${entity.relationType}；阶段：${entity.currentStage}；走向：${entity.trend}`
            : `角色关系；${characterA} ↔ ${characterB}；类型：${entity.relationType}；章前动态状态未知`,
        }
      }),
      ...this.stores.listWorldRules(projectId).map((entity) => ({
        id: entity.id, name: entity.rule, projectId: entity.projectId,
        detail: `世界规则；类别：${entity.category}；原文：${entity.rule}${entity.cost ? `；代价：${entity.cost}` : ''}`,
      })),
    ]
    const byId = new Map(facts.map((fact) => [fact.id, fact]))
    const byName = new Map<string, Fact | null>()
    for (const fact of facts) {
      byName.set(fact.name, byName.has(fact.name) ? null : fact)
      for (const alias of fact.aliases ?? []) {
        byName.set(alias, byName.has(alias) ? null : fact)
      }
    }
    const resolved = requested
      .map((reference) => byId.get(reference) ?? byName.get(reference))
      .filter((fact): fact is Fact => Boolean(fact && fact.projectId === projectId))
    if (resolved.length === 0) return ''
    return `## 必要事实引用（仅以下已解析事实）\n\n${resolved
      .map((fact) => `- ${compactPromptText(fact.name, 60)}：${compactPromptText(fact.detail, 240)}`)
      .join('\n')}`
  }

  /** Select only entities explicitly mentioned by structured review findings. */
  buildReviewFactPack(
    projectId: string,
    findingTexts: readonly string[],
    explicitReferences?: readonly string[],
    boundary?: ChapterBoundaryContext,
  ): string {
    const reviewText = findingTexts.join('\n')
    const mentioned = [
      ...this.stores.listCharacters(projectId),
      ...this.stores.listConflicts(projectId),
      ...this.stores.listForeshadowing(projectId),
      ...this.stores.listClues(projectId),
      ...this.stores.listFactions(projectId),
      ...this.stores.listLocations(projectId),
      ...this.stores.listItems(projectId),
      ...this.stores.listWorldElements(projectId),
      ...this.stores.listWorldRules(projectId),
    ].flatMap((entity) => {
      const name = 'name' in entity ? entity.name : 'rule' in entity ? entity.rule : entity.description
      return reviewText.includes(entity.id) || (name.length >= 2 && reviewText.includes(name))
        ? [entity.id]
        : []
    })
    const characters = new Map(this.stores.listCharacters(projectId).map((entity) => [entity.id, entity.name]))
    for (const relationship of this.stores.listRelationships(projectId)) {
      const characterA = characters.get(relationship.characterA) ?? relationship.characterA
      const characterB = characters.get(relationship.characterB) ?? relationship.characterB
      if (reviewText.includes(relationship.id)
        || (reviewText.includes(characterA) && reviewText.includes(characterB))) {
        mentioned.push(relationship.id)
      }
    }
    return this.buildReferenceFactPack(
      projectId,
      [...(explicitReferences ?? []), ...mentioned],
      boundary,
    )
  }

  /**
   * 按 Agent 职责编译当前项目的文风档案，供预览和日志审计复用。
   *
   * 诊断行为：当 profile 不存在或样本为空时打 console.warn，让用户能从日志看到
   * 文风档案未生效的根因（用户经常以为档案已配置实际未保存，或样本被前端
   * < 20 字符过滤规则静默丢弃）。不打断创作流程，仅告警。
   */
  buildWritingStylePrompt(
    projectId: string,
    target: WritingStylePromptTarget,
    styleExpertIds?: string[],
  ): ReturnType<typeof compileWritingStylePrompt> | undefined {
    const profile = this.stores.getWritingStyleProfile?.(projectId)
    if (!profile) {
      console.warn(
        `[Novel] 文风档案未生效：projectId=${projectId} 未配置 writingStyleProfile。` +
          `writer/reviser/reviewer 将不带文风约束，请前往项目设置配置档案。`
      )
      return undefined
    }
    if (
      (profile.positiveExamples?.length ?? 0) === 0 &&
      (profile.negativeExamples?.length ?? 0) === 0
    ) {
      console.warn(
        `[Novel] 文风档案样本为空：projectId=${projectId} positiveExamples 和 negativeExamples 均为空。` +
          `常见原因：前端编辑器过滤了长度 < 20 字符的样本（见 writing-style-profile-editor.tsx:392-397）。` +
          `档案已注入但缺乏正反样本引导，LLM 可能不严格遵循。`
      )
    }
    return compileWritingStylePrompt(selectStyleExperts(profile, styleExpertIds), target)
  }

  // ═══════════════════════════════════════════════════════════════
  // 系统提示词（STATIC 层 - 跨章节缓存命中）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 构建系统提示词
   *
   * ⚠️ 此方法只读取静态数据，不读取动态状态，也不读取角色定义。
   * 系统提示词在整个项目生命周期内保持不变（除非世界规则/风格/势力/地点被修改）。
   * 这确保 LLM 提供商的 prompt cache 能跨章节命中。
   *
   * 角色定义不放在系统提示词的原因：
   * - 角色数量可能很大（200+），全部塞系统提示词会导致上下文爆炸
   * - 本章出场角色已通过 arrangedEntities 编排好，只需注入这些角色的完整定义
   * - 其他角色 LLM 通过 formatStoryState 知道存在（name+动态状态），需要详情时调 query_state 工具
   *
   * 势力 / 地点 / 世界要素 上提到系统提示词的原因：
   * - 数量有限（通常几十个），不会导致上下文爆炸
   * - 静态档案跨章稳定（name / description / type 等极少变）
   * - 上提后 system prompt 长度提升到缓存阈值之上，提升缓存命中率
   *
   * 构建顺序（从最稳定到最不稳定）：
   * 1. 世界规则（项目级，极少变）              ← 高命中率
   * 2. 风格指南（项目级，极少变）              ← 高命中率
   * 3. 势力/地点/世界要素静态档案（项目级）     ← 高命中率
   * 4. Agent 身份（Agent 专属）                ← 同 Agent 跨章不变
   */
  buildSystemPrompt(projectId: string, agentType: string): string {
    void agentType
    const parts: string[] = []
    const compact = (value: string, maxLength: number): string => {
      const normalized = value.trim()
      if (normalized.length <= maxLength) return normalized
      const headLength = Math.round(maxLength * 0.72)
      const tailLength = maxLength - headLength
      return `${normalized.slice(0, headLength)}\n\n[中段已压缩，按本章矩阵实体按需查询]\n\n${normalized.slice(-tailLength)}`
    }

    // ── 共享前缀（跨 Agent 相同，跨章不变，最大化 prompt cache 命中）──
    // 顺序：全书大纲 → 卷纲 → 世界规则 → 风格指南 → Agent 身份
    // 共享部分在前，Agent 专属部分在后，确保不同 Agent 的前缀相同可共享缓存。

    // ── Layer -1: 全书大纲 + 当前卷纲（项目级，跨 Agent 共享，跨章不变）──
    // 全书大纲让 Director 规划时不偏离主线走向，Writer 创作时知道故事全局方向。
    // 卷纲让 Director 和 Writer 明确当前卷的起承转合和核心冲突。
    const project = this.stores.getProject(projectId)
    if (project) {
      if (project.synopsis?.trim()) {
        parts.push(`## 故事简介\n\n${compact(project.synopsis, SYSTEM_BUDGET.synopsis)}`)
      }
      if (project.outline?.trim()) {
        parts.push(`## 全书大纲\n\n${compact(project.outline, SYSTEM_BUDGET.outline)}`)
      }
      // 注入当前卷纲 + 相邻卷纲摘要
      const volumes = this.stores.listVolumes(projectId)
      const currentVolNum = project.currentVolume
      const currentVol = volumes.find((v) => v.volumeNumber === currentVolNum)
      const prevVol = volumes.find((v) => v.volumeNumber === currentVolNum - 1)
      const nextVol = volumes.find((v) => v.volumeNumber === currentVolNum + 1)

      // 前卷纲要回顾：让 Director/Writer 知道上一卷的收束情况，避免断裂
      if (prevVol?.outline?.trim()) {
        parts.push(
          `## 前卷回顾（第${prevVol.volumeNumber}卷《${prevVol.title}》）\n\n${compact(prevVol.outline, SYSTEM_BUDGET.previousVolumeOutline)}`
        )
      }
      // 当前卷纲：Director 规划必须服务于此
      if (currentVol?.outline?.trim()) {
        parts.push(
          `## 当前卷纲（第${currentVol.volumeNumber}卷《${currentVol.title}》）\n\n${compact(currentVol.outline, SYSTEM_BUDGET.currentVolumeOutline)}`
        )
      }
      // 下卷预告：让 Director 在卷末规划时能提前衔接下一卷方向
      if (nextVol?.outline?.trim()) {
        parts.push(
          `## 下卷方向（第${nextVol.volumeNumber}卷《${nextVol.title}》）\n\n${compact(nextVol.outline, SYSTEM_BUDGET.nextVolumeOutline)}`
        )
      }
    }

    // ── Layer 1: 世界规则（项目级，跨 Agent 共享，跨章不变）──
    // 双键排序：category 业务分组 + id 稳定次序键。
    // 仅按 category 排序在相同 category 多行时仍可能不稳定（依赖上游 SQL 顺序），
    // 加 id 作为次序键确保完全确定性，最大化 prompt cache 命中率。
    const worldRules = this.stores.listWorldRules(projectId)
    if (worldRules.length > 0) {
      const sorted = [...worldRules]
        .sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id))
        .slice(0, SYSTEM_BUDGET.worldRuleCount)
      parts.push(this.formatWorldRules(sorted))
    }

    // ── Layer 2: 风格指南（项目级，跨 Agent 共享，跨章不变）──
    // 双键排序：category + id（同上）
    const styleGuide = this.stores.listStyleGuide(projectId)
    if (styleGuide.length > 0) {
      const sorted = [...styleGuide]
        .sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id))
        .slice(0, SYSTEM_BUDGET.styleGuideCount)
      parts.push(this.formatStyleGuide(sorted))
    }

    // 势力、地点、世界要素不再整库塞入 STATIC 层。本章需要的实体由矩阵在
    // buildChapterContextShared 中注入；未编排实体可通过只读工具按需查询。

    // ⚠️ 缓存关键：Agent 身份段（system-base.md + agent_type + agent_role）已从此处移除，
    // 改为在 DYNAMIC 层 userMessage 开头注入（见 buildAgentIdentity）。
    //
    // 原设计把身份段放在 systemPrompt 末尾，假设"前面的共享部分可跨 Agent 缓存命中"。
    // 但 provider 端的 cache_control breakpoint 打在 system 末尾，整个 system 是一个缓存块，
    // 只要末尾的 agent_type 不同，整个 system 块就 cache miss——4 个 Agent 的 system
    // 各不相同，跨 Agent 缓存全部失效。
    //
    // 移除身份段后，4 个 Agent 的 systemPrompt 完全相同（故事简介+大纲+卷纲+世界规则+
    // 风格指南+实体档案），provider 端能跨 Agent 命中 system 缓存，大幅提升命中率。

    return parts.join('\n\n---\n\n')
  }

  /**
   * 构建 Agent 身份段（原 STATIC 层末尾的 system-base.md 渲染）。
   *
   * 已从 buildSystemPrompt 移到 DYNAMIC 层 userMessage 开头注入，
   * 避免 agent_type 差异导致整个 system 缓存块失效。
   * 调用方：NovelOrchestrator.runAgent 在拼接 inputText 时调用。
   *
   * @param discussion 是否为群聊共创模式。true 时优先加载 `role-{agentType}-discussion`
   *   模板（如 role-director-discussion.md 含场景拆分格式、role-writer-discussion.md
   *   含剧本编织约束、role-character-actor.md 含剧本演出格式）。
   *   群聊模式必须传 true，否则 Agent 不知道自己的群聊职责，会出现 Director 直接写正文等问题。
   */
  buildAgentIdentity(projectId: string, agentType: string, discussion = false, styleExpertIds?: string[]): string {
    const identity = this.promptManager.render(
      'system-base',
      {
        agent_type: agentType,
        agent_role: this.getAgentRoleDescription(agentType, projectId, discussion)
      },
      projectId
    )
    // 写作铁律只注入给需要创作正文的 Agent（writer/reviser/reviewer/prose_editor）。
    // Director 只做规划不写正文，注入铁律浪费 token 且破坏缓存稳定性。
    // 修复（2026-07-18）：铁律从 system-base.md 拆分到 system-base-rules.md，
    // 按需注入，避免 Director/Memory 被铁律示范破折号污染。
    const needsWritingRules =
      agentType === 'writer' || agentType === 'reviser' || agentType === 'reviewer'
    let result = identity
    if (needsWritingRules) {
      const rules = this.promptManager.getTemplate('system-base-rules', projectId)
      if (rules) result = `${result}\n\n---\n\n${rules}`
    }
    if (agentType !== 'writer' && agentType !== 'reviser' && agentType !== 'reviewer') {
      this.guardAgentIdentity(agentType, result)
      return result
    }
    const compiledStyle = this.buildWritingStylePrompt(
      projectId,
      agentType as WritingStylePromptTarget,
      styleExpertIds,
    )
    const final = compiledStyle ? `${result}\n\n---\n\n${compiledStyle.content}` : result
    this.guardAgentIdentity(agentType, final)
    return final
  }

  /**
   * 构建由 Skill 提供角色方法时的 Reviewer 基础身份壳。
   *
   * 保留 system-base、写作铁律和项目文风，但不再嵌入 role-reviewer 正文，
   * 避免同一套审稿规则同时从旧模板和 Skill 注入两次。
   */
  getReviewerSkillPath(projectId: string): string | undefined {
    return this.promptManager.getDefaultTemplatePath('role-reviewer', projectId)
  }

  buildReviewerSkillIdentity(projectId: string, styleExpertIds?: string[]): string {
    const identity = this.promptManager.render(
      'system-base',
      {
        agent_type: 'reviewer',
        agent_role: '具体审稿方法由本次显式加载的 novel-reviewer Skill 提供。',
      },
      projectId,
    )
    const rules = this.promptManager.getTemplate('system-base-rules', projectId)
    const withRules = rules ? `${identity}\n\n---\n\n${rules}` : identity
    const compiledStyle = this.buildWritingStylePrompt(projectId, 'reviewer', styleExpertIds)
    return compiledStyle ? `${withRules}\n\n---\n\n${compiledStyle.content}` : withRules
  }

  /**
   * 构建由 Skill 提供角色方法时的 Director 基础身份壳。
   *
   * 与 buildAgentIdentity 的 director 分支保持一致：Director 只做规划不写正文，
   * 不注入铁律（system-base-rules）与项目文风，避免示范破折号污染规划输出。
   * 角色方法（决策顺序、场景动力契约、novel_submit_narrative_task 协议）由
   * 本次显式加载的 novel-director Skill 提供，这里不再嵌入 role-director 正文。
   */
  getDirectorSkillPath(projectId: string): string | undefined {
    return this.promptManager.getDefaultTemplatePath('role-director', projectId)
  }

  buildDirectorSkillIdentity(projectId: string): string {
    return this.promptManager.render(
      'system-base',
      {
        agent_type: 'director',
        agent_role: '具体规划方法由本次显式加载的 novel-director Skill 提供。',
      },
      projectId,
    )
  }

  /**
   * 构建由 Skill 提供角色方法时的 Writer 基础身份壳。
   *
   * 与 buildAgentIdentity 的 writer 分支保持一致：保留 system-base、写作铁律
   * （system-base-rules）与项目文风，不嵌入 role-writer 正文（由本次显式加载的
   * novel-writer Skill 展开提供）。
   */
  getWriterSkillPath(projectId: string): string | undefined {
    return this.promptManager.getDefaultTemplatePath('role-writer', projectId)
  }

  buildWriterSkillIdentity(projectId: string, styleExpertIds?: string[]): string {
    const identity = this.promptManager.render(
      'system-base',
      {
        agent_type: 'writer',
        agent_role: '具体创作方法由本次显式加载的 novel-writer Skill 提供。',
      },
      projectId,
    )
    const rules = this.promptManager.getTemplate('system-base-rules', projectId)
    const withRules = rules ? `${identity}\n\n---\n\n${rules}` : identity
    const compiledStyle = this.buildWritingStylePrompt(projectId, 'writer', styleExpertIds)
    return compiledStyle ? `${withRules}\n\n---\n\n${compiledStyle.content}` : withRules
  }

  /**
   * 构建由 Skill 提供角色方法时的 Reviser 基础身份壳。
   *
   * 与 buildAgentIdentity 的 reviser 分支保持一致：保留 system-base、写作铁律与
   * 项目文风，不嵌入 role-reviser 正文；novel_apply_revision 工具协议由
   * novel-reviser Skill 展开提供，与 extraTools 注入的工具实例叠加。
   */
  getReviserSkillPath(projectId: string): string | undefined {
    return this.promptManager.getDefaultTemplatePath('role-reviser', projectId)
  }

  buildReviserSkillIdentity(projectId: string, styleExpertIds?: string[]): string {
    const identity = this.promptManager.render(
      'system-base',
      {
        agent_type: 'reviser',
        agent_role: '具体修订方法由本次显式加载的 novel-reviser Skill 提供。',
      },
      projectId,
    )
    const rules = this.promptManager.getTemplate('system-base-rules', projectId)
    const withRules = rules ? `${identity}\n\n---\n\n${rules}` : identity
    const compiledStyle = this.buildWritingStylePrompt(projectId, 'reviser', styleExpertIds)
    return compiledStyle ? `${withRules}\n\n---\n\n${compiledStyle.content}` : withRules
  }

  /**
   * 构建由 Skill 提供角色方法时的 Memory 基础身份壳（工具循环回退路径）。
   *
   * Memory 只提取状态变更：与 buildAgentIdentity 的 memory 分支一致，不注入铁律与
   * 文风；角色方法（工具使用指南）由本次显式加载的 novel-memory Skill 提供。
   */
  getMemorySkillPath(projectId: string): string | undefined {
    return this.promptManager.getDefaultTemplatePath('role-memory', projectId)
  }

  buildMemorySkillIdentity(projectId: string): string {
    return this.promptManager.render(
      'system-base',
      {
        agent_type: 'memory',
        agent_role: '具体提取方法由本次显式加载的 novel-memory Skill 提供。',
      },
      projectId,
    )
  }

  /**
   * 构建由 Skill 提供角色方法时的 Memory Generator 基础身份壳（纯 JSON 提取路径）。
   *
   * 用于 NovelMemoryGenerator 的 analyze / runFullCalibration：与旧
   * buildAgentIdentity('memory-generator') 一致不注入铁律与文风；角色方法（实体轨道
   * 归类、纯 JSON 输出协议）由本次显式加载的 novel-memory-generator Skill 提供。
   */
  getMemoryGeneratorSkillPath(projectId: string): string | undefined {
    return this.promptManager.getDefaultTemplatePath('role-memory-generator', projectId)
  }

  buildMemoryGeneratorSkillIdentity(projectId: string): string {
    return this.promptManager.render(
      'system-base',
      {
        agent_type: 'memory-generator',
        agent_role: '具体提取方法由本次显式加载的 novel-memory-generator Skill 提供。',
      },
      projectId,
    )
  }

  /**
   * 构建群聊模式下由 Skill 提供角色方法时的基础身份壳。
   *
   * 对应 buildAgentIdentity(projectId, agentType, discussion=true) 的旧路径：
   * director 只保留 system-base（不注入铁律/文风）；writer/reviser/reviewer 额外
   * 保留铁律与项目文风。群聊职责正文由 novel-{agentType}-discussion Skill 展开提供。
   * role-{agentType}-discussion 模板不存在（如 reviser）或项目/SQLite 覆盖时，
   * 调用方应通过 getDiscussionSkillPath 返回 undefined 并回退旧身份路径。
   */
  getDiscussionSkillPath(agentType: string, projectId: string): string | undefined {
    return this.promptManager.getDefaultTemplatePath(`role-${agentType}-discussion`, projectId)
  }

  buildDiscussionSkillIdentity(agentType: string, projectId: string, styleExpertIds?: string[]): string {
    const identity = this.promptManager.render(
      'system-base',
      {
        agent_type: agentType,
        agent_role: `具体群聊职责由本次显式加载的 novel-${agentType}-discussion Skill 提供。`,
      },
      projectId,
    )
    if (agentType !== 'writer' && agentType !== 'reviser' && agentType !== 'reviewer') {
      return identity
    }
    const rules = this.promptManager.getTemplate('system-base-rules', projectId)
    const withRules = rules ? `${identity}\n\n---\n\n${rules}` : identity
    const compiledStyle = this.buildWritingStylePrompt(
      projectId,
      agentType as WritingStylePromptTarget,
      styleExpertIds,
    )
    return compiledStyle ? `${withRules}\n\n---\n\n${compiledStyle.content}` : withRules
  }

  /**
   * 构建由 Skill 提供角色方法时的角色演员基础身份壳（群聊单角色调用）。
   *
   * 角色卡字段与声音参数由 buildCharacterIdentityPrompt 拼在薄壳之前；
   * 演出方法（剧本格式、演出规则）由 novel-character-actor Skill 展开提供。
   * 合并演出路径不展开 Skill，改用 buildMergedActorIdentityPrompt 的完整模板身份。
   */
  getCharacterActorSkillPath(projectId: string): string | undefined {
    return this.promptManager.getDefaultTemplatePath('role-character-actor', projectId)
  }

  buildCharacterActorSkillIdentity(projectId: string): string {
    return this.promptManager.render(
      'system-base',
      {
        agent_type: 'character-actor',
        agent_role: '具体演出方法由本次显式加载的 novel-character-actor Skill 提供。',
      },
      projectId,
    )
  }

  /** 构建由 Skill 提供角色方法时的实体反推基础身份壳（正文反推路径）。 */
  getEntityExtractorSkillPath(projectId: string): string | undefined {
    return this.promptManager.getDefaultTemplatePath('role-entity-extractor', projectId)
  }

  buildEntityExtractorSkillIdentity(projectId: string): string {
    return this.promptManager.render(
      'system-base',
      {
        agent_type: 'entity-extractor',
        agent_role: '具体反推方法由本次显式加载的 novel-entity-extractor Skill 提供。',
      },
      projectId,
    )
  }

  /** 构建由 Skill 提供角色方法时的矩阵编排基础身份壳（章纲编排路径）。 */
  getMatrixArrangerSkillPath(projectId: string): string | undefined {
    return this.promptManager.getDefaultTemplatePath('role-matrix-arranger', projectId)
  }

  buildMatrixArrangerSkillIdentity(projectId: string): string {
    return this.promptManager.render(
      'system-base',
      {
        agent_type: 'matrix-arranger',
        agent_role: '具体编排方法由本次显式加载的 novel-matrix-arranger Skill 提供。',
      },
      projectId,
    )
  }

  /**
   * 统一小说创作入口 Skill。它只负责模式识别和意图协议，不替代具体
   * Director/Writer/Discussion/Entity 服务，也不直接持久化领域数据。
   */
  getNovelCreationSkillPath(projectId: string): string | undefined {
    return this.promptManager.getDefaultTemplatePath('novel-creation', projectId)
  }

  /** 项目级 lengdu Skill：供独立校准与 Reader 工作流按路径加载，不参与默认 Skill 扫描。 */
  getLengduSkillPath(): string | undefined {
    return this.promptManager.getExternalSkillPath('lengdu', 'PI_LENGDU_SKILL_PATH')
  }

  buildNovelCreationSkillIdentity(projectId: string): string {
    return this.promptManager.render(
      'system-base',
      {
        agent_type: 'novel-creation',
        agent_role: '模式识别和创作意图协议由本次显式加载的 novel-creation Skill 提供。',
      },
      projectId,
    )
  }

  /**
   * P3 T03-6：identity-contract 守卫——所有 buildAgentIdentity 消费方统一覆盖。
   *
   * 校验身份文本是否包含 AGENT_IDENTITY_MARKERS（职责协议锚点），缺失时 warn
   * （不 throw：模板可能合法演进，但必须留痕让测试与运维发现漂移）。
   * 五角色之外的 agentType（character-generator / similarity-scanner 等）
   * markers 为空，validateAgentIdentity.ok 仅校验字符上界。
   */
  private guardAgentIdentity(agentType: string, identityText: string): void {
    const report = validateAgentIdentity(agentType, identityText)
    if (!report.ok) {
      const msg = `[identity-contract] Agent ${agentType} 身份契约漂移：missing=${report.missingMarkers.join(',')} totalChars=${report.totalChars}`
      this.identityLogger?.warn(msg, { agentType, missingMarkers: report.missingMarkers, totalChars: report.totalChars })
    }
  }

  /** 盲审文字编辑身份：不携带章节规划，只保留文字职责和项目文风档案。 */
  buildProseEditorIdentity(projectId: string, styleExpertIds?: string[]): string {
    const identity = this.promptManager.render(
      'system-base',
      {
        agent_type: 'prose_editor',
        agent_role: this.promptManager.getTemplate('role-prose-editor', projectId)
      },
      projectId
    )
    // prose_editor 也需要铁律
    const rules = this.promptManager.getTemplate('system-base-rules', projectId)
    const withRules = rules ? `${identity}\n\n---\n\n${rules}` : identity
    const compiledStyle = this.buildWritingStylePrompt(projectId, 'reviewer', styleExpertIds)
    return compiledStyle ? `${withRules}\n\n---\n\n${compiledStyle.content}` : withRules
  }

  // ═══════════════════════════════════════════════════════════════
  // 章节上下文（SEMI 层 - 单章内缓存命中）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 构建章节上下文 - 共享前缀部分（SEMI 层 shared，跨 Agent 完全相同）
   *
   * 此部分包含所有 Agent 都需要的、跨 Agent 完全一致的章节上下文。
   * 通过 prefixUserMessage 数组的第一条注入，打 cache_control breakpoint 后
   * 能跨 Agent 命中 prompt cache（Director 写入 → Writer/Reviewer/Reviser/Memory 命中）。
   *
   * ⚠️ 缓存关键：此方法的输出必须对所有 Agent 完全一致（不依赖 agentType）。
   * 任何 Agent 专属内容都应放入 buildChapterContextSuffix。
   *
   * 包含（顺序即 prompt 中的出现顺序）：
   *  1. 本章写作核心（卷/章号 + 本章要完成的事 + 用户章纲）
   *  2. 创作约束（事实/认知/阶段/叙事债务/角色弧光/冲突推进/节奏/悬念/POV/场景数/时间线）
   *  3. 本章出场要素（仅在有 arrangedEntities 时）
   *  4. 当前故事状态（仅在**无** arrangedEntities 时兜底）
   *  5. 账本承接（需 memoryStore 提供 getChapterStoryContext）
   *  6. 实体关联（画布手动连线 + 派生边）
   *  7. 信息差
   *  8. 最近章节摘要（最近 5 章）
   *  9. 上一章结尾
   * 10. 叙事声音锚点
   * 11. 下一章开头（重写中间章时的兼容锚点）
   * 12. 未兑现钩子
   * 13. 文风指纹（指标可信时才升级为硬约束）
   */
  buildChapterContextShared(
    projectId: string,
    chapterNumber: number,
    narrativeTask: NarrativeTask,
    constraints: ChapterConstraints,
    arrangedEntities?: ArrangedEntity,
    options?: { mode?: 'full' | 'diff'; askStoryEnabled?: boolean; entitySummaryMode?: 'full' | 'summary'; agentType?: string }
  ): string {
    // mode='diff' 时委托给增量 diff 模式：用全局关键事实摘要 + 上一章变化 delta
    // 替代全量故事状态（formatStoryState）和事件账本承接（formatStoryLedgerContext），
    // 大幅减少字符数。默认（不传或 'full'）走原有逻辑，保持向后兼容。
    if (options?.mode === 'diff') {
      return this.buildChapterContextDiff(
        projectId,
        chapterNumber,
        narrativeTask,
        constraints,
        arrangedEntities,
        options.askStoryEnabled ?? true,
      )
    }
    // T03-2 等价拆块：full 模式统一由 chunk 版构建，join 结果与旧字符串逐字节一致。
    return this.stripEmDash(
      this.buildChapterContextChunks(projectId, chapterNumber, narrativeTask, constraints, arrangedEntities, options)
        .map((c) => c.content)
        .join('\n\n---\n\n'),
    )
  }

  /**
   * P4 接入 4：把 chunk 数组组装为 shared 字符串（join + stripEmDash）。
   * 与 buildChapterContextShared 的最终组装一致，供 orchestrator 在 chunk 缓存
   * （§5.6 buildWithChunkCache）命中后直接组装，避免重复构建。
   */
  assembleSharedFromChunks(chunks: Array<{ chunkId: string; content: string }>): string {
    return this.stripEmDash(chunks.map((c) => c.content).join('\n\n---\n\n'))
  }

  /**
   * P4 接入 3：按角色组装 shared（flag contextChunksEnabled 开时由 orchestrator 调用）。
   *
   * 与 buildChapterContextShared 的差异：options.agentType 传入时按角色策略
   * （resolveChunkMode）过滤 disabled chunk——角色差异化组装，未传时与现状逐字节等价。
   */
  buildChapterContextSharedForAgent(
    projectId: string,
    chapterNumber: number,
    narrativeTask: NarrativeTask,
    constraints: ChapterConstraints,
    arrangedEntities?: ArrangedEntity,
    options?: { askStoryEnabled?: boolean; agentType?: string; entitySummaryMode?: 'full' | 'summary' },
  ): string {
    const chunks = this.buildChapterContextChunks(
      projectId, chapterNumber, narrativeTask, constraints, arrangedEntities,
      {
        askStoryEnabled: options?.askStoryEnabled ?? true,
        agentType: options?.agentType,
        entitySummaryMode: options?.entitySummaryMode,
      },
    )
    return this.stripEmDash(chunks.map((c) => c.content).join('\n\n---\n\n'))
  }

  /**
   * T03-4 生产决策：根据章前故事状态选择 story-state full/summary。
   *
   * 当前生成层没有统一暴露模型 contextWindow，因此只在实体数超过阈值时
   * 安全降级；预算未知不压缩小项目，满足"必要事实不丢失"。
   */
  chooseChapterEntitySummaryMode(
    projectId: string,
    chapterNumber: number,
    arrangedEntities?: ArrangedEntity,
  ): 'full' | 'summary' {
    if (this.hasArrangedEntities(arrangedEntities)) return 'full'
    const state = this.getChapterBoundaryContext(projectId, chapterNumber).state
    const entityCount = state.characters.length
      + state.relationships.length
      + state.activeConflicts.length
      + state.pendingForeshadowing.length
      + state.activeClues.length
      + state.activeFactions.length
      + state.activeLocations.length
      + state.items.length
    return chooseEntityChunkMode({
      entityCount,
      fullTokens: estimateChunkTokens(this.formatStoryState(state, true).length),
      // 未接入 modelRegistry.contextWindow 时给足预算，实体数阈值仍能保护大档案。
      remainingBudget: Number.POSITIVE_INFINITY,
    })
  }

  /**
   * T03-2 等价拆块：按 ContextChunk 目录输出 shared 层的 chunk 化结构（full 模式）。
   *
   * 每个 chunk 复用现有 format 方法（与旧 parts.push 完全相同的构建逻辑与顺序），
   * join 结果与 buildChapterContextShared 返回的字符串**逐字节一致**（由测试钉死）。
   * contextChunksEnabled flag 开启后，T03-3/4/7 在此结构上按 chunk 降级。
   */
  buildChapterContextChunks(
    projectId: string,
    chapterNumber: number,
    narrativeTask: NarrativeTask,
    constraints: ChapterConstraints,
    arrangedEntities?: ArrangedEntity,
    options?: { mode?: 'full' | 'diff'; askStoryEnabled?: boolean; entitySummaryMode?: 'full' | 'summary'; agentType?: string },
  ): Array<{ chunkId: string; content: string }> {
    if (options?.mode === 'diff') {
      // diff 模式暂不拆 chunk（独立优化路径，后续单独 chunk 化）
      return [{ chunkId: 'story-ledger', content: this.buildChapterContextDiff(
        projectId, chapterNumber, narrativeTask, constraints, arrangedEntities,
        options.askStoryEnabled ?? true,
      ) }]
    }
    void constraints // constraints 已在 formatConstraints 中使用，此处 void 避免未使用警告
    const chunks: Array<{ chunkId: string; content: string }> = []
    const relevantEntityIds = this.collectRelevantEntityIds(arrangedEntities)
    const boundary = this.getChapterBoundaryContext(projectId, chapterNumber)

    // ── 章节信息 ──
    chunks.push({ chunkId: 'chapter-info', content: this.formatChapterInfo(projectId, chapterNumber, narrativeTask) })

    // ── 创作约束 ──
    chunks.push({ chunkId: 'chapter-constraints', content: this.formatConstraints(constraints) })

    // ── 本章已编排实体约束（手动编排 / AI 编排产出，注入 SEMI 层）──
    const hasArranged = this.hasArrangedEntities(arrangedEntities)
    if (hasArranged && arrangedEntities) {
      chunks.push({ chunkId: 'arranged-entities', content: this.formatArrangedEntities(projectId, chapterNumber, arrangedEntities, boundary) })
    }

    // 已编排时，角色短卡和实体要素已经给出本章所需的状态。
    // 不再重复注入全量故事状态；它会把无关角色和旧线索挤进上下文中心。
    if (!hasArranged) {
      // T03-4：story-state 支持 summary 模式（实体档案降级），由调用方按
      // chooseEntityChunkMode 决策后传入；默认 full 保持逐字节等价。
      chunks.push({
        chunkId: 'story-state',
        content: this.buildStoryStateChunk(boundary, options),
      })
      // 无编排是旧项目/降级项目的常见路径，不能因为没有 arrangedEntities 就丢掉角色声音。
      // formatStoryState 只给状态和目标；声音对照表仍需单独注入，否则 Writer 在这条路径
      // 上会退回模型默认腔，造成"有编排时角色有差异、无编排时全部同声"的流程分叉。
      const stateCharacters = boundary.state.characters.filter((character) => (
        !/（待定）|待补充|待定$|^新的$|^测试角色/.test(character.name)
      ))
      const voiceTable = formatVoiceContrastTable(buildVoiceProfiles(stateCharacters))
      if (voiceTable) chunks.push({ chunkId: 'voice-contrast', content: voiceTable })
    }

    // ── 事件账本时间切片 ──
    // 生成中间章节时不能读取未来章节已经写入实体快照的结果。事件账本按当前章
    // 之前的最后一条原子变化重建章前状态，同时显式提供本章计划和未来承诺。
    if (this.memoryStore?.getChapterStoryContext) {
      const ledgerContext = this.memoryStore.getChapterStoryContext(projectId, chapterNumber)
      // 反查实体显示名，避免在提示词里暴露 UUID（AI 不需要 ID 来理解故事）
      const nameMap = boundary.fromSnapshot
        ? this.buildBoundaryEntityNameMap(projectId, boundary.entities)
        : this.buildSubjectNameMap(projectId, ledgerContext)
      this.injectSubjectNames(ledgerContext, nameMap)
      const ledgerSection = this.formatStoryLedgerContext(ledgerContext, arrangedEntities, nameMap)
      if (ledgerSection) chunks.push({ chunkId: 'story-ledger', content: ledgerSection })
    }

    // ── 实体关联（画布手动 + 派生自动边，作为故事状态的补充）──
    // C3 增强：通过 RelationshipGraph 拿到派生边（冲突参与/势力敌对/盟友/地点归属等 7 类），
    // 让 LLM 显式看到这些关系，无需从实体 description 自行推断。
    // 未注入 relationshipGraph 时降级到 stores.listEdges（仅手动边），保持向后兼容。
    const edges =
      arrangedEntities && relevantEntityIds.size === 0
        ? []
        : this.collectRelevantEdges(projectId, relevantEntityIds, boundary)
    if (edges.length > 0) {
      const edgeSection = this.formatEdges(projectId, edges, boundary)
      if (edgeSection) chunks.push({ chunkId: 'entity-edges', content: edgeSection })
    }

    // ── 信息差 ──
    const infoLayers = this.filterRelevantInfoLayers(
      boundary.entities.informationLayers,
      arrangedEntities,
      boundary
    )
    if (infoLayers.length > 0) {
      chunks.push({ chunkId: 'info-layers', content: this.formatInfoLayers(projectId, infoLayers, arrangedEntities, boundary) })
    }

    // ── 前后章锚点（摘要 / 上一章结尾 / 声音锚点 / 下一章开头 / 未兑现钩子 / 文风指纹）──
    chunks.push(...this.collectChapterAnchorChunks(projectId, chapterNumber))

    // P4 接入 2：角色策略过滤（T03-3 resolveChunkMode）——传 agentType 时移除
    // 显式 disabled 的 chunk（如 director/reviewer/memory 不需要的声音对照）。
    // 未传 agentType（默认/等价性路径）不做任何过滤，保持逐字节等价。
    if (options?.agentType) {
      return chunks.filter((c) => resolveChunkMode(options.agentType!, c.chunkId) !== 'disabled')
    }

    return chunks
  }

  /**
   * §5.6 先查后建：返回 shared chunk 的惰性构建器。
   *
   * 与 buildChapterContextChunks 保持相同的目录、顺序和过滤规则，但不提前读取
   * boundary / ledger / edges / anchors。缓存命中时对应 build() 完全不会执行。
   * optional chunk 用 null 表示不产出，由 lazy cache 以空哨兵记住。
   */
  buildChapterContextChunkBuilders(
    projectId: string,
    chapterNumber: number,
    narrativeTask: NarrativeTask,
    constraints: ChapterConstraints,
    arrangedEntities?: ArrangedEntity,
    options?: { mode?: 'full' | 'diff'; askStoryEnabled?: boolean; entitySummaryMode?: 'full' | 'summary'; agentType?: string },
  ): LazyChunkBuilder[] {
    const scopeSource = JSON.stringify({
      chapterNumber,
      narrativeTask,
      constraints,
      arrangedEntities: arrangedEntities ?? null,
      mode: options?.mode ?? 'full',
      askStoryEnabled: options?.askStoryEnabled ?? true,
      entitySummaryMode: options?.entitySummaryMode ?? 'full',
      agentType: options?.agentType ?? '',
    })
    const scope = createHash('sha256').update(scopeSource).digest('hex').slice(0, 16)
    const enabled = (chunkId: string): boolean =>
      !options?.agentType || resolveChunkMode(options.agentType, chunkId) !== 'disabled'
    const builder = (chunkId: string, build: () => string | null): LazyChunkBuilder => ({
      chunkId,
      scope,
      build,
    })

    if (options?.mode === 'diff') {
      return enabled('story-ledger')
        ? [builder('story-ledger', () => this.buildChapterContextDiff(
            projectId,
            chapterNumber,
            narrativeTask,
            constraints,
            arrangedEntities,
            options.askStoryEnabled ?? true,
          ))]
        : []
    }

    const hasArranged = this.hasArrangedEntities(arrangedEntities)
    const relevantEntityIds = this.collectRelevantEntityIds(arrangedEntities)
    let boundaryMemo: ReturnType<NovelPromptBuilder['getChapterBoundaryContext']> | undefined
    const boundary = (): ReturnType<NovelPromptBuilder['getChapterBoundaryContext']> =>
      boundaryMemo ??= this.getChapterBoundaryContext(projectId, chapterNumber)
    let anchorsMemo: Map<string, string> | undefined
    const anchor = (chunkId: string): string | null => {
      if (!anchorsMemo) {
        anchorsMemo = new Map(
          this.collectChapterAnchorChunks(projectId, chapterNumber).map((c) => [c.chunkId, c.content]),
        )
      }
      return anchorsMemo.get(chunkId) ?? null
    }

    const builders: LazyChunkBuilder[] = []
    if (enabled('chapter-info')) {
      builders.push(builder('chapter-info', () => this.formatChapterInfo(projectId, chapterNumber, narrativeTask)))
    }
    if (enabled('chapter-constraints')) {
      builders.push(builder('chapter-constraints', () => this.formatConstraints(constraints)))
    }
    if (hasArranged && arrangedEntities && enabled('arranged-entities')) {
      builders.push(builder('arranged-entities', () =>
        this.formatArrangedEntities(projectId, chapterNumber, arrangedEntities, boundary())))
    }
    if (!hasArranged) {
      if (enabled('story-state')) {
        builders.push(builder('story-state', () => this.buildStoryStateChunk(boundary(), options)))
      }
      if (enabled('voice-contrast')) {
        builders.push(builder('voice-contrast', () => {
          const stateCharacters = boundary().state.characters.filter((character) => (
            !/（待定）|待补充|待定$|^新的$|^测试角色/.test(character.name)
          ))
          return formatVoiceContrastTable(buildVoiceProfiles(stateCharacters)) || null
        }))
      }
    }
    if (this.memoryStore?.getChapterStoryContext && enabled('story-ledger')) {
      builders.push(builder('story-ledger', () => {
        const ledgerContext = this.memoryStore!.getChapterStoryContext!(projectId, chapterNumber)
        const b = boundary()
        const nameMap = b.fromSnapshot
          ? this.buildBoundaryEntityNameMap(projectId, b.entities)
          : this.buildSubjectNameMap(projectId, ledgerContext)
        this.injectSubjectNames(ledgerContext, nameMap)
        return this.formatStoryLedgerContext(ledgerContext, arrangedEntities, nameMap) || null
      }))
    }
    if (enabled('entity-edges')) {
      builders.push(builder('entity-edges', () => {
        const b = boundary()
        const edges = arrangedEntities && relevantEntityIds.size === 0
          ? []
          : this.collectRelevantEdges(projectId, relevantEntityIds, b)
        return edges.length > 0 ? this.formatEdges(projectId, edges, b) || null : null
      }))
    }
    if (enabled('info-layers')) {
      builders.push(builder('info-layers', () => {
        const b = boundary()
        const infoLayers = this.filterRelevantInfoLayers(
          b.entities.informationLayers,
          arrangedEntities,
          b,
        )
        return infoLayers.length > 0
          ? this.formatInfoLayers(projectId, infoLayers, arrangedEntities, b)
          : null
      }))
    }

    for (const chunkId of ['recent-recaps', 'prev-ending', 'sound-anchor', 'next-anchor', 'hooks', 'style-fingerprint']) {
      if (enabled(chunkId)) builders.push(builder(chunkId, () => anchor(chunkId)))
    }
    return builders
  }

  /**
   * 前后章锚点 section（full 与 diff 两种模式共用）。
   *
   * 产出顺序即 prompt 中的出现顺序：
   *   1. 最近章节摘要
   *   2. 上一章结尾（本章开头必须承接此处钩子）
   *   3. 叙事声音锚点（前文实际腔调示范）
   *   4. 下一章开头（重写中间章时的兼容锚点）
   *   5. 未兑现钩子
   *   6. 文风指纹
   *
   * 这一整段此前在 buildChapterContextShared 与 buildChapterContextDiff 里各有一份
   * 逐字相同的实现（含"必须按 chapterNumber 向前取"这条关键注释）。
   * 抽出来的目的不是省行数，而是让两种模式**不可能**在锚点逻辑上漂移。
   */
  private collectChapterAnchorSections(projectId: string, chapterNumber: number): string[] {
    return this.collectChapterAnchorChunks(projectId, chapterNumber).map((c) => c.content)
  }

  /**
   * 前后章锚点 chunk 标注版（T03-2 等价拆块）。
   * 与 collectChapterAnchorSections 同一实现（后者委托本方法），每段标注 chunkId：
   * recent-recaps / prev-ending / sound-anchor / next-anchor / hooks / style-fingerprint。
   */
  private collectChapterAnchorChunks(
    projectId: string,
    chapterNumber: number,
  ): Array<{ chunkId: string; content: string }> {
    const sections: Array<{ chunkId: string; content: string }> = []

    // ⚠️ 必须按当前章 chapterNumber 为基准向前取，不能用 listRecentChapters：
    // listRecentChapters 的 SQL 是 ORDER BY chapter_number DESC LIMIT N，返回的是
    // 全局章节号最大的 N 章，与"当前生成第几章"无关。当重新生成中间章节（如第 7 章）
    // 而后续章节（第 8、9 章）已有内容时，listRecentChapters 会返回 [9,8,7]，过滤当前章
    // 后变成 [8,9]——formatPreviousChapterEnding 会把第 9 章结尾当"上一章结尾"，
    // formatSoundAnchor 会把第 8、9 章开头当"叙事声音锚点"，剧情全面错乱。
    //
    // 历史问题（2026-07 修复）：旧实现只取最近 1 章，导致写第 30 章时 LLM 看不到
    // 第 1-28 章发生了什么，会重写"主角决定变强""发现师父阴谋"等已发生剧情。
    // 现在取最近 CHAPTER_ANCHOR_BUDGET.recentChapterCount 章：每章 recap 50-100 字，
    // 可控且足够建立"过去几章的剧情脉络"。
    const prevChapters: NovelChapter[] = []
    for (
      let n = chapterNumber - 1;
      n >= 1 && prevChapters.length < CHAPTER_ANCHOR_BUDGET.recentChapterCount;
      n--
    ) {
      const ch = this.stores.getChapter(projectId, n)
      if (ch && ch.content && ch.content.trim().length > 0) {
        prevChapters.push(ch)
      }
    }
    prevChapters.reverse() // 升序（旧→新）

    if (prevChapters.length > 0) {
      sections.push({ chunkId: 'recent-recaps', content: this.formatRecentSummaries(prevChapters) })

      // 上一章结尾 + 叙事声音锚点（向后看：本章开头承接此处钩子）。
      // 放 shared 层而非 suffix：Writer/Reviser/Reviewer 都需要且跨 Agent 完全一致，
      // 能让 director→writer→reviewer→reviser 之间多命中这部分缓存。
      const prevEnding = this.formatPreviousChapterEnding(prevChapters)
      if (prevEnding) sections.push({ chunkId: 'prev-ending', content: prevEnding })
      // 文风档案样本优先于自动声音锚点。直接复制上一章开头有一个隐蔽风险：
      // 如果上一章本身短段、泛化比喻或解释腔严重，下一章会把这些 AI 痕迹当成
      // “前文腔调”继续放大。formatSoundAnchor 内部先做确定性质量筛选，只有未命中
      // 严重形态问题的章节才有资格成为示范；不合格章节仍通过 recap/结尾承接剧情，
      // 但不再作为文风样本。
      const soundAnchor = this.formatSoundAnchor(prevChapters.slice(-2))
      if (soundAnchor) sections.push({ chunkId: 'sound-anchor', content: soundAnchor })
    }

    // 下一章开头（向前看：本章结尾必须过渡到此处场景）。
    // 重新生成中间章节时后续章节可能已有内容；不注入会让本章结尾与已存在的下一章开头
    // 对不上，导致剧情断裂。正常顺序生成时下一章不存在，自然跳过。
    const nextAnchor = this.formatNextChapterAnchor(
      this.stores.getChapter(projectId, chapterNumber + 1)
    )
    if (nextAnchor) sections.push({ chunkId: 'next-anchor', content: nextAnchor })

    // 未兑现钩子：Writer 必须承接上一章抛出的悬念，这是"前后章衔接对不上"的数据基础。
    const unfulfilledHooks = this.stores.listUnfulfilledHooksBefore(projectId, chapterNumber)
    if (unfulfilledHooks.length > 0) {
      // 上一章钩子必须完整承接；更早的遗留项只保留少量作为债务提醒，
      // 避免每一章都重复累积整本书的钩子历史。
      const previousChapterHooks = unfulfilledHooks
        .filter((hook) => hook.chapterNumber === chapterNumber - 1)
        // 同一章重跑 Director 可能留下多条 thrown 记录。优先保留最新结果，
        // 同类型同描述去重。
        .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
        .filter(
          (hook, index, hooks) =>
            hooks.findIndex(
              (candidate) =>
                candidate.hookType === hook.hookType &&
                candidate.description.trim() === hook.description.trim()
            ) === index
        )
        .slice(0, CHAPTER_ANCHOR_BUDGET.previousChapterHookCount)
      const olderBacklog = unfulfilledHooks
        .filter((hook) => hook.chapterNumber < chapterNumber - 1)
        .slice(0, CHAPTER_ANCHOR_BUDGET.olderHookBacklogCount)
      sections.push({ chunkId: 'hooks', content: this.formatUnfulfilledHooks([...previousChapterHooks, ...olderBacklog]) })
    }

    // 文风指纹：与 writingStyleProfile 叠加（profile 给方向，指纹给实际基准）。
    // 指标不可信时 formatStyleFingerprint 会自行降级为参考值，不作硬约束。
    if (prevChapters.length > 0) {
      const fingerprint = this.formatStyleFingerprint(prevChapters)
      if (fingerprint) sections.push({ chunkId: 'style-fingerprint', content: fingerprint })
    }

    return sections
  }

  /**
   * 增量 diff 上下文模式（SEMI 层）。
   *
   * 与 buildChapterContextShared 保持相同的 section 顺序，但用"全局关键事实摘要 +
   * 上一章变化 delta"替代全量故事状态（formatStoryState）和事件账本承接
   * （formatStoryLedgerContext），大幅减少字符数同时保留 AI 创作所需的关键信息。
   *
   * 触发场景：options.mode='diff' 时由 buildChapterContextShared 委托调用。
   * 设计意图：长篇小说中段（第 50+ 章）formatStoryState 会注入数百个角色/冲突/线索，
   * 把无关历史挤进上下文中心。diff 模式只注入全局 Top-N 关键事实和上一章 delta，
   * 让 LLM 聚焦"当前全局态势骨架 + 上一章发生了什么变化"。
   *
   * section 顺序（与 shared 一致，仅第 4、5 项替换）：
   * 1. 章节信息  2. 创作约束  3. 编排实体约束
   * 4. 全局关键事实摘要（formatGlobalKeyFacts，≤500 字）—— 替代 formatStoryState
   * 5. 上一章变化 delta（formatChapterDelta）—— 替代 formatStoryLedgerContext
   * 6. 实体关联  7. 信息差  8. 最近章节摘要  9. 上一章结尾 + 声音锚点
   * 10. 下一章锚点  11. 未兑现钩子  12. 文风指纹
   */
  buildChapterContextDiff(
    projectId: string,
    chapterNumber: number,
    narrativeTask: NarrativeTask,
    constraints: ChapterConstraints,
    arrangedEntities?: ArrangedEntity,
    askStoryEnabled = true,
  ): string {
    void constraints // constraints 已在 formatConstraints 中使用，此处 void 避免未使用警告
    const parts: string[] = []
    const relevantEntityIds = this.collectRelevantEntityIds(arrangedEntities)
    const boundary = this.getChapterBoundaryContext(projectId, chapterNumber)

    // ── 章节信息 ──
    parts.push(this.formatChapterInfo(projectId, chapterNumber, narrativeTask))

    // ── 创作约束 ──
    parts.push(this.formatConstraints(constraints))

    // ── 本章已编排实体约束（手动编排 / AI 编排产出，注入 SEMI 层）──
    const hasArranged = this.hasArrangedEntities(arrangedEntities)
    if (hasArranged && arrangedEntities) {
      parts.push(this.formatArrangedEntities(projectId, chapterNumber, arrangedEntities, boundary))
    }

    // ── 全局关键事实摘要（替代 formatStoryState，≤500 字紧凑摘要）──
    // 已编排时角色短卡和实体要素已经给出本章所需的状态，不再注入全局摘要；
    // 与 buildChapterContextShared 的 formatStoryState 注入条件保持一致。
    if (!hasArranged) {
      const keyFacts = this.formatGlobalKeyFacts(projectId, boundary, arrangedEntities)
      if (keyFacts) parts.push(keyFacts)
      // diff 模式也必须携带角色声音。否则 context-preview/长篇差分路径与 full
      // 路径的 Writer 输入不一致，预览通过但实际生成退回默认腔。
      const stateCharacters = boundary.state.characters.filter((character) => (
        !/（待定）|待补充|待定$|^新的$|^测试角色/.test(character.name)
      ))
      const voiceTable = formatVoiceContrastTable(buildVoiceProfiles(stateCharacters))
      if (voiceTable) parts.push(voiceTable)
    }

    // ── 上一章变化 delta（替代 formatStoryLedgerContext 的"最近承接"段）──
    // 仅注入第 N-1 章的原子变化，让 LLM 知道上一章哪些状态发生了改变。
    const delta = this.formatChapterDelta(projectId, chapterNumber, arrangedEntities, boundary)
    if (delta) parts.push(delta)

    // ── 实体关联（画布手动 + 派生自动边，作为故事状态的补充）──
    const edges =
      arrangedEntities && relevantEntityIds.size === 0
        ? []
        : this.collectRelevantEdges(projectId, relevantEntityIds, boundary)
    if (edges.length > 0) {
      const edgeSection = this.formatEdges(projectId, edges, boundary)
      if (edgeSection) parts.push(edgeSection)
    }

    // ── 信息差 ──
    const infoLayers = this.filterRelevantInfoLayers(
      boundary.entities.informationLayers,
      arrangedEntities,
      boundary
    )
    if (infoLayers.length > 0) {
      parts.push(this.formatInfoLayers(projectId, infoLayers, arrangedEntities, boundary))
    }

    // ── 前后章锚点（摘要 / 上一章结尾 / 声音锚点 / 下一章开头 / 未兑现钩子 / 文风指纹）──
    parts.push(...this.collectChapterAnchorSections(projectId, chapterNumber))

    return this.stripEmDash(parts.join('\n\n---\n\n'))
  }

  /**
   * 构建章节上下文 - Agent 专属后缀部分（SEMI 层 suffix，各 Agent 不同）
   *
   * 此部分包含各 Agent 专属的上下文，跨 Agent 不同。通过 prefixUserMessage
   * 数组的第二条注入，打 cache_control breakpoint 后仅同 Agent 重试命中。
   *
   * 各 Agent suffix 内容：
   * - Director：宏观节奏分布 + Reviewer 反馈回流
   * - Writer：创作指令（chapter-instruction）
   * - Reviser：空（上一章结尾+叙事声音锚点已在 shared 层）
   * - Reviewer：平台 Rubric + 已批准的 Director 方案
   * - Memory：空（无专属后缀）
   */
  buildChapterContextSuffix(
    projectId: string,
    chapterNumber: number,
    narrativeTask: NarrativeTask,
    constraints: ChapterConstraints,
    arrangedEntities?: ArrangedEntity,
    agentType?: string
  ): string {
    // T03-2 等价拆块：suffix 统一由 chunk 版构建（Agent 分支独立 chunk），
    // join 结果与旧字符串逐字节一致（每分支合并为一个 chunk，分隔符位置不变）。
    const chunks = this.buildChapterContextSuffixChunks(
      projectId, chapterNumber, narrativeTask, constraints, arrangedEntities, agentType,
    )
    if (chunks.length === 0) return ''
    return this.stripEmDash(chunks.map((c) => c.content).join('\n\n---\n\n'))
  }

  /**
   * T03-2：suffix 层 chunk 化。按 Agent 分支输出独立 chunk（director-scheme /
   * reviewer-rubric / writer-instruction），每个 chunk 内部分节保持原 join 顺序，
   * 与 buildChapterContextSuffix 返回字符串逐字节等价（由测试钉死）。
   */
  buildChapterContextSuffixChunks(
    projectId: string,
    chapterNumber: number,
    narrativeTask: NarrativeTask,
    constraints: ChapterConstraints,
    arrangedEntities?: ArrangedEntity,
    agentType?: string,
  ): Array<{ chunkId: string; content: string }> {
    if (!agentType) return []
    const chunks: Array<{ chunkId: string; content: string }> = []

    // ── 宏观节奏分布 + Reviewer 反馈回流（Director 注入）──
    if (agentType === 'director') {
      const parts: string[] = []
      const macroRhythm = this.formatMacroRhythm(projectId, chapterNumber)
      if (macroRhythm) parts.push(macroRhythm)
      const reviewerFeedback = this.formatReviewerFeedback(projectId, chapterNumber)
      if (reviewerFeedback) parts.push(reviewerFeedback)
      if (parts.length > 0) chunks.push({ chunkId: 'director-scheme', content: parts.join('\n\n---\n\n') })
    }
    void arrangedEntities

    // ── 平台 Rubric（仅 Reviewer 注入，按目标平台调整评分权重）──
    if (agentType === 'reviewer') {
      const parts: string[] = []
      const platformRubric = this.formatPlatformRubric(projectId)
      if (platformRubric) parts.push(platformRubric)
      if (narrativeTask.description.trim()) {
        parts.push(`## 已批准的本章叙事任务\n\n${narrativeTask.description.trim()}`)
      }
      // 矩阵执行验收：Reviewer 专属，从共享层 formatArrangedEntities 移至此处。
      // 对 Director/Writer/Memory 注入"Reviewer 必须逐项核对"无意义且破坏缓存稳定性。
      // 修复（2026-07-18）。
      if (this.hasArrangedEntities(arrangedEntities)) {
        parts.push(
          '## 矩阵执行验收（Reviewer 专属）\n\n' +
            '正文必须让上述编排实体实际参与本章事件，不得只在叙述中点名；' +
            '角色必须完成其本章功能位，冲突/伏笔必须按标注的推进节点执行。' +
            '你必须逐项核对矩阵实体是否全部兑现，未兑现项必须在审稿报告中明确指出。'
        )
      }
      if (parts.length > 0) chunks.push({ chunkId: 'reviewer-rubric', content: parts.join('\n\n---\n\n') })
    }

    // ── 创作指令（仅 Writer 注入，其他 Agent 看到会越权写作）──
    // chapter-instruction 模板包含"直接输出章节正文"等 Writer 专属指令，
    // 对 Director/Reviewer/Memory 注入会导致它们越权创作正文。
    if (agentType === 'writer') {
      const project = this.stores.getProject(projectId)
      // 字数统一走 WordBudgetResolver（buildChapterConstraints 已返回 resolver 值）；
      // 无定位时不再应用节奏倍率（2026-08-12 逻辑统一：删除 computeChapterTargetWords）。
      const targetWords = constraints.wordBudget?.target
        ?? resolveWordBudget({ baseTarget: baseTargetOf(project?.targetWords) }).resolvedTarget
      const styleDecisionPack = buildStyleDecisionPack({
        positioning: constraints.positioning ?? narrativeTask.positioning,
        narrativeTaskType: narrativeTask.type,
        profile: this.stores.getWritingStyleProfile?.(projectId),
      })
      // ── P1-2：按本章主导场景类型分桶挑选文风样本 + 自池动态样本 ──
      // 注入点在 per-chapter 指令层（SEMI），不进静态身份，保住跨章缓存。
      const sceneSampleSection = this.buildWriterSceneSamples(projectId, chapterNumber, narrativeTask.description)
      const positioningGuidance = sceneSampleSection
        ? `${styleDecisionPack}\n\n${sceneSampleSection}`
        : styleDecisionPack
      const instruction = this.promptManager.render(
        'chapter-instruction',
        {
          chapter_number: String(chapterNumber),
          narrative_task: narrativeTask.description,
          task_type: promptLabel(narrativeTask.type),
          target_words: String(targetWords),
          positioning_guidance: positioningGuidance,
        },
        projectId
      )
      chunks.push({ chunkId: 'writer-instruction', content: instruction })
    }

    return chunks
  }

  /**
   * P1-2：Writer 每章的场景文风样本分节。
   *
   * 样本来源 = 档案正向样本（跳过静态身份已用的第一条锚定样本）+ 自池摘段
   * （本书已发布、审稿得分最高的章节结尾，"本书最好的三章"）。
   * 按叙事任务推断的主导场景类型（对话场/动作场/静场）优先取同桶样本。
   *
   * 注入在 per-chapter 指令层而非静态身份：样本选择随章变化，
   * 进身份会破坏 Writer 的跨章前缀缓存。
   */
  private buildWriterSceneSamples(
    projectId: string,
    chapterNumber: number,
    narrativeTaskText: string,
  ): string {
    const profile = this.stores.getWritingStyleProfile?.(projectId)
    // 静态身份保留第一条作锚定样本，分桶时跳过它避免重复注入
    const remainingExamples = (profile?.positiveExamples ?? []).slice(1)

    const selfPoolExcerpts = this.getSelfPoolExcerpts(projectId, chapterNumber)

    return buildSceneSampleSection({
      positiveExamples: remainingExamples.length > 0 ? remainingExamples : undefined,
      selfPoolExcerpts: selfPoolExcerpts.length > 0 ? selfPoolExcerpts : undefined,
      sceneType: inferSceneType(narrativeTaskText),
      maxSamples: 2,
      sampleMaxLength: 1600,
    })
  }

  /**
   * 自池：最近发布章节按最新审稿 overallScore 排序，取前三的结尾摘段。
   * 审稿缺失（旧章节/未审）按 null 处理排在有分章节之后；
   * 正文不足 1500 字的章节不参与（太短学不到场景起伏）。
   * P1-2 反馈回路修正：**碎段/超短句风格的章节不得进入正向样本池**——
   * 否则自池会把被质量门惩罚的节奏当作"本书声音"喂回给 Writer，形成恶性循环。
   */
  private getSelfPoolExcerpts(
    projectId: string,
    excludeChapterNumber: number,
  ): Array<{ chapterNumber: number; score: number | null; excerpt: string }> {
    try {
      const candidates = this.stores
        .listRecentChapters(projectId, 24)
        .filter((chapter) => chapter.chapterNumber !== excludeChapterNumber)
        .filter((chapter) => (chapter.content ?? '').length >= 1500)
        .map((chapter) => {
          const metrics = measureStyleMetrics(chapter.content ?? '')
          return {
            chapterNumber: chapter.chapterNumber,
            score: this.stores.getChapterReview?.(chapter.id)?.overallScore ?? null,
            content: chapter.content ?? '',
            metrics,
          }
        })
        .filter(({ metrics }) => (
          // 形态过滤：超短句占主导或段落中位长度过小的，视为碎段风格，排除
          metrics.trustworthy
          && metrics.paragraphLength.median >= 60
          && metrics.sentenceLength.buckets['1-10'] / Math.max(1, metrics.sentenceCount) <= 0.5
        ))
        .sort((a, b) => {
          const scoreA = a.score ?? -1
          const scoreB = b.score ?? -1
          return scoreB - scoreA || b.chapterNumber - a.chapterNumber
        })
        .slice(0, 3)
      return candidates.map((candidate) => ({
        chapterNumber: candidate.chapterNumber,
        score: candidate.score,
        excerpt: candidate.content.slice(-1600),
      }))
    } catch {
      // 自池是增益能力，任何存储异常都不能阻塞创作主链
      return []
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 格式化方法
  // ═══════════════════════════════════════════════════════════════

  /** 格式化世界规则 */
  private formatWorldRules(rules: NovelWorldRule[]): string {
    const lines = rules.map((r) => {
      const cost = r.cost ? `（代价：${r.cost}）` : ''
      const fixed = r.isFixed ? '[固定]' : '[阶段]'
      return `- ${fixed} [${r.category}] ${r.rule}${cost}`
    })
    return `## 世界规则\n\n${lines.join('\n')}`
  }

  /** 格式化风格指南 */
  private formatStyleGuide(styles: NovelStyleGuide[]): string {
    const lines = styles.map((s) => {
      const example = s.example ? `\n  示例：${s.example}` : ''
      return `- [${s.category}] ${s.rule}${example}`
    })
    return `## 风格指南\n\n${lines.join('\n')}`
  }

  /**
   * 平台 Rubric：按目标平台注入差异化评分权重
   *
   * 仅在项目设置了 targetPlatform 且非 general 时注入。
   * null 或 general 时返回空字符串（不注入）。
   */
  private formatPlatformRubric(projectId: string): string {
    const project = this.stores.getProject(projectId)
    const platform = project?.targetPlatform
    if (!platform || platform === 'general') return ''

    const rubrics: Record<Exclude<NonNullable<typeof platform>, 'general'>, string> = {
      fanqie: `## 平台 Rubric（番茄·免费阅读平台）

本章按番茄平台的读者偏好调整评分权重：

- **核心权重**：节奏快、爽感强、每章必有小高潮
- **扣分项**：节奏拖沓（< 6 分直接 revise）、铺垫过长、无爽点
- **加分项**：反转密集、打脸爽快、金手指清晰

⚠️ 番茄读者属于浅阅读，节奏和爽感是生命线。若本章无爽点或节奏过慢，即使文笔再好也应降分。`,
      qidian: `## 平台 Rubric（起点·付费订阅平台）

本章按起点平台的读者偏好调整评分权重：

- **核心权重**：世界观完整、人物刻画深、伏笔系统性强
- **扣分项**：设定漏洞、人物扁平、逻辑不自洽
- **加分项**：体系清晰、配角有记忆点、伏笔回收惊艳

⚠️ 起点读者付费阅读，对设定一致性和逻辑严密性要求高。设定漏洞和人物扁平比节奏问题更严重。`,
      zhihu_yanyan: `## 平台 Rubric（知乎盐言·短篇故事平台）

本章按知乎盐言平台的读者偏好调整评分权重：

- **核心权重**：开篇抓人、反转精巧、篇幅精炼
- **扣分项**：开头拖沓、反转生硬、注水
- **加分项**：第一句就入戏、结尾有余味、情绪密度高

⚠️ 知乎盐言是短篇平台，每一段都必须有信息增量。注水和拖沓是致命伤。`
    }

    return rubrics[platform] ?? ''
  }

  /**
   * 格式化章节信息
   *
   * ⚠️ 缓存关键：所有 Agent（Director/Writer/Reviewer/Memory）必须输出完全相同的
   * 章节信息，确保 SEMI 层前缀跨 Agent 一致，让 LLM provider 端能命中 prompt cache。
   *
   * Writer 的完整叙事任务（Director 实时输出）由 chapter-instruction 模板在
   * SEMI 层末尾渲染，此处只输出数据库章纲描述（跨 Agent 一致）。
   * 类型/优先级等信息也由 chapter-instruction 模板输出，此处不重复。
   *
   * ⚠️ outline 字段：用户在前端 DebouncedOutlineField 填写的章纲内容，
   * 是创作的统一起点。这里优先注入 outline，narrativeTask 仅作为任务类型标签保留。
   * 历史问题：b4f720b 之前只注入 narrativeTask（如"推进主线剧情"6 字标签），
   * 导致 LLM 看不到用户写的章纲，Director 只能自由发挥，正文偏离用户设定。
   */
  private formatChapterInfo(
    projectId: string,
    chapterNumber: number,
    task: NarrativeTask,
    agentType?: string
  ): string {
    void agentType // 不再区分 agentType，保留参数仅为向后兼容
    const project = this.stores.getProject(projectId)
    const volume = project?.currentVolume ?? 1
    const chapter = this.stores.getChapter(projectId, chapterNumber)
    // 占位符检测：narrativeTask.description 默认值为"待补充"，是章节创建时的占位符，
    // Director 应该在规划时通过 novel_submit_narrative_task 工具覆盖它。
    // 注入占位符会让 LLM 误以为任务类型真的未定，导致规划混乱。
    const isPlaceholderTask = (desc: string | undefined): boolean =>
      !desc || desc.trim() === '' || desc.trim() === '待补充' || desc.trim() === '待定'
    const taskTypeLine = isPlaceholderTask(task.description)
      ? '当前任务尚待规划：先围绕用户章纲确定本章事件。'
      : task.description.trim()
    const lines = [
      `## 本章写作核心`,
      ``,
      `第${volume}卷·第${chapterNumber}章`,
      ``,
      `### 本章要完成的事`,
      ``,
      taskTypeLine
    ]
    // 注入用户编写的章纲（outline）作为创作统一起点
    // 如果 outline 为空，回退使用 narrativeTask（保持向后兼容）
    const outline = chapter?.outline?.trim()
    if (outline) {
      lines.push(``, `### 用户章纲（必须落实为本章事件）`, ``, outline)
    } else if (!isPlaceholderTask(task.description)) {
      lines.push(``, `### 章纲`, ``, task.description!)
    }
    return lines.join('\n')
  }

  /**
   * 将文本中的关键数字（百分比、次数、年份、频率等）加粗标注。
   *
   * 设计意图：LLM 在长上下文中容易"记错"具体数字（如把"三次脉冲"写成"七次"）。
   * 用 **加粗** 突出关键数字，利用 LLM 对 markdown 强调的注意力偏好，
   * 降低数字篡改概率。
   */
  private boldKeyNumbers(text: string): string {
    return (
      text
        // 百分比：73% → **73%**
        .replace(/(\d+(?:\.\d+)?%)/g, '**$1**')
        // 次数/量词：七次、3次、27年 → **七次**、**3次**、**27年**
        .replace(
          /(\d+|[一二三四五六七八九十百千万]+)(次|遍|个|年|月|天|日|时|刻|分|秒|轮|道|条|块|人|名|位)/g,
          '**$1$2**'
        )
        // 频率/参数：7.83Hz、42摄氏度
        .replace(/(\d+(?:\.\d+)?(?:Hz|赫兹|摄氏度|℃|度|米|公里|公斤|千克|吨))/g, '**$1**')
    )
  }

  private formatConstraints(constraints: ChapterConstraints): string {
    const parts: string[] = ['## 创作约束']

    if (constraints.facts.length > 0) {
      parts.push('\n### 事实约束（不能违反）')
      parts.push('⚠️ 关键数字已加粗标注，正文必须与此一致。')
      for (const c of constraints.facts) {
        parts.push(`- ${this.boldKeyNumbers(c.rule)}`)
      }
    }

    if (constraints.cognitive.length > 0) {
      parts.push('\n### 认知约束（角色不能知道不该知道的事）')
      for (const c of constraints.cognitive) {
        parts.push(`- ${c.rule}`)
      }
    }

    if (constraints.stage.length > 0) {
      parts.push('\n### 阶段约束（当前阶段允许/禁止的事）')
      for (const c of constraints.stage) {
        parts.push(`- ${c.rule}`)
      }
    }

    // suspenseHooks 已携带同一伏笔的本章动作时，不再以“叙事债务”重复一遍。
    const suspenseDescriptions = new Set(constraints.suspenseHooks.map((hook) => hook.description))
    const standaloneDebts = constraints.narrativeDebts.filter(
      (foreshadow) => !suspenseDescriptions.has(foreshadow.description)
    )
    if (standaloneDebts.length > 0) {
      parts.push('\n### 叙事债务（待回收的伏笔）')
      parts.push('⚠️ 伏笔描述中的关键数字已用 **加粗** 标注，正文必须与此一致，不得篡改。')
      for (const f of standaloneDebts) {
        const status =
          f.status === 'planted'
            ? '已埋下'
            : f.status === 'reinforced'
              ? '已强化'
              : f.status === 'partially_revealed'
                ? '部分揭露'
                : '待回收'
        // 关键数字加粗：防止 Writer 在正文中篡改设定数据
        const desc = this.boldKeyNumbers(f.description)
        parts.push(`- [${status}] ${desc}（首次：第${f.firstChapter}章）`)
      }
    }

    if (constraints.characterArcs.length > 0) {
      parts.push('\n### 角色弧光约束')
      // 已知弧光终态集合（来自 ARC_STAGE_MODELS 的各类型最后阶段 + 通用终态）
      // 仅当 arcStage 确实是终态时才显示"已完成弧光"，避免 allowedNextStage=null 时的误判
      const ARC_FINAL_STAGES = new Set([
        'transformation',
        'point_of_no_return',
        'redemption',
        'new_framework',
        'resolution'
      ])
      for (const arc of constraints.characterArcs) {
        const stage = arc.character.arcStage
        const isFinalStage = ARC_FINAL_STAGES.has(stage)
        const next = arc.allowedNextStage
          ? `下一步可达：${promptLabel(arc.allowedNextStage)}`
          : isFinalStage
            ? '已完成成长线'
            : '下一步由本章剧情决定'
        parts.push(`- ${arc.character.name}：当前处于「${promptLabel(stage)}」；${next}`)
      }
    }

    // 冲突推进目标（本章必须推进的冲突清单）
    if (constraints.conflictTargets.length > 0) {
      parts.push('\n### 冲突推进目标（本章必须推进）')
      for (const target of constraints.conflictTargets) {
        const c = target.conflict
        const segs = [`- [${promptLabel(c.type)}] ${c.description}`]
        segs.push(`本章后应达到：${promptLabel(target.targetStage)}`)
        segs.push(`强度变化：${target.intensityDelta > 0 ? '+' : ''}${target.intensityDelta}`)
        // ── 071：推进粒度（让 Writer 知道冲突已推进到哪一步，本章应承接而非重头验证）──
        if (c.currentStep?.trim()) {
          segs.push(`当前进展：${c.currentStep.trim()}`)
        }
        if (c.nextStep?.trim()) {
          segs.push(`⚡ 本章应推进：${c.nextStep.trim()}`)
        }
        if (target.isClimax) {
          segs.push('【本章推向高潮】')
          if (c.climaxType) segs.push(`高潮类型：${promptLabel(c.climaxType)}`)
        }
        parts.push(segs.join('；'))
      }
    }

    // 节奏约束
    if (constraints.rhythmConstraint) {
      const rc = constraints.rhythmConstraint
      parts.push('\n### 节奏约束')
      const segs = [`- 节奏：${promptLabel(rc.rhythm)}`]
      if (rc.climaxIntensity) segs.push(`高潮强度：${rc.climaxIntensity}`)
      if (rc.climaxType) segs.push(`高潮类型：${promptLabel(rc.climaxType)}`)
      segs.push(`说明：${rc.description}`)
      parts.push(segs.join('；'))
    }

    // 卷级节拍约束（Beat Planner）：存在时是本章任务类型与情绪曲线的最高规划依据
    if (constraints.beatConstraint) {
      const bc = constraints.beatConstraint
      parts.push('\n### 卷级节拍约束（本章在整卷结构中的职责，最高优先规划依据）')
      const segs = [`- 戏剧功能：${promptLabel(bc.dramaticFunction)}`]
      if (bc.arcPosition) segs.push(`弧光位置：${bc.arcPosition}`)
      if (bc.emotionalDebt) segs.push(`进入本章时的情绪债务：${bc.emotionalDebt}`)
      if (bc.payoff) segs.push(`本章爽点/回报：${bc.payoff}`)
      if (bc.summary) segs.push(`核心走向：${bc.summary}`)
      parts.push(segs.join('；'))
    }

    // 悬念钩子
    if (constraints.suspenseHooks.length > 0) {
      parts.push('\n### 悬念钩子（本章需维持或释放的悬念）')
      for (const hook of constraints.suspenseHooks) {
        const segs = [`- ${hook.description}`]
        segs.push(`本章动作：${promptLabel(hook.status)}`)
        if (hook.sustainedChapters > 0) segs.push(`已持续：${hook.sustainedChapters} 章`)
        if (hook.releaseByChapter) segs.push(`计划释放：第 ${hook.releaseByChapter} 章`)
        parts.push(segs.join('；'))
      }
    }

    // POV（视点人物）约束
    if (constraints.povCharacters && constraints.povCharacters.length > 0) {
      parts.push('\n### POV 约束（视点人物）')
      parts.push(`本章必须严格使用以下角色的视角：${constraints.povCharacters.join('、')}`)
      parts.push('不得出现未列在此处的角色的内心独白。如需切换视角，必须用明确的场景分隔。')
    }

    // 场景数（节奏速率引导）
    if (constraints.sceneCount && constraints.sceneCount > 0) {
      parts.push('\n### 场景数（节奏速率引导）')
      if (constraints.sceneCount === 1) {
        parts.push('本章 1 个场景：单场景写透，深入挖掘细节和情感，不赶进度')
      } else if (constraints.sceneCount === 2) {
        parts.push('本章 2 个场景：两个场景各有侧重，中间用场景切换自然过渡')
      } else {
        parts.push(
          `本章 ${constraints.sceneCount} 个场景：多场景快推，每个场景点到为止，保持节奏明快`
        )
      }
    }

    // 时间线偏移（引导 Writer 把握时间推进）
    if (constraints.timeOffset != null) {
      parts.push('\n### 时间线（相对第1章的偏移）')
      if (constraints.timeOffset === 0) {
        parts.push('本章与第1章同日发生，时间不推进')
      } else if (constraints.timeOffset > 0) {
        parts.push(
          `本章时间相对第1章推进 **${constraints.timeOffset} 天**，请在叙述中自然体现时间流逝（如环境、作息、日期感受）`
        )
      } else {
        parts.push(
          `本章时间相对第1章倒退 ${Math.abs(constraints.timeOffset)} 天（闪回/倒叙），请在叙述中明确标记这是回忆或往事`
        )
      }
    }

    return parts.join('\n')
  }

  /**
   * 格式化本章已编排的实体约束（手动编排 / AI 编排产出）
   *
   * 与 `formatConstraints` 的区别：
   * - `formatConstraints` 输出的是「规则文本约束」（事实/认知/阶段/伏笔债务/角色弧光）
   * - `formatArrangedEntities` 输出的是「本章必须出现的具体实体」的完整定义，
   *   让 Writer 在 SEMI 层就能感知到编排约束和角色详情，无需通过工具查询。
   *
   * ⚠️ 角色定义放在这里（SEMI 层）而不是系统提示词（STATIC 层）的原因：
   * - 角色数量可能很大（200+），全部塞系统提示词会导致上下文爆炸
   * - 本章出场角色已通过 arrangedEntities 编排好，只需注入这些角色的完整定义
   * - 系统提示词不含角色定义 → 跨章缓存命中最好
   * - 章节上下文含本章角色完整定义 → 单章内缓存命中
   * - 其他角色 LLM 通过 formatStoryState 知道存在（name+动态状态），需要详情时调 query_state 工具
   */
  private formatArrangedEntities(
    projectId: string,
    chapterNumber: number,
    arranged: ArrangedEntity,
    boundary: ChapterBoundaryContext
  ): string {
    void projectId
    const lines: string[] = ['## 本章出场要素（必须真正参与事件）']
    const characterById = new Map(boundary.entities.characters.map((entity) => [entity.id, entity]))
    const conflictById = new Map(boundary.entities.conflicts.map((entity) => [entity.id, entity]))
    const foreshadowById = new Map(
      boundary.entities.foreshadowing.map((entity) => [entity.id, entity])
    )
    const clueById = new Map(boundary.entities.clues.map((entity) => [entity.id, entity]))
    const factionById = new Map(boundary.entities.factions.map((entity) => [entity.id, entity]))
    const locationById = new Map(boundary.entities.locations.map((entity) => [entity.id, entity]))
    const itemById = new Map(boundary.entities.items.map((entity) => [entity.id, entity]))
    const infoLayerById = new Map(
      boundary.entities.informationLayers.map((entity) => [entity.id, entity])
    )
    const resolveCharacter = (id: string) => resolveChapterBoundaryEntity(
      id, characterById, (entityId) => this.stores.getCharacter(entityId), boundary.fromSnapshot,
    )
    const resolveConflict = (id: string) => resolveChapterBoundaryEntity(
      id, conflictById, (entityId) => this.stores.getConflict(entityId), boundary.fromSnapshot,
    )
    const resolveForeshadow = (id: string) => resolveChapterBoundaryEntity(
      id, foreshadowById, (entityId) => this.stores.getForeshadow(entityId), boundary.fromSnapshot,
    )
    const resolveClue = (id: string) => resolveChapterBoundaryEntity(
      id, clueById, (entityId) => this.stores.getClue(entityId), boundary.fromSnapshot,
    )
    const resolveFaction = (id: string) => resolveChapterBoundaryEntity(
      id, factionById, (entityId) => this.stores.getFaction(entityId), boundary.fromSnapshot,
    )
    const resolveLocation = (id: string) => resolveChapterBoundaryEntity(
      id, locationById, (entityId) => this.stores.getLocation(entityId), boundary.fromSnapshot,
    )
    const resolveItem = (id: string) => resolveChapterBoundaryEntity(
      id, itemById, (entityId) => this.stores.getItem(entityId), boundary.fromSnapshot,
    )
    // 功能位中文映射（让 Writer 直观理解每个角色的本章推动作用）
    const plotFunctionLabel: Record<string, string> = {
      provide_resource: '提供资源',
      create_obstacle: '制造阻碍',
      amplify_conflict: '放大冲突',
      open_phase: '打开新阶段',
      change_judgment: '改变主角判断',
      advance_relationship: '推进感情线',
      reveal_world_rule: '暴露世界规则'
    }
    const plotRoleLabel: Record<string, string> = {
      protagonist: '主角：允许完整感知、判断、选择与内心层',
      main_opponent: '主要对手：保留动机和策略，但不替他解释全部内心',
      supporting: '重要配角：本章有关系、认知或长期状态变化时才展开',
      function: '功能角色：完成一个具体动作、信息或阻碍即可；不分配独立内心、弧光展示或 POV',
      background: '背景人物：只作为环境反应或群体的一部分，不单独展开'
    }
    // ── P2-1：冲突推进模式中文映射 ──
    const progressionModeLabel: Record<string, string> = {
      linear: '线性升级',
      mutation: '突变',
      stagnation: '停滞',
      regression: '降级',
      reversal: '反转'
    }
    // ── P2-2：伏笔 category / plantMethod / recoverMethod 中文映射 ──
    const foreshadowCategoryLabel: Record<string, string> = {
      item: '物品',
      spoken: '言语',
      event: '事件',
      identity: '身份',
      secret: '秘密',
      prophecy: '预言',
      promise: '承诺',
      quote: '台词'
    }
    const plantMethodLabel: Record<string, string> = {
      explicit: '明写',
      implicit: '暗写',
      indirect: '侧写'
    }
    const recoverMethodLabel: Record<string, string> = {
      explicit: '点破',
      implicit: '暗示',
      reverse: '反向',
      progressive: '递进'
    }
    // 过滤占位角色：名字含"（待定）"/"待补充"等的是 AI 编排未命名的占位角色，
    // 其字段全是"待补充（占位）"模板文本，对 Writer 无意义且浪费上下文
    const isPlaceholderName = (name: string): boolean => /（待定）|待补充|待定$/.test(name)
    if (arranged.characterIds.length > 0) {
      const chars = arranged.characterIds
        .map(resolveCharacter)
        .filter((resolved): resolved is NonNullable<typeof resolved> => resolved != null)
        .filter(({ entity }) => !isPlaceholderName(entity.name))
      if (chars.length > 0) {
        // 按功能位索引，便于角色查到对应功能
        const functionMap = new Map<string, Array<{ function: string; note?: string }>>()
        for (const entry of arranged.characterFunctions ?? []) {
          const entries = functionMap.get(entry.characterId) ?? []
          entries.push({ function: entry.function, note: entry.note })
          functionMap.set(entry.characterId, entries)
        }
        lines.push('### 角色短卡')
        for (const { entity: c, hasBoundaryState } of chars) {
          const charLines = [`- **${c.name}**`]
          const roleLabel = plotRoleLabel[c.plotRole] ?? c.plotRole
          if (roleLabel) charLines.push(`  笔墨：${roleLabel}`)
          if (usableDetail(c.identity))
            charLines.push(
              `  身份：${compactPromptText(c.identity, CHARACTER_CARD_BUDGET.identity)}`
            )
          const functions = functionMap.get(c.id) ?? []
          for (const fn of functions) {
            const fnLabel = plotFunctionLabel[fn.function] ?? fn.function
            charLines.push(
              `  本章作用：${fnLabel}${fn.note ? `（${compactPromptText(fn.note, CHARACTER_CARD_BUDGET.functionNote)}）` : ''}`
            )
          }
          if (hasBoundaryState && usableDetail(c.currentState))
            charLines.push(
              `  此刻：${compactPromptText(c.currentState, CHARACTER_CARD_BUDGET.currentState)}`
            )
          const isLightweightRole = c.plotRole === 'function' || c.plotRole === 'background'
          if (hasBoundaryState && !isLightweightRole && usableDetail(c.currentGoal))
            charLines.push(
              `  想要：${compactPromptText(c.currentGoal, CHARACTER_CARD_BUDGET.currentGoal)}`
            )
          if (hasBoundaryState && !isLightweightRole && usableDetail(c.currentPressure))
            charLines.push(
              `  压力：${compactPromptText(c.currentPressure, CHARACTER_CARD_BUDGET.currentPressure)}`
            )
          // 长期欲望、缺点与完整性格只属于主角/主要对手/重要配角的笔墨预算。
          // 功能角色一旦看到这些字段，模型会本能地给他独立心理、背景解释和弧光展示，
          // 把“肇事司机打电话”写成另一条人物线。
          if (hasBoundaryState && !isLightweightRole && usableDetail(c.longTermDesire))
            charLines.push(
              `  一直想要：${compactPromptText(c.longTermDesire, CHARACTER_CARD_BUDGET.longTermDesire)}`
            )
          if (!isLightweightRole && usableDetail(c.personality))
            charLines.push(
              `  性格：${compactCharacterDetail(c.personality, CHARACTER_CARD_BUDGET.personality, 'personality')}`
            )
          if (usableDetail(c.speechStyle))
            charLines.push(
              isLightweightRole
                ? `  对话提示：${compactCharacterDetail(c.speechStyle, 100, 'speechStyle')}`
                : `  对话：${compactCharacterDetail(c.speechStyle, CHARACTER_CARD_BUDGET.speechStyle, 'speechStyle')}`
            )
          lines.push(charLines.join('\n'))
        }
        // 短卡是纵向的：模型逐张读完并不会自动去比较三个人的说话方式，
        // 于是三份都写着"沉稳克制"的档案输出同一把嗓子。
        // 声音对照表把差异横向摆开，并给出可判定的轴（句长字数区间 / 语域标记词 /
        // 被追问时的反应），与 detectVoiceCollapse 的实测口径一一对应。
        // 声音对照只为需要持续辨认的主角/对手/重要配角展开。
        // function/background 只使用短卡中的一句对话提示，不加入全套声音坐标，
        // 避免模型误以为每个过场人物都要获得同等台词量和辨识度展示。
        const voiceCharacters = chars
          .map(({ entity }) => entity)
          .filter((character) => (
            character.plotRole !== 'function' && character.plotRole !== 'background'
          ))
        const voiceTable = formatVoiceContrastTable(buildVoiceProfiles(voiceCharacters))
        if (voiceTable) {
          lines.push('')
          lines.push(voiceTable)
        }
      }
    }

    // ── 本章角色之间的关系状态（四层逻辑②：动态关系）──
    // 让 Writer 知道本章角色之间的当前关系状态 + 阵营 + 走向 + 本章约束提示
    if (arranged.characterIds.length > 1) {
      const charIdSet = new Set(arranged.characterIds)
      const relations = boundary.entities.relationships.filter(
        (r) => charIdSet.has(r.characterA) && charIdSet.has(r.characterB)
      )
      if (relations.length > 0) {
        lines.push('')
        lines.push('### 角色关系')
        const charNameMap = new Map(
          arranged.characterIds
            .map(resolveCharacter)
            .filter((resolved): resolved is NonNullable<typeof resolved> => resolved != null)
            .map(({ entity }) => [entity.id, entity.name])
        )
        const alignmentLabel: Record<string, string> = {
          ally: '同一边',
          temporary_ally: '暂时同路',
          opponent: '对立',
          temporary_opponent: '暂时对立',
          neutral: '中立',
          pending_shift: '待转变'
        }
        const trendLabel: Record<string, string> = {
          stable: '稳定',
          warming: '升温',
          cooling: '降温',
          breaking: '即将破裂',
          reconciling: '和解中'
        }
        for (const r of relations) {
          const nameA = charNameMap.get(r.characterA) ?? r.characterA
          const nameB = charNameMap.get(r.characterB) ?? r.characterB
          const parts = [`  - ${nameA} ↔ ${nameB}`]
          if (r.relationType) parts.push(`关系：${promptLabel(r.relationType)}`)
          if (r.currentStage) parts.push(`现状：${promptLabel(r.currentStage)}`)
          // ── 四层逻辑②：动态字段 ──
          if (r.dynamicRole) parts.push(`功能位：${promptLabel(r.dynamicRole)}`)
          parts.push(`阵营：${alignmentLabel[r.alignment] ?? r.alignment}`)
          parts.push(`走向：${trendLabel[r.trend] ?? r.trend}`)
          if (r.chapterHint) parts.push(`⚡ 本章约束：${r.chapterHint}`)
          lines.push(parts.join('；'))
        }
      }
    }

    // ── P1-1：对手戏欲望碰撞卡（对话的潜台词引擎）──
    // 角色短卡是纵向档案，模型逐张读完不会自动比较两人的欲望是否互斥；
    // 这张卡把同场角色的目标、压力与信息差横向摆进同一对视框，
    // 让对话的张力来自"我想要你身上的什么"，而不是"提问→完整回答→下一个问题"。
    if (arranged.characterIds.length > 1) {
      const charIdSet = new Set(arranged.characterIds)
      const pairRelations = boundary.entities.relationships.filter(
        (r) => charIdSet.has(r.characterA) && charIdSet.has(r.characterB)
      )
      const resolvedChars = arranged.characterIds
        .map(resolveCharacter)
        .filter((resolved): resolved is NonNullable<typeof resolved> => resolved != null)
        .filter(({ entity }) => !isPlaceholderName(entity.name))
      const collision = this.formatDesireCollision(
        resolvedChars,
        pairRelations,
        boundary.entities.informationLayers
      )
      if (collision) {
        lines.push('')
        lines.push(collision)
      }
    }
    if (arranged.conflictIds.length > 0) {
      const confl = arranged.conflictIds
        .map(resolveConflict)
        .filter((resolved): resolved is NonNullable<typeof resolved> => resolved != null)
      if (confl.length > 0) {
        lines.push('### 本章冲突')
        // 用于把 participants（JSON: string[]）解析为角色名
        const allChars = [...characterById.values()]
        const charNameMap = new Map(allChars.map((c) => [c.id, c.name]))
        for (const { entity: c, hasBoundaryState } of confl) {
          const parts = [`- [${promptLabel(c.type)}] ${c.description}`]
          if (hasBoundaryState) {
            parts.push(`现状：${promptLabel(c.stage)}`)
            parts.push(`强度：${c.intensity}/10`)
          }
          parts.push(`线索层级：${promptLabel(c.tier)}`)
          // ── P2-1：冲突功能位 + 推进模式（让 Writer 知道这个冲突在本章的推动作用与演变规律）──
          if (c.plotFunction) {
            parts.push(`⚡ 功能位：${plotFunctionLabel[c.plotFunction] ?? c.plotFunction}`)
          }
          if (c.progressionMode) {
            parts.push(`推进方式：${progressionModeLabel[c.progressionMode] ?? c.progressionMode}`)
          }
          // ── 071：推进粒度（让 Writer 知道冲突已经推进到哪一步，避免反复验证同一个粗状态）──
          // 关键修复：原本只输出 stage（emerging/escalating/...），Writer 看不到"已出现图案"
          // 这类细粒度进展，导致每章都从头验证穴位是否存在。
          if (hasBoundaryState && c.currentStep?.trim()) {
            parts.push(`当前进展：${c.currentStep.trim()}`)
          }
          if (hasBoundaryState && c.nextStep?.trim()) {
            parts.push(`⚡ 本章下一步：${c.nextStep.trim()}`)
          }
          // ── 四层逻辑④：participants 双向关联 ──
          // 输出参与方角色名，让 Writer 知道这个冲突涉及谁
          let participantNames: string[] = []
          if (hasBoundaryState) {
            try {
              const parsed = JSON.parse(c.participants)
              if (Array.isArray(parsed)) {
                participantNames = parsed
                  .map((id: unknown) => (typeof id === 'string' ? charNameMap.get(id) : undefined))
                  .filter((n: unknown): n is string => typeof n === 'string')
              }
            } catch {
              // 旧数据可能不是 JSON，忽略
            }
          }
          if (participantNames.length > 0) {
            parts.push(`参与方：${participantNames.join('、')}`)
          }
          if (c.stakes) parts.push(`赌注：${c.stakes}`)
          if (c.twistPotential != null) parts.push(`突转潜力：${c.twistPotential}/10`)
          lines.push(parts.join('；'))
        }
      }
    }
    if (arranged.foreshadowIds.length > 0) {
      const fores = arranged.foreshadowIds
        .map(resolveForeshadow)
        .filter((resolved): resolved is NonNullable<typeof resolved> => resolved != null)
      if (fores.length > 0) {
        lines.push('### 本章伏笔')
        for (const { entity: f, hasBoundaryState } of fores) {
          const parts = [`  - ${f.description}`]
          // ── P2-2：category + plantMethod + recoverMethod 让 Writer 知道如何埋设/回收 ──
          parts.push(`类别：${foreshadowCategoryLabel[f.category] ?? f.category}`)
          if (hasBoundaryState) parts.push(`现状：${promptLabel(f.status)}`)
          if (f.plantMethod) {
            parts.push(`埋设方式：${plantMethodLabel[f.plantMethod] ?? f.plantMethod}`)
          }
          if (f.recoverMethod) {
            parts.push(`回收方式：${recoverMethodLabel[f.recoverMethod] ?? f.recoverMethod}`)
          }
          if (hasBoundaryState && f.recoverByChapter != null) {
            parts.push(`应在第 ${f.recoverByChapter} 章前回收`)
          }
          const currentBeat = hasBoundaryState
            ? f.beats?.find((beat) => beat.chapter === chapterNumber)
            : undefined
          if (currentBeat) {
            const beatLabel = {
              plant: '埋设',
              reinforce: '强化',
              reveal: '部分揭示',
              payoff: '回收'
            }[currentBeat.type]
            parts.push(`本章节点：${beatLabel}`)
            if (currentBeat.note) parts.push(`节点内容：${currentBeat.note}`)
          }
          // ── P3-2：反向展示 linkedInfoLayers（本伏笔承载了哪些信息差）──
          // 让 Writer 在回收伏笔时同步翻转读者认知（避免伏笔回收了但信息差没揭露）
          // 关联关系已迁移至 novel_edges 表（foreshadow ↔ info_layer）
          const linkedInfoLayerIds = boundary.entities.edges
            .filter((edge) => edge.edgeType === 'related')
            .filter(
              (e) =>
                (e.sourceId === f.id && e.targetType === 'info_layer') ||
                (e.targetId === f.id && e.sourceType === 'info_layer')
            )
            .map((e) => (e.sourceId === f.id ? e.targetId : e.sourceId))
          if (linkedInfoLayerIds.length > 0) {
            const linkedInfoDescs: string[] = []
            for (const ilId of linkedInfoLayerIds) {
              const il = infoLayerById.get(ilId)
              if (il) {
                const ilReader = il.readerKnows ? '读者已知' : '读者未知'
                linkedInfoDescs.push(`${il.infoDescription}（${ilReader}）`)
              }
            }
            if (linkedInfoDescs.length > 0) {
              parts.push(`⚡ 承载信息差：${linkedInfoDescs.join('；')}`)
            }
          }
          lines.push(parts.join('；'))
        }
      }
    }
    if (arranged.factionIds.length > 0) {
      const facs = arranged.factionIds
        .map(resolveFaction)
        .filter((resolved): resolved is NonNullable<typeof resolved> => resolved != null)
      if (facs.length > 0) {
        lines.push('### 登场势力')
        for (const { entity: f, hasBoundaryState } of facs) {
          const parts = [`  - ${f.name}`]
          if (f.description) parts.push(f.description)
          if (f.type) parts.push(`类型：${promptLabel(f.type)}`)
          if (f.ideology) parts.push(`理念：${f.ideology}`)
          if (hasBoundaryState && f.strength) parts.push(`实力：${promptLabel(f.strength)}`)
          if (hasBoundaryState && f.status) parts.push(`状态：${promptLabel(f.status)}`)
          if (hasBoundaryState && f.allies.length > 0) parts.push(`盟友：${f.allies.join('、')}`)
          if (hasBoundaryState && f.enemies.length > 0) parts.push(`敌对：${f.enemies.join('、')}`)
          lines.push(parts.join('；'))
        }
      }
    }
    if (arranged.locationIds.length > 0) {
      const locs = arranged.locationIds
        .map(resolveLocation)
        .filter((resolved): resolved is NonNullable<typeof resolved> => resolved != null)
      if (locs.length > 0) {
        lines.push('### 场景地点')
        for (const { entity: l, hasBoundaryState } of locs) {
          const parts = [`  - ${l.name}`]
          if (l.description) parts.push(l.description)
          if (l.type) parts.push(`类型：${promptLabel(l.type)}`)
          if (l.significance) parts.push(`重要性：${promptLabel(l.significance)}`)
          if (hasBoundaryState && l.status !== 'normal') parts.push(`状态：${promptLabel(l.status)}`)
          lines.push(parts.join('；'))
        }
      }
    }
    // ── 本章登场物品（含拥有者、状态、能力，让 Writer 知道谁能用什么、什么已损坏/封印）──
    if ((arranged.itemIds ?? []).length > 0) {
      const itemTypeLabel: Record<string, string> = {
        weapon: '武器',
        armor: '防具',
        artifact: '法宝',
        consumable: '消耗品',
        key: '关键道具',
        material: '材料',
        info: '情报物品',
        misc: '杂物'
      }
      const itemStatusLabel: Record<string, string> = {
        active: '可用',
        lost: '遗失',
        destroyed: '损毁',
        transformed: '已转化',
        sealed: '封印',
        transferred: '已易主'
      }
      const items = (arranged.itemIds ?? [])
        .map(resolveItem)
        .filter((resolved): resolved is NonNullable<typeof resolved> => resolved != null)
      if (items.length > 0) {
        // 用于把 ownerId 解析为角色名
        const allChars = [...characterById.values()]
        const charNameMap = new Map(allChars.map((c) => [c.id, c.name]))
        lines.push('本章登场物品（写作时必须遵守物品归属与状态约束）：')
        for (const { entity: it, hasBoundaryState } of items) {
          const parts = [`  - ${it.name}`]
          parts.push(`类型：${itemTypeLabel[it.type] ?? it.type}`)
          if (it.description) parts.push(it.description)
          if (hasBoundaryState) {
            if (it.ownerId) {
              const ownerName = charNameMap.get(it.ownerId) ?? it.ownerId
              parts.push(`持有者：${ownerName}`)
            } else {
              parts.push('持有者：无主')
            }
            parts.push(`状态：${itemStatusLabel[it.status] ?? it.status}`)
          }
          if (it.abilities) parts.push(`能力/效果：${it.abilities}`)
          if (hasBoundaryState && it.origin) parts.push(`来历：${it.origin}`)
          if (hasBoundaryState && it.firstChapter != null) parts.push(`首次出现：第 ${it.firstChapter} 章`)
          lines.push(parts.join('；'))
        }
      }
    }
    if ((arranged.clueIds ?? []).length > 0) {
      const clues = (arranged.clueIds ?? [])
        .map(resolveClue)
        .filter((resolved): resolved is NonNullable<typeof resolved> => resolved != null)
      if (clues.length > 0) {
        lines.push('本章线索：')
        for (const { entity: clue, hasBoundaryState } of clues) {
          const parts = [`  - ${clue.description}`]
          if (clue.pointsTo) parts.push(`指向：${clue.pointsTo}`)
          if (hasBoundaryState) parts.push(`进度：${clue.progress}%`)
          if (hasBoundaryState && clue.currentStep) parts.push(`当前步骤：${clue.currentStep}`)
          if (hasBoundaryState && clue.nextStep) parts.push(`⚡ 本章推进：${clue.nextStep}`)
          if (clue.isMisleading) parts.push('性质：误导线索，不得写成已证实事实')
          lines.push(parts.join('；'))
        }
      }
    }
    // 矩阵执行验收已移至 Reviewer 专属 suffix（2026-07-18），
    // 不再在共享层注入"Reviewer 必须逐项核对"以避免对 Director/Writer/Memory 的无效指令。
    return lines.join('\n')
  }

  /**
   * 对手戏欲望碰撞卡（P1-1）：把同场角色的目标、压力与信息差按"对"横向摆开。
   *
   * 数据全部来自既有实体（currentGoal/currentPressure + 关系 + 信息差表），
   * 规则拼装，不需要额外 LLM 调用。无可用配对或双方均无欲望/压力/信息差时
   * 返回空串——宁可不注入，不注入凑数段落。
   */
  private formatDesireCollision(
    characters: Array<{ entity: NovelCharacter; hasBoundaryState: boolean }>,
    relations: NovelRelationship[],
    infoLayers: NovelInformationLayer[]
  ): string {
    if (characters.length < 2) return ''
    const nameById = new Map(characters.map(({ entity }) => [entity.id, entity.name]))
    const charById = new Map(characters.map(({ entity }) => [entity.id, entity]))

    // 配对来源：优先用已登记关系；没有关系记录时，在非功能位角色间两两组合
    type Pair = { aId: string; bId: string; relation?: NovelRelationship }
    let pairs: Pair[] = relations.map((relation) => ({
      aId: relation.characterA,
      bId: relation.characterB,
      relation,
    }))
    if (pairs.length === 0) {
      const heavy = characters
        .map(({ entity }) => entity)
        .filter((c) => c.plotRole !== 'function' && c.plotRole !== 'background')
      pairs = []
      for (let i = 0; i < heavy.length && pairs.length < 4; i += 1) {
        for (let j = i + 1; j < heavy.length && pairs.length < 4; j += 1) {
          pairs.push({ aId: heavy[i].id, bId: heavy[j].id })
        }
      }
    }
    if (pairs.length === 0) return ''

    const alignmentLabel: Record<string, string> = {
      ally: '同一边',
      temporary_ally: '暂时同路',
      opponent: '对立',
      temporary_opponent: '暂时对立',
      neutral: '中立',
      pending_shift: '待转变'
    }
    const trendLabel: Record<string, string> = {
      stable: '稳定',
      warming: '升温',
      cooling: '降温',
      breaking: '即将破裂',
      reconciling: '和解中'
    }

    // 预解析信息差：characterKnowledge JSON 的键是"知道此事"的角色 id
    const knowledgeByLayer = infoLayers
      .filter((layer) => !layer.isRevealed)
      .map((layer) => {
        let knownBy = new Set<string>()
        try {
          const parsed = JSON.parse(layer.characterKnowledge ?? '{}') as Record<string, unknown>
          knownBy = new Set(Object.keys(parsed))
        } catch {
          knownBy = new Set()
        }
        return { description: layer.infoDescription, knownBy }
      })
      .filter((layer) => layer.description.trim().length > 0)

    const lines: string[] = ['### 对手戏欲望碰撞（同场角色对照，对话的潜台词引擎）']
    let pairCount = 0
    for (const pair of pairs.slice(0, 4)) {
      const a = charById.get(pair.aId)
      const b = charById.get(pair.bId)
      if (!a || !b) continue
      const headerParts: string[] = []
      if (pair.relation) {
        if (pair.relation.alignment) headerParts.push(alignmentLabel[pair.relation.alignment] ?? pair.relation.alignment)
        if (pair.relation.trend) headerParts.push(`走向${trendLabel[pair.relation.trend] ?? pair.relation.trend}`)
      }
      lines.push(`- ${a.name} ↔ ${b.name}${headerParts.length > 0 ? `（${headerParts.join('；')}）` : ''}`)
      let sideWritten = false
      for (const side of [a, b]) {
        const want = usableDetail(side.currentGoal) ? compactPromptText(side.currentGoal, CHARACTER_CARD_BUDGET.currentGoal) : ''
        const pressure = usableDetail(side.currentPressure) ? compactPromptText(side.currentPressure, CHARACTER_CARD_BUDGET.currentPressure) : ''
        if (!want && !pressure) continue
        const segs = [`  - ${side.name}`]
        if (want) segs.push(`想要：${want}`)
        if (pressure) segs.push(`压力：${pressure}`)
        lines.push(segs.join('；'))
        sideWritten = true
      }
      // 信息差：一方知道而另一方不知道的未揭示信息（每对最多一条）
      for (const layer of knowledgeByLayer) {
        const aKnows = layer.knownBy.has(a.id)
        const bKnows = layer.knownBy.has(b.id)
        if (aKnows === bKnows) continue
        const knower = aKnows ? a.name : b.name
        const blind = aKnows ? b.name : a.name
        lines.push(`  - 信息差：${knower} 知道而 ${blind} 不知道——${compactPromptText(layer.description, 120)}`)
        break
      }
      if (sideWritten) pairCount += 1
    }
    if (pairCount === 0) return ''
    lines.push(
      '  碰撞写作要求：欲望冲突必须通过台词与行动发生，不得由旁白宣布共识；双方达成任何一致都要付出代价。'
    )
    return lines.join('\n')
  }

  private hasArrangedEntities(arranged?: ArrangedEntity): boolean {
    return (
      !!arranged &&
      (arranged.characterIds.length > 0 ||
        arranged.conflictIds.length > 0 ||
        arranged.foreshadowIds.length > 0 ||
        (arranged.clueIds ?? []).length > 0 ||
        arranged.factionIds.length > 0 ||
        arranged.locationIds.length > 0 ||
        (arranged.itemIds ?? []).length > 0)
    )
  }

  /**
   * P0 埋点辅助：单独取一次「实体档案」section 文本（供 ContextSectionCollector 计量）。
   *
   * 与 buildChapterContextShared 内部 formatArrangedEntities 使用同一判定与同一构建路径，
   * **不改变任何 prompt 输出**；无编排实体时返回空串（调用方跳过埋点）。
   * 输出与 shared 内的实体档案 section 完全一致，保证"实体档案占 shared 比例"口径可算。
   */
  buildArrangedEntitiesSection(
    projectId: string,
    chapterNumber: number,
    arrangedEntities?: ArrangedEntity,
  ): string {
    if (!this.hasArrangedEntities(arrangedEntities) || !arrangedEntities) return ''
    const boundary = this.getChapterBoundaryContext(projectId, chapterNumber)
    return this.formatArrangedEntities(projectId, chapterNumber, arrangedEntities, boundary)
  }

  private collectRelevantEntityIds(arranged?: ArrangedEntity): Set<string> {
    const ids = new Set<string>()
    if (!arranged) return ids
    for (const id of arranged.characterIds) ids.add(id)
    for (const id of arranged.conflictIds) ids.add(id)
    for (const id of arranged.foreshadowIds) ids.add(id)
    for (const id of arranged.clueIds ?? []) ids.add(id)
    for (const id of arranged.factionIds) ids.add(id)
    for (const id of arranged.locationIds) ids.add(id)
    for (const id of arranged.itemIds ?? []) ids.add(id)
    return ids
  }

  /**
   * 收集本章相关的边（含派生边，C3 增强）
   *
   * 数据源优先级：
   * 1. relationshipGraph 提供：调用 getAllGraphEdges，包含派生边（冲突参与/势力敌对
   *    /盟友/地点归属/世界要素层级等 7 类），让 LLM 显式看到这些关系
   * 2. 未提供：降级到 stores.listEdges（仅手动边），保持向后兼容
   *
   * 过滤策略：按 relevantEntityIds 筛选与本章编排实体相关的边，避免上下文爆炸
   */
  private collectRelevantEdges(
    projectId: string,
    relevantEntityIds: Set<string>,
    boundary: ChapterBoundaryContext
  ): GraphEdge[] {
    const snapshotEdges = boundary.entities.edges.map((e) => ({
      id: e.id,
      sourceId: e.sourceId,
      sourceType: e.sourceType,
      targetId: e.targetId,
      targetType: e.targetType,
      edgeType: e.edgeType,
      label: e.label,
      auto: e.auto,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt
    }))
    const allEdges: GraphEdge[] = boundary.fromSnapshot
      ? snapshotEdges
      : this.relationshipGraph
        ? this.relationshipGraph.getAllGraphEdges(projectId)
        : snapshotEdges
    return this.filterRelevantEdges(allEdges, relevantEntityIds)
  }

  private filterRelevantEdges<T extends { sourceId: string; targetId: string }>(
    edges: T[],
    relevantEntityIds: Set<string>
  ): T[] {
    if (edges.length === 0) return []
    if (relevantEntityIds.size === 0) return edges.slice(0, RELATION_BUDGET.edgeCount)
    return edges
      .filter((e) => relevantEntityIds.has(e.sourceId) && relevantEntityIds.has(e.targetId))
      .slice(0, RELATION_BUDGET.edgeCount)
  }

  private filterRelevantInfoLayers(
    layers: NovelInformationLayer[],
    arranged?: ArrangedEntity,
    boundary?: ChapterBoundaryContext
  ): NovelInformationLayer[] {
    if (layers.length === 0) return []
    if (!arranged) {
      return layers.filter((layer) => !layer.isRevealed).slice(0, RELATION_BUDGET.infoLayerCount)
    }

    const relevantForeshadowIds = new Set(arranged.foreshadowIds)
    const relevantCharacterIds = new Set(arranged.characterIds)
    const relevantInfoLayerIds = new Set<string>()
    const edges = boundary?.entities.edges ?? []
    for (const edge of edges) {
      if (edge.edgeType !== 'related') continue
      if (
        edge.sourceType === 'foreshadow' &&
        edge.targetType === 'info_layer' &&
        relevantForeshadowIds.has(edge.sourceId)
      ) {
        relevantInfoLayerIds.add(edge.targetId)
      }
      if (
        edge.targetType === 'foreshadow' &&
        edge.sourceType === 'info_layer' &&
        relevantForeshadowIds.has(edge.targetId)
      ) {
        relevantInfoLayerIds.add(edge.sourceId)
      }
    }

    const relevant = layers.filter((layer) => {
      if (relevantInfoLayerIds.has(layer.id)) return true
      const linked = edges
        .filter(
          (e) =>
            e.edgeType === 'related' &&
            ((e.sourceId === layer.id && e.targetType === 'foreshadow') ||
              (e.targetId === layer.id && e.sourceType === 'foreshadow'))
        )
        .map((e) => (e.sourceId === layer.id ? e.targetId : e.sourceId))
      if (linked.some((id) => relevantForeshadowIds.has(id))) return true
      if (relevantCharacterIds.size === 0 || !layer.characterKnowledge) return false
      try {
        const knowledge = JSON.parse(layer.characterKnowledge) as Record<string, unknown>
        return [...relevantCharacterIds].some((id) => Object.hasOwn(knowledge, id))
      } catch {
        return false
      }
    })
    return relevant.slice(0, RELATION_BUDGET.infoLayerCount)
  }

  /**
   * 格式化故事状态（SEMI 层注入）：全量精简的角色/关系/冲突/伏笔/线索/势力/地点/物品。
   *
   * 只在**没有编排实体**时注入。有编排时由 formatArrangedEntities 给出本章实体的完整定义，
   * 非编排实体严格隔离，避免 Writer 主动写入未编排的冲突或伏笔、绕过编排控制。
   *
   * 触发场景：旧项目无编排、AI 编排失败降级、纯 Reviewer 评估无 arrangedEntities。
   *
   * 历史说明：本方法曾有一条"有编排则按 arrangedEntities 筛选"的分支，但唯一调用点
   * （buildChapterContextShared）只在 !hasArranged 时调用且从不传第二个参数，
   * 该分支自始不可达，已随死代码清理一并删除。
   */
  /**
   * 组装 story-state chunk：全量/摘要二选一，并在状态可能越界时附加警告。
   *
   * 越界场景：重写旧章节且无该章前快照（或快照全部失效），只能回退实体表
   * 「全书最新」状态——其中可能包含本章之后才发生的事实。不声明的话，
   * Writer 会把未来进展当既成事实写进正文，与用户章纲直接冲突。
   */
  private buildStoryStateChunk(
    boundary: ChapterBoundaryContext,
    options?: { entitySummaryMode?: 'full' | 'summary'; askStoryEnabled?: boolean },
  ): string {
    const body = options?.entitySummaryMode === 'summary'
      ? buildStoryStateSummary(boundary.state)
      : this.formatStoryState(boundary.state, options?.askStoryEnabled ?? true)
    if (!boundary.stateAheadOfBoundary) return body
    const warning = [
      '> ⚠️ 状态边界警告：以下是全书当前最新状态，可能包含本章之后才发生的进展。',
      '> 本章创作必须以「用户章纲」和「本章叙事任务」为准；',
      '> 上述仅适用于本章之后的事实一律不得写入本章正文，也不得让角色表现出尚未经历这些事件后的心态。',
    ].join('\n')
    return `${warning}\n\n${body}`
  }

  private formatStoryState(state: StoryState, askStoryEnabled: boolean): string {
    // 占位实体过滤：名字含“（待定）”/“待补充”/“新的”的是 AI 编排未命名的占位实体，
    // 对 Writer 无意义且污染上下文，跳过输出
    const isPlaceholder = (name: string): boolean =>
      /（待定）|待补充|待定$|^新的$|^测试角色/.test(name)

    const parts: string[] = ['## 当前故事状态']

    // 分段上限：每类实体保留精简数量，超过部分仅列名称，避免上下文膨胀
    // 完整字段请通过工具按需回查（见末尾"按需查询提示"）
    const LIMIT = STORY_STATE_LIMIT

    // 角色动态状态（过滤占位）
    const otherChars = state.characters.filter((c) => !isPlaceholder(c.name))
    if (otherChars.length > 0) {
      parts.push('\n### 角色当前状态')
      for (const c of otherChars.slice(0, LIMIT.characters)) {
        const lines = [`- **${c.name}**`]
        if (c.currentState) lines.push(`  状态：${c.currentState}`)
        if (c.currentGoal) lines.push(`  目标：${c.currentGoal}`)
        parts.push(lines.join('\n'))
      }
      if (otherChars.length > LIMIT.characters) {
        const rest = otherChars
          .slice(LIMIT.characters)
          .map((c) => c.name)
          .join('、')
        parts.push(`- 其余角色（仅列名，共 ${otherChars.length - LIMIT.characters} 个）：${rest}`)
      }
    }

    // 关系状态（精简：单行输出）
    const relationships = state.relationships
    if (relationships.length > 0) {
      parts.push('\n### 关系当前状态')
      for (const r of relationships.slice(0, LIMIT.relationships)) {
        parts.push(
          `- ${r.characterA} ↔ ${r.characterB}：${promptLabel(r.relationType)}（${promptLabel(r.currentStage)}）`
        )
      }
      if (relationships.length > LIMIT.relationships) {
        const rest = relationships
          .slice(LIMIT.relationships)
          .map((r) => `${r.characterA}↔${r.characterB}`)
          .join('、')
        parts.push(
          `- 其余关系（仅列名，共 ${relationships.length - LIMIT.relationships} 条）：${rest}`
        )
      }
    }

    // 活跃冲突（过滤占位）
    const otherConflicts = state.activeConflicts.filter((c) => !isPlaceholder(c.description))
    if (otherConflicts.length > 0) {
      parts.push('\n### 活跃冲突')
      for (const c of otherConflicts.slice(0, LIMIT.conflicts)) {
        parts.push(
          `- [${promptLabel(c.type)}] ${c.description}（${promptLabel(c.stage)}，强度 ${c.intensity}/10）`
        )
      }
      if (otherConflicts.length > LIMIT.conflicts) {
        const rest = otherConflicts
          .slice(LIMIT.conflicts)
          .map((c) => c.description)
          .join('、')
        parts.push(
          `- 其余冲突（仅列名，共 ${otherConflicts.length - LIMIT.conflicts} 条）：${rest}`
        )
      }
    }

    // 待回收伏笔（过滤占位）
    const otherForeshadows = state.pendingForeshadowing.filter((f) => !isPlaceholder(f.description))
    if (otherForeshadows.length > 0) {
      parts.push('\n### 伏笔状态')
      for (const f of otherForeshadows.slice(0, LIMIT.foreshadows)) {
        parts.push(`- [${promptLabel(f.status)}] ${f.description}`)
      }
      if (otherForeshadows.length > LIMIT.foreshadows) {
        const rest = otherForeshadows
          .slice(LIMIT.foreshadows)
          .map((f) => f.description)
          .join('、')
        parts.push(
          `- 其余伏笔（仅列名，共 ${otherForeshadows.length - LIMIT.foreshadows} 条）：${rest}`
        )
      }
    }

    // 活跃线索
    const activeClues = state.activeClues
    if (activeClues.length > 0) {
      parts.push('\n### 线索进度')
      for (const c of activeClues.slice(0, LIMIT.clues)) {
        parts.push(`- ${c.description}（${c.progress}%，下一步：${c.nextStep}）`)
      }
      if (activeClues.length > LIMIT.clues) {
        const rest = activeClues
          .slice(LIMIT.clues)
          .map((c) => c.description)
          .join('、')
        parts.push(`- 其余线索（仅列名，共 ${activeClues.length - LIMIT.clues} 条）：${rest}`)
      }
    }

    // 活跃势力（过滤占位）
    const realFactions = state.activeFactions.filter((f) => !isPlaceholder(f.name))
    if (realFactions.length > 0) {
      parts.push('\n### 活跃势力')
      for (const f of realFactions.slice(0, LIMIT.factions)) {
        const segs = [`- **${f.name}**`]
        if (f.type) segs.push(`类型：${promptLabel(f.type)}`)
        if (f.status) segs.push(`状态：${promptLabel(f.status)}`)
        parts.push(segs.join('；'))
      }
      if (realFactions.length > LIMIT.factions) {
        const rest = realFactions
          .slice(LIMIT.factions)
          .map((f) => f.name)
          .join('、')
        parts.push(`- 其余势力（仅列名，共 ${realFactions.length - LIMIT.factions} 个）：${rest}`)
      }
    }

    // 已登场地点（过滤占位）
    const realLocations = state.activeLocations.filter((l) => !isPlaceholder(l.name))
    if (realLocations.length > 0) {
      parts.push('\n### 已登场地点')
      for (const l of realLocations.slice(0, LIMIT.locations)) {
        const segs = [`- **${l.name}**`]
        if (l.type) segs.push(`类型：${promptLabel(l.type)}`)
        parts.push(segs.join('；'))
      }
      if (realLocations.length > LIMIT.locations) {
        const rest = realLocations
          .slice(LIMIT.locations)
          .map((l) => l.name)
          .join('、')
        parts.push(`- 其余地点（仅列名，共 ${realLocations.length - LIMIT.locations} 个）：${rest}`)
      }
    }

    // 物品归属（按持有者分组，让 Writer 知道每个角色拥有什么）
    const realItems = state.items.filter((i) => !isPlaceholder(i.name))
    if (realItems.length > 0) {
      const charNameMap = new Map(state.characters.map((c) => [c.id, c.name]))
      const itemStatusLabel: Record<string, string> = {
        active: '可用',
        lost: '遗失',
        destroyed: '损毁',
        transformed: '已转化',
        sealed: '封印',
        transferred: '已易主'
      }
      const shownItems = realItems.slice(0, LIMIT.items)
      const ownerToItems = new Map<string, typeof realItems>()
      const orphanItems: typeof realItems = []
      for (const it of shownItems) {
        if (it.ownerId) {
          const list = ownerToItems.get(it.ownerId) ?? []
          list.push(it)
          ownerToItems.set(it.ownerId, list)
        } else {
          orphanItems.push(it)
        }
      }
      parts.push('\n### 物品归属')
      for (const [ownerId, items] of ownerToItems) {
        const ownerName = charNameMap.get(ownerId) ?? ownerId
        const itemDescs = items.map(
          (it) =>
            `${it.name}（${itemStatusLabel[it.status] ?? it.status}${it.type ? `·${it.type}` : ''}）`
        )
        parts.push(`- **${ownerName}**：${itemDescs.join('、')}`)
      }
      if (orphanItems.length > 0) {
        const orphanDescs = orphanItems.map(
          (it) => `${it.name}（${itemStatusLabel[it.status] ?? it.status}）`
        )
        parts.push(`- **无主**：${orphanDescs.join('、')}`)
      }
      if (realItems.length > LIMIT.items) {
        const rest = realItems
          .slice(LIMIT.items)
          .map((it) => it.name)
          .join('、')
        parts.push(`- 其余物品（仅列名，共 ${realItems.length - LIMIT.items} 件）：${rest}`)
      }
    }

    // 工具回查引导只列出本次 session 实际可用的工具，避免 Agent 请求不可见能力。
    parts.push('\n## 按需查询提示')
    if (askStoryEnabled) {
      parts.push('以上为精简快照。如需完整字段，请调用工具：')
      parts.push('- novel_ask_story（自然语言提问，如"角色林深的当前目标是什么？"）')
    } else {
      parts.push('以上为精简快照。请仅依据已注入的章节上下文完成当前职责。')
    }

    return parts.join('\n')
  }

  /**
   * 格式化信息差
   *
   * P3-2：扩展展示关联伏笔描述，让 Writer/Reviewer 意识到"这个信息差由哪些伏笔承载"，
   * 在写作时能协同伏笔回收与信息差揭露的时机，避免伏笔回收时未同步翻转读者认知。
   */
  private formatInfoLayers(
    projectId: string,
    layers: NovelInformationLayer[],
    arranged?: ArrangedEntity,
    boundary?: ChapterBoundaryContext
  ): string {
    void projectId
    const parts: string[] = ['## 信息差']
    const allowedCharacterIds = arranged ? new Set(arranged.characterIds) : null
    const allowedForeshadowIds = arranged ? new Set(arranged.foreshadowIds) : null
    const characters = new Map(
      (boundary?.entities.characters ?? []).map((character) => [character.id, character])
    )
    const foreshadows = new Map(
      (boundary?.entities.foreshadowing ?? []).map((foreshadow) => [foreshadow.id, foreshadow])
    )
    const edges = boundary?.entities.edges ?? []
    for (const layer of layers) {
      const readerStatus = layer.readerKnows ? '读者已知' : '读者未知'
      const revealStatus = layer.isRevealed ? '已揭露' : `计划揭露：${layer.revealStage ?? '未定'}`
      const head = `- ${layer.infoDescription}（${readerStatus}，${revealStatus}）`
      const details: string[] = []
      if (layer.characterKnowledge) {
        try {
          const knowledge = JSON.parse(layer.characterKnowledge) as Record<string, unknown>
          for (const [characterId, raw] of Object.entries(knowledge)) {
            if (allowedCharacterIds && !allowedCharacterIds.has(characterId)) continue
            const character = characters.get(characterId)
            if (!character || typeof raw !== 'object' || raw === null) continue
            const item = raw as { knows?: boolean; suspects?: boolean; misunderstands?: string }
            const states: string[] = []
            if (item.knows) states.push('知道')
            else if (item.suspects) states.push('怀疑')
            else states.push('不知道')
            if (item.misunderstands) states.push(`误解：${item.misunderstands}`)
            details.push(`  - ${character.name}：${states.join('；')}`)
          }
        } catch {
          // 兼容旧数据：非法 JSON 不阻断提示词构建。
        }
      }
      // ── P3-2：解析 linkedForeshadows 反向展示关联伏笔 ──
      // 让 Agent 知道本信息差由哪些伏笔承载，写作时协同回收时机
      // 关联关系已迁移至 novel_edges 表（info_layer ↔ foreshadow）
      const linkedIds = edges
        .filter(
          (e) =>
            e.edgeType === 'related' &&
            ((e.sourceId === layer.id && e.targetType === 'foreshadow') ||
              (e.targetId === layer.id && e.sourceType === 'foreshadow'))
        )
        .map((e) => (e.sourceId === layer.id ? e.targetId : e.sourceId))
        .filter((id) => !allowedForeshadowIds || allowedForeshadowIds.has(id))
      if (linkedIds.length > 0) {
        const linkedDescs: string[] = []
        for (const fid of linkedIds) {
          const f = foreshadows.get(fid)
          if (f) {
            linkedDescs.push(`${f.description}（${promptLabel(f.status)}）`)
          }
        }
        if (linkedDescs.length > 0) {
          parts.push([head, ...details, `  - 承载伏笔：${linkedDescs.join('；')}`].join('\n'))
          continue
        }
      }
      parts.push([head, ...details].join('\n'))
    }
    return parts.join('\n')
  }

  /** 容错解析 JSON 字符串数组（旧数据/非法 JSON 返回空数组） */
  private parseIdListSafe(raw: string | null | undefined): string[] {
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === 'string')
      }
    } catch {
      // 旧数据可能不是 JSON，忽略
    }
    return []
  }

  /**
   * 格式化实体关联（画布手动 + 派生自动边）
   *
   * 将画布上的手动 + 自动边格式化为可读文本，让 Agent 能感知
   * 用户在画布上建立的角色出场、势力归属、地点场景等关联关系，
   * 以及从实体 JSON 字段派生的冲突参与、势力敌对/盟友、地点层级等关系。
   *
   * C3 增强：edges 类型从 NovelEdge 改为 GraphEdge，以兼容派生边
   * （派生边的 fromRelationship/relationship 字段在 formatEdges 中不访问）
   */
  private formatEdges(
    projectId: string,
    edges: GraphEdge[],
    boundary?: ChapterBoundaryContext
  ): string {
    const nameMap = boundary?.fromSnapshot
      ? this.buildBoundaryEntityNameMap(projectId, boundary.entities)
      : this.buildEntityNameMap(projectId)
    // 过滤 involvement 派生边：冲突参与方信息已在 formatArrangedEntities 的"本章冲突"
    // "参与方"字段中体现，重复注入会浪费 token 且无新信息。
    // 仅过滤自动派生边（auto=true），保留手动边（用户明确标注的 involvement）。
    // 修复（2026-07-18）。
    const filteredEdges = edges.filter((e) => !(e.auto && e.edgeType === 'involvement'))
    if (filteredEdges.length === 0) return ''
    const lines = filteredEdges.map((e) => {
      const sourceName = nameMap.get(e.sourceId) ?? e.sourceId
      const targetName = nameMap.get(e.targetId) ?? e.targetId
      const label = e.label ? `：${e.label}` : ''
      const origin = e.auto ? '（自动）' : '（手动）'
      return `- ${sourceName}（${promptLabel(e.sourceType)}）—[${promptLabel(e.edgeType)}]→ ${targetName}（${promptLabel(e.targetType)}）${label}${origin}`
    })
    return `## 实体关联\n\n${lines.join('\n')}`
  }

  /** 格式化最近章节摘要 */
  private formatRecentSummaries(chapters: NovelChapter[]): string {
    const parts: string[] = ['## 最近章节摘要']
    for (const ch of chapters) {
      // 优先使用 Memory Agent 生成的 recap 字段（50-100 字真实剧情摘要）。
      // recap 是章节完成后由 generateChapterRecap 调用 LLM 提炼的真正剧情梗概，
      // 包含核心事件和关键转折，能让下游 Agent 准确理解前后文因果。
      //
      // 历史问题（2026-07 修复）：
      // - 旧实现用 content.slice(0, 300) 截取正文开头作为"摘要"。
      //   但正文开头往往是场景描写/对话切入，并非剧情概括，导致下游 Agent
      //   看到的"摘要"既不是真正的剧情梗概，又损失了章末关键转折信息。
      // - 用 narrativeTask 作摘要更不可靠——它是章纲标签（如"推进主线"），
      //   不是剧情摘要。
      //
      // 回退链：recap（真实摘要）→ content.slice(0, 300)（正文开头兜底）
      // → narrativeTask（章纲标签兜底）→ (无正文)
      let summary: string
      if (ch.recap && ch.recap.trim().length > 0) {
        // Memory Agent 生成的真实剧情摘要，直接使用
        summary = ch.recap.trim()
      } else if (ch.content && ch.content.trim().length > 50) {
        // recap 缺失（章节刚生成、Memory Agent 尚未生成 recap，或生成失败）：
        // 回退到正文开头 300 字兜底，保证有内容可用
        summary = ch.content.trim().slice(0, CHAPTER_ANCHOR_BUDGET.recapFallback)
        if (ch.content.length > 300) summary += '...'
      } else if (ch.narrativeTask) {
        summary = ch.narrativeTask
      } else {
        summary = '(无正文)'
      }
      parts.push(`- 第${ch.chapterNumber}章《${ch.title}》：${summary}`)
    }
    return parts.join('\n')
  }

  /**
   * 格式化上一章结尾段落（衔接锚点）。
   *
   * 设计意图：
   * - Writer 必须知道上一章如何收尾，才能让本章开头自然承接上一章的钩子。
   * - 注入上一章结尾 200-400 字，作为衔接的硬性锚点。
   * - 若无上一章（第1章或无内容），返回空字符串。
   */
  private formatPreviousChapterEnding(recentChapters: NovelChapter[]): string {
    // recentChapters 是升序（旧→新），取最后一章有内容的结尾（即第 N-1 章）
    // ⚠️ 顺序修正：listRecentChapters 返回升序（ORDER BY DESC + reverse），
    // 之前注释误写为"倒序"，导致取到最旧的章节而非第 N-1 章。
    for (let i = recentChapters.length - 1; i >= 0; i--) {
      const ch = recentChapters[i]
      if (ch.content && ch.content.trim().length > 100) {
        const content = ch.content.trim()
        // 取结尾原文（覆盖完整的场景收尾 + 钩子 + 场景切换节奏）。
        // 这是 Writer 在全新会话里能接触到的唯一大段前文逐字原文——续写语感靠它。
        const budget = CHAPTER_ANCHOR_BUDGET.previousEnding
        const ending =
          content.length > budget
            ? content.slice(-budget)
            : content
        const prefix = content.length > budget ? '...' : ''
        return [
          '## 上一章结尾原文（你在续写一部已有的长篇）',
          '',
          `以下是第${ch.chapterNumber}章《${ch.title}》的结尾原文。本章是它的下一章：语感、句子呼吸、称谓习惯、场景切换方式都要从这里自然延续；未落地的动作和悬念钩子必须先承接。只延续，不复述、不改写、不重复这段文字。`,
          '',
          `${prefix}${ending}`,
        ].join('\n')
      }
    }
    return ''
  }

  /**
   * 格式化叙事声音锚点：最近章节中按章节号稳定选取的代表片段。
   *
   * 设计意图：
   * - 风格指南是静态规则（"用短句""避免华丽修辞"），无法捕捉一部小说的整体声音质感
   * - 注入最近章节不同位置的代表片段（约 200 字），让 LLM 感受叙事腔调
   * - 不固定取开头，避免连续章节把同一种开场骨架互相复制
   * - Writer 据此保持声音一致；Reviewer 据此检查声音偏差
   */
  private formatSoundAnchor(recentChapters: NovelChapter[]): string {
    // 只有没有严重形态问题的前文才能作为声音示范。
    // 剧情承接与声音模仿必须分开：一个章节可以在事实层有效，但文笔层不值得复制。
    const anchors: string[] = []
    for (let i = recentChapters.length - 1; i >= 0; i--) {
      const ch = recentChapters[i]
      if (ch.content && ch.content.trim().length > 50) {
        const report = evaluateProseQuality(ch.content)
        const hasSevereShapeIssue = report.issues.some((issue) => issue.severity === 'error')
        if (!hasSevereShapeIssue) {
          const excerpt = this.selectSoundAnchorExcerpt(ch)
          anchors.push(
            `- 第${ch.chapterNumber}章代表片段：${excerpt}`
          )
        }
      }
      if (anchors.length >= 2) break
    }
    if (anchors.length === 0) return ''
    return [
      '## 叙事声音锚点（只参考自然观察和句子呼吸）',
      '',
      '以下前文已通过确定性形态筛选。只参考观察距离、句子呼吸和用词来源，不复用具体句式、比喻或开头结构。',
      '',
      anchors.join('\n'),
    ].join('\n')
  }

  /**
   * 在前段、中段、后段之间按章节号轮换取样。选择是确定性的，既不破坏缓存，
   * 也避免所有声音锚点都示范相同的章节开场结构。
   */
  private selectSoundAnchorExcerpt(chapter: NovelChapter): string {
    const content = chapter.content.trim()
    const paragraphs = content
      .split(/\n+/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length >= 20)
    if (paragraphs.length === 0) {
      return compactPromptText(content, CHAPTER_ANCHOR_BUDGET.soundAnchorExcerpt)
    }

    const sampleRatios = [0.2, 0.5, 0.75] as const
    const ratio = sampleRatios[(Math.max(1, chapter.chapterNumber) - 1) % sampleRatios.length]
    const start = Math.floor((paragraphs.length - 1) * ratio)
    const selected: string[] = []
    let selectedLength = 0
    for (let index = start; index < paragraphs.length; index += 1) {
      const paragraph = paragraphs[index]
      if (!paragraph) continue
      if (selected.length > 0 && selectedLength + paragraph.length > CHAPTER_ANCHOR_BUDGET.soundAnchorExcerpt) {
        break
      }
      selected.push(paragraph)
      selectedLength += paragraph.length
      if (selectedLength >= CHAPTER_ANCHOR_BUDGET.soundAnchorExcerpt) break
    }
    return compactPromptText(selected.join(' '), CHAPTER_ANCHOR_BUDGET.soundAnchorExcerpt)
  }

  /**
   * 格式化下一章开头锚点（前向衔接）。
   *
   * 设计意图：
   * - 重新生成中间章节时，后续章节可能已有内容。若不注入下一章信息，Writer 生成的
   *   本章结尾可能与已存在的下一章开头对不上，导致剧情断裂。
   * - 注入下一章开头 200-400 字 + recap（前情提要），让 Writer 知道本章结尾钩子
   *   要自然过渡到什么场景，保持章节间衔接连贯。
   * - 仅当下一章有实际内容时返回，否则返回空字符串（正常顺序生成时下一章不存在）。
   *
   * 与 formatPreviousChapterEnding 成对：前者向后看（本章开头承接上一章钩子），
   * 本方法向前看（本章结尾过渡到下一章场景），形成双向衔接锚定。
   */
  private formatNextChapterAnchor(nextChapter: NovelChapter | undefined): string {
    if (!nextChapter) return ''
    const content = nextChapter.content?.trim() ?? ''
    // 下一章内容过短（如刚创建的 planned 状态空章节）不注入，避免误导 Writer
    if (content.length < 50) return ''
    // 取开头 400 字（覆盖一个完整的场景切入，让 Writer 知道过渡目标）
    const opening = content.slice(0, CHAPTER_ANCHOR_BUDGET.nextChapterOpening)
    const suffix = content.length > 400 ? '...' : ''
    // recap 是 Memory Agent 为下一章生成的前情提要（50-100 字），比正文开头更能
    // 概括下一章核心事件。若存在则一并注入，让 Writer 双重锚定过渡目标。
    const recap = nextChapter.recap?.trim()
    const recapLine =
      recap && recap.length > 0 ? `\n\n第${nextChapter.chapterNumber}章前情提要：${recap}` : ''
    return `## 下一章开头（本章结尾必须自然过渡到此处的场景，钩子要对得上）\n\n第${nextChapter.chapterNumber}章《${nextChapter.title}》开头：\n\n${opening}${suffix}${recapLine}`
  }

  /**
   * 格式化未兑现钩子列表（v0.2）。
   *
   * 设计意图：
   * - Writer 必须承接上一章抛出的悬念，否则章节衔接断裂
   * - 注入未兑现钩子的描述，让 Writer 知道本章开头要承接什么
   * - 与 formatPreviousChapterEnding 配合：前者是上一章结尾原文，这里是悬念的结构化描述
   */
  private formatUnfulfilledHooks(hooks: NovelHook[]): string {
    const lines = hooks.map(
      (h) => `- 第${h.chapterNumber}章 ${promptLabel(h.hookType)}钩子：${h.description}`
    )
    return `## 未兑现钩子（本章开头必须自然承接以下悬念，否则读者会感到断裂）\n\n${lines.join('\n')}`
  }

  /**
   * 格式化宏观节奏分布：最近 10 章的节奏类型统计。
   *
   * 设计意图：
   * - 让 Director 在规划时看到宏观节奏曲线，避免连续高潮或连续铺垫
   * - 标注连续高潮/转折次数，提醒是否需要 breather 缓冲
   */
  private formatMacroRhythm(projectId: string, currentChapterNumber: number): string {
    // 获取最近 10 章（不含当前章）
    const recent = this.stores
      .listRecentChapters(projectId, 10)
      .filter((ch) => ch.chapterNumber < currentChapterNumber)
      .sort((a, b) => a.chapterNumber - b.chapterNumber)
    if (recent.length === 0) return ''

    const rhythms = recent.map((ch) => ch.rhythm ?? 'setup')
    const rhythmCounts = new Map<string, number>()
    for (const r of rhythms) rhythmCounts.set(r, (rhythmCounts.get(r) ?? 0) + 1)

    // 计算连续高潮/转折次数
    let consecutiveClimax = 0
    for (let i = rhythms.length - 1; i >= 0; i--) {
      if (rhythms[i] === 'climax' || rhythms[i] === 'twist') consecutiveClimax++
      else break
    }

    const lines = ['## 最近章节节奏分布（宏观节奏管理参考）', '']
    lines.push(
      `最近 ${recent.length} 章节奏序列：${rhythms.map((r) => promptLabel(r)).join(' → ')}`
    )
    lines.push('')
    lines.push('节奏统计：')
    for (const [rhythm, count] of rhythmCounts) {
      lines.push(`- ${promptLabel(rhythm)}：${count} 章`)
    }
    if (consecutiveClimax >= 2) {
      lines.push('')
      lines.push(`⚠️ 已连续 ${consecutiveClimax} 章高潮/转折，本章建议安排缓冲或铺垫节奏`)
    }
    return lines.join('\n')
  }

  /**
   * 格式化 Reviewer 反馈摘要：最近 3 章已审稿章节的 Reviewer 结论和关键问题。
   *
   * 设计意图：
   * - 如果 Reviewer 连续多章发现同类问题，Director 应该知道并改进规划
   * - 提取 Reviewer 日志中的结论（accept/revise/reject）和问题摘要
   *
   * 修复（2026-07-18）：
   * - 原实现按 created_at DESC 返回最近 20 条 reviewer 日志，未按 chapterNumber 过滤，
   *   导致 Director 规划第 10 章时可能拿到第 10 章本身的重试日志（status=success 但
   *   result 解析失败 → 显示"第10章审稿结论：unknown × 3"）。
   * - 修复：只取 chapterNumber < currentChapterNumber 的日志，按章节号去重（同章节
   *   多次重试只保留最新一条），按章节号降序取最近 3 章。
   * - 正则解析增强：兼容 JSON 格式（reviewerV2/PostWriteGuard 输出的结构化结果）。
   *
   * @param projectId 项目 ID
   * @param currentChapterNumber 当前正在创作的章节号（仅展示此章之前的已审稿章节）
   */
  private formatReviewerFeedback(projectId: string, currentChapterNumber: number): string {
    if (!this.stores.listAgentLogsByProject) return ''
    const logs = this.stores.listAgentLogsByProject(projectId, 50)
    // 筛选 Reviewer 日志：只看当前章之前的已审稿章节，避免拿到当前章的重试日志
    const reviewerLogs = logs
      .filter(
        (l) =>
          l.agentType === 'reviewer' &&
          l.status === 'success' &&
          l.chapterNumber < currentChapterNumber
      )
      // 同章节多次重试只保留最新一条（按 createdAt 降序后去重）
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .filter(
        (log, index, arr) => arr.findIndex((x) => x.chapterNumber === log.chapterNumber) === index
      )
      .sort((a, b) => b.chapterNumber - a.chapterNumber)
      .slice(0, 3)
    if (reviewerLogs.length === 0) return ''

    const lines = ['## 最近审稿反馈（改进规划参考）', '']
    for (const log of reviewerLogs) {
      const verdict = this.extractReviewerVerdict(log.result)
      const issues = this.extractReviewerIssues(log.result)
      lines.push(`- 第${log.chapterNumber}章审稿结论：${verdict}`)
      if (issues.length > 0) {
        lines.push(`  关键反馈：${issues.join('；')}`)
      }
    }
    return lines.join('\n')
  }

  /**
   * 从 Reviewer 日志 result 字段提取审稿结论。
   *
   * 兼容多种格式：
   * - 自然语言：包含"结论：accept"/"审稿结论: revise"等
   * - JSON 结构化：reviewerV2/PostWriteGuard 输出的 {"verdict": "accept", ...}
   * - 包含中文结论词：通过/需修订/拒绝
   */
  private extractReviewerVerdict(result: string | null | undefined): string {
    if (!result) return 'unknown'
    const text = result.slice(0, 500)
    // 1. 英文关键词（accept/revise/reject）
    const enMatch = text.match(/(?:结论|verdict|conclusion)[:：]\s*(accept|revise|reject)/i)
    if (enMatch) return enMatch[1].toLowerCase()
    // 2. JSON 结构化字段
    const jsonMatch = text.match(/"verdict"\s*:\s*"(accept|revise|reject)"/i)
    if (jsonMatch) return jsonMatch[1].toLowerCase()
    // 3. 中文关键词
    if (/通过|accept/i.test(text)) return 'accept'
    if (/需?修订|需?修改|revise/i.test(text)) return 'revise'
    if (/拒绝|驳回|reject/i.test(text)) return 'reject'
    return 'unknown'
  }

  /**
   * 从 Reviewer 日志 result 字段提取关键问题/建议。
   *
   * 匹配包含"问题""建议""扣分"等关键词的行，最多 3 条。
   */
  private extractReviewerIssues(result: string | null | undefined): string[] {
    if (!result) return []
    const text = result.slice(0, 800)
    return text
      .split('\n')
      .filter((l) => /问题|建议|扣分|不足|缺陷|漏洞/.test(l))
      .map((l) => l.trim().replace(/^[-•*]\s*/, ''))
      .filter((l) => l.length > 0 && l.length < 200)
      .slice(0, 3)
  }

  /**
   * 收集账本上下文里出现的所有 subjectId/targetId，反查实体显示名。
   * 返回 id → name 映射。反查失败的 id 不放入映射（格式化时回退到 type:id）。
   */
  private buildSubjectNameMap(
    projectId: string,
    context: ChapterStoryContext
  ): Map<string, string> {
    const ids = new Set<string>()
    for (const s of context.stateBeforeChapter) {
      ids.add(s.subjectId)
      if (s.targetId) ids.add(s.targetId)
    }
    for (const c of context.plannedChanges) {
      ids.add(c.subjectId)
      if (c.targetId) ids.add(c.targetId)
    }
    for (const c of context.unresolvedDebts) {
      ids.add(c.subjectId)
      if (c.targetId) ids.add(c.targetId)
    }
    for (const fc of context.futureCommitments) {
      for (const c of fc.changes) {
        ids.add(c.subjectId)
        if (c.targetId) ids.add(c.targetId)
      }
    }
    if (ids.size === 0) return new Map()

    const nameMap = new Map<string, string>()
    for (const id of ids) {
      // 按 subjectType 顺序尝试反查；NovelPromptStores 的 getXxx 方法按 ID 查询
      // 字段名差异：character/faction/location/item 用 name；conflict/foreshadow/clue 用 description
      const character = this.stores.getCharacter(id)
      if (character) {
        nameMap.set(id, character.name)
        continue
      }
      const conflict = this.stores.getConflict(id)
      if (conflict) {
        nameMap.set(id, conflict.description)
        continue
      }
      const foreshadow = this.stores.getForeshadow(id)
      if (foreshadow) {
        nameMap.set(id, foreshadow.description)
        continue
      }
      const clue = this.stores.getClue(id)
      if (clue) {
        nameMap.set(id, clue.description)
        continue
      }
      const faction = this.stores.getFaction(id)
      if (faction) {
        nameMap.set(id, faction.name)
        continue
      }
      const location = this.stores.getLocation(id)
      if (location) {
        nameMap.set(id, location.name)
        continue
      }
      const item = this.stores.getItem(id)
      if (item) {
        nameMap.set(id, item.name)
        continue
      }
      // info_layer / world_element / relationship 暂无 getXxx，跳过
    }
    return nameMap
  }

  /** 把反查到的实体名注入到 ChapterStoryContext 的状态项里，供 formatStoryLedgerContext 使用 */
  private injectSubjectNames(context: ChapterStoryContext, nameMap: Map<string, string>): void {
    for (const s of context.stateBeforeChapter) {
      s.subjectName = nameMap.get(s.subjectId)
      if (s.targetId) s.targetName = nameMap.get(s.targetId)
    }
    // plannedChanges / unresolvedDebts / futureCommitments.changes 是 NovelChangeRecord，
    // 没有独立的 subjectName 字段；formatStoryLedgerContext 通过同一个 nameMap 反查。
  }

  private formatStoryLedgerContext(
    context: ChapterStoryContext,
    arrangedEntities?: ArrangedEntity,
    names = new Map<string, string>()
  ): string {
    const arrangedIds = this.collectRelevantEntityIds(arrangedEntities)
    const hasArrangedFilter = arrangedIds.size > 0
    const recentChapterFloor = Math.max(
      1,
      context.chapterNumber - LEDGER_BUDGET.recentChangeLookback
    )
    const dimensionLabels: Record<string, string> = {
      'character.state': '状态',
      'character.goal': '目标',
      'character.pressure': '压力',
      'character.cognition': '认知',
      'character.arc_stage': '成长状态',
      'conflict.stage': '冲突进展',
      'conflict.intensity': '冲突强度',
      'foreshadow.beat': '伏笔动作',
      'foreshadow.payoff_chapter': '伏笔回收时点',
      'clue.progress': '线索进展',
      'faction.status': '势力状态',
      'faction.activity': '势力动态',
      'item.holder': '物品归属',
      'item.status': '物品状态',
      'relationship.stage': '关系进展',
      'relationship.alignment': '关系立场'
    }

    const labelFor = (subjectType: string, subjectId: string, suppliedName?: string): string =>
      suppliedName || names.get(subjectId) || `${promptLabel(subjectType)}相关事项`

    const valueFor = (value: unknown): string => {
      if (value == null || value === '') return '暂无明确结果'
      if (typeof value === 'string') return compactPromptText(promptLabel(value), 160)
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      if (typeof value !== 'object') return String(value)

      const record = value as Record<string, unknown>
      const fields: Array<[string, string]> = [
        ['currentState', '状态'],
        ['currentGoal', '目标'],
        ['currentPressure', '压力'],
        ['stage', '进展'],
        ['status', '状态'],
        ['currentStep', '当前进展'],
        ['nextStep', '下一步'],
        ['progress', '进度'],
        ['pointsTo', '指向']
      ]
      const parts = fields.flatMap(([key, label]) => {
        const fieldValue = record[key]
        if (fieldValue == null || fieldValue === '') return []
        return [`${label}：${compactPromptText(promptLabel(String(fieldValue)), 96)}`]
      })
      return parts.length > 0 ? parts.join('；') : '已有记录'
    }

    const isRelevant = (
      subjectType: string,
      subjectId: string,
      dimension: string,
      value: unknown
    ): boolean => {
      if (dimension === 'character.conflict_link' || dimension.endsWith('.created')) return false
      if (hasArrangedFilter && !arrangedIds.has(subjectId)) return false
      if (subjectType === 'conflict' && valueFor(value) === '已解决') return false
      return true
    }

    const changeLine = (
      change: {
        subjectType: string
        subjectId: string
        targetType: string | null
        targetId: string | null
        dimension: string
        afterValue: unknown
        reason: string
      },
      suppliedName?: string
    ): string => {
      const subject = labelFor(change.subjectType, change.subjectId, suppliedName)
      const target = change.targetId
        ? `与${labelFor(change.targetType ?? '', change.targetId)}`
        : ''
      const label = dimensionLabels[change.dimension] ?? '状态变化'
      const reason = change.reason
        ? `；缘由：${compactPromptText(change.reason, LEDGER_BUDGET.changeReason)}`
        : ''
      return `- ${subject}${target}：${label}变为「${valueFor(change.afterValue)}」${reason}`
    }

    const sections: string[] = []
    const recentStateLines = context.stateBeforeChapter
      .filter((state) => state.effectiveChapter >= recentChapterFloor)
      .filter((state) =>
        isRelevant(state.subjectType, state.subjectId, state.dimension, state.value)
      )
      .sort(
        (a, b) =>
          b.effectiveChapter - a.effectiveChapter || b.effectiveSceneOrder - a.effectiveSceneOrder
      )
      .slice(0, LEDGER_BUDGET.recentChangeCount)
      .map((state) => changeLine({ ...state, afterValue: state.value }, state.subjectName))
    if (recentStateLines.length > 0) {
      sections.push(
        `### 最近承接（第${recentChapterFloor}-${context.chapterNumber - 1}章）\n${recentStateLines.join('\n')}`
      )
    }

    const planLines = context.plannedChanges
      .filter((change) =>
        isRelevant(change.subjectType, change.subjectId, change.dimension, change.afterValue)
      )
      .slice(0, LEDGER_BUDGET.plannedChangeCount)
      .map((change) => changeLine(change))
    if (planLines.length > 0) {
      sections.push(`### 本章账本计划（应服务于本章写作核心）\n${planLines.join('\n')}`)
    }

    const futureLines = context.futureCommitments
      .filter(({ changes }) =>
        changes.some((change) =>
          isRelevant(change.subjectType, change.subjectId, change.dimension, change.afterValue)
        )
      )
      .sort((a, b) => a.event.chapterNumber - b.event.chapterNumber)
      .slice(0, LEDGER_BUDGET.futureCommitmentCount)
      .map(
        ({ event }) =>
          `- 第${event.chapterNumber}章将继续：${compactPromptText(event.title, LEDGER_BUDGET.commitmentTitle)}`
      )
    if (futureLines.length > 0) {
      sections.push(`### 后文边界（仅用于避免提前写完）\n${futureLines.join('\n')}`)
    }

    const annotationLabels: Record<string, string> = {
      intent: '作者意图',
      warning: '注意',
      note: '批注',
      constraint: '约束'
    }
    const annotationLines = context.annotations
      .filter((annotation) => annotation.includeInPrompt)
      .slice(0, LEDGER_BUDGET.annotationCount)
      .map(
        (annotation) =>
          `- ${annotationLabels[annotation.kind] ?? '作者批注'}：${compactPromptText(annotation.content, LEDGER_BUDGET.annotationContent)}`
      )
    if (annotationLines.length > 0) {
      sections.push(`### 作者批注\n${annotationLines.join('\n')}`)
    }

    return sections.length > 0 ? `## 账本承接\n\n${sections.join('\n\n')}` : ''
  }

  /**
   * 全局关键事实摘要（diff 模式专用，替代 formatStoryState）。
   *
   * 从 boundary.entities 提取 Top-N 关键标识，紧凑输出 ≤500 字摘要：
   * 主角当前态势、核心冲突 Top 3、关键未回收伏笔 Top 3、进行中线索 Top 2。
   * 不展开全部字段，让 LLM 拿到"全局态势骨架"即可，详情由 query_state 工具按需查询。
   *
   * 过滤规则：
   * - 主角：characters.find(isProtagonist)，无主角则取前 2 个角色（仅名字 + 身份）
   * - 核心冲突：排除 resolved/transformed，按 intensity 降序取 Top 3
   * - 关键伏笔：仅 planted/reinforced，取 Top 3
   * - 进行中线索：progress < 100，按 progress 降序取 Top 2
   * 字段缺失时跳过，不显示"未设定"；枚举值复用 promptLabel 翻译。
   */
  private formatGlobalKeyFacts(
    projectId: string,
    boundary: ChapterBoundaryContext,
    arrangedEntities?: ArrangedEntity
  ): string {
    void projectId
    void arrangedEntities
    const { characters, conflicts, foreshadowing, clues } = boundary.entities
    const sections: string[] = []

    // ── 主角 ──
    const protagonist = characters.find((c) => c.isProtagonist)
    const charLines: string[] = []
    if (protagonist) {
      const segs: string[] = [`${protagonist.name}：${compactPromptText(protagonist.identity, 40)}`]
      const goal = protagonist.currentGoal?.trim()
      if (goal) segs.push(`当前目标：${compactPromptText(goal, 40)}`)
      const pressure = protagonist.currentPressure?.trim()
      if (pressure) segs.push(`当前压力：${compactPromptText(pressure, 40)}`)
      charLines.push(`- ${segs.join('。')}。`)
    } else {
      // 无主角则取前 2 个角色，仅保留名字与身份
      for (const c of characters.slice(0, 2)) {
        if (!c.name) continue
        charLines.push(`- ${c.name}：${compactPromptText(c.identity, 40)}`)
      }
    }
    if (charLines.length > 0) {
      sections.push(`### 主角\n${charLines.join('\n')}`)
    }

    // ── 核心冲突 Top 3（排除已解决/已转化，按强度降序）──
    const topConflicts = conflicts
      .filter((c) => c.stage !== 'resolved' && c.stage !== 'transformed')
      .sort((a, b) => b.intensity - a.intensity)
      .slice(0, 3)
    if (topConflicts.length > 0) {
      const lines = topConflicts.map(
        (c) =>
          `- ${compactPromptText(c.description, 60)}（强度 ${c.intensity}/10，阶段 ${promptLabel(c.stage)}）`
      )
      sections.push(`### 核心冲突（Top 3）\n${lines.join('\n')}`)
    }

    // ── 关键未回收伏笔 Top 3（仅 planted / reinforced）──
    const topForeshadows = foreshadowing
      .filter((f) => f.status === 'planted' || f.status === 'reinforced')
      .slice(0, 3)
    if (topForeshadows.length > 0) {
      const lines = topForeshadows.map(
        (f) => `- ${compactPromptText(f.description, 60)}（状态 ${promptLabel(f.status)}）`
      )
      sections.push(`### 关键未回收伏笔（Top 3）\n${lines.join('\n')}`)
    }

    // ── 进行中线索 Top 2（progress < 100，按进度降序）──
    const topClues = clues
      .filter((c) => c.progress < 100)
      .sort((a, b) => b.progress - a.progress)
      .slice(0, 2)
    if (topClues.length > 0) {
      const lines = topClues.map(
        (c) => `- ${compactPromptText(c.description, 60)}（进度 ${c.progress}%）`
      )
      sections.push(`### 进行中线索（Top 2）\n${lines.join('\n')}`)
    }

    return sections.length > 0 ? `## 全局关键事实\n\n${sections.join('\n\n')}` : ''
  }

  /**
   * 上一章变化 delta（diff 模式专用，替代 formatStoryLedgerContext 的"最近承接"段）。
   *
   * 从 memoryStore.listChangeRecords 读取第 N-1 章的原子变化记录，按 subjectType 分组
   * 紧凑输出：角色状态变化（before→after）/ 冲突伏笔推进 / 新增实体。
   *
   * 行为约定：
   * - chapterNumber === 1 时返回空串（无上一章）
   * - memoryStore 未注入或未提供 listChangeRecords 时返回空串
   * - 无变化记录时返回空串
   * - dimension 以 .created 结尾归入"新增实体"组；character.conflict_link 跳过
   * - 每组最多 5 条，按 significance 降序
   * - beforeValue/afterValue 用 compactPromptText 精简，枚举值复用 promptLabel 翻译
   * - 实体名通过 buildBoundaryEntityNameMap 反查，避免暴露 UUID
   */
  private formatChapterDelta(
    projectId: string,
    chapterNumber: number,
    arrangedEntities?: ArrangedEntity,
    boundary?: ChapterBoundaryContext
  ): string {
    // 第 1 章无上一章，无变化 delta
    if (chapterNumber <= 1) return ''
    // memoryStore 未注入或未提供 listChangeRecords 时无法获取变化记录
    if (!this.memoryStore?.listChangeRecords) return ''

    const changes = this.memoryStore.listChangeRecords(projectId, {
      chapterNumber: chapterNumber - 1
    })
    if (changes.length === 0) return ''

    // 反查实体显示名，避免在提示词里暴露 UUID
    const nameMap = boundary
      ? this.buildBoundaryEntityNameMap(projectId, boundary.entities)
      : new Map<string, string>()
    const arrangedIds = this.collectRelevantEntityIds(arrangedEntities)
    const hasArrangedFilter = arrangedIds.size > 0

    // dimension 中文标签（复用 formatStoryLedgerContext 的映射风格）
    const dimensionLabels: Record<string, string> = {
      'character.state': '状态',
      'character.goal': '目标',
      'character.pressure': '压力',
      'character.cognition': '认知',
      'character.arc_stage': '成长状态',
      'conflict.stage': '冲突进展',
      'conflict.intensity': '冲突强度',
      'foreshadow.beat': '伏笔动作',
      'foreshadow.payoff_chapter': '伏笔回收时点',
      'clue.progress': '线索进展',
      'faction.status': '势力状态',
      'faction.activity': '势力动态',
      'item.holder': '物品归属',
      'item.status': '物品状态',
      'relationship.stage': '关系进展',
      'relationship.alignment': '关系立场'
    }

    const nameOf = (subjectType: string, subjectId: string): string =>
      nameMap.get(subjectId) ?? `${promptLabel(subjectType)}相关事项`

    const valueOf = (value: unknown): string => {
      if (value == null || value === '') return ''
      if (typeof value === 'string') return compactPromptText(promptLabel(value), 80)
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      if (typeof value === 'object') {
        const record = value as Record<string, unknown>
        const fields: Array<[string, string]> = [
          ['currentState', '状态'],
          ['currentGoal', '目标'],
          ['currentPressure', '压力'],
          ['stage', '进展'],
          ['status', '状态'],
          ['progress', '进度']
        ]
        const segs = fields.flatMap(([key, label]) => {
          const v = record[key]
          if (v == null || v === '') return []
          return [`${label}：${compactPromptText(promptLabel(String(v)), 48)}`]
        })
        return segs.length > 0 ? segs.join('；') : ''
      }
      return String(value)
    }

    // 按 subjectType + 是否新增 分组：character 单列；conflict/foreshadow/clue/其他归"推进"；.created 归"新增"
    const characterChanges: typeof changes = []
    const plotChanges: typeof changes = []
    const newEntities: typeof changes = []

    for (const change of changes) {
      if (change.dimension.endsWith('.created')) {
        newEntities.push(change)
        continue
      }
      if (change.dimension === 'character.conflict_link') continue
      if (hasArrangedFilter && !arrangedIds.has(change.subjectId)) continue
      if (change.subjectType === 'character') {
        characterChanges.push(change)
      } else {
        plotChanges.push(change)
      }
    }

    const sortBySignificance = (a: (typeof changes)[number], b: (typeof changes)[number]) =>
      b.significance - a.significance

    const sections: string[] = []

    // 角色状态变化（before → after）
    const charLines = characterChanges
      .sort(sortBySignificance)
      .slice(0, 5)
      .map((change) => {
        const name = nameOf(change.subjectType, change.subjectId)
        const label = dimensionLabels[change.dimension] ?? '状态变化'
        const before = valueOf(change.beforeValue)
        const after = valueOf(change.afterValue)
        const reason = change.reason?.trim()
          ? `（缘由：${compactPromptText(change.reason, 60)}）`
          : ''
        if (before && after) {
          return `- ${name}：${label}从「${before}」变为「${after}」${reason}`
        }
        return `- ${name}：${label}变为「${after || '暂无明确结果'}」${reason}`
      })
    if (charLines.length > 0) {
      sections.push(`### 角色状态变化\n${charLines.join('\n')}`)
    }

    // 冲突/伏笔推进（after only）
    const plotLines = plotChanges
      .sort(sortBySignificance)
      .slice(0, 5)
      .map((change) => {
        const name = nameOf(change.subjectType, change.subjectId)
        const label = dimensionLabels[change.dimension] ?? '状态变化'
        const after = valueOf(change.afterValue)
        const reason = change.reason?.trim()
          ? `（缘由：${compactPromptText(change.reason, 60)}）`
          : ''
        return `- ${name}：${label}变为「${after || '暂无明确结果'}」${reason}`
      })
    if (plotLines.length > 0) {
      sections.push(`### 冲突/伏笔推进\n${plotLines.join('\n')}`)
    }

    // 新增实体（.created 维度）：角色附带 identity，其余仅名字
    const newLines = newEntities
      .sort(sortBySignificance)
      .slice(0, 5)
      .map((change) => {
        const name = nameMap.get(change.subjectId) ?? `${promptLabel(change.subjectType)}相关`
        if (change.subjectType === 'character') {
          const char = this.stores.getCharacter(change.subjectId)
          const identity = char?.identity?.trim()
          return identity
            ? `- 新增角色：${name}（${compactPromptText(identity, 40)}）`
            : `- 新增角色：${name}`
        }
        return `- 新增${promptLabel(change.subjectType)}：${name}`
      })
    if (newLines.length > 0) {
      sections.push(`### 新增实体\n${newLines.join('\n')}`)
    }

    return sections.length > 0
      ? `## 上一章变化（第 ${chapterNumber - 1} 章 → 第 ${chapterNumber} 章前）\n\n${sections.join('\n\n')}`
      : ''
  }

  /** 事件类型 → 中文标签 */
  private translateMemoryEventType(t: MemoryEventType): string {
    const map: Record<MemoryEventType, string> = {
      character_change: '角色变更',
      conflict_change: '冲突变更',
      foreshadow_change: '伏笔变更',
      clue_change: '线索变更',
      faction_change: '势力变更',
      location_change: '地点变更',
      relationship_change: '关系变更',
      info_layer_change: '信息差变更',
      item_change: '物品变更',
      plot_event: '剧情事件',
      world_change: '世界变更'
    }
    return map[t] ?? t
  }

  // ═══════════════════════════════════════════════════════════════
  // 辅助方法
  // ═══════════════════════════════════════════════════════════════

  /**
   * 读取第 N 章开篇边界。底层保留全量实体，调用方必须再按本章编排筛选。
   *
   * 只要第 N 章已经成为当前章或历史章，就优先读取 N-1 快照；这同时覆盖
   * “重写最后一章”的场景，避免旧实现仅在存在未来章节时才回退快照。
   */
  getChapterBoundaryContext(projectId: string, chapterNumber: number): ChapterBoundaryContext {
    const project = this.stores.getProject(projectId)
    if (!project) throw new Error(`项目不存在: ${projectId}`)

    const recentChapters = this.stores.listRecentChapters(projectId, 50)
    const latestWrittenChapter = Math.max(
      0,
      ...recentChapters
        .filter((chapter) => chapter.content?.trim().length > 0)
        .map((chapter) => chapter.chapterNumber)
    )
    const latestKnownChapter = Math.max(project.currentChapter, latestWrittenChapter)
    if (chapterNumber > 1 && latestKnownChapter >= chapterNumber) {
      // ⚠️ 必须容忍非 active 快照：时间线重建/后续章节落库会把历史快照打成 stale/superseded，
      // 但那只是「不再是最新」，不代表历史边界状态不可信。若因 active 过滤查不到唯一的历史
      // 快照，会静默回退到实体表当前全局状态——重写旧章节时注入未来章节的状态（矩阵穿越）。
      const memory = this.memoryStore
      const candidates = memory?.listSnapshots
        ? memory.listSnapshots(projectId, {
            chapterNumber: chapterNumber - 1,
            snapshotType: 'full',
            includeInactive: true,
          })
        // 窄接口回退（测试桩/适配器只暴露 getSnapshot）：至少保留原行为
        : [memory?.getSnapshot?.(projectId, chapterNumber - 1, { snapshotType: 'full' })]
          .filter((s): s is NonNullable<typeof s> => s != null)
      // 排除时间线重建写入的重放摘要行（kind:'timeline_rebuild'，内容是审计摘要而非实体状态）
      const snapshot = candidates
        .filter((candidate) => !candidate.snapshotData.includes('"kind":"timeline_rebuild"'))
        .sort((a, b) => b.createdAt - a.createdAt)[0]
      if (snapshot) {
        try {
          const entities = this.parseBoundaryEntities(snapshot.snapshotData)
          return {
            chapterNumber,
            entities,
            state: this.toStoryState(
              { ...project, currentChapter: chapterNumber - 1 },
              entities,
              chapterNumber
            ),
            fromSnapshot: true,
            stateAheadOfBoundary: false
          }
        } catch {
          // 损坏快照不可用时只能回退到顺序生成状态；不混用部分当前实体。
        }
      }
    }

    const entities = this.getCurrentBoundaryEntities(projectId)
    return {
      chapterNumber,
      entities,
      state: this.toStoryState(project, entities, chapterNumber),
      fromSnapshot: false,
      // 走到这里且存在「本章或更后」的已写章节 / 进度标记时，实体表当前值可能包含本章之后的事实。
      stateAheadOfBoundary:
        latestWrittenChapter >= chapterNumber || latestKnownChapter > chapterNumber
    }
  }

  private getCurrentBoundaryEntities(projectId: string): ChapterBoundaryEntities {
    return {
      characters: this.stores.listCharacters(projectId),
      relationships: this.stores.listRelationships(projectId),
      conflicts: this.stores.listConflicts(projectId),
      foreshadowing: this.stores.listForeshadowing(projectId),
      clues: this.stores.listClues(projectId),
      factions: this.stores.listFactions(projectId),
      locations: this.stores.listLocations(projectId),
      items: this.stores.listItems(projectId),
      worldElements: this.stores.listWorldElements(projectId),
      informationLayers: this.stores.listInformationLayers(projectId),
      edges: this.stores.listEdges(projectId)
    }
  }

  private parseBoundaryEntities(snapshotData: string): ChapterBoundaryEntities {
    const data = JSON.parse(snapshotData) as Partial<ChapterBoundaryEntities>
    return {
      characters: Array.isArray(data.characters) ? data.characters : [],
      relationships: Array.isArray(data.relationships) ? data.relationships : [],
      conflicts: Array.isArray(data.conflicts) ? data.conflicts : [],
      foreshadowing: Array.isArray(data.foreshadowing) ? data.foreshadowing : [],
      clues: Array.isArray(data.clues) ? data.clues : [],
      factions: Array.isArray(data.factions) ? data.factions : [],
      locations: Array.isArray(data.locations) ? data.locations : [],
      items: Array.isArray(data.items) ? data.items : [],
      worldElements: Array.isArray(data.worldElements) ? data.worldElements : [],
      informationLayers: Array.isArray(data.informationLayers) ? data.informationLayers : [],
      edges: Array.isArray(data.edges) ? data.edges : []
    }
  }

  private toStoryState(
    project: NovelProject,
    entities: ChapterBoundaryEntities,
    chapterNumber: number
  ): StoryState {
    return {
      project,
      characters: entities.characters,
      relationships: entities.relationships,
      activeConflicts: entities.conflicts.filter(
        (conflict) => conflict.stage !== 'resolved' && conflict.stage !== 'transformed'
      ),
      pendingForeshadowing: entities.foreshadowing.filter(
        (foreshadow) => foreshadow.status !== 'recovered' && foreshadow.status !== 'abandoned'
      ),
      activeClues: entities.clues.filter((clue) => clue.progress < 100),
      activeFactions: entities.factions.filter((faction) => faction.status !== 'destroyed'),
      activeLocations: entities.locations.filter((location) =>
        location.appearChapters?.some((chapter) => chapter < chapterNumber)
      ),
      items: entities.items.filter((item) => item.status !== 'destroyed'),
      currentStage: project.currentStage,
      currentChapter: project.currentChapter
    }
  }

  /**
   * 文风指纹：从前几章正文中提取文风特征快照
   *
   * 注入 Writer/Reviewer 的 SEMI 层，让 LLM 在 context compaction 后仍能保持文风一致。
   * 统计实现已统一到 core/analysis/style-measurement（与参考小说分析、专家蒸馏
   * 共用同一测量器，V2 方案阶段 1）；此处只负责取样本与格式化。
   */
  private formatStyleFingerprint(prevChapters: NovelChapter[]): string {
    if (prevChapters.length === 0) return ''

    // 取最近 2-3 章的正文合并分析
    const sampleText = prevChapters
      .map((ch) => ch.content || '')
      .filter((c) => c.trim().length > 100)
      .join('\n\n')

    if (sampleText.trim().length < 200) return ''

    const snapshot = measureStyleMetrics(sampleText)
    if (snapshot.sentenceCount === 0) return ''

    const sampleRange: [number, number] = [
      prevChapters[0].chapterNumber,
      prevChapters[prevChapters.length - 1].chapterNumber
    ]
    return formatStyleMetricsAsFingerprint(snapshot, `第${sampleRange[0]}-${sampleRange[1]}章提取`)
  }

  /**
   * 清洗文本中的破折号"——"，用于注入 LLM 上下文前切断示范传播链。
   *
   * 设计意图：LLM 会模仿输入上下文中的标点习惯。历史章节正文、Director 输出、
   * 实体描述等字段可能含破折号，直接注入会导致下游 LLM 模仿输出破折号。
   * 在注入点清洗（而非 LLM 输出后处理），从源头切断示范传播。
   *
   * 替换策略：
   * - 句末/标点旁的破折号 → 删除（保留原标点）
   * - 连续破折号列举 → 顿号
   * - 句中破折号 → 逗号
   *
   * 注意：此方法仅用于"注入 LLM 上下文的数据字段"清洗，
   * 不用于 LLM 输出后处理（输出后处理已废弃，依赖 prompt 约束 + Reviewer 检测）。
   * 禁令文本中的"——"（如 system-base.md 的铁律）在 STATIC 层，不经过此方法。
   */
  stripEmDash(text: string | undefined | null): string {
    if (!text) return ''
    return (
      text
        // 0. 话语中断（对话末尾的破折号，表示话语被打断）：替换为省略号
        //    如 "我本来想——" → "我本来想……"
        //    检测：引号内的破折号且后跟引号收束
        .replace(/——(["」』""']\s*[。！？]?)/g, '……$1')
        // 1. 句末标点前的破折号：删除破折号，保留句末标点
        .replace(/——([。！？…])/g, '$1')
        // 2. 标点后的破折号：删除破折号，保留原标点
        .replace(/([。！？，；：])——/g, '$1')
        // 3. 连续破折号列举（3个及以上文字段用——分隔）：替换为顿号
        .replace(/(\S)——(\S)——/g, '$1、$2、')
        // 4. 行首破折号：直接删除
        .replace(/^——/gm, '')
        // 5. 剩余句中破折号（前后均为文字）：智能替换
        //    破折号在中文里有两种常见用法：
        //    a) 补充说明（"他拿起剑——父亲留下的遗物"）→ 逗号承接
        //    b) 语气延展/转折（"他推开门——门外站着一个人"）→ 句号断句，更接近铁律推荐的"用句号分割成独立句"
        //    判据：破折号前一字若是动词/形容词常见字（了/着/的/开/起/住/动/响/亮/白/红 等），
        //    多为语气延展，用句号；否则默认用逗号承接。
        //    这比一律替换为逗号更自然，避免"炸开，"这类生硬停顿。
        .replace(/(\S)——(\S)/g, (match, before: string, after: string) => {
          // 语气延展判定：前字为常见动词/状态词尾
          if (/[了着的起着住动响亮白红透碎开落来去见闻]/.test(before)) {
            return `${before}。${after}`
          }
          return `${before}，${after}`
        })
    )
  }

  /**
   * 构建实体 ID → 可读名称的映射表（供格式化边数据时查询实体名称）
   * 覆盖画布上所有节点类型：project/character/chapter/conflict/foreshadow/faction/location/world_element
   */
  private buildEntityNameMap(projectId: string): Map<string, string> {
    const map = new Map<string, string>()
    const project = this.stores.getProject(projectId)
    if (project) map.set(project.id, project.title)
    for (const c of this.stores.listCharacters(projectId)) map.set(c.id, c.name)
    for (const ch of this.stores.listRecentChapters(projectId, 9999)) {
      map.set(ch.id, `第${ch.chapterNumber}章《${ch.title}》`)
    }
    for (const c of this.stores.listConflicts(projectId)) map.set(c.id, c.description)
    for (const f of this.stores.listForeshadowing(projectId)) map.set(f.id, f.description)
    for (const f of this.stores.listFactions(projectId)) map.set(f.id, f.name)
    for (const l of this.stores.listLocations(projectId)) map.set(l.id, l.name)
    for (const w of this.stores.listWorldElements(projectId)) map.set(w.id, w.name)
    return map
  }

  /** 使用章节边界快照构建名称表，历史重写时不得回读未来实体名称。 */
  private buildBoundaryEntityNameMap(
    projectId: string,
    entities: ChapterBoundaryEntities
  ): Map<string, string> {
    const map = new Map<string, string>()
    const project = this.stores.getProject(projectId)
    if (project) map.set(project.id, project.title)
    for (const c of entities.characters) map.set(c.id, c.name)
    for (const c of entities.conflicts) map.set(c.id, c.description)
    for (const f of entities.foreshadowing) map.set(f.id, f.description)
    for (const c of entities.clues) map.set(c.id, c.description)
    for (const f of entities.factions) map.set(f.id, f.name)
    for (const l of entities.locations) map.set(l.id, l.name)
    for (const i of entities.items) map.set(i.id, i.name)
    for (const w of entities.worldElements) map.set(w.id, w.name)
    for (const layer of entities.informationLayers) map.set(layer.id, layer.infoDescription)
    return map
  }

  /** 根据实体类型和 ID 查询实体名称（找不到时返回 null） */
  private getEntityName(entityType: string, entityId: string, projectId: string): string | null {
    const map = this.buildEntityNameMap(projectId)
    if (map.has(entityId)) return map.get(entityId)!
    // group 节点无持久化实体
    if (entityType === 'group') return null
    return null
  }

  /**
   * 获取 Agent 角色描述（从模板读取，可配置）
   *
   * @param agentType Agent 类型（如 'director'/'writer'/'character-actor'）
   * @param projectId 项目 ID（用于读取项目级覆盖模板）
   * @param discussion 是否为群聊共创模式。true 时优先读 `role-{agentType}-discussion`，
   *   回退到 `role-{agentType}`，让群聊模式加载场景拆分/剧本格式等群聊专属约束。
   */
  private getAgentRoleDescription(
    agentType: string,
    projectId?: string,
    discussion = false
  ): string {
    try {
      if (discussion) {
        try {
          return this.promptManager.getTemplate(`role-${agentType}-discussion`, projectId)
        } catch {
          // 群聊专用模板不存在，回退到通用模板
        }
      }
      return this.promptManager.getTemplate(`role-${agentType}`, projectId)
    } catch {
      // 模板不存在时回退到通用描述
      return '小说创作助手'
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 缓存诊断方法
  // ═══════════════════════════════════════════════════════════════

  /** 计算字符串的 SHA-256 哈希（前 16 位，用于诊断） */
  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  }

  /** 计算系统提示词哈希（用于跨章诊断缓存命中） */
  getSystemPromptHash(projectId: string, agentType: string): string {
    const prompt = this.buildSystemPrompt(projectId, agentType)
    return this.hashContent(prompt)
  }

  /** 计算章节上下文哈希（用于单章内诊断缓存命中） */
  getChapterContextHash(
    projectId: string,
    chapterNumber: number,
    narrativeTask: NarrativeTask,
    constraints: ChapterConstraints,
    arrangedEntities?: ArrangedEntity,
    agentType?: string
  ): string {
    // arrangedEntities 参与 hash 输入，确保编排约束变化时 hash 反映出来
    const arrangedKey = arrangedEntities ? JSON.stringify(arrangedEntities) : ''
    const shared = this.buildChapterContextShared(
      projectId,
      chapterNumber,
      narrativeTask,
      constraints,
      arrangedEntities
    )
    const suffix = this.buildChapterContextSuffix(
      projectId,
      chapterNumber,
      narrativeTask,
      constraints,
      arrangedEntities,
      agentType
    )
    return this.hashContent(shared + '\n\n---\n\n' + suffix + arrangedKey)
  }

  // ═══════════════════════════════════════════════════════════════
  // 上下文预览（P1 可观测性）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 构建结构化上下文预览，供 context-preview 端点返回。
   *
   * 复用 buildSystemPrompt / buildChapterContextShared / buildChapterContextSuffix /
   * buildAgentIdentity，不重复实现构建逻辑，仅汇总各 section 的字符数、来源标记与
   * 前 200 字预览，让开发者无需触发完整创作流即可审计 prompt-builder 注入的内容。
   *
   * 注意：narrativeTask / constraints 使用最小默认值（章纲从 store 读取，约束留空），
   * 因为预览目的是展示 prompt 结构与 section 占比，而非还原运行时精确约束。
   * semi-shared section 的 fromSnapshot 标记来自 getChapterBoundaryContext，
   * 与实际创作流使用同一判定逻辑，保证诊断结果与生产一致。
   */
  buildContextPreview(
    projectId: string,
    chapterNumber: number,
    agentType?: string,
    mode?: 'full' | 'diff'
  ): ContextPreviewResult {
    // 默认 narrativeTask：从 store 读取章纲，缺失时退化为占位描述（与 orchestrator 一致）
    const chapter = this.stores.getChapter(projectId, chapterNumber)
    const narrativeTask: NarrativeTask = {
      description: chapter?.narrativeTask ?? `第 ${chapterNumber} 章创作`,
      type: 'advance_mainline',
      targetEntity: null,
      priority: 'medium'
    }
    // 预览用空约束：避免引入对 NovelEngine 的依赖，约束留空不影响 section 结构诊断
    const constraints: ChapterConstraints = {
      facts: [],
      cognitive: [],
      stage: [],
      narrativeDebts: [],
      characterArcs: [],
      conflictTargets: [],
      suspenseHooks: []
    }

    const sections: ContextPreviewSection[] = []
    // 截取前 200 字作为内容预览
    const previewOf = (text: string): string => text.slice(0, 200)

    // ── static：系统提示词（跨章、跨 Agent 静态层）──
    const systemPrompt = this.buildSystemPrompt(projectId, agentType ?? 'writer')
    sections.push({
      key: 'system',
      title: '系统提示词',
      source: 'static',
      charCount: systemPrompt.length,
      preview: previewOf(systemPrompt)
    })

    // ── semi-shared：章前共享层（单章内跨 Agent 共享，含故事状态/事件账本）──
    // fromSnapshot 标注是否命中 N-1 持久化快照，与生产路径判定逻辑一致
    // mode='diff' 时改走 buildChapterContextDiff：用全局关键事实摘要 + 上一章变化 delta
    // 替代全量故事状态，便于对比两种模式的字符数差异与内容收敛效果。
    const boundary = this.getChapterBoundaryContext(projectId, chapterNumber)
    const effectiveMode: 'full' | 'diff' = mode === 'diff' ? 'diff' : 'full'
    const shared =
      effectiveMode === 'diff'
        ? this.buildChapterContextDiff(projectId, chapterNumber, narrativeTask, constraints)
        : this.buildChapterContextShared(projectId, chapterNumber, narrativeTask, constraints)
    // T03-2：full 模式下沉 chunk 明细（复用 chunk 版构建，与 shared 字符串同源）
    const chunkBreakdown = effectiveMode === 'full'
      ? this.buildChapterContextChunks(projectId, chapterNumber, narrativeTask, constraints)
          .map((c) => ({
            chunkId: c.chunkId,
            title: CHUNK_BY_ID.get(c.chunkId)?.title ?? c.chunkId,
            charCount: c.content.length,
            preview: previewOf(c.content),
          }))
      : undefined
    sections.push({
      key: 'shared',
      title: '章前共享层',
      source: 'semi-shared',
      charCount: shared.length,
      fromSnapshot: boundary.fromSnapshot,
      mode: effectiveMode,
      preview: previewOf(shared),
      chunks: chunkBreakdown
    })

    // ── semi-suffix：Agent 专属后缀（Director 方案 / Reviewer Rubric / Writer 指令）──
    // 仅当传入 agentType 时构建，未指定则跳过（suffix 内部对无 agentType 直接返回空串）
    const suffix = this.buildChapterContextSuffix(
      projectId,
      chapterNumber,
      narrativeTask,
      constraints,
      undefined,
      agentType
    )
    if (suffix.length > 0) {
      sections.push({
        key: 'suffix',
        title: 'Agent 专属后缀',
        source: 'semi-suffix',
        charCount: suffix.length,
        preview: previewOf(suffix)
      })
    }

    // ── agent-identity：Agent 身份（独立缓存断点）──
    // 未指定 agentType 时仍构建 writer 默认身份，让预览展示身份 section 的结构
    const identity = this.buildAgentIdentity(projectId, agentType ?? 'writer')
    if (identity.length > 0) {
      sections.push({
        key: 'agentIdentity',
        title: 'Agent 身份',
        source: 'agent-identity',
        charCount: identity.length,
        preview: previewOf(identity)
      })
    }

    const totalChars = sections.reduce((sum, s) => sum + s.charCount, 0)
    return {
      projectId,
      chapterNumber,
      agentType,
      totalChars,
      sections
    }
  }
}
