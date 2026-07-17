/**
 * 小说创作系统核心类型定义（共享包）
 *
 * 对应 docs/ai_novel_creation_workbench_core_systems.md 中的 15 大系统
 *
 * 此文件为 novel 域类型的权威源，前端（apps/desktop）与后端（apps/agent-server）
 * 均通过 re-export 引用以消除重复定义。
 */

// ── 项目 ──

export interface NovelProject {
  id: string
  title: string
  genre: string // 玄幻/科幻/悬疑/都市...
  synopsis: string
  /** 全书大纲（一段文本） */
  outline?: string
  targetWords: number
  currentVolume: number
  currentChapter: number
  currentStage: StoryStage
  status: 'active' | 'paused' | 'completed'
  /** 节奏模型 ID（缺省时使用 RhythmController.DEFAULT_MODEL） */
  rhythmModelId?: string
  /** 目标发布平台（影响 Reviewer 评分权重，NULL 表示未设定） */
  targetPlatform?: TargetPlatform | null
  /** 移入回收站的时间戳（null 表示正常项目，非 null 表示已软删除） */
  deletedAt?: number | null
  createdAt: number
  updatedAt: number
}

/** 目标发布平台（决定 Reviewer 的评分权重偏好） */
export type TargetPlatform = 'fanqie' | 'qidian' | 'zhihu_yanyan' | 'general'
// fanqie: 番茄（免费阅读，重节奏和爽感）
// qidian: 起点（付费订阅，重世界观和伏笔）
// zhihu_yanyan: 知乎盐言（短篇故事，重开篇和反转）
// general: 通用（不调整权重）

export type StoryStage = 'setup' | 'rising' | 'climax' | 'falling' | 'resolution'

// ── 章节节奏 ──

/** 章节节奏类型 */
export type ChapterRhythm =
  | 'setup'      // 铺垫：介绍背景、人物、设定
  | 'rising'     // 上升：推进冲突，加剧紧张
  | 'climax'     // 高潮：冲突爆发，转折点
  | 'falling'    // 下降：高潮后回落，处理后果
  | 'resolution' // 收束：解决线索，回到平衡
  | 'twist'      // 转折：意料之外的走向
  | 'breather'   // 舒缓：紧张之间的缓冲
  | 'suspense'   // 悬念：信息差累积，读者期待感拉满

/** 高潮强度等级（区分小高潮/中高潮/大高潮） */
export type ClimaxIntensity = 'minor' | 'medium' | 'major'
// minor: 小高潮（情感强度 5-6，单卷内的阶段性爆发）
// medium: 中高潮（情感强度 7-8，卷末或弧线高潮）
// major: 大高潮（情感强度 9-10，全书终极高潮）

// ── 章节定位六型（借鉴 oh-story-claudecode）──

/**
 * 章节定位：决定本章在故事节奏中的功能定位
 * 不同定位有不同的钩子密度、爽点频率和节奏要求
 */
export type ChapterPositioning =
  | 'high_pressure'    // 高压章：冲突爆发/高潮/生死搏斗，节奏快，钩子密
  | 'advancement'      // 推进章：主线推进/信息释放，节奏中，爽点明确
  | 'cultivation'      // 修炼试错章：升级/试错/领悟，节奏慢，成长感
  | 'relationship'     // 关系回收章：角色互动/关系变化，节奏中，情感线
  | 'low_pressure'     // 低压生活章：日常/过渡/铺垫，节奏慢，世界观
  | 'information'      // 信息整理章：线索整理/布局/计划，节奏慢，信息密度

/** 高潮类型（五种主要高潮种类） */
export type ClimaxType =
  | 'emotional'    // 情感高潮：情感冲突最激烈紧张的瞬间（如误会解除）
  | 'fate'         // 命运高潮：主角命运生死攸关的揭晓时刻
  | 'character'    // 性格高潮：主角独特性格在严峻考验中彰显张力
  | 'combat'       // 打斗高潮：打斗最激烈时吸引读者视线（玄幻常见）
  | 'theme'        // 主题高潮：主题思想升华引起读者强烈共鸣
  | 'composite'    // 复合高潮：多种高潮共振（主题+性格+情节三者高度共振）

/** 节奏模型：定义故事弧的理想节奏序列 */
export interface RhythmModel {
  id: string
  name: string
  description: string
  /** 理想节奏序列（循环执行，如果章节数超过序列长度） */
  sequence: RhythmSequenceEntry[]
}

/** 节奏序列条目（带高潮强度标注） */
export interface RhythmSequenceEntry {
  rhythm: ChapterRhythm
  /** 高潮强度（仅 rhythm='climax' 时有意义） */
  climaxIntensity?: ClimaxIntensity
  /** 高潮类型建议（可选，供 Director 参考） */
  climaxType?: ClimaxType
}

/** 节奏建议 */
export interface RhythmSuggestion {
  /** 建议的节奏 */
  rhythm: ChapterRhythm
  /** 在弧中的位置（0-1） */
  arcPosition: number
  /** 建议原因 */
  reason: string
  /** 节奏描述（供 LLM 参考） */
  description: string
  /** 高潮强度（仅 rhythm='climax' 时有值） */
  climaxIntensity?: ClimaxIntensity
  /** 高潮类型建议（可选） */
  climaxType?: ClimaxType
}

/** 节奏历史记录 */
export interface RhythmHistoryEntry {
  chapterNumber: number
  rhythm: ChapterRhythm
  effectiveness: 'low' | 'medium' | 'high'  // 节奏效果评估
}

