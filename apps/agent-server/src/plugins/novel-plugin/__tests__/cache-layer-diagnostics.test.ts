/**
 * 缓存分层命中诊断
 *
 * 这个诊断存在的理由是：分层设计（system → shared → identity → suffix + cache_control
 * 断点）从未被验证过，而实测有两个可疑信号 —— Writer 平均 cache_read 只有 6.1k
 * 而 shared 段本身 14.2k 字符；155 条有 token 的日志里 cache_write 全为 0。
 *
 * 用例重点覆盖两件容易做错的事：
 *   1. **不用魔法常数**：字符/token 比从同一条日志反解，不硬编码「中文 1.5 字/token」，
 *      否则结论完全依赖那个猜测。
 *   2. **首次调用必须排除**：本章第一次调用负责写入缓存，cache_read 天然低；
 *      把它算进平均会掩盖真正要看的「后续调用有没有复用上」。
 */
import { describe, it, expect } from 'vitest'
import {
  computeCacheablePrefixChars,
  measureCall,
  diagnoseChapterCache,
  buildCacheLayerReport,
  CACHE_COVERAGE_THRESHOLDS,
  type CacheDiagnosticLog,
} from '../core/analysis/cache-layer-diagnostics.js'

const SEP = '\n\n---\n\n'

function log(partial: Partial<CacheDiagnosticLog> = {}): CacheDiagnosticLog {
  return {
    agentType: 'director',
    chapterNumber: 1,
    systemPrompt: 'S'.repeat(1000),
    chapterContext: ['H'.repeat(2000), 'I'.repeat(500), 'X'.repeat(300)].join(SEP),
    userMessage: 'U'.repeat(200),
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    createdAt: 1000,
    status: 'success',
    ...partial,
  }
}

describe('computeCacheablePrefixChars：suffix 不计入可缓存前缀', () => {
  it('full 模式 = system + shared + identity，排除 suffix', () => {
    // suffix 位于最后一个缓存断点之后且每次实时构建，算进去会虚高期望值
    expect(computeCacheablePrefixChars(log())).toBe(1000 + 2000 + 500)
  })

  it('没有 suffix 段时同样正确', () => {
    const l = log({ chapterContext: ['H'.repeat(2000), 'I'.repeat(500)].join(SEP) })
    expect(computeCacheablePrefixChars(l)).toBe(1000 + 2000 + 500)
  })

  it('identity_only（盲审）模式：systemPrompt 为空，整段都是 identity', () => {
    const l = log({ systemPrompt: '', chapterContext: 'I'.repeat(400) })
    expect(computeCacheablePrefixChars(l)).toBe(400)
  })

  it('chapterContext 为空时只算 systemPrompt', () => {
    expect(computeCacheablePrefixChars(log({ chapterContext: '' }))).toBe(1000)
  })
})

describe('measureCall：字符/token 比由记录自身反解', () => {
  it('比值 = 总提示词字符 / inputTokens，不依赖外部常数', () => {
    // 总字符 = system 1000 + context(2000 + 7 + 500 + 7 + 300) + user 200 = 4014
    const l = log({ inputTokens: 2000 })
    const m = measureCall(l, 1)

    expect(m.totalPromptChars).toBe(4014)
    expect(m.charsPerToken).toBeCloseTo(4014 / 2000, 5)
    // 可缓存前缀 3500 字符 → 期望 3500 / 2.007 ≈ 1744 token
    expect(m.expectedCacheReadTokens).toBe(Math.round(3500 / (4014 / 2000)))
  })

  it('完整命中时覆盖率接近 1', () => {
    const l = log({ inputTokens: 2000 })
    const expected = measureCall(l, 1).expectedCacheReadTokens!
    const m = measureCall(log({ inputTokens: 2000, cacheReadTokens: expected }), 1)
    expect(m.coverage).toBeCloseTo(1, 5)
  })

  it('完全 miss 时覆盖率为 0', () => {
    expect(measureCall(log({ inputTokens: 2000, cacheReadTokens: 0 }), 1).coverage).toBe(0)
  })

  it('Provider 未上报 inputTokens 时不猜，返回 null', () => {
    const m = measureCall(log({ inputTokens: 0, cacheReadTokens: 500 }), 1)
    expect(m.charsPerToken).toBeNull()
    expect(m.expectedCacheReadTokens).toBeNull()
    expect(m.coverage).toBeNull()
  })
})

