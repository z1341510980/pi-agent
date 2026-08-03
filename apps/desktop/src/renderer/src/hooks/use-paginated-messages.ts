import { useCallback, useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  getSessionMessages,
  type PaginatedMessages,
  type SessionContentBlock,
  type SessionMessageEntry,
} from '../api/http-client'
import type {
  ChatMessage,
  MessageSegment,
  ToolCallInfo,
  ToolResultDetails,
} from '../components/chat/types'
import { nextSegmentId, segmentsToText } from '../components/chat/types'
import type { AgentRole } from '@repo/shared/agent'

const PAGE_SIZE = 30

/**
 * 把会话 JSONL 条目解码为前端 ChatMessage。
 *
 * ## 为什么需要一个真正的解码器
 *
 * 之前这里假设条目形如 `{id, role, content: string, createdAt}`，但 JSONL 实际是
 * `@earendil-works/pi-agent-core` 的会话事件日志：
 *
 * ```jsonc
 * { "type": "message", "id": "5665a76e", "parentId": "…", "timestamp": "2026-…Z",
 *   "message": { "role": "assistant",
 *                "content": [{ "type": "text", "text": "…" },
 *                            { "type": "toolCall", "id": "…", "name": "read", "arguments": {…} }],
 *                "timestamp": 1781683192944, … } }
 * ```
 *
 * `entry.role` / `entry.content` / `entry.createdAt` 全部是 undefined，于是每条历史
 * 消息都退化成 `role: 'assistant'` + `content: ''` + `createdAt: Date.now()` ——
 * **翻出来的历史全是空白气泡**，分页功能等于没生效。
 *
 * ## 解码规则
 *
 * - `role: 'user'`：content 可能直接是字符串，也可能是块数组
 * - `role: 'assistant'`：text 块拼成正文，thinking 块合成思考块，toolCall 块转 ToolCallInfo
 * - `role: 'toolResult'`：**不单独成气泡**，回填到前一条 assistant 的同 id 工具调用上
 *   （工具结果在流式期间也是挂在工具卡里的，历史回看要保持一致）
 */

/**
 * 内容块数组 → 有序分段。
 *
 * JSONL 的 `content` 数组本来就是按发生顺序排的（text、toolCall、text…），
 * 所以历史回看也能还原「说一段 → 调工具 → 接着说」的交错，与流式期间一致。
 * 之前这里把 text / thinking / toolCall 分三次抽走，顺序信息直接丢了。
 */
function blocksToSegments(blocks: SessionContentBlock[], createdAt: number): MessageSegment[] {
  const segments: MessageSegment[] = []

  for (const block of blocks) {
    if (block.type === 'text') {
      if (typeof block.text !== 'string' || block.text.length === 0) continue
      const last = segments[segments.length - 1]
      if (last?.kind === 'text') last.text += block.text
      else segments.push({ kind: 'text', id: nextSegmentId('h-text'), text: block.text })
      continue
    }

    if (block.type === 'thinking') {
      if (typeof block.thinking !== 'string' || block.thinking.length === 0) continue
      segments.push({
        kind: 'thinking',
        id: nextSegmentId('h-think'),
        content: block.thinking,
        // 历史消息不存在"正在思考"
        isStreaming: false,
        startedAt: createdAt,
        endedAt: createdAt,
      })
      continue
    }

    if (block.type === 'toolCall') {
      const id =
        typeof block.id === 'string' && block.id.length > 0 ? block.id : crypto.randomUUID()
      segments.push({
        kind: 'tool',
        id: nextSegmentId('h-tool'),
        call: {
          toolCallId: id,
          toolName: typeof block.name === 'string' ? block.name : 'unknown',
          args: block.arguments,
          // 历史回看没有"进行中"；结果由后续 toolResult 条目回填
          status: 'success',
        },
      })
    }
  }

  return segments
}

