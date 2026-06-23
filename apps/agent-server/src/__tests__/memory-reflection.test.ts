import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { FactStore } from '../core/memory/fact-store.js'
import { MemoryReflector } from '../core/memory/memory-reflection.js'
import type { CandidateFact } from '../core/memory/memory-reflection.js'

let tempDir: string
let factStore: FactStore
let reflector: MemoryReflector

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'pi-reflection-test-'))
  factStore = new FactStore(tempDir)
  reflector = new MemoryReflector(factStore)
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('MemoryReflector — shadow 模式', () => {
  it('shadow 模式不写入 FactStore', async () => {
    const candidates: CandidateFact[] = [
      { content: '用户偏好暗色主题', tags: ['preference'], source: 's1:0', confidence: 0.9 },
    ]

    const result = await reflector.reflect({ mode: 'shadow', candidateFacts: candidates })

    expect(result.mode).toBe('shadow')
    expect(result.writtenFactIds).toEqual([])
    // FactStore 中不应有事实
    const all = await factStore.listFacts()
    expect(all.total).toBe(0)
  })

  it('shadow 模式检测新增事实', async () => {
    const candidates: CandidateFact[] = [
      { content: '用户偏好暗色主题', tags: ['preference'], source: 's1:0', confidence: 0.9 },
      { content: '项目使用 TypeScript', tags: ['decision'], source: 's1:1', confidence: 0.8 },
    ]

    const result = await reflector.reflect({ mode: 'shadow', candidateFacts: candidates })

    expect(result.metrics.newFacts).toBe(2)
    expect(result.metrics.updatedFacts).toBe(0)
    expect(result.metrics.totalBefore).toBe(0)
    expect(result.metrics.totalAfter).toBe(2)
  })

  it('shadow 模式检测事实丢失（高置信度旧事实消失）', async () => {
    // 预置旧事实
    await factStore.addFact({
      content: '用户偏好暗色主题',
      tags: ['preference'],
      source: 's1:0',
      confidence: 0.9,
    })

    // 候选事实不包含旧的高置信度事实
    const candidates: CandidateFact[] = [
      { content: '项目使用 TypeScript', tags: ['decision'], source: 's1:1', confidence: 0.8 },
    ]

    const result = await reflector.reflect({ mode: 'shadow', candidateFacts: candidates })

    expect(result.metrics.removedFacts).toBe(1)
    const factLossIssues = result.issues.filter((i) => i.type === 'fact_loss')
    expect(factLossIssues.length).toBeGreaterThan(0)
    expect(factLossIssues[0].severity).toBe('high') // confidence 0.9 >= 0.85
  })

  it('shadow 模式使用测试问题检测事实丢失', async () => {
    // 预置旧事实
    await factStore.addFact({
      content: '部署环境为 AWS',
      tags: ['infra'],
      source: 's1:0',
      confidence: 0.8,
    })

    // 候选事实不包含 AWS 相关内容
    const candidates: CandidateFact[] = [
      { content: '项目使用 TypeScript', tags: ['decision'], source: 's1:1', confidence: 0.8 },
    ]

    const result = await reflector.reflect({
      mode: 'shadow',
      candidateFacts: candidates,
      testQuestions: ['部署环境'],
    })

    // 旧记忆能回答（命中 AWS），新记忆不能 → fact_loss
    const testFactLoss = result.issues.find(
      (i) => i.type === 'fact_loss' && i.affectedSection === 'test_questions',
    )
    expect(testFactLoss).toBeDefined()
    expect(testFactLoss!.description).toContain('部署环境')
  })

  it('shadow 模式检测矛盾（更新事实内容差异显著）', async () => {
    // 预置旧事实
    const oldId = await factStore.addFact({
      content: '项目使用 JavaScript',
      tags: ['decision', 'tech'],
      source: 's1:0',
      confidence: 0.8,
    })

    // 候选事实更新为完全不同的内容
    const candidates: CandidateFact[] = [
      {
        content: '部署环境为 Google Cloud Platform',
        tags: ['decision', 'tech'],
        source: 's1:1',
        confidence: 0.8,
        updateId: oldId,
      },
    ]

    const result = await reflector.reflect({ mode: 'shadow', candidateFacts: candidates })

    expect(result.metrics.conflicts).toBe(1)
    const contradictionIssues = result.issues.filter((i) => i.type === 'contradiction')
    expect(contradictionIssues.length).toBe(1)
  })

  it('shadow 模式检测幻觉（低置信度新事实无依据）', async () => {
    const candidates: CandidateFact[] = [
      {
        content: '某个完全 unrelated 的低置信度事实',
        tags: ['unknown'],
        source: 's1:0',
        confidence: 0.2,
      },
    ]

    const result = await reflector.reflect({ mode: 'shadow', candidateFacts: candidates })

    const hallucinationIssues = result.issues.filter((i) => i.type === 'hallucination')
    expect(hallucinationIssues.length).toBe(1)
    expect(hallucinationIssues[0].severity).toBe('high') // confidence < 0.3
  })

  it('质量评估为 good 时推荐 accept', async () => {
    // 预置旧事实
    await factStore.addFact({
      content: '用户偏好暗色主题',
      tags: ['preference'],
      source: 's1:0',
      confidence: 0.9,
    })

    // 候选事实包含旧事实内容（无丢失）+ 高置信度新事实（无幻觉）
    const candidates: CandidateFact[] = [
      { content: '用户偏好暗色主题', tags: ['preference'], source: 's1:0', confidence: 0.9 },
      { content: '项目使用 TypeScript', tags: ['decision'], source: 's1:1', confidence: 0.8 },
    ]

    const result = await reflector.reflect({ mode: 'shadow', candidateFacts: candidates })

    expect(result.quality).toBe('good')
    expect(result.recommendation).toBe('accept')
  })

  it('质量评估为 poor 时推荐 rollback', async () => {
    // 预置高置信度旧事实
    await factStore.addFact({
      content: '用户偏好暗色主题',
      tags: ['preference'],
      source: 's1:0',
      confidence: 0.95,
    })

    // 候选事实完全不含旧事实 → fact_loss (high)
    const candidates: CandidateFact[] = [
      { content: '项目使用 TypeScript', tags: ['decision'], source: 's1:1', confidence: 0.8 },
    ]

    const result = await reflector.reflect({ mode: 'shadow', candidateFacts: candidates })

    expect(result.quality).toBe('poor')
    expect(result.recommendation).toBe('rollback')
  })

  it('质量评估为 degraded 时推荐 recompile', async () => {
    // 预置中等置信度旧事实（0.7-0.85 之间，severity 为 medium）
    await factStore.addFact({
      content: '用户偏好暗色主题',
      tags: ['preference'],
      source: 's1:0',
      confidence: 0.75,
    })

    // 候选事实不含旧事实 → fact_loss (medium)
    const candidates: CandidateFact[] = [
      { content: '项目使用 TypeScript', tags: ['decision'], source: 's1:1', confidence: 0.8 },
    ]

    const result = await reflector.reflect({ mode: 'shadow', candidateFacts: candidates })

    expect(result.quality).toBe('degraded')
    expect(result.recommendation).toBe('recompile')
  })
})

