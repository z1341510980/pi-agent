/**
 * ContextSectionMetrics：P0 成本测量的 section 级旁路埋点（PRD §4.1 P0-1）。
 *
 * 在 runAgentOnce 的上下文组装点做**纯内存旁路采集**：不改 prompt 内容、
 * 不改生成路径，仅记录每个 section 的字符数 / 估算 token / 内容哈希。
 * 由 NovelOrchestrator 在 finally 中随 insertAgentLog 一并持久化到
 * novel_context_section_metrics（迁移 087b）。
 *
 * 六类 section：system / shared / identity / suffix / dynamic / tool_schema。
 * token 估算：`estimateTokensFromChars(chars) = ceil(chars * RATIO)`，
 * 中文文本 RATIO=0.8（1 中文字符 ≤ 1 token），纯 ASCII 段 RATIO=0.25；
 * 仅用于 section 级相对占比，真实 token 仍以 novel_agent_logs.input_tokens 为准。
 */
import { createHash } from 'node:crypto'

export type ContextSectionType = 'system' | 'shared' | 'identity' | 'suffix' | 'dynamic' | 'tool_schema'
export type ContextSectionMode = 'full' | 'summary' | 'on-demand'

export interface ContextSectionMetric {
  id: string
  agentLogId: string
  projectId: string
  chapterNumber: number
  agentType: string
  sectionType: ContextSectionType
  sectionId: string
  chars: number
  estimatedTokens: number
  sourceHash: string
  mode: ContextSectionMode
  createdAt: number
}

/** 持久化入参（id / agentLogId / createdAt 由 store 层补齐） */
export interface ContextSectionMetricInput {
  agentLogId: string
  projectId: string
  chapterNumber: number
  agentType: string
  sectionType: ContextSectionType
  sectionId: string
  chars: number
  estimatedTokens: number
  sourceHash: string
  mode: ContextSectionMode
}

/** 中文文本估算比例：1 中文字符 ≤ 1 token */
export const CJK_TOKEN_RATIO = 0.8
/** 纯 ASCII 段估算比例 */
export const ASCII_TOKEN_RATIO = 0.25

/** 文本是否纯 ASCII（用于选择估算比例） */
export function isPureAscii(text: string): boolean {
  return /^[\x00-\x7F]*$/.test(text)
}

/**
 * 按字符数估算 token。
 * @param chars 字符数
 * @param asciiRatio 是否为纯 ASCII 段（true 用 0.25，false 用 0.8）
 */
export function estimateTokensFromChars(chars: number, asciiRatio = false): number {
  const ratio = asciiRatio ? ASCII_TOKEN_RATIO : CJK_TOKEN_RATIO
  return Math.ceil(chars * ratio)
}

/**
 * 规范化文本：折叠空白 + 去首尾空白（跨环境稳定，哈希前必做）。
 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 计算文本 sha256（规范化后），返回完整 hex。
 */
export function hashText(text: string): string {
  return createHash('sha256').update(normalizeText(text)).digest('hex')
}

/** 单条埋点内容（collector 采集时的中间形态） */
interface CollectedSection {
  sectionType: ContextSectionType
  sectionId: string
  chars: number
  estimatedTokens: number
  sourceHash: string
  mode: ContextSectionMode
}

/**
 * ContextSectionCollector：纯内存 section 收集器。
 *
 * 由 NovelOrchestrator 每次 runAgentOnce 持有一个实例；add() 只做字符数 /
 * token 估算 / 哈希（纯内存，无 IO）。finally 中 buildRows() 一次性产出
 * 待持久化行。
 */
export class ContextSectionCollector {
  private readonly sections: CollectedSection[] = []

  constructor(
    private readonly context: { projectId: string; chapterNumber: number; agentType: string },
    private readonly enabled = true,
  ) {}

  get isEnabled(): boolean {
    return this.enabled
  }

  get size(): number {
    return this.sections.length
  }

  /**
   * 采集一个 section。
   * @param sectionType 六类 section 之一
   * @param sectionId 具体 section 标识（如 chapter-info / story-ledger / arranged-entities）
   * @param content section 文本（仅用于测量，不会注入 prompt）
   * @param mode full | summary | on-demand
   */
  add(sectionType: ContextSectionType, sectionId: string, content: string, mode: ContextSectionMode = 'full'): void {
    if (!this.enabled) return
    if (!content || !content.trim()) return
    const ascii = isPureAscii(content)
    const chars = content.length
    this.sections.push({
      sectionType,
      sectionId,
      chars,
      estimatedTokens: estimateTokensFromChars(chars, ascii),
      sourceHash: hashText(content),
      mode,
    })
  }

  /** 产出待持久化行（不含 id/createdAt，由 store 补齐） */
  buildInputs(agentLogId: string): ContextSectionMetricInput[] {
    return this.sections.map((s) => ({
      agentLogId,
      projectId: this.context.projectId,
      chapterNumber: this.context.chapterNumber,
      agentType: this.context.agentType,
      sectionType: s.sectionType,
      sectionId: s.sectionId,
      chars: s.chars,
      estimatedTokens: s.estimatedTokens,
      sourceHash: s.sourceHash,
      mode: s.mode,
    }))
  }

  clear(): void {
    this.sections.length = 0
  }
}
