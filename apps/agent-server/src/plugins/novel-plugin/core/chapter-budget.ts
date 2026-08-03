/**
 * 单章成本闸门。
 *
 * ## 为什么需要
 *
 * 实测数据（真实项目 11 章）单章成本极不稳定：
 *
 * | 章 | 调用数 | 输入 token | 耗时 |
 * | --- | --- | --- | --- |
 * | 6 | 4 | 79,446 | 136s |
 * | 9 | 60 | 460,952 | 2287s |
 * | **10** | **73** | **1,257,979** | **3662s（61 分钟）** |
 * | 11 | 44 | 1,045,658 | 2089s |
 *
 * 第 10 章一章烧掉 126 万输入 token、跑了一个小时，而用户在这一小时里只看到
 * 一条 truncate 的进度文字，既不知道花了多少，也没有任何介入点。
 *
 * `MAX_GUARD_REWRITE = 2` 只限制 PostWriteGuard 触发的重写；
 * Reviewer→Reviser→再审的循环、以及用户在检查点主动选「重写」都不受它约束，
 * 所以调用数可以一路涨到 73。
 *
 * ## 设计取舍：推检查点，不硬停
 *
 * 超限时**弹检查点让用户决定**（继续 / 取消），而不是直接中断。
 * 硬停会把已经花掉的 100 万 token 全部作废，比超支更糟 ——
 * 用户往往宁愿再花一点把这一章写完。所以闸门的作用是"告知 + 给出口"，
 * 不是"熔断"。
 *
 * 同一章只提示一次（`acknowledged`）：用户既然已经选择继续，
 * 就不该在后续每次 Agent 调用前反复弹同一个框。
 *
 * ## 本模块的边界
 *
 * 纯函数 + 纯数据，不含计时器与 IO。阈值与判定可被单测钉住，
 * 累加与提问时机由 orchestrator 负责。
 */

/** 单章预算上限 */
export interface ChapterBudgetLimits {
  /** LLM 调用次数 */
  maxLlmCalls: number
  /** 累计输入 token */
  maxInputTokens: number
  /** 墙钟耗时（毫秒） */
  maxWallClockMs: number
  /** 用户主动从检查点重新打开整章的次数 */
  maxFullChapterRewrites?: number
}

/**
 * 默认上限。
 *
 * 取值依据实测分布：正常章节（1~8 章）落在 4~22 次调用、6~13 万 token、
 * 136~1248 秒；失控章节（9~11 章）是 44~73 次、46~126 万 token、35~61 分钟。
 * 阈值定在两者之间，让正常创作不受打扰，失控时尽早暴露。
 */
export const DEFAULT_CHAPTER_BUDGET: ChapterBudgetLimits = {
  maxLlmCalls: 30,
  maxInputTokens: 400_000,
  maxWallClockMs: 25 * 60_000,
  maxFullChapterRewrites: 1,
}

/** 单章累计用量 */
export interface ChapterBudgetUsage {
  /** 本章起始时间戳（毫秒） */
  startedAt: number
  llmCalls: number
  inputTokens: number
  /** 用户已在超限检查点选择继续；同一章不再重复提示 */
  acknowledged: boolean
  fullChapterRewrites: number
  guardWriterRewrites: number
  reviserRuns: number
  reviewerRuns: number
}

export type ChapterBudgetCategory =
  | 'fullChapterRewrites'
  | 'guardWriterRewrites'
  | 'reviserRuns'
  | 'reviewerRuns'

export interface ChapterBudgetCategorySnapshot {
  fullChapterRewrites: number
  maxFullChapterRewrites: number
  fullChapterRewriteAvailable: boolean
  guardWriterRewrites: number
  reviserRuns: number
  reviewerRuns: number
}

export function createChapterBudgetUsage(now: number = Date.now()): ChapterBudgetUsage {
  return {
    startedAt: now,
    llmCalls: 0,
    inputTokens: 0,
    acknowledged: false,
    fullChapterRewrites: 0,
    guardWriterRewrites: 0,
    reviserRuns: 0,
    reviewerRuns: 0,
  }
}

/** 记录一次分类运行；失败重试不会经过调用点，因此不会误占质量重写额度。 */
export function recordChapterBudgetCategory(
  usage: ChapterBudgetUsage,
  category: ChapterBudgetCategory,
): ChapterBudgetUsage {
  return { ...usage, [category]: usage[category] + 1 }
}

