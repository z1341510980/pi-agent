/**
 * Provider 价格表 & 成本计算
 *
 * 维护已知模型的每百万 token 价格，提供 calculateCost 函数计算单次调用成本。
 */

export interface ModelCostRate {
  /** 输入每百万 token 成本（USD） */
  inputPer1M: number
  /** 输出每百万 token 成本（USD） */
  outputPer1M: number
  /** 缓存读取每百万 token 成本 */
  cacheReadPer1M?: number
  /** 缓存写入每百万 token 成本 */
  cacheWritePer1M?: number
}

/** 已知模型的价格表 */
export const COST_RATES: Record<string, ModelCostRate> = {
  'deepseek-chat': {
    inputPer1M: 0.27,
    outputPer1M: 1.10,
    cacheReadPer1M: 0.07,
    cacheWritePer1M: 0.27,
  },
  'deepseek-reasoner': {
    inputPer1M: 0.55,
    outputPer1M: 2.19,
    cacheReadPer1M: 0.14,
    cacheWritePer1M: 0.55,
  },
  'claude-sonnet-4-20250514': {
    inputPer1M: 3.00,
    outputPer1M: 15.00,
    cacheReadPer1M: 0.30,
    cacheWritePer1M: 3.75,
  },
  'claude-3-5-haiku-20241022': {
    inputPer1M: 0.80,
    outputPer1M: 4.00,
    cacheReadPer1M: 0.08,
    cacheWritePer1M: 1.00,
  },
  'gpt-4o': {
    inputPer1M: 2.50,
    outputPer1M: 10.00,
    cacheReadPer1M: 1.25,
  },
  'gpt-4o-mini': {
    inputPer1M: 0.15,
    outputPer1M: 0.60,
    cacheReadPer1M: 0.075,
  },
}

/** 计算单次调用成本（USD），四舍五入到微美分精度 */
export function calculateCost(params: {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}): number {
  const rate = COST_RATES[params.model]
  if (!rate) {
    console.warn(`[calculateCost] 未知模型 "${params.model}"，成本将被记录为 0，请更新价格表`)
    return 0
  }

  const inputCost = (params.inputTokens / 1_000_000) * rate.inputPer1M
  const outputCost = (params.outputTokens / 1_000_000) * rate.outputPer1M
  const cacheReadCost = params.cacheReadTokens && rate.cacheReadPer1M
    ? (params.cacheReadTokens / 1_000_000) * rate.cacheReadPer1M
    : 0
  const cacheWriteCost = params.cacheWriteTokens && rate.cacheWritePer1M
    ? (params.cacheWriteTokens / 1_000_000) * rate.cacheWritePer1M
    : 0

  // 四舍五入到 8 位小数（微美分精度），避免浮点漂移
  return Math.round((inputCost + outputCost + cacheReadCost + cacheWriteCost) * 1e8) / 1e8
}
