import { describe, it, expect } from 'vitest'
import {
  resolveWordBudget,
  baseTargetOf,
  resolveWriterMaxTokens,
  type WordBudgetResolution,
} from '../core/chapters/word-budget-resolver.js'

describe('resolveWordBudget 字数唯一解析', () => {
  it('3000 + 无定位 → resolved 3000 / min 2550 / max 3450', () => {
    const r = resolveWordBudget({ baseTarget: 3000 })
    expect(r.resolvedTarget).toBe(3000)
    expect(r.min).toBe(2550)
    expect(r.max).toBe(3450)
    expect(r.adjustmentPct).toBe(0)
    expect(r.adjustedOnce).toBe(false)
  })

  it('定位 +10% → resolved 3300，min/max 围绕 3300 对称', () => {
    const r = resolveWordBudget({ baseTarget: 3000, adjustmentPct: 0.1 })
    expect(r.resolvedTarget).toBe(3300)
    expect(r.min).toBe(Math.round(3300 * 0.85))
    expect(r.max).toBe(Math.round(3300 * 1.15))
    expect(r.adjustedOnce).toBe(true)
  })

  it('调整 30% 被 clamp 到 +15%', () => {
    const r = resolveWordBudget({ baseTarget: 3000, adjustmentPct: 0.3 })
    expect(r.adjustmentPct).toBe(0.15)
    expect(r.resolvedTarget).toBe(Math.round(3000 * 1.15))
  })

  it('负向调整超出下限也被 clamp', () => {
    const r = resolveWordBudget({ baseTarget: 3000, adjustmentPct: -0.5 })
    expect(r.adjustmentPct).toBe(-0.15)
    expect(r.resolvedTarget).toBe(Math.round(3000 * 0.85))
  })

  it('同输入幂等（两次调用结果逐字段相等）', () => {
    const a = resolveWordBudget({ baseTarget: 3000, adjustmentPct: 0.1 })
    const b = resolveWordBudget({ baseTarget: 3000, adjustmentPct: 0.1 })
    expect(a).toEqual(b)
  })

  it('缺省 adjustmentPct 与显式 0 结果一致', () => {
    const a = resolveWordBudget({ baseTarget: 3000 })
    const b = resolveWordBudget({ baseTarget: 3000, adjustmentPct: 0 })
    expect(a).toEqual(b)
  })

  it('baseTargetOf：>0 取 round，否则 3000', () => {
    expect(baseTargetOf(3000)).toBe(3000)
    expect(baseTargetOf(2500.6)).toBe(2501)
    expect(baseTargetOf(0)).toBe(3000)
    expect(baseTargetOf(undefined)).toBe(3000)
    expect(baseTargetOf(-5)).toBe(3000)
  })

  it('resolvedTarget 公式与文档一致：round(baseTarget*(1+adjustmentPct))', () => {
    const r: WordBudgetResolution = resolveWordBudget({ baseTarget: 4100, adjustmentPct: -0.15 })
    expect(r.resolvedTarget).toBe(Math.round(4100 * 0.85))
  })
})

describe('resolveWriterMaxTokens：Writer 物理兜底不能拧到误伤合规稿件', () => {
  /** 与实现同源的口径：ceil(maxWords × 1.1) + （推理模型再 +1200） */
  const expectTokens = (maxWords: number, reasoning = true): number =>
    Math.ceil(maxWords * 1.1) + (reasoning ? 1200 : 0)

  it('硬上限 3900 字 → 字数保守换算 + thinking 预留，明显高于旧的 3900 直传', () => {
    // 旧实现直接把 3900（字）当 token 传：中文 3000 字已约 2000-3000 token，
    // 推理模型 thinking 块共享同一配额，很容易顶到 stopReason='length'，
    // 被 pi SDK 的 isRecoverableLength 判成可恢复截断 → 白烧一轮 compact+retry。
    const tokens = resolveWriterMaxTokens({ maxWords: 3900 })
    expect(tokens).toBe(expectTokens(3900))
    expect(tokens).toBeGreaterThan(3900)
  })

  it('物理闸只防无限膨胀，不贴着硬上限：余量控制在硬上限的 1.5 倍以内', () => {
    // thinking 预留从 4000 收到 1200 的意图：4000 等于把闸整体抬到 2 倍字数，
    // 闸门形同虚设（实测首稿 4740 字仍畅通）。这条守住"别再放大"。
    expect(resolveWriterMaxTokens({ maxWords: 3900 })).toBeLessThan(3900 * 1.5)
  })

  it('模型自身 maxTokens 更小时按模型上限夹紧（不发出模型不接受的值）', () => {
    expect(resolveWriterMaxTokens({ maxWords: 3900, modelMaxTokens: 4096 })).toBe(4096)
  })

  it('模型 maxTokens 足够大时不夹紧', () => {
    expect(resolveWriterMaxTokens({ maxWords: 3900, modelMaxTokens: 64000 })).toBe(
      expectTokens(3900),
    )
  })

  it('非推理模型不预留 thinking 配额', () => {
    expect(resolveWriterMaxTokens({ maxWords: 3900, reasoning: false })).toBe(
      expectTokens(3900, false),
    )
  })

  it('modelMaxTokens 缺失/为 0 时不夹紧（视为未知）', () => {
    expect(resolveWriterMaxTokens({ maxWords: 2600, modelMaxTokens: 0 })).toBe(expectTokens(2600))
    expect(resolveWriterMaxTokens({ maxWords: 2600 })).toBe(expectTokens(2600))
  })
})