// ── 章节 ──

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
  /** 章纲（用户编写，作为生成统一起点） */
  outline?: string
  /** 所属卷 ID（指向 novel_volumes.id，兼容旧数据可空） */
  volumeId?: string | null
  acceptanceResult: string | null // JSON
  /** 章节张力等级（1-10，NULL 表示未设定）
   *  借鉴 PlotPilot TensionLevel：1=LOW, 3-4=RISING, 5-6=ELEVATED,
   *  7-8=HIGH, 9=INTENSE, 10=EXTREME
   *  由 Director Agent 在规划时建议，或用户手动调整 */
  tension?: number | null
  /** 章节节奏（由 RhythmController 建议，可手动覆盖） */
  rhythm?: ChapterRhythm
  /** 章节定位（六型之一，决定本章的功能定位和节奏要求，NULL 表示未设定） */
  positioning?: ChapterPositioning | null
  /** 时间线偏移（相对第1章的天数，用于追踪故事时间线，NULL 表示未设定） */
  timeOffset?: number | null
  /** 章尾钩子类型（Director 规划，Writer 执行，Reviewer 评估，NULL 表示未设定） */
  chapterEndingHook?: ChapterEndingHookType | null
  /** 前情提要（章节完成后自动生成，50-100 字，供连载展示） */
  recap?: string | null
  createdAt: number
  updatedAt: number
}

export type ChapterStatus = 'planned' | 'drafting' | 'review' | 'published' | 'rejected'

// ── 章节正文版本历史 ──

/** 章节版本来源阶段，标识这版正文是怎么产生的 */
export type ChapterVersionPhase =
  | 'writer_initial'        // create-flow Writer 初稿落库
  | 'reviser_final'         // Reviser 修订后落库
  | 'rewrite_pre'           // rewrite 递归重写前（显式快照，预留枚举）
  | 'postwrite_guard_pre'   // PostWriteGuard 自动重写前（显式快照，预留枚举）
  | 'discussion_weaver'     // 群聊 weaveChapter 落库
  | 'manual_patch'          // 用户手动 PATCH content
  | 'rollback_pre'          // 回滚前安全存当前
  | 'rollback_applied'      // 回滚写入的正文
  | 'manual_snapshot'       // 手动创建快照（POST /versions）
  | 'import'                // 外部导入

/** 章节正文版本（详情，含全文） */
export interface ChapterVersion {
  id: string
  chapterId: string
  projectId: string
  content: string
  wordCount: number
  phase: ChapterVersionPhase | null
  agentType: string | null
  trigger: string | null
  sequence: number
  createdAt: number
}

/** 章节版本摘要（列表用，不含 content 全文，省流量） */
export interface ChapterVersionSummary {
  id: string
  sequence: number
  phase: ChapterVersionPhase | null
  agentType: string | null
  trigger: string | null
  wordCount: number
  /** 与上一版的字数差（正/负/0），方便前端展示"增了 200 字" */
  wordCountDelta: number
  createdAt: number
  /** 是否对应当前正文（最新一版为 true） */
  isCurrent: boolean
}

/**
 * 版本来源元数据，由调用方传入 updateChapter/updateChapterContent。
 * - 传对象：拦截时存入版本表，元数据取自该对象
 * - 传 'skip'：调用方已手动存过版本，拦截跳过（避免重复存档）
 * - 传 undefined：拦截仍存版本，但元数据为 null（兼容现有调用方）
 */
export type VersionSource =
  | { phase: ChapterVersionPhase; agentType?: string; trigger?: string }
  | 'skip'
  | undefined

/** 段落级 diff 的单个段落片段 */
export type ChapterVersionDiffSegment =
  | { type: 'unchanged'; content: string; fromIndex: number; toIndex: number }
  | { type: 'added'; content: string; toIndex: number }
  | { type: 'removed'; content: string; fromIndex: number }
  | { type: 'modified'; fromContent: string; toContent: string; fromIndex: number; toIndex: number }

/** 两个版本之间的段落级 diff 结果 */
export interface ChapterVersionDiff {
  fromVersionId: string
  toVersionId: string
  fromSequence: number
  toSequence: number
  segments: ChapterVersionDiffSegment[]
  stats: {
    added: number
    removed: number
    modified: number
    unchanged: number
    wordCountDelta: number
  }
}

/** 回滚操作返回结果 */
export interface RollbackResult {
  success: boolean
  /** 回滚前安全存的版本 ID（rollback_pre） */
  savedVersionId: string
  /** 回滚后的当前正文 */
  currentContent: string
  currentWordCount: number
}

// ── 卷 ──

export interface NovelVolume {
  id: string
  projectId: string
  volumeNumber: number
  title: string
  outline: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}

// ── 角色 ──

/**
 * 角色层级（持久化，回答"他在故事里是什么位置"）
 *
 * 区别于 PlotFunction（本章临时功能位），plot_role 是角色在整本书里的层级：
 * - protagonist: 主角，整本书的核心视角
 * - main_opponent: 主要对手，长期对抗主角的核心反派
 * - supporting: 重要配角，有人物深度，参与多条线
 * - function: 功能配角，主要为推动特定剧情而存在
 * - background: 背景人物，仅作为环境/陪衬
 *
 * 系统对 function/background 层级角色不要求长期欲望深度，
 * 让 LLM 写作时知道哪些角色值得花笔墨。
 */
export type NovelCharacterPlotRole =
  | 'protagonist' | 'main_opponent' | 'supporting' | 'function' | 'background'

export interface NovelCharacter {
  id: string
  projectId: string
  name: string
  description: string
  // 静态设定
  identity: string
  personality: string
  appearance: string
  // 动态状态
  currentState: string
  currentGoal: string
  currentPressure: string
  secret: string
  // 角色弧光
  arcStage: string
  arcHistory: string // JSON: ArcChange[]
  // 说话风格
  speechStyle: string
  isProtagonist: boolean // 是否主角
  // ── 四层逻辑补全（迁移 048）──
  /** 长期欲望：跨章节稳定的发动机，区别于 currentGoal 短期目标 */
  longTermDesire: string
  /** 角色层级：决定笔墨分配与功能位约束深度 */
  plotRole: NovelCharacterPlotRole
  /** 删掉影响：一句话描述"删掉这个角色哪段剧情会受影响" */
  removalImpact: string
  // ── 四层逻辑④：影响层反向索引（迁移 050）──
  /** 参与的冲突 ID 列表（JSON: string[]，由冲突 CRUD 时自动同步，回答"删掉他会断几条冲突线"） */
  participatingConflicts: string
  createdAt: number
  updatedAt: number
}