describe('diagnoseChapterCache：排除首次调用', () => {
  /** Director 写入缓存（read 低），Writer/Reviewer 应命中 */
  function chapterLogs(followUpCacheRead: number): CacheDiagnosticLog[] {
    return [
      log({ agentType: 'director', createdAt: 1000, inputTokens: 2000, cacheReadTokens: 100 }),
      log({ agentType: 'writer', createdAt: 2000, inputTokens: 2000, cacheReadTokens: followUpCacheRead }),
      log({ agentType: 'reviewer', createdAt: 3000, inputTokens: 2000, cacheReadTokens: followUpCacheRead }),
    ]
  }

  const expectedPrefixTokens = measureCall(log({ inputTokens: 2000 }), 1).expectedCacheReadTokens!

  it('后续 Agent 完整命中 → healthy，且 Director 的低 read 不拉低结论', () => {
    const d = diagnoseChapterCache(1, chapterLogs(expectedPrefixTokens))
    expect(d.verdict).toBe('healthy')
    expect(d.followUpCoverage).toBeCloseTo(1, 5)
    // 若把首次调用算进平均，覆盖率会被拉到 ~0.68，误判成 partial
    expect(d.calls[0]?.coverage).toBeLessThan(0.2)
  })

  it('只命中一小部分 → partial（典型症状：只命中 system，shared 没跨 Agent 复用）', () => {
    const d = diagnoseChapterCache(1, chapterLogs(Math.round(expectedPrefixTokens * 0.3)))
    expect(d.verdict).toBe('partial')
    expect(d.summary).toContain('shared')
  })

  it('后续完全没命中 → miss', () => {
    const d = diagnoseChapterCache(1, chapterLogs(0))
    expect(d.verdict).toBe('miss')
  })

  it('按 createdAt 排序，输入顺序不影响 order', () => {
    const logs = chapterLogs(expectedPrefixTokens).slice().reverse()
    const d = diagnoseChapterCache(1, logs)
    expect(d.calls.map((c) => c.agentType)).toEqual(['director', 'writer', 'reviewer'])
    expect(d.calls.map((c) => c.order)).toEqual([1, 2, 3])
  })

  it('排除失败调用：它们没走完请求，token 不可信', () => {
    const logs = [
      ...chapterLogs(expectedPrefixTokens),
      log({ agentType: 'writer', createdAt: 4000, status: 'error', inputTokens: 0 }),
    ]
    expect(diagnoseChapterCache(1, logs).calls).toHaveLength(3)
  })

  it('只有一次调用时明确说明无法判断跨 Agent 复用', () => {
    const d = diagnoseChapterCache(1, [log({ inputTokens: 2000, cacheReadTokens: 100 })])
    expect(d.verdict).toBe('no_data')
    expect(d.summary).toContain('只有一次调用')
  })

  it('无成功记录时不报错', () => {
    const d = diagnoseChapterCache(7, [log({ status: 'error' })])
    expect(d.verdict).toBe('no_data')
    expect(d.followUpCoverage).toBeNull()
  })

  it('Provider 全程不报 token → no_data，而不是误判成 miss', () => {
    const logs = [
      log({ agentType: 'director', createdAt: 1000, inputTokens: 0 }),
      log({ agentType: 'writer', createdAt: 2000, inputTokens: 0 }),
    ]
    const d = diagnoseChapterCache(1, logs)
    expect(d.verdict).toBe('no_data')
    expect(d.summary).toContain('未上报')
  })

  it('cache_write 全为 0 如实标记，不替 Provider 下结论', () => {
    // 两种解释都可能：Provider 不上报（无害）/ cache_control 未生效（严重）
    const d = diagnoseChapterCache(1, chapterLogs(expectedPrefixTokens))
    expect(d.allCacheWriteZero).toBe(true)
  })

  it('有 cache_write 时不标记', () => {
    const logs = chapterLogs(expectedPrefixTokens).map((l) => ({ ...l, cacheWriteTokens: 500 }))
    expect(diagnoseChapterCache(1, logs).allCacheWriteZero).toBe(false)
  })
})