export function getChapterBudgetCategorySnapshot(
  usage: ChapterBudgetUsage,
  limits: ChapterBudgetLimits = DEFAULT_CHAPTER_BUDGET,
): ChapterBudgetCategorySnapshot {
  const maxFullChapterRewrites = limits.maxFullChapterRewrites
    ?? DEFAULT_CHAPTER_BUDGET.maxFullChapterRewrites
    ?? 1
  return {
    fullChapterRewrites: usage.fullChapterRewrites,
    maxFullChapterRewrites,
    fullChapterRewriteAvailable: usage.fullChapterRewrites < maxFullChapterRewrites,
    guardWriterRewrites: usage.guardWriterRewrites,
    reviserRuns: usage.reviserRuns,
    reviewerRuns: usage.reviewerRuns,
  }
}

/** 尝试开始一次整章重写；达到上限时保持状态不变并返回 false。 */
export function tryRecordFullChapterRewrite(
  usage: ChapterBudgetUsage,
  limits: ChapterBudgetLimits = DEFAULT_CHAPTER_BUDGET,
): { usage: ChapterBudgetUsage; allowed: boolean } {
  if (!getChapterBudgetCategorySnapshot(usage, limits).fullChapterRewriteAvailable) {
    return { usage, allowed: false }
  }
  return {
    usage: { ...usage, fullChapterRewrites: usage.fullChapterRewrites + 1 },
    allowed: true,
  }
}

/** 记录一次 LLM 调用。返回新对象，便于在不可变上下文里替换。 */
export function recordLlmCall(
  usage: ChapterBudgetUsage,
  inputTokens: number,
): ChapterBudgetUsage {
  return {
    ...usage,
    llmCalls: usage.llmCalls + 1,
    // 缺失或异常的 token 数按 0 计：宁可少算也不要因为脏数据误报超限
    inputTokens: usage.inputTokens + (Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0),
  }
}

/** 触发超限的维度 */
export type BudgetDimension = 'llmCalls' | 'inputTokens' | 'wallClock'

export interface BudgetEvaluation {
  exceeded: boolean
  /** 首个触发上限的维度；未超限为 null */
  dimension: BudgetDimension | null
  /** 面向用户的一句话说明；未超限为 null */
  message: string | null
  /** 各维度的当前值与上限，供检查点展示 */
  snapshot: {
    llmCalls: number
    maxLlmCalls: number
    inputTokens: number
    maxInputTokens: number
    elapsedMs: number
    maxWallClockMs: number
    categories: ChapterBudgetCategorySnapshot
  }
}

/**
 * 判断是否超出单章预算。
 *
 * 维度检查顺序为 调用数 → 输入 token → 耗时：前两者是成本的直接来源，
 * 耗时更多是它们的结果，把耗时放最后能让提示文案指向更有行动价值的那个维度。
 */
export function evaluateChapterBudget(
  usage: ChapterBudgetUsage,
  limits: ChapterBudgetLimits = DEFAULT_CHAPTER_BUDGET,
  now: number = Date.now(),
): BudgetEvaluation {
  const elapsedMs = Math.max(0, now - usage.startedAt)
  const snapshot = {
    llmCalls: usage.llmCalls,
    maxLlmCalls: limits.maxLlmCalls,
    inputTokens: usage.inputTokens,
    maxInputTokens: limits.maxInputTokens,
    elapsedMs,
    maxWallClockMs: limits.maxWallClockMs,
    categories: getChapterBudgetCategorySnapshot(usage, limits),
  }

  if (usage.llmCalls >= limits.maxLlmCalls) {
    return {
      exceeded: true,
      dimension: 'llmCalls',
      message: `本章已调用 AI ${usage.llmCalls} 次（上限 ${limits.maxLlmCalls} 次），是否继续？`,
      snapshot,
    }
  }
  if (usage.inputTokens >= limits.maxInputTokens) {
    return {
      exceeded: true,
      dimension: 'inputTokens',
      message: `本章已消耗输入 ${formatTokens(usage.inputTokens)} token（上限 ${formatTokens(limits.maxInputTokens)}），是否继续？`,
      snapshot,
    }
  }
  if (elapsedMs >= limits.maxWallClockMs) {
    return {
      exceeded: true,
      dimension: 'wallClock',
      message: `本章已进行 ${Math.round(elapsedMs / 60_000)} 分钟（上限 ${Math.round(limits.maxWallClockMs / 60_000)} 分钟），是否继续？`,
      snapshot,
    }
  }
  return { exceeded: false, dimension: null, message: null, snapshot }
}

function formatTokens(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 10_000)} 万`
  return String(n)
}

/**
 * 是否应当在下一次 Agent 调用前弹检查点。
 *
 * 已 acknowledged 的章节不再提示：用户既然选了继续，
 * 就不该在后续每次调用前反复弹同一个框。
 */
export function shouldPromptBudgetCheckpoint(
  usage: ChapterBudgetUsage,
  limits: ChapterBudgetLimits = DEFAULT_CHAPTER_BUDGET,
  now: number = Date.now(),
): boolean {
  if (usage.acknowledged) return false
  return evaluateChapterBudget(usage, limits, now).exceeded
}