export interface ArcChange {
  fromStage: string
  toStage: string
  reason: string
  chapter: number
  timestamp: number
}

// ── 关系 ──

/**
 * 关系阵营关系（动态，回答"同一边还是暂时同路 / 后面会不会变"）
 * - ally: 同一边（长期盟友）
 * - temporary_ally: 暂时同路（短期合作，可能反目）
 * - opponent: 对立（长期敌对）
 * - temporary_opponent: 暂时对立（短期冲突，可能和解）
 * - neutral: 中立（无明确立场）
 * - pending_shift: 待转变（关系临界点，本章可能翻盘）
 */
export type RelationshipAlignment =
  | 'ally' | 'temporary_ally' | 'opponent'
  | 'temporary_opponent' | 'neutral' | 'pending_shift'

/**
 * 关系走向（动态，回答"后面会不会变，往哪边变"）
 * - stable: 稳定
 * - warming: 升温（关系在变好）
 * - cooling: 降温（关系在变冷，但未破裂）
 * - breaking: 即将破裂
 * - reconciling: 正在和解
 */
export type RelationshipTrend =
  | 'stable' | 'warming' | 'cooling' | 'breaking' | 'reconciling'

/** 关系阶段变更历史条目 */
export interface RelationChange {
  chapter: number
  fromStage: string
  toStage: string
  /** 变更原因 / 触发事件 */
  reason: string
  timestamp: number
}

export interface NovelRelationship {
  id: string
  projectId: string
  characterA: string
  characterB: string
  relationType: string // 敌对/合作/师徒/恋人/亲属...（持久化标签）
  currentStage: string
  stageHistory: string // JSON: RelationChange[]
  // ── 四层逻辑②：动态关系补全字段（迁移 049）──
  /** 动态功能位："在帮主角什么 / 拦主角什么"（一句话描述本关系对剧情的推动作用） */
  dynamicRole: string
  /** 阵营关系：同一边 / 暂时同路 / 对立 / 待转变 */
  alignment: RelationshipAlignment
  /** 走向：升温 / 降温 / 稳定 / 即将破裂 / 和解 */
  trend: RelationshipTrend
  /** 本章关系约束提示（一句话说明本章关系应如何变化，可空） */
  chapterHint: string
  /** 最后一次更新的章节号（用于追溯关系演变节奏） */
  lastUpdatedChapter: number | null
  createdAt: number
  updatedAt: number
}

// ── 伏笔 ──

export interface NovelForeshadow {
  id: string
  projectId: string
  description: string
  /** 伏笔类别（结构化枚举，四层逻辑③：功能层）
   *  不同类型有不同回收规律，提示 LLM 写回收时按类型给指导 */
  category: NovelForeshadowCategory
  status: ForeshadowStatus
  firstChapter: number | null
  lastChapter: number | null
  recoverByChapter: number | null
  linkedCharacters: string // JSON: string[]
  linkedClues: string // JSON: string[]
  // ── 四层逻辑③：埋设/回收方式（结构化）──
  /** 埋设方式（明写/暗写/侧写），指导 LLM 写埋设时的手法 */
  plantMethod?: ForeshadowPlantMethod
  /** 回收方式（点破/暗示/反向/递进），指导 LLM 写回收时的手法 */
  recoverMethod?: ForeshadowRecoverMethod
  /** ── P3-2：关联信息差 ID 数组（JSON: string[]）
   * 一个伏笔可以承载多个信息差（如同一物品伏笔同时承载"身份未明"+"读者不知来源"两条信息差） */
  linkedInfoLayers: string
  /** 旧版伏笔活跃区间，仅保留用于历史数据兼容；新逻辑不得据此推断中间章节与伏笔关联。 */
  chapterSpans: ChapterSpan[]
  /**
   * 伏笔事件链：只记录伏笔实际发生的章节，不把埋设到回收之间的章节视为连续关联。
   * 旧数据可缺省，读取时由 firstChapter/recoverByChapter 兼容生成端点事件。
   */
  beats?: ForeshadowBeat[]
  createdAt: number
  updatedAt: number
}

/** 伏笔在具体章节发生的离散叙事事件。 */
export type ForeshadowBeatType = 'plant' | 'reinforce' | 'reveal' | 'payoff'

export interface ForeshadowBeat {
  chapter: number
  type: ForeshadowBeatType
  /** 本次埋设、强化、揭示或回收的具体内容。 */
  note?: string
}

export type ForeshadowStatus =
  | 'planned' | 'planted' | 'reinforced' | 'partially_revealed'
  | 'recovering' | 'recovered' | 'abandoned'

/** 伏笔类别枚举（四层逻辑③：功能层）
 *  不同类别有不同回收规律：
 *  - item 物品：物品再次出现时回收
 *  - spoken 言语：在说出者面前应验时回收
 *  - event 事件：事件触发时回收
 *  - identity 身份：身份揭晓时回收
 *  - secret 秘密：秘密暴露时回收
 *  - prophecy 预言：兑现时回收
 *  - promise 承诺：在承诺人面前兑现时回收
 *  - quote 台词：台词应验时回收 */
export type NovelForeshadowCategory =
  | 'item' | 'spoken' | 'event' | 'identity'
  | 'secret' | 'prophecy' | 'promise' | 'quote'

/** 伏笔埋设方式（指导 LLM 写埋设时的手法）
 *  - explicit: 明写（直接点破，读者立刻知道是伏笔）
 *  - implicit: 暗写（藏在对话或动作里，读者需要细品）
 *  - indirect: 侧写（通过他人视角提及，间接埋设） */
export type ForeshadowPlantMethod = 'explicit' | 'implicit' | 'indirect'

