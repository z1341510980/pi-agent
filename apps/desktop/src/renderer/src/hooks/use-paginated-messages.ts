import { useCallback, useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  getSessionMessages,
  type PaginatedMessages,
  type SessionMessageEntry,
} from '../api/http-client'
import type { ChatMessage } from '../components/chat/types'
import type { AgentRole } from '@repo/shared/agent'

const PAGE_SIZE = 30

/**
 * 将后端 SessionMessageEntry 转换为前端 ChatMessage。
 *
 * 历史消息只用于回看，不参与流式状态机，因此 toolCalls/status 都按"已完成"渲染。
 * 不试图从 SessionEntry.toolCalls 重建 ToolCallInfo（结构差异较大且不影响阅读）。
 */
function entryToChatMessage(entry: SessionMessageEntry): ChatMessage {
  const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : crypto.randomUUID()
  const role: AgentRole =
    entry.role === 'user' ||
    entry.role === 'assistant' ||
    entry.role === 'system' ||
    entry.role === 'tool'
      ? entry.role
      : 'assistant'
  const content = typeof entry.content === 'string' ? entry.content : ''
  const createdAt =
    typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
      ? entry.createdAt
      : Date.now()
  return {
    id,
    role,
    content,
    createdAt,
    toolCalls: [],
    status: 'complete',
  }
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

  // 按时间正序展开：从最旧的一页开始，每页内部 newest-first 需要反向
  const messages = useMemo(() => {
    const result: ChatMessage[] = []
    for (let i = pages.length - 1; i >= 0; i--) {
      const page = pages[i]
      for (let j = page.messages.length - 1; j >= 0; j--) {
        result.push(entryToChatMessage(page.messages[j]))
      }
    }
    return result
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
