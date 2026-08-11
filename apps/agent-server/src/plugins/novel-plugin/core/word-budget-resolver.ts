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