/** 伏笔回收方式（指导 LLM 写回收时的手法）
 *  - explicit: 明回收（直接点破，与埋设呼应）
 *  - implicit: 暗回收（让读者自己悟，不点破）
 *  - reverse: 反向回收（与埋设相反，制造反转）
 *  - progressive: 递进回收（多次点破，逐步释放） */
export type ForeshadowRecoverMethod = 'explicit' | 'implicit' | 'reverse' | 'progressive'

// ── 线索 ──

/** 章节跨度：[start, end] 闭区间 */
export type ChapterSpan = [number, number]

export interface NovelClue {
  id: string
  projectId: string
  description: string
  pointsTo: string
  progress: number // 0-100
  currentStep: string
  nextStep: string
  isMisleading: boolean
  linkedForeshadow: string | null
  /** 线索被发现、验证或推进的章节；空数组表示尚未编排 */
  chapterSpans: ChapterSpan[]
  createdAt: number
  updatedAt: number
}

// ── 冲突 ──

export interface NovelConflict {
  id: string
  projectId: string
  description: string
  type: ConflictType
  intensity: number // 1-10
  stage: ConflictStage
  participants: string // JSON: string[]
  /** 非连续跨度数组，如 [[1,3],[10,12]]；空数组表示未放置 */
  chapterSpans: ChapterSpan[]
  tier: ConflictTier // 冲突层级
  /** 预计爆发章节（高潮目标章节） */
  climaxChapter?: number | null
  /** 高潮类型建议（该冲突推向高潮时的预期高潮种类） */
  climaxType?: ClimaxType | null
  /** 关联冲突 ID 列表（冲突网编织，JSON: string[]） */
  relatedConflicts?: string // JSON: string[]
  /** 赌注/代价（冲突失败或成功后的代价） */
  stakes?: string | null
  /** 突转潜力（0-10，越高越适合安排突转） */
  twistPotential?: number
  // ── 四层逻辑③：功能层 + 推进模式 ──
  /** 剧情功能位（复用 PlotFunction 七值枚举，避免类型爆炸）
   * - amplify_conflict: 放大冲突（让冲突升级到更高强度）
   * - open_phase: 打开新阶段（开启下一段故事）
   * - reveal_world_rule: 暴露世界规则（通过冲突展现世界运作方式）
   * - change_judgment: 改变主角判断（让主角重新评估）
   * - 其他值（provide_resource/create_obstacle/advance_relationship）理论可用但较少 */
  plotFunction?: PlotFunction
  /** 推进模式（决定 engine.computeConflictTargetStage 的推进路径）
   * - linear: 默认线性推进 latent→emerging→escalating→erupting→reversing→resolved
   * - mutation: 突变跳跃（latent 直接 erupting，跳过多阶）
   * - stagnation: 停滞（保持当前阶段，仅强度变化，用于潜伏长冲突）
   * - regression: 降级（erupting→escalating，因外部干预或形势缓和）
   * - reversal: 反复（resolved 重新 emerging，旧仇重燃 / 误解决） */
  progressionMode?: ConflictProgressionMode
  createdAt: number
  updatedAt: number
}

export type ConflictType =
  | 'inner' | 'relationship' | 'faction' | 'interest'
  | 'moral' | 'identity' | 'emotional' | 'world_rule' | 'survival'

export type ConflictStage =
  | 'latent' | 'emerging' | 'escalating' | 'erupting'
  | 'reversing' | 'resolved' | 'transformed'

export type ConflictTier = 'main' | 'secondary' | 'goal'

/** 冲突推进模式（四层逻辑③：非线性推进支持） */
export type ConflictProgressionMode =
  | 'linear' | 'mutation' | 'stagnation' | 'regression' | 'reversal'

// ── 钩子（v0.2：章末悬念驱动实体）──

/** 钩子状态：thrown（抛出）→ fulfilled（兑现）/ abandoned（弃用） */
export type HookStatus = 'thrown' | 'fulfilled' | 'abandoned'

/**
 * 章尾钩子实体（v0.2 新增）
 *
 * 职能边界：节奏层，追踪章末悬念的「抛出→兑现」闭环。
 * 与伏笔/冲突正交：伏笔是信息层（埋设-回收），冲突是张力层（有对抗方），
 * 钩子是节奏层（单章末的读者驱动设计）。
 *
 * 创建时机：Director 规划本章时创建（status=thrown）
 * 兑现时机：Memory Agent 检测到后续章节承接时标记 fulfilled
 * 关联建立：Memory Agent 创建伏笔/冲突后回填 linked_*_id
 */
export interface NovelHook {
  id: string
  projectId: string
  /** 抛出钩子的章节号 */
  chapterNumber: number
  hookType: ChapterEndingHookType
  /** 钩子内容描述（Director 规划时填） */
  description: string
  status: HookStatus
  /** 兑现章节号（fulfilled 时填） */
  fulfilledAtChapter: number | null
  /** 兑现方式描述（Writer 兑现后填） */
  fulfilledDescription: string | null
  /** 可选关联伏笔（钩子是伏笔的埋设） */
  linkedForeshadowId: string | null
  /** 可选关联冲突（钩子是冲突升级） */
  linkedConflictId: string | null
  createdAt: number
  updatedAt: number
}

// ── 角色弧光（v0.2：角色内心阶段演进）──

/** 弧光类型：growth成长 / fall堕落 / redemption救赎 / shift转变 */
export type ArcType = 'growth' | 'fall' | 'redemption' | 'shift'

/** 弧光阶段历史记录项 */
export interface ArcStageHistoryEntry {
  stage: string
  triggerEvent: string
  description: string
  chapterNumber: number
  changedAt: number
}

/**
 * 角色弧光实体（v0.2 新增）
 *
 * 职能边界：成长层，追踪角色内心的阶段演进。
 * 与 character_history 正交：character_history 记录横向状态变更（currentState/goal），
 * 弧光记录纵向成长线（只在阶段转换时更新）。
 *
 * 1:1 关联角色（一个角色一条主弧光线，多弧光留到 v0.3）。
 * character.arcStage 字段保留作弧光当前阶段的镜像。
 */
