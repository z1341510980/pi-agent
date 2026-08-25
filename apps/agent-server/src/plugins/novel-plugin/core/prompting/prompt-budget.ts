/**
 * 提示词预算集中表。
 *
 * ## 为什么要集中
 *
 * 这些上限此前是 40 多个散落在各 format 方法里的裸字面量。后果是没人能看到全局分配，
 * 于是出现过这样的失配：角色的「性格」只有 120 字，比「此刻状态」的 160 字还低，
 * 而性格是多角色同场时唯一的区分来源 —— 直接导致人物趋同。
 * 集中成一张表之后，这类问题一眼可见，也才有条件做全局预算调整。
 *
 * ## 约定
 *
 * - 单位是**字符数**（中文按字计），不是 token。全链路没有 token 计算，只有字符硬上限。
 * - 数值改动会直接改变发给 LLM 的文本，属于**行为变更**：golden-prompt 快照会 diff，
 *   必须在 PR 里说明为什么改。
 * - 结构性约束写在 PROMPT_BUDGET_INVARIANTS 里，由单测强制。
 */

/** system 层（跨章节稳定，缓存命中率最高的一段） */
export const SYSTEM_BUDGET = {
  /** 故事简介 */
  synopsis: 2400,
  /** 全书大纲 */
  outline: 4000,
  /** 前卷回顾 */
  previousVolumeOutline: 1200,
  /** 当前卷纲 */
  currentVolumeOutline: 2400,
  /** 下卷方向 */
  nextVolumeOutline: 800,
  /** 世界规则条数上限 */
  worldRuleCount: 40,
  /** 风格指南条数上限 */
  styleGuideCount: 20,
} as const

/**
 * 角色短卡（formatArrangedEntities）。
 *
 * ⚠️ 分配原则：**区分度字段的预算必须高于状态字段**。
 * 「性格」与「对话」决定多角色同场时读者能否分辨谁在说话；
 * 「此刻/想要/压力」只描述当下处境，同场角色之间天然不同，不需要那么多字。
 * 见 PROMPT_BUDGET_INVARIANTS。
 */
export const CHARACTER_CARD_BUDGET = {
  identity: 96,
  currentState: 160,
  currentGoal: 100,
  currentPressure: 120,
  /** 跨章稳定的人格发动机 */
  longTermDesire: 120,
  /** 结构化 JSON，按键序抽取（核心/优点/缺点/座右铭） */
  personality: 260,
  /** 结构化 JSON，按键序抽取（基调/典型句式示例/特点） */
  speechStyle: 240,
  /** 本章功能位的补充说明 */
  functionNote: 80,
} as const

/** 无编排时的兜底故事状态（formatStoryState）：每类实体保留条数，超出仅列名 */
export const STORY_STATE_LIMIT = {
  characters: 8,
  relationships: 6,
  conflicts: 5,
  foreshadows: 5,
  clues: 4,
  factions: 4,
  locations: 4,
  items: 3,
} as const

/** 实体关联（formatEdges）与信息差（formatInfoLayers） */
export const RELATION_BUDGET = {
  /** 边条数上限（含无相关实体时的兜底取前 N 条） */
  edgeCount: 20,
  /** 信息差条数上限 */
  infoLayerCount: 8,
} as const

/** 事件账本承接（formatStoryLedgerContext） */
export const LEDGER_BUDGET = {
  /** 最近承接的变化条数 */
  recentChangeCount: 6,
  /** 本章计划的变化条数 */
  plannedChangeCount: 4,
  /** 后文边界（未来承诺）条数 */
  futureCommitmentCount: 2,
  /** 作者批注条数 */
  annotationCount: 4,
  /** 变化缘由文本 */
  changeReason: 96,
  /** 未来承诺的事件标题 */
  commitmentTitle: 100,
  /** 批注正文 */
  annotationContent: 160,
  /**
   * "最近承接"只回看几章。
   *
   * 例：2 表示写第 N 章时只注入第 N-2 与 N-1 章的变化结果。
   * 调大会让 Writer 看到更长的状态演变，但也更容易与角色短卡的"此刻"重复。
   */
  recentChangeLookback: 2,
} as const

