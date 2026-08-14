/**
 * 单章成本闸门
 *
 * 阈值直接来自真实项目 11 章的实测分布，用例按「正常章不该被打扰 / 失控章要尽早暴露」
 * 两端钉住。分错的代价不对称：
 *   - 阈值过低 → 正常创作反复弹框，用户学会无脑点「继续」，闸门失效
 *   - 阈值过高 → 第 10 章那种 126 万 token / 61 分钟仍然静默烧完
 */
import { describe, it, expect } from 'vitest'
import {
  createChapterBudgetUsage,
  recordLlmCall,
  evaluateChapterBudget,
  getChapterBudgetCategorySnapshot,
  recordChapterBudgetCategory,
  shouldPromptBudgetCheckpoint,
  DEFAULT_CHAPTER_BUDGET,
  tryRecordFullChapterRewrite,
  type ChapterBudgetUsage,
} from '../plugins/novel-plugin/core/chapters/chapter-budget.js'

const T0 = 1_700_000_000_000

function usageWith(partial: Partial<ChapterBudgetUsage>): ChapterBudgetUsage {
  return { ...createChapterBudgetUsage(T0), ...partial }
}

describe('recordLlmCall：累加', () => {
  it('逐次累加调用数与输入 token', () => {
    let usage = createChapterBudgetUsage(T0)
    usage = recordLlmCall(usage, 10_000)
    usage = recordLlmCall(usage, 8_000)

    expect(usage.llmCalls).toBe(2)
    expect(usage.inputTokens).toBe(18_000)
  })

  it('token 缺失按 0 计，不影响调用计数', () => {
    // 失败的调用往往拿不到 usage，但它确实烧了一次配额
    const usage = recordLlmCall(createChapterBudgetUsage(T0), 0)
    expect(usage.llmCalls).toBe(1)
    expect(usage.inputTokens).toBe(0)
  })

  it('脏数据（NaN / 负数）不污染累计值', () => {
    let usage = recordLlmCall(createChapterBudgetUsage(T0), Number.NaN)
    usage = recordLlmCall(usage, -500)
    expect(usage.inputTokens).toBe(0)
    expect(usage.llmCalls).toBe(2)
  })

  it('返回新对象，不原地改写', () => {
    const before = createChapterBudgetUsage(T0)
    const after = recordLlmCall(before, 100)
    expect(before.llmCalls).toBe(0)
    expect(after).not.toBe(before)
  })

  it('保留 acknowledged 标记，累加不会让提示重新弹出', () => {
    const usage = recordLlmCall(usageWith({ acknowledged: true }), 100)
    expect(usage.acknowledged).toBe(true)
  })
})

describe('evaluateChapterBudget：实测分布的两端', () => {
  it('正常章节不触发（第 6 章：4 次调用 / 7.9 万 token / 136 秒）', () => {
    const usage = usageWith({ llmCalls: 4, inputTokens: 79_446 })
    const result = evaluateChapterBudget(usage, DEFAULT_CHAPTER_BUDGET, T0 + 136_000)
    expect(result.exceeded).toBe(false)
    expect(result.dimension).toBeNull()
  })

  it('正常章节上界也不触发（第 1 章：21 次调用 / 6.1 万 token / 1248 秒）', () => {
    const usage = usageWith({ llmCalls: 21, inputTokens: 61_594 })
    expect(evaluateChapterBudget(usage, DEFAULT_CHAPTER_BUDGET, T0 + 1_248_000).exceeded).toBe(false)
  })

  it('第 10 章（73 次 / 126 万 token / 61 分钟）会触发', () => {
    const usage = usageWith({ llmCalls: 73, inputTokens: 1_257_979 })
    const result = evaluateChapterBudget(usage, DEFAULT_CHAPTER_BUDGET, T0 + 3_662_000)
    expect(result.exceeded).toBe(true)
  })

  it('第 9 章（60 次 / 46 万 token / 38 分钟）会触发', () => {
    const usage = usageWith({ llmCalls: 60, inputTokens: 460_952 })
    expect(evaluateChapterBudget(usage, DEFAULT_CHAPTER_BUDGET, T0 + 2_287_000).exceeded).toBe(true)
  })
})