export interface NovelCharacterArc {
  id: string
  projectId: string
  characterId: string
  arcType: ArcType
  currentStage: string
  stageHistory: ArcStageHistoryEntry[]
  description: string | null
  createdAt: number
  updatedAt: number
}

/** 弧光阶段模型（按 arcType 对应不同阶段序列） */
export const ARC_STAGE_MODELS: Record<ArcType, string[]> = {
  growth: ['denial', 'resistance', 'acceptance', 'transformation'],
  fall: ['temptation', 'rationalization', 'corruption', 'point_of_no_return'],
  redemption: ['guilt', 'atonement', 'sacrifice', 'redemption'],
  shift: ['old_framework', 'disruption', 'exploration', 'new_framework'],
}

// ── 世界规则 ──

export interface NovelWorldRule {
  id: string
  projectId: string
  category: string // 力量体系/魔法/科技/政治/经济/地理/禁忌/代价...
  rule: string
  cost: string | null
  isFixed: boolean
  createdAt: number
  updatedAt: number
}

// ── 势力 ──

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
  allies: string[] // factionId[]
  enemies: string[] // factionId[]
  status: NovelFactionStatus
  /** 非连续跨度数组，如 [[1,3],[10,12]]；空数组表示未放置 */
  chapterSpans: ChapterSpan[]
  createdAt: number
  updatedAt: number
}

// ── 地点 ──

export type NovelLocationType =
  | 'continent' | 'country' | 'city' | 'building' | 'dungeon' | 'region' | 'wilderness'
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
  status: NovelLocationStatus
  appearChapters: number[] // 地点出现的章节列表
  createdAt: number
  updatedAt: number
}

// ── 世界观要素 ──

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

// ── 创作约束 ──

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

export type ConstraintType = 'fact' | 'cognitive' | 'stage' | 'debt' | 'arc'

// ── 信息差 ──

export interface NovelInformationLayer {
  id: string
  projectId: string
  infoDescription: string
  authorKnows: boolean
  readerKnows: boolean
  characterKnowledge: string // JSON: { [characterId]: { knows, suspects, misunderstands } }
  revealStage: string | null
  revealChapter: number | null
  isRevealed: boolean
  /** ── P3-2：关联伏笔 ID 数组（JSON: string[]）
   * 一条信息差可被多个伏笔承载（如"主角真实身份"可由吊坠伏笔+预言伏笔共同暗示） */
  linkedForeshadows: string
  createdAt: number
  updatedAt: number
}

// ── 风格指南 ──

export interface NovelStyleGuide {
  id: string
  projectId: string
  category: string
  rule: string
  example: string | null
  createdAt: number
  updatedAt: number
}

/**
 * 项目级叙事文风档案。
 *
 * 风格指南仍用于零散规则；文风档案负责描述整本书的稳定声音，
 * 由 PromptFactory 按 Agent 类型编译成 Writer/Reviser/Reviewer 提示词。
 */
export type WritingStyleNarrativePerson = 'first' | 'third' | 'mixed'
export type WritingStyleDistance = 'intimate' | 'limited' | 'omniscient'
export type WritingStyleRhythm = 'short' | 'balanced' | 'long'
export type WritingStyleRegister = 'colloquial' | 'plain' | 'literary' | 'classical'

export interface NovelWritingStyleProfile {
  id: string
  projectId: string
  name: string
  preset: string
  narrativePerson: WritingStyleNarrativePerson
  narrativeDistance: WritingStyleDistance
  sentenceRhythm: WritingStyleRhythm
  dialogueRatio: number
  emotionalTemperature: number
  imageryDensity: number
  vocabularyRegister: WritingStyleRegister
  hardRules: string[]
  softRules: string[]
  positiveExamples: string[]
  /** 明确不希望正文模仿的反例，只用于识别句式和叙述习惯，不作为事实上下文。 */
  negativeExamples: string[]
  notes: string
  version: number
  createdAt: number
  updatedAt: number
}

export type NovelWritingStyleProfileInput = Omit<
  NovelWritingStyleProfile,
  'id' | 'projectId' | 'version' | 'createdAt' | 'updatedAt'
>

// ── 作者意图 ──

export interface NovelAuthorIntent {
  id: string
  projectId: string
  chapterId: string | null
  intentType: 'plot' | 'foreshadow' | 'character' | 'scene' | 'dialogue'
  description: string
  targetEntityId: string | null
  createdAt: number
}

// ── 章节验收 ──

export interface NovelChapterReview {
  id: string
  projectId: string
  chapterId: string
  consistencyScore: number | null
  characterScore: number | null
  taskCompletionScore: number | null
  clueProgressScore: number | null
  foreshadowStatusScore: number | null
  conflictChangeScore: number | null
  pacingScore: number | null
  infoControlScore: number | null
  readerHookScore: number | null
  styleScore: number | null
  overallScore: number | null
  verdict: 'accept' | 'revise' | 'reject' | null
  issues: string | null // JSON
  suggestions: string | null // JSON
  reviewedBy: string | null
  createdAt: number
}

// ── 角色状态变更历史 ──

export type CharacterHistoryField =
  | 'currentState' | 'currentGoal' | 'currentPressure' | 'secret' | 'arcStage'

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

// ── 节点位置（前端画布节点坐标持久化）──

export type NovelNodeType =
  | 'project' | 'character' | 'chapter' | 'conflict' | 'foreshadow' | 'group'
  | 'faction' | 'location' | 'world_element' | 'info_layer'

export interface NovelNodePosition {
  id: string
  projectId: string
  nodeType: NovelNodeType
  entityId: string
  posX: number
  posY: number
  updatedAt: number
}

// ── 画布连线（手动连线持久化 + 自动边存储）──

