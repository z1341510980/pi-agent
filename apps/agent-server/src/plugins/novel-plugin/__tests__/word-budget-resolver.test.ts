import { describe, it, expect } from 'vitest'
import {
  resolveWordBudget,
  baseTargetOf,
  type WordBudgetResolution,
} from '../core/word-budget-resolver.js'

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
