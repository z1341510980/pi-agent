/**
 * WordBudgetResolver：章节字数预算的唯一解析点（T01）。
 *
 * 取代 `computeChapterTargetWords` 的 rhythm 倍率与 `POSITIONING_RULES.wordBudgetMultiplier`
 * 两处各自计算字数的逻辑。全系统（Writer 提示词、PostWriteGuard、buildChapterConstraints、
 * 群聊）只读取本模块的结果，禁止自行重算。
 *
 * 业务不变量（用户已确认）：
 * - `targetWords` 是项目硬目标；
 * - 章节定位最多应用一次调整，且 `|adjustmentPct| <= cap`（推荐默认 cap=15%）；
 * - **Rhythm 永不调整字数**：输入不含 rhythm；
 * - 定位默认不调整（adjustmentPct=0），产品可配置各定位的一次性倍率。
 *
 * 纯函数，无 IO，同输入幂等。
 */
export interface WordBudgetResolution {
  /** 基础目标：project.targetWords > 0 ? round(targetWords) : 3000（由调用方计算传入） */
  baseTarget: number
  /** 已 clamp 的定位调整比例（-cap ~ +cap）；无定位 = 0 */
  adjustmentPct: number
  /** 上下限比例，默认 0.15 */
  cap: number
  /** round(baseTarget * (1 + adjustmentPct)) */
  resolvedTarget: number
  /** round(resolvedTarget * (1 - cap)) */
  min: number
  /** round(resolvedTarget * (1 + cap)) */
  max: number
  /** 本解析是否执行过非零定位调整（供 Guard/对账断言） */
  adjustedOnce: boolean
}

export interface ResolveWordBudgetInput {
  /** 基础目标字数（调用方负责：targetWords > 0 ? round(targetWords) : 3000） */
  baseTarget: number
  /** 已由调用方换算好的定位调整比例；缺省/0 = 不调整 */
  adjustmentPct?: number
  /** 上下限比例，缺省 0.15 */
  cap?: number
}

const DEFAULT_CAP = 0.15

export function resolveWordBudget(input: ResolveWordBudgetInput): WordBudgetResolution {
  const cap = input.cap !== undefined && Number.isFinite(input.cap) ? input.cap : DEFAULT_CAP
  const rawAdjustment = input.adjustmentPct ?? 0
  const adjustmentPct = Math.min(Math.max(rawAdjustment, -cap), cap)
  const resolvedTarget = Math.round(input.baseTarget * (1 + adjustmentPct))
  return {
    baseTarget: input.baseTarget,
    adjustmentPct,
    cap,
    resolvedTarget,
    min: Math.round(resolvedTarget * (1 - cap)),
    max: Math.round(resolvedTarget * (1 + cap)),
    adjustedOnce: Math.abs(adjustmentPct) > 0,
  }
}

/**
 * 由项目目标字数换算基础目标：targetWords > 0 取 round，否则 3000。
 * 集中放这里，避免各调用点各自兜底导致口径不一。
 */
export function baseTargetOf(targetWords: number | undefined): number {
  return targetWords !== undefined && targetWords > 0 ? Math.round(targetWords) : 3000
}

/**
 * 中文正文的字→token 换算系数（保守取值）。
 *
 * 常见 tokenizer 对中文约 1 token ≈ 1-1.5 字；取 1 字 ≈ 1 token 的保守侧，
 * 宁可给足也不要把合规稿件截断。
 */
const CHARS_PER_TOKEN = 1

/**
 * thinking / reasoning 预留 token：推理模型的思考块与正文共享 max_tokens 配额。
 *
 * 实测 Writer 的 thinking 块只有几十字符（诊断日志 reasoningChars=36），
 * 早先给 4000 等于把物理闸整体抬到 7900，闸门形同虚设（实测首稿 4740 字仍畅通）。
 * 收到 1200：够容纳正常的思考块，又不至于让超写多出一整场的空间。
 */
const REASONING_RESERVE_TOKENS = 1200

/** 物理闸相对硬上限的宽容系数：留一点收尾余量，避免在合规稿件的最后一句被截断 */
const PHYSICAL_GATE_SLACK = 1.1

export interface WriterMaxTokensInput {
  /** 本章硬上限字数（target × bloatCeilingRatio，由调用方算好） */
  maxWords: number
  /** 目标模型的 maxTokens（来自 modelRegistry）；未知时不夹紧 */
  modelMaxTokens?: number
  /** 是否为推理模型（thinking 块占用同一配额） */
  reasoning?: boolean
}

/**
 * Writer 的 max_tokens 物理兜底。
 *
 * ## 这个闸的职责边界
 *
 * 它只防「无限膨胀」（写到目标两倍以上），**不是字数控制器**：拧到贴着硬上限
 * 会在合规稿件的最后一句被截断，Guard 判「正文疑似截断」→ 全量重写，比超写更贵。
 * 字数纪律由 prompt 的逐场预算 + PostWriteGuard 的定向压缩负责。
 *
 * ## 为什么不能直接把 maxWords 当 token 传
 *
 * 中文一章 3000 字约 2000-3000 token，推理模型的 thinking 块还与正文共享同一
 * 配额。顶到上限返回 `stopReason='length'` 会被 pi SDK 的 `isRecoverableLength`
 * 判成可恢复截断，触发一次 compact + retry —— 白烧一轮还可能压掉上下文。
 *
 * 所以：硬上限字数按字→token 保守换算，加 10% 收尾余量与小额 thinking 预留，
 * 再用模型自身 maxTokens 夹紧。
 */
export function resolveWriterMaxTokens(input: WriterMaxTokensInput): number {
  const bodyTokens = Math.ceil((input.maxWords * PHYSICAL_GATE_SLACK) / CHARS_PER_TOKEN)
  const desired = bodyTokens + (input.reasoning === false ? 0 : REASONING_RESERVE_TOKENS)
  return input.modelMaxTokens && input.modelMaxTokens > 0
    ? Math.min(desired, input.modelMaxTokens)
    : desired
}