/** 从内容块数组里抽出纯文本（toolResult 的展示文本用） */
function extractText(blocks: SessionContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/** 归一化 role；toolResult 单独处理，不参与 AgentRole */
function normalizeRole(raw: unknown): AgentRole {
  return raw === 'user' || raw === 'assistant' || raw === 'system' || raw === 'tool'
    ? raw
    : 'assistant'
}

/**
 * 解码一页条目为 ChatMessage[]（按传入顺序，要求已是时间正序）。
 *
 * toolResult 需要看到"前一条 assistant"，所以必须整批解码而不是逐条 map。
 *
 * 导出仅为可测试性 —— 这是本 hook 里唯一有分支逻辑的部分。
 */
export function decodeEntries(entries: SessionMessageEntry[]): ChatMessage[] {
  const result: ChatMessage[] = []

  for (const entry of entries) {
    const payload = entry.message
    if (!payload) continue

    const createdAt =
      typeof payload.timestamp === 'number' && Number.isFinite(payload.timestamp)
        ? payload.timestamp
        : parseEntryTimestamp(entry.timestamp)

    // ── 工具结果：回填到前一条 assistant 的对应工具调用 ──
    if (payload.role === 'toolResult') {
      const target = findToolCall(result, payload.toolCallId)
      if (target) {
        target.status = payload.isError === true ? 'error' : 'success'
        target.partialResult = toolResultText(payload.content)
        target.endedAt = createdAt
        // edit/write 的 diff 就在 details 里 —— 历史回看同样该看到"改了什么"
        if (payload.details && typeof payload.details === 'object') {
          target.details = payload.details as ToolResultDetails
        }
      }
      continue
    }

    const segments: MessageSegment[] = Array.isArray(payload.content)
      ? blocksToSegments(payload.content, createdAt)
      : typeof payload.content === 'string' && payload.content.length > 0
        ? [{ kind: 'text', id: nextSegmentId('h-text'), text: payload.content }]
        : []

    const message: ChatMessage = {
      id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : crypto.randomUUID(),
      role: normalizeRole(payload.role),
      content: segmentsToText(segments),
      createdAt,
      segments,
      status: 'complete',
    }

    if (typeof payload.errorMessage === 'string' && payload.errorMessage.length > 0) {
      message.status = 'error'
      message.error = payload.errorMessage
    }

    // 完全空的条目不值得占一个气泡
    if (segments.length === 0 && message.status !== 'error') continue

    result.push(message)
  }

  return result
}

/** entry 级 ISO 时间戳兜底 */
function parseEntryTimestamp(iso: unknown): number {
  if (typeof iso === 'string') {
    const parsed = Date.parse(iso)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

/** 从已解码消息里倒序查找指定 id 的工具调用 */
function findToolCall(messages: ChatMessage[], toolCallId: unknown): ToolCallInfo | undefined {
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const segment of messages[i].segments) {
      if (segment.kind === 'tool' && segment.call.toolCallId === toolCallId) return segment.call
    }
  }
  return undefined
}
/** toolResult 的内容块 → 展示用文本 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return extractText(content as SessionContentBlock[])
}

/** 当前 fetch 游标的状态 */
type FetchCursor = 'initial' | number | null

export interface UsePaginatedMessagesOptions {
  /** 是否启用分页查询（流式运行时应设为 false，避免冲突） */
  enabled?: boolean
}

export interface UsePaginatedMessagesReturn {
  /** 已加载的消息（按时间正序：最旧 → 最新） */
  messages: ChatMessage[]
  /** 是否还有更早的消息可加载 */
  hasMore: boolean
  /** 是否正在加载更多（非初始） */
  isLoadingMore: boolean
  /** 是否正在初始加载（首屏） */
  isLoadingInitial: boolean
  /** 加载更早的消息 */
  loadMore: () => void
}

/**
 * usePaginatedMessages：按行号游标分页加载会话历史消息
 *
 * 设计要点：
 * 1. 使用单一 useQuery + 显式 cursor 状态管理（不使用 useInfiniteQuery，便于精确控制）
 * 2. `fetchingCursor` 三态：'initial'（首屏）/ number（加载更多）/ null（空闲）
 * 3. 每次查询完成后将结果追加到 `pages`，并将 `fetchingCursor` 置回 null（禁用查询）
 * 4. `placeholderData: keepPreviousData` 避免切换 threadId 时画面闪烁
 * 5. threadId 切换时重置 pages 和 fetchingCursor
 */
export function usePaginatedMessages(
  threadId: string,
  options: UsePaginatedMessagesOptions = {},
): UsePaginatedMessagesReturn {
  const { enabled = true } = options

  // 已加载的所有页面，按加载顺序：第 0 页最新，最后一页最旧
  const [pages, setPages] = useState<PaginatedMessages[]>([])
  // 当前要查询的 cursor
  const [fetchingCursor, setFetchingCursor] = useState<FetchCursor>('initial')

  // threadId 切换时重置
  useEffect(() => {
    setPages([])
    setFetchingCursor('initial')
  }, [threadId])

  const query = useQuery({
    queryKey: ['session-messages-paginated', threadId, fetchingCursor],
    queryFn: () => {
      if (fetchingCursor === null) {
        // enabled=false 时不会进入，但 TypeScript 需要守卫
        return Promise.reject(new Error('No active cursor'))
      }
      const before = fetchingCursor === 'initial' ? undefined : fetchingCursor
      return getSessionMessages(threadId, { before, limit: PAGE_SIZE })
    },
    enabled: enabled && fetchingCursor !== null,
    placeholderData: keepPreviousData,
    // 历史消息不会频繁变化，拉长 staleTime 避免重复请求
    staleTime: 30_000,
  })

  // 当查询数据到达且与 fetchingCursor 匹配时，追加到 pages 并回到空闲态
  useEffect(() => {
    if (!query.data || fetchingCursor === null) return
    setPages((prev) => {
      // 防止重复追加（React 严格模式 / effect 重跑）
      if (prev.some((p) => p === query.data)) return prev

      if (fetchingCursor === 'initial') {
        // 初始加载：仅在 prev 为空时追加
        if (prev.length > 0) return prev
        return [query.data]
      }
      // 加载更多：校验 cursor 是否对应 prev 最后一页的 nextCursor
      const last = prev[prev.length - 1]
      if (!last) return prev
      if (last.nextCursor === fetchingCursor) {
        return [...prev, query.data]
      }
      return prev
    })
    setFetchingCursor(null)
  }, [query.data, fetchingCursor])

  const loadMore = useCallback(() => {
    if (!enabled) return
    if (fetchingCursor !== null) return // 正在 fetch
    if (pages.length === 0) return // 还未完成初始加载
    const last = pages[pages.length - 1]
    if (!last.hasMore || last.nextCursor == null) return
    setFetchingCursor(last.nextCursor)
  }, [enabled, fetchingCursor, pages])

  // 按时间正序展开：从最旧的一页开始，每页内部 newest-first 需要反向。
  // 解码必须整批做（toolResult 要回填到前一条 assistant 的工具调用上），
  // 因此先把所有条目拉平成正序数组，再一次性 decode。
  const messages = useMemo(() => {
    const ordered: SessionMessageEntry[] = []
    for (let i = pages.length - 1; i >= 0; i--) {
      const page = pages[i]
      for (let j = page.messages.length - 1; j >= 0; j--) {
        ordered.push(page.messages[j])
      }
    }
    return decodeEntries(ordered)
  }, [pages])

  const lastPage = pages[pages.length - 1]
  // 还没有任何 page 时乐观认为有更多（让 UI 显示加载态）
  const hasMore = lastPage ? lastPage.hasMore : true

  const isLoadingInitial =
    fetchingCursor === 'initial' && query.isFetching && pages.length === 0
  const isLoadingMore =
    fetchingCursor !== 'initial' && fetchingCursor !== null && query.isFetching

  return {
    messages,
    hasMore,
    isLoadingMore,
    isLoadingInitial,
    loadMore,
  }
}