/**
 * 边类型语义：
 * - appearance    角色 ↔ 章节（出场）
 * - relationship  角色 ↔ 角色（关系）
 * - involvement   冲突 → 角色（参与）
 * - foreshadow    伏笔 → 章节（埋设/回收）
 * - base          地点 ↔ 章节（场景）
 * - member        势力 ↔ 角色（成员/首领）
 * - hierarchy     地点 ↔ 地点 / 世界观要素 ↔ 世界观要素（层级）
 * - association   其他关联（兜底）
 * - mentor        师徒
 * - kinship       亲属
 * - rivalry       敌对
 * - alliance      同盟
 * - subordinate   隶属
 * - trigger       触发
 * - causality     因果
 */
export type NovelEdgeType =
  | 'appearance' | 'relationship' | 'involvement' | 'foreshadow'
  | 'base' | 'member' | 'hierarchy' | 'association'
  | 'mentor' | 'kinship' | 'rivalry' | 'alliance' | 'subordinate' | 'trigger' | 'causality'

export interface NovelEdge {
  id: string
  projectId: string
  sourceId: string
  sourceType: NovelNodeType
  targetId: string
  targetType: NovelNodeType
  edgeType: NovelEdgeType
  label: string
  /** true=自动生成, false=手动创建 */
  auto: boolean
  createdAt: number
  updatedAt: number
}

// ── 提示词模板 ──

export interface NovelPromptTemplate {
  id: string
  projectId: string | null // null = 全局默认
  name: string // 模板名称（如 writer, director, reviewer...）
  content: string // 模板内容，支持 {{variable}} 占位符
  description: string | null
  createdAt: number
  updatedAt: number
}

// ── 故事状态快照 ──

export interface StoryState {
  project: NovelProject
  characters: NovelCharacter[]
  relationships: NovelRelationship[]
  activeConflicts: NovelConflict[]
  pendingForeshadowing: NovelForeshadow[]
  activeClues: NovelClue[]
  activeFactions: NovelFaction[]
  activeLocations: NovelLocation[]
  currentStage: StoryStage
  currentChapter: number
}

// ── 字数预算（借鉴 oh-story-claudecode）──

/**
 * 字数预算：情节点级别的字数分配
 * Director 在规划时为每个情节点分配密/疏预算
 */
export interface WordBudget {
  /** 最少字数 */
  min: number
  /** 最多字数 */
  max: number
  /** 目标字数（min 和 max 的加权平均，Writer 的主目标） */
  target: number
}

// ── 文风指纹（借鉴 oh-story-claudecode，抗 compaction 的文风基准）──

/**
 * 文风指纹：从前几章正文中提取的文风特征快照
 * 用于在 context compaction 后仍能保持文风一致性
 * 由系统自动提取，注入 Writer/Reviewer 的提示词
 */
export interface StyleFingerprint {
  /** 平均句长（字符） */
  avgSentenceLength: number
  /** 短句占比（< 15 字的句子百分比） */
  shortSentenceRatio: number
  /** 长句占比（> 40 字的句子百分比） */
  longSentenceRatio: number
  /** 对话占比（含引号段落字数 / 总字数） */
  dialogueRatio: number
  /** 比喻密度（每千字比喻词出现次数） */
  metaphorDensity: number
  /** 段落平均长度（字符） */
  avgParagraphLength: number
  /** 叙事人称（第一/第三人称） */
  narrativePerson: 'first' | 'third' | 'mixed'
  /** 情感温度（0=冷峻克制，10=热烈奔放） */
  emotionalTemperature: number
  /** 采样章节范围（如 [1, 5] 表示从第1-5章提取） */
  sampleChapters: [number, number]
}

// ── 细纲五段式（借鉴 oh-story-claudecode）──

/**
 * 章节细纲：五段式结构化细纲
 * Director 规划时可选生成，Writer 按细纲创作
 */
export interface ChapterBlueprint {
  /** 章节定位 */
  positioning: ChapterPositioning
  /** 字数预算 */
  wordBudget: WordBudget
  /** 开篇段（第一段怎么写：场景/动作/对话） */
  opening: string
  /** 发展段（主体剧情推进） */
  development: string
  /** 转折段（关键转折或高潮点） */
  turningPoint: string
  /** 收束段（处理后果，过渡） */
  resolution: string
  /** 章尾钩子段（最后一段怎么收） */
  endingHook: string
}

// ── 统一 Findings Schema（借鉴 oh-story-claudecode）──

/** 问题严重度分级 */
export type FindingSeverity = 'S1' | 'S2' | 'S3' | 'S4'
// S1: 致命问题（必须 reject：模型退化/工程词泄漏/拒绝输出）
// S2: 严重问题（必须 revise：AI 腔模式/对话三症状/衔接断裂/开放项丢弃）
// S3: 中等问题（建议 revise：节奏偏差/字数偏差/对话密度异常）
// S4: 轻微问题（可选 revise：长段落/比喻密度/风格微偏）

/** 问题分类 */
export type FindingCategory =
  | 'ai_tone'             // AI 腔模式
  | 'dialogue'            // 对话质量问题
  | 'continuity'          // 连续性问题
  | 'plot'                // 剧情问题
  | 'style'               // 风格问题
  | 'model_degradation'   // 模型退化

/** 统一审查发现项 */
export interface ReviewFinding {
  /** 严重度 */
  severity: FindingSeverity
  /** 问题分类 */
  category: FindingCategory
  /** 问题描述 */
  description: string
  /** 问题位置（段落编号或引用片段） */
  location?: string
  /** 修改建议 */
  suggestion?: string
}

// ── 叙事任务 ──

