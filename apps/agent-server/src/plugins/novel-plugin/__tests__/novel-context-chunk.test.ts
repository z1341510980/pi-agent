/**
 * T03-1 Context Chunk 契约测试。
 *
 * 守护：
 * 1. CHUNK_CATALOG 结构合法性（id 唯一、priority/mode/layer 枚举合法、sizeTier 合法）；
 * 2. 目录 builderMethod 锚点与 prompt-builder.ts 真实方法对应（防止 T03-2 改方法名导致目录漂移）；
 * 3. contextChunksEnabled flag 默认关闭（回滚安全：关 = 完全旧字符串路径）。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHUNK_CATALOG, CHUNK_BY_ID, ROLE_CONTEXT_POLICIES, resolveChunkMode } from '../core/prompting/context-chunk.js'
import { NOVEL_FEATURE_FLAGS } from '../core/domain/novel-feature-flags.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const promptBuilderSource = fs.readFileSync(
  path.join(__dirname, '../core/prompt-builder.ts'),
  'utf8',
)

describe('Context Chunk 契约（T03-1）', () => {
  it('目录结构合法：id 唯一、枚举合法', () => {
    const ids = CHUNK_CATALOG.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length) // id 唯一
    const priorities = new Set(['required', 'recommended', 'optional'])
    const modes = new Set(['full', 'summary', 'on-demand', 'disabled'])
    const layers = new Set(['semi-shared', 'semi-suffix'])
    const tiers = new Set(['s', 'm', 'l'])
    for (const c of CHUNK_CATALOG) {
      expect(priorities.has(c.priority)).toBe(true)
      expect(modes.has(c.defaultMode)).toBe(true)
      expect(layers.has(c.layer)).toBe(true)
      expect(tiers.has(c.sizeTier)).toBe(true)
    }
    expect(CHUNK_BY_ID.size).toBe(ids.length)
  })

  it('目录覆盖 shared 层全部真实 section（builderMethod 锚点与源码对应）', () => {
    // 目录中所有 semi-shared chunk 的构建方法必须在 prompt-builder.ts 真实存在
    for (const c of CHUNK_CATALOG) {
      if (c.layer !== 'semi-shared') continue
      // 方法名可能是 private（如 formatPreviousChapterEnding）或模块级函数（formatVoiceContrastTable）
      const methodExists = promptBuilderSource.includes(c.builderMethod)
      expect(methodExists, `builderMethod ${c.builderMethod} 在 prompt-builder.ts 中不存在`).toBe(true)
    }
  })

  it('目录包含 §5.2 建议的共享层核心 chunk', () => {
    for (const id of ['chapter-info', 'story-ledger', 'arranged-entities', 'info-layers', 'recent-recaps', 'style-fingerprint']) {
      expect(CHUNK_BY_ID.has(id), `缺少 chunk ${id}`).toBe(true)
    }
  })

  it('ContextChunk 为唯一 shared 组装路径（2026-08-12 逻辑统一）', () => {
    // contextChunksEnabled flag 已转正移除（chunk 恒走，无旧字符串路径回退）
    expect(NOVEL_FEATURE_FLAGS).not.toContain('contextChunksEnabled')
    // 剩余 flag 中 contextSummaryMode / crossChapterChunkCache 是 V2 内功能/性能开关
    expect(NOVEL_FEATURE_FLAGS).toContain('contextSummaryMode')
    expect(NOVEL_FEATURE_FLAGS).toContain('crossChapterChunkCache')
    expect(NOVEL_FEATURE_FLAGS).toHaveLength(3)
  })
})

describe('角色 Chunk Policy（T03-3）', () => {
  it('策略覆盖全部 5 个 Agent，每策略 ≥2 项且 chunkId 都在目录中', () => {
    for (const agent of ['director', 'writer', 'reviewer', 'reviser', 'memory']) {
      const policy = ROLE_CONTEXT_POLICIES[agent]
      expect(policy, `${agent} 无策略`).toBeDefined()
      expect(policy.length, `${agent} 策略过少`).toBeGreaterThanOrEqual(2)
      for (const p of policy) {
        expect(CHUNK_BY_ID.has(p.chunkId), `${agent} 策略引用了不存在的 chunk ${p.chunkId}`).toBe(true)
      }
    }
  })

  it('每 Agent 策略内无重复 chunkId，且覆盖该角色的核心 chunk', () => {
    for (const agent of ['director', 'writer', 'reviewer', 'reviser', 'memory']) {
      const ids = ROLE_CONTEXT_POLICIES[agent].map((p) => p.chunkId)
      expect(new Set(ids).size, `${agent} 策略含重复 chunkId`).toBe(ids.length)
    }
    // 各角色核心 chunk 覆盖（方案 §5.3 语义映射到真实目录）
    const writerIds = ROLE_CONTEXT_POLICIES.writer.map((p) => p.chunkId)
    expect(writerIds).toContain('arranged-entities')
    expect(writerIds).toContain('writer-instruction')
    const reviewerIds = ROLE_CONTEXT_POLICIES.reviewer.map((p) => p.chunkId)
    expect(reviewerIds).toContain('reviewer-rubric')
    const directorIds = ROLE_CONTEXT_POLICIES.director.map((p) => p.chunkId)
    expect(directorIds).toContain('director-scheme')
  })

  it('resolveChunkMode：策略 full 生效；策略 summary 兜底 full（T03-4 前）；未列入走目录默认', () => {
    // 策略 full
    expect(resolveChunkMode('writer', 'arranged-entities')).toBe('full')
    // 策略 summary → 兜底 full（摘要能力未落地）
    expect(resolveChunkMode('writer', 'story-ledger')).toBe('full')
    expect(resolveChunkMode('director', 'story-ledger')).toBe('full')
    // 未列入策略 → 目录默认（不丢信息）
    expect(resolveChunkMode('writer', 'hooks')).toBe('full') // hooks 目录默认 full
    expect(resolveChunkMode('reviewer', 'style-fingerprint')).toBe('summary') // 目录默认 summary
    // 未知 chunk → disabled（目录外）
    expect(resolveChunkMode('writer', 'no-such-chunk')).toBe('disabled')
    // 未知角色 → 目录默认
    expect(resolveChunkMode('unknown-agent', 'chapter-info')).toBe('full')
  })
})
