/**
 * Session JSONL 读取器：支持按行号游标分页
 *
 * JSONL 文件按追加顺序写入，行号越大越新。
 * 游标设计：nextCursor 是返回的最后一条消息的行号，前端下次传 `?before=<lineIndex>` 即可。
 *
 * ## 只返回 `type: 'message'` 条目
 *
 * JSONL 是 `@earendil-works/pi-agent-core` 的会话事件日志，除了消息还混着
 * `session` 头、`model_change`、`thinking_level_change`、`active_tools_change`、
 * `compaction`、`branch_summary`、`label`、`leaf` 等条目。
 *
 * 如果不过滤就分页，`limit: 30` 拿到的是 30 **行**而不是 30 条消息 —— 一个
 * 频繁切模型的会话可能整页都是 `model_change`，前端翻半天翻不出一条对话。
 * 所以过滤放在游标之前。
 */

import { access, readFile } from 'node:fs/promises'
import type { SessionEntry } from './session-health.js'

export interface PaginatedMessages {
  /** 倒序的消息条目（最新在前） */
  messages: SessionEntry[]
  /** 下一页游标（行号）；null 表示已到顶部 */
  nextCursor: number | null
  /** 是否还有更早的消息 */
  hasMore: boolean
}

export interface ReadSessionMessagesOptions {
  /** 行号游标：返回 lineIndex < before 的消息；缺省时从最新开始 */
  before?: number
  /** 单次返回上限，默认 30，最大 100 */
  limit?: number
}

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100

/**
 * 读取会话 JSONL 文件并按行号倒序分页返回。
 *
 * 行为约定：
 * - 文件不存在：返回空数组 + hasMore:false
 * - 损坏的行（JSON 解析失败）跳过，与 session-health.ts 保持一致
 * - 非 `type: 'message'` 的会话事件条目跳过（见文件头说明）
 * - 游标为行号（lineIndex），前端不关心语义，只需原样回传
 */
export async function readSessionMessages(
  sessionPath: string,
  options: ReadSessionMessagesOptions = {},
): Promise<PaginatedMessages> {
  const exists = await fileExists(sessionPath)
  if (!exists) {
    return { messages: [], nextCursor: null, hasMore: false }
  }

  const content = await readFile(sessionPath, 'utf8')
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length)

  // 解析每行并附加行号；只保留消息条目
  type IndexedEntry = { lineIndex: number; entry: SessionEntry }
  const indexed: IndexedEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]) as SessionEntry
      if (!isMessageEntry(entry)) continue
      indexed.push({ lineIndex: i, entry })
    } catch {
      // 跳过损坏行
    }
  }

  // 行号倒序：最新在前
  indexed.sort((a, b) => b.lineIndex - a.lineIndex)

  // 应用 before 游标
  const before = options.before
  const filtered =
    before != null
      ? indexed.filter((item) => item.lineIndex < before)
      : indexed

  // 应用 limit
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const slice = filtered.slice(0, limit)
  const hasMore = filtered.length > limit

  const messages = slice.map((item) => item.entry)
  const nextCursor =
    hasMore && slice.length > 0 ? slice[slice.length - 1].lineIndex : null

  return { messages, nextCursor, hasMore }
}

/**
 * 是否为消息条目。
 *
 * 只认 `type === 'message'` 且带 `message` 对象的条目。宽松判断（不校验
 * message 内部结构）是为了不因 pi-agent-core 升级新增字段而漏掉消息。
 */
function isMessageEntry(entry: SessionEntry): boolean {
  if (entry.type !== 'message') return false
  const message = (entry as { message?: unknown }).message
  return typeof message === 'object' && message !== null
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