export interface NarrativeTask {
  description: string
  type: NarrativeTaskType
  /** 次要任务类型（最多 2 个，允许一章兼顾多个任务） */
  secondaryTasks?: NarrativeTaskType[]
  targetEntity: string | null
  priority: 'high' | 'medium' | 'low'
  /** 预期冲突强度变化（如 escalate_conflict 任务时使用） */
  expectedIntensityDelta?: number
  /** 高潮目标（create_reversal 或 climax 章节时使用） */
  climaxTarget?: {
    type: ClimaxType
    intensity: ClimaxIntensity
  }
  /** 悬念持续章数（create_suspense 任务时使用，默认 2-3 章） */
  suspenseDuration?: number
  /** 章尾钩子类型（Director 规划，Writer 执行） */
  chapterEndingHook?: ChapterEndingHookType
  /** v0.2：章尾钩子描述文本（Director 规划的完整描述，用于创建钩子实体） */
  chapterEndingHookDescription?: string
  /** 本章 POV（视点人物）角色名列表，Writer 必须严格使用这些角色的视角 */
  povCharacters?: string[]
  /** 本章场景数（1=单场景写透，2-3=多场景快推），引导 Writer 控制节奏速率 */
  sceneCount?: number
  /** 章节定位（Director 规划或用户手动指定，决定节奏与字数预算） */
  positioning?: ChapterPositioning | null
  /** 时间线偏移（相对第1章的天数，由 Director 规划，持久化到章节） */
  timeOffset?: number | null
}

/** 章尾钩子类型 */
export type ChapterEndingHookType = 'suspense' | 'reversal' | 'emotional' | 'action' | 'none'

export type NarrativeTaskType =
  | 'advance_mainline' | 'advance_subline' | 'create_conflict' | 'escalate_conflict'
  | 'release_info' | 'hide_info' | 'reinforce_foreshadow' | 'recover_foreshadow'
  | 'change_relationship' | 'change_cognition' | 'create_reversal' | 'create_suspense'
  | 'phase_closure' | 'introduce_problem'

// ── 章节约束 ──

export interface ChapterConstraints {
  facts: NovelConstraint[]
  cognitive: NovelConstraint[]
  stage: NovelConstraint[]
  narrativeDebts: NovelForeshadow[]
  characterArcs: Array<{
    character: NovelCharacter
    allowedNextStage: string | null
  }>
  /** 本章必须推进的冲突清单（含目标阶段和强度变化） */
  conflictTargets: ConflictTarget[]
  /** 本章节奏约束（含高潮强度和类型建议） */
  rhythmConstraint?: RhythmConstraint
  /** 本章悬念钩子（需要维持或释放的悬念） */
  suspenseHooks: SuspenseHook[]
  /** 本章 POV（视点人物）角色 ID 列表，Writer 必须严格使用这些角色的视角 */
  povCharacters?: string[]
  /** 本章场景数（1=单场景写透，2-3=多场景快推），引导 Writer 控制节奏速率 */
  sceneCount?: number
  /** 本章时间线偏移（相对第1章的天数，引导 Writer 把握时间推进） */
  timeOffset?: number | null
  /** 本章字数预算（Director 规划的情节点级别字数分配，NULL 表示用系统默认目标字数） */
  wordBudget?: WordBudget | null
  /** 本章定位（六型之一，引导 Writer 按定位调整写法，NULL 表示未设定） */
  positioning?: ChapterPositioning | null
}

/** 冲突推进目标 */
export interface ConflictTarget {
  conflict: NovelConflict
  /** 本章目标阶段 */
  targetStage: ConflictStage
  /** 本章预期强度变化（正数为升级，负数为降级） */
  intensityDelta: number
  /** 是否本章推向高潮 */
  isClimax: boolean
}

/** 节奏约束 */
export interface RhythmConstraint {
  rhythm: ChapterRhythm
  /** 高潮强度（仅 rhythm='climax' 时有值） */
  climaxIntensity?: ClimaxIntensity
  /** 高潮类型建议 */
  climaxType?: ClimaxType
  /** 节奏描述 */
  description: string
  /** 建议原因 */
  reason: string
}

/** 悬念钩子 */
export interface SuspenseHook {
  /** 关联的信息差 ID */
  infoLayerId: string | null
  /** 悬念描述 */
  description: string
  /** 悬念状态：planting（埋设）/ sustaining（维持）/ releasing（释放） */
  status: 'planting' | 'sustaining' | 'releasing'
  /** 悬念已持续的章数 */
  sustainedChapters: number
  /** 计划释放章节 */
  releaseByChapter: number | null
}

// ── 本章已编排的实体约束 ──

/**
 * 本章角色剧情功能位（临时编排结果，回答"他这次出场负责推动什么"）
 *
 * 区别于 NovelCharacterPlotRole（角色层级，持久化），PlotFunction 是某角色在本章
 * 的具体推动作用，每章可变。回答四层逻辑第三句"他这次出场负责推动什么"。
 *
 * 七种功能位对应四层逻辑列出的常见剧情功能：
 * - provide_resource: 提供资源（信息/物品/人脉/能力）
 * - create_obstacle: 制造阻碍（直接拦主角或制造麻烦）
 * - amplify_conflict: 放大冲突（让现有冲突升级或暴露）
 * - open_phase: 打开新阶段（引入新场景/新角色/新规则）
 * - change_judgment: 改变主角判断（让主角重新评估或转变想法）
 * - advance_relationship: 推进感情线（让某段关系发生质变）
 * - reveal_world_rule: 暴露世界规则（通过他展示世界运作方式）
 *
 * 同一角色同章可承担多个功能位（如既提供资源又放大冲突）。
 */
export type PlotFunction =
  | 'provide_resource' | 'create_obstacle' | 'amplify_conflict'
  | 'open_phase' | 'change_judgment' | 'advance_relationship' | 'reveal_world_rule'

/** 单个角色本章的功能位编排（不持久化，仅注入 Writer SEMI 层） */
export interface CharacterFunctionEntry {
  characterId: string
  /** 功能位（必填，决定该角色本章推动什么） */
  function: PlotFunction
  /** 功能位的具体描述（可选，让 Writer 知道如何执行） */
  note?: string
}