describe('MemoryReflector — write 模式', () => {
  it('write 模式将新增事实写入 FactStore', async () => {
    const candidates: CandidateFact[] = [
      { content: '用户偏好暗色主题', tags: ['preference'], source: 's1:0', confidence: 0.9 },
      { content: '项目使用 TypeScript', tags: ['decision'], source: 's1:1', confidence: 0.8 },
    ]

    const result = await reflector.reflect({ mode: 'write', candidateFacts: candidates })

    expect(result.mode).toBe('write')
    expect(result.writtenFactIds).toHaveLength(2)
    // FactStore 中应有 2 条事实
    const all = await factStore.listFacts()
    expect(all.total).toBe(2)
  })

  it('write 模式更新已有事实', async () => {
    const oldId = await factStore.addFact({
      content: '用户偏好暗色主题',
      tags: ['preference'],
      source: 's1:0',
      confidence: 0.8,
    })

    const candidates: CandidateFact[] = [
      {
        content: '用户偏好暗色主题和等宽字体',
        tags: ['preference', 'ui'],
        source: 's1:1',
        confidence: 0.9,
        updateId: oldId,
      },
    ]

    const result = await reflector.reflect({ mode: 'write', candidateFacts: candidates })

    expect(result.writtenFactIds).toHaveLength(1)
    expect(result.writtenFactIds[0]).toBe(oldId)
    expect(result.metrics.updatedFacts).toBe(1)
    expect(result.metrics.newFacts).toBe(0)

    // 验证事实已更新
    const updated = await factStore.getFact(oldId)
    expect(updated!.content).toBe('用户偏好暗色主题和等宽字体')
    expect(updated!.tags).toEqual(['preference', 'ui'])
    expect(updated!.confidence).toBe(0.9)
  })

  it('write 模式同时新增和更新事实', async () => {
    const oldId = await factStore.addFact({
      content: '旧事实',
      tags: ['old'],
      source: 's1:0',
      confidence: 0.5,
    })

    const candidates: CandidateFact[] = [
      {
        content: '更新后的旧事实',
        tags: ['old', 'updated'],
        source: 's1:1',
        confidence: 0.8,
        updateId: oldId,
      },
      { content: '全新事实', tags: ['new'], source: 's1:2', confidence: 0.9 },
    ]

    const result = await reflector.reflect({ mode: 'write', candidateFacts: candidates })

    expect(result.writtenFactIds).toHaveLength(2)
    expect(result.metrics.updatedFacts).toBe(1)
    expect(result.metrics.newFacts).toBe(1)

    const all = await factStore.listFacts()
    expect(all.total).toBe(2)
  })

  it('write 模式下 updateId 不存在时视为新增', async () => {
    const candidates: CandidateFact[] = [
      {
        content: '新事实',
        tags: ['new'],
        source: 's1:0',
        confidence: 0.8,
        updateId: 'nonexistent-id',
      },
    ]

    const result = await reflector.reflect({ mode: 'write', candidateFacts: candidates })

    // updateId 不存在 → 作为新增处理
    expect(result.metrics.newFacts).toBe(1)
    expect(result.metrics.updatedFacts).toBe(0)
    expect(result.writtenFactIds).toHaveLength(1)
  })
})

