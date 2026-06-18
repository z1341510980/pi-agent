import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Evidence Ledger：工具调用证据记录
 *
 * 参考 ARCHITECTURE.md §22.8。S2 阶段实现最小记录：
 * - 每次工具调用后追加一条 JSONL 记录到 ${dataDir}/agent/evidence/${threadId}.jsonl
 * - 记录工具名、参数摘要、结果摘要、是否出错、时间戳
 * - 完整的 Final Readiness Check 验证留到后续阶段
 */

export interface EvidenceEntry {
  /** 记录 ID（hash） */
  id: string
  /** 线程 ID */
  threadId: string
  /** 工具调用 ID */
  toolCallId: string
  /** 工具名 */
  toolName: string
  /** 参数摘要（前 500 字符） */
  argsSummary: string
  /** 结果摘要（前 1000 字符） */
  resultSummary: string
  /** 是否出错 */
  isError: boolean
  /** 时间戳 ISO */
  timestamp: string
}

export interface EvidenceRecordOptions {
  threadId: string
  dataDir: string
}

export class EvidenceLedger {
  private readonly threadId: string
  private readonly logFile: string

  constructor(options: EvidenceRecordOptions) {
    this.threadId = options.threadId
    const dir = join(options.dataDir, 'agent', 'evidence')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    this.logFile = join(dir, `${this.threadId}.jsonl`)
  }

  /**
   * 记录一次工具调用的证据
   * 在 afterToolCall 钩子中调用
   */
  record(entry: Omit<EvidenceEntry, 'id' | 'threadId' | 'timestamp'>): EvidenceEntry {
    const full: EvidenceEntry = {
      ...entry,
      id: this.hash(entry.toolCallId, entry.toolName, Date.now()),
      threadId: this.threadId,
      timestamp: new Date().toISOString(),
    }

    appendFileSync(this.logFile, JSON.stringify(full) + '\n', 'utf8')
    return full
  }

  /** 读取当前线程的所有证据记录 */
  readAll(): EvidenceEntry[] {
    if (!existsSync(this.logFile)) return []
    const { readFileSync } = require('node:fs')
    const content = readFileSync(this.logFile, 'utf8') as string
    return content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as EvidenceEntry)
  }

  private hash(...parts: unknown[]): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
  }
}

/** 工具参数摘要：截断长字符串，保留结构 */
export function summarizeArgs(args: Record<string, unknown>): string {
  const json = JSON.stringify(args)
  return json.length > 500 ? json.slice(0, 500) + '...' : json
}

/** 工具结果摘要：截断长输出 */
export function summarizeResult(result: unknown): string {
  if (typeof result === 'string') {
    return result.length > 1000 ? result.slice(0, 1000) + '...' : result
  }
  const json = JSON.stringify(result)
  return json.length > 1000 ? json.slice(0, 1000) + '...' : json
}
