/**
 * p3-context-report：P3 灰度看板聚合（T03-8 收官）
 *
 * 聚合 T03-1~7 的可观测性为单份报告：
 * - baseline：现状 shared（flag 关）的字符/token（P3 验收对照基线）；
 * - chunks：chunk 明细（id/标题/优先级/默认模式/字符/token/层级）；
 * - rolePolicies：各 Agent 的 chunk 策略（T03-3）；
 * - degradation：给定预算下的降级模拟（T03-7：步骤/节省/是否 fit/是否阻止）；
 * - identity：身份 token（T03-6）。
 *
 * 用途：无需触发完整创作流即可审计 P3 降级链路，供灰度验收（
 * "shared token 中位数降 ≥25%" 的对照数据源）。
 *
 * ⚠️ 数据真实性：narrativeTask 从 store 读该章章纲、constraints 由 NovelEngine
 * 真实构建（与 orchestrator 生产路径同源）。早期版本用空约束占位，会让
 * chapter-constraints chunk 恒为空、baseline 显著偏小——那样的基线拿来验收没有意义。
 */
import type { NovelPromptBuilder } from './prompt-builder.js'
import { CHUNK_BY_ID, CHUNK_CATALOG, ROLE_CONTEXT_POLICIES } from './context-chunk.js'
import { degradeChunks, estimateChunkTokens } from './context-budget.js'
import { countIdentityChars } from './identity-contract.js'
import type { NovelStore } from './novel-store.js'
import type { NovelEngine } from './novel-engine.js'

export interface P3ChunkEntry {
  chunkId: string
  title: string
  priority: string
  defaultMode: string
  layer: string
  charCount: number
  tokens: number
}

export interface P3ContextReport {
  projectId: string
  chapterNumber: number
  agentType?: string
  /** 基线（flag 关 = 现状，P3 验收对照） */
  baseline: {
    sharedChars: number
    sharedTokens: number
    chunkCount: number
  }
  /** chunk 明细（降级前） */
  chunks: P3ChunkEntry[]
  /** 各 Agent chunk 策略（T03-3） */
  rolePolicies: Array<{ agentType: string; policy: Array<{ chunkId: string; mode: string }> }>
  /** 降级模拟（T03-7，传 budgetTokens 时返回） */
  degradation?: {
    budgetTokens: number
    tokensBefore: number
    tokensAfter: number
    savedTokens: number
    savedPercent: number
    appliedSteps: string[]
    fits: boolean
  }
  /** 身份 token（T03-6，传 agentType 时返回） */
  identity?: {
    agentType: string
    chars: number
    tokens: number
  }
  /** P4 灰度对照：角色组装后的 shared（flag 开实际效果）与 baseline 的 token 差 */
  roleAssembly?: {
    agentType: string
    chars: number
    tokens: number
    savedTokens: number
    savedPercent: number
  }
  /** 目录完整清单（含未注入的，供看板展示全量） */
  catalog: Array<{ chunkId: string; title: string; priority: string; defaultMode: string }>
}

export function buildP3ContextReport(
  promptBuilder: NovelPromptBuilder,
  store: NovelStore,
  engine: NovelEngine,
  projectId: string,
  chapterNumber: number,
  options?: { agentType?: string; budgetTokens?: number },
): P3ContextReport {
  // 与 orchestrator 生产路径同源：章纲来自 store，约束由 engine 真实构建。
  const chapter = store.getChapter(projectId, chapterNumber)
  const narrativeTask = {
    description: chapter?.narrativeTask?.trim() || `第 ${chapterNumber} 章创作`,
    type: 'advance_mainline',
    targetEntity: null,
    priority: 'medium',
  }
  const constraints = engine.buildChapterConstraints(projectId, chapterNumber)

  const chunks = promptBuilder.buildChapterContextChunks(
    projectId,
    chapterNumber,
    narrativeTask as never,
    constraints,
  )
  // 基线：现状 shared 字符串（flag 关路径）
  const shared = promptBuilder.buildChapterContextShared(
    projectId,
    chapterNumber,
    narrativeTask as never,
    constraints,
  )

  const report: P3ContextReport = {
    projectId,
    chapterNumber,
    agentType: options?.agentType,
    baseline: {
      sharedChars: shared.length,
      sharedTokens: estimateChunkTokens(shared.length),
      chunkCount: chunks.length,
    },
    chunks: chunks.map((c) => {
      const meta = CHUNK_BY_ID.get(c.chunkId)
      return {
        chunkId: c.chunkId,
        title: meta?.title ?? c.chunkId,
        priority: meta?.priority ?? 'unknown',
        defaultMode: meta?.defaultMode ?? 'full',
        layer: meta?.layer ?? 'semi-shared',
        charCount: c.content.length,
        tokens: estimateChunkTokens(c.content.length),
      }
    }),
    rolePolicies: Object.entries(ROLE_CONTEXT_POLICIES).map(([agentType, policy]) => ({
      agentType,
      policy: policy.map((p) => ({ chunkId: p.chunkId, mode: p.mode })),
    })),
    catalog: CHUNK_CATALOG.map((c) => ({
      chunkId: c.id,
      title: c.title,
      priority: c.priority,
      defaultMode: c.defaultMode,
    })),
  }

  if (options?.budgetTokens !== undefined) {
    const d = degradeChunks(chunks, options.budgetTokens)
    report.degradation = {
      budgetTokens: options.budgetTokens,
      tokensBefore: d.tokensBefore,
      tokensAfter: d.tokensAfter,
      savedTokens: d.tokensBefore - d.tokensAfter,
      savedPercent: d.tokensBefore > 0 ? Math.round(((d.tokensBefore - d.tokensAfter) / d.tokensBefore) * 100) : 0,
      appliedSteps: d.appliedSteps,
      fits: d.fits,
    }
  }

  if (options?.agentType) {
    const identity = promptBuilder.buildAgentIdentity(projectId, options.agentType)
    const chars = countIdentityChars(identity)
    report.identity = { agentType: options.agentType, chars, tokens: estimateChunkTokens(chars) }

    // P4 灰度对照：角色组装后的 shared（T03-3 disabled 过滤实际效果）
    const forAgent = promptBuilder.buildChapterContextSharedForAgent(
      projectId, chapterNumber, narrativeTask as never, constraints, undefined,
      { askStoryEnabled: true, agentType: options.agentType },
    )
    const tokens = estimateChunkTokens(forAgent.length)
    const baselineTokens = report.baseline.sharedTokens
    report.roleAssembly = {
      agentType: options.agentType,
      chars: forAgent.length,
      tokens,
      savedTokens: Math.max(0, baselineTokens - tokens),
      savedPercent: baselineTokens > 0 ? Math.round(((baselineTokens - tokens) / baselineTokens) * 100) : 0,
    }
  }

  return report
}
