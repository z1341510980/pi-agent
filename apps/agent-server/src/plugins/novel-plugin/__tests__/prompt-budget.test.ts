/**
 * 提示词预算表的结构性约束。
 *
 * 这些断言存在的理由是一个真实事故：角色的「性格」预算是 120 字，
 * 比「此刻状态」的 160 字还低，而性格是多角色同场时唯一的区分来源 ——
 * 预算散落在各 format 方法里时，没人能发现这种失配。
 *
 * 集中成表之后，用断言把分配原则固定下来：改预算可以，破坏原则不行。
 */
import { describe, it, expect } from 'vitest'
import {
  CHARACTER_CARD_BUDGET,
  CHAPTER_ANCHOR_BUDGET,
  FINGERPRINT_TRUST,
  LEDGER_BUDGET,
  PROMPT_BUDGET_INVARIANTS,
  RELATION_BUDGET,
  STORY_STATE_LIMIT,
  SYSTEM_BUDGET,
} from '../core/prompting/prompt-budget.js'

describe('提示词预算表', () => {
  it.each(PROMPT_BUDGET_INVARIANTS)('$name', ({ check }) => {
    expect(check()).toBe(true)
  })

  it('所有预算为正整数（负数或小数会让 slice 行为不可预期）', () => {
    const tables = {
      SYSTEM_BUDGET,
      CHARACTER_CARD_BUDGET,
      STORY_STATE_LIMIT,
      RELATION_BUDGET,
      LEDGER_BUDGET,
      CHAPTER_ANCHOR_BUDGET,
      FINGERPRINT_TRUST,
    }
    for (const [tableName, table] of Object.entries(tables)) {
      for (const [key, value] of Object.entries(table)) {
        expect(Number.isInteger(value), `${tableName}.${key} = ${value}`).toBe(true)
        expect(value, `${tableName}.${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('角色短卡里区分度字段的预算高于状态字段', () => {
    const distinguishing = [CHARACTER_CARD_BUDGET.personality, CHARACTER_CARD_BUDGET.speechStyle]
    const situational = [
      CHARACTER_CARD_BUDGET.currentState,
      CHARACTER_CARD_BUDGET.currentGoal,
      CHARACTER_CARD_BUDGET.currentPressure,
      CHARACTER_CARD_BUDGET.identity,
    ]
    expect(Math.min(...distinguishing)).toBeGreaterThanOrEqual(Math.max(...situational))
  })
})
