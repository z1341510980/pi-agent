/**
 * scene-word-check：单场字数核验（scene-wise-writing T3）。
 *
 * 背景：单次整章调用 + 模型自我计数被实测证伪两次（4740/3000=158%、
 * 4657/3000=155%，且第二次 Writer prompt 里已带结构化逐场预算）。
 * 模型对"写到 900 字停笔"没有可靠执行力——字数纪律必须是系统侧的确定性核验。
 *
 * 协议（spec「目标行为」第 4 条）：
 * - 在本场有效预算 ±20% 内 → accept
 * - 超出 20% → compress（就地压缩重写该场，最多 1 次；重试后仍超 → accept，
 *   超出量从后续场次预算扣除）
 * - 低于 50% → expand（判该场残稿，扩写该场，最多 1 次）
 *
 * 结转账本（carry）：正数 = 前场超支需从后续场扣除；负数 = 前场欠缺补给后续场。
 * 逐场滚动后全章总字数向目标收敛，不再依赖整章事后压缩。
 */

/** 单场预算下限：结转扣减不给任何一场清零（模型无从执行 0 字契约） */
export const MIN_SCENE_BUDGET = 200

/** 压缩阈值：超出有效预算的比例（spec：±20% 内接受） */
const COMPRESS_OVER_RATIO = 1.2

/** 残稿阈值：低于有效预算的比例（spec：低于 50% 判残稿） */
const REWRITE_UNDER_RATIO = 0.5

/** 每场的就地重试上限（压缩或重写各算一次机会） */
export const MAX_SCENE_RETRIES = 1

export type SceneWordVerdict = 'accept' | 'compress' | 'expand'

/**
 * 核验本场字数。
 *
 * @param targetWords  本场有效预算（已含结转调整）
 * @param actualWords  本场实际字数（去空白计数）
 * @param retriesUsed  本场已用掉的就地重试次数
 */
export function checkSceneWords(
  targetWords: number,
  actualWords: number,
  retriesUsed: number,
): SceneWordVerdict {
  if (retriesUsed >= MAX_SCENE_RETRIES) return 'accept'
  if (targetWords > 0 && actualWords < targetWords * REWRITE_UNDER_RATIO) return 'expand'
  if (actualWords > targetWords * COMPRESS_OVER_RATIO) return 'compress'
  return 'accept'
}

/**
 * 把累计结转应用到本场预算。
 *
 * carry 为正（前场超支）时扣减本场预算，扣到 MIN_SCENE_BUDGET 为止，
 * 未消化完的部分结转给后续场；carry 为负（前场欠缺）时增补本场预算，
 * 全额消化（增补不受下限约束）。
 *
 * @returns `{ effective, carry }`：effective = 本场有效预算；
 *   carry = 未消化的剩余结转（调用方在结转本场偏差前先置为此值）。
 */
export function applySceneCarry(
  targetWords: number,
  carry: number,
  minBudget: number = MIN_SCENE_BUDGET,
): { effective: number; carry: number } {
  const effective = Math.max(minBudget, targetWords - carry)
  return { effective, carry: carry - (targetWords - effective) }
}

/**
 * 本场最终结转偏差：正 = 超出（后续场扣减），负 = 欠缺（后续场增补）。
 * 与 verdict 无关——accepted 的轻微超出同样计入，保证全章总量收敛。
 */
export function sceneDeviation(actualWords: number, effectiveBudget: number): number {
  return actualWords - effectiveBudget
}

/** 去空白字数统计（与 PostWriteGuard 同口径） */
export function countSceneWords(text: string): number {
  return text.replace(/\s/g, '').length
}