/** 前后章锚点与摘要 */
export const CHAPTER_ANCHOR_BUDGET = {
  /** 最近章节摘要覆盖章数 */
  recentChapterCount: 5,
  /** 无 recap 时用正文开头兜底的字数 */
  recapFallback: 300,
  /**
   * 上一章结尾取尾部字数。
   *
   * 这是 Writer 的"续写语感锚点"：每次创作都是全新会话（无跨章 session），
   * 模型能接触到的自己前文只有这段逐字原文。400 字只够看到钩子，
   * 看不到场景切换的节奏和句子呼吸；2400 字覆盖 1-2 个完整场景收尾。
   * 位于 shared 缓存段内：同一次 run 内各 Agent 复用同一份缓存，增量成本可控。
   */
  previousEnding: 2400,
  /** 叙事声音锚点：每章代表片段字数 */
  soundAnchorExcerpt: 200,
  /** 下一章开头取字数（重写中间章时的兼容锚点；与上一章结尾保持对称） */
  nextChapterOpening: 1600,
  /** 上一章未兑现钩子条数（必须完整承接） */
  previousChapterHookCount: 3,
  /** 更早遗留钩子条数（仅作债务提醒） */
  olderHookBacklogCount: 2,
} as const

/**
 * 文风指纹的可信度门槛。
 *
 * 指纹是"从既有正文自动量化"的观测值，样本不足时指标会失真
 * （历史上对话占比因引号正则被编码转换破坏而恒为 0%，还带 ⚠️ 强制一致，
 * 等价于命令 Writer 整章不写对话）。低于门槛时降级为参考值，不作硬约束。
 */
export const FINGERPRINT_TRUST = {
  /** 样本正文最少字符数 */
  minParagraphChars: 3000,
  /** 样本最少段落数 */
  minParagraphCount: 20,
} as const

/** diff 模式（context-preview）专用上限 */
export const DIFF_BUDGET = {
  /** 主角/配角身份摘要 */
  identity: 40,
  /** 配角条数 */
  supportingCharacterCount: 2,
  /** 冲突/伏笔/线索描述 */
  entityDescription: 60,
  /** 冲突条数 */
  conflictCount: 3,
  /** 伏笔条数 */
  foreshadowCount: 3,
  /** 线索条数 */
  clueCount: 2,
  /** delta 变化条数（每类） */
  deltaChangeCount: 5,
  /** delta 变化缘由 */
  deltaReason: 60,
} as const

/**
 * 结构性约束：由单测强制，防止预算调整时破坏"区分度优先"的分配原则。
 *
 * 每条 check 返回 true 表示满足。
 */
export const PROMPT_BUDGET_INVARIANTS: Array<{ name: string; check: () => boolean }> = [
  {
    name: '性格预算不得低于此刻状态（性格是多角色同场唯一的区分来源）',
    check: () => CHARACTER_CARD_BUDGET.personality >= CHARACTER_CARD_BUDGET.currentState,
  },
  {
    name: '对话预算不得低于此刻状态（台词可互换即人物趋同）',
    check: () => CHARACTER_CARD_BUDGET.speechStyle >= CHARACTER_CARD_BUDGET.currentState,
  },
  {
    name: '性格与对话预算需足以容纳结构化 JSON 的成对键（核心+优点+缺点 / 基调+句式示例）',
    check: () => CHARACTER_CARD_BUDGET.personality >= 200 && CHARACTER_CARD_BUDGET.speechStyle >= 200,
  },
  {
    name: '最近承接的回看章数不得超过最近章节摘要的覆盖范围（否则状态与摘要脱节）',
    check: () => LEDGER_BUDGET.recentChangeLookback <= CHAPTER_ANCHOR_BUDGET.recentChapterCount,
  },
  {
    name: '上一章结尾字数不得超过下一章开头字数的 2 倍（前后锚点应对称）',
    check: () => CHAPTER_ANCHOR_BUDGET.previousEnding <= CHAPTER_ANCHOR_BUDGET.nextChapterOpening * 2,
  },
  {
    name: '上一章结尾是续写语感锚点，不得低于一个完整场景的体量（否则 Writer 只能靠摘要想象前文）',
    check: () => CHAPTER_ANCHOR_BUDGET.previousEnding >= 1200,
  },
]