describe('evaluateChapterBudget：单维度判定', () => {
  it('仅调用数超限', () => {
    const result = evaluateChapterBudget(usageWith({ llmCalls: 30 }), DEFAULT_CHAPTER_BUDGET, T0)
    expect(result.dimension).toBe('llmCalls')
    expect(result.message).toContain('30 次')
  })

  it('仅 token 超限', () => {
    const result = evaluateChapterBudget(
      usageWith({ llmCalls: 5, inputTokens: DEFAULT_CHAPTER_BUDGET.maxInputTokens }),
      DEFAULT_CHAPTER_BUDGET,
      T0,
    )
    expect(result.dimension).toBe('inputTokens')
    expect(result.message).toContain('万')
  })

  it('仅耗时超限', () => {
    const result = evaluateChapterBudget(
      usageWith({ llmCalls: 5, inputTokens: 1000 }),
      DEFAULT_CHAPTER_BUDGET,
      T0 + 25 * 60_000,
    )
    expect(result.dimension).toBe('wallClock')
    expect(result.message).toContain('分钟')
  })

  it('多维度同时超限时报调用数 —— 它比耗时更有行动价值', () => {
    const result = evaluateChapterBudget(
      usageWith({ llmCalls: 73, inputTokens: 1_257_979 }),
      DEFAULT_CHAPTER_BUDGET,
      T0 + 3_662_000,
    )
    expect(result.dimension).toBe('llmCalls')
  })

  it('恰好等于上限即触发（边界含等号）', () => {
    expect(evaluateChapterBudget(usageWith({ llmCalls: 30 }), DEFAULT_CHAPTER_BUDGET, T0).exceeded).toBe(true)
    expect(evaluateChapterBudget(usageWith({ llmCalls: 29 }), DEFAULT_CHAPTER_BUDGET, T0).exceeded).toBe(false)
  })

  it('时钟回拨不产生负耗时', () => {
    const result = evaluateChapterBudget(usageWith({}), DEFAULT_CHAPTER_BUDGET, T0 - 60_000)
    expect(result.snapshot.elapsedMs).toBe(0)
    expect(result.exceeded).toBe(false)
  })

  it('snapshot 同时给出当前值与上限，供检查点展示', () => {
    const result = evaluateChapterBudget(
      usageWith({ llmCalls: 31, inputTokens: 123 }),
      DEFAULT_CHAPTER_BUDGET,
      T0 + 1000,
    )
    expect(result.snapshot).toEqual({
      llmCalls: 31,
      maxLlmCalls: DEFAULT_CHAPTER_BUDGET.maxLlmCalls,
      inputTokens: 123,
      maxInputTokens: DEFAULT_CHAPTER_BUDGET.maxInputTokens,
      elapsedMs: 1000,
      maxWallClockMs: DEFAULT_CHAPTER_BUDGET.maxWallClockMs,
      categories: {
        fullChapterRewrites: 0,
        maxFullChapterRewrites: 1,
        fullChapterRewriteAvailable: true,
        guardWriterRewrites: 0,
        reviserRuns: 0,
        reviewerRuns: 0,
      },
    })
  })

  it('自定义上限生效', () => {
    const result = evaluateChapterBudget(
      usageWith({ llmCalls: 3 }),
      { maxLlmCalls: 3, maxInputTokens: 1e9, maxWallClockMs: 1e9, maxFullChapterRewrites: 1 },
      T0,
    )
    expect(result.exceeded).toBe(true)
  })
})

describe('分类预算', () => {
  it('默认允许一次整章重写，第二次拒绝', () => {
    const first = tryRecordFullChapterRewrite(createChapterBudgetUsage(T0))
    expect(first.allowed).toBe(true)
    expect(first.usage.fullChapterRewrites).toBe(1)

    const second = tryRecordFullChapterRewrite(first.usage)
    expect(second.allowed).toBe(false)
    expect(second.usage).toBe(first.usage)
  })

  it('分别累加 Guard Writer 重写、Reviser 和 Reviewer 运行次数', () => {
    let usage = createChapterBudgetUsage(T0)
    usage = recordChapterBudgetCategory(usage, 'guardWriterRewrites')
    usage = recordChapterBudgetCategory(usage, 'reviserRuns')
    usage = recordChapterBudgetCategory(usage, 'reviewerRuns')
    usage = recordChapterBudgetCategory(usage, 'reviewerRuns')

    expect(getChapterBudgetCategorySnapshot(usage)).toMatchObject({
      fullChapterRewrites: 0,
      fullChapterRewriteAvailable: true,
      guardWriterRewrites: 1,
      reviserRuns: 1,
      reviewerRuns: 2,
    })
  })

  it('整章重写耗尽后快照明确标记不可用', () => {
    const first = tryRecordFullChapterRewrite(createChapterBudgetUsage(T0))
    expect(getChapterBudgetCategorySnapshot(first.usage)).toMatchObject({
      fullChapterRewrites: 1,
      maxFullChapterRewrites: 1,
      fullChapterRewriteAvailable: false,
    })
  })
})

describe('shouldPromptBudgetCheckpoint：同一章只问一次', () => {
  it('超限且未确认 → 提示', () => {
    expect(shouldPromptBudgetCheckpoint(usageWith({ llmCalls: 30 }), DEFAULT_CHAPTER_BUDGET, T0)).toBe(true)
  })

  it('已确认后不再提示，即使继续超限', () => {
    // 用户选了继续，不该在后续每次 Agent 调用前反复弹同一个框
    const usage = usageWith({ llmCalls: 90, inputTokens: 2_000_000, acknowledged: true })
    expect(shouldPromptBudgetCheckpoint(usage, DEFAULT_CHAPTER_BUDGET, T0 + 1e7)).toBe(false)
  })

  it('未超限不提示', () => {
    expect(shouldPromptBudgetCheckpoint(usageWith({ llmCalls: 2 }), DEFAULT_CHAPTER_BUDGET, T0)).toBe(false)
  })
})

describe('DEFAULT_CHAPTER_BUDGET 的不变量', () => {
  it('阈值落在正常章上界（21 次 / 8 万 token / 21 分钟）与失控章下界（44 次 / 46 万 / 35 分钟）之间', () => {
    expect(DEFAULT_CHAPTER_BUDGET.maxLlmCalls).toBeGreaterThan(22)
    expect(DEFAULT_CHAPTER_BUDGET.maxLlmCalls).toBeLessThan(44)
    expect(DEFAULT_CHAPTER_BUDGET.maxWallClockMs).toBeGreaterThan(21 * 60_000)
    expect(DEFAULT_CHAPTER_BUDGET.maxWallClockMs).toBeLessThan(35 * 60_000)
  })

  it('token 上限高于任何正常章（最高 13 万），低于失控章（最低 46 万）', () => {
    expect(DEFAULT_CHAPTER_BUDGET.maxInputTokens).toBeGreaterThan(133_763)
    expect(DEFAULT_CHAPTER_BUDGET.maxInputTokens).toBeLessThanOrEqual(460_952)
  })
})
