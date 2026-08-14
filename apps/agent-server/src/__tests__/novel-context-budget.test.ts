/**
 * T03-7 Token 预算与降级测试。
 *
 * 守护方案 §5.5：
 * 1. allocateContextBudget 计算正确（减去三项预留）；
 * 2. 预算充足时零降级（chunks 原样、无步骤、fits=true）；
 * 3. 超限时按降级顺序逐级执行（optional 删除 → recommended 标 summary → ...）；
 * 4. required chunk 永不移除（不可降级保护）；
 * 5. 五级跑完仍超限 → fits=false（阻止生成）。
 */
import { describe, expect, it } from 'vitest'
import {
  allocateContextBudget,
  degradeChunks,
  estimateChunkTokens,
  materializeDegradedChunks,
} from '../plugins/novel-plugin/core/prompting/context-budget.js'
import type { DegradableChunk } from '../plugins/novel-plugin/core/prompting/context-budget.js'

/** 构造 chunks：可选大小，覆盖 required/recommended/optional 三类 */
function makeChunks(): DegradableChunk[] {
  return [
    { chunkId: 'chapter-info', content: 'a'.repeat(100) },          // required
    { chunkId: 'story-ledger', content: 'b'.repeat(200) },          // required
    { chunkId: 'recent-recaps', content: 'c'.repeat(150) },         // recommended
    { chunkId: 'style-fingerprint', content: 'd'.repeat(100) },     // optional
    { chunkId: 'sound-anchor', content: 'e'.repeat(60) },           // optional
  ]
}

describe('allocateContextBudget（§5.5）', () => {
  it('减去动态任务/工具 schema/输出三项预留', () => {
    expect(allocateContextBudget({
      maxInputTokens: 10000,
      reservedForDynamicTask: 1000,
      reservedForToolSchemas: 1500,
      reservedForOutput: 2500,
    })).toBe(5000)
  })
})

describe('estimateChunkTokens', () => {
  it('按 1.5 字符/token 估算（中文保守上界）', () => {
    expect(estimateChunkTokens(150)).toBe(100)
    expect(estimateChunkTokens(1)).toBe(1)
  })
})

describe('degradeChunks（§5.5 降级顺序）', () => {
  it('预算充足：零降级、原样返回、fits=true', () => {
    const chunks = makeChunks()
    const r = degradeChunks(chunks, 10000)
    expect(r.fits).toBe(true)
    expect(r.appliedSteps).toHaveLength(0)
    expect(r.chunks).toHaveLength(chunks.length)
    expect(r.tokensBefore).toBe(r.tokensAfter)
  })

  it('第一步：删除 optional chunk（required/recommended 保留）', () => {
    const chunks = makeChunks()
    // 总 token = (100+200+150+100+60)/1.5 ≈ 407；预算只够 required+recommended
    const r = degradeChunks(chunks, estimateChunkTokens(100 + 200 + 150) + 1)
    expect(r.fits).toBe(true)
    expect(r.appliedSteps).toContain('delete-optional')
    const ids = r.chunks.map((c) => c.chunkId)
    expect(ids).not.toContain('style-fingerprint')
    expect(ids).not.toContain('sound-anchor')
    expect(ids).toContain('chapter-info')
    expect(ids).toContain('story-ledger')
  })

  it('recommended chunk 标 summaryMode（不删除）', () => {
    const chunks = makeChunks()
    const r = degradeChunks(chunks, estimateChunkTokens(100 + 200) + 1)
    expect(r.appliedSteps).toContain('recommended-full-to-summary')
    const recaps = r.chunks.find((c) => c.chunkId === 'recent-recaps')
    expect(recaps?.summaryMode).toBe(true)
    // required 不受影响
    expect(r.chunks.find((c) => c.chunkId === 'chapter-info')?.summaryMode).toBeUndefined()
  })

  it('required chunk 永不移除（不可降级保护）', () => {
    const chunks = makeChunks()
    // 极低预算 → 五级全跑仍超限
    const r = degradeChunks(chunks, 10)
    const ids = r.chunks.map((c) => c.chunkId)
    expect(ids).toContain('chapter-info') // required 保留
    expect(ids).toContain('story-ledger') // required 保留
    expect(r.fits).toBe(false) // 阻止生成
    expect(r.appliedSteps.length).toBeGreaterThan(0)
  })

  it('五级跑完仍超限 → fits=false（阻止生成）', () => {
    const chunks = makeChunks()
    const r = degradeChunks(chunks, 30)
    expect(r.fits).toBe(false)
    expect(r.tokensAfter).toBeGreaterThan(30)
  })
})

describe('materializeDegradedChunks（生产物化）', () => {
  it('summaryMode 使用调用方提供的真实摘要', () => {
    const out = materializeDegradedChunks([
      { chunkId: 'recent-recaps', content: 'x'.repeat(300), summaryMode: true, summaryContent: '真实摘要' },
    ])
    expect(out).toEqual([{ chunkId: 'recent-recaps', content: '真实摘要' }])
  })

  it('summaryMode 无 summaryContent 时按前 30% 确定性兜底', () => {
    const out = materializeDegradedChunks([
      { chunkId: 'recent-recaps', content: 'a'.repeat(100), summaryMode: true },
    ])
    expect(out[0].content.length).toBeLessThan(100)
    expect(out[0].content).toContain('novel_ask_story')
  })

  it('keepOne 保留最近一章 recap；无标记原样透传', () => {
    const out = materializeDegradedChunks([
      { chunkId: 'recent-recaps', content: '【第1章】…\n\n---\n\n【第2章】…', keepOne: true, keepOneContent: '【第2章】…' },
      { chunkId: 'chapter-info', content: '章节信息' },
    ])
    expect(out).toEqual([
      { chunkId: 'recent-recaps', content: '【第2章】…' },
      { chunkId: 'chapter-info', content: '章节信息' },
    ])
  })

  it('空 content 的 chunk 被过滤（避免输出空 section）', () => {
    const out = materializeDegradedChunks([
      { chunkId: 'story-ledger', content: '' },
      { chunkId: 'chapter-info', content: 'x' },
    ])
    expect(out).toEqual([{ chunkId: 'chapter-info', content: 'x' }])
  })
})
