/**
 * Memory Reflection：记忆反思（shadow/write 双模式）
 *
 * 参考 ARCHITECTURE.md §22.9。用于验证记忆编译的质量：
 * - shadow 模式：编译记忆但不写入 FactStore，仅返回对比结果（检测事实丢失）
 * - write 模式：编译记忆并写入 FactStore（检测事实添加/幻觉）
 *
 * 质量评估指标：
 * - 新增事实数（newFacts）
 * - 更新事实数（updatedFacts）
 * - 冲突数（conflicts）
 * - 移除事实数（removedFacts，旧记忆有但新记忆没有）
 *
 * Issue 类型：
 * - fact_loss：高置信度旧事实在新记忆中消失
 * - hallucination：新事实无法在旧记忆或来源中找到依据
 * - contradiction：新事实与旧事实内容矛盾（相同标签但内容差异显著）
 * - stale：旧事实长时间未访问且未被新记忆引用
 */

import { randomUUID } from 'node:crypto'
import type { FactStore, Fact } from './fact-store.js'

/** 反思问题 */
export interface ReflectionIssue {
  type: 'fact_loss' | 'hallucination' | 'contradiction' | 'stale'
  description: string
  affectedSection: string
  severity: 'low' | 'medium' | 'high'
}

/** 反思质量评估指标 */
export interface ReflectionMetrics {
  /** 新增事实数 */
  newFacts: number
  /** 更新事实数 */
  updatedFacts: number
  /** 冲突数 */
  conflicts: number
  /** 移除事实数（旧记忆有但新记忆没有） */
  removedFacts: number
  /** 编译前事实总数 */
  totalBefore: number
  /** 编译后事实总数 */
  totalAfter: number
}

/** 反思结果 */
export interface ReflectionResult {
  mode: 'shadow' | 'write'
  quality: 'good' | 'degraded' | 'poor'
  issues: ReflectionIssue[]
  recommendation: 'accept' | 'rollback' | 'recompile'
  metrics: ReflectionMetrics
  /** write 模式下实际写入的事实 ID 列表；shadow 模式为空 */
  writtenFactIds: string[]
}

/** 候选事实（编译产出） */
export interface CandidateFact {
  /** 事实内容 */
  content: string
  /** 标签 */
  tags: string[]
  /** 来源（sessionId:turnIndex） */
  source: string
  /** 置信度 0-1 */
  confidence: number
  /** 可选：指定要更新的现有事实 ID。提供时视为更新，否则视为新增 */
  updateId?: string
}

/** 反思选项 */
export interface ReflectOptions {
  /** 模式：shadow 仅对比不写入，write 对比并写入 FactStore */
  mode: 'shadow' | 'write'
  /** 编译产出的候选事实 */
  candidateFacts: CandidateFact[]
  /**
   * shadow 模式下的测试问题列表。
   * 用于检测事实丢失：用旧记忆和新记忆分别回答，对比覆盖情况。
   * 若不提供，则使用全量对比策略。
   */
  testQuestions?: string[]
}

/** MemoryReflector 配置 */
export interface MemoryReflectorConfig {
  /** 判定事实矛盾的内容相似度阈值（0-1，越低越严格），默认 0.6 */
  contradictionThreshold: number
  /** 判定事实过期的最后访问时间阈值（毫秒），默认 7 天 */
  staleThresholdMs: number
  /** 触发 fact_loss 检测的最低旧事实置信度，默认 0.7 */
  factLossMinConfidence: number
}

const DEFAULT_CONFIG: MemoryReflectorConfig = {
  contradictionThreshold: 0.6,
  staleThresholdMs: 7 * 24 * 60 * 60 * 1000,
  factLossMinConfidence: 0.7,
}

/**
 * MemoryReflector：记忆反思器
 *
 * 使用方式：
 * ```typescript
 * const reflector = new MemoryReflector(factStore)
 * // shadow 模式：仅检测，不写入
 * const result = await reflector.reflect({ mode: 'shadow', candidateFacts })
 * // write 模式：检测并写入
 * const writeResult = await reflector.reflect({ mode: 'write', candidateFacts })
 * ```
 */
export class MemoryReflector {
  private readonly config: MemoryReflectorConfig

