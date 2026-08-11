/**
 * context-budget：Token 预算与降级（P3 T03-7）
 *
 * 方案 §5.5：
 * - allocateContextBudget：从 maxInputTokens 减去动态任务/工具 schema/输出的预留；
 * - 降级顺序（预算不足时逐级执行，直到 fit 或阻止生成）：
 *   1. 删除 optional Chunk
 *   2. recommended Chunk 从 full 降 summary
 *   3. arranged-entities 从 full 降 summary
 *   4. recent-recaps 只保留最近 1 章
 *   5. style-fingerprint 降 on-demand（T03-5 后由 ask_story 按需补齐）
 *   6. 仍超限 → 阻止生成并展示明细
 * - 不可降级：NarrativeTask / POV / 必须出场角色 / 活跃冲突目标 / 必须兑现钩子 / 用户指令
 *   （映射为 CHUNK_CATALOG 中 priority=required 的 chunk 保护）
 */
import { CHUNK_BY_ID } from './context-chunk.js'

export interface ContextBudget {
  maxInputTokens: number
  reservedForDynamicTask: number
  reservedForToolSchemas: number
  reservedForOutput: number
}

/** 上下文预算（§5.5）：可用于上下文注入的 token 额度 */
export function allocateContextBudget(budget: ContextBudget): number {
  return budget.maxInputTokens - budget.reservedForDynamicTask - budget.reservedForToolSchemas - budget.reservedForOutput
}

/**
 * 字符 → token 估算（中文约 1.5 字符/token，ASCII 约 4 字符/token；
 * 取保守上界：全按中文 1.5 计）。纯估算，供降级决策使用。
 */
export function estimateChunkTokens(chars: number): number {
  return Math.ceil(chars / 1.5)
}

/** 带降级标记的 chunk（summaryMode=需摘要替换；keepOne=recaps 只留最近 1 章） */
export interface DegradableChunk {
  chunkId: string
  content: string
  summaryMode?: boolean
  keepOne?: boolean
}

/** 五级降级顺序的代码化定义（§5.5），逐级执行直到 fit */
export const DEGRADATION_ORDER: ReadonlyArray<{
  step: string
  apply: (chunks: DegradableChunk[]) => DegradableChunk[]
}> = [
  {
    step: 'delete-optional',
    apply: (chunks) => chunks.filter((c) => CHUNK_BY_ID.get(c.chunkId)?.priority !== 'optional'),
  },
  {
    step: 'recommended-full-to-summary',
    apply: (chunks) => chunks.map((c) => {
      const meta = CHUNK_BY_ID.get(c.chunkId)
      if (meta?.priority === 'recommended') return { ...c, summaryMode: true }
      return c
    }),
  },
  {
    step: 'arranged-to-summary',
    apply: (chunks) => chunks.map((c) => {
      if (c.chunkId === 'arranged-entities') return { ...c, summaryMode: true }
      return c
    }),
  },
  {
    step: 'recaps-keep-one',
    apply: (chunks) => chunks.map((c) => {
      if (c.chunkId === 'recent-recaps') return { ...c, keepOne: true }
      return c
    }),
  },
  {
    step: 'style-fingerprint-on-demand',
    apply: (chunks) => chunks.filter((c) => c.chunkId !== 'style-fingerprint'),
  },
]

export interface DegradeResult {
  chunks: DegradableChunk[]
  /** 预算是否满足（false = 已阻止生成） */
  fits: boolean
  /** 实际执行的降级步骤 */
  appliedSteps: string[]
  /** 降级前后 token 估算 */
  tokensBefore: number
  tokensAfter: number
}

/**
 * 按预算降级 chunk 列表（§5.5 降级顺序）。
 *
 * - required chunk（不可降级内容）永不移除；
 * - summaryMode/keepOne 是"降级标记"，由调用方在 T03-4/§5.5 能力上执行
 *   （summary 替换 / recap 裁剪）——本模块负责决策序与保护；
 * - 五级跑完仍超限 → fits=false（阻止生成），由调用方展示明细。
 */
export function degradeChunks(
  chunks: DegradableChunk[],
  budgetTokens: number,
): DegradeResult {
  // 模拟降级后的 token 效果：summaryMode 按 30%（§5.4 摘要每实体单行 ≈ full 的 1/3）、
  // keepOne 按 50%（recaps 多章拼接，只留最近 1 章约一半）
  const tokensOf = (list: DegradableChunk[]): number =>
    list.reduce((acc, c) => {
      const chars = c.summaryMode ? c.content.length * 0.3 : c.keepOne ? c.content.length * 0.5 : c.content.length
      return acc + estimateChunkTokens(Math.ceil(chars))
    }, 0)

  const signatureOf = (list: DegradableChunk[]): string =>
    list.map((c) => `${c.chunkId}:${c.summaryMode ? 's' : ''}${c.keepOne ? 'k' : ''}`).join('|')

  let current = chunks
  const tokensBefore = tokensOf(current)
  const appliedSteps: string[] = []

  for (const step of DEGRADATION_ORDER) {
    if (tokensOf(current) <= budgetTokens) break
    const next = step.apply(current)
    if (signatureOf(next) === signatureOf(current)) continue // 本步无实际变化
    current = next
    appliedSteps.push(step.step)
  }

  return {
    chunks: current,
    fits: tokensOf(current) <= budgetTokens,
    appliedSteps,
    tokensBefore,
    tokensAfter: tokensOf(current),
  }
}
