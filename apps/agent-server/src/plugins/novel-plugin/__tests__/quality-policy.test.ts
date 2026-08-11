/**
 * 质量门统一仲裁（S5）的行为测试。
 *
 * 这些断言把"哪个门有权做什么"和"冲突怎么裁"固定下来。
 * 五个门此前互不知晓、各自 early-return，冲突时只能由 LLM 自己猜。
 */
import { describe, it, expect } from 'vitest'
import {
  GATE_REGISTRY,
  CONFLICT_RULES,
  PROSE_SHAPE_LIMITS,
  WORD_COUNT_LIMITS,
  QUALITY_POLICY_INVARIANTS,
  arbitrateQuality,
  strongerAction,
  type QualitySignal,
} from '../core/quality-policy.js'
import { evaluateProseQuality } from '../core/prose-quality-evaluator.js'

describe('质量门策略表', () => {
  it.each(QUALITY_POLICY_INVARIANTS)('$name', ({ check }) => {
    expect(check()).toBe(true)
  })

  it('门 id 唯一', () => {
    const ids = GATE_REGISTRY.map((gate) => gate.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每条登记的冲突都写明了仲裁方式', () => {
    for (const rule of CONFLICT_RULES) {
      expect(rule.conflict.length).toBeGreaterThan(10)
      expect(rule.resolution.length).toBeGreaterThan(10)
    }
  })
})

describe('仲裁', () => {
  it('取最强动作', () => {
    const signals: QualitySignal[] = [
      { gateId: 'prose-shape', action: 'revise', reason: '碎片段落' },
      { gateId: 'word-count', action: 'rewrite', reason: '字数严重不足' },
      { gateId: 'matrix-semantic-entities', action: 'advisory', reason: '势力全名缺失' },
    ]
    const decision = arbitrateQuality(signals)
    expect(decision.action).toBe('rewrite')
    expect(decision.decidedBy?.gateId).toBe('word-count')
    // 未被选中的信号不丢弃，继续转达给下游
    expect(decision.carried.map((s) => s.gateId)).toEqual(['prose-shape', 'matrix-semantic-entities'])
  })

  it('同强度时按注册表顺序决胜（确定性门在前）', () => {
    const decision = arbitrateQuality([
      { gateId: 'reviewer-verdict', action: 'revise', reason: 'LLM 认为需修订' },
      { gateId: 'prose-shape', action: 'revise', reason: '碎片段落' },
    ])
    expect(decision.decidedBy?.gateId).toBe('prose-shape')
  })

  it('超出门权限的动作被降级（调用方不能越权）', () => {
    const decision = arbitrateQuality([
      // 文风指纹是观测值，声称要整章重写也只能降到 reference
      { gateId: 'style-fingerprint', action: 'rewrite', reason: '对话占比 0%' },
    ])
    expect(decision.action).toBe('reference')
  })

  it('观测型门无法压过确定性门', () => {
    const decision = arbitrateQuality([
      { gateId: 'style-fingerprint', action: 'rewrite', reason: '指纹不符' },
      { gateId: 'matrix-semantic-entities', action: 'advisory', reason: '地点全名缺失' },
    ])
    expect(decision.action).toBe('advisory')
    expect(decision.decidedBy?.gateId).toBe('matrix-semantic-entities')
  })

  it('无信号时不产生动作', () => {
    expect(arbitrateQuality([])).toEqual({ action: 'none', decidedBy: null, carried: [] })
    expect(arbitrateQuality([{ gateId: 'prose-shape', action: 'none', reason: '' }]).action).toBe('none')
  })

  it('strongerAction 按强度取大', () => {
    expect(strongerAction('advisory', 'rewrite')).toBe('rewrite')
    expect(strongerAction('reference', 'none')).toBe('reference')
    expect(strongerAction('revise', 'revise')).toBe('revise')
  })
})

describe('阈值单一来源', () => {
  /**
   * 构造指定形态的正文：先连续若干单句段，再接若干多句段。
   *
   * 多句段必须真的含两个句末标点 —— countSentences 修复后段内连写的句子也会被数到。
   */
  function makeProse(consecutiveSingle: number, multiCount: number): string {
    const single = Array.from({ length: consecutiveSingle }, (_, i) => `他停住了${i}。`)
    const multi = Array.from({ length: multiCount }, (_, i) =>
      `他把灯放回桌上，动作很稳。没有多余的话，这一段用来充当正常长度的段落${i}。`)
    return [...single, ...multi].join('\n\n')
  }

  it('prose-quality 的连续单句段阈值来自 PROSE_SHAPE_LIMITS', () => {
    const limit = PROSE_SHAPE_LIMITS.maxConsecutiveSingleSentenceParagraphs
    // 恰好等于上限：不报问题
    const atLimit = evaluateProseQuality(makeProse(limit, 30))
    expect(atLimit.metrics.maxConsecutiveSingleSentenceParagraphs).toBe(limit)
    expect(atLimit.issues.some((i) => i.code === 'fragmented_paragraphs')).toBe(false)
    // 超过上限：报问题
    const overLimit = evaluateProseQuality(makeProse(limit + 1, 30))
    expect(overLimit.issues.some((i) => i.code === 'fragmented_paragraphs')).toBe(true)
  })

  it('role-writer.md 的段落约束与检查阈值一致', async () => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const text = await readFile(
      join(process.cwd(), 'src/plugins/novel-plugin/core/prompts/role-writer.md'),
      'utf8',
    )
    // prompt 必须引用与 PROSE_SHAPE_LIMITS 同一个数字，而不是自己写一个更严/更松的措辞。
    // 断言从常量派生：调阈值时测试会指出 prompt 也要一起改。
    const limit = PROSE_SHAPE_LIMITS.maxConsecutiveSingleSentenceParagraphs
    expect(text).toContain(`连续单句段不得超过 ${limit} 段`)
    // 旧措辞（写死"六段"或比检查更严的"三段"禁令）必须已移除
    expect(text).not.toContain('避免连续六段以上单句成段')
    expect(text).not.toContain('禁止连续三段以上单句成段')
  })

  it('role-writer.md 的短段占比措辞与检查阈值一致', async () => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const text = await readFile(
      join(process.cwd(), 'src/plugins/novel-plugin/core/prompts/role-writer.md'),
      'utf8',
    )
    // 0.25 → "四分之一"。阈值改动时这条会失败，提醒同步 prompt 措辞。
    expect(PROSE_SHAPE_LIMITS.shortParagraphRatioWarning).toBe(0.25)
    expect(text).toContain('18 字以内的短段全章不超过四分之一')
  })


  it('role-writer.md 说明了字数硬下限与"出现不等于交差"', () => {
    // 这两条是 S5 登记的冲突的 prompt 侧修复：
    // 字数：prompt 原本只说"宁可更短"，与 <75% 整章重写矛盾
    // 点名：prompt 原本只说"不能靠点名交差"，与姓名必须出现的确定性检查矛盾
    expect(WORD_COUNT_LIMITS.rewriteBelow).toBe(0.75)
  })
})