describe('buildCacheLayerReport：跨章汇总', () => {
  const expectedPrefixTokens = measureCall(log({ inputTokens: 2000 }), 1).expectedCacheReadTokens!

  function chapter(chapterNumber: number, followUpCacheRead: number) {
    return diagnoseChapterCache(chapterNumber, [
      log({ chapterNumber, agentType: 'director', createdAt: 1000, inputTokens: 2000, cacheReadTokens: 100 }),
      log({ chapterNumber, agentType: 'writer', createdAt: 2000, inputTokens: 2000, cacheReadTokens: followUpCacheRead }),
    ])
  }

  it('汇总各章覆盖率', () => {
    const report = buildCacheLayerReport([
      chapter(1, expectedPrefixTokens),
      chapter(2, 0),
    ])
    expect(report.overallCoverage).toBeCloseTo(0.5, 2)
    expect(report.verdict).toBe('partial')
  })

  it('潜在节省只统计后续调用 —— 首次调用必须真实写入，没有可省部分', () => {
    const report = buildCacheLayerReport([chapter(1, 0)])
    expect(report.potentialSavedTokens).toBe(expectedPrefixTokens)
  })

  it('已完整命中时潜在节省为 0', () => {
    const report = buildCacheLayerReport([chapter(1, expectedPrefixTokens)])
    expect(report.potentialSavedTokens).toBe(0)
  })

  it('cache_write 全 0 时给出需人工确认的提示', () => {
    const report = buildCacheLayerReport([chapter(1, expectedPrefixTokens)])
    expect(report.notes.some((n) => n.includes('cache_write_tokens'))).toBe(true)
  })

  it('命中率偏低时提示优先检查 shared 段是否逐字稳定', () => {
    const report = buildCacheLayerReport([chapter(1, 0)])
    expect(report.notes.some((n) => n.includes('shared'))).toBe(true)
  })

  it('无可用数据时 verdict 为 no_data', () => {
    const report = buildCacheLayerReport([diagnoseChapterCache(1, [])])
    expect(report.verdict).toBe('no_data')
    expect(report.overallCoverage).toBeNull()
  })

  it('阈值单调：healthy 高于 partial', () => {
    expect(CACHE_COVERAGE_THRESHOLDS.healthy).toBeGreaterThan(CACHE_COVERAGE_THRESHOLDS.partial)
  })

  it('healthy 阈值留有余量 —— 分词边界与 identity 微小变动都会造成偏差', () => {
    expect(CACHE_COVERAGE_THRESHOLDS.healthy).toBeLessThan(1)
    expect(CACHE_COVERAGE_THRESHOLDS.healthy).toBeGreaterThanOrEqual(0.8)
  })
})

describe('实测场景复现：Writer cache_read 6.1k vs shared 14.2k 字符', () => {
  it('该组合应被判为未完整命中，而不是 healthy', () => {
    // 按实测均值构造：Writer input 18.9k token、cache_read 6.1k、
    // chapter_context 14241 字符（含 suffix）、system 约 8k 字符
    const director = log({
      agentType: 'director',
      createdAt: 1000,
      systemPrompt: 'S'.repeat(8000),
      chapterContext: ['H'.repeat(11000), 'I'.repeat(2000), 'X'.repeat(1241)].join(SEP),
      userMessage: 'U'.repeat(500),
      inputTokens: 10_700,
      cacheReadTokens: 800,
    })
    const writer = log({
      agentType: 'writer',
      createdAt: 2000,
      systemPrompt: 'S'.repeat(8000),
      chapterContext: ['H'.repeat(11000), 'I'.repeat(2000), 'X'.repeat(1241)].join(SEP),
      userMessage: 'U'.repeat(500),
      inputTokens: 18_900,
      cacheReadTokens: 6_100,
    })

    const d = diagnoseChapterCache(10, [director, writer])
    expect(d.verdict).not.toBe('healthy')
    expect(d.followUpCoverage).toBeLessThan(CACHE_COVERAGE_THRESHOLDS.healthy)
  })
})