  constructor(
    private readonly factStore: FactStore,
    config?: Partial<MemoryReflectorConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 执行记忆反思
   *
   * shadow 模式：对比候选事实与现有 FactStore，返回质量评估，不写入
   * write 模式：对比后将新增/更新事实写入 FactStore，返回质量评估
   */
  async reflect(options: ReflectOptions): Promise<ReflectionResult> {
    const { mode, candidateFacts } = options

    // 1. 获取编译前的所有事实快照
    const beforeList = await this.factStore.listFacts()
    const beforeFacts = beforeList.facts
    const beforeIds = new Set(beforeFacts.map((f) => f.id))

    // 2. 分类候选事实：新增 vs 更新
    const toAdd: CandidateFact[] = []
    const toUpdate: Array<{ id: string; candidate: CandidateFact }> = []
    for (const candidate of candidateFacts) {
      if (candidate.updateId && beforeIds.has(candidate.updateId)) {
        toUpdate.push({ id: candidate.updateId, candidate })
      } else {
        toAdd.push(candidate)
      }
    }

    // 3. 检测问题
    const issues: ReflectionIssue[] = []

    // 3.1 检测事实丢失：高置信度旧事实在新记忆中消失
    const candidateContents = new Set(candidateFacts.map((c) => this.normalize(c.content)))
    const candidateTags = new Set(candidateFacts.flatMap((c) => c.tags))
    const updatedOrAddedContents = new Set(
      [...toAdd, ...toUpdate.map((u) => u.candidate)].map((c) => this.normalize(c.content)),
    )

    const removedFacts: Fact[] = []
    for (const oldFact of beforeFacts) {
      // 如果旧事实被更新（updateId 命中），不算丢失
      if (toUpdate.some((u) => u.id === oldFact.id)) continue
      // 如果旧事实内容在新记忆中存在（精确匹配），不算丢失
      if (updatedOrAddedContents.has(this.normalize(oldFact.content))) continue

      // 旧事实不在新记忆中 → 可能丢失
      removedFacts.push(oldFact)
      if (oldFact.confidence >= this.config.factLossMinConfidence) {
        issues.push({
          type: 'fact_loss',
          description: `高置信度事实在新记忆中消失："${this.truncate(oldFact.content, 60)}"`,
          affectedSection: oldFact.tags.join(',') || 'untagged',
          severity: oldFact.confidence >= 0.85 ? 'high' : 'medium',
        })
      }
    }

    // 3.2 检测幻觉：新事实无法在旧记忆中找到依据
    for (const candidate of toAdd) {
      const hasBasis = this.findSimilarFact(candidate, beforeFacts)
      if (!hasBasis && candidate.confidence < 0.5) {
        issues.push({
          type: 'hallucination',
          description: `低置信度新事实在旧记忆中无依据："${this.truncate(candidate.content, 60)}"`,
          affectedSection: candidate.tags.join(',') || 'untagged',
          severity: candidate.confidence < 0.3 ? 'high' : 'low',
        })
      }
    }

    // 3.3 检测矛盾：新事实与旧事实相同标签但内容差异显著
    let conflicts = 0
    for (const { id, candidate } of toUpdate) {
      const oldFact = beforeFacts.find((f) => f.id === id)
      if (!oldFact) continue
      const similarity = this.contentSimilarity(oldFact.content, candidate.content)
      if (similarity < this.config.contradictionThreshold) {
        conflicts++
        issues.push({
          type: 'contradiction',
          description: `更新的事实与旧事实内容矛盾（相似度 ${(similarity * 100).toFixed(0)}%）：` +
            `旧="${this.truncate(oldFact.content, 40)}" → 新="${this.truncate(candidate.content, 40)}"`,
          affectedSection: candidate.tags.join(',') || oldFact.tags.join(','),
          severity: similarity < 0.3 ? 'high' : 'medium',
        })
      }
    }

    // 3.4 检测过期：旧事实长时间未访问且未被新记忆引用
    const now = Date.now()
    for (const oldFact of beforeFacts) {
      if (candidateContents.has(this.normalize(oldFact.content))) continue
      if (toUpdate.some((u) => u.id === oldFact.id)) continue
      const lastAccessed = oldFact.lastAccessedAt || oldFact.createdAt
      if (now - lastAccessed > this.config.staleThresholdMs) {
        issues.push({
          type: 'stale',
          description: `事实已过期且未被新记忆引用："${this.truncate(oldFact.content, 60)}"`,
          affectedSection: oldFact.tags.join(',') || 'untagged',
          severity: 'low',
        })
      }
    }

    // 4. shadow 模式下的测试问题覆盖检测
    if (mode === 'shadow' && options.testQuestions && options.testQuestions.length > 0) {
      for (const question of options.testQuestions) {
        const oldHits = await this.factStore.searchByText(question)
        const newHits = this.searchInCandidates(question, candidateFacts)
        // 旧记忆能回答但新记忆不能 → 事实丢失
        if (oldHits.length > 0 && newHits.length === 0) {
          issues.push({
            type: 'fact_loss',
            description: `测试问题在新记忆中无匹配："${this.truncate(question, 60)}"（旧记忆命中 ${oldHits.length} 条）`,
            affectedSection: 'test_questions',
            severity: 'medium',
          })
        }
      }
    }

    // 5. 计算指标
    const totalAfter = beforeFacts.length - removedFacts.length + toAdd.length + toUpdate.length
    const metrics: ReflectionMetrics = {
      newFacts: toAdd.length,
      updatedFacts: toUpdate.length,
      conflicts,
      removedFacts: removedFacts.length,
      totalBefore: beforeFacts.length,
      totalAfter,
    }

    // 6. 评估质量
    const highIssues = issues.filter((i) => i.severity === 'high').length
    const mediumIssues = issues.filter((i) => i.severity === 'medium').length
    let quality: ReflectionResult['quality']
    if (highIssues > 0) {
      quality = 'poor'
    } else if (mediumIssues > 0 || conflicts > 0) {
      quality = 'degraded'
    } else {
      quality = 'good'
    }

    // 7. 推荐操作
    let recommendation: ReflectionResult['recommendation']
    if (quality === 'good') {
      recommendation = 'accept'
    } else if (quality === 'poor') {
      recommendation = 'rollback'
    } else {
      recommendation = 'recompile'
    }

    // 8. write 模式：实际写入 FactStore
    const writtenFactIds: string[] = []
    if (mode === 'write') {
      for (const candidate of toAdd) {
        const id = await this.factStore.addFact({
          content: candidate.content,
          tags: candidate.tags,
          source: candidate.source,
          confidence: candidate.confidence,
        })
        writtenFactIds.push(id)
      }
      for (const { id, candidate } of toUpdate) {
        await this.factStore.updateFact(id, {
          content: candidate.content,
          tags: candidate.tags,
          confidence: candidate.confidence,
        })
        writtenFactIds.push(id)
      }
    }

    return {
      mode,
      quality,
      issues,
      recommendation,
      metrics,
      writtenFactIds,
    }
  }

  /** 在候选事实中搜索关键词 */
  private searchInCandidates(query: string, candidates: CandidateFact[]): CandidateFact[] {
    const keywords = query.toLowerCase().split(/\s+/).filter((k) => k.length > 0)
    if (keywords.length === 0) return candidates
    return candidates.filter((c) => {
      const lower = c.content.toLowerCase()
      return keywords.some((kw) => lower.includes(kw))
    })
  }

  /** 查找候选事实在旧事实中是否有相似依据 */
  private findSimilarFact(candidate: CandidateFact, oldFacts: Fact[]): Fact | null {
    for (const old of oldFacts) {
      // 标签有交集
      const hasCommonTag = candidate.tags.some((t) => old.tags.includes(t))
      if (hasCommonTag && this.contentSimilarity(old.content, candidate.content) >= this.config.contradictionThreshold) {
        return old
      }
    }
    return null
  }

  /**
   * 计算两个字符串的内容相似度（0-1）
   * 使用基于词集的 Jaccard 相似度，简单高效
   */
  private contentSimilarity(a: string, b: string): number {
    const wordsA = new Set(this.normalize(a).split(/\s+/).filter((w) => w.length > 0))
    const wordsB = new Set(this.normalize(b).split(/\s+/).filter((w) => w.length > 0))
    if (wordsA.size === 0 && wordsB.size === 0) return 1
    if (wordsA.size === 0 || wordsB.size === 0) return 0

    let intersection = 0
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++
    }
    const union = wordsA.size + wordsB.size - intersection
    return union > 0 ? intersection / union : 0
  }

  /** 归一化文本：小写 + 去标点 */
  private normalize(text: string): string {
    return text.toLowerCase().replace(/[^\w\u4e00-\u9fa5\s]/g, ' ').replace(/\s+/g, ' ').trim()
  }

  /** 截断字符串 */
  private truncate(text: string, maxLen: number): string {
    return text.length > maxLen ? text.slice(0, maxLen) + '...' : text
  }
}

/**
 * 创建候选事实的便捷工厂函数
 * 用于在编译流水线中生成 CandidateFact
 */
export function createCandidateFact(
  content: string,
  options: {
    tags?: string[]
    source?: string
    confidence?: number
    updateId?: string
  } = {},
): CandidateFact {
  return {
    content,
    tags: options.tags ?? [],
    source: options.source ?? 'reflection',
    confidence: options.confidence ?? 0.5,
    ...(options.updateId !== undefined ? { updateId: options.updateId } : {}),
  }
}