describe('MemoryReflector — 指标计算', () => {
  it('正确计算 totalBefore 和 totalAfter', async () => {
    // 预置 3 条旧事实
    for (let i = 0; i < 3; i++) {
      await factStore.addFact({
        content: `旧事实${i}`,
        tags: ['old'],
        source: `s1:${i}`,
        confidence: 0.5,
      })
    }

    const candidates: CandidateFact[] = [
      { content: '新事实1', tags: ['new'], source: 's2:0', confidence: 0.8 },
      { content: '新事实2', tags: ['new'], source: 's2:1', confidence: 0.8 },
    ]

    const result = await reflector.reflect({ mode: 'shadow', candidateFacts: candidates })

    expect(result.metrics.totalBefore).toBe(3)
    // 3 旧事实全部不在新记忆中（removedFacts=3）+ 2 新增 = 2
    expect(result.metrics.removedFacts).toBe(3)
    expect(result.metrics.totalAfter).toBe(2)
  })

  it('无候选事实时返回空指标', async () => {
    const result = await reflector.reflect({ mode: 'shadow', candidateFacts: [] })

    expect(result.metrics.newFacts).toBe(0)
    expect(result.metrics.updatedFacts).toBe(0)
    expect(result.metrics.conflicts).toBe(0)
    expect(result.metrics.removedFacts).toBe(0)
    expect(result.quality).toBe('good')
    expect(result.recommendation).toBe('accept')
  })
})

describe('MemoryReflector — 配置', () => {
  it('自定义矛盾阈值', async () => {
    const oldId = await factStore.addFact({
      content: '项目使用 JavaScript',
      tags: ['tech'],
      source: 's1:0',
      confidence: 0.8,
    })

    // 内容有一定相似度（共享"项目使用"）
    const candidates: CandidateFact[] = [
      {
        content: '项目使用 TypeScript',
        tags: ['tech'],
        source: 's1:1',
        confidence: 0.8,
        updateId: oldId,
      },
    ]

    // 默认阈值 0.6，"项目使用 JavaScript" vs "项目使用 TypeScript" 的 Jaccard 相似度
    // 词集：{项目使用, javascript} vs {项目使用, typescript} → 交集 1，并集 3 → 0.33
    // 0.33 < 0.6 → 矛盾
    const strictReflector = new MemoryReflector(factStore, { contradictionThreshold: 0.6 })
    const result = await strictReflector.reflect({ mode: 'shadow', candidateFacts: candidates })
    expect(result.metrics.conflicts).toBe(1)

    // 宽松阈值 0.2，0.33 > 0.2 → 不算矛盾
    const looseReflector = new MemoryReflector(factStore, { contradictionThreshold: 0.2 })
    const looseResult = await looseReflector.reflect({ mode: 'shadow', candidateFacts: candidates })
    expect(looseResult.metrics.conflicts).toBe(0)
  })

  it('自定义 factLoss 最低置信度', async () => {
    // 置信度 0.6 的旧事实
    await factStore.addFact({
      content: '低置信度旧事实',
      tags: ['old'],
      source: 's1:0',
      confidence: 0.6,
    })

    const candidates: CandidateFact[] = [
      { content: '完全不同的新事实', tags: ['new'], source: 's1:1', confidence: 0.8 },
    ]

    // 默认 factLossMinConfidence=0.7，0.6 < 0.7 → 不报 fact_loss
    const defaultResult = await reflector.reflect({ mode: 'shadow', candidateFacts: candidates })
    const defaultFactLoss = defaultResult.issues.filter((i) => i.type === 'fact_loss')
    expect(defaultFactLoss).toHaveLength(0)

    // 自定义 factLossMinConfidence=0.5，0.6 >= 0.5 → 报 fact_loss
    const strictReflector = new MemoryReflector(factStore, { factLossMinConfidence: 0.5 })
    const strictResult = await strictReflector.reflect({ mode: 'shadow', candidateFacts: candidates })
    const strictFactLoss = strictResult.issues.filter((i) => i.type === 'fact_loss')
    expect(strictFactLoss.length).toBeGreaterThan(0)
  })
})
