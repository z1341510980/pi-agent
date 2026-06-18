import { describe, expect, it } from 'vitest'
import { calculateCost, COST_RATES } from '../core/usage/cost-rates.js'

describe('COST_RATES', () => {
  it('包含已知模型的价格', () => {
    expect(COST_RATES['deepseek-chat']).toBeDefined()
    expect(COST_RATES['deepseek-reasoner']).toBeDefined()
    expect(COST_RATES['claude-sonnet-4-20250514']).toBeDefined()
    expect(COST_RATES['claude-3-5-haiku-20241022']).toBeDefined()
    expect(COST_RATES['gpt-4o']).toBeDefined()
    expect(COST_RATES['gpt-4o-mini']).toBeDefined()
  })

  it('每个模型包含 inputPer1M 和 outputPer1M', () => {
    for (const [model, rate] of Object.entries(COST_RATES)) {
      expect(rate.inputPer1M).toBeGreaterThan(0)
      expect(rate.outputPer1M).toBeGreaterThan(0)
    }
  })
})

describe('calculateCost', () => {
  it('已知模型计算输入+输出成本', () => {
    // deepseek-chat: inputPer1M=0.27, outputPer1M=1.10
    const cost = calculateCost({
      model: 'deepseek-chat',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })
    expect(cost).toBeCloseTo(0.27 + 1.10, 6)
  })

  it('未知模型返回 0 成本', () => {
    const cost = calculateCost({
      model: 'unknown-model',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })
    expect(cost).toBe(0)
  })

  it('包含缓存读取 token 计算', () => {
    // deepseek-chat: cacheReadPer1M=0.07
    const cost = calculateCost({
      model: 'deepseek-chat',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    })
    expect(cost).toBeCloseTo(0.27 + 0.07, 6)
  })

  it('包含缓存写入 token 计算', () => {
    // deepseek-chat: cacheWritePer1M=0.27
    const cost = calculateCost({
      model: 'deepseek-chat',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheWriteTokens: 1_000_000,
    })
    expect(cost).toBeCloseTo(0.27 + 0.27, 6)
  })

  it('同时包含缓存读取和写入', () => {
    // claude-sonnet-4: inputPer1M=3, outputPer1M=15, cacheReadPer1M=0.3, cacheWritePer1M=3.75
    const cost = calculateCost({
      model: 'claude-sonnet-4-20250514',
      inputTokens: 500_000,
      outputTokens: 200_000,
      cacheReadTokens: 300_000,
      cacheWriteTokens: 100_000,
    })
    const expected =
      (500_000 / 1_000_000) * 3 +
      (200_000 / 1_000_000) * 15 +
      (300_000 / 1_000_000) * 0.3 +
      (100_000 / 1_000_000) * 3.75
    expect(cost).toBeCloseTo(expected, 6)
  })

  it('模型无缓存价格时缓存 token 不计入', () => {
    // gpt-4o: cacheReadPer1M=1.25, 无 cacheWritePer1M
    const cost = calculateCost({
      model: 'gpt-4o',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheWriteTokens: 1_000_000,
    })
    // cacheWritePer1M 未定义，cacheWriteTokens 不计入
    expect(cost).toBeCloseTo(2.5, 6)
  })

  it('零 token 返回 0 成本', () => {
    const cost = calculateCost({
      model: 'deepseek-chat',
      inputTokens: 0,
      outputTokens: 0,
    })
    expect(cost).toBe(0)
  })
})