/** 本章已编排的实体约束（手动编排或 AI 编排产出，注入 Writer SEMI 提示词层） */
export interface ArrangedEntity {
  characterIds: string[]
  conflictIds: string[]
  foreshadowIds: string[]
  /** 本章需要呈现或推进的线索；可选以兼容旧版矩阵快照。 */
  clueIds?: string[]
  factionIds: string[]
  locationIds: string[]
  /**
   * 角色本章功能位编排（可选，未指定时不约束）。
   * 由 planEntitiesFromOutline 在编排阶段为每个新角色规划，注入 Writer 让其明确
   * "这角色这次出场负责推动什么"，避免"在场 + 说话"的工具人化。
   */
  characterFunctions?: CharacterFunctionEntry[]
}

// ── 缓存层标记 ──

/**
 * 提示词缓存层级
 *
 * 缓存命中率是小说创作的关键成本指标。
 * 提示词按缓存稳定性从高到低分层：
 *
 * STATIC    - 系统提示词中的静态部分（世界规则、风格、角色定义）
 *             跨章节不变，缓存命中率最高
 * SEMI      - 章节上下文（当前状态、叙事任务）
 *             单章内不变，跨章失效
 * DYNAMIC   - 对话消息（工具调用结果、生成内容）
 *             每次调用都变，不缓存
 */
export type CacheLayer = 'static' | 'semi' | 'dynamic'

// ── Agent 调用日志 ──

export type NovelAgentLogStatus = 'success' | 'error' | 'cancelled'

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
  /** LLM 返回的 input tokens（不含 cache read） */
  inputTokens: number
  /** LLM 返回的 output tokens */
  outputTokens: number
  /** LLM prompt cache 命中读取的 tokens（0 = 完全 miss） */
  cacheReadTokens: number
  /** LLM prompt cache 写入的 tokens（首次写入缓存） */
  cacheWriteTokens: number
  /** LLM provider 名（如 deepseek） */
  llmProvider: string
  /** LLM 模型名（如 deepseek-v4-flash） */
  llmModel: string
  createdAt: number
}

/** 列表查询时返回的精简记录（不含完整 prompt 内容，避免传输过大） */
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
  /** LLM 返回的 input tokens（不含 cache read） */
  inputTokens: number
  /** LLM 返回的 output tokens */
  outputTokens: number
  /** LLM prompt cache 命中读取的 tokens（0 = 完全 miss） */
  cacheReadTokens: number
  /** LLM prompt cache 写入的 tokens（首次写入缓存） */
  cacheWriteTokens: number
  /** LLM provider 名（如 deepseek） */
  llmProvider: string
  /** LLM 模型名（如 deepseek-v4-flash） */
  llmModel: string
  createdAt: number
}

// ── 时间轴标记 ──

export type NovelMarkerType =
  | 'bookmark' | 'turning-point' | 'foreshadow' | 'climax' | 'note'
  | 'clip-note' | 'in' | 'out'

export type NovelMarkerColor = 'blue' | 'yellow' | 'green' | 'red' | 'purple'

/** 时间轴标记：用户在时间轴上手动创建的章节标记 */
export interface NovelMarker {
  id: string
  projectId: string
  /** 标记所在章节号 */
  chapter: number
  title: string
  /** 可选备注 */
  note: string
  /** 标记类型：书签/转折/伏笔/高潮/备注/入点/出点 */
  type: NovelMarkerType
  /** 标记颜色 */
  color: NovelMarkerColor
  /** clip-note 关联的实体类型（仅 type='clip-note' 时有效） */
  entityType: string | null
  /** clip-note 关联的实体 ID */
  entityId: string | null
  createdAt: number
  updatedAt: number
}

// ── 实体去重（整理功能）──

/** 支持去重的实体类型（不含 world_element，因其无独立 name 且 description 自由） */
export type DeduplicateEntityKind = 'character' | 'conflict' | 'foreshadow' | 'faction' | 'location'

/** 一组重复实体：保留一个，删除其余 */
export interface DeduplicateGroup {
  kind: DeduplicateEntityKind
  /** 用于判重的字段值（character/faction/location 为 name，conflict/foreshadow 为 description） */
  key: string
  /** 保留的实体 ID（每组保留 createdAt 最早的） */
  keptId: string
  /** 保留实体的显示名称 */
  keptName: string
  /** 待删除的实体列表 */
  removed: Array<{ id: string; name: string; createdAt: number }>
}

/** 去重报告 */
export interface DeduplicateReport {
  /** 所有重复组（按 character → conflict → foreshadow → faction → location 顺序） */
  groups: DeduplicateGroup[]
  /** 总共待删除/已删除的实体数（所有 removed 之和） */
  totalRemoved: number
}

// ── LLM 相似度扫描 ──

/** LLM 相似度扫描支持的实体类型（含 world_element / hook / character_arc） */
export type SimilarityEntityKind = 'character' | 'conflict' | 'foreshadow' | 'faction' | 'location' | 'world_element' | 'hook' | 'character_arc'

/** 一组相似实体（LLM 判定） */
export interface SimilarityGroup {
  /** 实体类型 */
  kind: SimilarityEntityKind
  /** LLM 给出的相似度理由（如"都是寻找失落神器的角色"） */
  reason: string
  /** 相似度分数 0-1（LLM 主观判断，>0.6 才报告） */
  similarity: number
  /** LLM 建议保留的实体 ID */
  keptId: string
  /** 建议删除的实体列表 */
  removed: Array<{ id: string; name: string }>
  /** 字段级合并建议：保留实体的字段应该用哪个来源的值 */
  fieldMerges?: Array<{
    field: string
    fromId: string
    fromName: string
    reason: string
  }>
}

/** 相似度扫描报告 */
export interface SimilarityScanReport {
  groups: SimilarityGroup[]
  totalCandidates: number
}

/** 相似度扫描进度事件 */
export interface SimilarityScanProgressEvent {
  phase: 'preparing' | 'generating' | 'parsing' | 'completed' | 'fallback'
  message: string
  data?: unknown
}
